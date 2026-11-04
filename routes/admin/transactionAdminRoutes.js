// routes/admin/transactionAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// REVISION 2026-11-04 (Batch 6)
//
// Admin Transactions — ROUTES.
//
// Fixes vs. Batch 5:
//   • The trailing JSON 404 is now SCOPED to ['/transactions', '/refunds'].
//     Batch 5's unscoped `router.use((req,res)=>...)` swallowed every
//     sibling /api/admin/* route (meRoutes, permissionsRoutes,
//     stepUpRoutes, dashboardRoutes, …) because this router is mounted
//     at the shared /api/admin prefix. That made GET /api/admin/me
//     return {code:'ROUTE_NOT_FOUND'} and broke the whole admin UI.
//   • The rate-limiter cleanup interval is wrapped in try/catch so
//     process shutdown can't throw out of it.
//   • Scoped 404 sets no-store so a browser can't cache a miss.
//
// Unchanged vs. Batch 5:
//   • Cache-Control: no-store + X-Content-Type-Options: nosniff on
//     every response under /transactions and /refunds.
//   • In-memory rate limiting on refund, approve, reject, export,
//     and status endpoints.
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
const { supabaseAdmin } = require('../../db/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:\-]{8,200}$/;
const MAX_REFUND_AMOUNT = refundSvc.MAX_REFUND_AMOUNT || 10_000_000;

// Step-up error codes emitted by adminStepUp.js (Batch 0):
//   STEP_UP_EXPIRED     403 — verification is stale, prompt to re-verify
//   MFA_REQUIRED        403 — no verification at all for this session
//   SESSION_EXPIRED     401 — the whole session is gone; sign in again
//   SESSION_NOT_FOUND   401 — session row missing
//   SESSION_REVOKED     401 — revoked
//   STEP_UP_UNAVAILABLE 503 — auth DB failure
//   STEP_UP_ERROR       500 — anything else
// The UI must handle STEP_UP_EXPIRED and MFA_REQUIRED by prompting
// for MFA and retrying with the SAME Idempotency-Key.
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
// For 5xx, only the code-to-message table decides what the client
// sees. Anything not in the table returns a generic message. Raw
// DB / provider text goes to the server log with the request ID.
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
    PERMISSION_SERVICE_UNAVAILABLE:   'Permission service unavailable. Please try again.'
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
    // Accept YYYY-MM-DD or full ISO.
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
    if (!IDEMPOTENCY_KEY_RE.match(s)) {
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

// Scoped so a sibling mount (/api/admin/me, /api/admin/permissions,
// …) can never be affected by these middlewares. Batch 5 wrote
// `router.use('/transactions', …)` at the very top of a file that is
// mounted at /api/admin — harmless because the path is scoped — but
// the pattern is easy to get wrong, so this comment block now
// documents the rule: EVERY middleware and EVERY fallback in this
// file must carry a path.
router.use(['/transactions', '/refunds'], adminResponseHeaders);
router.use(['/transactions', '/refunds'], attachRequestId);

// ─── In-memory rate limiter ─────────────────────────────────────
// Small, dependency-free. Buckets per (adminId || ip) per route
// family. Not shared across processes — acceptable for a single
// Node instance. Replace with a shared store (Redis) if you scale
// horizontally; the interface is one function.

const RATE_BUCKETS = new Map();   // key → { count, resetAt }
const RATE_LIMITS = {
    refund:  { max: 10,  windowMs: 60_000 },     // 10 refunds / min / admin
    approve: { max: 20,  windowMs: 60_000 },     // 20 approvals / min / admin
    reject:  { max: 20,  windowMs: 60_000 },
    status:  { max: 30,  windowMs: 60_000 },     // 30 status changes / min / admin
    export:  { max: 3,   windowMs: 60_000 }      // 3 exports / min / admin
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

// Periodic cleanup — drop expired buckets so the map doesn't grow
// unbounded on a long-running process. Never throw out of the
// interval: a stray error here must not crash shutdown.
const _rateCleanupInterval = setInterval(() => {
    try {
        const now = Date.now();
        for (const [k, b] of RATE_BUCKETS) {
            if (now >= b.resetAt) RATE_BUCKETS.delete(k);
        }
    } catch (e) {
        // Never let cleanup crash the process.
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

// ─── Type registry ──────────────────────────────────────────────
// The UI filter dropdown reads from this. One source: the shared
// transactionTypes module.
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

// ─── Export ─────────────────────────────────────────────────────
// Audit BEFORE streaming. If the audit row can't be written, the
// file is not generated. Filename uses ISO date in WAT.
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

            // Audit insert — before the file leaves the server.
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

            // Filename: transactions_2026-11-03_<timestamp>.csv (WAT date)
            const watDate = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Africa/Lagos',
                year: 'numeric', month: '2-digit', day: '2-digit'
            }).format(new Date());
            const filename = `transactions_${watDate}_${Date.now()}.csv`;

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('X-Export-Row-Count', String(result.rowCount));
            if (result.truncated) {
                res.setHeader('X-Export-Truncated', 'true');
            }
            res.setHeader('X-Export-Timezone', result.timezone || 'Africa/Lagos');
            res.send(result.csv);
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
//  PARAM ROUTES (each validates :id is a UUID)
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

// ─── Status change ──────────────────────────────────────────────
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

// ─── Refund (step-up + idempotency-required + rate-limited) ────
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

// ─── Note ───────────────────────────────────────────────────────
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
//  REFUNDS — listing + approve/reject
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

// ─── Approve a pending refund ───────────────────────────────────
// Step-up required (financial action). Approver ≠ requester is
// enforced inside the RPC. Rate-limited.
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

// ─── Reject a pending refund ────────────────────────────────────
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
//
//  This router is mounted at /api/admin alongside meRoutes,
//  permissionsRoutes, stepUpRoutes, dashboardRoutes, settingsRoutes,
//  and many more. An UNSCOPED `router.use((req,res)=>...)` here
//  would swallow every sibling mount because Express falls through
//  to the next matching layer in registration order.
//
//  Scoping by path guarantees that a request for /api/admin/me falls
//  through this router untouched and reaches meRoutes.
//
//  Rule for this file: every middleware and every fallback must
//  carry a path.
// ═════════════════════════════════════════════════════════════════
router.use(['/transactions', '/refunds'], (req, res) => {
    if (res.headersSent) return;
    // Belt-and-braces: never cache a miss.
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