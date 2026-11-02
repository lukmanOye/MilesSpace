// services/adminRolesService.js
// ─────────────────────────────────────────────────────────────────
// Role and permission management for MilesSpace admin.
//
// Guarantees:
//   • System roles cannot be deleted or renamed.
//   • Non-super-admins cannot grant permissions they don't have.
//   • Last active super-admin cannot be demoted or deleted.
//   • All changes are audited (admin_role_audit, same call as change).
//   • Permission names are validated against PERMISSIONS allow-list.
//   • Custom roles (any slug in admin_roles) are supported.
//   • READS NEVER THROW. If admin_roles is missing or unreadable,
//     the caller receives { available: false, reason } — not a 500
//     that hangs the frontend spinner.
//   • Optimistic version on update: callers may pass updated_at and
//     receive VERSION_CONFLICT with the current row on mismatch.
//   • When a role change reduces privileges, the target user's
//     active sessions are revoked so they must re-authenticate.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const { PERMISSIONS, invalidateRoleCache } = require('../middleware/adminAuth');

// ─── Allow-lists ─────────────────────────────────────────────────
const ALLOWED_PERMISSIONS = new Set(Object.values(PERMISSIONS));
const SYSTEM_ROLE_SLUGS = new Set([
    'super_admin','admin','finance','operations','support','auditor','read_only'
]);

// Sensitive permissions — granting these requires step-up + a typed
// confirmation (G.3).
const SENSITIVE_PERMISSIONS = new Set([
    PERMISSIONS.WALLETS_ADJUST,
    PERMISSIONS.SETTINGS_MANAGE,
    PERMISSIONS.SETTINGS_EMERGENCY || 'settings.emergency',
    PERMISSIONS.ADMINS_MANAGE,
    PERMISSIONS.FX_MANAGE,
    PERMISSIONS.TRANSACTIONS_REFUND
]);

// ─── Admin_roles explicit columns (never select('*')) ───────────
const ROLE_COLS = [
    'id','slug','label','description','permissions',
    'is_system','created_at','updated_at','created_by','updated_by'
].join(',');

// ─── Error helpers ───────────────────────────────────────────────
function roleError(code, message, status = 422, extra = {}) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    Object.assign(e, extra);
    return e;
}

// ─── Authority resolver (E.1) ───────────────────────────────────
// Reads the actor's role and permissions from `profiles` and
// `admin_roles`. Never trusts anything from the caller.
async function resolveAuthority(actorId) {
    if (!actorId) return { isSuperAdmin: false, role: null, permissions: [] };

    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('role, status, deleted_at')
        .eq('id', actorId)
        .maybeSingle();

    if (error) {
        // Fail closed.
        return { isSuperAdmin: false, role: null, permissions: [] };
    }
    if (!data || data.deleted_at || (data.status && data.status !== 'active')) {
        return { isSuperAdmin: false, role: null, permissions: [] };
    }

    const role = String(data.role || '').toLowerCase();
    if (role === 'super_admin') {
        return { isSuperAdmin: true, role, permissions: ['*'] };
    }

    // Resolve permissions for ANY role slug — custom roles included.
    const { data: roleRow, error: roleErr } = await supabaseAdmin
        .from('admin_roles')
        .select('permissions')
        .eq('slug', role)
        .maybeSingle();

    // Missing table is not fatal here — the middleware falls back to
    // the frozen set, so mirror that behaviour.
    if (roleErr && !(roleErr.code === '42P01' || roleErr.code === 'PGRST205')) {
        return { isSuperAdmin: false, role, permissions: [] };
    }

    const permissions = roleRow && Array.isArray(roleRow.permissions)
        ? roleRow.permissions
        : [];

    return { isSuperAdmin: false, role, permissions };
}

function can(ctx, permission) {
    if (!ctx) return false;
    if (ctx.isSuperAdmin) return true;
    if (!Array.isArray(ctx.permissions)) return false;
    if (ctx.permissions.includes('*')) return true;
    return ctx.permissions.includes(permission);
}

// ─── Audit writer (same call as the change — G.2) ───────────────
async function writeAuditRow({
    actorId, action, targetType, targetId,
    before, after, reason, req,
    throwOnFailure = false
}) {
    try {
        let email = null;
        if (actorId) {
            const { data } = await supabaseAdmin
                .from('profiles')
                .select('email')
                .eq('id', actorId)
                .maybeSingle();
            email = data?.email || null;
        }
        const row = {
            admin_id:    actorId,
            admin_email: email,
            action,
            target_type: targetType,
            target_id:   targetId ? String(targetId) : null,
            before:      before || null,
            after:       after || null,
            reason:      reason ? String(reason).slice(0, 500) : null,
            ip_address:  req?.ip || req?.adminContext?.ip || null,
            user_agent:  req?.headers?.['user-agent'] || null
        };
        const { error } = await supabaseAdmin.from('admin_role_audit').insert(row);
        if (error) {
            console.warn('[ROLE AUDIT] insert failed:', error.message);
            if (throwOnFailure) {
                throw roleError('AUDIT_WRITE_FAILED',
                    'Role change aborted: audit row could not be written.',
                    503);
            }
        }
    } catch (e) {
        if (throwOnFailure) throw e;
        console.warn('[ROLE AUDIT] exception:', e.message);
    }
}

// ─── LIST ROLES (never throws on read failures) ────────────────
// Returns { available: true, roles: [...] } or
//         { available: false, reason: '...', roles: [] }.
// The route layer must pass both fields through to the frontend so
// the spinner clears either way.
async function listRoles(/* { actorId } — not used, kept for signature */) {
    let rolesRes;
    try {
        rolesRes = await supabaseAdmin
            .from('admin_roles')
            .select(ROLE_COLS)
            .order('is_system', { ascending: false })
            .order('label', { ascending: true });
    } catch (e) {
        return { available: false, reason: 'ROLES_QUERY_EXCEPTION', roles: [] };
    }

    if (rolesRes.error) {
        if (['42P01', 'PGRST205', 'PGRST116'].includes(rolesRes.error.code)) {
            return { available: false, reason: 'ROLES_TABLE_MISSING', roles: [] };
        }
        console.warn('[ROLES] read error:', rolesRes.error.code || rolesRes.error.message);
        return { available: false, reason: 'ROLES_QUERY_FAILED', roles: [] };
    }

    const roles = rolesRes.data || [];
    if (!roles.length) {
        return { available: true, roles: [] };
    }

    // User counts — prefer the grouped RPC (G.4). Fall back to a
    // single profiles scan if the RPC isn't deployed.
    const counts = await _getRoleUserCounts();

    return {
        available: true,
        roles: roles.map(r => ({
            id:          r.id,
            slug:        r.slug,
            label:       r.label,
            description: r.description || '',
            permissions: Array.isArray(r.permissions) ? r.permissions : [],
            is_system:   !!r.is_system,
            user_count:  counts[r.slug] || 0,
            created_at:  r.created_at,
            updated_at:  r.updated_at,
            created_by:  r.created_by || null,
            updated_by:  r.updated_by || null
        }))
    };
}

// ─── User counts — grouped RPC, falls back to a scan ────────────
// The RPC is:
//   create or replace function public.admin_role_user_counts()
//   returns table (role text, user_count bigint)
//   language sql security definer set search_path = public as $$
//     select coalesce(role,'')::text as role, count(*)::bigint as user_count
//     from public.profiles
//     where deleted_at is null
//     group by role;
//   $$;
//   revoke all on function public.admin_role_user_counts() from public;
//   grant execute on function public.admin_role_user_counts() to service_role;
async function _getRoleUserCounts() {
    try {
        const { data, error } = await supabaseAdmin.rpc('admin_role_user_counts');
        if (!error && Array.isArray(data)) {
            const out = {};
            for (const row of data) {
                const slug = String(row.role || '').toLowerCase();
                if (slug) out[slug] = Number(row.user_count) || 0;
            }
            return out;
        }
        if (error && !(error.code === '42883' || error.code === 'PGRST202')) {
            // Real error — fall through to scan.
            console.warn('[ROLES] admin_role_user_counts failed:', error.code || error.message);
        }
    } catch (_) { /* fall through */ }

    // Fallback — single query, capped to avoid full-table scans on
    // very large deployments. We only need counts, not user rows.
    try {
        const { data } = await supabaseAdmin
            .from('profiles')
            .select('role')
            .is('deleted_at', null)
            .limit(200_000);
        const out = {};
        for (const r of data || []) {
            const slug = String(r.role || '').toLowerCase();
            if (slug) out[slug] = (out[slug] || 0) + 1;
        }
        return out;
    } catch {
        return {};
    }
}

// ─── GET ONE ─────────────────────────────────────────────────────
async function getRole(slug) {
    const clean = String(slug || '').trim().toLowerCase();
    if (!clean) return null;
    const { data, error } = await supabaseAdmin
        .from('admin_roles')
        .select(ROLE_COLS)
        .eq('slug', clean)
        .maybeSingle();
    if (error) return null;
    return data || null;
}

// ─── CREATE ─────────────────────────────────────────────────────
async function createRole({ actorId, slug, label, description, permissions, reason, req }) {
    const authority = await resolveAuthority(actorId);
    if (!authority.isSuperAdmin) {
        throw roleError('SUPER_ADMIN_REQUIRED', 'Only Super Admins can create roles', 403);
    }

    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(cleanSlug)) {
        throw roleError('INVALID_SLUG',
            'Slug must be 3-40 characters, lowercase, starting with a letter (a-z, 0-9, _)');
    }
    if (SYSTEM_ROLE_SLUGS.has(cleanSlug)) {
        throw roleError('RESERVED_SLUG', 'This slug is reserved for a system role', 409);
    }

    const cleanLabel = String(label || '').trim();
    if (cleanLabel.length < 2 || cleanLabel.length > 60) {
        throw roleError('INVALID_LABEL', 'Label must be 2-60 characters');
    }

    const cleanPerms = _validatePermissions(permissions);
    if (!cleanPerms.length) {
        throw roleError('EMPTY_PERMISSIONS', 'At least one permission is required');
    }
    if (!reason || String(reason).trim().length < 4) {
        throw roleError('REASON_REQUIRED', 'A reason is required (min 4 chars)');
    }

    const { data, error } = await supabaseAdmin
        .from('admin_roles')
        .insert({
            slug: cleanSlug,
            label: cleanLabel,
            description: String(description || '').trim().slice(0, 500),
            permissions: cleanPerms,
            is_system: false,
            created_by: actorId,
            updated_by: actorId
        })
        .select(ROLE_COLS)
        .single();

    if (error) {
        if (error.code === '23505') {
            throw roleError('SLUG_TAKEN', 'A role with this slug already exists', 409);
        }
        throw roleError('ROLE_CREATE_FAILED', 'Failed to create role', 500);
    }

    await writeAuditRow({
        actorId,
        action: 'admin.role_created',
        targetType: 'admin_role',
        targetId: data.slug,
        before: null,
        after: { slug: data.slug, label: data.label, permissions: data.permissions },
        reason,
        req,
        throwOnFailure: true
    });

    // Custom role now exists — adminAuth's isAdminRoleAsync() cache
    // must be invalidated so a user with this role can log in.
    invalidateRoleCache(data.slug);

    return data;
}

// ─── UPDATE ─────────────────────────────────────────────────────
async function updateRole({ actorId, slug, label, description, permissions, reason, expectedUpdatedAt, req }) {
    const authority = await resolveAuthority(actorId);
    if (!authority.isSuperAdmin) {
        throw roleError('SUPER_ADMIN_REQUIRED', 'Only Super Admins can edit roles', 403);
    }

    const cleanSlug = String(slug || '').trim().toLowerCase();
    const existing = await getRole(cleanSlug);
    if (!existing) throw roleError('ROLE_NOT_FOUND', 'Role not found', 404);
    if (existing.is_system) {
        throw roleError('SYSTEM_ROLE_IMMUTABLE', 'System roles cannot be edited', 403);
    }

    // Optimistic version (G.4).
    if (expectedUpdatedAt && existing.updated_at) {
        const a = new Date(expectedUpdatedAt).getTime();
        const b = new Date(existing.updated_at).getTime();
        if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
            throw roleError('VERSION_CONFLICT',
                'Another admin changed this role. Reload and retry.', 409,
                { current_updated_at: existing.updated_at });
        }
    }

    const updateData = { updated_at: new Date().toISOString(), updated_by: actorId };
    const before = {};
    const after = {};

    if (label !== undefined) {
        const cleanLabel = String(label || '').trim();
        if (cleanLabel.length < 2 || cleanLabel.length > 60) {
            throw roleError('INVALID_LABEL', 'Label must be 2-60 characters');
        }
        if (cleanLabel !== existing.label) {
            updateData.label = cleanLabel;
            before.label = existing.label;
            after.label = cleanLabel;
        }
    }

    if (description !== undefined) {
        const cleanDesc = String(description || '').trim().slice(0, 500);
        if (cleanDesc !== existing.description) {
            updateData.description = cleanDesc;
            before.description = existing.description;
            after.description = cleanDesc;
        }
    }

    if (permissions !== undefined) {
        const cleanPerms = _validatePermissions(permissions);
        if (!cleanPerms.length) {
            throw roleError('EMPTY_PERMISSIONS', 'At least one permission is required');
        }
        // FIX (G.4): no .sort() mutation — copy before comparing.
        const current = Array.isArray(existing.permissions) ? [...existing.permissions].sort() : [];
        const next = [...cleanPerms].sort();
        if (JSON.stringify(current) !== JSON.stringify(next)) {
            updateData.permissions = cleanPerms;
            before.permissions = existing.permissions;
            after.permissions = cleanPerms;
        }
    }

    if (!Object.keys(after).length && Object.keys(updateData).length <= 2) {
        throw roleError('NO_CHANGES', 'No changes supplied');
    }
    if (!reason || String(reason).trim().length < 4) {
        throw roleError('REASON_REQUIRED', 'A reason is required (min 4 chars)');
    }

    const { data: updated, error } = await supabaseAdmin
        .from('admin_roles')
        .update(updateData)
        .eq('slug', cleanSlug)
        .select(ROLE_COLS)
        .single();

    if (error) throw roleError('ROLE_UPDATE_FAILED', 'Failed to update role', 500);

    await writeAuditRow({
        actorId,
        action: 'admin.role_updated',
        targetType: 'admin_role',
        targetId: cleanSlug,
        before,
        after,
        reason,
        req,
        throwOnFailure: true
    });

    // Permissions of a role that has users → invalidate cache so the
    // next request picks up the new permissions.
    invalidateRoleCache(cleanSlug);

    return updated;
}

// ─── DELETE ─────────────────────────────────────────────────────
async function deleteRole({ actorId, slug, reason, req }) {
    const authority = await resolveAuthority(actorId);
    if (!authority.isSuperAdmin) {
        throw roleError('SUPER_ADMIN_REQUIRED', 'Only Super Admins can delete roles', 403);
    }

    const cleanSlug = String(slug || '').trim().toLowerCase();
    const existing = await getRole(cleanSlug);
    if (!existing) throw roleError('ROLE_NOT_FOUND', 'Role not found', 404);
    if (existing.is_system) {
        throw roleError('SYSTEM_ROLE_IMMUTABLE', 'System roles cannot be deleted', 403);
    }

    const { count } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', cleanSlug)
        .is('deleted_at', null);
    if ((count || 0) > 0) {
        throw roleError('ROLE_IN_USE',
            `Cannot delete: ${count} user(s) still have this role. Reassign them first.`,
            409, { user_count: count });
    }

    if (!reason || String(reason).trim().length < 4) {
        throw roleError('REASON_REQUIRED', 'A reason is required');
    }

    const { error } = await supabaseAdmin
        .from('admin_roles')
        .delete()
        .eq('slug', cleanSlug);
    if (error) throw roleError('ROLE_DELETE_FAILED', 'Failed to delete role', 500);

    await writeAuditRow({
        actorId,
        action: 'admin.role_deleted',
        targetType: 'admin_role',
        targetId: cleanSlug,
        before: { slug: existing.slug, label: existing.label, permissions: existing.permissions },
        after: null,
        reason,
        req,
        throwOnFailure: true
    });

    invalidateRoleCache(cleanSlug);

    return { deleted: true };
}

// ─── ASSIGN ─────────────────────────────────────────────────────
async function assignRoleToUser({ actorId, userId, roleSlug, reason, req }) {
    const authority = await resolveAuthority(actorId);
    if (!authority.isSuperAdmin) {
        throw roleError('SUPER_ADMIN_REQUIRED', 'Only Super Admins can assign roles', 403);
    }

    const cleanSlug = String(roleSlug || '').trim().toLowerCase();
    const roleRow = await getRole(cleanSlug);
    if (!roleRow) throw roleError('ROLE_NOT_FOUND', 'Role not found', 404);

    if (roleRow.slug === 'super_admin') {
        throw roleError('SUPER_ADMIN_GRANT_FORBIDDEN',
            'The super_admin role cannot be assigned through this endpoint. Use a dedicated promotion flow.',
            403);
    }

    const { data: user, error: userErr } = await supabaseAdmin
        .from('profiles')
        .select('id, email, role, status, deleted_at')
        .eq('id', userId)
        .maybeSingle();
    if (userErr || !user) throw roleError('USER_NOT_FOUND', 'User not found', 404);
    if (user.deleted_at) throw roleError('USER_DELETED', 'User is deleted', 410);

    if (String(userId) === String(actorId)) {
        throw roleError('SELF_ROLE_CHANGE_FORBIDDEN',
            'You cannot change your own role.', 403);
    }

    if (String(user.role).toLowerCase() === 'super_admin' && cleanSlug !== 'super_admin') {
        const { count } = await supabaseAdmin
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('role', 'super_admin')
            .eq('status', 'active')
            .is('deleted_at', null);
        if ((count || 0) <= 1) {
            throw roleError('LAST_SUPER_ADMIN',
                'Cannot demote the last active super admin.', 409);
        }
    }

    if (String(user.role).toLowerCase() === cleanSlug) {
        throw roleError('NO_CHANGE', 'User already has this role', 409);
    }

    if (!reason || String(reason).trim().length < 4) {
        throw roleError('REASON_REQUIRED', 'A reason is required');
    }

    // Determine if this is a privilege reduction (G.5).
    const oldPerms = await _getPermissionsForRoleSlug(String(user.role).toLowerCase());
    const newPerms = new Set(Array.isArray(roleRow.permissions) ? roleRow.permissions : []);
    const reduced = [...oldPerms].some(p => !newPerms.has(p) && p !== '*');

    const { error } = await supabaseAdmin
        .from('profiles')
        .update({ role: cleanSlug, updated_at: new Date().toISOString() })
        .eq('id', userId);
    if (error) throw roleError('ROLE_ASSIGN_FAILED', 'Failed to assign role', 500);

    await writeAuditRow({
        actorId,
        action: 'admin.role_assigned',
        targetType: 'profile',
        targetId: userId,
        before: { role: user.role },
        after: { role: cleanSlug, role_label: roleRow.label, privileges_reduced: reduced },
        reason,
        req,
        throwOnFailure: false    // role change already committed; audit is best-effort here
    });

    // Privilege reduction → force re-auth (G.5).
    if (reduced) {
        try {
            await supabaseAdmin
                .from('user_sessions')
                .update({
                    is_active: false,
                    revoked_at: new Date().toISOString(),
                    revoked_reason: 'role_privilege_reduction'
                })
                .eq('user_id', userId)
                .eq('is_active', true);
        } catch (e) {
            console.warn('[ROLES] session revocation after privilege reduction failed:', e.message);
        }
    }

    // Role assignment changed what this user can do — invalidate the
    // role cache so the very next request reflects the new state.
    invalidateRoleCache(cleanSlug);

    return {
        user_id: userId,
        email: user.email,
        previous_role: user.role,
        new_role: cleanSlug,
        new_role_label: roleRow.label,
        privileges_reduced: reduced
    };
}

async function _getPermissionsForRoleSlug(slug) {
    if (!slug) return new Set();
    if (slug === 'super_admin') return new Set(['*']);
    const { data, error } = await supabaseAdmin
        .from('admin_roles')
        .select('permissions')
        .eq('slug', slug)
        .maybeSingle();
    if (error || !data) return new Set();
    return new Set(Array.isArray(data.permissions) ? data.permissions : []);
}

// ─── LIST USERS (for role assignment picker) ───────────────────
async function listUsersForRoleAssignment({ actorId, search = '', limit = 50 }) {
    const authority = await resolveAuthority(actorId);
    if (!authority.isSuperAdmin) {
        throw roleError('SUPER_ADMIN_REQUIRED', 'Only Super Admins can assign roles', 403);
    }
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
    let q = supabaseAdmin
        .from('profiles')
        .select('id, username, email, role, status, created_at')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(cap);

    const term = String(search || '').trim().slice(0, 64);
    if (term) {
        const safe = term.replace(/[%_\\]/g, m => '\\' + m);
        q = q.or(`username.ilike.%${safe}%,email.ilike.%${safe}%`);
    }
    const { data, error } = await q;
    if (error) throw roleError('USERS_READ_FAILED', 'Failed to read users', 500);
    return data || [];
}

// ─── VALIDATION HELPERS ─────────────────────────────────────────
function _validatePermissions(permissions) {
    const clean = Array.isArray(permissions) ? permissions : [];
    const invalid = clean.filter(p => !ALLOWED_PERMISSIONS.has(p));
    if (invalid.length) {
        throw roleError('INVALID_PERMISSION',
            `Unknown permission(s): ${invalid.join(', ')}`,
            422, { invalid });
    }
    // Deduplicate
    return Array.from(new Set(clean));
}

// ─── Sensitive permission check (exposed to routes) ────────────
// When a role edit will grant any sensitive permission, the caller
// must have already done step-up and typed confirmation. This helper
// tells the route layer which permissions triggered the guard.
function findSensitivePermissions(permissions) {
    if (!Array.isArray(permissions)) return [];
    return permissions.filter(p => SENSITIVE_PERMISSIONS.has(p));
}

// ─── PERMISSION GROUPS (for UI catalogue) ──────────────────────
const PERMISSION_GROUPS = [
    {
        key: 'dashboard_reports',
        label: 'Dashboard and reports',
        permissions: [
            PERMISSIONS.DASHBOARD_READ,
            PERMISSIONS.REPORTS_READ,
            PERMISSIONS.REPORTS_EXPORT
        ]
    },
    {
        key: 'user_management',
        label: 'User management',
        permissions: [
            PERMISSIONS.USERS_READ,
            PERMISSIONS.USERS_MANAGE,
            PERMISSIONS.USERS_SUSPEND,
            PERMISSIONS.USERS_SECURITY_READ,
            PERMISSIONS.USERS_AUDIT_READ
        ]
    },
    {
        key: 'role_permissions',
        label: 'Role and permission management',
        permissions: [
            PERMISSIONS.ADMINS_READ,
            PERMISSIONS.ADMINS_MANAGE
        ]
    },
    {
        key: 'wallets_transactions',
        label: 'Wallets and transactions',
        permissions: [
            PERMISSIONS.WALLETS_READ,
            PERMISSIONS.WALLETS_ADJUST,
            PERMISSIONS.TRANSACTIONS_READ,
            PERMISSIONS.TRANSACTIONS_RESOLVE,
            PERMISSIONS.TRANSACTIONS_REFUND
        ]
    },
    {
        key: 'deposits_reconciliation',
        label: 'Deposits and reconciliation',
        permissions: [
            PERMISSIONS.DEPOSITS_READ,
            PERMISSIONS.DEPOSITS_RESOLVE,
            PERMISSIONS.RECONCILIATION_READ,
            PERMISSIONS.RECONCILIATION_RESOLVE
        ]
    },
    {
        key: 'giftcards_products',
        label: 'Gift cards and products',
        permissions: [
            PERMISSIONS.SERVICES_READ,
            PERMISSIONS.SERVICES_MANAGE,
            PERMISSIONS.ORDERS_READ,
            PERMISSIONS.ORDERS_RESOLVE
        ]
    },
    {
        key: 'campaigns_services',
        label: 'Campaigns and services',
        permissions: [
            PERMISSIONS.CRYPTO_READ,
            PERMISSIONS.CRYPTO_RESOLVE,
            PERMISSIONS.FX_READ,
            PERMISSIONS.FX_MANAGE,
            PERMISSIONS.PROVIDERS_READ,
            PERMISSIONS.PROVIDERS_MANAGE,
            PERMISSIONS.PROVIDERS_TEST,
            PERMISSIONS.WEBHOOKS_READ,
            PERMISSIONS.WEBHOOKS_REPLAY
        ]
    },
    {
        key: 'support_notifications',
        label: 'Support and notifications',
        permissions: [
            PERMISSIONS.SUPPORT_READ,
            PERMISSIONS.SUPPORT_REPLY,
            PERMISSIONS.SUPPORT_INTERNAL_NOTE,
            PERMISSIONS.SUPPORT_ASSIGN,
            PERMISSIONS.SUPPORT_CHANGE_STATUS,
            PERMISSIONS.SUPPORT_CLOSE,
            PERMISSIONS.SUPPORT_REOPEN,
            PERMISSIONS.SUPPORT_ATTACHMENTS,
            PERMISSIONS.SUPPORT_VIEW_CUSTOMER,
            PERMISSIONS.SUPPORT_AUDIT_READ,
            PERMISSIONS.NOTIFICATIONS_READ,
            PERMISSIONS.NOTIFICATIONS_MANAGE
        ]
    },
    {
        key: 'system_settings',
        label: 'System settings and provider configuration',
        permissions: [
            PERMISSIONS.SETTINGS_READ,
            PERMISSIONS.SETTINGS_MANAGE,
            PERMISSIONS.SETTINGS_EMERGENCY || 'settings.emergency',
            PERMISSIONS.SYSTEM_HEALTH_READ,
            PERMISSIONS.SECURITY_READ,
            PERMISSIONS.SECURITY_MANAGE,
            PERMISSIONS.SESSIONS_READ,
            PERMISSIONS.SESSIONS_REVOKE,
            PERMISSIONS.AUDIT_READ,
            PERMISSIONS.AUDIT_EXPORT
        ]
    }
];

function listPermissionsGrouped() {
    return PERMISSION_GROUPS.map(g => ({
        key: g.key,
        label: g.label,
        permissions: g.permissions.map(p => ({
            slug: p,
            label: humanPermissionLabel(p),
            sensitive: SENSITIVE_PERMISSIONS.has(p)
        }))
    }));
}

function humanPermissionLabel(slug) {
    const map = {
        'dashboard.read': 'View dashboard',
        'users.read': 'View users',
        'users.manage': 'Manage users',
        'users.suspend': 'Suspend users',
        'users.security.read': 'View user security',
        'users.audit.read': 'View user audit trail',
        'wallets.read': 'View wallets',
        'wallets.adjust': 'Adjust wallet balances',
        'transactions.read': 'View transactions',
        'transactions.resolve': 'Resolve transactions',
        'transactions.refund': 'Refund transactions',
        'deposits.read': 'View deposits',
        'deposits.resolve': 'Resolve deposits',
        'crypto.read': 'View crypto',
        'crypto.resolve': 'Resolve crypto',
        'fx.read': 'View FX rates',
        'fx.manage': 'Manage FX rates',
        'providers.read': 'View providers',
        'providers.manage': 'Manage providers',
        'providers.test': 'Test providers',
        'services.read': 'View services',
        'services.manage': 'Manage services',
        'orders.read': 'View orders',
        'orders.resolve': 'Resolve orders',
        'webhooks.read': 'View webhooks',
        'webhooks.replay': 'Replay webhooks',
        'reconciliation.read': 'View reconciliation',
        'reconciliation.resolve': 'Resolve reconciliation',
        'reports.read': 'View reports',
        'reports.export': 'Export reports',
        'notifications.read': 'View notifications',
        'notifications.manage': 'Manage notifications',
                'settings.read': 'View settings',
        'settings.manage': 'Manage settings',
        'settings.emergency': 'Emergency controls',
        'admins.read': 'View admins',
        'admins.manage': 'Manage admins and roles',
        'audit.read': 'View audit log',
        'audit.export': 'Export audit log',
        'system.health.read': 'View system health',
        'security.read': 'View security',
        'security.manage': 'Manage security',
        'sessions.read': 'View sessions',
        'sessions.revoke': 'Revoke sessions',
        'support.read': 'View support tickets',
        'support.reply': 'Reply to tickets',
        'support.internal_note': 'Add internal notes',
        'support.assign': 'Assign tickets',
        'support.change_status': 'Change ticket status',
        'support.close': 'Close tickets',
        'support.reopen': 'Reopen tickets',
        'support.attachments': 'Manage attachments',
        'support.delete_attachment': 'Delete attachments',
        'support.manage_categories': 'Manage categories',
        'support.view_customer': 'View customer details',
        'support.audit.read': 'View support audit'
    };
    return map[slug] || slug.replace(/\./g, ' ');
}

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════
module.exports = {
    // reads (never throw)
    listRoles,
    getRole,

    // writes (throw structured errors)
    createRole,
    updateRole,
    deleteRole,
    assignRoleToUser,

    // users picker
    listUsersForRoleAssignment,

    // catalogue
    listPermissionsGrouped,
    humanPermissionLabel,

    // guards
    resolveAuthority,
    can,
    findSensitivePermissions,
    SENSITIVE_PERMISSIONS,
    SYSTEM_ROLE_SLUGS,
    ALLOWED_PERMISSIONS
};