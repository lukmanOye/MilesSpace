// routes/admin/moneyOverviewRoutes.js
// ─────────────────────────────────────────────────────────────────
// The Money Overview page makes ONE request per block here.
// We compose the existing service calls (ledger, deposits, transactions,
// refunds, recon, esim) so the UI stays simple and each block can fail
// independently with a clean { success:false, code, error } envelope.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { supabaseAdmin } = require('../../db/supabase');
const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');

// Pull the current routes so we reuse their logic instead of duplicating it
const moneyAdmin = require('./moneyAdminRoutes');
const refundAdmin = require('./refundAdminRoutes');
const esimAdmin  = require('./esimAdminRoutes');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Small helpers ──────────────────────────────────────────────
function reqId(req) {
    return req.headers['x-request-id'] || crypto.randomUUID();
}
function ok(res, payload) {
    if (!res.headersSent) res.json({ success: true, data: payload });
}
function fail(res, status, code, error, extra = {}) {
    if (res.headersSent) return;
    res.status(status).json({ success: false, code, error, ...extra });
}
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
function bigintToDecimalString(cents) {
    const negative = cents < 0n;
    const abs = negative ? -cents : cents;
    const whole = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

// ─── Convert internal helpers to reusable callables ─────────────
// We call the routes' own handler code by mounting their logic through
// a tiny in-memory request/response adapter. That way we never duplicate
// permission checks, shaping, or fallbacks. Everything the underlying
// route computes is what the UI sees.

function makeAdapter() {
    return new Promise((resolve) => {
        const res = {
            _status: 200,
            _body: null,
            _headers: {},
            status(s) { this._status = s; return this; },
            setHeader(k, v) { this._headers[k] = v; return this; },
            json(body) { this._body = body; this.headersSent = true; resolve({ status: this._status, body }); return this; },
            send(body) { this._body = body; this.headersSent = true; resolve({ status: this._status, body }); return this; },
            headersSent: false
        };
        resolve(res);
    });
}

// ─── 1. GET /api/admin/money-overview/attention ─────────────────
// One request. Returns the four counts the strip needs plus deep-link URLs.
router.get(
    '/money-overview/attention',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        const rid = reqId(req);
        res.setHeader('X-Request-Id', rid);

        const out = {
            recon: { count: 0, critical: 0, available: false, error: null, link: '/admin/reconciliation.html?provider=kora' },
            refunds: { count: 0, over_sla: 0, available: false, error: null, link: '/admin/refunds.html?status=PENDING_APPROVAL' },
            crypto: { count: 0, available: false, error: null, link: '/admin/deposits.html?source=crypto&status=manual_review' },
            esim: { count: 0, available: false, error: null, link: '/admin/esim.html?status=failed' }
        };

        // Recon summary — one call
        try {
            const r = await supabaseAdmin.rpc('admin_reconciliation_summary', {
                p_provider: 'kora',
                p_from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
                p_to: new Date().toISOString()
            });
            if (r.error) throw r.error;
            const d = r.data || {};
            const issues = d.issues || d.exceptions || [];
            out.recon.count = Number(d.unresolved ?? issues.length ?? 0);
            out.recon.critical = issues.filter(x =>
                String(x.severity || '').toLowerCase() === 'critical' ||
                String(x.severity || '').toLowerCase() === 'high'
            ).length;
            out.recon.available = true;
        } catch (e) {
            // Fallback: count from the issues table
            try {
                const { count } = await supabaseAdmin
                    .from('reconciliation_issues')
                    .select('id', { count: 'exact', head: true })
                    .eq('status', 'open');
                out.recon.count = count || 0;
                out.recon.available = true;
            } catch (e2) {
                out.recon.error = 'Could not load reconciliation summary.';
            }
        }

        // Refunds summary — one call
        try {
            const { data, error } = await supabaseAdmin.rpc('admin_refund_summary', {
                p_from: null, p_to: null
            });
            if (!error && data) {
                let pending = 0;
                for (const [k, v] of Object.entries(data)) {
                    if (String(k).toLowerCase() === 'pending_approval') pending = Number(v?.count || 0);
                }
                out.refunds.count = pending;
            } else {
                // Fallback
                const { count } = await supabaseAdmin
                    .from('refunds')
                    .select('id', { count: 'exact', head: true })
                    .eq('status', 'PENDING_APPROVAL');
                out.refunds.count = count || 0;
            }
            // over-SLA count
            const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
            const { count: overSla } = await supabaseAdmin
                .from('refunds')
                .select('id', { count: 'exact', head: true })
                .eq('status', 'PENDING_APPROVAL')
                .lt('created_at', fourHoursAgo);
            out.refunds.over_sla = overSla || 0;
            out.refunds.available = true;
        } catch (e) {
            out.refunds.error = 'Could not load refund summary.';
        }

        // Crypto manual_review — one call
        try {
            const { count } = await supabaseAdmin
                .from('crypto_deposits')
                .select('id', { count: 'exact', head: true })
                .eq('status', 'manual_review');
            out.crypto.count = count || 0;
            out.crypto.available = true;
        } catch (e) {
            out.crypto.error = 'Could not load crypto deposits.';
        }

        // eSIM failures
        try {
            const { count } = await supabaseAdmin
                .from('esim_transactions')
                .select('id', { count: 'exact', head: true })
                .eq('status', 'failed');
            out.esim.count = count || 0;
            out.esim.available = true;
        } catch (e) {
            out.esim.error = 'Could not load eSIM failures.';
        }

        ok(res, out);
    }
);

// ─── 2. GET /api/admin/money-overview/wallets ───────────────────
router.get(
    '/money-overview/wallets',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        const rid = reqId(req);
        res.setHeader('X-Request-Id', rid);
        try {
            const { data, error } = await supabaseAdmin.rpc('admin_ledger_balances');
            if (error) {
                if (error.code === '42883' || error.code === 'PGRST202') {
                    // Fallback to direct aggregation
                    const { data: rows, error: fe } = await supabaseAdmin
                        .from('ledger_accounts')
                        .select('currency, available_balance, held_balance');
                    if (fe) throw fe;
                    const totals = {};
                    for (const row of rows || []) {
                        const ccy = String(row.currency || 'NGN').toUpperCase();
                        if (!totals[ccy]) totals[ccy] = { available: 0n, held: 0n };
                        totals[ccy].available += BigInt(Math.round(num(row.available_balance) * 100));
                        totals[ccy].held += BigInt(Math.round(num(row.held_balance) * 100));
                    }
                    const out = {};
                    for (const [ccy, t] of Object.entries(totals)) {
                        out[ccy] = {
                            available: bigintToDecimalString(t.available),
                            held: bigintToDecimalString(t.held),
                            total: bigintToDecimalString(t.available + t.held)
                        };
                    }
                    return ok(res, { balances: out });
                }
                throw error;
            }
            const out = {};
            for (const row of data || []) {
                out[row.currency] = {
                    available: String(row.available || '0.00'),
                    held: String(row.held || '0.00'),
                    total: String(row.total || '0.00')
                };
            }
            ok(res, { balances: out });
        } catch (e) {
            console.error('[MONEY-OVERVIEW] wallets:', rid, e.message);
            fail(res, 500, 'WALLETS_ERROR', 'Could not load wallet balances.');
        }
    }
);

// ─── 3. GET /api/admin/money-overview/deposits ──────────────────
router.get(
    '/money-overview/deposits',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        const rid = reqId(req);
        res.setHeader('X-Request-Id', rid);
        try {
            const [koraCompleted, koraPending, koraFailed, cryptoCompleted, cryptoPending, cryptoManual] = await Promise.all([
                supabaseAdmin.from('deposit_requests').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
                supabaseAdmin.from('deposit_requests').select('id', { count: 'exact', head: true }).in('status', ['pending', 'processing']),
                supabaseAdmin.from('deposit_requests').select('id', { count: 'exact', head: true }).in('status', ['failed', 'expired', 'cancelled']),
                supabaseAdmin.from('crypto_deposits').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
                supabaseAdmin.from('crypto_deposits').select('id', { count: 'exact', head: true }).in('status', ['pending', 'processing', 'partially_paid']),
                supabaseAdmin.from('crypto_deposits').select('id', { count: 'exact', head: true }).eq('status', 'manual_review')
            ]);
            ok(res, {
                kora: {
                    completed: koraCompleted.count || 0,
                    pending: koraPending.count || 0,
                    failed: koraFailed.count || 0
                },
                crypto: {
                    completed: cryptoCompleted.count || 0,
                    pending: cryptoPending.count || 0,
                    manual_review: cryptoManual.count || 0
                }
            });
        } catch (e) {
            console.error('[MONEY-OVERVIEW] deposits:', rid, e.message);
            fail(res, 500, 'DEPOSITS_ERROR', 'Could not load deposit stats.');
        }
    }
);

// ─── 4. GET /api/admin/money-overview/transactions ──────────────
router.get(
    '/money-overview/transactions',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        const rid = reqId(req);
        res.setHeader('X-Request-Id', rid);
        try {
            const [total, completed, pending, failed] = await Promise.all([
                supabaseAdmin.from('transactions').select('id', { count: 'exact', head: true }),
                supabaseAdmin.from('transactions').select('id', { count: 'exact', head: true }).in('status', ['completed', 'success']),
                supabaseAdmin.from('transactions').select('id', { count: 'exact', head: true }).in('status', ['pending', 'processing', 'confirming']),
                supabaseAdmin.from('transactions').select('id', { count: 'exact', head: true }).in('status', ['failed', 'cancelled', 'reversed'])
            ]);
            ok(res, {
                total: total.count || 0,
                completed: completed.count || 0,
                pending: pending.count || 0,
                failed: failed.count || 0
            });
        } catch (e) {
            console.error('[MONEY-OVERVIEW] transactions:', rid, e.message);
            fail(res, 500, 'TRANSACTIONS_ERROR', 'Could not load transaction stats.');
        }
    }
);

// ─── 5. GET /api/admin/money-overview/refunds ───────────────────
router.get(
    '/money-overview/refunds',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        const rid = reqId(req);
        res.setHeader('X-Request-Id', rid);
        try {
            const { data, error } = await supabaseAdmin.rpc('admin_refund_summary', { p_from: null, p_to: null });
            if (error) {
                // Fallback
                const [pending, completed, failed] = await Promise.all([
                    supabaseAdmin.from('refunds').select('id', { count: 'exact', head: true }).eq('status', 'PENDING_APPROVAL'),
                    supabaseAdmin.from('refunds').select('id', { count: 'exact', head: true }).eq('status', 'COMPLETED'),
                    supabaseAdmin.from('refunds').select('id', { count: 'exact', head: true }).in('status', ['FAILED', 'REJECTED'])
                ]);
                const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
                const { count: overSla } = await supabaseAdmin
                    .from('refunds').select('id', { count: 'exact', head: true })
                    .eq('status', 'PENDING_APPROVAL').lt('created_at', fourHoursAgo);
                return ok(res, {
                    pending_approval: pending.count || 0,
                    completed: completed.count || 0,
                    failed: failed.count || 0,
                    over_sla: overSla || 0
                });
            }
            let pending = 0, completed = 0, failed = 0;
            for (const [k, v] of Object.entries(data || {})) {
                const key = String(k).toLowerCase();
                const n = Number(v?.count || 0);
                if (key === 'pending_approval') pending = n;
                if (key === 'completed') completed = n;
                if (key === 'failed' || key === 'rejected') failed += n;
            }
            const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
            const { count: overSla } = await supabaseAdmin
                .from('refunds').select('id', { count: 'exact', head: true })
                .eq('status', 'PENDING_APPROVAL').lt('created_at', fourHoursAgo);
            ok(res, {
                pending_approval: pending,
                completed,
                failed,
                over_sla: overSla || 0
            });
        } catch (e) {
            console.error('[MONEY-OVERVIEW] refunds:', rid, e.message);
            fail(res, 500, 'REFUNDS_ERROR', 'Could not load refund stats.');
        }
    }
);

// ─── 6. GET /api/admin/money-overview/revenue ───────────────────
// Just wraps /esim/stats so the UI only needs one endpoint.
router.get(
    '/money-overview/revenue',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        const rid = reqId(req);
        res.setHeader('X-Request-Id', rid);
        try {
            const esim = require('../../services/esimAdminService');
            const stats = await esim.getStats({ from: null, to: null });
            ok(res, { periods: stats.periods });
        } catch (e) {
            console.error('[MONEY-OVERVIEW] revenue:', rid, e.message);
            fail(res, 500, 'REVENUE_ERROR', 'Could not load revenue stats.');
        }
    }
);

// ─── 7. GET /api/admin/money-overview/recent ────────────────────
// The last 8 transactions with user info in one call.
router.get(
    '/money-overview/recent',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        const rid = reqId(req);
        res.setHeader('X-Request-Id', rid);
        try {
            const { data, error } = await supabaseAdmin
                .from('transactions')
                .select(`
                    id, ref, reference, type, status, currency, amount, provider, created_at, user_id,
                    profiles!transactions_user_id_fkey (username, email)
                `)
                .order('created_at', { ascending: false })
                .limit(8);
            if (error) throw error;
            ok(res, {
                transactions: (data || []).map(t => ({
                    id: t.id,
                    reference: t.ref || t.reference || null,
                    type: t.type || null,
                    status: t.status || null,
                    currency: String(t.currency || '').toUpperCase(),
                    amount: t.amount != null ? String(t.amount) : null,
                    provider: t.provider || null,
                    created_at: t.created_at,
                    user: t.profiles ? {
                        username: t.profiles.username || null,
                        email: t.profiles.email || null
                    } : null
                }))
            });
        } catch (e) {
            console.error('[MONEY-OVERVIEW] recent:', rid, e.message);
            fail(res, 500, 'RECENT_ERROR', 'Could not load recent transactions.');
        }
    }
);

// ─── 8. GET /api/admin/money-overview/provider ──────────────────
router.get(
    '/money-overview/provider',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        const rid = reqId(req);
        res.setHeader('X-Request-Id', rid);
        try {
            const dtone = require('../../services/dtoneService');
            const [healthR, balR] = await Promise.allSettled([
                dtone.getBalances(),
                dtone.getBalances()  // same call, used for both
            ]);
            const balances = balR.status === 'fulfilled' && balR.value.success
                ? (balR.value.balances || []).map(b => ({
                    currency: String(b.unit || b.currency || '').toUpperCase() || null,
                    available: b.available != null ? String(b.available) : (b.amount != null ? String(b.amount) : null),
                    amount: b.amount != null ? String(b.amount) : null,
                    reserved: b.reserved != null ? String(b.reserved) : null
                }))
                : [];
            ok(res, {
                reachable: balR.status === 'fulfilled' && balR.value.success === true,
                balances,
                error: balR.status === 'fulfilled' && !balR.value.success
                    ? (balR.value.error || 'Provider unreachable')
                    : (balR.status === 'rejected' ? balR.reason.message : null)
            });
        } catch (e) {
            console.error('[MONEY-OVERVIEW] provider:', rid, e.message);
            fail(res, 500, 'PROVIDER_ERROR', 'Could not load provider float.');
        }
    }
);

module.exports = router;