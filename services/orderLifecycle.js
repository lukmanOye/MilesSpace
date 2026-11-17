// services/orderLifecycle.js
// ─────────────────────────────────────────────────────────────────
// Shared order-lifecycle primitives. Extracted from
// giftCardService.js so eSIM (and anything else with the same
// three-state provider model) can reuse them without copy-paste.
//
// Every function here is a MOVE, not a change. If you diff against
// services/giftCardService.js you will see the exact same bodies —
// only the module boundary changed.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');

// ─── Audit (fail-loud) ──────────────────────────────────────────
async function recordAudit({ ctx, table, action, targetId, before, after, reason }) {
    const row = {
        admin_id: ctx?.adminId || null,
        admin_email: ctx?.adminEmail || null,
        action,
        target_type: table,
        target_id: targetId,
        before: before || null,
        after: after || null,
        reason: reason ? String(reason).slice(0, 500) : null,
        ip_address: ctx?.ip || null,
        user_agent: ctx?.userAgent || null,
        created_at: new Date().toISOString()
    };
    const { error } = await supabaseAdmin.from('admin_audit_logs').insert(row);
    if (error) {
        console.error('[ORDER LIFECYCLE] audit insert failed:', error.message);
        const e = new Error('Audit logging failed.');
        e.status = 500; e.code = 'AUDIT_WRITE_FAILED';
        throw e;
    }
}

// ─── State transition with optimistic lock ──────────────────────
//
//   table           'gift_card_orders' | 'esim_transactions'
//   eventsTable     'gift_card_order_events' | 'esim_transaction_events'
//   allowedMap      the per-service ALLOWED_TRANSITIONS map
//
async function transitionOrderStatus({
    table, eventsTable, allowedMap,
    orderId, expectedCurrentStatus, nextStatus,
    reason = null, extraFields = {}, ctx = null, eventType = 'status_changed'
}) {
    const current = String(expectedCurrentStatus || '').toLowerCase();
    const next_ = String(nextStatus || '').toLowerCase();

    const allowed = allowedMap[current] || [];
    if (!allowed.includes(next_)) {
        const e = new Error(`Cannot transition from "${current}" to "${next_}".`);
        e.status = 422; e.code = 'INVALID_STATUS_TRANSITION';
        e.allowed_transitions = allowed;
        e.current_status = current;
        throw e;
    }

    const now = new Date().toISOString();
    const update = { status: next_, updated_at: now, ...extraFields };
    if (next_ === 'completed') update.completed_at = now;
    if (next_ === 'refunded')  update.refunded_at  = now;

    const { data: updated, error } = await supabaseAdmin
        .from(table)
        .update(update)
        .eq('id', orderId)
        .eq('status', current)
        .select('*')
        .maybeSingle();

    if (error) {
        const e = new Error('Failed to update order status.');
        e.status = 500; e.code = 'ORDER_UPDATE_FAILED';
        e.cause = error.message;
        throw e;
    }
    if (!updated) {
        const e = new Error('Order changed while you were editing it. Reload and try again.');
        e.status = 409; e.code = 'ORDER_STATE_CHANGED';
        e.expected_status = current;
        throw e;
    }

    // Non-fatal event insert
    try {
        await supabaseAdmin.from(eventsTable).insert({
            order_id: orderId,
            event_type: eventType,
            from_status: current,
            to_status: next_,
            actor_type: ctx ? 'admin' : 'system',
            actor_id: ctx?.adminId || null,
            reason: reason ? String(reason).slice(0, 500) : null,
            created_at: now
        });
    } catch (e) {
        console.warn('[ORDER LIFECYCLE] event insert failed:', e.message);
    }

    if (ctx) {
        await recordAudit({
            ctx,
            table,
            action: `${table}.${eventType}`,
            targetId: orderId,
            before: { status: current },
            after: { status: next_ },
            reason
        });
    }

    return { updated: true, order: updated };
}

module.exports = {
    recordAudit,
    transitionOrderStatus
};