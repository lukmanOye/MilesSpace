// routes/boost.js
// ─────────────────────────────────────────────────────────────────
// User-facing Boost routes.
//
//   GET  /config               public, 30s cache
//   GET  /catalog              auth, ETag
//   GET  /services/:serviceId  auth, includes link_hint / refill_days
//   POST /quote                auth, Postgres rate-limited (40/min)
//   POST /order                auth, Postgres rate-limited (8/min)
//   GET  /orders               paged, user shape only
//   GET  /orders/:orderRef     own orders only, user shape
//   POST /orders/:orderRef/refresh  own orders only, provider throttled (20s/order)
//   POST /orders/:orderRef/refill   own completed orders, provider action 'refill'
//   GET  /stats                RPC, no select-all
//
// All money moves and shaping live in boostService. This file only
// forwards, translates errors to HTTP, and applies the rate limit.
//
// Batch 2 (2026-11-10):
//   + Every boost order is mirrored into `orders` so Admin → Orders
//     and Revenue analytics see them. recordOrder() is idempotent on
//     (source_table='boost_orders', source_id=<boost_orders.id>).
//     Called here on order placement and on refresh; the ongoing
//     status writes in boostSyncService ALSO call it so the order
//     tracks through to completed/failed/refunded.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { supabaseAdmin } = require('../db/supabase');
const boostService = require('../services/boostService');
const syncService  = require('../services/boostSyncService');

// ★ NEW: order mirroring
const fulfillment = require('../services/billsFulfillment');
const recordOrder = (data) => fulfillment.recordOrder(data);

// ─── Postgres rate limiter ─────────────────────────────────────
//
// Backed by the `boost_rate_limits` table and the
// `boost_rate_limit_check` RPC. Survives restarts and works across
// multiple Node instances (unlike the previous in-memory Map).

function pgRateLimit(key, max, windowMs) {
    return async (req, res, next) => {
        const uid = req.user?.id;
        if (!uid) return next(); // authMiddleware already rejected
        try {
            const { data, error } = await supabaseAdmin.rpc('boost_rate_limit_check', {
                p_user_id: uid,
                p_key: key,
                p_max: max,
                p_window: `${Math.ceil(windowMs / 1000)} seconds`
            });
            if (error) {
                // Fail-open: a broken rate limiter must not block payments.
                console.error('[BOOST RATE] RPC failed, allowing:', error.message);
                return next();
            }
            const row = Array.isArray(data) ? data[0] : data;
            if (row && row.allowed === false) {
                return res.status(429).json({
                    success: false,
                    code: 'RATE_LIMITED',
                    error: 'Too many requests. Slow down.',
                    retry_after_ms: Number(row.retry_after_ms || 0)
                });
            }
            return next();
        } catch (e) {
            console.error('[BOOST RATE] exception, allowing:', e.message);
            return next();
        }
    };
}

// ─── Response helpers ─────────────────────────────────────────

function ok(res, payload) {
    if (!res.headersSent) res.json({ success: true, ...payload });
}
function fail(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'BOOST_ERROR';
    if (status >= 500) console.error('[BOOST]', code, err?.message || err);
    const body = { success: false, error: err?.message || 'Boost request failed.', code };
    if (err?.required !== undefined) body.required = err.required;
    if (err?.balance !== undefined) body.balance = err.balance;
    if (err?.new_amount !== undefined) body.new_amount = err.new_amount;
    if (err?.currency) body.currency = err.currency;
    if (err?.min_ngn !== undefined) body.min_ngn = err.min_ngn;
    if (err?.max_ngn !== undefined) body.max_ngn = err.max_ngn;
    if (err?.refund_reference) body.refund_reference = err.refund_reference;
    if (err?.allowed_transitions) body.allowed_transitions = err.allowed_transitions;
    res.status(status).json(body);
}

// ★ NEW: build the recordOrder payload from a boost_orders row.
// Kept in one place so all callers (place, refresh, sync) send the
// same shape. Never throws.
function buildBoostOrderMirror(orderRow) {
    if (!orderRow) return null;
    const status = String(orderRow.status || '').toLowerCase();
    const orderStatus =
        status === 'completed' ? 'completed'
      : (status === 'failed' || status === 'refunded' || status === 'cancelled' || status === 'partial')
            ? 'failed'
            : 'pending';

    // Boost purchases are paid in NGN or USD. Use the same fields
    // the rest of the codebase uses (`amount`/`currency` on the
    // boost_orders row, if present) and fall back to debit_*.
        // boost_orders has `total_amount` as the only amount column.
    // `currency` is the wallet currency, `provider_cost` is what we
    // paid SMMWiz, `profit_amount` is stored when known.
    const currency = String(orderRow.currency || 'NGN').toUpperCase();
    const amount = Number(orderRow.total_amount ?? 0);
    const providerCost = Number(orderRow.provider_cost ?? 0);
    const storedProfit = orderRow.profit_amount != null
        ? Number(orderRow.profit_amount)
        : null;
        const profitAmount = orderStatus === 'completed'
        ? (storedProfit != null ? storedProfit : Math.max(0, amount - providerCost))
        : 0;

    return {
        billTransactionId: orderRow.id,
        reference: orderRow.order_ref,
        userId: orderRow.user_id,
        productType: 'boost',
        serviceId: orderRow.service_id || null,
        provider: orderRow.provider || 'smmwiz',
        currency,
        amount,
        serviceFee: 0,
        totalAmount: amount,
        providerCost,
        profitAmountOverride: profitAmount,
        status: orderStatus,
        recipient: orderRow.link || null,
        metadata: {
            service_name: orderRow.service_name || null,
            quantity: orderRow.quantity || null,
            provider_order_id: orderRow.provider_order_id || null,
            failure_reason: orderRow.failure_reason || null,
            refunded: status === 'refunded'
        }
    };
}

// ─── Config (public) ──────────────────────────────────────────

router.get('/config', async (req, res) => {
    try {
        const config = await boostService.getPublicConfig();
        res.set('Cache-Control', 'public, max-age=30');
        ok(res, { config });
    } catch (err) { fail(res, err); }
});

// ─── Catalog (auth, ETag) ─────────────────────────────────────

router.get('/catalog', authMiddleware, async (req, res) => {
    try {
        const catalog = await boostService.getPublicCatalog();
        const etag = `"${catalog.version}"`;
        res.set('Cache-Control', 'private, max-age=30');
        res.set('ETag', etag);
        if (req.headers['if-none-match'] === etag) {
            return res.status(304).end();
        }
        ok(res, { services: catalog.services, usd_to_ngn: catalog.usd_to_ngn, version: catalog.version });
    } catch (err) { fail(res, err); }
});

// ─── Service detail ───────────────────────────────────────────

router.get('/services/:serviceId', authMiddleware, async (req, res) => {
    try {
        const service = await boostService.getPublicService(req.params.serviceId);
        ok(res, { service });
    } catch (err) { fail(res, err); }
});

// ─── Quote ────────────────────────────────────────────────────

router.post(
    '/quote',
    authMiddleware,
    pgRateLimit('quote', 40, 60_000),
    async (req, res) => {
        try {
            const { service_id, quantity, wallet_type } = req.body || {};
            if (!service_id || !quantity) {
                return res.status(400).json({
                    success: false, code: 'MISSING_FIELDS',
                    error: 'service_id and quantity are required.'
                });
            }
            const qty = parseInt(quantity, 10);
            if (!Number.isFinite(qty) || qty < 1) {
                return res.status(422).json({
                    success: false, code: 'INVALID_QUANTITY',
                    error: 'Quantity must be a positive integer.'
                });
            }
            const result = await boostService.quote({
                userId: req.user.id,
                serviceId: service_id,
                quantity: qty,
                walletCurrency: wallet_type || 'NGN'
            });
            ok(res, { quote: result });
        } catch (err) { fail(res, err); }
    }
);

// ─── Place order ──────────────────────────────────────────────

router.post(
    '/order',
    authMiddleware,
    pgRateLimit('order', 8, 60_000),
    async (req, res) => {
        try {
            const { service_id, link, quantity, wallet_type, expected_amount } = req.body || {};
            const idempotencyKey = req.headers['idempotency-key'] || null;

            if (!idempotencyKey) {
                return res.status(400).json({
                    success: false, code: 'IDEMPOTENCY_KEY_REQUIRED',
                    error: 'Idempotency-Key header is required.'
                });
            }
            if (!service_id || !link || !quantity) {
                return res.status(400).json({
                    success: false, code: 'MISSING_FIELDS',
                    error: 'service_id, link and quantity are required.'
                });
            }
            const qty = parseInt(quantity, 10);
            if (!Number.isFinite(qty) || qty < 1) {
                return res.status(422).json({
                    success: false, code: 'INVALID_QUANTITY',
                    error: 'Quantity must be a positive integer.'
                });
            }

            const result = await boostService.placeOrder({
                userId: req.user.id,
                serviceId: service_id,
                link: String(link),
                quantity: qty,
                walletType: wallet_type || 'NGN',
                idempotencyKey,
                expectedAmount: expected_amount
            });

            // ★ NEW: mirror to `orders` before we touch the provider so
            // the order is visible in Admin → Orders immediately, even
            // if the provider call times out or throws.
            // Non-fatal — a mirror failure must never break a purchase.
            if (!result.idempotent && result.order) {
                try {
                    const payload = buildBoostOrderMirror(result.order);
                    if (payload) await recordOrder(payload);
                } catch (mirrorErr) {
                    console.error('[BOOST] recordOrder (place) failed:', mirrorErr.message);
                }
            }

            // Submit THIS order. Provider timeout never fails the
            // request — the order stays pending/provider_unknown.
            if (!result.idempotent) {
                try {
                    await syncService.submitBoostOrder(result.order);
                } catch (e) {
                    console.warn('[BOOST] immediate submit failed:', e.message);
                }
            }

            // Re-read so the response reflects the latest status.
            let fresh = result.order;
            try {
                const reloaded = await boostService.getOrder(result.order.id);
                fresh = reloaded.order;
            } catch (_) {}

            // ★ NEW: sync the order with whatever the submit produced.
            // If submitBoostOrder flipped it to completed/failed, we
            // want Revenue to see that without waiting for a webhook.
            if (fresh && !result.idempotent) {
                try {
                    const payload = buildBoostOrderMirror(fresh);
                    if (payload) await recordOrder(payload);
                } catch (mirrorErr) {
                    console.error('[BOOST] recordOrder (post-submit) failed:', mirrorErr.message);
                }
            }

            ok(res, {
                order: boostService.shapeUserOrder(fresh),
                idempotent: !!result.idempotent
            });
        } catch (err) { fail(res, err); }
    }
);

// ─── User orders ──────────────────────────────────────────────

router.get('/orders', authMiddleware, async (req, res) => {
    try {
        const result = await boostService.listOrders({
            page: req.query.page,
            limit: req.query.limit,
            status: req.query.status,
            from: req.query.from,
            to: req.query.to
        }, { forUserId: req.user.id });
        ok(res, {
            orders: result.orders,
            count: result.count,
            page: result.page,
            limit: result.limit,
            totalPages: result.totalPages
        });
    } catch (err) { fail(res, err); }
});

router.get('/orders/:orderRef', authMiddleware, async (req, res) => {
    try {
        const { data: order, error } = await supabaseAdmin
            .from('boost_orders').select('*')
            .eq('order_ref', String(req.params.orderRef))
            .eq('user_id', req.user.id)
            .maybeSingle();
        if (error || !order) {
            return res.status(404).json({ success: false, code: 'BOOST_NOT_FOUND', error: 'Order not found.' });
        }
        ok(res, { order: boostService.shapeUserOrder(order) });
    } catch (err) { fail(res, err); }
});

// Refresh — user-initiated provider check. Throttled to 1 call
// per order per 20s (the provider side only allows so many).
router.post(
    '/orders/:orderRef/refresh',
    authMiddleware,
    pgRateLimit('refresh', 20, 60_000),
    async (req, res) => {
        try {
            const { data: order, error } = await supabaseAdmin
                .from('boost_orders').select('*')
                .eq('order_ref', String(req.params.orderRef))
                .eq('user_id', req.user.id)
                .maybeSingle();
            if (error || !order) {
                return res.status(404).json({ success: false, code: 'BOOST_NOT_FOUND', error: 'Order not found.' });
            }

            if (boostService.TERMINAL_STATUSES.has(String(order.status))) {
                return ok(res, { order: boostService.shapeUserOrder(order), refreshed: false, terminal: true });
            }

            const lastChecked = order.provider_last_checked_at
                ? new Date(order.provider_last_checked_at).getTime() : 0;
            const throttled = Date.now() - lastChecked < 20_000;

            let refreshed = false;
            if (!throttled) {
                const r = await syncService.syncBoostOrder(order).catch(() => ({ updated: false }));
                refreshed = !!r.updated;
            }

            const { data: fresh } = await supabaseAdmin
                .from('boost_orders').select('*').eq('id', order.id).maybeSingle();

            // ★ NEW: sync order with the refreshed state. `syncBoostOrder`
            // also calls recordOrder internally, but this covers the
            // throttled path where the in-service hook never ran.
            try {
                const payload = buildBoostOrderMirror(fresh || order);
                if (payload) await recordOrder(payload);
            } catch (mirrorErr) {
                console.error('[BOOST] recordOrder (refresh) failed:', mirrorErr.message);
            }

            ok(res, {
                order: boostService.shapeUserOrder(fresh || order),
                refreshed,
                throttled
            });
        } catch (err) { fail(res, err); }
    }
);

// Refill request — only for completed orders, provider action 'refill'.
router.post(
    '/orders/:orderRef/refill',
    authMiddleware,
    pgRateLimit('refill', 3, 60_000),
    async (req, res) => {
        try {
            const { data: order, error } = await supabaseAdmin
                .from('boost_orders').select('*')
                .eq('order_ref', String(req.params.orderRef))
                .eq('user_id', req.user.id)
                .maybeSingle();
            if (error || !order) {
                return res.status(404).json({ success: false, code: 'BOOST_NOT_FOUND', error: 'Order not found.' });
            }
            const r = await syncService.requestRefill({ orderRef: order.order_ref });

            // ★ NEW: refill may update the row; re-read and mirror.
            try {
                const { data: fresh } = await supabaseAdmin
                    .from('boost_orders').select('*').eq('id', order.id).maybeSingle();
                const payload = buildBoostOrderMirror(fresh || order);
                if (payload) await recordOrder(payload);
            } catch (mirrorErr) {
                console.error('[BOOST] recordOrder (refill) failed:', mirrorErr.message);
            }

            ok(res, r);
        } catch (err) { fail(res, err); }
    }
);

// ─── Stats (RPC) ──────────────────────────────────────────────

router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const stats = await boostService.getUserStats(req.user.id);
        ok(res, { stats });
    } catch (err) { fail(res, err); }
});

module.exports = router;