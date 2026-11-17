// routes/admin/revenueAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Revenue analytics API.
//
//   GET /api/admin/revenue/meta
//   GET /api/admin/revenue/summary
//   GET /api/admin/revenue/timeseries
//   GET /api/admin/revenue/products
//   GET /api/admin/revenue/providers
//   GET /api/admin/revenue/refunds
//   GET /api/admin/revenue/customers
//   GET /api/admin/revenue/funding
//   GET /api/admin/revenue/daily
//   GET /api/admin/revenue/export
//
// Every response has:
//   Cache-Control: no-store
//   X-Request-Id: <uuid>
// Failure envelope:
//   { success:false, code, error, request_id }
// Success envelope:
//   { success:true, ...payload }
//
// Customer PII (email) is masked unless the caller has CUSTOMERS_READ
// or '*'. REPORTS_READ alone is NOT enough to see emails.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const revenue = require('../../services/revenueService');
const {
    requirePermission,
    recordAdminAction,
    PERMISSIONS
} = require('../../middleware/adminAuth');

// ─── Request-id middleware (mounted once on this router) ────────
router.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    next();
});

// ─── In-process rate limiter for export (5/min/admin) ───────────
const _exportBuckets = new Map();
function exportRateLimit(req, res, next) {
    const key = `revenue-export:${req.adminContext?.id || req.ip || 'anon'}`;
    const now = Date.now();
    const windowMs = 60_000;
    let b = _exportBuckets.get(key);
    if (!b || now > b.resetAt) b = { count: 0, resetAt: now + windowMs };
    b.count++;
    _exportBuckets.set(key, b);
    if (b.count > 5) {
        const retry = Math.ceil((b.resetAt - now) / 1000);
        res.setHeader('Retry-After', String(retry));
        return fail(res, 429, 'RATE_LIMITED', `Too many exports. Retry in ${retry}s.`, req);
    }
    next();
}
setInterval(() => {
    const now = Date.now();
    for (const [k, b] of _exportBuckets) if (now > b.resetAt) _exportBuckets.delete(k);
}, 60_000).unref?.();

// ─── Envelopes ──────────────────────────────────────────────────
function ok(res, payload) {
    if (res.headersSent) return;
    res.json({ success: true, ...payload });
}
function fail(res, status, code, error, req) {
    if (res.headersSent) return;
    res.status(status).json({
        success: false,
        code,
        error,
        request_id: req?.requestId || null
    });
}
function handleError(res, req, e) {
    if (res.headersSent) return;
    const status = Number.isInteger(e?.status) ? e.status : 500;
    if (status >= 500) console.error('[ADMIN REVENUE]', req.requestId, e?.message || e);
    // Never leak raw DB errors. Use generic message for 5xx.
    const error = status >= 500 ? 'Revenue request failed. Please try again.' : (e?.message || 'Request failed.');
    fail(res, status, e?.code || 'REVENUE_ERROR', error, req);
}

// ─── PII masking ────────────────────────────────────────────────
function canSeePII(req) {
    const perms = req.adminContext?.permissions || [];
    return perms.includes('*') || perms.includes(PERMISSIONS.CUSTOMERS_READ || 'customers.read');
}
function maskEmail(email) {
    if (!email) return null;
    const [local, domain] = String(email).split('@');
    if (!domain) return '***';
    const head = local.slice(0, 1);
    return `${head}***@${domain}`;
}
function maskCustomersPayload(payload, req) {
    if (canSeePII(req)) return payload;
    if (Array.isArray(payload.customers)) {
        return {
            ...payload,
            customers: payload.customers.map(c => ({
                ...c,
                user: { ...c.user, email: maskEmail(c.user.email) }
            }))
        };
    }
    if (Array.isArray(payload.refunds)) {
        return {
            ...payload,
            refunds: payload.refunds.map(r => ({
                ...r,
                user: { ...r.user, email: maskEmail(r.user.email) }
            }))
        };
    }
    return payload;
}

// ─── GET /revenue/meta ──────────────────────────────────────────
router.get(
    '/revenue/meta',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const meta = await revenue.getMeta();
            ok(res, meta);
        } catch (e) { handleError(res, req, e); }
    }
);

// ─── GET /revenue/summary ───────────────────────────────────────
router.get(
    '/revenue/summary',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await revenue.getSummary(pickScopeInput(req.query));
            ok(res, data);
        } catch (e) { handleError(res, req, e); }
    }
);

// ─── GET /revenue/timeseries ────────────────────────────────────
router.get(
    '/revenue/timeseries',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const granularity = ['day','week','month'].includes(req.query.granularity)
                ? req.query.granularity : 'day';
            const data = await revenue.getTimeseries({ ...pickScopeInput(req.query), granularity });
            ok(res, data);
        } catch (e) { handleError(res, req, e); }
    }
);

// ─── GET /revenue/products ──────────────────────────────────────
router.get(
    '/revenue/products',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await revenue.getByProduct(pickScopeInput(req.query));
            ok(res, data);
        } catch (e) { handleError(res, req, e); }
    }
);

// ─── GET /revenue/providers ─────────────────────────────────────
router.get(
    '/revenue/providers',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await revenue.getByProvider(pickScopeInput(req.query));
            ok(res, data);
        } catch (e) { handleError(res, req, e); }
    }
);

// ─── GET /revenue/refunds ───────────────────────────────────────
router.get(
    '/revenue/refunds',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await revenue.getRefunds({
                ...pickScopeInput(req.query),
                page: req.query.page,
                limit: req.query.limit
            });
            ok(res, maskCustomersPayload(data, req));
        } catch (e) { handleError(res, req, e); }
    }
);

// ─── GET /revenue/customers ─────────────────────────────────────
router.get(
    '/revenue/customers',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await revenue.getTopCustomers({
                ...pickScopeInput(req.query),
                limit: req.query.limit
            });
            ok(res, maskCustomersPayload(data, req));
        } catch (e) { handleError(res, req, e); }
    }
);

// ─── GET /revenue/funding ───────────────────────────────────────
router.get(
    '/revenue/funding',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await revenue.getFunding(pickScopeInput(req.query));
            ok(res, data);
        } catch (e) { handleError(res, req, e); }
    }
);

// ─── GET /revenue/daily ─────────────────────────────────────────
router.get(
    '/revenue/daily',
    requirePermission(PERMISSIONS.REPORTS_READ),
    async (req, res) => {
        try {
            const data = await revenue.getDailyTable(pickScopeInput(req.query));
            ok(res, data);
        } catch (e) { handleError(res, req, e); }
    }
);

// ─── GET /revenue/export ────────────────────────────────────────
router.get(
    '/revenue/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    exportRateLimit,
    async (req, res) => {
        try {
            const kind = String(req.query.kind || 'summary').toLowerCase();
            const allowed = ['summary','timeseries','daily','products','providers','refunds','customers'];
            if (!allowed.includes(kind)) {
                return fail(res, 400, 'INVALID_EXPORT_KIND', `kind must be one of: ${allowed.join(', ')}`, req);
            }
            const scopeInput = pickScopeInput(req.query);
            const csv = await revenue.exportCsv({ ...scopeInput, kind });
            const rowCount = csv.split('\n').length;

            // Audit log (best-effort — must not block the download).
            recordAdminAction({
                adminId: req.adminContext?.id,
                adminEmail: req.adminContext?.email,
                action: 'revenue.export',
                targetType: 'revenue_export',
                targetId: null,
                reason: `Exported revenue ${kind}`,
                after: { kind, scope: scopeInput, rows: rowCount },
                requestId: req.requestId,
                req
            }).catch(() => {});

            const filename = `revenue_${kind}_${new Date().toISOString().slice(0,10)}_${req.requestId.slice(0,8)}.csv`;
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(csv);
        } catch (e) { handleError(res, req, e); }
    }
);

// ─── Helper: pick only the fields normalizeScope accepts ────────
function pickScopeInput(q = {}) {
    return {
        from: q.from,
        to: q.to,
        currency: q.currency,
        preset: q.preset,
        granularity: q.granularity,
        page: q.page,
        limit: q.limit
    };
}

module.exports = router;