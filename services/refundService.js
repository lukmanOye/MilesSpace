'use strict';

// services/refundService.js
// ─────────────────────────────────────────────────────────────────
// REVISION 2026-11-03 (V2 - Production)
//
// THE CENTRAL REFUND AUTHORITY. Every refund path — auto (bills,
// airtime, boost, gift cards, eSIM, virtual SMS) and admin — goes
// through this file.
//
// Guarantees:
//   • Approval flow is split:
//       createRefundRequest() → applies policy, inserts row (REQUESTED/PENDING_APPROVAL/PROCESSING)
//       executeRefund() → atomically claims row (APPROVED->PROCESSING), moves ledger, finalizes.
//     Approving a refund never triggers a new request, it only claims and
//     executes the existing row.
//   • Deterministic ledger reference per refund row:
//     `REFUND-{originalId}-{refundId}` or `REVERSAL-{originalId}-{refundId}`.
//     Ledger idempotency key is `refund:{refundId}`.
//   • Timeout recovery: if the ledger call throws, look up the ledger tx
//     by its deterministic reference. If it exists, finalize as COMPLETED.
//     Only mark FAILED if it truly does not exist.
//   • Active refund statuses (blocking new partials) = REQUESTED,
//     PENDING_APPROVAL, APPROVED, PROCESSING.
//     COMPLETED does NOT block new partial refunds.
//   • Remaining refundable = original - SUM(COMPLETED).
//   • Reversal guard: A reversal cannot drive a user's balance below zero.
//     Checked at creation time AND at execution time.
//   • Auto refunds dedupe via refunds table AND `metadata.refunded_transaction_id`.
// ─────────────────────────────────────────────────────────────────

const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const IdempotencyService = require('./idempotencyService');
const txTypes = require('./transactionTypes');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Threshold + cap ────────────────────────────────────────────
const MAX_REFUND_AMOUNT = 10_000_000;
const MIN_REASON_LENGTH = 4;
const MAX_REASON_LENGTH = 500;

// ─── Provider refund adapters (HARDCODED) ───────────────────────
// A provider that supports refunds must be added here with a lazy
// loader. `tx.provider` is only ever used as a KEY into this map.
// A value not in the map returns PROVIDER_REFUND_NOT_IMPLEMENTED.
const PROVIDER_REFUND_ADAPTERS = Object.freeze({
    // korapay:     () => require('../providers/korapay/refundAdapter'),
    // nowpayments: () => require('../providers/nowpayments/refundAdapter')
});

// ─── Active refund statuses ─────────────────────────────────────
// Only these block a new refund. COMPLETED is terminal.
const ACTIVE_REFUND_STATUSES = Object.freeze([
    'REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING'
]);

// ─── Column allowlists ──────────────────────────────────────────
const TX_COLUMNS = [
    'id', 'user_id', 'type', 'status', 'currency', 'amount', 'description',
    'reference', 'provider', 'provider_reference', 'source_type', 'source_id',
    'metadata', 'completed_at'
].join(', ');

// Ensure this list reflects the actual DB schema, including new columns
const REFUND_COLUMNS = [
    'id', 'original_transaction_id', 'refund_transaction_id', 'user_id',
    'refund_type', 'refund_method', 'amount', 'currency', 'reason', 'status',
    'provider', 'provider_refund_ref', 'requested_by', 'requester_email',
    'approved_by', 'approved_at', 'failure_reason', 'rejection_reason',
    'idempotency_key', 'request_fingerprint',
    'approvals_required', 'expires_at', 'risk_flags',
    'created_at', 'updated_at', 'completed_at', 'failed_at', 'processing_at'
].join(', ');

// ─── Reason labels for the capability response ──────────────────
const REASON_LABELS = Object.freeze({
    NOT_ELIGIBLE:                'This transaction is not eligible for a refund.',
    PENDING_REFUND_EXISTS:       'A refund is already in progress for this transaction.',
    ALREADY_REFUNDED:            'This transaction has already been fully refunded.',
    ALREADY_REVERSED:            'This deposit has already been reversed.',
    TYPE_NOT_REFUNDABLE:         'This transaction type cannot be refunded.',
    NO_PROVIDER_ON_RECORD:       'No provider is on record for this transaction.',
    PROVIDER_REFUND_NOT_IMPLEMENTED: 'Refunds through this provider are not supported.',
    TX_NOT_FOUND:                'Transaction not found.',
    USER_MISMATCH:               'Transaction does not belong to the specified customer.',
    INVALID_AMOUNT:              'The amount is invalid.',
    AMOUNT_TOO_LARGE:            'The amount exceeds the maximum allowed.',
    REASON_REQUIRED:             'A reason is required.',
    REASON_TOO_LONG:             'The reason is too long.',
    IDEMPOTENCY_KEY_REQUIRED:    'An Idempotency-Key header (min 8 characters) is required.',
    DEPOSIT_NOT_COMPLETED:       'A deposit can only be reversed after it settles.',
    LEDGER_REJECTED:             'The ledger rejected the operation.',
    REFUND_EXCEEDS_REMAINING:    'The amount exceeds the remaining refundable balance.',
    REFUND_EXCEEDS_ORIGINAL:     'The amount exceeds the original transaction amount.',
    RECONCILE_REQUIRED:          'The operation is in a reconcilable state. Contact engineering.',
    REFUND_ALREADY_IN_FLIGHT:    'A refund for this transaction is already in progress.',
    REFUND_APPROVAL_REQUIRED:    'This refund requires a second admin to approve.',
    REFUND_NOT_PENDING_APPROVAL: 'This refund is not awaiting approval.',
    SELF_APPROVAL_FORBIDDEN:     'The requester cannot approve their own refund.',
    SELF_REJECTION_FORBIDDEN:    'The requester cannot reject their own refund.',
    APPROVE_FAILED:              'Failed to approve the refund.',
    REJECT_FAILED:               'Failed to reject the refund.',
    INVALID_STATE:               'The refund is in an invalid state for this action.',
    ALREADY_DECIDED:             'You have already decided on this refund.',
    APPROVAL_LIMIT_EXCEEDED:     'Your role limit does not allow you to approve this amount.',
    REFUND_EXPIRED:              'This refund request has expired.',
    REVERSAL_INSUFFICIENT_BALANCE: 'Insufficient balance for this reversal.'
});

function reasonLabel(code) {
    return REASON_LABELS[code] || 'Refund not available.';
}

// ─── Errors ─────────────────────────────────────────────────────
function svcErr(code, message, status = 400, extra = {}) {
    const e = new Error(message || reasonLabel(code));
    e.code = code;
    e.status = status;
    Object.assign(e, extra);
    return e;
}

// ─── Shared helpers ─────────────────────────────────────────────
function toNumber(v) {
    if (v === null || v === undefined) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function absoluteAmount(v) {
    return Math.abs(toNumber(v));
}

function round2(n) {
    return Math.round(Number(n) * 100) / 100;
}

function parseAmount(raw) {
    if (raw === null || raw === undefined || raw === '') {
        throw svcErr('INVALID_AMOUNT', 'Refund amount is required.', 422);
    }
    const s = String(raw).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s)) {
        throw svcErr('INVALID_AMOUNT', 'Amount must be a number with at most 2 decimal places.', 422);
    }
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) {
        throw svcErr('INVALID_AMOUNT', 'Amount must be positive.', 422);
    }
    if (n > MAX_REFUND_AMOUNT) {
        throw svcErr('AMOUNT_TOO_LARGE', `Amount must be at most ${MAX_REFUND_AMOUNT.toLocaleString('en-US')}.`, 422);
    }
    return round2(n);
}

function requireReason(raw) {
    const s = String(raw || '').trim();
    if (s.length < MIN_REASON_LENGTH) {
        throw svcErr('REASON_REQUIRED', `A reason of at least ${MIN_REASON_LENGTH} characters is required.`, 422);
    }
    if (s.length > MAX_REASON_LENGTH) {
        throw svcErr('REASON_TOO_LONG', `A reason of at most ${MAX_REASON_LENGTH} characters is required.`, 422);
    }
    return s;
}

function requireIdempotencyKey(raw) {
    if (!raw || typeof raw !== 'string') {
        throw svcErr('IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header (min 8 characters) is required.', 422);
    }
    const s = raw.trim();
    if (s.length < 8 || s.length > 200) {
        throw svcErr('IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header (8-200 characters) is required.', 422);
    }
    return s;
}

function fingerprint({ transactionId, amount, reason, refundType }) {
    const payload = JSON.stringify({
        t: transactionId, a: String(amount), r: reason, k: refundType
    });
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Audit a refund action. Non-fatal but logged on failure — the
 * money path must not fail because audit failed.
 */
async function auditRefund({ ctx, action, refundId, transactionId, before, after, reason }) {
    try {
        const { error } = await supabaseAdmin.from('admin_audit_logs').insert({
            admin_id: ctx.adminId || null,
            admin_email: ctx.adminEmail || null,
            action,
            target_type: 'refund',
            target_id: refundId || transactionId,
            before: before || null,
            after: after || null,
            reason: reason ? String(reason).slice(0, MAX_REASON_LENGTH) : null,
            ip_address: ctx.ip || null,
            user_agent: ctx.userAgent || null,
            request_id: ctx.requestId || null,
            created_at: new Date().toISOString()
        });
        if (error) {
            console.error('[REFUND AUDIT] insert failed', { action, refundId, error: error.message });
        }
    } catch (e) {
        console.error('[REFUND AUDIT] exception', { action, refundId, error: e.message });
    }
}

// ─── Capability (READ) ──────────────────────────────────────────

async function getRefundCapability(transactionId) {
    if (!UUID_RE.test(String(transactionId || ''))) {
        throw svcErr('TX_NOT_FOUND', 'Invalid transaction id.', 400);
    }

    const { data: tx, error } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, type, status, currency, amount, provider, provider_reference, metadata, completed_at')
        .eq('id', transactionId)
        .maybeSingle();

    if (error) throw svcErr('TX_NOT_FOUND', 'Failed to load transaction.', 500);
    if (!tx) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    const type = String(tx.type || '').toLowerCase();
    const status = String(tx.status || '').toLowerCase();
    const originalAmount = absoluteAmount(tx.amount);
    const currency = String(tx.currency || '').toUpperCase();
    const txTypeMeta = txTypes.getType(type);

    // Fetch all refunds to compute active/completed.
    const { data: refunds, error: rErr } = await supabaseAdmin
        .from('refunds')
        .select('id, status, amount')
        .eq('original_transaction_id', tx.id)
        .in('status', ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'COMPLETED']);

    if (rErr) throw svcErr('TX_NOT_FOUND', 'Failed to check active refunds.', 500);

    const activeRefund = (refunds || []).find(r => ACTIVE_REFUND_STATUSES.includes(r.status));
    const completedAmount = (refunds || [])
        .filter(r => r.status === 'COMPLETED')
        .reduce((sum, r) => sum + absoluteAmount(r.amount), 0);

    const remaining = Math.max(0, originalAmount - completedAmount);

    const base = {
        eligible: false,
        methods: [],
        max_amount: '0.00',
        currency,
        original_amount: originalAmount.toFixed(2),
        already_refunded: completedAmount > 0,
        already_refunded_amount: completedAmount.toFixed(2),
        remaining_amount: remaining.toFixed(2),
        pending_refund_id: activeRefund ? activeRefund.id : null,
        pending_refund_status: activeRefund ? activeRefund.status : null,
        requires_step_up: true,
        requires_approval: false,
        reason: null,
        reason_label: null
    };

    if (activeRefund) {
        return { ...base, reason: 'PENDING_REFUND_EXISTS', reason_label: reasonLabel('PENDING_REFUND_EXISTS') };
    }
    if (remaining <= 0) {
        return { ...base, reason: 'ALREADY_REFUNDED', reason_label: reasonLabel('ALREADY_REFUNDED') };
    }
    if (status === 'reversed') {
        return { ...base, reason: 'ALREADY_REVERSED', reason_label: reasonLabel('ALREADY_REVERSED') };
    }
    if (!txTypeMeta) {
        return { ...base, reason: 'TYPE_NOT_REFUNDABLE', reason_label: reasonLabel('TYPE_NOT_REFUNDABLE') };
    }

    if (txTypes.isRefundable(type, 'wallet')) {
        return { ...base, eligible: true, methods: ['wallet'], max_amount: remaining.toFixed(2) };
    }

    if (txTypes.isRefundable(type, 'provider')) {
        if (!tx.provider) {
            return { ...base, reason: 'NO_PROVIDER_ON_RECORD', reason_label: reasonLabel('NO_PROVIDER_ON_RECORD') };
        }
        if (!PROVIDER_REFUND_ADAPTERS[String(tx.provider).toLowerCase()]) {
            return { ...base, reason: 'PROVIDER_REFUND_NOT_IMPLEMENTED', reason_label: reasonLabel('PROVIDER_REFUND_NOT_IMPLEMENTED') };
        }
        return { ...base, eligible: true, methods: ['provider'], max_amount: remaining.toFixed(2), requires_approval: true };
    }

    if (txTypes.isRefundable(type, 'reversal')) {
        if (status !== 'completed' && status !== 'success') {
            return { ...base, reason: 'DEPOSIT_NOT_COMPLETED', reason_label: reasonLabel('DEPOSIT_NOT_COMPLETED') };
        }
        return { ...base, eligible: true, methods: ['reversal'], max_amount: remaining.toFixed(2), requires_approval: true };
    }

    return { ...base, reason: 'TYPE_NOT_REFUNDABLE', reason_label: reasonLabel('TYPE_NOT_REFUNDABLE') };
}

// ─── CREATE ─────────────────────────────────────────────────────

async function createRefundRequest({ transactionId, amount, reason, refundType, ctx, idempotencyKey }) {
    if (!UUID_RE.test(String(transactionId || ''))) {
        throw svcErr('TX_NOT_FOUND', 'Invalid transaction id.', 400);
    }
    const amt = parseAmount(amount);
    const trimmedReason = requireReason(reason);
    const idem = requireIdempotencyKey(idempotencyKey);

    const { data: tx, error: txErr } = await supabaseAdmin
        .from('transactions')
        .select(TX_COLUMNS)
        .eq('id', transactionId)
        .maybeSingle();
        
    if (txErr) throw svcErr('TX_NOT_FOUND', 'Failed to load transaction.', 500);
    if (!tx) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    const type = String(tx.type || '').toLowerCase();
    const txTypeMeta = txTypes.getType(type);
    if (!txTypeMeta || !txTypes.isRefundable(type, refundType)) {
        throw svcErr('TYPE_NOT_REFUNDABLE', `Transaction type "${tx.type}" cannot be refunded this way.`, 422);
    }

    if (refundType === 'reversal') {
        const st = String(tx.status || '').toLowerCase();
        if (st !== 'completed' && st !== 'success') {
            throw svcErr('DEPOSIT_NOT_COMPLETED', 'Only settled deposits can be reversed.', 422);
        }
    }

    const originalAmount = absoluteAmount(tx.amount);
    if (amt > originalAmount) {
        throw svcErr('REFUND_EXCEEDS_ORIGINAL', `Amount exceeds original amount (${originalAmount.toFixed(2)}).`, 422);
    }

    const requestFingerprint = fingerprint({ transactionId, amount: amt, reason: trimmedReason, refundType });

    const { data, error } = await supabaseAdmin.rpc('create_refund_request_atomic', {
        p_original_tx_id: tx.id,
        p_user_id: tx.user_id,
        p_amount: amt,
        p_currency: tx.currency,
        p_reason: trimmedReason,
        p_refund_type: refundType,
        p_requested_by: ctx.adminId,
        p_admin_email: ctx.adminEmail,
        p_idempotency_key: idem,
        p_metadata: { request_id: ctx.requestId, fingerprint: requestFingerprint }
    });

    if (error) throw svcErr('REFUND_CREATE_FAILED', 'Failed to create refund request.', 500);
    if (!data.ok) throw svcErr(data.error, reasonLabel(data.error), 400);

    const refundId = data.refund.id;
    const status = data.refund.status;

    // If it's low-value and auto-approved (goes straight to PROCESSING), execute immediately.
    if (status === 'PROCESSING') {
        return executeRefund(refundId, ctx);
    }

    return {
        refund: data.refund,
        message: status === 'PENDING_APPROVAL' ? 'Refund created and pending approval.' : 'Refund processing.'
    };
}

// ─── EXECUTE ────────────────────────────────────────────────────

async function executeRefund(refundId, ctx) {
    if (!UUID_RE.test(String(refundId || ''))) {
        throw svcErr('TX_NOT_FOUND', 'Invalid refund id.', 400);
    }

    // 1. Atomically claim the row (APPROVED -> PROCESSING)
    const { data: claimData, error: claimErr } = await supabaseAdmin.rpc('claim_refund_for_execution', {
        p_refund_id: refundId
    });

    if (claimErr) throw svcErr('REFUND_UPDATE_FAILED', 'Failed to claim refund for execution.', 500);
    if (!claimData.ok) {
        // Someone else claimed it, or it's already done. Return current state.
        const refund = await getRefund(refundId);
        return { refund, executed: false, reason: 'Already processing or completed.' };
    }

    const refund = claimData.refund;

    // 2. Load original tx for metadata & balance checks
    const { data: tx, error: txErr } = await supabaseAdmin
        .from('transactions')
        .select(TX_COLUMNS)
        .eq('id', refund.original_transaction_id)
        .maybeSingle();
        
    if (txErr || !tx) {
        await failRefund(refundId, ctx, tx?.id, refund.refund_type, 'Original transaction not found');
        throw svcErr('TX_NOT_FOUND', 'Original transaction not found.', 404);
    }

    // 3. Execution re-validation (especially for reversals)
    if (refund.refund_type === 'reversal') {
        const { data: acct } = await supabaseAdmin
            .from('ledger_accounts')
            .select('available_balance')
            .eq('user_id', tx.user_id)
            .eq('currency', tx.currency)
            .maybeSingle();
        
        if (toNumber(acct?.available_balance) < Number(refund.amount)) {
            const shortfall = Number(refund.amount) - toNumber(acct?.available_balance);
            
            // Revert to PENDING_APPROVAL with a risk flag so it's auditable, not FAILED
            await supabaseAdmin.from('refunds').update({
                status: 'PENDING_APPROVAL',
                risk_flags: { ...refund.risk_flags, reversal_insufficient_balance: true, shortfall }
            }).eq('id', refundId);
            
            await auditRefund({
                ctx, action: 'refund.reversal_failed_balance', refundId, transactionId: tx.id,
                after: { status: 'PENDING_APPROVAL', shortfall },
                reason: 'Reversal blocked: insufficient balance at execution time.'
            });
            
            throw svcErr('REVERSAL_INSUFFICIENT_BALANCE', `User has insufficient balance (shortfall ${shortfall}).`, 422);
        }
    }

    // 4. Ledger Move
    const ledgerRef = `${refund.refund_type === 'reversal' ? 'REVERSAL' : 'REFUND'}-${tx.id}-${refundId}`;
    let ledgerResult = null;
    let ledgerError = null;

    try {
        const params = {
            userId: tx.user_id,
            amount: Number(refund.amount),
            currency: refund.currency,
            description: `${refund.refund_type} refund: ${refund.reason}`,
            reference: ledgerRef,
            sourceType: refund.refund_type,
            sourceId: tx.id,
            type: refund.refund_type === 'reversal' ? 'reversal' : 'refund',
            idempotencyKey: `refund:${refundId}`,
            metadata: {
                original_transaction_id: tx.id,
                refund_record_id: refundId,
                admin_id: ctx.adminId || null
            }
        };
        
        if (refund.refund_type === 'reversal') {
            ledgerResult = await LedgerService.debitWallet(params);
        } else {
            ledgerResult = await LedgerService.creditWallet(params);
        }
    } catch (e) {
        ledgerError = e;
    }

    // 5. Handle Ledger outcome (Timeout Recovery)
    if (ledgerError || !ledgerResult) {
        const existing = await LedgerService.findTransactionByReference(ledgerRef);
        if (existing) {
            // Ledger committed, but threw. Finalize.
            ledgerResult = { transaction_id: existing.id, reference: existing.reference };
        } else {
            // Ledger truly failed.
            await failRefund(refundId, ctx, tx.id, refund.refund_type, ledgerError?.message || 'Ledger rejected');
            throw svcErr('LEDGER_REJECTED', 'Refund rejected by ledger.', 400);
        }
    }

    // 6. Finalize
    await finalizeRefund(refundId, ledgerResult.transaction_id, ctx, tx.id, Number(refund.amount), refund.currency, refund.refund_type, refund.reason);

    return {
        refund: {
            ...refund,
            status: 'COMPLETED',
            refund_transaction_id: ledgerResult.transaction_id
        },
        executed: true
    };
}

async function finalizeRefund(refundId, ledgerTxId, ctx, transactionId, amount, currency, refundType, reason) {
    const { error } = await supabaseAdmin
        .from('refunds')
        .update({
            status: 'COMPLETED',
            refund_transaction_id: ledgerTxId,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('id', refundId);
        
    if (error) {
        throw svcErr('RECONCILE_REQUIRED', 'Ledger posted but refund finalization failed.', 500, { ledger_transaction_id: ledgerTxId });
    }

    await auditRefund({
        ctx, action: `refund.${refundType}.completed`, refundId, transactionId,
        before: { status: 'PROCESSING' }, after: { status: 'COMPLETED', amount, currency, ledger_tx_id: ledgerTxId }, reason
    });
}

async function failRefund(refundId, ctx, transactionId, refundType, errorMessage) {
    const { error } = await supabaseAdmin
        .from('refunds')
        .update({
            status: 'FAILED',
            failure_reason: String(errorMessage || 'Ledger rejected').slice(0, MAX_REASON_LENGTH),
            failed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('id', refundId);

    if (error) {
        console.error('[REFUND] fail-refund update failed', { refundId, transactionId, error: error.message });
    }
    
    await auditRefund({
        ctx, action: `refund.${refundType}.failed`, refundId, transactionId,
        before: { status: 'PROCESSING' }, after: { status: 'FAILED', failure_reason: errorMessage }, reason: errorMessage
    });
}

// ─── DECISION FLOW ──────────────────────────────────────────────

async function approveRefund({ refundId, ctx, reason, idempotencyKey }) {
    if (!UUID_RE.test(String(refundId || ''))) {
        throw svcErr('TX_NOT_FOUND', 'Invalid refund id.', 400);
    }
    const trimmedReason = requireReason(reason);
    const idem = requireIdempotencyKey(idempotencyKey);

    // Check idempotency cache
    const cached = await IdempotencyService.check(ctx.adminId, idem, 'admin.refunds.approve');
    if (cached && !cached.__in_flight) return cached;

    const { data, error } = await supabaseAdmin.rpc('decide_refund_atomic', {
        p_refund_id: refundId,
        p_admin_id: ctx.adminId,
        p_admin_email: ctx.adminEmail,
        p_admin_role: ctx.adminRole,
        p_decision: 'approve',
        p_reason: trimmedReason,
        p_request_id: ctx.requestId
    });

    if (error) throw svcErr('APPROVE_FAILED', 'Database error during approval.', 500);
    if (!data.ok) throw svcErr(data.error, reasonLabel(data.error), 400);

    let result = { ...data, executed: false };

    if (data.status === 'APPROVED') {
        // Trigger execution
        const execResult = await executeRefund(refundId, ctx);
        result.executed = true;
        result.refund = execResult.refund;
    }

    await IdempotencyService.save(ctx.adminId, idem, 'admin.refunds.approve', result).catch(() => {});
    return result;
}

async function rejectRefund({ refundId, ctx, reason }) {
    if (!UUID_RE.test(String(refundId || ''))) {
        throw svcErr('TX_NOT_FOUND', 'Invalid refund id.', 400);
    }
    const trimmedReason = requireReason(reason);

    const { data, error } = await supabaseAdmin.rpc('decide_refund_atomic', {
        p_refund_id: refundId,
        p_admin_id: ctx.adminId,
        p_admin_email: ctx.adminEmail,
        p_admin_role: ctx.adminRole,
        p_decision: 'reject',
        p_reason: trimmedReason,
        p_request_id: ctx.requestId
    });

    if (error) throw svcErr('REJECT_FAILED', 'Database error during rejection.', 500);
    if (!data.ok) throw svcErr(data.error, reasonLabel(data.error), 400);

    return { refund: { id: refundId, status: 'REJECTED' } };
}

async function cancelRefund({ refundId, ctx, reason }) {
    if (!UUID_RE.test(String(refundId || ''))) {
        throw svcErr('TX_NOT_FOUND', 'Invalid refund id.', 400);
    }
    const trimmedReason = requireReason(reason);
    
    const { data, error } = await supabaseAdmin.rpc('cancel_refund_atomic', {
        p_refund_id: refundId,
        p_admin_id: ctx.adminId,
        p_admin_email: ctx.adminEmail,
        p_admin_role: ctx.adminRole,
        p_reason: trimmedReason
    });

    if (error) throw svcErr('REFUND_UPDATE_FAILED', 'Failed to cancel refund.', 500);
    if (!data.ok) throw svcErr(data.error, reasonLabel(data.error), 400);

    return { cancelled: true };
}

// ─── PROVIDER REFUNDS ───────────────────────────────────────────

async function executeProviderRefund({ transactionId, amount, reason, ctx, idempotencyKey }) {
    if (!UUID_RE.test(String(transactionId || ''))) {
        throw svcErr('TX_NOT_FOUND', 'Invalid transaction id.', 400);
    }

    const { data: tx, error } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, type, provider, provider_reference, currency, amount')
        .eq('id', transactionId)
        .maybeSingle();
        
    if (error) throw svcErr('TX_NOT_FOUND', 'Failed to load transaction.', 500);
    if (!tx) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    const type = String(tx.type || '').toLowerCase();
    if (!txTypes.isRefundable(type, 'provider')) {
        throw svcErr('TYPE_NOT_REFUNDABLE', `Transaction type "${tx.type}" cannot be provider-refunded.`, 422);
    }
    if (!tx.provider) {
        throw svcErr('NO_PROVIDER_ON_RECORD', 'No provider on record for this transaction.', 422);
    }

    const providerKey = String(tx.provider).toLowerCase();
    const loader = PROVIDER_REFUND_ADAPTERS[providerKey];
    if (!loader) {
        throw svcErr('PROVIDER_REFUND_NOT_IMPLEMENTED', `Refunds through ${tx.provider} are not supported. Use wallet refund or a reversal instead.`, 422);
    }

    const amt = parseAmount(amount);
    const trimmedReason = requireReason(reason);
    const idem = requireIdempotencyKey(idempotencyKey);

    const originalAmount = absoluteAmount(tx.amount);
    if (amt > originalAmount) {
        throw svcErr('REFUND_EXCEEDS_ORIGINAL', `Amount exceeds original amount (${originalAmount.toFixed(2)}).`, 422);
    }

    // Insert PROCESSING row via RPC (handles active checks)
    const { data, error: rpcErr } = await supabaseAdmin.rpc('create_refund_request_atomic', {
        p_original_tx_id: tx.id,
        p_user_id: tx.user_id,
        p_amount: amt,
        p_currency: tx.currency,
        p_reason: trimmedReason,
        p_refund_type: 'provider',
        p_requested_by: ctx.adminId,
        p_admin_email: ctx.adminEmail,
        p_idempotency_key: idem,
        p_metadata: { request_id: ctx.requestId, fingerprint: fingerprint({ transactionId: tx.id, amount: amt, reason: trimmedReason, refundType: 'provider' }) }
    });

    if (rpcErr) throw svcErr('REFUND_CREATE_FAILED', 'Failed to create refund record.', 500);
    if (!data.ok) throw svcErr(data.error, reasonLabel(data.error), 400);

    const refundId = data.refund.id;
    const status = data.refund.status;

    if (status !== 'PROCESSING') {
        return { refund: data.refund }; // Pending approval or rejected
    }

    // Dispatch to provider
    let providerResult;
    try {
        const adapter = loader();
        if (!adapter || typeof adapter.initiateRefund !== 'function') {
            throw new Error('Adapter missing initiateRefund()');
        }
        providerResult = await adapter.initiateRefund({
            refundId,
            providerReference: tx.provider_reference,
            amount: amt,
            currency: tx.currency,
            reason: trimmedReason,
            userId: tx.user_id
        });
    } catch (e) {
        await supabaseAdmin
            .from('refunds')
            .update({
                status: 'FAILED',
                failure_reason: String(e.message || 'Provider dispatch failed').slice(0, MAX_REASON_LENGTH),
                failed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', refundId);
            
        await auditRefund({
            ctx, action: 'refund.provider.dispatch_failed', refundId, transactionId: tx.id,
            before: { status: 'PROCESSING' }, after: { status: 'FAILED', error: String(e.message || '').slice(0, 200) }, reason: trimmedReason
        });
        throw svcErr('PROVIDER_REFUND_DISPATCH_FAILED', 'Provider refund dispatch failed. No wallet change occurred.', 502);
    }

    await supabaseAdmin
        .from('refunds')
        .update({ provider_refund_ref: providerResult?.provider_refund_ref || null, updated_at: new Date().toISOString() })
        .eq('id', refundId);

    return {
        refund: {
            id: refundId,
            type: 'provider',
            amount: amt,
            currency: String(tx.currency || '').toUpperCase(),
            status: 'PROCESSING',
            provider: tx.provider,
            provider_refund_ref: providerResult?.provider_refund_ref || null
        }
    };
}

// ─── AUTO REFUND ────────────────────────────────────────────────

async function autoRefund({ transactionId, userId, reason, source }) {
    // Fetch amount from tx
    const { data: tx } = await supabaseAdmin.from('transactions').select('amount').eq('id', transactionId).single();
    const amt = absoluteAmount(tx?.amount);
    
    const ctx = { adminId: null, adminEmail: `auto:${source}`, adminRole: 'system', requestId: `auto-${Date.now()}` };
    const idem = `auto-${transactionId}-${source}`;

    const res = await createRefundRequest({
        transactionId,
        amount: amt,
        reason: reason || `Auto-refund (${source})`,
        refundType: 'wallet',
        ctx,
        idempotencyKey: idem
    });
    
    return res;
}

// ─── LISTINGS / READS ───────────────────────────────────────────

async function listRefunds({ status, limit = 50, page = 1 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
    let q = supabaseAdmin.from('refunds').select(REFUND_COLUMNS, { count: 'exact' }).order('created_at', { ascending: false }).range(off, off + lim - 1);
    if (status && status !== 'all') q = q.eq('status', String(status).toUpperCase());
    const { data, error, count } = await q;
    if (error) throw svcErr('REFUNDS_LIST_FAILED', 'Failed to load refunds.', 500);
    return { refunds: data || [], count: count || 0, page, limit: lim, totalPages: Math.ceil((count || 0) / lim) };
}

async function getRefund(id) {
    if (!UUID_RE.test(String(id || ''))) throw svcErr('TX_NOT_FOUND', 'Invalid refund id.', 400);
    const { data, error } = await supabaseAdmin.from('refunds').select(REFUND_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw svcErr('REFUND_READ_FAILED', 'Failed to load refund.', 500);
    if (!data) throw svcErr('TX_NOT_FOUND', 'Refund not found.', 404);
    return data;
}

// ─── EXPORTS ────────────────────────────────────────────────────

module.exports = {
    getRefundCapability,
    createRefundRequest,
    executeRefund,
    executeProviderRefund,
    approveRefund,
    rejectRefund,
    cancelRefund,
    autoRefund,
    listRefunds,
    getRefund,

    // Exported for tests and route validation
    ACTIVE_REFUND_STATUSES,
    MAX_REFUND_AMOUNT,
    PROVIDER_REFUND_ADAPTERS,
    REASON_LABELS,
    reasonLabel,

    // Exported for internal reuse / tests
    _internal: {
        parseAmount,
        requireReason,
        requireIdempotencyKey,
        fingerprint
    }
};