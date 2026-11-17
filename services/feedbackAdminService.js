// services/feedbackAdminService.js
// ─────────────────────────────────────────────────────────────────
// MilesSpace — admin feedback service.
//
// LIST, SUMMARY, REVIEW, CSV export. Same conventions as
// services/transactionAdminService.js:
//   • svcErr(code, message, status) for typed errors.
//   • SAFE_500 message table lives in the route file; this service
//     only ever throws svcErr with a stable code.
//   • WAT dates in the response; raw ISO in the DB.
//   • Search is sanitised before any PostgREST .or() (commas, parens,
//     quotes, backslashes, % and _ are stripped).
//   • No N+1: profiles are attached with one .in() query.
//
// The four route files that call into here:
//   GET  /api/admin/feedback
//   GET  /api/admin/feedback/summary
//   PUT  /api/admin/feedback/:id/review
//   GET  /api/admin/feedback/export
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');

const TIMEZONE = 'Africa/Lagos';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const MAX_EXPORT = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Errors ─────────────────────────────────────────────────────
function svcErr(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    Object.assign(e, extra);
    return e;
}

// ─── Param helpers ──────────────────────────────────────────────
function limitOf(v, def = DEFAULT_LIMIT) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : def;
}
function pageOf(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}
function strParam(v, maxLen = 200) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s ? s.slice(0, maxLen) : null;
}
function enumParam(v, allowed) {
    const s = strParam(v, 40);
    if (!s) return null;
    const lc = s.toLowerCase();
    return allowed.has(lc) ? lc : null;
}

/**
 * Convert a date filter to a UTC instant.
 *   'YYYY-MM-DD' for `from` → start of that WAT calendar day (UTC).
 *   'YYYY-MM-DD' for `to`   → end of that WAT calendar day (UTC).
 *   Full ISO                → used as-is.
 * Returns null for invalid input.
 */
function dateToInstant(v, which) {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        if (!y || !m || !d) return null;
        const OFF = 60 * 60 * 1000;
        if (which === 'from') {
            return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - OFF).toISOString();
        }
        return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - OFF).toISOString();
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Remove PostgREST metacharacters from search before it can be
 * interpolated into .or(). The result is safe to wrap in %…%.
 */
function sanitizeSearch(raw) {
    const s = strParam(raw, 100);
    if (!s) return null;
    const cleaned = s.replace(/[,()"\\%_]/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned || null;
}
function escapeLike(s) {
    return String(s || '').replace(/[%_\\]/g, (m) => '\\' + m);
}

const REVIEW_STATUSES = new Set(['new', 'reviewed', 'actioned']);
const SOURCE_TYPES = new Set([
    'transactions', 'giftcard', 'esim', 'airtime',
    'bill', 'marketplace', 'boost', 'virtual',
]);

// Column list shared by LIST and CSV. Never selects admin-only
// columns it doesn't render; the reviewer fields ARE included because
// the drawer needs them.
const FEEDBACK_COLUMNS =
    'id, user_id, source_type, source_id, reference, tx_type, tx_status, ' +
    'rating, rating_label, comment, review_status, admin_note, ' +
    'reviewed_by, reviewed_at, created_at, updated_at';

// ─── LIST ───────────────────────────────────────────────────────
async function listFeedback(query = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    const rating = parseInt(query.rating, 10);
    const reviewStatus = enumParam(query.review_status, REVIEW_STATUSES);
    const type = enumParam(query.type, SOURCE_TYPES);
    const fromIso = dateToInstant(strParam(query.from), 'from');
    const toIso = dateToInstant(strParam(query.to), 'to');
    const search = sanitizeSearch(query.search);

    let q = supabaseAdmin
        .from('transaction_feedback')
        .select(FEEDBACK_COLUMNS, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (Number.isFinite(rating) && rating >= 1 && rating <= 5) {
        q = q.eq('rating', rating);
    }
    if (reviewStatus) q = q.eq('review_status', reviewStatus);
    if (type)         q = q.eq('source_type', type);
    if (fromIso)      q = q.gte('created_at', fromIso);
    if (toIso)        q = q.lte('created_at', toIso);

    if (search) {
        const e = escapeLike(search);
        q = q.or(`reference.ilike.%${e}%,comment.ilike.%${e}%`);
    }

    const { data, error, count } = await q;
    if (error) {
        throw svcErr('FB_LIST_FAILED', 'Failed to load feedback.', 500);
    }

    // One profiles query — no N+1.
    const userIds = [...new Set((data || []).map((r) => r.user_id).filter(Boolean))];
    const byId = {};
    if (userIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email')
            .in('id', userIds);
        for (const p of profiles || []) byId[p.id] = p;
    }

    return {
        feedback: (data || []).map((r) => ({
            ...r,
            user: byId[r.user_id] || { username: null, email: null },
        })),
        count: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
        timezone: TIMEZONE,
    };
}

// ─── SUMMARY ────────────────────────────────────────────────────
async function getSummary(query = {}) {
    const fromIso = dateToInstant(strParam(query.from), 'from');
    const toIso = dateToInstant(strParam(query.to), 'to');

    const applyBase = (q) => {
        if (fromIso) q = q.gte('created_at', fromIso);
        if (toIso)   q = q.lte('created_at', toIso);
        return q;
    };

    // Per-rating counts + total, in one parallel batch.
    const buckets = await Promise.all([1, 2, 3, 4, 5].map(async (r) => {
        let q = supabaseAdmin
            .from('transaction_feedback')
            .select('id', { count: 'exact', head: true })
            .eq('rating', r);
        q = applyBase(q);
        const { count, error } = await q;
        if (error) throw svcErr('FB_SUMMARY_FAILED', 'Failed to compute summary.', 500);
        return { rating: r, count: count || 0 };
    }));

    const total = buckets.reduce((s, b) => s + b.count, 0);
    const weighted = buckets.reduce((s, b) => s + b.rating * b.count, 0);
    const average = total > 0 ? +(weighted / total).toFixed(2) : null;

    // Low-rating (1-2) that still needs review.
    let lowQ = supabaseAdmin
        .from('transaction_feedback')
        .select('id', { count: 'exact', head: true })
        .in('rating', [1, 2])
        .eq('review_status', 'new');
    lowQ = applyBase(lowQ);
    const lowRes = await lowQ;
    if (lowRes.error) throw svcErr('FB_SUMMARY_FAILED', 'Failed to compute summary.', 500);

    // Small strip: the 10 most recent low-rating 'new' rows, with
    // reference + user so a caller can render a "needs attention"
    // list without a second request.
    let lowListQ = supabaseAdmin
        .from('transaction_feedback')
        .select('id, reference, user_id, rating, rating_label, created_at')
        .in('rating', [1, 2])
        .eq('review_status', 'new')
        .order('created_at', { ascending: false })
        .limit(10);
    lowListQ = applyBase(lowListQ);
    const lowListRes = await lowListQ;
    const lowNeedsReview = lowListRes.error ? [] : (lowListRes.data || []);

    // Per-service average.
    let svcQ = supabaseAdmin
        .from('transaction_feedback')
        .select('source_type, rating');
    svcQ = applyBase(svcQ);
    const { data: svcRows, error: svcErr2 } = await svcQ;
    if (svcErr2) throw svcErr('FB_SUMMARY_FAILED', 'Failed to compute summary.', 500);

    const agg = {};
    for (const row of svcRows || []) {
        const k = row.source_type;
        if (!agg[k]) agg[k] = { count: 0, sum: 0 };
        agg[k].count += 1;
        agg[k].sum += Number(row.rating) || 0;
    }
    const byService = Object.keys(agg).map((k) => ({
        source_type: k,
        count: agg[k].count,
        average: agg[k].count ? +(agg[k].sum / agg[k].count).toFixed(2) : null,
    })).sort((a, b) => b.count - a.count);

    return {
        average_rating: average,
        total,
        per_rating: buckets.reduce((o, b) => (o[b.rating] = b.count, o), {}),
        low_needs_review: lowRes.count || 0,
        low_needs_review_list: lowNeedsReview,
        by_service: byService,
        from: fromIso,
        to: toIso,
        timezone: TIMEZONE,
    };
}

// ─── REVIEW ─────────────────────────────────────────────────────
// Compare-and-set on review_status. Audit is written BEFORE the
// update; if the audit fails, the update does not happen. Editing a
// rating (which resets the status via the trigger) invalidates the
// CAS — the caller gets 409 and reloads.
async function reviewFeedback({ id, review_status, admin_note, reason, ctx }) {
    if (!UUID_RE.test(String(id || ''))) {
        throw svcErr('FB_NOT_FOUND', 'Invalid feedback id.', 400);
    }

    const next = String(review_status || '').toLowerCase();
    if (!REVIEW_STATUSES.has(next)) {
        throw svcErr('FB_INVALID_STATUS', 'Invalid review status.', 422);
    }

    const trimmedNote = String(admin_note || '').trim().slice(0, 1000);
    if (next === 'actioned' && trimmedNote.length < 4) {
        throw svcErr(
            'FB_REASON_REQUIRED',
            'A note of at least 4 characters is required when marking as "actioned".',
            422
        );
    }

    const auditReason = String(reason || '').trim();
    if (auditReason.length < 4) {
        throw svcErr('FB_REASON_REQUIRED', 'A reason of at least 4 characters is required.', 422);
    }

    const { data: existing, error: exErr } = await supabaseAdmin
        .from('transaction_feedback')
        .select('id, review_status')
        .eq('id', id)
        .maybeSingle();
    if (exErr) throw svcErr('FB_LOOKUP_FAILED', 'Failed to load feedback.', 500);
    if (!existing) throw svcErr('FB_NOT_FOUND', 'Feedback not found.', 404);

    const current = existing.review_status;

    // Audit BEFORE the update so an audit failure aborts the write.
    const { error: auditErr } = await supabaseAdmin
        .from('admin_audit_logs')
        .insert({
            admin_id: ctx.adminId || null,
            admin_email: ctx.adminEmail || null,
            action: 'transaction.feedback_review',
            target_type: 'transaction_feedback',
            target_id: id,
            before: { review_status: current },
            after: { review_status: next, admin_note: trimmedNote || null },
            reason: auditReason.slice(0, 500),
            ip_address: ctx.ip || null,
            user_agent: ctx.userAgent || null,
            request_id: ctx.requestId || null,
            created_at: new Date().toISOString(),
        });

    if (auditErr) {
        console.error('[FB] audit insert failed', { id, message: auditErr.message });
        throw svcErr(
            'AUDIT_INSERT_FAILED',
            'Could not record the review. No change was applied.',
            500
        );
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error: upErr } = await supabaseAdmin
        .from('transaction_feedback')
        .update({
            review_status: next,
            admin_note: trimmedNote || null,
            reviewed_by: ctx.adminId || null,
            reviewed_at: nowIso,
            updated_at: nowIso,
        })
        .eq('id', id)
        .eq('review_status', current)
        .select('id, review_status, admin_note, reviewed_at')
        .maybeSingle();

    if (upErr) throw svcErr('FB_UPDATE_FAILED', 'Could not update feedback.', 500);
    if (!updated) {
        throw svcErr(
            'FB_CHANGED',
            'Feedback was modified by another admin. Reload and try again.',
            409,
            { current_status: current }
        );
    }

    return { feedback: updated };
}

// ─── CSV ────────────────────────────────────────────────────────
// Same shape as the transactions CSV: BOM, formula-injection guard on
// text columns, WAT dates, row cap.
function csvCell(v, isText) {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (isText && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
}

async function exportCsv(query = {}) {
    const fromIso = dateToInstant(strParam(query.from), 'from');
    const toIso = dateToInstant(strParam(query.to), 'to');
    const rating = parseInt(query.rating, 10);
    const reviewStatus = enumParam(query.review_status, REVIEW_STATUSES);
    const type = enumParam(query.type, SOURCE_TYPES);
    const search = sanitizeSearch(query.search);

    const buildBase = () => {
        let q = supabaseAdmin
            .from('transaction_feedback')
            .select(
                'id, user_id, source_type, source_id, reference, tx_type, tx_status, ' +
                'rating, rating_label, comment, review_status, admin_note, created_at'
            )
            .order('created_at', { ascending: false });

        if (Number.isFinite(rating) && rating >= 1 && rating <= 5) q = q.eq('rating', rating);
        if (reviewStatus) q = q.eq('review_status', reviewStatus);
        if (type)         q = q.eq('source_type', type);
        if (fromIso)      q = q.gte('created_at', fromIso);
        if (toIso)        q = q.lte('created_at', toIso);
        if (search) {
            const e = escapeLike(search);
            q = q.or(`reference.ilike.%${e}%,comment.ilike.%${e}%`);
        }
        return q;
    };

    const rows = [];
    let offset = 0;
    const CHUNK = 1000;
    let truncated = false;
    while (offset < MAX_EXPORT) {
        const lim = Math.min(CHUNK, MAX_EXPORT - offset);
        const { data, error } = await buildBase().range(offset, offset + lim - 1);
        if (error) throw svcErr('FB_EXPORT_FAILED', 'Failed to export feedback.', 500);
        if (!data || !data.length) break;
        rows.push(...data);
        if (data.length < lim) break;
        offset += lim;
        if (offset >= MAX_EXPORT && data.length === lim) truncated = true;
    }

    // One profile lookup, no N+1.
    const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
    const byId = {};
    if (userIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email')
            .in('id', userIds);
        for (const p of profiles || []) byId[p.id] = p;
    }

    const header = [
        'Feedback ID', 'Reference', 'Source', 'Type', 'Status',
        'Customer', 'Email', 'Rating', 'Label', 'Comment',
        'Review Status', 'Admin Note', 'Created (WAT)',
    ];
    const textCols = [
        true, true, true, true, true,
        true, true, false, true, true,
        true, true, true,
    ];

    const fmtDate = (iso) => {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return new Intl.DateTimeFormat('en-GB', {
            timeZone: TIMEZONE,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
        }).format(d);
    };

    const lines = [header.map((h, i) => csvCell(h, textCols[i])).join(',')];
    for (const r of rows) {
        const u = byId[r.user_id] || {};
        lines.push([
            r.id,
            r.reference,
            r.source_type,
            r.tx_type || '',
            r.tx_status || '',
            u.username || '',
            u.email || '',
            r.rating,
            r.rating_label,
            r.comment || '',
            r.review_status,
            r.admin_note || '',
            fmtDate(r.created_at),
        ].map((v, i) => csvCell(v, textCols[i])).join(','));
    }

    return {
        csv: '\uFEFF' + lines.join('\n'),
        rowCount: rows.length,
        truncated,
        timezone: TIMEZONE,
    };
}

module.exports = {
    listFeedback,
    getSummary,
    reviewFeedback,
    exportCsv,
};