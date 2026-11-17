'use strict';

// routes/admin/refundAdminRoutes.js
// ─────────────────────────────────────────────────────────────────
// Admin Refunds — ROUTES.
//
// Change in this revision:
//   GET /refunds now joins user + original transaction in two
//   batched queries so the UI can show Customer and Original TX.
// ─────────────────────────────────────────────────────────────────

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');
const { requireStepUpAuth } = require('../../middleware/adminStepUp');
const refundSvc = require('../../services/refundService');
const { supabaseAdmin } = require('../../db/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Helpers ────────────────────────────────────────────────────

function sendOk(res, payload) { if (!res.headersSent) res.json({ success: true, ...payload }); }
function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'REFUND_ADMIN_ERROR';
    const message = err?.message || 'Refund request failed';
    
    const body = { success: false, code, error: message, request_id: err?.request_id || null };
    if (err?.remaining_amount) body.remaining_amount = err.remaining_amount;
    if (err?.ledger_transaction_id) body.ledger_transaction_id = err.ledger_transaction_id;

    if (status >= 500) console.error('[ADMIN REFUND]', code, message);
    res.status(status).json(body);
}

function adminCtx(req) {
    return {
        adminId: req.adminContext?.id,
        adminEmail: req.adminContext?.email,
        role: req.adminContext?.role,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.requestId
    };
}

function attachRequestId(req, res, next) {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
}

function requireIdempotencyKey(req) {
    const key = req.headers['idempotency-key'];
    if (!key || key.length < 8 || key.length > 200) {
        throw Object.assign(new Error('A valid Idempotency-Key header is required.'), { status: 422, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    return key;
}

function addDecimalStrings(a, b) {
    const parse = (s) => {
        const str = String(s ?? '0').trim();
        const neg = str.startsWith('-');
        const clean = str.replace('-', '');
        const [intPart, fracPart = ''] = clean.split('.');
        const intNum = BigInt(intPart || '0');
        const fracPadded = (fracPart + '00').slice(0, 2);
        const fracNum = BigInt(fracPadded);
        const totalMinor = intNum * 100n + fracNum;
        return neg ? -totalMinor : totalMinor;
    };
    const totalMinor = parse(a) + parse(b);
    const neg = totalMinor < 0n;
    const abs = neg ? -totalMinor : totalMinor;
    const whole = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, '0');
    return `${neg ? '-' : ''}${whole.toString()}.${frac}`;
}

router.use('/refunds', attachRequestId);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/refunds
// ═════════════════════════════════════════════════════════════════

router.get(
    '/refunds',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
            const offset = (page - 1) * limit;

            let q = supabaseAdmin
                .from('refunds')
                .select(
                    'id, original_transaction_id, refund_transaction_id, user_id, ' +
                    'refund_type, amount, currency, reason, status, ' +
                    'provider, provider_refund_ref, requested_by, requester_email, approved_by, ' +
                    'rejection_reason, failure_reason, created_at, updated_at, approved_at, ' +
                    'completed_at, failed_at',
                    { count: 'exact' }
                )
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1);

            if (req.query.status && req.query.status !== 'all') {
                q = q.eq('status', String(req.query.status).toUpperCase());
            }
            if (req.query.refund_type && req.query.refund_type !== 'all') {
                q = q.eq('refund_type', String(req.query.refund_type).toLowerCase());
            }
            if (req.query.currency && req.query.currency !== 'all') {
                q = q.eq('currency', String(req.query.currency).toUpperCase());
            }
            if (req.query.from) {
                const d = new Date(req.query.from);
                if (!isNaN(d.getTime())) q = q.gte('created_at', d.toISOString());
            }
            if (req.query.to) {
                const d = new Date(req.query.to);
                if (!isNaN(d.getTime())) {
                    d.setUTCHours(23, 59, 59, 999);
                    q = q.lte('created_at', d.toISOString());
                }
            }

            const { data, error, count } = await q;
            if (error) throw error;

            const rows = data || [];

            // ─── Batched joins for users + original transactions ───
            const userIds = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
            const txIds   = [...new Set(rows.map(r => r.original_transaction_id).filter(Boolean))];

            const profilesById = {};
            const txById = {};

            const [profilesRes, txRes] = await Promise.all([
                userIds.length
                    ? supabaseAdmin.from('profiles').select('id, username, email').in('id', userIds)
                    : Promise.resolve({ data: [] }),
                txIds.length
                    ? supabaseAdmin.from('transactions').select('id, reference, ref, type, status, amount, currency, provider, provider_reference').in('id', txIds)
                    : Promise.resolve({ data: [] })
            ]);

            for (const p of profilesRes.data || []) profilesById[p.id] = p;
            for (const t of txRes.data || []) txById[t.id] = t;

            const enriched = rows.map(r => {
                const p = profilesById[r.user_id] || null;
                const t = txById[r.original_transaction_id] || null;
                return {
                    ...r,
                    user: p ? { id: p.id, username: p.username, email: p.email } : null,
                    original_transaction: t ? {
                        id: t.id,
                        reference: t.reference || t.ref || null,
                        type: t.type,
                        status: t.status,
                        amount: t.amount != null ? String(t.amount) : null,
                        currency: t.currency,
                        provider: t.provider || null,
                        provider_reference: t.provider_reference || null
                    } : null
                };
            });

            sendOk(res, {
                refunds: enriched,
                count: count || 0,
                page,
                limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/refunds/summary
// ═════════════════════════════════════════════════════════════════

router.get(
    '/refunds/summary',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const fromIso = req.query.from ? new Date(req.query.from).toISOString() : null;
            const toIso = req.query.to
                ? (() => { const d = new Date(req.query.to); d.setUTCHours(23, 59, 59, 999); return d.toISOString(); })()
                : null;

            const emptyShape = {
                total: 0, requested: 0, pending_approval: 0, approved: 0,
                processing: 0, completed: 0, failed: 0, rejected: 0,
                cancelled: 0, expired: 0,
                amounts: { NGN: {}, USD: {} },
                oldest_pending_seconds: 0, over_sla_count: 0, source: 'rpc',
            };

            const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc(
                'admin_refund_summary',
                { p_from: fromIso, p_to: toIso }
            );

            const rpcMissing =
                rpcErr &&
                (rpcErr.code === 'PGRST202' ||
                 rpcErr.code === '42883' ||
                 /function .* does not exist/i.test(rpcErr.message || ''));

            if (!rpcMissing && rpcErr) {
                console.error('[REFUND SUMMARY] RPC error:', rpcErr.code, rpcErr.message);
                throw Object.assign(
                    new Error('Failed to load refund summary.'),
                    { status: 500, code: 'REFUND_SUMMARY_FAILED' }
                );
            }

            if (!rpcMissing && rpcData) {
                const summary = { ...emptyShape, amounts: { NGN: {}, USD: {} } };
                for (const [statusKey, payload] of Object.entries(rpcData || {})) {
                    const lower = String(statusKey).toLowerCase();
                    const count = Number(payload?.count) || 0;
                    summary.total += count;
                    if (Object.prototype.hasOwnProperty.call(summary, lower)) {
                        summary[lower] = count;
                    }
                    const amounts = payload?.amounts || {};
                    for (const [ccy, amt] of Object.entries(amounts)) {
                        const upperCcy = String(ccy).toUpperCase();
                        if (!summary.amounts[upperCcy]) summary.amounts[upperCcy] = {};
                        summary.amounts[upperCcy][String(statusKey).toUpperCase()] =
                            typeof amt === 'number' ? String(amt) : String(amt ?? '0');
                    }
                }
                try {
                    const { data: oldestRow } = await supabaseAdmin
                        .from('refunds').select('created_at')
                        .eq('status', 'PENDING_APPROVAL')
                        .order('created_at', { ascending: true })
                        .limit(1).maybeSingle();
                    if (oldestRow?.created_at) {
                        summary.oldest_pending_seconds = Math.max(0, Math.floor((Date.now() - new Date(oldestRow.created_at).getTime()) / 1000));
                    }
                    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
                    const { count: overSlaCount } = await supabaseAdmin
                        .from('refunds').select('id', { count: 'exact', head: true })
                        .eq('status', 'PENDING_APPROVAL')
                        .lt('created_at', fourHoursAgo);
                    summary.over_sla_count = overSlaCount || 0;
                } catch (_) {}
                summary.source = 'rpc';
                return sendOk(res, { summary });
            }

            // Fallback: JS aggregation
            const summary = { ...emptyShape, amounts: { NGN: {}, USD: {} }, source: 'fallback' };
            const CHUNK = 1000;
            const MAX_ROWS = 100_000;
            let offset = 0;
            let truncated = false;

            while (offset < MAX_ROWS) {
                const { data: rows, error } = await supabaseAdmin
                    .from('refunds')
                    .select('id, status, currency, amount, created_at')
                    .gte('created_at', fromIso || '1970-01-01')
                    .lte('created_at', toIso || '2099-12-31')
                    .order('created_at', { ascending: false })
                    .range(offset, offset + CHUNK - 1);

                if (error) {
                    console.error('[REFUND SUMMARY] fallback read error:', error.message);
                    throw Object.assign(
                        new Error('Failed to load refund summary.'),
                        { status: 500, code: 'REFUND_SUMMARY_FAILED' }
                    );
                }
                if (!rows || rows.length === 0) break;

                for (const r of rows) {
                    const lower = String(r.status || '').toLowerCase();
                    summary.total += 1;
                    if (Object.prototype.hasOwnProperty.call(summary, lower)) {
                        summary[lower] += 1;
                    }
                    const ccy = String(r.currency || '').toUpperCase();
                    if (!['NGN', 'USD'].includes(ccy)) continue;
                    const key = String(r.status || '').toUpperCase();
                    if (!summary.amounts[ccy]) summary.amounts[ccy] = {};
                    const prevStr = String(summary.amounts[ccy][key] || '0');
                    summary.amounts[ccy][key] = addDecimalStrings(prevStr, String(r.amount ?? '0'));
                    if (r.status === 'PENDING_APPROVAL') {
                        const ageSec = Math.max(0, Math.floor((Date.now() - new Date(r.created_at).getTime()) / 1000));
                        if (ageSec > summary.oldest_pending_seconds) summary.oldest_pending_seconds = ageSec;
                        if (ageSec > 4 * 60 * 60) summary.over_sla_count += 1;
                    }
                }
                if (rows.length < CHUNK) break;
                offset += CHUNK;
                if (offset >= MAX_ROWS) { truncated = true; break; }
            }
            if (truncated) {
                summary.truncated = true;
                summary.note = `Fallback capped at ${MAX_ROWS} rows.`;
            }
            return sendOk(res, { summary });
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/admin/refunds/:id
// ═════════════════════════════════════════════════════════════════

router.get(
    '/refunds/:id',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const refund = await refundSvc.getRefund(req.params.id);

            let user = null, originalTx = null, refundTx = null, audit = [], approvals = [];

            if (refund.user_id) {
                const { data } = await supabaseAdmin.from('profiles').select('id, username, email').eq('id', refund.user_id).maybeSingle();
                user = data || null;
            }
            if (refund.original_transaction_id) {
                const { data } = await supabaseAdmin.from('transactions').select('id, reference, ref, type, status, amount, currency, provider, provider_reference').eq('id', refund.original_transaction_id).maybeSingle();
                originalTx = data ? { ...data, reference: data.reference || data.ref } : null;
            }
            if (refund.refund_transaction_id) {
                const { data } = await supabaseAdmin.from('transactions').select('id, reference, ref, type, status, amount, currency').eq('id', refund.refund_transaction_id).maybeSingle();
                refundTx = data || null;
            }
            const { data: apprs } = await supabaseAdmin.from('refund_approvals').select('*').eq('refund_id', refund.id);
            approvals = apprs || [];

            const { data: audits } = await supabaseAdmin.from('admin_audit_logs').select('*').eq('target_type', 'refund').eq('target_id', refund.id).order('created_at', { ascending: false }).limit(50);
            audit = audits || [];

            const approvalsCount = approvals.filter(a => a.decision === 'approve').length;
            const canApprove = (refund.status === 'PENDING_APPROVAL' && refund.requested_by !== req.adminContext.id);

            sendOk(res, {
                refund: { ...refund, amount: refund.amount != null ? String(refund.amount) : null },
                user,
                original_transaction: originalTx,
                refund_transaction: refundTx,
                approvals,
                audit,
                approval_state: {
                    approvals_count: approvalsCount,
                    approvals_required: refund.approvals_required,
                    expires_at: refund.expires_at,
                    can_approve: canApprove,
                    blocked_reason: refund.requested_by === req.adminContext.id ? 'Cannot approve your own request.' : null
                }
            });
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  POST /api/admin/refunds
// ═════════════════════════════════════════════════════════════════

router.post(
    '/refunds',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res) => {
        try {
            const { transaction_id, amount, reason, refund_type } = req.body || {};
            if (!UUID_RE.test(String(transaction_id || ''))) {
                throw Object.assign(new Error('Valid transaction_id is required.'), { status: 422, code: 'INVALID_TRANSACTION_ID' });
            }
            if (!refund_type || !['wallet', 'reversal', 'provider'].includes(refund_type)) {
                throw Object.assign(new Error('Invalid refund_type.'), { status: 422, code: 'INVALID_REFUND_TYPE' });
            }
            const idem = requireIdempotencyKey(req);

            const result = await refundSvc.createRefundRequest({
                transactionId: transaction_id,
                amount, reason,
                refundType: refund_type,
                ctx: adminCtx(req),
                idempotencyKey: idem
            });

            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

// ═════════════════════════════════════════════════════════════════
//  POST /api/admin/refunds/:id/approve | reject | cancel | retry
// ═════════════════════════════════════════════════════════════════

router.post(
    '/refunds/:id/approve',
    requirePermission(PERMISSIONS.REFUNDS_APPROVE || PERMISSIONS.TRANSACTIONS_REFUND),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) throw Object.assign(new Error('Reason required.'), { status: 422, code: 'REASON_REQUIRED' });
            const idem = requireIdempotencyKey(req);
            const result = await refundSvc.approveRefund({
                refundId: req.params.id,
                ctx: adminCtx(req),
                reason,
                idempotencyKey: idem
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/refunds/:id/reject',
    requirePermission(PERMISSIONS.REFUNDS_APPROVE || PERMISSIONS.TRANSACTIONS_REFUND),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) throw Object.assign(new Error('Reason required.'), { status: 422, code: 'REASON_REQUIRED' });
            const result = await refundSvc.rejectRefund({
                refundId: req.params.id,
                ctx: adminCtx(req),
                reason
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/refunds/:id/cancel',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            const reason = String(req.body?.reason || '').trim();
            if (reason.length < 4) throw Object.assign(new Error('Reason required.'), { status: 422, code: 'REASON_REQUIRED' });
            const result = await refundSvc.cancelRefund({
                refundId: req.params.id,
                ctx: adminCtx(req),
                reason
            });
            sendOk(res, result);
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/refunds/:id/retry',
    requirePermission(PERMISSIONS.TRANSACTIONS_REFUND),
    requireStepUpAuth({ maxAgeSeconds: 300 }),
    async (req, res, next) => {
        if (!UUID_RE.test(String(req.params.id || ''))) return next();
        try {
            throw Object.assign(new Error('Provider retries are not configured.'), { status: 503, code: 'NOT_IMPLEMENTED' });
        } catch (err) { sendErr(res, err); }
    }
);

module.exports = router;