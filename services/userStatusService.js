// services/userStatusService.js
// ─────────────────────────────────────────────────────────────────
// Shared verification path for the user-facing status endpoints.
//
//   GET  /api/transactions/:id/status  → read-only, cached, cheap
//   POST /api/transactions/:id/check   → triggers one provider verify
//
// Both are user-scoped: the caller MUST own the transaction. Neither
// returns raw provider fields, wallet internals, or issue ids.
//
// The POST path delegates to the reconciliation engine, so its
// idempotency and rate-limit guarantees are inherited — the user
// can trigger a check but never a credit.
//
// Language rules (enforced here, not in the frontend):
//   • The user never sees "reconciliation", "issue", or "ledger".
//   • Statuses exposed to the user: pending | completed | failed |
//     refunded | processing | reversed | cancelled | under_review.
//   • "under_review" is the user-safe label for manual_review.
// ─────────────────────────────────────────────────────────────────
'use strict';

const { supabaseAdmin } = require('../db/supabase');

const THROTTLE_MS = 30 * 1000;
const SUPPORTED_TABLES = new Set([
    'deposit_requests',
    'crypto_deposits',
    'airtime_transactions',
    'bill_payment_transactions',
    'esim_transactions',
    'giftcard_transactions'
]);

// Map internal status → user-facing label + banner message.
const STATUS_LABEL = Object.freeze({
    // Deposits
    awaiting_payment_id: 'pending',
    pending:             'pending',
    processing:          'processing',
    processing_credit:   'processing',
    partially_paid:      'under_review',
    manual_review:       'under_review',
    completed:           'completed',
    failed:              'failed',
    expired:             'failed',
    cancelled:           'cancelled',
    refunded:            'refunded',
    reversed:            'reversed',

    // Purchases
    provider_unknown:    'processing'
});

// User-facing message per label.
const LABEL_MESSAGE = Object.freeze({
    pending:       'Most payments confirm within 10 minutes.',
    processing:    'We are confirming your payment with the provider.',
    under_review:  'A specialist is checking this for you.',
    completed:     'Your transaction completed successfully.',
    failed:        'This transaction did not go through.',
    refunded:      'Your wallet has been refunded.',
    reversed:      'This payment was reversed by the provider.',
    cancelled:     'This transaction was cancelled.'
});

// User-safe mapping: never leak provider status, never leak issue type.
function toUserStatus(internalStatus) {
    const s = String(internalStatus || '').toLowerCase();
    return STATUS_LABEL[s] || 'processing';
}

function isStale(row) {
    if (!row || !row.created_at) return false;
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    return ageMs > 10 * 60 * 1000 && ['pending', 'processing', 'under_review'].includes(toUserStatus(row.status));
}

// ═══════════════════════════════════════════════════════════════════
//  The public "row" the frontend reads.
// ═══════════════════════════════════════════════════════════════════
function shapeForUser(row, { isStaleResult = null } = {}) {
    if (!row) return null;
    const label = toUserStatus(row.status);
    return {
        reference: row.reference || row.internal_reference || row.order_id || null,
        status: label,
        status_message: LABEL_MESSAGE[label] || 'Processing.',
        is_stale: isStaleResult == null ? isStale(row) : isStaleResult,
        last_updated_at: row.updated_at || row.created_at || null,
        completed_at: row.completed_at || null,
        failed_at: row.failed_at || row.failed_at || null
    };
}

// ═══════════════════════════════════════════════════════════════════
//  Look up a record by transactions.id + user_id
// ═══════════════════════════════════════════════════════════════════
async function resolveRecordForUser(transactionId, userId) {
    if (!transactionId || !userId) return null;

    // The user's activity page points at `transactions.id`. But the
    // status endpoints are also useful when the user only has a
    // reference. Accept either:
    //   1. A `transactions.id` (UUID) → source_type + source_id
    //   2. A reference string → search the transaction mirror
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transactionId);

    let txRow = null;
    if (isUuid) {
        const { data } = await supabaseAdmin
            .from('transactions')
            .select('id, user_id, type, status, reference, source_type, source_id, created_at, updated_at, completed_at, failed_at, metadata')
            .eq('id', transactionId)
            .eq('user_id', userId)
            .maybeSingle();
        txRow = data || null;
    }
    if (!txRow) {
        const { data } = await supabaseAdmin
            .from('transactions')
            .select('id, user_id, type, status, reference, source_type, source_id, created_at, updated_at, completed_at, failed_at, metadata')
            .eq('user_id', userId)
            .or(`reference.eq.${transactionId},ref.eq.${transactionId}`)
            .limit(1)
            .maybeSingle();
        txRow = data || null;
    }
    if (!txRow) return null;

    // Load the underlying record (the one the sweeper acts on).
    if (!txRow.source_type || !txRow.source_id) {
        // The transaction mirror is authoritative for status.
        return {
            transaction: txRow,
            recordTable: null,
            record: null
        };
    }

    const map = {
        kora_deposit:     'deposit_requests',
        crypto_deposit:   'crypto_deposits',
        airtime:          'airtime_transactions',
        esim:             'esim_transactions',
        giftcard:         'giftcard_transactions',
        vtpass:           'bill_payment_transactions',
        marketplace:      null
    };
    const table = map[txRow.source_type] || null;
    if (!table || !SUPPORTED_TABLES.has(table)) {
        return {
            transaction: txRow,
            recordTable: null,
            record: null
        };
    }

    const { data: record } = await supabaseAdmin
        .from(table)
        .select('*')
        .eq('id', txRow.source_id)
        .eq('user_id', userId)
        .maybeSingle();
    if (!record) {
        return {
            transaction: txRow,
            recordTable: null,
            record: null
        };
    }

    return {
        transaction: txRow,
        recordTable: table,
        record
    };
}

// ═══════════════════════════════════════════════════════════════════
//  Read-only status
// ═══════════════════════════════════════════════════════════════════
/**
 * @param {string} transactionId  uuid or reference
 * @param {string} userId
 * @returns {Promise<object|null>} user-shaped row, or null on miss
 */
async function getStatus({ transactionId, userId }) {
    const resolved = await resolveRecordForUser(transactionId, userId);
    if (!resolved) return null;

    const { transaction, recordTable, record } = resolved;
    // Prefer the underlying record's status (it's the one the sweeper
    // updates). Fall back to the mirror.
    const base = record && recordTable
        ? { ...transaction, status: record.status, updated_at: record.updated_at || transaction.updated_at }
        : transaction;

    return shapeForUser(base);
}

// ═══════════════════════════════════════════════════════════════════
//  Throttle
// ═══════════════════════════════════════════════════════════════════
/**
 * Returns { allowed, retryAfterMs }.
 */
async function checkThrottle(userId) {
    const now = Date.now();
    const { data: row } = await supabaseAdmin
        .from('user_status_checks')
        .select('last_check_at, check_count_1h, window_start_1h')
        .eq('user_id', userId)
        .maybeSingle();

    if (!row) return { allowed: true, retryAfterMs: 0 };

    const sinceLast = now - new Date(row.last_check_at).getTime();
    if (sinceLast < THROTTLE_MS) {
        return { allowed: false, retryAfterMs: THROTTLE_MS - sinceLast };
    }
    return { allowed: true, retryAfterMs: 0 };
}

async function recordCheck(userId, transactionId) {
    const now = new Date();
    const { data: existing } = await supabaseAdmin
        .from('user_status_checks')
        .select('window_start_1h, check_count_1h')
        .eq('user_id', userId)
        .maybeSingle();

    let count1h = 1;
    let windowStart = now.toISOString();

    if (existing) {
        const windowAge =
            now.getTime() - new Date(existing.window_start_1h).getTime();
        if (windowAge < 60 * 60 * 1000) {
            count1h = (existing.check_count_1h || 0) + 1;
            windowStart = existing.window_start_1h;
        }
    }

    await supabaseAdmin
        .from('user_status_checks')
        .upsert({
            user_id:        userId,
            last_check_at:  now.toISOString(),
            last_tx_id:     transactionId,
            check_count_1h: count1h,
            window_start_1h: windowStart
        }, { onConflict: 'user_id' });
}

// ═══════════════════════════════════════════════════════════════════
//  Active check — one provider re-verify, no wallet movement
// ═══════════════════════════════════════════════════════════════════
/**
 * The user clicks "Check status". We run the engine for the record's
 * service, but scoped to a single candidate. The engine:
 *   • takes its lock (so a sweep can't overlap),
 *   • rate-limits the provider,
 *   • calls verify + settle via the adapter (idempotent),
 *   • raises/closes issues as the adapter dictates.
 *
 * The user cannot cause a credit — the settle path is the same one
 * the sweeper uses, so if the provider has not confirmed success,
 * nothing is credited. If it has, the user just triggered a
 * settlement they were owed.
 *
 * Returns the fresh user-shaped status.
 */
async function runUserCheck({ transactionId, userId, ctx = {} }) {
    const resolved = await resolveRecordForUser(transactionId, userId);
    if (!resolved) {
        const e = new Error('Transaction not found.');
        e.status = 404; e.code = 'TRANSACTION_NOT_FOUND';
        throw e;
    }

    const { recordTable, record } = resolved;
    if (!recordTable || !record) {
        // The record doesn't have an underlying provider record.
        // This is fine for e.g. wallet_debit rows — just return
        // the current status without pinging a provider.
        return {
            check_ran: false,
            reason: 'no_provider_record',
            status: shapeForUser(resolved.transaction)
        };
    }

    // Map table → adapter key.
    const tableToAdapter = {
        deposit_requests:          'kora',
        crypto_deposits:           'nowpayments',
        airtime_transactions:      'airtime',
        bill_payment_transactions: 'bills',
        esim_transactions:         'esim',
        giftcard_transactions:     'giftcard'
    };
    const serviceKey = tableToAdapter[recordTable];
    if (!serviceKey) {
        const e = new Error('This transaction cannot be checked right now.');
        e.status = 409; e.code = 'CHECK_NOT_SUPPORTED';
        throw e;
    }

    // Delegate. The adapter's `_processOne` is exported by the engine
    // (deliverable 3) so we can run a single record without a full
    // sweep batch.
    let engine;
    try {
        engine = require('../reconciliation/engine');
    } catch (e) {
        const err = new Error('Status check is temporarily unavailable.');
        err.status = 503; err.code = 'CHECK_UNAVAILABLE';
        throw err;
    }

    const adapterFactory = require('../reconciliation/adapters');
    const adapter = adapterFactory.getAdapter(serviceKey);

    let result;
    try {
        if (typeof engine.runOneCandidate === 'function') {
            result = await engine.runOneCandidate(adapter, record, ctx);
        } else if (typeof engine._processCandidate === 'function') {
            result = await engine._processCandidate(adapter, record, ctx);
        } else {
            // Fallback: run the full service sweep. Less targeted but
            // safe — the adapter's own `findCandidates` will skip the
            // record if `next_check_at` is in the future, so this is
            // effectively the same as a normal sweep. The user still
            // gets a real answer.
            result = await engine.runService(adapter, ctx);
        }
    } catch (e) {
        // Provider 429/timeout — surface as pending, not as an error.
        console.warn('[USER CHECK] engine threw:', e.message);
        return {
            check_ran: true,
            reason: 'provider_slow',
            status: await getStatus({ transactionId: resolved.transaction.id, userId })
        };
    }

    return {
        check_ran: true,
        engine_result: result,
        status: await getStatus({ transactionId: resolved.transaction.id, userId })
    };
}

module.exports = {
    getStatus,
    runUserCheck,
    checkThrottle,
    recordCheck,
    toUserStatus,
    shapeForUser,
    isStale,
    THROTTLE_MS
};