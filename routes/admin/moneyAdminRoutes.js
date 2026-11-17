// routes/admin/marketAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Marketplace API — HTTP glue over marketplaceAdminService.
//
// CONTRACT:
//   • Every route requires requirePermission(...) with the correct
//     permission. No route trusts req.user.role.
//   • Every successful response is { success: true, ...payload }.
//   • Every error response is { success: false, code, error,
//     request_id }. For status >= 500 the message is generic; the
//     real message was logged inside the service with the same
//     request_id.
//   • Every state-changing route calls the corresponding service
//     method, which records the audit action.
//   • UUID validation on every :id. Non-UUIDs get 422 JSON, not
//     Express HTML.
//   • The route file contains NO business logic beyond validation
//     and context construction.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const {
    requirePermission,
    PERMISSIONS,
} = require('../../middleware/adminAuth');

const svc = require('../../services/marketplaceAdminService');

// ─── Helpers ────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) { return UUID_RE.test(String(v || '')); }

function sendOk(res, payload) {
    if (!res.headersSent) res.json({ success: true, ...payload });
}

function sendErr(res, req, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'MARKETPLACE_ERROR';
    const rid = req.marketRequestId || req.correlationId || null;

    if (status >= 500) {
        console.error('[ADMIN MARKET]', rid, code, err?.message);
        return res.status(status).json({
            success: false,
            code,
            error: 'Marketplace request failed.',
            request_id: rid,
        });
    }
    return res.status(status).json({
        success: false,
        code,
        error: err?.message || 'Marketplace request failed',
        request_id: rid,
        ...(err?.has_debit ? { has_debit: true, transaction_id: err.transaction_id || null } : {}),
        ...(err?.required ? { required: err.required } : {}),
    });
}

// Request-scoped id + admin ctx
router.use((req, res, next) => {
    req.marketRequestId =
        req.correlationId ||
        req.headers['x-request-id'] ||
        'MK-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    res.setHeader('X-Request-Id', req.marketRequestId);
    next();
});

function ctxFrom(req) {
    return {
        adminId:    req.adminContext?.id       || null,
        adminEmail: req.adminContext?.email    || null,
        adminRole:  req.adminContext?.role     || null,
        ip:         req.adminContext?.ip       || req.ip || null,
        userAgent:  req.headers['user-agent']  || null,
        requestId:  req.marketRequestId,
        idempotencyKey: req.headers['idempotency-key'] || null,
        req,
    };
}

// Enum validation helpers
function requireOneOf(value, allowed, code, field) {
    if (!allowed.includes(value)) {
        const e = new Error(`Invalid ${field}: ${value}`);
        e.status = 422; e.code = code;
        throw e;
    }
}

// ═════════════════════════════════════════════════════════════════
// STATS / TREND
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/stats',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const payload = await svc.getStats();
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/marketplace/trend',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const days = parseInt(req.query.days, 10);
            const payload = await svc.getTrend({ days: Number.isFinite(days) ? days : 30 });
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
// PRODUCTS
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/products',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const payload = await svc.listProducts({
                q: req.query.q || '',
                status: req.query.status || 'all',
                category: req.query.category || 'all',
                stock: req.query.stock || 'all',
                sort: req.query.sort || 'created_desc',
                page: req.query.page,
                limit: req.query.limit,
            });
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/marketplace/products/:id',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const payload = await svc.getProduct(req.params.id);
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/products',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const payload = await svc.createProduct(req.body || {}, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.put(
    '/marketplace/products/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const payload = await svc.updateProduct(req.params.id, req.body || {}, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/products/:id/duplicate',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const payload = await svc.duplicateProduct(req.params.id, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/products/bulk-status',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const { ids, status } = req.body || {};
            const payload = await svc.bulkStatusProducts(ids, status, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.delete(
    '/marketplace/products/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const payload = await svc.archiveOrDeleteProduct(req.params.id, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
// CATEGORIES
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/categories',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const payload = await svc.listCategories();
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/categories',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const payload = await svc.createCategory(req.body || {}, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.put(
    '/marketplace/categories/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const payload = await svc.updateCategory(req.params.id, req.body || {}, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.delete(
    '/marketplace/categories/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const payload = await svc.deleteCategory(req.params.id, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
// INVENTORY
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/inventory/:productId',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const payload = await svc.listInventory(req.params.productId, {
                status: req.query.status || 'all',
                page: req.query.page,
                limit: req.query.limit,
            });
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/inventory',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const payload = await svc.addInventory(req.body || {}, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.put(
    '/marketplace/inventory/:id',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const payload = await svc.updateInventoryItem(req.params.id, req.body || {}, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/inventory/:id/void',
    requirePermission(PERMISSIONS.SERVICES_MANAGE),
    async (req, res) => {
        try {
            const payload = await svc.voidInventoryItem(req.params.id, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

// Reveal requires a dedicated permission. ASSUMPTION A2 — the
// permission is added in Round 4 (middleware/adminAuth.js). Until
// then only super_admin (permissions=['*']) can call this.
router.post(
    '/marketplace/inventory/:id/reveal',
    requirePermission('marketplace.inventory_reveal'),
    async (req, res) => {
        try {
            const { reason } = req.body || {};
            const payload = await svc.revealInventoryItem(req.params.id, reason, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
// ORDERS
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const payload = await svc.listOrders({
                status: req.query.status || 'all',
                currency: req.query.currency || 'all',
                product_id: req.query.product_id || undefined,
                q: req.query.q || '',
                from: req.query.from || undefined,
                to: req.query.to || undefined,
                page: req.query.page,
                limit: req.query.limit,
                sort: req.query.sort || 'created_desc',
            });
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.get(
    '/marketplace/orders/:id',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            if (!isUuid(req.params.id)) {
                const e = new Error('Order id must be a UUID');
                e.status = 422; e.code = 'INVALID_ID';
                throw e;
            }
            const payload = await svc.getOrder(req.params.id);
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/orders/:id/refund',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    async (req, res) => {
        try {
            if (!isUuid(req.params.id)) {
                const e = new Error('Order id must be a UUID');
                e.status = 422; e.code = 'INVALID_ID';
                throw e;
            }
            const reason = String(req.body?.reason || '').trim();
            const payload = await svc.refundOrder(req.params.id, reason, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/orders/:id/complete',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res) => {
        try {
            if (!isUuid(req.params.id)) {
                const e = new Error('Order id must be a UUID');
                e.status = 422; e.code = 'INVALID_ID';
                throw e;
            }
            const reason = String(req.body?.reason || '').trim();
            const payload = await svc.completeOrder(req.params.id, reason, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/orders/:id/fail',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res) => {
        try {
            if (!isUuid(req.params.id)) {
                const e = new Error('Order id must be a UUID');
                e.status = 422; e.code = 'INVALID_ID';
                throw e;
            }
            const reason = String(req.body?.reason || '').trim();
            const refund = req.body?.refund === true;
            const payload = await svc.failOrder(req.params.id, reason, { refund }, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/orders/:id/resend',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res) => {
        try {
            if (!isUuid(req.params.id)) {
                const e = new Error('Order id must be a UUID');
                e.status = 422; e.code = 'INVALID_ID';
                throw e;
            }
            const payload = await svc.resendDelivery(req.params.id, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
// DISPUTES
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/disputes',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const payload = await svc.listDisputes({
                status: req.query.status || 'all',
                page: req.query.page,
                limit: req.query.limit,
            });
            // If the disputes table isn't deployed, the service
            // returns { available: false }. The admin page shows a
            // "not deployed" placeholder.
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

router.post(
    '/marketplace/disputes/:id/resolve',
    requirePermission(PERMISSIONS.ORDERS_RESOLVE),
    async (req, res) => {
        try {
            const payload = await svc.resolveDispute(req.params.id, req.body || {}, ctxFrom(req));
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
// AUDIT
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/audit',
    requirePermission(PERMISSIONS.AUDIT_READ),
    async (req, res) => {
        try {
            const payload = await svc.listAudit({
                action_prefix: req.query.action_prefix || 'marketplace.',
                target_id: req.query.target_id || undefined,
                admin_id: req.query.admin_id || undefined,
                from: req.query.from || undefined,
                to: req.query.to || undefined,
                page: req.query.page,
                limit: req.query.limit,
            });
            sendOk(res, payload);
        } catch (err) { sendErr(res, req, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
// SEARCH
// ═════════════════════════════════════════════════════════════════

router.get(
    '/marketplace/search',
    requirePermission(PERMISSIONS.SERVICES_READ),
    async (req, res) => {
        try {
            const q = String(req.query.q || '').trim();
            if (q.length < 2) {
                return sendOk(res, { results: { products: [], orders: [] } });
            }
            const results = await svc.search(q);
            sendOk(res, { results });
        } catch (err) { sendErr(res, req, err); }
    }
);

module.exports = router;