// routes/admin/esimAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin eSIM API.
//
// New in this revision:
//   • GET /esim/provider/balances — uncached balance read.
//   • GET /esim/provider/health accepts ?fresh=1 to bypass the 20s cache.
//   • GET /esim/catalog forwards coverage and hide_imported.
//   • GET /esim/products delegates to esim.listProducts() so margin
//     fields (margin_pct, below_cost, below_min_margin) are computed
//     server-side.
//   • Everything else preserved.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { supabaseAdmin } = require('../../db/supabase');
const esim = require('../../services/esimAdminService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use((req, res, next) => {
    req.esimRequestId = req.headers['x-request-id']
        || `ES-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    res.setHeader('X-Request-ID', req.esimRequestId);
    next();
});

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

const SAFE_MESSAGES = {
    INVALID_ID:                 'Invalid identifier.',
    REASON_REQUIRED:            'A reason is required.',
    ESIM_NOT_FOUND:             'eSIM order not found.',
    ALREADY_REFUNDED:           'This order is already refunded.',
    NOT_REFUNDABLE:             'This order is not eligible for a refund.',
    NOT_COMPLETED:              'This action requires a completed order.',
    NO_TRANSACTION:             'This order has no wallet transaction.',
    TX_NOT_FOUND:               'The original transaction could not be found.',
    TX_NOT_REFUNDABLE:          'The original transaction is not refundable.',
    ORDER_STATE_CHANGED:        'The order changed before this action completed. Reload and try again.',
    INVALID_STATUS_TRANSITION:  'That status change is not allowed.',
    AUDIT_WRITE_FAILED:         'The action was aborted because the audit log could not be written.',
    LEDGER_REFUND_FAILED:       'The wallet refund could not be completed.',
    REFUND_POST_CREDIT_FAILED:  'The refund was applied, but the order could not be finalized.',
    IDEMPOTENCY_CONFLICT:       'This idempotency key was already used with different parameters.',
    INVALID_COUNTRY:            'Country must be a 3-letter ISO code.',
    INVALID_DECIMAL:            'Not a valid decimal value.',
    PRICING_BELOW_COST:         'Price is below provider cost. Pass allow_below_cost:true to override.',
    PRICING_BELOW_MIN_MARGIN:   'Price yields a margin below the minimum.',
    PRICING_INVALID_MODE:       'Mode must be one of: global, markup_pct, fixed_ngn, fixed_usd.',
    PRICING_INVALID_VALUE:      'The pricing value is invalid for this mode.',
    OPTIMISTIC_LOCK_FAILED:     'Product was modified by another admin. Reload and retry.',
    IMPORT_EMPTY:               'No provider_product_ids provided.',
    REFRESH_RATE_LIMITED:       'Rate limited. Try again shortly.',
    CONFIG_VERSION_REQUIRED:    'expectedVersion is required. Reload settings and retry.',
    CONFIG_VERSION_CONFLICT:    'Another admin saved this section first. Reload and retry.',
    VALIDATION_ERROR:           'One or more fields failed validation.',
    PERMISSION_DENIED:          'You do not have permission to perform this action.',
    PRODUCT_NOT_FOUND:          'eSIM product not found.',
    PROVIDER_QUERY_FAILED:      'The provider could not be reached.',
    DB_ERROR:                   'A database error occurred.',
    ESIM_STATS_ERROR:           'Could not aggregate eSIM stats.',
    ESIM_LIST_ERROR:            'Could not load eSIM orders.',
    ESIM_DETAIL_ERROR:          'Could not load this eSIM order.',
    ESIM_UPDATE_ERROR:          'Could not update the eSIM order.',
    ESIM_ATTENTION_ERROR:       'Could not load the attention list.'
};

function sendOk(res, payload) {
    if (!res.headersSent) res.json({ success: true, data: payload });
}

function sendErr(res, req, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'ESIM_ERROR';
    const message = SAFE_MESSAGES[code] || 'eSIM request failed.';
    if (status >= 500 || !SAFE_MESSAGES[code]) {
        console.error('[ADMIN ESIM]', req.esimRequestId, code, err?.message || err);
    }
    const body = { success: false, code, message, request_id: req.esimRequestId };
    if (err?.allowed_transitions) body.allowed_transitions = err.allowed_transitions;
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
        adminId:    req.adminContext?.id    || null,
        adminEmail: req.adminContext?.email || null,
        adminRole:  req.adminContext?.role  || null,
        ip:         req.ip || req.headers['x-forwarded-for'] || null,
        userAgent:  req.headers['user-agent'] || null,
        requestId:  req.esimRequestId
    };
}

function hashRequest({ adminId, endpoint, body, params, query }) {
    const canonical = JSON.stringify({ adminId, endpoint, body: body || {}, params: params || {}, query: query || {} });
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function withIdempotency({ req, operationName }) {
    const key = req.headers['idempotency-key'];
    if (!key || String(key).length < 8) return { fresh: true, enabled: false };

    const adminId = req.adminContext?.id || 'anon';
    const endpoint = `${req.method} ${req.baseUrl}${req.path.replace(/\/[0-9a-f-]+(\/|$)/i, '/:id$1')}`;
    const idemKey = String(key).slice(0, 200);
    const requestHash = hashRequest({ adminId, endpoint, body: req.body, params: { id: req.params.id }, query: { operation: operationName } });

    const { data: existing, error: lookupErr } = await supabaseAdmin
        .from('admin_idempotency')
        .select('id, request_hash, status, response, expires_at')
        .eq('admin_id', adminId)
        .eq('endpoint', endpoint)
        .eq('idempotency_key', idemKey)
        .maybeSingle();

    if (lookupErr) {
        const e = new Error('Idempotency lookup failed.');
        e.status = 500; e.code = 'IDEMPOTENCY_LOOKUP_FAILED'; throw e;
    }

    if (existing && (!existing.expires_at || new Date(existing.expires_at) > new Date())) {
        if (existing.request_hash && existing.request_hash !== requestHash) {
            const e = new Error('Idempotency key reused with different parameters.');
            e.status = 409; e.code = 'IDEMPOTENCY_CONFLICT'; throw e;
        }
        if (existing.status === 'completed' && existing.response) {
            return { fresh: false, replay: existing.response, enabled: true };
        }
    }

    const insertRow = {
        admin_id: adminId, endpoint,
        idempotency_key: idemKey,
        request_hash: requestHash,
        status: 'processing',
        response: null,
        status_code: null,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };

    const { error: insertErr } = await supabaseAdmin.from('admin_idempotency').insert(insertRow);
    
    if (insertErr) {
        if (String(insertErr.code) === '23505') {
            // Duplicate key - safe to proceed if the previous attempt failed or expired
            const { data: row } = await supabaseAdmin
                .from('admin_idempotency')
                .select('status, response, created_at')
                .eq('admin_id', adminId).eq('endpoint', endpoint).eq('idempotency_key', idemKey)
                .maybeSingle();
            if (row?.status === 'completed' && row.response) {
                return { fresh: false, replay: row.response, enabled: true };
            }
            if (row?.status === 'processing' && Date.now() - new Date(row.created_at).getTime() < 30000) {
                const e = new Error('In progress.'); e.status = 409; e.code = 'IDEMPOTENCY_IN_PROGRESS'; throw e;
            }
            // Reclaim it
            await supabaseAdmin.from('admin_idempotency')
                .update({ status: 'processing', request_hash: requestHash, response: null })
                .eq('admin_id', adminId).eq('endpoint', endpoint).eq('idempotency_key', idemKey);
        } else {
            // THIS IS THE IMPORTANT PART - Log the real reason
            console.error('[ESIM IDEMPOTENCY] claim failed:', insertErr.code, insertErr.message, insertErr.details, insertErr.hint);
            const e = new Error('Idempotency claim failed.');
            e.status = 500; e.code = 'IDEMPOTENCY_CLAIM_FAILED'; throw e;
        }
    }

    return {
        fresh: true, enabled: true,
        persist: async (response) => {
            await supabaseAdmin
                .from('admin_idempotency')
                .update({ status: 'completed', response })
                .eq('admin_id', adminId).eq('endpoint', endpoint).eq('idempotency_key', idemKey);
        },
        fail: async () => {
            await supabaseAdmin
                .from('admin_idempotency')
                .update({ status: 'failed' })
                .eq('admin_id', adminId).eq('endpoint', endpoint).eq('idempotency_key', idemKey);
        }
    };
}
// ─── Stats / Orders / Detail ────────────────────────────────────

router.get('/esim/stats', requirePermission(PERMISSIONS.SERVICES_READ), async (req, res) => {
    try {
        const stats = await esim.getStats({ from: req.query.from || null, to: req.query.to || null });
        sendOk(res, stats);
    } catch (err) { sendErr(res, req, err); }
});

router.get('/esim/orders', requirePermission(PERMISSIONS.ORDERS_READ), async (req, res) => {
    try {
        const result = await esim.listOrders({
            page: parseInt(req.query.page, 10) || 1,
            limit: parseInt(req.query.limit, 10) || 25,
            status: req.query.status || null,
            delivery_status: req.query.delivery_status || null,
            country: req.query.country || null,
            user_id: req.query.user_id || null,
            from: req.query.from || null,
            to: req.query.to || null,
            search: req.query.search || null
        });
        sendOk(res, result);
    } catch (err) { sendErr(res, req, err); }
});

router.get('/esim/orders/:id', requirePermission(PERMISSIONS.ORDERS_READ), async (req, res, next) => {
    if (!UUID_RE.test(String(req.params.id || ''))) return next();
    try {
        const data = await esim.getOrder(req.params.id, { revealSensitive: false });
        sendOk(res, data);
    } catch (err) { sendErr(res, req, err); }
});

router.post('/esim/orders/:id/reveal', requirePermission(PERMISSIONS.ORDERS_RESOLVE), async (req, res, next) => {
    if (!UUID_RE.test(String(req.params.id || ''))) return next();
    try {
        const data = await esim.revealActivation({ orderId: req.params.id, ctx: ctxFrom(req) });
        sendOk(res, data);
    } catch (err) { sendErr(res, req, err); }
});

router.post('/esim/orders/:id/sync', requirePermission(PERMISSIONS.ORDERS_RESOLVE), async (req, res, next) => {
    if (!UUID_RE.test(String(req.params.id || ''))) return next();
    try {
        const result = await esim.syncOrder({ orderId: req.params.id, ctx: ctxFrom(req) });
        sendOk(res, result);
    } catch (err) { sendErr(res, req, err); }
});

router.post('/esim/orders/:id/refund', requirePermission(PERMISSIONS.TRANSACTIONS_REFUND), async (req, res, next) => {
    if (!UUID_RE.test(String(req.params.id || ''))) return next();
    try {
        const { reason } = req.body || {};
        if (!reason || String(reason).trim().length < 4) {
            const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
        }
        const idem = await withIdempotency({ req, operationName: 'esim-refund' });
        if (!idem.fresh) return res.json(idem.replay);
        try {
            const result = await esim.refundOrder({ orderId: req.params.id, reason: String(reason).slice(0, 500), ctx: ctxFrom(req) });
            const response = { success: true, data: result };
            await idem.persist?.(response);
            sendOk(res, result);
        } catch (inner) { await idem.fail?.(); throw inner; }
    } catch (err) { sendErr(res, req, err); }
});

router.post('/esim/orders/:id/review', requirePermission(PERMISSIONS.ORDERS_RESOLVE), async (req, res, next) => {
    if (!UUID_RE.test(String(req.params.id || ''))) return next();
    try {
        const { reason } = req.body || {};
        if (!reason || String(reason).trim().length < 4) {
            const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
        }
        const idem = await withIdempotency({ req, operationName: 'esim-review' });
        if (!idem.fresh) return res.json(idem.replay);
        try {
            const result = await esim.reviewOrder({ orderId: req.params.id, reason: String(reason).slice(0, 500), ctx: ctxFrom(req) });
            const response = { success: true, data: result };
            await idem.persist?.(response);
            sendOk(res, result);
        } catch (inner) { await idem.fail?.(); throw inner; }
    } catch (err) { sendErr(res, req, err); }
});

router.get('/esim/attention', requirePermission(PERMISSIONS.SERVICES_READ), async (req, res) => {
    try {
        const result = await esim.getAttention({ limit: parseInt(req.query.limit, 10) || 100 });
        sendOk(res, result);
    } catch (err) { sendErr(res, req, err); }
});

// ─── Provider ───────────────────────────────────────────────────

router.get('/esim/provider/health', requirePermission(PERMISSIONS.PROVIDERS_READ), async (req, res) => {
    try {
        const fresh = String(req.query.fresh || '') === '1';
        const health = await esim.getProviderHealth({ fresh });
        sendOk(res, { health });
    } catch (err) { sendErr(res, req, err); }
});

router.get('/esim/provider/balances', requirePermission(PERMISSIONS.PROVIDERS_READ), async (req, res) => {
    try {
        const result = await esim.getProviderBalances();
        sendOk(res, result);
    } catch (err) { sendErr(res, req, err); }
});

router.post('/esim/provider/health-check', requirePermission(PERMISSIONS.PROVIDERS_READ), async (req, res) => {
    try {
        const result = await esim.healthCheckProvider({ ctx: ctxFrom(req) });
        sendOk(res, result);
    } catch (err) { sendErr(res, req, err); }
});

// ─── Products ───────────────────────────────────────────────────

router.get('/esim/products', requirePermission(PERMISSIONS.SERVICES_READ), async (req, res) => {
    try {
        const result = await esim.listProducts({
            page: parseInt(req.query.page, 10) || 1,
            limit: parseInt(req.query.limit, 10) || 50,
            enabled: req.query.enabled || null,
            featured: req.query.featured || null,
            coverage_type: req.query.coverage_type || null,
            search: req.query.search || null
        });
        sendOk(res, result);
    } catch (err) { sendErr(res, req, err); }
});

router.put('/esim/products/:id/enabled', requirePermission(PERMISSIONS.SERVICES_MANAGE), async (req, res) => {
    if (!UUID_RE.test(String(req.params.id || ''))) {
        const e = new Error('Invalid product id.'); e.status = 400; e.code = 'INVALID_ID'; return sendErr(res, req, e);
    }
    try {
        const { enabled, reason } = req.body || {};
        if (typeof enabled !== 'boolean') {
            const e = new Error('enabled must be a boolean.'); e.status = 422; e.code = 'VALIDATION_ERROR'; throw e;
        }
        if (!reason || String(reason).trim().length < 4) {
            const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
        }

        const { data: before } = await supabaseAdmin
            .from('esim_products').select('id, enabled, name, display_name').eq('id', req.params.id).maybeSingle();
        if (!before) {
            const e = new Error('Product not found.'); e.status = 404; e.code = 'PRODUCT_NOT_FOUND'; throw e;
        }

        const { data: updated, error } = await supabaseAdmin
            .from('esim_products')
            .update({ enabled, updated_at: new Date().toISOString() })
            .eq('id', req.params.id)
            .select('id, enabled').maybeSingle();
        if (error) throw error;

        const { error: auditErr } = await supabaseAdmin
            .from('admin_audit_logs')
            .insert({
                admin_id:    req.adminContext.id,
                admin_email: req.adminContext.email,
                action:      `esim.product_${enabled ? 'enabled' : 'disabled'}`,
                target_type: 'esim_product',
                target_id:   req.params.id,
                before:      { enabled: before.enabled },
                after:       { enabled },
                reason:      String(reason).slice(0, 500),
                ip_address:  req.ip || null,
                user_agent:  req.headers['user-agent'] || null,
                request_id:  req.esimRequestId,
                created_at:  new Date().toISOString()
            });
        if (auditErr) {
            console.error('[ADMIN ESIM] audit failed:', auditErr.message);
            const e = new Error('Audit logging failed.'); e.status = 500; e.code = 'AUDIT_WRITE_FAILED'; throw e;
        }

        sendOk(res, { id: updated.id, enabled: updated.enabled });
    } catch (err) { sendErr(res, req, err); }
});

router.get('/esim/catalog', requirePermission(PERMISSIONS.SERVICES_READ), async (req, res) => {
    try {
        const result = await esim.getCatalog({
            country: req.query.country || null,
            region: req.query.region || null,
            search: req.query.search || null,
            coverage: req.query.coverage || null,
            hide_imported: req.query.hide_imported || null,
            page: parseInt(req.query.page, 10) || 1,
            limit: parseInt(req.query.limit, 10) || 50
        });
        sendOk(res, result);
    } catch (err) { sendErr(res, req, err); }
});

router.post('/esim/products/import',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    rateLimit({ key: 'esim-import', max: 5, windowMs: 60_000 }),
    async (req, res) => {
        let idem = null;
        try {
            const { provider_product_ids, enable = false, reason } = req.body || {};
            if (!Array.isArray(provider_product_ids) || !provider_product_ids.length) {
                const e = new Error('provider_product_ids array is required.');
                e.status = 422; e.code = 'IMPORT_EMPTY'; throw e;
            }
            if (provider_product_ids.length > 500) {
                const e = new Error('Cannot import more than 500 products at once.');
                e.status = 422; e.code = 'VALIDATION_ERROR'; throw e;
            }
            if (!reason || String(reason).trim().length < 4) {
                const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
            }

            idem = await withIdempotency({ req, operationName: 'esim-import' });
            if (!idem.fresh) return res.json(idem.replay);

            const result = await esim.importProducts({
                providerProductIds: provider_product_ids.map(String),
                enable: Boolean(enable),
                reason: String(reason).slice(0, 500)
            }, ctxFrom(req));
            const response = { success: true, data: result };
            await idem.persist?.(response);
            sendOk(res, result);
        } catch (err) {
            await idem?.fail?.();
            sendErr(res, req, err);
        }
    }
);

router.put('/esim/products/:id/pricing', requirePermission(PERMISSIONS.SERVICES_MANAGE), async (req, res) => {
    if (!UUID_RE.test(String(req.params.id || ''))) {
        const e = new Error('Invalid product id.'); e.status = 400; e.code = 'INVALID_ID'; return sendErr(res, req, e);
    }
    let idem = null;
    try {
        const { mode, value, reason, expected_updated_at, allow_below_cost } = req.body || {};
        if (!reason || String(reason).trim().length < 4) {
            const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
        }

        idem = await withIdempotency({ req, operationName: 'esim-pricing-update' });
        if (!idem.fresh) return res.json(idem.replay);

        const result = await esim.updateProductPricing({
            productId: req.params.id,
            mode, value,
            reason: String(reason).slice(0, 500),
            expectedUpdatedAt: expected_updated_at || null,
            allowBelowCost: Boolean(allow_below_cost)
        }, ctxFrom(req));
        const response = { success: true, data: result };
        await idem.persist?.(response);
        sendOk(res, result);
    } catch (err) {
        await idem?.fail?.();
        sendErr(res, req, err);
    }
});

router.put('/esim/products/:id', requirePermission(PERMISSIONS.SERVICES_MANAGE), async (req, res) => {
    if (!UUID_RE.test(String(req.params.id || ''))) {
        const e = new Error('Invalid product id.'); e.status = 400; e.code = 'INVALID_ID'; return sendErr(res, req, e);
    }
    let idem = null;
    try {
        const { display_name, logo_url, featured, sort_order } = req.body || {};
        idem = await withIdempotency({ req, operationName: 'esim-product-update' });
        if (!idem.fresh) return res.json(idem.replay);

        const result = await esim.updateProduct({
            productId: req.params.id,
            displayName: display_name,
            logoUrl: logo_url,
            featured,
            sortOrder: sort_order
        }, ctxFrom(req));
        const response = { success: true, data: result };
        await idem.persist?.(response);
        sendOk(res, result);
    } catch (err) {
        await idem?.fail?.();
        sendErr(res, req, err);
    }
});

router.post('/esim/pricing/preview', requirePermission(PERMISSIONS.SERVICES_READ), async (req, res) => {
    try {
        const { wholesale_amount, wholesale_currency, mode, value } = req.body || {};
        if (wholesale_amount == null) {
            const e = new Error('wholesale_amount is required.'); e.status = 422; e.code = 'VALIDATION_ERROR'; throw e;
        }
        const result = await esim.previewPricing({
            wholesaleAmount: String(wholesale_amount),
            wholesaleCurrency: String(wholesale_currency || 'USD').toUpperCase(),
            mode: String(mode || 'global'),
            value
        });
        sendOk(res, result);
    } catch (err) { sendErr(res, req, err); }
});

router.get('/esim/pricing', requirePermission(PERMISSIONS.SERVICES_READ), async (req, res) => {
    try {
        const result = await esim.getPricingConfig();
        sendOk(res, result);
    } catch (err) { sendErr(res, req, err); }
});

router.put('/esim/pricing', requirePermission(PERMISSIONS.SETTINGS_MANAGE), async (req, res) => {
    let idem = null;
    try {
        const { patch, reason, expectedVersion, confirmLargeChange } = req.body || {};
        idem = await withIdempotency({ req, operationName: 'esim-pricing-config-update' });
        if (!idem.fresh) return res.json(idem.replay);

        const result = await esim.updatePricingConfig({
            patch: patch || {},
            reason,
            expectedVersion,
            confirmLargeChange
        }, ctxFrom(req));
        const response = { success: true, data: result };
        await idem.persist?.(response);
        sendOk(res, result);
    } catch (err) {
        await idem?.fail?.();
        sendErr(res, req, err);
    }
});

router.post('/esim/products/refresh-costs',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    rateLimit({ key: 'esim-refresh-costs', max: 3, windowMs: 60_000 }),
    async (req, res) => {
        let idem = null;
        try {
            const { limit } = req.body || {};
            idem = await withIdempotency({ req, operationName: 'esim-refresh-costs' });
            if (!idem.fresh) return res.json(idem.replay);

            const result = await esim.refreshCosts(
                { limit: limit != null ? parseInt(limit, 10) : 25 },
                ctxFrom(req)
            );
            const response = { success: true, data: result };
            await idem.persist?.(response);
            sendOk(res, result);
        } catch (err) {
            await idem?.fail?.();
            sendErr(res, req, err);
        }
    }
);

module.exports = router;