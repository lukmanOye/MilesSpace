// services/revenueService.js
// ─────────────────────────────────────────────────────────────────
// Revenue analytics — financial authority for /admin/revenue.
//
// MONEY RULES (enforced here AND in SQL; never trust Node to sum money):
//   • Revenue = completed service orders only (excluded types in SQL).
//   • Every aggregate is per-currency. NGN and USD are NEVER summed.
//   • "combinedNgn" is computed from per-currency totals × explicit
//     FX rate, flagged approximate:true. Never from mixed rows.
//   • Money returned as decimal strings. Node passes through; no
//     floating-point math on sums. BigInt only for combinedNgn.
//   • Funding = wallet deposits (liability, never revenue).
//   • Held funds = ledger balances (liability), shown separately.
//   • Period comparison: previous period = same length, ends 1ms
//     before current start. changePct per currency, null when prev=0.
//   • Timezone: Africa/Lagos (WAT, UTC+1). Presets computed server-side.
//   • Timeseries zero-filled by SQL (generate_series).
//   • Failed sub-query → block returns { available:false, reason }
//     rather than silently zeroing.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');

// ─── Constants ───────────────────────────────────────────────────
const VALID_PRESETS = ['today','yesterday','7d','30d','month','lastmonth','year'];
const VALID_CURRENCIES = ['NGN','USD'];
const MAX_RANGE_DAYS = 400;
const WAT_OFFSET_MS = 60 * 60 * 1000;
const TZ = 'Africa/Lagos';
const FX_CACHE_MS = 5 * 60 * 1000;
const SUMMARY_CACHE_MS = 30 * 1000;
const RPC_MISSING_CODES = new Set(['42883','PGRST202']);

// ─── Typed errors ────────────────────────────────────────────────
function typedError(status, code, message) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    return e;
}
function validation(msg, code = 'INVALID_INPUT') {
    return typedError(400, code, msg);
}
function rpcMissing(msg) {
    return typedError(503, 'REVENUE_RPC_NOT_DEPLOYED', msg);
}

// ─── Date helpers (WAT = UTC+1, no DST) ──────────────────────────
function watBounds(date = new Date()) {
    const local = new Date(date.getTime() + WAT_OFFSET_MS);
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth();
    const d = local.getUTCDate();
    return {
        start: new Date(Date.UTC(y, m, d, 0, 0, 0) - WAT_OFFSET_MS),
        end:   new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - WAT_OFFSET_MS)
    };
}
function addDays(d, n) {
    return new Date(d.getTime() + n * 86400000);
}
function isValidDateOnly(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function parseDateOnlyWAT(s) {
    // YYYY-MM-DD → 00:00:00.000 WAT → ISO UTC
    const [y, m, d] = s.split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    const dt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - WAT_OFFSET_MS);
    return isNaN(dt.getTime()) ? null : dt;
}
function isoOrThrow(s, field) {
    if (!s) return null;
    const d = new Date(s);
    if (isNaN(d.getTime())) throw validation(`Invalid ${field}.`, 'INVALID_DATE');
    return d;
}
function toIso(d) { return d.toISOString(); }

// ─── Scope normalisation ─────────────────────────────────────────
/**
 * Normalize a scope into { from, to, currency, preset, label, days }.
 * Presets are computed in WAT; custom ranges must be WAT date-only or ISO.
 * @throws {Error & { status:number, code:string }}
 */
function normalizeScope(input = {}) {
    const { from: rawFrom, to: rawTo, currency: rawCurrency, preset: rawPreset } = input || {};

    const currency = rawCurrency && String(rawCurrency).toUpperCase() !== 'ALL'
        ? String(rawCurrency).toUpperCase()
        : null;
    if (currency !== null && !VALID_CURRENCIES.includes(currency)) {
        throw validation('currency must be NGN, USD, or all.', 'INVALID_CURRENCY');
    }

    const preset = rawPreset ? String(rawPreset).toLowerCase() : null;
    if (preset && !VALID_PRESETS.includes(preset)) {
        throw validation(`preset must be one of: ${VALID_PRESETS.join(', ')}.`, 'INVALID_PRESET');
    }

    // Preset wins if provided; else custom from/to.
    if (preset) {
        const now = new Date();
        const today = watBounds(now);
        let from, to, label;
        switch (preset) {
            case 'today':      from = today.start; to = today.end; label = 'Today'; break;
            case 'yesterday':  { const y = watBounds(addDays(now, -1)); from = y.start; to = y.end; label = 'Yesterday'; break; }
            case '7d':         from = watBounds(addDays(now, -6)).start; to = today.end; label = 'Last 7 days'; break;
            case '30d':        from = watBounds(addDays(now, -29)).start; to = today.end; label = 'Last 30 days'; break;
            case 'month': {
                const local = new Date(now.getTime() + WAT_OFFSET_MS);
                const first = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - WAT_OFFSET_MS);
                from = first; to = today.end; label = 'This month'; break;
            }
            case 'lastmonth': {
                const local = new Date(now.getTime() + WAT_OFFSET_MS);
                const firstLast = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1) - WAT_OFFSET_MS);
                const endLast = new Date(firstLast.getTime() + 31 * 86400000);
                to = watBounds(new Date(endLast.getTime() - 1)).end; // end of last day of last month, WAT
                from = firstLast; label = 'Last month'; break;
            }
            case 'year': {
                const local = new Date(now.getTime() + WAT_OFFSET_MS);
                from = new Date(Date.UTC(local.getUTCFullYear(), 0, 1) - WAT_OFFSET_MS);
                to = today.end; label = 'This year'; break;
            }
            default:
                throw validation('Unknown preset.', 'INVALID_PRESET');
        }
        const days = Math.ceil((to - from) / 86400000);
        if (days > MAX_RANGE_DAYS) throw validation(`Range exceeds ${MAX_RANGE_DAYS} days.`, 'RANGE_TOO_LARGE');
        return { from: toIso(from), to: toIso(to), currency, preset, label, days };
    }

    // Custom range
    let from, to;
    if (isValidDateOnly(rawFrom)) {
        const d = parseDateOnlyWAT(rawFrom);
        if (!d) throw validation('Invalid from date.', 'INVALID_DATE');
        from = d;
    } else {
        from = isoOrThrow(rawFrom, 'from');
    }
    if (isValidDateOnly(rawTo)) {
        const d = parseDateOnlyWAT(rawTo);
        if (!d) throw validation('Invalid to date.', 'INVALID_DATE');
        to = new Date(d.getTime() + 86400000 - 1);
    } else {
        to = isoOrThrow(rawTo, 'to');
    }

    if (!from && !to) {
        const today = watBounds();
        return { from: toIso(today.start), to: toIso(today.end), currency, preset: 'today', label: 'Today', days: 1 };
    }
    if (!from || !to) throw validation('Both from and to are required for custom range.', 'MISSING_RANGE');
    if (from > to) throw validation('from must be before or equal to to.', 'INVALID_RANGE');
    const days = Math.ceil((to - from) / 86400000);
    if (days > MAX_RANGE_DAYS) throw validation(`Range exceeds ${MAX_RANGE_DAYS} days.`, 'RANGE_TOO_LARGE');
    return { from: toIso(from), to: toIso(to), currency, preset: 'custom', label: 'Custom range', days };
}

/** Previous period of equal length, ending 1ms before current start. */
function previousPeriod(fromIso, toIso) {
    const f = new Date(fromIso).getTime();
    const t = new Date(toIso).getTime();
    const span = t - f;
    return {
        from: new Date(f - span).toISOString(),
        to:   new Date(f - 1).toISOString()
    };
}

// ─── Caches ──────────────────────────────────────────────────────
let _fxCache = { value: null, expiresAt: 0 };
let _summaryCache = new Map();

async function getUsdToNgnRate() {
    const now = Date.now();
    if (_fxCache.value && now < _fxCache.expiresAt) return _fxCache.value;

    let rate = null, source = 'none', asOf = new Date().toISOString();
    try {
        const { data, error } = await supabaseAdmin
            .from('app_config').select('value').eq('key','usd_to_ngn').maybeSingle();
        if (error) throw error;
        if (data?.value) {
            const n = Number(data.value);
            if (Number.isFinite(n) && n > 0) { rate = n; source = 'app_config.usd_to_ngn'; }
        }
    } catch (_) { /* fall through */ }
    if (rate === null) {
        const n = Number(process.env.MILESSPACE_USD_TO_NGN);
        if (Number.isFinite(n) && n > 0) { rate = n; source = 'env'; }
    }
    if (rate === null) { rate = 1600; source = 'default'; }
    _fxCache = { value: { usdToNgn: rate, source, asOf }, expiresAt: now + FX_CACHE_MS };
    return _fxCache.value;
}

function summaryCacheKey(scope) {
    return `${scope.from}|${scope.to}|${scope.currency || 'ALL'}|${scope.preset}`;
}
function getCachedSummary(scope) {
    const e = _summaryCache.get(summaryCacheKey(scope));
    if (e && e.expiresAt > Date.now()) return e.value;
    return null;
}
function setCachedSummary(scope, value) {
    _summaryCache.set(summaryCacheKey(scope), { value, expiresAt: Date.now() + SUMMARY_CACHE_MS });
    if (_summaryCache.size > 128) {
        const firstKey = _summaryCache.keys().next().value;
        _summaryCache.delete(firstKey);
    }
}

// ─── Helpers for money strings ───────────────────────────────────
function money(v) {
    if (v === null || v === undefined) return '0.00';
    return String(v); // Postgres numeric comes back as string
}
function bigintFromDecimalString(s) {
    // "1234.56" → 123456n (2 dp)
    const neg = s.startsWith('-');
    const abs = neg ? s.slice(1) : s;
    const [w, f = ''] = abs.split('.');
    const cents = BigInt(w || '0') * 100n + BigInt((f + '00').slice(0, 2));
    return neg ? -cents : cents;
}
function decimalStringFromBigint(cents) {
    const neg = cents < 0n;
    const abs = neg ? -cents : cents;
    const whole = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, '0');
    return `${neg ? '-' : ''}${whole}.${frac}`;
}
function pctChange(current, previous) {
    const c = Number(current || 0);
    const p = Number(previous || 0);
    if (p === 0 && c === 0) return 0;
    if (p === 0) return null;
    return Math.round(((c - p) / p) * 10000) / 100;
}

// ─── RPC wrapper: throws typed RPC_MISSING on 42883/PGRST202 ─────
async function rpc(name, args) {
    const { data, error } = await supabaseAdmin.rpc(name, args);
    if (error) {
        if (RPC_MISSING_CODES.has(error.code)) {
            throw rpcMissing(`RPC ${name} is not deployed. Run migrations/2025_revenue_analytics.sql.`);
        }
        throw typedError(500, 'RPC_FAILED', `RPC ${name} failed: ${error.message}`);
    }
    return data || [];
}

// ─── Held funds (via admin_ledger_balances, SQL aggregate fallback) ──
async function getHeldFunds() {
    try {
        const data = await rpc('admin_ledger_balances', {});
        const out = [];
        for (const row of data || []) {
            out.push({
                currency: String(row.currency || '').toUpperCase(),
                available: money(row.available),
                held: money(row.held),
                total: money(row.total)
            });
        }
        if (out.length) return { available: true, currencies: out };
    } catch (e) {
        if (!RPC_MISSING_CODES.has(e.code)) {
            // Real failure — surface it as a soft-unavailable block.
            return { available: false, reason: 'HELD_FUNDS_FAILED', message: e.message };
        }
    }
    // Fallback: SQL aggregate (no row loading into Node).
    try {
        const { data, error } = await supabaseAdmin
            .from('ledger_accounts')
            .select('currency, available_balance, held_balance');
        if (error) throw error;
        const totals = new Map();
        for (const row of data || []) {
            const ccy = String(row.currency || 'NGN').toUpperCase();
            const cur = totals.get(ccy) || { available: 0n, held: 0n };
            cur.available += bigintFromDecimalString(money(row.available_balance));
            cur.held += bigintFromDecimalString(money(row.held_balance));
            totals.set(ccy, cur);
        }
        const out = [];
        for (const [ccy, t] of totals) {
            out.push({
                currency: ccy,
                available: decimalStringFromBigint(t.available),
                held: decimalStringFromBigint(t.held),
                total: decimalStringFromBigint(t.available + t.held)
            });
        }
        return { available: true, currencies: out };
    } catch (e) {
        return { available: false, reason: 'HELD_FUNDS_FAILED', message: e.message };
    }
}

// ─── getSummary ──────────────────────────────────────────────────
/**
 * Returns per-currency summary, combinedNgn, orders, funding, heldFunds,
 * insights. Throws typed errors on validation / RPC missing. Per-block
 * failures (funding, held) return available:false rather than zeroing.
 */
async function getSummary(inputScope) {
    const scope = normalizeScope(inputScope);
    const cached = getCachedSummary(scope);
    if (cached) return cached;

    const prev = previousPeriod(scope.from, scope.to);

    // Fire everything at once — including FX.
    const [
        currentRpc,
        prevRpc,
        fundingRes,
        heldFunds,
        fx
    ] = await Promise.allSettled([
        rpc('revenue_summary', { p_from: scope.from, p_to: scope.to, p_currency: scope.currency }),
        rpc('revenue_summary', { p_from: prev.from, p_to: prev.to, p_currency: scope.currency }),
        rpc('revenue_funding_summary', { p_from: scope.from, p_to: scope.to, p_currency: scope.currency }),
        getHeldFunds(),
        getUsdToNgnRate()
    ]);

    // RPC-missing is fatal: the whole feature can't work.
    for (const r of [currentRpc, prevRpc]) {
        if (r.status === 'rejected' && r.reason?.code === 'REVENUE_RPC_NOT_DEPLOYED') throw r.reason;
    }
    if (currentRpc.status === 'rejected') throw currentRpc.reason;
    if (prevRpc.status === 'rejected') throw prevRpc.reason;

    const fxMeta = fx.status === 'fulfilled' ? fx.value : { usdToNgn: 1600, source: 'fallback', asOf: new Date().toISOString() };

    const currentRows = currentRpc.value || [];
    const prevRows = prevRpc.value || [];
    const prevByCcy = new Map(prevRows.map(r => [String(r.currency).toUpperCase(), r]));

    const currencies = currentRows.map(r => {
        const ccy = String(r.currency).toUpperCase();
        const p = prevByCcy.get(ccy);
        return {
            currency: ccy,
            revenue: money(r.gross_revenue),
            net: money(r.net_revenue),
            providerCost: money(r.provider_cost),
            profit: money(r.gross_profit),
            refunds: money(r.refunds),
            marginPct: r.margin_pct != null ? Number(r.margin_pct) : null,
            aov: r.aov != null ? Number(r.aov) : null,
            estimatedProfit: !!r.estimated_profit,
            changePct: pctChange(r.gross_revenue, p?.gross_revenue),
            previous: p ? {
                revenue: money(p.gross_revenue),
                net: money(p.net_revenue),
                providerCost: money(p.provider_cost),
                profit: money(p.gross_profit),
                refunds: money(p.refunds)
            } : null,
            orders: {
                total: Number(r.total_orders || 0),
                completed: Number(r.completed_orders || 0),
                pending: Number(r.pending_orders || 0),
                failed: Number(r.failed_orders || 0),
                refunded: Number(r.refunded_orders || 0)
            }
        };
    });

    // Aggregate order counts (counts are safe to sum across currencies).
    const orders = {
        total: currencies.reduce((s, c) => s + c.orders.total, 0),
        completed: currencies.reduce((s, c) => s + c.orders.completed, 0),
        pending: currencies.reduce((s, c) => s + c.orders.pending, 0),
        failed: currencies.reduce((s, c) => s + c.orders.failed, 0),
        refunded: currencies.reduce((s, c) => s + c.orders.refunded, 0)
    };
    orders.completionRate = orders.total > 0
        ? Math.round((orders.completed / orders.total) * 10000) / 100
        : null;

    // combinedNgn: per-currency totals × fx, NOT mixed rows.
    let combinedNgn = null;
    if (currencies.length) {
        try {
            let totalCents = 0n;
            for (const c of currencies) {
                const cents = bigintFromDecimalString(c.revenue);
                if (c.currency === 'NGN') totalCents += cents;
                else if (c.currency === 'USD') {
                    const fxCents = BigInt(Math.round(fxMeta.usdToNgn * 100));
                    totalCents += (cents * fxCents) / 100n;
                }
            }
            combinedNgn = {
                amount: decimalStringFromBigint(totalCents),
                approximate: true,
                fxRate: fxMeta.usdToNgn,
                fxSource: fxMeta.source,
                fxAsOf: fxMeta.asOf
            };
        } catch (_) { combinedNgn = null; }
    }

    // Funding
    let funding;
    if (fundingRes.status === 'fulfilled') {
        funding = (fundingRes.value || []).map(r => ({
            currency: String(r.currency).toUpperCase(),
            depositsCount: Number(r.deposits_count || 0),
            depositsTotal: money(r.deposits_total),
            avgDeposit: money(r.avg_deposit),
            largestDeposit: money(r.largest_deposit)
        }));
    } else {
        funding = { available: false, reason: 'FUNDING_FAILED', message: fundingRes.reason?.message || 'Unavailable' };
    }

    // Insights: top product / provider / best day (best-effort; failures don't
    // fail the whole summary).
    const insights = { topProduct: null, topProvider: null, bestDay: null };
    try {
        const [products, providers, ts] = await Promise.allSettled([
            rpc('revenue_by_product', { p_from: scope.from, p_to: scope.to, p_currency: scope.currency }),
            rpc('revenue_by_provider', { p_from: scope.from, p_to: scope.to, p_currency: scope.currency }),
            rpc('revenue_timeseries', { p_from: scope.from, p_to: scope.to, p_granularity: 'day', p_currency: scope.currency })
        ]);
        if (products.status === 'fulfilled' && products.value.length) {
            const top = products.value[0];
            insights.topProduct = { product: top.product, currency: String(top.currency).toUpperCase(), revenue: money(top.revenue) };
        }
        if (providers.status === 'fulfilled' && providers.value.length) {
            const top = providers.value[0];
            insights.topProvider = { provider: top.provider, currency: String(top.currency).toUpperCase(), revenue: money(top.revenue) };
        }
        if (ts.status === 'fulfilled' && ts.value.length) {
            const best = ts.value.reduce((a, b) => Number(b.revenue) > Number(a.revenue) ? b : a);
            insights.bestDay = { bucket: best.bucket, currency: String(best.currency).toUpperCase(), revenue: money(best.revenue) };
        }
    } catch (_) { /* best-effort */ }

    const result = {
        available: true,
        scope: { from: scope.from, to: scope.to, currency: scope.currency, preset: scope.preset, label: scope.label, days: scope.days, previous: prev },
        fx: { usdToNgn: fxMeta.usdToNgn, source: fxMeta.source, asOf: fxMeta.asOf },
        currencies,
        combinedNgn,
        orders,
        funding,
        heldFunds: heldFunds.status === 'fulfilled' ? heldFunds.value : { available: false, reason: 'HELD_FUNDS_FAILED' },
        insights
    };
    setCachedSummary(scope, result);
    return result;
}

// ─── getTimeseries ───────────────────────────────────────────────
async function getTimeseries(input) {
    const scope = normalizeScope(input);
    const grain = ['day','week','month'].includes(input?.granularity) ? input.granularity : 'day';
    const rows = await rpc('revenue_timeseries', {
        p_from: scope.from, p_to: scope.to, p_granularity: grain, p_currency: scope.currency
    });

    // Group by bucket, then currency (SQL already zero-fills).
    const byBucket = new Map();
    for (const r of rows) {
        const key = r.bucket;
        if (!byBucket.has(key)) byBucket.set(key, { bucket: key, NGN: null, USD: null, orders: 0 });
        const entry = byBucket.get(key);
        const ccy = String(r.currency).toUpperCase();
        entry[ccy] = {
            revenue: money(r.revenue),
            providerCost: money(r.provider_cost),
            refunds: money(r.refunds),
            profit: money(r.profit)
        };
        entry.orders += Number(r.orders || 0);
    }
    return {
        available: true,
        scope: { from: scope.from, to: scope.to, currency: scope.currency, label: scope.label },
        granularity: grain,
        points: Array.from(byBucket.values()).sort((a, b) => new Date(a.bucket) - new Date(b.bucket))
    };
}

// ─── getByProduct ────────────────────────────────────────────────
async function getByProduct(input) {
    const scope = normalizeScope(input);
    const rows = await rpc('revenue_by_product', { p_from: scope.from, p_to: scope.to, p_currency: scope.currency });
    const totalByCcy = new Map();
    for (const r of rows) {
        const ccy = String(r.currency).toUpperCase();
        totalByCcy.set(ccy, (totalByCcy.get(ccy) || 0) + Number(r.revenue || 0));
    }
    return {
        available: true,
        scope,
        products: rows.map(r => {
            const ccy = String(r.currency).toUpperCase();
            const total = totalByCcy.get(ccy) || 0;
            return {
                product: r.product,
                currency: ccy,
                orders: Number(r.orders || 0),
                revenue: money(r.revenue),
                providerCost: money(r.provider_cost),
                refunds: money(r.refunds),
                profit: money(r.profit),
                marginPct: r.margin_pct != null ? Number(r.margin_pct) : null,
                shareOfRevenue: total > 0 ? Math.round((Number(r.revenue) / total) * 10000) / 100 : null
            };
        })
    };
}

// ─── getByProvider ───────────────────────────────────────────────
async function getByProvider(input) {
    const scope = normalizeScope(input);
    const rows = await rpc('revenue_by_provider', { p_from: scope.from, p_to: scope.to, p_currency: scope.currency });
    const totalByCcy = new Map();
    for (const r of rows) {
        const ccy = String(r.currency).toUpperCase();
        totalByCcy.set(ccy, (totalByCcy.get(ccy) || 0) + Number(r.revenue || 0));
    }
    return {
        available: true,
        scope,
        providers: rows.map(r => {
            const ccy = String(r.currency).toUpperCase();
            const total = totalByCcy.get(ccy) || 0;
            return {
                provider: r.provider,
                currency: ccy,
                orders: Number(r.orders || 0),
                revenue: money(r.revenue),
                providerCost: money(r.provider_cost),
                refunds: money(r.refunds),
                profit: money(r.profit),
                failedOrders: Number(r.failed_orders || 0),
                shareOfRevenue: total > 0 ? Math.round((Number(r.revenue) / total) * 10000) / 100 : null
            };
        })
    };
}

// ─── getRefunds ──────────────────────────────────────────────────
async function getRefunds(input) {
    const scope = normalizeScope(input);
    const limit = Math.min(Math.max(parseInt(input?.limit, 10) || 50, 1), 500);
    const page  = Math.max(parseInt(input?.page, 10) || 1, 1);
    const offset = (page - 1) * limit;
    const rows = await rpc('revenue_refunds', {
        p_from: scope.from, p_to: scope.to, p_currency: scope.currency,
        p_limit: limit, p_offset: offset
    });
    const totalCount = rows[0]?.total_count ? Number(rows[0].total_count) : rows.length;

    const userIds = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
    let profilesById = new Map();
    if (userIds.length) {
        const { data: profiles, error } = await supabaseAdmin
            .from('profiles').select('id, username, email').in('id', userIds);
        if (!error) profilesById = new Map((profiles || []).map(p => [p.id, p]));
    }

    return {
        available: true,
        scope,
        page, limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        refunds: rows.map(r => {
            const p = profilesById.get(r.user_id) || {};
            return {
                refundId: r.refund_id,
                orderRef: r.order_ref,
                product: r.product_type,
                provider: r.provider,
                currency: String(r.currency).toUpperCase(),
                amount: money(r.refund_amount),
                reference: r.refund_reference,
                reason: r.reason,
                refundedAt: r.refunded_at,
                user: {
                    id: r.user_id,
                    username: p.username || (p.email ? String(p.email).split('@')[0] : 'User'),
                    email: p.email || null
                }
            };
        })
    };
}

// ─── getTopCustomers ────────────────────────────────────────────
async function getTopCustomers(input) {
    const scope = normalizeScope(input);
    const limit = Math.min(Math.max(parseInt(input?.limit, 10) || 20, 1), 100);
    const rows = await rpc('revenue_top_customers', {
        p_from: scope.from, p_to: scope.to, p_currency: scope.currency, p_limit: limit
    });
    const userIds = rows.map(r => r.user_id).filter(Boolean);
    let profilesById = new Map();
    if (userIds.length) {
        const { data: profiles, error } = await supabaseAdmin
            .from('profiles').select('id, username, email').in('id', userIds);
        if (!error) profilesById = new Map((profiles || []).map(p => [p.id, p]));
    }
    return {
        available: true,
        scope,
        customers: rows.map(r => {
            const p = profilesById.get(r.user_id) || {};
            return {
                user: {
                    id: r.user_id,
                    username: p.username || (p.email ? String(p.email).split('@')[0] : 'User'),
                    email: p.email || null
                },
                currency: String(r.currency).toUpperCase(),
                orders: Number(r.orders || 0),
                spent: money(r.spent),
                refunded: money(r.refunded),
                netSpend: money(r.net_spend),
                lastOrder: r.last_order
            };
        })
    };
}

// ─── getFunding ─────────────────────────────────────────────────
async function getFunding(input) {
    const scope = normalizeScope(input);
    const rows = await rpc('revenue_funding_summary', {
        p_from: scope.from, p_to: scope.to, p_currency: scope.currency
    });
    return {
        available: true,
        scope,
        funding: rows.map(r => ({
            currency: String(r.currency).toUpperCase(),
            depositsCount: Number(r.deposits_count || 0),
            depositsTotal: money(r.deposits_total),
            avgDeposit: money(r.avg_deposit),
            largestDeposit: money(r.largest_deposit)
        }))
    };
}

// ─── getDailyTable ──────────────────────────────────────────────
async function getDailyTable(input) {
    const ts = await getTimeseries({ ...input, granularity: 'day' });
    const totals = {};
    for (const p of ts.points) {
        for (const ccy of ['NGN', 'USD']) {
            if (!p[ccy]) continue;
            totals[ccy] = totals[ccy] || { revenue: 0, providerCost: 0, refunds: 0, profit: 0, orders: 0 };
            totals[ccy].revenue += Number(p[ccy].revenue);
            totals[ccy].providerCost += Number(p[ccy].providerCost);
            totals[ccy].refunds += Number(p[ccy].refunds);
            totals[ccy].profit += Number(p[ccy].profit);
        }
        totals.NGN = totals.NGN || { orders: 0 }; totals.USD = totals.USD || { orders: 0 };
        totals.NGN.orders += p.NGN ? 0 : 0; // orders already per-bucket
    }
    const totalsRow = Object.entries(totals).map(([ccy, t]) => ({
        currency: ccy,
        revenue: String(t.revenue),
        providerCost: String(t.providerCost),
        refunds: String(t.refunds),
        profit: String(t.profit)
    }));
    return { available: true, scope: ts.scope, days: ts.points, totals: totalsRow };
}

// ─── CSV export ────────────────────────────────────────────────
function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Formula injection guard: leading = + - @ tab CR are prefixed with '
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) return `"'${s.replace(/"/g,'""')}"`;
    return `"${s.replace(/"/g, '""')}"`;
}
function csvRow(cells) { return cells.map(csvCell).join(','); }

async function exportCsv(input) {
    const kind = String(input?.kind || 'summary').toLowerCase();
    const scope = normalizeScope(input);
    const header = `# MilesSpace Revenue Export\n# kind: ${kind}\n# from: ${scope.from}\n# to: ${scope.to}\n# currency: ${scope.currency || 'all'}\n# generated_at: ${new Date().toISOString()}\n`;
    const BOM = '\uFEFF';
    let body;

    switch (kind) {
        case 'summary': {
            const s = await getSummary(input);
            if (!s.available) throw typedError(503, 'REVENUE_RPC_NOT_DEPLOYED', s.reason);
            const rows = [['Currency','Revenue','Net Revenue','Provider Cost','Profit','Refunds','Margin %','AOV','Orders Completed','Orders Failed','Change %']];
            for (const c of s.currencies) {
                rows.push([c.currency, c.revenue, c.net, c.providerCost, c.profit, c.refunds,
                    c.marginPct ?? '', c.aov ?? '', c.orders.completed, c.orders.failed, c.changePct ?? '']);
            }
            body = rows.map(csvRow).join('\n');
            break;
        }
        case 'timeseries':
        case 'daily': {
            const t = kind === 'daily' ? await getDailyTable(input) : await getTimeseries(input);
            if (!t.available) throw typedError(503, 'REVENUE_RPC_NOT_DEPLOYED', t.reason);
            const rows = [['Bucket','Currency','Revenue','Provider Cost','Refunds','Profit','Orders']];
            const pts = kind === 'daily' ? t.days : t.points;
            for (const p of pts) {
                for (const ccy of ['NGN','USD']) {
                    if (!p[ccy]) continue;
                    rows.push([p.bucket, ccy, p[ccy].revenue, p[ccy].providerCost, p[ccy].refunds, p[ccy].profit, p.NGN ? 0 : 0]);
                }
            }
            body = rows.map(csvRow).join('\n');
            break;
        }
        case 'products': {
            const r = await getByProduct(input);
            if (!r.available) throw typedError(503, 'REVENUE_RPC_NOT_DEPLOYED', r.reason);
            const rows = [['Product','Currency','Orders','Revenue','Provider Cost','Refunds','Profit','Margin %','Share %']];
            for (const p of r.products) rows.push([p.product,p.currency,p.orders,p.revenue,p.providerCost,p.refunds,p.profit,p.marginPct ?? '',p.shareOfRevenue ?? '']);
            body = rows.map(csvRow).join('\n');
            break;
        }
        case 'providers': {
            const r = await getByProvider(input);
            if (!r.available) throw typedError(503, 'REVENUE_RPC_NOT_DEPLOYED', r.reason);
            const rows = [['Provider','Currency','Orders','Revenue','Provider Cost','Refunds','Profit','Failed Orders','Share %']];
            for (const p of r.providers) rows.push([p.provider,p.currency,p.orders,p.revenue,p.providerCost,p.refunds,p.profit,p.failedOrders,p.shareOfRevenue ?? '']);
            body = rows.map(csvRow).join('\n');
            break;
        }
        case 'refunds': {
            const r = await getRefunds({ ...input, limit: 500, page: 1 });
            if (!r.available) throw typedError(503, 'REVENUE_RPC_NOT_DEPLOYED', r.reason);
            const rows = [['Order','Customer','Email','Product','Provider','Currency','Amount','Reference','Reason','Refunded At']];
            for (const x of r.refunds) rows.push([x.orderRef, x.user.username, x.user.email || '', x.product, x.provider, x.currency, x.amount, x.reference || '', x.reason || '', x.refundedAt]);
            body = rows.map(csvRow).join('\n');
            break;
        }
        case 'customers': {
            const r = await getTopCustomers({ ...input, limit: 100 });
            if (!r.available) throw typedError(503, 'REVENUE_RPC_NOT_DEPLOYED', r.reason);
            const rows = [['Customer','Email','Currency','Orders','Spent','Refunded','Net Spend','Last Order']];
            for (const c of r.customers) rows.push([c.user.username, c.user.email || '', c.currency, c.orders, c.spent, c.refunded, c.netSpend, c.lastOrder]);
            body = rows.map(csvRow).join('\n');
            break;
        }
        default:
            throw validation(`Unknown export kind: ${kind}`, 'INVALID_EXPORT_KIND');
    }

    if (body.split('\n').length > 10000) {
        throw typedError(413, 'EXPORT_TOO_LARGE', 'Export exceeds 10,000 rows. Narrow the range.');
    }
    return BOM + header + '\n' + body + '\n';
}

// ─── Meta ──────────────────────────────────────────────────────
async function getMeta() {
    const fx = await getUsdToNgnRate();
    return {
        currencies: ['NGN', 'USD'],
        presets: VALID_PRESETS,
        timezone: TZ,
        maxRangeDays: MAX_RANGE_DAYS,
        fx
    };
}

module.exports = {
    normalizeScope,
    previousPeriod,
    getSummary,
    getTimeseries,
    getByProduct,
    getByProvider,
    getRefunds,
    getTopCustomers,
    getFunding,
    getDailyTable,
    exportCsv,
    getMeta,
    getUsdToNgnRate
};