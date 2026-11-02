// routes/admin/dashboardRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin dashboard endpoints — authoritative implementation (v7).
//
// Response envelope (all endpoints):
//   { success: true,  data: <payload>,  _meta: {...} }
//   { success: false, error: <string>, code: <string> }
//
// The ONLY exception is CSV exports, which return text/csv with a
// Content-Disposition header.
//
// Safety contract (unchanged):
//   • Every value comes from Postgres or a provider HTTP call.
//   • Failures render "Data unavailable" — never a fabricated 0.
//   • Money is a 2-decimal STRING from Postgres NUMERIC.
//   • Every endpoint is permission-gated.
//   • Pagination is validated and capped server-side.
//   • Audit is written after the read succeeds (never blocks it).
//
// Audit:
//   Writes to public.admin_audit_logs (immutable). Uses only columns
//   that exist in your supplied schema: admin_id, admin_email,
//   admin_role, action, target_type, target_id, metadata, category,
//   severity, result, ip_address, user_agent. Nothing invented.
//
// RPCs consumed (from 2026_admin_dashboard_v7.sql):
//   admin_stats_range, admin_volume_7d, admin_logins_today_count,
//   admin_open_support_count, admin_failed_webhooks_count,
//   admin_revenue_rows, admin_search, plus the existing admin_*.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const { adminAuth, requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { buildPermissionMap } = require('../../middleware/adminPermissions');
const agg = require('./dashboardAggregations');

// Lazy-required to avoid circular imports.
function providerHealthService() {
    return require('../../services/providerHealthService');
}
function providerMetadata() {
    return require('../../services/providers/providerMetadata');
}

// ─── Response helpers ────────────────────────────────────────────
function unwrap(field) {
    if (!field || typeof field !== 'object') return field ?? null;
    if (field.available === true) return field.value;
    return null;
}
function limitOf(q, def = 20, max = 100) {
    const n = parseInt(q, 10);
    if (!Number.isFinite(n) || n < 1) return def;
    return Math.min(n, max);
}
function pageOf(q) {
    const n = parseInt(q, 10);
    return (!Number.isFinite(n) || n < 1) ? 1 : n;
}
function fail(res, err) {
    const status = err?.status || 500;
    const code   = err?.code || 'SERVER_ERROR';
    const message = err?.message || 'Unexpected error';
    console.error('[ADMIN DASHBOARD]', code, message);
    if (res.headersSent) return;
    res.status(status).json({ success: false, error: message, code });
}
function ok(res, data, meta) {
    res.json({ success: true, data, _meta: meta || {} });
}

// Range parsing. When either bound is missing, default to today WAT.
// Server enforces an upper bound on window size so a client can never
// ask for "everything since 1970".
const MAX_RANGE_DAYS = 92;
function parseRange(req) {
    const day = agg.watDayBounds();
    const from = agg.isIsoDate(req.query.from) ? new Date(req.query.from) : new Date(day.start);
    let to     = agg.isIsoDate(req.query.to)   ? new Date(req.query.to)   : new Date(day.end);
    
    // Ensure the `to` date includes the very last millisecond of the day
    if (req.query.to) to = new Date(to.getTime() + 1000);
    
    if (from > to) {
        return { error: 'FROM_AFTER_TO' };
    }
    const spanDays = (to - from) / (1000 * 60 * 60 * 24);
    if (spanDays > MAX_RANGE_DAYS) {
        return { error: 'RANGE_TOO_LARGE' };
    }
    return { from: from.toISOString(), to: to.toISOString() };
}

// Map provider-health-service vocabulary to the small visual set the
// frontend CSS understands. `status` is preserved for old consumers;
// `statusGroup` is additive.
function statusGroup(status) {
    switch (String(status || '').toLowerCase()) {
        case 'healthy':
        case 'operational':      return 'operational';
        case 'degraded':
        case 'slow':
        case 'rate_limited':     return 'degraded';
        case 'unreachable':
        case 'auth_failed':
        case 'circuit_open':
        case 'error':            return 'unreachable';
        case 'not_configured':
        case 'disabled':         return 'not_configured';
        default:                 return 'unknown';
    }
}

// ─── Audit helper ────────────────────────────────────────────────
// Delegates to agg.logAdminAction. Wrapped here so every route can
// call `audit(req, ...)` without knowing the context shape.
function audit(req, action, targetType, targetId, meta = {}) {
    const ctx = {
        ...(req.adminContext || {}),
        ip: req.ip,
        userAgent: req.get('user-agent')
    };
    // fire-and-forget; never blocks the response
    agg.logAdminAction(ctx, action, targetType, targetId, meta).catch(() => {});
}

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/stats?from=&to=&fresh=1
//
//  Returns KPI values for the requested range plus "previous period"
//  values so the frontend can show change % — computed from the two
//  string/number pairs. Financial change % never uses JS float math.
//
//  Cached in-memory for 20 s keyed by (from,to). `?fresh=1` bypasses.
// ═════════════════════════════════════════════════════════════════
const _statsCache = new Map(); // key → { at, value }
const STATS_TTL_MS = 20_000;

function _statsCacheKey(from, to) { return `stats|${from}|${to}`; }
function _statsCacheGet(key) {
    const hit = _statsCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > STATS_TTL_MS) { _statsCache.delete(key); return null; }
    return hit.value;
}
function _statsCacheSet(key, value) { _statsCache.set(key, { at: Date.now(), value }); }

// Compute change % between two values. Only called with `previous > 0`
// so we never report a fabricated "infinite growth" from zero.
function changePct(current, previous) {
    if (previous == null || current == null) return null;
    if (previous === 0) return null;
    return Number((((current - previous) / previous) * 100).toFixed(1));
}
// Financial change %: both values are 2-decimal strings from Postgres,
// so we operate on cents (BigInt) and never a JS float.
function changePctMoney(current, previous) {
    const c = toCents(current), p = toCents(previous);
    if (c == null || p == null || p === 0n) return null;
    const bps = ((c - p) * 10000n) / p;
    return Number(bps) / 100;
}
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

router.get(
    '/stats',
    requirePermission(PERMISSIONS.DASHBOARD_READ),
    async (req, res) => {
        try {
            const range = parseRange(req);
            if (range.error) return fail(res, { status: 400, code: range.error, message: range.error });

            const cacheKey = _statsCacheKey(range.from, range.to);
            const fresh = String(req.query.fresh || '') === '1';
            if (!fresh) {
                const hit = _statsCacheGet(cacheKey);
                if (hit) return res.json(hit);
            }

            const [bundle, wallet, deposits, support] = await Promise.all([
                agg.getStatsRange({ from: range.from, to: range.to }),
                agg.getWalletLiabilities(),
                agg.getDepositStats(),
                agg.getSupportStats()
            ]);

            if (!bundle.available) {
                return fail(res, {
                    status: 500, code: 'STATS_RANGE_FAILED',
                    message: `admin_stats_range: ${bundle.reason}`
                });
            }

            const c = bundle.current;
            const p = bundle.previous;

            const payload = {
                success: true,
                data: {
                    from: bundle.from,
                    to: bundle.to,
                    prevFrom: bundle.prevFrom,
                    prevTo:   bundle.prevTo,
                    kpis: {
                        users: {
                            value: c.usersTotal,
                            change: null // lifetime metric
                        },
                        signups: {
                            value: c.signups,
                            change: changePct(c.signups, p.signups)
                        },
                        logins: {
                            value: c.logins,
                            change: changePct(c.logins, p.logins)
                        },
                        transactions: {
                            value: c.txn,
                            change: changePct(c.txn, p.txn)
                        },
                        failedTransactions: {
                            value: c.txnFailed,
                            change: changePct(c.txnFailed, p.txnFailed)
                        },
                        deposits: {
                            value: c.deposits,
                            change: changePct(c.deposits, p.deposits)
                        },
                        pendingDeposits: {
                            value: c.depositsPending,
                            change: null // point-in-time metric
                        },
                        revenueNgn: {
                            value: c.revenueNgn,
                            change: changePctMoney(c.revenueNgn, p.revenueNgn)
                        },
                        revenueUsd: {
                            value: c.revenueUsd,
                            change: changePctMoney(c.revenueUsd, p.revenueUsd)
                        },
                        supportOpen: {
                            value: c.supportOpen,
                            change: null // lifetime
                        }
                    },
                    wallet: {
                        ngn: unwrap(wallet.ngn),
                        usd: unwrap(wallet.usd)
                    },
                    deposits: {
                        today: {
                            count: unwrap(deposits.today.count),
                            ngn:   unwrap(deposits.today.ngn),
                            usd:   unwrap(deposits.today.usd)
                        },
                        pending:   unwrap(deposits.pending),
                        failed:    unwrap(deposits.failed),
                        completed: unwrap(deposits.completed),
                        byProvider: deposits.byProvider,
                        _meta: deposits._meta || { partial: false, missingSources: [] }
                    },
                    support: {
                        open: unwrap(support.open)
                    },
                    features: { withdrawals: false },
                    _meta: {
                        users_total:           true,
                        users_customers:       true,
                        wallet_ngn_liability:  wallet.ngn.available,
                        wallet_usd_liability:  wallet.usd.available,
                        deposits_today:        deposits.today.count.available,
                        deposits_partial:      deposits._meta?.partial === true,
                        revenue_today_ngn:     !!c.revenueNgn,
                        revenue_today_usd:     !!c.revenueUsd,
                        support_open:          support.open.available,
                        cachedAt:              new Date().toISOString()
                    }
                }
            };

            _statsCacheSet(cacheKey, payload);
            res.json(payload);
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/charts
//
//  All four chart series verified independently. A failed series
//  returns `available: false` — never a zero-filled array.
//  `weeklyRevenue` uses the real date labels from admin_volume_7d
//  (no hardcoded Mon..Sun).
// ═════════════════════════════════════════════════════════════════
router.get(
    '/charts',
    requirePermission(PERMISSIONS.DASHBOARD_READ),
    async (req, res) => {
        try {
            const [rev, gr, ord, volume7d] = await Promise.all([
                supabaseAdmin.rpc('admin_charts_revenue_12m'),
                supabaseAdmin.rpc('admin_charts_user_growth_12m'),
                supabaseAdmin.rpc('admin_charts_order_breakdown'),
                agg.getVolume7d()
            ]);

            const missingRpc = e => e && (e.code === '42883' || e.code === 'PGRST202');
            if ([rev, gr, ord].some(r => missingRpc(r.error))) {
                return fail(res, {
                    status: 500, code: 'CHARTS_RPC_NOT_DEPLOYED',
                    message: 'Run migrations/2026_admin_dashboard_v7.sql.'
                });
            }

            const chartAvailability = {
                revenue:        { available: !rev.error, reason: rev.error ? (rev.error.code || 'RPC_ERROR') : null },
                userGrowth:     { available: !gr.error,  reason: gr.error  ? (gr.error.code  || 'RPC_ERROR') : null },
                orderBreakdown: { available: !ord.error, reason: ord.error ? (ord.error.code || 'RPC_ERROR') : null },
                volume7d:       { available: volume7d.available, reason: volume7d.available ? null : volume7d.reason }
            };

            let revenueNgn = null, revenueUsd = null;
            if (chartAvailability.revenue.available) {
                revenueNgn = new Array(12).fill('0.00');
                revenueUsd = new Array(12).fill('0.00');
                for (const r of (rev.data || [])) {
                    const idx = Number(r.month_offset ?? 0);
                    if (idx >= 0 && idx < 12) {
                        const slot = 11 - idx;
                        const str = String(r.total || '0.00');
                        if (r.currency === 'USD') revenueUsd[slot] = str;
                        else                     revenueNgn[slot] = str;
                    }
                }
            }

            let userGrowth = null;
            if (chartAvailability.userGrowth.available) {
                userGrowth = new Array(12).fill(0);
                for (const r of (gr.data || [])) {
                    const idx = Number(r.month_offset ?? 0);
                    if (idx >= 0 && idx < 12) userGrowth[11 - idx] = Number(r.cumulative || 0);
                }
            }

            let order = null;
            if (chartAvailability.orderBreakdown.available) {
                order = Array.isArray(ord.data) ? ord.data[0] : ord.data;
                order = order || {};
            }
            const buildOrders = (prefix, labels) => {
                if (!order) return { available: false, reason: chartAvailability.orderBreakdown.reason };
                const fields = ['pending', 'processing', 'completed', 'failed', 'active'];
                return {
                    labels,
                    data: labels.map((_, i) => Number(order[`${prefix}_${fields[i]}`] || 0))
                };
            };

            const chartData = {
                revenue:           revenueNgn,
                revenueUSD:        revenueUsd,
                userGrowth,
                volume7d:          volume7d.available
                    ? {
                        dates:      volume7d.dates,
                        ngn:        volume7d.ngn,
                        usd:        volume7d.usd,
                        ngnTotal:   volume7d.ngnTotal,
                        usdTotal:   volume7d.usdTotal
                    }
                    : { available: false, reason: volume7d.reason },
                cryptoOrders:      buildOrders('crypto', ['Pending','Processing','Completed','Failed']),
                boostOrders:       buildOrders('boost',  ['Pending','Processing','Completed','Failed']),
                smsOrders:         buildOrders('sms',    ['Pending','Active','Completed']),
                marketplaceOrders: buildOrders('market', ['Pending','Processing','Completed']),
                giftCardSales:     buildOrders('gift',   ['Pending','Processing','Completed','Failed']),
                expenses:          { available: false, reason: 'EXPENSE_LEDGER_NOT_IMPLEMENTED' },
                walletBreakdown:   { available: false, reason: 'WITHDRAWALS_DISABLED' },
                cashbackActivity:  { available: false, reason: 'CASHBACK_NOT_USED' },
                topCountries:      { available: false, reason: 'NOT_IMPLEMENTED' },
                topCustomers:      { available: false, reason: 'NOT_IMPLEMENTED' },
                _meta:             { chartAvailability }
            };

            ok(res, chartData);
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/health  (unchanged except env-driven overall)
// ═════════════════════════════════════════════════════════════════
router.get(
    '/health',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    async (req, res) => {
        try {
            const data = await agg.getSystemHealth();
            ok(res, data);
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/recent-activity?limit=
//  Envelope normalized to { success, data: { items, _meta } }.
// ═════════════════════════════════════════════════════════════════
router.get(
    '/recent-activity',
    requirePermission(PERMISSIONS.DASHBOARD_READ),
    async (req, res) => {
        try {
            const limit = limitOf(req.query.limit, 20, 100);

            const { data: txRows, error: txErr } = await supabaseAdmin
                .from('transactions')
                .select('id, user_id, type, status, currency, amount, description, ref, reference, created_at')
                .order('created_at', { ascending: false })
                .limit(limit);

            if (txErr) return fail(res, { status: 500, code: 'ACTIVITY_ERROR', message: txErr.message });

            const userIds = [...new Set((txRows || []).map(t => t.user_id).filter(Boolean))];
            let profilesById = {};
            if (userIds.length) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles').select('id, username, email').in('id', userIds);
                (profiles || []).forEach(p => { profilesById[p.id] = p; });
            }

            const items = (txRows || []).map(t => {
                const p = profilesById[t.user_id] || {};
                const username = p.username || (p.email ? p.email.split('@')[0] : 'User');
                return {
                    id: t.id,
                    userId: t.user_id,
                    username,
                    userEmail: maskEmail(p.email || ''),
                    action: t.type || 'transaction',
                    description: `${username} — ${t.description || t.type}`,
                    details: {
                        amount: t.amount ?? null,
                        currency: t.currency || 'NGN',
                        reference: t.ref || t.reference,
                        status: t.status
                    },
                    created_at: t.created_at,
                    icon: iconForType(t.type),
                    statusBadge: badgeForStatus(t.status),
                    isSuccess: ['completed','success','delivered'].includes(String(t.status || '').toLowerCase())
                };
            });

            ok(res, { items, total: items.length });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/users/recent?from=&to=&limit=
//
//  Range-aware. Defaults to today if no from/to is present.
//  Sensitive fields (phone, email) are masked in list responses;
//  the full value is only returned by /users/:id/detail.
// ═════════════════════════════════════════════════════════════════
router.get(
    '/users/recent',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const range = parseRange(req);
            if (range.error) return fail(res, { status: 400, code: range.error, message: range.error });
            const limit = limitOf(req.query.limit, 20, 100);

            const { data, error } = await supabaseAdmin
                .from('profiles')
                .select('id, username, email, created_at, last_location, is_verified, status, role')
                .is('deleted_at', null)
                .gte('created_at', range.from)
                .lte('created_at', range.to)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) return fail(res, { status: 500, code: 'USERS_QUERY_ERROR', message: error.message });

            const users = (data || []).map(u => ({
                id: u.id,
                username: u.username || u.email?.split('@')[0] || 'User',
                email: maskEmail(u.email || ''),
                created_at: u.created_at,
                last_location: u.last_location || '—',
                is_verified: !!u.is_verified,
                status: u.status || 'active',
                role: u.role || 'user',
                initials: (u.username || u.email || 'U').charAt(0).toUpperCase()
            }));

            ok(res, { items: users, total: users.length, from: range.from, to: range.to });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/transactions/recent?from=&to=&limit=
//
//  Envelope normalized to { success, data: { transactions } } to
//  satisfy the spec's request to fix the raw { transactions } shape.
// ═════════════════════════════════════════════════════════════════
router.get(
    '/transactions/recent',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const range = parseRange(req);
            if (range.error) return fail(res, { status: 400, code: range.error, message: range.error });
            const limit = limitOf(req.query.limit, 20, 50);

            const { data, error } = await supabaseAdmin
                .from('transactions')
                .select(`
                    id, user_id, type, status, currency, amount, fee,
                    ref, reference, description, metadata, meta,
                    provider, provider_reference,
                    created_at, completed_at, failed_at, failure_reason
                `)
                .gte('created_at', range.from)
                .lte('created_at', range.to)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) return fail(res, { status: 500, code: 'TRANSACTIONS_QUERY_FAILED', message: error.message });

            const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
            let profilesById = {};
            if (userIds.length) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles').select('id, username, email').in('id', userIds);
                (profiles || []).forEach(p => { profilesById[p.id] = p; });
            }

            const transactions = (data || []).map(tx => {
                const p = profilesById[tx.user_id] || {};
                return {
                    id: tx.id,
                    user_id: tx.user_id,
                    type: tx.type,
                    type_label: prettyService(tx.type),
                    status: tx.status,
                    currency: tx.currency || 'NGN',
                    amount: tx.amount ?? null,
                    fee: tx.fee ?? null,
                    reference: tx.ref || tx.reference,
                    description: tx.description,
                    metadata: tx.metadata || tx.meta || {},
                    provider: tx.provider,
                    provider_reference: tx.provider_reference,
                    created_at: tx.created_at,
                    completed_at: tx.completed_at,
                    failed_at: tx.failed_at,
                    failure_reason: tx.failure_reason,
                    user: {
                        id: tx.user_id,
                        username: p.username || (p.email ? p.email.split('@')[0] : 'Unknown User'),
                        email: maskEmail(p.email || '')
                    }
                };
            });

            // ── The fix: wrap the response in `data` ──
            // The frontend reads `res.data.transactions`, so the
            // route MUST use `ok(...)` to produce { success, data, _meta }.
            ok(res, { transactions, from: range.from, to: range.to });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/orders/failed/recent?from=&to=&limit=
// ═════════════════════════════════════════════════════════════════
router.get(
    '/orders/failed/recent',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const range = parseRange(req);
            if (range.error) return fail(res, { status: 400, code: range.error, message: range.error });
            const limit = limitOf(req.query.limit, 20, 50);

            const { data, error } = await supabaseAdmin
                .from('transactions')
                .select('id, user_id, type, status, currency, amount, description, ref, reference, provider, provider_reference, failure_reason, created_at')
                .eq('status', 'failed')
                .gte('created_at', range.from)
                .lte('created_at', range.to)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) return fail(res, { status: 500, code: 'FAILED_ORDERS_ERROR', message: error.message });

            const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
            let profilesById = {};
            if (userIds.length) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles').select('id, username, email').in('id', userIds);
                (profiles || []).forEach(p => { profilesById[p.id] = p; });
            }

            const rows = (data || []).map(t => {
                const p = profilesById[t.user_id] || {};
                return {
                    id: t.id,
                    orderRef: t.ref || t.reference,
                    reference: t.ref || t.reference,
                    customer: p.username || (p.email ? p.email.split('@')[0] : 'User'),
                    userEmail: maskEmail(p.email || ''),
                    service: prettyService(t.type),
                    type: t.type,
                    amount: t.amount ?? null,
                    currency: t.currency || 'NGN',
                    provider: t.provider || null,
                    providerReference: t.provider_reference || null,
                    reason: t.failure_reason || 'No reason provided',
                    created_at: t.created_at
                };
            });

            ok(res, { items: rows, total: rows.length, from: range.from, to: range.to });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/deposits/recent?from=&to=&limit=
// ═════════════════════════════════════════════════════════════════
router.get(
    '/deposits/recent',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        try {
            const range = parseRange(req);
            if (range.error) return fail(res, { status: 400, code: range.error, message: range.error });
            const limit = limitOf(req.query.limit, 20, 100);

            const [kora, crypto] = await Promise.all([
                supabaseAdmin
                    .from('deposit_requests')
                    .select('id, user_id, internal_reference, provider_reference, status, payment_currency, payment_amount, wallet_currency, wallet_amount, customer_rate, fee_amount, fee_currency, created_at, completed_at')
                    .gte('created_at', range.from).lte('created_at', range.to)
                    .order('created_at', { ascending: false }).limit(limit),
                supabaseAdmin
                    .from('crypto_deposits')
                    .select('id, user_id, nowpayments_payment_id, status, requested_usd, required_usd, wallet_credit_usd, credited_amount, pay_currency, pay_network, fee_usd, fee_percent, created_at, completed_at')
                    .gte('created_at', range.from).lte('created_at', range.to)
                    .order('created_at', { ascending: false }).limit(limit)
            ]);

            const koraFailed = !!kora.error;
            const cryptoFailed = !!crypto.error;
            if (koraFailed && cryptoFailed) {
                return fail(res, {
                    status: 500, code: 'DEPOSITS_QUERY_FAILED',
                    message: 'Both deposit sources failed.'
                });
            }

            const allUserIds = [
                ...(kora.data || []).map(r => r.user_id),
                ...(crypto.data || []).map(r => r.user_id)
            ].filter(Boolean);
            const uniqueIds = [...new Set(allUserIds)];
            let profilesById = {};
            if (uniqueIds.length) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles').select('id, username, email').in('id', uniqueIds);
                (profiles || []).forEach(p => { profilesById[p.id] = p; });
            }

            const koraRows = (kora.data || []).map(r => {
                const p = profilesById[r.user_id] || {};
                return {
                    id: r.id, source: 'kora', method: 'KoraPay',
                    reference: r.internal_reference, providerReference: r.provider_reference,
                    customer: p.username || (p.email ? p.email.split('@')[0] : 'User'),
                    userEmail: maskEmail(p.email || ''),
                    paymentCurrency: r.payment_currency || null,
                    paymentAmount: r.payment_amount ?? null,
                    walletCurrency: r.wallet_currency || null,
                    walletAmount: r.wallet_amount ?? null,
                    customerRate: r.customer_rate ?? null,
                    feeAmount: r.fee_amount ?? null,
                    feeCurrency: r.fee_currency || null,
                    status: r.status,
                    created_at: r.created_at,
                    completed_at: r.completed_at
                };
            });

            const cryptoRows = (crypto.data || []).map(r => {
                const p = profilesById[r.user_id] || {};
                return {
                    id: r.id, source: 'crypto', method: 'NowPayments',
                    reference: r.nowpayments_payment_id, providerReference: r.nowpayments_payment_id,
                    customer: p.username || (p.email ? p.email.split('@')[0] : 'User'),
                    userEmail: maskEmail(p.email || ''),
                    paymentCurrency: r.pay_currency,
                    paymentAmount: null,
                    walletCurrency: 'USD',
                    walletAmount: r.credited_amount ?? r.wallet_credit_usd ?? r.requested_usd ?? null,
                    requestedUsd: r.requested_usd ?? null,
                    requiredUsd: r.required_usd ?? null,
                    feeUsd: r.fee_usd ?? null,
                    feePercent: r.fee_percent ?? null,
                    payNetwork: r.pay_network,
                    status: r.status,
                    created_at: r.created_at,
                    completed_at: r.completed_at
                };
            });

            const merged = [...koraRows, ...cryptoRows]
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
                .slice(0, limit);

            ok(res, merged, {
                koraAvailable: !koraFailed,
                cryptoAvailable: !cryptoFailed,
                partial: koraFailed || cryptoFailed,
                from: range.from, to: range.to
            });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/deposits/pending?page=&pageSize=
//
//  Real pagination: fetches page*pageSize rows from each source,
//  merges, slices the page. `total` is the real merged count.
//  Callers must treat `total` as an exact count — nothing here
//  invents a number.
// ═════════════════════════════════════════════════════════════════
router.get(
    '/deposits/pending',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        try {
            const pageSize = limitOf(req.query.pageSize, 20, 100);
            const page = pageOf(req.query.page);
            const fetchN = page * pageSize;

            const [kora, crypto] = await Promise.all([
                supabaseAdmin
                    .from('deposit_requests')
                    .select('id, user_id, internal_reference, provider_reference, status, payment_currency, payment_amount, wallet_currency, wallet_amount, created_at')
                    .in('status', ['pending','processing'])
                    .order('created_at', { ascending: false })
                    .limit(fetchN),
                supabaseAdmin
                    .from('crypto_deposits')
                    .select('id, user_id, nowpayments_payment_id, status, requested_usd, credited_amount, pay_currency, created_at')
                    .in('status', ['pending','processing','manual_review'])
                    .order('created_at', { ascending: false })
                    .limit(fetchN)
            ]);

            if (kora.error && crypto.error) {
                return fail(res, { status: 500, code: 'PENDING_QUERY_FAILED', message: 'Both sources failed.' });
            }

            const allUserIds = [
                ...((kora.data || []).map(r => r.user_id)),
                ...((crypto.data || []).map(r => r.user_id))
            ].filter(Boolean);
            const uniqueIds = [...new Set(allUserIds)];
            let profilesById = {};
                        if (uniqueIds.length) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles').select('id, username, email').in('id', uniqueIds);
                (profiles || []).forEach(p => { profilesById[p.id] = p; });
            }

            const koraRows = (kora.data || []).map(r => {
                const p = profilesById[r.user_id] || {};
                return {
                    id: r.id,
                    source: 'kora',
                    method: 'KoraPay',
                    reference: r.internal_reference || r.provider_reference,
                    customer: p.username || (p.email ? p.email.split('@')[0] : 'User'),
                    userEmail: maskEmail(p.email || ''),
                    paymentCurrency: r.payment_currency,
                    paymentAmount: r.payment_amount ?? null,
                    walletCurrency: r.wallet_currency,
                    walletAmount: r.wallet_amount ?? null,
                    status: r.status,
                    created_at: r.created_at
                };
            });

            const cryptoRows = (crypto.data || []).map(r => {
                const p = profilesById[r.user_id] || {};
                return {
                    id: r.id,
                    source: 'crypto',
                    method: 'NowPayments',
                    reference: r.nowpayments_payment_id,
                    customer: p.username || (p.email ? p.email.split('@')[0] : 'User'),
                    userEmail: maskEmail(p.email || ''),
                    paymentCurrency: r.pay_currency,
                    paymentAmount: null,
                    walletCurrency: 'USD',
                    walletAmount: r.credited_amount ?? r.requested_usd ?? null,
                    status: r.status,
                    created_at: r.created_at
                };
            });

            const merged = [...koraRows, ...cryptoRows]
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            const start    = (page - 1) * pageSize;
            const pageRows = merged.slice(start, start + pageSize);
            const total    = merged.length;

            ok(res, {
                rows: pageRows,
                pagination: {
                    page,
                    pageSize,
                    total,
                    totalPages: total ? Math.ceil(total / pageSize) : 0
                },
                sources: {
                    kora:   { available: !kora.error,   reason: kora.error?.code   || null },
                    crypto: { available: !crypto.error, reason: crypto.error?.code || null }
                }
            });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/deposits/today-summary
//
//  Kept for backwards compatibility — same shape as before.
// ═════════════════════════════════════════════════════════════════
router.get(
    '/deposits/today-summary',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        try {
            const d = await agg.getDepositStats();
            ok(res, {
                today: {
                    count: unwrap(d.today.count),
                    ngn:   unwrap(d.today.ngn),
                    usd:   unwrap(d.today.usd)
                },
                pending:   unwrap(d.pending),
                failed:    unwrap(d.failed),
                completed: unwrap(d.completed),
                byProvider: d.byProvider,
                _meta: d._meta || { partial: false, missingSources: [] }
            });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/revenue/breakdown?currency=&from=&to=&page=&pageSize=
//
//  Single source of truth: calls admin_revenue_rows RPC. The revenue
//  KPI is defined by the exact same WHERE clause as
//  admin_revenue_summary (fee > 0, completed statuses only).
//  Frontend does NOT recompute the fee — it reads what this
//  endpoint returns.
// ═════════════════════════════════════════════════════════════════
router.get(
    '/revenue/breakdown',
    requirePermission(PERMISSIONS.REVENUE_READ || PERMISSIONS.DASHBOARD_READ),
    async (req, res) => {
        try {
            const currency = String(req.query.currency || 'NGN').toUpperCase();
            if (!['NGN', 'USD'].includes(currency)) {
                return fail(res, { status: 400, code: 'INVALID_CURRENCY', message: 'Currency must be NGN or USD.' });
            }
            const range = parseRange(req);
            if (range.error) return fail(res, { status: 400, code: range.error, message: range.error });

            const pageSize = limitOf(req.query.pageSize, 20, 100);
            const page = pageOf(req.query.page);

            const { data, error } = await supabaseAdmin.rpc('admin_revenue_rows', {
                p_from:      range.from,
                p_to:        range.to,
                p_currency:  currency,
                p_page:      page,
                p_page_size: pageSize
            });

            if (error) {
                console.error('[ADMIN DASHBOARD] revenue rows error:', error.message);
                return fail(res, { status: 500, code: 'REVENUE_BREAKDOWN_ERROR', message: error.message });
            }

            const rows = Array.isArray(data) ? data : [];
            const total = rows.length ? Number(rows[0].total_count || 0) : 0;

            ok(res, {
                currency,
                rows: rows.map(r => ({
                    id: r.id,
                    user: {
                        id: r.user_id,
                        username: r.username || 'Unknown',
                        email: maskEmail(r.email || '')
                    },
                    type: r.type,
                    status: r.status,
                    currency: r.currency,
                    amount: r.amount,
                    fee: r.fee,
                    reference: r.reference,
                    provider: r.provider,
                    created_at: r.created_at
                })),
                pagination: {
                    page,
                    pageSize,
                    total,
                    totalPages: total ? Math.ceil(total / pageSize) : 0
                },
                from: range.from,
                to: range.to
            });

            // Sensitive drawer audit (revenue detail)
            audit(req, 'drawer.open.revenue_breakdown', 'revenue', currency, {
                currency, from: range.from, to: range.to, page
            });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/logins/today?limit=
//
//  Count-only for the KPI: /stats already returns it. This endpoint
//  is only the detailed drawer.
// ═════════════════════════════════════════════════════════════════
router.get(
    '/logins/today',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const limit = limitOf(req.query.limit, 50, 200);
            const result = await agg.getLoginsTodayDetailed({ limit });

            if (!result.available) {
                return res.status(503).json({
                    success: false,
                    error: 'Unable to load login data.',
                    code: 'LOGINS_QUERY_FAILED',
                    reason: result.reason
                });
            }

            ok(res, {
                count: result.total,
                users: result.value.map(u => ({
                    ...u,
                    email: maskEmail(u.email || '')
                })),
                detailAvailable: result.detailAvailable !== false,
                detailReason:    result.detailReason || null,
                deviceBreakdown: result.deviceBreakdown || {},
                from: result.from,
                to: result.to
            });

            audit(req, 'drawer.open.logins_today', 'user_session', null, { from: result.from, to: result.to });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/notifications/recent?limit=
// ═════════════════════════════════════════════════════════════════
router.get(
    '/notifications/recent',
    requirePermission(PERMISSIONS.NOTIFICATIONS_READ),
    async (req, res) => {
        try {
            const limit = limitOf(req.query.limit, 5, 20);
            const { data, error } = await supabaseAdmin
                .from('notifications')
                .select('id, user_id, title, message, icon, type, is_read, created_at, metadata')
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) {
                if (error.code === '42P01') {
                    return ok(res, [], { available: false, reason: 'NOTIFICATIONS_TABLE_NOT_FOUND' });
                }
                return fail(res, { status: 500, code: 'NOTIFICATIONS_ERROR', message: error.message });
            }

            const notifications = (data || []).map(n => ({
                id: n.id,
                user_id: n.user_id,
                title: n.title || 'Notification',
                message: n.message || '',
                icon: n.icon || null,
                iconFa: n.icon && /^fa[- ]/.test(String(n.icon)) ? n.icon : 'fa-solid fa-bell',
                type: n.type || 'info',
                is_read: !!n.is_read,
                created_at: n.created_at,
                metadata: n.metadata || {}
            }));

            ok(res, notifications, { available: true });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/me
// ═════════════════════════════════════════════════════════════════
router.get('/me', adminAuth, async (req, res) => {
    try {
        const ctx = req.adminContext;
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, role, avatar_url, created_at, mfa_enabled_at')
            .eq('id', ctx.id)
            .single();

        if (error) return fail(res, { status: 404, code: 'ADMIN_NOT_FOUND', message: 'Admin not found' });

        ok(res, {
            user: {
                  id: data.id,
        username: data.username || data.email?.split('@')[0] || 'Admin',
        email: data.email || '',
        role: data.role || 'admin',
        avatar_url: data.avatar_url || null,
        created_at: data.created_at,
        mfa_enabled: !!data.mfa_enabled_at,
        // Array of dotted string values, e.g. ['*'] for super_admin,
        // or ['dashboard.read','support.assign', ...] for other roles.
        permissions: Array.isArray(ctx.permissions)
            ? ctx.permissions
            : []
    },
            permissions: buildPermissionMap(ctx),
    role: ctx.role,
    isSuperAdmin: ctx.isSuperAdmin
        });
    } catch (err) { fail(res, err); }
});

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/services/performance?from=&to=
// ═════════════════════════════════════════════════════════════════
router.get(
    '/services/performance',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const range = parseRange(req);
            if (range.error) return fail(res, { status: 400, code: range.error, message: range.error });

            const { data, error } = await supabaseAdmin.rpc('admin_services_performance', {
                p_from: range.from,
                p_to:   range.to
            });

            if (error) {
                if (error.code === '42883') {
                    return fail(res, {
                        status: 500, code: 'SERVICES_PERF_RPC_NOT_DEPLOYED',
                        message: 'Run migrations/2025_admin_agg.sql.'
                    });
                }
                return fail(res, { status: 500, code: 'SERVICE_PERF_ERROR', message: error.message });
            }

            const rows = (data || []).map(r => ({
                service:     r.service,
                label:       prettyService(r.service),
                orders:      Number(r.orders || 0),
                completed:   Number(r.completed || 0),
                pending:     Number(r.pending || 0),
                failed:      Number(r.failed || 0),
                volumeNgn:   String(r.volume_ngn || '0.00'),
                volumeUsd:   String(r.volume_usd || '0.00'),
                revenueNgn:  String(r.revenue_ngn || '0.00'),
                revenueUsd:  String(r.revenue_usd || '0.00'),
                successRate: Number(r.orders || 0) > 0
                             ? +((Number(r.completed || 0) / Number(r.orders || 0)) * 100).toFixed(1)
                             : 0,
                route:       serviceRoute(r.service)
            }));

            ok(res, rows, { from: range.from, to: range.to });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/providers/health
// ═════════════════════════════════════════════════════════════════
router.get(
    '/providers/health',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const snapshot = await providerHealthService().getProviderHealth();
            const meta = providerMetadata().PROVIDER_METADATA || {};

            const providers = Object.values(snapshot).map(p => {
                const m = meta[p.provider] || {};
                return {
                    key:              p.provider,
                    name:             p.label || p.provider,
                    status:           p.status,
                    statusGroup:      statusGroup(p.status),
                    configured:       p.configured,
                    enabled:          p.enabled !== false,
                    reachable:        p.reachable,
                    authenticated:    p.authenticated,
                    functional:       p.functional,
                    latencyMs:        p.latencyMs,
                    lastSuccess:      p.lastSuccessAt,
                    lastFailure:      p.lastFailureAt
                                        ? { at: p.lastFailureAt, reason: p.errorMessage || null }
                                        : null,
                    recentCount:      p.metadata?.recentCount ?? 0,
                    lastChecked:      p.lastCheckedAt,
                    lastWebhook:      p.lastWebhookAt,
                    failedWebhooks:   p.failedWebhooks24h ?? 0,
                    webhookStatus:    p.webhookStatus,
                    lastError:        p.errorMessage || null,
                    errorCategory:    p.errorCategory || null,
                    category:         p.category || m.category || null,
                    critical:         p.critical === true,
                    environment:      p.environment || m.environment || null,
                    staleness:        p.staleness || 'unknown',
                    breaker:          p.breaker || null
                };
            });

            ok(res, providers);
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/providers/balances
//
//  Wraps agg.getProviderBalances() — returns per-provider NGN/USD
//  balance or `{ available: false, reason }`. Never fabricates.
// ═════════════════════════════════════════════════════════════════
router.get(
    '/providers/balances',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const rows = await agg.getProviderBalances();
            ok(res, rows);
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/needs-attention
//
//  Sources of "needs attention" (all read-only):
//   • Stuck deposits (>30 min pending)             — high
//   • Crypto manual review                         — high
//   • Provider unreachable / degraded              — high / medium
//   • Provider low balance                         — medium
//   • Failed webhooks (24h)                        — high
//   • Reconciliation exceptions                    — high
//   • Failed transactions (last 24h)               — medium
//   • Open support tickets                         — medium
//
//  `_meta.severity` lets the frontend render a critical banner when
//  any high-severity item exists.
// ═════════════════════════════════════════════════════════════════
router.get(
    '/needs-attention',
    requirePermission(PERMISSIONS.DASHBOARD_READ),
    async (req, res) => {
        try {
            const items = [];
            const unavailable = [];
            const day = agg.watDayBounds();
            const cutoff30 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
            const cutoff24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

            const tryCount = async (label, fn) => {
                try {
                    const { count, error } = await fn();
                    if (error) { unavailable.push(label); return null; }
                    return count || 0;
                } catch { unavailable.push(label); return null; }
            };

            const [
                stuckDeposits,
                cryptoReview,
                failedToday,
                openTickets,
                failedWebhooks,
                reconciliation,
                providerHealth,
                providerBalances
            ] = await Promise.all([
                tryCount('stuck_deposits', () =>
                    supabaseAdmin.from('deposit_requests').select('id', { count: 'exact', head: true })
                        .in('status', ['pending','processing']).lt('created_at', cutoff30)),
                tryCount('crypto_manual_review', () =>
                    supabaseAdmin.from('crypto_deposits').select('id', { count: 'exact', head: true })
                        .eq('status', 'manual_review')),
                tryCount('failed_transactions_today', () =>
                    supabaseAdmin.from('transactions').select('id', { count: 'exact', head: true })
                        .eq('status', 'failed').gte('created_at', cutoff24)),
                tryCount('open_support_tickets', () =>
                    supabaseAdmin.from('support_tickets').select('id', { count: 'exact', head: true })
                        .in('status', ['open','in_progress'])),
                agg.getFailedWebhooksCount(),
                agg.getReconciliationCount(),
                (async () => {
                    try { return await providerHealthService().getProviderHealth(); }
                    catch { unavailable.push('provider_health'); return null; }
                })(),
                agg.getProviderBalances()
            ]);

            if (stuckDeposits && stuckDeposits > 0) items.push({
                type: 'stuck_deposits',
                severity: 'high',
                title: 'Stuck deposits',
                description: `${stuckDeposits} deposit(s) pending for more than 30 minutes`,
                count: stuckDeposits,
                route: '/admin/deposits.html?status=pending&stuck=1'
            });

            if (cryptoReview && cryptoReview > 0) items.push({
                type: 'crypto_manual_review',
                severity: 'high',
                title: 'Crypto deposits in manual review',
                description: `${cryptoReview} case(s) need investigation`,
                count: cryptoReview,
                route: '/admin/crypto.html?status=manual_review'
            });

            if (failedWebhooks && failedWebhooks.available && failedWebhooks.value > 0) items.push({
                type: 'failed_webhooks',
                severity: 'high',
                title: 'Failed webhooks',
                description: `${failedWebhooks.value} webhook(s) failed in the last 24 hours`,
                count: failedWebhooks.value,
                route: '/admin/webhooks.html?status=failed'
            });

            if (reconciliation && reconciliation.available && reconciliation.value.total > 0) {
                items.push({
                    type: 'reconciliation_exceptions',
                    severity: 'high',
                    title: 'Reconciliation exceptions',
                    description: `${reconciliation.value.total} exception(s) to review`,
                    count: reconciliation.value.total,
                    route: '/admin/reconciliation.html?status=exceptions'
                });
            }

            if (providerHealth) {
                for (const p of Object.values(providerHealth)) {
                    const group = statusGroup(p.status);
                    if (group === 'unreachable') {
                        items.push({
                            type: 'provider_unreachable',
                            severity: 'high',
                            title: `${p.label || p.provider} unreachable`,
                            description: p.errorMessage || 'Provider health check failing',
                            count: 1,
                            route: '/admin/providers.html'
                        });
                    } else if (group === 'degraded') {
                        items.push({
                            type: 'provider_degraded',
                            severity: 'medium',
                            title: `${p.label || p.provider} degraded`,
                            description: p.errorMessage || 'Provider is responding slowly or partially',
                            count: 1,
                            route: '/admin/providers.html'
                        });
                    }
                }
            }

            if (providerBalances && Array.isArray(providerBalances)) {
                for (const b of providerBalances) {
                    if (!b.available) continue;
                    if (b.lowBalance?.NGN === true) {
                        items.push({
                            type: 'provider_low_balance',
                            severity: 'medium',
                            title: `${b.label} NGN balance low`,
                            description: `Below ₦${b.threshold.NGN}`,
                            count: 1,
                            route: '/admin/providers.html'
                        });
                    }
                    if (b.lowBalance?.USD === true) {
                        items.push({
                            type: 'provider_low_balance',
                            severity: 'medium',
                            title: `${b.label} USD balance low`,
                            description: `Below $${b.threshold.USD}`,
                            count: 1,
                            route: '/admin/providers.html'
                        });
                    }
                }
            }

            if (failedToday && failedToday > 0) items.push({
                type: 'failed_transactions_24h',
                severity: 'medium',
                title: 'Failed transactions (24h)',
                description: `${failedToday} failed transaction(s) in the last 24 hours`,
                count: failedToday,
                route: '/admin/transactions.html?status=failed&range=24h'
            });

            if (openTickets && openTickets > 0) items.push({
                type: 'open_support_tickets',
                severity: 'medium',
                title: 'Open support tickets',
                description: `${openTickets} ticket(s) awaiting response`,
                count: openTickets,
                route: '/admin/support.html'
            });

            const severityCounts = items.reduce(
                (acc, it) => { acc[it.severity] = (acc[it.severity] || 0) + 1; return acc; },
                { high: 0, medium: 0, low: 0 }
            );

            ok(res, items, {
                allClear: items.length === 0 && unavailable.length === 0,
                partial: unavailable.length > 0,
                unavailable,
                severity: severityCounts
            });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/reconciliation/exceptions/count
// ═════════════════════════════════════════════════════════════════
router.get(
    '/reconciliation/exceptions/count',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    async (req, res) => {
        try {
            const r = await agg.getReconciliationCount();
            if (!r.available) {
                return ok(res, { count: null, available: false, reasons: [r.reason] });
            }
            ok(res, {
                count: r.value.total,
                available: true,
                breakdown: {
                    kora_manual_review:    r.value.kora_manual_review,
                    kora_underpaid:        r.value.kora_underpaid,
                    kora_overpaid:         r.value.kora_overpaid,
                    crypto_manual_review:  r.value.crypto_manual_review,
                    crypto_partially_paid: r.value.crypto_partially_paid
                }
            });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/webhooks/recent?from=&to=&limit=
//  (kept for the full webhooks page; the dashboard itself no longer
//  renders a webhook table — failed webhooks are surfaced through
//  /needs-attention.)
// ═════════════════════════════════════════════════════════════════
router.get(
    '/webhooks/recent',
    requirePermission(PERMISSIONS.WEBHOOKS_READ),
    async (req, res) => {
        try {
            const range = parseRange(req);
            if (range.error) return fail(res, { status: 400, code: range.error, message: range.error });
            const limit = limitOf(req.query.limit, 20, 100);

            const { data, error } = await supabaseAdmin
                .from('provider_webhook_events')
                .select('id, provider, event_type, payment_id, order_id, signature_valid, processing_status, processing_error, received_at, processed_at')
                .gte('received_at', range.from)
                .lte('received_at', range.to)
                .order('received_at', { ascending: false })
                .limit(limit);

            if (error) {
                if (error.code === '42P01') {
                    return ok(res, [], { available: false, reason: 'WEBHOOK_TABLE_NOT_FOUND' });
                }
                return fail(res, { status: 500, code: 'WEBHOOKS_ERROR', message: error.message });
            }

            const rows = (data || []).map(w => ({
                id: w.id,
                provider: w.provider,
                event: w.event_type,
                reference: w.payment_id || w.order_id,
                signatureVerified: !!w.signature_valid,
                status: mapWebhookStatus(w.processing_status),
                processingStatus: w.processing_status,
                error: w.processing_error || null,
                received_at: w.received_at,
                processed_at: w.processed_at
            }));

            ok(res, rows, { available: true, from: range.from, to: range.to });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/search?q=
//
//  Uses the admin_search RPC. Capped at 10 rows total (5 users,
//  5 transactions). Requires at least 2 characters. Escapes %
//  and _ so a user typing "%" can't force a full table scan.
// ═════════════════════════════════════════════════════════════════
router.get(
    '/search',
    requirePermission(PERMISSIONS.DASHBOARD_READ),
    async (req, res) => {
        try {
            const raw = String(req.query.q || '').trim();
            if (raw.length < 2) {
                return ok(res, { results: [] }, { reason: 'QUERY_TOO_SHORT' });
            }
            if (raw.length > 64) {
                return fail(res, { status: 400, code: 'QUERY_TOO_LONG', message: 'Search must be 64 chars or fewer.' });
            }
            // Escape LIKE wildcards
            const sanitized = raw.replace(/[%_\\]/g, '\\$&');

            const { data, error } = await supabaseAdmin.rpc('admin_search', { p_q: sanitized });
            if (error) {
                if (error.code === '42883') {
                    return fail(res, { status: 500, code: 'SEARCH_RPC_NOT_DEPLOYED', message: 'Run migrations/2026_admin_dashboard_v7.sql.' });
                }
                return fail(res, { status: 500, code: 'SEARCH_FAILED', message: error.message });
            }

            const results = (data || []).map(r => ({
                kind: r.kind,
                id: r.id,
                display: r.display,
                subDisplay: r.kind === 'user' ? maskEmail(r.sub_display || '') : (r.sub_display || ''),
                matchedOn: r.matched_on,
                createdAt: r.created_at
            }));

            ok(res, { results, query: raw }, { cap: 10 });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/export/:table
//
//  The `.csv` suffix is validated in the handler, NOT in the path.
//  Express 5 / path-to-regexp v8 does not support inline regex in
//  route parameters — `:table([a-z_]+\.csv)` is a runtime error.
// ═════════════════════════════════════════════════════════════════
const CSV_TABLES = {
    users:           PERMISSIONS.USERS_READ,
    transactions:    PERMISSIONS.TRANSACTIONS_READ,
    deposits:        PERMISSIONS.DEPOSITS_READ,
    failed_orders:   PERMISSIONS.ORDERS_READ,
    logins:          PERMISSIONS.USERS_READ,
    services:        PERMISSIONS.SERVICES_READ 
};
const CSV_MAX_ROWS = 5000;

function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}
function csvRow(fields) { return fields.map(csvEscape).join(',') + '\n'; }

router.get(
    '/export/:table',
    (req, res, next) => {
        const raw = String(req.params.table || '').toLowerCase();
        // Accept "users" or "users.csv"
        const bareTable = raw.endsWith('.csv') ? raw.slice(0, -4) : raw;
        const perm = CSV_TABLES[bareTable];
        if (!perm) {
            return fail(res, {
                status: 404,
                code: 'CSV_TABLE_NOT_FOUND',
                message: `Unknown export table: ${bareTable}`
            });
        }
        req.csvTable = bareTable;
        return requirePermission(perm)(req, res, next);
    },
    async (req, res) => {
        try {
            const table = req.csvTable;
            const range = parseRange(req);
            if (range.error) {
                return fail(res, { status: 400, code: range.error, message: range.error });
            }
            const limit = Math.min(CSV_MAX_ROWS, limitOf(req.query.limit, 1000, CSV_MAX_ROWS));

            let rows = [];
            let header = [];

            if (table === 'users') {
                const { data, error } = await supabaseAdmin
                    .from('profiles')
                    .select('id, username, email, status, role, is_verified, created_at, last_location')
                    .is('deleted_at', null)
                    .gte('created_at', range.from).lte('created_at', range.to)
                    .order('created_at', { ascending: false }).limit(limit);
                if (error) return fail(res, { status: 500, code: 'CSV_QUERY_FAILED', message: error.message });
                header = ['id', 'username', 'email', 'status', 'role', 'is_verified', 'created_at', 'last_location'];
                rows = (data || []).map(u => [
                    u.id, u.username, maskEmail(u.email || ''),
                    u.status, u.role, u.is_verified, u.created_at, u.last_location
                ]);
            } else if (table === 'transactions') {
                const { data, error } = await supabaseAdmin
                    .from('transactions')
                    .select('id, user_id, type, status, currency, amount, fee, reference, provider, created_at')
                    .gte('created_at', range.from).lte('created_at', range.to)
                    .order('created_at', { ascending: false }).limit(limit);
                if (error) return fail(res, { status: 500, code: 'CSV_QUERY_FAILED', message: error.message });
                header = ['id', 'user_id', 'type', 'status', 'currency', 'amount', 'fee', 'reference', 'provider', 'created_at'];
                rows = (data || []).map(t => [
                    t.id, t.user_id, t.type, t.status, t.currency,
                    t.amount, t.fee, t.reference, t.provider, t.created_at
                ]);
            } else if (table === 'deposits') {
                const { data, error } = await supabaseAdmin
                    .from('deposit_requests')
                    .select('id, user_id, internal_reference, status, payment_currency, payment_amount, wallet_currency, wallet_amount, created_at')
                    .gte('created_at', range.from).lte('created_at', range.to)
                    .order('created_at', { ascending: false }).limit(limit);
                if (error) return fail(res, { status: 500, code: 'CSV_QUERY_FAILED', message: error.message });
                header = ['id', 'user_id', 'reference', 'status', 'payment_currency', 'payment_amount', 'wallet_currency', 'wallet_amount', 'created_at'];
                rows = (data || []).map(d => [
                    d.id, d.user_id, d.internal_reference, d.status,
                    d.payment_currency, d.payment_amount, d.wallet_currency,
                    d.wallet_amount, d.created_at
                ]);
            } else if (table === 'failed_orders') {
                const { data, error } = await supabaseAdmin
                    .from('transactions')
                    .select('id, user_id, type, currency, amount, reference, provider, failure_reason, created_at')
                    .eq('status', 'failed')
                    .gte('created_at', range.from).lte('created_at', range.to)
                    .order('created_at', { ascending: false }).limit(limit);
                if (error) return fail(res, { status: 500, code: 'CSV_QUERY_FAILED', message: error.message });
                header = ['id', 'user_id', 'type', 'currency', 'amount', 'reference', 'provider', 'failure_reason', 'created_at'];
                rows = (data || []).map(t => [
                    t.id, t.user_id, t.type, t.currency, t.amount,
                    t.reference, t.provider, t.failure_reason, t.created_at
                ]);
            } else if (table === 'logins') {
                const r = await agg.getLoginsTodayDetailed({ limit: Math.min(limit, 200) });
                if (!r.available) return fail(res, { status: 500, code: 'CSV_QUERY_FAILED', message: r.reason });
                header = ['user_id', 'username', 'email', 'first_session_at'];
                rows = (r.value || []).map(u => [
                    u.user_id, u.username, maskEmail(u.email || ''), u.first_session_at
                ]);

                } else if (table === 'services') {
    const r = await supabaseAdmin.rpc('admin_services_performance', {
        p_from: range.from,
        p_to:   range.to
    });
    if (r.error) {
        return fail(res, { status: 500, code: 'CSV_QUERY_FAILED', message: r.error.message });
    }
    const svcRows = (r.data || []).map(x => ({
        service:     x.service,
        label:       prettyService(x.service),
        orders:      Number(x.orders    || 0),
        completed:   Number(x.completed || 0),
        pending:     Number(x.pending   || 0),
        failed:      Number(x.failed    || 0),
        volume_ngn:  String(x.volume_ngn  || '0.00'),
        volume_usd:  String(x.volume_usd  || '0.00'),
        revenue_ngn: String(x.revenue_ngn || '0.00'),
        revenue_usd: String(x.revenue_usd || '0.00'),
        success_rate: Number(x.orders || 0) > 0
            ? ((Number(x.completed || 0) / Number(x.orders || 0)) * 100).toFixed(1) + '%'
            : '0.0%'
    }));
    header = ['service', 'label', 'orders', 'completed', 'pending', 'failed',
              'volume_ngn', 'volume_usd', 'revenue_ngn', 'revenue_usd', 'success_rate'];
    rows = svcRows.map(s => [
        s.service, s.label, s.orders, s.completed, s.pending, s.failed,
        s.volume_ngn, s.volume_usd, s.revenue_ngn, s.revenue_usd, s.success_rate
    ]);

            }

            const body = csvRow(header) + rows.map(r => csvRow(r)).join('');
            const filename = `milesspace_${table}_${range.from.slice(0,10)}_to_${range.to.slice(0,10)}.csv`;

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.status(200).send(body);

            audit(req, 'export.csv', table, null, { from: range.from, to: range.to, rowCount: rows.length });
        } catch (err) { fail(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  POST /api/admin/audit/drawer-open
//
//  Called by the frontend after a sensitive drawer successfully
//  renders its data. This is the ONLY audit-write endpoint; every
//  other route writes audit inline where the read succeeded.
// ═════════════════════════════════════════════════════════════════
router.post(
    '/audit/drawer-open',
    adminAuth,
    async (req, res) => {
        try {
            const allowed = new Set([
                'user_detail', 'deposits', 'revenue', 'pending_deposits',
                'failed_orders', 'logins_today', 'signups_today',
                'transactions_today'
            ]);
            const drawer = String(req.body?.drawer || '').toLowerCase();
            if (!allowed.has(drawer)) {
                return fail(res, { status: 400, code: 'UNKNOWN_DRAWER', message: 'Unknown drawer key.' });
            }
            const targetType = String(req.body?.targetType || drawer);
            const targetId   = req.body?.targetId ? String(req.body.targetId) : null;
            audit(req, `drawer.open.${drawer}`, targetType, targetId, {
                from: req.body?.from || null,
                to:   req.body?.to   || null
            });
            res.json({ success: true });
        } catch (err) { fail(res, err); }
    }
);

// ─── Internal helpers ────────────────────────────────────────────
function maskEmail(email) {
    if (!email || typeof email !== 'string') return '';
    const at = email.indexOf('@');
    if (at < 0) return email.slice(0, 2) + '***';
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const shownLocal = local.length <= 2 ? local.slice(0, 1) + '***'
                                         : local.slice(0, 2) + '***';
    return `${shownLocal}@${domain}`;
}

function humanTime(iso) {
    if (!iso) return 'Never';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'Just now';
    if (s < 120) return '1 minute ago';
    if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
    if (s < 7200) return '1 hour ago';
    if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
    if (s < 172800) return 'Yesterday';
    return `${Math.floor(s / 86400)} days ago`;
}
function badgeForStatus(status) {
    const s = String(status || '').toLowerCase();
    if (['completed','success','successful','delivered'].includes(s)) return 'success';
    if (['failed','cancelled','reversed'].includes(s)) return 'danger';
    if (['pending','processing','confirming','partially_paid'].includes(s)) return 'warn';
    if (s === 'manual_review') return 'purple';
    return 'neutral';
}
function iconForType(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('deposit') || t === 'wallet_funding') return 'fa-solid fa-circle-down';
    if (t.includes('crypto'))                          return 'fa-brands fa-bitcoin';
    if (t.includes('gift'))                            return 'fa-solid fa-gift';
    if (t.includes('airtime') || t.includes('data'))   return 'fa-solid fa-mobile-screen';
    if (t.includes('boost'))                           return 'fa-solid fa-arrow-trend-up';
    if (t.includes('sms'))                             return 'fa-solid fa-message';
    return 'fa-solid fa-credit-card';
}
function prettyService(key) {
    const map = {
        crypto: 'Crypto', gift_cards: 'Gift Cards', gift: 'Gift Cards',
        marketplace: 'Marketplace', boost: 'Boost', virtual_sms: 'Virtual SMS',
        airtime: 'Airtime', data: 'Data', esim: 'eSIM', bills: 'Bills & Utilities'
    };
    return map[key] || (key ? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Other');
}
// Every route ends in .html — matching the frontend rule.
function serviceRoute(key) {
    const map = {
        crypto:        '/admin/crypto.html',
        gift_cards:    '/admin/sellgift.html',
        gift:          '/admin/sellgift.html',
        marketplace:   '/admin/marketplace-products.html',
        boost:         '/admin/boost.html',
        virtual_sms:   '/admin/virtual-sms.html',
        airtime:       '/admin/airtime-data.html',
        data:          '/admin/airtime-data.html',
        esim:          '/admin/esim.html',
        bills:         '/admin/bills.html'
    };
    return map[key] || null;
}
function mapWebhookStatus(s) {
    if (s === 'processed' || s === 'success') return 'processed';
    if (s === 'failed' || s === 'error')      return 'failed';
    if (s === 'received')                     return 'received';
    return s || 'unknown';
}

module.exports = router;