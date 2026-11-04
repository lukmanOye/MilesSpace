'use strict';

// services/transactionAdminService.js
// ─────────────────────────────────────────────────────────────────
// REVISION 2026-11-03 (Batch 4)
//
// Admin Transactions — SERVICE.
//
// Changes from the previous revision:
//   • changeStatus now calls change_status_atomic (Batch 1 RPC).
//     Atomic compare-and-set + audit in one DB transaction. The
//     compensating-update code is gone.
//   • getSummary calls admin_transaction_summary (5-arg, Batch 1)
//     with WAT-converted bounds. Fallback pages through in 1000-row
//     chunks and returns available:false rather than silently
//     under-counting. Response includes timezone.
//   • Export streams via .range() in 1000-row chunks up to
//     MAX_EXPORT. truncated is true only when rows were actually
//     cut. CSV has a UTF-8 BOM. Formula-injection guard is applied
//     only to text columns. Adds direction + signed amount columns.
//   • Date filters: 2026-11-03 as "to" includes the whole day (WAT).
//     from/to are converted to UTC instants before the DB query.
//   • Search strips , ( ) " and \ before .or() interpolation. Same
//     rule applied to provider_reference and ref in getTransaction.
//   • Query param hardening: only strings accepted; page/limit
//     clamped; sort/order/type/status whitelist-checked.
//   • Status filtering: exact status OR a group (completed/pending/
//     failed).
//   • getTransaction: Promise.all for independent queries; .limit(1)
//     instead of .maybeSingle() on .or() lookups; no `meta` select;
//     amount_minor from ledger_entries (correct unit); returns
//     can_resolve, can_refund, allowed_transitions, refund_capability
//     (only when permitted), and ledger_integrity (balanced bool).
//   • addNote: writes the full note (up to 1000 chars) into
//     admin_audit_logs.admin_note. No truncation. Audit failure
//     throws — a note that can't be audited did not happen.
//   • shapeTransaction: returns direction, absolute_amount and
//     signed_amount separately. UI never guesses.
//   • count: 'exact' only when page=1 is being rendered. Subsequent
//     pages use 'planned' (cheap) because the caller already has
//     the total from the first page. Callers can force exact with
//     ?exact=1.
//   • getTransactions supports provider and user_id filters.
// ─────────────────────────────────────────────────────────────────

const { supabaseAdmin } = require('../db/supabase');
const refundSvc = require('./refundService');
const txTypes = require('./transactionTypes');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const MAX_EXPORT = 50_000;
const EXPORT_CHUNK = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_MAX = 100;

// WAT (Africa/Lagos) is UTC+1 with no DST. A date-only string
// `YYYY-MM-DD` means the entire calendar day in WAT.
const TIMEZONE = 'Africa/Lagos';
const WAT_OFFSET_MS = 60 * 60 * 1000;

// ─── Status groups ──────────────────────────────────────────────
const STATUS_GROUPS = Object.freeze({
    completed: new Set(['completed', 'success']),
    pending:   new Set(['pending', 'processing', 'confirming', 'partially_paid', 'manual_review']),
    failed:    new Set(['failed', 'cancelled', 'expired', 'reversed'])
});

const ALL_STATUSES = new Set([
    'pending', 'processing', 'confirming', 'completed', 'success',
    'failed', 'cancelled', 'expired', 'reversed', 'refunded',
    'manual_review', 'partially_paid', 'overpaid', 'underpaid'
]);

// ─── Column allowlists ──────────────────────────────────────────
const TX_COLUMNS = [
    'id', 'user_id', 'type', 'status', 'currency', 'amount', 'fee',
    'revenue_ngn', 'revenue_usd', 'description',
    'ref', 'reference', 'provider', 'provider_reference',
    'source_type', 'source_id', 'category',
    'created_at', 'updated_at', 'completed_at', 'failed_at',
    'cancelled_at', 'refunded_at', 'reversed_at', 'failure_reason',
    'metadata'
].join(', ');

const TX_LIST_COLUMNS = [
    'id', 'user_id', 'type', 'status', 'currency', 'amount', 'fee',
    'reference', 'provider', 'provider_reference',
    'created_at', 'updated_at', 'completed_at', 'failed_at',
    'failure_reason'
].join(', ');

const SAFE_META_KEYS = new Set([
    'direction', 'balance_before', 'balance_after', 'currency_type',
    'original_transaction_id', 'original_reference', 'original_type',
    'original_amount', 'refund_amount', 'reason', 'cashback_type', 'source'
]);

// Operational transitions (server is authoritative; ALLOWED_TRANSITIONS
// here mirrors what the UI can render). change_status_atomic enforces
// the compare-and-set; this map is only used to decide which buttons
// to show.
const ALLOWED_TRANSITIONS = Object.freeze({
    pending:        ['processing', 'failed', 'expired', 'cancelled', 'manual_review'],
    processing:     ['failed', 'cancelled', 'manual_review'],
    confirming:     ['failed', 'manual_review'],
    completed:      [],
    success:        [],
    failed:         ['manual_review'],
    cancelled:      ['manual_review'],
    expired:        ['manual_review'],
    refunded:       [],
    reversed:       [],
    manual_review:  ['pending', 'processing', 'failed', 'cancelled'],
    partially_paid: ['manual_review', 'failed'],
    overpaid:       ['manual_review'],
    underpaid:      ['manual_review', 'failed']
});

// Types that may NOT be manually moved to completed (money-moving).
const LEDGER_MOVING_TYPES = new Set([
    'deposit', 'refund', 'cashback_earned',
    'wallet_debit', 'cashback_used',
    'airtime_purchase', 'data_purchase',
    'giftcard_purchase', 'gift_card_purchase',
    'esim_purchase', 'boost_purchase',
    'virtual_number_purchase', 'virtual_sms_purchase', 'sms_purchase',
    'marketplace_purchase', 'bills_purchase', 'bill_purchase',
    'withdrawal', 'reversal'
]);

// ─── Errors ─────────────────────────────────────────────────────

function svcErr(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    Object.assign(e, extra);
    return e;
}

// ─── Helpers ────────────────────────────────────────────────────

function toNumber(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function absoluteAmount(v) {
    const n = toNumber(v);
    return n === null ? null : Math.abs(n);
}

function limitOf(v, def = DEFAULT_LIMIT) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : def;
}

function pageOf(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Convert a date filter value to an ISO instant in UTC.
 *
 *   'YYYY-MM-DD' for `from` → start of that calendar day in WAT.
 *   'YYYY-MM-DD' for `to`   → end of that calendar day in WAT.
 *   Full ISO timestamp      → used as-is.
 *
 * Returns null for invalid input. Callers convert to a `null` where
 * the DB should ignore the filter.
 */
function dateToInstant(v, which) {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;

    // Date-only: interpret in WAT.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        // WAT day starts at 00:00 WAT == 23:00 UTC previous day.
        // WAT day ends at 23:59:59.999 WAT == 22:59:59.999 UTC same day.
        const [y, m, d] = s.split('-').map(Number);
        if (!y || !m || !d) return null;
        if (which === 'from') {
            // 00:00 WAT = 23:00 UTC previous day
            const startUtc = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - WAT_OFFSET_MS;
            return new Date(startUtc).toISOString();
        }
        // 23:59:59.999 WAT = 22:59:59.999 UTC same day
        const endUtc = Date.UTC(y, m - 1, d, 23, 59, 59, 999) - WAT_OFFSET_MS;
        return new Date(endUtc).toISOString();
    }

    // Full ISO — trust it as a UTC instant.
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
}

/**
 * Strip characters that would break or inject into a PostgREST .or()
 * filter: comma, parentheses, double-quote, backslash. Also trims to
 * SEARCH_MAX.
 */
function sanitizeSearch(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const cleaned = s
        .replace(/[,()"\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, SEARCH_MAX);
    return cleaned || null;
}

/**
 * Escape characters that Postgres ilike treats specially (% _ \) so
 * a literal search doesn't accidentally wildcard. `.or()` has already
 * been sanitized by sanitizeSearch.
 */
function escapeLike(s) {
    return String(s || '').replace(/[%_\\]/g, (m) => '\\' + m);
}

/**
 * Accept only a plain string from a query param. Arrays (from
 * ?a=1&a=2) and objects are rejected.
 */
function strParam(v, maxLen = 200) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s) return null;
    return s.slice(0, maxLen);
}

function safeMeta(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const k of Object.keys(raw)) {
        if (SAFE_META_KEYS.has(k)) out[k] = raw[k];
    }
    return out;
}

function directionOfType(type) {
    const meta = txTypes.getType(type);
    if (meta && (meta.direction === 'credit' || meta.direction === 'debit')) {
        return meta.direction;
    }
    return 'debit';
}

function iconForType(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('deposit'))                              return 'fa-solid fa-circle-down';
    if (t.includes('crypto'))                               return 'fa-brands fa-bitcoin';
    if (t.includes('gift'))                                 return 'fa-solid fa-gift';
    if (t.includes('airtime'))                              return 'fa-solid fa-signal';
    if (t.includes('data'))                                 return 'fa-solid fa-wifi';
    if (t.includes('boost'))                                return 'fa-solid fa-arrow-trend-up';
    if (t.includes('sms') || t.includes('virtual'))         return 'fa-solid fa-message';
    if (t.includes('esim'))                                 return 'fa-solid fa-sim-card';
    if (t.includes('bill'))                                 return 'fa-solid fa-file-invoice-dollar';
    if (t.includes('marketplace') || t === 'purchase')      return 'fa-solid fa-box';
    if (t === 'refund')                                     return 'fa-solid fa-rotate-left';
    if (t === 'reversal')                                   return 'fa-solid fa-rotate-left';
    if (t === 'adjustment' || t === 'admin_adjustment')     return 'fa-solid fa-sliders';
    if (t === 'fee_revenue')                                return 'fa-solid fa-coins';
    if (t === 'cashback_earned' || t === 'cashback_used')   return 'fa-solid fa-coins';
    if (t === 'wallet_debit' || t === 'wallet_credit')      return 'fa-solid fa-wallet';
    if (t === 'withdrawal')                                 return 'fa-solid fa-money-bill-transfer';
    return 'fa-solid fa-credit-card';
}

function prettyType(type) {
    return txTypes.prettyLabel(type);
}

function shapeTransaction(t, profile, ledgerAvailable) {
    const ccy = String(t.currency || 'NGN').toUpperCase();
    const meta = safeMeta(t.metadata);
    const signed = toNumber(t.amount);
    const absolute = absoluteAmount(t.amount);
    const direction = meta.direction === 'credit' || meta.direction === 'debit'
        ? meta.direction
        : directionOfType(t.type);

    return {
        id: t.id,
        reference: t.ref || t.reference || null,
        type: t.type || null,
        type_label: prettyType(t.type),
        category: t.category || null,
        status: t.status || null,
        currency: ccy,
        // Amounts: the UI should use `direction` to pick the sign,
        // not the raw `amount`.
        absolute_amount: absolute,
        signed_amount: signed,
        amount: absolute,   // kept for backward compat with older UI versions
        fee: toNumber(t.fee),
        revenue_ngn: toNumber(t.revenue_ngn),
        revenue_usd: toNumber(t.revenue_usd),
        description: t.description || '',
        provider: t.provider || null,
        provider_reference: t.provider_reference || null,
        source_type: t.source_type || null,
        source_id: t.source_id || null,
        admin_safe_metadata: meta,
        failure_reason: t.failure_reason || null,
        direction,
        balance_before: toNumber(meta.balance_before),
        balance_after: toNumber(meta.balance_after),
        created_at: t.created_at || null,
        updated_at: t.updated_at || null,
        completed_at: t.completed_at || null,
        failed_at: t.failed_at || null,
        cancelled_at: t.cancelled_at || null,
        refunded_at: t.refunded_at || null,
        reversed_at: t.reversed_at || null,
        icon: iconForType(t.type),
        ledger_available: ledgerAvailable !== false,
        user: profile ? {
            id: profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email: profile.email || null
        } : null
    };
}

async function loadProfilesByIds(userIds) {
    if (!userIds.length) return {};
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, username, email')
        .in('id', userIds);
    if (error) {
        throw svcErr('PROFILES_LOOKUP_FAILED', 'Failed to load customer profiles.', 500);
    }
    const out = {};
    for (const p of data || []) out[p.id] = p;
    return out;
}

// ─── LIST ───────────────────────────────────────────────────────

async function getTransactions(query = {}) {
    const page = pageOf(strParam(query.page));
    const limit = limitOf(strParam(query.limit));
    const offset = (page - 1) * limit;

    // Exact count is expensive on large tables. Only needed on the
    // first page (so the caller has `totalPages`). Subsequent pages
    // can pass exact=0 (default on page>1) to use 'planned'.
    const exactParam = strParam(query.exact);
    const wantExact = exactParam === '1' || page === 1;

    const sortable = new Set(['created_at', 'updated_at', 'completed_at', 'amount']);
    const sortParam = strParam(query.sort);
    const sortCol = sortable.has(sortParam) ? sortParam : 'created_at';
    const orderParam = strParam(query.order);
    const ascending = orderParam === 'asc';

    let q = supabaseAdmin
        .from('transactions')
        .select(TX_LIST_COLUMNS, wantExact ? { count: 'exact' } : { count: 'planned' })
        .order(sortCol, { ascending })
        .range(offset, offset + limit - 1);

    // Type filter (exact key or group).
    const typeFilter = strParam(query.type);
    if (typeFilter && txTypes.isValidType(typeFilter)) {
        q = q.eq('type', typeFilter.toLowerCase());
    }

    // Status filter: single, group, or "all".
    const statusFilter = strParam(query.status);
    if (statusFilter && statusFilter !== 'all') {
        const s = statusFilter.toLowerCase();
        if (STATUS_GROUPS[s]) {
            q = q.in('status', [...STATUS_GROUPS[s]]);
        } else if (ALL_STATUSES.has(s)) {
            q = q.eq('status', s);
        }
    }

    const ccy = strParam(query.currency);
    if (ccy && ccy !== 'all') q = q.eq('currency', ccy.toUpperCase());

    const provider = strParam(query.provider);
    if (provider && provider !== 'all') q = q.eq('provider', provider);

    const userId = strParam(query.user_id);
    if (userId && UUID_RE.test(userId)) q = q.eq('user_id', userId);

    const fromIso = dateToInstant(strParam(query.from), 'from');
    const toIso = dateToInstant(strParam(query.to), 'to');
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso)   q = q.lte('created_at', toIso);

    // Search.
    const search = sanitizeSearch(strParam(query.search));
    if (search) {
        const escaped = escapeLike(search);
        const orParts = [
            `ref.ilike.%${escaped}%`,
            `reference.ilike.%${escaped}%`,
            `provider_reference.ilike.%${escaped}%`,
            `description.ilike.%${escaped}%`
        ];
        if (UUID_RE.test(search)) {
            orParts.push(`id.eq.${search}`);
            orParts.push(`user_id.eq.${search}`);
        } else {
            const { data: matched } = await supabaseAdmin
                .from('profiles')
                .select('id')
                .or(`email.ilike.%${escaped}%,username.ilike.%${escaped}%`)
                .limit(50);
            if (matched && matched.length) {
                orParts.push(`user_id.in.(${matched.map(r => r.id).join(',')})`);
            }
        }
        q = q.or(orParts.join(','));
    }

    const { data, error, count } = await q;
    if (error) {
        throw svcErr('TX_LIST_FAILED', 'Failed to load transactions.', 500);
    }

    const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);

    // Determine whether ledger reads will work by sampling. If the
    // schema check fails, ledger_available is false for all rows,
    // and the drawer knows not to expect integrity data.
    const ledgerAvailable = await _ledgerTableAvailable();

    return {
        transactions: (data || []).map(t =>
            shapeTransaction(t, profilesById[t.user_id], ledgerAvailable)
        ),
        count: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
        hasMore: page * limit < (count || 0),
        timezone: TIMEZONE,
        filters_applied: {
            from: fromIso, to: toIso,
            status: statusFilter || 'all',
            type: typeFilter || null,
            currency: ccy || 'all',
            provider: provider || null,
            user_id: userId || null,
            search: search || null
        }
    };
}

async function getRecentTransactions({ limit = 10 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
    const { data, error } = await supabaseAdmin
        .from('transactions')
        .select(TX_LIST_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(lim);
    if (error) throw svcErr('TX_RECENT_FAILED', 'Failed to load recent transactions.', 500);

    const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);
    const ledgerAvailable = await _ledgerTableAvailable();
    return (data || []).map(t =>
        shapeTransaction(t, profilesById[t.user_id], ledgerAvailable)
    );
}

// ─── SUMMARY ────────────────────────────────────────────────────

async function getSummary(query = {}) {
    const fromIso = dateToInstant(strParam(query.from), 'from');
    const toIso = dateToInstant(strParam(query.to), 'to');
    const ccy = strParam(query.currency);
    const currency = ccy && ccy !== 'all' ? ccy.toUpperCase() : null;
    const typeFilter = strParam(query.type);
    const type = typeFilter && txTypes.isValidType(typeFilter) ? typeFilter.toLowerCase() : null;
    const provider = strParam(query.provider);
    const providerFilter = provider && provider !== 'all' ? provider : null;

    // Try the RPC first.
    try {
        const { data, error } = await supabaseAdmin.rpc('admin_transaction_summary', {
            p_from:     fromIso,
            p_to:       toIso,
            p_currency: currency,
            p_type:     type,
            p_provider: providerFilter
        });
        if (!error && data) {
            const row = Array.isArray(data) ? data[0] : data;
            if (row && typeof row === 'object') {
                const ngn = {
                    volume:        String(row.ngn_volume || '0'),
                    credit_volume: String(row.ngn_credit_volume || '0'),
                    debit_volume:  String(row.ngn_debit_volume || '0'),
                    fees:          String(row.ngn_fees || '0')
                };
                const usd = {
                    volume:        String(row.usd_volume || '0'),
                    credit_volume: String(row.usd_credit_volume || '0'),
                    debit_volume:  String(row.usd_debit_volume || '0'),
                    fees:          String(row.usd_fees || '0')
                };
                const total = Number(row.total || 0);
                const completed = Number(row.completed || 0);
                return {
                    total,
                    completed,
                    pending:       Number(row.pending || 0),
                    failed:        Number(row.failed || 0),
                    manual_review: Number(row.manual_review || 0),
                    volume: { NGN: ngn.volume, USD: usd.volume, available: true },
                    credit_volume: { NGN: ngn.credit_volume, USD: usd.credit_volume, available: true },
                    debit_volume:  { NGN: ngn.debit_volume,  USD: usd.debit_volume,  available: true },
                    fees: { NGN: ngn.fees, USD: usd.fees, available: true },
                    success_rate: total > 0 ? Number(((completed / total) * 100).toFixed(1)) : null,
                    source: 'rpc',
                    from: fromIso, to: toIso,
                    timezone: TIMEZONE
                };
            }
        }

        const rpcMissing = error && (
            error.code === '42883' || error.code === 'PGRST202'
        );
        if (!rpcMissing && error) {
            throw svcErr('TX_SUMMARY_FAILED', 'Summary query failed.', 500);
        }
    } catch (e) {
        if (e && e.status) throw e;
        // Fall through.
    }

    // ── Fallback: paginate through the table ──────────────────────
    // Supabase caps at 1000 rows per request. Without an RPC, we
    // can't get the totals in one query. We could either (a) do a
    // COUNT per status via head:true (accurate, no aggregate) or
    // (b) page through and sum in JS (approximate, capped). We do
    // (a) for the counts (accurate), and return available:false for
    // volume/fees because we cannot trust a JS sum over a capped
    // result set.
    const applyFilters = (q) => {
        if (fromIso)  q = q.gte('created_at', fromIso);
        if (toIso)    q = q.lte('created_at', toIso);
        if (currency) q = q.eq('currency', currency);
        if (type)     q = q.eq('type', type);
        if (providerFilter) q = q.eq('provider', providerFilter);
        return q;
    };

    const countFor = async (statuses) => {
        let q = supabaseAdmin
            .from('transactions')
            .select('id', { count: 'exact', head: true });
        q = applyFilters(q);
        if (statuses) q = q.in('status', [...statuses]);
        const { count, error } = await q;
        if (error) throw svcErr('TX_SUMMARY_COUNT_FAILED', 'Summary count failed.', 500);
        return count || 0;
    };

    try {
        const [total, completed, pending, failed, manual_review] = await Promise.all([
            countFor(null),
            countFor(STATUS_GROUPS.completed),
            countFor(STATUS_GROUPS.pending),
            countFor(STATUS_GROUPS.failed),
            countFor(new Set(['manual_review']))
        ]);

        return {
            total, completed, pending, failed, manual_review,
            volume:        { NGN: null, USD: null, available: false },
            credit_volume: { NGN: null, USD: null, available: false },
            debit_volume:  { NGN: null, USD: null, available: false },
            fees:          { NGN: null, USD: null, available: false },
            success_rate: total > 0 ? Number(((completed / total) * 100).toFixed(1)) : null,
            source: 'fallback',
            from: fromIso, to: toIso,
            timezone: TIMEZONE,
            note: 'Aggregate RPC unavailable; volume/fees are reported as unavailable.'
        };
    } catch (e) {
        throw svcErr('TX_SUMMARY_FAILED', 'Summary query failed.', 500);
    }
}

// ─── DETAIL ─────────────────────────────────────────────────────

async function getTransaction(id, { includeRefundCapability = false, canResolve = false } = {}) {
    if (!UUID_RE.test(String(id || ''))) {
        throw svcErr('TX_NOT_FOUND', 'Invalid transaction id.', 400);
    }

    const [txRes, ledgerRes, auditRes, refundsRes] = await Promise.all([
        supabaseAdmin
            .from('transactions')
            .select(TX_COLUMNS)
            .eq('id', id)
            .maybeSingle(),
        supabaseAdmin
            .from('ledger_entries')
            .select('id, account_id, transaction_id, entry_type, amount_minor, currency, balance_before, balance_after, description, created_at')
            .eq('transaction_id', id)
            .order('created_at', { ascending: true }),
        supabaseAdmin
            .from('admin_audit_logs')
            .select('id, admin_id, admin_email, action, reason, admin_note, before, after, created_at, ip_address, request_id')
            .eq('target_type', 'transaction')
            .eq('target_id', id)
            .order('created_at', { ascending: false })
            .limit(100),
        supabaseAdmin
            .from('refunds')
            .select('id, refund_type, refund_method, amount, currency, status, provider, provider_refund_ref, reason, created_at, completed_at, failed_at, failure_reason, refund_transaction_id, requested_by, approved_by, approved_at')
            .eq('original_transaction_id', id)
            .order('created_at', { ascending: false })
    ]);

    if (txRes.error) throw svcErr('TX_DETAIL_FAILED', 'Failed to load transaction.', 500);
    if (!txRes.data) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    const tx = txRes.data;
    const ledgerEntries = !ledgerRes.error ? (ledgerRes.data || []) : [];
    const ledgerAvailable = !ledgerRes.error;
    const audit = !auditRes.error ? (auditRes.data || []) : [];
    const auditAvailable = !auditRes.error;
    const refunds = !refundsRes.error ? (refundsRes.data || []) : [];
    const refundsAvailable = !refundsRes.error;

    // Customer profile — one query.
    const profilePromise = tx.user_id
        ? supabaseAdmin
            .from('profiles')
            .select('id, username, email, role, status, created_at')
            .eq('id', tx.user_id)
            .maybeSingle()
            .then(({ data, error }) => error ? null : data)
        : Promise.resolve(null);

    // Provider record lookup (deposit / crypto deposit) — in parallel
    // with the profile read.
    const providerPromise = (async () => {
        try {
            const ref = tx.reference || tx.ref;
            const pr = tx.provider_reference;

            if (tx.type === 'deposit' || tx.provider === 'korapay') {
                const conds = [];
                if (UUID_RE.test(String(tx.id))) conds.push(`unified_transaction_id.eq.${tx.id}`);
                if (ref) conds.push(`internal_reference.eq.${ref}`);
                if (pr)  conds.push(`provider_reference.eq.${pr}`);
                if (!conds.length) return null;
                const { data } = await supabaseAdmin
                    .from('deposit_requests')
                    .select('id, internal_reference, provider_reference, payment_currency, payment_amount, wallet_currency, wallet_amount, customer_rate, fee_amount, fee_currency, status, created_at, completed_at')
                    .or(conds.join(','))
                    .limit(1);
                const row = Array.isArray(data) ? data[0] : null;
                return row ? { record: row, type: 'kora_deposit' } : null;
            }

            if (tx.provider === 'nowpayments') {
                const conds = [];
                if (pr) conds.push(`nowpayments_payment_id.eq.${pr}`);
                if (tx.source_id && UUID_RE.test(String(tx.source_id))) conds.push(`id.eq.${tx.source_id}`);
                if (!conds.length) return null;
                const { data } = await supabaseAdmin
                    .from('crypto_deposits')
                    .select('id, nowpayments_payment_id, order_id, price_amount, price_currency, pay_amount, pay_currency, actually_paid, outcome_amount, outcome_currency, payment_status, created_at, updated_at')
                    .or(conds.join(','))
                    .limit(1);
                const row = Array.isArray(data) ? data[0] : null;
                return row ? { record: row, type: 'crypto_deposit' } : null;
            }
            return null;
        } catch (_) {
            return null;
        }
    })();

    // Webhooks — also in parallel.
    const webhooksPromise = (async () => {
        const ref = tx.provider_reference || tx.reference || tx.ref;
        if (!ref) return { webhooks: [], available: true };
        try {
            const [koraRes, npRes] = await Promise.all([
                supabaseAdmin
                    .from('kora_webhook_events')
                    .select('id, event_type, provider_reference, signature_valid, processing_status, processing_error, received_at, processed_at')
                    .eq('provider_reference', ref)
                    .order('received_at', { ascending: false })
                    .limit(20),
                supabaseAdmin
                    .from('provider_webhook_events')
                    .select('id, provider, event_type, payment_id, order_id, signature_valid, processing_status, processing_error, received_at, processed_at')
                    .or(`payment_id.eq.${ref},order_id.eq.${ref}`)
                    .order('received_at', { ascending: false })
                    .limit(20)
            ]);
            const koraMissing = koraRes.error && koraRes.error.code === '42P01';
            const npMissing = npRes.error && npRes.error.code === '42P01';
            const available = (!koraRes.error || koraMissing) && (!npRes.error || npMissing);
            const webhooks = [...(koraRes.data || []), ...(npRes.data || [])]
                .sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
            return { webhooks, available };
        } catch (_) {
            return { webhooks: [], available: false };
        }
    })();

    const [profile, providerLookup, webhookLookup] = await Promise.all([
        profilePromise,
        providerPromise,
        webhooksPromise
    ]);

    // Related orders via RPC (tolerate missing).
    const relatedOrdersPromise = (async () => {
        try {
            const { data, error } = await supabaseAdmin.rpc('transaction_related_orders', {
                p_transaction_id: id
            });
            if (error && error.code !== '42883' && error.code !== 'PGRST202') {
                return { orders: [], available: false };
            }
            return { orders: Array.isArray(data) ? data : [], available: true };
        } catch (_) {
            return { orders: [], available: false };
        }
    })();

    const [relatedOrders, refundCapabilityLookup] = await Promise.all([
        relatedOrdersPromise,
        includeRefundCapability
            ? (async () => {
                try {
                    return { cap: await refundSvc.getRefundCapability(id), error: null };
                } catch (e) {
                    return { cap: null, error: e.code || 'CAPABILITY_UNAVAILABLE' };
                }
            })()
            : Promise.resolve({ cap: null, error: null })
    ]);

    // Ledger integrity: sum ledger entries in minor units, compare to
    // transaction amount × 100. Only meaningful when we have both.
    let ledgerIntegrity = null;
    if (ledgerAvailable && ledgerEntries.length) {
        const totalMinor = ledgerEntries.reduce((sum, e) => {
            const m = Number(e.amount_minor);
            return Number.isFinite(m) ? sum + m : sum;
        }, 0);
        const txMinor = Math.round((toNumber(tx.amount) || 0) * 100);
        ledgerIntegrity = {
            balanced: Math.abs(Math.abs(totalMinor) - Math.abs(txMinor)) < 2,
            ledger_total_minor: totalMinor,
            transaction_minor: txMinor
        };
    }

    const currentStatus = String(tx.status || '').toLowerCase();
    const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];

    return {
        transaction: shapeTransaction(tx, profile, ledgerAvailable),
        user: profile,
        ledger_entries: ledgerEntries,
        ledger_available: ledgerAvailable,
        ledger_integrity: ledgerIntegrity,
        related_orders: relatedOrders.orders,
        related_orders_available: relatedOrders.available,
        provider_record: providerLookup ? providerLookup.record : null,
        provider_record_type: providerLookup ? providerLookup.type : null,
        webhooks: webhookLookup.webhooks,
        webhooks_available: webhookLookup.available,
        audit,
        audit_available: auditAvailable,
        refunds,
        refunds_available: refundsAvailable,
        refund_capability: refundCapabilityLookup.cap,
        refund_capability_error: refundCapabilityLookup.error,
        allowed_transitions: allowed,
        current_status: currentStatus,
        can_resolve: !!canResolve && allowed.length > 0,
        can_refund: !!(refundCapabilityLookup.cap && refundCapabilityLookup.cap.eligible)
    };
}

// ─── STATUS CHANGE — atomic via change_status_atomic ────────────

async function changeStatus({ transactionId, nextStatus, reason, ctx }) {
    if (!UUID_RE.test(String(transactionId || ''))) {
        throw svcErr('TX_NOT_FOUND', 'Invalid transaction id.', 400);
    }
    const next_ = String(nextStatus || '').toLowerCase();
    if (!ALL_STATUSES.has(next_)) {
        throw svcErr('INVALID_STATUS', 'Invalid status.', 422);
    }
    const trimmedReason = String(reason || '').trim();
    if (trimmedReason.length < 4) {
        throw svcErr('REASON_REQUIRED', 'A reason is required (min 4 characters).', 422);
    }
    if (trimmedReason.length > 500) {
        throw svcErr('REASON_TOO_LONG', 'Reason must be 500 characters or fewer.', 422);
    }

    // Load current status so we can pass it to the RPC for the
    // compare-and-set.
    const { data: existing, error } = await supabaseAdmin
        .from('transactions')
        .select('id, status, type')
        .eq('id', transactionId)
        .maybeSingle();
    if (error) throw svcErr('TX_STATUS_GET_FAILED', 'Failed to load transaction.', 500);
    if (!existing) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    const current = String(existing.status || '').toLowerCase();

    if (current === next_) {
        return {
            no_op: true,
            message: `Already in status "${next_}".`,
            status: current,
            allowed_transitions: ALLOWED_TRANSITIONS[current] || []
        };
    }

    const allowed = ALLOWED_TRANSITIONS[current] || [];
    if (!allowed.includes(next_)) {
        throw svcErr('INVALID_STATUS_TRANSITION',
            `Cannot transition from "${current}" to "${next_}".`, 422,
            { allowed_transitions: allowed, current_status: current });
    }

    if (next_ === 'completed' || next_ === 'success') {
        const type = String(existing.type || '').toLowerCase();
        if (LEDGER_MOVING_TYPES.has(type)) {
            throw svcErr('MANUAL_COMPLETION_NOT_ALLOWED',
                `Cannot manually complete a "${type}" transaction. Use the provider reconciliation flow.`,
                422, { transaction_type: type });
        }
    }

    const updates = {};
    if (next_ === 'completed' || next_ === 'success') updates.completed_at = 'now';
    if (next_ === 'failed')    updates.failed_at = 'now';
    if (next_ === 'cancelled') updates.cancelled_at = 'now';
    if (next_ === 'reversed')  updates.reversed_at = 'now';
    if (next_ === 'refunded')  updates.refunded_at = 'now';

    const { data, error: rpcErr } = await supabaseAdmin.rpc('change_status_atomic', {
        p_tx_id:       transactionId,
        p_from_status: current,
        p_to_status:   next_,
        p_updates:     updates,
        p_admin_id:    ctx.adminId || null,
        p_admin_email: ctx.adminEmail || null,
        p_reason:      trimmedReason,
        p_ip:          ctx.ip || null,
        p_user_agent:  ctx.userAgent || null,
        p_request_id:  ctx.requestId || null
    });

    if (rpcErr) {
        throw svcErr('TX_STATUS_UPDATE_FAILED', 'Could not update status.', 500);
    }
    if (!data || data.ok !== true) {
        const errCode = (data && data.error) || 'TX_STATUS_UPDATE_FAILED';
        if (errCode === 'TX_NOT_FOUND') throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);
        if (errCode === 'TX_CHANGED') {
            throw svcErr('TX_CHANGED',
                'Transaction was modified by another admin. Reload and try again.',
                409,
                { current_status: data.current_status });
        }
        throw svcErr('TX_STATUS_UPDATE_FAILED', 'Could not update status.', 500);
    }

    const updatedTx = data.transaction;
    return {
        transaction: shapeTransaction(updatedTx, null, true),
        status: next_,
        allowed_transitions: ALLOWED_TRANSITIONS[next_] || []
    };
}

// ─── REFUND (delegates to refundService) ───────────────────────

async function refundTransaction({ transactionId, amount, reason, ctx, idempotencyKey }) {
    if (!UUID_RE.test(String(transactionId || ''))) {
        throw svcErr('TX_NOT_FOUND', 'Invalid transaction id.', 400);
    }
    if (!idempotencyKey) {
        throw svcErr('IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header is required.', 422);
    }

    const capability = await refundSvc.getRefundCapability(transactionId);
    if (!capability.eligible) {
        throw svcErr('TX_NOT_REFUNDABLE',
            capability.reason_label || 'Refund not available.',
            422,
            { reason: capability.reason, reason_label: capability.reason_label });
    }

    const method = capability.methods[0];
    if (!['wallet', 'provider', 'reversal'].includes(method)) {
        throw svcErr('REFUND_METHOD_UNKNOWN', `Unsupported refund method: ${method}.`, 500);
    }

    const args = { transactionId, amount, reason, ctx, idempotencyKey };
    if (method === 'wallet')   return refundSvc.executeWalletRefund(args);
    if (method === 'provider') return refundSvc.executeProviderRefund(args);
    if (method === 'reversal') return refundSvc.executeDepositReversal(args);
}

async function approveRefund({ refundId, ctx, reason }) {
    return refundSvc.approveRefund({ refundId, ctx, reason });
}

async function rejectRefund({ refundId, ctx, reason }) {
    return refundSvc.rejectRefund({ refundId, ctx, reason });
}

// ─── NOTE ───────────────────────────────────────────────────────

async function addNote({ transactionId, note, ctx }) {
    if (!UUID_RE.test(String(transactionId || ''))) {
        throw svcErr('TX_NOT_FOUND', 'Invalid transaction id.', 400);
    }
    const trimmed = String(note || '').trim();
    if (trimmed.length < 2) {
        throw svcErr('NOTE_REQUIRED', 'Note text is required.', 422);
    }
    if (trimmed.length > 1000) {
        throw svcErr('NOTE_TOO_LONG', 'Note must be 1000 characters or fewer.', 422);
    }

    const { data: tx, error: txErr } = await supabaseAdmin
        .from('transactions').select('id').eq('id', transactionId).maybeSingle();
    if (txErr) throw svcErr('TX_NOTE_LOOKUP_FAILED', 'Failed to load transaction.', 500);
    if (!tx) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    // Write the full note into admin_note (Batch 4). reason stays
    // short. Both stored — reason for status change, admin_note for
    // the free-form comment.
    const { error: auditErr } = await supabaseAdmin.from('admin_audit_logs').insert({
        admin_id:    ctx.adminId || null,
        admin_email: ctx.adminEmail || null,
        action:      'transaction.note',
        target_type: 'transaction',
        target_id:   transactionId,
        before:      null,
        after:       null,
        reason:      null,
        admin_note:  trimmed.slice(0, 1000),
        ip_address:  ctx.ip || null,
        user_agent:  ctx.userAgent || null,
        request_id:  ctx.requestId || null,
        created_at:  new Date().toISOString()
    });
    if (auditErr) {
        throw svcErr('AUDIT_INSERT_FAILED', 'Failed to record note.', 500);
    }
    return { ok: true };
}

// ─── EXPORT ─────────────────────────────────────────────────────
// Streams via .range() in 1000-row chunks up to MAX_EXPORT.
// Formula-injection guard applied to text columns ONLY — numbers
// stay numeric.

const TEXT_COLS = new Set([
    'id', 'reference', 'provider_reference', 'username', 'email',
    'type_label', 'status', 'currency', 'provider', 'description'
]);

function csvCell(v, isText) {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (isText && /^[=+\-@\t\r]/.test(s)) {
        s = `'${s}`;
    }
    return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(values, isTextFlags) {
    return values.map((v, i) => csvCell(v, isTextFlags[i])).join(',') + '\n';
}

async function exportTransactions(query = {}) {
    const fromIso = dateToInstant(strParam(query.from), 'from');
    const toIso = dateToInstant(strParam(query.to), 'to');
    const typeFilter = strParam(query.type);
    const type = typeFilter && txTypes.isValidType(typeFilter) ? typeFilter.toLowerCase() : null;
    const statusFilter = strParam(query.status);
    const statusGroup = statusFilter && STATUS_GROUPS[statusFilter.toLowerCase()]
        ? statusFilter.toLowerCase()
        : null;
    const statusExact = statusFilter && ALL_STATUSES.has(statusFilter.toLowerCase())
        ? statusFilter.toLowerCase()
        : null;
    const ccy = strParam(query.currency);
    const currency = ccy && ccy !== 'all' ? ccy.toUpperCase() : null;
    const provider = strParam(query.provider);
    const providerFilter = provider && provider !== 'all' ? provider : null;
    const userId = strParam(query.user_id);
    const search = sanitizeSearch(strParam(query.search));

    // Build the base query once, then page.
    const buildQuery = (offset, limit) => {
        let q = supabaseAdmin
            .from('transactions')
            .select(TX_COLUMNS)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (fromIso) q = q.gte('created_at', fromIso);
        if (toIso)   q = q.lte('created_at', toIso);
        if (type)    q = q.eq('type', type);
        if (statusGroup) q = q.in('status', [...STATUS_GROUPS[statusGroup]]);
        else if (statusExact) q = q.eq('status', statusExact);
        if (currency) q = q.eq('currency', currency);
        if (providerFilter) q = q.eq('provider', providerFilter);
        if (userId && UUID_RE.test(userId)) q = q.eq('user_id', userId);

        if (search) {
            const escaped = escapeLike(search);
            const orParts = [
                `ref.ilike.%${escaped}%`,
                `reference.ilike.%${escaped}%`,
                `provider_reference.ilike.%${escaped}%`,
                `description.ilike.%${escaped}%`
            ];
            if (UUID_RE.test(search)) {
                orParts.push(`id.eq.${search}`);
                orParts.push(`user_id.eq.${search}`);
            }
            q = q.or(orParts.join(','));
        }
        return q;
    };

    // Paginate.
    const rows = [];
    let offset = 0;
    let truncated = false;
    while (offset < MAX_EXPORT) {
        const limit = Math.min(EXPORT_CHUNK, MAX_EXPORT - offset);
        const { data, error } = await buildQuery(offset, limit);
        if (error) throw svcErr('TX_EXPORT_FAILED', 'Failed to export transactions.', 500);
        if (!data || !data.length) break;
        rows.push(...data);
        if (data.length < limit) break;
        offset += limit;
        if (offset >= MAX_EXPORT && data.length === limit) {
            // We hit the cap with a full final chunk — could be more.
            truncated = true;
        }
    }

    // Fetch profiles in one go.
    const userIds = [...new Set(rows.map(t => t.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);

    // Header. `is_text` flags tell csvCell which columns get the
    // formula-injection prefix.
    const header = [
        'Transaction ID', 'Reference', 'Provider Reference', 'Customer', 'Email',
        'Type', 'Direction', 'Status', 'Currency', 'Amount (absolute)',
        'Amount (signed)', 'Fee', 'Revenue NGN', 'Revenue USD', 'Provider',
        'Description', 'Created (WAT)', 'Completed (WAT)', 'Failed (WAT)'
    ];
    const isTextFlags = [
        true, true, true, true, true,
        true, true, true, true, false,
        false, false, false, false, true,
        true, true, true, true
    ];

    const fmtDate = (iso) => {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            // Format in WAT.
            return new Intl.DateTimeFormat('en-GB', {
                timeZone: TIMEZONE,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: false
            }).format(d);
        } catch (_) { return ''; }
    };

    const bodyLines = rows.map(t => {
        const p = profilesById[t.user_id] || {};
        const sh = shapeTransaction(t, p);
        const dir = sh.direction || 'debit';
        return [
            sh.id || '',
            sh.reference || '',
            sh.provider_reference || '',
            p.username || '',
            p.email || '',
            sh.type_label || '',
            dir,
            sh.status || '',
            sh.currency || '',
            sh.absolute_amount != null ? sh.absolute_amount.toFixed(2) : '',
            sh.signed_amount != null ? sh.signed_amount.toFixed(2) : '',
            sh.fee != null ? sh.fee.toFixed(2) : '',
            sh.revenue_ngn != null ? sh.revenue_ngn.toFixed(2) : '',
            sh.revenue_usd != null ? sh.revenue_usd.toFixed(2) : '',
            sh.provider || '',
            sh.description || '',
            fmtDate(sh.created_at),
            fmtDate(sh.completed_at),
            fmtDate(sh.failed_at)
        ];
    });

    const csv = '\uFEFF'  // UTF-8 BOM
        + csvRow(header, isTextFlags)
        + bodyLines.map(line => csvRow(line, isTextFlags)).join('');

    return {
        csv,
        rowCount: rows.length,
        truncated,
        timezone: TIMEZONE
    };
}

// ─── Types registry (for /transactions/types endpoint) ──────────

function getTypeRegistry() {
    return txTypes.publicList();
}

// ─── Internal probe ─────────────────────────────────────────────

let _ledgerTableProbe = null;   // { available: boolean, at: number }
const LEDGER_PROBE_TTL_MS = 60_000;

async function _ledgerTableAvailable() {
    if (_ledgerTableProbe && Date.now() - _ledgerTableProbe.at < LEDGER_PROBE_TTL_MS) {
        return _ledgerTableProbe.available;
    }
    try {
        const { error } = await supabaseAdmin
            .from('ledger_entries')
            .select('id', { count: 'exact', head: true })
            .limit(1);
        const available = !error;
        _ledgerTableProbe = { available, at: Date.now() };
        return available;
    } catch (_) {
        _ledgerTableProbe = { available: false, at: Date.now() };
        return false;
    }
}

// ─── Exports ────────────────────────────────────────────────────

module.exports = {
    ALL_STATUSES,
    STATUS_GROUPS,
    ALLOWED_TRANSITIONS,

    getTransactions,
    getRecentTransactions,
    getSummary,
    getTransaction,
    refundTransaction,
    approveRefund,
    rejectRefund,
    addNote,
    changeStatus,
    exportTransactions,
    getTypeRegistry,

    _internal: {
        iconForType,
        prettyType,
        sanitizeSearch,
        escapeLike,
        csvCell,
        dateToInstant,
        strParam
    }
};