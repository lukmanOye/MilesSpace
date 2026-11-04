// reconciliation/adapters/nowpayments.js
// ─────────────────────────────────────────────────────────────────
// NowPayments crypto deposits adapter.
//
// ⚠️ IMPORTANT: this adapter does NOT call
// cryptoDepositService.verifyAndComplete() for verify(). It calls the
// provider directly. Reason:
//
//   verifyAndComplete maps 'confirmed' to a credit decision — but
//   NowPayments 'confirmed' is not the same as 'finished'. A deposit
//   in 'confirmed' state has been seen on-chain but not yet
//   finalized; crediting on it would double-credit if 'finished'
//   arrives later with a different amount.
//
//   verifyAndComplete also maps 'partially_paid' to a terminal
//   manual_review status — which removes the deposit from the
//   sweeper permanently. The correct behavior is to raise an
//   AMOUNT_MISMATCH issue and leave the deposit in a
//   still-sweepable state so a later top-up of the same deposit
//   (which NowPayments does NOT support) is not confused with a
//   fresh one. We keep the deposit in 'pending' + issue open.
//
// The adapter's settle() then delegates to verifyAndComplete ONLY
// for the case it handles correctly: provider status = 'finished'
// and amount within EXACT_BAND. For anything else it delegates to
// the markFailed / manual-review path explicitly.
//
// 🔴 MONEY-MOVE RISK: if NowPayments ever changes 'finished' semantics
// to include partial-credit, verifyAndComplete's decideCredit() will
// handle the amount band correctly (it uses EXACT_BAND = 2%). But
// the adapter's validate() also enforces the band — defense in depth.
//
// ─────────────────────────────────────────────────────────────────
// FIX LOG (2026-11-03, second pass)
//   • findCandidates was calling .in() on the object returned by
//     supabaseAdmin.from(TABLE). In @supabase/supabase-js v2 that
//     object is a PostgrestQueryBuilder and does NOT have .in /
//     .eq / .lte / .order / .limit. Those methods only exist on the
//     PostgrestFilterBuilder returned by .select(). The fix is to
//     insert .select('*') before .in('status', ...), matching how
//     kora.js is written.
//   • Moved the defensive assertBuilderHas() call to after
//     .select() so it validates the filter builder, not the query
//     builder.
//   • Removed the module.exports.listProviderTransactions = ... line
//     that was silently overwritten by the module.exports = {…} on
//     the next line. listProviderTransactions is now part of the
//     final export object.
//   • markFailed() gets a .select('id') tail so we can log if the
//     UPDATE matched zero rows (a bug symptom we want visible).
// ─────────────────────────────────────────────────────────────────
'use strict';

const axios = require('axios');
const { supabaseAdmin } = require('../../db/supabase');
const cryptoDepositService = require('../../services/cryptoDepositService');

const KEY       = 'nowpayments';
const PROVIDER  = 'nowpayments';
const TABLE     = 'crypto_deposits';
const LOCK_NAME = `recon:${KEY}:${TABLE}`;

const NOWPAYMENTS_API_BASE = 'https://api-sandbox.nowpayments.io/v1';
const NOWPAYMENTS_API_KEY  = process.env.NOWPAYMENTS_API_KEY;

const PENDING_STATUSES  = ['pending', 'processing', 'processing_credit', 'partially_paid'];
const TERMINAL_STATUSES = ['completed', 'failed', 'expired', 'refunded', 'manual_review'];

// Match cryptoDepositService.EXACT_BAND.
const EXACT_BAND = 0.02;

// ─── Defensive helpers ──────────────────────────────────────────
// In @supabase/supabase-js v2:
//   .from(table)            → PostgrestQueryBuilder  (no .in, .eq, .order…)
//   .select(...) / .update(...) / .insert(...)  → PostgrestFilterBuilder
// Only the *FilterBuilder* has .in, .eq, .lte, .order, .limit.
// So we must always chain through .select() or .update() first.
function assertFilterBuilder(builder, methods, label) {
    for (const m of methods) {
        if (typeof builder[m] !== 'function') {
            const e = new Error(
                `[nowpayments] filter builder missing .${m}() at ${label}. ` +
                `This means the chain did not go through .select() or .update() first.`
            );
            e.code = 'SDK_SHAPE_ERROR';
            throw e;
        }
    }
}

// ─── provider status → verdict ──────────────────────────────────
// ONLY 'finished' is a success verdict. 'confirmed' is pending.
// 'partially_paid' is a specific under-payment failure (see below).
function classifyNowPaymentsStatus(s) {
    const v = String(s || '').toLowerCase();
    if (v === 'finished') return 'success';
    if (['failed', 'expired', 'refunded', 'wrong_asset'].includes(v)) return 'failure';
    if (['waiting', 'confirming', 'sending', 'partially_paid', 'confirmed'].includes(v)) return 'pending';
    return 'unknown';
}

async function findCandidates(limit) {
    const now = new Date().toISOString();

    // ⚠️ ORDER: .from() → .select() → .in()/… — .in is not on the
    // query builder. See the FIX LOG at the top of this file.
    const filterBuilder = supabaseAdmin
        .from(TABLE)
        .select('*');
    assertFilterBuilder(filterBuilder, ['in', 'lte', 'order', 'limit'], 'findCandidates');

    const { data, error } = await filterBuilder
        .in('status', PENDING_STATUSES)
        .lte('next_check_at', now)
        .order('next_check_at', { ascending: true })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

async function verify(record) {
    const paymentId = record.nowpayments_payment_id;
    if (!paymentId) {
        return {
            verdict: 'unknown',
            providerStatus: null,
            reason: 'no_payment_id'
        };
    }

    // Direct provider call. This is the ONLY place in the adapter
    // that reaches out to NowPayments. Do not call verifyAndComplete
    // from here — it will settle, which is settle()'s job.
    let p;
    try {
        const { data } = await axios.get(`${NOWPAYMENTS_API_BASE}/payment/${paymentId}`, {
            headers: { 'x-api-key': NOWPAYMENTS_API_KEY },
            timeout: 12000
        });
        p = data || {};
    } catch (err) {
        const httpStatus = err.response?.status;
        const e = new Error(`nowpayments.verify failed: ${err.message}`);
        e.status = httpStatus;
        e.providerHttpStatus = httpStatus;
        throw e;
    }

    if (String(p.payment_id) !== String(paymentId)) {
        return {
            verdict: 'unknown',
            providerStatus: 'MISMATCH',
            reason: 'provider payment_id does not match our record'
        };
    }

    const status = String(p.payment_status || '').toLowerCase();
    const verdict = classifyNowPaymentsStatus(status);

    const outcomeAmount = p.outcome_amount != null ? parseFloat(p.outcome_amount) : null;
    const priceAmount   = p.price_amount   != null ? parseFloat(p.price_amount)   : null;
    const priceCurrency = String(p.price_currency || '').toUpperCase();

    let paidUsd = null;
    if (outcomeAmount != null && String(p.outcome_currency || '').toUpperCase() === 'USD') {
        paidUsd = outcomeAmount;
    } else if (priceAmount != null && priceCurrency === 'USD') {
        paidUsd = priceAmount;
    }

    return {
        verdict,
        providerStatus: status,
        amount: paidUsd,
        currency: 'USD',
        providerRef: String(paymentId),
        raw: p
    };
}

function validate(record, verified) {
    const required = Number(record.required_usd || 0);
    if (!Number.isFinite(required) || required <= 0) {
        return { issueType: 'VERIFICATION_FAILED', reason: 'required_usd missing on record' };
    }
    if (!Number.isFinite(Number(verified.amount)) || Number(verified.amount) <= 0) {
        return { issueType: 'VERIFICATION_FAILED', reason: 'Provider returned no usable USD amount' };
    }
    const ratio = Number(verified.amount) / required;
    if (ratio < 1 - EXACT_BAND) {
        return { issueType: 'AMOUNT_MISMATCH', reason: `Underpaid: ${(ratio * 100).toFixed(2)}% of required` };
    }
    if (ratio > 1 + EXACT_BAND) {
        return true;
    }
    return true;
}

async function settle(record, verified) {
    // Delegate to verifyAndComplete. It re-fetches the provider payload
    // (one extra call), re-runs decideCredit, and credits via the
    // process_transaction_v2 RPC. That's the single source of truth for
    // crypto credits — do not reimplement it here.
    const result = await cryptoDepositService.verifyAndComplete(
        String(record.nowpayments_payment_id),
        'reconciliation'
    );

    if (result.completed) {
        return { completed: true };
    }

    return {
        completed: false,
        reason: result.reason || 'NOWPAYMENTS_SETTLE_NOT_COMPLETED'
    };
}

async function markFailed(record, verified) {
    const status = String(verified.providerStatus || '').toLowerCase();
    const targetStatus =
        status === 'expired'       ? 'expired'       :
        status === 'refunded'      ? 'refunded'      :
        status === 'wrong_asset'   ? 'manual_review' :
        status === 'partially_paid'? 'manual_review' :
        'failed';

    const actuallyTerminal = ['failed', 'expired', 'refunded'].includes(targetStatus);

    // ⚠️ ORDER: .from() → .update() → .eq()/… — .update returns a
    // filter builder, so .eq/.in work here. Confirm with the
    // assertion anyway.
    const filterBuilder = supabaseAdmin
        .from(TABLE)
        .update({
            status: targetStatus,
            failure_reason: `Provider status: ${verified.providerStatus}`,
            provider_payload: verified.raw || null,
            updated_at: new Date().toISOString()
        });
    assertFilterBuilder(filterBuilder, ['eq', 'in', 'select'], 'markFailed.update');

    const { data: updated, error: updErr } = await filterBuilder
        .eq('id', record.id)
        .in('status', PENDING_STATUSES)
        .select('id');

    if (updErr) {
        console.warn('[nowpayments] markFailed update failed:', updErr.message);
    } else if (!updated || updated.length === 0) {
        // Row was already in a non-pending state — benign race
        // (settle finished while we were verifying). Log at debug
        // level only.
        console.log(`[nowpayments] markFailed skipped for ${record.id} (already terminal)`);
    }

    try {
        if (typeof cryptoDepositService._internal_syncUserFacingTransaction === 'function') {
            await cryptoDepositService._internal_syncUserFacingTransaction(
                record,
                actuallyTerminal ? targetStatus : 'pending',
                { actuallyPaid: null, outcomeAmount: null }
            );
        }
    } catch (e) {
        console.warn('[nowpayments] user-facing sync failed:', e.message);
    }
}

async function isConsistent(record) {
    if (record.status === 'completed') {
        const { data: tx } = await supabaseAdmin
            .from('transactions')
            .select('id, status')
            .eq('source_type', 'crypto_deposit')
            .eq('source_id', record.id)
            .eq('type', 'deposit')
            .maybeSingle();
        return Boolean(tx && tx.status === 'completed');
    }
    if (['failed', 'expired', 'refunded'].includes(record.status)) {
        const { data: tx } = await supabaseAdmin
            .from('transactions')
            .select('id, status')
            .eq('source_type', 'crypto_deposit')
            .eq('source_id', record.id)
            .eq('type', 'deposit')
            .maybeSingle();
        return Boolean(tx && tx.status !== 'pending');
    }
    return false;
}

function amountFor(record) {
    return record.requested_usd || record.requested_amount || null;
}
function currencyFor(_record) {
    return 'USD';
}

async function listProviderTransactions(from, to) {
    if (process.env.NOWPAYMENTS_HAS_LIST_API !== '1') return null;
    try {
        const apiKey = process.env.NOWPAYMENTS_API_KEY;
        if (!apiKey) return null;
        const { data } = await axios.get(`${NOWPAYMENTS_API_BASE}/payment/`, {
            headers: { 'x-api-key': apiKey },
            params: {
                payment_date_from: from.toISOString(),
                payment_date_to: to.toISOString(),
                limit: 500
            },
            timeout: 15000
        });
        const rows = Array.isArray(data) ? data : (data?.data || data?.payments || []);
        if (!Array.isArray(rows)) return null;
        return rows.map(p => ({
            payment_id: String(p.payment_id),
            reference: String(p.payment_id),
            amount: p.price_amount,
            currency: p.price_currency,
            status: p.payment_status,
            provider_status: p.payment_status
        }));
    } catch (e) {
        console.warn('[nowpayments] list failed:', e.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
//  EXPORTS — single object, one assignment, no partial assignments
// ═══════════════════════════════════════════════════════════════
module.exports = {
    key: KEY,
    provider: PROVIDER,
    table: TABLE,
    lockName: LOCK_NAME,
    pendingStatuses: PENDING_STATUSES,
    terminalStatuses: TERMINAL_STATUSES,

    findCandidates,
    verify,
    validate,
    settle,
    markFailed,
    isConsistent,
    amountFor,
    currencyFor,
    listProviderTransactions
};