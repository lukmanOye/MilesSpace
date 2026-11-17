// routes/admin/boostAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Boost API. Permission-guarded. 5xx never leaks internals.
//
//   GET  /boost/overview
//   GET  /boost/orders
//   GET  /boost/orders/:id
//   PUT  /boost/orders/:id/status
//   POST /boost/orders/:id/refund         (verified_at_provider for
//                                          provider_unknown/manual_review)
//   POST /boost/orders/:id/note
//   POST /boost/orders/:id/recheck
//   POST /boost/sync
//   GET  /boost/services
//   POST /boost/services/bulk             (accepts { ids | filters, patch })
//   POST /boost/services/sync
//   PUT  /boost/services/:id
//   GET  /boost/provider                  (configured, dry_run, balance)
//   GET  /boost/config                    (includes dry_run + smmwiz_configured)
//   PUT  /boost/config                    (accepts `changes`, reason,
//                                          expected_version, confirm_large_change)
//   GET  /boost/alerts                    (task 25)
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { supabaseAdmin } = require('../../db/supabase');
const boostService = require('../../services/boostService');
const syncService  = require('../../services/boostSyncService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAFE_MESSAGES = {
    PROVIDER_NOT_CONFIGURED:   'SMMWiz is not configured on this server.',
    PROVIDER_NETWORK:          'SMMWiz could not be reached. Try again shortly.',
    PROVIDER_ERROR:            'SMMWiz rejected the request.',
    SERVICE_NOT_FOUND:         'Service not found.',
    SERVICE_UPDATE_FAILED:     'Failed to update service.',
    BOOST_NOT_FOUND:           'Boost order not found.',
    NOT_REFUNDABLE:            'This order is not eligible for a refund.',
    ORDER_STATE_CHANGED:       'The order changed before this action completed. Reload and try again.',
    INVALID_STATUS_TRANSITION: 'That status change is not allowed.',
    INVALID_ID:                'Invalid identifier.',
    REASON_REQUIRED:           'A reason is required.',
    NOTE_REQUIRED:             'Note text is required.',
    NOTE_SAVE_FAILED:          'Failed to save note.',
    VERIFICATION_REQUIRED:     'This refund requires verified_at_provider=true (provider panel checked).',
    REFUND_PENDING_RECONCILE:  'Refund recorded; wallet credit will be reconciled automatically.',
    CONFIG_VERSION_REQUIRED:   'expectedVersion is required. Reload and retry.'
};

function sendOk(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'BOOST_ADMIN_ERROR';
    const message = SAFE_MESSAGES[code] || err?.message || 'Boost admin request failed.';
    if (status >= 500 || !SAFE_MESSAGES[code]) {
        console.error('[ADMIN BOOST]', code, err?.message || err);
    }
    const body = { success: false, code, error: message };
    if (err?.missing) body.missing = err.missing;
    if (err?.required !== undefined) body.required = err.required;
    if (err?.balance !== undefined) body.balance = err.balance;
    if (err?.new_amount !== undefined) body.new_amount = err.new_amount;
    if (err?.current_version !== undefined) body.current_version = err.current_version;
    if (err?.refund_reference) body.refund_reference = err.refund_reference;
    if (err?.allowed_transitions) body.allowed_transitions = err.allowed_transitions;
    if (err?.keys) body.keys = err.keys;
    if (err?.key) body.key = err.key;
    if (err?.old_value !== undefined) body.old_value = err.old_value;
    if (err?.new_value !== undefined) body.new_value = err.new_value;
    res.status(status).json(body);
}
function ctxFrom(req) {
    return {
        adminId: req.adminContext?.id || null,
        adminEmail: req.adminContext?.email || null,
        permissions: req.adminContext?.permissions || [],
        ip: req.ip || req.headers['x-forwarded-for'] || null,
        userAgent: req.headers['user-agent'] || null,
        requestId: req.headers['x-request-id'] || null
    };
}

// ─── Overview ─────────────────────────────────────────────────

router.get('/boost/overview', requirePermission(PERMISSIONS.SERVICES_READ), async (req, res) => {
    try {
        const overview = await boostService.getOverview({
            range: req.query.range || null,
            from: req.query.from || null,
            to: req.query.to || null
        });
        sendOk(res, { overview });
    } catch (err) { sendErr(res, err); }
});

// ─── Orders ───────────────────────────────────────────────────

router.get(
    '/boost/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            // The Overview tile only needs rows, not a count. Skip the
            // expensive exact count when limit is small and the caller
            // is clearly a "recent orders" panel.
            const wantsCount =
                req.query.withCount === 'true' ||
                parseInt(req.query.limit, 10) > 25 ||
                Boolean(req.query.page);
            const result = await boostService.listOrders({
                page: req.query.page, limit: req.query.limit,
                status: req.query.status, platform: req.query.platform,
                category: req.query.category, currency: req.query.currency,
                user_id: req.query.user_id, from: req.query.from,
                to: req.query.to, search: req.query.search
            }, { withCount: wantsCount });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/boost/orders/:id',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await boostService.getOrder(req.params.id);
            sendOk(res, data);
        } catch (err) { sendErr(res, err); }
    }
);

router.put(
    '/boost/orders/:id/status',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { status, note, verified_at_provider } = req.body || {};
            const result = await boostService.updateOrderStatus({
                orderId: req.params.id, status, note,
                verifiedAtProvider: !!verified_at_provider,
                ctx: ctxFrom(req)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/boost/orders/:id/refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { reason, allow_non_failed, verified_at_provider } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const result = await boostService.refundOrder({
                orderId: req.params.id,
                reason: String(reason).slice(0, 500),
                ctx: ctxFrom(req),
                allowNonFailed: !!allow_non_failed,
                verifiedAtProvider: !!verified_at_provider
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/boost/orders/:id/note',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { note } = req.body || {};
            if (!note || String(note).trim().length < 2) {
                const e = new Error('Note text is required.');
                e.status = 422; e.code = 'NOTE_REQUIRED'; throw e;
            }
            const { data: updated, error } = await supabaseAdmin
                .from('boost_orders')
                .update({ admin_note: String(note).slice(0, 1000), updated_at: new Date().toISOString() })
                .eq('id', req.params.id)
                .select('*')
                .maybeSingle();
            if (error || !updated) {
                const e = new Error('Failed to save note.');
                e.status = 500; e.code = 'NOTE_SAVE_FAILED'; throw e;
            }
            try {
                await supabaseAdmin.from('admin_audit_logs').insert({
                    admin_id: req.adminContext?.id || null,
                    admin_email: req.adminContext?.email || null,
                    action: 'boost.order_note',
                    target_type: 'boost_order',
                    target_id: req.params.id,
                    reason: String(note).slice(0, 500),
                    created_at: new Date().toISOString()
                });
            } catch (_) {}
            sendOk(res, { order: boostService.shapeOrder(updated) });
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/boost/orders/:id/recheck',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const { data: order } = await supabaseAdmin
                .from('boost_orders').select('*').eq('id', req.params.id).maybeSingle();
            if (!order) {
                const e = new Error('Order not found.'); e.status = 404; e.code = 'BOOST_NOT_FOUND'; throw e;
            }
            const r = await syncService.syncBoostOrder(order)
                .catch(err => ({ updated: false, error: err.message }));
            const { data: fresh } = await supabaseAdmin
                .from('boost_orders').select('*').eq('id', order.id).maybeSingle();
            sendOk(res, { refreshed: !!r.updated, order: boostService.shapeOrder(fresh || order) });
        } catch (err) { sendErr(res, err); }
    }
);

// ─── Sync (submissions + status) ──────────────────────────────

router.post(
    '/boost/sync',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res) => {
        try {
            if (!syncService.isProviderConfigured()) {
                return res.status(503).json({
                    success: false, code: 'PROVIDER_NOT_CONFIGURED',
                    error: SAFE_MESSAGES.PROVIDER_NOT_CONFIGURED,
                    missing: 'SMMWIZ_API_KEY'
                });
            }
            const submit = await syncService.submitPendingBoostOrders({ limit: 25 });
            const sweep  = await syncService.syncPendingBoostOrders({ limit: 100 });
            sendOk(res, { submit, sweep, dry_run: syncService.isDryRun() });
        } catch (err) { sendErr(res, err); }
    }
);

// ─── Services ─────────────────────────────────────────────────
// NOTE: /bulk is declared BEFORE /:id so POST /services/bulk never
// falls through to PUT /services/:id.

router.get(
    '/boost/services',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const result = await boostService.listServices({
                page: req.query.page, limit: req.query.limit,
                active: req.query.active, visible: req.query.visible,
                platform: req.query.platform, category: req.query.category,
                search: req.query.search
            }, { withPricing: true });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/boost/services/bulk',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            // Task 13: accept BOTH `filter` (legacy) and `filters`.
            const body = req.body || {};
            const ids = body.ids;
            const filters = body.filters || body.filter || null;
            const patch = body.patch || {};

            const result = await boostService.bulkUpdateServices({
                ids, filters, patch, ctx: ctxFrom(req)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/boost/services/sync',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            if (!syncService.isProviderConfigured()) {
                return res.status(503).json({
                    success: false, code: 'PROVIDER_NOT_CONFIGURED',
                    error: SAFE_MESSAGES.PROVIDER_NOT_CONFIGURED,
                    missing: 'SMMWIZ_API_KEY'
                });
            }
            const result = await syncService.syncServiceCatalog();
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.put(
    '/boost/services/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const result = await boostService.updateService({
                serviceId: req.params.id,
                patch: req.body || {},
                ctx: ctxFrom(req)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

// ─── Provider info ────────────────────────────────────────────

router.get(
    '/boost/provider',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const balance = await syncService.getProviderBalance();
            sendOk(res, {
                configured: syncService.isProviderConfigured(),
                dry_run: syncService.isDryRun(),
                balance
            });
        } catch (err) { sendErr(res, err); }
    }
);

// ─── Alerts (task 25) ─────────────────────────────────────────

router.get(
    '/boost/alerts',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            // Balance first so alerts can flag low-balance.
            let providerBalanceUsd = null;
            try {
                const b = await syncService.getProviderBalance();
                providerBalanceUsd = (b && typeof b.balance === 'number') ? b.balance : null;
            } catch (_) {}

            const alerts = await boostService.getAlerts(providerBalanceUsd);
            sendOk(res, { alerts, provider: { balance_usd: providerBalanceUsd, dry_run: syncService.isDryRun() } });
        } catch (err) { sendErr(res, err); }
    }
);

// ─── Config ───────────────────────────────────────────────────

router.get(
    '/boost/config',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const config = await boostService.getAdminConfig();
            // Task 12: add these two so the UI can show banners.
            config.smmwiz_configured = syncService.isProviderConfigured();
            config.dry_run = syncService.isDryRun();
            sendOk(res, { config });
        } catch (err) { sendErr(res, err); }
    }
);

router.put(
    '/boost/config',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            // Task 11: UI sends `changes`, not `patch`.
            const body = req.body || {};
            const changes = body.changes || body.patch || null;
            if (!changes || typeof changes !== 'object') {
                return res.status(422).json({
                    success: false, code: 'INVALID_PATCH',
                    error: 'A `changes` object is required.'
                });
            }
            const result = await boostService.saveAdminConfig({
                changes,
                reason: body.reason || null,
                expectedVersion: body.expected_version != null ? body.expected_version : null,
                confirmLargeChange: !!body.confirm_large_change,
                ctx: ctxFrom(req)
            });
            sendOk(res, { result });
        } catch (err) {
            if (err.code === 'LARGE_CHANGE_REQUIRES_CONFIRMATION') {
                return res.status(422).json({
                    success: false, code: err.code, error: err.message,
                    key: err.key, old_value: err.old_value, new_value: err.new_value
                });
            }
            if (err.code === 'CONFIG_VERSION_CONFLICT') {
                return res.status(409).json({
                    success: false, code: err.code, error: err.message,
                    current_version: err.current_version
                });
            }
            if (err.code === 'CONFIG_VERSION_REQUIRED') {
                return res.status(409).json({
                    success: false, code: err.code,
                    error: SAFE_MESSAGES.CONFIG_VERSION_REQUIRED
                });
            }
            sendErr(res, err);
        }
    }
);

module.exports = router;