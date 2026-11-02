// routes/admin/dashboardAggregations.js
// ─────────────────────────────────────────────────────────────────
// Server-side aggregation helpers.
//
// CONTRACTS (unchanged):
//   • Money is a 2-decimal STRING from Postgres NUMERIC. Never Number().
//   • Counts are NUMBERS.
//   • Failures → { available: false, reason }. Never 0.
//   • A value that depends on multiple sources is "available" only
//     when ALL of them succeeded. Otherwise it carries
//     { available: false, reason, partial: true, missing: [...] }.
//   • Nothing fabricated. Nothing silently swallowed.
//
// CHANGE LOG (v7):
//   • Removed getPresenceStats() and all admin_presence_summary use.
//   • Added getStatsRange({from,to}) that calls admin_stats_range once
//     and returns current + previous values (change % is computed by
//     the route handler; the aggregator just exposes the raw pairs).
//   • Added getVolume7d() → per-day NGN + USD volume with real dates.
//   • Added getOpenTicketsCount(), getFailedWebhooksCount(),
//     getReconciliationCount().
//   • Added getProviderBalances() — mockless. Returns
//     { available: false, reason } when keys are missing or provider
//     errors, never a fake number.
//   • Added logAdminAction(ctx, action, targetType, targetId, meta) —
//     writes to public.admin_audit_logs. Fails silently (logs to
//     console only); never blocks the request that triggered it.
//   • Every existing function kept its name and return shape.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../../db/supabase');

// ─── Constants ───────────────────────────────────────────────────
const PROVIDER_LOW_BALANCE = Object.freeze({
    NGN: '500000.00',
    USD: '500.00'
});

// Kora + NowPayments balance endpoints. These are only called when
// the corresponding env var is present, so a missing key always
// yields { available: false, reason: 'NOT_CONFIGURED' } — no fake
// numbers.
const PROVIDER_BALANCE_TTL_MS = 60_000;

// ─── WAT boundaries ──────────────────────────────────────────────
function watDayBounds(date = new Date()) {
    const OFFSET_MS = 60 * 60 * 1000;
    const local = new Date(date.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth();
    const d = local.getUTCDate();
    const startUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) - OFFSET_MS);
    const endUtc   = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - OFFSET_MS);
    return { start: startUtc.toISOString(), end: endUtc.toISOString() };
}
function watMonthBounds(date = new Date()) {
    const OFFSET_MS = 60 * 60 * 1000;
    const local = new Date(date.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth();
    const startUtc = new Date(Date.UTC(y, m, 1, 0, 0, 0) - OFFSET_MS);
    const endUtc   = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0) - OFFSET_MS - 1);
    return { start: startUtc.toISOString(), end: endUtc.toISOString() };
}
function isIsoDate(s) {
    if (!s) return false;
    const d = new Date(s);
    return !isNaN(d.getTime());
}
function previousPeriodOf(fromIso, toIso) {
    const fromMs = new Date(fromIso).getTime();
    const toMs   = new Date(toIso).getTime();
    const spanMs = Math.max(0, toMs - fromMs);
    return {
        prevFrom: new Date(fromMs - spanMs - 1).toISOString(),
        prevTo:   new Date(fromMs - 1).toISOString()
    };
}

// ─── Response shapes ─────────────────────────────────────────────
function unavailable(reason, extra = {}) {
    return { available: false, reason: reason || 'NOT_AVAILABLE', ...extra };
}
function ok(value, extra = {}) {
    return { available: true, value, ...extra };
}

// ─── RPC caller ──────────────────────────────────────────────────
async function callRpc(fnName, params = {}) {
    try {
        const { data, error } = await supabaseAdmin.rpc(fnName, params);
        if (error) {
            const code = error.code || 'RPC_ERROR';
            if (code === '42883' || code === 'PGRST202') {
                return unavailable('RPC_NOT_DEPLOYED');
            }
            console.error(`[AGG] rpc ${fnName} error:`, error.message);
            return unavailable(code);
        }
        return ok(data);
    } catch (e) {
        console.error(`[AGG] rpc ${fnName} exception:`, e.message);
        return unavailable('EXCEPTION');
    }
}
function unwrapRpcRow(row) {
    if (Array.isArray(row)) return row[0] || {};
    return row || {};
}

// ─── Money helpers (string-safe, no JS float) ───────────────────
function toCents(v) {
    if (v == null || v === '') return null;
    const s = String(v);
    const neg = s.startsWith('-');
    const [i, f = ''] = s.replace('-', '').split('.');
    const frac2 = (f + '00').slice(0, 2);
    try {
        const cents = BigInt(i || '0') * 100n + BigInt(frac2 || '0');
        return neg ? -cents : cents;
    } catch { return null; }
}
function fromCents(c) {
    if (c == null) return null;
    const neg = c < 0n;
    const abs = neg ? -c : c;
    return (neg ? '-' : '') + (abs / 100n).toString() + '.' + (abs % 100n).toString().padStart(2, '0');
}
function sumMoneyStrings(values) {
    let total = 0n;
    for (const v of values) {
        const c = toCents(v);
        if (c === null) return null;
        total += c;
    }
    return fromCents(total);
}

// ─── USERS ───────────────────────────────────────────────────────
async function getUserStats() {
    const day = watDayBounds();
    const month = watMonthBounds();

    const r = await callRpc('admin_user_summary', {
        p_day_start:   day.start,
        p_month_start: month.start
    });
    if (!r.available) {
        return {
            total:     unavailable(r.reason),
            customers: unavailable(r.reason),
            newToday:  unavailable(r.reason),
            newMonth:  unavailable(r.reason),
            suspended: unavailable(r.reason)
        };
    }
    const row = unwrapRpcRow(r.value);
    return {
        total:     ok(Number(row.total_users     || 0)),
        customers: ok(Number(row.customer_users  || 0)),
        newToday:  ok(Number(row.new_today       || 0)),
        newMonth:  ok(Number(row.new_month       || 0)),
        suspended: ok(Number(row.suspended_users || 0))
    };
}

// ─── RANGE-AWARE STATS BUNDLE ────────────────────────────────────
// Calls admin_stats_range(p_from,p_to,p_prev_from,p_prev_to).
// Returns current + previous values so the route can compute the
// change % without touching money as numbers (it uses the string
// pairs only for display).
async function getStatsRange({ from, to }) {
    const validFrom = isIsoDate(from) ? from : watDayBounds().start;
    const validTo   = isIsoDate(to)   ? to   : watDayBounds().end;
    const { prevFrom, prevTo } = previousPeriodOf(validFrom, validTo);

    const r = await callRpc('admin_stats_range', {
        p_from:      validFrom,
        p_to:        validTo,
        p_prev_from: prevFrom,
        p_prev_to:   prevTo
    });

    if (!r.available) {
        return {
            available: false,
            reason: r.reason,
            from: validFrom,
            to: validTo,
            prevFrom,
            prevTo
        };
    }

    const row = unwrapRpcRow(r.value);
    const num = (v) => Number(v || 0);
    const str = (v) => (v == null ? null : String(v));

    return {
        available: true,
        from: validFrom,
        to: validTo,
        prevFrom,
        prevTo,
        current: {
            usersTotal:      num(row.users_total),
            signups:         num(row.signups_current),
            logins:          num(row.logins_current),
            txn:             num(row.txn_current),
            txnFailed:       num(row.txn_failed_current),
            deposits:        num(row.deposits_current),
            depositsPending: num(row.deposits_pending),
            revenueNgn:      str(row.revenue_ngn_current),
            revenueUsd:      str(row.revenue_usd_current),
            supportOpen:     num(row.support_open)
        },
        previous: {
            signups:    num(row.signups_previous),
            logins:     num(row.logins_previous),
            txn:        num(row.txn_previous),
            txnFailed:  num(row.txn_failed_previous),
            deposits:   num(row.deposits_previous),
            revenueNgn: str(row.revenue_ngn_previous),
            revenueUsd: str(row.revenue_usd_previous)
        }
    };
}

// ─── VOLUME SERIES (7 days, real dates) ──────────────────────────
// "Volume" = sum of transaction.amount for completed/successful
// statuses. Customer flow, NOT revenue.
async function getVolume7d() {
    const r = await callRpc('admin_volume_7d');
    if (!r.available) {
        return {
            available: false,
            reason: r.reason,
            ngn: null,
            usd: null,
            ngnTotal: null,
            usdTotal: null
        };
    }
    const rows = Array.isArray(r.value) ? r.value : [];

    const byDate = new Map();
    for (const row of rows) {
        const d = row.day_date instanceof Date
            ? row.day_date.toISOString().slice(0, 10)
            : String(row.day_date);
        if (!byDate.has(d)) byDate.set(d, { date: d, ngn: '0.00', usd: '0.00', ngnCount: 0, usdCount: 0 });
        const entry = byDate.get(d);
        if (row.currency === 'USD') {
            entry.usd      = String(row.total_amount || '0.00');
            entry.usdCount = Number(row.txn_count || 0);
        } else if (row.currency === 'NGN') {
            entry.ngn      = String(row.total_amount || '0.00');
            entry.ngnCount = Number(row.txn_count || 0);
        }
    }
    const dates = [...byDate.keys()].sort();
    const ngnSeries = dates.map(d => byDate.get(d).ngn);
    const usdSeries = dates.map(d => byDate.get(d).usd);
    const ngnTotal  = sumMoneyStrings(ngnSeries);
    const usdTotal  = sumMoneyStrings(usdSeries);

    return {
        available: true,
        dates,
        ngn: ngnSeries,
        usd: usdSeries,
        ngnTotal,
        usdTotal
    };
}

// ─── WALLET LIABILITIES ──────────────────────────────────────────
async function getWalletLiabilities() {
    const r = await callRpc('admin_wallet_liabilities');
    if (!r.available) {
        return { ngn: unavailable(r.reason), usd: unavailable(r.reason) };
    }
    const rows = Array.isArray(r.value) ? r.value : [];
    let ngn = null, usd = null;
    for (const row of rows) {
        if (row.currency === 'NGN') ngn = String(row.available ?? '0.00');
        if (row.currency === 'USD') usd = String(row.available ?? '0.00');
    }
    return {
        ngn: ngn === null ? unavailable('NO_NGN_ACCOUNTS') : ok(ngn),
        usd: usd === null ? unavailable('NO_USD_ACCOUNTS') : ok(usd)
    };
}

// ─── DEPOSITS (partial-provider safe) ────────────────────────────
async function getDepositStats() {
    const day = watDayBounds();
    const month = watMonthBounds();

    const [kora, crypto, koraOpen, cryptoOpen] = await Promise.all([
        callRpc('admin_kora_deposit_summary',   { p_day_start: day.start, p_day_end: day.end, p_month_start: month.start }),
        callRpc('admin_crypto_deposit_summary', { p_day_start: day.start, p_day_end: day.end, p_month_start: month.start }),
        callRpc('admin_kora_open_deposits'),
        callRpc('admin_crypto_open_deposits')
    ]);

    const koraRow       = kora.available     ? unwrapRpcRow(kora.value)       : null;
    const cryptoRow     = crypto.available   ? unwrapRpcRow(crypto.value)     : null;
    const koraOpenRow   = koraOpen.available ? unwrapRpcRow(koraOpen.value)   : null;
    const cryptoOpenRow = cryptoOpen.available ? unwrapRpcRow(cryptoOpen.value) : null;

    const missingSources = [];
    if (!kora.available)       missingSources.push('kora_summary');
    if (!crypto.available)     missingSources.push('crypto_summary');
    if (!koraOpen.available)   missingSources.push('kora_open');
    if (!cryptoOpen.available) missingSources.push('crypto_open');

    const partialMeta = missingSources.length
        ? { partial: true, missingSources }
        : { partial: false, missingSources: [] };

    const addBothKnown = (a, b) => (a == null || b == null) ? null : a + b;

    const todayCount     = addBothKnown(koraRow?.today_count     ?? null, cryptoRow?.today_count     ?? null);
    const monthCount     = addBothKnown(koraRow?.month_count     ?? null, cryptoRow?.month_count     ?? null);
    const failedTotal    = addBothKnown(koraRow?.failed_count    ?? null, cryptoRow?.failed_count    ?? null);
    const completedTotal = addBothKnown(koraRow?.completed_count ?? null, cryptoRow?.completed_count ?? null);
    const pendingTotal   = addBothKnown(koraOpenRow?.count       ?? null, cryptoOpenRow?.count       ?? null);

    const todayNgn = kora.available ? sumMoneyStrings([koraRow?.today_ngn ?? null]) : null;
    const monthNgn = kora.available ? sumMoneyStrings([koraRow?.month_ngn ?? null]) : null;
    const todayUsd = (kora.available && crypto.available)
        ? sumMoneyStrings([koraRow?.today_usd ?? null, cryptoRow?.today_usd ?? null])
        : null;
    const monthUsd = (kora.available && crypto.available)
        ? sumMoneyStrings([koraRow?.month_usd ?? null, cryptoRow?.month_usd ?? null])
        : null;

    const wrap = (val, reason) => val == null
        ? unavailable(reason, partialMeta)
        : ok(val, partialMeta);

    const byProvider = {};
    if (kora.available) {
        byProvider.kora = {
            todayCount: ok(Number(koraRow.today_count || 0)),
            todayNgn:   ok(String(koraRow.today_ngn || '0.00')),
            todayUsd:   ok(String(koraRow.today_usd || '0.00')),
            pending:    koraOpen.available ? ok(Number(koraOpenRow.count || 0)) : unavailable(koraOpen.reason),
            completed:  ok(Number(koraRow.completed_count || 0)),
            failed:     ok(Number(koraRow.failed_count    || 0))
        };
    } else {
        byProvider.kora = { unavailable: true, reason: kora.reason };
    }
    if (crypto.available) {
        byProvider.nowpayments = {
            todayCount:   ok(Number(cryptoRow.today_count   || 0)),
            todayUsd:     ok(String(cryptoRow.today_usd     || '0.00')),
            pending:      cryptoOpen.available ? ok(Number(cryptoOpenRow.count || 0)) : unavailable(cryptoOpen.reason),
            completed:    ok(Number(cryptoRow.completed_count || 0)),
            failed:       ok(Number(cryptoRow.failed_count    || 0)),
            manualReview: ok(Number(cryptoRow.manual_review_count || 0))
        };
    } else {
        byProvider.nowpayments = { unavailable: true, reason: crypto.reason };
    }

    return {
        today: {
            count: wrap(todayCount, 'INCOMPLETE_PROVIDER_DATA'),
            ngn:   wrap(todayNgn,   kora.available ? 'NO_KORA_TODAY_NGN' : 'NO_KORA_DATA'),
            usd:   wrap(todayUsd,   'INCOMPLETE_PROVIDER_DATA')
        },
        month: {
            count: wrap(monthCount, 'INCOMPLETE_PROVIDER_DATA'),
            ngn:   wrap(monthNgn,   kora.available ? 'NO_KORA_MONTH_NGN' : 'NO_KORA_DATA'),
            usd:   wrap(monthUsd,   'INCOMPLETE_PROVIDER_DATA')
        },
        pending:   wrap(pendingTotal,   'INCOMPLETE_OPEN_QUERY'),
        failed:    wrap(failedTotal,    'INCOMPLETE_PROVIDER_DATA'),
        completed: wrap(completedTotal, 'INCOMPLETE_PROVIDER_DATA'),
        byProvider,
        _meta: partialMeta
    };
}

// ─── TRANSACTIONS ────────────────────────────────────────────────
async function getTransactionStats() {
    const day = watDayBounds();
    const month = watMonthBounds();

    const r = await callRpc('admin_transaction_summary', {
        p_day_start:   day.start,
        p_day_end:     day.end,
        p_month_start: month.start
    });

    if (!r.available) {
        return {
            today:    { count: unavailable(r.reason), ngn: unavailable(r.reason), usd: unavailable(r.reason) },
            month:    { count: unavailable(r.reason), ngn: unavailable(r.reason), usd: unavailable(r.reason) },
            byStatus: { completed: unavailable(r.reason), pending: unavailable(r.reason), failed: unavailable(r.reason) }
        };
    }
    const row = unwrapRpcRow(r.value);
    return {
        today: {
            count: ok(Number(row.today_count || 0)),
            ngn:   ok(String(row.today_ngn   || '0.00')),
            usd:   ok(String(row.today_usd   || '0.00'))
        },
        month: {
            count: ok(Number(row.month_count || 0)),
            ngn:   ok(String(row.month_ngn   || '0.00')),
            usd:   ok(String(row.month_usd   || '0.00'))
        },
        byStatus: {
            completed: ok(Number(row.completed_count || 0)),
            pending:   ok(Number(row.pending_count   || 0)),
            failed:    ok(Number(row.failed_count    || 0))
        }
    };
}

// ─── REVENUE ─────────────────────────────────────────────────────
// Unchanged shape. The revenue-page and the KPI drawer call this
// same RPC — there is no other place revenue is defined.
async function getRevenueStats() {
    const day = watDayBounds();
    const month = watMonthBounds();

    const r = await callRpc('admin_revenue_summary', {
        p_day_start:   day.start,
        p_day_end:     day.end,
        p_month_start: month.start
    });

    if (!r.available) {
        return {
            todayNgn: unavailable(r.reason),
            todayUsd: unavailable(r.reason),
            monthNgn: unavailable(r.reason),
            monthUsd: unavailable(r.reason)
        };
    }
    const row = unwrapRpcRow(r.value);
    return {
        todayNgn: ok(String(row.today_ngn || '0.00')),
        todayUsd: ok(String(row.today_usd || '0.00')),
        monthNgn: ok(String(row.month_ngn || '0.00')),
        monthUsd: ok(String(row.month_usd || '0.00'))
    };
}

// ─── SUPPORT / NOTIFICATIONS / WEBHOOKS / RECON ──────────────────
async function getSupportStats() {
    const r = await callRpc('admin_support_summary');
    if (!r.available) return { open: unavailable(r.reason) };
    const row = unwrapRpcRow(r.value);
    return { open: ok(Number(row.open_count || 0)) };
}

async function getNotificationStats() {
    const r = await callRpc('admin_notification_summary');
    if (!r.available) return { unread: unavailable(r.reason) };
    const row = unwrapRpcRow(r.value);
    return { unread: ok(Number(row.unread_count || 0)) };
}

async function getFailedWebhooksCount() {
    const r = await callRpc('admin_failed_webhooks_count');
    if (!r.available) return unavailable(r.reason);
    const row = unwrapRpcRow(r.value);
    return ok(Number(row.failed_count || 0));
}

async function getReconciliationCount() {
    const r = await callRpc('admin_reconciliation_summary');
    if (!r.available) return unavailable(r.reason);
    const row = unwrapRpcRow(r.value);
    return ok({
        total:              Number(row.total || 0),
        kora_manual_review: Number(row.kora_manual_review || 0),
        kora_underpaid:     Number(row.kora_underpaid || 0),
        kora_overpaid:      Number(row.kora_overpaid || 0),
        crypto_manual_review: Number(row.crypto_manual_review || 0),
        crypto_partially_paid: Number(row.crypto_partially_paid || 0)
    });
}

// ─── LOGINS TODAY ────────────────────────────────────────────────
// Count-only RPC. `getLoginsTodayDetailed` remains for the drawer;
// it must not be used for the KPI card (per spec).
async function getLoginsTodayCountOnly() {
    const day = watDayBounds();
    const r = await callRpc('admin_logins_today_count', {
        p_day_start: day.start,
        p_day_end:   day.end
    });
    if (!r.available) return unavailable(r.reason);
    const row = unwrapRpcRow(r.value);
    return ok(Number(row.total || 0));
}

async function getLoginsTodayDetailed({ limit = 50 } = {}) {
    const day = watDayBounds();

    const [countRpc, rowsRpc] = await Promise.all([
        callRpc('admin_logins_today_count', {
            p_day_start: day.start,
            p_day_end:   day.end
        }),
        callRpc('admin_logins_today_users', {
            p_day_start: day.start,
            p_day_end:   day.end,
            p_limit:     Math.min(limit, 200)
        })
    ]);

    if (!countRpc.available) return unavailable(countRpc.reason);

    const countRow        = unwrapRpcRow(countRpc.value);
    const total           = Number(countRow.total || 0);
    const detailAvailable = rowsRpc.available;
    const users           = detailAvailable && Array.isArray(rowsRpc.value) ? rowsRpc.value : [];

    return {
        available: true,
        total,
        value: users,
        detailAvailable,
        detailReason: detailAvailable ? null : rowsRpc.reason,
        deviceBreakdown: {},
        from: day.start,
        to: day.end
    };
}

// ─── PROVIDER BALANCES ──────────────────────────────────────────
// Never fabricates. If the provider has no configured key, we say
// NOT_CONFIGURED. If the provider errors, we say the code.
// Cached for PROVIDER_BALANCE_TTL_MS so we don't hammer their APIs.
const _balanceCache = new Map(); // key → { at, value }

function _readCache(key) {
    const hit = _balanceCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > PROVIDER_BALANCE_TTL_MS) {
        _balanceCache.delete(key);
        return null;
    }
    return hit.value;
}
function _writeCache(key, value) {
    _balanceCache.set(key, { at: Date.now(), value });
}

async function _fetchJson(url, headers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
        if (!res.ok) return { ok: false, reason: `HTTP_${res.status}` };
        const json = await res.json();
        return { ok: true, data: json };
    } catch (e) {
        if (e.name === 'AbortError') return { ok: false, reason: 'TIMEOUT' };
        return { ok: false, reason: 'NETWORK_ERROR' };
    } finally {
        clearTimeout(timer);
    }
}

async function _koraBalances() {
    const cacheKey = 'kora';
    const cached = _readCache(cacheKey);
    if (cached) return cached;

    const key = process.env.KORA_SECRET_KEY;
    if (!key) {
        const value = unavailable('NOT_CONFIGURED');
        _writeCache(cacheKey, value);
        return value;
    }
    const res = await _fetchJson('https://api.korapay.com/merchant/api/v1/balances', {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
    });
    if (!res.ok) {
        const value = unavailable(res.reason);
        _writeCache(cacheKey, value);
        return value;
    }
    // Kora returns { data: { NGN: "123.45", USD: "10.00", ... } }.
    // We only expose NGN and USD; anything else is ignored, not
    // invented. Missing currency → unavailable for that currency.
    const raw = res.data?.data || res.data || {};
    const value = {
        available: true,
        balances: {
            NGN: raw.NGN != null ? String(raw.NGN) : null,
            USD: raw.USD != null ? String(raw.USD) : null
        }
    };
    _writeCache(cacheKey, value);
    return value;
}

async function _nowPaymentsBalances() {
    const cacheKey = 'nowpayments';
    const cached = _readCache(cacheKey);
    if (cached) return cached;

    const key = process.env.NOWPAYMENTS_API_KEY;
    if (!key) {
        const value = unavailable('NOT_CONFIGURED');
        _writeCache(cacheKey, value);
        return value;
    }
    const res = await _fetchJson('https://api.nowpayments.io/v1/balance', {
        'x-api-key': key,
        Accept: 'application/json'
    });
    if (!res.ok) {
        const value = unavailable(res.reason);
        _writeCache(cacheKey, value);
        return value;
    }
    // NowPayments returns { balance: { USD: 12.5, ... } }.
    const raw = res.data?.balance || res.data || {};
    const value = {
        available: true,
        balances: {
            NGN: raw.NGN != null ? String(raw.NGN) : null,
            USD: raw.USD != null ? String(raw.USD) : null
        }
    };
    _writeCache(cacheKey, value);
    return value;
}

async function getProviderBalances() {
    const [kora, nowpayments] = await Promise.all([
        _koraBalances(),
        _nowPaymentsBalances()
    ]);

    // Compare against thresholds without doing financial math in JS:
    // both sides come from Postgres/HTTP as strings, and we only need
    // a yes/no.
    const low = (bal, threshold) => {
        const c = toCents(bal), t = toCents(threshold);
        if (c == null || t == null) return null;
        return c < t;
    };

    const rows = [
        {
            provider: 'kora',
            label:    'KoraPay',
            ...kora,
            threshold: { NGN: PROVIDER_LOW_BALANCE.NGN, USD: PROVIDER_LOW_BALANCE.USD },
            lowBalance: kora.available
                ? {
                    NGN: low(kora.balances?.NGN, PROVIDER_LOW_BALANCE.NGN),
                    USD: low(kora.balances?.USD, PROVIDER_LOW_BALANCE.USD)
                }
                : null
        },
        {
            provider: 'nowpayments',
            label:    'NowPayments',
            ...nowpayments,
            threshold: { NGN: PROVIDER_LOW_BALANCE.NGN, USD: PROVIDER_LOW_BALANCE.USD },
            lowBalance: nowpayments.available
                ? {
                    NGN: low(nowpayments.balances?.NGN, PROVIDER_LOW_BALANCE.NGN),
                    USD: low(nowpayments.balances?.USD, PROVIDER_LOW_BALANCE.USD)
                }
                : null
        }
    ];

    return rows;
}

// ─── AUDIT HELPER ───────────────────────────────────────────────
// Writes to admin_audit_logs. Never throws; the caller's request
// must not fail because an audit write failed.
//
// ctx is what the route handler receives: req.adminContext, plus
// req.ip and req.headers['user-agent'].
async function logAdminAction(ctx, action, targetType, targetId, meta = {}) {
    try {
        const adminId   = ctx?.id || null;
        const adminRole = ctx?.role || null;
        const email     = ctx?.email || null;
        const ip        = ctx?.ip || null;
        const ua        = ctx?.userAgent || null;
        if (!adminId) return;

        const row = {
            admin_id:    adminId,
            admin_email: email,
            admin_role:  adminRole,
            action,
            target_type: targetType || null,
            target_id:   targetId ? String(targetId) : null,
            metadata:    meta,
            category:    'admin',
            severity:    'low',
            result:      'success',
            ip_address:  ip,
            user_agent:  ua
        };

        const { error } = await supabaseAdmin.from('admin_audit_logs').insert(row);
        if (error) {
            console.warn('[AUDIT] insert failed:', error.message);
        }
    } catch (e) {
        console.warn('[AUDIT] exception:', e.message);
    }
}

// ─── SYSTEM HEALTH ───────────────────────────────────────────────
async function getSystemHealth() {
    const start = Date.now();
    let dbLatency = -1;
    let dbHealth  = 'unknown';
    try {
        const t = Date.now();
        const { error } = await supabaseAdmin
            .from('profiles')
            .select('id', { count: 'exact', head: true });
        dbLatency = Date.now() - t;
        if (error)                  dbHealth = 'error';
        else if (dbLatency < 500)   dbHealth = 'healthy';
        else if (dbLatency < 2000)  dbHealth = 'degraded';
        else                        dbHealth = 'slow';
    } catch {
        dbHealth = 'error';
    }

    const overall =
        dbHealth === 'error'    ? 'outage'      :
        dbHealth === 'slow'     ? 'degraded'    :
        dbHealth === 'degraded' ? 'degraded'    :
        dbHealth === 'healthy'  ? 'operational' :
                                  'unknown';

    const mem = process.memoryUsage();
    const memPercent = Math.round((mem.heapUsed / mem.heapTotal) * 100);

    return {
        status: overall,
        api_latency:    `${Date.now() - start}ms`,
        db_latency:     dbLatency >= 0 ? `${dbLatency}ms` : 'Error',
        database_health: dbHealth,
        server_uptime:  `${Math.floor(process.uptime())} seconds`,
        memory_usage:   `${memPercent}%`,
        heap_used:      `${Math.round(mem.heapUsed  / 1024 / 1024)}MB`,
        heap_total:     `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
        rss:            `${Math.round(mem.rss       / 1024 / 1024)}MB`,
        timestamp:      new Date().toISOString()
    };
}

// ─── Exports ────────────────────────────────────────────────────
module.exports = {
    // boundaries / utils
    watDayBounds,
    watMonthBounds,
    isIsoDate,
    previousPeriodOf,
    unavailable,
    ok,
    // stats
    getUserStats,
    getStatsRange,
    getVolume7d,
    getWalletLiabilities,
    getDepositStats,
    getTransactionStats,
    getRevenueStats,
    getSupportStats,
    getNotificationStats,
    getFailedWebhooksCount,
    getReconciliationCount,
    getLoginsTodayCountOnly,
    getLoginsTodayDetailed,
    getProviderBalances,
    logAdminAction,
    getSystemHealth
};