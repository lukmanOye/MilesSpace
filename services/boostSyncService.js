// services/boostSyncService.js
// ─────────────────────────────────────────────────────────────────
// Boost sync service.
//
// TRANSPORT: every SMMWiz call goes through providers/smmwizProvider
// (via providerFactory). Never axios directly, never a second API
// key reader. The adapter owns the key, the transport, the timeout,
// and the error shape.
//
// CIRCUIT BREAKER: submitBoostOrder and syncPendingBoostOrders call
// providerCircuitBreaker.allowRequest('smmwiz') first and record
// success/failure. During a SMMWiz outage the breaker opens and
// boostSyncService returns { ok: false, reason: 'CIRCUIT_OPEN' }
// without hammering the provider.
//
// Rules:
//   • Provider timeout ≠ failed. Unknown → provider_unknown.
//   • Only definitive failures (HTTP 4xx, { error }) auto-refund.
//   • Partial is terminal: refund = FLOOR(total * remains / qty)
//     via boostService.applyPartialRefund (idempotent).
//   • Status moves forward only from provider.
//   • Only type='Default' services are imported. min/max already set
//     by the admin are never overwritten.
//   • last_polled_at bumps on every poll. provider_last_checked_at
//     bumps only when the provider actually replied with a status.
//
// Batch 2 (2026-11-10):
//   + Every status transition also mirrors the boost order into
//     `orders` so Admin → Orders and Revenue analytics see it and
//     track the correct final status. Centralised in
//     mirrorBoostOrder() so no transition site can forget.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const boostService = require('./boostService');

const providerFactory = require('./providers/providerFactory');
const breaker         = require('./providers/providerCircuitBreaker');
const { shapeProviderError } = require('./providers/providerBase');

// ★ NEW: order mirroring
const fulfillment = require('./billsFulfillment');
const recordOrder = (data) => fulfillment.recordOrder(data);

const STUCK_SUBMISSION_MS = 3 * 60 * 1000;
const STATUS_BATCH_SIZE   = 100;
const STATUS_PARALLEL     = 5;
const PROVIDER_NAME       = 'smmwiz';

function isDryRun() {
    return String(process.env.BOOST_PROVIDER_DRY_RUN || '').toLowerCase() === 'true';
}

// ★ NEW: mirrorBoostOrder
// Reads the fresh boost_orders row and pushes it into `orders` via
// recordOrder (idempotent on source_table='boost_orders', source_id).
// Never throws — a mirror failure must not break a boost state
// transition. Call this from every place a boost order changes
// status, so `orders` stays in lockstep.
async function mirrorBoostOrder(orderId) {
    if (!orderId) return;
    try {
        const { data: b } = await supabaseAdmin
            .from('boost_orders')
            .select('id, order_ref, user_id, service_id, service_name, link, quantity, total_amount, currency, status, provider, provider_cost, profit_amount, provider_order_id, api_order_id, failure_reason, refund_status')
            .eq('id', orderId)
            .maybeSingle();
        if (!b) return;

        const status = String(b.status || '').toLowerCase();
        const orderStatus =
            status === 'completed' ? 'completed'
          : (status === 'failed' || status === 'refunded' || status === 'cancelled' || status === 'partial')
                ? 'failed'
                : 'pending';

        const currency = String(b.currency || 'NGN').toUpperCase();
        const amount = Number(b.total_amount ?? 0);
        const providerCost = Number(b.provider_cost ?? 0);
        const storedProfit = b.profit_amount != null ? Number(b.profit_amount) : null;
        const profitAmountOverride = orderStatus === 'completed'
            ? (storedProfit != null ? storedProfit : Math.max(0, amount - providerCost))
            : 0;

        await recordOrder({
            billTransactionId: b.id,
            reference: b.order_ref,
            userId: b.user_id,
            productType: 'boost',
            serviceId: b.service_id || null,
            provider: b.provider || 'smmwiz',
            currency,
            amount,
            serviceFee: 0,
            totalAmount: amount,
            providerCost,
            profitAmountOverride,
            status: orderStatus,
            recipient: b.link || null,
            metadata: {
                service_name: b.service_name || null,
                quantity: b.quantity || null,
                provider_order_id: b.api_order_id || b.provider_order_id || null,
                failure_reason: b.failure_reason || null,
                refunded: status === 'refunded' || b.refund_status === 'refunded'
            }
        });
    } catch (mirrorErr) {
        console.error('[BOOST SYNC] mirrorBoostOrder failed:', orderId, mirrorErr.message);
    }
}

// ── Adapter accessor ─────────────────────────────────────────────
//
// In dry-run mode we do NOT load the real adapter (it would try to
// hit SMMWiz). We return a small in-memory stub that mirrors the
// adapter's interface exactly. isProviderConfigured() is true when
// either real config exists or dry-run is on.

function provider() {
    return providerFactory.getOrThrow(PROVIDER_NAME);
}

function isProviderConfigured() {
    if (isDryRun()) return true;
    const a = providerFactory.get(PROVIDER_NAME);
    return !!(a && typeof a.isConfigured === 'function' && a.isConfigured());
}

function assertProviderConfigured() {
    if (!isProviderConfigured()) {
        const e = new Error('SMMWIZ_API_KEY is not set on this server.');
        e.status = 503; e.code = 'PROVIDER_NOT_CONFIGURED'; e.missing = 'SMMWIZ_API_KEY';
        throw e;
    }
}

// ── Dry-run shim ─────────────────────────────────────────────────
//
// Same interface as the real adapter, but never touches SMMWiz.
// Used by callThrough() below when BOOST_PROVIDER_DRY_RUN=true.

const _dryOrders = new Map(); // providerOrderId → { status, start_count, remains }

function dryAdapter() {
    return {
        isConfigured: () => true,
        async createOrder() {
            const id = 'DRY-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
            _dryOrders.set(id, { status: 'completed', start_count: 0, remains: 0 });
            return { providerOrderId: id, raw: { order: id } };
        },
        async getOrderStatus(order) {
            const id = order && order.provider_order_id;
            if (!id) return { status: null, raw: null };
            const state = _dryOrders.get(id) || { status: 'completed', start_count: 0, remains: 0 };
            return { status: state.status, raw: state };
        },
        async getOrderStatusBatch(ids) {
            const out = {};
            for (const raw of ids || []) {
                const id = String(raw);
                const state = _dryOrders.get(id) || { status: 'completed', start_count: 0, remains: 0 };
                out[id] = {
                    status: state.status,
                    start_count: state.start_count,
                    remains: state.remains,
                    raw: state
                };
            }
            return out;
        },
        async refillOrder(order) {
            return { refillId: 'DRYREFILL-' + Date.now(), raw: { refill: 'DRY' } };
        },
        async getBalance() {
            return { supported: true, raw: { balance: '100.00', currency: 'USD' } };
        },
        normalizeStatus(s) {
            const v = String(s || '').toLowerCase().trim();
            if (!v) return null;
            if (v === 'completed' || v === 'complete') return 'completed';
            if (v === 'failed' || v === 'error') return 'failed';
            if (v === 'pending') return 'pending';
            if (v === 'in progress' || v === 'in_progress') return 'in_progress';
            if (v === 'processing' || v === 'started') return 'processing';
            if (v === 'partial') return 'partial';
            if (v === 'cancelled' || v === 'canceled') return 'cancelled';
            return null;
        }
    };
}

// ── Unified call through adapter (or dry-run shim) ──────────────
//
// Wraps every provider call so the caller always sees:
//   { ok: true, data }            on success
//   { ok: false, err, ... }       on failure, with err already shaped
//
// Also honours the circuit breaker so a broken SMMWiz doesn't spam.

async function callThrough(method, args, { breakerAware = true, timeoutLabel = null } = {}) {
    if (!isProviderConfigured()) {
        return { ok: false, reason: 'PROVIDER_NOT_CONFIGURED' };
    }
    if (breakerAware && !breaker.allowRequest(PROVIDER_NAME)) {
        return { ok: false, reason: 'CIRCUIT_OPEN' };
    }
    const adapter = isDryRun() ? dryAdapter() : provider();
    try {
        const data = await adapter[method].apply(adapter, args || []);
        if (breakerAware) breaker.recordSuccess(PROVIDER_NAME);
        return { ok: true, data };
    } catch (e) {
        const shaped = shapeProviderError(e, `SMMWiz ${method} failed`);
        if (breakerAware) breaker.recordFailure(PROVIDER_NAME);
        // Preserve the "definitive" signal so callers can auto-refund.
        return {
            ok: false,
            err: shaped,
            code: shaped.code,
            ambiguous: shaped.ambiguous,
            definitive: shaped.definitive,
            error: shaped.message
        };
    }
}

function normalizeBoostStatus(status) {
    if (isDryRun()) return dryAdapter().normalizeStatus(status);
    const adapter = providerFactory.get(PROVIDER_NAME);
    if (adapter && typeof adapter.normalizeStatus === 'function') {
        return adapter.normalizeStatus(status);
    }
    // Fallback for safety if the adapter ever drops the export.
    const v = String(status || '').toLowerCase().trim();
    if (!v) return null;
    if (v === 'pending') return 'pending';
    if (v === 'in progress' || v === 'in_progress') return 'in_progress';
    if (v === 'processing' || v === 'started') return 'processing';
    if (v === 'partial' || v === 'partially completed') return 'partial';
    if (['completed','complete','finished','done'].includes(v)) return 'completed';
    if (['canceled','cancelled'].includes(v)) return 'cancelled';
    if (v === 'failed' || v === 'error') return 'failed';
    if (v === 'refunded') return 'refunded';
    return null;
}

function isForwardMove(currentLocal, nextProvider) {
    const local = String(currentLocal || '').toLowerCase();
    const next  = String(nextProvider || '').toLowerCase();
    if (!next) return false;
    if (local === next) return false;
    if (local === 'pending') return true;
    if (local === 'processing')  return next !== 'pending';
    if (local === 'in_progress') return next !== 'pending' && next !== 'processing';
    if (local === 'partial')     return ['completed','failed','cancelled','partial_refunded','manual_review'].includes(next);
    if (local === 'provider_unknown') return ['processing','in_progress','partial','completed','failed','manual_review'].includes(next);
    if (local === 'manual_review')    return ['processing','completed','failed','refunded'].includes(next);
    return false;
}

// ── Claim-first submission ───────────────────────────────────────

async function claimOrderForSubmission(orderId) {
    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin
        .from('boost_orders')
        .update({ provider_status: 'submitting', last_polled_at: now, updated_at: now })
        .eq('id', orderId)
        .eq('status', 'pending')
        .is('api_order_id', null)
        .is('provider_status', null)
        .select('*')
        .maybeSingle();
    if (error) return { claimed: false, reason: 'DB_ERROR' };
    if (!data) return { claimed: false, reason: 'ALREADY_CLAIMED_OR_NOT_PENDING' };
    return { claimed: true, order: data };
}

async function submitBoostOrder(order) {
    if (!order || !order.id) return { submitted: false, reason: 'NO_ORDER' };
    if (order.api_order_id) return { submitted: false, reason: 'ALREADY_SUBMITTED' };
    if (String(order.status) !== 'pending') return { submitted: false, reason: 'NOT_PENDING' };

    const claim = await claimOrderForSubmission(order.id);
    if (!claim.claimed) return { submitted: false, reason: claim.reason };

    const claimedOrder = claim.order;

    const call = await callThrough('createOrder', [{
        serviceId: claimedOrder.service_id,
        link: claimedOrder.link,
        quantity: claimedOrder.quantity
    }]);

    if (call.ok && call.data && call.data.providerOrderId) {
        const apiOrderId = String(call.data.providerOrderId);
        const now = new Date().toISOString();
        const { data: updated } = await supabaseAdmin
            .from('boost_orders')
            .update({
                api_order_id: apiOrderId,
                provider_status: 'submitted',
                provider_last_checked_at: now,
                last_polled_at: now,
                status: 'processing',
                updated_at: now
            })
            .eq('id', claimedOrder.id)
            .select('*')
            .maybeSingle();
        if (updated) {
            try {
                await supabaseAdmin.from('notifications').insert({
                    user_id: updated.user_id,
                    title: 'Boost Submitted',
                    message: `Your ${updated.service_name} order ${updated.order_ref} is now processing.`,
                    type: 'boost_processing', icon: '⏳', link: '/boost', is_read: false,
                    created_at: now
                });
            } catch (_) {}
            // ★ NEW: mirror the status='processing' transition
            await mirrorBoostOrder(updated.id);
        }
        return { submitted: true, api_order_id: apiOrderId, order: updated };
    }

    // Failure path
    const now = new Date().toISOString();
    const reason = call.reason || call.code || 'PROVIDER_ERROR';
    if (reason === 'CIRCUIT_OPEN' || reason === 'PROVIDER_NOT_CONFIGURED') {
        // No real attempt was made. Un-claim so a later tick can retry.
        await supabaseAdmin
            .from('boost_orders')
            .update({ provider_status: null, last_polled_at: now, updated_at: now })
            .eq('id', claimedOrder.id);
        // Order stays pending — no need to mirror a no-op.
        return { submitted: false, reason };
    }
    const definitive = call.definitive === true;
    const nextStatus = definitive ? 'failed' : 'provider_unknown';
    const nextProviderStatus = definitive ? 'rejected' : 'submission_unknown';
    const message = call.error || 'Provider error';

    await supabaseAdmin
        .from('boost_orders')
        .update({
            status: nextStatus,
            provider_status: nextProviderStatus,
            provider_last_checked_at: now,
            last_polled_at: now,
            updated_at: now,
            failure_reason: definitive ? String(message).slice(0, 500) : null
        })
        .eq('id', claimedOrder.id);

    // ★ NEW: mirror the failed / provider_unknown transition
    await mirrorBoostOrder(claimedOrder.id);

    if (definitive) {
        try {
            await boostService.refundOrder({
                orderId: claimedOrder.id,
                reason: `Provider rejected: ${String(message).slice(0, 200)}`,
                ctx: null
            });
            // ★ NEW: refundOrder sets refund_status='refunded'; re-mirror
            // so profit_amount doesn't stay at the pre-refund value.
            await mirrorBoostOrder(claimedOrder.id);
        } catch (refundErr) {
            console.error('[BOOST SYNC] refund after rejection failed:', refundErr.message);
        }
    }
    return { submitted: false, reason, definitive, error: message };
}

async function submitBoostOrderById(orderId) {
    const { data: order } = await supabaseAdmin
        .from('boost_orders').select('*').eq('id', orderId).maybeSingle();
    if (!order) return { submitted: false, reason: 'ORDER_NOT_FOUND' };
    return submitBoostOrder(order);
}

// ── Single-order status ─────────────────────────────────────────

async function syncBoostOrder(order) {
    if (!order || !order.api_order_id) return { updated: false, reason: 'NO_PROVIDER_ORDER_ID' };
    if (boostService.TERMINAL_STATUSES.has(String(order.status).toLowerCase())) {
        return { updated: false, reason: 'TERMINAL' };
    }

    const call = await callThrough('getOrderStatus', [{ provider_order_id: order.api_order_id }], { breakerAware: false });

    if (!call.ok) {
        const now = new Date().toISOString();
        await supabaseAdmin.from('boost_orders').update({
            last_polled_at: now,
            updated_at: now
        }).eq('id', order.id);
        return { updated: false, reason: call.reason || 'PROVIDER_QUERY_FAILED', error: call.error };
    }

    // Normalise the adapter's shape into what applyProviderResult expects.
    const providerStatus = {
        status: call.data.status || null,
        start_count: call.data.raw && call.data.raw.start_count,
        remains: call.data.raw && call.data.raw.remains
    };
    return await applyProviderResult(order, providerStatus);
}

async function applyProviderResult(order, providerStatus) {
    const apiStatus = normalizeBoostStatus(providerStatus.status);
    const now = new Date().toISOString();

    const update = { last_polled_at: now, updated_at: now };
    if (providerStatus.start_count !== undefined) update.start_count = providerStatus.start_count ?? order.start_count ?? null;
    if (providerStatus.remains     !== undefined) update.remains     = providerStatus.remains     ?? order.remains     ?? null;
    update.provider_last_checked_at = now;
    update.provider_status = String(providerStatus.status || '');

    if (!apiStatus || apiStatus === order.status) {
        await supabaseAdmin.from('boost_orders').update(update).eq('id', order.id);
        return { updated: false, status: apiStatus || order.status };
    }
    if (!isForwardMove(order.status, apiStatus)) {
        await supabaseAdmin.from('boost_orders').update(update).eq('id', order.id);
        return { updated: false, status: order.status, reason: 'BACKWARD_BLOCKED' };
    }

    // Partial: refund the shortfall, mark partial_refunded.
    if (apiStatus === 'partial') {
        update.status = 'partial';
        update.completed_at = now;
        const { data: applied, error: updErr } = await supabaseAdmin
            .from('boost_orders').update(update)
            .eq('id', order.id).eq('status', order.status)
            .select('*').maybeSingle();
        if (updErr || !applied) return { updated: false, reason: 'STATE_CHANGED' };

        // ★ NEW: mirror the partial transition (counts as failed in orders)
        await mirrorBoostOrder(applied.id);

        const remains = Number(providerStatus.remains ?? applied.remains ?? 0);
        try {
            await boostService.applyPartialRefund({
                orderId: applied.id,
                remains,
                reason: `Provider reported partial (${remains} remaining)`
            });
            // Re-mirror so refund_status is picked up.
            await mirrorBoostOrder(applied.id);
        } catch (e) {
            console.error('[BOOST SYNC] partial refund failed:', applied.order_ref, e.message);
            return { updated: true, status: 'partial', partial_refund: false, error: e.message };
        }
        return { updated: true, status: 'partial', partial_refund: true };
    }

    update.status = apiStatus;
    if (apiStatus === 'completed') update.completed_at = now;
    if (apiStatus === 'failed' || apiStatus === 'cancelled') update.failed_at = now;

    const { data: applied, error: updErr } = await supabaseAdmin
        .from('boost_orders').update(update)
        .eq('id', order.id).eq('status', order.status)
        .select('*').maybeSingle();
    if (updErr || !applied) return { updated: false, reason: 'STATE_CHANGED' };

    // ★ NEW: mirror the new status
    await mirrorBoostOrder(applied.id);

    try {
        const titles = {
            processing: 'Boost Processing', in_progress: 'Boost In Progress',
            completed: 'Boost Completed', failed: 'Boost Failed', cancelled: 'Boost Cancelled'
        };
        await supabaseAdmin.from('notifications').insert({
            user_id: applied.user_id,
            title: titles[apiStatus] || 'Boost Update',
            message: `Your ${applied.service_name} order ${applied.order_ref} is now ${apiStatus}.`,
            type: `boost_${apiStatus}`,
            icon: apiStatus === 'completed' ? '✅' : apiStatus === 'failed' ? '❌' : '📈',
            link: '/boost', is_read: false, created_at: now
        });
    } catch (_) {}

    if ((apiStatus === 'failed' || apiStatus === 'cancelled') && applied.refund_status !== 'refunded') {
        try {
            await boostService.refundOrder({
                orderId: applied.id,
                reason: `Provider reported ${apiStatus}`,
                ctx: null
            });
            // ★ NEW: re-mirror so refund_status / profit_amount are current
            await mirrorBoostOrder(applied.id);
        } catch (refundErr) {
            console.error('[BOOST SYNC] refund failed for', applied.order_ref, refundErr.message);
        }
    }
    return { updated: true, status: apiStatus };
}

// ── Batch status polling ────────────────────────────────────────

async function syncPendingBoostOrders({ limit = 100 } = {}) {
    if (!isProviderConfigured()) {
        return { ok: false, reason: 'PROVIDER_NOT_CONFIGURED', processed: 0 };
    }
    if (!breaker.allowRequest(PROVIDER_NAME)) {
        return { ok: false, reason: 'CIRCUIT_OPEN', processed: 0 };
    }

    const { data: orders, error } = await supabaseAdmin
        .from('boost_orders')
        .select('*')
        .in('status', ['pending', 'processing', 'in_progress', 'partial', 'provider_unknown'])
        .not('api_order_id', 'is', null)
        .order('last_polled_at', { ascending: true, nullsFirst: true })
        .limit(limit);

    if (error) return { ok: false, error: error.message, processed: 0 };
    if (!orders?.length) return { ok: true, processed: 0, updated: 0 };

    // Try batch first (up to STATUS_BATCH_SIZE per call).
    const chunks = [];
    for (let i = 0; i < orders.length; i += STATUS_BATCH_SIZE) {
        chunks.push(orders.slice(i, i + STATUS_BATCH_SIZE));
    }
    let updated = 0;
    let mode = 'batch';
    for (const chunk of chunks) {
        const ids = chunk.map(o => o.api_order_id).filter(Boolean);
        if (!ids.length) continue;
        const call = await callThrough('getOrderStatusBatch', [ids], { breakerAware: false });
        if (!call.ok) {
            // Fall back to per-order for this chunk.
            mode = 'parallel';
            for (let i = 0; i < chunk.length; i += STATUS_PARALLEL) {
                const slice = chunk.slice(i, i + STATUS_PARALLEL);
                const results = await Promise.all(slice.map(o =>
                    syncBoostOrder(o).catch(err => ({ updated: false, error: err.message }))
                ));
                updated += results.filter(r => r.updated).length;
            }
            continue;
        }
        const batch = call.data || {};
        for (const order of chunk) {
            const row = batch[order.api_order_id];
            if (!row) continue;
            try {
                const r = await applyProviderResult(order, {
                    status: row.status,
                    start_count: row.start_count,
                    remains: row.remains
                });
                if (r.updated) updated++;
            } catch (e) {
                console.error('[BOOST SYNC] apply batch failed for', order.order_ref, e.message);
            }
        }
    }
    return { ok: true, processed: orders.length, updated, mode };
}

// ── Stuck submission recovery ───────────────────────────────────

async function recoverStuckSubmissions() {
    const cutoff = new Date(Date.now() - STUCK_SUBMISSION_MS).toISOString();
    const { data, error } = await supabaseAdmin
        .from('boost_orders')
        .update({
            provider_status: 'submission_unknown',
            status: 'provider_unknown',
            updated_at: new Date().toISOString(),
            last_polled_at: new Date().toISOString()
        })
        .eq('provider_status', 'submitting')
        .lt('last_polled_at', cutoff)
        .select('id, order_ref');
    if (error) return { recovered: 0 };
    const recovered = data?.length || 0;
    // ★ NEW: mirror each recovered order (they moved to provider_unknown)
    for (const row of data || []) {
        await mirrorBoostOrder(row.id);
    }
    return { recovered, orders: data || [] };
}

// ── Pending submissions sweep ──────────────────────────────────

async function submitPendingBoostOrders({ limit = 25 } = {}) {
    if (!isProviderConfigured()) {
        return { ok: false, reason: 'PROVIDER_NOT_CONFIGURED', submitted: 0 };
    }
    if (!breaker.allowRequest(PROVIDER_NAME)) {
        return { ok: false, reason: 'CIRCUIT_OPEN', submitted: 0 };
    }
    await recoverStuckSubmissions();

    const { data: orders, error } = await supabaseAdmin
        .from('boost_orders')
        .select('*')
        .eq('status', 'pending')
        .is('api_order_id', null)
        .is('provider_status', null)
        .order('created_at', { ascending: true })
        .limit(limit);
    if (error) return { ok: false, error: error.message, submitted: 0 };
    if (!orders?.length) return { ok: true, submitted: 0 };

    let submitted = 0;
    for (const order of orders) {
        const r = await submitBoostOrder(order);
        if (r.submitted) submitted++;
    }
    return { ok: true, submitted };
}

// ── Provider balance ────────────────────────────────────────────

async function getProviderBalance() {
    if (!isProviderConfigured()) {
        return { configured: false, balance: null, currency: null, dry_run: isDryRun() };
    }
    const call = await callThrough('getBalance', [], { breakerAware: false });
    if (!call.ok) {
        return {
            configured: true,
            balance: null,
            currency: 'USD',
            error: call.error || call.reason,
            dry_run: isDryRun()
        };
    }
    const raw = call.data && call.data.raw ? call.data.raw : call.data;
    const n = Number(raw && (raw.balance || raw.funds)) || 0;
    return {
        configured: true,
        balance: n,
        currency: (raw && raw.currency) || 'USD',
        dry_run: isDryRun()
    };
}

// ── Refill ─────────────────────────────────────────────────────

async function requestRefill({ orderRef }) {
    if (!orderRef) {
        const e = new Error('orderRef is required.'); e.status = 400; e.code = 'INVALID_ORDER_REF'; throw e;
    }
    const { data: order, error } = await supabaseAdmin
        .from('boost_orders').select('*').eq('order_ref', String(orderRef)).maybeSingle();
    if (error || !order) {
        const e = new Error('Order not found.'); e.status = 404; e.code = 'BOOST_NOT_FOUND'; throw e;
    }
    if (!order.api_order_id) {
        const e = new Error('Order was never submitted to the provider.');
        e.status = 422; e.code = 'NOT_SUBMITTED'; throw e;
    }
    if (!['completed','partial'].includes(String(order.status).toLowerCase())) {
        const e = new Error('Refill is only available for completed orders.');
        e.status = 422; e.code = 'NOT_REFUNDABLE_ORDER_STATE'; throw e;
    }
    const call = await callThrough('refillOrder', [{ provider_order_id: order.api_order_id }], { breakerAware: true });
    if (!call.ok) {
        const e = new Error(call.error || 'Refill failed.');
        e.status = call.definitive ? 422 : 502;
        e.code = call.code || 'REFILL_FAILED';
        throw e;
    }
    return { ok: true, refill_id: call.data && call.data.refillId || null, raw: call.data && call.data.raw };
}

// ── Catalog import ─────────────────────────────────────────────

function detectPlatform(name, category) {
    const src = `${name || ''} ${category || ''}`.toLowerCase();
    if (src.includes('instagram')) return 'instagram';
    if (src.includes('tiktok'))    return 'tiktok';
    if (src.includes('youtube'))   return 'youtube';
    if (src.includes('facebook'))  return 'facebook';
    if (src.includes('twitter') || src.includes(' x ')) return 'twitter';
    if (src.includes('telegram'))  return 'telegram';
    if (src.includes('whatsapp'))  return 'whatsapp';
    if (src.includes('discord'))   return 'discord';
    if (src.includes('spotify'))   return 'spotify';
    return 'other';
}
function detectCategory(name, category) {
    const src = `${name || ''} ${category || ''}`.toLowerCase();
    if (src.includes('follower'))   return 'followers';
    if (src.includes('like'))       return 'likes';
    if (src.includes('view') || src.includes('impression')) return 'views';
    if (src.includes('comment'))    return 'comments';
    if (src.includes('share'))      return 'shares';
    if (src.includes('subscriber')) return 'subscribers';
    if (src.includes('member'))     return 'members';
    if (src.includes('stream') || src.includes('play')) return 'streams';
    return 'other';
}

// In dry-run we return two fake services.
async function dryServiceList() {
    return [
        { service: 'dry-1', name: 'Instagram Followers — Dry', rate: '1.00', min: '100', max: '10000', category: 'Instagram Followers', type: 'Default' },
        { service: 'dry-2', name: 'TikTok Likes — Dry',       rate: '0.50', min: '50',  max: '5000',  category: 'TikTok Likes',       type: 'Default' }
    ];
}

async function syncServiceCatalog() {
    assertProviderConfigured();

    let list;
    if (isDryRun()) {
        list = await dryServiceList();
    } else {
        // Services listing isn't in the adapter's public API. If it
        // ever gains one (e.g. `listServices()`), swap this in. For
        // now we call the provider through a dedicated helper the
        // adapter will grow later. If the adapter has no
        // `listServices`, we fail clean.
        const adapter = provider();
if (typeof adapter.listServices !== 'function') {
    const e = new Error('SMMWiz adapter does not expose listServices yet.');
    e.status = 503; e.code = 'PROVIDER_LIST_UNSUPPORTED'; throw e;
}
const res = await adapter.listServices();
if (!res || res.supported === false) {
    const e = new Error((res && res.error) || 'SMMWiz service listing failed.');
    e.status = 502; e.code = 'PROVIDER_LIST_FAILED'; throw e;
}
list = Array.isArray(res.services) ? res.services : [];
    }
    if (!Array.isArray(list) || !list.length) {
        return { ok: true, created: 0, updated: 0, deactivated: 0, rate_changes: 0, skipped_non_default: 0, total: 0 };
    }

    const defaults = list.filter(s => {
        const t = String(s.type || '').trim();
        return !t || t.toLowerCase() === 'default';
    });
    const skipped_non_default = list.length - defaults.length;

    const { data: existing } = await supabaseAdmin
        .from('boost_services')
        .select('id, provider_service_id, provider_rate, min_quantity, max_quantity, admin_min_quantity, admin_max_quantity')
        .eq('provider', 'smmwiz');
    const existingByProviderId = new Map();
    for (const row of existing || []) existingByProviderId.set(String(row.provider_service_id), row);

    const providerIds = new Set();
    const inserts = [];
    const updates = [];

    for (const s of defaults) {
        const providerServiceId = String(s.service);
        providerIds.add(providerServiceId);
        const newRate = Number(s.rate) || 0;
        if (newRate <= 0) continue;
        const newMin = Number(s.min) || null;
        const newMax = Number(s.max) || null;
        const ex = existingByProviderId.get(providerServiceId);
        const canCancel = Boolean(s.cancel) || String(s.cancel || '').toLowerCase() === 'true';

        if (ex) {
            const oldRate = Number(ex.provider_rate) || 0;
            const rateChanged = Math.abs(oldRate - newRate) > 1e-9;
            const adminMin = ex.admin_min_quantity;
            const adminMax = ex.admin_max_quantity;
            let minToKeep = ex.min_quantity;
            let maxToKeep = ex.max_quantity;
            if (adminMin == null) {
                minToKeep = rateChanged && ex.min_quantity != null && newMin != null
                    ? Math.max(Number(ex.min_quantity), newMin) : (newMin ?? ex.min_quantity);
            }
            if (adminMax == null) {
                maxToKeep = rateChanged && ex.max_quantity != null && newMax != null
                    ? Math.min(Number(ex.max_quantity), newMax) : (newMax ?? ex.max_quantity);
            }
            const patch = {
                provider_rate: newRate,
                service_type: String(s.type || 'Default'),
                cancel_supported: canCancel,
                updated_at: new Date().toISOString()
            };
            if (adminMin == null) patch.min_quantity = minToKeep;
            if (adminMax == null) patch.max_quantity = maxToKeep;

            const needsUpdate =
                rateChanged ||
                Number(ex.min_quantity) !== Number(minToKeep) ||
                Number(ex.max_quantity) !== Number(maxToKeep);
            if (needsUpdate) updates.push({ id: ex.id, patch, rate_changed: rateChanged });
        } else {
            inserts.push({
                provider: 'smmwiz',
                provider_service_id: providerServiceId,
                name: String(s.name || `Service ${providerServiceId}`).slice(0, 200),
                description: null,
                platform: detectPlatform(s.name, s.category),
                category: detectCategory(s.name, s.category),
                service_type: String(s.type || 'Default'),
                cancel_supported: canCancel,
                active: false, visible_to_users: false,
                provider_rate: newRate,
                min_quantity: newMin,
                max_quantity: newMax,
                refill_allowed: Boolean(s.refill),
                sort_order: 100,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        }
    }

    const removedIds = [...existingByProviderId.keys()].filter(id => !providerIds.has(id));
    let deactivated = 0;
    if (removedIds.length) {
        const { data: deact } = await supabaseAdmin
            .from('boost_services')
            .update({ active: false, visible_to_users: false, updated_at: new Date().toISOString() })
            .eq('provider', 'smmwiz')
            .in('provider_service_id', removedIds)
            .select('id');
        deactivated = deact?.length || 0;
    }

    let created = 0;
    for (let i = 0; i < inserts.length; i += 500) {
        const chunk = inserts.slice(i, i + 500);
        const { error } = await supabaseAdmin.from('boost_services').insert(chunk);
        if (!error) created += chunk.length;
    }

    let updated = 0, rateChanges = 0;
    for (let i = 0; i < updates.length; i += 20) {
        const batch = updates.slice(i, i + 20);
        const results = await Promise.all(batch.map(u =>
            supabaseAdmin.from('boost_services').update(u.patch).eq('id', u.id)
                .then(r => ({ ok: !r.error, rate_changed: u.rate_changed }))
        ));
        updated += results.filter(r => r.ok).length;
        rateChanges += results.filter(r => r.ok && r.rate_changed).length;
    }

    boostService.invalidateCatalog();

    return {
        ok: true,
        created, updated, deactivated,
        rate_changes: rateChanges,
        skipped_non_default,
        total: list.length,
        dry_run: isDryRun()
    };
}

module.exports = {
    isProviderConfigured,
    assertProviderConfigured,
    isDryRun,
    normalizeBoostStatus,
    isForwardMove,
    submitBoostOrder,
    submitBoostOrderById,
    submitPendingBoostOrders,
    syncBoostOrder,
    syncPendingBoostOrders,
    getProviderBalance,
    requestRefill,
    syncServiceCatalog,
    recoverStuckSubmissions,
    mirrorBoostOrder   // ★ NEW: exported for admin tooling / tests
};