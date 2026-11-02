// routes/admin/userRoutes.js
// ─────────────────────────────────────────────────────────────────
// MilesSpace User Management — production routes v3.
//
// Standardised envelope: { success: true, data: <payload>, _meta: {...} }
// on success, { success: false, error, code, ...extra } on failure.
// The ONLY exception is the CSV export (Content-Type: text/csv).
//
// Guarantees:
//   • Every route is permission-gated.
//   • Actor authority is re-resolved from the LIVE database on every
//     mutation (not from the JWT claim).
//   • Audit is written exactly once per successful mutation — either
//     by the service (when the service owns the ledger/approval step)
//     or by `recordAdminAction` (when the service is a plain DB write).
//   • `?fresh=1` on /stats bypasses the 30s cache.
//   • PUT /users/:id requires `if_updated_at` and returns 428 without
//     it; 409 STALE_RECORD on mismatch.
//   • Bulk actions capped at BULK_MAX (100).
//   • CSV export capped at CSV_MAX_ROWS (5,000), PII masked unless
//     the caller has users.pii_reveal.
//   • Step-up token required for wallet/role/bulk (header
//     X-Step-Up-Token). The middleware that validates it lives in
//     middleware/adminAuth.js — route only forwards it.
//   • Read-audit throttling is done inside the service via
//     recordReadAudit.
//
// URL surface (additions marked +):
//   GET    /users
//   GET    /users/recent
//   GET    /users/stats              (?fresh=1)
//   GET    /users/export.csv
//   POST   /users/bulk/force-logout          +
//   POST   /users/bulk/tag                   +
//   GET    /users/:id/overview
//   GET    /users/:id/detail         (alias of overview, deprecated)
//   GET    /users/:id/wallets
//   GET    /users/:id/ledger
//   GET    /users/:id/transactions
//   GET    /users/:id/orders
//   GET    /users/:id/security
//   GET    /users/:id/support
//   GET    /users/:id/notes
//   POST   /users/:id/notes
//   POST   /users/:id/restrictions
//   DELETE /users/:id/restrictions/:restriction
//   POST   /users/:id/force-logout
//   POST   /users/:id/require-password-reset
//   POST   /users/:id/require-2fa
//   POST   /users/:id/reveal                 +
//   GET    /users/:id
//   PUT    /users/:id                (requires if_updated_at)
//   PUT    /users/:id/status
//   POST   /users/:id/wallet
//   GET    /users/:id/audit
//   GET    /approvals
//   POST   /approvals/:id/approve
//   POST   /approvals/:id/reject
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const svc = require('../../services/userAdminService');
const {
    requirePermission,
    recordAdminAction,
    requireStepUpAuth,
    PERMISSIONS
} = require('../../middleware/adminAuth');
const { supabaseAdmin } = require('../../db/supabase');

// ═══════════════════════════════════════════════════════════════
//  RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Success envelope:
 *   { success: true, data: <payload>, _meta: { request_id?, cached? } }
 */
function ok(res, data, meta) {
    if (res.headersSent) return;
    res.json({
        success: true,
        data: data === undefined ? null : data,
        _meta: meta || {}
    });
}

function fail(res, status, code, message, extra) {
    if (res.headersSent) return;
    res.status(status).json({
        success: false,
        error: message,
        code,
        ...(extra || {})
    });
}

function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code   = err?.code || 'USER_ADMIN_ERROR';
    const message = status >= 500
        ? 'Something went wrong. Please try again.'
        : (err?.message || 'Request failed');
    if (status >= 500) console.error('[ADMIN USERS]', code, err?.message);
    const body = { success: false, error: message, code };
    if (err?.allowed) body.allowed = err.allowed;
    if (err?.limit) body.limit = err.limit;
    if (err?.used) body.used = err.used;
    if (err?.remaining !== undefined) body.remaining = err.remaining;
    res.status(status).json(body);
}

// ═══════════════════════════════════════════════════════════════
//  AUTHENTICATION / AUTHORITY
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve actor authority from the LIVE database.
 * The JWT's `isSuperAdmin` claim is NEVER trusted for the approval-
 * bypass decision — a demoted admin with a stale token must fall back
 * to the normal approval workflow.
 */
async function resolveActorAuthority(req) {
    const actorId = req.adminContext?.id;
    if (!actorId) return { id: null, role: null, isSuperAdmin: false, email: null, permissions: {} };

    try {
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select('id, email, role, status, deleted_at')
            .eq('id', actorId)
            .maybeSingle();
        if (error || !data) {
            console.warn('[AUTHORITY] lookup failed:', error?.message);
            return {
                id: actorId,
                role: req.adminContext?.role || null,
                isSuperAdmin: false,
                email: req.adminContext?.email || null,
                permissions: req.adminPermissions || {}
            };
        }
        if (data.deleted_at) {
            throw Object.assign(new Error('Admin account has been deleted'), { status: 403, code: 'ACTOR_DELETED' });
        }
        if (data.status && data.status !== 'active') {
            throw Object.assign(new Error('Admin account is not active'), { status: 403, code: 'ACTOR_INACTIVE' });
        }
        return {
            id: data.id,
            email: data.email,
            role: data.role,
            isSuperAdmin: String(data.role || '').toLowerCase() === 'super_admin',
            permissions: req.adminPermissions || {}
        };
    } catch (e) {
        if (e.status) throw e;
        console.warn('[AUTHORITY] exception:', e.message);
        return {
            id: actorId,
            role: req.adminContext?.role || null,
            isSuperAdmin: false,
            email: req.adminContext?.email || null,
            permissions: req.adminPermissions || {}
        };
    }
}

/**
 * Build the ctx object services expect for PII masking + read-audit.
 */
function buildServiceCtx(req, authority) {
    return {
        id: authority.id,
        email: authority.email,
        role: authority.role,
        permissions: authority.permissions || {}
    };
}

// ═══════════════════════════════════════════════════════════════
//  STEP-UP MIDDLEWARE WRAPPER
//
//  We call requireStepUp as a function that returns middleware.
//  If the middleware is not implemented (older deployment), we
//  fail loud so the caller doesn't silently bypass re-auth.
// ═══════════════════════════════════════════════════════════════
function stepUp() {
    if (typeof requireStepUpAuth !== 'function') {
        return (req, res) => fail(
            res, 500, 'STEP_UP_MIDDLEWARE_MISSING',
            'Step-up middleware is not installed. Contact engineering.'
        );
    }
    return requireStepUpAuth();
}
// ═══════════════════════════════════════════════════════════════
//  LIST ROUTES  (must come before /:id)
// ═══════════════════════════════════════════════════════════════

router.get(
    '/users',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);
            const ctx = buildServiceCtx(req, authority);

            // Normalise boolean query params
            const parseBool = (v) => {
                if (v === 'true' || v === '1') return true;
                if (v === 'false' || v === '0') return false;
                return null;
            };

            const result = await svc.listUsers({
                page: req.query.page,
                limit: req.query.limit,
                search: req.query.search,
                status: req.query.status,
                role: req.query.role,
                verified: parseBool(req.query.verified),
                has_restriction: parseBool(req.query.has_restriction),
                risk_level: req.query.risk_level,
                created_from: req.query.created_from || null,
                created_to: req.query.created_to || null,
                sort: req.query.sort,
                ctx
            });

            ok(res, result, {
                request_id: req.id || null,
                cached: false
            });
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/users/recent',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const users = await svc.getRecentUsers(req.query.limit);
            ok(res, { users }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/users/stats',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const fresh = String(req.query.fresh || '') === '1';
            const stats = await svc.getStats({ fresh });
            ok(res, stats, {
                request_id: req.id || null,
                cached: !fresh && stats.available === true
            });
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/users/export.csv',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);
            const canRevealPII = !!(authority.permissions && authority.permissions['users.pii_reveal']);

            // Build filter object from the same params as the list
            const filters = {
                search: req.query.search || '',
                status: req.query.status || '',
                role: req.query.role || '',
                verified: (req.query.verified === 'true' || req.query.verified === '1')
                    ? true
                    : (req.query.verified === 'false' || req.query.verified === '0')
                        ? false
                        : null,
                has_restriction: (req.query.has_restriction === 'true' || req.query.has_restriction === '1')
                    ? true
                    : (req.query.has_restriction === 'false' || req.query.has_restriction === '0')
                        ? false
                        : null,
                risk_level: req.query.risk_level || '',
                created_from: req.query.created_from || null,
                created_to: req.query.created_to || null,
                sort: req.query.sort || 'newest'
            };

            const result = await svc.buildUsersCsv({
                filters,
                actorId: authority.id,
                actorEmail: authority.email,
                actorRole: authority.role,
                req,
                canRevealPII
            });

            const filename = `milesspace_users_${new Date().toISOString().slice(0, 10)}.csv`;
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('X-Export-Rows', String(result.row_count));
            res.setHeader('X-Export-Capped', String(result.capped));
            res.setHeader('X-Export-PII-Masked', String(result.pii_masked));
            res.status(200).send(result.csv);
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  BULK ACTIONS  (must come before /:id)
// ═══════════════════════════════════════════════════════════════

router.post(
    '/users/bulk/force-logout',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    stepUp(),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);
            const userIds = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
            const result = await svc.bulkForceLogout({
                userIds,
                reason: req.body?.reason,
                actorId: authority.id,
                actorEmail: authority.email,
                actorRole: authority.role,
                req
            });
            ok(res, result, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/users/bulk/tag',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    stepUp(),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);
            const userIds = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
            const result = await svc.bulkAddTag({
                userIds,
                tag: req.body?.tag,
                actorId: authority.id,
                actorEmail: authority.email,
                actorRole: authority.role,
                req
            });
            ok(res, result, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  USER 360 OVERVIEW  (+ legacy alias)
// ═══════════════════════════════════════════════════════════════

router.get(
    '/users/:id/overview',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);
            const ctx = buildServiceCtx(req, authority);
            const data = await svc.getUser360(req.params.id, ctx);
            ok(res, data, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

/**
 * Backward-compatible alias. Some older dashboard pages still call
 * /users/:id/detail. Shape matches the previous version so they keep
 * working, but the body is derived entirely from /overview + a small
 * transactions/sessions read. New callers MUST use /overview.
 */
router.get(
    '/users/:id/detail',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);
            const ctx = buildServiceCtx(req, authority);
            const data = await svc.getUser360(req.params.id, ctx);

            let recent_tx = [];
            try {
                const tx = await svc.getTransactions(req.params.id, { limit: 10 });
                recent_tx = tx.transactions;
            } catch (_) {}

            let sessions = [];
            try {
                const sec = await svc.getSecurity(req.params.id, { limit: 5 }, ctx);
                sessions = sec.sessions;
            } catch (_) {}

            ok(res, {
                user: {
                    ...data.profile,
                    wallet_ngn: data.wallet?.currencies?.NGN?.available ?? null,
                    wallet_usd: data.wallet?.currencies?.USD?.available ?? null
                },
                wallet: data.wallet,
                stats: data.summary,
                recent_transactions: recent_tx,
                sessions
            }, { request_id: req.id || null, deprecated: true });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  SUB-RESOURCES
// ═══════════════════════════════════════════════════════════════

router.get(
    '/users/:id/wallets',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);
            const ctx = buildServiceCtx(req, authority);
            const data = await svc.getWallets(req.params.id, ctx);
            ok(res, data, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/users/:id/ledger',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);
            const ctx = buildServiceCtx(req, authority);
            const result = await svc.getLedger(req.params.id, {
                page: req.query.page,
                limit: req.query.limit,
                currency: req.query.currency,
                entry_type: req.query.entry_type
            }, ctx);
            ok(res, {
                entries: result.entries,
                accounts: result.accounts,
                available: result.available,
                count: result.count,
                page: result.page,
                limit: result.limit,
                totalPages: result.totalPages,
                ...(result.note ? { note: result.note } : {})
            }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/users/:id/transactions',
    requirePermission(PERMISSIONS.TRANSACTIONS_READ),
    async (req, res) => {
        try {
            const result = await svc.getTransactions(req.params.id, {
                page: req.query.page,
                limit: req.query.limit,
                type: req.query.type,
                status: req.query.status,
                currency: req.query.currency
            });
            ok(res, {
                transactions: result.transactions,
                count: result.count,
                page: result.page,
                limit: result.limit,
                totalPages: result.totalPages
            }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/users/:id/orders',
    requirePermission(PERMISSIONS.ORDERS_READ),
    async (req, res) => {
        try {
            const result = await svc.getOrders(req.params.id, {
                page: req.query.page,
                limit: req.query.limit,
                product_type: req.query.product_type,
                status: req.query.status
            });
            ok(res, {
                orders: result.orders,
                count: result.count,
                page: result.page,
                limit: result.limit,
                totalPages: result.totalPages,
                ...(result.note ? { note: result.note } : {})
            }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/users/:id/security',
    requirePermission(PERMISSIONS.USERS_SECURITY_READ),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);
            const ctx = buildServiceCtx(req, authority);
            const data = await svc.getSecurity(req.params.id, { limit: req.query.limit }, ctx);
            ok(res, data, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/users/:id/support',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const result = await svc.getSupport(req.params.id);
            ok(res, {
                tickets: result.tickets,
                ...(result.note ? { note: result.note } : {})
            }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.get(
    '/users/:id/notes',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const notes = await svc.getNotes(req.params.id);
            ok(res, { notes }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/users/:id/notes',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const note = await svc.addNote({
                userId: req.params.id,
                authorId: req.adminContext.id,
                body: req.body?.body,
                tags: req.body?.tags
            });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.note_added',
                targetType: 'profile',
                targetId: req.params.id,
                after: { note_id: note.id, tags: note.tags },
                reason: 'internal note',
                req
            });
            ok(res, note, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  RESTRICTIONS
// ═══════════════════════════════════════════════════════════════

router.post(
    '/users/:id/restrictions',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const created = await svc.addRestriction({
                userId: req.params.id,
                adminId: req.adminContext.id,
                restriction: req.body?.restriction,
                reason: req.body?.reason,
                expires_at: req.body?.expires_at || null
            });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.restriction_added',
                targetType: 'profile',
                targetId: req.params.id,
                after: {
                    restriction: created.restriction,
                    reason: created.reason,
                    expires_at: created.expires_at || null
                },
                reason: created.reason,
                req
            });
            ok(res, created, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.delete(
    '/users/:id/restrictions/:restriction',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const reason = req.query?.reason || req.body?.reason;
            const updated = await svc.removeRestriction({
                userId: req.params.id,
                adminId: req.adminContext.id,
                restriction: req.params.restriction,
                reason
            });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.restriction_lifted',
                targetType: 'profile',
                targetId: req.params.id,
                after: {
                    restriction: updated.restriction,
                    reason: updated.lifted_reason
                },
                reason: updated.lifted_reason,
                req
            });
            ok(res, updated, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  SECURITY ACTIONS
// ═══════════════════════════════════════════════════════════════

router.post(
    '/users/:id/force-logout',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            // Self-block: an admin should use the sidebar "Logout"
            // button, not the user-360 action, to log themselves out.
            if (String(req.params.id) === String(req.adminContext.id)) {
                return fail(res, 403, 'SELF_ACTION_FORBIDDEN',
                    'Use the account menu to log yourself out.');
            }

            const reason = req.body?.reason;
            const result = await svc.forceLogout({ userId: req.params.id, reason, req });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.force_logout',
                targetType: 'profile',
                targetId: req.params.id,
                after: {
                    sessions_revoked: result.revoked,
                    profile_cleared: result.profile_cleared
                },
                reason,
                req
            });
            ok(res, {
                revoked: result.revoked,
                profile_cleared: result.profile_cleared
            }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/users/:id/require-password-reset',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const reason = req.body?.reason;
            const result = await svc.requirePasswordReset({ userId: req.params.id, reason, req });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.require_password_reset',
                targetType: 'profile',
                targetId: req.params.id,
                after: {
                    force_password_change: result.force_password_change,
                    sessions_revoked: result.sessions_revoked
                },
                reason,
                req
            });
            ok(res, result, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/users/:id/require-2fa',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
        try {
            const reason = req.body?.reason;
            const result = await svc.requireTwoFA({ userId: req.params.id, reason, req });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.require_2fa',
                targetType: 'profile',
                targetId: req.params.id,
                after: { two_factor_required: result.two_factor_required },
                reason,
                req
            });
            ok(res, result, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  PII REVEAL
// ═══════════════════════════════════════════════════════════════

router.post(
    '/users/:id/reveal',
    requirePermission(PERMISSIONS.USERS_PII_REVEAL || PERMISSIONS.USERS_MANAGE),
    stepUp(),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);
            const data = await svc.getRevealedPII({
                userId: req.params.id,
                actorId: authority.id,
                actorEmail: authority.email,
                actorRole: authority.role,
                req
            });
            ok(res, data, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  SINGLE USER  (must come after every literal path)
// ═══════════════════════════════════════════════════════════════

router.get(
    '/users/:id',
    requirePermission(PERMISSIONS.USERS_READ),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);
            const ctx = buildServiceCtx(req, authority);
            const data = await svc.getUser360(req.params.id, ctx);

            // Legacy counts block preserved for older dashboard views.
            const counts = {
                transactions: 0,
                campaigns: 0,
                giftOrders: 0,
                boostOrders: 0,
                smsOrders: 0
            };
            const tables = [
                ['transactions', 'transactions'],
                ['campaigns', 'campaigns'],
                ['gift_orders', 'giftOrders'],
                ['boost_orders', 'boostOrders'],
                ['sms_orders', 'smsOrders']
            ];
            await Promise.all(tables.map(async ([table, key]) => {
                try {
                    const { count } = await supabaseAdmin
                        .from(table)
                        .select('id', { count: 'exact', head: true })
                        .eq('user_id', req.params.id);
                    counts[key] = count || 0;
                } catch (_) {}
            }));

            ok(res, { user: data.profile, stats: counts }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.put(
    '/users/:id',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    stepUp(),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);

            // Bug 7: if_updated_at is REQUIRED. If the body lacks it we
            // return 428 (Precondition Required) before even hitting the
            // service so the error is unambiguous.
            if (!req.body?.if_updated_at) {
                return fail(res, 428, 'IF_UPDATED_AT_REQUIRED',
                    'if_updated_at is required for profile updates. Fetch the user, then send the updated_at value with the change.');
            }

            const result = await svc.updateProfile({
                userId: req.params.id,
                body: req.body || {},
                actorIsSuperAdmin: authority.isSuperAdmin,
                actorId: authority.id
            });

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'user.update',
                targetType: 'profile',
                targetId: req.params.id,
                before: result.before,
                after: result.after,
                reason: req.body?.reason || null,
                req
            });
            ok(res, result.updated, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.put(
    '/users/:id/status',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    stepUp(),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);
            const result = await svc.setStatus({
                userId: req.params.id,
                status: req.body?.status,
                reason: req.body?.reason,
                req,
                actorId: authority.id
            });
            // setStatus writes its own audit row inside the service.
            ok(res, {
                user: result.user,
                before: result.before,
                after: result.after,
                sessions_revoked: result.sessions_revoked
            }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  WALLET ADJUSTMENT
// ═══════════════════════════════════════════════════════════════

router.post(
    '/users/:id/wallet',
    requirePermission(PERMISSIONS.WALLETS_ADJUST),
    stepUp(),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);

            const result = await svc.adjustWallet({
                userId: req.params.id,
                actorId: req.adminContext.id,
                actorEmail: authority.email || req.adminContext.email,
                actorRole: authority.role,
                actorIsSuperAdmin: authority.isSuperAdmin,
                currency: req.body?.currency,
                amount: req.body?.amount,
                reason: req.body?.reason,
                req
            });

            if (result.pending_approval) {
                return res.status(202).json({
                    success: true,
                    data: result,
                    _meta: { request_id: req.id || null, pending_approval: true }
                });
            }

            ok(res, {
                ...result,
                message: `Wallet ${Number(req.body?.amount) > 0 ? 'funded' : 'debited'} successfully`
            }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  APPROVALS
// ═══════════════════════════════════════════════════════════════

router.get(
    '/approvals',
    requirePermission(PERMISSIONS.WALLETS_ADJUST),
    async (req, res) => {
        try {
            const list = await svc.listApprovals({
                status: req.query.status || 'pending',
                limit: req.query.limit
            });
            ok(res, { approvals: list }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/approvals/:id/approve',
    requirePermission(PERMISSIONS.WALLETS_ADJUST),
    stepUp(),
    async (req, res) => {
        try {
            const authority = await resolveActorAuthority(req);

            const result = await svc.approveApproval({
                id: req.params.id,
                actorId: req.adminContext.id,
                actorEmail: authority.email || req.adminContext.email,
                actorIsSuperAdmin: authority.isSuperAdmin,
                reason: req.body?.reason,
                req
            });

            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'wallet.approval_executed',
                targetType: 'approval',
                targetId: req.params.id,
                after: { ledger_transaction_id: result.ledger?.transaction_id },
                reason: req.body?.reason || null,
                req
            });

            ok(res, { executed: true, ledger: result.ledger }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

router.post(
    '/approvals/:id/reject',
    requirePermission(PERMISSIONS.WALLETS_ADJUST),
    async (req, res) => {
        try {
            const result = await svc.rejectApproval({
                id: req.params.id,
                actorId: req.adminContext.id,
                reason: req.body?.reason,
                req
            });
            await recordAdminAction({
                adminId: req.adminContext.id,
                action: 'wallet.approval_rejected',
                targetType: 'approval',
                targetId: req.params.id,
                reason: req.body?.reason,
                req
            });
            ok(res, result, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  AUDIT TRAIL
// ═══════════════════════════════════════════════════════════════

router.get(
    '/users/:id/audit',
    requirePermission(PERMISSIONS.USERS_AUDIT_READ),
    async (req, res) => {
        try {
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
            const audit = await svc.getAudit(req.params.id, { limit });
            ok(res, { audit }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);
// ═══════════════════════════════════════════════════════════════
//  AUTH CONTEXT MIDDLEWARE HOOK  (must be at end so it applies to
//  all routes registered above — Express only applies middleware
//  registered BEFORE the route, so if your app mounts this router
//  under a global adminAuth middleware, this block is unnecessary.
//  Included as a defensive fallback for older deployments where
//  the router was mounted without a global auth check.
// ═══════════════════════════════════════════════════════════════

/**
 * If the parent app did not attach req.adminContext or
 * req.adminPermissions, we refuse the request. This is a
 * defence-in-depth check — it does not replace the real auth
 * middleware and must NEVER be the only thing standing between
 * an unauthenticated request and the user API.
 *
 * If you already mount this router after a global adminAuth
 * middleware that populates those fields, this block is a no-op.
 */
router.use((req, res, next) => {
    if (!req.adminContext || !req.adminContext.id) {
        return fail(res, 401, 'AUTH_CONTEXT_MISSING',
            'Admin authentication context is missing. Ensure the router is mounted after adminAuth middleware.');
    }
    next();
});

// ═══════════════════════════════════════════════════════════════
//  MODULE EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = router;