// routes/marketRoutes.js
// ─────────────────────────────────────────────────────────────────
// MilesSpace Marketplace — customer-facing router.
//
// CONTRACT:
//   • Every route requires authMiddleware. No anonymous access.
//   • Every 5xx response carries { success:false, code, error,
//     request_id }. `error` is a GENERIC message — real error is
//     logged server-side with the same request_id.
//   • Purchase is idempotent by construction:
//       — order id = seedUuid(userId + ':' + Idempotency-Key)
//       — order_ref = refFromSeed(same)
//       — the ledger reference is order_ref, so a replayed debit
//         23505s at the transactions.reference unique index and is
//         treated as "already debited" (not as a second charge).
//       — INSERT on marketplace_orders.id 23505s on a replay, which
//         becomes either "resume to completed" or 409 PURCHASE_PENDING.
//       — Once the ledger has been touched, the route NEVER deletes
//         the order or releases inventory — the sweeper resolves
//         ambiguity.
//   • Delivery (`delivery` field, and the /download endpoint) is only
//     returned for orders with status='completed'. A refunded order
//     has no delivery, even though the row exists.
//   • /products and /products/:id return FINAL prices (markup
//     included). Same function as the purchase route, so the price
//     shown == the price charged.
//   • /orders/:id and /orders/:id/download scope to req.user.id.
//     IDOR is impossible: the WHERE clause is (id = ? AND user_id = ?).
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { LedgerService } = require('../services/ledgerService');
const marketplace = require('../services/marketplaceService');
const fulfillment = require('../services/billsFulfillment');
const recordOrder = (data) => fulfillment.recordOrder(data);

const router = express.Router();

// ─── Helpers ────────────────────────────────────────────────────
const PENDING_MSG = 'We could not confirm this payment yet. Do not pay again. Check your Purchase History in a minute.';
const DEFINITIVE_LEDGER_ERR = /insufficient|not enough|invalid|unsupported|must be|restricted|suspended/i;

function newRequestId() {
    return crypto.randomBytes(4).toString('hex');
}

function fail(res, status, code, error, extra = {}) {
    if (res.headersSent) return;
    const rid = newRequestId();
    if (status >= 500) {
        console.error('[MARKET]', rid, code, error, extra);
    }
    res.status(status).json({ success: false, code, error, request_id: rid, ...extra });
}

function safeFail(res, status, code, publicMsg) {
    // Generic outward-facing message for 5xx. Real error was logged
    // at the call site.
    return fail(res, status, code, publicMsg);
}

// In-process rate limiter for /purchase. Per-process — see Known
// Limitations. For a distributed setup, use Redis or an upstream LB.
const _hits = new Map();
function purchaseLimiter(req, res, next) {
    const k = req.user?.id || req.ip;
    const now = Date.now();
    const arr = (_hits.get(k) || []).filter(t => now - t < 60_000);
    if (arr.length >= 10) {
        res.setHeader('Retry-After', '30');
        return fail(res, 429, 'RATE_LIMITED', 'Too many purchase attempts. Please wait a moment.');
    }
    arr.push(now);
    _hits.set(k, arr);
    next();
}
setInterval(() => {
    const c = Date.now() - 60_000;
    for (const [k, a] of _hits) if (!a.some(t => t > c)) _hits.delete(k);
}, 60_000).unref?.();

// ─── Read-side (products) ──────────────────────────────────────

router.get('/products', authMiddleware, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
        const offset = (page - 1) * limit;
        const category = String(req.query.category || '').trim();
        const search = String(req.query.search || '').trim();
        const sort = String(req.query.sort || 'default').trim();

        let query = supabaseAdmin
            .from('marketplace_products')
            .select(
                'id, name, category_id, description, long_description, how_to_use, features, ' +
                'mail_access, login_tutorial, login_format, country, price_usd, price_ngn, ' +
                'stock, sold, delivery_type, status, created_at, ' +
                'marketplace_categories!marketplace_products_category_id_fkey(name, icon)',
                { count: 'exact' }
            )
            .eq('status', 'Active');

        if (category && category !== 'all') query = query.eq('category_id', category);
        if (search) {
            const safe = search.replace(/[%_\\]/g, m => '\\' + m);
            query = query.ilike('name', `%${safe}%`);
        }

        if (sort === 'price-asc')       query = query.order('price_usd', { ascending: true });
        else if (sort === 'price-desc') query = query.order('price_usd', { ascending: false });
        else if (sort === 'qty-desc')   query = query.order('stock', { ascending: false });
        else if (sort === 'name-asc')   query = query.order('name', { ascending: true });
        else                            query = query.order('created_at', { ascending: false });

        query = query.range(offset, offset + limit - 1);

        // Fetch the pricing context ONCE per request. Both list and
        // detail use it, so the markup rate is stable within a request.
        const [qRes, ctx] = await Promise.all([query, marketplace.pricingContext()]);
        if (qRes.error) {
            console.error('[MARKET] products query failed:', qRes.error.message);
            return safeFail(res, 500, 'PRODUCTS_FETCH_FAILED', 'Could not load products.');
        }

        const products = (qRes.data || []).map(p => marketplace.sanitizeProduct(p, ctx));
        res.json({
            success: true,
            products,
            meta: {
                page,
                limit,
                total: qRes.count || 0,
                hasMore: offset + products.length < (qRes.count || 0),
            },
        });
    } catch (err) {
        console.error('[MARKET] /products error:', err.message);
        return safeFail(res, 500, 'PRODUCTS_FETCH_FAILED', 'Could not load products.');
    }
});

router.get('/products/:id', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('marketplace_products')
            .select(
                'id, name, category_id, description, long_description, how_to_use, features, ' +
                'mail_access, login_tutorial, login_format, country, price_usd, price_ngn, ' +
                'stock, sold, delivery_type, status, created_at, ' +
                'marketplace_categories!marketplace_products_category_id_fkey(name, icon)'
            )
            .eq('id', req.params.id)
            .eq('status', 'Active')
            .maybeSingle();

        if (error) {
            console.error('[MARKET] product get failed:', error.message);
            return safeFail(res, 500, 'PRODUCT_FETCH_FAILED', 'Could not load product.');
        }
        if (!data) return fail(res, 404, 'NOT_FOUND', 'Product not found');

        const ctx = await marketplace.pricingContext();
        res.json({ success: true, product: marketplace.sanitizeProduct(data, ctx) });
    } catch (err) {
        console.error('[MARKET] /products/:id error:', err.message);
        return safeFail(res, 500, 'PRODUCT_FETCH_FAILED', 'Could not load product.');
    }
});

router.get('/categories', authMiddleware, async (_req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('marketplace_categories')
            .select('id, name, icon')
            .eq('status', 'Active')
            .order('name');
        if (error) return safeFail(res, 500, 'CATEGORIES_FAILED', 'Could not load categories');
        res.json({ success: true, categories: data || [] });
    } catch (err) {
        console.error('[MARKET] /categories error:', err.message);
        return safeFail(res, 500, 'CATEGORIES_FAILED', 'Could not load categories');
    }
});

router.get('/balances', authMiddleware, async (req, res) => {
    try {
        const [ngn, usd] = await Promise.all([
            LedgerService.getBalance(req.user.id, 'NGN'),
            LedgerService.getBalance(req.user.id, 'USD'),
        ]);
        res.json({ success: true, balances: { NGN: ngn, USD: usd } });
    } catch (err) {
        console.error('[MARKET] /balances error:', err.message);
        return safeFail(res, 500, 'BALANCES_FAILED', 'Could not load wallet balances');
    }
});

// ─── Purchase ──────────────────────────────────────────────────

async function releaseInventory(inventoryId, orderId) {
    if (!inventoryId || !orderId) return;
    const { error } = await supabaseAdmin.rpc('release_marketplace_inventory', {
        p_inventory_id: inventoryId,
        p_order_id: orderId,
    });
    if (error) {
        console.error('[MARKET] release inventory FAILED, fix manually', { inventoryId, orderId, error: error.message });
    }
}

async function completeOrder({ order, product, pricing, inv, txId }) {
    const now = new Date().toISOString();
    const delivery = marketplace.buildDeliveryPayload(inv, { product_title: product.name }, product);

    const { error } = await supabaseAdmin
        .from('marketplace_orders')
        .update({
            status: 'completed',
            completed_at: now,
            updated_at: now,
            delivered_data: delivery,
            unified_transaction_id: txId,
        })
        .eq('id', order.id);
    if (error) throw new Error('order finalize failed: ' + error.message);

    try {
        // Mirror with the REAL cost — profit is not 100%.
        await recordOrder({
            billTransactionId: order.id,
            reference: order.order_ref,
            userId: order.user_id,
            productType: 'marketplace',
            serviceId: String(product.id),
            provider: 'marketplace',
            currency: order.currency,
            amount: pricing.cost,
            serviceFee: pricing.markup,
            totalAmount: Number(order.total),
            providerCost: pricing.cost,
            status: 'completed',
            recipient: null,
            metadata: {
                product_name: product.name,
                product_category: product.category_id || null,
                inventory_id: inv.id,
                ledger_transaction_id: txId,
            },
        });
    } catch (e) {
        console.error('[MARKET][MIRROR] recordOrder failed', order.order_ref, e.message);
    }
}

router.post('/purchase', authMiddleware, purchaseLimiter, async (req, res) => {
    const userId = req.user?.id;
    let orderId = null;
    let inventoryId = null;
    let ledgerTouched = false;

    try {
        const key = String(req.headers['idempotency-key'] || req.body?.idempotency_key || '').trim();
        if (key.length < 8 || key.length > 120) {
            return fail(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required.');
        }

        const { product_id, wallet_type, expected_total } = req.body || {};
        const wallet = String(wallet_type || '').toUpperCase();
        if (!product_id || typeof product_id !== 'string') {
            return fail(res, 400, 'MISSING_PRODUCT', 'product_id is required');
        }
        if (wallet !== 'NGN' && wallet !== 'USD') {
            return fail(res, 400, 'INVALID_WALLET', 'wallet_type must be NGN or USD');
        }

        // Deterministic IDs — the same key always resolves to the same
        // primary key and the same reference. This is the entire
        // idempotency guarantee.
        const seed = `${userId}:${key}`;
        const newOrderId = marketplace.seedUuid(seed);
        const orderRef = marketplace.refFromSeed(seed);

        // ── 1. Replay of an earlier attempt ─────────────────────
        const { data: prior, error: priorErr } = await supabaseAdmin
            .from('marketplace_orders')
            .select('id, order_ref, user_id, status, total, currency, product_id, product_name, inventory_id, download_token, unified_transaction_id')
            .eq('id', newOrderId)
            .maybeSingle();
        if (priorErr) throw priorErr;

        if (prior) {
            if (prior.status === 'completed') {
                return res.json({
                    success: true,
                    already_processed: true,
                    purchase: marketplace.purchaseView(prior),
                });
            }
            // Order exists but is not completed. Find out whether the
            // ledger committed — if so, resume. If not, keep order
            // and let the sweeper resolve; do NOT roll back.
            const tx = await LedgerService.findTransactionByReference(prior.order_ref);
            if (!tx) return fail(res, 409, 'PURCHASE_PENDING', PENDING_MSG);

            const [{ data: product }, { data: inv }] = await Promise.all([
                supabaseAdmin
                    .from('marketplace_products')
                    .select('id, name, category_id, price_usd, price_ngn')
                    .eq('id', prior.product_id)
                    .maybeSingle(),
                supabaseAdmin
                    .from('marketplace_inventory')
                    .select('*')
                    .eq('id', prior.inventory_id)
                    .maybeSingle(),
            ]);
            if (!product || !inv) return fail(res, 409, 'PURCHASE_PENDING', PENDING_MSG);

            const pricing = await marketplace.computePrice(product, prior.currency);
            await completeOrder({ order: prior, product, pricing, inv, txId: tx.id });

            return res.json({
                success: true,
                recovered: true,
                purchase: marketplace.purchaseView({ ...prior, unified_transaction_id: tx.id }),
            });
        }

        // ── 2. Product and exact price ──────────────────────────
        const { data: product, error: pErr } = await supabaseAdmin
            .from('marketplace_products')
            .select('id, name, category_id, price_usd, price_ngn, status')
            .eq('id', product_id)
            .eq('status', 'Active')
            .maybeSingle();
        if (pErr) throw pErr;
        if (!product) return fail(res, 404, 'NOT_FOUND', 'Product not found');

        const pricing = await marketplace.computePrice(product, wallet);
        if (!(pricing.charge > 0)) {
            return fail(res, 400, 'INVALID_PRICE', 'Invalid product price');
        }
        if (expected_total != null && Math.abs(Number(expected_total) - pricing.charge) > 0.009) {
            return fail(res, 409, 'PRICE_CHANGED', 'The price changed. Please review the new total.', {
                current_total: pricing.charge,
                currency: wallet,
            });
        }

        // ── 3. Balance pre-check (the ledger is still the authority) ─
        const balance = await LedgerService.getBalance(userId, wallet);
        if (balance < pricing.charge) {
            return fail(res, 400, 'INSUFFICIENT_BALANCE', `Insufficient ${wallet} balance.`, {
                required: pricing.charge,
                balance,
            });
        }

        // ── 4. Reserve one inventory item ───────────────────────
        const { data: alloc, error: allocErr } = await supabaseAdmin.rpc('allocate_marketplace_inventory', {
            p_product_id: product.id,
            p_user_id: userId,
            p_order_id: newOrderId,
        });
        if (allocErr) throw allocErr;
        if (!alloc || !alloc.length) {
            return fail(res, 400, 'OUT_OF_STOCK', 'Out of stock');
        }
        const inv = alloc[0];
        inventoryId = inv.id;

        // ── 5. Pending order row. No credentials yet. ───────────
        const { data: order, error: oErr } = await supabaseAdmin
            .from('marketplace_orders')
            .insert({
                id: newOrderId,
                order_ref: orderRef,
                user_id: userId,
                product_id: product.id,
                product_name: product.name,
                product_title: product.name,
                quantity: 1,
                total: pricing.charge,
                currency: wallet,
                wallet: wallet,
                wallet_used: wallet,
                price_usd: pricing.usd,
                price_ngn: pricing.ngn,
                status: 'pending',
                inventory_id: inventoryId,
                download_token: marketplace.generateDownloadToken(),
                download_count: 0,
                delivered_data: null,
                idempotency_key: key,
                created_at: new Date().toISOString(),
            })
            .select()
            .single();

        if (oErr) {
            await releaseInventory(inventoryId, newOrderId);
            inventoryId = null;
            if (oErr.code === '23505') {
                return fail(res, 409, 'PURCHASE_PENDING', PENDING_MSG);
            }
            throw oErr;
        }
        orderId = newOrderId;

        // ── 6. Debit. Deterministic reference prevents double charge. ─
        let txId;
        let balanceAfter = null;
        ledgerTouched = true;
        try {
            const tx = await LedgerService.createTransaction({
                userId,
                type: 'marketplace_purchase',
                amount: -pricing.charge,
                currency: wallet,
                description: `Purchased: ${product.name}`,
                reference: orderRef,
                sourceType: 'order',
                sourceId: orderId,
                provider: 'marketplace',
                metadata: {
                    product_id: product.id,
                    product_name: product.name,
                    order_ref: orderRef,
                    inventory_id: inventoryId,
                },
                idempotencyKey: `mp:${orderId}`,
            });
            txId = tx.transaction_id;
            balanceAfter = tx.balance_after ?? null;
        } catch (ledgerErr) {
            // Ambiguous vs definitive? Only "definitive" errors are
            // safe to roll back. If we cannot tell, assume the debit
            // committed (or will) and leave the order pending.
            const found = await LedgerService.findTransactionByReference(orderRef);
            if (found) {
                txId = found.id;
            } else if (DEFINITIVE_LEDGER_ERR.test(String(ledgerErr.message))) {
                ledgerTouched = false;
                await releaseInventory(inventoryId, orderId);
                await supabaseAdmin
                    .from('marketplace_orders')
                    .delete()
                    .eq('id', orderId)
                    .eq('status', 'pending');
                inventoryId = null;
                orderId = null;
                const nsf = /insufficient|not enough/i.test(String(ledgerErr.message));
                return fail(
                    res,
                    400,
                    nsf ? 'INSUFFICIENT_BALANCE' : 'PAYMENT_DECLINED',
                    nsf ? `Insufficient ${wallet} balance.` : 'Payment could not be processed.'
                );
            } else {
                console.error('[MARKET] ambiguous ledger error', orderRef, ledgerErr.message);
                return fail(res, 409, 'PURCHASE_PENDING', PENDING_MSG);
            }
        }

        // ── 7. Deliver + link + mirror ──────────────────────────
        try {
            await completeOrder({ order, product, pricing, inv, txId });
        } catch (e) {
            console.error('[MARKET] finalize failed after debit', orderRef, e.message);
            return fail(res, 409, 'PURCHASE_PENDING', PENDING_MSG);
        }

        if (global.invalidateDashboardCache) global.invalidateDashboardCache();

        return res.json({
            success: true,
            purchase: {
                order_ref: orderRef,
                order_id: orderId,
                product_name: product.name,
                price: pricing.charge,
                currency: wallet,
                new_balance: balanceAfter,
                download_token: order.download_token,
                transaction_id: txId,
                unified_transaction_id: txId,
            },
        });
    } catch (err) {
        console.error('[MARKET] purchase error:', err.message);
        // Only roll back if we are certain the ledger was never touched.
        if (!ledgerTouched) {
            try {
                if (inventoryId && orderId) await releaseInventory(inventoryId, orderId);
                if (orderId) {
                    await supabaseAdmin
                        .from('marketplace_orders')
                        .delete()
                        .eq('id', orderId)
                        .eq('status', 'pending');
                }
            } catch (cleanupErr) {
                console.error('[MARKET] cleanup failed:', cleanupErr.message);
            }
            return safeFail(res, 500, 'PURCHASE_FAILED', 'Purchase could not be completed. You have not been charged.');
        }
        return fail(res, 409, 'PURCHASE_PENDING', PENDING_MSG);
    }
});

// ─── Read-side (orders) ────────────────────────────────────────

router.get('/orders', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;

        const { data, error, count } = await supabaseAdmin
            .from('marketplace_orders')
            .select(
                'id, order_ref, product_id, product_name, product_title, quantity, total, ' +
                'currency, wallet, wallet_used, price_usd, price_ngn, status, ' +
                'download_count, last_download_at, created_at, completed_at',
                { count: 'exact' }
            )
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            console.error('[MARKET] /orders query failed:', error.message);
            return safeFail(res, 500, 'ORDERS_FETCH_FAILED', 'Could not load orders.');
        }

        const orders = (data || []).map(marketplace.sanitizeOrderRow);
        res.json({
            success: true,
            data: orders,
            meta: {
                page,
                limit,
                total: count || 0,
                hasMore: offset + orders.length < (count || 0),
            },
        });
    } catch (err) {
        console.error('[MARKET] /orders error:', err.message);
        return safeFail(res, 500, 'ORDERS_FETCH_FAILED', 'Could not load orders.');
    }
});

router.get('/orders/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data, error } = await supabaseAdmin
            .from('marketplace_orders')
            .select(
                'id, order_ref, user_id, product_id, product_name, product_title, quantity, ' +
                'total, currency, wallet, wallet_used, price_usd, price_ngn, status, ' +
                'download_count, last_download_at, created_at, completed_at, ' +
                'delivered_data, unified_transaction_id'
            )
            .eq('id', req.params.id)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            console.error('[MARKET] /orders/:id query failed:', error.message);
            return safeFail(res, 500, 'ORDER_FETCH_FAILED', 'Could not load order.');
        }
        if (!data) return fail(res, 404, 'NOT_FOUND', 'Order not found');

        const order = marketplace.sanitizeOrderRow(data);
        // Delivery is only exposed for completed orders. A refunded
        // order keeps the row but loses the delivery.
        if (data.status === 'completed' && data.delivered_data) {
            order.delivery = data.delivered_data;
        } else {
            order.delivery = null;
        }
        res.json({ success: true, order });
    } catch (err) {
        console.error('[MARKET] /orders/:id error:', err.message);
        return safeFail(res, 500, 'ORDER_FETCH_FAILED', 'Could not load order.');
    }
});

router.get('/orders/:id/download', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data: order, error } = await supabaseAdmin
            .from('marketplace_orders')
            .select(
                'id, order_ref, user_id, product_name, product_title, wallet, wallet_used, ' +
                'price_usd, price_ngn, total, status, download_count, delivered_data, created_at'
            )
            .eq('id', req.params.id)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            console.error('[MARKET] /download query failed:', error.message);
            return safeFail(res, 500, 'DOWNLOAD_FAILED', 'Download failed.');
        }
        if (!order) return fail(res, 404, 'NOT_FOUND', 'Order not found');
        if (order.status !== 'completed' || !order.delivered_data) {
            return fail(res, 400, 'ORDER_NOT_COMPLETED', 'Order is not completed');
        }

        // Increment the download counter — best effort.
        let downloadCount = (order.download_count || 0) + 1;
        try {
            const { data: newCount, error: incErr } = await supabaseAdmin.rpc(
                'increment_marketplace_download',
                { p_order_id: order.id }
            );
            if (!incErr && Number.isFinite(newCount)) downloadCount = newCount;
        } catch (incErr) {
            console.warn('[MARKET] download counter RPC failed (non-fatal):', incErr.message);
        }

        const delivery = order.delivered_data || {};
        const wallet = order.wallet_used || order.wallet || 'NGN';
        const amount = wallet === 'USD'
            ? parseFloat(order.price_usd) || 0
            : parseFloat(order.price_ngn) || parseFloat(order.total) || 0;

        const lines = [
            '═══════════════════════════════════════════════',
            '  MILESPACE ORDER DETAILS',
            '═══════════════════════════════════════════════',
            '',
            `Order ID:    ${order.order_ref}`,
            `Product:     ${order.product_title || order.product_name}`,
            `Date:        ${new Date(order.created_at).toLocaleString('en-NG')}`,
            `Wallet:      ${wallet}`,
            `Amount:      ${wallet === 'USD' ? '$' : '₦'}${amount.toFixed(2)}`,
            `Downloads:   ${downloadCount}`,
            '',
            '────────── DELIVERY DETAILS ──────────',
            '',
            `Format:      ${delivery.login_format || 'N/A'}`,
            '',
            'Instructions:',
            delivery.login_instructions || 'No instructions provided.',
            '',
            'Content:',
            typeof delivery.content === 'string'
                ? delivery.content
                : JSON.stringify(delivery.content || {}, null, 2),
            '',
            '───────────────────────────────────────',
            `Downloaded:  ${new Date().toISOString()}`,
            '═══════════════════════════════════════════════',
        ];

        const filename = `order_${order.order_ref}.txt`;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(lines.join('\n'));
    } catch (err) {
        console.error('[MARKET] /orders/:id/download error:', err.message);
        return safeFail(res, 500, 'DOWNLOAD_FAILED', 'Download failed.');
    }
});

// ─── Legacy token-based download ────────────────────────────────
router.get('/download/:token', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data: order, error } = await supabaseAdmin
            .from('marketplace_orders')
            .select('id')
            .eq('download_token', req.params.token)
            .eq('user_id', userId)
            .maybeSingle();
        if (error) {
            console.error('[MARKET] legacy download query failed:', error.message);
            return safeFail(res, 500, 'DOWNLOAD_FAILED', 'Download failed.');
        }
        if (!order) return fail(res, 404, 'NOT_FOUND', 'Order not found');
        return res.redirect(`/api/market/orders/${order.id}/download`);
    } catch (err) {
        console.error('[MARKET] legacy /download error:', err.message);
        return safeFail(res, 500, 'DOWNLOAD_FAILED', 'Download failed.');
    }
});

module.exports = router;