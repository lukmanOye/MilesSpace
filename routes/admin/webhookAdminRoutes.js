// routes/admin/webhookAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin webhook operations.
//   GET  /api/admin/webhooks                (list)
//   GET  /api/admin/webhooks/stats
//   GET  /api/admin/webhooks/providers
//   GET  /api/admin/webhooks/:id
//   POST /api/admin/webhooks/:id/reprocess  (step-up)
//   POST /api/admin/webhooks/:id/ignore
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requirePermission, PERMISSIONS, can } = require('../../middleware/adminAuth');
const { requireStepUpAuth } = require('../../middleware/adminStepUp');
const { supabaseAdmin } = require('../../db/supabase');
const webhookService = require('../../services/webhookService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function attachRequestId(req, res, next) {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}
router.use(['/webhooks'], attachRequestId);

function ok(res, payload) {
    if (!res.headersSent) res.json({ success: true, ...payload });
}
function err(res, e) {
    if (res.headersSent) return;
    const status = e?.status || 500;
    if (status >= 500) console.error('[ADMIN WEBHOOKS]', e?.code || '', e?.message || e);
    const message = status >= 500
        ? 'Something went wrong. Please try again.'
        : (e?.message || 'Webhook request failed.');
    res.status(status).json({
        success: false,
        code: e?.code || 'WEBHOOK_ERROR',
        error: message,
        ...(e?.safe ? { detail: e.safe } : {})
    });
}

// ─── List ───────────────────────────────────────────────────────

router.get(
    '/webhooks',
    requirePermission(PERMISSIONS.WEBHOOKS_READ),
    async (req, res) => {
        try {
            const provider = req.query.provider || null;
            const status = req.query.status || null;
            const orderId = req.query.order_id != null ? Number(req.query.order_id) : null;
            const search = req.query.search || null;
            const page = req.query.page;
            const limit = req.query.limit;

            if (orderId != null && (!Number.isInteger(orderId) || orderId <= 0)) {
                const e = new Error('order_id must be a positive integer.');
                e.status = 400; e.code = 'INVALID_ORDER_ID'; throw e;
            }

            const r = await webhookService.listEvents({ page, limit, provider, status, orderId, search });
            ok(res, r);
        } catch (e) { err(res, e); }
    }
);

// ─── Stats ──────────────────────────────────────────────────────

router.get(
    '/webhooks/stats',
    requirePermission(PERMISSIONS.WEBHOOKS_READ),
    async (req, res) => {
        try {
            const stats = await webhookService.getStats({ provider: req.query.provider });
            ok(res, { stats, available: true });
        } catch (e) { err(res, e); }
    }
);

// ─── Providers ─────────────────────────────────────────────────

router.get(
    '/webhooks/providers',
    requirePermission(PERMISSIONS.WEBHOOKS_READ),
    async (req, res) => {
        try {
            const providers = await webhookService.listProviders();
            ok(res, { providers });
        } catch (e) { err(res, e); }
    }
);

// ─── Detail ────────────────────────────────────────────────────

router.get(
    '/webhooks/:id',
    requirePermission(PERMISSIONS.WEBHOOKS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const canReplay = can(req.adminContext, PERMISSIONS.WEBHOOKS_REPLAY);
            const detail = await webhookService.getEventDetail(req.params.id, { canReplay });
            ok(res, detail);
        } catch (e) { err(res, e); }
    }
);

// ─── Reprocess ─────────────────────────────────────────────────

router.post(
    '/webhooks/:id/reprocess',
    requirePermission(PERMISSIONS.WEBHOOKS_REPLAY),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) {
                const e = new Error('A reason of at least 4 characters is required.');
                e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }

            const result = await webhookService.reprocessWebhook({
                eventId: req.params.id,
                ctx: { adminId: req.adminContext.id, adminEmail: req.adminContext.email, requestId: req.requestId }
            });

            // Audit is mandatory — reprocess can trigger refunds.
            const { error: auditErr } = await supabaseAdmin
                .from('admin_audit_logs')
                .insert({
                    admin_id: req.adminContext.id,
                    admin_email: req.adminContext.email,
                    action: 'webhook.reprocess',
                    target_type: 'webhook_event',
                    target_id: req.params.id,
                    reason: reason.slice(0, 500),
                    before: { status: result.before_status },
                    after: { status: result.after_status, outcome: result.outcome, updated: result.updated },
                    ip_address: req.ip,
                    user_agent: req.headers['user-agent'] || null,
                    request_id: req.requestId,
                    created_at: new Date().toISOString()
                });
            if (auditErr) {
                console.error('[ADMIN WEBHOOKS] AUDIT INSERT FAILED', auditErr.message, { requestId: req.requestId, eventId: req.params.id });
                const e = new Error('Audit log write failed; action aborted.');
                e.status = 500; e.code = 'AUDIT_WRITE_FAILED'; throw e;
            }

            ok(res, result);
        } catch (e) {
            // Audit the failure too (best effort).
            try {
                await supabaseAdmin.from('admin_audit_logs').insert({
                    admin_id: req.adminContext?.id || null,
                    admin_email: req.adminContext?.email || null,
                    action: 'webhook.reprocess.failed',
                    target_type: 'webhook_event',
                    target_id: req.params.id,
                    reason: String(req.body?.reason || '').slice(0, 500),
                    after: { error: e.code || 'ERROR', message: String(e.message || '').slice(0, 500) },
                    ip_address: req.ip,
                    user_agent: req.headers['user-agent'] || null,
                    request_id: req.requestId,
                    created_at: new Date().toISOString()
                });
            } catch { /* swallow — failure to audit a failure */ }
            err(res, e);
        }
    }
);

// ─── Ignore ────────────────────────────────────────────────────

router.post(
    '/webhooks/:id/ignore',
    requirePermission(PERMISSIONS.WEBHOOKS_REPLAY),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) {
                const e = new Error('A reason of at least 4 characters is required.');
                e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const result = await webhookService.ignoreWebhook({ eventId: req.params.id, reason });

            const { error: auditErr } = await supabaseAdmin
                .from('admin_audit_logs')
                .insert({
                    admin_id: req.adminContext.id,
                    admin_email: req.adminContext.email,
                    action: 'webhook.ignore',
                    target_type: 'webhook_event',
                    target_id: req.params.id,
                    reason: reason.slice(0, 500),
                    before: { status: result.before_status },
                    after: { status: result.after_status },
                    ip_address: req.ip,
                    user_agent: req.headers['user-agent'] || null,
                    request_id: req.requestId,
                    created_at: new Date().toISOString()
                });
            if (auditErr) {
                console.error('[ADMIN WEBHOOKS] AUDIT INSERT FAILED', auditErr.message, { requestId: req.requestId, eventId: req.params.id });
                const e = new Error('Audit log write failed; action aborted.');
                e.status = 500; e.code = 'AUDIT_WRITE_FAILED'; throw e;
            }

            ok(res, result);
        } catch (e) { err(res, e); }
    }
);

module.exports = router;