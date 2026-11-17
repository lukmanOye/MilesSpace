// services/marketplaceService.js
// ─────────────────────────────────────────────────────────────────
// MilesSpace Marketplace — pricing, sanitizers, deterministic IDs,
// delivery payload builder.
//
// CONTRACT:
//   • priceWith() is PURE and SYNCHRONOUS. The storefront and the
//     purchase route call it with the SAME (product, ctx, wallet) and
//     get the SAME result. This is what guarantees "price shown =
//     price charged". Any code path that needs pricing must call
//     priceWith/computePrice — nothing else computes money.
//   • pricingContext() caches (usdToNgn, markupPct) for 30s per
//     process. Markup changes are picked up within 30s. Cache is NOT
//     shared across processes; each instance refreshes independently.
//   • Money is returned as numbers rounded to 2 decimal places using
//     the `r2` helper — NOT raw floats. Callers that need strings use
//     `.toFixed(2)`.
//   • seedUuid(userId, idempotencyKey) → deterministic UUIDv4-shaped
//     string. Same input, same output, forever. Used as the
//     marketplace_orders.id primary key so a replay 23505s and is
//     treated as "already processing" rather than creating a second
//     order.
//   • refFromSeed(userId, idempotencyKey) → deterministic order_ref.
//     Also stable. The ledger reference is the order_ref, so a
//     retried debit is caught by the transaction reference index.
//   • sanitizeProduct(p, ctx) NEVER returns `inventory_raw` or any
//     other credential column. It returns final (marked-up) prices,
//     category name, and every marketing field the storefront shows.
//   • buildDeliveryPayload / generateDownloadToken unchanged from
//     the shipped version — delivery formatting is orthogonal to
//     pricing.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { AdminConfigService } = require('./ledgerService');

const CTX_TTL_MS = 30_000;
let _ctx = { at: 0, v: null };

/**
 * Cached pricing context. Refreshed every 30 seconds per process.
 * Fails loudly if either setting is missing — never silently falls
 * back to a hardcoded rate.
 */
async function pricingContext() {
    if (_ctx.v && Date.now() - _ctx.at < CTX_TTL_MS) return _ctx.v;

    const [usdToNgn, markupPct] = await Promise.all([
        AdminConfigService.getExchangeRate(),
        AdminConfigService.getMarkup('marketplace'),
    ]);

    if (!Number.isFinite(usdToNgn) || usdToNgn <= 0) {
        throw new Error('marketplaceService: usd_to_ngn is not configured');
    }
    if (!Number.isFinite(markupPct) || markupPct < 0) {
        throw new Error('marketplaceService: marketplace_markup is not configured');
    }

    _ctx = { at: Date.now(), v: { usdToNgn, markupPct } };
    return _ctx.v;
}

/** Round to 2 dp with float correction. */
function r2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Pure and synchronous. Same function used by the storefront and
 * the purchase route.
 *
 * Inputs:
 *   product  — row with price_usd (required) and price_ngn (optional)
 *   ctx      — { usdToNgn, markupPct }
 *   wallet   — 'NGN' | 'USD' (defaults to 'NGN')
 *
 * Returns:
 *   usd      — final markup-inclusive USD price
 *   ngn      — final markup-inclusive NGN price (from price_ngn if
 *              present, else derived from usd * usdToNgn)
 *   charge   — amount debited for the chosen wallet
 *   cost     — base cost in the same currency (used for profit)
 *   markup   — charge - cost
 *   wallet   — normalized 'NGN' | 'USD'
 *   usdToNgn — snapshot of the FX rate used
 *   markupPct — snapshot of the markup used
 */
function priceWith(product, ctx, walletType = 'NGN') {
    const m = 1 + ctx.markupPct / 100;

    const baseUsd = Number(product.price_usd) || 0;
    const baseNgnRaw = Number(product.price_ngn);
    const hasNgn = Number.isFinite(baseNgnRaw) && baseNgnRaw > 0;

    const usd = r2(baseUsd * m);
    const ngn = hasNgn ? r2(baseNgnRaw * m) : r2(usd * ctx.usdToNgn);

    const wallet = String(walletType || 'NGN').toUpperCase() === 'USD' ? 'USD' : 'NGN';
    const charge = wallet === 'USD' ? usd : ngn;
    const cost   = wallet === 'USD'
        ? r2(baseUsd)
        : r2(hasNgn ? baseNgnRaw : baseUsd * ctx.usdToNgn);

    return {
        usd,
        ngn,
        charge,
        cost,
        markup: r2(charge - cost),
        wallet,
        usdToNgn: ctx.usdToNgn,
        markupPct: ctx.markupPct,
    };
}

/**
 * Async wrapper for callers that have not already loaded the ctx.
 * Uses the cached context.
 */
async function computePrice(product, walletType) {
    return priceWith(product, await pricingContext(), walletType);
}

// ─── Deterministic identity ─────────────────────────────────────
// Both helpers hash (userId + ':' + idempotencyKey). The same
// (user, key) pair always maps to the same UUID / ref, so a retry
// with the same key cannot create a second order or a second ledger
// transaction. A different key is a different purchase.

function seedUuid(seed) {
    const h = crypto.createHash('sha256').update(String(seed)).digest();
    // Force UUIDv4 shape (version nibble = 4, variant bits = 10xx).
    h[6] = (h[6] & 0x0f) | 0x40;
    h[8] = (h[8] & 0x3f) | 0x80;
    const x = h.subarray(0, 16).toString('hex');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function refFromSeed(seed) {
    return 'ORD-' + crypto
        .createHash('sha256')
        .update('ref:' + String(seed))
        .digest('hex')
        .slice(0, 14)
        .toUpperCase();
}

// ─── Storefront view of a purchase ──────────────────────────────
// Same shape the storefront already consumes. `new_balance` is
// null here — the route fills it from the ledger response when it
// has one. This keeps the client code identical across "fresh
// purchase", "replay", and "recovered after timeout".

function purchaseView(order) {
    return {
        order_ref: order.order_ref,
        order_id: order.id,
        product_name: order.product_name,
        price: Number(order.total),
        currency: order.currency,
        new_balance: null,
        download_token: order.download_token,
        transaction_id: order.unified_transaction_id,
        unified_transaction_id: order.unified_transaction_id,
    };
}

// ─── Sanitizers ─────────────────────────────────────────────────
// `ctx` is required when you want final (marked-up) prices. If ctx
// is null, price fields are null and the caller must not display
// them. sanitizeProduct NEVER reads inventory_raw, metadata, or any
// credential column.

function sanitizeProduct(p, ctx) {
    if (!p) return null;

    const q = ctx ? priceWith(p, ctx) : null;
    const cat = p.marketplace_categories || {};

    return {
        id: p.id,
        name: p.name || 'Unknown',

        // Category: id for filtering, name/icon for display.
        category: p.category_id || 'other',
        categoryName: cat.name || p.category_id || 'Other',
        categoryIcon: cat.icon || null,

        // Marketing copy.
        description: p.description || '',
        longDescription: p.long_description || '',
        howToUse: p.how_to_use || '',
        features: p.features || '',
        mailAccess: p.mail_access || '',
        loginTutorial: p.login_tutorial || '',
        loginFormat: p.login_format || '',

        country: p.country || 'Global',

        // Prices are FINAL — the client displays these.
        // price* are null when ctx is missing; the storefront always
        // passes ctx, so this only affects internal callers.
        price: q ? q.usd : null,
        priceUsd: q ? q.usd : null,
        priceNgn: q ? q.ngn : null,

        stock: parseInt(p.stock, 10) || 0,
        qty: parseInt(p.stock, 10) || 0,
        sold: parseInt(p.sold, 10) || 0,

        deliveryType: p.delivery_type || 'structured',
        status: p.status,
        badge: '',
        tags: [],
    };
}

function sanitizeOrderRow(o) {
    if (!o) return null;
    return {
        id: o.id,
        orderRef: o.order_ref,
        productId: o.product_id,
        productName: o.product_title || o.product_name,
        category: o.category_id || 'other',
        quantity: o.quantity || 1,
        amountUsd: parseFloat(o.price_usd) || 0,
        amountNgn: parseFloat(o.price_ngn) || parseFloat(o.total) || 0,
        currency: o.wallet_used || o.wallet || 'NGN',
        status: o.status,
        transactionId: o.transaction_id || o.unified_transaction_id || null,
        inventoryId: o.inventory_id || null,
        downloadCount: o.download_count || 0,
        lastDownloadAt: o.last_download_at,
        createdAt: o.created_at,
        completedAt: o.completed_at,
        deliveredData: o.delivered_data || null,
    };
}

// ─── Legacy ID helpers ─────────────────────────────────────────
// Kept because older modules reference them. The new purchase route
// uses seedUuid/refFromSeed exclusively; these are only for any
// remaining legacy call sites.

function generateOrderId() {
    return crypto.randomUUID();
}

function generateOrderRef() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `ORD-${ts}-${rand}`;
}

function generateDownloadToken() {
    return crypto.randomBytes(32).toString('hex');
}

// ─── Delivery payload ──────────────────────────────────────────
// Formats the inventory content for the buyer's receipt. `content`
// may be a JSON string (structured payload) or plain text.
//
// IMPORTANT: this function is called AFTER the buyer has paid. It is
// never called from a list endpoint or a pre-purchase view.

function buildDeliveryPayload(inventoryRow, order, product) {
    let parsedContent = inventoryRow.content;
    let loginFormat = inventoryRow.login_format || 'N/A';
    let loginInstructions = '';

    try {
        const j = JSON.parse(inventoryRow.content);
        if (j && typeof j === 'object') {
            parsedContent = j;
            loginFormat = j.format || j.login_format || loginFormat;
            loginInstructions = j.instructions || j.login_instructions || '';
        }
    } catch (_) {
        // Plain text — keep as-is.
    }

    return {
        inventory_id: inventoryRow.id,
        delivery_type: inventoryRow.delivery_type || 'structured',
        content: parsedContent,
        login_format: loginFormat,
        login_instructions: loginInstructions,
        product_name: product?.name || order.product_title,
        delivered_at: new Date().toISOString(),
    };
}

module.exports = {
    pricingContext,
    priceWith,
    computePrice,
    r2,

    seedUuid,
    refFromSeed,

    purchaseView,
    sanitizeProduct,
    sanitizeOrderRow,

    generateOrderId,
    generateOrderRef,
    generateDownloadToken,

    buildDeliveryPayload,
};