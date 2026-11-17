// routes/transactionFeedbackRoute.js
// ─────────────────────────────────────────────────────────────────
// MilesSpace — user-side transaction feedback.
//
//   POST /api/transactions/:reference/feedback   { rating, comment? }
//   GET  /api/transactions/:reference/feedback
//
// MOUNT ORDER (server.js):
//   app.use('/api/transactions', require('./routes/transactionFeedbackRoute'));
//   app.use('/api/transactions', require('./routes/transactionStatusRoute'));
//   app.use('/api/transactions', require('./routes/transactionRoutes'));
//
// transactionRoutes has a catch-all GET /:id at the bottom. If this
// file is mounted after it, a request for /:reference/feedback gets
// swallowed and the POST/GET here never fire.
//
// GUARANTEES:
//   • userId from req.user.id ONLY. Never from body, query or params.
//   • The reference is resolved against the caller's own rows only,
//     across all eight sources. Missing OR foreign → 404 (identical
//     response — no existence oracle).
//   • Ratings allowed only when the transaction status is terminal
//     (completed / success / failed / refunded / cancelled).
//   • Rating is an integer 1-5. Comment is trimmed, control chars
//     stripped, max 500.
//   • Upsert on (user_id, source_type, source_id). Editing resets
//     review_status to 'new' via the DB trigger (see migration).
//   • Rate limit: 10 / minute / user (in-memory; single-process safe).
//   • No raw error text ever reaches the client. Every 5xx carries a
//     stable `code` and a `request_id`.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

// ─── Rate limiter (10 / min / user) ─────────────────────────────
// Per-process. Replace with Redis if the app is ever multi-instance.
const _hits = new Map();          // userId → [timestamps]
const RATE_MAX = 10;
const RATE_WIN_MS = 60_000;

function takeToken(userId) {
    const now = Date.now();
    const arr = (_hits.get(userId) || []).filter((t) => now - t < RATE_WIN_MS);
    if (arr.length >= RATE_MAX) {
        _hits.set(userId, arr);
        return { allowed: false, retry_after_ms: arr[0] + RATE_WIN_MS - now };
    }
    arr.push(now);
    _hits.set(userId, arr);
    return { allowed: true };
}

setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of _hits) {
        const live = arr.filter((t) => now - t < RATE_WIN_MS);
        if (live.length) _hits.set(k, live);
        else _hits.delete(k);
    }
}, RATE_WIN_MS).unref?.();

// ─── Validation ─────────────────────────────────────────────────
// The reference goes through an allowlist before it can reach any
// query. Letters, digits, underscore, hyphen — everything this
// codebase writes as a reference fits, including UUIDs.
const REF_RE = /^[A-Za-z0-9_\-]{6,80}$/;
const RATING_LABELS = ['Very Bad', 'Bad', 'Average', 'Good', 'Very Good'];
const TERMINAL_STATUSES = new Set([
    'completed', 'success', 'failed', 'refunded', 'cancelled',
]);

function labelFor(rating) {
    return RATING_LABELS[rating - 1] || 'Average';
}

function cleanComment(raw) {
    if (raw === null || raw === undefined) return null;
    // Strip control chars except \n (0x0A) and \t (0x09), then trim.
    let s = String(raw);
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    s = s.trim();
    if (!s) return null;
    if (s.length > 500) s = s.slice(0, 500);
    return s;
}

function newRequestId() {
    return crypto.randomBytes(4).toString('hex');
}

function fail(res, status, code, error, extra = {}) {
    if (res.headersSent) return;
    const rid = newRequestId();
    res.status(status).json({
        success: false,
        code,
        error,
        request_id: rid,
        ...extra,
    });
}

// ─── Ownership resolver ─────────────────────────────────────────
// Searches ONLY the caller's rows, across all eight source tables.
// Returns { source_type, source_id, reference, tx_type, tx_status }
// or null. The caller treats null as 404 — the response is identical
// whether the row does not exist OR belongs to someone else.
//
// Every lookup uses .eq('user_id', userId) and .limit(1) so it can
// never return a foreign row, even if a reference is duplicated.

async function resolveOwnedReference(userId, reference) {
    // 1. transactions — matches either `reference` or legacy `ref`.
    {
        const { data } = await supabaseAdmin
            .from('transactions')
            .select('id, reference, ref, type, status')
            .eq('user_id', userId)
            .or(`reference.eq.${reference},ref.eq.${reference}`)
            .limit(1);
        const row = Array.isArray(data) ? data[0] : null;
        if (row) {
            return {
                source_type: 'transactions',
                source_id: String(row.id), // <--- THIS IS THE FIX
                reference: row.reference || row.ref || reference,
                tx_type: row.type || null,
                tx_status: row.status || null,
            };
        }
    }

    // 2. airtime_transactions
    {
        const { data } = await supabaseAdmin
            .from('airtime_transactions')
            .select('id, reference, status')
            .eq('user_id', userId)
            .eq('reference', reference)
            .limit(1);
        const row = Array.isArray(data) ? data[0] : null;
        if (row) {
            return {
                source_type: 'airtime',
                source_id: String(row.id),
                reference: row.reference,
                tx_type: 'airtime',
                tx_status: row.status || null,
            };
        }
    }

    // 3. bill_payment_transactions
    {
        const { data } = await supabaseAdmin
            .from('bill_payment_transactions')
            .select('id, reference, service_type, status')
            .eq('user_id', userId)
            .eq('reference', reference)
            .limit(1);
        const row = Array.isArray(data) ? data[0] : null;
        if (row) {
            return {
                source_type: 'bill',
                source_id: String(row.id),
                reference: row.reference,
                tx_type: row.service_type || 'bill',
                tx_status: row.status || null,
            };
        }
    }

    // 4. esim_transactions
    {
        const { data } = await supabaseAdmin
            .from('esim_transactions')
            .select('id, reference, status')
            .eq('user_id', userId)
            .eq('reference', reference)
            .limit(1);
        const row = Array.isArray(data) ? data[0] : null;
        if (row) {
            return {
                source_type: 'esim',
                source_id: String(row.id),
                reference: row.reference,
                tx_type: 'esim',
                tx_status: row.status || null,
            };
        }
    }

    // 5. giftcard_transactions
    {
        const { data } = await supabaseAdmin
            .from('giftcard_transactions')
            .select('id, reference, status')
            .eq('user_id', userId)
            .eq('reference', reference)
            .limit(1);
        const row = Array.isArray(data) ? data[0] : null;
        if (row) {
            return {
                source_type: 'giftcard',
                source_id: String(row.id),
                reference: row.reference,
                tx_type: 'giftcard',
                tx_status: row.status || null,
            };
        }
    }

    // 6. marketplace_orders — matched by order_ref.
    {
        const { data } = await supabaseAdmin
            .from('marketplace_orders')
            .select('id, order_ref, status')
            .eq('user_id', userId)
            .eq('order_ref', reference)
            .limit(1);
        const row = Array.isArray(data) ? data[0] : null;
        if (row) {
            return {
                source_type: 'marketplace',
                source_id: String(row.id),
                reference: row.order_ref,
                tx_type: 'marketplace',
                tx_status: row.status || null,
            };
        }
    }

    // 7. boost_orders
    {
        const { data } = await supabaseAdmin
            .from('boost_orders')
            .select('id, reference, status')
            .eq('user_id', userId)
            .eq('reference', reference)
            .limit(1);
        const row = Array.isArray(data) ? data[0] : null;
        if (row) {
            return {
                source_type: 'boost',
                source_id: String(row.id),
                reference: row.reference,
                tx_type: 'boost',
                tx_status: row.status || null,
            };
        }
    }

    // 8. virtual_sms_orders
    {
        const { data } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('id, order_ref, status')
            .eq('user_id', userId)
            .eq('order_ref', reference)
            .limit(1);
        const row = Array.isArray(data) ? data[0] : null;
        if (row) {
            return {
                source_type: 'virtual',
                source_id: String(row.id),
                reference: row.order_ref,
                tx_type: 'virtual',
                tx_status: row.status || null,
            };
        }
    }

    return null;
}
// ─── POST /:reference/feedback ──────────────────────────────────
router.post('/:reference/feedback', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return fail(res, 401, 'AUTH_REQUIRED', 'Authentication required.');
        }

        const reference = String(req.params.reference || '').trim();
        if (!REF_RE.test(reference)) {
            return fail(res, 400, 'INVALID_REFERENCE', 'Invalid transaction reference.');
        }

        const rl = takeToken(userId);
        if (!rl.allowed) {
            res.setHeader('Retry-After', String(Math.ceil(rl.retry_after_ms / 1000)));
            return fail(
                res, 429, 'RATE_LIMITED',
                'Too many requests. Please wait a moment.',
                { retry_after_ms: rl.retry_after_ms }
            );
        }

        const rating = Number(req.body?.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            return fail(res, 422, 'INVALID_RATING', 'Rating must be a whole number from 1 to 5.');
        }
        const comment = cleanComment(req.body?.comment);

        const owned = await resolveOwnedReference(userId, reference);
        if (!owned) {
            return fail(res, 404, 'NOT_FOUND', 'Transaction not found.');
        }

        const st = String(owned.tx_status || '').toLowerCase();
        if (!TERMINAL_STATUSES.has(st)) {
            return fail(
                res, 409, 'NOT_TERMINAL',
                'You can only rate a transaction once it has finished (completed, failed, refunded or cancelled).'
            );
        }

        const nowIso = new Date().toISOString();
        const row = {
            user_id: userId,
            source_type: owned.source_type,
            source_id: owned.source_id,
            reference: owned.reference,
            tx_type: owned.tx_type,
            tx_status: owned.tx_status,
            rating,
            rating_label: labelFor(rating),
            comment,
            review_status: 'new',
            updated_at: nowIso,
        };

        const { error } = await supabaseAdmin
            .from('transaction_feedback')
            .upsert(row, { onConflict: 'user_id,source_type,source_id' });

        if (error) {
            console.error('[TXFB] upsert failed', {
                request_id: res.getHeader?.('X-Request-Id'),
                user_id: userId,
                reference,
                code: error.code,
                message: error.message,
            });
            return fail(res, 500, 'FEEDBACK_SAVE_FAILED', 'Could not save feedback. Please try again.');
        }

        return res.json({ success: true, data: { rating, comment } });
    } catch (err) {
        console.error('[TXFB] POST exception', { message: err?.message });
        return fail(res, 500, 'FEEDBACK_SAVE_FAILED', 'Could not save feedback. Please try again.');
    }
});

// ─── GET /:reference/feedback ───────────────────────────────────
router.get('/:reference/feedback', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return fail(res, 401, 'AUTH_REQUIRED', 'Authentication required.');
        }

        const reference = String(req.params.reference || '').trim();
        if (!REF_RE.test(reference)) {
            return fail(res, 400, 'INVALID_REFERENCE', 'Invalid transaction reference.');
        }

        const owned = await resolveOwnedReference(userId, reference);
        if (!owned) {
            return fail(res, 404, 'NOT_FOUND', 'Transaction not found.');
        }

        const { data, error } = await supabaseAdmin
            .from('transaction_feedback')
            .select('rating, rating_label, comment, created_at, updated_at')
            .eq('user_id', userId)
            .eq('source_type', owned.source_type)
            .eq('source_id', owned.source_id)
            .limit(1);

        if (error) {
            console.error('[TXFB] GET failed', { user_id: userId, reference, message: error.message });
            return fail(res, 500, 'FEEDBACK_READ_FAILED', 'Could not load feedback.');
        }

        const row = Array.isArray(data) ? data[0] : null;
        return res.json({ success: true, data: row || null });
    } catch (err) {
        console.error('[TXFB] GET exception', { message: err?.message });
        return fail(res, 500, 'FEEDBACK_READ_FAILED', 'Could not load feedback.');
    }
});

module.exports = router;
module.exports.resolveOwnedReference = resolveOwnedReference;