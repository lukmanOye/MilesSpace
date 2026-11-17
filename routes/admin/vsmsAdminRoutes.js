// routes/admin/vsmsAdminRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Admin Virtual SMS API — HTTP surface.
//
// All routes require requirePermission(...) and — for mutations — a
// reason and a valid Idempotency-Key header. Mutations claim the key
// atomically BEFORE the handler runs.
//
// URL surface:
//
//   GET    /api/admin/virtual-sms/stats?range=today|7d|30d|all
//   GET    /api/admin/virtual-sms/stats?from=&to=
//   GET    /api/admin/virtual-sms/attention
//
//   GET    /api/admin/virtual-sms/orders?page&limit&status&...
//   GET    /api/admin/virtual-sms/orders/export.csv?...
//   GET    /api/admin/virtual-sms/orders/:id
//   GET    /api/admin/virtual-sms/orders/:id/events
//   GET    /api/admin/virtual-sms/orders/:id/provider-logs
//   POST   /api/admin/virtual-sms/orders/:id/sync
//   POST   /api/admin/virtual-sms/orders/:id/cancel
//   POST   /api/admin/virtual-sms/orders/:id/release
//   POST   /api/admin/virtual-sms/orders/:id/retry
//   POST   /api/admin/virtual-sms/orders/:id/refund
//   POST   /api/admin/virtual-sms/orders/:id/reveal
//   PATCH  /api/admin/virtual-sms/orders/:id/status
//   POST   /api/admin/virtual-sms/orders/bulk-refund
//
//   GET    /api/admin/virtual-sms/catalogue/countries
//   PATCH  /api/admin/virtual-sms/catalogue/countries/:id
//   GET    /api/admin/virtual-sms/catalogue/services?country=
//   PATCH  /api/admin/virtual-sms/catalogue/services/:id
//   POST   /api/admin/virtual-sms/catalogue/sync
//
//   GET    /api/admin/virtual-sms/provider/health
//   POST   /api/admin/virtual-sms/provider/health-check
//   GET    /api/admin/virtual-sms/provider/logs
//   POST   /api/admin/virtual-sms/provider/breaker/reset
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { requirePermission, PERMISSIONS, recordAdminAction } = require('../../middleware/adminAuth');
const { supabaseAdmin } = require('../../db/supabase');
const svc = require('../../services/vsmsAdminService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Request-id middleware ───────────────────────────────────────────────
router.use((req, res, next) => {
    req.vsmsRequestId = req.headers['x-request-id']
        || `VS-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    res.setHeader('X-Request-ID', req.vsmsRequestId);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
});

// ─── Error surface ───────────────────────────────────────────────────────
const SAFE_MESSAGES = {
    INVALID_ID:                     'Invalid identifier.',
    REASON_REQUIRED:                'A reason of at least 4 characters is required.',
    VSMS_NOT_FOUND:                 'Virtual SMS order not found.',
    ALREADY_REFUNDED:               'This order is already refunded.',
    NOT_REFUNDABLE:                 'This order is not eligible for a refund.',
    NO_TRANSACTION:                 'This order has no wallet transaction.',
    TX_NOT_FOUND:                   'The original transaction could not be found.',
    TX_NOT_REFUNDABLE:              'The original transaction is not refundable.',
    ORDER_STATE_CHANGED:            'The order changed before this action completed. Reload and try again.',
    INVALID_STATUS_TRANSITION:      'That status change is not allowed.',
    LEDGER_REFUND_FAILED:           'The wallet refund could not be completed. The worker will retry automatically.',
    REFUND_FAILED:                  'The wallet refund could not be completed. The worker will retry automatically.',
    REFUND_POST_CREDIT_FAILED:      'The refund was applied, but the order could not be finalized. Support has been notified.',
    PROVIDER_NOT_CONFIGURED:        'The Virtual SMS provider is not configured.',
    PROVIDER_CANCEL_FAILED:         'The provider could not cancel the number.',
    PROVIDER_CANCEL_AMBIGUOUS:      'The provider response was ambiguous. The worker will resolve.',
    PROVIDER_RELEASE_FAILED:        'The provider could not release the number.',
    PROVIDER_RETRY_FAILED:          'The provider could not resend the SMS.',
    NO_ACTIVATION:                  'This order has no number to act on.',
    ORDER_INACTIVE:                 'This order is already finished.',
    SMS_CODE_DELIVERED:             'A code has already been delivered. This order cannot be cancelled/refunded without confirming.',
    SMS_ALREADY_RECEIVED:           'The SMS has already been received.',
    IDEMPOTENCY_KEY_REQUIRED:       'An Idempotency-Key header (8-200 characters) is required.',
    IDEMPOTENCY_CONFLICT:           'This idempotency key was already used with different parameters.',
    AUDIT_WRITE_FAILED:             'The action was aborted because the audit log could not be written.',
    BULK_TOO_LARGE:                 'Bulk action is limited to 50 orders per request.',
    CATALOGUE_ERROR:                'Failed to load catalogue.',
    CATALOGUE_UPDATE_FAILED:        'Failed to update catalogue entry.',
    PROVIDER_LOGS_ERROR:            'Failed to load provider logs.',
    ATTENTION_ERROR:                'Failed to load attention queue.'
};

function sendOk(res, data, meta) {
    if (res.headersSent) return;
    res.json({ success: true, data: data === undefined ? null : data, _meta: meta || {} });
}

function sendErr(res, req, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'VSMS_ERROR';
    const message = SAFE_MESSAGES[code] || (status < 500 ? (err?.message || 'Request failed.') : 'Virtual SMS request failed.');
    if (status >= 500) {
        console.error('[ADMIN VSMS]', req.vsmsRequestId, code, err?.message || err);
    }
    const body = { success: false, error: message, code, request_id: req.vsmsRequestId };
    if (err?.allowed_transitions) body.allowed_transitions = err.allowed_transitions;
    if (err?.expected_status) body.expected_status = err.expected_status;
    if (err?.can_cancel_at) body.can_cancel_at = err.can_cancel_at;
    if (err?.wait_seconds != null) body.wait_seconds = err.wait_seconds;
    res.status(status).json(body);
}

// ─── Context ─────────────────────────────────────────────────────────────
function ctxFrom(req) {
    return {
        adminId:    req.adminContext?.id    || null,
        adminEmail: req.adminContext?.email || null,
        ip:         req.ip || req.headers['x-forwarded-for'] || null,
        userAgent:  req.headers['user-agent'] || null,
        requestId:  req.vsmsRequestId
    };
}

// ─── Idempotency — claim first, race-safe ────────────────────────────────
// The unique index on (admin_id, endpoint, idempotency_key) makes the
// INSERT the claim. Two concurrent requests: one wins, one gets 23505
// and is told to wait or that the request was already processed.
async function claimIdempotency({ req, bodyHash }) {
    const key = String(req.headers['idempotency-key'] || '').trim();
    if (!key || key.length < 8) {
        const e = new Error('Idempotency-Key required.');
        e.status = 400; e.code = 'IDEMPOTENCY_KEY_REQUIRED'; throw e;
    }
    if (key.length > 200) {
        const e = new Error('Idempotency-Key too long.');
        e.status = 400; e.code = 'IDEMPOTENCY_KEY_REQUIRED'; throw e;
    }
    const adminId = String(req.adminContext?.id || 'anon');
    const endpoint = `${req.method} ${req.baseUrl}${req.path}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Try INSERT.
    const { data: inserted, error } = await supabaseAdmin
        .from('admin_idempotency')
        .insert({
            admin_id:        adminId,
            endpoint,
            idempotency_key: key,
            request_hash:    bodyHash || null,
            status:          'in_progress',
            response:        null,
            status_code:     null,
            created_at:      now,
            expires_at:      expiresAt,
            updated_at:      now
        })
        .select('id')
        .maybeSingle();

    if (!error && inserted) {
        return { fresh: true, id: inserted.id, key, endpoint, adminId };
    }

    if (error && error.code === '23505') {
        // Already exists. Check hash + status.
        const { data: existing } = await supabaseAdmin
            .from('admin_idempotency')
            .select('response, status, request_hash, status_code')
            .eq('admin_id', adminId)
            .eq('endpoint', endpoint)
            .eq('idempotency_key', key)
            .maybeSingle();

        if (existing && existing.request_hash && bodyHash && existing.request_hash !== bodyHash) {
            const e = new Error('Idempotency key reused with different parameters.');
            e.status = 409; e.code = 'IDEMPOTENCY_CONFLICT'; throw e;
        }
        if (existing && existing.status === 'completed' && existing.response) {
            return { fresh: false, replay: existing.response, replayStatus: existing.status_code || 200 };
        }
        // In progress elsewhere → 409 so the client retries.
        const e = new Error('An identical request is already being processed.');
        e.status = 409; e.code = 'IDEMPOTENCY_CONFLICT'; throw e;
    }

    // Any other error is real.
    console.error('[ADMIN VSMS] idempotency claim failed:', error?.message);
    const e = new Error('Failed to claim idempotency key.');
    e.status = 500; e.code = 'AUDIT_WRITE_FAILED'; throw e;
}

async function completeIdempotency({ claim, response, statusCode }) {
    try {
        await supabaseAdmin
            .from('admin_idempotency')
            .update({
                status: 'completed',
                response,
                status_code: statusCode || 200,
                updated_at: new Date().toISOString()
            })
            .eq('admin_id', claim.adminId)
            .eq('endpoint', claim.endpoint)
            .eq('idempotency_key', claim.key);
    } catch (e) {
        console.warn('[ADMIN VSMS] idempotency complete failed:', e.message);
    }
}

async function releaseIdempotency({ claim }) {
    try {
        await supabaseAdmin
            .from('admin_idempotency')
            .delete()
            .eq('admin_id', claim.adminId)
            .eq('endpoint', claim.endpoint)
            .eq('idempotency_key', claim.key)
            .eq('status', 'in_progress');
    } catch { /* ignore */ }
}

function hashBody(body) {
    try { return crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex'); }
    catch { return null; }
}

// ─── Reason helper ───────────────────────────────────────────────────────
function requireReason(body) {
    const reason = body && body.reason ? String(body.reason).trim() : '';
    if (reason.length < 4) {
        const e = new Error('A reason of at least 4 characters is required.');
        e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    return reason.slice(0, 500);
}

// ═════════════════════════════════════════════════════════════════════════
//  STATS + ATTENTION
// ═════════════════════════════════════════════════════════════════════════
router.get(
    '/virtual-sms/stats',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const stats = await svc.getStats({
                range: req.query.range || 'today',
                from:  req.query.from  || null,
                to:    req.query.to    || null
            });
            sendOk(res, stats, { request_id: req.vsmsRequestId });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/virtual-sms/attention',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const result = await svc.getAttentionQueue(req.query.limit);
            sendOk(res, result, { request_id: req.vsmsRequestId });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════════════
//  ORDERS — LIST + EXPORT
// ═════════════════════════════════════════════════════════════════════════
router.get(
    '/virtual-sms/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const result = await svc.listOrders({
                page:         req.query.page,
                limit:        req.query.limit,
                status:       req.query.status,
                country:      req.query.country,
                service:      req.query.service,
                user_id:      req.query.user_id,
                sms_received: req.query.sms_received,
                refunded:     req.query.refunded,
                from:         req.query.from,
                to:           req.query.to,
                search:       req.query.search
            });
            sendOk(res, result, { request_id: req.vsmsRequestId });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/virtual-sms/orders/export.csv',
    requirePermission(PERMISSIONS.REPORTS_EXPORT || PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const result = await svc.listOrders({
                page: 1, limit: 500,
                status: req.query.status,
                country: req.query.country,
                service: req.query.service,
                user_id: req.query.user_id,
                sms_received: req.query.sms_received,
                refunded: req.query.refunded,
                from: req.query.from,
                to: req.query.to,
                search: req.query.search
            });

            const header = [
                'id','created_at','status','user_id','user_email',
                'country_id','service_code','service_name',
                'phone_masked','activation_id','charge_currency','charge_amount',
                'price_usd','price_ngn','provider_cost_usd','profit_usd',
                'sms_received_at','completed_at','refunded_at','failure_code'
            ];
            const lines = [header.join(',')];
            for (const o of result.orders) {
                lines.push([
                    o.id, o.created_at, o.status, o.user_id,
                    (o.user && o.user.email) || '',
                    o.country_id, o.service_code, o.service_name,
                    o.phone_masked, o.activation_id,
                    o.charge_currency, o.charge_amount,
                    o.price_usd, o.price_ngn, o.provider_cost_usd, o.profit_usd,
                    o.sms_received_at, o.completed_at, o.refunded_at, o.failure_code
                ].map(csvEscape).join(','));
            }
            const csv = lines.join('\n');

            // Audit the export.
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'virtual_sms.orders_export',
                targetType: 'virtual_sms_orders',
                targetId: 'csv',
                after: { row_count: result.orders.length },
                req
            }).catch(() => {});

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="virtual-sms-orders-${stamp}.csv"`);
            res.setHeader('X-Export-Rows', String(result.orders.length));
            res.status(200).send(csv);
        } catch (err) { sendErr(res, req, err); }
    }
);

function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

// ═════════════════════════════════════════════════════════════════════════
//  ORDERS — DETAIL + EVENTS + LOGS
// ═════════════════════════════════════════════════════════════════════════
router.get(
    '/virtual-sms/orders/:id',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await svc.getOrder(req.params.id, { revealSensitive: false });
            sendOk(res, data, { request_id: req.vsmsRequestId });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/virtual-sms/orders/:id/events',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await svc.getOrder(req.params.id, { revealSensitive: false });
            sendOk(res, { events: data.events }, { request_id: req.vsmsRequestId });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/virtual-sms/orders/:id/provider-logs',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const data = await svc.getOrder(req.params.id, { revealSensitive: false });
            sendOk(res, { logs: data.provider_logs }, { request_id: req.vsmsRequestId });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════════════
//  MUTATION WRAPPER — claims idempotency, runs handler, completes
// ═════════════════════════════════════════════════════════════════════════
async function withMutation(req, res, handler) {
    let claim = null;
    try {
        claim = await claimIdempotency({ req, bodyHash: hashBody(req.body) });
        if (!claim.fresh) {
            return res.status(claim.replayStatus || 200).json(claim.replay);
        }
        const response = await handler();
        await completeIdempotency({ claim, response, statusCode: response.status || 200 });
        sendOk(res, response.data || null, {
            request_id: req.vsmsRequestId,
            ...(response.meta || {})
        });
    } catch (err) {
        if (claim && claim.fresh) await releaseIdempotency({ claim });
        sendErr(res, req, err);
    }
}

// ═════════════════════════════════════════════════════════════════════════
//  ORDERS — ACTIONS
// ═════════════════════════════════════════════════════════════════════════

router.post(
    '/virtual-sms/orders/:id/sync',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        await withMutation(req, res, async () => {
            const result = await svc.syncOrder({ orderId: req.params.id, ctx: ctxFrom(req) });
            return { data: result };
        });
    }
);

router.post(
    '/virtual-sms/orders/:id/cancel',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        await withMutation(req, res, async () => {
            const reason = requireReason(req.body);
            const result = await svc.cancelOrder({
                orderId: req.params.id,
                ctx: ctxFrom(req),
                reason,
                confirmCodeWasReceived: !!req.body?.confirmCodeWasReceived
            });
            return { data: result };
        });
    }
);

router.post(
    '/virtual-sms/orders/:id/release',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        await withMutation(req, res, async () => {
            const reason = requireReason(req.body);
            const result = await svc.releaseNumber({
                orderId: req.params.id,
                ctx: ctxFrom(req),
                reason
            });
            return { data: result };
        });
    }
);

router.post(
    '/virtual-sms/orders/:id/retry',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        await withMutation(req, res, async () => {
            const reason = requireReason(req.body);
            const result = await svc.retryOrder({
                orderId: req.params.id,
                ctx: ctxFrom(req),
                reason
            });
            return { data: result };
        });
    }
);

router.post(
    '/virtual-sms/orders/:id/refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        await withMutation(req, res, async () => {
            const reason = requireReason(req.body);
            const result = await svc.refundOrder({
                orderId: req.params.id,
                ctx: ctxFrom(req),
                reason,
                confirmCodeWasReceived: !!req.body?.confirmCodeWasReceived
            });
            return { data: result };
        });
    }
);

router.post(
    '/virtual-sms/orders/:id/reveal',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        await withMutation(req, res, async () => {
            const revealFullNumber = !!req.body?.revealFullNumber;
            const result = await svc.revealSensitive({
                orderId: req.params.id,
                ctx: ctxFrom(req),
                revealFullNumber
            });
            return { data: result };
        });
    }
);

router.patch(
    '/virtual-sms/orders/:id/status',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        await withMutation(req, res, async () => {
            const reason = requireReason(req.body);
            const status = String(req.body?.status || '').toLowerCase();
            if (!status) {
                const e = new Error('A status is required.');
                e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            const result = await svc.changeStatus({
                orderId: req.params.id,
                nextStatus: status,
                ctx: ctxFrom(req),
                reason
            });
            return { data: result };
        });
    }
);

// ─── Bulk refund ────────────────────────────────────────────────────────
router.post(
    '/virtual-sms/orders/bulk-refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    async (req, res) => {
        await withMutation(req, res, async () => {
            const reason = requireReason(req.body);
            const ids = Array.isArray(req.body?.order_ids) ? req.body.order_ids : [];
            if (!ids.length) {
                const e = new Error('order_ids must be a non-empty array.');
                e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }
            if (ids.length > 50) {
                const e = new Error('Bulk action is limited to 50 orders per request.');
                e.status = 422; e.code = 'BULK_TOO_LARGE'; throw e;
            }

            const results = [];
            for (const id of ids) {
                if (!UUID_RE.test(String(id || ''))) {
                    results.push({ id, ok: false, code: 'INVALID_ID' });
                    continue;
                }
                try {
                    const r = await svc.refundOrder({
                        orderId: id,
                        ctx: ctxFrom(req),
                        reason,
                        confirmCodeWasReceived: !!req.body?.confirmCodeWasReceived
                    });
                    results.push({ id, ok: true, refund: r.refund, already: r.already });
                } catch (e) {
                    results.push({ id, ok: false, code: e.code || 'REFUND_FAILED', message: SAFE_MESSAGES[e.code] || e.message });
                }
            }
            return {
                data: {
                    total: results.length,
                    succeeded: results.filter(r => r.ok).length,
                    failed: results.filter(r => !r.ok).length,
                    results
                }
            };
        });
    }
);

// ═════════════════════════════════════════════════════════════════════════
//  CATALOGUE
// ═════════════════════════════════════════════════════════════════════════
router.get(
    '/virtual-sms/catalogue/countries',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const result = await svc.getCatalogueCountries({
                limit: req.query.limit, offset: req.query.offset
            });
            sendOk(res, result, { request_id: req.vsmsRequestId });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.patch(
    '/virtual-sms/catalogue/countries/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        await withMutation(req, res, async () => {
            const reason = requireReason(req.body);
            const patch = { ...(req.body || {}) };
            delete patch.reason;
            delete patch.idempotencyKey;
            const country = await svc.updateCatalogueCountry({
                id: req.params.id, patch, ctx: ctxFrom(req), reason
            });
            return { data: country };
        });
    }
);

router.get(
    '/virtual-sms/catalogue/services',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const result = await svc.getCatalogueServices({
                countryId: req.query.country || null,
                limit: req.query.limit, offset: req.query.offset
            });
            sendOk(res, result, { request_id: req.vsmsRequestId });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.patch(
    '/virtual-sms/catalogue/services/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        await withMutation(req, res, async () => {
            const reason = requireReason(req.body);
            const patch = { ...(req.body || {}) };
            delete patch.reason;
            delete patch.idempotencyKey;
            const service = await svc.updateCatalogueService({
                id: req.params.id, patch, ctx: ctxFrom(req), reason
            });
            return { data: service };
        });
    }
);

router.post(
    '/virtual-sms/catalogue/sync',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        await withMutation(req, res, async () => {
            const reason = requireReason(req.body);
            const result = await svc.syncCatalogueNow({ ctx: ctxFrom(req), reason });
            return { data: result };
        });
    }
);

// ═════════════════════════════════════════════════════════════════════════
//  PROVIDER
// ═════════════════════════════════════════════════════════════════════════
router.get(
    '/virtual-sms/provider/health',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const health = await svc.getProviderHealth();
            sendOk(res, { health }, { request_id: req.vsmsRequestId });
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/virtual-sms/provider/health-check',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        await withMutation(req, res, async () => {
            const result = await svc.healthCheckProvider({ ctx: ctxFrom(req) });
            return { data: result };
        });
    }
);

router.get(
    '/virtual-sms/provider/logs',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const result = await svc.getProviderLogsRecent({ limit: req.query.limit });
            sendOk(res, result, { request_id: req.vsmsRequestId });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════════════
//  BULK RESOLVE STALE — one-click cleanup of ancient stuck orders
// ═════════════════════════════════════════════════════════════════════════
// Finds every order in `processing` (no activation) or `manual_review`
// whose updated_at is older than `stale_hours` (default 24), and calls
// refundOrderSafely on each. Idempotent — already-refunded orders
// short-circuit. Every order is audited individually.
router.post(
    '/virtual-sms/orders/bulk-resolve-stale',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res) => {
        await withMutation(req, res, async () => {
            const reason = requireReason(req.body);
            const staleHours = Math.max(1, Math.min(parseInt(req.body?.stale_hours, 10) || 24, 24 * 30));

            // Find candidates via the RPC — same source the admin page's
            // Needs Attention tab reads. Filter to the two reasons we
            // know are safe to auto-refund.
            const rpc = await supabaseAdmin.rpc('virtual_sms_attention_queue', { p_limit: 500 });
            if (rpc.error) {
                const e = new Error('Failed to load attention queue.');
                e.status = 500; e.code = 'ATTENTION_ERROR'; throw e;
            }

            const candidates = (rpc.data || []).filter(row => {
                if (row.reason_code === 'STUCK_PROCESSING') return row.age_seconds > staleHours * 3600;
                if (row.reason_code === 'MANUAL_REVIEW')   return row.age_seconds > staleHours * 3600;
                return false;
            });

            const results = [];
            for (const c of candidates) {
                try {
                    const r = await svc.refundOrder({
                        orderId: c.order_id,
                        ctx: ctxFrom(req),
                        reason: `Stale order auto-resolve (>${staleHours}h): ${reason}`,
                        confirmCodeWasReceived: false
                    });
                    results.push({ id: c.order_id, ok: true, already: !!r.already, refund: r.refund });
                } catch (e) {
                    // If the order has no ledger transaction, it was never
                    // debited — mark it failed instead of refunding.
                    if (e.code === 'NO_TRANSACTION' || e.code === 'NOT_REFUNDABLE') {
                        try {
                            await svc.changeStatus({
                                orderId: c.order_id,
                                nextStatus: 'failed',
                                ctx: ctxFrom(req),
                                reason: `Stale order (>${staleHours}h) had no debit; marked failed. Original: ${reason}`
                            });
                            results.push({ id: c.order_id, ok: true, action: 'marked_failed', reason: e.code });
                        } catch (e2) {
                            results.push({ id: c.order_id, ok: false, code: e2.code || 'FAILED', message: SAFE_MESSAGES[e2.code] || e2.message });
                        }
                    } else {
                        results.push({ id: c.order_id, ok: false, code: e.code || 'FAILED', message: SAFE_MESSAGES[e.code] || e.message });
                    }
                }
            }

            return {
                data: {
                    total: results.length,
                    succeeded: results.filter(r => r.ok).length,
                    failed: results.filter(r => !r.ok).length,
                    stale_hours: staleHours,
                    results
                }
            };
        });
    }
);

router.post(
    '/virtual-sms/provider/breaker/reset',
    requirePermission(PERMISSIONS.PROVIDERS_MANAGE),
    async (req, res) => {
        await withMutation(req, res, async () => {
            const reason = requireReason(req.body);
            const result = await svc.resetBreaker({ ctx: ctxFrom(req), reason });
            return { data: result };
        });
    }
);

module.exports = router;