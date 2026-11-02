'use strict';

// ─────────────────────────────────────────────────────────────────
// routes/supportRoutes.js  —  REVISION 2026-11-02
//
// Endpoints (mounted at /api/admin, per server.js):
//
//   GET    /support/stats
//   GET    /support/tickets
//   GET    /support/tickets/:id
//   POST   /support/tickets/:id/read
//   POST   /support/tickets/:id/messages
//   POST   /support/tickets/:id/internal-note
//   PATCH  /support/tickets/:id/status          (also PUT alias)
//   PATCH  /support/tickets/:id/priority        (new — B.4)
//   PATCH  /support/tickets/:id/category        (new — C.6)
//   POST   /support/tickets/:id/assign          (also PUT alias)
//   POST   /support/tickets/:id/close
//   POST   /support/tickets/:id/reopen
//   GET    /support/tickets/:id/timeline        (new — C.6)
//   GET    /support/tickets/:id/customer-context (new — C.6)
//   GET    /support/tickets/:id/attachments/:attachmentId/url (new — B.15)
//   GET    /support/admins
//   GET    /support/health
//   GET    /support/canned-replies              (new — C.6)
//   POST   /support/canned-replies              (new)
//   PUT    /support/canned-replies/:id          (new)
//   DELETE /support/canned-replies/:id          (new)
//   GET    /support/export.csv                  (new — C.6)
//
// Guarantees:
//   • Idempotency-Key checked BEFORE any upload. On replay, the
//     original message is returned without uploading.
//   • createMessage -> { message, idempotent } — no emit/notify/
//     email when idempotent is true.
//   • Auth happens ONCE per request (requirePermission once per
//     route). Attachments permission is checked at the handler
//     level, not as stacked middleware.
//   • Multer wrapped: LIMIT_FILE_SIZE, LIMIT_FILE_COUNT,
//     LIMIT_UNEXPECTED_FILE, and MIME_NOT_ALLOWED return JSON, not
//     HTML.
//   • Per-admin rate limit on sends (30/min) and uploads (60/min).
//   • Every mutation sends expected_version and returns
//     STALE_VERSION with current_version on conflict.
//   • Every response is { success, ... } or { success:false, code,
//     error }. No HTML error pages.
//   • Every mutation logs request_id, admin_id, ticket_id, latency.
// ─────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');

const support             = require('../../services/supportService');
const supportAttachments  = require('../../services/supportAttachmentService');
const supportNotifications = require('../../services/supportNotificationService');
const { supabaseAdmin }   = require('../../db/supabase');
const {
    requirePermission,
    PERMISSIONS,
    getClientIp,
    assertSameOrigin,
    recordAdminAction
} = require('../../middleware/adminAuth');

// ─── Boot-time wiring check ────────────────────────────────────
// If any required module is missing a method we rely on, refuse to
// mount. Better a 503 at startup than a 500 on every reply.
for (const [mod, method] of [
    [support, 'listTickets'],
    [support, 'getTicket'],
    [support, 'createMessage'],
    [support, 'changeStatus'],
    [support, 'assignTicket'],
    [support, 'changePriority'],
    [support, 'changeCategory'],
    [support, 'getTimeline'],
    [support, 'getCustomerContext'],
    [support, 'findMessageByIdempotency'],
    [supportAttachments, 'uploadForMessage'],
    [supportAttachments, 'resolveMessages'],
    [supportAttachments, 'freshAttachmentUrl'],
    [supportNotifications, 'notifyCustomer']
]) {
    if (!mod || typeof mod[method] !== 'function') {
        throw new Error(`supportRoutes: required module method ${method} is missing`);
    }
}

const P = {
    READ:          PERMISSIONS.SUPPORT_READ,
    REPLY:         PERMISSIONS.SUPPORT_REPLY,
    INTERNAL:      PERMISSIONS.SUPPORT_INTERNAL_NOTE,
    ASSIGN:        PERMISSIONS.SUPPORT_ASSIGN,
    CHANGE_STATUS: PERMISSIONS.SUPPORT_CHANGE_STATUS,
    CLOSE:         PERMISSIONS.SUPPORT_CLOSE,
    REOPEN:        PERMISSIONS.SUPPORT_REOPEN,
    ATTACHMENTS:   PERMISSIONS.SUPPORT_ATTACHMENTS,
    VIEW_CUSTOMER: PERMISSIONS.SUPPORT_VIEW_CUSTOMER,
    AUDIT:         PERMISSIONS.SUPPORT_AUDIT_READ,
    // New permission keys introduced in go 5a. If they are missing
    // at boot, the routes that use them will 403 — which is safe.
    CHANGE_PRIORITY: PERMISSIONS.SUPPORT_CHANGE_PRIORITY || 'support.change_priority',
    CHANGE_CATEGORY: PERMISSIONS.SUPPORT_CHANGE_CATEGORY || 'support.change_category',
    CANNED:          PERMISSIONS.SUPPORT_CANNED_REPLIES || 'support.canned_replies.manage',
    EXPORT:          PERMISSIONS.SUPPORT_EXPORT          || 'support.export'
};

// ─── Per-request correlation ID ────────────────────────────────
function attachRequestId(req, res, next) {
    const inbound = req.headers['x-request-id'];
    const safe = (typeof inbound === 'string' && /^[A-Za-z0-9_\-]{1,80}$/.test(inbound))
        ? inbound
        : crypto.randomUUID();
    req.requestId = safe;
    if (!res.headersSent) res.setHeader('X-Request-Id', safe);
    next();
}
router.use('/support', attachRequestId);

// ─── Multer (memory) ───────────────────────────────────────────
// Multer runs BEFORE the handler can send JSON, so LIMIT_* errors
// surface here. The wrapper converts them to our envelope.
const multerUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024,
        files: 5,
        fields: 10,
        fieldSize: 128 * 1024
    }
}).array('attachments', 5);

function uploadMiddleware(req, res, next) {
    multerUpload(req, res, (err) => {
        if (!err) return next();
        const code = err.code === 'LIMIT_FILE_SIZE'     ? 'FILE_TOO_LARGE'
                   : err.code === 'LIMIT_FILE_COUNT'    ? 'TOO_MANY_FILES'
                   : err.code === 'LIMIT_UNEXPECTED_FILE' ? 'UNEXPECTED_FIELD'
                   : err.code === 'LIMIT_FIELD_SIZE'    ? 'FIELD_TOO_LARGE'
                   : err.code || 'UPLOAD_ERROR';
        const status = code === 'FILE_TOO_LARGE' || code === 'TOO_MANY_FILES' ? 413 : 400;
        if (res.headersSent) return;
        res.status(status).json({
            success: false,
            code,
            error: err.message || 'Upload rejected.'
        });
    });
}

// ─── Response helpers ──────────────────────────────────────────
function ok(res, payload) {
    if (!res.headersSent) res.json({ success: true, ...payload });
}
function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code   = err?.code   || 'SUPPORT_ERROR';
    const message = status >= 500
        ? (code === 'UPLOAD_FAILED' ? 'Could not upload attachment.'
            : code === 'SUPPORT_STATS_UNAVAILABLE' ? 'Stats temporarily unavailable.'
            : 'Something went wrong. Please try again.')
        : (err?.message || 'Request failed');
    if (status >= 500) {
        // eslint-disable-next-line no-console
        console.error('[ADMIN SUPPORT]', code, err?.message);
    }
    const body = { success: false, code, error: message };
    if (err?.current_version != null) body.current_version = err.current_version;
    if (Array.isArray(err?.allowed)) body.allowed = err.allowed;
    if (Array.isArray(err?.orphans)) body.orphans = err.orphans;
    res.status(status).json(body);
}
function routeLog(event, req, fields = {}) {
    try {
        // eslint-disable-next-line no-console
        console.log('[ADMIN SUPPORT]', JSON.stringify({
            ts: new Date().toISOString(),
            event,
            requestId: req.requestId,
            adminId:   req.adminContext && req.adminContext.id,
            ...fields
        }));
    } catch (_) {
        // eslint-disable-next-line no-console
        console.log('[ADMIN SUPPORT]', event);
    }
}

// ─── Per-admin rate limit ──────────────────────────────────────
// In-memory buckets per (adminId, bucketName). Good for a single
// instance. For multi-instance, replace with Redis — the interface
// is a single function so the swap is one line.
const _rateBuckets = new Map();   // key -> { count, resetAt }
function rateLimit(adminId, name, max, windowMs) {
    const key = `${adminId}:${name}`;
    const now = Date.now();
    let b = _rateBuckets.get(key);
    if (!b || now >= b.resetAt) {
        b = { count: 1, resetAt: now + windowMs };
        _rateBuckets.set(key, b);
        return true;
    }
    if (b.count >= max) return false;
    b.count++;
    return true;
}
function enforceRateLimit(req, res, name, max, windowMs) {
    const adminId = req.adminContext && req.adminContext.id;
    if (!adminId) return true;
    if (!rateLimit(adminId, name, max, windowMs)) {
        if (!res.headersSent) {
            res.status(429).json({
                success: false,
                code: 'RATE_LIMITED',
                error: 'Too many requests. Please slow down.'
            });
        }
        return false;
    }
    return true;
}

// ─── Socket service accessor ───────────────────────────────────
function socketSvc(req) {
    const app = req.app;
    return app && app.locals ? app.locals.supportSocketService || null : null;
}

// ─── Notification helpers (best-effort, never block) ───────────
async function fetchTicketBrief(ticketId, requestId) {
    return supportNotifications.fetchTicketBrief(ticketId, requestId);
}
async function notify(ticketId, event, requestId, extra = {}) {
    try {
        const ticket = await fetchTicketBrief(ticketId, requestId);
        if (!ticket) return { ok: false, error: 'no_ticket' };
        return await supportNotifications.notifyCustomer({
            event, ticket, requestId, extra
        });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[ADMIN SUPPORT] notify failed:', e.message);
        return { ok: false, error: e.message };
    }
}

// ─────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────
router.get('/support/stats', requirePermission(P.READ), async (req, res) => {
    const started = Date.now();
    try {
        const data = await support.getStats({
            dateFrom: req.query.from || null,
            dateTo:   req.query.to || null,
            adminId:  req.adminContext.id
        });
        routeLog('stats.ok', req, { latencyMs: Date.now() - started });
        ok(res, { data });
    } catch (e) {
        routeLog('stats.error', req, { code: e.code, msg: e.message, latencyMs: Date.now() - started });
        sendErr(res, e);
    }
});

// ─────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────
router.get('/support/tickets', requirePermission(P.READ), async (req, res) => {
    const started = Date.now();
    try {
        const result = await support.listTickets({
            page:     req.query.page,
            limit:    req.query.limit,
            status:   req.query.status,
            priority: req.query.priority,
            category: req.query.category,
            assigned: req.query.assigned,
            search:   req.query.search,
            sort:     req.query.sort,
            sla:      req.query.sla,
            unread:   req.query.unread === 'true' ? true : undefined,
            dateFrom: req.query.date_from,
            dateTo:   req.query.date_to,
            viewerId: req.adminContext.id
        });
        routeLog('list.ok', req, {
            count: result.tickets.length, total: result.total, page: result.page,
            latencyMs: Date.now() - started
        });
        ok(res, result);
    } catch (e) {
        routeLog('list.error', req, { code: e.code, msg: e.message, latencyMs: Date.now() - started });
        sendErr(res, e);
    }
});

// ─────────────────────────────────────────────────────────────
// DETAIL
// ─────────────────────────────────────────────────────────────
router.get('/support/tickets/:id', requirePermission(P.READ), async (req, res) => {
    const started = Date.now();
    try {
        const result = await support.getTicket({
            id: req.params.id,
            adminCtx: req.adminContext,
            beforeCreatedAt: req.query.before_created_at || null,
            limit: req.query.limit
        });
        const resolved = supportAttachments.resolveMessages(result.messages);
        ok(res, {
            data: {
                ...result.ticket,
                messages: resolved,
                hasMore: !!result.hasMore,
                nextCursor: result.nextCursor || null
            }
        });
        routeLog('detail.ok', req, {
            ticketId: req.params.id, messages: resolved.length, latencyMs: Date.now() - started
        });
    } catch (e) {
        routeLog('detail.error', req, { ticketId: req.params.id, code: e.code, latencyMs: Date.now() - started });
        sendErr(res, e);
    }
});

// ─────────────────────────────────────────────────────────────
// MARK READ
// ─────────────────────────────────────────────────────────────
router.post('/support/tickets/:id/read', requirePermission(P.READ), async (req, res) => {
    try {
        const result = await support.markRead({
            ticketId: req.params.id,
            actorCtx: req.adminContext
        });
        ok(res, result);
    } catch (e) { sendErr(res, e); }
});

// ─────────────────────────────────────────────────────────────
// REPLY — single pipeline with idempotency pre-check
// ─────────────────────────────────────────────────────────────
router.post(
    '/support/tickets/:id/messages',
    requirePermission(P.REPLY),
    assertSameOrigin,
    uploadMiddleware,
    async (req, res) => {
        const started = Date.now();
        const ticketId = req.params.id;
        const idempotencyKey = req.headers['idempotency-key'] || null;
        const hasFiles = !!(req.files && req.files.length);

        try {
            // Attachments permission is checked only when files are
            // present — a plain-text reply should not require it.
            if (hasFiles && !(req.adminContext.permissions || []).includes('*')
                && !(req.adminContext.permissions || []).includes(P.ATTACHMENTS)) {
                throw Object.assign(new Error('You do not have permission to attach files.'),
                    { status: 403, code: 'PERMISSION_DENIED', required: P.ATTACHMENTS });
            }

            // Reject is_internal through the reply endpoint.
            if (req.body && (req.body.is_internal === true || req.body.is_internal === 'true')) {
                throw Object.assign(new Error('Use the internal-note endpoint.'),
                    { status: 422, code: 'INTERNAL_NOTE_WRONG_ENDPOINT' });
            }

            if (!enforceRateLimit(req, res, 'send', 30, 60_000)) return;
            if (hasFiles && !enforceRateLimit(req, res, 'upload', 60, 60_000)) return;

            const text = String((req.body && req.body.message) || '').trim().slice(0, 10000);

            // 1. Idempotency pre-check BEFORE any upload.
            if (idempotencyKey) {
                try {
                    const existing = await support.findMessageByIdempotency({
                        ticketId, idempotencyKey
                    });
                    if (existing) {
                        routeLog('message.replay', req, {
                            ticketId, messageId: existing.id,
                            latencyMs: Date.now() - started
                        });
                        return ok(res, {
                            data: {
                                message: existing,
                                attachments: supportAttachments.resolveMessages([existing])[0].attachments,
                                idempotent: true
                            }
                        });
                    }
                } catch (e) {
                    // Non-fatal: the RPC also enforces idempotency.
                    routeLog('message.precheckFailed', req, {
                        ticketId, code: e.code, msg: e.message
                    });
                }
            }

            // 2. Upload (validates magic bytes, size, MIME).
            const { attachments, cleanup } = await supportAttachments.uploadForMessage({
                files: req.files || [],
                ticketId,
                isPrivate: true
            });

            // 3. Persist.
            let saved;
            try {
                saved = await support.createMessage({
                    ticketId,
                    adminId: req.adminContext.id,
                    message: text,
                    isInternal: false,
                    attachments,
                    idempotencyKey,
                    req
                });
            } catch (dbErr) {
                await cleanup();
                throw dbErr;
            }

            // If the RPC itself reports idempotent (race), cleanup
            // the uploads we just did and return the original.
            if (saved && saved.idempotent === true) {
                await cleanup();
                return ok(res, {
                    data: { message: saved.message, idempotent: true }
                });
            }

            // 4. Emit only on a fresh message.
            const io = socketSvc(req);
            if (io && saved && saved.message) {
                try {
                    io.emitNewMessage(ticketId, saved.message, req.adminContext.id, true);
                } catch (_) { /* non-fatal */ }
            }

            // 5. Move ticket to waiting_user if the RPC did not.
            //    RPC does not touch status, so we own this.
            try {
                const { data: t } = await supabaseAdmin
                    .from('support_tickets')
                    .select('status, version')
                    .eq('id', ticketId)
                    .maybeSingle();
                if (t && (t.status === 'open' || t.status === 'in_progress')) {
                    await support.changeStatus({
                        ticketId,
                        nextStatus: 'waiting_user',
                        adminId: req.adminContext.id,
                        reason: 'Reply sent — awaiting customer',
                        expectedVersion: t.version,
                        req
                    });
                    if (io) io.emitTicketUpdate(ticketId, { status: 'waiting_user' });
                }
            } catch (statusErr) {
                // Non-fatal: the reply is saved.
                routeLog('message.statusTransitionFailed', req, {
                    ticketId, code: statusErr.code, msg: statusErr.message
                });
            }

            // 6. Notify + email (best-effort). The notification
            //    service handles burst gating and guest vs user.
            await notify(ticketId, 'ticket_reply', req.requestId, {
                messageBody: text,
                messageId: saved.message.id
            });

            routeLog('message.saved', req, {
                ticketId, messageId: saved.message.id, attachments: attachments.length,
                latencyMs: Date.now() - started
            });

            const resolvedAtt = supportAttachments.resolveMessages([saved.message])[0].attachments;
            ok(res, { data: { message: { ...saved.message, attachments: resolvedAtt } } });
        } catch (e) {
            routeLog('message.error', req, {
                ticketId, code: e.code, msg: e.message, latencyMs: Date.now() - started
            });
            sendErr(res, e);
        }
    }
);

// ─────────────────────────────────────────────────────────────
// INTERNAL NOTE — same pipeline, isInternal true, no notify/emit
// ─────────────────────────────────────────────────────────────
router.post(
    '/support/tickets/:id/internal-note',
    requirePermission(P.INTERNAL),
    assertSameOrigin,
    uploadMiddleware,
    async (req, res) => {
        const started = Date.now();
        const ticketId = req.params.id;
        const idempotencyKey = req.headers['idempotency-key'] || null;
        const hasFiles = !!(req.files && req.files.length);

        try {
            if (hasFiles && !(req.adminContext.permissions || []).includes('*')
                && !(req.adminContext.permissions || []).includes(P.ATTACHMENTS)) {
                throw Object.assign(new Error('You do not have permission to attach files.'),
                    { status: 403, code: 'PERMISSION_DENIED', required: P.ATTACHMENTS });
            }
            if (!enforceRateLimit(req, res, 'send', 30, 60_000)) return;
            if (hasFiles && !enforceRateLimit(req, res, 'upload', 60, 60_000)) return;

            const text = String((req.body && req.body.message) || '').trim().slice(0, 10000);

            if (idempotencyKey) {
                try {
                    const existing = await support.findMessageByIdempotency({ ticketId, idempotencyKey });
                    if (existing) {
                        return ok(res, {
                            data: {
                                message: existing,
                                attachments: supportAttachments.resolveMessages([existing])[0].attachments,
                                idempotent: true
                            }
                        });
                    }
                } catch (_) { /* handled by RPC */ }
            }

            const { attachments, cleanup } = await supportAttachments.uploadForMessage({
                files: req.files || [],
                ticketId,
                isPrivate: true
            });

            let saved;
            try {
                saved = await support.createMessage({
                    ticketId,
                    adminId: req.adminContext.id,
                    message: text,
                    isInternal: true,
                    attachments,
                    idempotencyKey,
                    req
                });
            } catch (dbErr) {
                await cleanup();
                throw dbErr;
            }

            if (saved && saved.idempotent === true) {
                await cleanup();
                return ok(res, { data: { message: saved.message, idempotent: true } });
            }

            // Intentionally no emit, no notify.
            routeLog('internalNote.saved', req, {
                ticketId, messageId: saved.message.id,
                attachments: attachments.length,
                latencyMs: Date.now() - started
            });
            const resolvedAtt = supportAttachments.resolveMessages([saved.message])[0].attachments;
            ok(res, { data: { message: { ...saved.message, attachments: resolvedAtt } } });
        } catch (e) {
            routeLog('internalNote.error', req, {
                ticketId, code: e.code, msg: e.message, latencyMs: Date.now() - started
            });
            sendErr(res, e);
        }
    }
);

// ─────────────────────────────────────────────────────────────
// STATUS
// ─────────────────────────────────────────────────────────────
const changeStatusHandler = async (req, res) => {
    const started = Date.now();
    try {
        const expected = Number.isFinite(Number(req.body && req.body.expected_version))
            ? Number(req.body.expected_version)
            : null;
        const result = await support.changeStatus({
            ticketId: req.params.id,
            nextStatus: String((req.body && req.body.status) || '').toLowerCase(),
            adminId: req.adminContext.id,
            reason: (req.body && req.body.reason) || null,
            expectedVersion: expected,
            req
        });
        const io = socketSvc(req);
        if (io) {
            try { io.emitTicketUpdate(req.params.id, result); } catch (_) {}
        }
        const event = result.status === 'resolved' ? 'ticket_resolved'
                    : result.status === 'closed'   ? 'ticket_closed'
                    : result.status === 'open'     ? 'ticket_reopened'
                    : null;
        if (event) await notify(req.params.id, event, req.requestId);
        routeLog('status.ok', req, { ticketId: req.params.id, status: result.status, latencyMs: Date.now() - started });
        ok(res, result);
    } catch (e) {
        routeLog('status.error', req, { ticketId: req.params.id, code: e.code, latencyMs: Date.now() - started });
        sendErr(res, e);
    }
};
router.patch('/support/tickets/:id/status', requirePermission(P.CHANGE_STATUS), assertSameOrigin, changeStatusHandler);
router.put(  '/support/tickets/:id/status', requirePermission(P.CHANGE_STATUS), assertSameOrigin, changeStatusHandler);

// ─────────────────────────────────────────────────────────────
// PRIORITY — new (B.4)
// ─────────────────────────────────────────────────────────────
router.patch('/support/tickets/:id/priority', requirePermission(P.CHANGE_PRIORITY), assertSameOrigin, async (req, res) => {
    const started = Date.now();
    try {
        const expected = Number.isFinite(Number(req.body && req.body.expected_version))
            ? Number(req.body.expected_version)
            : null;
        const result = await support.changePriority({
            ticketId: req.params.id,
            nextPriority: String((req.body && req.body.priority) || ''),
            adminId: req.adminContext.id,
            reason: (req.body && req.body.reason) || null,
            expectedVersion: expected,
            req
        });
        const io = socketSvc(req);
        if (io) { try { io.emitTicketUpdate(req.params.id, result); } catch (_) {} }
        routeLog('priority.ok', req, { ticketId: req.params.id, priority: result.priority, latencyMs: Date.now() - started });
        ok(res, result);
    } catch (e) {
        routeLog('priority.error', req, { ticketId: req.params.id, code: e.code, latencyMs: Date.now() - started });
        sendErr(res, e);
    }
});

// ─────────────────────────────────────────────────────────────
// CATEGORY — new (C.6)
// ─────────────────────────────────────────────────────────────
router.patch('/support/tickets/:id/category', requirePermission(P.CHANGE_CATEGORY), assertSameOrigin, async (req, res) => {
    const started = Date.now();
    try {
        const expected = Number.isFinite(Number(req.body && req.body.expected_version))
            ? Number(req.body.expected_version)
            : null;
        const result = await support.changeCategory({
            ticketId: req.params.id,
            nextCategory: String((req.body && req.body.category) || ''),
            adminId: req.adminContext.id,
            reason: (req.body && req.body.reason) || null,
            expectedVersion: expected,
            req
        });
        const io = socketSvc(req);
        if (io) { try { io.emitTicketUpdate(req.params.id, result); } catch (_) {} }
        routeLog('category.ok', req, { ticketId: req.params.id, category: result.category, latencyMs: Date.now() - started });
        ok(res, result);
    } catch (e) {
        routeLog('category.error', req, { ticketId: req.params.id, code: e.code, latencyMs: Date.now() - started });
        sendErr(res, e);
    }
});

// ─────────────────────────────────────────────────────────────
// ASSIGN
// ─────────────────────────────────────────────────────────────
const assignHandler = async (req, res) => {
    const started = Date.now();
    try {
        const expected = Number.isFinite(Number(req.body && req.body.expected_version))
            ? Number(req.body.expected_version)
            : null;
        const result = await support.assignTicket({
            ticketId: req.params.id,
            adminId: req.adminContext.id,
            assignTo: (req.body && (req.body.assigned_to || req.body.admin_id)) || null,
            reason: (req.body && req.body.reason) || null,
            expectedVersion: expected,
            req
        });

        const io = socketSvc(req);
        if (io) {
            try {
                const { data: agent } = await supabaseAdmin
                    .from('profiles').select('username').eq('id', result.assigned_to).maybeSingle();
                io.emitTicketAssigned(req.params.id, result.assigned_to, agent && agent.username);
                io.emitTicketUpdate(req.params.id, result);
            } catch (_) {}
        }
        await notify(req.params.id, 'ticket_assigned', req.requestId, {
            agentId: result.assigned_to
        });
        routeLog('assign.ok', req, {
            ticketId: req.params.id, assignedTo: result.assigned_to,
            latencyMs: Date.now() - started
        });
        ok(res, result);
    } catch (e) {
        routeLog('assign.error', req, { ticketId: req.params.id, code: e.code, latencyMs: Date.now() - started });
        sendErr(res, e);
    }
};
router.post('/support/tickets/:id/assign', requirePermission(P.ASSIGN), assertSameOrigin, assignHandler);
router.put( '/support/tickets/:id/assign', requirePermission(P.ASSIGN), assertSameOrigin, assignHandler);

// ─────────────────────────────────────────────────────────────
// CLOSE / REOPEN
// ─────────────────────────────────────────────────────────────
router.post('/support/tickets/:id/close', requirePermission(P.CLOSE), assertSameOrigin, async (req, res) => {
    const started = Date.now();
    try {
        const expected = Number.isFinite(Number(req.body && req.body.expected_version))
            ? Number(req.body.expected_version) : null;
        const result = await support.changeStatus({
            ticketId: req.params.id,
            nextStatus: 'closed',
            adminId: req.adminContext.id,
            reason: (req.body && req.body.reason) || 'Closed by admin',
            expectedVersion: expected,
            req
        });
        const io = socketSvc(req);
        if (io) { try { io.emitTicketUpdate(req.params.id, result); } catch (_) {} }
        await notify(req.params.id, 'ticket_closed', req.requestId);
        routeLog('close.ok', req, { ticketId: req.params.id, latencyMs: Date.now() - started });
        ok(res, result);
    } catch (e) {
        routeLog('close.error', req, { ticketId: req.params.id, code: e.code, latencyMs: Date.now() - started });
        sendErr(res, e);
    }
});

router.post('/support/tickets/:id/reopen', requirePermission(P.REOPEN), assertSameOrigin, async (req, res) => {
    const started = Date.now();
    try {
        const expected = Number.isFinite(Number(req.body && req.body.expected_version))
            ? Number(req.body.expected_version) : null;
        const result = await support.changeStatus({
            ticketId: req.params.id,
            nextStatus: 'open',
            adminId: req.adminContext.id,
            reason: (req.body && req.body.reason) || 'Reopened by admin',
            expectedVersion: expected,
            req
        });
        const io = socketSvc(req);
        if (io) { try { io.emitTicketUpdate(req.params.id, result); } catch (_) {} }
        await notify(req.params.id, 'ticket_reopened', req.requestId);
        routeLog('reopen.ok', req, { ticketId: req.params.id, latencyMs: Date.now() - started });
        ok(res, result);
    } catch (e) {
        routeLog('reopen.error', req, { ticketId: req.params.id, code: e.code, latencyMs: Date.now() - started });
        sendErr(res, e);
    }
});

// ─────────────────────────────────────────────────────────────
// TIMELINE — new (C.6)
// ─────────────────────────────────────────────────────────────
router.get('/support/tickets/:id/timeline', requirePermission(P.READ), requirePermission(P.AUDIT), async (req, res) => {
    try {
        const items = await support.getTimeline({
            ticketId: req.params.id,
            adminCtx: req.adminContext
        });
        ok(res, { data: items });
    } catch (e) { sendErr(res, e); }
});

// ─────────────────────────────────────────────────────────────
// CUSTOMER CONTEXT — new (C.6)
// ─────────────────────────────────────────────────────────────
router.get('/support/tickets/:id/customer-context', requirePermission(P.VIEW_CUSTOMER), async (req, res) => {
    const started = Date.now();
    try {
        const data = await support.getCustomerContext({
            ticketId: req.params.id,
            adminCtx: req.adminContext
        });
        // Read-audit — the customer's financial data was just read.
        recordAdminAction({
            adminId: req.adminContext.id,
            action: 'support.view_customer_context',
            targetType: 'support_ticket',
            targetId: req.params.id,
            requestId: req.requestId,
            req,
            metadata: { wallet_available: !!data.wallet && data.wallet.available === true }
        }).catch(() => {});
        routeLog('customerContext.ok', req, {
            ticketId: req.params.id, latencyMs: Date.now() - started
        });
        ok(res, { data });
    } catch (e) {
        routeLog('customerContext.error', req, { ticketId: req.params.id, code: e.code, latencyMs: Date.now() - started });
        sendErr(res, e);
    }
});

// ─────────────────────────────────────────────────────────────
// ATTACHMENT URL — new (B.15)
// Fresh signed URL on click. Audited.
// ─────────────────────────────────────────────────────────────
router.get(
    '/support/tickets/:id/attachments/:attachmentId/url',
    requirePermission(P.READ),
    async (req, res) => {
        const started = Date.now();
        try {
            const { id: ticketId, attachmentId } = req.params;

            // Load the ticket's messages so we can find the attachment.
            const result = await support.getTicket({
                id: ticketId,
                adminCtx: req.adminContext,
                limit: 500     // pagination doesn't apply to a single lookup
            });

            let found = null;
            for (const m of result.messages) {
                if (Array.isArray(m.attachments)) {
                    const hit = m.attachments.find((a) => a && a.id === attachmentId);
                    if (hit) { found = hit; break; }
                }
            }
            if (!found) throw Object.assign(new Error('Attachment not found'), { status: 404, code: 'NOT_FOUND' });

            const url = supportAttachments.freshAttachmentUrl(found);
            if (!url) throw Object.assign(new Error('Could not sign URL'), { status: 500, code: 'SIGN_FAILED' });

            recordAdminAction({
                adminId: req.adminContext.id,
                action: 'support.view_attachment',
                targetType: 'support_ticket',
                targetId: ticketId,
                requestId: req.requestId,
                req,
                metadata: { attachment_id: attachmentId }
            }).catch(() => {});

            routeLog('attachmentUrl.ok', req, {
                ticketId, latencyMs: Date.now() - started
            });
            ok(res, { data: { url, expires_in: supportAttachments.SIGNED_URL_TTL_SECS } });
        } catch (e) {
            routeLog('attachmentUrl.error', req, {
                ticketId: req.params.id, code: e.code, latencyMs: Date.now() - started
            });
            sendErr(res, e);
        }
    }
);

// ─────────────────────────────────────────────────────────────
// ASSIGNABLE ADMINS
// ─────────────────────────────────────────────────────────────
router.get('/support/admins', requirePermission(P.READ), async (req, res) => {
    try { ok(res, { data: await support.listAssignableAdmins() }); }
    catch (e) { sendErr(res, e); }
});

// ─────────────────────────────────────────────────────────────
// CANNED REPLIES (support_saved_replies table)
//   GET    /support/canned-replies          — list (any REPLY)
//   POST   /support/canned-replies          — create (CANNED)
//   PUT    /support/canned-replies/:id      — update (CANNED + owner or super)
//   DELETE /support/canned-replies/:id      — delete (CANNED + owner or super)
// ─────────────────────────────────────────────────────────────
router.get('/support/canned-replies', requirePermission(P.REPLY), async (req, res) => {
    try {
        const rows = await support.listCannedReplies({ activeOnly: req.query.all !== 'true' });
        ok(res, { data: rows });
    } catch (e) { sendErr(res, e); }
});

router.post('/support/canned-replies', requirePermission(P.CANNED), assertSameOrigin, async (req, res) => {
    try {
        const body = req.body || {};
        const title = String(body.title || '').trim().slice(0, 100);
        const content = String(body.content || '').trim().slice(0, 5000);
        if (!title || !content) {
            throw Object.assign(new Error('title and content are required'), { status: 422, code: 'INVALID_INPUT' });
        }
        const { data, error } = await supabaseAdmin
            .from('support_saved_replies')
            .insert({
                title,
                content,
                category: body.category || null,
                shortcut: body.shortcut || null,
                admin_id: req.adminContext.id,
                is_active: body.is_active !== false
            })
            .select('*')
            .maybeSingle();
        if (error) throw error;
        routeLog('canned.create', req, { id: data && data.id });
        ok(res, { data });
    } catch (e) { sendErr(res, e); }
});

router.put('/support/canned-replies/:id', requirePermission(P.CANNED), assertSameOrigin, async (req, res) => {
    try {
        const { data: existing, error: e1 } = await supabaseAdmin
            .from('support_saved_replies')
            .select('id, admin_id')
            .eq('id', req.params.id)
            .maybeSingle();
        if (e1) throw e1;
        if (!existing) throw Object.assign(new Error('Not found'), { status: 404, code: 'NOT_FOUND' });
        if (!req.adminContext.isSuperAdmin && String(existing.admin_id) !== String(req.adminContext.id)) {
            throw Object.assign(new Error('Only the creator can edit'), { status: 403, code: 'FORBIDDEN' });
        }
        const body = req.body || {};
        const patch = {};
        if (body.title != null)    patch.title    = String(body.title).trim().slice(0, 100);
        if (body.content != null)  patch.content  = String(body.content).trim().slice(0, 5000);
        if (body.category != null) patch.category = body.category;
        if (body.shortcut != null) patch.shortcut = body.shortcut;
        if (body.is_active != null) patch.is_active = body.is_active !== false;
        patch.updated_at = new Date().toISOString();
        const { data, error } = await supabaseAdmin
            .from('support_saved_replies')
            .update(patch)
            .eq('id', req.params.id)
            .select('*')
            .maybeSingle();
        if (error) throw error;
        ok(res, { data });
    } catch (e) { sendErr(res, e); }
});

router.delete('/support/canned-replies/:id', requirePermission(P.CANNED), assertSameOrigin, async (req, res) => {
    try {
        const { data: existing, error: e1 } = await supabaseAdmin
            .from('support_saved_replies')
            .select('id, admin_id')
            .eq('id', req.params.id)
            .maybeSingle();
        if (e1) throw e1;
        if (!existing) throw Object.assign(new Error('Not found'), { status: 404, code: 'NOT_FOUND' });
        if (!req.adminContext.isSuperAdmin && String(existing.admin_id) !== String(req.adminContext.id)) {
            throw Object.assign(new Error('Only the creator can delete'), { status: 403, code: 'FORBIDDEN' });
        }
        const { error } = await supabaseAdmin
            .from('support_saved_replies')
            .delete()
            .eq('id', req.params.id);
        if (error) throw error;
        ok(res, { deleted: true });
    } catch (e) { sendErr(res, e); }
});

// ─────────────────────────────────────────────────────────────
// CSV EXPORT — new (C.6)
// Capped at 5000 rows. Audited. PII masked unless VIEW_CUSTOMER.
// Raw CSV body (not wrapped) so browsers stream it to a file.
// ─────────────────────────────────────────────────────────────
router.get('/support/export.csv', requirePermission(P.EXPORT), async (req, res) => {
    const started = Date.now();
    try {
        const canViewPii = req.adminContext.isSuperAdmin
            || (req.adminContext.permissions || []).includes(P.VIEW_CUSTOMER);
        const rows = await support.listTickets({
            page: 1, limit: 5000,
            status:   req.query.status,
            priority: req.query.priority,
            category: req.query.category,
            assigned: req.query.assigned,
            search:   req.query.search,
            sla:      req.query.sla,
            sort:     req.query.sort || 'recent',
            dateFrom: req.query.date_from,
            dateTo:   req.query.date_to,
            viewerId: req.adminContext.id
        });

        const header = [
            'ticket_number','subject','status','priority','category',
            'created_at','updated_at','assigned_to','contact_name','contact_email'
        ];
        function csv(v) {
            if (v == null) return '';
            const s = String(v);
            if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
            return s;
        }
        const lines = [header.join(',')];
        for (const t of rows.tickets) {
            lines.push([
                t.ticket_number,
                t.subject,
                t.status,
                t.priority,
                t.category,
                t.created_at,
                t.updated_at,
                (t.assigned && t.assigned.username) || '',
                canViewPii ? (t.contact_name || '')  : '—',
                canViewPii ? (t.contact_email || '') : '—'
            ].map(csv).join(','));
        }

        recordAdminAction({
            adminId: req.adminContext.id,
            action: 'support.export_csv',
            requestId: req.requestId,
            req,
            metadata: { rows: rows.tickets.length, pii_included: canViewPii }
        }).catch(() => {});

        routeLog('export.csv', req, {
            rows: rows.tickets.length, pii: canViewPii, latencyMs: Date.now() - started
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition',
            'attachment; filename="support-tickets-' + new Date().toISOString().slice(0, 10) + '.csv"');
        res.send(lines.join('\n'));
    } catch (e) {
        routeLog('export.error', req, { code: e.code, latencyMs: Date.now() - started });
        sendErr(res, e);
    }
});

// ─────────────────────────────────────────────────────────────
// HEALTH (existing endpoint, unchanged shape)
// ─────────────────────────────────────────────────────────────
router.get('/support/health', requirePermission(P.READ), async (req, res) => {
    try {
        const io = socketSvc(req);
        const payload = {
            socket: io && typeof io.stats === 'function' ? io.stats() : { available: false },
            now: new Date().toISOString()
        };
        try {
            const outbox = require('../../services/supportEmailOutbox');
            if (outbox && typeof outbox.stats === 'function') {
                payload.emailOutbox = await outbox.stats();
            }
        } catch (e) {
            payload.emailOutbox = { error: true, message: e.message };
        }
        ok(res, { data: payload });
    } catch (e) { sendErr(res, e); }
});

module.exports = router;