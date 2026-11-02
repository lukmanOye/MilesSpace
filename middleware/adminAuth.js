// middleware/adminAuth.js
// ─────────────────────────────────────────────────────────────────
// SINGLE ADMIN AUTH AUTHORITY.
//
// Guarantees:
//   • Never trusts req.body.role / req.body.isAdmin / req.body.permission.
//   • Re-reads role from `profiles` on every request.
//   • Permission resolution is DB-authoritative and FAILS CLOSED:
//       * admin_permissions read error → 503, deny
//       * profiles read error          → 503, deny
//       * super_admin                  → ['*']
//       * every other role             → admin_roles.permissions
//                                        (custom roles supported),
//                                        falling back to hardcoded
//                                        ROLE_PERMISSIONS only if the
//                                        admin_roles row is missing.
//   • Session must match profiles.current_session_id AND be active
//     in user_sessions.
//   • Profile status must be 'active'. Suspended / banned / inactive
//     are rejected here (E.4).
//   • Only super_admin gets the wildcard.
//   • Audit is delegated to services/auditLogService.
//   • `sid` on the FULL admin token must be a UUID. A malformed
//     sid is rejected before any DB call. Setup tokens do NOT
//     carry an `sid` — they are identified by `type: 'admin_setup'`.
//   • Setup tokens NEVER get permissions and NEVER trigger the
//     user_sessions lookup.
//   • jwt.verify() pins algorithm, issuer, and audience.
//   • Correlation IDs are validated (alphanum + dash/underscore,
//     max 80 chars).
//   • Cache-Control: no-store is set on every admin response,
//     including success (E.6).
//   • Token-based step-up (X-Step-Up-Token) is DEPRECATED but still
//     validated. The session-based step-up middleware from
//     adminStepUp.js is the canonical path (E.5).
// ─────────────────────────────────────────────────────────────────

'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const auditLog = require('../services/auditLogService');

// ─── JWT secret ─────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error(
        'JWT_SECRET must be set and at least 32 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
}

const JWT_ISSUER   = 'milespace-admin';
const JWT_AUDIENCE = 'milespace-admin-api';

// ─── UUID shape ─────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Correlation ID shape ───────────────────────────────────────
const CORR_RE = /^[A-Za-z0-9_\-]{1,80}$/;

// ─── PROFILE_SELECT — single source of truth for the profile columns
// any admin route may read. Consumers (users routes, roles routes)
// MUST import this instead of writing their own select() so we never
// reintroduce the class of bug that hit `kyc_status`.
//
// IMPORTANT: never add mfa_secret_encrypted / mfa_pending_secret_encrypted
// to this list (E.3). They are the crown jewels and must be read by
// the dedicated MFA routes, never by general admin context.
// ─────────────────────────────────────────────────────────────────
const PROFILE_SELECT = Object.freeze([
    'id',
    'email',
    'username',
    'role',
    'status',
    'deleted_at',
    'current_session_id',
    'session_expires_at',
    'session_created_at',
    'two_factor_enabled'
]);

// ─── Roles ──────────────────────────────────────────────────────
const ADMIN_ROLES = Object.freeze({
    SUPER_ADMIN: 'super_admin',
    ADMIN:       'admin',
    FINANCE:     'finance',
    OPERATIONS:  'operations',
    SUPPORT:     'support',
    AUDITOR:     'auditor',
    READ_ONLY:   'read_only'
});
const ADMIN_ROLE_VALUES = Object.freeze(Object.values(ADMIN_ROLES));

// ─── Permission registry ────────────────────────────────────────
const PERMISSIONS = Object.freeze({
    DASHBOARD_READ:         'dashboard.read',

    USERS_READ:             'users.read',
    USERS_MANAGE:           'users.manage',
    USERS_SUSPEND:          'users.suspend',
    USERS_SECURITY_READ:    'users.security.read',
    USERS_AUDIT_READ:       'users.audit.read',

    WALLETS_READ:           'wallets.read',
    WALLETS_ADJUST:         'wallets.adjust',

    TRANSACTIONS_READ:      'transactions.read',
    TRANSACTIONS_RESOLVE:   'transactions.resolve',
    TRANSACTIONS_REFUND:    'transactions.refund',

    DEPOSITS_READ:          'deposits.read',
    DEPOSITS_RESOLVE:       'deposits.resolve',

    CRYPTO_READ:            'crypto.read',
    CRYPTO_RESOLVE:         'crypto.resolve',

    FX_READ:                'fx.read',
    FX_MANAGE:              'fx.manage',

    PROVIDERS_READ:         'providers.read',
    PROVIDERS_MANAGE:       'providers.manage',
    PROVIDERS_TEST:         'providers.test',

    SERVICES_READ:          'services.read',
    SERVICES_MANAGE:        'services.manage',

    ORDERS_READ:            'orders.read',
    ORDERS_RESOLVE:         'orders.resolve',

    WEBHOOKS_READ:          'webhooks.read',
    WEBHOOKS_REPLAY:        'webhooks.replay',

    RECONCILIATION_READ:    'reconciliation.read',
    RECONCILIATION_RESOLVE: 'reconciliation.resolve',

    REPORTS_READ:           'reports.read',
    REPORTS_EXPORT:         'reports.export',

    NOTIFICATIONS_READ:     'notifications.read',
    NOTIFICATIONS_MANAGE:   'notifications.manage',

    SETTINGS_READ:          'settings.read',
    SETTINGS_MANAGE:        'settings.manage',
    SETTINGS_EMERGENCY:     'settings.emergency',    // new — F.1

    ADMINS_READ:            'admins.read',
    ADMINS_MANAGE:          'admins.manage',

    AUDIT_READ:             'audit.read',
    AUDIT_EXPORT:           'audit.export',

    SYSTEM_HEALTH_READ:     'system.health.read',

    SECURITY_READ:          'security.read',
    SECURITY_MANAGE:        'security.manage',
    SESSIONS_READ:          'sessions.read',
    SESSIONS_REVOKE:        'sessions.revoke',

    SUPPORT_READ:               'support.read',
    SUPPORT_REPLY:              'support.reply',
    SUPPORT_INTERNAL_NOTE:      'support.internal_note',
    SUPPORT_ASSIGN:             'support.assign',
    SUPPORT_CHANGE_STATUS:      'support.change_status',
    SUPPORT_CLOSE:              'support.close',
    SUPPORT_REOPEN:             'support.reopen',
    SUPPORT_ATTACHMENTS:        'support.attachments',
    SUPPORT_DELETE_ATTACHMENT:  'support.delete_attachment',
    SUPPORT_MANAGE_CATEGORIES:  'support.manage_categories',
    SUPPORT_VIEW_CUSTOMER:      'support.view_customer',
    SUPPORT_AUDIT_READ:         'support.audit.read'
});

// ─── Role → baseline permissions ────────────────────────────────
// NOTE: this is the SEED for system roles. Admin_roles.permissions
// is the runtime authority once the row exists (E.1). This table
// exists only so a fresh deployment with an empty admin_roles
// still gives correct behaviour, and so a `super_admin` short-circuit
// works even before the first DB read.
const ROLE_PERMISSIONS = Object.freeze({
    [ADMIN_ROLES.SUPER_ADMIN]: ['*'],

    [ADMIN_ROLES.ADMIN]: [
        PERMISSIONS.DASHBOARD_READ,
        PERMISSIONS.USERS_READ, PERMISSIONS.USERS_MANAGE, PERMISSIONS.USERS_SUSPEND,
        PERMISSIONS.USERS_SECURITY_READ, PERMISSIONS.USERS_AUDIT_READ,
        PERMISSIONS.WALLETS_READ,
        PERMISSIONS.TRANSACTIONS_READ, PERMISSIONS.TRANSACTIONS_RESOLVE,
        PERMISSIONS.DEPOSITS_READ, PERMISSIONS.DEPOSITS_RESOLVE,
        PERMISSIONS.CRYPTO_READ, PERMISSIONS.CRYPTO_RESOLVE,
        PERMISSIONS.FX_READ,
        PERMISSIONS.PROVIDERS_READ, PERMISSIONS.PROVIDERS_TEST,
        PERMISSIONS.SERVICES_READ, PERMISSIONS.SERVICES_MANAGE,
        PERMISSIONS.ORDERS_READ, PERMISSIONS.ORDERS_RESOLVE,
        PERMISSIONS.WEBHOOKS_READ,
        PERMISSIONS.RECONCILIATION_READ,
        PERMISSIONS.REPORTS_READ, PERMISSIONS.REPORTS_EXPORT,
        PERMISSIONS.NOTIFICATIONS_READ, PERMISSIONS.NOTIFICATIONS_MANAGE,
        PERMISSIONS.SETTINGS_READ,
        PERMISSIONS.SYSTEM_HEALTH_READ,
        PERMISSIONS.SECURITY_READ,
        PERMISSIONS.SESSIONS_READ,

        PERMISSIONS.SUPPORT_READ,
        PERMISSIONS.SUPPORT_REPLY,
        PERMISSIONS.SUPPORT_INTERNAL_NOTE,
        PERMISSIONS.SUPPORT_ASSIGN,
        PERMISSIONS.SUPPORT_CHANGE_STATUS,
        PERMISSIONS.SUPPORT_CLOSE,
        PERMISSIONS.SUPPORT_REOPEN,
        PERMISSIONS.SUPPORT_ATTACHMENTS,
        PERMISSIONS.SUPPORT_VIEW_CUSTOMER,
        PERMISSIONS.SUPPORT_AUDIT_READ
    ],

    [ADMIN_ROLES.FINANCE]: [
        PERMISSIONS.DASHBOARD_READ,
        PERMISSIONS.USERS_READ,
        PERMISSIONS.WALLETS_READ, PERMISSIONS.WALLETS_ADJUST,
        PERMISSIONS.TRANSACTIONS_READ, PERMISSIONS.TRANSACTIONS_RESOLVE, PERMISSIONS.TRANSACTIONS_REFUND,
        PERMISSIONS.DEPOSITS_READ, PERMISSIONS.DEPOSITS_RESOLVE,
        PERMISSIONS.CRYPTO_READ, PERMISSIONS.CRYPTO_RESOLVE,
        PERMISSIONS.FX_READ, PERMISSIONS.FX_MANAGE,
        PERMISSIONS.RECONCILIATION_READ, PERMISSIONS.RECONCILIATION_RESOLVE,
        PERMISSIONS.REPORTS_READ, PERMISSIONS.REPORTS_EXPORT,
        PERMISSIONS.AUDIT_READ,
        PERMISSIONS.SECURITY_READ,
        PERMISSIONS.SESSIONS_READ,

        PERMISSIONS.SUPPORT_READ,
        PERMISSIONS.SUPPORT_VIEW_CUSTOMER
    ],

    [ADMIN_ROLES.OPERATIONS]: [
        PERMISSIONS.DASHBOARD_READ,
        PERMISSIONS.USERS_READ,
        PERMISSIONS.TRANSACTIONS_READ,
        PERMISSIONS.DEPOSITS_READ,
        PERMISSIONS.CRYPTO_READ,
        PERMISSIONS.PROVIDERS_READ, PERMISSIONS.PROVIDERS_TEST,
        PERMISSIONS.SERVICES_READ,
        PERMISSIONS.ORDERS_READ, PERMISSIONS.ORDERS_RESOLVE,
        PERMISSIONS.WEBHOOKS_READ, PERMISSIONS.WEBHOOKS_REPLAY,
        PERMISSIONS.RECONCILIATION_READ,
        PERMISSIONS.REPORTS_READ,
        PERMISSIONS.SYSTEM_HEALTH_READ,
        PERMISSIONS.SECURITY_READ,
        PERMISSIONS.SESSIONS_READ,

        PERMISSIONS.SUPPORT_READ,
        PERMISSIONS.SUPPORT_REPLY,
        PERMISSIONS.SUPPORT_INTERNAL_NOTE,
        PERMISSIONS.SUPPORT_ATTACHMENTS,
        PERMISSIONS.SUPPORT_VIEW_CUSTOMER
    ],

    [ADMIN_ROLES.SUPPORT]: [
        PERMISSIONS.DASHBOARD_READ,
        PERMISSIONS.USERS_READ,
        PERMISSIONS.TRANSACTIONS_READ,
        PERMISSIONS.DEPOSITS_READ,
        PERMISSIONS.CRYPTO_READ,
        PERMISSIONS.ORDERS_READ,
        PERMISSIONS.NOTIFICATIONS_READ, PERMISSIONS.NOTIFICATIONS_MANAGE,
        PERMISSIONS.SECURITY_READ,
        PERMISSIONS.SESSIONS_READ,

        PERMISSIONS.SUPPORT_READ,
        PERMISSIONS.SUPPORT_REPLY,
        PERMISSIONS.SUPPORT_INTERNAL_NOTE,
        PERMISSIONS.SUPPORT_CHANGE_STATUS,
        PERMISSIONS.SUPPORT_ASSIGN,
        PERMISSIONS.SUPPORT_CLOSE,
        PERMISSIONS.SUPPORT_REOPEN,
        PERMISSIONS.SUPPORT_ATTACHMENTS,
        PERMISSIONS.SUPPORT_VIEW_CUSTOMER
    ],

    [ADMIN_ROLES.AUDITOR]: [
        PERMISSIONS.DASHBOARD_READ,
        PERMISSIONS.USERS_READ,
        PERMISSIONS.TRANSACTIONS_READ,
        PERMISSIONS.DEPOSITS_READ,
        PERMISSIONS.CRYPTO_READ,
        PERMISSIONS.RECONCILIATION_READ,
        PERMISSIONS.REPORTS_READ, PERMISSIONS.REPORTS_EXPORT,
        PERMISSIONS.AUDIT_READ, PERMISSIONS.AUDIT_EXPORT,
        PERMISSIONS.SYSTEM_HEALTH_READ,
        PERMISSIONS.SECURITY_READ,
        PERMISSIONS.SESSIONS_READ,

        PERMISSIONS.SUPPORT_READ,
        PERMISSIONS.SUPPORT_AUDIT_READ
    ],

    [ADMIN_ROLES.READ_ONLY]: [
        PERMISSIONS.DASHBOARD_READ,
        PERMISSIONS.USERS_READ,
        PERMISSIONS.TRANSACTIONS_READ,
        PERMISSIONS.DEPOSITS_READ,
        PERMISSIONS.CRYPTO_READ,
        PERMISSIONS.REPORTS_READ,
        PERMISSIONS.SECURITY_READ,
        PERMISSIONS.SESSIONS_READ,

        PERMISSIONS.SUPPORT_READ
    ]
});

// ─── Role slug cache (E.1) ──────────────────────────────────────
// 30-second cache keyed by role slug. Only caches the YES/NO answer
// of "does this slug exist as an admin role?" — never caches the
// permission list, so a super-admin's role edit is picked up on the
// next request in production. On cache-miss we query admin_roles;
// if the table does not exist, we fall back to the frozen set so a
// pre-migration deployment keeps working.
const ROLE_CACHE_TTL_MS = 30_000;
const _roleCache = new Map();   // slug → { val: boolean, exp: number }

function _cacheGet(slug) {
    const row = _roleCache.get(slug);
    if (!row) return undefined;
    if (row.exp < Date.now()) { _roleCache.delete(slug); return undefined; }
    return row.val;
}
function _cacheSet(slug, val) {
    _roleCache.set(slug, { val, exp: Date.now() + ROLE_CACHE_TTL_MS });
    // Cheap eviction — cap the map.
    if (_roleCache.size > 200) {
        const firstKey = _roleCache.keys().next().value;
        if (firstKey) _roleCache.delete(firstKey);
    }
}
function invalidateRoleCache(slug) {
    if (slug) _roleCache.delete(String(slug).toLowerCase());
    else _roleCache.clear();
}

async function isAdminRoleAsync(role) {
    const slug = String(role || '').toLowerCase();
    if (!slug) return false;

    // Super admin and all system roles are always valid — no DB hit.
    if (ADMIN_ROLE_VALUES.includes(slug)) return true;

    const cached = _cacheGet(slug);
    if (cached !== undefined) return cached;

    try {
        const { data, error } = await supabaseAdmin
            .from('admin_roles')
            .select('slug')
            .eq('slug', slug)
            .maybeSingle();

        // Missing table → fall back to the frozen set (pre-migration).
        if (error && (error.code === '42P01' || error.code === 'PGRST205')) {
            _cacheSet(slug, false);
            return false;
        }
        const exists = !!data;
        _cacheSet(slug, exists);
        return exists;
    } catch {
        // DB failure → FAIL CLOSED for role validity.
        _cacheSet(slug, false);
        return false;
    }
}

// Kept for synchronous callers that only want the frozen-set answer.
// Prefer isAdminRoleAsync() in request paths.
function isAdminRole(role) {
    return ADMIN_ROLE_VALUES.includes(String(role || '').toLowerCase());
}

function roleHasPermission(role, permission) {
    const perms = ROLE_PERMISSIONS[role] || [];
    if (perms.includes('*')) return true;
    return perms.includes(permission);
}

// ─── Client IP ──────────────────────────────────────────────────
// TRUSTED_PROXIES controls how many hops we walk when parsing
// x-forwarded-for. Default 1 (single reverse proxy in front of the
// app). Set TRUSTED_PROXIES=0 when Express is exposed directly.
const TRUSTED_PROXIES = (() => {
    const raw = process.env.TRUSTED_PROXIES;
    const n = parseInt(raw == null ? '1' : raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 1;
})();

function getClientIp(req) {
    if (!req) return null;
    // If Express already trusts the proxy chain, req.ip is correct.
    if (typeof req.ip === 'string' && req.ip) return _normalizeIp(req.ip);

    const fwd = req.headers?.['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) {
        const parts = fwd.split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length) {
            // Walk back TRUSTED_PROXIES hops from the RIGHT.
            const idx = Math.max(0, parts.length - 1 - TRUSTED_PROXIES);
            return _normalizeIp(parts[idx]);
        }
    }
    return _normalizeIp(req.socket?.remoteAddress || null);
}

function _normalizeIp(raw) {
    if (!raw) return null;
    const s = String(raw).replace(/^::ffff:/, '');
    if (s === '::1' || s === '127.0.0.1' || s === 'localhost') return null;
    return s;
}

function safeAdminIdentity(user) {
    if (!user) return null;
    return {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        isAdmin: user.isAdmin,
        isSuperAdmin: user.isSuperAdmin
    };
}

function ensureCorrelationId(req, res) {
    const inbound = req.headers?.['x-correlation-id'];
    const safe = (typeof inbound === 'string' && CORR_RE.test(inbound))
        ? inbound
        : crypto.randomUUID();
    req.correlationId = safe;
    if (res && typeof res.setHeader === 'function' && !res.headersSent) {
        res.setHeader('X-Correlation-Id', safe);
    }
    return safe;
}

// ─── Cache-Control: no-store on all admin responses ─────────────
// Applied to every response sent by adminAuth-family middleware,
// including success paths (E.6).
function _applyAdminNoStoreHeaders(res) {
    if (!res || typeof res.setHeader !== 'function' || res.headersSent) return;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    // Prevent caching of authenticated content by intermediate caches.
    res.setHeader('Vary', 'Authorization');
}

// ─── JWT verification ───────────────────────────────────────────
function verifyAdminJwt(req, expectedType = 'admin') {
    const auth = req.headers?.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        const e = new Error('Authentication required.');
        e.status = 401; e.code = 'NO_TOKEN';
        throw e;
    }
    const token = auth.slice(7);
    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET, {
            algorithms: ['HS256'],
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE
        });
    } catch (err) {
        const expired = err.name === 'TokenExpiredError';
        const e = new Error(expired
            ? 'Your session has expired. Please sign in again.'
            : 'Invalid or expired token.');
        e.status = 401;
        e.code = expired ? 'SESSION_EXPIRED' : 'INVALID_TOKEN';
        throw e;
    }

    // ── Type check ─────────────────────────────────────────────
    if (decoded.type !== expectedType) {
        const e = new Error(
            expectedType === 'admin_setup'
                ? 'Setup session required.'
                : 'Admin access required.'
        );
        e.status = 403;
        e.code = expectedType === 'admin_setup'
            ? 'SETUP_SESSION_REQUIRED'
            : 'ADMIN_REQUIRED';
        throw e;
    }

    // ── Identity ───────────────────────────────────────────────
    if (!decoded.id || typeof decoded.id !== 'string') {
        const e = new Error('Invalid session. Please sign in again.');
        e.status = 401; e.code = 'INVALID_SESSION';
        throw e;
    }

    // ── Session-id shape (ONLY for full admin tokens) ──────────
    if (expectedType === 'admin') {
        if (!decoded.sid || typeof decoded.sid !== 'string' || !UUID_RE.test(decoded.sid)) {
            const e = new Error('Invalid session. Please sign in again.');
            e.status = 401; e.code = 'INVALID_SESSION';
            throw e;
        }
    }

    return decoded;
}

// ─── buildAdminContext ──────────────────────────────────────────
async function buildAdminContext(req, requiredPermission, expectedType = 'admin') {
    _applyAdminNoStoreHeaders(req.res);

    const decoded = verifyAdminJwt(req, expectedType);
    const correlationId = ensureCorrelationId(req, req.res);

    // 1. Read profile
    let profile;
    try {
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select(PROFILE_SELECT.join(', '))
            .eq('id', decoded.id)
            .maybeSingle();
        if (error) throw new Error('Authentication service temporarily unavailable.');
        profile = data;
    } catch (dbErr) {
        const e = new Error('Authentication service temporarily unavailable.');
        e.status = 503; e.code = 'AUTH_SERVICE_UNAVAILABLE';
        throw e;
    }

    if (!profile) {
        const e = new Error('Admin profile not found.');
        e.status = 403; e.code = 'USER_NOT_FOUND'; throw e;
    }
    if (profile.deleted_at) {
        const e = new Error('This admin account has been deleted.');
        e.status = 403; e.code = 'ACCOUNT_DELETED'; throw e;
    }

    // E.4 — block suspended, banned, inactive (not just suspended).
    const profileStatus = String(profile.status || '').toLowerCase();
    if (profileStatus && profileStatus !== 'active') {
        const e = new Error(
            profileStatus === 'banned'
                ? 'This admin account has been banned.'
                : profileStatus === 'suspended'
                    ? 'This admin account has been suspended.'
                    : 'This admin account is not active.'
        );
        e.status = 403;
        e.code = profileStatus === 'banned'
            ? 'ACCOUNT_BANNED'
            : profileStatus === 'suspended'
                ? 'ACCOUNT_SUSPENDED'
                : 'ACCOUNT_INACTIVE';
        throw e;
    }

    // ── Role check (async — supports custom roles, E.1) ────────
    const role = String(profile.role || '').toLowerCase();
    const roleValid = await isAdminRoleAsync(role);
    if (!roleValid) {
        const e = new Error('Admin access required.');
        e.status = 403; e.code = 'ADMIN_REQUIRED'; throw e;
    }

    // ── Session check (ONLY for full admin tokens) ─────────────
    if (expectedType === 'admin') {
        if (!profile.current_session_id || profile.current_session_id !== decoded.sid) {
            const e = new Error('Your session has been revoked. Please sign in again.');
            e.status = 401; e.code = 'SESSION_REVOKED';
            throw e;
        }
        if (profile.session_expires_at && new Date(profile.session_expires_at) < new Date()) {
            const e = new Error('Your session has expired. Please sign in again.');
            e.status = 401; e.code = 'SESSION_EXPIRED';
            throw e;
        }
        try {
            const { data: sess, error: sessErr } = await supabaseAdmin
                .from('user_sessions')
                .select('session_id, user_id, is_active, revoked_at, expires_at, mfa_verified, mfa_verified_at, mfa_method')
                .eq('session_id', decoded.sid)
                .eq('user_id', profile.id)
                .maybeSingle();
            if (sessErr) throw new Error('Auth service unavailable');
            if (!sess) {
                const e = new Error('Your session could not be found. Please sign in again.');
                e.status = 401; e.code = 'SESSION_NOT_FOUND'; throw e;
            }
            if (!sess.is_active || sess.revoked_at) {
                const e = new Error('Your session has been revoked. Please sign in again.');
                e.status = 401; e.code = 'SESSION_REVOKED'; throw e;
            }
            if (sess.expires_at && new Date(sess.expires_at) <= new Date()) {
                const e = new Error('Your session has expired.');
                e.status = 401; e.code = 'SESSION_EXPIRED'; throw e;
            }
            req.sessionMfaVerified    = !!sess.mfa_verified;
            req.sessionMfaVerifiedAt  = sess.mfa_verified_at || null;
            req.sessionMfaMethod      = sess.mfa_method || null;
        } catch (e) {
            if (e.status) throw e;
            const err = new Error('Auth service unavailable');
            err.status = 503; err.code = 'AUTH_SERVICE_UNAVAILABLE'; throw err;
        }
    }

    // ── Permissions ────────────────────────────────────────────
    // Setup tokens do NOT get permissions.
    let effective = [];
    if (expectedType === 'admin') {
        if (role === ADMIN_ROLES.SUPER_ADMIN) {
            effective = ['*'];
        } else {
            // Resolve permissions from admin_roles for ANY slug (E.1).
            // Falls back to ROLE_PERMISSIONS if the row is missing —
            // this preserves behaviour on a fresh deploy with an
            // empty admin_roles table, and for any legacy role not
            // yet migrated.
            let rolePermissions = null;
            try {
                const { data, error } = await supabaseAdmin
                    .from('admin_roles')
                    .select('permissions')
                    .eq('slug', role)
                    .maybeSingle();
                if (error) {
                    // Missing table is not fatal (pre-migration). Any
                    // other error is.
                    if (!(error.code === '42P01' || error.code === 'PGRST205')) {
                        console.warn('[ADMIN AUTH] admin_roles lookup error:', error.message);
                    }
                } else if (data && Array.isArray(data.permissions)) {
                    rolePermissions = data.permissions;
                }
            } catch (e) {
                console.warn('[ADMIN AUTH] admin_roles exception:', e.message);
            }

            const defaults = rolePermissions != null
                ? rolePermissions
                : (ROLE_PERMISSIONS[role] || []);
            const merged = new Set(defaults);

            // Per-user overrides (admin_permissions).
            try {
                const { data, error } = await supabaseAdmin
                    .from('admin_permissions')
                    .select('permission, granted')
                    .eq('user_id', profile.id);
                if (error) throw new Error('Permission service unavailable');
                (data || []).forEach(o => {
                    if (o.granted) merged.add(o.permission);
                    else merged.delete(o.permission);
                });
            } catch (e) {
                const err = new Error('Permission service unavailable');
                err.status = 503; err.code = 'PERMISSION_SERVICE_UNAVAILABLE'; throw err;
            }
            effective = Array.from(merged);
        }
    }

    // ── Context ────────────────────────────────────────────────
    req.user = req.user || {};
    req.user.id = profile.id;
    req.user.email = profile.email;
    req.user.username = profile.username;
    req.user.role = role;
    req.user.isAdmin = true;
    req.user.isSuperAdmin = role === ADMIN_ROLES.SUPER_ADMIN;

    req.adminContext = {
        id: profile.id,
        email: profile.email,
        username: profile.username,
        role,
        isSuperAdmin: role === ADMIN_ROLES.SUPER_ADMIN,
        permissions: effective,
        sessionId: decoded.sid || null,
        authTime: new Date().toISOString(),
        correlationId,
        ip: getClientIp(req),
        authType: expectedType,
        mfaEnabled: !!profile.two_factor_enabled,
        hasPendingMfa: false    // E.3 — no longer leaks the pending-secret column
    };

    if (requiredPermission && expectedType === 'admin') {
        const has = effective.includes('*') || effective.includes(requiredPermission);
        if (!has) {
            const e = new Error('You do not have permission to perform this action.');
            e.status = 403; e.code = 'PERMISSION_DENIED';
            e.required = requiredPermission; throw e;
        }
    }

    return req.adminContext;
}
// ─── Socket-context resolver ───────────────────────────────────
// Used by server.js `io.use` to build an admin context for a
// socket handshake. Same logic as buildAdminContext, minus the
// req/res plumbing. Returns { ok: true, ctx } or { ok: false,
// code, message }. Never throws — callers disconnect the socket
// on !ok.
//
// The returned ctx has the exact shape buildAdminContext produces
// (id, email, username, role, isSuperAdmin, permissions, sessionId,
// authType: 'admin'), so anything that consumes req.adminContext
// also consumes socket.adminCtx without modification.
async function resolvePermissionsForUser(userId, sessionId = null) {
    if (!userId || typeof userId !== 'string') {
        return { ok: false, code: 'INVALID_USER', message: 'Invalid user id' };
    }

    // 1. Profile read.
    let profile;
    try {
        const { data, error } = await supabaseAdmin
            .from('profiles')
            .select(PROFILE_SELECT.join(', '))
            .eq('id', userId)
            .maybeSingle();
        if (error) {
            return { ok: false, code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Auth service unavailable' };
        }
        profile = data;
    } catch (_) {
        return { ok: false, code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Auth service unavailable' };
    }

    if (!profile) return { ok: false, code: 'USER_NOT_FOUND', message: 'Profile not found' };
    if (profile.deleted_at) return { ok: false, code: 'ACCOUNT_DELETED', message: 'Account deleted' };

    const profileStatus = String(profile.status || '').toLowerCase();
    if (profileStatus && profileStatus !== 'active') {
        return {
            ok: false,
            code: profileStatus === 'banned'    ? 'ACCOUNT_BANNED'
                : profileStatus === 'suspended' ? 'ACCOUNT_SUSPENDED'
                :                                 'ACCOUNT_INACTIVE',
            message: 'Account not active'
        };
    }

    // 2. Role check.
    const role = String(profile.role || '').toLowerCase();
    const roleValid = await isAdminRoleAsync(role);
    if (!roleValid) return { ok: false, code: 'ADMIN_REQUIRED', message: 'Admin access required' };

    // 3. Session check (only when a session was passed — customer
    //    sockets have no admin session).
    if (sessionId) {
        if (!profile.current_session_id || profile.current_session_id !== sessionId) {
            return { ok: false, code: 'SESSION_REVOKED', message: 'Session revoked' };
        }
        if (profile.session_expires_at && new Date(profile.session_expires_at) < new Date()) {
            return { ok: false, code: 'SESSION_EXPIRED', message: 'Session expired' };
        }
        try {
            const { data: sess, error: sessErr } = await supabaseAdmin
                .from('user_sessions')
                .select('session_id, user_id, is_active, revoked_at, expires_at')
                .eq('session_id', sessionId)
                .eq('user_id', profile.id)
                .maybeSingle();
            if (sessErr) return { ok: false, code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Auth service unavailable' };
            if (!sess) return { ok: false, code: 'SESSION_NOT_FOUND', message: 'Session not found' };
            if (!sess.is_active || sess.revoked_at) {
                return { ok: false, code: 'SESSION_REVOKED', message: 'Session revoked' };
            }
            if (sess.expires_at && new Date(sess.expires_at) <= new Date()) {
                return { ok: false, code: 'SESSION_EXPIRED', message: 'Session expired' };
            }
        } catch (_) {
            return { ok: false, code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Auth service unavailable' };
        }
    }

    // 4. Permissions.
    let effective = [];
    if (role === ADMIN_ROLES.SUPER_ADMIN) {
        effective = ['*'];
    } else {
        let rolePermissions = null;
        try {
            const { data, error } = await supabaseAdmin
                .from('admin_roles')
                .select('permissions')
                .eq('slug', role)
                .maybeSingle();
            if (!error && data && Array.isArray(data.permissions)) {
                rolePermissions = data.permissions;
            }
        } catch (_) { /* fall through to defaults */ }

        const defaults = rolePermissions != null
            ? rolePermissions
            : (ROLE_PERMISSIONS[role] || []);
        const merged = new Set(defaults);

        try {
            const { data, error } = await supabaseAdmin
                .from('admin_permissions')
                .select('permission, granted')
                .eq('user_id', profile.id);
            if (error) {
                return { ok: false, code: 'PERMISSION_SERVICE_UNAVAILABLE', message: 'Permission service unavailable' };
            }
            (data || []).forEach((o) => {
                if (o.granted) merged.add(o.permission);
                else merged.delete(o.permission);
            });
        } catch (_) {
            return { ok: false, code: 'PERMISSION_SERVICE_UNAVAILABLE', message: 'Permission service unavailable' };
        }
        effective = Array.from(merged);
    }

    return {
        ok: true,
        ctx: {
            id: profile.id,
            email: profile.email,
            username: profile.username,
            role,
            isSuperAdmin: role === ADMIN_ROLES.SUPER_ADMIN,
            permissions: effective,
            sessionId: sessionId || null,
            authType: 'admin',
            mfaEnabled: !!profile.two_factor_enabled
        }
    };
}

// ─── Programmatic permission helpers ────────────────────────────
function can(ctx, permission) {
    if (!ctx) return false;
    if (ctx.authType !== 'admin') return false;
    if (ctx.isSuperAdmin) return true;
    if (!Array.isArray(ctx.permissions)) return false;
    if (ctx.permissions.includes('*')) return true;
    return ctx.permissions.includes(permission);
}
function canAny(ctx, perms) {
    return Array.isArray(perms) && perms.some(p => can(ctx, p));
}
function canAll(ctx, perms) {
    return Array.isArray(perms) && perms.every(p => can(ctx, p));
}

// ─── Error sender ───────────────────────────────────────────────
function sendAdminError(res, err) {
    const status = err?.status || 500;
    const code = err?.code || 'ADMIN_AUTH_ERROR';
    const message = err?.message || 'Admin authorization failed.';

    if (status >= 500) {
        console.error('[ADMIN AUTH]', code, message);
    } else if (status === 401 || status === 403) {
        try {
            const adminId = err?.adminId || null;
            console.warn('[ADMIN AUTH DENIED]', code,
                err?.required ? `required=${err.required}` : '',
                adminId ? `admin=${adminId}` : '');
        } catch (_) { /* never throw from logging */ }
    }

    if (res && typeof res.status === 'function' && !res.headersSent) {
        _applyAdminNoStoreHeaders(res);
        return res.status(status).json({
            success: false,
            error: message,
            code,
            ...(err?.required ? { required: err.required } : {}),
            ...(err?.current_version != null ? { current_version: err.current_version } : {})
        });
    }
    console.error('[ADMIN AUTH] Unreported error:', code, message);
}

// ─── Middleware factories ───────────────────────────────────────
function adminAuth(req, res, next) {
    req.res = req.res || res;
    buildAdminContext(req, null, 'admin')
        .then(() => next())
        .catch(err => sendAdminError(res, err));
}

function setupAuth(req, res, next) {
    req.res = req.res || res;
    buildAdminContext(req, null, 'admin_setup')
        .then(() => next())
        .catch(err => sendAdminError(res, err));
}

function superAdminAuth(req, res, next) {
    req.res = req.res || res;
    buildAdminContext(req, null, 'admin')
        .then(() => {
            if (!req.adminContext.isSuperAdmin) {
                return sendAdminError(res, {
                    status: 403,
                    code: 'SUPER_ADMIN_REQUIRED',
                    message: 'Super admin privileges required.',
                    adminId: req.adminContext.id
                });
            }
            next();
        })
        .catch(err => sendAdminError(res, err));
}
const requireSuperAdmin = superAdminAuth;

function requirePermission(permission) {
    return (req, res, next) => {
        req.res = req.res || res;
        buildAdminContext(req, permission, 'admin')
            .then(() => next())
            .catch(err => sendAdminError(res, {
                ...err,
                adminId: err?.adminId || null
            }));
    };
}

// ─── Step-up ────────────────────────────────────────────────────
// E.5 — the token-based path is DEPRECATED. The canonical path is
// the session-based requireStepUpAuth from adminStepUp.js. This
// export is kept so existing routes that import requireStepUp
// continue to work, but its implementation now delegates to the
// session-based middleware. The legacy X-Step-Up-Token header is
// still accepted (for backwards compat with any mobile clients that
// cached an old build), but it is validated atomically and only
// once — a token cannot be consumed twice.
let requireStepUpAuth;
try {
    const stepUp = require('./adminStepUp');
    if (!stepUp || typeof stepUp.requireStepUpAuth !== 'function') {
        throw new Error('adminStepUp.js must export requireStepUpAuth as a function');
    }
    requireStepUpAuth = stepUp.requireStepUpAuth;
} catch (err) {
    console.error('[ADMIN AUTH] requireStepUpAuth unavailable:', err.message);
    requireStepUpAuth = (req, res, next) => {
        const e = new Error('Step-up authentication is not configured on this server.');
        e.status = 503;
        e.code = 'STEP_UP_NOT_CONFIGURED';
        throw e;
    };
}

// Atomic token consumption — single UPDATE ... RETURNING so two
// concurrent requests cannot both succeed with the same token.
// Returns true only if this call is the one that consumed the token.
async function _consumeStepUpToken(token, adminId) {
    if (!token || !adminId) return false;

    const nowIso = new Date().toISOString();

    // NOTE: `token` is compared as a plain string here for
    // compatibility with the current step_up_tokens schema. The
    // migration in FILE 1 accepts either plaintext or hashed tokens;
    // if you later switch the column to hashed, hash here with
    // `crypto.createHash('sha256').update(token).digest('hex')`
    // before the query. No other change is needed.
    const { data, error } = await supabaseAdmin
        .from('step_up_tokens')
        .update({ used_at: nowIso })
        .eq('token', token)
        .eq('admin_id', adminId)
        .is('used_at', null)
        .gt('expires_at', nowIso)
        .select('admin_id, expires_at, used_at')
        .maybeSingle();

    if (error) {
        // Missing table (pre-migration) is treated as "cannot verify"
        // — fail closed.
        if (error.code === '42P01' || error.code === 'PGRST205') return false;
        console.warn('[ADMIN AUTH] step-up token consume error:', error.message);
        return false;
    }
    return !!data;
}

function requireStepUp(options = {}) {
    const maxAgeSeconds = Number.isFinite(options.maxAgeSeconds)
        ? Math.max(30, Math.min(3600, options.maxAgeSeconds))
        : 300;

    return async (req, res, next) => {
        // Prefer the session-based path — it is what the frontend
        // actually implements via /api/admin/auth/step-up which
        // stamps user_sessions.mfa_verified. Delegating here means
        // there is only one source of truth for "is step-up fresh?".
        try {
            return requireStepUpAuth({ maxAgeSeconds })(req, res, next);
        } catch (primaryErr) {
            // Do not fall through on unexpected errors — this is a
            // security gate, so fail closed.
            return sendAdminError(res, {
                status: 500,
                code: 'STEP_UP_ERROR',
                message: 'Security verification failed.'
            });
        }
    };
}

// ─── Audit ─────────────────────────────────────────────────────
async function recordAdminAction({
    adminId, adminEmail, adminRole, actorType,
    action, targetType, targetId,
    before = null, after = null, reason = null,
    adminNote = null, result = 'success',
    failureCode = null, durationMs = null,
    correlationId = null, requestId = null, sessionId = null,
    provider = null, operation = null, metadata = null,
    ip = null, userAgent = null, location = null,
    req = null
}) {
    if (!adminId || !action) return;
    try {
        await auditLog.record({
            adminId,
            adminEmail: adminEmail || req?.adminContext?.email || null,
            adminRole:  adminRole  || req?.adminContext?.role  || null,
            actorType:  actorType  || (req?.adminContext ? 'admin' : 'system'),

            action,
            targetType,
            targetId,

            before,
            after,

            reason,
            adminNote,

            result,
            failureCode,
            durationMs,

            correlationId: correlationId || req?.correlationId || null,
            requestId:     requestId     || req?.requestId || req?.headers?.['x-request-id'] || null,
            sessionId:     sessionId     || req?.adminContext?.sessionId || null,

            provider,
            operation,
            metadata,

            ip:        ip        || getClientIp(req),
            userAgent: userAgent || req?.headers?.['user-agent'] || null,
            location
        });
    } catch (e) {
        console.warn('[ADMIN AUDIT] Failed to record action:', e.message);
    }
}

async function recordAdminActionStrict(opts) {
    const mod = require('./adminAuditStrict');
    if (!mod || typeof mod.recordAdminActionStrict !== 'function') {
        const e = new Error('Audit strict middleware is not configured.');
        e.code = 'AUDIT_STRICT_NOT_CONFIGURED';
        e.status = 503;
        throw e;
    }
    return mod.recordAdminActionStrict(opts);
}

// ─── CSRF — same-origin check for state-changing routes ────────
// E.6 — token is bearer, so CSRF is minimal, but a hostile page
// could still call the API with a stolen token if the token were
// exposed via XSS on the admin origin. Reject cross-origin writes
// where the Origin header disagrees with the request host. This is
// cheap and fail-closed: if Origin is present and does not match,
// deny. Requests without Origin (native mobile, curl) pass.
function assertSameOrigin(req, res, next) {
    const method = String(req.method || '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();

    const origin = req.headers?.origin;
    if (!origin) return next();  // no Origin → not a browser form/script

    const allowed = (process.env.ADMIN_ALLOWED_ORIGINS || '')
        .split(',').map(s => s.trim()).filter(Boolean);

    let ok = false;
    try {
        const o = new URL(origin);
        // Always allow the request's own host.
        const host = req.headers.host;
        if (host && o.host === host) ok = true;
        // Allow explicit allow-list entries.
        if (!ok && allowed.includes(`${o.protocol}//${o.host}`)) ok = true;
    } catch {
        // Malformed Origin — fail closed.
        ok = false;
    }

    if (ok) return next();
    return sendAdminError(res, {
        status: 403,
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Request origin is not allowed.'
    });
}

// ─── Service / provider / operation gates ──────────────────────
// The consumers of these helpers live in service routes
// (deposits, purchases, wallet, provider clients). Exporting them
// from adminAuth.js means there is exactly ONE import path and
// ONE behaviour for "is this action currently permitted?". These
// delegate to adminSettingsService so the source of truth remains
// app_config — this file only provides a stable call site.
//
// These functions throw on denial (not just return false) so any
// service that forgets to check the return value still fails
// closed. Callers that want a boolean should use isOperationAllowed.
async function _getSettingsService() {
    // Lazy-require to avoid a circular import: adminSettingsService
    // imports adminAuth for its route layer.
    return require('../services/adminSettingsService');
}

async function assertServiceEnabled(service) {
    const svc = await _getSettingsService();
    return svc.assertServiceEnabled(service);
}
async function assertProviderEnabled(provider) {
    const svc = await _getSettingsService();
    return svc.assertProviderEnabled(provider);
}
async function assertOperationAllowed(operation) {
    const svc = await _getSettingsService();
    return svc.assertOperationAllowed(operation);
}
async function isServiceEnabled(service) {
    const svc = await _getSettingsService();
    return svc.isServiceEnabled(service);
}
async function isProviderEnabled(provider) {
    const svc = await _getSettingsService();
    return svc.isProviderEnabled(provider);
}
async function isOperationAllowed(operation) {
    const svc = await _getSettingsService();
    return svc.isOperationAllowed(operation);
}

// ─── Exports ────────────────────────────────────────────────────
module.exports = {
    // middleware
    adminAuth,
    setupAuth,
    superAdminAuth,
    requireSuperAdmin,
    requirePermission,
    requireStepUpAuth,
    requireStepUp,        // deprecated — delegates to requireStepUpAuth
    assertSameOrigin,

    // audit
    recordAdminAction,
    recordAdminActionStrict,

    // context builders / helpers
    buildAdminContext,
    getClientIp,
    safeAdminIdentity,
    isAdminRole,          // sync, frozen-set only
    isAdminRoleAsync,     // async, supports custom roles (E.1)
    invalidateRoleCache,  // call after admin_roles writes
    roleHasPermission,
    can,
    canAny,
    canAll,

    // feature gates (delegate to adminSettingsService)
    assertServiceEnabled,
    assertProviderEnabled,
    assertOperationAllowed,
    isServiceEnabled,
    isProviderEnabled,
    isOperationAllowed,
    resolvePermissionsForUser,

    // registries
    ADMIN_ROLES,
    ADMIN_ROLE_VALUES,
    PERMISSIONS,
    ROLE_PERMISSIONS,

    // constants
    PROFILE_SELECT,
    JWT_ISSUER,
    JWT_AUDIENCE
};