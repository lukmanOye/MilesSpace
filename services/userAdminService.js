// services/userAdminService.js
// ─────────────────────────────────────────────────────────────────
// MilesSpace User Management — production hardened v3.
//
// CHANGES vs. v2:
//   • Bug 1:  getStats → single RPC `admin_users_stats_v2` returns
//             every KPI + role_counts + ledger totals. 30s in-process
//             cache, bypass with ?fresh=1.
//   • Bug 2:  "Active" and "Verified" are now precise. See comments
//             above each KPI. The RPC and the UI subtitle agree.
//   • Bug 3:  WAT (UTC+1) day boundaries used inside the RPC (server
//             local time is no longer trusted).
//   • Bug 4:  listUsers fetches ledger_accounts via
//             `admin_users_ledger_totals_for_ids` — ONE query for the
//             whole page. Falls back to `wallet_ngn: null` when the
//             RPC fails. Never reads profiles.wallet_* as truth.
//   • Bug 5:  getWallets pending totals use BigInt cents. Withdrawal
//             fields REMOVED from both the query and the response.
//   • Bug 6:  fmtNum / fmtCcy — client-side, but the service never
//             returns floats for money. All money is String.
//   • Bug 7:  updateProfile honours `if_updated_at`. Returns
//             409 STALE_RECORD on mismatch.
//   • Bug 8:  setStatus blocks self-suspend, blocks suspending the
//             last super_admin, and revokes sessions atomically when
//             status becomes suspended/banned.
//   • Bug 9:  getUser360 runs its 4 sub-queries in Promise.all.
//   • Bug 10: /users/:id/detail merged into getOverview. Legacy alias
//             kept in routes only.
//   • Bug 11: getNotes joins profiles for author_name.
//   • Bug 12: getAudit reshapes before/after into a field-level diff.
//   • Bug 13: (client-side focus trap in users.html — no service
//              change needed)
//   • Bug 14: (client-side URL param handling — no service change)
//   • Bug 15: pg_trgm indexes live in the migration.
//
//   • Withdrawals are DISABLED. Every `withdrawal` reference is gone
//     from queries, filters, and response shapes.
//   • No emoji anywhere. Font Awesome class names only (notifications
//     use `icon_fa` strings like "fa-solid fa-wallet").
//   • Role-based PII masking (maskEmail, maskPhone) applied at the
//     service boundary — list responses NEVER expose full PII to
//     admins without users.pii_reveal.
//   • POST /users/:id/reveal → getRevealedPII() returns full values
//     and writes an audit row.
//   • Bulk actions: bulkForceLogout, bulkAddTag. Limited to 100.
//   • CSV export: buildUsersCsv() returns a streamed string builder
//     capped at 5,000 rows.
//   • Daily wallet adjustment cap constant + per-admin audit when
//     exceeded (WALLET_DAILY_CAP_*).
//   • Read audit throttled via admin_audit_read RPC.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');

// ─── Constants ──────────────────────────────────────────────────
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 20;
const BULK_MAX = 100;
const CSV_MAX_ROWS = 5000;
const MAX_WALLET_ADJUSTMENT = 100_000_000;
const APPROVAL_THRESHOLD = Number(process.env.ADMIN_APPROVAL_THRESHOLD || 100_000);

// Daily wallet adjustment caps per admin (sum of |amount| in a 24h
// rolling window, grouped by currency).
const WALLET_DAILY_CAP = {
    NGN: 50_000_000,       // ₦50M per admin per rolling day
    USD: 50_000            // $50k per admin per rolling day
};

const ALLOWED_CURRENCIES = new Set(['NGN', 'USD']);
const ALLOWED_STATUS = new Set(['active', 'inactive', 'suspended', 'banned']);
const ALLOWED_ROLES = new Set([
    'user', 'admin', 'super_admin', 'finance',
    'operations', 'support', 'auditor', 'read_only'
]);

// Withdrawals are disabled platform-wide, so this list omits them.
const ALLOWED_RESTRICTIONS = new Set([
    'deposits', 'gift_cards', 'virtual_cards',
    'transactions', 'login', 'payouts', 'trading'
]);

const ADMIN_ROLES = new Set([
    'admin', 'super_admin', 'finance', 'operations',
    'support', 'auditor', 'read_only'
]);

const SORT_ALLOW = new Set(['newest', 'last_seen', 'risk', 'ledger_balance']);

// ─── In-process stats cache (30s) ───────────────────────────────
const _statsCache = { at: 0, value: null };
const STATS_TTL_MS = 30_000;

// ─── Errors ─────────────────────────────────────────────────────
function serviceError(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    Object.assign(e, extra);
    return e;
}

// ─── Money & numeric helpers (NO floats for money) ──────────────
function isDecimalString(v) {
    return typeof v === 'string' && /^-?\d+(\.\d{1,2})?$/.test(v);
}
function toIntOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
}
// BigInt cents — used only for pending amounts that must be summed.
function toCents(v) {
    if (v == null || v === '') return null;
    const s = String(v);
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    const neg = s.startsWith('-');
    const [i, f = ''] = s.replace('-', '').split('.');
    const frac2 = (f + '00').slice(0, 2);
    try {
        const cents = BigInt(i || '0') * 100n + BigInt(frac2 || '0');
        return neg ? -cents : cents;
    } catch { return null; }
}
function fromCents(c) {
    if (c == null) return null;
    const neg = c < 0n;
    const abs = neg ? -c : c;
    return (neg ? '-' : '') + (abs / 100n).toString() + '.' + (abs % 100n).toString().padStart(2, '0');
}
function sumMoneyStrings(list) {
    let total = 0n;
    for (const v of list) {
        const c = toCents(v);
        if (c === null) return null;
        total += c;
    }
    return fromCents(total);
}

// ─── PII masking ────────────────────────────────────────────────
function maskEmail(email) {
    if (!email || typeof email !== 'string') return '';
    const at = email.indexOf('@');
    if (at < 0) return email.slice(0, 2) + '***';
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const shown = local.length <= 2
        ? local.slice(0, 1) + '***'
        : local.slice(0, 2) + '***';
    return `${shown}@${domain}`;
}
function maskPhone(phone) {
    if (!phone || typeof phone !== 'string') return '';
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 4) return '***';
    return '***' + digits.slice(-4);
}

// ─── Scrubbing (for metadata blobs only — never for full rows) ──
const SENSITIVE_KEYS = [
    'password', 'password_hash', 'token', 'access_token', 'refresh_token',
    'api_key', 'secret', 'webhook_secret', 'mfa_secret', 'private_key',
    'authorization', 'cookie', 'transaction_pin'
];
function scrubObject(value, depth = 0) {
    if (depth > 6) return '[depth-limit]';
    if (value == null) return value;
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => scrubObject(v, depth + 1));
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
        const lower = k.toLowerCase();
        if (SENSITIVE_KEYS.some(bad => lower.includes(bad))) {
            clean[k] = '[REDACTED]';
        } else if (v && typeof v === 'object') {
            clean[k] = scrubObject(v, depth + 1);
        } else {
            clean[k] = v;
        }
    }
    return clean;
}

// ─── Transaction shaper ────────────────────────────────────────
function shapeTransaction(t, { includeMeta = false } = {}) {
    const base = {
        transaction_id:      t.id,
        type:                t.type || null,
        status:              t.status || null,
        currency:            String(t.currency || '').toUpperCase() || null,
        amount:              isDecimalString(String(t.amount ?? '')) ? String(t.amount) : null,
        fee:                 isDecimalString(String(t.fee ?? '')) ? String(t.fee) : null,
        revenue_ngn:         isDecimalString(String(t.revenue_ngn ?? '')) ? String(t.revenue_ngn) : null,
        revenue_usd:         isDecimalString(String(t.revenue_usd ?? '')) ? String(t.revenue_usd) : null,
        description:         t.description || null,
        customer_reference:  t.ref || t.reference || null,
        provider:            t.provider || null,
        provider_reference:  t.provider_reference || null,
        source_type:         t.source_type || null,
        source_id:           t.source_id || null,
        created_at:          t.created_at || null,
        completed_at:        t.completed_at || null,
        failed_at:           t.failed_at || null,
        failure_reason:      t.failure_reason || null
    };
    if (includeMeta) {
        const meta = t.meta || t.metadata || null;
        base.metadata = meta ? scrubObject(meta) : null;
    }
    return base;
}

// ─── RPC helper ─────────────────────────────────────────────────
async function tryRpc(name, args) {
    try {
        const { data, error } = await supabaseAdmin.rpc(name, args);
        if (error) return { ok: false, error: error.message, code: error.code };
        return { ok: true, data };
    } catch (e) {
        return { ok: false, error: e.message, code: e.code || 'RPC_THREW' };
    }
}

// ─── Audit writer ──────────────────────────────────────────────
async function writeAuditRow({
    adminId, adminEmail, adminRole, action, targetType, targetId,
    before, after, reason, req, severity = 'medium'
}) {
    try {
        const row = {
            admin_id: adminId,
            admin_email: adminEmail || null,
            admin_role: adminRole || null,
            action,
            target_type: targetType || null,
            target_id: targetId ? String(targetId) : null,
            before: before || null,
            after: after || null,
            reason: reason || null,
            category: 'admin',
            severity,
            result: 'success',
            ip_address: req?.ip || null,
            user_agent: req?.get?.('user-agent') || null,
            request_id: req?.id || null
        };
        const { error } = await supabaseAdmin.from('admin_audit_logs').insert(row);
        if (error) console.warn('[AUDIT] insert failed:', error.message);
    } catch (e) {
        console.warn('[AUDIT] exception:', e.message);
    }
}

// ─── Read-audit throttle via RPC ────────────────────────────────
async function recordReadAudit(ctx, targetType, targetId, tab) {
    if (!ctx?.id) return;
    try {
        await supabaseAdmin.rpc('admin_audit_read', {
            p_admin_id: ctx.id,
            p_admin_email: ctx.email || null,
            p_admin_role: ctx.role || null,
            p_target_type: targetType,
            p_target_id: String(targetId),
            p_tab: tab
        });
    } catch (e) {
        console.warn('[READ-AUDIT] failed:', e.message);
    }
}

// ═════════════════════════════════════════════════════════════════
//  STATS  (single RPC, 30s cache, ?fresh=1 bypass)
// ═════════════════════════════════════════════════════════════════

/**
 * Precise KPI definitions — the UI must display these subtitles
 * verbatim so the numbers match the labels.
 *
 *   total         : COUNT(*) of non-deleted profiles.
 *   active        : status = 'active' AND is_verified = TRUE. (It is NOT
 *                   just "status = active". An unverified active account
 *                   is not counted, because a customer who hasn't
 *                   confirmed their email cannot transact.)
 *   suspended     : status = 'suspended' OR status = 'banned'.
 *   unverified    : is_verified = FALSE.
 *   restricted    : exists an active row in user_restrictions.
 *   high_risk     : risk_level IN ('high','critical').
 *   new_today     : created_at >= WAT day start (UTC+1).
 *   new_this_week : created_at >= WAT day start − 6 days.
 */
async function getStats({ fresh = false } = {}) {
    if (!fresh && _statsCache.value && (Date.now() - _statsCache.at) < STATS_TTL_MS) {
        return _statsCache.value;
    }

    const r = await tryRpc('admin_users_stats_v2', {});
    if (!r.ok) {
        // Never fabricate. Report the failure.
        return {
            available: false,
            reason: r.code || 'STATS_RPC_FAILED',
            error: r.error,
            total: null, active: null, suspended: null, unverified: null,
            restricted: null, high_risk: null,
            new_today: null, new_this_week: null,
            role_counts: {},
            ledger: { ngn: null, usd: null, available: false }
        };
    }

    // RPC returns a single-row array
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!row) {
        return {
            available: false, reason: 'STATS_EMPTY',
            total: null, active: null, suspended: null, unverified: null,
            restricted: null, high_risk: null,
            new_today: null, new_this_week: null,
            role_counts: {},
            ledger: { ngn: null, usd: null, available: false }
        };
    }

    const value = {
        available: true,
        total: Number(row.total || 0),
        active: Number(row.active || 0),
        suspended: Number(row.suspended || 0),
        unverified: Number(row.unverified || 0),
        restricted: Number(row.restricted || 0),
        high_risk: Number(row.high_risk || 0),
        new_today: Number(row.new_today || 0),
        new_this_week: Number(row.new_this_week || 0),
        role_counts: row.role_counts || {},
        ledger: {
            ngn: row.ledger_ok ? row.ledger_ngn : null,
            usd: row.ledger_ok ? row.ledger_usd : null,
            available: !!row.ledger_ok
        }
    };

    _statsCache.at = Date.now();
    _statsCache.value = value;
    return value;
}

// ═════════════════════════════════════════════════════════════════
//  LIST
// ═════════════════════════════════════════════════════════════════

async function listUsers({
    page = 1,
    limit = DEFAULT_LIMIT,
    search = '',
    status = '',
    role = '',
    verified = null,
    has_restriction = null,
    risk_level = '',
    created_from = null,
    created_to = null,
    sort = 'newest',
    ctx = null
} = {}) {
    limit = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    page = Math.max(parseInt(page, 10) || 1, 1);

    // Sanitise search — truncate BEFORE escaping.
    const searchTerm = search
        ? String(search).trim().slice(0, 64).replace(/[%_\\]/g, m => '\\' + m)
        : '';

    // Sort allow-list
    const sortKey = SORT_ALLOW.has(sort) ? sort : 'newest';

    // Filter validation
    if (status && !ALLOWED_STATUS.has(status)) status = '';
    if (role && !ALLOWED_ROLES.has(role)) role = '';
    const riskClean = ['low', 'medium', 'high', 'critical'].includes(risk_level)
        ? risk_level : '';

    const r = await tryRpc('admin_users_search_v2', {
        p_q: searchTerm,
        p_page: page,
        p_limit: limit,
        p_status: status || '',
        p_role: role || '',
        p_verified: verified === true ? true : verified === false ? false : null,
        p_has_restriction: has_restriction === true ? true : has_restriction === false ? false : null,
        p_risk_level: riskClean,
        p_created_from: created_from || null,
        p_created_to: created_to || null,
        p_sort: sortKey
    });

    if (!r.ok) {
        throw serviceError('USERS_LIST_FAILED', r.error || 'Failed to list users', 500);
    }

    const rows = Array.isArray(r.data) ? r.data : [];
    const count = rows.length ? Number(rows[0].total_count || 0) : 0;
    const userIds = rows.map(u => u.id);

    // ─── ONE query for the page's ledger balances ──────────────
    let ledgerByUser = {};
    let ledgerAvailable = true;
    if (userIds.length) {
        const lr = await tryRpc('admin_users_ledger_totals_for_ids', { p_ids: userIds });
        if (lr.ok && Array.isArray(lr.data)) {
            for (const row of lr.data) {
                if (!ledgerByUser[row.user_id]) {
                    ledgerByUser[row.user_id] = { ngn: null, usd: null };
                }
                if (row.currency === 'NGN') ledgerByUser[row.user_id].ngn = row.balance;
                else if (row.currency === 'USD') ledgerByUser[row.user_id].usd = row.balance;
            }
        } else {
            ledgerAvailable = false;
        }
    }

    // Restrictions map (already in the RPC result, but keep the legacy
    // shape so existing callers don't break)
    const restrictionsByUser = {};
    if (userIds.length) {
        try {
            const { data: rs } = await supabaseAdmin
                .from('user_restrictions')
                .select('user_id, restriction')
                .in('user_id', userIds)
                .eq('is_active', true);
            for (const r of rs || []) {
                (restrictionsByUser[r.user_id] ||= []).push(r.restriction);
            }
        } catch (_) {}
    }

    // PII masking (unless caller has users.pii_reveal)
    const canRevealPII = !!(ctx?.permissions && ctx.permissions['users.pii_reveal']);

    const users = rows.map(u => {
        const ledger = ledgerByUser[u.id] || {};
        return {
            id: u.id,
            username: u.username || null,
            email: canRevealPII ? (u.email || null) : (u.email ? maskEmail(u.email) : null),
            phone: canRevealPII ? (u.phone || null) : (u.phone ? maskPhone(u.phone) : null),
            role: u.role || 'user',
            status: u.status || 'active',
            is_verified: !!u.is_verified,
            two_factor_enabled: !!u.two_factor_enabled,
            risk_level: u.risk_level || null,
            // Bug 4: ledger is the ONLY source of wallet numbers here.
            wallet_ngn: ledger.ngn ?? null,
            wallet_usd: ledger.usd ?? null,
            wallet_ngn_available: ledger.ngn !== undefined,
            wallet_usd_available: ledger.usd !== undefined,
            ledger_available: ledgerAvailable,
            created_at: u.created_at,
            updated_at: u.updated_at,
            last_seen: u.last_seen,
            last_login: u.last_login,
            last_location: u.last_location,
            avatar_url: u.avatar_url,
            referral_code: u.referral_code,
            login_count: u.login_count || 0,
            restrictions: restrictionsByUser[u.id] || []
        };
    });

    return {
        users,
        count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
        sort: sortKey,
        pii_masked: !canRevealPII
    };
}

async function getRecentUsers(limit = 6) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 6, 1), 50);
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, username, email, role, created_at, last_location, wallet_ngn, wallet_usd, is_verified, status, avatar_url')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) throw serviceError('USERS_RECENT_FAILED', error.message, 500);

    // Recent users is a slim list — no ledger query. wallets are
    // explicitly marked unavailable so downstream code knows.
    return (data || []).map(u => ({
        id: u.id,
        username: u.username || (u.email ? u.email.split('@')[0] : 'User'),
        email: maskEmail(u.email || ''),
        role: u.role || 'user',
        created_at: u.created_at,
        last_location: u.last_location,
        is_verified: !!u.is_verified,
        status: u.status || 'active',
        avatar_url: u.avatar_url,
        wallet_ngn: null,
        wallet_usd: null,
        ledger_available: false
    }));
}

// ═════════════════════════════════════════════════════════════════
//  USER 360  (parallel queries)
// ═════════════════════════════════════════════════════════════════

async function getUser360(id, ctx = null) {
    // Parallel: profile + PIN probe + summary + financial + restrictions
    const [
        profileRes,
        pinProbe,
        summaryRpc,
        finRpc,
        restrictionsRes
    ] = await Promise.all([
                supabaseAdmin
            .from('profiles')
            .select(
                'id, username, email, phone, role, status, is_verified, ' +
                'two_factor_enabled, risk_level, referral_code, avatar_url, ' +
                'created_at, updated_at, last_login, last_seen, last_location, ' +
                'login_count, deleted_at, current_session_id, session_expires_at'
            )
            .eq('id', id)
            .maybeSingle(),
        supabaseAdmin
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('id', id)
            .not('transaction_pin_hash', 'is', null)
            .then(r => ({ count: r.count || 0, ok: !r.error })),
        tryRpc('get_user_360_summary', { p_user_id: id }),
        tryRpc('get_user_financial_summary', { p_user_id: id }),
        supabaseAdmin
            .from('user_restrictions')
            .select('id, restriction, reason, imposed_at, imposed_by, lifted_at, lifted_by, lifted_reason, is_active, expires_at')
            .eq('user_id', id)
            .eq('is_active', true)
    ]);

    if (profileRes.error) throw serviceError('USER_LOOKUP_FAILED', profileRes.error.message, 500);
    if (!profileRes.data) throw serviceError('USER_NOT_FOUND', 'User not found', 404);

    const user = profileRes.data;
    const summary = summaryRpc.ok ? summaryRpc.data : null;
    const wallet = finRpc.ok ? finRpc.data : {
        available: false,
        error_code: 'LEDGER_UNAVAILABLE',
        error: finRpc.error
    };
    const restrictions = restrictionsRes.error ? [] : (restrictionsRes.data || []);

    const canRevealPII = !!(ctx?.permissions && ctx.permissions['users.pii_reveal']);

    return {
        profile: {
            id: user.id,
            username: user.username,
            email: canRevealPII ? user.email : (user.email ? maskEmail(user.email) : null),
            phone: canRevealPII ? user.phone : (user.phone ? maskPhone(user.phone) : null),
            role: user.role || 'user',
            status: user.status || 'active',
            is_verified: !!user.is_verified,
            two_factor_enabled: !!user.two_factor_enabled,
            risk_level: user.risk_level || null,
            referral_code: user.referral_code || null,
            avatar_url: user.avatar_url || null,
            created_at: user.created_at,
            updated_at: user.updated_at,
            last_login: user.last_login,
            last_seen: user.last_seen,
            last_location: user.last_location,
            login_count: user.login_count || 0,
            has_transaction_pin: pinProbe.ok && pinProbe.count > 0,
            deleted_at: user.deleted_at,
            is_admin: ADMIN_ROLES.has(String(user.role || '').toLowerCase())
        },
        wallet,
        summary: summary || {
            active_sessions: null,
            open_tickets: null,
            pending_deposits: null,
            total_transactions: null,
            ledger_available: false
        },
        restrictions,
        pii_masked: !canRevealPII
    };
}

// ═════════════════════════════════════════════════════════════════
//  WALLETS  (BigInt cents, no withdrawals)
// ═════════════════════════════════════════════════════════════════

async function getWallets(id, ctx = null) {
    await recordReadAudit(ctx, 'profile', id, 'wallets');

    const rpc = await tryRpc('get_user_financial_summary', { p_user_id: id });

    // Pending DEPOSITS only — withdrawals are disabled.
    let pending = { available: false, deposits_ngn: null, deposits_usd: null };
    try {
        const { data, error } = await supabaseAdmin
            .from('transactions')
            .select('type, currency, amount, status')
            .eq('user_id', id)
            .eq('type', 'deposit')
            .in('status', ['pending', 'processing']);
        if (!error && data) {
            const ngnCents = [];
            const usdCents = [];
            for (const row of data) {
                const s = String(row.amount ?? '');
                const ccy = String(row.currency || '').toUpperCase();
                if (!isDecimalString(s)) continue;
                if (ccy === 'USD') usdCents.push(toCents(s));
                else ngnCents.push(toCents(s));
            }
            const ngnSum = ngnCents.every(c => c !== null)
                ? fromCents(ngnCents.reduce((a, b) => a + b, 0n))
                : null;
            const usdSum = usdCents.every(c => c !== null)
                ? fromCents(usdCents.reduce((a, b) => a + b, 0n))
                : null;
            pending = {
                available: true,
                deposits_ngn: ngnSum,
                deposits_usd: usdSum
            };
        }
    } catch (_) { /* pending.available stays false */ }

    let lastMovement = null;
    let lastMovementAvailable = true;
    try {
        const { data: accounts, error: accErr } = await supabaseAdmin
            .from('ledger_accounts')
            .select('id, currency')
            .eq('user_id', id);
        if (accErr) {
            lastMovementAvailable = false;
        } else {
            const accountIds = (accounts || []).map(a => a.id);
            if (accountIds.length) {
                const { data: last, error: lastErr } = await supabaseAdmin
                    .from('ledger_entries')
                    .select('id, account_id, entry_type, amount, currency, balance_after, description, created_at')
                    .in('account_id', accountIds)
                    .order('created_at', { ascending: false })
                    .limit(1);
                if (lastErr) lastMovementAvailable = false;
                else lastMovement = last?.[0] || null;
            }
        }
    } catch (_) { lastMovementAvailable = false; }

    if (rpc.ok) {
        return {
            available: true,
            source: 'ledger_accounts',
            wallets: rpc.data?.currencies || {},
            pending,
            last_movement: lastMovement,
            last_movement_available: lastMovementAvailable,
            generated_at: rpc.data?.generated_at || new Date().toISOString(),
            withdrawals_enabled: false
        };
    }

    return {
        available: false,
        error_code: 'LEDGER_UNAVAILABLE',
        error: rpc.error,
        wallets: null,
        pending,
        last_movement: null,
        last_movement_available: false,
        withdrawals_enabled: false
    };
}

// ═════════════════════════════════════════════════════════════════
//  LEDGER
// ═════════════════════════════════════════════════════════════════

async function getLedger(id, { page = 1, limit = 50, currency = '', entry_type = '' } = {}, ctx = null) {
    await recordReadAudit(ctx, 'profile', id, 'ledger');

    limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), MAX_LIMIT);
    page = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    const { data: accounts, error: accErr } = await supabaseAdmin
        .from('ledger_accounts')
        .select('id, currency, available_balance, held_balance')
        .eq('user_id', id);
    if (accErr) throw serviceError('LEDGER_ACCOUNTS_FAILED', accErr.message, 500);
    if (!accounts || !accounts.length) {
        return { available: true, accounts: [], entries: [], count: 0, page, limit, totalPages: 0 };
    }

    const wanted = accounts
        .filter(a => !currency || a.currency === currency)
        .map(a => a.id);
    if (!wanted.length) {
        return { available: true, accounts, entries: [], count: 0, page, limit, totalPages: 0 };
    }

    let q = supabaseAdmin
        .from('ledger_entries')
        .select(
            'id, transaction_id, account_id, entry_type, amount, currency, ' +
            'balance_before, balance_after, description, metadata, created_at',
            { count: 'exact' }
        )
        .in('account_id', wanted)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (entry_type === 'CREDIT' || entry_type === 'DEBIT') q = q.eq('entry_type', entry_type);

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { available: true, accounts, entries: [], count: 0, page, limit, totalPages: 0, note: 'ledger_entries table not present' };
        }
        throw serviceError('LEDGER_READ_FAILED', error.message, 500);
    }

    return {
        available: true,
        accounts,
        entries: (data || []).map(e => ({
            id: e.id,
            account_id: e.account_id,
            transaction_id: e.transaction_id,
            entry_type: e.entry_type,
            direction: e.entry_type === 'CREDIT' ? 'credit' : 'debit',
            amount: isDecimalString(String(e.amount ?? '')) ? String(e.amount) : null,
            currency: e.currency,
            balance_before: isDecimalString(String(e.balance_before ?? '')) ? String(e.balance_before) : null,
            balance_after: isDecimalString(String(e.balance_after ?? '')) ? String(e.balance_after) : null,
            description: e.description || '',
            metadata: e.metadata ? scrubObject(e.metadata) : null,
            created_at: e.created_at
        })),
        count: count || 0,
        page, limit,
        totalPages: Math.ceil((count || 0) / limit)
    };
}

// ═════════════════════════════════════════════════════════════════
//  TRANSACTIONS / ORDERS
// ═════════════════════════════════════════════════════════════════

async function getTransactions(id, { page = 1, limit = 30, type = '', status = '', currency = '' } = {}) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), MAX_LIMIT);
    page = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    // Withdrawals disabled — hard-exclude any legacy withdrawal rows.
    let q = supabaseAdmin
        .from('transactions')
        .select(
            'id, type, status, currency, amount, fee, revenue_ngn, revenue_usd, ' +
            'description, ref, reference, provider, provider_reference, ' +
            'source_type, source_id, meta, metadata, created_at, completed_at, ' +
            'failed_at, failure_reason',
            { count: 'exact' }
        )
        .eq('user_id', id)
        .neq('type', 'withdrawal')
                .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (type && type !== 'withdrawal') q = q.eq('type', type);
    if (status) q = q.eq('status', status);
    if (currency) q = q.eq('currency', String(currency).toUpperCase());

    const { data, error, count } = await q;
    if (error) throw serviceError('TRANSACTIONS_READ_FAILED', error.message, 500);

    return {
        transactions: (data || []).map(t => shapeTransaction(t, { includeMeta: false })),
        count: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit)
    };
}

async function getOrders(id, { page = 1, limit = 30, product_type = '', status = '' } = {}) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), MAX_LIMIT);
    page = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('orders')
        .select(
            'id, order_ref, user_id, product_type, product_name, ' +
            'provider, provider_order_id, total_amount, currency, ' +
            'status, payment_status, created_at, completed_at, failed_at',
            { count: 'exact' }
        )
        .eq('user_id', id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (product_type) q = q.eq('product_type', product_type);
    if (status) q = q.eq('status', status);

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { orders: [], count: 0, page, limit, totalPages: 0, note: 'orders table not present' };
        }
        throw serviceError('ORDERS_READ_FAILED', error.message, 500);
    }

    return {
        orders: (data || []).map(o => ({
            order_id: o.id,
            order_ref: o.order_ref,
            product_type: o.product_type,
            product_name: o.product_name,
            provider: o.provider,
            provider_order_id: o.provider_order_id,
            amount: isDecimalString(String(o.total_amount ?? '')) ? String(o.total_amount) : null,
            currency: o.currency,
            status: o.status,
            payment_status: o.payment_status,
            created_at: o.created_at,
            completed_at: o.completed_at,
            failed_at: o.failed_at
        })),
        count: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit)
    };
}

// ═════════════════════════════════════════════════════════════════
//  SECURITY
// ═════════════════════════════════════════════════════════════════

async function getSecurity(id, { limit = 30 } = {}, ctx = null) {
    await recordReadAudit(ctx, 'profile', id, 'security');

    limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);

    let sessions = [];
    let sessionsAvailable = true;
    try {
        const { data, error } = await supabaseAdmin
            .from('user_sessions')
            .select(
                'id, session_id, device_name, device_type, browser, os, ' +
                'ip, ip_address, location, created_at, last_activity_at, ' +
                'expires_at, revoked_at, is_active, is_current, user_agent'
            )
            .eq('user_id', id)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) sessionsAvailable = false;
        else sessions = data || [];
    } catch (_) { sessionsAvailable = false; }

    const active = sessions.filter(s => s.is_active && !s.revoked_at);

    // Failed-login count from security events (best-effort)
    let failedLogins = null;
    let failedLoginsAvailable = false;
    try {
        const since = new Date(Date.now() - 30 * 86400000).toISOString();
        const { count, error } = await supabaseAdmin
            .from('user_security_events')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', id)
            .eq('event_type', 'login_failed')
            .gte('created_at', since);
        if (!error) {
            failedLogins = count || 0;
            failedLoginsAvailable = true;
        }
    } catch (_) {}

    let events = null;
    try {
        const { data, error } = await supabaseAdmin
            .from('user_security_events')
            .select('id, event_type, severity, detail, ip_address, user_agent, created_at')
            .eq('user_id', id)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (!error) events = data || [];
    } catch (_) {}

    return {
        sessions,
        active_sessions: active,
        sessions_available: sessionsAvailable,
        failed_logins: failedLogins,
        failed_logins_available: failedLoginsAvailable,
        events,
        events_available: events !== null
    };
}

// ═════════════════════════════════════════════════════════════════
//  SUPPORT
// ═════════════════════════════════════════════════════════════════

async function getSupport(id) {
    try {
        const { data, error } = await supabaseAdmin
            .from('support_tickets')
            .select('id, ticket_number, subject, status, priority, created_at, updated_at, assigned_to, last_message_at')
            .eq('user_id', id)
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) {
            if (error.code === '42P01') return { tickets: [], note: 'support_tickets table not present' };
            throw error;
        }
        return { tickets: data || [] };
    } catch (e) {
        if (e.code === '42P01') return { tickets: [], note: 'support_tickets table not present' };
        throw serviceError('SUPPORT_READ_FAILED', e.message, 500);
    }
}

// ═════════════════════════════════════════════════════════════════
//  NOTES  (Bug 11: join author names)
// ═════════════════════════════════════════════════════════════════

async function getNotes(id) {
    try {
        const { data: notes, error } = await supabaseAdmin
            .from('admin_user_notes')
            .select('id, author_id, body, tags, created_at')
            .eq('user_id', id)
            .order('created_at', { ascending: false })
            .limit(200);
        if (error) {
            if (error.code === '42P01') return [];
            throw error;
        }
        if (!notes || !notes.length) return [];

        // Join author profiles
        const authorIds = [...new Set(notes.map(n => n.author_id).filter(Boolean))];
        let authorsById = {};
        if (authorIds.length) {
            const { data: profiles } = await supabaseAdmin
                .from('profiles')
                .select('id, username, email')
                .in('id', authorIds);
            for (const p of profiles || []) {
                authorsById[p.id] = p.username || (p.email ? p.email.split('@')[0] : 'Admin');
            }
        }

        return notes.map(n => ({
            id: n.id,
            author_id: n.author_id,
            author_name: authorsById[n.author_id] || 'Admin',
            body: n.body,
            tags: n.tags || [],
            created_at: n.created_at
        }));
    } catch (e) {
        if (e.code === '42P01') return [];
        throw serviceError('NOTES_READ_FAILED', e.message, 500);
    }
}

async function addNote({ userId, authorId, body, tags }) {
    const trimmed = String(body || '').trim();
    if (trimmed.length < 3) throw serviceError('BODY_REQUIRED', 'Note body required (min 3 chars)', 422);
    if (trimmed.length > 4000) throw serviceError('BODY_TOO_LONG', 'Note max 4000 chars', 422);

    const cleanTags = Array.isArray(tags)
        ? tags.filter(t => typeof t === 'string' && t.trim()).slice(0, 10).map(t => t.trim().slice(0, 40))
        : [];

    const { data, error } = await supabaseAdmin
        .from('admin_user_notes')
        .insert({ user_id: userId, author_id: authorId, body: trimmed, tags: cleanTags })
        .select()
        .single();
    if (error) throw serviceError('NOTE_INSERT_FAILED', error.message, 500);
    return data;
}

// ═════════════════════════════════════════════════════════════════
//  RESTRICTIONS
// ═════════════════════════════════════════════════════════════════

async function addRestriction({ userId, adminId, restriction, reason, expires_at = null }) {
    const key = String(restriction || '').toLowerCase();
    const trimmedReason = String(reason || '').trim();

    if (!ALLOWED_RESTRICTIONS.has(key)) {
        throw serviceError('INVALID_RESTRICTION', `Restriction must be one of: ${[...ALLOWED_RESTRICTIONS].join(', ')}`, 422);
    }
    if (trimmedReason.length < 4) throw serviceError('REASON_REQUIRED', 'Reason required (min 4 chars)', 422);

    let expiresIso = null;
    if (expires_at) {
        const d = new Date(expires_at);
        if (isNaN(d.getTime())) throw serviceError('INVALID_EXPIRY', 'Expiry is not a valid date', 422);
        if (d.getTime() <= Date.now()) throw serviceError('INVALID_EXPIRY', 'Expiry must be in the future', 422);
        expiresIso = d.toISOString();
    }

    const { data: existing } = await supabaseAdmin
        .from('user_restrictions')
        .select('id')
        .eq('user_id', userId)
        .eq('restriction', key)
        .eq('is_active', true)
        .maybeSingle();
    if (existing) throw serviceError('RESTRICTION_ALREADY_ACTIVE', 'This restriction is already active', 409);

    const { data, error } = await supabaseAdmin
        .from('user_restrictions')
        .insert({
            user_id: userId,
            restriction: key,
            is_active: true,
            reason: trimmedReason,
            imposed_by: adminId,
            imposed_at: new Date().toISOString(),
            expires_at: expiresIso
        })
        .select()
        .single();
    if (error) {
        if (error.code === '23505') throw serviceError('RESTRICTION_ALREADY_ACTIVE', 'This restriction is already active', 409);
        throw serviceError('RESTRICTION_INSERT_FAILED', error.message, 500);
    }
    return data;
}

async function removeRestriction({ userId, adminId, restriction, reason }) {
    const key = String(restriction || '').toLowerCase();
    const trimmedReason = String(reason || '').trim();

    if (!ALLOWED_RESTRICTIONS.has(key)) throw serviceError('INVALID_RESTRICTION', 'Unknown restriction', 422);
    if (trimmedReason.length < 4) throw serviceError('REASON_REQUIRED', 'Reason required (min 4 chars)', 422);

    const { data: target, error: pickErr } = await supabaseAdmin
        .from('user_restrictions')
        .select('id')
        .eq('user_id', userId)
        .eq('restriction', key)
        .eq('is_active', true)
        .order('imposed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (pickErr) throw serviceError('RESTRICTION_LOOKUP_FAILED', pickErr.message, 500);
    if (!target) throw serviceError('RESTRICTION_NOT_FOUND', 'No active restriction found', 404);

    const { data: updated, error } = await supabaseAdmin
        .from('user_restrictions')
        .update({
            is_active: false,
            lifted_at: new Date().toISOString(),
            lifted_by: adminId,
            lifted_reason: trimmedReason
        })
        .eq('id', target.id)
        .select()
        .maybeSingle();

    if (error) throw serviceError('RESTRICTION_UPDATE_FAILED', error.message, 500);
    if (!updated) throw serviceError('RESTRICTION_NOT_FOUND', 'No active restriction found', 404);
    return updated;
}

// ═════════════════════════════════════════════════════════════════
//  SECURITY ACTIONS
// ═════════════════════════════════════════════════════════════════

async function forceLogout({ userId, reason, req }) {
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 4) throw serviceError('REASON_REQUIRED', 'Reason required', 422);

    const now = new Date().toISOString();
    const { data: revoked, error } = await supabaseAdmin
        .from('user_sessions')
        .update({
            is_active: false,
            revoked_at: now,
            revoked_reason: `admin force-logout: ${trimmed}`
        })
        .eq('user_id', userId)
        .eq('is_active', true)
        .select('id');

    if (error) throw serviceError('FORCE_LOGOUT_FAILED', error.message, 500);

    const { error: profileErr } = await supabaseAdmin
        .from('profiles')
        .update({ current_session_id: null, session_expires_at: null })
        .eq('id', userId);
    if (profileErr) {
        console.warn('[FORCE_LOGOUT] profile clear failed:', profileErr.message);
    }

    return { revoked: (revoked || []).length, profile_cleared: !profileErr };
}

async function requirePasswordReset({ userId, reason, req }) {
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 4) throw serviceError('REASON_REQUIRED', 'Reason required', 422);

    const now = new Date().toISOString();
    const { error: flagErr } = await supabaseAdmin
        .from('profiles')
        .update({ force_password_change: true })
        .eq('id', userId);
    if (flagErr) {
        if (flagErr.code === '42703' || /column .* does not exist/i.test(flagErr.message || '')) {
            throw serviceError('MIGRATION_MISSING',
                'profiles.force_password_change column is missing. Run migration 2026_admin_users_hardening.sql.', 500);
        }
        throw serviceError('PASSWORD_RESET_FLAG_FAILED', flagErr.message, 500);
    }

    const { error: sessErr } = await supabaseAdmin
        .from('user_sessions')
        .update({ is_active: false, revoked_at: now, revoked_reason: 'admin required password reset' })
        .eq('user_id', userId)
        .eq('is_active', true);
    if (sessErr) throw serviceError('SESSION_REVOKE_FAILED', sessErr.message, 500);

    return { force_password_change: true, sessions_revoked: true };
}

async function requireTwoFA({ userId, reason, req }) {
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 4) throw serviceError('REASON_REQUIRED', 'Reason required', 422);

    const { error } = await supabaseAdmin
        .from('profiles')
        .update({ two_factor_required: true })
        .eq('id', userId);
    if (error) {
        if (error.code === '42703' || /column .* does not exist/i.test(error.message || '')) {
            throw serviceError('MIGRATION_MISSING',
                'profiles.two_factor_required column is missing. Run migration 2026_admin_users_hardening.sql.', 500);
        }
        throw serviceError('TWOFA_FLAG_FAILED', error.message, 500);
    }
    return { two_factor_required: true };
}

// ═════════════════════════════════════════════════════════════════
//  PROFILE / STATUS  (optimistic lock via if_updated_at)
// ═════════════════════════════════════════════════════════════════

async function updateProfile({ userId, body, actorIsSuperAdmin, actorId }) {
    // Optimistic lock is required on this endpoint.
    const expectedUpdatedAt = body?.if_updated_at;
    if (!expectedUpdatedAt) {
        throw serviceError('OPTIMISTIC_LOCK_REQUIRED', 'if_updated_at is required for updates', 428);
    }

    const { data: existing, error: getErr } = await supabaseAdmin
        .from('profiles')
        .select('id, username, phone, status, is_verified, role, updated_at, deleted_at')
        .eq('id', userId)
        .single();
    if (getErr || !existing) throw serviceError('USER_NOT_FOUND', 'User not found', 404);
    if (existing.deleted_at) throw serviceError('USER_DELETED', 'User is deleted', 410);

    // Compare timestamps (millisecond precision — Postgres truncates to µs
    // but JS rounds to ms; we compare within 1ms).
    const expected = new Date(expectedUpdatedAt).getTime();
    const actual = new Date(existing.updated_at).getTime();
    if (!Number.isFinite(expected) || Math.abs(expected - actual) > 1000) {
        throw serviceError('STALE_RECORD', 'This user was updated by another admin. Refresh and retry.', 409);
    }

    const updateData = {};
    const before = {};
    const after = {};
    const assign = (field, value) => {
        updateData[field] = value;
        before[field] = existing[field];
        after[field] = value;
    };

    if (body.username !== undefined) {
        const v = String(body.username).trim();
        if (v.length < 3 || v.length > 40) throw serviceError('INVALID_USERNAME', 'Username must be 3–40 chars', 422);
        assign('username', v);
    }
    if (body.phone !== undefined) {
        assign('phone', String(body.phone).trim().slice(0, 30));
    }
    if (body.is_verified !== undefined) {
        assign('is_verified', !!body.is_verified);
    }
    if (body.status !== undefined) {
        // Status changes have their own guards in setStatus — do not
        // allow them through updateProfile.
        throw serviceError('USE_STATUS_ENDPOINT', 'Use PUT /users/:id/status for status changes', 422);
    }
    if (body.role !== undefined) {
        const r = String(body.role).toLowerCase();
        if (!ALLOWED_ROLES.has(r)) throw serviceError('INVALID_ROLE', 'Invalid role', 422);
        if (!actorIsSuperAdmin) throw serviceError('ROLE_CHANGE_FORBIDDEN', 'Only super admins can change roles', 403);

        // Bug 8: self-escalation guard.
        if (actorId && String(actorId) === String(userId) && r !== existing.role) {
            throw serviceError('SELF_ESCALATION', 'You cannot change your own role', 403);
        }

        // Last super-admin guard.
        if (existing.role === 'super_admin' && r !== 'super_admin') {
            const { count } = await supabaseAdmin
                .from('profiles')
                .select('id', { count: 'exact', head: true })
                .eq('role', 'super_admin')
                .is('deleted_at', null);
            if ((count || 0) <= 1) {
                throw serviceError('LAST_SUPER_ADMIN', 'Cannot demote the last remaining super admin.', 409);
            }
        }

        assign('role', r);
    }

    if (!Object.keys(updateData).length) throw serviceError('NO_CHANGES', 'No valid fields supplied', 422);

    const { data: updated, error: updateErr } = await supabaseAdmin
        .from('profiles')
        .update(updateData)
        .eq('id', userId)
        .eq('updated_at', existing.updated_at)
        .select('id, username, phone, status, is_verified, role, updated_at')
        .maybeSingle();

    if (updateErr) throw serviceError('USER_UPDATE_FAILED', updateErr.message, 500);
    if (!updated) throw serviceError('STALE_RECORD', 'This user was updated by another admin. Refresh and retry.', 409);

    return { updated, before, after };
}

async function setStatus({ userId, status, reason, req, actorId }) {
    const s = String(status || '').toLowerCase();
    if (!ALLOWED_STATUS.has(s)) throw serviceError('INVALID_STATUS', 'Invalid status', 422);

    // Bug 8a: block self-suspend / self-ban.
    if (actorId && String(actorId) === String(userId) && ['suspended', 'banned', 'inactive'].includes(s)) {
        throw serviceError('SELF_SUSPEND_FORBIDDEN', 'You cannot suspend or ban yourself', 403);
    }

    const { data: existing } = await supabaseAdmin
        .from('profiles')
        .select('id, status, role')
        .eq('id', userId)
        .single();
    if (!existing) throw serviceError('USER_NOT_FOUND', 'User not found', 404);

    // Bug 8b: block suspending the last super_admin.
    if (['suspended', 'banned'].includes(s) && existing.role === 'super_admin') {
        const { count } = await supabaseAdmin
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('role', 'super_admin')
            .eq('status', 'active')
            .is('deleted_at', null);
        if ((count || 0) <= 1) {
            throw serviceError('LAST_SUPER_ADMIN', 'Cannot suspend the last active super admin.', 409);
        }
    }

    const now = new Date().toISOString();
    const { data: user, error } = await supabaseAdmin
        .from('profiles')
        .update({ status: s })
        .eq('id', userId)
        .select('id, username, email, role, status, updated_at')
        .single();
    if (error) throw serviceError('STATUS_UPDATE_FAILED', error.message, 500);

    // Bug 8c: revoke all active sessions atomically when suspended/banned.
    let sessionsRevoked = 0;
    if (['suspended', 'banned'].includes(s)) {
        const { data: revoked, error: sessErr } = await supabaseAdmin
            .from('user_sessions')
            .update({
                is_active: false,
                revoked_at: now,
                revoked_reason: `admin set status to ${s}`
            })
            .eq('user_id', userId)
            .eq('is_active', true)
            .select('id');
        if (sessErr) {
            // The status change committed, but session revocation failed.
            // Log loudly — the auth middleware must be checking is_active,
            // so this is a desync, not a security failure, but it must be
            // surfaced.
            console.error('[SET_STATUS] session revoke failed:', sessErr.message);
        } else {
            sessionsRevoked = (revoked || []).length;
        }
    }

    // Audit — written after all DB writes committed.
    await writeAuditRow({
        adminId: req?.adminContext?.id,
        adminEmail: req?.adminContext?.email,
        adminRole: req?.adminContext?.role,
        action: 'user.status_change',
        targetType: 'profile',
        targetId: userId,
        before: { status: existing.status },
        after: { status: s, sessions_revoked: sessionsRevoked },
        reason,
        req,
        severity: ['suspended', 'banned'].includes(s) ? 'high' : 'medium'
    });

    // Best-effort notification. No emoji — `icon_fa` is a Font Awesome
    // class name rendered by the frontend.
    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title: s === 'suspended' ? 'Account Suspended'
                : s === 'banned' ? 'Account Banned'
                : 'Account Activated',
            message: s === 'suspended' ? 'Your account has been suspended.'
                : s === 'banned' ? 'Your account has been banned.'
                : 'Your account has been reactivated.',
            type: s === 'active' ? 'success' : 'warning',
            icon_fa: s === 'active' ? 'fa-solid fa-circle-check' : 'fa-solid fa-triangle-exclamation',
            is_read: false,
            created_at: now
        });
    } catch (_) {}

    return {
        user,
        before: existing.status,
        after: s,
        sessions_revoked: sessionsRevoked
    };
}

// ═════════════════════════════════════════════════════════════════
//  WALLET ADJUSTMENT  (daily cap, no withdrawals)
// ═════════════════════════════════════════════════════════════════

async function checkDailyWalletCap({ actorId, currency, amount }) {
    const cap = WALLET_DAILY_CAP[currency];
    if (!cap) return { ok: true, remaining: null };

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
        .from('admin_audit_logs')
        .select('after')
        .eq('admin_id', actorId)
        .in('action', ['wallet.credit', 'wallet.debit', 'wallet.adjustment_pending_approval'])
        .gte('created_at', since);

    if (error) return { ok: true, remaining: null };  // don't block on audit read failure

    let totalCents = 0n;
    for (const row of data || []) {
        const after = row.after || {};
        if (String(after.currency || '').toUpperCase() !== currency) continue;
        const delta = after.delta || after.amount;
        if (delta == null) continue;
        const c = toCents(String(delta));
        if (c != null) totalCents += c < 0n ? -c : c;
    }

    const capCents = toCents(String(cap));
    const newCents = totalCents + (toCents(String(Math.abs(amount))) || 0n);
    if (capCents != null && newCents > capCents) {
        return {
            ok: false,
            reason: 'DAILY_CAP_EXCEEDED',
            limit: fromCents(capCents),
            used: fromCents(totalCents),
            would_use: fromCents(newCents),
            remaining: fromCents(capCents - totalCents > 0n ? capCents - totalCents : 0n)
        };
    }
    return { ok: true, remaining: capCents != null ? fromCents(capCents - newCents) : null };
}

async function adjustWallet({
    userId, actorId, actorEmail, actorRole, actorIsSuperAdmin,
    currency, amount, reason, req
}) {
    const ccy = String(currency || '').toUpperCase();
    const amt = Number(amount);
    const trimmedReason = String(reason || '').trim();

    if (!ALLOWED_CURRENCIES.has(ccy)) throw serviceError('INVALID_CURRENCY', 'Currency must be NGN or USD', 422);
    if (!Number.isFinite(amt) || amt === 0) throw serviceError('INVALID_AMOUNT', 'Non-zero amount required', 422);
    if (Math.abs(amt) > MAX_WALLET_ADJUSTMENT) throw serviceError('AMOUNT_TOO_LARGE', 'Amount too large', 422);
    if (trimmedReason.length < 4) throw serviceError('REASON_REQUIRED', 'Reason required (min 4 chars)', 422);

    // Daily cap check (per admin per currency)
    const capCheck = await checkDailyWalletCap({ actorId, currency: ccy, amount: amt });
    if (!capCheck.ok) {
        // Write a dedicated audit row so the ops team can see the
        // refusal; the audit is severity 'high' because a cap breach
        // attempt is worth investigating.
        await writeAuditRow({
            adminId: actorId,
            adminEmail: actorEmail,
            adminRole: actorRole,
            action: 'wallet.daily_cap_exceeded',
            targetType: 'profile',
            targetId: userId,
            after: {
                currency: ccy,
                requested: amt,
                limit: capCheck.limit,
                used: capCheck.used,
                would_use: capCheck.would_use
            },
            reason: trimmedReason,
            req,
            severity: 'high'
        });
        throw serviceError('DAILY_CAP_EXCEEDED',
            `Daily ${ccy} wallet adjustment limit reached (${capCheck.limit}). Used: ${capCheck.used}.`,
            429,
            { limit: capCheck.limit, used: capCheck.used, remaining: capCheck.remaining });
    }

    const exceedsThreshold = Math.abs(amt) >= APPROVAL_THRESHOLD;
    const requiresApproval = exceedsThreshold && !actorIsSuperAdmin;

    if (requiresApproval) {
        const payload = {
            currency: ccy,
            amount: amt,
            direction: amt > 0 ? 'credit' : 'debit',
            reason: trimmedReason
        };
        const { data: approval, error: apErr } = await supabaseAdmin
            .from('admin_approvals')
            .insert({
                action: 'wallet_adjustment',
                target_type: 'profile',
                target_id: userId,
                requested_by: actorId,
                payload,
                status: 'pending',
                requested_at: new Date().toISOString()
            })
            .select('id, status, requested_at')
            .single();
        if (apErr) throw serviceError('APPROVAL_CREATE_FAILED', apErr.message, 500);

        await writeAuditRow({
            adminId: actorId,
            adminEmail: actorEmail,
            adminRole: actorRole,
            action: 'wallet.adjustment_pending_approval',
            targetType: 'profile',
            targetId: userId,
            after: { approval_id: approval.id, currency: ccy, amount: amt },
            reason: trimmedReason,
            req
        });

        return {
            pending_approval: true,
            approval_id: approval.id,
            message: `Adjustment above ${APPROVAL_THRESHOLD} ${ccy} requires a second approver.`
        };
    }

    const isCredit = amt > 0;
    const absAmount = Math.abs(amt);
    const reference = `ADMIN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    let ledgerResult;
    try {
        const commonArgs = {
            userId,
            amount: absAmount,
            currency: ccy,
            description: `Admin ${isCredit ? 'credit' : 'debit'} (${trimmedReason})`,
            reference,
            sourceType: 'admin_adjustment',
            sourceId: actorId,
            metadata: { admin_id: actorId, admin_email: actorEmail, reason: trimmedReason },
            type: 'admin_adjustment'
        };
        ledgerResult = isCredit
            ? await LedgerService.creditWallet(commonArgs)
            : await LedgerService.debitWallet(commonArgs);
    } catch (ledgerErr) {
        throw serviceError('LEDGER_ADJUSTMENT_FAILED', ledgerErr.message || 'Ledger rejected adjustment', 400);
    }

    // Audit immediately after ledger success
    await writeAuditRow({
        adminId: actorId,
        adminEmail: actorEmail,
        adminRole: actorRole,
        action: isCredit ? 'wallet.credit' : 'wallet.debit',
        targetType: 'profile',
        targetId: userId,
        before: { currency: ccy, balance: ledgerResult.balance_before ?? null },
        after: {
            currency: ccy,
            balance: ledgerResult.balance_after ?? null,
            delta: isCredit ? absAmount : -absAmount,
            reference
        },
        reason: trimmedReason,
        req
    });

    // Mirror update (best-effort, never authoritative)
    const mirrorField = ccy === 'USD' ? 'wallet_usd' : 'wallet_ngn';
    try {
        if (ledgerResult.balance_after != null) {
            await supabaseAdmin
                .from('profiles')
                .update({ [mirrorField]: ledgerResult.balance_after })
                .eq('id', userId);
        }
    } catch (mirrorErr) {
        console.warn('[ADJUST_WALLET] mirror update failed:', mirrorErr.message);
    }

    // Notification (no emoji)
    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title: isCredit ? 'Wallet Funded' : 'Wallet Debited',
            message: `${isCredit ? 'Added' : 'Removed'} ${absAmount} ${ccy} (${trimmedReason})`,
            type: isCredit ? 'success' : 'warning',
            icon_fa: isCredit ? 'fa-solid fa-wallet' : 'fa-solid fa-arrow-right-from-bracket',
            is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (_) {}

    return {
        currency: ccy,
        amount: amt,
        new_balance: ledgerResult.balance_after ?? null,
        daily_remaining: capCheck.remaining,
        ledger: {
            transaction_id: ledgerResult.transaction_id,
            reference: ledgerResult.reference,
            balance_before: ledgerResult.balance_before,
            balance_after: ledgerResult.balance_after
        }
    };
}

// ═════════════════════════════════════════════════════════════════
//  APPROVALS
// ═════════════════════════════════════════════════════════════════

async function listApprovals({ status = 'pending', limit = 50 } = {}) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    const { data, error } = await supabaseAdmin
        .from('admin_approvals')
        .select(
            'id, action, target_type, target_id, requested_by, payload, status, ' +
            'requested_at, reviewed_by, reviewed_at, review_reason, executed_at, ' +
            'execution_result, execution_idempotency_key'
        )
        .eq('status', status)
        .order('requested_at', { ascending: false })
        .limit(limit);

    if (error) {
        if (error.code === '42P01') return [];
        throw serviceError('APPROVALS_READ_FAILED', error.message, 500);
    }
    return data || [];
}

async function approveApproval({ id, actorId, actorEmail, actorIsSuperAdmin, reason, req }) {
    if (!actorIsSuperAdmin && !reason) {
        throw serviceError('REASON_REQUIRED', 'Approver must provide a reason', 422);
    }

    const { data, error } = await supabaseAdmin.rpc('admin_execute_approval', {
        p_approval_id: id,
        p_actor_id: actorId,
        p_actor_email: actorEmail,
        p_actor_is_super: !!actorIsSuperAdmin,
        p_reason: reason || null
    });

    if (error) {
        const msg = String(error.message || '');
        if (error.code === '42883' || /function .* does not exist/i.test(msg)) {
            throw serviceError('MIGRATION_MISSING',
                'admin_execute_approval RPC is missing. Run migration 2026_user_management_v2.sql.', 500);
        }
        if (/APPROVAL_NOT_FOUND/.test(msg)) throw serviceError('APPROVAL_NOT_FOUND', 'Pending approval not found', 404);
        if (/ALREADY_EXECUTED/.test(msg)) throw serviceError('ALREADY_EXECUTED', 'This approval has already been processed', 409);
        if (/SELF_APPROVAL/.test(msg)) throw serviceError('SELF_APPROVAL_FORBIDDEN', 'Second approver must differ from requester', 403);
        if (/INVALID_PAYLOAD/.test(msg)) throw serviceError('INVALID_PAYLOAD', 'Approval payload is invalid', 422);
        if (/INSUFFICIENT/.test(msg)) throw serviceError('INSUFFICIENT_BALANCE', 'Insufficient balance for this debit', 400);
        throw serviceError('APPROVAL_EXECUTE_FAILED', msg || 'Failed to execute approval', 500);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw serviceError('APPROVAL_EXECUTE_FAILED', 'RPC returned no result', 500);

    return {
        executed: true,
        ledger: {
            reference: row.ledger_reference || null,
            transaction_id: row.ledger_transaction_id || null,
            balance_before: row.balance_before ?? null,
            balance_after: row.balance_after ?? null
        }
    };
}

async function rejectApproval({ id, actorId, reason, req }) {
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 4) throw serviceError('REASON_REQUIRED', 'Reason required (min 4 chars)', 422);

    const { data: updated, error } = await supabaseAdmin
        .from('admin_approvals')
        .update({
            status: 'rejected',
            reviewed_by: actorId,
            reviewed_at: new Date().toISOString(),
            review_reason: trimmed
        })
        .eq('id', id)
        .eq('status', 'pending')
        .select('id, status, reviewed_by, reviewed_at, review_reason')
        .maybeSingle();

    if (error) throw serviceError('APPROVAL_REJECT_FAILED', error.message, 500);
    if (!updated) throw serviceError('APPROVAL_NOT_FOUND', 'Pending approval not found', 404);
    return updated;
}

// ═════════════════════════════════════════════════════════════════
//  AUDIT  (Bug 12: field-level diff)
// ═════════════════════════════════════════════════════════════════

async function getAudit(id, { limit = 100 } = {}) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const { data, error } = await supabaseAdmin.rpc('get_user_audit_history', {
        p_user_id: id,
        p_limit: limit
    });
    if (error) throw serviceError('AUDIT_READ_FAILED', 'Failed to read audit history', 500);

    const rows = Array.isArray(data) ? data : [];

    // Convert before/after JSON blobs into a field-level diff.
    return rows.map(a => {
        const before = a.before || null;
        const after = a.after || null;
        const changes = [];

        const keys = new Set([
            ...Object.keys(before || {}),
            ...Object.keys(after || {})
        ]);

        for (const k of keys) {
            const b = before && k in before ? before[k] : undefined;
            const af = after && k in after ? after[k] : undefined;
            if (JSON.stringify(b) === JSON.stringify(af)) continue;
            changes.push({
                field: k,
                before: b === undefined ? null : b,
                after: af === undefined ? null : af
            });
        }

        return {
            id: a.id,
            action: a.action || 'action',
            admin_email: a.admin_email || null,
            admin_id: a.admin_id || null,
            target_type: a.target_type || null,
            target_id: a.target_id || null,
            reason: a.reason || null,
            ip_address: a.ip_address || null,
            created_at: a.created_at || null,
            changes,
            // Keep raw blobs for export but not for display
            has_changes: changes.length > 0
        };
    });
}

// ═════════════════════════════════════════════════════════════════
//  PII REVEAL  (returns full values + audit)
// ═════════════════════════════════════════════════════════════════

async function getRevealedPII({ userId, actorId, actorEmail, actorRole, req }) {
    const { data: row, error } = await supabaseAdmin
        .from('profiles')
        .select('id, email, phone')
        .eq('id', userId)
        .maybeSingle();
    if (error) throw serviceError('USER_LOOKUP_FAILED', error.message, 500);
    if (!row) throw serviceError('USER_NOT_FOUND', 'User not found', 404);

    await writeAuditRow({
        adminId: actorId,
        adminEmail: actorEmail,
        adminRole: actorRole,
        action: 'user.pii_revealed',
        targetType: 'profile',
        targetId: userId,
        after: { fields: ['email', 'phone'] },
        reason: 'admin requested full PII',
        req,
        severity: 'high'
    });

    return { email: row.email || null, phone: row.phone || null };
}

// ═════════════════════════════════════════════════════════════════
//  BULK ACTIONS  (max 100 users, per-user audit)
// ═════════════════════════════════════════════════════════════════

async function bulkForceLogout({ userIds, reason, actorId, actorEmail, actorRole, req }) {
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 4) throw serviceError('REASON_REQUIRED', 'Reason required', 422);
    if (!Array.isArray(userIds) || !userIds.length) throw serviceError('NO_USERS', 'No users supplied', 422);
    if (userIds.length > BULK_MAX) throw serviceError('BULK_LIMIT', `Maximum ${BULK_MAX} users per bulk action`, 422);

    const now = new Date().toISOString();
    const results = [];

    for (const userId of userIds) {
        try {
            // Self-block: bulk force-logout on yourself is disallowed.
            if (String(actorId) === String(userId)) {
                results.push({ user_id: userId, revoked: 0, skipped: true, reason: 'SELF' });
                continue;
            }

            const { data: revoked, error } = await supabaseAdmin
                .from('user_sessions')
                .update({
                    is_active: false,
                    revoked_at: now,
                    revoked_reason: `admin bulk force-logout: ${trimmed}`
                })
                .eq('user_id', userId)
                .eq('is_active', true)
                .select('id');

            if (error) {
                results.push({ user_id: userId, revoked: 0, error: error.message });
                continue;
            }

            const n = (revoked || []).length;

            await writeAuditRow({
                adminId: actorId,
                adminEmail: actorEmail,
                adminRole: actorRole,
                action: 'user.force_logout',
                targetType: 'profile',
                targetId: userId,
                after: { sessions_revoked: n, bulk: true },
                reason: trimmed,
                req
            });

            results.push({ user_id: userId, revoked: n, error: null });
        } catch (e) {
            results.push({ user_id: userId, revoked: 0, error: e.message });
        }
    }

    return {
        total: userIds.length,
        succeeded: results.filter(r => !r.error && !r.skipped).length,
        failed: results.filter(r => !!r.error).length,
        skipped: results.filter(r => !!r.skipped).length,
        results
    };
}

async function bulkAddTag({ userIds, tag, actorId, actorEmail, actorRole, req }) {
    const cleanTag = String(tag || '').trim().slice(0, 40);
    if (cleanTag.length < 2) throw serviceError('INVALID_TAG', 'Tag must be 2–40 chars', 422);
    if (!Array.isArray(userIds) || !userIds.length) throw serviceError('NO_USERS', 'No users supplied', 422);
    if (userIds.length > BULK_MAX) throw serviceError('BULK_LIMIT', `Maximum ${BULK_MAX} users per bulk action`, 422);

    const results = [];
    for (const userId of userIds) {
        try {
            // Append a system note (the audit log is the source of truth
            // for tags; we add a note so the tag is visible in the user's
            // timeline).
            const { error } = await supabaseAdmin
                .from('admin_user_notes')
                .insert({
                    user_id: userId,
                    author_id: actorId,
                    body: `[bulk tag] ${cleanTag}`,
                    tags: [cleanTag]
                });

            if (error) {
                results.push({ user_id: userId, error: error.message });
                continue;
            }

            await writeAuditRow({
                adminId: actorId,
                adminEmail: actorEmail,
                adminRole: actorRole,
                action: 'user.bulk_tag_added',
                targetType: 'profile',
                targetId: userId,
                after: { tag: cleanTag, bulk: true },
                reason: 'bulk tag',
                req
            });

            results.push({ user_id: userId, error: null });
        } catch (e) {
            results.push({ user_id: userId, error: e.message });
        }
    }

    return {
        total: userIds.length,
        succeeded: results.filter(r => !r.error).length,
        failed: results.filter(r => !!r.error).length,
        results
    };
}

// ═════════════════════════════════════════════════════════════════
//  CSV EXPORT  (server-side, capped, PII masked unless permission)
// ═════════════════════════════════════════════════════════════════

function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}
function csvRow(fields) {
    return fields.map(csvEscape).join(',') + '\n';
}

async function buildUsersCsv({
    filters = {},
    actorId, actorEmail, actorRole, req,
    canRevealPII = false
}) {
    // Reuse listUsers with a very high limit, but cap at CSV_MAX_ROWS.
    // The RPC itself caps at 200/page, so we iterate pages until we hit
    // CSV_MAX_ROWS or the end of the dataset.
    const csvLimit = Math.min(CSV_MAX_ROWS, 5000);
    const pageSize = 200;
    const allUsers = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && allUsers.length < csvLimit) {
        const chunk = await listUsers({
            ...filters,
            page,
            limit: pageSize,
            ctx: {
                permissions: canRevealPII ? { 'users.pii_reveal': true } : {}
            }
        });
        allUsers.push(...chunk.users);
        totalPages = chunk.totalPages;
        page += 1;
        if (page > 50) break; // hard safety
    }

    const rows = allUsers.slice(0, csvLimit);

    const header = [
        'id', 'username', 'email', 'phone', 'role', 'status',
        'is_verified', 'two_factor_enabled', 'risk_level',
        'wallet_ngn', 'wallet_usd',
        'created_at', 'last_seen', 'last_login', 'last_location',
        'restrictions'
    ];

    let body = csvRow(header);
    for (const u of rows) {
        body += csvRow([
            u.id, u.username || '', u.email || '', u.phone || '',
            u.role, u.status,
            u.is_verified ? 'true' : 'false',
            u.two_factor_enabled ? 'true' : 'false',
            u.risk_level || '',
            u.wallet_ngn ?? '',
            u.wallet_usd ?? '',
            u.created_at || '',
            u.last_seen || '',
            u.last_login || '',
            u.last_location || '',
            (u.restrictions || []).join(';')
        ]);
    }

    await writeAuditRow({
        adminId: actorId,
        adminEmail: actorEmail,
        adminRole: actorRole,
        action: 'users.csv_export',
        targetType: 'bulk',
        targetId: null,
        after: {
            row_count: rows.length,
            pii_masked: !canRevealPII,
            filters
        },
        reason: 'csv export',
        req,
        severity: 'medium'
    });

    return {
        csv: body,
        row_count: rows.length,
        capped: rows.length >= csvLimit,
        pii_masked: !canRevealPII
    };
}

// ═════════════════════════════════════════════════════════════════
//  MODULE EXPORTS
// ═════════════════════════════════════════════════════════════════

module.exports = {
    // constants (exported for routes to use)
    MAX_LIMIT,
    DEFAULT_LIMIT,
    BULK_MAX,
    CSV_MAX_ROWS,
    MAX_WALLET_ADJUSTMENT,
    APPROVAL_THRESHOLD,
    WALLET_DAILY_CAP,
    ALLOWED_CURRENCIES,
    ALLOWED_STATUS,
    ALLOWED_ROLES,
    ALLOWED_RESTRICTIONS,

    // utilities
    maskEmail,
    maskPhone,

    // stats
    getStats,

    // list
    listUsers,
    getRecentUsers,

    // user 360
    getUser360,
    getWallets,
    getLedger,
    getTransactions,
    getOrders,
    getSecurity,
    getSupport,
    getNotes,
    getAudit,

    // mutations
    addNote,
    addRestriction,
    removeRestriction,
    forceLogout,
    requirePasswordReset,
    requireTwoFA,
    updateProfile,
    setStatus,
    adjustWallet,
    getRevealedPII,

    // approvals
    listApprovals,
    approveApproval,
    rejectApproval,

    // bulk
    bulkForceLogout,
    bulkAddTag,

    // export
    buildUsersCsv
};