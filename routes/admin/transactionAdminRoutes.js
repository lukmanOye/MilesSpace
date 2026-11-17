// routes/admin/transactionAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// REVISION 2026-11-13 (Batch 7) — adds transaction feedback.
//
// Admin Transactions — ROUTES.
//
// Adds vs. Batch 6:
//   • GET  /feedback                   (TRANSACTIONS_READ)
//   • GET  /feedback/summary           (TRANSACTIONS_READ)
//   • PUT  /feedback/:id/review        (TRANSACTIONS_RESOLVE)
//   • GET  /feedback/export            (REPORTS_EXPORT)
//   • SAFE_500 entries for the feedback service's stable codes.
//   • Scoped middleware + scoped 404 now include /feedback so admin
//     headers and the JSON 404 apply there too.
//
// Preserved from Batch 6:
//   • Scoped `router.use(['/transactions', '/refunds'], …)` — never
//     an unscoped middleware, so sibling mounts (meRoutes,
//     permissionsRoutes, dashboardRoutes, …) keep working.
//   • Cache-Control: no-store + X-Content-Type-Options: nosniff on
//     every response under this router's own prefixes.
//   • In-memory rate limiting on refund, approve, reject, export
//     and status.
//   • Endpoints: /transactions/types, /refunds/:id/approve,
//     /refunds/:id/reject.
//   • Input validation → 422 with UI-renderable codes.
//   • Export audited BEFORE streaming; truncated surfaced via headers.
//   • Step-up error codes exposed as STEP_UP_CODES.
//   • Refund amount cap from refundService.MAX_REFUND_AMOUNT.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const {
    requirePermission,
    PERMISSIONS,
    getClientIp
} = require('../../middleware/adminAuth');
const { requireStepUpAuth } = require('../../middleware/adminStepUp');
const txAdmin = require('../../services/transactionAdminService');
const refundSvc = require('../../services/refundService');
const fbAdmin = require('../../services/feedbackAdminService');
const { supabaseAdmin } = require('../../db/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:\-]{8,200}$/;
const MAX_REFUND_AMOUNT = refundSvc.MAX_REFUND_AMOUNT || 10_000_000;

// Step-up error codes emitted by adminStepUp.js.
const STEP_UP_CODES = Object.freeze({
    EXPIRED: 'STEP_UP_EXPIRED',
    MFA_REQUIRED: 'MFA_REQUIRED',
    SESSION_EXPIRED: 'SESSION_EXPIRED',
    SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
    SESSION_REVOKED: 'SESSION_REVOKED',
    UNAVAILABLE: 'STEP_UP_UNAVAILABLE',
    ERROR: 'STEP_UP_ERROR'
});

// ─── Safe error messages ────────────────────────────────────────
const SAFE_500 = {
    TX_LIST_FAILED:                   'Could not load transactions.',
    TX_RECENT_FAILED:                 'Could not load recent transactions.',
    TX_SUMMARY_FAILED:                'Could not load summary.',
    TX_SUMMARY_COUNT_FAILED:          'Could not load summary.',
    TX_DETAIL_FAILED:                 'Could not load transaction details.',
    TX_STATUS_UPDATE_FAILED:          'Could not update status.',
    TX_STATUS_GET_FAILED:             'Could not load transaction.',
    AUDIT_INSERT_FAILED:              'Status change could not be audited. No change was applied.',
    TX_EXPORT_FAILED:                 'Could not export transactions.',
    EXPORT_AUDIT_FAILED:              'Export could not be audited. No file was generated.',
    PROFILES_LOOKUP_FAILED:           'Could not load customer profiles.',
    TX_NOT_FOUND:                     'Transaction not found.',
    TX_NOTE_LOOKUP_FAILED:            'Could not load transaction.',
    REFUND_CREATE_FAILED:             'Could not create refund record.',
    REFUND_UPDATE_FAILED:             'Could not update refund.',
    REFUNDS_LIST_FAILED:              'Could not load refunds.',
    REFUND_READ_FAILED:               'Could not load refund.',
    APPROVE_FAILED:                   'Failed to approve refund.',
    REJECT_FAILED:                    'Failed to reject refund.',
    PROVIDER_REFUND_DISPATCH_FAILED:  'Provider refund dispatch failed.',
    LEDGER_REJECTED:                  'The ledger rejected the operation.',
    RECONCILE_REQUIRED:               'The operation is in a reconcilable state. Contact engineering.',
    PERMISSION_SERVICE_UNAVAILABLE:   'Permission service unavailable. Please try again.',

    // Feedback (Batch 7)
    FB_LIST_FAILED:                   'Could not load feedback.',
    FB_SUMMARY_FAILED:                'Could not load feedback summary.',
    FB_EXPORT_FAILED:                 'Could not export feedback.',
    FB_LOOKUP_FAILED:                 'Could not load feedback.',
    FB_UPDATE_FAILED:                 'Could not update feedback.',
    FB_NOT_FOUND:                     'Feedback not found.',
};

function sendOk(res, payload) {
    if (!res.headersSent) res.json({ success: true, ...payload });
}

function sendErr(res, err, ctx) {
    if (res.headersSent) return;

    const status = err?.status || 500;
    const code = err?.code || 'TX_ADMIN_ERROR';
    const requestId = ctx?.requestId || null;

    let message;
    if (status < 500) {
        message = err?.message || 'Request failed.';
    } else {
        message = SAFE_500[code] || 'Something went wrong. Please try again.';
    }

    if (status >= 500) {
        console.error('[ADMIN TX]', JSON.stringify({
            ts: new Date().toISOString(),
            requestId,
            code,
            status,
            adminId: ctx?.adminId || null,
            raw_message: String(err?.message || '').slice(0, 500),
            detail: err?.detail || null,
            refund_id: err?.refund_id || null,
            ledger_transaction_id: err?.ledger_transaction_id || null
        }));
    }

    const body = { success: false, code, error: message, requestId };
    if (err?.allowed_transitions) body.allowed_transitions = err.allowed_transitions;
    if (err?.current_status) body.current_status = err.current_status;
    if (err?.transaction_type) body.transaction_type = err.transaction_type;
    if (err?.reason) body.reason = err.reason;
    if (err?.reason_label) body.reason_label = err.reason_label;
    if (err?.remaining_amount) body.remaining_amount = err.remaining_amount;
    if (err?.original_amount) body.original_amount = err.original_amount;
    if (err?.refund_id) body.refund_id = err.refund_id;
    if (err?.pending_refund_id) body.pending_refund_id = err.pending_refund_id;
    if (err?.provider) body.provider = err.provider;

    res.status(status).json(body);
}

function adminCtx(req) {
    return {
        adminId: req.adminContext?.id || null,
        adminEmail: req.adminContext?.email || null,
        ip: getClientIp(req),
        userAgent: (req.headers['user-agent'] || '').slice(0, 400) || null,
        requestId: req.requestId || null
    };
}

function can(ctx, permission) {
    if (!ctx) return false;
    if (ctx.isSuperAdmin) return true;
    if (!Array.isArray(ctx.permissions)) return false;
    if (ctx.permissions.includes('*')) return true;
    return ctx.permissions.includes(permission);
}

// ─── Input validation helpers ───────────────────────────────────

function strOnly(v, maxLen = 500) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s) return null;
    return s.slice(0, maxLen);
}

function isoDateOrNull(v) {
    const s = strOnly(v, 40);
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return s;
}

function uuidOrNull(v) {
    const s = strOnly(v, 64);
    if (!s) return null;
    return UUID_RE.test(s) ? s : null;
}

function intOrNull(v, { min = 1, max = 1_000_000 } = {}) {
    const s = strOnly(v, 20);
    if (!s) return null;
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) return null;
    if (n < min || n > max) return null;
    return n;
}

function enumOrNull(v, allowed) {
    const s = strOnly(v, 40);
    if (!s) return null;
    const lc = s.toLowerCase();
    return allowed.has(lc) ? lc : null;
}

function requireIdempotencyKey(req) {
    const raw = req.headers['idempotency-key'];
    if (!raw || typeof raw !== 'string') {
        const e = new Error('An Idempotency-Key header (8-200 characters) is required.');
        e.code = 'IDEMPOTENCY_KEY_REQUIRED';
        e.status = 422;
        throw e;
    }
    const s = raw.trim();
    if (!IDEMPOTENCY_KEY_RE.test(s)) {
        const e = new Error('Idempotency-Key must be 8-200 characters using A-Z a-z 0-9 . _ : -');
        e.code = 'INVALID_IDEMPOTENCY_KEY';
        e.status = 422;
        throw e;
    }
    return s;
}

function requireAmountString(raw) {
    if (raw === null || raw === undefined || raw === '') {
        const e = new Error('Refund amount is required.');
        e.code = 'INVALID_AMOUNT';
        e.status = 422;
        throw e;
    }
    const s = String(raw).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s)) {
        const e = new Error('Amount must be a number with at most 2 decimal places.');
        e.code = 'INVALID_AMOUNT';
        e.status = 422;
        throw e;
    }
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) {
        const e = new Error('Amount must be positive.');
        e.code = 'INVALID_AMOUNT';
        e.status = 422;
        throw e;
    }
    if (n > MAX_REFUND_AMOUNT) {
        const e = new Error(`Amount must be at most ${MAX_REFUND_AMOUNT.toLocaleString('en-US')}.`);
        e.code = 'AMOUNT_TOO_LARGE';
        e.status = 422;
        throw e;
    }
    return s;
}

function requireReason(raw, { min = 4, max = 500 } = {}) {
    const s = String(raw || '').trim();
    if (s.length < min) {
        const e = new Error(`A reason of at least ${min} characters is required.`);
        e.code = 'REASON_REQUIRED';
        e.status = 422;
        throw e;
    }
    if (s.length > max) {
        const e = new Error(`Reason must be ${max} characters or fewer.`);
        e.code = 'REASON_TOO_LONG';
        e.status = 422;
        throw e;
    }
    return s;
}

// ─── Request ID middleware ──────────────────────────────────────

function safeRequestId(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s || s.length > 80) return null;
    if (UUID_RE.test(s)) return s;
    if (/^[A-Za-z0-9_\-]{8,80}$/.test(s)) return s;
    return null;
}

function attachRequestId(req, res, next) {
    const provided = safeRequestId(req.headers['x-request-id']);
    req.requestId = provided || crypto.randomUUID();
    if (!res.headersSent) res.setHeader('X-Request-Id', req.requestId);
    next();
}

// ─── Response headers ───────────────────────────────────────────

function adminResponseHeaders(req, res, next) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Authorization');
    next();
}

// Scoped so a sibling mount can never be affected by these.
// Rule: EVERY middleware and EVERY fallback in this file MUST
// carry a path prefix. Add '/feedback' here when its routes are
// added below.
router.use(['/transactions', '/refunds', '/feedback'], adminResponseHeaders);
router.use(['/transactions', '/refunds', '/feedback'], attachRequestId);

// ─── In-memory rate limiter ─────────────────────────────────────

const RATE_BUCKETS = new Map();
const RATE_LIMITS = {
    refund:  { max: 10,  windowMs: 60_000 },
    approve: { max: 20,  windowMs: 60_000 },
    reject:  { max: 20,  windowMs: 60_000 },
    status:  { max: 30,  windowMs: 60_000 },
    export:  { max: 3,   windowMs: 60_000 }
};

function rateLimit(name) {
    const cfg = RATE_LIMITS[name] || { max: 60, windowMs: 60_000 };
    return (req, res, next) => {
        const subject = req.adminContext?.id || getClientIp(req) || 'unknown';
        const key = `${name}:${subject}`;
        const now = Date.now();
        let bucket = RATE_BUCKETS.get(key);
        if (!bucket || now >= bucket.resetAt) {
            bucket = { count: 1, resetAt: now + cfg.windowMs };
            RATE_BUCKETS.set(key, bucket);
            return next();
        }
        if (bucket.count >= cfg.max) {
            const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
            if (!res.headersSent) {
                res.setHeader('Retry-After', String(retryAfter));
                return res.status(429).json({
                    success: false,
                    code: 'RATE_LIMITED',
                    error: 'Too many requests. Please slow down.',
                    retry_after_seconds: retryAfter,
                    requestId: req.requestId || null
                });
            }
            return;
        }
        bucket.count++;
        next();
    };
}

const _rateCleanupInterval = setInterval(() => {
    try {
        const now = Date.now();
        for (const [k, b] of RATE_BUCKETS) {
            if (now >= b.resetAt) RATE_BUCKETS.delete(k);
        }
    } catch (e) {
        console.warn('[ADMIN TX] rate-bucket cleanup error:', e && e.message);
    }
}, 60_000);
if (_rateCleanupInterval && typeof _rateCleanupInterval.unref === 'function') {
    _rateCleanupInterval.unref();
}

// ═════════════════════════════════════════════════════════════════
//  LITERAL ROUTES (declared before /:id)
// ═════════════════════════════════════════════════════════════════

router.get(
    '/transactions/recent',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        const ctx = adminCtx(req);
        try {
            const limit = intOrNull(req.query.limit, { min: 1, max: 50 }) || 10;
            const data = await txAdmin.getRecentTransactions({ limit });
            res.json({ success: true, transactions: data });
        } catch (err) { sendErr(res, err, ctx); }
    }
);

router.get(
    '/transactions/summary',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        const ctx = adminCtx(req);
        try {
            const summary = await txAdmin.getSummary({
                from:     isoDateOrNull(req.query.from),
                to:       isoDateOrNull(req.query.to),
                currency: strOnly(req.query.currency, 8),
                type:     strOnly(req.query.type, 40),
                provider: strOnly(req.query.provider, 60)
            });
            sendOk(res, { summary });
        } catch (err) { sendErr(res, err, ctx); }
    }
);

router.get(
    '/transactions/types',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    (req, res) => {
        try {
            const registry = txAdmin.getTypeRegistry();
            sendOk(res, { registry });
        } catch (err) {
            sendErr(res, err, adminCtx(req));
        }
    }
);

router.get(
    '/transactions/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    rateLimit('export'),
    async (req, res) => {
        const ctx = adminCtx(req);
        try {
            const filters = {
                from:     isoDateOrNull(req.query.from),
                to:       isoDateOrNull(req.query.to),
                type:     strOnly(req.query.type, 40),
                status:   strOnly(req.query.status, 40),
                currency: strOnly(req.query.currency, 8),
                provider: strOnly(req.query.provider, 60),
                user_id:  uuidOrNull(req.query.user_id),
                search:   strOnly(req.query.search, 200)
            };

            const result = await txAdmin.exportTransactions(filters);

            const auditReason = `Exported ${result.rowCount} row(s) with filters: ${JSON.stringify(filters)}`.slice(0, 500);
            const { error: auditErr } = await supabaseAdmin
                .from('admin_audit_logs')
                .insert({
                    admin_id:    ctx.adminId,
                    admin_email: ctx.adminEmail,
                    action:      'transaction.export',
                    target_type: 'transactions_export',
                    target_id:   null,
                    reason:      auditReason,
                    ip_address:  ctx.ip,
                    user_agent:  ctx.userAgent,
                    request_id:  ctx.requestId,
                    created_at:  new Date().toISOString()
                });

            if (auditErr) {
                console.error('[ADMIN TX] export audit failed', {
                    requestId: ctx.requestId,
                    adminId: ctx.adminId,
                    error: auditErr.message
                });
                return res.status(500).json({
                    success: false,
                    code: 'EXPORT_AUDIT_FAILED',
                    error: SAFE_500.EXPORT_AUDIT_FAILED,
                    requestId: ctx.requestId
                });
            }

            const watDate = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Africa/Lagos',
                year: 'numeric', month: '2-digit', day: '2-digit'
            }).format(new Date());
            const filename = `transactions_${watDate}_${Date.now()}.csv`;

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('X-Export-Row-Count', String(result.rowCount));
            if (result.truncated) res.setHeader('X-Export-Truncated', 'true');
            res.setHeader('X-Export-Timezone', result.timezone || 'Africa/Lagos');
            res.send(result.csv);
        } catch (err) { sendErr(res, err, ctx); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  FEEDBACK (declared before /transactions/:id, /feedback/:id)
// ═════════════════════════════════════════════════════════════════

router.get(
    '/feedback',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        const ctx = adminCtx(req);
        try {
            const result = await fbAdmin.listFeedback({
                rating:        strOnly(req.query.rating, 4),
                review_status: strOnly(req.query.review_status, 20),
                type:          strOnly(req.query.type, 20),
                from:          isoDateOrNull(req.query.from),
                to:            isoDateOrNull(req.query.to),
                search:        strOnly(req.query.search, 100),
                page:          intOrNull(req.query.page, { min: 1, max: 100_000 }) || 1,
                limit:         intOrNull(req.query.limit, { min: 1, max: 200 }) || 25
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err, ctx); }
    }
);

router.get(
    '/feedback/summary',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        const ctx = adminCtx(req);
        try {
            const result = await fbAdmin.getSummary({
                from: isoDateOrNull(req.query.from),
                to:   isoDateOrNull(req.query.to)
            });
            sendOk(res, { summary: result });
        } catch (err) { sendErr(res, err, ctx); }
    }
);

router.get(
    '/feedback/export',
    requirePermission(PERMISSIONS.REPORTS_EXPORT),
    async (req, res) => {
        const ctx = adminCtx(req);
        try {
            const result = await fbAdmin.exportCsv({
                rating:        strOnly(req.query.rating, 4),
                review_status: strOnly(req.query.review_status, 20),
                type:          strOnly(req.query.type, 20),
                from:          isoDateOrNull(req.query.from),
                to:            isoDateOrNull(req.query.to),
                search:        strOnly(req.query.search, 100)
            });

            const auditReason = `Exported ${result.rowCount} feedback row(s)`.slice(0, 500);
            const { error: auditErr } = await supabaseAdmin
                .from('admin_audit_logs')
                .insert({
                    admin_id:    ctx.adminId,
                    admin_email: ctx.adminEmail,
                    action:      'transaction.feedback_export',
                    target_type: 'transaction_feedback_export',
                    target_id:   null,
                    reason:      auditReason,
                    ip_address:  ctx.ip,
                    user_agent:  ctx.userAgent,
                    request_id:  ctx.requestId,
                    created_at:  new Date().toISOString()
                });

            if (auditErr) {
                console.error('[ADMIN TX] feedback export audit failed', {
                    requestId: ctx.requestId,
                    adminId: ctx.adminId,
                    error: auditErr.message
                });
                return res.status(500).json({
                    success: false,
                    code: 'EXPORT_AUDIT_FAILED',
                    error: SAFE_500.EXPORT_AUDIT_FAILED,
                    requestId: ctx.requestId
                });
            }

            const watDate = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Africa/Lagos',
                year: 'numeric', month: '2-digit', day: '2-digit'
            }).format(new Date());
            const filename = `feedback_${watDate}_${Date.now()}.csv`;

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('X-Export-Row-Count', String(result.rowCount));
            if (result.truncated) res.setHeader('X-Export-Truncated', 'true');
            res.setHeader('X-Export-Timezone', result.timezone || 'Africa/Lagos');
            res.send(result.csv);
        } catch (err) { sendErr(res, err, ctx); }
    }
);

// PUT must be declared before the /:id route to avoid the /:id
// matcher shadowing this. Express is method-aware, so `PUT /:id/review`
// vs `GET /:id` don't collide, but keeping PUT above GET /:id keeps
// the intent obvious when scanning the file.
router.put(
    '/feedback/:id/review',
    requirePermission(PERMISSIONS.TRANSACTIONS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        const ctx = adminCtx(req);
        try {
            const result = await fbAdmin.reviewFeedback({
                id: req.params.id,
                review_status: req.body?.review_status,
                admin_note:    req.body?.admin_note,
                reason:        req.body?.reason,
                ctx
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err, ctx); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  LIST
// ═════════════════════════════════════════════════════════════════

router.get(
    '/transactions',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        const ctx = adminCtx(req);
        try {
            const result = await txAdmin.getTransactions({
                page:     intOrNull(req.query.page, { min: 1, max: 100_000 }) || 1,
                limit:    intOrNull(req.query.limit, { min: 1, max: 200 }) || 25,
                search:   strOnly(req.query.search, 200),
                type:     strOnly(req.query.type, 40),
                status:   strOnly(req.query.status, 40),
                currency: strOnly(req.query.currency, 8),
                provider: strOnly(req.query.provider, 60),
                user_id:  uuidOrNull(req.query.user_id),
                from:     isoDateOrNull(req.query.from),
                to:       isoDateOrNull(req.query.to),
                sort:     strOnly(req.query.sort, 20),
                order:    strOnly(req.query.order, 8),
                exact:    strOnly(req.query.exact, 4)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err, ctx); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  PARAM ROUTES
// ═════════════════════════════════════════════════════════════════

router.get(
    '/transactions/:id',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        const ctx = adminCtx(req);
        try {
            const includeRefundCapability = can(req.adminContext, PERMISSIONS.TRANSACTIONS_REFUND);
            const canResolve = can(req.adminContext, PERMISSIONS.TRANSACTIONS_RESOLVE);
            const data = await txAdmin.getTransaction(req.params.id, {
                includeRefundCapability,
                canResolve
            });
            sendOk(res, data);
        } catch (err) { sendErr(res, err, ctx); }
    }
);

router.put(
    '/transactions/:id/status',
    requirePermission(PERMISSIONS.TRANSACTIONS_RESOLVE),
    rateLimit('status'),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        const ctx = adminCtx(req);
        try {
            const { status, reason } = req.body || {};
            const statusClean = strOnly(status, 40);
            if (!statusClean) {
                const e = new Error('A status is required.');
                e.code = 'STATUS_REQUIRED';
                e.status = 422;
                throw e;
            }
            const reasonClean = requireReason(reason, { min: 4, max: 500 });

            const result = await txAdmin.changeStatus({
                transactionId: req.params.id,
                nextStatus: statusClean.toLowerCase(),
                reason: reasonClean,
                ctx
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err, ctx); }
    }
);

router.post(
    '/transactions/:id/refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    rateLimit('refund'),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        const ctx = adminCtx(req);
        try {
            const idempotencyKey = requireIdempotencyKey(req);
            const amountString = requireAmountString(req.body?.amount);
            const reasonClean = requireReason(req.body?.reason, { min: 4, max: 500 });

            const result = await txAdmin.refundTransaction({
                transactionId: req.params.id,
                amount: amountString,
                reason: reasonClean,
                ctx,
                idempotencyKey
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err, ctx); }
    }
);

router.post(
    '/transactions/:id/note',
    requirePermission(PERMISSIONS.TRANSACTIONS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        const ctx = adminCtx(req);
        try {
            const note = requireReason(req.body?.note, { min: 2, max: 1000 });
            const result = await txAdmin.addNote({
                transactionId: req.params.id,
                note,
                ctx
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err, ctx); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  REFUNDS
// ═════════════════════════════════════════════════════════════════

router.get(
    '/refunds',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        const ctx = adminCtx(req);
        try {
            const result = await refundSvc.listRefunds({
                status: strOnly(req.query.status, 40) || 'all',
                limit:  intOrNull(req.query.limit, { min: 1, max: 200 }) || 50,
                page:   intOrNull(req.query.page, { min: 1, max: 100_000 }) || 1
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err, ctx); }
    }
);

router.get(
    '/refunds/:id',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        const ctx = adminCtx(req);
        try {
            const refund = await refundSvc.getRefund(req.params.id);
            sendOk(res, { refund });
        } catch (err) { sendErr(res, err, ctx); }
    }
);

router.post(
    '/refunds/:id/approve',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    rateLimit('approve'),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        const ctx = adminCtx(req);
        try {
            const reasonClean = req.body?.reason
                ? requireReason(req.body.reason, { min: 4, max: 500 })
                : null;
            const result = await txAdmin.approveRefund({
                refundId: req.params.id,
                ctx,
                reason: reasonClean
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err, ctx); }
    }
);

router.post(
    '/refunds/:id/reject',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    rateLimit('reject'),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        const ctx = adminCtx(req);
        try {
            const reasonClean = requireReason(req.body?.reason, { min: 4, max: 500 });
            const result = await txAdmin.rejectRefund({
                refundId: req.params.id,
                ctx,
                reason: reasonClean
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err, ctx); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  SCOPED 404 — only for this router's own prefixes.
// ═════════════════════════════════════════════════════════════════
router.use(['/transactions', '/refunds', '/feedback'], (req, res) => {
    if (res.headersSent) return;
    try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    } catch (_) { /* ignore */ }

    res.status(404).json({
        success: false,
        code: 'ROUTE_NOT_FOUND',
        error: `Route ${req.method} ${req.originalUrl.split('?')[0]} not found.`,
        requestId: req.requestId || null
    });
});

module.exports = router;
module.exports.STEP_UP_CODES = STEP_UP_CODES;