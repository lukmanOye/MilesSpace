// routes/admin/giftCardAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Gift Cards API — routes only.
//
//   GET  /api/admin/gift-cards/summary
//   GET  /api/admin/gift-cards/orders
//   GET  /api/admin/gift-cards/orders/:id
//   POST /api/admin/gift-cards/orders/:id/reveal-code
//   POST /api/admin/gift-cards/orders/:id/retry
//   POST /api/admin/gift-cards/orders/:id/refund
//   POST /api/admin/gift-cards/orders/:id/sync
//   GET  /api/admin/gift-cards/products
//   PUT  /api/admin/gift-cards/products/:id/enabled
//   GET  /api/admin/gift-cards/provider/health
//
// NEW (Batch 2):
//   GET  /api/admin/gift-cards/catalog
//   POST /api/admin/gift-cards/products/import
//   PUT  /api/admin/gift-cards/products/:id/pricing
//   PUT  /api/admin/gift-cards/products/:id
//   POST /api/admin/gift-cards/pricing/preview
//   GET  /api/admin/gift-cards/pricing
//   PUT  /api/admin/gift-cards/pricing
//   POST /api/admin/gift-cards/products/refresh-costs
//
// REMOVED in this revision:
//   router.post('/services/:id', ... boost_services ...) — did not
//   belong here, used supabaseAdmin without importing it, and
//   returned raw error.message. Belongs in a boost admin router.
//   TODO: move to routes/admin/boostAdminRoutes.js when that file
//   exists.
//
// Response shape (single canonical form):
//   Success:  { success: true, data: {...} }
//   Error:    { success: false, code, message, request_id }
//
// All pricing flows through services/giftCardAdminService which
// itself flows through services/pricingEngine. The route never
// touches money math.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { requireStepUpAuth } = require('../../middleware/adminStepUp');

const giftCards = require('../../services/giftCardService');
const adminService = require('../../services/giftCardAdminService');
const dtoneService = require('../../services/dtoneService');

// ─── Identifier validation ───────────────────────────────────────
// gift_card_orders.id and gift_card_products.id are BIGINT in this
// deployment. If you migrate to UUID later, swap this regex for the
// UUID pattern in ONE place.
const ORDER_ID_RE = /^\d{1,19}$/;
const PRODUCT_ID_RE = /^\d{1,19}$/;

// ─── Rate limiting (in-memory, per admin) ────────────────────────
// The route module owns its buckets. moneyAdminRoutes has its own.
const _buckets = new Map();
function rateLimit({ key, max, windowMs }) {
    return (req, res, next) => {
        const k = `${key}:${req.adminContext?.id || req.ip || 'anon'}`;
        const now = Date.now();
        let bucket = _buckets.get(k);
        if (!bucket || now > bucket.resetAt) {
            bucket = { count: 1, resetAt: now + windowMs };
            _buckets.set(k, bucket);
            return next();
        }
        bucket.count++;
        if (bucket.count > max) {
            const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
            res.setHeader('Retry-After', String(retryAfter));
            const e = new Error(`Too many requests. Retry in ${retryAfter}s.`);
            e.status = 429; e.code = 'REFRESH_RATE_LIMITED';
            return sendErr(res, req, e);
        }
        next();
    };
}
setInterval(() => {
    const now = Date.now();
    for (const [k, b] of _buckets.entries()) {
        if (now > b.resetAt) _buckets.delete(k);
    }
}, 60_000).unref?.();

// ─── Request ID middleware (per request) ─────────────────────────
router.use((req, res, next) => {
    req.gcRequestId = req.headers['x-request-id']
        || `GC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    res.setHeader('X-Request-ID', req.gcRequestId);
    next();
});

// ─── Response helpers ────────────────────────────────────────────

function sendOk(res, payload) {
    if (res.headersSent) return;
    res.json({ success: true, data: payload });
}

// Safe messages keyed by stable code. Never send raw err.message.
const SAFE_MESSAGES = {
    INVALID_ID:                 'Invalid identifier.',
    INVALID_DATE:               'Invalid date.',
    INVALID_DATE_RANGE:         'from must be before to.',
    REASON_REQUIRED:            'A reason is required.',
    NOT_FOUND:                  'Resource not found.',
    GCO_NOT_FOUND:              'Gift card order not found.',
    GCP_NOT_FOUND:              'Gift card product not found.',
    PRODUCT_NOT_FOUND:          'Gift card product not found.',
    NO_DELIVERY:                'No delivery is available for this order.',
    ALREADY_COMPLETED:          'This order is already completed.',
    ALREADY_REFUNDED:           'This order is already refunded.',
    IN_REFUND_STATE:            'This order is in a refund state.',
    NOT_REFUNDABLE:             'This order is not eligible for a refund.',
    NO_TRANSACTION:             'This order has no associated wallet transaction.',
    TX_NOT_FOUND:               'The original transaction could not be found.',
    TX_NOT_REFUNDABLE:          'The original transaction is not refundable.',
    TX_NOT_DEBIT:               'The original transaction is not a wallet debit.',
    MISSING_ORDER_DATA:         'Order is missing required data.',
    MISSING_PRODUCT_ID:         'Order is missing the provider product id.',
    ORDER_STATE_CHANGED:        'The order changed before this action completed. Reload and try again.',
    INVALID_STATUS_TRANSITION:  'That status change is not allowed.',
    PRODUCT_CHANGED:            'The product changed before this action completed.',
    AUDIT_WRITE_FAILED:         'The action was aborted because the audit log could not be written.',
    LEDGER_REFUND_FAILED:       'The wallet refund could not be completed.',
    DELIVERY_WRITE_FAILED:      'The delivery could not be persisted.',
    PROVIDER_QUERY_FAILED:      'The provider could not be reached.',
    PROVIDER_STATE_UNKNOWN:     'The provider state is unknown — reconciliation is required.',
    PROVIDER_PURCHASE_FAILED:   'The provider rejected the purchase request.',
    INVALID_ENABLED:            'The enabled field must be a boolean.',
    IDEMPOTENCY_CONFLICT:       'This request key was already used with different parameters.',
    IDEMPOTENCY_IN_PROGRESS:    'A matching request is already in progress.',
    UNKNOWN_ERROR:              'An unexpected error occurred.',
    DB_ERROR:                   'A database error occurred.',

    // Batch 2 additions
    INVALID_COUNTRY:            'Country must be a 3-letter ISO code.',
    INVALID_DECIMAL:            'Not a valid decimal value.',
    PRICING_BELOW_COST:         'Price is below provider cost. Pass allow_below_cost:true to override.',
    PRICING_BELOW_MIN_MARGIN:   'Price yields a margin below the minimum.',
    PRICING_INVALID_MODE:       'Mode must be one of: global, markup_pct, fixed_ngn, fixed_usd.',
    PRICING_INVALID_VALUE:      'The pricing value is invalid for this mode.',
    OPTIMISTIC_LOCK_FAILED:     'Product was modified by another admin. Reload and retry.',
    IMPORT_EMPTY:               'No provider_product_ids provided.',
    CATALOG_TRUNCATED:          'The provider catalog was truncated. Narrow your filters.',
    REFRESH_RATE_LIMITED:       'Rate limited. Try again shortly.',
    CONFIG_VERSION_REQUIRED:    'expectedVersion is required. Reload settings and retry.',
    CONFIG_VERSION_CONFLICT:    'Another admin saved this section first. Reload and retry.',
    VALIDATION_ERROR:           'One or more fields failed validation.',
    PERMISSION_DENIED:          'You do not have permission to perform this action.'
};

function sendErr(res, req, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'GIFTCARD_ERROR';
    const clientMessage = SAFE_MESSAGES[code] || 'Gift card request failed.';

    // Full detail goes to the server log, correlated by request id.
    if (status >= 500 || !SAFE_MESSAGES[code]) {
        console.error('[ADMIN GIFTCARD]', req.gcRequestId, code, err?.message || err);
    }

    const body = {
        success: false,
        code,
        message: clientMessage,
        request_id: req.gcRequestId
    };
    if (err?.allowed_transitions) body.allowed_transitions = err.allowed_transitions;
    if (err?.current_status) body.current_status = err.current_status;
    if (err?.expected_status) body.expected_status = err.expected_status;
    if (err?.current_updated_at) body.current_updated_at = err.current_updated_at;
    if (err?.current_version != null) body.current_version = err.current_version;
    if (err?.price) body.price = err.price;
    if (err?.cost) body.cost = err.cost;
    if (err?.min_margin_pct) body.min_margin_pct = err.min_margin_pct;
    if (err?.value) body.value = err.value;

    res.status(status).json(body);
}

function ctxFrom(req) {
    return {
        adminId: req.adminContext?.id || null,
        adminEmail: req.adminContext?.email || null,
        adminRole: req.adminContext?.role || null,
        ip: req.ip || req.headers['x-forwarded-for'] || null,
        userAgent: req.headers['user-agent'] || null,
        requestId: req.gcRequestId
    };
}

// ─── Validation helpers ─────────────────────────────────────────

function validateOrderId(req, res, next) {
    const raw = String(req.params.id || '');
    if (!ORDER_ID_RE.test(raw)) {
        const e = new Error('Invalid order identifier.');
        e.status = 400;
        e.code = 'INVALID_ID';
        return sendErr(res, req, e);
    }
    next();
}

function validateProductId(req, res, next) {
    const raw = String(req.params.id || '');
    if (!PRODUCT_ID_RE.test(raw)) {
        const e = new Error('Invalid product identifier.');
        e.status = 400;
        e.code = 'INVALID_ID';
        return sendErr(res, req, e);
    }
    next();
}

function validateQueryDates(req, res, next) {
    const { from, to } = req.query;
    if (from) {
        const d = new Date(from);
        if (isNaN(d.getTime())) {
            const e = new Error('Invalid from date.');
            e.status = 422; e.code = 'INVALID_DATE';
            return sendErr(res, req, e);
        }
    }
    if (to) {
        const d = new Date(to);
        if (isNaN(d.getTime())) {
            const e = new Error('Invalid to date.');
            e.status = 422; e.code = 'INVALID_DATE';
            return sendErr(res, req, e);
        }
    }
    if (from && to && new Date(from) > new Date(to)) {
        const e = new Error('from must be before to.');
        e.status = 422; e.code = 'INVALID_DATE_RANGE';
        return sendErr(res, req, e);
    }
    next();
}

// ─── Idempotency (unchanged from previous revision) ─────────────

function hashRequest({ adminId, endpoint, body, params, query }) {
    const canonical = JSON.stringify({
        adminId,
        endpoint,
        body: body || {},
        params: params || {},
        query: query || {}
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function withIdempotency({ req, operationName }) {
    const key = req.headers['idempotency-key'];
    if (!key || String(key).length < 8) {
        return { fresh: true, enabled: false };
    }

    const adminId = req.adminContext?.id || 'anon';
    const endpoint = `${req.method} ${req.baseUrl}${req.path.replace(/\/\d+(\/|$)/, '/:id$1')}`;
    const idemKey = String(key).slice(0, 200);
    const requestHash = hashRequest({
        adminId,
        endpoint,
        body: req.body,
        params: { id: req.params.id },
        query: { operation: operationName }
    });

    const { supabaseAdmin } = require('../../db/supabase');

    const { data: existing, error: lookupErr } = await supabaseAdmin
        .from('admin_idempotency')
        .select('id, request_hash, status, response, expires_at')
        .eq('admin_id', adminId)
        .eq('endpoint', endpoint)
        .eq('idempotency_key', idemKey)
        .maybeSingle();

    if (lookupErr) {
        const e = new Error('Idempotency lookup failed.');
        e.status = 500; e.code = 'IDEMPOTENCY_LOOKUP_FAILED';
        e.cause = lookupErr.message;
        throw e;
    }

    if (existing && (!existing.expires_at || new Date(existing.expires_at) > new Date())) {
        if (existing.request_hash && existing.request_hash !== requestHash) {
            const e = new Error('Idempotency key reused with different parameters.');
            e.status = 409; e.code = 'IDEMPOTENCY_CONFLICT';
            throw e;
        }
        if (existing.status === 'completed' && existing.response) {
            return { fresh: false, replay: existing.response, enabled: true };
        }
        if (existing.status === 'processing') {
            const e = new Error('A matching request is already in progress.');
            e.status = 409; e.code = 'IDEMPOTENCY_IN_PROGRESS';
            throw e;
        }
    }

    const insertRow = {
        admin_id: adminId,
        endpoint,
        idempotency_key: idemKey,
        request_hash: requestHash,
        status: 'processing',
        response: null,
        status_code: null,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };

    const { error: insertErr } = await supabaseAdmin
        .from('admin_idempotency')
        .insert(insertRow);

    if (insertErr) {
        if (String(insertErr.code) === '23505') {
            const { data: re } = await supabaseAdmin
                .from('admin_idempotency')
                .select('status, response, request_hash')
                .eq('admin_id', adminId)
                .eq('endpoint', endpoint)
                .eq('idempotency_key', idemKey)
                .maybeSingle();
            if (re?.status === 'completed' && re.response) {
                return { fresh: false, replay: re.response, enabled: true };
            }
            const e = new Error('A matching request is already in progress.');
            e.status = 409; e.code = 'IDEMPOTENCY_IN_PROGRESS';
            throw e;
        }
        const e = new Error('Idempotency claim failed.');
        e.status = 500; e.code = 'IDEMPOTENCY_CLAIM_FAILED';
        e.cause = insertErr.message;
        throw e;
    }

    return {
        fresh: true,
        enabled: true,
        persist: async (response, statusCode = 200) => {
            const { error: updErr } = await supabaseAdmin
                .from('admin_idempotency')
                .update({
                    status: 'completed',
                    response,
                    status_code: statusCode
                })
                .eq('admin_id', adminId)
                .eq('endpoint', endpoint)
                .eq('idempotency_key', idemKey);
            if (updErr) {
                console.warn('[ADMIN GIFTCARD] idempotency persist failed:', updErr.message);
            }
        },
        fail: async () => {
            await supabaseAdmin
                .from('admin_idempotency')
                .update({ status: 'failed' })
                .eq('admin_id', adminId)
                .eq('endpoint', endpoint)
                .eq('idempotency_key', idemKey);
        }
    };
}

// ═════════════════════════════════════════════════════════════════
//  SUMMARY
// ═════════════════════════════════════════════════════════════════

router.get(
    '/gift-cards/summary',
    requirePermission(PERMISSIONS.SERVICES_READ),
    validateQueryDates,
    async (req, res) => {
        try {
            const summary = await giftCards.getSummary({
                from: req.query.from || null,
                to: req.query.to || null
            });
            sendOk(res, { summary });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  ORDERS
// ═════════════════════════════════════════════════════════════════

router.get(
    '/gift-cards/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    validateQueryDates,
    async (req, res) => {
        try {
            const result = await giftCards.listOrders({
                page: parseInt(req.query.page, 10) || 1,
                limit: parseInt(req.query.limit, 10) || 25,
                status: req.query.status || null,
                brand: req.query.brand || null,
                country: req.query.country || null,
                provider: req.query.provider || null,
                user_id: req.query.user_id || null,
                from: req.query.from || null,
                to: req.query.to || null,
                search: req.query.search || null
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/gift-cards/orders/:id',
    requirePermission(PERMISSIONS.ORDERS_READ),
    validateOrderId,
    async (req, res) => {
        try {
            const data = await giftCards.getOrder(req.params.id);
            sendOk(res, data);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ─── Reveal code ─────────────────────────────────────────────────
router.post(
    '/gift-cards/orders/:id/reveal-code',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    validateOrderId,
    async (req, res) => {
        let idem = null;
        try {
            idem = await withIdempotency({ req, operationName: 'reveal-code' });
            if (!idem.fresh) return res.json(idem.replay);

            const data = await giftCards.revealDeliveryCode({
                orderId: req.params.id,
                ctx: ctxFrom(req)
            });
            const response = { success: true, data };
            if (idem.enabled) await idem.persist(response, 200);
            sendOk(res, data);
        } catch (err) {
            if (idem?.enabled) await idem.fail?.();
            sendErr(res, req, err);
        }
    }
);

// ─── Retry ───────────────────────────────────────────────────────
router.post(
    '/gift-cards/orders/:id/retry',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    validateOrderId,
    async (req, res) => {
        let idem = null;
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }

            idem = await withIdempotency({ req, operationName: 'retry' });
            if (!idem.fresh) return res.json(idem.replay);

            const result = await giftCards.retryOrder({
                orderId: req.params.id,
                reason: String(reason).slice(0, 500),
                ctx: ctxFrom(req)
            });
            const response = { success: true, data: result };
            if (idem.enabled) await idem.persist(response, 200);
            sendOk(res, result);
        } catch (err) {
            if (idem?.enabled) await idem.fail?.();
            sendErr(res, req, err);
        }
    }
);

// ─── Refund ──────────────────────────────────────────────────────
router.post(
    '/gift-cards/orders/:id/refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    validateOrderId,
    async (req, res) => {
        let idem = null;
        try {
            const { reason } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }

            idem = await withIdempotency({ req, operationName: 'refund' });
            if (!idem.fresh) return res.json(idem.replay);

            const result = await giftCards.refundOrder({
                orderId: req.params.id,
                reason: String(reason).slice(0, 500),
                ctx: ctxFrom(req)
            });
            const response = { success: true, data: result };
            if (idem.enabled) await idem.persist(response, 200);
            sendOk(res, result);
        } catch (err) {
            if (idem?.enabled) await idem.fail?.();
            sendErr(res, req, err);
        }
    }
);

// ─── Sync ────────────────────────────────────────────────────────
// Read/reconciliation operation. Safe to call repeatedly. Not gated
// on Idempotency-Key because it does not create side effects.
router.post(
    '/gift-cards/orders/:id/sync',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    validateOrderId,
    async (req, res) => {
        try {
            const result = await giftCards.syncOrder({
                orderId: req.params.id,
                ctx: ctxFrom(req)
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  PRODUCTS — legacy enabled toggle (unchanged) + paginated list
// ═════════════════════════════════════════════════════════════════

router.get(
    '/gift-cards/products',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const result = await giftCards.listProducts({
                page: parseInt(req.query.page, 10) || 1,
                limit: parseInt(req.query.limit, 10) || 50,
                enabled: req.query.enabled || null,
                country: req.query.country || null,
                brand: req.query.brand || null,
                search: req.query.search || null
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.put(
    '/gift-cards/products/:id/enabled',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    validateProductId,
    async (req, res) => {
        let idem = null;
        try {
            const { enabled, reason } = req.body || {};
            if (typeof enabled !== 'boolean') {
                const e = new Error('enabled must be a boolean.');
                e.status = 422; e.code = 'INVALID_ENABLED';
                throw e;
            }
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }

            idem = await withIdempotency({ req, operationName: 'product-enabled' });
            if (!idem.fresh) return res.json(idem.replay);

            const result = await giftCards.setProductEnabled({
                productId: req.params.id,
                enabled,
                reason: String(reason).slice(0, 500),
                ctx: ctxFrom(req)
            });
            const response = { success: true, data: result };
            if (idem.enabled) await idem.persist(response, 200);
            sendOk(res, result);
        } catch (err) {
            if (idem?.enabled) await idem.fail?.();
            sendErr(res, req, err);
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  CATALOG — browse provider gift cards (Batch 2)
// ═════════════════════════════════════════════════════════════════

router.get(
    '/gift-cards/catalog',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const result = await adminService.getCatalog({
                country: req.query.country || null,
                subservice: req.query.subservice || null,
                search: req.query.search || null,
                page: parseInt(req.query.page, 10) || 1,
                limit: parseInt(req.query.limit, 10) || 50
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  IMPORT — pull provider catalog rows into gift_card_products
// ═════════════════════════════════════════════════════════════════

router.post(
    '/gift-cards/products/import',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    rateLimit({ key: 'import', max: 5, windowMs: 60_000 }),
    async (req, res) => {
        let idem = null;
        try {
            const { provider_product_ids, enable = false, reason } = req.body || {};
            if (!Array.isArray(provider_product_ids) || !provider_product_ids.length) {
                const e = new Error('provider_product_ids array is required.');
                e.status = 422; e.code = 'IMPORT_EMPTY';
                throw e;
            }
            if (provider_product_ids.length > 500) {
                const e = new Error('Cannot import more than 500 products at once.');
                e.status = 422; e.code = 'VALIDATION_ERROR';
                throw e;
            }
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }

            idem = await withIdempotency({ req, operationName: 'import' });
            if (!idem.fresh) return res.json(idem.replay);

            const result = await adminService.importProducts({
                providerProductIds: provider_product_ids.map(String),
                enable: Boolean(enable),
                reason: String(reason).slice(0, 500)
            }, ctxFrom(req));
            const response = { success: true, data: result };
            if (idem.enabled) await idem.persist(response, 200);
            sendOk(res, result);
        } catch (err) {
            if (idem?.enabled) await idem.fail?.();
            sendErr(res, req, err);
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  UPDATE PRICING — per-product mode/value
// ═════════════════════════════════════════════════════════════════

router.put(
    '/gift-cards/products/:id/pricing',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    validateProductId,
    async (req, res) => {
        let idem = null;
        try {
            const { mode, value, reason, expected_updated_at, allow_below_cost } = req.body || {};
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.');
                e.status = 422; e.code = 'REASON_REQUIRED';
                throw e;
            }

            idem = await withIdempotency({ req, operationName: 'pricing-update' });
            if (!idem.fresh) return res.json(idem.replay);

            const result = await adminService.updateProductPricing({
                productId: req.params.id,
                mode,
                value,
                reason: String(reason).slice(0, 500),
                expectedUpdatedAt: expected_updated_at || null,
                allowBelowCost: Boolean(allow_below_cost)
            }, ctxFrom(req));
            const response = { success: true, data: result };
            if (idem.enabled) await idem.persist(response, 200);
            sendOk(res, result);
        } catch (err) {
            if (idem?.enabled) await idem.fail?.();
            sendErr(res, req, err);
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  UPDATE PRODUCT — display_name, logo_url, featured, sort_order
// ═════════════════════════════════════════════════════════════════

router.put(
    '/gift-cards/products/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    validateProductId,
    async (req, res) => {
        let idem = null;
        try {
            const { display_name, logo_url, featured, sort_order } = req.body || {};

            idem = await withIdempotency({ req, operationName: 'product-update' });
            if (!idem.fresh) return res.json(idem.replay);

            const result = await adminService.updateProduct({
                productId: req.params.id,
                displayName: display_name,
                logoUrl:     logo_url,
                featured:    featured,
                sortOrder:   sort_order
            }, ctxFrom(req));
            const response = { success: true, data: result };
            if (idem.enabled) await idem.persist(response, 200);
            sendOk(res, result);
        } catch (err) {
            if (idem?.enabled) await idem.fail?.();
            sendErr(res, req, err);
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  PRICING PREVIEW — pure calculator, no DB writes
// ═════════════════════════════════════════════════════════════════

router.post(
    '/gift-cards/pricing/preview',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const { wholesale_amount, wholesale_currency, mode, value } = req.body || {};
            if (wholesale_amount == null) {
                const e = new Error('wholesale_amount is required.');
                e.status = 422; e.code = 'VALIDATION_ERROR';
                throw e;
            }
            const result = await adminService.previewPricing({
                wholesaleAmount: String(wholesale_amount),
                wholesaleCurrency: String(wholesale_currency || 'USD').toUpperCase(),
                mode: String(mode || 'global'),
                value
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GLOBAL PRICING CONFIG
// ═════════════════════════════════════════════════════════════════

router.get(
    '/gift-cards/pricing',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const result = await adminService.getPricingConfig();
            sendOk(res, result);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.put(
    '/gift-cards/pricing',
    requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    async (req, res) => {
        let idem = null;
        try {
            const { patch, reason, expectedVersion, confirmLargeChange } = req.body || {};
            idem = await withIdempotency({ req, operationName: 'pricing-config-update' });
            if (!idem.fresh) return res.json(idem.replay);

            const result = await adminService.updatePricingConfig({
                patch: patch || {},
                reason,
                expectedVersion,
                confirmLargeChange
            }, ctxFrom(req));
            const response = { success: true, data: result };
            if (idem.enabled) await idem.persist(response, 200);
            sendOk(res, result);
        } catch (err) {
            if (idem?.enabled) await idem.fail?.();
            sendErr(res, req, err);
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  REFRESH COSTS — re-read wholesale, recompute customer price
// ═════════════════════════════════════════════════════════════════

router.post(
    '/gift-cards/products/refresh-costs',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    rateLimit({ key: 'refresh-costs', max: 3, windowMs: 60_000 }),
    async (req, res) => {
        let idem = null;
        try {
            const { limit } = req.body || {};
            idem = await withIdempotency({ req, operationName: 'refresh-costs' });
            if (!idem.fresh) return res.json(idem.replay);

            const result = await adminService.refreshCosts(
                { limit: limit != null ? parseInt(limit, 10) : 25 },
                ctxFrom(req)
            );
            const response = { success: true, data: result };
            if (idem.enabled) await idem.persist(response, 200);
            sendOk(res, result);
        } catch (err) {
            if (idem?.enabled) await idem.fail?.();
            sendErr(res, req, err);
        }
    }
);

// ═════════════════════════════════════════════════════════════════
//  PROVIDER HEALTH
//  Response is normalized so no admin HTML ever sees 'DT One'.
// ═════════════════════════════════════════════════════════════════

router.get(
    '/gift-cards/provider/health',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    async (req, res) => {
        try {
            const raw = await giftCards.getProviderHealth();
            // Force the label — never leak the provider name to the UI.
            const health = {
                ...raw,
                label: 'Provider',
                // Preserve the internal-only name in a field the UI
                // never reads. Useful for server logs only.
                _internalProvider: raw?.provider || 'dtone'
            };
            delete health.provider;

            sendOk(res, { health });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  MISC
// ═════════════════════════════════════════════════════════════════

// Legacy stub: provider "test connection" button. Full adapter
// wiring is out of scope for Batch 2; the UI shows the safe message.
router.post(
    '/gift-cards/provider/health-check',
    requirePermission(PERMISSIONS.PROVIDERS_READ),
    rateLimit({ key: 'provider-health-check', max: 5, windowMs: 60_000 }),
    async (req, res) => {
        try {
            let reachable = false;
            let errorMessage = null;
            try {
                const balances = await dtoneService.getBalances();
                reachable = Boolean(balances?.success);
                errorMessage = reachable ? null : (balances?.error || 'Unknown');
            } catch (e) {
                errorMessage = e.message;
            }
            sendOk(res, {
                provider: 'Provider',
                reachable,
                errorMessage,
                checkedAt: new Date().toISOString()
            });
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  STRAY BOOST ROUTE — REMOVED
// ═════════════════════════════════════════════════════════════════
//
// The previous version of this file contained:
//
//   router.post('/services/:id', requirePermission(PERMISSIONS.BOOST_MANAGE), ...)
//
// That handler:
//   • Used supabaseAdmin without importing it
//   • Returned raw error.message to the client
//   • Operated on `boost_services`, not gift cards
//   • Sat on the wrong router entirely
//
// It has been deleted. The handler belongs in routes/admin/boostAdminRoutes.js
// (which does not yet exist). When you build that file, port it there
// with:
//   • const { supabaseAdmin } = require('../../db/supabase');
//   • SAFE_MESSAGES error handling (do not send raw error.message)
//   • requirePermission(PERMISSIONS.SERVICES_MANAGE) if BOOST_MANAGE
//     does not exist in your PERMISSIONS registry
//   • Proper payload validation (field length caps, numeric bounds)
//
// TODO: implement routes/admin/boostAdminRoutes.js and mount it in
// server.js under /api/admin/boost.

module.exports = router;