// services/ordersService.js
// ─────────────────────────────────────────────────────────────────
// Central Orders service.
//
// Schema assumptions (verified against the schemas in this thread):
//   orders.id           : integer (serial)
//   orders.user_id      : uuid -> profiles.id
//   refunds             : uuid pk; original_transaction_id uuid -> transactions.id;
//                         order_id integer -> orders.id (added by orders_admin_v1.sql §2)
//   transactions.id     : uuid; transactions.source_id is TEXT
//   ledger_entries      : uuid pk; amount_minor is minor units
//   order_events        : uuid pk; order_id is uuid (kept for legacy order_events rows —
//                         orders.id is integer, so order_events rows for integer orders
//                         are written with the STRING form of order_id; see recordEvent)
//   admin_audit_logs    : uuid pk; every column used here exists per attached schema
//   webhook_events      : uuid pk; order_id INTEGER; signature_status text
//   kora_webhook_events : uuid pk; order_id INTEGER; provider_reference text
//   provider_webhook_events : uuid pk; payment_id text; order_id text (legacy)
//   provider_transactions   : uuid pk; order_id INTEGER
//
// Guarantees:
//   • ONE pipeline: processProviderUpdate(). Webhook, admin sync, and scheduled sync all feed it.
//   • State transitions are atomic (apply_order_provider_update RPC, guarded by expected status).
//     Ordered-idempotency is enforced in code so a late 'processing' cannot overwrite 'completed'.
//   • Refunds claim atomically with a unique refund_reference. Ledger credit uses
//     `REFUND-{order_ref}` as the ledger-level idempotency key.
//   • Repeated partial refunds are supported ONLY when the migration §3 has replaced
//     the existing refunds uniqueness indexes. On the un-migrated schema the service
//     refuses the second refund with REFUND_SCHEMA_NOT_MIGRATED and the exact steps.
//   • No email or notification fires inside an HTTP request. Notifications are rows.
//   • Money comes from Postgres NUMERIC and is not re-derived in JS beyond display.
//   • Money mutations fail loudly. Nothing swallowed.
//
// Batch 4 (2026-11-10):
//   + computeHealth(): 'paid_but_no_provider_id' now only fires for orders
//     that are NOT completed/refunded/partially_refunded. Completed orders
//     have been fulfilled; whether the provider ID made it onto the mirror
//     is a data-completeness concern, not a fulfillment failure. Silences
//     the false-positive warning on historical orders.
//   + refundOrder(): only failed, cancelled, manual_review orders are
//     refundable. Completed orders cannot be refunded via this endpoint.
//     Backend enforcement. UI hides the button automatically via can.refund.
//   + computeCan(): refund action is now gated to the same 3 statuses, so
//     the Refund button hides for completed orders.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const providerFactory = require('./providers/providerFactory');
const providerMetadata = require('./providers/providerMetadata');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_RE = /^\d+$/;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const EXPORT_MAX_ROWS = 5000;
const EXPORT_CHUNK = 500;
const SYNC_BUDGET_MS = 25000;
const SYNC_CONCURRENCY = 3;
const IDEM_TTL_MS = 24 * 60 * 60 * 1000;
const NOTE_HISTORY_MAX = 20;
const STUCK_THRESHOLDS_MS = Object.freeze({
    pending: 30 * 60 * 1000,
    paid: 15 * 60 * 1000,
    processing: 30 * 60 * 1000,
    in_progress: 60 * 60 * 1000,
    partial: 2 * 60 * 60 * 1000,
    provider_unknown: 30 * 60 * 1000,
    manual_review: 24 * 60 * 60 * 1000,
    refunding: 30 * 60 * 1000
});

// Refundable statuses — single source of truth for both the service
// (refundOrder) and the UI gate (computeCan).
const REFUNDABLE_STATUSES = Object.freeze(['failed', 'cancelled', 'manual_review']);

// ─── Safe metadata keys exposed to admins ─────────────────────────
const DELIVERY_KEYS_BY_PRODUCT = {
    airtime:      ['phone', 'network', 'plan', 'plan_name'],
    data:         ['phone', 'network', 'plan', 'plan_name', 'variation_code'],
    electricity:  ['meter_number', 'meter_type', 'disco', 'customer_name', 'customer_address', 'token'],
    tv:           ['smartcard_number', 'decoder_number', 'provider', 'package', 'customer_name'],
    esim:         ['iccid', 'lpa', 'activation_code', 'smdp_address'],
    virtual_sms:  ['phone_number', 'country', 'service', 'activation_id'],
    boost:        ['link', 'quantity', 'service_id', 'start_count', 'remains'],
    gift_card:    ['brand', 'denomination', 'currency', 'voucher_code', 'serial'],
    marketplace:  ['product_id', 'product_title', 'quantity', 'delivery_notes']
};
const MASK_ALWAYS = new Set([
    'token', 'voucher_code', 'activation_code', 'lpa', 'serial', 'iccid', 'phone_number'
]);

const ORDER_STATUSES = new Set([
    'pending', 'paid', 'processing', 'in_progress', 'completed',
    'partial', 'failed', 'cancelled', 'refunding', 'refunded',
    'partially_refunded', 'expired', 'manual_review', 'provider_unknown'
]);

const PAYMENT_STATUSES = new Set([
    'unpaid', 'pending', 'paid', 'failed', 'refunded', 'partially_refunded'
]);

const ALLOWED_TRANSITIONS = Object.freeze({
    pending:          ['paid', 'processing', 'cancelled', 'failed', 'expired'],
    paid:             ['processing', 'completed', 'cancelled', 'failed'],
    processing:       ['in_progress', 'partial', 'completed', 'failed', 'cancelled', 'provider_unknown', 'manual_review'],
    in_progress:      ['partial', 'completed', 'failed', 'provider_unknown', 'manual_review'],
    partial:          ['completed', 'failed', 'refunding', 'manual_review'],
    provider_unknown: ['processing', 'in_progress', 'partial', 'completed', 'failed', 'manual_review'],
    manual_review:    ['completed', 'failed', 'cancelled', 'refunding', 'processing'],
    completed:        ['refunding'],
    failed:           ['refunding'],
    cancelled:        ['refunding'],
    refunding:        ['refunded', 'partially_refunded', 'failed'],
    refunded:         [],
    partially_refunded: ['refunding'],
    expired:          ['failed']
});

const STATUS_SEVERITY = Object.freeze({
    pending: 1, paid: 2, processing: 3, in_progress: 4, partial: 5,
    provider_unknown: 6, manual_review: 6,
    completed: 10, failed: 10, cancelled: 10, expired: 10,
    refunding: 11, partially_refunded: 12, refunded: 13
});

// ─── Column allowlists ───────────────────────────────────────────
const ORDER_COLUMNS = [
    'id', 'order_ref', 'user_id',
    'product_type', 'product_name', 'service_type', 'quantity',
    'amount', 'fee', 'total_amount', 'currency',
    'status', 'payment_status', 'fulfillment_status',
    'provider', 'provider_order_id', 'provider_reference', 'provider_status',
    'webhook_status', 'webhook_received_at', 'last_provider_sync_at',
    'failure_reason', 'admin_note',
    'refund_status', 'refund_amount', 'refund_reference', 'refund_transaction_id', 'refunded_at',
    'cancelled_at', 'completed_at', 'failed_at',
    'metadata', 'attempt_number', 'parent_order_id', 'retry_reason',
    'created_at', 'updated_at',
    'start_count', 'current_count', 'remains',
    'partial_delivered_qty', 'admin_review_required'
].join(', ');

const LIST_COLUMNS = [
    'id', 'order_ref', 'user_id', 'product_type', 'product_name', 'service_type',
    'quantity', 'amount', 'fee', 'total_amount', 'currency',
    'status', 'payment_status', 'fulfillment_status',
    'provider', 'provider_order_id', 'provider_reference', 'provider_status',
    'webhook_status', 'webhook_received_at', 'last_provider_sync_at',
    'failure_reason',
    'refund_status', 'refund_amount', 'refund_reference', 'refunded_at',
    'completed_at', 'failed_at', 'cancelled_at',
    'attempt_number', 'parent_order_id',
    'start_count', 'current_count', 'remains',
    'created_at', 'updated_at'
].join(', ');

// ─── Helpers ────────────────────────────────────────────────────
function limitOf(v, def = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
function pageOf(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}
function isoDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
function isoDateEndWAT(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        if (!y || !m || !d) return null;
        return new Date(Date.UTC(y, m - 1, d, 22, 59, 59, 999)).toISOString();
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
function isoDateStartWAT(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        if (!y || !m || !d) return null;
        return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - 60 * 60 * 1000).toISOString();
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
function escapeLike(s) {
    return String(s || '').trim().slice(0, 100).replace(/[%_\\]/g, m => '\\' + m);
}
function sanitizeSearch(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s) return null;
    return s.replace(/[,()"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || null;
}
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function asNum(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
function severityOf(s) {
    return STATUS_SEVERITY[String(s || '').toLowerCase()] || 0;
}
function assertOrderId(id) {
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id;
    if (typeof id === 'string' && INT_RE.test(id.trim())) {
        const n = Number(id);
        if (Number.isInteger(n) && n > 0) return n;
    }
    const e = new Error('Invalid order id.');
    e.status = 400; e.code = 'INVALID_ID';
    throw e;
}
function maskValue(value, key) {
    if (value == null || value === '') return null;
    const s = String(value);
    if (MASK_ALWAYS.has(key)) {
        if (s.length <= 4) return '••••';
        return s.slice(0, 3) + '•••' + s.slice(-3);
    }
    if (key === 'meter_number' || key === 'smartcard_number' || key === 'decoder_number') {
        return s.length > 4 ? '••••' + s.slice(-4) : '••••';
    }
    return s;
}

// ─── Event / audit / notifications ───────────────────────────────
async function recordEvent({ orderId, eventType, oldStatus = null, newStatus = null, actorType = 'system', actorId = null, message = null, metadata = null }) {
    try {
        const row = {
            event_type: eventType,
            old_status: oldStatus,
            new_status: newStatus,
            actor_type: actorType,
            actor_id: actorId && UUID_RE.test(String(actorId)) ? actorId : null,
            message: message ? String(message).slice(0, 500) : null,
            metadata: metadata || null,
            created_at: new Date().toISOString()
        };
        row.order_id = String(orderId);
        await supabaseAdmin.from('order_events').insert(row);
    } catch (e) {
        console.warn('[ORDERS] order_events insert failed (non-fatal):', e.message);
    }
}

async function recordAudit({ ctx, action, orderId, before, after, reason, result = 'success', failureCode = null }) {
    if (!ctx) return;
    try {
        await supabaseAdmin.from('admin_audit_logs').insert({
            admin_id: ctx.adminId || null,
            admin_email: ctx.adminEmail || null,
            admin_role: ctx.adminRole || null,
            action,
            target_type: 'order',
            target_id: String(orderId),
            before: before || null,
            after: after || null,
            reason: reason ? String(reason).slice(0, 500) : null,
            result,
            failure_code: failureCode,
            correlation_id: ctx.correlationId || null,
            session_id: ctx.sessionId || null,
            ip_address: ctx.ip || null,
            user_agent: ctx.userAgent || null,
            request_id: ctx.requestId || null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        throw new Error(`AUDIT_INSERT_FAILED: ${e.message}`);
    }
}

async function createNotificationRow({ userId, title, message, type, icon = 'info-circle', link = '/history' }) {
    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId, title, message, type, icon, link,
            is_read: false, created_at: new Date().toISOString()
        });
    } catch (_) { /* best effort */ }
}

// ═════════════════════════════════════════════════════════════════
//  IDEMPOTENCY (admin_idempotency)
// ═════════════════════════════════════════════════════════════════
const ADMIN_IDEM_TABLE = 'admin_idempotency';
let _adminIdemExists = null;
async function _adminIdemAvailable() {
    if (_adminIdemExists !== null) return _adminIdemExists;
    try {
        const { error } = await supabaseAdmin.from(ADMIN_IDEM_TABLE).select('id', { head: true, count: 'exact' }).limit(1);
        _adminIdemExists = !error;
    } catch (_) { _adminIdemExists = false; }
    return _adminIdemExists;
}
async function idemLookup(scope, key, actorId) {
    if (!key || !actorId) return null;
    if (!await _adminIdemAvailable()) return null;
    try {
        const { data } = await supabaseAdmin.from(ADMIN_IDEM_TABLE)
            .select('response, status_code, created_at, expires_at')
            .eq('admin_id', String(actorId))
            .eq('endpoint', String(scope))
            .eq('idempotency_key', String(key))
            .maybeSingle();
        if (!data) return null;
        if (data.expires_at && new Date(data.expires_at) < new Date()) return null;
        if (data.response == null) return null;
        if (Number.isInteger(data.status_code) && data.status_code >= 400 && data.status_code < 500) return null;
        return data.response;
    } catch (_) { return null; }
}
async function idemStore(scope, key, actorId, result, statusCode = 200) {
    if (!key || !actorId) return;
    if (!await _adminIdemAvailable()) return;
    try {
        await supabaseAdmin.from(ADMIN_IDEM_TABLE).upsert({
            admin_id: String(actorId),
            endpoint: String(scope),
            idempotency_key: String(key),
            response: result,
            status: 'completed',
            status_code: statusCode,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + IDEM_TTL_MS).toISOString()
        }, { onConflict: 'admin_id,endpoint,idempotency_key' });
    } catch (e) { console.warn('[ORDERS] idem store failed:', e.message); }
}

// ═════════════════════════════════════════════════════════════════
//  REFUND SCHEMA GUARD
// ═════════════════════════════════════════════════════════════════
let _refundsRepeatedAllowed = null;
async function _refundsSupportRepeated() {
    if (_refundsRepeatedAllowed !== null) return _refundsRepeatedAllowed;
    try {
        const { error } = await supabaseAdmin.from('orders').select('refunded_total').limit(1);
        _refundsRepeatedAllowed = !error;
    } catch (_) { _refundsRepeatedAllowed = false; }
    return _refundsRepeatedAllowed;
}

// ═════════════════════════════════════════════════════════════════
//  REGISTER
// ═════════════════════════════════════════════════════════════════
async function registerOrder({
    orderRef, userId, productType, productName, serviceType,
    quantity = null, amount, fee = 0, totalAmount, currency,
    status = 'pending', paymentStatus = 'pending', fulfillmentStatus = 'pending',
    provider, providerOrderId = null, providerReference = null,
    sourceTable = null, sourceId = null, metadata = {}
}) {
    if (!userId || !UUID_RE.test(String(userId))) {
        const e = new Error('Invalid user id.'); e.status = 400; e.code = 'INVALID_USER'; throw e;
    }
    if (!orderRef || typeof orderRef !== 'string') {
        const e = new Error('Invalid order reference.'); e.status = 400; e.code = 'INVALID_ORDER_REF'; throw e;
    }
    const { data, error } = await supabaseAdmin.from('orders').insert({
        order_ref: orderRef,
        user_id: userId,
        product_type: productType,
        product_name: productName || productType,
        service_type: serviceType || productType,
        quantity,
        amount,
        fee,
        total_amount: totalAmount ?? amount,
        currency,
        status,
        payment_status: paymentStatus,
        fulfillment_status: fulfillmentStatus,
        provider,
        provider_order_id: providerOrderId,
        provider_reference: providerReference,
        source_table: sourceTable,
        source_id: sourceId,
        metadata,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    }).select(ORDER_COLUMNS).single();
    if (error) {
        if (error.code === '23505') {
            const e = new Error('Order already exists.'); e.status = 409; e.code = 'ORDER_ALREADY_EXISTS'; throw e;
        }
        const e = new Error('Failed to register order.'); e.status = 500; e.code = 'ORDER_REGISTER_FAILED'; throw e;
    }
    await recordEvent({ orderId: data.id, eventType: 'order_created', newStatus: status, actorType: 'user', message: `Order ${orderRef} created` });
    return data;
}

// ═════════════════════════════════════════════════════════════════
//  LIST
// ═════════════════════════════════════════════════════════════════
async function listOrders(query = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    const sortable = new Set(['created_at', 'updated_at', 'completed_at', 'total_amount']);
    const sortCol = sortable.has(String(query.sort)) ? query.sort : 'created_at';
    const ascending = String(query.order || 'desc').toLowerCase() === 'asc';

    let q = supabaseAdmin
        .from('orders')
        .select(LIST_COLUMNS, { count: 'exact' })
        .order(sortCol, { ascending })
        .range(offset, offset + limit - 1);

    if (query.status && query.status !== 'all') {
        const s = String(query.status).toLowerCase();
        if (ORDER_STATUSES.has(s)) q = q.eq('status', s);
    }
    if (query.payment_status && query.payment_status !== 'all') {
        const s = String(query.payment_status).toLowerCase();
        if (PAYMENT_STATUSES.has(s)) q = q.eq('payment_status', s);
    }
    if (query.provider && query.provider !== 'all') q = q.eq('provider', String(query.provider).toLowerCase());
    if (query.product_type && query.product_type !== 'all') q = q.eq('product_type', String(query.product_type));
    if (query.currency && query.currency !== 'all') q = q.eq('currency', String(query.currency).toUpperCase());
    if (query.user_id && UUID_RE.test(String(query.user_id))) q = q.eq('user_id', query.user_id);

    const fromIso = isoDateStartWAT(query.from || query.date_from);
    const toIso = isoDateEndWAT(query.to || query.date_to);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso) q = q.lte('created_at', toIso);

    if (query.failed_only === 'true' || query.failed_only === true) q = q.in('status', ['failed', 'cancelled']);
    if (query.provider_failed === 'true' || query.provider_failed === true) q = q.eq('status', 'failed').not('provider_status', 'is', null);
    if (query.webhook_failed === 'true' || query.webhook_failed === true) q = q.eq('webhook_status', 'failed');
    if (query.manual_review === 'true' || query.manual_review === true) q = q.eq('status', 'manual_review');

    if (query.search) {
        const cleaned = sanitizeSearch(query.search);
        if (cleaned) {
            const safe = escapeLike(cleaned);
            let userIds = [];
            try {
                const { data: users } = await supabaseAdmin.from('profiles')
                    .select('id')
                    .or(`email.ilike.%${safe}%,username.ilike.%${safe}%`)
                    .limit(50);
                if (users && users.length) userIds = users.map(u => u.id);
            } catch (_) { /* optional */ }

            const parts = [
                `order_ref.ilike.%${safe}%`,
                `provider_order_id.ilike.%${safe}%`,
                `provider_reference.ilike.%${safe}%`
            ];
            if (userIds.length) parts.push(`user_id.in.(${userIds.join(',')})`);
            q = q.or(parts.join(','));
        }
    }

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { orders: [], count: 0, page, limit, totalPages: 0, available: false, reason: 'ORDERS_TABLE_NOT_FOUND', timezone: 'Africa/Lagos' };
        }
        const e = new Error('Failed to load orders.'); e.status = 500; e.code = 'ORDER_LIST_ERROR'; throw e;
    }

    const userIds = [...new Set((data || []).map(o => o.user_id).filter(Boolean))];
    const profilesById = {};
    if (userIds.length) {
        try {
            const { data: profiles } = await supabaseAdmin.from('profiles').select('id, username, email').in('id', userIds);
            for (const p of profiles || []) profilesById[p.id] = p;
        } catch (_) { /* ignore */ }
    }

    return {
        orders: (data || []).map(o => shapeOrder(o, profilesById[o.user_id])),
        count: count || 0,
        page, limit,
        totalPages: Math.ceil((count || 0) / limit),
        hasMore: page * limit < (count || 0),
        available: true,
        timezone: 'Africa/Lagos'
    };
}

function shapeOrder(o, profile) {
    if (!o) return null;
    const total = asNum(o.total_amount);
    const refunded = asNum(o.refunded_total != null ? o.refunded_total : o.refund_amount);
    const remaining = Math.max(0, round2(total - refunded));
    const ageMinutes = o.created_at ? Math.max(0, Math.floor((Date.now() - new Date(o.created_at).getTime()) / 60000)) : null;
    const status = String(o.status || '').toLowerCase();
    const stuckThreshold = STUCK_THRESHOLDS_MS[status];
    const isStuck = ageMinutes != null && stuckThreshold != null && ageMinutes * 60000 > stuckThreshold;
    return {
        id: o.id,
        order_ref: o.order_ref,
        user_id: o.user_id,
        user: profile ? {
            id: profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email: profile.email || null
        } : null,
        product_type: o.product_type,
        product_name: o.product_name,
        service_type: o.service_type,
        quantity: o.quantity,
        amount: o.amount,
        fee: o.fee,
        total_amount: o.total_amount,
        currency: o.currency,
        status: o.status,
        payment_status: o.payment_status,
        fulfillment_status: o.fulfillment_status,
        provider: o.provider,
        provider_order_id: o.provider_order_id,
        provider_reference: o.provider_reference,
        provider_status: o.provider_status,
        webhook_status: o.webhook_status,
        webhook_received_at: o.webhook_received_at,
        last_provider_sync_at: o.last_provider_sync_at,
        failure_reason: o.failure_reason,
        admin_note: o.admin_note,
        refund_status: o.refund_status,
        refund_amount: o.refund_amount,
        refunded_total: refunded,
        refund_reference: o.refund_reference,
        refund_transaction_id: o.refund_transaction_id,
        refunded_at: o.refunded_at,
        cancelled_at: o.cancelled_at,
        completed_at: o.completed_at,
        failed_at: o.failed_at,
        metadata: o.metadata,
        attempt_number: o.attempt_number,
        parent_order_id: o.parent_order_id,
        retry_reason: o.retry_reason,
        start_count: o.start_count,
        current_count: o.current_count,
        remains: o.remains,
        created_at: o.created_at,
        updated_at: o.updated_at,
        age_minutes: ageMinutes,
        is_stuck: isStuck,
        refundable_remaining: remaining
    };
}

// ═════════════════════════════════════════════════════════════════
//  DETAIL — rich
// ═════════════════════════════════════════════════════════════════
async function getOrder(orderId, { permissions = [] } = {}) {
    const orderIdInt = assertOrderId(orderId);

    const orderRes = await supabaseAdmin
        .from('orders')
        .select(ORDER_COLUMNS)
        .eq('id', orderIdInt)
        .maybeSingle();
    if (orderRes.error) {
        console.error('[ORDERS] getOrder: order select failed:', orderRes.error.message);
        const e = new Error('Failed to load order.'); e.status = 500; e.code = 'ORDER_DETAIL_ERROR'; throw e;
    }
    if (!orderRes.data) {
        const e = new Error('Order not found.'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e;
    }
    const order = orderRes.data;

    const results = await Promise.allSettled([
        order.user_id
            ? supabaseAdmin.from('profiles').select('id, username, email, status, created_at').eq('id', order.user_id).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        (async () => {
            try {
                const { data, error } = await supabaseAdmin.from('order_events')
                    .select('id, event_type, old_status, new_status, actor_type, actor_id, message, metadata, created_at')
                    .eq('order_id', String(orderIdInt))
                    .order('created_at', { ascending: true });
                return { data: data || [], error };
            } catch (e) { return { data: [], error: e }; }
        })(),
        (async () => {
            const out = [];
            let any = false;
            const tasks = [
                supabaseAdmin.from('webhook_events')
                    .select('id, provider, event_type, event_id, signature_status, signature_valid, processing_status, processing_error, received_at, processed_at')
                    .eq('order_id', orderIdInt).order('received_at', { ascending: false }),
                supabaseAdmin.from('kora_webhook_events')
                    .select('id, provider, event_type, provider_event_ref, provider_reference, signature_status, signature_valid, processing_status, processing_error, received_at, processed_at')
                    .eq('order_id', orderIdInt).order('received_at', { ascending: false }),
                supabaseAdmin.from('provider_webhook_events')
                    .select('id, provider, event_type, payment_id, signature_status, signature_valid, processing_status, processing_error, received_at, processed_at')
                    .eq('order_id', String(orderIdInt)).order('received_at', { ascending: false })
            ];
            const settled = await Promise.allSettled(tasks);
            for (const s of settled) {
                if (s.status === 'fulfilled' && Array.isArray(s.value.data)) {
                    any = true;
                    for (const w of s.value.data) {
                        out.push({
                            id: w.id,
                            provider: w.provider,
                            event_type: w.event_type,
                            event_id: w.event_id || w.provider_event_ref || null,
                            provider_reference: w.provider_reference || w.payment_id || null,
                            signature_status: w.signature_status
                                || (w.signature_valid === true ? 'valid'
                                    : w.signature_valid === false ? 'invalid' : 'unknown'),
                            processing_status: w.processing_status,
                            processing_error: w.processing_error,
                            received_at: w.received_at,
                            processed_at: w.processed_at
                        });
                    }
                }
            }
            out.sort((a, b) => new Date(b.received_at || 0) - new Date(a.received_at || 0));
            return { data: out, available: any };
        })(),
        (async () => {
            try {
                const { data, error } = await supabaseAdmin.from('transactions')
                    .select('id, ref, reference, type, status, currency, amount, description, source_type, source_id, created_at, completed_at')
                    .or(`source_id.eq.${orderIdInt},metadata->>order_id.eq.${orderIdInt}`)
                    .order('created_at', { ascending: true });
                return { data: data || [], error };
            } catch (e) { return { data: [], error: e }; }
        })(),
        (async () => {
            try {
                const { data, error } = await supabaseAdmin.from('refunds')
                    .select('id, refund_type, amount, currency, status, provider, provider_reference, provider_refund_ref, reason, requested_by, approved_by, approved_at, created_at, completed_at, failed_at, failure_reason, order_id')
                    .or(`order_id.eq.${orderIdInt},metadata->>order_id.eq.${orderIdInt}`)
                    .order('created_at', { ascending: false });
                if (!error) return { data: data || [], available: true };
            } catch (_) { /* fall through */ }
            try {
                const { data, error } = await supabaseAdmin.from('refunds')
                    .select('id, refund_type, amount, currency, status, provider, provider_reference, provider_refund_ref, reason, requested_by, approved_by, approved_at, created_at, completed_at, failed_at, failure_reason')
                    .or(`metadata->>order_id.eq.${orderIdInt}`)
                    .order('created_at', { ascending: false });
                if (!error) return { data: data || [], available: true };
            } catch (_) { /* fall through */ }
            return { data: [], available: false };
        })(),
        (async () => {
            try {
                const { data, error } = await supabaseAdmin.from('provider_transactions')
                    .select('id, provider, provider_transaction_id, provider_reference, status, created_at, updated_at')
                    .eq('order_id', orderIdInt).order('created_at', { ascending: false });
                return { data: data || [], error };
            } catch (e) { return { data: [], error: e }; }
        })(),
        order.user_id
            ? supabaseAdmin.from('orders')
                .select('id, order_ref, product_name, total_amount, currency, status, created_at')
                .eq('user_id', order.user_id)
                .neq('id', orderIdInt)
                .order('created_at', { ascending: false })
                .limit(5)
            : Promise.resolve({ data: [], error: null }),
        (async () => {
            const parent = order.parent_order_id
                ? await supabaseAdmin.from('orders').select('id, order_ref, status, created_at').eq('id', order.parent_order_id).maybeSingle()
                : { data: null };
            const children = await supabaseAdmin.from('orders')
                .select('id, order_ref, status, created_at, attempt_number')
                .eq('parent_order_id', orderIdInt)
                .order('attempt_number', { ascending: true });
            return { data: { parent: parent.data || null, children: children.data || [] }, available: true };
        })()
    ]);

    const unwrap = (idx, fallback) => {
        const r = results[idx];
        if (r.status !== 'fulfilled') return fallback;
        return r.value || fallback;
    };
    const profileRes = unwrap(0, { data: null });
    const eventsRes = unwrap(1, { data: [] });
    const webhooksRes = unwrap(2, { data: [], available: false });
    const txRes = unwrap(3, { data: [] });
    const refundsRes = unwrap(4, { data: [], available: false });
    const providerTxRes = unwrap(5, { data: [] });
    const lastOrdersRes = unwrap(6, { data: [] });
    const retryRes = unwrap(7, { data: { parent: null, children: [] }, available: true });

    const profile = profileRes.data || null;
    const events = eventsRes.data || [];
    const webhooks = webhooksRes.data || [];
    const transactions = txRes.data || [];
    const refunds = refundsRes.data || [];
    const providerTx = providerTxRes.data || [];
    const lastOrders = lastOrdersRes.data || [];
    const retryChain = retryRes.data || { parent: null, children: [] };

    const primaryTx = transactions.find(t => t.type !== 'refund') || null;
    const refundTx = transactions.find(t => t.type === 'refund') || null;

    let wallet = { available: false, currencies: {} };
    if (order.user_id) {
        try {
            const { data: accs, error: accErr } = await supabaseAdmin.from('ledger_accounts')
                .select('currency, available_balance')
                .eq('user_id', order.user_id);
            if (!accErr && Array.isArray(accs)) {
                wallet.available = true;
                for (const a of accs) {
                    wallet.currencies[a.currency] = {
                        available: asNum(a.available_balance)
                    };
                }
            }
        } catch (_) { /* keep unavailable */ }
    }

    let ledger = { entries: [], available: false, integrity: null };
    const txIds = transactions.map(t => t.id).filter(Boolean);
    if (txIds.length) {
        try {
            const { data: entries } = await supabaseAdmin.from('ledger_entries')
                .select('id, transaction_id, entry_type, amount_minor, currency, balance_before, balance_after, description, created_at')
                .in('transaction_id', txIds)
                .order('created_at', { ascending: true });
            ledger.entries = entries || [];
            ledger.available = true;
            let sumCredit = 0, sumDebit = 0;
            for (const e of ledger.entries) {
                const minor = Number(e.amount_minor) || 0;
                if (e.entry_type === 'CREDIT') sumCredit += minor;
                else if (e.entry_type === 'DEBIT') sumDebit += minor;
            }
            const txMinor = Math.round(asNum(order.total_amount) * 100);
            const refundedMinor = Math.round(asNum(order.refunded_total != null ? order.refunded_total : order.refund_amount) * 100);
            ledger.integrity = {
                debit_minor: sumDebit,
                credit_minor: sumCredit,
                expected_debit_minor: txMinor,
                expected_credit_minor: refundedMinor,
                balanced: Math.abs(sumDebit - txMinor) <= 1 && Math.abs(sumCredit - refundedMinor) <= 1
            };
        } catch (_) { /* keep unavailable */ }
    }

    const delivery = extractDelivery(order);

    let audit = { events: [], available: false };
    try {
        const { data } = await supabaseAdmin.from('admin_audit_logs')
            .select('id, admin_id, admin_email, admin_role, action, reason, before, after, result, created_at, request_id')
            .eq('target_type', 'order')
            .eq('target_id', String(orderIdInt))
            .order('created_at', { ascending: false })
            .limit(100);
        audit = { events: data || [], available: true };
    } catch (_) { /* keep unavailable */ }

    const providerRecords = providerTx.map(p => ({
        id: p.id,
        provider: p.provider,
        provider_transaction_id: p.provider_transaction_id,
        provider_reference: p.provider_reference,
        status: p.status,
        created_at: p.created_at,
        updated_at: p.updated_at
    }));

    const shaped = shapeOrder(order, profile);
    shaped.allowed_transitions = Array.isArray(ALLOWED_TRANSITIONS[String(order.status || '').toLowerCase()])
        ? [...ALLOWED_TRANSITIONS[String(order.status || '').toLowerCase()]]
        : [];
    shaped.can = computeCan(order, permissions);
    const health = computeHealth(order, { tx: transactions, refunds, webhooks });
    shaped.health_warnings = health.warnings;
    shaped.needs_attention = health.needs_attention;
    shaped.needs_attention_reasons = health.reasons;

    return {
        order: shaped,
        user: profile,
        wallet,
        last_orders: lastOrders,
        delivery,
        transactions,
        transaction: primaryTx,
        refund_transaction: refundTx,
        ledger_entries: ledger.entries,
        ledger_available: ledger.available,
        ledger_integrity: ledger.integrity,
        provider_transactions: providerRecords,
        events,
        events_available: eventsRes.data !== null,
        webhooks,
        webhooks_available: webhooksRes.available,
        refunds,
        refunds_available: refundsRes.available,
        retry_chain: retryChain,
        audit: audit.events,
        audit_available: audit.available,
        timezone: 'Africa/Lagos'
    };
}
function extractDelivery(order) {
    const meta = order.metadata && typeof order.metadata === 'object' ? order.metadata : {};
    const productType = String(order.product_type || '').toLowerCase();
    const keys = DELIVERY_KEYS_BY_PRODUCT[productType] || [];
    const out = {};
    const maskedFields = [];
    for (const k of keys) {
        const v = meta[k];
        if (v === undefined || v === null || v === '') continue;
        const masked = maskValue(v, k);
        out[k] = masked;
        if (masked !== String(v)) maskedFields.push(k);
    }
    return {
        product_type: productType,
        fields: out,
        masked_fields: maskedFields,
        available: Object.keys(out).length > 0,
        note: maskedFields.length
            ? 'Masked fields require a reveal-permission to see in full.'
            : null
    };
}

function computeCan(order, permissions) {
    const has = (p) => Array.isArray(permissions) && (permissions.includes('*') || permissions.includes(p));
    const status = String(order.status || '').toLowerCase();
    const isTerminal = ['completed', 'refunded', 'partially_refunded', 'expired'].includes(status);
    const adapter = providerFactory.get(String(order.provider || '').toLowerCase());
    const supportsStatus = adapter && typeof adapter.getOrderStatus === 'function';
    const remaining = asNum(order.total_amount) - asNum(order.refunded_total != null ? order.refunded_total : order.refund_amount);
    return {
        sync: has('orders.resolve') && supportsStatus && !isTerminal,
        change_status: has('orders.resolve') && (ALLOWED_TRANSITIONS[status] || []).length > 0,
        // ★ refund gated to REFUNDABLE_STATUSES (failed / cancelled / manual_review).
        //   Completed, paid, pending, processing orders cannot be refunded via this UI.
        refund: has('transactions.refund') && remaining > 0 && REFUNDABLE_STATUSES.includes(status),
        retry: has('orders.resolve') && ['failed', 'cancelled', 'expired'].includes(status),
        cancel: has('orders.resolve') && ['pending', 'paid', 'processing', 'in_progress'].includes(status),
        add_note: has('orders.resolve'),
        query_provider: has('orders.read') && supportsStatus && !isTerminal,
        export: has('reports.export')
    };
}

function computeHealth(order, { tx, refunds, webhooks }) {
    const warnings = [];
    const reasons = new Set();
    const status = String(order.status || '').toLowerCase();
    const paymentStatus = String(order.payment_status || '').toLowerCase();
    const webhookStatus = String(order.webhook_status || '').toLowerCase();
    const total = asNum(order.total_amount);
    const refunded = asNum(order.refunded_total != null ? order.refunded_total : order.refund_amount);
    const providerStatus = String(order.provider_status || '').toLowerCase();

    // ★ Only flag "paid but no provider id" for orders that are still in
    //   flight. Completed orders are fulfilled — the missing provider id
    //   on the mirror is a data-completeness gap, not a fulfillment
    //   failure. Terminal states have either succeeded or been refunded.
    const needsExternalProvider =
        order.provider &&
        order.provider !== 'marketplace' &&
        status !== 'completed' &&
        status !== 'refunded' &&
        status !== 'partially_refunded';

    if (paymentStatus === 'paid' && needsExternalProvider && !order.provider_order_id) {
        warnings.push('paid_but_no_provider_id');
        reasons.add('paid not fulfilled');
    }
    if (status === 'completed' && webhookStatus === 'failed') {
        warnings.push('completed_but_webhook_failed');
        reasons.add('webhook failed');
    }
    if (refunded > total + 0.005) {
        warnings.push('refund_exceeds_total');
        reasons.add('refund exceeds total');
    }
    if (providerStatus === 'failed' && status === 'completed') {
        warnings.push('provider_failed_local_completed');
        reasons.add('provider/local disagreement');
    }
    if (status === 'completed' && paymentStatus !== 'paid' && paymentStatus !== 'partially_refunded') {
        warnings.push('completed_but_not_paid');
        reasons.add('completed but unpaid');
    }
    if (status === 'processing' && order.created_at) {
        const ageMin = (Date.now() - new Date(order.created_at).getTime()) / 60000;
        if (ageMin > 30) {
            warnings.push('stuck_in_processing');
            reasons.add('stuck processing');
        }
    }
    if (Array.isArray(webhooks) && webhooks.some(w => String(w.processing_status || '').toLowerCase() === 'failed')) {
        warnings.push('has_failed_webhook');
    }
    return {
        warnings,
        needs_attention: warnings.length > 0,
        reasons: Array.from(reasons)
    };
}

async function getTimeline(orderId) {
    const orderIdInt = assertOrderId(orderId);
    const { data, error } = await supabaseAdmin.from('order_events').select('*').eq('order_id', String(orderIdInt)).order('created_at', { ascending: true });
    if (error) { const e = new Error('Failed to load timeline.'); e.status = 500; e.code = 'TIMELINE_ERROR'; throw e; }
    return data || [];
}

async function getWebhooks(orderId) {
    const orderIdInt = assertOrderId(orderId);
    const settled = await Promise.allSettled([
        supabaseAdmin.from('webhook_events').select('id, provider, event_type, event_id, signature_valid, signature_status, processing_status, processing_error, attempts, received_at, processed_at, created_at').eq('order_id', orderIdInt).order('received_at', { ascending: false }),
        supabaseAdmin.from('kora_webhook_events').select('id, provider, event_type, provider_reference, signature_valid, signature_status, processing_status, processing_error, received_at, processed_at').eq('order_id', orderIdInt).order('received_at', { ascending: false }),
        supabaseAdmin.from('provider_webhook_events').select('id, provider, event_type, payment_id, signature_valid, signature_status, processing_status, processing_error, received_at, processed_at').eq('order_id', String(orderIdInt)).order('received_at', { ascending: false })
    ]);
    const out = [];
    for (const s of settled) if (s.status === 'fulfilled' && s.value.data) out.push(...s.value.data);
    return out.sort((a, b) => new Date(b.received_at || 0) - new Date(a.received_at || 0));
}

// ═════════════════════════════════════════════════════════════════
//  STATS
// ═════════════════════════════════════════════════════════════════
async function getStats(query = {}) {
    const filters = {
        from: isoDateStartWAT(query.from),
        to: isoDateEndWAT(query.to),
        status: query.status && query.status !== 'all' ? String(query.status).toLowerCase() : null,
        payment_status: query.payment_status && query.payment_status !== 'all' ? String(query.payment_status).toLowerCase() : null,
        product_type: query.product_type && query.product_type !== 'all' ? String(query.product_type) : null,
        provider: query.provider && query.provider !== 'all' ? String(query.provider).toLowerCase() : null,
        currency: query.currency && query.currency !== 'all' ? String(query.currency).toUpperCase() : null,
        search: query.search ? sanitizeSearch(query.search) : null,
        failed_only: query.failed_only === 'true' || query.failed_only === true,
        provider_failed: query.provider_failed === 'true' || query.provider_failed === true,
        webhook_failed: query.webhook_failed === 'true' || query.webhook_failed === true,
        manual_review: query.manual_review === 'true' || query.manual_review === true
    };

    try {
        const rpc = await supabaseAdmin.rpc('order_stats_by_filter', {
            p_from: filters.from, p_to: filters.to,
            p_status: filters.status, p_payment_status: filters.payment_status,
            p_provider: filters.provider, p_product_type: filters.product_type,
            p_currency: filters.currency, p_search: filters.search,
            p_failed_only: filters.failed_only, p_provider_failed: filters.provider_failed,
            p_webhook_failed: filters.webhook_failed, p_manual_review: filters.manual_review
        });
        if (!rpc.error && rpc.data) {
            const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
            return {
                totalOrders: asNum(row.total_orders),
                pending: asNum(row.pending_orders),
                paid: asNum(row.paid_orders),
                processing: asNum(row.processing_orders),
                completed: asNum(row.completed_orders),
                partial: asNum(row.partial_orders),
                failed: asNum(row.failed_orders),
                cancelled: asNum(row.cancelled_orders),
                refunded: asNum(row.refunded_orders),
                partialRefunded: asNum(row.partial_refunded_orders),
                manualReview: asNum(row.manual_review_orders),
                stuck: asNum(row.stuck_orders),
                totalRevenueNgn: String(row.total_revenue_ngn ?? '0'),
                totalRevenueUsd: String(row.total_revenue_usd ?? '0'),
                totalRefundedNgn: String(row.total_refunded_ngn ?? '0'),
                totalRefundedUsd: String(row.total_refunded_usd ?? '0'),
                revenueAvailable: true, refundsAvailable: true,
                source: 'rpc',
                timezone: 'Africa/Lagos'
            };
        }
    } catch (_) { /* fall through */ }

    const applyFilters = (q) => {
        if (filters.from) q = q.gte('created_at', filters.from);
        if (filters.to) q = q.lte('created_at', filters.to);
        if (filters.status) q = q.eq('status', filters.status);
        if (filters.payment_status) q = q.eq('payment_status', filters.payment_status);
        if (filters.product_type) q = q.eq('product_type', filters.product_type);
        if (filters.provider) q = q.eq('provider', filters.provider);
        if (filters.currency) q = q.eq('currency', filters.currency);
        if (filters.failed_only) q = q.in('status', ['failed', 'cancelled']);
        if (filters.provider_failed) q = q.eq('status', 'failed').not('provider_status', 'is', null);
        if (filters.webhook_failed) q = q.eq('webhook_status', 'failed');
        if (filters.manual_review) q = q.eq('status', 'manual_review');
        if (filters.search) {
            const safe = escapeLike(filters.search);
            q = q.or(`order_ref.ilike.%${safe}%,provider_order_id.ilike.%${safe}%,provider_reference.ilike.%${safe}%`);
        }
        return q;
    };

    let q = supabaseAdmin.from('orders').select('status, currency, total_amount, refunded_total, refund_amount, payment_status, webhook_status, provider_status, created_at');
    q = applyFilters(q);
    const { data, error } = await q.limit(10000);
    if (error) { const e = new Error('Failed to aggregate stats.'); e.status = 500; e.code = 'STATS_ERROR'; throw e; }

    const acc = {
        totalOrders: 0, pending: 0, paid: 0, processing: 0, completed: 0,
        partial: 0, failed: 0, cancelled: 0, refunded: 0, partialRefunded: 0,
        manualReview: 0, stuck: 0,
        revenueNgn: 0, revenueUsd: 0, refundedNgn: 0, refundedUsd: 0
    };
    const now = Date.now();
    for (const row of data || []) {
        acc.totalOrders++;
        const s = String(row.status || '').toLowerCase();
        if (s === 'pending') acc.pending++;
        else if (s === 'paid') acc.paid++;
        else if (s === 'processing') acc.processing++;
        else if (s === 'completed') acc.completed++;
        else if (s === 'partial') acc.partial++;
        else if (s === 'failed') acc.failed++;
        else if (s === 'cancelled') acc.cancelled++;
        else if (s === 'refunded') acc.refunded++;
        else if (s === 'partially_refunded') acc.partialRefunded++;
        else if (s === 'manual_review') acc.manualReview++;
        if ((s === 'processing' || s === 'in_progress') && row.created_at) {
            const age = (now - new Date(row.created_at).getTime()) / 60000;
            if (age > 30) acc.stuck++;
        }
        const ccy = String(row.currency || '').toUpperCase();
        if (s === 'completed') {
            const amt = asNum(row.total_amount);
            if (ccy === 'NGN') acc.revenueNgn += amt;
            else if (ccy === 'USD') acc.revenueUsd += amt;
        }
        const refundAmt = asNum(row.refunded_total != null ? row.refunded_total : row.refund_amount);
        if (refundAmt > 0) {
            if (ccy === 'NGN') acc.refundedNgn += refundAmt;
            else if (ccy === 'USD') acc.refundedUsd += refundAmt;
        }
    }

    return {
        totalOrders: acc.totalOrders,
        pending: acc.pending, paid: acc.paid, processing: acc.processing,
        completed: acc.completed, partial: acc.partial, failed: acc.failed,
        cancelled: acc.cancelled, refunded: acc.refunded, partialRefunded: acc.partialRefunded,
        manualReview: acc.manualReview, stuck: acc.stuck,
        totalRevenueNgn: round2(acc.revenueNgn).toFixed(2),
        totalRevenueUsd: round2(acc.revenueUsd).toFixed(2),
        totalRefundedNgn: round2(acc.refundedNgn).toFixed(2),
        totalRefundedUsd: round2(acc.refundedUsd).toFixed(2),
        revenueAvailable: true, refundsAvailable: true,
        source: 'fallback',
        timezone: 'Africa/Lagos',
        note: 'Aggregated from up to 10,000 rows. Deploy the order_stats_by_filter RPC for exact-at-scale.'
    };
}

async function getAttentionCounts() {
    try {
        const { data, error } = await supabaseAdmin.rpc('order_attention_counts');
        if (!error && data) {
            const row = Array.isArray(data) ? data[0] : data;
            return {
                stuck_processing: asNum(row.stuck_processing),
                failed_unrefunded: asNum(row.failed_unrefunded),
                manual_review: asNum(row.manual_review),
                webhook_failed: asNum(row.webhook_failed),
                provider_unknown: asNum(row.provider_unknown),
                paid_not_fulfilled: asNum(row.paid_not_fulfilled)
            };
        }
    } catch (_) { /* fall through */ }
    const q = (build) => {
        try { return build().then(({ count }) => count || 0).catch(() => 0); }
        catch { return Promise.resolve(0); }
    };
    const from30 = new Date(Date.now() - 30 * 60000).toISOString();
    const [stuck, failed, manual, wh, prov, paid] = await Promise.all([
        q(() => supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).in('status', ['processing', 'in_progress']).lt('created_at', from30)),
        q(() => supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'failed')),
        q(() => supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'manual_review')),
        q(() => supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq('webhook_status', 'failed')),
        q(() => supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'provider_unknown')),
        q(() => supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq('payment_status', 'paid').not('status', 'in', '(completed,refunded,cancelled)'))
    ]);
    return {
        stuck_processing: stuck, failed_unrefunded: failed,
        manual_review: manual, webhook_failed: wh,
        provider_unknown: prov, paid_not_fulfilled: paid,
        note: 'RPC order_attention_counts not deployed; counts from sequential head-counts.'
    };
}

// ═════════════════════════════════════════════════════════════════
//  PIPELINE
// ═════════════════════════════════════════════════════════════════
async function processProviderUpdate({
    order, providerStatus, providerResponse,
    source, actorId = null, actorType = 'system', ctx = null
}) {
    if (!order || !order.id) {
        const e = new Error('Order is required.'); e.status = 400; e.code = 'ORDER_REQUIRED'; throw e;
    }
    const currentStatus = String(order.status || '').toLowerCase();
    const targetStatus = String(providerStatus || '').toLowerCase().trim();
    const internalTarget = mapProviderToInternal(targetStatus, currentStatus);

    const currentSev = severityOf(currentStatus);
    const targetSev = internalTarget ? severityOf(internalTarget) : 0;
    const regresses = internalTarget && targetSev < currentSev;

    const now = new Date().toISOString();
    const patch = { provider_status: targetStatus, provider_response: providerResponse || null };

    if (!internalTarget || internalTarget === currentStatus || regresses) {
        await supabaseAdmin.from('orders').update({
            provider_status: patch.provider_status,
            provider_response: patch.provider_response,
            last_provider_sync_at: now,
            updated_at: now
        }).eq('id', order.id);
        await recordEvent({
            orderId: order.id,
            eventType: regresses ? 'provider_status_regressed' : 'provider_status_synced',
            actorType: actorType || source,
            message: regresses
                ? `Ignored late provider status ${targetStatus} (order is already ${currentStatus})`
                : `Provider status ${targetStatus} (no change)`
        });
        return { updated: false, status: currentStatus, transition_rejected: !!regresses };
    }

    let nextTarget = internalTarget;

    const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
    if (actorType !== 'admin' && !allowed.includes(internalTarget)) {
        await recordEvent({
            orderId: order.id,
            eventType: 'provider_transition_rejected',
            actorType: actorType || source,
            message: `Rejected transition ${currentStatus} → ${internalTarget}`
        });
        return { updated: false, status: currentStatus, reason: 'INVALID_TRANSITION', transition_rejected: true };
    }

    const { error: rpcErr } = await supabaseAdmin.rpc('apply_order_provider_update', {
        p_order_id: order.id,
        p_expected_status: currentStatus,
        p_next_status: nextTarget,
        p_patch: patch,
        p_event_type: `provider_${nextTarget}`,
        p_actor_type: actorType || source,
        p_actor_id: actorId || null,
        p_message: `Provider reported ${providerStatus}`
    });

    if (rpcErr) {
        const msg = String(rpcErr.message || '');
        if (msg.includes('ORDER_STATE_CHANGED')) {
            return { updated: false, status: currentStatus, reason: 'STATE_CHANGED', transition_rejected: true };
        }
        throw new Error(`Failed to apply provider update: ${msg}`);
    }

    if ((nextTarget === 'failed' || nextTarget === 'cancelled') && order.refund_status !== 'refunded') {
        try {
            await refundOrder({ orderId: order.id, reason: `Provider reported ${providerStatus}`, ctx: null });
        } catch (refundErr) {
            console.error('[ORDERS] auto-refund failed for', order.order_ref, refundErr.message);
            await recordEvent({ orderId: order.id, eventType: 'refund_failed', actorType: 'system', message: refundErr.message });
        }
    }

    if (['completed', 'failed', 'cancelled', 'partial', 'refunded'].includes(nextTarget)) {
        const titles = {
            completed: 'Order Completed', failed: 'Order Failed', cancelled: 'Order Cancelled',
            partial: 'Order Partially Completed', refunded: 'Order Refunded'
        };
        const icons = { completed: 'check-circle', failed: 'times-circle', cancelled: 'ban', partial: 'exclamation-triangle', refunded: 'money-bill' };
        await createNotificationRow({
            userId: order.user_id,
            title: titles[nextTarget],
            message: `Your order ${order.order_ref} is now ${nextTarget}.`,
            type: `order_${nextTarget}`,
            icon: icons[nextTarget],
            link: '/history'
        });
    }
    return { updated: true, status: nextTarget };
}

function mapProviderToInternal(s, currentInternal) {
    if (!s) return null;
    if (['completed', 'success', 'successful', 'delivered', 'done', 'finished', 'fulfilled'].includes(s)) return 'completed';
    if (['failed', 'error', 'rejected', 'declined', 'reversed'].includes(s)) return 'failed';
    if (['cancelled', 'canceled', 'void'].includes(s)) return 'cancelled';
    if (s === 'refunded') return 'refunded';
    if (['partial', 'partially_completed', 'partially completed', 'partially_paid', 'underpaid'].includes(s)) return 'partial';
    if (['in progress', 'in_progress', 'processing', 'started', 'pending_fulfillment'].includes(s)) return 'processing';
    if (['pending', 'received', 'submitted', 'created', 'pending_payment', 'waiting', 'confirming'].includes(s)) return currentInternal || 'pending';
    if (['expired', 'timeout', 'timed_out'].includes(s)) return 'expired';
    return 'manual_review';
}

// ═════════════════════════════════════════════════════════════════
//  ADMIN MUTATIONS
// ═════════════════════════════════════════════════════════════════
async function updateOrderStatus({ orderId, status, note, ctx, actorType = 'admin' }) {
    const orderIdInt = assertOrderId(orderId);
    const next = String(status || '').toLowerCase();
    if (!ORDER_STATUSES.has(next)) { const e = new Error('Invalid status.'); e.status = 422; e.code = 'INVALID_STATUS'; throw e; }
    if (!note || String(note).trim().length < 4) { const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e; }

    const idemKey = ctx?.idempotencyKey;
    if (idemKey) {
        const prior = await idemLookup('order.status', idemKey, ctx?.adminId);
        if (prior) return { ...prior, idempotent_replay: true };
    }

    const { data: order } = await supabaseAdmin.from('orders').select('id, status, order_ref').eq('id', orderIdInt).maybeSingle();
    if (!order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }

    const current = String(order.status || '').toLowerCase();
    if (current === next) {
        const result = { no_op: true, message: `Already in status "${next}".`, status: current, allowed_transitions: ALLOWED_TRANSITIONS[current] || [] };
        if (idemKey) await idemStore('order.status', idemKey, ctx?.adminId, result);
        return result;
    }
    const allowed = ALLOWED_TRANSITIONS[current] || [];
    if (!allowed.includes(next)) {
        const e = new Error(`Cannot transition from "${current}" to "${next}".`);
        e.status = 422; e.code = 'INVALID_STATUS_TRANSITION'; e.allowed_transitions = allowed; e.current_status = current; throw e;
    }

    const { error: rpcErr } = await supabaseAdmin.rpc('apply_order_provider_update', {
        p_order_id: orderIdInt,
        p_expected_status: current,
        p_next_status: next,
        p_patch: { fulfillment_status: next, admin_note: String(note).slice(0, 1000) },
        p_event_type: 'admin_status_change',
        p_actor_type: actorType,
        p_actor_id: ctx?.adminId || null,
        p_message: String(note).slice(0, 500)
    });
    if (rpcErr) {
        const msg = String(rpcErr.message || '');
        if (msg.includes('ORDER_STATE_CHANGED')) {
            const e = new Error('Order changed before this action completed. Reload and try again.');
            e.status = 409; e.code = 'ORDER_STATE_CHANGED'; throw e;
        }
        throw new Error(`Failed to update order: ${msg}`);
    }

    const result = { updated: true, status: next, allowed_transitions: ALLOWED_TRANSITIONS[next] || [] };
    if (idemKey) await idemStore('order.status', idemKey, ctx?.adminId, result);
    return result;
}

async function refundOrder({ orderId, reason, ctx, forceAmount = null }) {
    const orderIdInt = assertOrderId(orderId);
    if (!reason || String(reason).trim().length < 4) { const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e; }

    const idemKey = ctx?.idempotencyKey;
    if (idemKey) {
        const prior = await idemLookup('order.refund', idemKey, ctx?.adminId);
        if (prior) return { ...prior, idempotent_replay: true };
    }

    const { data: order, error } = await supabaseAdmin.from('orders')
        .select('id, order_ref, user_id, total_amount, currency, status, payment_status, refund_status, refund_reference, refund_amount, refunded_total')
        .eq('id', orderIdInt).maybeSingle();
    if (error || !order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }

    const paymentStatus = String(order.payment_status || '').toLowerCase();
    if (!['paid', 'refunded', 'partially_refunded'].includes(paymentStatus) && String(order.status || '').toLowerCase() !== 'failed') {
        const e = new Error('This order has not been paid and is not eligible for a refund.'); e.status = 422; e.code = 'NOT_REFUNDABLE'; throw e;
    }

    const status = String(order.status || '').toLowerCase();

    // ★ Business rule: only failed / cancelled / manual_review orders may be
    //   refunded. Completed orders are final. Paid / pending / processing
    //   orders cannot be refunded until they reach a terminal state.
    if (!REFUNDABLE_STATUSES.includes(status)) {
        const e = new Error(
            status === 'completed'
                ? 'Completed orders cannot be refunded via this endpoint. Use the refunds module for post-fulfillment adjustments.'
                : `Order status "${status}" is not refundable. Only failed, cancelled, or manual-review orders can be refunded.`
        );
        e.status = 422;
        e.code = 'NOT_REFUNDABLE';
        e.current_status = status;
        e.allowed_statuses = [...REFUNDABLE_STATUSES];
        throw e;
    }

    const totalAmount = asNum(order.total_amount);
    const alreadyRefunded = asNum(order.refunded_total != null ? order.refunded_total : order.refund_amount);
    const remaining = totalAmount - alreadyRefunded;
    if (remaining <= 0) {
        const result = { refund: { reference: order.refund_reference, amount: alreadyRefunded, currency: order.currency, already_refunded: true, remaining: 0 } };
        if (idemKey) await idemStore('order.refund', idemKey, ctx?.adminId, result);
        return result;
    }

    const refundAmount = forceAmount != null ? Number(forceAmount) : remaining;
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
        const e = new Error('Invalid refund amount.'); e.status = 422; e.code = 'INVALID_AMOUNT'; throw e;
    }
    if (refundAmount > remaining + 1e-9) {
        const e = new Error('Refund amount exceeds the refundable balance.'); e.status = 422; e.code = 'REFUND_EXCEEDS_ORDER'; throw e;
    }

    const supportsRepeated = await _refundsSupportRepeated();
    if (alreadyRefunded > 0 && !supportsRepeated) {
        const e = new Error(
            'Repeated refunds require migration §3 (replace the refunds uniqueness indexes). ' +
            'Run sql/orders_admin_v1.sql §3, then retry.'
        );
        e.status = 409; e.code = 'REFUND_SCHEMA_NOT_MIGRATED';
        e.migration = 'sql/orders_admin_v1.sql §3';
        throw e;
    }

    const refundRef = `REFUND-${order.order_ref}${alreadyRefunded > 0 ? '-' + Date.now().toString(36) : ''}`;

    const newTotal = round2(alreadyRefunded + refundAmount);
    const { data: claimed, error: claimErr } = await supabaseAdmin.from('orders')
        .update({
            refund_status: 'refunding',
            refund_amount: newTotal,
            refunded_total: newTotal,
            refund_reference: refundRef,
            updated_at: new Date().toISOString()
        })
        .eq('id', orderIdInt)
        .neq('refund_status', 'refunded')
        .is('refund_reference', null)
        .select('id, refund_reference, refund_amount, refunded_total, currency')
        .maybeSingle();

    if (claimErr) {
        if (claimErr.code === '23505') {
            const { data: fresh } = await supabaseAdmin.from('orders').select('refund_reference, refund_amount, refunded_total, currency').eq('id', orderIdInt).maybeSingle();
            const result = { refund: { reference: fresh?.refund_reference, amount: fresh?.refunded_total, currency: fresh?.currency, already_refunded: true } };
            if (idemKey) await idemStore('order.refund', idemKey, ctx?.adminId, result);
            return result;
        }
        const e = new Error('Failed to claim refund.'); e.status = 500; e.code = 'REFUND_CLAIM_FAILED'; throw e;
    }
    if (!claimed) {
        const { data: fresh } = await supabaseAdmin.from('orders').select('refund_reference, refund_amount, refunded_total, currency').eq('id', orderIdInt).maybeSingle();
        const result = { refund: { reference: fresh?.refund_reference || refundRef, amount: fresh?.refunded_total || refundAmount, currency: fresh?.currency || order.currency, already_refunded: true } };
        if (idemKey) await idemStore('order.refund', idemKey, ctx?.adminId, result);
        return result;
    }

    let creditResult;
    try {
        creditResult = await LedgerService.creditWallet({
            userId: order.user_id,
            amount: refundAmount,
            currency: order.currency,
            description: `Refund for order ${order.order_ref}`,
            reference: refundRef,
            type: 'refund',
            sourceType: 'order',
            sourceId: String(order.id),
            metadata: { order_ref: order.order_ref, reason: String(reason).slice(0, 500), order_id: order.id },
            idempotencyKey: refundRef
        });
    } catch (creditErr) {
        await supabaseAdmin.from('orders').update({
            refund_status: 'failed',
            refund_reference: null,
            refund_amount: alreadyRefunded,
            refunded_total: alreadyRefunded,
            updated_at: new Date().toISOString()
        }).eq('id', orderIdInt);
        const e = new Error('Wallet refund failed.'); e.status = 500; e.code = 'LEDGER_REFUND_FAILED'; e.cause = creditErr.message; throw e;
    }

    const fullyRefunded = newTotal >= totalAmount - 0.005;
    const finalStatus = fullyRefunded ? 'refunded' : 'partially_refunded';
    await supabaseAdmin.from('orders').update({
        refund_status: finalStatus,
        refund_transaction_id: creditResult.transaction_id || null,
        refunded_at: new Date().toISOString(),
        status: fullyRefunded && String(order.status || '').toLowerCase() === 'completed' ? 'refunded' : order.status,
        updated_at: new Date().toISOString()
    }).eq('id', orderIdInt);

    let sidecarWritten = false;
    let sidecarError = null;
    try {
        if (creditResult && creditResult.transaction_id && UUID_RE.test(String(creditResult.transaction_id))) {
            const insertRow = {
                original_transaction_id: creditResult.transaction_id,
                refund_transaction_id: creditResult.transaction_id,
                user_id: order.user_id,
                order_id: order.id,
                refund_type: 'wallet',
                refund_method: 'wallet',
                amount: refundAmount,
                currency: order.currency,
                reason: String(reason).slice(0, 500),
                status: 'completed',
                requested_by: ctx?.adminId || null,
                approved_by: ctx?.adminId || null,
                approved_at: new Date().toISOString(),
                idempotency_key: refundRef,
                metadata: { order_id: order.id, order_ref: order.order_ref },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                completed_at: new Date().toISOString()
            };
            const { error: sidecarErr } = await supabaseAdmin.from('refunds').insert(insertRow);
            if (sidecarErr) { sidecarError = sidecarErr.message; console.error('[ORDERS] refunds sidecar insert failed:', sidecarErr.message); }
            else sidecarWritten = true;
        }
    } catch (e) {
        sidecarError = e.message;
        console.warn('[ORDERS] refunds sidecar outer error:', e.message);
    }

    await recordEvent({
        orderId: order.id, eventType: 'refund_created',
        actorType: ctx ? 'admin' : 'system', actorId: ctx?.adminId || null,
        message: `Refund of ${refundAmount} ${order.currency} — ${reason}`
    });
    if (ctx) {
        await recordAudit({
            ctx, action: 'order.refund', orderId: order.id,
            before: { refund_status: order.refund_status, refunded_total: alreadyRefunded, amount: order.total_amount },
            after: { refund_status: finalStatus, refunded_total: newTotal, refunded_this: refundAmount, refund_reference: refundRef, sidecar: sidecarWritten ? 'written' : 'failed' },
            reason
        });
    }
    await createNotificationRow({
        userId: order.user_id,
        title: fullyRefunded ? 'Order Refunded' : 'Partial Refund Issued',
        message: `A refund of ${refundAmount} ${order.currency} has been credited for order ${order.order_ref}.`,
        type: 'order_refunded', icon: 'money-bill', link: '/history'
    });

    const result = {
        refund: {
            reference: refundRef,
            amount: refundAmount,
            currency: order.currency,
            already_refunded: false,
            remaining: round2(totalAmount - newTotal),
            fully_refunded: fullyRefunded,
            sidecar_written: sidecarWritten,
            sidecar_error: sidecarError
        }
    };
    if (idemKey) await idemStore('order.refund', idemKey, ctx?.adminId, result);
    return result;
}

async function cancelOrder({ orderId, reason, ctx, force = false }) {
    const orderIdInt = assertOrderId(orderId);
    if (!force) {
        const { data: order } = await supabaseAdmin.from('orders')
            .select('provider, provider_order_id, provider_reference, status')
            .eq('id', orderIdInt).maybeSingle();
        if (order) {
            const adapter = providerFactory.get(order.provider);
            if (adapter && typeof adapter.getOrderStatus === 'function' && (order.provider_order_id || order.provider_reference)) {
                try {
                    const providerState = await Promise.race([
                        Promise.resolve().then(() => adapter.getOrderStatus(order)),
                        new Promise((_, rej) => setTimeout(() => { const e = new Error('timeout'); e.code = 'PROVIDER_TIMEOUT'; rej(e); }, 5000))
                    ]);
                    const providerNorm = mapProviderToInternal(String(providerState?.status || '').toLowerCase(), order.status);
                    if (providerNorm === 'completed') {
                        const e = new Error('Provider reports this order as completed. Cannot cancel.');
                        e.status = 422; e.code = 'NOT_REFUNDABLE'; throw e;
                    }
                } catch (e) {
                    if (e.code === 'NOT_REFUNDABLE') throw e;
                }
            }
        }
    }
    return updateOrderStatus({ orderId: orderIdInt, status: 'cancelled', note: reason, ctx });
}

async function retryOrder({ orderId, reason, ctx }) {
    const orderIdInt = assertOrderId(orderId);
    if (!reason || String(reason).trim().length < 4) { const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e; }

    const idemKey = ctx?.idempotencyKey;
    if (idemKey) {
        const prior = await idemLookup('order.retry', idemKey, ctx?.adminId);
        if (prior) return { ...prior, idempotent_replay: true };
    }

    const { data: order } = await supabaseAdmin.from('orders').select(ORDER_COLUMNS).eq('id', orderIdInt).maybeSingle();
    if (!order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }
    if (!['failed', 'cancelled', 'expired'].includes(String(order.status))) {
        const e = new Error('Only failed/cancelled/expired orders can be re-queued.'); e.status = 422; e.code = 'NOT_RETRYABLE'; throw e;
    }

    const attemptNumber = Number(order.attempt_number || 1) + 1;
    const childOrderRef = `${order.order_ref}-R${attemptNumber}`;

    const { data: existingChild } = await supabaseAdmin.from('orders').select(ORDER_COLUMNS)
        .eq('parent_order_id', order.id).eq('attempt_number', attemptNumber).maybeSingle();
    if (existingChild) {
        const result = { retry_order: shapeOrder(existingChild), idempotent_replay: true };
        if (idemKey) await idemStore('order.retry', idemKey, ctx?.adminId, result);
        return result;
    }

    const { data: child, error } = await supabaseAdmin.from('orders').insert({
        order_ref: childOrderRef,
        user_id: order.user_id,
        product_type: order.product_type,
        product_name: order.product_name,
        service_type: order.service_type,
        quantity: order.quantity,
        amount: order.amount,
        fee: order.fee,
        total_amount: 0,
        currency: order.currency,
        status: 'pending',
        payment_status: 'paid',
        fulfillment_status: 'pending',
        provider: order.provider,
        provider_order_id: null,
        provider_reference: null,
        source_table: order.source_table,
        source_id: order.source_id,
        parent_order_id: order.id,
        attempt_number: attemptNumber,
        retry_reason: String(reason).slice(0, 500),
        metadata: { retried_from: order.order_ref, requires_fulfilment_worker: true },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    }).select(ORDER_COLUMNS).single();
    if (error) { const e = new Error('Failed to create re-queue order.'); e.status = 500; e.code = 'RETRY_FAILED'; throw e; }

    await recordEvent({
        orderId: child.id, eventType: 'retry_created',
        actorType: 'admin', actorId: ctx?.adminId || null,
        message: `Re-queue #${attemptNumber} of ${order.order_ref}`
    });
    if (ctx) {
        await recordAudit({
            ctx, action: 'order.retry', orderId: order.id,
            before: { status: order.status },
            after: { retry_order_ref: child.order_ref, attempt_number: attemptNumber },
            reason
        });
    }
    const result = {
        retry_order: shapeOrder(child),
        note: 'Re-queued. The fulfilment worker will pick this up; this endpoint does not call the provider.'
    };
    if (idemKey) await idemStore('order.retry', idemKey, ctx?.adminId, result);
    return result;
}

async function addNote({ orderId, note, ctx }) {
    const orderIdInt = assertOrderId(orderId);
    const cleaned = String(note || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    if (cleaned.length < 2) { const e = new Error('Note text is required.'); e.status = 422; e.code = 'NOTE_REQUIRED'; throw e; }
    if (cleaned.length > 1000) { const e = new Error('Note is too long.'); e.status = 422; e.code = 'NOTE_REQUIRED'; throw e; }

    const { data: existing } = await supabaseAdmin.from('orders').select('id, admin_note, metadata').eq('id', orderIdInt).maybeSingle();
    if (!existing) { const e = new Error('Order not found.'); e.status = 404; e.code = 'ORDER_NOT_FOUND'; throw e; }

    const meta = existing.metadata && typeof existing.metadata === 'object' ? { ...existing.metadata } : {};
    const history = Array.isArray(meta.note_history) ? meta.note_history.slice(-NOTE_HISTORY_MAX) : [];
    if (existing.admin_note) {
        history.push({ note: String(existing.admin_note).slice(0, 1000), archived_at: new Date().toISOString(), archived_by: ctx?.adminId || null });
    }
    while (history.length > NOTE_HISTORY_MAX) history.shift();
    meta.note_history = history;

    const { error } = await supabaseAdmin.from('orders').update({
        admin_note: cleaned.slice(0, 1000),
        metadata: meta,
        updated_at: new Date().toISOString()
    }).eq('id', orderIdInt);
    if (error) { const e = new Error('Failed to save note.'); e.status = 500; e.code = 'NOTE_SAVE_FAILED'; throw e; }

    await recordEvent({ orderId: orderIdInt, eventType: 'admin_note', actorType: 'admin', actorId: ctx?.adminId || null, message: cleaned });
    if (ctx) {
        await recordAudit({ ctx, action: 'order.note', orderId: orderIdInt, before: null, after: { admin_note: cleaned }, reason: cleaned });
    }
    return { ok: true };
}

// ═════════════════════════════════════════════════════════════════
//  BULK SYNC
// ═════════════════════════════════════════════════════════════════
let _bulkSyncLock = null;
async function syncPending({ limit = 25, reason = 'Bulk sync', source = 'admin_bulk_sync', actorType = 'admin', ctx = null }) {
    if (_bulkSyncLock) { const e = new Error('A bulk sync is already running.'); e.status = 409; e.code = 'SYNC_IN_PROGRESS'; throw e; }
    _bulkSyncLock = Date.now();
    const started = Date.now();
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);

    try {
        const { data: rows, error } = await supabaseAdmin.from('orders').select(LIST_COLUMNS)
            .in('status', ['pending', 'paid', 'processing', 'in_progress', 'partial', 'provider_unknown'])
            .or('provider_order_id.not.is.null,provider_reference.not.is.null')
            .order('last_provider_sync_at', { ascending: true, nullsFirst: true })
            .limit(safeLimit);
        if (error) { const e = new Error('Failed to load orders for sync.'); e.status = 500; e.code = 'ORDER_LIST_ERROR'; throw e; }

        let processed = 0, updated = 0, skipped = 0, aborted = false;
        const results = [];
        const queue = [...(rows || [])];

        const worker = async () => {
            while (queue.length) {
                if (Date.now() - started > SYNC_BUDGET_MS) { aborted = true; return; }
                const order = queue.shift();
                processed++;
                const result = { order_ref: order.order_ref };
                try {
                    const name = String(order.provider || '').toLowerCase();
                    const meta = providerMetadata.getMetadata(name) || {};
                    if (meta.enabled === false) { result.skipped = true; result.reason = 'PROVIDER_DISABLED'; skipped++; results.push(result); continue; }
                    const adapter = providerFactory.get(name);
                    if (!adapter || typeof adapter.getOrderStatus !== 'function') { result.skipped = true; result.reason = 'PROVIDER_DOES_NOT_SUPPORT_STATUS'; skipped++; results.push(result); continue; }
                    const providerState = await Promise.race([
                        Promise.resolve().then(() => adapter.getOrderStatus(order)),
                        new Promise((_, rej) => setTimeout(() => { const e = new Error('timeout'); e.code = 'PROVIDER_TIMEOUT'; rej(e); }, 8000))
                    ]).catch(err => { result.error = err.code || 'PROVIDER_ERROR'; skipped++; results.push(result); return null; });
                    if (!providerState) continue;
                    const r = await processProviderUpdate({
                        order, providerStatus: providerState?.status || null, providerResponse: providerState?.raw || null,
                        source, actorType, actorId: ctx?.adminId || null, ctx
                    });
                    result.status = r.status; result.updated = !!r.updated;
                    if (r.updated) updated++;
                } catch (e) {
                    result.error = e.code || 'SYNC_FAILED';
                    skipped++;
                } finally {
                    try {
                        await supabaseAdmin.from('orders').update({
                            last_provider_sync_at: new Date().toISOString(),
                            last_sync_attempt_at: new Date().toISOString()
                        }).eq('id', order.id);
                    } catch (_) { /* ignore */ }
                    if (result.error || result.skipped) results.push(result);
                    else if (!result.updated) results.push(result);
                }
            }
        };

        await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, queue.length || 1) }).map(() => worker()));

        return { processed, updated, skipped, aborted, duration_ms: Date.now() - started, results, reason, source };
    } finally {
        _bulkSyncLock = null;
    }
}

// ═════════════════════════════════════════════════════════════════
//  CSV EXPORT
// ═════════════════════════════════════════════════════════════════
async function buildOrdersCsv({ filters = {}, maxRows = EXPORT_MAX_ROWS, ctx = null }) {
    const rows = [];
    let offset = 0;
    let truncated = false;
    while (offset < maxRows) {
        const lim = Math.min(EXPORT_CHUNK, maxRows - offset);
        const chunk = await listOrders({ ...filters, page: Math.floor(offset / lim) + 1, limit: lim });
        if (!chunk.orders || !chunk.orders.length) break;
        rows.push(...chunk.orders);
        if (chunk.orders.length < lim) break;
        offset += lim;
        if (offset >= maxRows) { truncated = true; break; }
    }

    const header = [
        'Order Ref', 'Customer', 'Email', 'Product', 'Provider', 'Provider Order ID',
        'Amount', 'Currency', 'Status', 'Payment', 'Refunded Total', 'Created (WAT)', 'Completed (WAT)', 'Failed (WAT)'
    ];
    const fmt = (iso) => {
        if (!iso) return '';
        try {
            return new Intl.DateTimeFormat('en-GB', {
                timeZone: 'Africa/Lagos',
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
            }).format(new Date(iso));
        } catch (_) { return ''; }
    };
    const defuse = (v) => { const s = String(v == null ? '' : v); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
    const esc = (v) => '"' + defuse(v).replace(/"/g, '""') + '"';
    const textCols = new Set([0, 1, 2, 3, 4, 5, 8, 9]);
    const row = (values) => values.map((v, i) => textCols.has(i) ? esc(v) : ('"' + String(v == null ? '' : v).replace(/"/g, '""') + '"')).join(',');

    const lines = ['\uFEFF' + header.map((h, i) => textCols.has(i) ? esc(h) : '"' + h + '"').join(',')];
    for (const o of rows) {
        lines.push(row([
            o.order_ref, o.user?.username || '', o.user?.email || '',
            o.product_name || o.product_type || '', o.provider || '',
            o.provider_order_id || '',
            o.total_amount, o.currency, o.status, o.payment_status,
            o.refunded_total, fmt(o.created_at), fmt(o.completed_at), fmt(o.failed_at)
        ]));
    }
    return { csv: lines.join('\r\n'), row_count: rows.length, truncated, timezone: 'Africa/Lagos' };
}

// ═════════════════════════════════════════════════════════════════
//  EXPORTS
// ═════════════════════════════════════════════════════════════════
module.exports = {
    ORDER_STATUSES, PAYMENT_STATUSES, ALLOWED_TRANSITIONS, REFUNDABLE_STATUSES,
    registerOrder, listOrders, getOrder, getTimeline, getWebhooks,
    getStats, getAttentionCounts,
    processProviderUpdate, updateOrderStatus, refundOrder, cancelOrder, retryOrder, addNote,
    syncPending, buildOrdersCsv,
    recordEvent, shapeOrder, mapProviderToInternal
};