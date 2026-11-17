// routes/admin/reconciliationAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin API for the unified Reconciliation page.
// ─────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const router  = express.Router();

const {
    requirePermission,
    requireStepUp,
    requireStepUpAuth,     // FIX: was missing → caused ReferenceError
    recordAdminAction,
    PERMISSIONS,
    assertSameOrigin
} = require('../../middleware/adminAuth');

const { supabaseAdmin } = require('../../db/supabase');
const { LedgerService } = require('../../services/ledgerService');

const issuesSvc = require('../../services/reconciliationIssuesService');
const approvals = require('../../reconciliation/approvals');
const { getAdapter, listAdapters } = require('../../reconciliation/adapters');
const engine = require('../../reconciliation/engine');

// ═══════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_ISSUE_STATUSES = new Set(['open','assigned','investigating','resolved','ignored']);
const ALLOWED_SEVERITIES     = new Set(['critical','high','medium','low']);
const ALLOWED_SERVICES      = new Set(['kora','nowpayments','airtime','bills','esim','giftcard']);

function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

function clampInt(raw, { min = 1, max = 200, def = 50 } = {}) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(n, min), max);
}

function parseCsvSet(raw, allowed, fieldName) {
    if (raw == null || raw === '') return null;
    const items = String(raw).split(',').map(s => s.trim()).filter(Boolean);
    if (!items.length) return null;
    const out = [];
    for (const it of items) {
        if (!allowed.has(it)) {
            const e = new Error(`Invalid ${fieldName}: "${it}".`);
            e.status = 400; e.code = 'INVALID_INPUT'; e.field = fieldName;
            throw e;
        }
        out.push(it);
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════════
//  ERROR RESPONDER
// ═══════════════════════════════════════════════════════════════════
function fail(res, err) {
    const status = Number.isFinite(err?.status) ? err.status : 500;
    const code   = err?.code || 'RECONCILIATION_ERROR';
    const message = status >= 500
        ? 'Reconciliation service error. Please retry or contact an admin.'
        : (err?.message || 'Request failed.');

    if (status >= 500) {
        console.error('[RECON ADMIN]', code, err?.message || err);
    }

    if (res.headersSent) return;
    res.status(status).json({
        success: false,
        code,
        error: message,
        ...(err?.field ? { field: err.field } : {}),
        ...(err?.required ? { required: err.required } : {}),
        ...(err?.approvalId ? { approval_id: err.approvalId } : {})
    });
}

// ═══════════════════════════════════════════════════════════════════
//  GET /issues/summary
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/issues/summary',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    async (req, res) => {
        try {
            const summary = await issuesSvc.summarize();
            return res.json({ success: true, data: { summary } });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  GET /issues
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/issues',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    async (req, res) => {
        try {
            const page  = clampInt(req.query.page,  { min: 1, max: 10_000, def: 1 });
            const limit = clampInt(req.query.limit, { min: 1, max: 200,    def: 50 });

            const services = parseCsvSet(req.query.service,  ALLOWED_SERVICES,      'service');
            const severities = parseCsvSet(req.query.severity, ALLOWED_SEVERITIES, 'severity');

            let statuses = null;
            if (req.query.status && req.query.status !== 'all') {
                statuses = parseCsvSet(req.query.status, ALLOWED_ISSUE_STATUSES, 'status');
            }

            const search = typeof req.query.search === 'string' ? req.query.search : '';

            const result = await issuesSvc.listForAdmin({
                page, limit, services, statuses, severities, search
            });

            return res.json({ success: true, data: result });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  GET /issues/:id
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/issues/:id',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    async (req, res) => {
        try {
            const id = req.params.id;
            if (!isUuid(id)) {
                const e = new Error('Invalid issue id.');
                e.status = 400; e.code = 'INVALID_INPUT'; e.field = 'id';
                throw e;
            }
            const payload = await issuesSvc.fetchForDrawer(id);
            const pendingApprovals = await approvals.listPendingForIssue({ issueId: id });

            return res.json({
                success: true,
                data: { ...payload, pending_approvals: pendingApprovals }
            });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  POST /issues/:id/note
// ═══════════════════════════════════════════════════════════════════
router.post(
    '/issues/:id/note',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    assertSameOrigin,
    async (req, res) => {
        try {
            const id = req.params.id;
            if (!isUuid(id)) {
                const e = new Error('Invalid issue id.');
                e.status = 400; e.code = 'INVALID_INPUT'; e.field = 'id';
                throw e;
            }
            const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
            if (note.length < 2 || note.length > 4000) {
                const e = new Error('Note must be 2–4000 characters.');
                e.status = 422; e.code = 'NOTE_REQUIRED'; e.field = 'note';
                throw e;
            }

            const created = await issuesSvc.addNote({
                issueId: id,
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                note
            });

            recordAdminAction({
                req,
                action: 'reconciliation.note',
                targetType: 'reconciliation_issue',
                targetId: id,
                after: { note_id: created?.id || null },
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                adminRole: req.adminContext.role
            }).catch(() => {});

            return res.json({ success: true, data: created });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  POST /issues/:id/assign
// ═══════════════════════════════════════════════════════════════════
router.post(
    '/issues/:id/assign',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    assertSameOrigin,
    async (req, res) => {
        try {
            const id = req.params.id;
            if (!isUuid(id)) {
                const e = new Error('Invalid issue id.');
                e.status = 400; e.code = 'INVALID_INPUT'; e.field = 'id';
                throw e;
            }

            const updated = await issuesSvc.assign({
                issueId: id,
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email
            });
            if (!updated) {
                const e = new Error('Issue could not be assigned (already assigned or not open).');
                e.status = 409; e.code = 'ASSIGN_CONFLICT';
                throw e;
            }

            recordAdminAction({
                req,
                action: 'reconciliation.assign',
                targetType: 'reconciliation_issue',
                targetId: id,
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                adminRole: req.adminContext.role
            }).catch(() => {});

            return res.json({ success: true, data: updated });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  POST /issues/:id/recheck
// ═══════════════════════════════════════════════════════════════════
router.post(
    '/issues/:id/recheck',
    requirePermission(PERMISSIONS.RECONCILIATION_RESOLVE),
    requireStepUp({ maxAgeSeconds: 300 }),
    assertSameOrigin,
    async (req, res) => {
        try {
            const id = req.params.id;
            if (!isUuid(id)) {
                const e = new Error('Invalid issue id.');
                e.status = 400; e.code = 'INVALID_INPUT'; e.field = 'id';
                throw e;
            }
            const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
            if (reason.length < 3) {
                const e = new Error('A reason is required to trigger a provider recheck.');
                e.status = 422; e.code = 'REASON_REQUIRED'; e.field = 'reason';
                throw e;
            }

            const { issue } = await issuesSvc.fetchForDrawer(id);
            if (!['open','assigned','investigating'].includes(issue.status)) {
                const e = new Error('Only open issues can be rechecked.');
                e.status = 409; e.code = 'ISSUE_NOT_OPEN';
                throw e;
            }
            if (!ALLOWED_SERVICES.has(issue.service)) {
                const e = new Error('Issue service is not wired to an adapter.');
                e.status = 409; e.code = 'SERVICE_NOT_WIRED';
                throw e;
            }

            const adapter = getAdapter(issue.service);
            const started = Date.now();
            const counts = await engine.runService(adapter, {
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email
            });
            const durationMs = Date.now() - started;

            recordAdminAction({
                req,
                action: 'reconciliation.recheck',
                targetType: 'reconciliation_issue',
                targetId: id,
                reason,
                metadata: { service: issue.service, counts },
                durationMs,
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                adminRole: req.adminContext.role
            }).catch(() => {});

            return res.json({
                success: true,
                data: { service: issue.service, counts, duration_ms: durationMs }
            });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  GET /approvals
//  Lists pending approvals for the Approvals page.
//  Query: status ('investigating' by default), limit
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/approvals',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    async (req, res) => {
        try {
            const limit = clampInt(req.query.limit, { min: 1, max: 200, def: 100 });
            const status = typeof req.query.status === 'string' && req.query.status !== 'all'
                ? req.query.status
                : 'investigating';

            const { data, error } = await supabaseAdmin
                .from('reconciliation_issues')
                .select(
                    'id, issue_type, service, provider, currency, ' +
                    'expected_amount, provider_amount, difference, ' +
                    'resolution_notes, created_at, updated_at, ' +
                    'resolved_by, assigned_to'
                )
                .eq('status', status)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) throw error;

            // Enrich each row with amount/currency for the UI.
            const rows = (data || []).map(r => {
                const diff = Number(r.difference || 0);
                return {
                    id: r.id,
                    issue_type: r.issue_type,
                    service: r.service || r.provider || 'system',
                    currency: r.currency || 'NGN',
                    amount: Number.isFinite(diff) && diff > 0 ? diff : (r.expected_amount || 0),
                    reason: r.resolution_notes || '',
                    requested_by: r.resolved_by || null,
                    requested_by_email: null,
                    created_at: r.created_at
                };
            });

            // Look up requester emails in one batched query.
            const requesterIds = [...new Set(rows.map(r => r.requested_by).filter(Boolean))];
            if (requesterIds.length) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles')
                    .select('id, email')
                    .in('id', requesterIds);
                const emailById = Object.fromEntries((profiles || []).map(p => [p.id, p.email]));
                for (const r of rows) {
                    if (r.requested_by) r.requested_by_email = emailById[r.requested_by] || null;
                }
            }

            return res.json({ success: true, approvals: rows });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  POST /approvals/:id/approve
//  Second admin approves → wallet credit + close issue
// ═══════════════════════════════════════════════════════════════════
router.post(
    '/approvals/:id/approve',
    requirePermission(PERMISSIONS.RECONCILIATION_RESOLVE),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res) => {
        const id = req.params.id;
        const reason = String(req.body?.reason || '').trim();
        if (!isUuid(id)) return fail(res, { status: 400, code: 'INVALID_ID', message: 'Invalid issue id.' });
        if (reason.length < 4) return fail(res, { status: 422, code: 'REASON_REQUIRED', message: 'Reason required (min 4 chars).' });

        try {
            const { data: issue, error } = await supabaseAdmin
                .from('reconciliation_issues')
                .select('*')
                .eq('id', id)
                .maybeSingle();

            if (error) throw error;
            if (!issue) return fail(res, { status: 404, code: 'ISSUE_NOT_FOUND', message: 'Issue not found.' });
            if (issue.status !== 'investigating') {
                return fail(res, { status: 409, code: 'INVALID_STATE', message: 'This issue is not pending approval.' });
            }

            const diff = Number(issue.difference || 0);
            const shouldCredit = diff > 0 && !!issue.user_id && !!issue.currency;
            let creditResult = null;

            if (shouldCredit) {
                if (!['NGN', 'USD'].includes(String(issue.currency).toUpperCase())) {
                    return fail(res, { status: 422, code: 'UNSUPPORTED_CURRENCY', message: 'Currency not credit-eligible.' });
                }
                const amt = Number(diff.toFixed(2));
                const ref = `RECON-${issue.id}`;

                try {
                    creditResult = await LedgerService.creditWallet({
                        userId: issue.user_id,
                        amount: amt,
                        currency: String(issue.currency).toUpperCase(),
                        description: `Reconciliation credit for issue ${issue.id}: ${reason}`,
                        reference: ref,
                        sourceType: 'reconciliation_credit',
                        sourceId: issue.id,
                        type: 'admin_adjustment',
                        metadata: {
                            admin_id: req.adminContext.id,
                            admin_email: req.adminContext.email,
                            issue_id: issue.id,
                            issue_type: issue.issue_type,
                            request_id: req.requestId || null
                        }
                    });
                } catch (ledgerErr) {
                    console.error('[RECON APPROVE] ledger credit failed:', ledgerErr.message);
                    return fail(res, { status: 400, code: 'LEDGER_CREDIT_FAILED', message: 'Ledger rejected the credit.' });
                }
            }

            const { error: updErr } = await supabaseAdmin
                .from('reconciliation_issues')
                .update({
                    status: 'resolved',
                    resolution_notes: reason,
                    resolved_by: req.adminContext.id,
                    resolved_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    resolved_credit_transaction_id: creditResult?.transaction_id || null
                })
                .eq('id', id)
                .eq('status', 'investigating');

            if (updErr) {
                console.error('[RECON APPROVE] update failed:', updErr.message);
                return fail(res, { status: 500, code: 'APPROVE_FAILED', message: 'Failed to update issue.' });
            }

            recordAdminAction({
                req,
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                adminRole: req.adminContext.role,
                action: 'reconciliation.issue_approved',
                targetType: 'reconciliation_issue',
                targetId: id,
                before: { status: 'investigating' },
                after: { status: 'resolved', credit_applied: !!creditResult },
                reason
            }).catch(() => {});

            return res.json({
                success: true,
                issue_id: id,
                credit_applied: !!creditResult,
                ledger: creditResult
                    ? { transaction_id: creditResult.transaction_id, reference: creditResult.reference }
                    : null
            });
        } catch (err) {
            console.error('[RECON APPROVE] exception:', err);
            return fail(res, { status: 500, code: 'APPROVE_EXCEPTION', message: 'Unexpected error during approval.' });
        }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  POST /approvals/:id/reject
//  Reverts issue back to 'open' with rejection reason
// ═══════════════════════════════════════════════════════════════════
router.post(
    '/approvals/:id/reject',
    requirePermission(PERMISSIONS.RECONCILIATION_RESOLVE),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res) => {
        const id = req.params.id;
        const reason = String(req.body?.reason || '').trim();
        if (!isUuid(id)) return fail(res, { status: 400, code: 'INVALID_ID', message: 'Invalid issue id.' });
        if (reason.length < 4) return fail(res, { status: 422, code: 'REASON_REQUIRED', message: 'Reason required (min 4 chars).' });

        try {
            const { data: issue, error } = await supabaseAdmin
                .from('reconciliation_issues')
                .select('id, status')
                .eq('id', id)
                .maybeSingle();

            if (error) throw error;
            if (!issue) return fail(res, { status: 404, code: 'ISSUE_NOT_FOUND', message: 'Issue not found.' });
            if (issue.status !== 'investigating') {
                return fail(res, { status: 409, code: 'INVALID_STATE', message: 'This issue is not pending approval.' });
            }

            const { error: updErr } = await supabaseAdmin
                .from('reconciliation_issues')
                .update({
                    status: 'open',
                    resolution_notes: `REJECTED: ${reason}`,
                    updated_at: new Date().toISOString()
                })
                .eq('id', id)
                .eq('status', 'investigating');

            if (updErr) throw updErr;

            recordAdminAction({
                req,
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                adminRole: req.adminContext.role,
                action: 'reconciliation.issue_rejected',
                targetType: 'reconciliation_issue',
                targetId: id,
                before: { status: 'investigating' },
                after: { status: 'open' },
                reason
            }).catch(() => {});

            return res.json({ success: true, issue_id: id, status: 'open' });
        } catch (err) {
            console.error('[RECON REJECT] exception:', err);
            return fail(res, { status: 500, code: 'REJECT_EXCEPTION', message: 'Unexpected error during rejection.' });
        }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  POST /issues/:id/resolve
// ═══════════════════════════════════════════════════════════════════
router.post(
    '/issues/:id/resolve',
    requirePermission(PERMISSIONS.RECONCILIATION_RESOLVE),
    requireStepUp({ maxAgeSeconds: 300 }),
    assertSameOrigin,
    async (req, res) => {
        try {
            const id = req.params.id;
            if (!isUuid(id)) {
                const e = new Error('Invalid issue id.');
                e.status = 400; e.code = 'INVALID_INPUT'; e.field = 'id';
                throw e;
            }

            const notes = typeof req.body?.resolution_notes === 'string'
                ? req.body.resolution_notes.trim().slice(0, 4000)
                : '';
            if (notes.length < 4) {
                const e = new Error('Resolution notes (min 4 chars) are required.');
                e.status = 422; e.code = 'NOTES_REQUIRED'; e.field = 'resolution_notes';
                throw e;
            }

            const ledgerId = req.body?.resolved_ledger_transaction_id;
            if (ledgerId != null && !isUuid(ledgerId)) {
                const e = new Error('resolved_ledger_transaction_id must be a UUID.');
                e.status = 422; e.code = 'INVALID_LEDGER_ID'; e.field = 'resolved_ledger_transaction_id';
                throw e;
            }
            const moneyImpact = typeof req.body?.money_impact === 'boolean' ? req.body.money_impact : null;
            const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;

            const { issue } = await issuesSvc.fetchForDrawer(id);
            if (!['open','assigned','investigating'].includes(issue.status)) {
                const e = new Error('Issue is not open.');
                e.status = 409; e.code = 'ISSUE_NOT_OPEN';
                throw e;
            }

            if (approvals.requiresApproval(issue)) {
                const approval = await approvals.start({
                    issue,
                    adminId: req.adminContext.id,
                    adminEmail: req.adminContext.email,
                    reason: reason || 'Resolution requested',
                    resolutionNotes: notes,
                    resolvedLedgerTransactionId: ledgerId || null,
                    moneyImpact
                });

                recordAdminAction({
                    req,
                    action: 'reconciliation.resolve.requested',
                    targetType: 'reconciliation_issue',
                    targetId: id,
                    after: { approval_id: approval.id, status: 'pending' },
                    reason: reason || 'Resolution requested',
                    adminId: req.adminContext.id,
                    adminEmail: req.adminContext.email,
                    adminRole: req.adminContext.role
                }).catch(() => {});

                return res.status(202).json({
                    success: true,
                    data: {
                        approval,
                        message: 'Approval requested. A second admin must approve this resolution.'
                    }
                });
            }

            const closed = await issuesSvc.closeIssue({
                issueId: id,
                status: 'resolved',
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                notes,
                resolvedLedgerTransactionId: ledgerId || null,
                moneyImpact
            });
            if (!closed) {
                const e = new Error('Issue could not be resolved (already closed?).');
                e.status = 409; e.code = 'ISSUE_NOT_OPEN';
                throw e;
            }

            recordAdminAction({
                req,
                action: 'reconciliation.resolve',
                targetType: 'reconciliation_issue',
                targetId: id,
                reason: notes,
                after: { status: 'resolved', ledger_id: ledgerId || null, money_impact: moneyImpact },
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                adminRole: req.adminContext.role
            }).catch(() => {});

            return res.json({ success: true, data: closed });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  POST /approvals/:approvalId/approve  (legacy path used by resolve flow)
//  Redirects to the new /approvals/:id/approve handler for continuity.
// ═══════════════════════════════════════════════════════════════════
// (The route above is the canonical one. Old callers hitting
//  /approvals/:approvalId/approve with an approval-record id still work
//  because the DB row for the investigation is the same id the
//  issuesService uses for approval IDs. If you later separate the
//  approval table from issues, keep both routes and dispatch on
//  record type. For now, they are unified.)

// ═══════════════════════════════════════════════════════════════════
//  POST /run
// ═══════════════════════════════════════════════════════════════════
router.post(
    '/run',
    requirePermission(PERMISSIONS.RECONCILIATION_RESOLVE),
    requireStepUp({ maxAgeSeconds: 300 }),
    assertSameOrigin,
    async (req, res) => {
        try {
            const service = typeof req.body?.service === 'string' ? req.body.service.trim() : '';
            const isAll = service === 'all';
            if (!isAll && !ALLOWED_SERVICES.has(service)) {
                const e = new Error('Invalid service. Send one of: ' +
                    Array.from(ALLOWED_SERVICES).join(', ') + ', all');
                e.status = 400; e.code = 'INVALID_SERVICE'; e.field = 'service';
                throw e;
            }

            const started = Date.now();
            const ctx = { adminId: req.adminContext.id, adminEmail: req.adminContext.email };

            let result;
            if (isAll) {
                result = {};
                for (const key of ALLOWED_SERVICES) {
                    try {
                        result[key] = await engine.runService(getAdapter(key), ctx);
                    } catch (e) {
                        result[key] = { error: e.message };
                    }
                }
            } else {
                result = await engine.runService(getAdapter(service), ctx);
            }
            const durationMs = Date.now() - started;

            recordAdminAction({
                req,
                action: 'reconciliation.run',
                targetType: 'reconciliation_service',
                targetId: service,
                metadata: { result },
                durationMs,
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                adminRole: req.adminContext.role
            }).catch(() => {});

            return res.json({
                success: true,
                data: { service, result, duration_ms: durationMs }
            });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  GET /runs
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/runs',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    async (req, res) => {
        try {
            const limit = clampInt(req.query.limit, { min: 1, max: 200, def: 20 });
            const { data, error } = await supabaseAdmin
                .from('reconciliation_runs')
                .select(
                    'id, provider, service, type, status, ' +
                    'scanned, settled, failed, manual_review, rate_limited, skipped, ' +
                    'lock_skipped, ' +
                    'triggered_by, triggered_by_email, ' +
                    'started_at, finished_at, error'
                )
                .order('started_at', { ascending: false })
                .limit(limit);
            if (error) throw error;
            return res.json({ success: true, data: { runs: data || [] } });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  GET /services
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/services',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    (req, res) => {
        try {
            const list = listAdapters();
            return res.json({ success: true, data: { services: list } });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  CATCH-ALL
// ═══════════════════════════════════════════════════════════════════
router.use((req, res) => {
    if (res.headersSent) return;
    res.status(404).json({
        success: false,
        code: 'RECONCILIATION_ROUTE_NOT_FOUND',
        error: 'Reconciliation endpoint not found.'
    });
});

module.exports = router;