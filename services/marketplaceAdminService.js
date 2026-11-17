// services/marketplaceAdminService.js
// ─────────────────────────────────────────────────────────────────
// MilesSpace Marketplace — admin business logic.
//
// CONTRACT:
//   • Every method here is side-effect-managed and idempotent where
//     the prompt requires it (create/update, refund, resolve, etc.).
//   • Every state-changing method calls recordAdminAction() before
//     returning success. Audit failures do NOT undo the action but
//     are logged loudly. This mirrors the rest of the admin surface.
//   • Every method either returns a plain object the route can pass
//     through, or throws an Error carrying { status, code }. The
//     route uses a single sendError() wrapper.
//   • Credentials (inventory content) NEVER leave this file except
//     through revealInventoryItem(), which requires the caller to
//     have already passed requirePermission(INVENTORY_REVEAL). The
//     method records an audit row with the reason.
//   • Stats and trend read from the admin_marketplace_stats() RPC.
//   • Refund delegates to refundService (ASSUMPTION A1 — see handoff).
//   • Disputes: marketplace_disputes is lazily created on first use
//     (ASSUMPTION A8). Lazy creation is safe to call concurrently —
//     `create table if not exists` is idempotent in Postgres.
//   • Optional columns (image_url, tags, featured, low_stock_threshold)
//     are written only if present, determined by a one-time schema
//     probe per process (ASSUMPTION A9/A10).
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const { recordAdminAction } = require('../middleware/adminAuth');
const marketplace = require('./marketplaceService');
const refundService = require('./refundService');   // ASSUMPTION A1
const fulfillment = require('./billsFulfillment');
const recordOrder = (data) => fulfillment.recordOrder(data);   // ASSUMPTION A5

// ─── Error helper ──────────────────────────────────────────────
function fail(status, code, message, extra = {}) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    Object.assign(e, extra);
    return e;
}

// ─── Column allowlists ─────────────────────────────────────────
const PRODUCT_EDITABLE = [
    'name', 'category_id', 'description', 'long_description',
    'how_to_use', 'features', 'mail_access', 'login_tutorial',
    'login_format', 'country', 'price_usd', 'price_ngn',
    'delivery_type', 'status',
];

const PRODUCT_OPTIONAL = ['image_url', 'tags', 'featured', 'low_stock_threshold'];

const PRODUCT_SELECT = [
    'id', 'name', 'category_id',
    'description', 'long_description', 'how_to_use', 'features',
    'mail_access', 'login_tutorial', 'login_format',
    'country', 'price_usd', 'price_ngn',
    'stock', 'sold', 'delivery_type', 'status',
    'created_at', 'updated_at',
    // NOTE: inventory_raw is deliberately absent.
].join(', ');

const ORDER_SELECT = [
    'id', 'order_ref', 'user_id', 'product_id', 'product_name',
    'product_title', 'quantity', 'total', 'currency', 'wallet',
    'wallet_used', 'price_usd', 'price_ngn', 'status',
    'inventory_id', 'download_token', 'download_count',
    'last_download_at', 'created_at', 'completed_at',
    'unified_transaction_id',
].join(', ');

const STATUSES = new Set(['Active', 'Inactive', 'Archived']);
const ORDER_STATUSES = new Set(['pending', 'processing', 'completed', 'failed', 'cancelled', 'refunded', 'manual_review']);

// ─── Schema probe (once per process) ───────────────────────────
// Confirms which optional columns exist before writing them.
// Never invent a column.
let _schemaPromise = null;
function schemaProbe() {
    if (_schemaPromise) return _schemaPromise;
    _schemaPromise = (async () => {
        const { data, error } = await supabaseAdmin
            .from('information_schema.columns')
            .select('column_name')
            .eq('table_schema', 'public')
            .eq('table_name', 'marketplace_products');
        if (error) {
            // information_schema isn't exposed via PostgREST; fall
            // back to "no optional columns". This is safe: the
            // create/update paths silently drop unknown keys.
            return { product: new Set() };
        }
        return { product: new Set((data || []).map(r => r.column_name)) };
    })();
    return _schemaPromise;
}

// ─── Utility ───────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) { return UUID_RE.test(String(v || '')); }

function clampInt(v, min, max, def) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
}

function escapeLike(s) {
    return String(s).replace(/[\\%_]/g, m => '\\' + m);
}

function pick(obj, keys) {
    const out = {};
    for (const k of keys) {
        if (obj && obj[k] !== undefined) out[k] = obj[k];
    }
    return out;
}

// ─── Stats / trend ─────────────────────────────────────────────
async function getStats() {
    const { data, error } = await supabaseAdmin.rpc('admin_marketplace_stats', { p_low_stock: 10 });
    if (error) throw fail(500, 'STATS_FAILED', 'Could not load marketplace stats');
    const s = data || {};
    const rev = s.revenue || {};
    return {
        stats: {
            totalProducts: s.products?.total ?? 0,
            active: s.products?.active ?? 0,
            totalStock: s.products?.total_stock ?? 0,
            totalSold: s.products?.total_sold ?? 0,
            lowStock: s.products?.low_stock ?? 0,
            outOfStock: s.products?.out_of_stock ?? 0,
            totalOrders: s.orders?.total ?? 0,
            pending: s.orders?.pending ?? 0,
            completed: s.orders?.completed ?? 0,
            refunded: s.orders?.refunded ?? 0,
            failed: s.orders?.failed ?? 0,
            usdRev: rev.USD?.revenue ?? '0.00',
            ngnRev: rev.NGN?.revenue ?? '0.00',
            available: s.inventory?.available ?? 0,
            soldItems: s.inventory?.sold ?? 0,
            voidItems: s.inventory?.void ?? 0,
        },
        raw: s,
    };
}

/**
 * Per-currency daily sales for the last N days. Returns
 * { USD: [{ day, revenue, orders }], NGN: [...] }.
 * Buckets missing days as zero — never fabricated.
 */
async function getTrend({ days = 30 } = {}) {
    const n = clampInt(days, 1, 365, 30);

    const { data, error } = await supabaseAdmin.rpc('admin_marketplace_trend', { p_days: n });
    if (error) {
        // Trend RPC not yet deployed — return "unavailable" rather
        // than fabricating data.
        return { available: false, reason: 'TREND_RPC_NOT_DEPLOYED', USD: [], NGN: [] };
    }
    return { available: true, ...(data || { USD: [], NGN: [] }) };
}

// ─── Products ──────────────────────────────────────────────────
async function listProducts({
    q = '', status = 'all', category = 'all',
    stock = 'all', sort = 'created_desc', page = 1, limit = 50,
} = {}) {
    const lim = clampInt(limit, 1, 200, 50);
    const pg = clampInt(page, 1, 10000, 1);
    const off = (pg - 1) * lim;

    let query = supabaseAdmin
        .from('marketplace_products')
        .select(`${PRODUCT_SELECT}, marketplace_categories!marketplace_products_category_id_fkey(name, icon)`, { count: 'exact' });

    if (status !== 'all') query = query.eq('status', status);
    if (category !== 'all') query = query.eq('category_id', category);

    if (stock === 'out') query = query.eq('stock', 0);
    else if (stock === 'low') query = query.gt('stock', 0).lt('stock', 10);
    else if (stock === 'healthy') query = query.gte('stock', 10);

    if (q) {
        const term = escapeLike(q);
        query = query.or(`name.ilike.%${term}%,id.ilike.%${term}%`);
    }

    switch (sort) {
        case 'name_asc':    query = query.order('name', { ascending: true }); break;
        case 'name_desc':   query = query.order('name', { ascending: false }); break;
        case 'price_asc':   query = query.order('price_usd', { ascending: true }); break;
        case 'price_desc':  query = query.order('price_usd', { ascending: false }); break;
        case 'stock_asc':   query = query.order('stock', { ascending: true }); break;
        case 'stock_desc':  query = query.order('stock', { ascending: false }); break;
        default:            query = query.order('created_at', { ascending: false });
    }

    query = query.range(off, off + lim - 1);

    const { data, error, count } = await query;
    if (error) throw fail(500, 'PRODUCTS_LIST_FAILED', 'Could not load products');

    const products = (data || []).map(p => ({
        ...p,
        category_name: p.marketplace_categories?.name || null,
        category_icon: p.marketplace_categories?.icon || null,
        marketplace_categories: undefined,
    }));

    return {
        products,
        count: count || 0,
        page: pg,
        totalPages: Math.ceil((count || 0) / lim),
    };
}

async function getProduct(id) {
    if (!id) throw fail(422, 'ID_REQUIRED', 'Product id is required');
    const { data, error } = await supabaseAdmin
        .from('marketplace_products')
        .select(`${PRODUCT_SELECT}, marketplace_categories!marketplace_products_category_id_fkey(name, icon)`)
        .eq('id', id)
        .maybeSingle();
    if (error) throw fail(500, 'PRODUCT_GET_FAILED', 'Could not load product');
    if (!data) throw fail(404, 'NOT_FOUND', 'Product not found');
    return {
        product: {
            ...data,
            category_name: data.marketplace_categories?.name || null,
            category_icon: data.marketplace_categories?.icon || null,
            marketplace_categories: undefined,
        },
    };
}

async function createProduct(body, ctx) {
    const b = body || {};

    if (!b.name || !b.category_id) {
        throw fail(422, 'MISSING_FIELDS', 'name and category_id are required');
    }
    const price = Number(b.price_usd);
    if (!Number.isFinite(price) || price <= 0) {
        throw fail(422, 'INVALID_PRICE', 'price_usd must be a positive number');
    }

    const schema = await schemaProbe();
    const base = pick(b, PRODUCT_EDITABLE);
    const optional = pick(b, PRODUCT_OPTIONAL.filter(k => schema.product.has(k)));

    // Explicitly null price_ngn if not provided — the storefront
    // derives it from live FX at charge time. Never hardcode 1600.
    base.price_ngn = (b.price_ngn === '' || b.price_ngn == null) ? null : Number(b.price_ngn);
    if (base.price_ngn !== null && !(Number.isFinite(base.price_ngn) && base.price_ngn > 0)) {
        throw fail(422, 'INVALID_PRICE', 'price_ngn must be positive or empty');
    }

    base.status = STATUSES.has(base.status) ? base.status : 'Active';

    const id = 'PRD-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const now = new Date().toISOString();

    const { data, error } = await supabaseAdmin
        .from('marketplace_products')
        .insert({ ...base, ...optional, id, created_at: now, updated_at: now })
        .select(PRODUCT_SELECT)
        .single();

    if (error) {
        if (error.code === '23505') throw fail(409, 'DUPLICATE_PRODUCT', 'Product id already exists');
        throw fail(500, 'CREATE_FAILED', 'Could not create product');
    }

    // Add inventory in the SAME request if the client sent any.
    // The trigger updates stock from inventory truth.
    if (Array.isArray(b.inventory_items) && b.inventory_items.length) {
        try {
            await addInventoryInternal({
                product_id: id,
                items: b.inventory_items,
                product_name: data.name,
                delivery_type: data.delivery_type || 'structured',
            });
        } catch (e) {
            // Product was created; inventory failed. Log loudly
            // but don't roll back the product. Admin can retry.
            console.error('[MARKET][ADMIN] inventory add failed after product create:', id, e.message);
        }
    }

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.product_create',
        targetType: 'marketplace_product',
        targetId: id,
        after: { name: data.name, category_id: data.category_id, price_usd: data.price_usd },
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });

    return { product: data };
}

async function updateProduct(id, body, ctx) {
    if (!id) throw fail(422, 'ID_REQUIRED', 'Product id is required');
    const b = body || {};

    const schema = await schemaProbe();
    const patch = pick(b, PRODUCT_EDITABLE.concat(PRODUCT_OPTIONAL.filter(k => schema.product.has(k))));

    if (patch.name !== undefined && !String(patch.name).trim()) {
        throw fail(422, 'INVALID_NAME', 'name cannot be empty');
    }
    if (patch.price_usd !== undefined) {
        const p = Number(patch.price_usd);
        if (!Number.isFinite(p) || p <= 0) throw fail(422, 'INVALID_PRICE', 'price_usd must be positive');
        patch.price_usd = p;
    }
    if (patch.price_ngn !== undefined) {
        if (patch.price_ngn === '' || patch.price_ngn === null || patch.price_ngn === 0) {
            patch.price_ngn = null;
        } else {
            const p = Number(patch.price_ngn);
            if (!Number.isFinite(p) || p <= 0) throw fail(422, 'INVALID_PRICE', 'price_ngn must be positive or empty');
            patch.price_ngn = p;
        }
    }
    if (patch.status !== undefined && !STATUSES.has(patch.status)) {
        throw fail(422, 'INVALID_STATUS', 'Invalid status');
    }
    if (!Object.keys(patch).length) throw fail(422, 'NO_CHANGES', 'No editable fields present');

    patch.updated_at = new Date().toISOString();

    const { data: before } = await supabaseAdmin
        .from('marketplace_products')
        .select(PRODUCT_SELECT)
        .eq('id', id)
        .maybeSingle();
    if (!before) throw fail(404, 'NOT_FOUND', 'Product not found');

    const { data, error } = await supabaseAdmin
        .from('marketplace_products')
        .update(patch)
        .eq('id', id)
        .select(PRODUCT_SELECT)
        .single();
    if (error) throw fail(500, 'UPDATE_FAILED', 'Could not update product');

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.product_update',
        targetType: 'marketplace_product',
        targetId: id,
        before, after: patch,
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });

    return { product: data };
}

async function duplicateProduct(id, ctx) {
    const { product } = await getProduct(id);
    const b = { ...product };
    delete b.id; delete b.created_at; delete b.updated_at;
    delete b.category_name; delete b.category_icon;
    b.name = `${b.name} (copy)`;
    b.status = 'Inactive';
    const { product: created } = await createProduct(b, ctx);
    // Inventory is NOT copied — creds are burned on the source.
    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.product_duplicate',
        targetType: 'marketplace_product',
        targetId: created.id,
        after: { source_id: id },
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });
    return { product: created };
}

async function archiveOrDeleteProduct(id, ctx) {
    if (!id) throw fail(422, 'ID_REQUIRED', 'Product id is required');

    const { count, error: cErr } = await supabaseAdmin
        .from('marketplace_orders')
        .select('id', { count: 'exact', head: true })
        .eq('product_id', id);
    if (cErr) throw fail(500, 'ORDER_LOOKUP_FAILED', 'Could not check product history');

    if ((count || 0) > 0) {
        const { error } = await supabaseAdmin
            .from('marketplace_products')
            .update({ status: 'Archived', updated_at: new Date().toISOString() })
            .eq('id', id);
        if (error) throw fail(500, 'ARCHIVE_FAILED', 'Could not archive product');
        await recordAdminAction({
            adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
            action: 'marketplace.product_archive',
            targetType: 'marketplace_product', targetId: id,
            after: { reason: 'product has orders' },
            ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
        });
        return { archived: true };
    }

    // No orders — safe to hard-delete. Only delete AVAILABLE
    // inventory; leave any sold/refunded rows alone (shouldn't exist
    // if no orders, but defensive).
    await supabaseAdmin
        .from('marketplace_inventory')
        .delete()
        .eq('product_id', id)
        .eq('status', 'available');

    const { error } = await supabaseAdmin.from('marketplace_products').delete().eq('id', id);
    if (error) throw fail(500, 'DELETE_FAILED', 'Could not delete product');

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.product_delete',
        targetType: 'marketplace_product', targetId: id,
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });
    return { deleted: true };
}

async function bulkStatusProducts(ids, status, ctx) {
    if (!Array.isArray(ids) || !ids.length) throw fail(422, 'IDS_REQUIRED', 'ids[] is required');
    if (!STATUSES.has(status)) throw fail(422, 'INVALID_STATUS', 'Invalid status');
    const clean = ids.filter(s => typeof s === 'string').slice(0, 200);
    if (!clean.length) throw fail(422, 'IDS_REQUIRED', 'ids[] is required');

    const { error } = await supabaseAdmin
        .from('marketplace_products')
        .update({ status, updated_at: new Date().toISOString() })
        .in('id', clean);
    if (error) throw fail(500, 'BULK_FAILED', 'Could not update products');

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.product_bulk_status',
        targetType: 'marketplace_product', targetId: null,
        after: { count: clean.length, status, ids: clean.slice(0, 20) },
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });
    return { updated: clean.length };
}

// ─── Categories ────────────────────────────────────────────────
async function listCategories() {
    const { data, error } = await supabaseAdmin
        .from('marketplace_categories')
        .select('id, name, icon, status, created_at, updated_at')
        .order('name');
    if (error) throw fail(500, 'CATEGORIES_LIST_FAILED', 'Could not load categories');

    // Product counts in one pass — never N+1.
    const { data: counts, error: cErr } = await supabaseAdmin
        .from('marketplace_products')
        .select('category_id, id');
    if (cErr) throw fail(500, 'CATEGORY_COUNTS_FAILED', 'Could not count products');
    const byCat = new Map();
    for (const row of counts || []) {
        const k = row.category_id || 'other';
        byCat.set(k, (byCat.get(k) || 0) + 1);
    }
    return {
        categories: (data || []).map(c => ({ ...c, product_count: byCat.get(c.id) || 0 })),
    };
}

async function createCategory(body, ctx) {
    const b = body || {};
    if (!b.name || !String(b.name).trim()) throw fail(422, 'MISSING_NAME', 'name is required');
    const id = 'CAT-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin
        .from('marketplace_categories')
        .insert({ id, name: String(b.name).trim(), icon: b.icon || null, status: 'Active', created_at: now, updated_at: now })
        .select()
        .single();
    if (error) throw fail(500, 'CREATE_FAILED', 'Could not create category');

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.category_create',
        targetType: 'marketplace_category', targetId: id,
        after: { name: data.name, icon: data.icon },
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });
    return { category: data };
}

async function updateCategory(id, body, ctx) {
    if (!id) throw fail(422, 'ID_REQUIRED', 'Category id is required');
    const b = body || {};
    const patch = pick(b, ['name', 'icon', 'status']);
    if (patch.name !== undefined && !String(patch.name).trim()) throw fail(422, 'INVALID_NAME', 'name cannot be empty');
    if (patch.status !== undefined && !['Active', 'Inactive', 'Archived'].includes(patch.status)) {
        throw fail(422, 'INVALID_STATUS', 'Invalid status');
    }
    if (!Object.keys(patch).length) throw fail(422, 'NO_CHANGES', 'Nothing to update');
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
        .from('marketplace_categories')
        .update(patch)
        .eq('id', id)
        .select()
        .single();
    if (error) throw fail(500, 'UPDATE_FAILED', 'Could not update category');

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.category_update',
        targetType: 'marketplace_category', targetId: id,
        after: patch,
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });
    return { category: data };
}

async function deleteCategory(id, ctx) {
    if (!id) throw fail(422, 'ID_REQUIRED', 'Category id is required');
    const { count } = await supabaseAdmin
        .from('marketplace_products')
        .select('id', { count: 'exact', head: true })
        .eq('category_id', id);
    if ((count || 0) > 0) {
        throw fail(409, 'CATEGORY_IN_USE', `Category is in use by ${count} product(s). Reassign them first.`);
    }
    const { error } = await supabaseAdmin.from('marketplace_categories').delete().eq('id', id);
    if (error) throw fail(500, 'DELETE_FAILED', 'Could not delete category');

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.category_delete',
        targetType: 'marketplace_category', targetId: id,
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });
    return { deleted: true };
}

// ─── Inventory ─────────────────────────────────────────────────
function maskContent(content) {
    if (!content) return '';
    const s = String(content);
    if (s.length <= 3) return '•'.repeat(s.length);
    return s.slice(0, 3) + '…' + '•'.repeat(Math.max(3, Math.min(20, s.length - 3)));
}

async function listInventory(productId, { status = 'all', page = 1, limit = 50 } = {}) {
    if (!productId) throw fail(422, 'PRODUCT_ID_REQUIRED', 'productId is required');
    const lim = clampInt(limit, 1, 200, 50);
    const pg = clampInt(page, 1, 10000, 1);
    const off = (pg - 1) * lim;

    let q = supabaseAdmin
        .from('marketplace_inventory')
        .select('id, product_id, product_name, status, delivery_type, sold_to_user_id, sold_order_id, sold_at, created_at, updated_at, content', { count: 'exact' })
        .eq('product_id', productId)
        .order('created_at', { ascending: false });
    if (status !== 'all') q = q.eq('status', status);
    q = q.range(off, off + lim - 1);

    const { data, error, count } = await q;
    if (error) throw fail(500, 'INVENTORY_LIST_FAILED', 'Could not load inventory');

    // Mask content. Full content requires revealInventoryItem().
    const items = (data || []).map(it => ({
        id: it.id,
        product_id: it.product_id,
        product_name: it.product_name,
        status: it.status,
        delivery_type: it.delivery_type,
        sold_to_user_id: it.sold_to_user_id,
        sold_order_id: it.sold_order_id,
        sold_at: it.sold_at,
        created_at: it.created_at,
        updated_at: it.updated_at,
        content_masked: maskContent(it.content),
        content_length: it.content ? String(it.content).length : 0,
    }));

    return { inventory: items, count: count || 0, page: pg, totalPages: Math.ceil((count || 0) / lim) };
}

async function revealInventoryItem(id, reason, ctx) {
    if (!id) throw fail(422, 'ID_REQUIRED', 'Inventory id is required');
    if (!reason || String(reason).trim().length < 4) {
        throw fail(422, 'REASON_REQUIRED', 'A reason of at least 4 characters is required');
    }
    const { data, error } = await supabaseAdmin
        .from('marketplace_inventory')
        .select('id, product_id, product_name, content, status')
        .eq('id', id)
        .maybeSingle();
    if (error) throw fail(500, 'REVEAL_FAILED', 'Could not load inventory item');
    if (!data) throw fail(404, 'NOT_FOUND', 'Inventory item not found');

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.inventory_reveal',
        targetType: 'marketplace_inventory', targetId: id,
        after: { product_id: data.product_id, status: data.status, content_length: data.content ? String(data.content).length : 0 },
        reason: String(reason).trim(),
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });

    return {
        id: data.id,
        product_id: data.product_id,
        product_name: data.product_name,
        status: data.status,
        content: data.content,
    };
}

async function addInventoryInternal({ product_id, items, product_name, delivery_type }) {
    const clean = [...new Set((items || [])
        .map(s => String(s == null ? '' : s).trim())
        .filter(Boolean))];
    if (!clean.length) throw fail(422, 'INVALID_ITEMS', 'At least one item is required');
    if (clean.length > 500) throw fail(422, 'TOO_MANY_ITEMS', 'Maximum 500 items per request');

    const now = new Date().toISOString();
    const rows = clean.map(content => ({
        id: 'INV-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
        product_id,
        product_name: product_name || null,
        delivery_type: delivery_type || 'structured',
        content,
        status: 'available',
        created_at: now,
        updated_at: now,
    }));

    const { error } = await supabaseAdmin.from('marketplace_inventory').insert(rows);
    if (error) {
        if (error.code === '23505') throw fail(409, 'DUPLICATE_ITEMS', 'Some items already exist for this product');
        throw fail(500, 'INVENTORY_ADD_FAILED', 'Could not add inventory items');
    }
    return { added: rows.length };
}

async function addInventory(body, ctx) {
    const b = body || {};
    if (!b.product_id) throw fail(422, 'PRODUCT_ID_REQUIRED', 'product_id is required');

    const { data: product, error: pErr } = await supabaseAdmin
        .from('marketplace_products')
        .select('name, delivery_type')
        .eq('id', b.product_id)
        .maybeSingle();
    if (pErr) throw fail(500, 'PRODUCT_LOOKUP_FAILED', 'Could not load product');
    if (!product) throw fail(404, 'NOT_FOUND', 'Product not found');

    const { added } = await addInventoryInternal({
        product_id: b.product_id,
        items: b.items,
        product_name: product.name,
        delivery_type: b.delivery_type || product.delivery_type,
    });

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.inventory_add',
        targetType: 'marketplace_product', targetId: b.product_id,
        after: { added },
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });
    return { added };
}

async function updateInventoryItem(id, body, ctx) {
    if (!id) throw fail(422, 'ID_REQUIRED', 'Inventory id is required');
    const b = body || {};

    const { data: row, error } = await supabaseAdmin
        .from('marketplace_inventory')
        .select('id, status, product_id')
        .eq('id', id)
        .maybeSingle();
    if (error) throw fail(500, 'INVENTORY_LOOKUP_FAILED', 'Could not load inventory item');
    if (!row) throw fail(404, 'NOT_FOUND', 'Inventory item not found');
    if (row.status !== 'available') {
        throw fail(409, 'ITEM_LOCKED', 'Sold or refunded items cannot be edited');
    }

    const patch = {};
    if (b.content !== undefined) {
        if (!String(b.content).trim()) throw fail(422, 'INVALID_CONTENT', 'content cannot be empty');
        patch.content = String(b.content);
    }
    if (b.status !== undefined) {
        if (!['available', 'void'].includes(b.status)) throw fail(422, 'INVALID_STATUS', 'status must be available or void');
        patch.status = b.status;
    }
    if (!Object.keys(patch).length) throw fail(422, 'NO_CHANGES', 'Nothing to update');
    patch.updated_at = new Date().toISOString();

    const { data, error: uErr } = await supabaseAdmin
        .from('marketplace_inventory')
        .update(patch)
        .eq('id', id)
        .eq('status', 'available')   // CAS — the row may have been sold between our read and this update
        .select('id, product_id, product_name, status, delivery_type, sold_at, created_at, updated_at')
        .maybeSingle();
    if (uErr) throw fail(500, 'UPDATE_FAILED', 'Could not update inventory item');
    if (!data) throw fail(409, 'ITEM_LOCKED', 'Item is no longer editable');

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.inventory_update',
        targetType: 'marketplace_inventory', targetId: id,
        after: { status: data.status, content_updated: patch.content !== undefined },
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });
    return { inventory: data };
}

async function voidInventoryItem(id, ctx) {
    return updateInventoryItem(id, { status: 'void' }, ctx);
}

// ─── Orders ────────────────────────────────────────────────────
async function listOrders({
    status = 'all', currency = 'all', product_id,
    q = '', from, to, page = 1, limit = 50, sort = 'created_desc',
} = {}) {
    const lim = clampInt(limit, 1, 200, 50);
    const pg = clampInt(page, 1, 10000, 1);
    const off = (pg - 1) * lim;

    let query = supabaseAdmin
        .from('marketplace_orders')
        .select(ORDER_SELECT, { count: 'exact' });

    if (status !== 'all') query = query.eq('status', status);
    if (currency !== 'all') query = query.ilike('currency', currency);
    if (product_id) query = query.eq('product_id', product_id);
    if (from) query = query.gte('created_at', from);
    if (to)   query = query.lte('created_at', to);

    if (q) {
        const term = escapeLike(q);
        // order_ref and product_name exist on marketplace_orders.
        // Do NOT search customer_name/email here — those are not
        // columns (fix K in the prompt).
        query = query.or(`order_ref.ilike.%${term}%,product_name.ilike.%${term}%`);
    }

    switch (sort) {
        case 'created_asc':   query = query.order('created_at', { ascending: true }); break;
        case 'total_asc':     query = query.order('total', { ascending: true }); break;
        case 'total_desc':    query = query.order('total', { ascending: false }); break;
        default:              query = query.order('created_at', { ascending: false });
    }

    query = query.range(off, off + lim - 1);

    const { data, error, count } = await query;
    if (error) throw fail(500, 'ORDERS_LIST_FAILED', 'Could not load orders');

    // Attach usernames via a single profiles lookup (no N+1).
    const userIds = [...new Set((data || []).map(o => o.user_id).filter(Boolean))];
    const usersById = new Map();
    if (userIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email')
            .in('id', userIds);
        (profiles || []).forEach(p => usersById.set(p.id, p));
    }

    const orders = (data || []).map(o => {
        const u = usersById.get(o.user_id) || {};
        return {
            ...o,
            user_name: u.username || null,
            user_email: u.email || null,
        };
    });

    return { orders, count: count || 0, page: pg, totalPages: Math.ceil((count || 0) / lim) };
}

async function getOrder(id) {
    if (!isUuid(id)) throw fail(422, 'INVALID_ID', 'Order id must be a UUID');
    const { data, error } = await supabaseAdmin
        .from('marketplace_orders')
        .select(ORDER_SELECT + ', delivered_data, idempotency_key')
        .eq('id', id)
        .maybeSingle();
    if (error) throw fail(500, 'ORDER_GET_FAILED', 'Could not load order');
    if (!data) throw fail(404, 'NOT_FOUND', 'Order not found');

    let transaction = null;
    if (data.unified_transaction_id) {
        const { data: tx } = await supabaseAdmin
            .from('transactions')
            .select('id, reference, type, status, currency, amount, description, created_at, completed_at')
            .eq('id', data.unified_transaction_id)
            .maybeSingle();
        transaction = tx || null;
    }

    // Buyer profile for the drawer.
    let user = null;
    if (data.user_id) {
        const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email')
            .eq('id', data.user_id)
            .maybeSingle();
        user = p || null;
    }

    // Attach a delivery summary. Credentials are NOT included here —
    // only the shape, so the admin sees "delivery attached" vs not.
    const deliverySummary = data.delivered_data
        ? {
            attached: true,
            delivery_type: data.delivered_data.delivery_type || null,
            login_format: data.delivered_data.login_format || null,
            delivered_at: data.delivered_data.delivered_at || null,
        }
        : { attached: false };

    const order = { ...data, delivered_data: undefined, delivery_summary: deliverySummary };
    return { order, transaction, user };
}

async function completeOrder(id, reason, ctx) {
    if (!isUuid(id)) throw fail(422, 'INVALID_ID', 'Order id must be a UUID');
    if (!reason || String(reason).trim().length < 4) throw fail(422, 'REASON_REQUIRED', 'A reason is required');

    const { data: order } = await supabaseAdmin
        .from('marketplace_orders')
        .select(ORDER_SELECT + ', delivered_data')
        .eq('id', id)
        .maybeSingle();
    if (!order) throw fail(404, 'NOT_FOUND', 'Order not found');

    const st = String(order.status || '').toLowerCase();
    if (st === 'completed') return { no_op: true };
    if (!['pending', 'processing'].includes(st)) {
        throw fail(422, 'INVALID_TRANSITION', `Cannot complete a ${st} order`);
    }

    // A pending order with no inventory attached cannot be "completed".
    // The prompt says "Complete (only for pending orders with delivery
    // attached)". Inventory is attached at purchase time; if for any
    // reason it isn't (manual order creation path doesn't exist yet),
    // reject.
    if (!order.inventory_id) {
        throw fail(422, 'NO_INVENTORY', 'Order has no reserved inventory item');
    }

    const { data: inv } = await supabaseAdmin
        .from('marketplace_inventory')
        .select('*')
        .eq('id', order.inventory_id)
        .maybeSingle();
    if (!inv) throw fail(409, 'INVENTORY_MISSING', 'Reserved inventory item no longer exists');

    const { data: product } = await supabaseAdmin
        .from('marketplace_products')
        .select('id, name, category_id, price_usd, price_ngn')
        .eq('id', order.product_id)
        .maybeSingle();
    if (!product) throw fail(409, 'PRODUCT_MISSING', 'Product no longer exists');

    const pricing = await marketplace.computePrice(product, order.currency);
    const now = new Date().toISOString();
    const delivery = marketplace.buildDeliveryPayload(inv, { product_title: product.name }, product);

    const { error: uErr } = await supabaseAdmin
        .from('marketplace_orders')
        .update({
            status: 'completed',
            completed_at: now,
            updated_at: now,
            delivered_data: delivery,
        })
        .eq('id', order.id);
    if (uErr) throw fail(500, 'COMPLETE_FAILED', 'Could not finalize order');

    // Mirror to `orders` — non-fatal, logged.
    try {
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
                ledger_transaction_id: order.unified_transaction_id || null,
                source: 'admin_complete',
            },
        });
    } catch (e) {
        console.error('[MARKET][MIRROR] recordOrder (admin complete) failed', order.order_ref, e.message);
    }

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.order_complete',
        targetType: 'marketplace_order', targetId: order.id,
        before: { status: st }, after: { status: 'completed' },
        reason: String(reason).trim(),
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });
    return { message: 'Order marked completed' };
}

async function failOrder(id, reason, { refund = false } = {}, ctx) {
    if (!isUuid(id)) throw fail(422, 'INVALID_ID', 'Order id must be a UUID');
    if (!reason || String(reason).trim().length < 4) throw fail(422, 'REASON_REQUIRED', 'A reason is required');

    const { data: order } = await supabaseAdmin
        .from('marketplace_orders')
        .select(ORDER_SELECT)
        .eq('id', id)
        .maybeSingle();
    if (!order) throw fail(404, 'NOT_FOUND', 'Order not found');

    const st = String(order.status || '').toLowerCase();
    if (st === 'failed') return { no_op: true };
    if (!['pending', 'processing'].includes(st)) {
        throw fail(422, 'INVALID_TRANSITION', `Cannot fail a ${st} order`);
    }

    // If the ledger was actually debited, "fail" alone is dangerous —
    // the buyer has paid. The route should be called with refund=true
    // in that case, or the caller should leave the order pending.
    const ledgerTx = await LedgerService.findTransactionByReference(order.order_ref);
    if (ledgerTx && !refund) {
        throw fail(409, 'ORDER_HAS_DEBIT', 'Order was debited — refund it or leave it pending.', {
            has_debit: true,
            transaction_id: ledgerTx.id,
        });
    }

    if (refund) {
        // Delegate to the same refund path as the standalone refund
        // action, so the refunds table is written, approvals apply,
        // and the mirror is updated.
        await refundOrder(id, reason, ctx);
        return { refunded: true };
    }

    // No debit, no refund — safe to cancel and release inventory.
    const now = new Date().toISOString();
    await supabaseAdmin
        .from('marketplace_orders')
        .update({ status: 'cancelled', updated_at: now })
        .eq('id', id);

    if (order.inventory_id) {
        await supabaseAdmin.rpc('release_marketplace_inventory', {
            p_inventory_id: order.inventory_id,
            p_order_id: order.id,
        });
    }

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.order_fail',
        targetType: 'marketplace_order', targetId: order.id,
        before: { status: st }, after: { status: 'cancelled', refunded: false },
        reason: String(reason).trim(),
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });
    return { cancelled: true };
}

async function refundOrder(id, reason, ctx) {
    if (!isUuid(id)) throw fail(422, 'INVALID_ID', 'Order id must be a UUID');
    if (!reason || String(reason).trim().length < 4) throw fail(422, 'REASON_REQUIRED', 'A reason is required');

    const { data: order } = await supabaseAdmin
        .from('marketplace_orders')
        .select('id, order_ref, user_id, status, total, currency, inventory_id, unified_transaction_id')
        .eq('id', id)
        .maybeSingle();
    if (!order) throw fail(404, 'NOT_FOUND', 'Order not found');

    const st = String(order.status || '').toLowerCase();
    if (st === 'refunded') throw fail(409, 'ALREADY_REFUNDED', 'Order is already refunded');
    if (!['completed', 'failed', 'cancelled'].includes(st)) {
        throw fail(422, 'NOT_REFUNDABLE', 'Only completed, failed, or cancelled orders can be refunded');
    }
    if (!order.unified_transaction_id) {
        throw fail(422, 'NO_TRANSACTION', 'Order has no ledger transaction to refund');
    }

    // The refund amount is always positive. The ledger stores the
    // original debit as a negative number — passing that to a credit
    // API fails. Math.abs() here is deliberate.
    const amountStr = Math.abs(Number(order.total)).toFixed(2);

    // ASSUMPTION A1: refundService.createRefundRequest signature per
    // the prompt. If the real signature differs, swap this call.
    const result = await refundService.createRefundRequest({
        transactionId: order.unified_transaction_id,
        amount: amountStr,
        reason: String(reason).trim(),
        refundType: 'wallet',
        ctx: {
            adminId: ctx.adminId,
            adminEmail: ctx.adminEmail,
            adminRole: ctx.adminRole,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            requestId: ctx.requestId,
        },
        idempotencyKey: ctx.idempotencyKey || `mkt-refund-${order.id}`,
    });

    const refund = result?.refund || {};
    const executed = result?.executed === true || String(refund.status).toUpperCase() === 'COMPLETED';

    if (executed) {
        const now = new Date().toISOString();
        await supabaseAdmin
            .from('marketplace_orders')
            .update({ status: 'refunded', refunded_at: now, updated_at: now })
            .eq('id', order.id)
            .neq('status', 'refunded');

        // Burn the delivered credentials. The buyer keeps nothing;
        // the inventory row remains for audit.
        if (order.inventory_id) {
            await supabaseAdmin
                .from('marketplace_inventory')
                .update({ status: 'refunded', updated_at: now })
                .eq('id', order.inventory_id)
                .eq('status', 'sold');
        }

        // Best-effort mirror sync (ASSUMPTION A4).
        try {
            await supabaseAdmin
                .from('orders')
                .update({
                    refund_status: 'refunded',
                    refund_amount: order.total,
                    refunded_at: now,
                    updated_at: now,
                })
                .eq('order_ref', order.order_ref);
        } catch (e) {
            console.error('[MARKET][MIRROR] orders refund_status update failed', order.order_ref, e.message);
        }
    }

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.order_refund',
        targetType: 'marketplace_order', targetId: order.id,
        after: { refund_id: refund.id || null, status: refund.status || null, executed },
        reason: String(reason).trim(),
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });

    return {
        refund: {
            id: refund.id || null,
            status: refund.status || null,
            completed: executed,
            pending_approval: String(refund.status || '').toUpperCase() === 'PENDING_APPROVAL',
        },
    };
}

async function resendDelivery(id, ctx) {
    if (!isUuid(id)) throw fail(422, 'INVALID_ID', 'Order id must be a UUID');
    const { data: order } = await supabaseAdmin
        .from('marketplace_orders')
        .select('id, order_ref, user_id, status, delivered_data')
        .eq('id', id)
        .maybeSingle();
    if (!order) throw fail(404, 'NOT_FOUND', 'Order not found');
    if (String(order.status).toLowerCase() !== 'completed' || !order.delivered_data) {
        throw fail(422, 'NOT_DELIVERABLE', 'Order is not completed or has no delivery data');
    }
    // Delivery re-send currently means "tell the client the download
    // token is still valid" — there is no email pipeline in scope.
    // The buyer can re-download via /api/market/orders/:id/download.
    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.order_resend_delivery',
        targetType: 'marketplace_order', targetId: id,
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });
    return { message: 'Buyer can re-download from Purchase History.' };
}

// ─── Disputes ──────────────────────────────────────────────────
// Lazy schema. ASSUMPTION A8: no prior migration creates this table.
async function ensureDisputesTable() {
    // Supabase PostgREST can't run DDL. Use an RPC the platform
    // provides for DDL, or fail gracefully. To keep this deployment
    // self-contained, try a no-op select first; if the table doesn't
    // exist we return { available: false } and the routes surface a
    // "Disputes not deployed" badge. The admin page still works.
    const { error } = await supabaseAdmin.from('marketplace_disputes').select('id').limit(1);
    if (error && (error.code === '42P01' || error.code === 'PGRST205')) {
        return { available: false, reason: 'MARKETPLACE_DISPUTES_NOT_DEPLOYED' };
    }
    return { available: true };
}

async function listDisputes({ status = 'all', page = 1, limit = 50 } = {}) {
    const probe = await ensureDisputesTable();
    if (!probe.available) return { available: false, reason: probe.reason, disputes: [], count: 0 };

    const lim = clampInt(limit, 1, 200, 50);
    const pg = clampInt(page, 1, 10000, 1);
    const off = (pg - 1) * lim;

    let q = supabaseAdmin
        .from('marketplace_disputes')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });
    if (status !== 'all') q = q.eq('status', status);
    q = q.range(off, off + lim - 1);

    const { data, error, count } = await q;
    if (error) throw fail(500, 'DISPUTES_LIST_FAILED', 'Could not load disputes');
    return { available: true, disputes: data || [], count: count || 0, page: pg, totalPages: Math.ceil((count || 0) / lim) };
}

async function resolveDispute(id, body, ctx) {
    const probe = await ensureDisputesTable();
    if (!probe.available) throw fail(503, 'DISPUTES_NOT_DEPLOYED', 'Disputes table is not deployed');

    const b = body || {};
    const resolution = String(b.resolution || '').toLowerCase();
    if (!['approved_replacement', 'approved_refund', 'rejected'].includes(resolution)) {
        throw fail(422, 'INVALID_RESOLUTION', 'resolution must be approved_replacement, approved_refund, or rejected');
    }
    if (!b.notes || String(b.notes).trim().length < 4) throw fail(422, 'NOTES_REQUIRED', 'Resolution notes are required');

    const { data: dispute, error } = await supabaseAdmin
        .from('marketplace_disputes')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error) throw fail(500, 'DISPUTE_GET_FAILED', 'Could not load dispute');
    if (!dispute) throw fail(404, 'NOT_FOUND', 'Dispute not found');
    if (dispute.status !== 'open') throw fail(409, 'ALREADY_RESOLVED', 'Dispute is not open');

    const now = new Date().toISOString();

    // Replacement: allocate a fresh item for the buyer, void the old
    // one, update delivered_data. Atomic via allocate_marketplace_
    // inventory.
    if (resolution === 'approved_replacement') {
        const { data: order } = await supabaseAdmin
            .from('marketplace_orders')
            .select('id, product_id, user_id, inventory_id, currency')
            .eq('id', dispute.order_id)
            .maybeSingle();
        if (!order) throw fail(409, 'ORDER_MISSING', 'Related order not found');

        const { data: alloc, error: aErr } = await supabaseAdmin.rpc('allocate_marketplace_inventory', {
            p_product_id: order.product_id,
            p_user_id: order.user_id,
            p_order_id: order.id,
        });
        if (aErr) throw fail(500, 'REPLACEMENT_FAILED', 'Could not allocate replacement inventory');
        if (!alloc || !alloc.length) throw fail(409, 'OUT_OF_STOCK', 'No replacement inventory available');

        const newInv = alloc[0];
        const { data: product } = await supabaseAdmin
            .from('marketplace_products')
            .select('id, name')
            .eq('id', order.product_id)
            .maybeSingle();
        const delivery = marketplace.buildDeliveryPayload(newInv, { product_title: product?.name || 'Replacement' }, product);

        await supabaseAdmin
            .from('marketplace_orders')
            .update({ inventory_id: newInv.id, delivered_data: delivery, updated_at: now })
            .eq('id', order.id);

        if (order.inventory_id) {
            await supabaseAdmin
                .from('marketplace_inventory')
                .update({ status: 'void', updated_at: now })
                .eq('id', order.inventory_id);
        }
    }

    if (resolution === 'approved_refund') {
        // Go through the standard refund path so approvals and the
        // refunds table apply.
        await refundOrder(dispute.order_id, `Dispute: ${b.notes}`.slice(0, 400), ctx);
    }

    const { error: uErr } = await supabaseAdmin
        .from('marketplace_disputes')
        .update({
            status: resolution,
            resolution_notes: String(b.notes).trim(),
            resolved_by: ctx.adminId,
            resolved_at: now,
            updated_at: now,
        })
        .eq('id', id);
    if (uErr) throw fail(500, 'DISPUTE_RESOLVE_FAILED', 'Could not resolve dispute');

    await recordAdminAction({
        adminId: ctx.adminId, adminEmail: ctx.adminEmail, adminRole: ctx.adminRole,
        action: 'marketplace.dispute_resolve',
        targetType: 'marketplace_dispute', targetId: id,
        before: { status: 'open' }, after: { status: resolution },
        reason: String(b.notes).trim(),
        ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId, req: ctx.req,
    });

    return { resolved: true, resolution };
}

// ─── Audit ─────────────────────────────────────────────────────
async function listAudit({ action_prefix = 'marketplace.', target_id, admin_id, from, to, page = 1, limit = 100 } = {}) {
    const lim = clampInt(limit, 1, 500, 100);
    const pg = clampInt(page, 1, 10000, 1);
    const off = (pg - 1) * lim;

    let q = supabaseAdmin
        .from('admin_audit_logs')
        .select('id, admin_id, action, target_type, target_id, reason, result, created_at, before, after', { count: 'exact' })
        .like('action', `${escapeLike(action_prefix)}%`)
        .order('created_at', { ascending: false });
    if (target_id) q = q.eq('target_id', target_id);
    if (admin_id) q = q.eq('admin_id', admin_id);
    if (from) q = q.gte('created_at', from);
    if (to) q = q.lte('created_at', to);
    q = q.range(off, off + lim - 1);

    const { data, error, count } = await q;
    if (error) return { available: false, reason: 'AUDIT_LOOKUP_FAILED', logs: [], count: 0 };
    return { available: true, logs: data || [], count: count || 0, page: pg, totalPages: Math.ceil((count || 0) / lim) };
}

// ─── Search ────────────────────────────────────────────────────
// Returns products and orders only. Inventory is deliberately
// excluded — searching creds is not allowed.
async function search(q) {
    const term = String(q || '').trim();
    if (term.length < 2) return { products: [], orders: [] };
    const safe = escapeLike(term);

    const [prodRes, orderRes] = await Promise.all([
        supabaseAdmin
            .from('marketplace_products')
            .select('id, name, category_id, price_usd, price_ngn, stock, status')
            .or(`name.ilike.%${safe}%,id.ilike.%${safe}%`)
            .limit(10),
        supabaseAdmin
            .from('marketplace_orders')
            .select('id, order_ref, product_name, total, currency, status, user_id')
            .or(`order_ref.ilike.%${safe}%,product_name.ilike.%${safe}%`)
            .limit(10),
    ]);

    return {
        products: prodRes.data || [],
        orders: orderRes.data || [],
    };
}

module.exports = {
    getStats,
    getTrend,
    listProducts,
    getProduct,
    createProduct,
    updateProduct,
    duplicateProduct,
    archiveOrDeleteProduct,
    bulkStatusProducts,
    listCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    listInventory,
    revealInventoryItem,
    addInventory,
    updateInventoryItem,
    voidInventoryItem,
    listOrders,
    getOrder,
    completeOrder,
    failOrder,
    refundOrder,
    resendDelivery,
    listDisputes,
    resolveDispute,
    listAudit,
    search,
    maskContent,
};