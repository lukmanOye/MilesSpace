// routes/admin/infrastructure.js
// ─────────────────────────────────────────────────────────────────
// Admin Infrastructure routes.
//
//   GET /infrastructure/health       cached-in-request, safe
//   GET /infrastructure/overview     providers list
//   GET /infrastructure/usage        host API cache (may be unavailable)
//   GET /infrastructure/metrics      server cache + fresh API stats
//   GET /infrastructure/deployment   host API cache (may be unavailable)
//
// Fixes from the audit review:
//   • Mounted at /api/admin by server.js — the router paths start
//     with /infrastructure so they resolve to
//     /api/admin/infrastructure/*.
//   • auditView() deduped: at most one audit row per admin per
//     10 minutes, fire-and-forget. Was: one row per request.
//   • Rate limit: 60 requests per minute per admin. In-memory,
//     per-process (single-instance-safe; a multi-instance fleet
//     would need the Postgres-backed limiter, out of scope here).
//   • Consistent error shape: { success: false, code, error }
//     never leaks internals on 5xx.
//   • Cache-Control: no-store on every response.
//   • Permission SYSTEM_HEALTH_READ on every route.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const {
    requirePermission,
    PERMISSIONS,
    getClientIp
} = require('../../middleware/adminAuth');

const { recordAdminActionStrict } = require('../../middleware/adminAuditStrict');
const infrastructure = require('../../services/infrastructureService');

// ─── Request id ────────────────────────────────────────────────

function attachRequestId(req, res, next) {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}
router.use('/infrastructure', attachRequestId);

// ─── Cache-Control ────────────────────────────────────────────

function noStore(req, res, next) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    next();
}
router.use('/infrastructure', noStore);

// ─── Response helpers ────────────────────────────────────────

function ok(res, payload) {
    if (!res.headersSent) res.json({ success: true, ...payload });
}

function err(res, e) {
    if (res.headersSent) return;
    const status  = (e && e.status) || 500;
    const code    = (e && e.code)   || 'INFRA_ERROR';
    const message = status >= 500
        ? 'Something went wrong. Please try again.'
        : (e && e.message) || 'Request failed.';
    if (status >= 500) {
        console.error('[ADMIN INFRA]', code, e && e.message ? e.message : e);
    }
    const body = { success: false, code, error: message };
    if (e && e.field) body.field = e.field;
    res.status(status).json(body);
}

// ─── Rate limiter ────────────────────────────────────────────
//
// In-memory, per-process, per-admin. 60 requests per minute. The
// UI polls once every 60s and loads 5 endpoints, so worst-case
// steady state is ~5 req/min per admin. 60 leaves headroom for
// manual refresh and filter interactions.
//
// If you ever run more than one Node instance, replace with the
// Postgres-backed limiter (boost_rate_limit_check).

const RL_WINDOW_MS = 60_000;
const RL_MAX       = 60;
const _rl = new Map(); // key → [timestamps]

setInterval(() => {
    const cutoff = Date.now() - RL_WINDOW_MS * 2;
    for (const [k, arr] of _rl) {
        const pruned = arr.filter(t => t > cutoff);
        if (!pruned.length) _rl.delete(k);
        else _rl.set(k, pruned);
    }
}, 60_000).unref?.();

function infraRateLimit(req, res, next) {
    const id = (req.adminContext && req.adminContext.id) || req.ip || 'anon';
    const now = Date.now();
    const arr = (_rl.get(id) || []).filter(t => now - t < RL_WINDOW_MS);
    if (arr.length >= RL_MAX) {
        const retryAfterMs = RL_WINDOW_MS - (now - arr[0]);
        res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        return res.status(429).json({
            success: false,
            code: 'RATE_LIMITED',
            error: 'Too many requests. Slow down.',
            retry_after_ms: retryAfterMs
        });
    }
    arr.push(now);
    _rl.set(id, arr);
    next();
}

// ─── Audit dedupe ───────────────────────────────────────────
//
// One row per admin per 10 minutes, regardless of which endpoint
// triggered it. `infrastructure.viewed` is the single action; the
// specific section is captured in metadata.section so an auditor
// can still see which panel the admin was looking at.

const VIEW_DEDUPE_MS = 10 * 60 * 1000;
const _lastViewByAdmin = new Map(); // adminId → { at, sections: Set<string> }

function auditViewOnce(req, section) {
    const adminId = req.adminContext && req.adminContext.id;
    if (!adminId) return;

    const now = Date.now();
    const prev = _lastViewByAdmin.get(adminId) || { at: 0, sections: new Set() };

    // Within the dedupe window: remember the section, do not write.
    if (now - prev.at < VIEW_DEDUPE_MS) {
        prev.sections.add(section);
        _lastViewByAdmin.set(adminId, prev);
        return;
    }

    // New window: write one row, reset the marker.
    const sections = new Set(prev.sections);
    sections.add(section);
    _lastViewByAdmin.set(adminId, { at: now, sections: new Set() });

    // Fire-and-forget. Failing to audit a *view* must never fail
    // the request, and we do not want it to appear in the response.
    // We use recordAdminActionStrict for correctness when the action
    // is registered; if it throws AUDIT_ACTION_UNREGISTERED (because
    // file 4 hasn't landed yet), we fall back to a log line so the
    // admin is not blocked. This fallback is removed the moment
    // 'infrastructure.viewed' is in auditActions.
    recordAdminActionStrict({
        req,
        action: 'infrastructure.viewed',
        targetType: 'infrastructure',
        targetId: null,
        metadata: {
            sections: Array.from(sections)
        },
        result: 'success'
    }).catch((e) => {
        if (e && e.code === 'AUDIT_ACTION_UNREGISTERED') {
            console.warn(
                '[ADMIN INFRA] auditAction "infrastructure.viewed" not registered; ' +
                'add it to services/auditActions.js. Not blocking the request.'
            );
            return;
        }
        // Any other failure: roll back the marker so a future view
        // retries. Not fatal.
        _lastViewByAdmin.delete(adminId);
        console.warn('[ADMIN INFRA] view audit failed:', e.message);
    });
}

// ─── Routes ─────────────────────────────────────────────────

router.get(
    '/infrastructure/health',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    infraRateLimit,
    async (req, res) => {
        try {
            const data = await infrastructure.getHealth();
            auditViewOnce(req, 'health');
            ok(res, { health: data });
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/infrastructure/overview',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    infraRateLimit,
    async (req, res) => {
        try {
            const data = await infrastructure.getOverview();
            auditViewOnce(req, 'overview');
            ok(res, { overview: data });
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/infrastructure/usage',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    infraRateLimit,
    async (req, res) => {
        try {
            const data = await infrastructure.getUsage();
            auditViewOnce(req, 'usage');
            ok(res, { usage: data });
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/infrastructure/metrics',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    infraRateLimit,
    async (req, res) => {
        try {
            const data = await infrastructure.getMetrics();
            auditViewOnce(req, 'metrics');
            ok(res, { metrics: data });
        } catch (e) { err(res, e); }
    }
);

router.get(
    '/infrastructure/deployment',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ),
    infraRateLimit,
    async (req, res) => {
        try {
            const data = await infrastructure.getDeployment();
            auditViewOnce(req, 'deployment');
            ok(res, { deployment: data });
        } catch (e) { err(res, e); }
    }
);

module.exports = router;