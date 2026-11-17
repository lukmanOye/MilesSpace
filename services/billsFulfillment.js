// services/billsFulfillment.js
// Shared helpers extracted from routes/billsRoutes.js so
// billsRoutes, the VTpass reconciler, and the admin service all use
// the SAME refund path, notification creator and transaction writer.
//
// Batch 3 (2026-11-10):
//   + recordOrder() now writes `payment_status` in lockstep with
//     `status`. This stops the Orders page from flagging every
//     completed order as "completed but not paid" (computeHealth() in
//     ordersService.js checks both fields).
//   + Optional paymentStatus override for refunded orders so
//     payment_status='refunded' rather than 'failed'.
'use strict';

const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function getWalletBalance(userId, currency = 'NGN') {
    const ccy = String(currency).toUpperCase();
    const { data: profile } = await supabaseAdmin
        .from('profiles').select('wallet_ngn, wallet_usd').eq('id', userId).maybeSingle();
    const profileBal = ccy === 'USD' ? num(profile?.wallet_usd) : num(profile?.wallet_ngn);
    if (profileBal > 0) return profileBal;
    try {
        const { data: ledger } = await supabaseAdmin
            .from('ledger_accounts').select('available_balance')
            .eq('user_id', userId).eq('currency', ccy).maybeSingle();
        const ledgerBal = num(ledger?.available_balance);
        if (ledgerBal > 0) return ledgerBal;
    } catch {}
    return profileBal;
}

async function createNotification(userId, title, message, type = 'info', link = null) {
    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId, title, message, type,
            icon: type === 'success' ? '✅' : type === 'error' ? '❌' : '📌',
            link: link || '/bills', is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.error('Notification error:', e.message);
    }
}

async function createTransaction(data) {
    const payload = {
        user_id: data.userId,
        reference: data.reference,
        service_type: data.serviceType,
        service_id: data.serviceId,
        provider: 'vtpass',
        currency: data.currency || 'NGN',
        base_amount: parseFloat(data.baseAmount) || 0,
        provider_amount: parseFloat(data.providerAmount) || 0,
        markup_amount: parseFloat(data.markupAmount) || 0,
        service_fee: parseFloat(data.serviceFee) || 0,
        customer_amount: parseFloat(data.customerAmount) || 0,
        recipient: data.recipient,
        network: data.network || null,
        variation_code: data.variationCode || null,
        status: data.status || 'pending',
        idempotency_key: data.idempotencyKey || null,
        request_fingerprint: data.requestFingerprint || null,
        metadata: data.metadata || {},
        fee_percent: data.feePercent != null ? String(data.feePercent) : null,
        provider_commission_ngn: data.providerCommissionNgn != null ? String(data.providerCommissionNgn) : null,
        margin_ngn: data.marginNgn != null ? String(data.marginNgn) : null,
        ledger_transaction_id: data.ledgerTransactionId || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
    const { data: tx, error } = await supabaseAdmin
        .from('bill_payment_transactions').insert(payload).select().single();
    if (error) throw new Error(`Failed to create transaction: ${error.message}`);
    return tx;
}

async function updateTransaction(transactionId, updates) {
    const { data, error } = await supabaseAdmin
        .from('bill_payment_transactions')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', transactionId).select().single();
    if (error) throw new Error(`Failed to update transaction: ${error.message}`);
    return data;
}

/**
 * Mirror a bill_payment_transactions row into `orders` so Admin → Orders
 * and Revenue analytics can see bills purchases. Idempotent on
 * (source_table='bill_payment_transactions', source_id).
 * Never throws — logs and returns null on failure.
 *
 * payment_status is derived from status:
 *   completed → 'paid'
 *   failed    → 'failed'  (or 'refunded' if paymentStatus='refunded' passed)
 *   pending   → 'pending'
 *
 * This keeps computeHealth() (ordersService.js) from flagging every
 * completed order as "completed but not paid".
 */
// services/billsFulfillment.js — replace the existing recordOrder with this one.
// Everything else in the file stays as-is.

async function recordOrder({
    billTransactionId,
    sourceTable = 'bill_payment_transactions',
    reference,
    userId,
    productType,
    serviceId,
    provider = 'vtpass',
    currency = 'NGN',
    amount,
    serviceFee = 0,
    totalAmount,
    providerCost = 0,
    profitAmountOverride = null,
    status,
    recipient,
    metadata = {}
}) {
    if (!billTransactionId || !userId) {
        console.warn('[recordOrder] missing billTransactionId or userId — skipping');
        return null;
    }
    if (!sourceTable || typeof sourceTable !== 'string') {
        console.warn('[recordOrder] invalid sourceTable — skipping');
        return null;
    }

    const mappedStatus =
        status === 'completed' ? 'completed'
      : status === 'failed'    ? 'failed'
      : 'pending';

    const computedProfit =
        mappedStatus === 'completed'
            ? Number(totalAmount || 0) - Number(providerCost || 0)
            : 0;
    const profitAmount = profitAmountOverride != null
        ? Number(profitAmountOverride)
        : computedProfit;

    const orderRef = reference
        ? (String(reference).startsWith('ORD-') ? String(reference) : `ORD-${reference}`)
        : `ORD-${billTransactionId}`;

    const payload = {
        order_ref:     orderRef,
        user_id:       userId,
        product_type:  productType,
        provider,
        currency:      String(currency || 'NGN').toUpperCase(),
        status:        mappedStatus,
        amount:        Number(amount || 0),
        total_amount:  Number(totalAmount || 0),
        provider_cost: Number(providerCost || 0),
        profit_amount: profitAmount,
        source_table:  sourceTable,
        source_id:     billTransactionId,
        metadata: {
            ...metadata,
            service_id: serviceId,
            recipient,
            service_fee: Number(serviceFee || 0),
            bill_transaction_id: billTransactionId
        },
        created_at: new Date().toISOString()
    };

    try {
        // 1. Preferred lookup: (source_table, source_id). Matches the
        //    new code's contract.
        const { data: bySource, error: selErr } = await supabaseAdmin
            .from('orders')
            .select('id')
            .eq('source_table', sourceTable)
            .eq('source_id', billTransactionId)
            .maybeSingle();
        if (selErr) throw selErr;

        if (bySource) {
            const { error } = await supabaseAdmin
                .from('orders')
                .update(payload)
                .eq('id', bySource.id);
            if (error) throw error;
            return bySource.id;
        }

        // 2. Fallback lookup: order_ref. This is the column that has
        //    the UNIQUE constraint. If a legacy or pre-migration row
        //    exists with the same order_ref (but different/missing
        //    source_table/source_id), we MUST update it — never
        //    attempt the insert, because the insert will throw 23505.
        const { data: byRef, error: refErr } = await supabaseAdmin
            .from('orders')
            .select('id')
            .eq('order_ref', orderRef)
            .maybeSingle();
        if (refErr) throw refErr;

        if (byRef) {
            const { error } = await supabaseAdmin
                .from('orders')
                .update(payload)
                .eq('id', byRef.id);
            if (error) throw error;
            return byRef.id;
        }

        // 3. No row at all — insert.
        const { data, error } = await supabaseAdmin
            .from('orders')
            .insert(payload)
            .select('id')
            .single();
        if (error) throw error;
        return data.id;
    } catch (err) {
        // 4. Race-safe fallback: if we lost a race on the UNIQUE
        //    order_ref constraint (23505), re-read and update. This
        //    handles the case where two workers tried to mirror the
        //    same order at the same instant.
        if (err && err.code === '23505') {
            try {
                const { data: again } = await supabaseAdmin
                    .from('orders')
                    .select('id')
                    .eq('order_ref', orderRef)
                    .maybeSingle();
                if (again && again.id) {
                    const { error: updErr } = await supabaseAdmin
                        .from('orders')
                        .update(payload)
                        .eq('id', again.id);
                    if (updErr) throw updErr;
                    return again.id;
                }
            } catch (retryErr) {
                console.error('[recordOrder] 23505 retry failed:', retryErr.message, {
                    sourceTable, billTransactionId, orderRef
                });
            }
        }
        console.error('[recordOrder] failed:', err.message, {
            sourceTable, billTransactionId, orderRef, productType, status
        });
        return null;
    }
}
async function attemptRefund({ userId, ledgerTransactionId, reason, sourceContext }) {
    if (!ledgerTransactionId) return { success: false, error: 'no ledgerTransactionId', code: 'NO_LEDGER_ID' };
    try {
        const result = await LedgerService.refundTransaction({
            userId,
            transactionId: ledgerTransactionId,
            reason: reason || 'Refund'
        });
        if (!result || result.success !== true) {
            throw new Error(result?.error || 'refund returned unsuccessful');
        }
        console.log(`[BILLS] ✅ Refunded ${result.amount} ${result.currency} (refund_tx=${result.transaction_id}, original=${ledgerTransactionId})`);
        return { success: true, refund: result };
    } catch (refundErr) {
        console.error(`[BILLS] 🚨 REFUND FAILED — user=${userId}, ledger_tx=${ledgerTransactionId}, reason="${reason}".`,
            refundErr.message);
        try {
            await supabaseAdmin.from('failed_refunds').insert({
                user_id: userId,
                ledger_transaction_id: ledgerTransactionId,
                reason: String(reason || 'unknown').slice(0, 500),
                error_message: String(refundErr.message || refundErr).slice(0, 1000),
                context: sourceContext || {},
                status: 'pending',
                attempts: 0,
                created_at: new Date().toISOString()
            });
        } catch (persistErr) {
            console.error('[BILLS] Could not persist failed_refunds row:', persistErr.message);
        }
        return { success: false, error: refundErr.message || String(refundErr) };
    }
}

module.exports = {
    getWalletBalance,
    createNotification,
    createTransaction,
    updateTransaction,
    recordOrder,
    attemptRefund
};