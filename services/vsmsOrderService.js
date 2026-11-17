// services/vsmsOrderService.js
// ─────────────────────────────────────────────────────────────────────────────
// THE Virtual SMS ORDER STATE MACHINE.
//
// Every status change in the entire system goes through this file. The
// user route, the admin service, and the worker DO NOT write
// virtual_sms_orders.status directly — they call this module.
//
// Guarantees:
//   • Every transition is compare-and-set:
//       UPDATE ... WHERE id=? AND status=<expected> RETURNING *
//     A 0-row result means "someone else moved it" — the caller gets
//     a structured ORDER_STATE_CHANGED error and does NOT retry blindly.
//   • Every transition writes a virtual_sms_order_events row.
//   • Every transition that affects revenue mirrors to the shared
//     `orders` table via billsFulfillment.recordOrder (non-fatal,
//     try/catch). Money correctness is handled in mirrorToOrders():
//     profit_amount is always in the CHARGE currency.
//   • Refunds go through ONE helper — refundOrderSafely — which:
//       - re-checks sms_code (cannot refund a delivered code),
//       - claims the order atomically (CAS to *_pending_refund),
//       - calls the provider cancel FIRST when an activation exists,
//       - calls LedgerService.refundTransaction with the deterministic
//         reference the ledger already uses (`REFUND-{original.reference}`),
//       - writes refunds row via the ledger's own path,
//       - CAS's the order to 'refunded',
//       - mirrors as 'failed' to `orders`,
//       - creates a user notification,
//       - writes a terminal event.
//   • Idempotency: refundTransaction short-circuits on the deterministic
//     reference. Calling refundOrderSafely twice is safe.
//
// States (single source of truth):
//   pending            — row created, not yet debited
//   processing         — debited, provider call in flight or ambiguous
//   active             — number assigned, waiting for SMS
//   sms_received       — code stored; user can read it
//   completed          — provider setStatus=6 confirmed; revenue recognised
//   failed             — provider definite failure, no debit or debit refunded
//   cancelled          — user cancelled + refunded
//   expired            — worker expired + refunded
//   refunded           — terminal; wallet refund posted
//   manual_review      — anything ambiguous or a failed refund path
//   cancelling         — CAS lock while user cancel refund is in flight
//   expiring           — CAS lock while worker expiry refund is in flight
//   failing            — CAS lock while definite-failure refund is in flight
//
// Transition table (enforced by CAS + ALLOWED_TRANSITIONS below):
//   pending → processing | failed | manual_review
//   processing → active | sms_received | failed | manual_review
//   active → sms_received | completed | cancelling | expiring | failing | manual_review
//   sms_received → completed | refunded | manual_review
//   completed → (terminal)
//   failed → refunded
//   cancelled → refunded
//   expired → refunded
//   cancelling → refunded | manual_review
//   expiring → refunded | manual_review
//   failing → refunded | manual_review
//   refunded → (terminal)
//   manual_review → refunded | active | completed
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const adminSettings = require('./adminSettingsService');
const fulfillment = require('./billsFulfillment');
const provider = require('./vsmsProvider');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sentinel UUID for audit rows created by system-initiated refunds.
// Used ONLY if admin_audit_logs.admin_id turns out to be NOT NULL.
const SYSTEM_ADMIN_ID = '00000000-0000-0000-0000-000000000000';

// ─── Transition table ─────────────────────────────────────────────────────
const ALLOWED_TRANSITIONS = Object.freeze({
    pending:       ['processing', 'failed', 'manual_review'],
    processing:    ['active', 'sms_received', 'failed', 'manual_review'],
    active:        ['sms_received', 'completed', 'cancelling', 'expiring', 'failing', 'manual_review'],
    sms_received:  ['completed', 'refunded', 'manual_review'],
    completed:     [],  // terminal
    failed:        ['refunded'],
    cancelled:     ['refunded'],
    expired:       ['refunded'],
    cancelling:    ['refunded', 'manual_review'],
    expiring:      ['refunded', 'manual_review'],
    failing:       ['refunded', 'manual_review'],
    refunded:      [],  // terminal
    manual_review: ['refunded', 'active', 'completed']
});

// Statuses that mean "the user paid and hasn't been refunded yet".
const PAID_NOT_REFUNDED = new Set([
    'processing', 'active', 'sms_received', 'completed',
    'cancelling', 'expiring', 'failing', 'failed', 'cancelled', 'expired',
    'manual_review'
]);

// Statuses that mean "the money is gone from the wallet, we still need
// to resolve the order". Used by the orphan-debit resolver.
const HOLDING_DEBIT = new Set([
    'processing', 'active', 'sms_received', 'cancelling', 'expiring', 'failing'
]);

// ─── Error helper ─────────────────────────────────────────────────────────
function err(code, message, status = 400, extra = {}) {
    const e = new Error(message || code);
    e.code = code;
    e.status = status;
    Object.assign(e, extra);
    return e;
}

// ─── Event helper ─────────────────────────────────────────────────────────
async function recordEvent({
    orderId, eventType, oldStatus, newStatus, message, providerResponse, metadata
}) {
    if (!UUID_RE.test(String(orderId || ''))) return;
    try {
        await supabaseAdmin.from('virtual_sms_order_events').insert({
            order_id:          orderId,
            event_type:        eventType || newStatus || 'event',
            old_status:        oldStatus   || null,
            new_status:        newStatus   || null,
            message:           message     ? String(message).slice(0, 1000) : null,
            provider_response: providerResponse || null,
            metadata:          metadata || {}
        });
    } catch (e) {
        console.warn('[VSMS ORDER] event insert failed:', e.message, { orderId, eventType });
    }
}

// ─── Notification helper (delegates to billsFulfillment) ─────────────────
async function notifyUser(userId, title, message, type, link) {
    try {
        await fulfillment.createNotification(userId, title, message, type, link || '/virtual.html');
    } catch (e) {
        console.warn('[VSMS ORDER] notification failed:', e.message, { userId });
    }
}

// ─── Order mirror to shared `orders` table ────────────────────────────────
// The single place any VSMS code calls recordOrder(). Every other module
// calls this function. This guarantees:
//   • provider_cost is expressed in the CHARGE currency (not USD)
//   • profit_amount is totalAmount − providerCost, in the charge currency
//   • status maps the VSMS lifecycle to the Revenue lifecycle:
//       debited/active/processing → 'pending'
//       sms_received (code stored, awaiting completion) → 'pending'
//       completed → 'completed'
//       failed/cancelled/expired/refunded/manual_review → 'failed'
async function mirrorToOrders(order, { statusOverride } = {}) {
    if (!order || !order.id || !order.user_id) return;
    const chargeCurrency = String(order.charge_currency || 'NGN').toUpperCase();
    const exchangeRate   = Number(order.exchange_rate) || 0;
    const priceUsd       = Number(order.price_usd) || 0;
    const providerCostUsd = Number(order.provider_cost_usd) || 0;

    // Convert provider cost into the charge currency.
    let providerCostInChargeCurrency;
    if (chargeCurrency === 'USD') {
        providerCostInChargeCurrency = providerCostUsd;
    } else {
        // NGN: convert using the order's own exchange_rate.
        providerCostInChargeCurrency = exchangeRate > 0
            ? Number((providerCostUsd * exchangeRate).toFixed(2))
            : 0;
    }

    // Total amount in the charge currency.
    let totalAmount;
    if (Number.isFinite(Number(order.charge_amount)) && Number(order.charge_amount) > 0) {
        totalAmount = Number(order.charge_amount);
    } else if (chargeCurrency === 'USD') {
        totalAmount = priceUsd;
    } else {
        totalAmount = Number(order.price_ngn) || 0;
    }

    // Revenue lifecycle mapping.
    const s = String(order.status || '').toLowerCase();
    let mirrorStatus;
    if (statusOverride) {
        mirrorStatus = statusOverride;
    } else if (s === 'completed') {
        mirrorStatus = 'completed';
    } else if (['failed', 'cancelled', 'expired', 'refunded', 'manual_review'].includes(s)) {
        mirrorStatus = 'failed';
    } else {
        mirrorStatus = 'pending';   // pending / processing / active / sms_received
    }

    try {
        await fulfillment.recordOrder({
            billTransactionId: order.id,
            sourceTable:       'virtual_sms_orders',
            reference:         order.id,
            userId:            order.user_id,
            productType:       'virtual_sms',
            serviceId:         String(order.country_id || ''),
            provider:          'virtualsms',
            currency:          chargeCurrency,
            amount:            totalAmount,
            serviceFee:        0,
            totalAmount:       totalAmount,
            providerCost:      providerCostInChargeCurrency,
            profitAmountOverride: mirrorStatus === 'completed'
                ? Number((totalAmount - providerCostInChargeCurrency).toFixed(2))
                : 0,
            status:            mirrorStatus,
            recipient:         order.phone_number || null,
            metadata: {
                service_code:  order.service_code,
                service_name:  order.service_name,
                country_id:    order.country_id,
                activation_id: order.activation_id,
                exchange_rate: order.exchange_rate,
                charge_currency: chargeCurrency,
                provider_cost_usd: providerCostUsd
            }
        });
    } catch (e) {
        // Mirror is never fatal. The reconciliation admin can re-run it.
        console.error('[VSMS ORDER] mirrorToOrders failed (non-fatal):', e.message, { orderId: order.id });
    }
}

// ─── Load ─────────────────────────────────────────────────────────────────
async function loadOrder(id) {
    if (!UUID_RE.test(String(id || ''))) {
        throw err('INVALID_ID', 'Invalid order id.', 400);
    }
    const { data, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error) throw err('VSMS_LOAD_FAILED', 'Failed to load order.', 500, { cause: error.message });
    if (!data) throw err('VSMS_NOT_FOUND', 'Order not found.', 404);
    return data;
}

// ─── Atomic transition ────────────────────────────────────────────────────
async function transition({
    orderId, fromStatus, toStatus, patch = {}, ctx,
    eventType, reason, providerResponse, silentAudit
}) {
    const current = String(fromStatus || '').toLowerCase();
    const next    = String(toStatus   || '').toLowerCase();

    const allowed = ALLOWED_TRANSITIONS[current] || [];
    if (!allowed.includes(next)) {
        throw err(
            'INVALID_STATUS_TRANSITION',
            `Cannot transition from "${current}" to "${next}".`,
            422,
            { allowed_transitions: allowed, expected_status: current }
        );
    }

    const now = new Date().toISOString();
    const updatePayload = { ...patch, status: next, updated_at: now };
    if (next === 'completed')          updatePayload.completed_at          = now;
    if (next === 'cancelled')          updatePayload.cancelled_at          = now;
    if (next === 'refunded')           updatePayload.refunded_at           = now;
    if (next === 'expired' && !updatePayload.expired_at) updatePayload.expired_at = now;
    if (next === 'sms_received' && !updatePayload.sms_received_at) updatePayload.sms_received_at = now;

    const { data: updated, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .update(updatePayload)
        .eq('id', orderId)
        .eq('status', current)
        .select('*')
        .maybeSingle();

    if (error) {
        throw err('VSMS_UPDATE_FAILED', 'Failed to update order.', 500, { cause: error.message });
    }
    if (!updated) {
        throw err(
            'ORDER_STATE_CHANGED',
            'Order changed while this action was in flight. Reload and try again.',
            409,
            { expected_status: current }
        );
    }

    await recordEvent({
        orderId,
        eventType: eventType || next,
        oldStatus: current,
        newStatus: next,
        message:   reason || null,
        providerResponse: providerResponse || null,
        metadata: { transition_from: current, transition_to: next }
    });

    // Admin-side audit (only when ctx is a real admin — the worker and
    // user-cancel path pass systemCtx = null and skip the audit table).
    if (ctx && !silentAudit && ctx.adminId) {
        try {
            await supabaseAdmin.from('virtual_sms_admin_actions').insert({
                admin_id:   ctx.adminId   || null,
                order_id:   orderId,
                action:     eventType || next,
                old_status: current,
                new_status: next,
                reason:     reason ? String(reason).slice(0, 500) : null,
                ip_address: ctx.ip || null,
                user_agent: ctx.userAgent || null
            });
        } catch (e) {
            console.warn('[VSMS ORDER] admin action insert failed:', e.message);
        }
    }

    // Mirror to shared orders table.
    await mirrorToOrders(updated);

    return updated;
}

// ─── createAndDebitOrder ──────────────────────────────────────────────────
// Called from POST /order AFTER the caller has:
//   • run feature/emergency/provider gates
//   • resolved the live price
//   • checked expectedAmount
//   • checked balance
//
// This function is the ONLY place that inserts the initial row AND
// debits the wallet. It must be called AFTER an idempotency claim has
// been established (the caller inserts with the idempotency_key first,
// and a 23505 on that INSERT is the duplicate short-circuit — see the
// user route for the exact pattern).
//
// Returns { order } on success. On debit failure, the order is marked
// 'failed' + recorded as such and the error is thrown.
async function createAndDebitOrder({
    userId,
    countryId,
    serviceCode,
    serviceName,
    priceUsd,
    priceNgn,
    providerCostUsd,
    exchangeRate,
    chargeCurrency,
    chargeAmount,
    idempotencyKey
}) {
    if (!UUID_RE.test(String(userId || ''))) {
        throw err('INVALID_USER', 'Invalid user id.', 400);
    }

    const orderId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + await getExpiryMinutes() * 60_000).toISOString();
    const cancelAvailableAt = null;    // set when we go active
    const ledgerReference = `VSMS-${orderId}`;

    // 1. Insert with the unique idempotency key. If a duplicate exists,
    //    Supabase returns 23505 and we surface it as a structured
    //    DUPLICATE_REQUEST. This is the lock.
    const { data: inserted, error: insertError } = await supabaseAdmin
        .from('virtual_sms_orders')
        .insert({
            id:                     orderId,
            user_id:                userId,
            country_id:             countryId,
            service_code:           serviceCode,
            service_name:           serviceName,
            price_usd:              priceUsd,
            price_ngn:              priceNgn,
            provider_cost_usd:      providerCostUsd,
            exchange_rate:          exchangeRate,
            charge_currency:        chargeCurrency,
            charge_amount:          chargeAmount,
            status:                 'pending',
            idempotency_key:        idempotencyKey,
            ledger_reference:       ledgerReference,
            expires_at:             expiresAt,
            cancel_available_at:    cancelAvailableAt,
            created_at:             new Date().toISOString(),
            updated_at:             new Date().toISOString(),
            metadata: {
                source: 'api',
                markup_at_purchase: null    // filled later if needed
            }
        })
        .select('*')
        .single();

    if (insertError) {
        if (insertError.code === '23505') {
            // Fetch the existing order — the caller (route) will return its state.
            const { data: existing } = await supabaseAdmin
                .from('virtual_sms_orders')
                .select('*')
                .eq('user_id', userId)
                .eq('idempotency_key', idempotencyKey)
                .maybeSingle();
            throw err(
                'DUPLICATE_REQUEST',
                'This order was already placed.',
                200,
                { existing_order: existing }
            );
        }
        throw err('ORDER_CREATE_FAILED', 'Failed to create order.', 500, { cause: insertError.message });
    }

    await recordEvent({
        orderId,
        eventType: 'order_created',
        newStatus: 'pending',
        message: 'Order created',
        metadata: { chargeCurrency, chargeAmount, countryId, serviceCode }
    });

    // 2. Debit. Uses deterministic reference + idempotencyKey so a
    //    retry short-circuits on the ledger and we never double-charge.
    let debit;
    try {
        debit = await LedgerService.debitWallet({
            userId,
            amount:         chargeAmount,
            currency:       chargeCurrency,
            type:           'virtual_sms_purchase',
            reference:      ledgerReference,
            sourceType:     'virtual_sms_order',
            sourceId:       orderId,
            idempotencyKey: `vsms-debit-${orderId}`,
            description:    `Virtual SMS: ${serviceName} (${chargeCurrency})`,
            metadata: {
                order_id:     orderId,
                service_code: serviceCode,
                country_id:   countryId,
                price_usd:    priceUsd,
                price_ngn:    priceNgn,
                provider_cost_usd: providerCostUsd,
                exchange_rate: exchangeRate
            }
        });
    } catch (debitErr) {
        // 3. Debit failed — mark failed, mirror, return error.
        const failed = await supabaseAdmin
            .from('virtual_sms_orders')
            .update({
                status: 'failed',
                failure_code: 'DEBIT_FAILED',
                failure_message: String(debitErr.message || 'Wallet debit failed').slice(0, 500),
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId)
            .eq('status', 'pending')
            .select('*')
            .maybeSingle();

        const failedRow = failed.data || inserted;
        await recordEvent({
            orderId,
            eventType: 'wallet_debit_failed',
            oldStatus: 'pending',
            newStatus: 'failed',
            message:   String(debitErr.message || 'Wallet debit failed').slice(0, 500)
        });
        await mirrorToOrders(failedRow);

        throw err(
            'DEBIT_FAILED',
            'Wallet debit failed. No charge was made.',
            402,
            { cause: debitErr.message }
        );
    }

    // 4. Attach the ledger transaction, move to processing.
    let active;
    try {
        active = await transition({
            orderId,
            fromStatus: 'pending',
            toStatus:   'processing',
            patch: {
                ledger_transaction_id: debit.transaction_id,
                ledger_reference:      ledgerReference
            },
            eventType: 'wallet_debited',
            reason:    `Debited ${chargeAmount} ${chargeCurrency}`,
            silentAudit: true
        });
    } catch (e) {
        // This should never happen — CAS from pending with our own row.
        // If it does, the debit succeeded but the order is stuck. Mark
        // needs_attention and log.
        await supabaseAdmin
            .from('virtual_sms_orders')
            .update({
                needs_attention: true,
                attention_reason: 'debit_ok_but_transition_failed: ' + String(e.message).slice(0, 400)
            })
            .eq('id', orderId);
        await mirrorToOrders(inserted);
        throw err('ORDER_STUCK', 'Order stuck after debit. Support has been notified.', 500, { orderId });
    }

    return { order: active, ledgerTransactionId: debit.transaction_id };
}

// ─── applyProviderPurchaseResult ──────────────────────────────────────────
// Called from POST /order after the provider responds. Parses the
// provider result (kind: NUMBER_ASSIGNED | DEFINITE_FAILURE | AMBIGUOUS)
// and either activates the order, refunds it, or leaves it in processing
// for the worker to resolve.
async function applyProviderPurchaseResult({ orderId, providerResult }) {
    const order = await loadOrder(orderId);

    if (order.status !== 'processing') {
        // Someone else moved it — return the current state.
        return { order, resolved: order.status };
    }

    // ── NUMBER_ASSIGNED ─────────────────────────────────────────────
    if (providerResult && providerResult.kind === 'NUMBER_ASSIGNED') {
        const activationId = String(providerResult.activationId || '');
        const phoneNumber  = String(providerResult.phoneNumber  || '');
        if (!activationId || !phoneNumber) {
            // Same as AMBIGUOUS — the provider said "number" but didn't
            // give us one. Do NOT refund. Let the worker resolve.
            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    needs_attention: true,
                    attention_reason: 'NUMBER_ASSIGNED without id or phone',
                    updated_at: new Date().toISOString()
                })
                .eq('id', orderId);
            return { order, resolved: 'processing' };
        }

        const cancelAfterMinutes = await getCancelAfterMinutes();
        const cancelAvailableAt = new Date(Date.now() + cancelAfterMinutes * 60_000).toISOString();
        const nextCheckAt = new Date(Date.now() + 3000).toISOString();

        const updated = await transition({
            orderId,
            fromStatus: 'processing',
            toStatus:   'active',
            patch: {
                activation_id:       activationId,
                phone_number:        phoneNumber,
                activated_at:        new Date().toISOString(),
                cancel_available_at: cancelAvailableAt,
                next_check_at:       nextCheckAt,
                provider_response:   providerResult.raw || null
            },
            eventType: 'number_activated',
            reason:    `Number assigned: ${phoneNumber}`,
            providerResponse: providerResult.raw || null,
            silentAudit: true
        });

        return { order: updated, resolved: 'active' };
    }

    // ── DEFINITE_FAILURE ────────────────────────────────────────────
    if (providerResult && providerResult.kind === 'DEFINITE_FAILURE') {
        const code = String(providerResult.code || 'PROVIDER_REJECTED');
        const message = String(providerResult.message || 'Provider rejected the order.');

        // Move to 'failing' first (CAS lock), then refund. Refund helper
        // handles the actual credit + terminal state.
        let locked;
        try {
            locked = await transition({
                orderId,
                fromStatus: 'processing',
                toStatus:   'failing',
                patch: {
                    failure_code:    code.slice(0, 80),
                    failure_message: message.slice(0, 500),
                    provider_response: providerResult.raw || null
                },
                eventType: 'provider_definite_failure',
                reason:    `${code}: ${message}`,
                silentAudit: true
            });
        } catch (e) {
            if (e.code === 'ORDER_STATE_CHANGED') {
                const current = await loadOrder(orderId);
                return { order: current, resolved: current.status };
            }
            throw e;
        }

        const refundResult = await refundOrderSafely({
            orderId,
            reason: `Provider ${code}: ${message}`,
            actor:  { type: 'system', source: 'provider_definite_failure' }
        });

        return { order: refundResult.order, resolved: 'refunded', refund: refundResult.refund };
    }

    // ── AMBIGUOUS ───────────────────────────────────────────────────
    // Leave the order in 'processing'. The worker will resolve within
    // 90s via the ambiguous-resolver. We add a next_check_at to make
    // sure the worker picks it up promptly.
    await supabaseAdmin
        .from('virtual_sms_orders')
        .update({
            next_check_at: new Date(Date.now() + 90_000).toISOString(),
            failure_message: (providerResult && providerResult.reason)
                ? String(providerResult.reason).slice(0, 500)
                : 'Provider response ambiguous',
            provider_response: (providerResult && providerResult.raw) || null,
            updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

    return { order: await loadOrder(orderId), resolved: 'processing' };
}

// ─── storeSmsAndComplete ──────────────────────────────────────────────────
// Called by the worker (and by the admin "sync" path) when a code is
// received from the provider. Stores the code, fires setStatus(6) for
// completion, and transitions to completed. If setStatus fails, we
// leave the order in sms_received and let the worker retry — the user
// still sees the code.
async function storeSmsAndComplete({ orderId, smsCode, smsText, providerRaw }) {
    const order = await loadOrder(orderId);

    // If code already stored and order already completed, no-op.
    if (order.status === 'completed' && order.sms_code) {
        return { order, completed: true };
    }
    if (!smsCode) {
        return { order, completed: false };
    }
    if (!['active', 'processing', 'sms_received'].includes(order.status)) {
        return { order, completed: false };
    }

    // 1. Store the code. If fromStatus is 'active' or 'processing', CAS
    //    to sms_received. If already sms_received, just update the code.
    let afterCode;
    if (order.status === 'sms_received') {
        const { data: patched } = await supabaseAdmin
            .from('virtual_sms_orders')
            .update({
                sms_code:         smsCode,
                sms_message:      smsText ? String(smsText).slice(0, 2000) : null,
                sms_status:       'received',
                otp_status:       'received',
                otp_received_at:  new Date().toISOString(),
                provider_response: providerRaw || null,
                updated_at:       new Date().toISOString()
            })
            .eq('id', orderId)
            .eq('status', 'sms_received')
            .select('*')
            .maybeSingle();
        afterCode = patched || order;
    } else {
        afterCode = await transition({
            orderId,
            fromStatus: order.status,
            toStatus:   'sms_received',
            patch: {
                sms_code:         smsCode,
                sms_message:      smsText ? String(smsText).slice(0, 2000) : null,
                sms_status:       'received',
                otp_status:       'received',
                otp_received_at:  new Date().toISOString(),
                provider_response: providerRaw || null
            },
            eventType: 'sms_received',
            reason:    'SMS code received',
            providerResponse: providerRaw || null,
            silentAudit: true
        });
    }

    await mirrorToOrders(afterCode);
    await notifyUser(
        afterCode.user_id,
        'Your verification code is ready',
        `SMS received for ${afterCode.service_name || afterCode.service_code}.`,
        'success',
        '/virtual.html'
    );

    // 2. Try setStatus 6 (complete). Non-fatal — worker retries.
    let completedConfirmed = false;
    let confirmError = null;
    if (afterCode.activation_id) {
        try {
            const res = await provider.setStatus({
                activationId: afterCode.activation_id,
                status: 6,
                orderId: orderId
            });
            completedConfirmed = res && res.kind === 'ACCESS_ACTIVATION';
        } catch (e) {
            confirmError = e.message;
        }
    }

    // 3. If confirmed, transition to completed. Otherwise stay in
    //    sms_received and mark next_check_at so the worker retries.
    if (completedConfirmed) {
        try {
            const completed = await transition({
                orderId,
                fromStatus: 'sms_received',
                toStatus:   'completed',
                patch: {
                    completed_confirmed_at: new Date().toISOString()
                },
                eventType: 'completed',
                reason:    'Provider confirmed completion (setStatus 6)',
                silentAudit: true
            });
            return { order: completed, completed: true };
        } catch (e) {
            if (e.code === 'ORDER_STATE_CHANGED') {
                const current = await loadOrder(orderId);
                return { order: current, completed: current.status === 'completed' };
            }
            throw e;
        }
    }

    // Stay in sms_received. Worker will retry.
    await supabaseAdmin
        .from('virtual_sms_orders')
        .update({
            next_check_at: new Date(Date.now() + 30_000).toISOString(),
            failure_message: confirmError
                ? `setStatus 6 failed: ${confirmError}`.slice(0, 500)
                : 'setStatus 6 not confirmed',
            updated_at: new Date().toISOString()
        })
        .eq('id', orderId)
        .eq('status', 'sms_received');

    return { order: afterCode, completed: false };
}

// ─── refundOrderSafely ────────────────────────────────────────────────────
// THE single refund path for every refund in the system.
//
// Steps:
//   1. Re-check: cannot refund a delivered SMS code.
//   2. Verify the order is refundable and has a ledger transaction.
//   3. CAS-lock the order (to *_pending_refund state: cancelling /
//      expiring / failing / sms_received→refunded for edge case).
//   4. Provider cancel (setStatus 8) when activation exists. If the
//      provider refuses because the SMS actually arrived, we deliver
//      the code instead of refunding.
//   5. LedgerService.refundTransaction with the order's ledger
//      transaction id. Handles idempotency on `REFUND-{reference}`.
//   6. CAS to refunded, store refund_transaction_id, refunded_at.
//   7. Mirror as failed.
//   8. Notify user.
//   9. Terminal event.
//
// Idempotent: calling it twice is safe. `result.already_exists` is
// treated as success.
//
// If anything after step 5 fails, we CAS to manual_review and insert a
// failed_refunds row + notify admins.
async function refundOrderSafely({ orderId, reason, actor }) {
    if (!reason || String(reason).trim().length < 4) {
        throw err('REASON_REQUIRED', 'A reason of at least 4 characters is required.', 422);
    }
    const order = await loadOrder(orderId);

    // 1. Cannot refund delivered code.
    if (order.sms_code) {
        return {
            order,
            refund: null,
            skipped: 'SMS_CODE_ALREADY_DELIVERED',
            message: 'This order already delivered a code. It cannot be refunded.'
        };
    }

    // 2. Verify.
    if (order.status === 'refunded') {
        return {
            order,
            refund: {
                already_refunded: true,
                transaction_id: order.refund_transaction_id || null
            }
        };
    }
    if (!order.ledger_transaction_id) {
        throw err('NO_TRANSACTION', 'This order has no wallet transaction to refund.', 422);
    }
    if (!PAID_NOT_REFUNDED.has(order.status) && order.status !== 'manual_review') {
        throw err('NOT_REFUNDABLE', `Cannot refund an order with status "${order.status}".`, 422);
    }

    // 3. CAS lock.
    // Map the current status to a *_pending_refund state:
    //   active               → cancelling
    //   processing           → failing
    //   pending (rare)       → failing
    //   sms_received (no code) → refunded (immediate — see below)
    //   expired              → (no CAS needed, straight to refunded)
    //   failed/cancelled     → (no CAS needed, straight to refunded)
    //   manual_review        → (no CAS needed)
    let lockTo = null;
    if (order.status === 'active')      lockTo = 'cancelling';
    if (order.status === 'processing')  lockTo = 'failing';
    if (order.status === 'pending')     lockTo = 'failing';

    let locked = order;
    if (lockTo) {
        try {
            locked = await transition({
                orderId,
                fromStatus: order.status,
                toStatus:   lockTo,
                eventType:  'refund_lock_acquired',
                reason:     `Refund lock acquired: ${lockTo}`,
                silentAudit: true
            });
        } catch (e) {
            if (e.code === 'ORDER_STATE_CHANGED') {
                // Someone else moved it. Return the current state — do
                // not double-refund.
                const current = await loadOrder(orderId);
                return { order: current, refund: null, skipped: 'CONCURRENT_TRANSITION' };
            }
            throw e;
        }
    }

    // 4. Provider cancel (only when activation exists AND this is a
    //    pre-delivery state). We already checked !sms_code at step 1.
    if (locked.activation_id && ['cancelling', 'failing', 'expiring', 'active'].includes(locked.status)) {
        try {
            const cancelRes = await provider.setStatus({
                activationId: locked.activation_id,
                status: 8,
                orderId: orderId
            });
            if (cancelRes && cancelRes.kind === 'ACCESS_CANCEL') {
                // Provider confirmed cancel.
            } else if (cancelRes && cancelRes.kind === 'STATUS_OK') {
                // Provider says the SMS actually arrived — DO NOT REFUND.
                // Deliver the code instead.
                await storeSmsAndComplete({
                    orderId,
                    smsCode: cancelRes.smsCode || null,
                    smsText: cancelRes.smsText || null,
                    providerRaw: cancelRes.raw
                });
                const current = await loadOrder(orderId);
                return {
                    order: current,
                    refund: null,
                    skipped: 'PROVIDER_CONFIRMED_SMS_ARRIVED',
                    message: 'Provider reported the SMS arrived during cancellation. Code delivered instead of refund.'
                };
            } else if (cancelRes && cancelRes.kind === 'EARLY_CANCEL_DENIED') {
                // Provider minimum hold — keep the order, retry next tick.
                // Do NOT refund now. The worker will retry.
                if (lockTo) {
                    try {
                        await transition({
                            orderId,
                            fromStatus: locked.status,
                            toStatus:   order.status,
                            eventType:  'refund_lock_released',
                            reason:     'Early cancel denied by provider; will retry',
                            silentAudit: true
                        });
                    } catch (e) { /* best effort */ }
                }
                return {
                    order: await loadOrder(orderId),
                    refund: null,
                    skipped: 'EARLY_CANCEL_DENIED',
                    message: 'Provider minimum hold not met. Refund will retry automatically.'
                };
            }
            // Anything else — ambiguous — do not refund yet. Release
            // lock, mark needs_attention, return.
            if (lockTo) {
                try {
                    await transition({
                        orderId,
                        fromStatus: locked.status,
                        toStatus:   order.status,
                        eventType:  'refund_lock_released',
                        reason:     'Provider cancel response ambiguous',
                        silentAudit: true
                    });
                } catch (e) { /* best effort */ }
            }
            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    needs_attention: true,
                    attention_reason: `Provider cancel ambiguous: ${(cancelRes && cancelRes.kind) || 'UNKNOWN'}`,
                    updated_at: new Date().toISOString()
                })
                .eq('id', orderId);
            return {
                order: await loadOrder(orderId),
                refund: null,
                skipped: 'PROVIDER_CANCEL_AMBIGUOUS'
            };
        } catch (e) {
            // Provider threw. Do not refund blindly — the number may
            // still be live. Mark needs_attention.
            if (lockTo) {
                try {
                    await transition({
                        orderId,
                        fromStatus: locked.status,
                        toStatus:   order.status,
                        eventType:  'refund_lock_released',
                        reason:     'Provider cancel threw: ' + String(e.message).slice(0, 200),
                        silentAudit: true
                    });
                } catch (_) { /* best effort */ }
            }
            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    needs_attention: true,
                    attention_reason: 'Provider cancel threw: ' + String(e.message).slice(0, 400),
                    updated_at: new Date().toISOString()
                })
                .eq('id', orderId);
            return {
                order: await loadOrder(orderId),
                refund: null,
                skipped: 'PROVIDER_CANCEL_FAILED'
            };
        }
    }

    // 5. Ledger refund. This is the ONE place we call it.
    let refundResult;
    try {
        refundResult = await LedgerService.refundTransaction({
            userId:          locked.user_id,
            transactionId:   locked.ledger_transaction_id,
            reason:          String(reason).slice(0, 500),
            idempotencyKey:  `vsms-refund-${orderId}`
        });
    } catch (refundErr) {
        // Ledger refund failed. Leave the order in its *_pending_refund
        // state, record the failure, and let the worker retry.
        await supabaseAdmin
            .from('virtual_sms_orders')
            .update({
                refund_status:    'failed',
                refund_attempts:  (Number(locked.refund_attempts) || 0) + 1,
                failure_message:  String(refundErr.message || 'Ledger refund failed').slice(0, 500),
                updated_at:       new Date().toISOString()
            })
            .eq('id', orderId);

        // Only after 5 attempts do we go to manual_review.
        const attempts = (Number(locked.refund_attempts) || 0) + 1;
        if (attempts >= 5) {
            await transition({
                orderId,
                fromStatus: locked.status,
                toStatus:   'manual_review',
                patch: {
                    needs_attention: true,
                    attention_reason: 'Refund failed after 5 attempts'
                },
                eventType: 'refund_failed_max_attempts',
                reason:    String(refundErr.message || '').slice(0, 500),
                silentAudit: true
            }).catch(() => {});
            try {
                await supabaseAdmin.from('failed_refunds').insert({
                    user_id:               locked.user_id,
                    ledger_transaction_id: locked.ledger_transaction_id,
                    reason:                `VSMS refund (${reason})`.slice(0, 500),
                    error_message:         String(refundErr.message || '').slice(0, 1000),
                    context:               { order_id: orderId, source: 'vsms_order_service' },
                    status:                'pending',
                    attempts:              attempts
                });
            } catch (e) {
                console.warn('[VSMS ORDER] failed_refunds insert failed:', e.message);
            }
            await notifyAdmins(
                'VSMS refund failed after retries',
                `Order ${orderId} could not be refunded. Reason: ${refundErr.message || 'unknown'}.`
            );
        }
        throw err('REFUND_FAILED', 'Refund failed. The worker will retry automatically.', 502, {
            cause: refundErr.message,
            attempts
        });
    }

    // 6. CAS to refunded. Must be from whichever state the lock put us in,
    //    or from the original state if there was no lock.
    const fromState = locked.status || order.status;
    const targetFrom = (fromState === 'cancelling' || fromState === 'failing' || fromState === 'expiring')
        ? fromState
        : order.status;

    let finalOrder;
    try {
        finalOrder = await transition({
            orderId,
            fromStatus: targetFrom,
            toStatus:   'refunded',
            patch: {
                refund_status:          'completed',
                refund_transaction_id:  refundResult.transaction_id || null,
                refund_attempts:        (Number(locked.refund_attempts) || 0) + 1
            },
            eventType: 'refunded',
            reason:    String(reason).slice(0, 500),
            silentAudit: true
        });
    } catch (e) {
        // If the CAS failed here, the money IS gone from the user's
        // perspective (already refunded) but the order didn't update.
        // Mark needs_attention.
        await supabaseAdmin
            .from('virtual_sms_orders')
            .update({
                needs_attention: true,
                attention_reason: 'Refund posted but order CAS failed: ' + String(e.message).slice(0, 400),
                refund_status: 'completed',
                refund_transaction_id: refundResult.transaction_id || null,
                updated_at: new Date().toISOString()
            })
            .eq('id', orderId);
        throw err('REFUND_POST_CREDIT_FAILED',
            'Refund posted to wallet but order could not be finalized. Support has been notified.',
            500);
    }

    // 7. Mirror as failed (already done by transition()).
    // 8. Notify user.
    const amount = Number(finalOrder.charge_amount) || 0;
    const currency = finalOrder.charge_currency || 'NGN';
    const sym = currency === 'USD' ? '$' : '₦';
    await notifyUser(
        finalOrder.user_id,
        'Your order was refunded',
        `${sym}${amount.toFixed(2)} ${currency} has been refunded to your wallet for ${finalOrder.service_name || finalOrder.service_code}.`,
        'success',
        '/virtual.html'
    );

    return {
        order: finalOrder,
        refund: {
            transaction_id: refundResult.transaction_id || null,
            reference:      refundResult.reference || null,
            amount,
            currency,
            already_refunded: !!refundResult.already_exists
        }
    };
}

// ─── expireOrder ──────────────────────────────────────────────────────────
// Called by the worker when an active/processing order's expires_at has
// passed with no SMS code. Uses refundOrderSafely.
async function expireOrder({ orderId, reason }) {
    const order = await loadOrder(orderId);
    if (order.sms_code) {
        return { order, expired: false, reason: 'SMS_CODE_DELIVERED' };
    }
    if (!['active', 'processing', 'sms_received'].includes(order.status)) {
        return { order, expired: false, reason: 'NOT_EXPIRABLE' };
    }

    // If we're on 'active', CAS to 'expiring' first (lock), then refund.
    if (order.status === 'active') {
        try {
            await transition({
                orderId,
                fromStatus: 'active',
                toStatus:   'expiring',
                eventType:  'expiry_lock_acquired',
                reason:     'Expiry reached; refunding',
                silentAudit: true
            });
        } catch (e) {
            if (e.code === 'ORDER_STATE_CHANGED') {
                return { order: await loadOrder(orderId), expired: false, reason: 'CONCURRENT' };
            }
            throw e;
        }
    }

    return await refundOrderSafely({
        orderId,
        reason: reason || 'Order expired — no SMS received',
        actor:  { type: 'system', source: 'expiry' }
    });
}

// ─── cancelByUser ─────────────────────────────────────────────────────────
// User-initiated cancel. Checks:
//   • no code delivered
//   • status is active
//   • cancel_available_at has passed
// Then refunds via the single helper.
async function cancelByUser({ orderId, userId, reason }) {
    const order = await loadOrder(orderId);
    if (String(order.user_id) !== String(userId)) {
        throw err('FORBIDDEN', 'This order does not belong to you.', 403);
    }
    if (order.sms_code) {
        throw err('SMS_CODE_DELIVERED', 'A code has already been delivered. Cancellation is not available.', 422);
    }
    if (order.status === 'refunded') {
        return { order, already: true, refund: { already_refunded: true } };
    }
    if (order.status !== 'active') {
        throw err('NOT_CANCELLABLE', `Cannot cancel an order with status "${order.status}".`, 422);
    }
    if (order.cancel_available_at && new Date(order.cancel_available_at) > new Date()) {
        const waitSec = Math.ceil((new Date(order.cancel_available_at) - Date.now()) / 1000);
        throw err('CANCEL_TOO_EARLY',
            `Cancellation is available in ${Math.ceil(waitSec / 60)} more minute(s).`,
            409,
            { can_cancel_at: order.cancel_available_at, wait_seconds: waitSec });
    }

    return await refundOrderSafely({
        orderId,
        reason: reason || 'User cancelled — full refund',
        actor:  { type: 'user', userId }
    });
}

// ─── cancelByAdmin ────────────────────────────────────────────────────────
// Admin-initiated cancel-and-refund. Same refund helper, but the audit
// path is populated via ctx.
async function cancelByAdmin({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        throw err('REASON_REQUIRED', 'A reason of at least 4 characters is required.', 422);
    }
    const order = await loadOrder(orderId);

    // Admin can override with confirmCodeWasReceived, but default is
    // to refuse if a code exists.
    if (order.sms_code && !ctx.confirmCodeWasReceived) {
        throw err('SMS_CODE_DELIVERED',
            'A code has already been delivered. Send confirmCodeWasReceived: true to override.',
            409);
    }
    if (order.status === 'refunded') {
        return { order, already: true, refund: { already_refunded: true } };
    }

    const result = await refundOrderSafely({
        orderId,
        reason,
        actor: { type: 'admin', adminId: ctx.adminId, adminEmail: ctx.adminEmail }
    });

    // Audit trail (admin-specific).
    try {
        await supabaseAdmin.from('virtual_sms_admin_actions').insert({
            admin_id:   ctx.adminId   || null,
            order_id:   orderId,
            action:     'cancel_and_refund',
            old_status: order.status,
            new_status: result.order?.status || 'refunded',
            reason:     String(reason).slice(0, 500),
            ip_address: ctx.ip || null,
            user_agent: ctx.userAgent || null
        });
    } catch (e) {
        console.warn('[VSMS ORDER] admin cancel audit failed:', e.message);
    }

    return result;
}

// ─── Settings helpers ─────────────────────────────────────────────────────
async function getExpiryMinutes() {
    try {
        const v = await adminSettings.getRaw('virtual_sms_expiry_minutes');
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n > 0 ? n : 20;
    } catch { return 20; }
}
async function getCancelAfterMinutes() {
    try {
        const v = await adminSettings.getRaw('virtual_sms_cancel_after_minutes');
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n >= 0 ? n : 5;
    } catch { return 5; }
}
async function getMaxActivePerUser() {
    try {
        const v = await adminSettings.getRaw('virtual_sms_max_active_per_user');
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n > 0 ? n : 3;
    } catch { return 3; }
}
async function getAutoRefundEnabled() {
    try {
        const v = await adminSettings.getRaw('virtual_sms_auto_refund_enabled');
        return v !== false && v !== 'false' && v !== '0';
    } catch { return true; }
}

// ─── Admin notification helper ────────────────────────────────────────────
async function notifyAdmins(title, message) {
    try {
        const { data: admins } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .in('role', ['admin', 'super_admin'])
            .eq('status', 'active')
            .limit(50);
        for (const a of admins || []) {
            await fulfillment.createNotification(a.id, title, message, 'error', '/admin/virtual-sms.html');
        }
    } catch (e) {
        console.warn('[VSMS ORDER] admin notify failed:', e.message);
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────
module.exports = {
    ALLOWED_TRANSITIONS,
    PAID_NOT_REFUNDED,
    HOLDING_DEBIT,
    SYSTEM_ADMIN_ID,

    // State machine (single entrypoints)
    createAndDebitOrder,
    applyProviderPurchaseResult,
    storeSmsAndComplete,
    refundOrderSafely,
    expireOrder,
    cancelByUser,
    cancelByAdmin,
    transition,

    // Utilities
    loadOrder,
    recordEvent,
    mirrorToOrders,
    notifyUser,
    notifyAdmins,

    // Settings
    getExpiryMinutes,
    getCancelAfterMinutes,
    getMaxActivePerUser,
    getAutoRefundEnabled
};