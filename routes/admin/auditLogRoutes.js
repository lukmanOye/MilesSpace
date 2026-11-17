// routes/admin/audit.js
// ─────────────────────────────────────────────────────────────────
// Admin Audit Log routes.
//
//   GET /audit/bootstrap        summary + facets + admins (one call)
//   GET /audit/summary          KPI counts (RPC)
//   GET /audit/facets           categories/actions/…/providers
//   GET /audit/admins           distinct admins dropdown
//   GET /audit/recent           cheap timeline query
//   GET /audit/integrity        chain check (returns enabled:false
//                               while hash chain is deferred)
//   GET /audit/export           CSV (strict-audited, rate limited)
//   GET /audit                  paginated list
//   GET /audit/:id              single entry + chain
//
// Route order matters: /recent, /export and /integrity MUST be
// declared before /:id or Express treats them as UUIDs.
//
// Permissions:
//   AUDIT_READ           — list, get, summary, facets, admins,
//                          recent, bootstrap
//   AUDIT_EXPORT         — export
//   AUDIT_ADMIN          — integrity
//   AUDIT_READ_SENSITIVE — see unmasked IP / user agent in get()
//
// Auth model matches the rest of the admin API:
//   requirePermission(PERMISSIONS.X)
//   req.adminContext populated by adminAuth
//
// Rate limits:
//   • 120 reads per minute per admin (any of the read endpoints)
//   • 5 exports per minute per admin
//
// Error shape: { success: true, ... } on 2xx, or
//              { success: false, code, error } on error.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const {
    requirePermission,
    PERMISSIONS,
    getClientIp
} = require('../../middleware/adminAuth');

const { recordAdminActionStrict } = require('../../middleware/adminAuditStrict');
const audit = require('../../services/auditLogService');

// ─── Rate limiter ──────────────────────────────────────────────
//
// In-memory. Per-process. The review noted this as a limitation
// (review item 15 in the boost thread, not the audit one). For a
// single admin panel with a handful of admins, per-process is
// sufficient. If you ever run multiple Node instances behind a
// load balancer, replace with the Postgres-backed version from
// the boost rewrite (boost_rate_limit_check).
function makeRateLimiter({ windowMs, max, keyPrefix }) {
    const buckets = new Map(); // key → array of timestamps

    // Sweep occasionally so memory doesn't grow unbounded.
    setInterval(() => {
        const cutoff = Date.now() - windowMs * 2;
        for (const [k, arr] of buckets) {
            const pruned = arr.filter(t => t > cutoff);
            if (!pruned.length) buckets.delete(k);
            else buckets.set(k, pruned);
        }
    }, Math.min(windowMs, 60_000)).unref?.();

    return function rateLimit(req, res, next) {
        const id = (req.adminContext && req.adminContext.id)
            || req.ip
            || 'anon';
        const key = keyPrefix + ':' + id;
        const now = Date.now();
        const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
        if (arr.length >= max) {
            const retryAfterMs = windowMs - (now - arr[0]);
            res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
            return res.status(429).json({
                success: false,
                code: 'RATE_LIMITED',
                error: 'Too many requests. Slow down.',
                retry_after_ms: retryAfterMs
            });
        }
        arr.push(now);
        buckets.set(key, arr);
        next();
    };
}

const readLimit   = makeRateLimiter({ windowMs: 60_000, max: 120, keyPrefix: 'audit:read' });
const exportLimit = makeRateLimiter({ windowMs: 60_000, max: 5,   keyPrefix: 'audit:export' });

// ─── Request id ────────────────────────────────────────────────
//
// Every request to /audit* gets a request id that lands on the
// audit row. If the caller supplied one, we honour it.

function attachRequestId(req, res, next) {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}
router.use(attachRequestId);

// ─── Response helpers ──────────────────────────────────────────

function ok(res, payload) {
    if (!res.headersSent) res.json({ success: true, ...payload });
}

function fail(res, e) {
    if (res.headersSent) return;
    const status = e && e.status ? e.status : 500;
    const code = (e && e.code) || 'AUDIT_ADMIN_ERROR';
    const message = status >= 500
        ? 'Something went wrong. Please try again.'
        : (e && e.message) || 'Request failed.';
    if (status >= 500) {
        console.error('[ADMIN AUDIT]', code, e && e.message ? e.message : e);
    }
    const body = { success: false, code, error: message };
    if (e && e.field) body.field = e.field;
    res.status(status).json(body);
}

// ─── Query validation ──────────────────────────────────────────
//
// One shared validator for every GET /audit* endpoint. Hand-written
// (no zod dependency) to match the codebase style.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEVERITIES   = ['low', 'medium', 'high', 'critical'];
const RESULTS      = ['success', 'failure', 'partial'];
const ACTOR_TYPES  = ['admin', 'system', 'scheduler', 'webhook', 'provider', 'customer'];

function badRequest(code, message, extra) {
    const e = new Error(message || code);
    e.status = 400;
    e.code = code;
    if (extra) Object.assign(e, extra);
    return e;
}

function validateQuery(query) {
    query = query || {};

    // page / limit
    let page = 1, limit = 50;
    if (query.page !== undefined) {
        const n = parseInt(query.page, 10);
        if (!Number.isFinite(n) || n < 1 || n > 100_000) {
            throw badRequest('INVALID_PAGE', 'page must be a positive integer');
        }
        page = n;
    }
    if (query.limit !== undefined) {
        const n = parseInt(query.limit, 10);
        if (!Number.isFinite(n) || n < 1 || n > 200) {
            throw badRequest('INVALID_LIMIT', 'limit must be between 1 and 200');
        }
        limit = n;
    }

    // UUIDs
    const adminId       = query.admin_id && UUID_RE.test(query.admin_id) ? query.admin_id : null;
    const correlationId = query.correlation_id ? String(query.correlation_id).slice(0, 100) : null;
    const requestId     = query.request_id     ? String(query.request_id).slice(0, 100)     : null;

    // Enums
    const severity = query.severity && query.severity !== 'all'
        ? (SEVERITIES.includes(query.severity) ? query.severity : null)
        : null;
    const result = query.result && query.result !== 'all'
        ? (RESULTS.includes(query.result) ? query.result : null)
        : null;
    const actorType = query.actor_type && query.actor_type !== 'all'
        ? (ACTOR_TYPES.includes(query.actor_type) ? query.actor_type : null)
        : null;

    // Category can be a single value or a comma-separated list
    // (the "Financial" quick filter sends 5).
    let categories = null;
    if (query.category && query.category !== 'all') {
        const parts = String(query.category).split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length === 1) categories = parts;
        else if (parts.length > 1) categories = parts;
    } else if (query.categories) {
        const parts = String(query.categories).split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length) categories = parts;
    }
    const category = categories && categories.length === 1 ? categories[0] : null;

    // Free-form strings
    const search   = query.search   ? String(query.search).slice(0, 100)   : null;
    const action   = query.action && query.action !== 'all'   ? String(query.action).slice(0, 120)   : null;
    const provider = query.provider && query.provider !== 'all' ? String(query.provider).slice(0, 60) : null;

    // Dates
    function parseDate(v, field) {
        if (!v) return null;
        const d = new Date(v);
        if (isNaN(d.getTime())) {
            throw badRequest('INVALID_DATE', `${field} is not a valid date`, { field });
        }
        return d.toISOString();
    }
    const from = parseDate(query.from, 'from');
    const to   = parseDate(query.to,   'to');
    if (from && to && new Date(from) > new Date(to)) {
        throw badRequest('INVALID_DATE', 'from must be before to', { field: 'from' });
    }

    // Cursor (keyset)
    let cursor = null;
    if (query.cursor) {
        try {
            const c = typeof query.cursor === 'string' ? JSON.parse(query.cursor) : query.cursor;
            if (c && c.created_at && c.id && UUID_RE.test(String(c.id))) {
                cursor = { created_at: String(c.created_at), id: String(c.id) };
            }
        } catch (_) { /* ignore */ }
    }

    return {
        page, limit,
        adminId, category, categories,
        action, severity, result, actorType, provider,
        correlationId, requestId,
        search, from, to,
        cursor,
        withNeighbours: query.with_neighbours === '1' ? '1' : undefined
    };
}

// ─── Sensitive masking ────────────────────────────────────────
//
// If the caller does not have AUDIT_READ_SENSITIVE, mask the last
// octet of IPs and the UA. Applied ONLY on get(); the list endpoint
// already does not select ip_address / user_agent.

function canReadSensitive(req) {
    const perms = (req.adminContext && Array.isArray(req.adminContext.permissions))
        ? req.adminContext.permissions
        : [];
    if (perms.includes('*')) return true;
    return perms.includes('audit.read_sensitive');
}

function maskIp(ip) {
    if (!ip) return null;
    const s = String(ip);
    // IPv4: last octet → xx
    if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s)) {
        return s.replace(/\.\d+$/, '.xxx');
    }
    // IPv6: last group
    if (s.includes(':')) {
        const parts = s.split(':');
        if (parts.length >= 2) {
            parts[parts.length - 1] = 'xxxx';
            return parts.join(':');
        }
    }
    return s;
}

function maskUserAgent(ua) {
    if (!ua) return null;
    const s = String(ua);
    // Keep the family, drop the version detail.
    if (/^Mozilla\//i.test(s)) return 'Mozilla/…';
    return s.length > 30 ? s.slice(0, 30) + '…' : s;
}

function maskEntry(entry, allowed) {
    if (!entry) return entry;
    if (allowed) return entry;
    return {
        ...entry,
        ip_address: maskIp(entry.ip_address),
        user_agent: maskUserAgent(entry.user_agent),
        _sensitive_masked: true
    };
}

// ─── audit.view dedupe ────────────────────────────────────────
//
// The review called this out: every page load, every filter change,
// and every reload would write an `audit.view` row. That floods the
// log and makes it useless for investigating anything else.
//
// Here we dedupe to at most one `audit.view` per admin per 5
// minutes. The write is fire-and-forget — if it fails, nothing
// breaks and the next eligible admin action retries it.

const VIEW_DEDUPE_MS = 5 * 60 * 1000;
const _lastViewByAdmin = new Map();

function recordViewIfDue(req) {
    const adminId = req.adminContext && req.adminContext.id;
    if (!adminId) return;
    const now = Date.now();
    const last = _lastViewByAdmin.get(adminId) || 0;
    if (now - last < VIEW_DEDUPE_MS) return;
    _lastViewByAdmin.set(adminId, now);

    recordAdminActionStrict({
        req,
        action: 'audit.view',
        targetType: 'audit_log',
        result: 'success'
    }).catch((e) => {
        // Not fatal. Roll back the marker so the next view retries.
        _lastViewByAdmin.delete(adminId);
        console.warn('[ADMIN AUDIT] audit.view write failed:', e.message);
    });
}

// ─── Bootstrap ────────────────────────────────────────────────

router.get(
    '/audit/bootstrap',
    requirePermission(PERMISSIONS.AUDIT_READ),
    readLimit,
    async (req, res) => {
        try {
            const q = validateQuery(req.query);
            const [summary, facets, admins] = await Promise.all([
                audit.summary(q).catch(() => ({ available: false })),
                audit.facets().catch(() => ({
                    categories: [], actions: [], severities: [],
                    results: [], actor_types: [], providers: []
                })),
                audit.distinctAdmins().catch(() => [])
            ]);
            recordViewIfDue(req);
            ok(res, { summary, facets, admins });
        } catch (e) { fail(res, e); }
    }
);

// ─── Summary ──────────────────────────────────────────────────

router.get(
    '/audit/summary',
    requirePermission(PERMISSIONS.AUDIT_READ),
    readLimit,
    async (req, res) => {
        try {
            const q = validateQuery(req.query);
            const s = await audit.summary(q);
            ok(res, { summary: s });
        } catch (e) { fail(res, e); }
    }
);

// ─── Facets ───────────────────────────────────────────────────

router.get(
    '/audit/facets',
    requirePermission(PERMISSIONS.AUDIT_READ),
    readLimit,
    async (req, res) => {
        try {
            const f = await audit.facets();
            ok(res, { facets: f });
        } catch (e) { fail(res, e); }
    }
);

// ─── Admins ───────────────────────────────────────────────────

router.get(
    '/audit/admins',
    requirePermission(PERMISSIONS.AUDIT_READ),
    readLimit,
    async (req, res) => {
        try {
            const admins = await audit.distinctAdmins();
            ok(res, { admins });
        } catch (e) { fail(res, e); }
    }
);

// ─── Recent (timeline) ────────────────────────────────────────
// MUST be declared before /:id.

router.get(
    '/audit/recent',
    requirePermission(PERMISSIONS.AUDIT_READ),
    readLimit,
    async (req, res) => {
        try {
            const q = validateQuery(req.query);
            const limit = q.limit <= 200 ? q.limit : 20;
            const entries = await audit.recent(limit, q);
            ok(res, { entries });
        } catch (e) { fail(res, e); }
    }
);

// ─── Integrity ────────────────────────────────────────────────
// MUST be declared before /:id.

router.get(
    '/audit/integrity',
    requirePermission(PERMISSIONS.AUDIT_ADMIN),
    readLimit,
    async (req, res) => {
        try {
            const q = validateQuery(req.query);
            const r = await audit.verifyIntegrity(q.from, q.to);
            ok(res, { integrity: r });
        } catch (e) { fail(res, e); }
    }
);

// ─── Export ───────────────────────────────────────────────────
// MUST be declared before /:id.

router.get(
    '/audit/export',
    requirePermission(PERMISSIONS.AUDIT_EXPORT),
    exportLimit,
    async (req, res) => {
        const started = Date.now();
        try {
            const q = validateQuery(req.query);
            const includeSensitive = canReadSensitive(req);

            const result = await audit.exportCsv(
                { ...q, cursor: undefined },
                { maxRows: 50000, includeSensitive }
            );

            // Strict audit of the export itself. If this fails, the
            // export is aborted so we never hand out data without a
            // record of who took it.
            await recordAdminActionStrict({
                req,
                action: 'audit.export',
                targetType: 'audit_log',
                result: 'success',
                durationMs: Date.now() - started,
                metadata: {
                    filters: {
                        search: q.search || null,
                        admin_id: q.adminId || null,
                        categories: q.categories || null,
                        action: q.action || null,
                        severity: q.severity || null,
                        result: q.result || null,
                        actor_type: q.actorType || null,
                        provider: q.provider || null,
                        from: q.from || null,
                        to: q.to || null
                    },
                    row_count: result.rowCount,
                    truncated: result.truncated,
                    include_sensitive: includeSensitive
                }
            });

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename=admin_audit_${new Date().toISOString().slice(0, 10)}.csv`
            );
            res.setHeader('X-Export-Row-Count', String(result.rowCount));
            if (result.truncated) res.setHeader('X-Export-Truncated', 'true');
            res.send(result.csv);
        } catch (e) {
            fail(res, e);
        }
    }
);

// ─── List ─────────────────────────────────────────────────────

router.get(
    '/audit',
    requirePermission(PERMISSIONS.AUDIT_READ),
    readLimit,
    async (req, res) => {
        try {
            const q = validateQuery(req.query);
            const result = await audit.list(q);
            ok(res, result);
        } catch (e) { fail(res, e); }
    }
);

// ─── Single entry ─────────────────────────────────────────────
// MUST be declared last among /audit* routes.

router.get(
    '/audit/:id',
    requirePermission(PERMISSIONS.AUDIT_READ),
    readLimit,
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await audit.get(req.params.id);

            // Mask sensitive fields unless the caller has the
            // dedicated permission.
            const allowSensitive = canReadSensitive(req);
            if (!allowSensitive && data.entry) {
                data.entry = maskEntry(data.entry, false);
            }

            ok(res, data);
        } catch (e) { fail(res, e); }
    }
);

module.exports = router;