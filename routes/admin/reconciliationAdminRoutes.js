// routes/admin/reconciliationAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin API for the unified Reconciliation page.
//
// Mount (in server.js, EARLY — before any generic /api/admin mount
// that might have a router.all('*') catch-all):
//   app.use('/api/admin/reconciliation',
//           require('./routes/admin/reconciliationAdminRoutes'));
//
// Design:
//   • Every route names its permission explicitly. No top-level
//     router.use guard — that would apply ONE permission to every
//     route, including mutations needing RECONCILIATION_RESOLVE.
//
//   • requirePermission(perm) builds req.adminContext and enforces
//     the permission. It is the ONLY way this router gets a context.
//     There is no AUTH_CONTEXT_MISSING path — that bug came from a
//     hand-rolled guard that fired before requirePermission ran.
//
//   • Every mutation:
//       – runs assertSameOrigin (CSRF),
//       – runs requireStepUp when money or state moves,
//       – writes an audit row via recordAdminAction,
//       – returns { success, data } or { success:false, code, error }.
//
//   • Money-impacting resolutions are gated on the four-eyes
//     approval flow in reconciliation/approvals.js: the FIRST admin
//     calls /resolve (which either closes directly when approval is
//     not required, or converts into a pending approval). The
//     SECOND admin calls /approve. /reject cancels the approval.
//
//   • The routes NEVER touch the DB. All logic lives in
//     services/reconciliationIssuesService.js and
//     reconciliation/approvals.js.
// ─────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const router  = express.Router();

const {
    requirePermission,
    requireStepUp,
    recordAdminAction,
    PERMISSIONS,
    assertSameOrigin
} = require('../../middleware/adminAuth');

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
//  KPI data for the header cards.
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
//  Paginated issue queue.
//  Query: page, limit, service, status, severity, search
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

            // status accepts comma-separated or 'all' (null).
            let statuses = null;
            if (req.query.status && req.query.status !== 'all') {
                statuses = parseCsvSet(req.query.status, ALLOWED_ISSUE_STATUSES, 'status');
            }

            const search = typeof req.query.search === 'string' ? req.query.search : '';

            const result = await issuesSvc.listForAdmin({
                page, limit,
                services,
                statuses,
                severities,
                search
            });

            return res.json({ success: true, data: result });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  GET /issues/:id
//  Drawer payload: issue + user + internal_record + notes + approvals.
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
//  Append an internal note. Not a money-move, not step-up gated.
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
//  Assign to me.
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
//  Runs the engine for the issue's service. Step-up required
//  because it triggers provider calls.
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

            // Load the issue to determine the service.
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
//  POST /issues/:id/resolve
//  Closes the issue. Enforces:
//    – money-impact proof (ledger id OR money_impact=false)
//    – four-eyes approval for critical / money-impacting issues
//
//  Body:
//    resolution_notes             string (min 4)
//    resolved_ledger_transaction_id  uuid (optional)
//    money_impact                 bool (optional)
//    reason                       string (optional, for audit)
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

            // ── Four-eyes gate ─────────────────────────────────
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

            // ── Direct resolve ─────────────────────────────────
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
//  POST /approvals/:approvalId/approve
//  The SECOND admin approves a pending resolution.
//  This is where the actual closeIssue runs — the caller must not be
//  the requester.
// ═══════════════════════════════════════════════════════════════════
router.post(
    '/approvals/:approvalId/approve',
    requirePermission(PERMISSIONS.RECONCILIATION_RESOLVE),
    requireStepUp({ maxAgeSeconds: 300 }),
    assertSameOrigin,
    async (req, res) => {
        try {
            const approvalId = req.params.approvalId;
            if (!isUuid(approvalId)) {
                const e = new Error('Invalid approval id.');
                e.status = 400; e.code = 'INVALID_INPUT'; e.field = 'approvalId';
                throw e;
            }
            const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;

            const approval = await approvals.approve({
                approvalId,
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email
            });

            // Now perform the close. Use the carried fields from the
            // original request.
            const closed = await issuesSvc.closeIssue({
                issueId: approval.issue_id,
                status: 'resolved',
                adminId: req.adminContext.id,          // second admin is the resolver
                adminEmail: req.adminContext.email,
                notes: approval.resolution_notes || `Approved resolution (reason: ${approval.reason})`,
                resolvedLedgerTransactionId: approval.resolved_ledger_transaction_id,
                moneyImpact: approval.money_impact
            });

            recordAdminAction({
                req,
                action: 'reconciliation.resolve.approved',
                targetType: 'reconciliation_approval',
                targetId: approvalId,
                reason: reason || approval.reason,
                after: { issue_id: approval.issue_id, status: 'resolved' },
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                adminRole: req.adminContext.role
            }).catch(() => {});

            return res.json({ success: true, data: { approval, issue: closed } });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  POST /approvals/:approvalId/reject
// ═══════════════════════════════════════════════════════════════════
router.post(
    '/approvals/:approvalId/reject',
    requirePermission(PERMISSIONS.RECONCILIATION_RESOLVE),
    assertSameOrigin,
    async (req, res) => {
        try {
            const approvalId = req.params.approvalId;
            if (!isUuid(approvalId)) {
                const e = new Error('Invalid approval id.');
                e.status = 400; e.code = 'INVALID_INPUT'; e.field = 'approvalId';
                throw e;
            }
            const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;

            const approval = await approvals.reject({
                approvalId,
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                reason
            });

            recordAdminAction({
                req,
                action: 'reconciliation.resolve.rejected',
                targetType: 'reconciliation_approval',
                targetId: approvalId,
                reason,
                adminId: req.adminContext.id,
                adminEmail: req.adminContext.email,
                adminRole: req.adminContext.role
            }).catch(() => {});

            return res.json({ success: true, data: approval });
        } catch (err) { return fail(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  POST /run
//  Manually run one adapter (or all). Step-up required.
//  Body: { service: 'kora' | ... | 'all' }
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
                // Sequential, not parallel — each adapter has its own lock,
                // and hammering every provider at once can trip multiple 429s.
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
//  Recent sweep history.
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/runs',
    requirePermission(PERMISSIONS.RECONCILIATION_READ),
    async (req, res) => {
        try {
            const limit = clampInt(req.query.limit, { min: 1, max: 200, def: 20 });
            const { supabaseAdmin } = require('../../db/supabase');
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
//  The wired services for the filter dropdown.
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