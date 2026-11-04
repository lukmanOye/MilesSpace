// routes/transactionStatusRoute.js
// ─────────────────────────────────────────────────────────────────
// Public, user-scoped status endpoints.
//
//   GET  /api/transactions/:id/status     read-only, no provider call
//   POST /api/transactions/:id/check      triggers one provider verify
//
// Both require auth. Both enforce ownership. Neither returns
// provider-internal fields, issue ids, or ledger details.
//
// Mount (in server.js, BEFORE the general transactionRoutes):
//   app.use('/api/transactions', require('./routes/transactionStatusRoute'));
//   app.use('/api/transactions', require('./routes/transactionRoutes'));
//
// Why mount order matters:
//   transactionRoutes has a catch-all GET /:id at the end of its
//   stack. If transactionRoutes runs first, a request for
//   /api/transactions/:id/status is caught by its /:id handler and
//   the status endpoint never fires. Mounting the status router
//   first ensures /status and /check resolve to their own handlers.
//
// This file does NOT:
//   • touch the database directly (all DB access is in
//     services/userStatusService.js)
//   • call any provider (all provider access is in
//     reconciliation/engine.js → adapters)
//   • move money (that's the engine's job, and it is idempotent)
//
// It does only three things:
//   1. Validate the request (id shape, size, throttle).
//   2. Delegate to userStatusService.
//   3. Map errors to user-safe JSON.
// ─────────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const router  = express.Router();

const { authMiddleware } = require('../middleware/auth');

// Lazy-require the service so a missing services/userStatusService.js
// doesn't crash this router at load time — it just means both
// endpoints return 503 with a clear message.
let _userStatus = null;
function userStatus() {
    if (_userStatus) return _userStatus;
    try {
        _userStatus = require('../services/userStatusService');
    } catch (e) {
        const err = new Error('Status service is not available on this server.');
        err.status = 503;
        err.code = 'STATUS_SERVICE_UNAVAILABLE';
        err.cause = e.message;
        throw err;
    }
    return _userStatus;
}

// ─── GET /:id/status ────────────────────────────────────────────
// Read-only. No provider call. Returns the current user-safe status
// of the transaction. Idempotent — safe to call as often as the page
// wants.
router.get('/:id/status', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({
                success: false,
                code: 'AUTH_REQUIRED',
                error: 'Authentication required.'
            });
        }

        const id = String(req.params.id || '').trim();
        if (!id || id.length > 200) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_ID',
                error: 'Invalid transaction id.'
            });
        }

        const svc = userStatus();
        const status = await svc.getStatus({ transactionId: id, userId });

        if (!status) {
            return res.status(404).json({
                success: false,
                code: 'TRANSACTION_NOT_FOUND',
                error: 'Transaction not found.'
            });
        }

        return res.json({ success: true, data: status });
    } catch (err) {
        return handleError(res, err, 'STATUS_FAILED');
    }
});

// ─── POST /:id/check ────────────────────────────────────────────
// Triggers ONE provider re-verify, throttled to 1 per 30 seconds per
// user. Delegates to the reconciliation engine via userStatusService
// so the same idempotent settle path is used — a user can trigger a
// check, but never a credit.
router.post('/:id/check', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({
                success: false,
                code: 'AUTH_REQUIRED',
                error: 'Authentication required.'
            });
        }

        const id = String(req.params.id || '').trim();
        if (!id || id.length > 200) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_ID',
                error: 'Invalid transaction id.'
            });
        }

        const svc = userStatus();

        // ── 1. Throttle ─────────────────────────────────────────
        // Enforce BEFORE the ownership check, so a user cannot use
        // response time as an oracle for "does this transaction
        // exist and belong to me". Both 404 and 429 feel similar.
        const throttle = await svc.checkThrottle(userId);
        if (!throttle.allowed) {
            return res.status(429).json({
                success: false,
                code: 'CHECK_THROTTLED',
                error: 'Please wait before checking again.',
                retry_after_ms: throttle.retryAfterMs
            });
        }

        // ── 2. Ownership + existence ────────────────────────────
        // Do this BEFORE claiming the throttle so we don't penalize
        // the user for tapping "Check status" on a row that doesn't
        // exist (e.g. it was deleted, or they tapped a stale row).
        const pre = await svc.getStatus({ transactionId: id, userId });
        if (!pre) {
            return res.status(404).json({
                success: false,
                code: 'TRANSACTION_NOT_FOUND',
                error: 'Transaction not found.'
            });
        }

        // ── 3. Claim the throttle ───────────────────────────────
        // Claim BEFORE hitting the provider, so a provider call that
        // hangs still counts toward the throttle window. Otherwise a
        // slow provider becomes indistinguishable from a spam attack.
        await svc.recordCheck(userId, id);

        // ── 4. Run the check ────────────────────────────────────
        const ctx = {
            adminId: null,
            adminEmail: 'user:check-status',
            userId
        };

        const result = await svc.runUserCheck({
            transactionId: id,
            userId,
            ctx
        });

        // ── 5. Respond ──────────────────────────────────────────
        // `result.status` is the user-safe shape. `result.check` is
        // metadata the frontend can use to display "you can check
        // again in 30s" without a separate round-trip.
        return res.json({
            success: true,
            data: result.status,
            check: {
                ran: !!result.check_ran,
                reason: result.reason || null,
                retry_after_ms: svc.THROTTLE_MS
            }
        });
    } catch (err) {
        return handleError(res, err, 'CHECK_FAILED');
    }
});

// ─── Error handler ──────────────────────────────────────────────
// Maps the error codes thrown by userStatusService (and the engine)
// to clean HTTP responses. Anything 500-class is logged and its
// message is replaced with a generic one so we never leak internal
// state to the user.
function handleError(res, err, fallbackCode) {
    const status = Number.isFinite(err?.status) ? err.status : 500;
    const code = err?.code || fallbackCode;

    if (status >= 500) {
        console.error(`[TX STATUS] ${code}: ${err?.message || err}`);
    }

    if (res.headersSent) return;

    // Specific codes that have user-meaningful messages. Everything
    // else gets the fallback for status >= 500 (generic) or the
    // original message for status < 500 (validation, 404, 429, 409).
    const userMessage = (() => {
        if (status >= 500) {
            if (code === 'STATUS_SERVICE_UNAVAILABLE') return 'Status check is temporarily unavailable.';
            if (code === 'CHECK_UNAVAILABLE')          return 'Status check is temporarily unavailable.';
            return 'Something went wrong. Please try again in a moment.';
        }
        return err?.message || 'Request failed.';
    })();

    return res.status(status).json({
        success: false,
        code,
        error: userMessage,
        ...(err?.retry_after_ms ? { retry_after_ms: err.retry_after_ms } : {}),
        ...(err?.retryAfterMs    ? { retry_after_ms: err.retryAfterMs }    : {})
    });
}

module.exports = router;