// reconciliation/adapters/kora.js
// ─────────────────────────────────────────────────────────────────
// KoraPay fiat deposits adapter.
//
// Settle path: delegates to depositService.completeKoraDeposit(),
// which already has the full pipeline:
//   • HMAC digest verification (_isTrustedVerified)
//   • claim_kora_deposit_for_credit RPC (compare-and-swap)
//   • amount + currency drift check (EXACT_BAND)
//   • process_transaction_v2 (ledger credit)
//   • finalize_kora_deposit
//
// The adapter's only job is to (a) fetch provider status, (b) build
// the trusted-verified envelope, (c) hand off. It must NEVER credit
// the wallet itself — that is depositService's contract.
//
// ⚠️ MONEY-MOVE SURFACE — every credit goes through completeKoraDeposit.
// Do not add a code path that credits without going through it.
// ─────────────────────────────────────────────────────────────────
'use strict';

const { supabaseAdmin } = require('../../db/supabase');
const korapayService    = require('../../services/korapayService');
const depositService    = require('../../services/depositService');

const KEY       = 'kora';
const PROVIDER  = 'korapay';
const TABLE     = 'deposit_requests';
const LOCK_NAME = `recon:${KEY}:${TABLE}`;

const PENDING_STATUSES = ['pending', 'processing', 'processing_credit'];
const RESCAN_STATUSES  = ['failed', 'expired'];   // for late success
const TERMINAL_STATUSES = ['completed', 'failed', 'expired', 'cancelled'];

// How far back to rescan failed/expired deposits for a late success.
// Kora occasionally confirms late; if we gave up too early the user
// is under-credited. 72h is generous but bounded.
const RESCAN_WINDOW_HOURS = 72;
const RESCAN_MIN_AGE_MS   = 5 * 60 * 1000;

// Kora provider statuses → adapter verdict.
function classifyKoraStatus(s) {
    const v = String(s || '').toLowerCase();
    if (['success', 'successful', 'completed', 'confirmed', 'finished'].includes(v)) return 'success';
    if (['failed', 'expired', 'cancelled', 'canceled', 'rejected', 'declined'].includes(v)) return 'failure';
    if (['pending', 'processing', 'initiated', 'created', 'in_progress', 'awaiting_payment'].includes(v)) return 'pending';
    // `reversed` handled separately — it is not "failure", see
    // markFailed() comment. It's a post-credit event.
    if (v === 'reversed') return 'reversed';
    return 'unknown';
}

// ─── findCandidates ──────────────────────────────────────────────
// Two queries:
//   1. Pending/processing rows with next_check_at <= now()
//   2. Failed/expired rows within the rescan window that are NOT
//      already flagged as terminal-and-consistent (see markFailed)
async function findCandidates(limit) {
    const now = new Date().toISOString();

    const { data: pending, error: pErr } = await supabaseAdmin
        .from(TABLE)
        .select('*')
        .eq('provider', PROVIDER)
        .in('status', PENDING_STATUSES)
        .lte('next_check_at', now)
        .order('next_check_at', { ascending: true })
        .limit(limit);

    if (pErr) throw pErr;

    // Rescan for late success.
    const rescanCutoff = new Date(Date.now() - RESCAN_MIN_AGE_MS).toISOString();
    const windowStart = new Date(Date.now() - RESCAN_WINDOW_HOURS * 3600 * 1000).toISOString();

    const { data: rescan, error: rErr } = await supabaseAdmin
        .from(TABLE)
        .select('*')
        .eq('provider', PROVIDER)
        .in('status', RESCAN_STATUSES)
        .not('provider_reference', 'is', null)
        .lt('created_at', rescanCutoff)
        .gt('created_at', windowStart)
        .lte('next_check_at', now)
        .order('next_check_at', { ascending: true })
        .limit(Math.max(1, Math.floor(limit / 4))); // 25% of batch

    if (rErr) throw rErr;

    return [...(pending || []), ...(rescan || [])];
}

// ─── verify ──────────────────────────────────────────────────────
// Throws on HTTP errors (including 429). Returns a verdict object.
async function verify(record) {
    const ref = record.provider_reference || record.merchant_reference;
    if (!ref) {
        return {
            verdict: 'unknown',
            providerStatus: null,
            reason: 'no_provider_reference'
        };
    }

    const v = await korapayService.verifyTransaction(ref);
    const status = String(v.provider_status || '').toLowerCase();
    const verdict = classifyKoraStatus(status);

    if (verdict === 'reversed') {
        // Not a failure of the deposit — a post-credit reversal. The
        // engine will raise PROVIDER_FAILURE_NOT_REFUNDED for this
        // case. The adapter does not "settle" it.
        return {
            verdict: 'reversed',
            providerStatus: status,
            amount: v.amount,
            currency: v.currency,
            providerRef: v.reference || v.payment_reference || ref
        };
    }

    return {
        verdict: verdict === 'reversed' ? 'unknown' : verdict,
        providerStatus: status,
        amount: v.amount,
        currency: v.currency,
        providerRef: v.reference || v.payment_reference || ref,
        raw: v.raw
    };
}

// ─── validate ────────────────────────────────────────────────────
// The engine calls this BEFORE settle(). If it returns something
// other than true, settle() is not called.
//
// But depositService.completeKoraDeposit re-validates amount/currency
// internally — we trust it. The only thing the adapter checks is
// that we have a currency and amount at all (so it doesn't trip
// completeKoraDeposit's "MISSING_PROVIDER_CURRENCY" for a null
// provider response, which would be confusing as an AMOUNT_MISMATCH).
function validate(record, verified) {
    if (!verified.currency) {
        return { issueType: 'VERIFICATION_FAILED', reason: 'Provider returned no currency' };
    }
    if (!Number.isFinite(Number(verified.amount)) || Number(verified.amount) <= 0) {
        return { issueType: 'VERIFICATION_FAILED', reason: 'Provider returned invalid amount' };
    }
    return true;
}

// ─── settle ──────────────────────────────────────────────────────
// Delegates to depositService.completeKoraDeposit.
//
// ⚠️ MUST build the digest with computeVerifiedDigest so that
// completeKoraDeposit's _isTrustedVerified short-circuits and does
// not re-query the provider. If the digest is wrong, completeKoraDeposit
// re-verifies (defense in depth) but the amount we passed may differ
// from what it re-verifies to. Building the digest from the SAME
// verified object that this adapter received is the only safe path.
async function settle(record, verified) {
    const digest = depositService.computeVerifiedDigest({
        provider_status: verified.providerStatus,
        amount:          verified.amount,
        currency:        verified.currency,
        reference:       verified.providerRef
    });

    if (!digest) {
        // KORA_WEBHOOK_SECRET / KORA_SECRET_KEY missing. Do not proceed
        // without an HMAC — completeKoraDeposit would re-verify, but
        // we don't want to hit the provider twice for the same sweep.
        return { completed: false, reason: 'DIGEST_UNAVAILABLE' };
    }

    const result = await depositService.completeKoraDeposit({
        depositId: record.id,
        providerTransaction: {
            provider_status: verified.providerStatus,
            amount:          verified.amount,
            currency:        verified.currency,
            reference:       verified.providerRef,
            _trustedVerified: true,
            _verifiedDigest:  digest
        },
        source: 'reconciliation'
    });

    if (result.completed) {
        return { completed: true };
    }

    // Map depositService's reasons to what the engine expects.
    // 'AMBIGUOUS_REFERENCE' and 'PAYMENT_CURRENCY_MISMATCH' are
    // AMOUNT_MISMATCH-adjacent but not the same. Let the engine's
    // settle-failure branch raise PROVIDER_SUCCESS_INTERNAL_INCOMPLETE
    // for anything that reaches here with completed !== true — that's
    // the right issue type for "provider says success but internal
    // did not complete".
    return {
        completed: false,
        reason: result.reason || 'KORA_SETTLE_NOT_COMPLETED'
    };
}

// ─── settleFailure (deposits: mark failed, never refund) ─────────
// For a Kora deposit, "failure" means the provider says the payment
// did not succeed. There is nothing to refund — the wallet was never
// credited. We mark the record failed (or expired if provider said
// expired) and the transaction mirror.
async function markFailed(record, verified) {
    const targetStatus = verified.providerStatus === 'expired' ? 'expired' : 'failed';

    await supabaseAdmin
        .from(TABLE)
        .update({
            status: targetStatus,
            failed_at: new Date().toISOString(),
            failure_reason: `Provider status: ${verified.providerStatus}`,
            updated_at: new Date().toISOString()
        })
        .eq('id', record.id)
        .in('status', PENDING_STATUSES);

    await depositService.finalizeTransactionNonSuccess(
        record,
        { status: targetStatus, reason: `Provider status: ${verified.providerStatus}` }
    );
}

// ─── isConsistent ────────────────────────────────────────────────
// True if the deposit record's status is terminal AND the ledger
// actually reflects it. The auto-close pass uses this to close an
// open issue after a webhook settled the deposit.
async function isConsistent(record) {
    if (!TERMINAL_STATUSES.includes(record.status)) return false;

    if (record.status === 'completed') {
        // Verify the ledger credit exists.
        const { data: tx } = await supabaseAdmin
            .from('transactions')
            .select('id, status')
            .eq('source_type', 'kora_deposit')
            .eq('source_id', record.id)
            .eq('type', 'deposit')
            .maybeSingle();
        return Boolean(tx && tx.status === 'completed');
    }

    if (record.status === 'failed' || record.status === 'expired' || record.status === 'cancelled') {
        // A terminal failure is consistent — there was nothing to
        // credit. The transaction mirror should be non-pending.
        const { data: tx } = await supabaseAdmin
            .from('transactions')
            .select('id, status')
            .eq('source_type', 'kora_deposit')
            .eq('source_id', record.id)
            .eq('type', 'deposit')
            .maybeSingle();
        return Boolean(tx && tx.status !== 'pending');
    }
    return false;
}

// ─── amountFor (used by engine's pickAmount fallback) ────────────
function amountFor(record) {
    return record.wallet_amount || record.target_amount || record.expected_target_amount || null;
}
function currencyFor(record) {
    return record.wallet_currency || record.target_currency || 'NGN';
}
// ─── listProviderTransactions ─────────────────────────────────
// Kora does NOT expose a public "list all charges for a day" API in
// the merchant API version this deployment uses. Rather than invent
// a call, we look for a manual CSV drop at:
//     data/kora-recon/{YYYY-MM-DD}.csv
// with columns: reference,amount,currency,status
// If the file exists, we parse it. If not, we return null and the
// audit records "provider_list_unavailable".
async function listProviderTransactions(from, to) {
    const fs = require('fs');
    const path = require('path');
    const day = from.toISOString().slice(0, 10);
    const filePath = path.join(__dirname, '..', '..', 'data', 'kora-recon', `${day}.csv`);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const header = lines[0].split(',').map(s => s.trim().toLowerCase());
    const refIdx = header.indexOf('reference');
    const amtIdx = header.indexOf('amount');
    const ccyIdx = header.indexOf('currency');
    const stIdx = header.indexOf('status');
    if (refIdx < 0 || amtIdx < 0 || stIdx < 0) {
        throw new Error('kora recon CSV is missing required columns');
    }
    return lines.slice(1).map(line => {
        const parts = line.split(',');
        return {
            reference: parts[refIdx],
            amount: parts[amtIdx],
            currency: (ccyIdx >= 0 ? parts[ccyIdx] : 'NGN').toUpperCase(),
            status: parts[stIdx],
            provider_status: parts[stIdx]
        };
    });
}

module.exports.listProviderTransactions = listProviderTransactions;

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
    currencyFor
};