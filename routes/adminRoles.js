// routes/adminRoles.js
// ─────────────────────────────────────────────────────────────────
// Role management HTTP surface.
//
//   GET    /api/admin/roles                    → { roles: [], available: bool }
//   GET    /api/admin/roles/permissions        → { groups: [] }
//   POST   /api/admin/roles                    → create custom role
//   PUT    /api/admin/roles/:slug              → edit custom role
//   DELETE /api/admin/roles/:slug              → delete custom role
//   GET    /api/admin/roles/users              → { users: [] }
//   POST   /api/admin/roles/assign             → assign role to user
//
// Contract: `GET /roles` ALWAYS returns 200 for recoverable failures,
// with `{ roles: [], available: false, reason }`. The frontend uses
// this to render an error state instead of an infinite spinner.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const svc = require('../services/adminRolesService');
const {
    requirePermission,
    recordAdminAction,
    PERMISSIONS
} = require('../middleware/adminAuth');

// ─── Response helpers ───────────────────────────────────────────
function ok(res, data, meta) {
    if (res.headersSent) return;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ success: true, data: data === undefined ? null : data, _meta: meta || {} });
}
function fail(res, status, code, message, extra) {
    if (res.headersSent) return;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.status(status).json({ success: false, error: message, code, ...(extra || {}) });
}
function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'ROLE_ERROR';
    const message = status >= 500
        ? 'Something went wrong. Please try again.'
        : (err?.message || 'Request failed');
    if (status >= 500) console.error('[ADMIN ROLES]', code, err?.message);
    const body = { success: false, error: message, code };
    if (err?.invalid) body.invalid = err.invalid;
    if (err?.user_count != null) body.user_count = err.user_count;
    if (err?.current_updated_at) body.current_updated_at = err.current_updated_at;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.status(status).json(body);
}

// ═══════════════════════════════════════════════════════════════
//  GET /api/admin/roles
//
//  THE FIX IS HERE.
//
//  svc.listRoles() returns: { available: bool, roles: [], reason? }
//
//  Old code: ok(res, { roles }) → data.roles = { available, roles: [] }
//            (frontend reads data.roles as an array — got an object)
//
//  New code: ok(res, { roles: result.roles, available: result.available })
//            → data.roles = [ ...array... ]  ✓
//
//  Also: this route NEVER returns non-200 for recoverable failures,
//  so the frontend spinner always clears.
// ═══════════════════════════════════════════════════════════════
router.get(
    '/roles',
    requirePermission(PERMISSIONS.ADMINS_READ || PERMISSIONS.SETTINGS_READ),
    async (req, res) => {
        try {
            const result = await svc.listRoles({ actorId: req.adminContext?.id });

            // Unwrap the service result correctly.
            // result = { available: bool, roles: [], reason? }
            if (!result || result.available === false) {
                return ok(res, {
                    roles: [],
                    available: false,
                    reason: (result && result.reason) || 'ROLES_UNAVAILABLE'
                }, { request_id: req.id || null });
            }
            return ok(res, {
                roles: Array.isArray(result.roles) ? result.roles : [],
                available: true
            }, { request_id: req.id || null });
        } catch (err) {
            // Even on unexpected failure, return 200 so the frontend
            // clears its spinner and shows a clear "unavailable" state.
            console.warn('[ADMIN ROLES] /roles unexpected:', err?.code || err?.message);
            return ok(res, {
                roles: [],
                available: false,
                reason: 'ROLES_UNAVAILABLE'
            }, { request_id: req.id || null });
        }
    }
);

// ═══════════════════════════════════════════════════════════════
//  GET /api/admin/roles/permissions
// ═══════════════════════════════════════════════════════════════
router.get(
    '/roles/permissions',
    requirePermission(PERMISSIONS.ADMINS_READ || PERMISSIONS.SETTINGS_READ),
    async (req, res) => {
        try {
            const groups = svc.listPermissionsGrouped();
            ok(res, { groups }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/roles
// ═══════════════════════════════════════════════════════════════
router.post(
    '/roles',
    requirePermission(PERMISSIONS.ADMINS_MANAGE),
    async (req, res) => {
        try {
            const body = req.body || {};
            const role = await svc.createRole({
                actorId: req.adminContext?.id,
                slug: body.slug,
                label: body.label,
                description: body.description,
                permissions: body.permissions,
                reason: body.reason,
                req
            });
            await recordAdminAction({
                adminId: req.adminContext?.id,
                action: 'admin.role_created',
                targetType: 'admin_role',
                targetId: role.slug,
                after: { slug: role.slug, label: role.label, permissions: role.permissions },
                reason: body.reason,
                req
            }).catch(() => {});
            ok(res, role, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  PUT /api/admin/roles/:slug
// ═══════════════════════════════════════════════════════════════
router.put(
    '/roles/:slug',
    requirePermission(PERMISSIONS.ADMINS_MANAGE),
    async (req, res) => {
        try {
            const body = req.body || {};
            const role = await svc.updateRole({
                actorId: req.adminContext?.id,
                slug: req.params.slug,
                label: body.label,
                description: body.description,
                permissions: body.permissions,
                reason: body.reason,
                req
            });
            await recordAdminAction({
                adminId: req.adminContext?.id,
                action: 'admin.role_updated',
                targetType: 'admin_role',
                targetId: role.slug,
                after: { label: role.label, permissions: role.permissions },
                reason: body.reason,
                req
            }).catch(() => {});
            ok(res, role, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  DELETE /api/admin/roles/:slug
// ═══════════════════════════════════════════════════════════════
router.delete(
    '/roles/:slug',
    requirePermission(PERMISSIONS.ADMINS_MANAGE),
    async (req, res) => {
        try {
            const reason = req.query?.reason || req.body?.reason;
            const result = await svc.deleteRole({
                actorId: req.adminContext?.id,
                slug: req.params.slug,
                reason,
                req
            });
            await recordAdminAction({
                adminId: req.adminContext?.id,
                action: 'admin.role_deleted',
                targetType: 'admin_role',
                targetId: req.params.slug,
                reason,
                req
            }).catch(() => {});
            ok(res, result, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  GET /api/admin/roles/users
// ═══════════════════════════════════════════════════════════════
router.get(
    '/roles/users',
    requirePermission(PERMISSIONS.ADMINS_MANAGE),
    async (req, res) => {
        try {
            const users = await svc.listUsersForRoleAssignment({
                actorId: req.adminContext?.id,
                search: req.query.search || '',
                limit: req.query.limit
            });
            ok(res, { users }, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/roles/assign
// ═══════════════════════════════════════════════════════════════
router.post(
    '/roles/assign',
    requirePermission(PERMISSIONS.ADMINS_MANAGE),
    async (req, res) => {
        try {
            const body = req.body || {};
            if (!body.user_id || !body.role) {
                return fail(res, 422, 'INVALID_BODY', 'user_id and role are required');
            }
            const result = await svc.assignRoleToUser({
                actorId: req.adminContext?.id,
                userId: body.user_id,
                roleSlug: body.role,
                reason: body.reason,
                req
            });
            await recordAdminAction({
                adminId: req.adminContext?.id,
                action: 'admin.role_assigned',
                targetType: 'profile',
                targetId: body.user_id,
                before: { role: result.previous_role },
                after: { role: result.new_role },
                reason: body.reason,
                req
            }).catch(() => {});
            ok(res, result, { request_id: req.id || null });
        } catch (err) { sendErr(res, err); }
    }
);

module.exports = router;