// services/reconciliationIssuesService.js
// ─────────────────────────────────────────────────────────────────
// Issue queue for the unified reconciliation engine.
//
// Responsibilities:
//   1. upsertIssue      — create-or-update one open issue per
//                          (service, internal_id) with the partial
//                          unique index enforcing the invariant.
//   2. closeIssue       — closes an issue. Refuses money-impacting
//                          closes without ledger proof.
//   3. closeByInternal  — closes every open issue for a record.
//                          Used by the engine when a settle succeeds
//                          or a terminal failure is handled.
//   4. addNote / assign — audit-trail writes; both stamp
//                          first_touched_at on the issue.
//   5. autoCloseStale   — periodic pass. Closes open issues whose
//                          internal record is now terminal AND the
//                          ledger agrees. This is what catches
//                          webhook-settled records.
//   6. summarize        — the KPI counts the admin page reads.
//   7. listForAdmin     — paginated, filterable, search-enabled.
//   8. resolveWithProof — the endpoint the admin resolve button
//                          calls. Enforces the ledger-requirement
//                          rule and sets resolved_at consistently.
//
// SLA:
//   critical → due at +1h
//   high     → due at +4h
//   medium   → due at +24h
//   low      → due at +72h
//   Computed once at insert. Never changed on update.
//
// Locking:
//   The engine holds a recon_lock during a sweep. This service does
//   not acquire locks itself — it relies on the engine's lock to
//   serialize writes to a given record. The partial unique index is
//   the safety net for races that slip past (webhook vs sweep).
// ─────────────────────────────────────────────────────────────────
'use strict';

const { supabaseAdmin } = require('../db/supabase');

// ═══════════════════════════════════════════════════════════════════
//  ISSUE TYPES + SEVERITY
// ═══════════════════════════════════════════════════════════════════
const ISSUE_TYPES = Object.freeze({
    PENDING_TOO_LONG:                     'PENDING_TOO_LONG',
    PROVIDER_SUCCESS_INTERNAL_INCOMPLETE: 'PROVIDER_SUCCESS_INTERNAL_INCOMPLETE',
    INTERNAL_SUCCESS_PROVIDER_UNKNOWN:    'INTERNAL_SUCCESS_PROVIDER_UNKNOWN',
    PROVIDER_FAILURE_NOT_REFUNDED:        'PROVIDER_FAILURE_NOT_REFUNDED',
    AMOUNT_MISMATCH:                      'AMOUNT_MISMATCH',
    DUPLICATE:                            'DUPLICATE',
    MISSING_WEBHOOK:                      'MISSING_WEBHOOK',
    UNVERIFIED_WEBHOOK:                   'UNVERIFIED_WEBHOOK',
    LEDGER_MISMATCH:                      'LEDGER_MISMATCH',
    VERIFICATION_FAILED:                  'VERIFICATION_FAILED',
    PROVIDER_STATUS_UNKNOWN:              'PROVIDER_STATUS_UNKNOWN'
});

const SEVERITY = Object.freeze({
    PENDING_TOO_LONG:                     'medium',
    PROVIDER_SUCCESS_INTERNAL_INCOMPLETE: 'high',
    INTERNAL_SUCCESS_PROVIDER_UNKNOWN:    'high',
    PROVIDER_FAILURE_NOT_REFUNDED:        'critical',
    AMOUNT_MISMATCH:                      'critical',
    DUPLICATE:                            'critical',
    MISSING_WEBHOOK:                      'medium',
    UNVERIFIED_WEBHOOK:                   'high',
    LEDGER_MISMATCH:                      'critical',
    VERIFICATION_FAILED:                  'low',
    PROVIDER_STATUS_UNKNOWN:              'high'
});

// Issue types that involve money moving. Resolving one of these
// requires either a `resolved_ledger_transaction_id` or an explicit
// `money_impact: false` acknowledgement.
const MONEY_IMPACTING_TYPES = new Set([
    ISSUE_TYPES.PROVIDER_SUCCESS_INTERNAL_INCOMPLETE,
    ISSUE_TYPES.PROVIDER_FAILURE_NOT_REFUNDED,
    ISSUE_TYPES.AMOUNT_MISMATCH,
    ISSUE_TYPES.DUPLICATE,
    ISSUE_TYPES.LEDGER_MISMATCH
]);

// SLA due time per severity. Computed at insert.
const SLA_WINDOW_MS = Object.freeze({
    critical: 1 * 60 * 60 * 1000,   // 1h
    high:     4 * 60 * 60 * 1000,   // 4h
    medium:  24 * 60 * 60 * 1000,   // 24h
    low:     72 * 60 * 60 * 1000    // 72h
});

const TERMINAL_STATUSES = new Set(['resolved', 'ignored']);
const OPEN_STATUSES     = ['open', 'assigned', 'investigating'];

// Tables this service will accept as `internal_table`. Anything else
// is rejected so a typo can't accidentally join a user_id column to
// the wrong table during auto-close.
const ALLOWED_TABLES = new Set([
    'deposit_requests',
    'crypto_deposits',
    'airtime_transactions',
    'bill_payment_transactions',
    'esim_transactions',
    'giftcard_transactions'
]);

// ═══════════════════════════════════════════════════════════════════
//  ERRORS
// ═══════════════════════════════════════════════════════════════════
function svcErr(code, message, status = 400) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    return e;
}

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════
function computeSlaDueAt(severity, fromMs = Date.now()) {
    const window = SLA_WINDOW_MS[severity] || SLA_WINDOW_MS.medium;
    return new Date(fromMs + window).toISOString();
}

function normalizeSeverity(issueType) {
    return SEVERITY[issueType] || 'medium';
}

function isTerminal(status) {
    return TERMINAL_STATUSES.has(status);
}

function isOpenStatus(status) {
    return OPEN_STATUSES.includes(status);
}

/**
 * Read the internal record that an issue points at. Returns null
 * if the table is not in the allowlist, the record is missing, or
 * the lookup fails. Never throws — the caller must treat null as
 * "cannot auto-close".
 */
async function fetchInternalRecord(issue) {
    if (!issue || !issue.internal_table || !issue.internal_id) return null;
    if (!ALLOWED_TABLES.has(issue.internal_table)) return null;

    const { data, error } = await supabaseAdmin
        .from(issue.internal_table)
        .select('*')
        .eq('id', issue.internal_id)
        .maybeSingle();

    if (error) return null;
    return data || null;
}

/**
 * Check that a terminal deposit has a completed ledger credit, or a
 * terminal purchase has a completed refund, or a terminal failure
 * has no money in flight. This is the definition of "consistent"
 * for auto-close. If we can't prove consistency, we do NOT close.
 *
 * Returns { consistent: boolean, reason: string|null }.
 */
async function checkLedgerConsistency(issue, record) {
    // No record — can't prove anything. Leave open.
    if (!record) return { consistent: false, reason: 'no_internal_record' };

    const status = String(record.status || '').toLowerCase();

    // ── Deposits ───────────────────────────────────────────────
    if (issue.internal_table === 'deposit_requests') {
        if (status === 'completed') {
            const { data: tx } = await supabaseAdmin
                .from('transactions')
                .select('id, status')
                .eq('source_type', 'kora_deposit')
                .eq('source_id', record.id)
                .eq('type', 'deposit')
                .maybeSingle();
            return {
                consistent: Boolean(tx && tx.status === 'completed'),
                reason: tx ? null : 'no_ledger_tx'
            };
        }
        if (['failed', 'expired', 'cancelled'].includes(status)) {
            // A terminal failure is consistent as long as no credit
            // exists. Check the tx row is not 'completed'.
            const { data: tx } = await supabaseAdmin
                .from('transactions')
                .select('id, status')
                .eq('source_type', 'kora_deposit')
                .eq('source_id', record.id)
                .eq('type', 'deposit')
                .maybeSingle();
            return {
                consistent: !tx || tx.status !== 'completed',
                reason: tx && tx.status === 'completed' ? 'credit_exists_on_failed' : null
            };
        }
        return { consistent: false, reason: `status_${status}` };
    }

    if (issue.internal_table === 'crypto_deposits') {
        if (status === 'completed') {
            const { data: tx } = await supabaseAdmin
                .from('transactions')
                .select('id, status')
                .eq('source_type', 'crypto_deposit')
                .eq('source_id', record.id)
                .eq('type', 'deposit')
                .maybeSingle();
            return {
                consistent: Boolean(tx && tx.status === 'completed'),
                reason: tx ? null : 'no_ledger_tx'
            };
        }
        if (['failed', 'expired', 'refunded'].includes(status)) {
            const { data: tx } = await supabaseAdmin
                .from('transactions')
                .select('id, status')
                .eq('source_type', 'crypto_deposit')
                .eq('source_id', record.id)
                .eq('type', 'deposit')
                .maybeSingle();
            return {
                consistent: !tx || tx.status !== 'completed',
                reason: tx && tx.status === 'completed' ? 'credit_exists_on_failed' : null
            };
        }
        return { consistent: false, reason: `status_${status}` };
    }

    // ── Purchases (airtime, bills, eSIM, gift card) ────────────
    if (['airtime_transactions', 'bill_payment_transactions',
         'esim_transactions', 'giftcard_transactions'].includes(issue.internal_table)) {
        if (status === 'completed') {
            // Success: nothing more to prove — the record is the truth.
            return { consistent: true, reason: null };
        }
        if (status === 'refunded') {
            return { consistent: true, reason: null };
        }
        if (status === 'failed') {
            // A purchase in `failed` should also have `refunded = true`
            // OR the refund should exist in the ledger. If neither,
            // money is stuck — leave open so a PROVIDER_FAILURE_NOT_REFUNDED
            // can be raised by the engine.
            if (record.refunded === true) return { consistent: true, reason: null };
            if (record.ledger_transaction_id) {
                const { data: refundTx } = await supabaseAdmin
                    .from('ledger_transactions')
                    .select('id')
                    .eq('type', 'refund')
                    .eq('reference', `REFUND-${record.reference}`)
                    .maybeSingle();
                if (refundTx) return { consistent: true, reason: null };
            }
            return { consistent: false, reason: 'failed_without_refund' };
        }
        if (status === 'manual_review' || status === 'provider_unknown') {
            // Not terminal — still being worked. Leave open.
            return { consistent: false, reason: `still_${status}` };
        }
        return { consistent: false, reason: `status_${status}` };
    }

    return { consistent: false, reason: 'unknown_table' };
}

// ═══════════════════════════════════════════════════════════════════
//  upsertIssue — create-or-update one open issue per record
// ═══════════════════════════════════════════════════════════════════
/**
 * Create an open issue, or update the existing open issue for the
 * same (service, internal_id). Never creates a second open issue.
 * The partial unique index in migration 04-02 enforces this even
 * when two writers race — the loser handles the 23505 by re-reading.
 *
 * Fields:
 *   service             'kora' | 'nowpayments' | 'airtime' | 'bills' | 'esim' | 'giftcard'
 *   provider            'korapay' | 'nowpayments' | 'dtone' | 'vtpass'
 *   issueType           one of ISSUE_TYPES
 *   internalTable       one of ALLOWED_TABLES
 *   internalId          uuid of the internal record (may be null for pre-record issues)
 *   internalRef         human-readable reference (may be null)
 *   providerRef         provider reference (may be null)
 *   userId              uuid (may be null)
 *   amount              numeric (may be null)
 *   currency            'NGN' | 'USD' (may be null)
 *   internalStatus      current internal status (may be null)
 *   providerStatus      current provider status (may be null)
 *   reason              human-readable reason
 *   nextVerifyAt        timestamp the issue re-verify job should try next
 *   lastVerifyError     last error from a provider query, if any
 *   metadata            arbitrary object merged into existing metadata
 *   actor               'system:reconciliation' | '<admin email>' | null
 */
async function upsertIssue({
    service,
    provider,
    issueType,
    internalTable,
    internalId,
    internalRef,
    providerRef,
    userId,
    amount,
    currency,
    internalStatus,
    providerStatus,
    reason,
    nextVerifyAt = null,
    lastVerifyError = null,
    metadata = {},
    actor = 'system:reconciliation'
}) {
    if (!service || !provider || !issueType) {
        throw svcErr('INVALID_INPUT', 'service, provider, issueType are required');
    }
    if (!Object.values(ISSUE_TYPES).includes(issueType)) {
        throw svcErr('INVALID_ISSUE_TYPE', `Unknown issueType: ${issueType}`);
    }
    if (internalTable && !ALLOWED_TABLES.has(internalTable)) {
        throw svcErr('INVALID_TABLE', `internalTable "${internalTable}" is not allowed`);
    }

    const severity = normalizeSeverity(issueType);
    const nowIso = new Date().toISOString();
    const slaDueAt = computeSlaDueAt(severity);

    // ── 1. Try to find the existing open issue ─────────────────
    let existing = null;
    if (internalId) {
        const { data, error } = await supabaseAdmin
            .from('reconciliation_issues')
            .select('*')
            .eq('service', service)
            .eq('internal_id', internalId)
            .in('status', OPEN_STATUSES)
            .maybeSingle();
        if (error && error.code !== 'PGRST116') {
            throw svcErr('ISSUE_LOOKUP_FAILED', error.message, 500);
        }
        existing = data || null;
    }

    if (existing) {
        // Preserve the original issue_type unless the caller explicitly
        // escalates. This means a PENDING_TOO_LONG issue raised on
        // sweep 1 does NOT morph into a PROVIDER_FAILURE_NOT_REFUNDED
        // issue on sweep 5 unless the engine explicitly asks for it.
        // Rationale: the original diagnostic context is valuable; a
        // later, more severe finding is best kept as a NOTE unless the
        // caller is authoritative about the new type.
        const keepType = existing.issue_type;
        const escalate = shouldEscalate(existing.issue_type, issueType);
        const finalType = escalate ? issueType : keepType;
        const finalSeverity = normalizeSeverity(finalType);

        const mergedMetadata = {
            ...(existing.metadata || {}),
            ...metadata,
            last_upsert_at: nowIso,
            last_upsert_by: actor
        };

        const { data: updated, error: updErr } = await supabaseAdmin
            .from('reconciliation_issues')
            .update({
                issue_type:              finalType,
                severity:                finalSeverity,
                internal_ref:            internalRef      || existing.internal_ref,
                provider_ref:            providerRef      || existing.provider_ref,
                user_id:                 userId           || existing.user_id,
                amount:                  amount != null   ? amount   : existing.amount,
                currency:                currency         || existing.currency,
                internal_status:         internalStatus   || existing.internal_status,
                provider_status:         providerStatus   || existing.provider_status,
                reason:                  reason           || existing.reason,
                last_verified_at:        nowIso,
                next_verify_at:          nextVerifyAt,
                last_verify_error:       lastVerifyError,
                reconciliation_attempts: (existing.reconciliation_attempts || 0) + 1,
                metadata:                mergedMetadata,
                updated_at:              nowIso
            })
            .eq('id', existing.id)
            .in('status', OPEN_STATUSES)
            .select('*')
            .single();

        if (updErr) {
            throw svcErr('ISSUE_UPDATE_FAILED', updErr.message, 500);
        }

        // Append a note recording the escalation, so the admin drawer
        // shows what happened without needing to reconstruct.
        if (escalate && finalType !== keepType) {
            await addNote({
                issueId: updated.id,
                adminId: null,
                adminEmail: actor,
                note: `Issue escalated from ${keepType} to ${finalType}. Reason: ${reason || '(no reason)'}`
            }).catch(() => {});
        }

        return updated;
    }

    // ── 2. Insert new ──────────────────────────────────────────
    const insertPayload = {
        service,
        provider,
        issue_type:              issueType,
        severity,
        status:                  'open',
        internal_ref:            internalRef      || null,
        provider_ref:            providerRef      || null,
        internal_table:          internalTable    || null,
        internal_id:             internalId       || null,
        user_id:                 userId           || null,
        amount:                  amount != null   ? amount   : null,
        currency:                currency         || null,
        internal_status:         internalStatus   || null,
        provider_status:         providerStatus   || null,
        reason:                  reason           || null,
        reconciliation_attempts: 1,
        last_verified_at:        nowIso,
        next_verify_at:          nextVerifyAt,
        last_verify_error:       lastVerifyError,
        sla_due_at:              slaDueAt,
        first_touched_at:        null,
        metadata: {
            ...metadata,
            created_by: actor,
            created_at: nowIso
        }
    };

    const { data: inserted, error: insErr } = await supabaseAdmin
        .from('reconciliation_issues')
        .insert(insertPayload)
        .select('*')
        .single();

    if (insErr) {
        // ── 3. Race recovery (partial unique index hit) ────────
        if (insErr.code === '23505' && internalId) {
            const { data: raced } = await supabaseAdmin
                .from('reconciliation_issues')
                .select('*')
                .eq('service', service)
                .eq('internal_id', internalId)
                .in('status', OPEN_STATUSES)
                .maybeSingle();
            if (raced) return raced;
        }
        throw svcErr('ISSUE_INSERT_FAILED', insErr.message, 500);
    }
    return inserted;
}

/**
 * Escalation rule: a lower-severity issue is escalated to a higher
 * severity one, but a higher severity issue is NOT downgraded by a
 * later lower-severity raise. This preserves the admin's view of
 * worst-known-state.
 */
function shouldEscalate(currentType, incomingType) {
    if (currentType === incomingType) return false;
    const order = { critical: 4, high: 3, medium: 2, low: 1 };
    const cur = order[normalizeSeverity(currentType)] || 0;
    const inc = order[normalizeSeverity(incomingType)] || 0;
    return inc > cur;
}

// ═══════════════════════════════════════════════════════════════════
//  closeIssue — close with ledger proof for money-impacting issues
// ═══════════════════════════════════════════════════════════════════
/**
 * Close an issue. If the issue is money-impacting, requires either:
 *   - resolvedLedgerTransactionId (a UUID), OR
 *   - moneyImpact === false (explicit "no money moved" acknowledgement).
 * Without one of those, the close is REJECTED with MONEY_IMPACT_UNPROVEN.
 *
 * The routes/admin layer is expected to compute those two fields
 * from the resolution request. This service trusts them.
 *
 * Returns the closed row, or null if the issue was not in an open
 * status (someone else closed it first — not an error).
 */
async function closeIssue({
    issueId,
    status = 'resolved',
    adminId,
    adminEmail,
    notes,
    resolvedLedgerTransactionId = null,
    moneyImpact = null
}) {
    if (!issueId) throw svcErr('INVALID_INPUT', 'issueId required');
    if (!['resolved', 'ignored'].includes(status)) {
        throw svcErr('INVALID_STATUS', `Invalid close status: ${status}`);
    }

    // ── 1. Read the current issue ───────────────────────────────
    const { data: issue, error: readErr } = await supabaseAdmin
        .from('reconciliation_issues')
        .select('*')
        .eq('id', issueId)
        .maybeSingle();
    if (readErr) throw svcErr('ISSUE_LOOKUP_FAILED', readErr.message, 500);
    if (!issue) throw svcErr('ISSUE_NOT_FOUND', 'Issue not found', 404);
    if (!isOpenStatus(issue.status)) {
        // Someone else closed it — return the row so the caller can
        // tell the admin "already resolved". Not an error.
        return issue;
    }

    // ── 2. Ledger-proof gate for money-impacting issues ─────────
    if (MONEY_IMPACTING_TYPES.has(issue.issue_type)) {
        const hasLedger = Boolean(resolvedLedgerTransactionId);
        const explicitNoImpact = moneyImpact === false;
        if (!hasLedger && !explicitNoImpact) {
            throw svcErr(
                'MONEY_IMPACT_UNPROVEN',
                'This issue is money-impacting. Provide resolved_ledger_transaction_id, or set money_impact=false with a note.',
                422
            );
        }
        if (hasLedger) {
            // Verify the ledger row exists. A typo'd UUID would let
            // the issue close against a nonexistent proof.
            const { data: ledgerRow, error: ledgerErr } = await supabaseAdmin
                .from('transactions')
                .select('id, status')
                .eq('id', resolvedLedgerTransactionId)
                .maybeSingle();
            if (ledgerErr) throw svcErr('LEDGER_LOOKUP_FAILED', ledgerErr.message, 500);
            if (!ledgerRow) {
                throw svcErr('LEDGER_NOT_FOUND', 'The referenced ledger transaction does not exist.', 422);
            }
            if (ledgerRow.status !== 'completed') {
                throw svcErr('LEDGER_NOT_COMPLETED', 'The referenced ledger transaction is not completed.', 422);
            }
        }
    }

    // ── 3. Update ───────────────────────────────────────────────
    const nowIso = new Date().toISOString();
    const patch = {
        status,
        resolved_by:                     adminId || null,
        resolved_at:                     nowIso,
        resolution_notes:                notes || null,
        resolved_ledger_transaction_id:  resolvedLedgerTransactionId || null,
        first_touched_at:                issue.first_touched_at || nowIso,
        updated_at:                      nowIso
    };

    const { data, error } = await supabaseAdmin
        .from('reconciliation_issues')
        .update(patch)
        .eq('id', issueId)
        .in('status', OPEN_STATUSES)
        .select('*')
        .maybeSingle();

    if (error) throw svcErr('ISSUE_CLOSE_FAILED', error.message, 500);

    // ── 4. Append resolution note (if admin supplied notes) ────
    if (data && notes && notes.trim().length >= 2) {
        await addNote({
            issueId: data.id,
            adminId: adminId || null,
            adminEmail: adminEmail || null,
            note: `[RESOLVED — ${status}] ${notes.trim()}`
        }).catch(() => {});
    }

    return data;
}

// ═══════════════════════════════════════════════════════════════════
//  closeByInternal — close all open issues for a record
// ═══════════════════════════════════════════════════════════════════
/**
 * Close every open issue tied to (service, internalId). Used by the
 * engine after a settle succeeds or a terminal failure is handled.
 *
 * Because the engine already knows the settlement succeeded, we set
 * moneyImpact = false here — the engine's settle call IS the proof
 * of money movement. The issue is being closed because the money
 * moved, not in spite of it.
 *
 * If `resolvedLedgerTransactionId` is provided, we record it.
 */
async function closeByInternal({
    service,
    internalId,
    adminEmail = 'system:reconciliation',
    notes,
    resolvedLedgerTransactionId = null
}) {
    if (!service || !internalId) return [];

    const { data: openIssues, error } = await supabaseAdmin
        .from('reconciliation_issues')
        .select('id, issue_type')
        .eq('service', service)
        .eq('internal_id', internalId)
        .in('status', OPEN_STATUSES);

    if (error || !openIssues || !openIssues.length) return [];

    const closed = [];
    for (const oi of openIssues) {
        try {
            const isMoneyImpacting = MONEY_IMPACTING_TYPES.has(oi.issue_type);
            const row = await closeIssue({
                issueId: oi.id,
                status: 'resolved',
                adminId: null,
                adminEmail,
                notes: notes || 'Auto-resolved by reconciliation',
                resolvedLedgerTransactionId,
                // The engine would not call closeByInternal if the money
                // had not moved. Trust that.
                moneyImpact: isMoneyImpacting ? false : null
            });
            if (row) closed.push(row);
        } catch (e) {
            // A failed auto-close must not abort the sweep. Log and
            // move on. The next sweep tries again.
            console.warn(`[ISSUES] closeByInternal failed for ${oi.id}: ${e.message}`);
        }
    }
    return closed;
}

// ═══════════════════════════════════════════════════════════════════
//  addNote — append an audit-trail note, stamp first_touched_at
// ═══════════════════════════════════════════════════════════════════
async function addNote({ issueId, adminId, adminEmail, note }) {
    if (!issueId) throw svcErr('INVALID_INPUT', 'issueId required');
    const trimmed = typeof note === 'string' ? note.trim() : '';
    if (trimmed.length < 2) throw svcErr('NOTE_REQUIRED', 'Note must be at least 2 characters.', 422);
    if (trimmed.length > 4000) throw svcErr('NOTE_TOO_LONG', 'Note must be at most 4000 characters.', 422);

    const nowIso = new Date().toISOString();

    const { data, error } = await supabaseAdmin
        .from('reconciliation_issue_notes')
        .insert({
            issue_id:     issueId,
            author_id:    adminId || null,
            author_email: adminEmail || null,
            note:         trimmed,
            created_at:   nowIso
        })
        .select('*')
        .single();

    if (error) throw svcErr('NOTE_FAILED', error.message, 500);

    // Stamp first_touched_at on the issue (idempotent).
    await supabaseAdmin
        .from('reconciliation_issues')
        .update({ first_touched_at: nowIso })
        .eq('id', issueId)
        .is('first_touched_at', null);

    return data;
}

// ═══════════════════════════════════════════════════════════════════
//  assign — assign an issue to an admin
// ═══════════════════════════════════════════════════════════════════
async function assign({ issueId, adminId, adminEmail }) {
    if (!issueId) throw svcErr('INVALID_INPUT', 'issueId required');
    if (!adminId) throw svcErr('INVALID_INPUT', 'adminId required');

    const nowIso = new Date().toISOString();

    const { data, error } = await supabaseAdmin
        .from('reconciliation_issues')
        .update({
            status:             'assigned',
            assigned_to:        adminId,
            assigned_to_email:  adminEmail || null,
            assigned_at:        nowIso,
            first_touched_at:   nowIso,   // always set if null; overwriting
                                          // is prevented by the update filter below
            updated_at:         nowIso
        })
        .eq('id', issueId)
        .in('status', ['open', 'investigating'])
        .select('*')
        .maybeSingle();

    if (error) throw svcErr('ASSIGN_FAILED', error.message, 500);

    // Preserve the FIRST touch if the issue was already touched before.
    if (data) {
        await supabaseAdmin
            .from('reconciliation_issues')
            .update({ first_touched_at: data.first_touched_at || nowIso })
            .eq('id', issueId);
    }

    return data;
}

// ═══════════════════════════════════════════════════════════════════
//  autoCloseStale — close provably-consistent open issues
// ═══════════════════════════════════════════════════════════════════
/**
 * Periodic pass. For each open issue older than `minAgeMs`:
 *   1. Fetch the internal record.
 *   2. Ask `checkLedgerConsistency` whether it is terminal AND the
 *      ledger agrees.
 *   3. If yes, close with `system:auto-close` as the actor.
 *
 * This is what closes an issue when a webhook settled the deposit
 * while the issue was open, or when an admin resolved the record
 * from another admin page, or when the engine settled it on a
 * later sweep.
 *
 * Called by the engine after each service sweep (see
 * reconciliation/autoClose.js). Also safe to call standalone.
 *
 * Returns { scanned, closed, skipped }.
 */
async function autoCloseStale({ minAgeMs = 5 * 60 * 1000, batchSize = 100 } = {}) {
    const cutoff = new Date(Date.now() - minAgeMs).toISOString();

    const { data: issues, error } = await supabaseAdmin
        .from('reconciliation_issues')
        .select('*')
        .in('status', OPEN_STATUSES)
        .lt('created_at', cutoff)
        .order('created_at', { ascending: true })
        .limit(batchSize);

    if (error) {
        console.warn('[ISSUES] autoCloseStale read failed:', error.message);
        return { scanned: 0, closed: 0, skipped: 0 };
    }
    if (!issues || !issues.length) return { scanned: 0, closed: 0, skipped: 0 };

    let closed = 0;
    let skipped = 0;

    for (const issue of issues) {
        try {
            const record = await fetchInternalRecord(issue);
            if (!record) { skipped++; continue; }

            const { consistent, reason } = await checkLedgerConsistency(issue, record);
            if (!consistent) {
                skipped++;
                continue;
            }

            const closeResult = await closeIssue({
                issueId: issue.id,
                status: 'resolved',
                adminId: null,
                adminEmail: 'system:auto-close',
                notes: `Auto-closed: ${issue.service} record ${record.status} is now terminal and consistent${reason ? ` (${reason})` : ''}`,
                moneyImpact: null   // auto-close is not gated on money-impact
            });

            if (closeResult) {
                closed++;
                console.log(`[ISSUES] auto-closed ${issue.id} (${issue.service}, ${record.status})`);
            } else {
                skipped++;
            }
        } catch (e) {
            console.warn(`[ISSUES] auto-close failed for ${issue.id}:`, e.message);
            skipped++;
        }
    }

    return { scanned: issues.length, closed, skipped };
}

// ═══════════════════════════════════════════════════════════════════
//  summarize — KPI data for the admin page
// ═══════════════════════════════════════════════════════════════════
/**
 * Return counts for the header cards:
 *   open, assigned, investigating,
 *   critical, high, medium, low,
 *   oldest_open_age_seconds,
 *   sla_breached, due_soon (within 30 min)
 *
 * Uses the RPC `admin_reconciliation_issues_summary()` if it exists
 * (created by migration 20261103_reconciliation_v2.sql). Falls back
 * to a JS aggregation otherwise.
 */
async function summarize() {
    const { data, error } = await supabaseAdmin.rpc('admin_reconciliation_issues_summary');
    if (!error && data) {
        const row = Array.isArray(data) ? data[0] : data;
        return normalizeSummary(row);
    }
    if (error && error.code !== 'PGRST202') {
        console.warn('[ISSUES] summary RPC failed, using fallback:', error.message);
    }
    return await summarizeFallback();
}

function normalizeSummary(row) {
    const r = row || {};
    return {
        open:                    Number(r.open          || 0),
        assigned:                Number(r.assigned      || 0),
        investigating:           Number(r.investigating || 0),
        critical:                Number(r.critical      || 0),
        high:                    Number(r.high          || 0),
        medium:                  Number(r.medium        || 0),
        low:                     Number(r.low           || 0),
        oldest_open_age_seconds: r.oldest_open_age_seconds == null
            ? null
            : Number(r.oldest_open_age_seconds),
        sla_breached:            Number(r.sla_breached  || 0),
        due_soon:                Number(r.due_soon      || 0)
    };
}

async function summarizeFallback() {
    const now = Date.now();
    const in30Min = new Date(now + 30 * 60_000).toISOString();
    const nowIso = new Date(now).toISOString();

    const [openR, assignedR, investigatingR, critR, highR, medR, lowR, oldestR, breachedR, dueSoonR] =
        await Promise.all([
            countBy({ statuses: OPEN_STATUSES }),
            countBy({ statuses: ['assigned'] }),
            countBy({ statuses: ['investigating'] }),
            countBy({ statuses: OPEN_STATUSES, severity: 'critical' }),
            countBy({ statuses: OPEN_STATUSES, severity: 'high' }),
            countBy({ statuses: OPEN_STATUSES, severity: 'medium' }),
            countBy({ statuses: OPEN_STATUSES, severity: 'low' }),
            oldestOpen(),
            countBy({ statuses: OPEN_STATUSES, slaBreachedAt: nowIso }),
            countBy({ statuses: OPEN_STATUSES, slaDueBefore: in30Min, slaDueAfter: nowIso })
        ]);

    return {
        open: openR,
        assigned: assignedR,
        investigating: investigatingR,
        critical: critR,
        high: highR,
        medium: medR,
        low: lowR,
        oldest_open_age_seconds: oldestR,
        sla_breached: breachedR,
        due_soon: dueSoonR
    };
}

async function countBy({ statuses, severity, slaBreachedAt, slaDueBefore, slaDueAfter }) {
    let q = supabaseAdmin
        .from('reconciliation_issues')
        .select('id', { count: 'exact', head: true });

    if (statuses && statuses.length)   q = q.in('status', statuses);
    if (severity)                      q = q.eq('severity', severity);
    if (slaBreachedAt)                 q = q.lt('sla_due_at', slaBreachedAt);
    if (slaDueBefore)                  q = q.lt('sla_due_at', slaDueBefore);
    if (slaDueAfter)                   q = q.gt('sla_due_at', slaDueAfter);

    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
}

async function oldestOpen() {
    const { data, error } = await supabaseAdmin
        .from('reconciliation_issues')
        .select('created_at')
        .in('status', OPEN_STATUSES)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    if (!data?.created_at) return null;
    return Math.max(0, Math.round((Date.now() - new Date(data.created_at).getTime()) / 1000));
}

// ═══════════════════════════════════════════════════════════════════
//  listForAdmin — paginated, filterable, search-enabled queue
// ═══════════════════════════════════════════════════════════════════
/**
 * Paginated list for the admin table. Handles:
 *   - page/limit pagination
 *   - status filter (single, comma-separated, or "all")
 *   - severity filter (single, comma-separated)
 *   - service filter (single, comma-separated)
 *   - search (trimmed, capped, PostgREST-safe)
 *
 * Returns { issues, page, limit, total, totalPages }.
 */
async function listForAdmin({
    page = 1,
    limit = 50,
    services = null,
    statuses = null,
    severities = null,
    search = ''
} = {}) {
    const safePage  = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const from = (safePage - 1) * safeLimit;
    const to   = from + safeLimit - 1;

    let q = supabaseAdmin
        .from('reconciliation_issues')
        .select(
            'id, service, provider, issue_type, severity, status, ' +
            'internal_table, internal_id, internal_ref, provider_ref, ' +
            'user_id, amount, currency, internal_status, provider_status, ' +
            'reason, reconciliation_attempts, last_verified_at, next_verify_at, ' +
            'created_at, updated_at, assigned_to_email, resolved_at, ' +
            'sla_due_at, first_touched_at, resolved_ledger_transaction_id',
            { count: 'exact' }
        );

    if (Array.isArray(services) && services.length)   q = q.in('service', services);
    if (Array.isArray(severities) && severities.length) q = q.in('severity', severities);
    if (Array.isArray(statuses) && statuses.length)   q = q.in('status', statuses);

    const trimmed = typeof search === 'string' ? search.trim().slice(0, 200) : '';
    if (trimmed) {
        // Escape LIKE wildcards. Replace PostgREST `or()` syntax chars.
        const safe = trimmed.replace(/[(),]/g, ' ').replace(/[%_]/g, '\\$&');
        q = q.or(
            `internal_ref.ilike.%${safe}%,` +
            `provider_ref.ilike.%${safe}%,` +
            `reason.ilike.%${safe}%,` +
            `issue_type.ilike.%${safe}%`
        );
    }

    q = q.order('created_at', { ascending: false }).range(from, to);

    const { data, count, error } = await q;
    if (error) throw svcErr('ISSUE_LIST_FAILED', error.message, 500);

    const total = count || 0;
    const totalPages = Math.max(1, Math.ceil(total / safeLimit));

    return {
        issues: data || [],
        page: safePage,
        limit: safeLimit,
        total,
        totalPages
    };
}

// ═══════════════════════════════════════════════════════════════════
//  fetchForDrawer — full issue payload for the admin drawer
// ═══════════════════════════════════════════════════════════════════
/**
 * Returns { issue, user, internal_record, notes } — everything the
 * drawer needs in one call, so two admins looking at the same issue
 * cannot disagree because they joined different data.
 */
async function fetchForDrawer(issueId) {
    if (!issueId) throw svcErr('INVALID_INPUT', 'issueId required');

    const { data: issue, error } = await supabaseAdmin
        .from('reconciliation_issues')
        .select('*')
        .eq('id', issueId)
        .maybeSingle();
    if (error) throw svcErr('ISSUE_LOOKUP_FAILED', error.message, 500);
    if (!issue) throw svcErr('ISSUE_NOT_FOUND', 'Issue not found', 404);

    const [userRes, notesRes, recordRes] = await Promise.all([
        issue.user_id
            ? supabaseAdmin.from('profiles').select('id, email, username').eq('id', issue.user_id).maybeSingle()
            : Promise.resolve({ data: null }),
        supabaseAdmin
            .from('reconciliation_issue_notes')
            .select('id, author_id, author_email, note, created_at')
            .eq('issue_id', issueId)
            .order('created_at', { ascending: false }),
        fetchInternalRecord(issue)
    ]);

    if (notesRes.error) throw svcErr('NOTES_READ_FAILED', notesRes.error.message, 500);

    return {
        issue,
        user: userRes.data || null,
        internal_record: recordRes,
        notes: notesRes.data || []
    };
}

// ═══════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════
module.exports = {
    ISSUE_TYPES,
    SEVERITY,
    MONEY_IMPACTING_TYPES,
    SLA_WINDOW_MS,
    ALLOWED_TABLES,

    upsertIssue,
    closeIssue,
    closeByInternal,
    addNote,
    assign,
    autoCloseStale,
    summarize,
    listForAdmin,
    fetchForDrawer,

    // Exposed for tests and future use.
    checkLedgerConsistency,
    computeSlaDueAt,
    fetchInternalRecord
};