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
// CHANGE LOG (v7.1 — correctness pass):
//   • getStatsRange(): count fields now preserve `null` instead of
//     coercing to 0. A missing RPC field no longer fabricates a 0
//     for signups/logins/txn/txnFailed/deposits/depositsPending/
//     supportOpen/usersTotal.
//   • getVolume7d(): day keys are normalized to YYYY-MM-DD so a
//     Postgres `date` and a timestamp string for the same day merge
//     into one bucket. Also back-fills missing days so `dates` always
//     has exactly 7 entries (real dates, zero-filled amounts).
//   • getDepositStats(): a provider that is available but has no
//     NGN row is reported as '0.00' (genuine zero), NOT unavailable.
//     USD totals are computed from whichever provider(s) are up —
//     the previous code required BOTH kora AND crypto to succeed,
//     which under-reported when only one was down.
//   • sumMoneyStrings(): unchanged (null-in → null-out) — callers
//     decide what a null means.
//   • All exports and signatures unchanged.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../../db/supabase');

// ─── Constants ───────────────────────────────────────────────────
const PROVIDER_LOW_BALANCE = Object.freeze({
    NGN: '500000.00',
    USD: '500.00'
});

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

// ─── Field coercion helpers ──────────────────────────────────────
// Preserves null. Only converts when the value is genuinely present.
// A null/undefined/'' → null (never 0). This is what prevents the
// "fabricated 0" bug in getStatsRange().
function numOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
function strOrNull(v) {
    if (v == null || v === '') return null;
    return String(v);
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
    const toCount = (v) => numOrNull(v) ?? 0;  // counts default to 0 only when provider succeeded
    return {
        total:     ok(toCount(row.total_users)),
        customers: ok(toCount(row.customer_users)),
        newToday:  ok(toCount(row.new_today)),
        newMonth:  ok(toCount(row.new_month)),
        suspended: ok(toCount(row.suspended_users))
    };
}

// ─── RANGE-AWARE STATS BUNDLE ────────────────────────────────────
// Calls admin_stats_range(p_from,p_to,p_prev_from,p_prev_to).
//
// FIX (v7.1): every count field now uses numOrNull() instead of
// `Number(v || 0)`. A field the RPC did not return stays null, so
// the route can render "Data unavailable" instead of a fake 0.
// Money fields already used strOrNull() and are unchanged.
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

    return {
        available: true,
        from: validFrom,
        to: validTo,
        prevFrom,
        prevTo,
        current: {
            usersTotal:      numOrNull(row.users_total),
            signups:         numOrNull(row.signups_current),
            logins:          numOrNull(row.logins_current),
            txn:             numOrNull(row.txn_current),
            txnFailed:       numOrNull(row.txn_failed_current),
            deposits:        numOrNull(row.deposits_current),
            depositsPending: numOrNull(row.deposits_pending),
            revenueNgn:      strOrNull(row.revenue_ngn_current),
            revenueUsd:      strOrNull(row.revenue_usd_current),
            supportOpen:     numOrNull(row.support_open)
        },
        previous: {
            signups:    numOrNull(row.signups_previous),
            logins:     numOrNull(row.logins_previous),
            txn:        numOrNull(row.txn_previous),
            txnFailed:  numOrNull(row.txn_failed_previous),
            deposits:   numOrNull(row.deposits_previous),
            revenueNgn: strOrNull(row.revenue_ngn_previous),
            revenueUsd: strOrNull(row.revenue_usd_previous)
        }
    };
}

// ─── VOLUME SERIES (7 days, real dates) ──────────────────────────
// "Volume" = sum of transaction.amount for completed/successful
// statuses. Customer flow, NOT revenue.
//
// FIX (v7.1):
//   • Day keys are normalized to YYYY-MM-DD regardless of whether
//     Postgres returns a `date` or a full timestamp string.
//   • Missing days within the 7-day window are back-filled with
//     '0.00' so `dates` always has exactly 7 entries and the chart
//     x-axis aligns. (Zero volume on a real day is a real 0.00,
//     not a fabricated one.)
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

    // Normalize any date-ish value to YYYY-MM-DD.
    const toDayKey = (v) => {
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === 'string') {
            // Accept '2026-01-15' or '2026-01-15T...' — take first 10 chars if ISO.
            const m = v.match(/^\d{4}-\d{2}-\d{2}/);
            if (m) return m[0];
            const d = new Date(v);
            return isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
        }
        return String(v);
    };

    const byDate = new Map();
    for (const row of rows) {
        const d = toDayKey(row.day_date);
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

    // Back-fill missing days over the last 7 calendar days (WAT).
    const today = watDayBounds();
    const todayKey = today.start.slice(0, 10);
    const dayMs = 24 * 60 * 60 * 1000;
    const startMs = new Date(todayKey + 'T00:00:00Z').getTime();
    for (let i = 6; i >= 0; i--) {
        const key = new Date(startMs - i * dayMs).toISOString().slice(0, 10);
        if (!byDate.has(key)) {
            byDate.set(key, { date: key, ngn: '0.00', usd: '0.00', ngnCount: 0, usdCount: 0 });
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
//
// FIX (v7.1):
//   • A provider that is AVAILABLE but has no NGN row is now reported
//     as '0.00' (a genuine zero), not `unavailable`. The old code
//     conflated "no deposits today" with "query failed".
//   • USD totals are computed from whichever provider(s) are up,
//     instead of requiring BOTH kora AND crypto. If only one is down,
//     USD still reports the other's contribution — with
//     `partial: true` + `missingSources` so the route can flag it.
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

    // Counts: only add when BOTH sources are available (the "all
    // sources" contract). A missing source makes the count unavailable.
    const addBothKnown = (a, b) => (a == null || b == null) ? null : a + b;

    const todayCount     = addBothKnown(koraRow?.today_count     ?? null, cryptoRow?.today_count     ?? null);
    const monthCount     = addBothKnown(koraRow?.month_count     ?? null, cryptoRow?.month_count     ?? null);
    const failedTotal    = addBothKnown(koraRow?.failed_count    ?? null, cryptoRow?.failed_count    ?? null);
    const completedTotal = addBothKnown(koraRow?.completed_count ?? null, cryptoRow?.completed_count ?? null);
    const pendingTotal   = addBothKnown(koraOpenRow?.count       ?? null, cryptoOpenRow?.count       ?? null);

    // Money: for each currency, sum from whichever provider(s) are up.
    // If a provider is down, the sum is `partial` (flagged in meta) but
    // still reflects the up provider(s) — never a fake 0, never a
    // silently-dropped contribution.
    const sumFromUpProviders = (fields) => {
        const present = [];
        for (const { available, value } of fields) {
            if (!available) continue;
            const c = toCents(value);
            if (c === null) continue; // provider up but field absent → skip, don't fake
            present.push(c);
        }
        if (present.length === 0) return null; // nothing to report
        let total = 0n;
        for (const c of present) total += c;
        return fromCents(total);
    };

    const todayNgn = sumFromUpProviders([
        { available: kora.available, value: koraRow?.today_ngn ?? null }
    ]);
    const monthNgn = sumFromUpProviders([
        { available: kora.available, value: koraRow?.month_ngn ?? null }
    ]);
    const todayUsd = sumFromUpProviders([
        { available: kora.available,   value: koraRow?.today_usd ?? null },
        { available: crypto.available, value: cryptoRow?.today_usd ?? null }
    ]);
    const monthUsd = sumFromUpProviders([
        { available: kora.available,   value: koraRow?.month_usd ?? null },
        { available: crypto.available, value: cryptoRow?.month_usd ?? null }
    ]);

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
            ngn:   wrap(todayNgn,   'NO_PROVIDER_NGN_DATA'),
            usd:   wrap(todayUsd,   'NO_PROVIDER_USD_DATA')
        },
        month: {
            count: wrap(monthCount, 'INCOMPLETE_PROVIDER_DATA'),
            ngn:   wrap(monthNgn,   'NO_PROVIDER_NGN_DATA'),
            usd:   wrap(monthUsd,   'NO_PROVIDER_USD_DATA')
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