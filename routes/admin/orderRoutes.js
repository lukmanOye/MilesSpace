// routes/admin/orderRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Orders API. Mirrors routes/admin/transactionAdminRoutes.js:
//   • Scoped 404 (['/orders']) so sibling /api/admin/* mounts are untouched.
//   • no-store headers on every response under /orders.
//   • Per-admin in-memory rate limiting per route family.
//   • Safe 5xx messages via SAFE_500 map; raw text logged with requestId.
//   • Input validation → 422 with UI-renderable codes.
//   • Idempotency-Key required on refund, retry, status, cancel, note.
//   • Step-up (requireStepUpAuth) on refund, retry, status→completed, cancel of paid orders.
//   • Audit written BEFORE streaming export.
//   • Every middleware carries a path.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { requirePermission, PERMISSIONS, getClientIp } = require('../../middleware/adminAuth');
const { requireStepUpAuth } = require('../../middleware/adminStepUp');
const ordersService = require('../../services/ordersService');
const providerFactory = require('../../services/providers/providerFactory');
const providerMetadata = require('../../services/providers/providerMetadata');
const { supabaseAdmin } = require('../../db/supabase');

const INT_RE = /^\d+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEM_KEY_RE = /^[A-Za-z0-9._:\-]{8,200}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const LIST_MAX_LIMIT = 100;
const EXPORT_MAX_ROWS = 5000;
const SEARCH_MAX_LEN = 100;
const REASON_MIN = 4;
const REASON_MAX = 500;
const NOTE_MAX = 1000;

const SORTABLE = new Set(['created_at', 'updated_at', 'completed_at', 'total_amount']);
const PAYMENT_STATUSES = new Set(['unpaid', 'pending', 'paid', 'failed', 'refunded', 'partially_refunded']);

const SAFE_500 = {
    ORDER_LIST_ERROR:           'Could not load orders.',
    ORDER_DETAIL_ERROR:         'Could not load order details.',
    TIMELINE_ERROR:             'Could not load timeline.',
    WEBHOOK_LIST_ERROR:         'Could not load webhooks.',
    STATS_ERROR:                'Could not load summary.',
    ATTENTION_ERROR:            'Could not load attention counts.',
    FILTERS_ERROR:              'Could not load filters.',
    ORDER_REGISTER_FAILED:      'Could not register order.',
    INVALID_ID:                 'Invalid identifier.',
    ORDER_NOT_FOUND:            'Order not found.',
    INVALID_STATUS:             'Invalid status.',
    INVALID_STATUS_TRANSITION:  'That status change is not allowed.',
    ORDER_STATE_CHANGED:        'The order changed before this action completed. Reload and try again.',
    REASON_REQUIRED:            'A reason is required (minimum 4 characters).',
    NOT_REFUNDABLE:             'This order is not eligible for a refund.',
    INVALID_AMOUNT:             'Invalid amount.',
    REFUND_EXCEEDS_ORDER:       'Refund amount exceeds the refundable balance.',
    REFUND_CLAIM_FAILED:        'Could not claim refund — try again.',
    REFUND_SCHEMA_NOT_MIGRATED: 'Repeated refunds require the pending SQL migration. See the error detail.',
    LEDGER_REFUND_FAILED:       'Wallet refund failed.',
    NOTE_REQUIRED:              'Note text is required.',
    NOTE_SAVE_FAILED:           'Failed to save note.',
    NOT_RETRYABLE:              'This order cannot be re-queued.',
    RETRY_FAILED:               'Re-queue could not be created.',
    PROVIDER_NOT_SUPPORTED:     'Provider does not support this action.',
    PROVIDER_TIMEOUT:           'The provider took too long to respond. Try again shortly.',
    PROVIDER_NOT_CONFIGURED:    'Provider is not configured on the server.',
    PROVIDER_BAD_RESPONSE:      'Provider returned an unexpected response.',
    CIRCUIT_OPEN:               'Provider is temporarily disabled after repeated failures.',
    UNKNOWN_PROVIDER:           'Unknown provider.',
    SYNC_IN_PROGRESS:           'A bulk sync is already running. Try again shortly.',
    AUDIT_INSERT_FAILED:        'Action could not be audited. No change was applied.',
    PERMISSION_DENIED:          'You do not have permission to perform this action.',
    RATE_LIMITED:               'Too many requests. Slow down and try again shortly.',
    INVALID_IDEMPOTENCY_KEY:    'Idempotency-Key must be 8–200 chars of A–Z a–z 0–9 . _ : -',
    INVALID_QUERY:              'Invalid query parameter.',
    EXPORT_AUDIT_FAILED:        'Export could not be audited. No file was generated.'
};

const STEP_UP_CODES = Object.freeze({
    EXPIRED: 'STEP_UP_EXPIRED', MFA_REQUIRED: 'MFA_REQUIRED',
    SESSION_EXPIRED: 'SESSION_EXPIRED', SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
    SESSION_REVOKED: 'SESSION_REVOKED', UNAVAILABLE: 'STEP_UP_UNAVAILABLE', ERROR: 'STEP_UP_ERROR'
});

// ─── Helpers ─────────────────────────────────────────────────────
function sendOk(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function sendErr(res, err, ctx) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'ORDERS_ERROR';
    const message = status >= 500 ? (SAFE_500[code] || 'Something went wrong. Please try again.') : (err?.message || SAFE_500[code] || 'Request failed.');
    if (status >= 500) {
        console.error('[ADMIN ORDERS]', JSON.stringify({
            ts: new Date().toISOString(),
            requestId: ctx?.requestId || null,
            code, status,
            adminId: ctx?.adminId || null,
            raw_message: String(err?.message || '').slice(0, 500)
        }));
    }
    const body = { success: false, code, error: message, requestId: ctx?.requestId || null };
    if (err?.allowed_transitions) body.allowed_transitions = err.allowed_transitions;
    if (err?.current_status) body.current_status = err.current_status;
    if (err?.migration) body.migration = err.migration;
    if (err?.remaining_amount != null) body.remaining_amount = err.remaining_amount;
    res.status(status).json(body);
}
function ctxOf(req) {
    return {
        adminId: req.adminContext?.id || null,
        adminEmail: req.adminContext?.email || null,
        adminRole: req.adminContext?.role || null,
        sessionId: req.adminContext?.sessionId || null,
        correlationId: req.adminContext?.correlationId || null,
        ip: getClientIp(req) || null,
        userAgent: (req.headers['user-agent'] || '').slice(0, 400) || null,
        requestId: req.requestId || null,
        idempotencyKey: req.idempotencyKey || null
    };
}
function can(ctx, permission) {
    if (!ctx) return false;
    if (ctx.isSuperAdmin) return true;
    if (!Array.isArray(ctx.permissions)) return false;
    if (ctx.permissions.includes('*')) return true;
    return ctx.permissions.includes(permission);
}

// ─── Validation ──────────────────────────────────────────────────
function strOnly(v, maxLen = 500) { if (typeof v !== 'string') return null; const s = v.trim(); if (!s) return null; return s.slice(0, maxLen); }
function intOrNull(v, { min = 1, max = 1_000_000 } = {}) { const s = strOnly(v, 20); if (!s) return null; const n = parseInt(s, 10); return Number.isFinite(n) && n >= min && n <= max ? n : null; }
function uuidOrNull(v) { const s = strOnly(v, 64); return s && UUID_RE.test(s) ? s : null; }
function isoDateOrNull(v) { const s = strOnly(v, 40); if (!s) return null; if (ISO_DATE_RE.test(s)) return s; const d = new Date(s); return isNaN(d.getTime()) ? null : s; }
function parseReason(v, { required = true } = {}) {
    const s = String(v || '').trim();
    if (!required && !s) return null;
    if (s.length < REASON_MIN) { const e = new Error('A reason is required (min 4 characters).'); e.code = 'REASON_REQUIRED'; e.status = 422; throw e; }
    if (s.length > REASON_MAX) { const e = new Error('Reason must be 500 chars or fewer.'); e.code = 'INVALID_QUERY'; e.status = 422; throw e; }
    return s;
}
function parseNote(v) {
    const s = String(v || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    if (s.length < 2) { const e = new Error('Note text is required.'); e.code = 'NOTE_REQUIRED'; e.status = 422; throw e; }
    if (s.length > NOTE_MAX) { const e = new Error('Note is too long.'); e.code = 'NOTE_REQUIRED'; e.status = 422; throw e; }
    return s;
}
function parseAmount(v) {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s)) { const e = new Error('Amount must be a number with at most 2 decimals.'); e.code = 'INVALID_AMOUNT'; e.status = 422; throw e; }
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) { const e = new Error('Amount must be positive.'); e.code = 'INVALID_AMOUNT'; e.status = 422; throw e; }
    return s;
}
function requireIdemKey(req) {
    const raw = req.headers['idempotency-key'];
    if (!raw || typeof raw !== 'string') { const e = new Error('Idempotency-Key (8-200 chars) required.'); e.code = 'IDEMPOTENCY_KEY_REQUIRED'; e.status = 422; throw e; }
    const s = raw.trim();
    if (!IDEM_KEY_RE.test(s)) { const e = new Error('Idempotency-Key must be 8-200 chars of A-Z a-z 0-9 . _ : -'); e.code = 'INVALID_IDEMPOTENCY_KEY'; e.status = 422; throw e; }
    return s;
}

// ─── Middleware ──────────────────────────────────────────────────
function attachRequestId(req, res, next) {
    const provided = strOnly(req.headers['x-request-id'], 80);
    req.requestId = (provided && (UUID_RE.test(provided) || /^[A-Za-z0-9_\-]{8,80}$/.test(provided))) ? provided : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}
function adminResponseHeaders(req, res, next) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Authorization');
    next();
}
// Every middleware carries a path (['/orders']) so sibling /api/admin/*
// mounts are never affected.
router.use(['/orders'], adminResponseHeaders);
router.use(['/orders'], attachRequestId);

// ─── Rate limiter (per admin, per route family) ─────────────────
const RATE_BUCKETS = new Map();
const RATE_LIMITS = {
    read:      { max: 240, windowMs: 60_000 },
    write:     { max: 60,  windowMs: 60_000 },
    sensitive: { max: 10,  windowMs: 60_000 },
    export:    { max: 3,   windowMs: 60_000 }
};
function rateLimit(name) {
    const cfg = RATE_LIMITS[name] || RATE_LIMITS.read;
    return (req, res, next) => {
        const subject = req.adminContext?.id || getClientIp(req) || 'unknown';
        const key = `${name}:${subject}`;
        const now = Date.now();
        let bucket = RATE_BUCKETS.get(key);
        if (!bucket || now >= bucket.resetAt) { bucket = { count: 1, resetAt: now + cfg.windowMs }; RATE_BUCKETS.set(key, bucket); return next(); }
        if (bucket.count >= cfg.max) {
            const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
            res.setHeader('Retry-After', String(retryAfter));
            return res.status(429).json({ success: false, code: 'RATE_LIMITED', error: SAFE_500.RATE_LIMITED, retry_after_seconds: retryAfter, requestId: req.requestId || null });
        }
        bucket.count++;
        next();
    };
}
const _rateCleanup = setInterval(() => {
    try { const now = Date.now(); for (const [k, b] of RATE_BUCKETS) if (now >= b.resetAt) RATE_BUCKETS.delete(k); }
    catch (e) { console.warn('[ADMIN ORDERS] rate-bucket cleanup error:', e && e.message); }
}, 60_000);
if (_rateCleanup && typeof _rateCleanup.unref === 'function') _rateCleanup.unref();

// ─── Step-up helper — NEVER inside a Promise. It must respond or call next(). ───
function maybeStepUp(req, res) {
    // Returns a Promise that resolves on success, rejects with an error
    // that the caller must forward to sendErr. On failure, the middleware
    // writes the response itself — the caller detects res.headersSent and
    // returns without writing a second response.
    return new Promise((resolve, reject) => {
        const mw = requireStepUpAuth({ maxAgeSeconds: 300 });
        mw(req, res, (err) => {
            if (res.headersSent) return resolve(); // middleware responded — treat as handled
            if (err) return reject(err);
            resolve();
        });
    });
}

// ═════════════════════════════════════════════════════════════════
//  LITERAL ROUTES (before /:id)
// ═════════════════════════════════════════════════════════════════

router.get('/orders/filters', requirePermission(PERMISSIONS.ORDERS_READ), rateLimit('read'), async (req, res) => {
    const ctx = ctxOf(req);
    try {
        const providers = [];
        try {
            for (const name of providerFactory.list()) {
                const meta = providerMetadata.getMetadata(name) || {};
                if (meta.enabled === false) continue;
                providers.push({ value: name, label: (providerFactory.get(name)?.label) || meta.label || name });
            }
        } catch (_) { /* ignore */ }
        const product_types = ['airtime','data','electricity','tv','esim','virtual_sms','gift_card','boost','crypto','marketplace'];
        const statuses = Array.from(ordersService.ORDER_STATUSES || []);
        const payment_statuses = Array.from(ordersService.PAYMENT_STATUSES || []);
        sendOk(res, { data: { providers, product_types, statuses, payment_statuses, currencies: ['NGN', 'USD'] } });
    } catch (err) { sendErr(res, err, ctx); }
});

router.get('/orders/attention', requirePermission(PERMISSIONS.ORDERS_READ), rateLimit('read'), async (req, res) => {
    const ctx = ctxOf(req);
    try { sendOk(res, { data: await ordersService.getAttentionCounts() }); }
    catch (err) { sendErr(res, err, ctx); }
});

router.get('/orders/stats', requirePermission(PERMISSIONS.ORDERS_READ), rateLimit('read'), async (req, res) => {
    const ctx = ctxOf(req);
    try {
        const filters = {
            from: isoDateOrNull(req.query.from), to: isoDateOrNull(req.query.to),
            status: strOnly(req.query.status, 40), payment_status: strOnly(req.query.payment_status, 40),
            product_type: strOnly(req.query.product_type, 40), provider: strOnly(req.query.provider, 40),
            currency: strOnly(req.query.currency, 8), search: strOnly(req.query.search, SEARCH_MAX_LEN),
            failed_only: req.query.failed_only === 'true', provider_failed: req.query.provider_failed === 'true',
            webhook_failed: req.query.webhook_failed === 'true', manual_review: req.query.manual_review === 'true'
        };
        const stats = await ordersService.getStats(filters);
        sendOk(res, { data: { stats } });
    } catch (err) { sendErr(res, err, ctx); }
});

router.get('/orders/export', requirePermission(PERMISSIONS.REPORTS_EXPORT), rateLimit('export'), async (req, res) => {
    const ctx = ctxOf(req);
    try {
        const filters = {
            from: isoDateOrNull(req.query.from), to: isoDateOrNull(req.query.to),
            status: strOnly(req.query.status, 40), payment_status: strOnly(req.query.payment_status, 40),
            product_type: strOnly(req.query.product_type, 40), provider: strOnly(req.query.provider, 40),
            currency: strOnly(req.query.currency, 8), search: strOnly(req.query.search, SEARCH_MAX_LEN),
            failed_only: req.query.failed_only === 'true', provider_failed: req.query.provider_failed === 'true',
            webhook_failed: req.query.webhook_failed === 'true', manual_review: req.query.manual_review === 'true',
            sort: SORTABLE.has(strOnly(req.query.sort)) ? strOnly(req.query.sort) : null,
            order: strOnly(req.query.order, 8)
        };
        const result = await ordersService.buildOrdersCsv({ filters, maxRows: EXPORT_MAX_ROWS, ctx });

        // Audit BEFORE streaming.
        const auditReason = `Exported ${result.row_count} row(s); filters ${JSON.stringify(filters)}`.slice(0, 500);
        const { error: auditErr } = await supabaseAdmin.from('admin_audit_logs').insert({
            admin_id: ctx.adminId, admin_email: ctx.adminEmail,
            action: 'order.export', target_type: 'order_export', target_id: null,
            reason: auditReason, ip_address: ctx.ip, user_agent: ctx.userAgent,
            request_id: ctx.requestId, created_at: new Date().toISOString()
        });
        if (auditErr) { return sendErr(res, Object.assign(new Error('audit failed'), { code: 'EXPORT_AUDIT_FAILED', status: 500 }), ctx); }

        const watDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const filename = `orders_${watDate}_${Date.now()}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('X-Export-Row-Count', String(result.row_count));
        if (result.truncated) res.setHeader('X-Export-Truncated', 'true');
        res.setHeader('X-Export-Timezone', result.timezone);
        res.send(result.csv);
    } catch (err) { sendErr(res, err, ctx); }
});

router.post('/orders/sync-pending', requirePermission(PERMISSIONS.ORDERS_RESOLVE), rateLimit('write'), async (req, res) => {
    const ctx = ctxOf(req);
    try {
        const reason = parseReason(req.body?.reason, { required: false }) || 'Bulk sync from admin orders page';
        const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
        const result = await ordersService.syncPending({ limit, reason, source: 'admin_bulk_sync', actorType: 'admin', ctx });
        sendOk(res, { data: result });
    } catch (err) { sendErr(res, err, ctx); }
});

// ═════════════════════════════════════════════════════════════════
//  LIST
// ═════════════════════════════════════════════════════════════════
router.get('/orders', requirePermission(PERMISSIONS.ORDERS_READ), rateLimit('read'), async (req, res) => {
    const ctx = ctxOf(req);
    try {
        const page = intOrNull(req.query.page, { min: 1, max: 100000 }) || 1;
        const limit = intOrNull(req.query.limit, { min: 1, max: LIST_MAX_LIMIT }) || 25;
        const sort = SORTABLE.has(strOnly(req.query.sort)) ? strOnly(req.query.sort) : null;
        const order = strOnly(req.query.order, 8) === 'asc' ? 'asc' : 'desc';
        const status = strOnly(req.query.status, 40);
        const payment_status = strOnly(req.query.payment_status, 40);
        if (payment_status && payment_status !== 'all' && !PAYMENT_STATUSES.has(payment_status.toLowerCase())) {
            throw Object.assign(new Error('Invalid payment_status.'), { code: 'INVALID_QUERY', status: 400 });
        }
        const result = await ordersService.listOrders({
            page, limit, sort, order, status,
            payment_status, provider: strOnly(req.query.provider, 40),
            product_type: strOnly(req.query.product_type, 40),
            currency: strOnly(req.query.currency, 8),
            user_id: uuidOrNull(req.query.user_id),
            from: isoDateOrNull(req.query.from), to: isoDateOrNull(req.query.to),
            search: strOnly(req.query.search, SEARCH_MAX_LEN),
            failed_only: req.query.failed_only === 'true', provider_failed: req.query.provider_failed === 'true',
            webhook_failed: req.query.webhook_failed === 'true', manual_review: req.query.manual_review === 'true'
        });
        sendOk(res, result);
    } catch (err) { sendErr(res, err, ctx); }
});

// ═════════════════════════════════════════════════════════════════
//  PARAM ROUTES
// ═════════════════════════════════════════════════════════════════
router.get('/orders/:orderId', requirePermission(PERMISSIONS.ORDERS_READ), rateLimit('read'), async (req, res, next) => {
    if (!INT_RE.test(String(req.params.orderId || ''))) return next();
    const ctx = ctxOf(req);
    try {
        const detail = await ordersService.getOrder(req.params.orderId, { permissions: req.adminContext?.permissions || [] });
        sendOk(res, detail);
    } catch (err) { sendErr(res, err, ctx); }
});

router.get('/orders/:orderId/timeline', requirePermission(PERMISSIONS.ORDERS_READ), rateLimit('read'), async (req, res, next) => {
    if (!INT_RE.test(String(req.params.orderId || ''))) return next();
    const ctx = ctxOf(req);
    try { sendOk(res, { events: await ordersService.getTimeline(req.params.orderId) }); }
    catch (err) { sendErr(res, err, ctx); }
});

router.get('/orders/:orderId/webhooks', requirePermission(PERMISSIONS.ORDERS_READ), rateLimit('read'), async (req, res, next) => {
    if (!INT_RE.test(String(req.params.orderId || ''))) return next();
    const ctx = ctxOf(req);
    try { sendOk(res, { webhooks: await ordersService.getWebhooks(req.params.orderId) }); }
    catch (err) { sendErr(res, err, ctx); }
});

router.get('/orders/:orderId/provider-status', requirePermission(PERMISSIONS.ORDERS_READ), rateLimit('read'), async (req, res, next) => {
    if (!INT_RE.test(String(req.params.orderId || ''))) return next();
    const ctx = ctxOf(req);
    try {
        const detail = await ordersService.getOrder(req.params.orderId, { permissions: req.adminContext?.permissions || [] });
        const order = detail.order;
        const adapter = providerFactory.get(String(order.provider || '').toLowerCase());
        if (!adapter || typeof adapter.getOrderStatus !== 'function') {
            return sendOk(res, { data: { provider_supported: false, local_status: order.status, provider: order.provider, reason: 'PROVIDER_DOES_NOT_SUPPORT_STATUS' } });
        }
        const providerState = await Promise.race([
            Promise.resolve().then(() => adapter.getOrderStatus(order)),
            new Promise((_, rej) => setTimeout(() => { const e = new Error('Provider timed out.'); e.code = 'PROVIDER_TIMEOUT'; e.status = 504; rej(e); }, 8000))
        ]);
        sendOk(res, { data: {
            provider_supported: true, local_status: order.status,
            provider_status: providerState?.status || null,
            provider_order_id: order.provider_order_id,
            last_checked: new Date().toISOString()
        }});
    } catch (err) { sendErr(res, err, ctx); }
});

// ─── Sync single ─────────────────────────────────────────────────
router.post('/orders/:orderId/sync', requirePermission(PERMISSIONS.ORDERS_RESOLVE), rateLimit('write'), async (req, res, next) => {
    if (!INT_RE.test(String(req.params.orderId || ''))) return next();
    const ctx = ctxOf(req);
    try {
        const reason = parseReason(req.body?.reason);
        const detail = await ordersService.getOrder(req.params.orderId, { permissions: req.adminContext?.permissions || [] });
        const order = detail.order;
        const adapter = providerFactory.get(String(order.provider || '').toLowerCase());
        if (!adapter || typeof adapter.getOrderStatus !== 'function') {
            const e = new Error('Provider does not support status lookup.'); e.code = 'PROVIDER_NOT_SUPPORTED'; e.status = 400; throw e;
        }
        const providerState = await Promise.race([
            Promise.resolve().then(() => adapter.getOrderStatus(order)),
            new Promise((_, rej) => setTimeout(() => { const e = new Error('Provider timed out.'); e.code = 'PROVIDER_TIMEOUT'; e.status = 504; rej(e); }, 8000))
        ]);
        const result = await ordersService.processProviderUpdate({
            order, providerStatus: providerState?.status || null, providerResponse: providerState?.raw || null,
            source: 'admin_sync', actorType: 'admin', actorId: req.adminContext.id, ctx
        });
        sendOk(res, { data: { updated: !!result.updated, status: result.status }, reason });
    } catch (err) { sendErr(res, err, ctx); }
});

// ─── Status change (step-up only for status='completed') ────────
router.put('/orders/:orderId/status', requirePermission(PERMISSIONS.ORDERS_RESOLVE), rateLimit('write'), async (req, res, next) => {
    if (!INT_RE.test(String(req.params.orderId || ''))) return next();
    const ctx = ctxOf(req);
    try {
        req.idempotencyKey = requireIdemKey(req);
        const status = String(req.body?.status || '').toLowerCase();
        if (!ordersService.ORDER_STATUSES.has(status)) { const e = new Error('Invalid status.'); e.code = 'INVALID_STATUS'; e.status = 422; throw e; }
        const note = parseReason(req.body?.note);

        // Peek current status to decide step-up
        const detail = await ordersService.getOrder(req.params.orderId, { permissions: req.adminContext?.permissions || [] });
        const current = String(detail.order.status || '').toLowerCase();
        const needsStepUp = status === 'completed';
        if (needsStepUp) {
            await maybeStepUp(req, res);
            if (res.headersSent) return;
        }

        const result = await ordersService.updateOrderStatus({ orderId: req.params.orderId, status, note, ctx: ctxOf(req) });
        sendOk(res, { data: result });
    } catch (err) { sendErr(res, err, ctx); }
});

// ─── Refund (step-up always) ────────────────────────────────────
router.post('/orders/:orderId/refund', requirePermission(PERMISSIONS.TRANSACTIONS_REFUND), rateLimit('sensitive'), async (req, res, next) => {
    if (!INT_RE.test(String(req.params.orderId || ''))) return next();
    const ctx = ctxOf(req);
    try {
        req.idempotencyKey = requireIdemKey(req);
        const reason = parseReason(req.body?.reason);
        const amount = parseAmount(req.body?.amount);

        // Peek remaining to reject obvious over-refunds before step-up
        const detail = await ordersService.getOrder(req.params.orderId, { permissions: req.adminContext?.permissions || [] });
        const remaining = Number(detail.order.refundable_remaining || 0);
        if (amount != null && Number(amount) > remaining + 1e-9) {
            const e = new Error('Refund amount exceeds the refundable balance.'); e.code = 'REFUND_EXCEEDS_ORDER'; e.status = 422; e.remaining_amount = remaining; throw e;
        }

        await maybeStepUp(req, res);
        if (res.headersSent) return;

        const result = await ordersService.refundOrder({
            orderId: req.params.orderId, reason,
            forceAmount: amount != null ? Number(amount) : null,
            ctx: ctxOf(req)
        });
        sendOk(res, { data: result });
    } catch (err) { sendErr(res, err, ctx); }
});

// ─── Retry / re-queue (step-up always) ──────────────────────────
router.post('/orders/:orderId/retry', requirePermission(PERMISSIONS.ORDERS_RESOLVE), rateLimit('sensitive'), async (req, res, next) => {
    if (!INT_RE.test(String(req.params.orderId || ''))) return next();
    const ctx = ctxOf(req);
    try {
        req.idempotencyKey = requireIdemKey(req);
        const reason = parseReason(req.body?.reason);
        await maybeStepUp(req, res);
        if (res.headersSent) return;
        const result = await ordersService.retryOrder({ orderId: req.params.orderId, reason, ctx: ctxOf(req) });
        sendOk(res, { data: result });
    } catch (err) { sendErr(res, err, ctx); }
});

// ─── Cancel (step-up only if status is paid|processing|in_progress) ───
router.post('/orders/:orderId/cancel', requirePermission(PERMISSIONS.ORDERS_RESOLVE), rateLimit('write'), async (req, res, next) => {
    if (!INT_RE.test(String(req.params.orderId || ''))) return next();
    const ctx = ctxOf(req);
    try {
        req.idempotencyKey = requireIdemKey(req);
        const reason = parseReason(req.body?.reason);
        const detail = await ordersService.getOrder(req.params.orderId, { permissions: req.adminContext?.permissions || [] });
        const current = String(detail.order.status || '').toLowerCase();
        const needsStepUp = ['paid', 'processing', 'in_progress'].includes(current);
        if (needsStepUp) {
            await maybeStepUp(req, res);
            if (res.headersSent) return;
        }
        const result = await ordersService.cancelOrder({ orderId: req.params.orderId, reason, ctx: ctxOf(req) });
        sendOk(res, { data: result });
    } catch (err) { sendErr(res, err, ctx); }
});

// ─── Note (no step-up) ──────────────────────────────────────────
router.post('/orders/:orderId/note', requirePermission(PERMISSIONS.ORDERS_RESOLVE), rateLimit('write'), async (req, res, next) => {
    if (!INT_RE.test(String(req.params.orderId || ''))) return next();
    const ctx = ctxOf(req);
    try {
        req.idempotencyKey = requireIdemKey(req);
        const note = parseNote(req.body?.note);
        const result = await ordersService.addNote({ orderId: req.params.orderId, note, ctx: ctxOf(req) });
        sendOk(res, { data: result });
    } catch (err) { sendErr(res, err, ctx); }
});

// ═════════════════════════════════════════════════════════════════
//  SCOPED 404 — only for this router's prefixes
// ═════════════════════════════════════════════════════════════════
router.use(['/orders'], (req, res) => {
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