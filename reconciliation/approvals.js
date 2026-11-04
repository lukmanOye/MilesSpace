// reconciliation/approvals.js
// ─────────────────────────────────────────────────────────────────
// Two-admin approval for critical reconciliation resolutions.
//
// Rule:
//   • A resolve on a CRITICAL issue (or any issue whose type is in
//     MONEY_IMPACTING_TYPES) requires two distinct admins.
//   • First admin calls start() → creates a pending approval row.
//     The issue is NOT closed.
//   • Second admin calls approve() → closes the issue with the
//     second admin's identity, records the decision.
//   • Rejection is a terminal decision for the approval row — the
//     issue stays open.
//   • Expiry after 24h means the pending row can be replaced by a
//     new request.
//
// The service layer (closeIssue) is what actually closes. This module
// only orchestrates the two-step handshake. The second admin never
// needs to know the internal ledger-proof rules — those are enforced
// by the service when closeIssue is called with the approval's
// carried-over fields.
// ─────────────────────────────────────────────────────────────────
'use strict';

const { supabaseAdmin } = require('../db/supabase');

const APPROVAL_REQUIRED_TYPES = new Set([
    'PROVIDER_SUCCESS_INTERNAL_INCOMPLETE',
    'PROVIDER_FAILURE_NOT_REFUNDED',
    'AMOUNT_MISMATCH',
    'DUPLICATE',
    'LEDGER_MISMATCH'
]);

function svcErr(code, message, status = 400) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    return e;
}

function requiresApproval(issue) {
    if (!issue) return false;
    if (String(issue.severity || '').toLowerCase() === 'critical') return true;
    if (APPROVAL_REQUIRED_TYPES.has(issue.issue_type)) return true;
    return false;
}

/**
 * Start an approval. Records the requester's intent. Does not close
 * the issue. The requester CANNOT be the decider (enforced on approve).
 *
 * @returns { approval } row
 * @throws {APPROVAL_ALREADY_PENDING} if a pending row exists
 * @throws {APPROVAL_NOT_REQUIRED} if the issue is not critical/money-impacting
 */
async function start({ issue, adminId, adminEmail, reason, resolutionNotes, resolvedLedgerTransactionId, moneyImpact }) {
    if (!issue) throw svcErr('ISSUE_REQUIRED', 'issue required', 500);
    if (!adminId) throw svcErr('AUTH_REQUIRED', 'adminId required');
    if (!reason || reason.trim().length < 4) {
        throw svcErr('REASON_REQUIRED', 'A reason (min 4 chars) is required to start an approval.', 422);
    }

    if (!requiresApproval(issue)) {
        throw svcErr('APPROVAL_NOT_REQUIRED', 'This issue does not require four-eyes approval.', 400);
    }

    // Reject if there's already a pending approval for this issue.
    const { data: existing } = await supabaseAdmin
        .from('reconciliation_approvals')
        .select('id, requested_by_email, created_at, expires_at')
        .eq('issue_id', issue.id)
        .eq('status', 'pending')
        .maybeSingle();

    if (existing && new Date(existing.expires_at) > new Date()) {
        const e = svcErr(
            'APPROVAL_ALREADY_PENDING',
            `A pending approval already exists (requested by ${existing.requested_by_email || 'another admin'} at ${existing.created_at}).`,
            409
        );
        e.approvalId = existing.id;
        throw e;
    }
    // If pending but expired, expire it first then create fresh.
    if (existing) {
        await supabaseAdmin
            .from('reconciliation_approvals')
            .update({ status: 'expired', decided_at: new Date().toISOString() })
            .eq('id', existing.id);
    }

    const { data, error } = await supabaseAdmin
        .from('reconciliation_approvals')
        .insert({
            issue_id: issue.id,
            requested_by: adminId,
            requested_by_email: adminEmail || null,
            reason: reason.trim(),
            resolution_notes: (resolutionNotes || '').trim() || null,
            resolved_ledger_transaction_id: resolvedLedgerTransactionId || null,
            money_impact: moneyImpact === undefined ? null : moneyImpact,
            status: 'pending',
            expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
        })
        .select('*')
        .single();

    if (error) {
        if (error.code === '23505') {
            throw svcErr('APPROVAL_ALREADY_PENDING', 'A pending approval already exists for this issue.', 409);
        }
        throw svcErr('APPROVAL_INSERT_FAILED', error.message, 500);
    }
    return data;
}

/**
 * Approve a pending approval. The SECOND admin is the resolving actor.
 * Enforces "cannot approve your own request."
 *
 * @returns { approval } row updated to status='approved'
 * @throws {APPROVAL_NOT_FOUND} if the approval does not exist
 * @throws {APPROVAL_NOT_PENDING} if it is already decided
 * @throws {APPROVAL_EXPIRED} if past expires_at
 * @throws {APPROVAL_SELF} if the same admin requested it
 */
async function approve({ approvalId, adminId, adminEmail }) {
    if (!approvalId) throw svcErr('APPROVAL_ID_REQUIRED', 'approvalId required');
    if (!adminId) throw svcErr('AUTH_REQUIRED', 'adminId required');

    const { data: approval, error: readErr } = await supabaseAdmin
        .from('reconciliation_approvals')
        .select('*')
        .eq('id', approvalId)
        .maybeSingle();
    if (readErr) throw svcErr('APPROVAL_LOOKUP_FAILED', readErr.message, 500);
    if (!approval) throw svcErr('APPROVAL_NOT_FOUND', 'Approval not found.', 404);
    if (approval.status !== 'pending') {
        throw svcErr('APPROVAL_NOT_PENDING', `Approval is already ${approval.status}.`, 409);
    }
    if (new Date(approval.expires_at) < new Date()) {
        await supabaseAdmin
            .from('reconciliation_approvals')
            .update({ status: 'expired', decided_at: new Date().toISOString() })
            .eq('id', approvalId);
        throw svcErr('APPROVAL_EXPIRED', 'Approval has expired. Start a new request.', 409);
    }
    if (String(approval.requested_by) === String(adminId)) {
        throw svcErr('APPROVAL_SELF', 'You cannot approve your own resolution. A second admin must approve.', 403);
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error: updErr } = await supabaseAdmin
        .from('reconciliation_approvals')
        .update({
            status: 'approved',
            decided_by: adminId,
            decided_by_email: adminEmail || null,
            decided_at: nowIso
        })
        .eq('id', approvalId)
        .eq('status', 'pending')
        .select('*')
        .maybeSingle();

    if (updErr) throw svcErr('APPROVAL_UPDATE_FAILED', updErr.message, 500);
    if (!updated) {
        throw svcErr('APPROVAL_NOT_PENDING', 'Another admin already decided this approval.', 409);
    }
    return updated;
}

async function reject({ approvalId, adminId, adminEmail, reason }) {
    if (!approvalId) throw svcErr('APPROVAL_ID_REQUIRED', 'approvalId required');
    if (!adminId) throw svcErr('AUTH_REQUIRED', 'adminId required');

    const nowIso = new Date().toISOString();
    const { data: updated, error } = await supabaseAdmin
        .from('reconciliation_approvals')
        .update({
            status: 'rejected',
            decided_by: adminId,
            decided_by_email: adminEmail || null,
            decided_at: nowIso,
            metadata: { rejection_reason: (reason || '').slice(0, 500) }
        })
        .eq('id', approvalId)
        .eq('status', 'pending')
        .select('*')
        .maybeSingle();

    if (error) throw svcErr('APPROVAL_UPDATE_FAILED', error.message, 500);
    if (!updated) throw svcErr('APPROVAL_NOT_PENDING', 'Approval is not pending.', 409);
    return updated;
}

async function listPendingForIssue({ issueId }) {
    if (!issueId) return [];
    const { data } = await supabaseAdmin
        .from('reconciliation_approvals')
        .select('*')
        .eq('issue_id', issueId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
    return data || [];
}

module.exports = {
    APPROVAL_REQUIRED_TYPES,
    requiresApproval,
    start,
    approve,
    reject,
    listPendingForIssue
};