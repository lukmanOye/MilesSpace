'use strict';

// services/transactionAdminService.js
// ─────────────────────────────────────────────────────────────────
// REVISION 2026-11-14 (Batch 8) — Unified identity & fees.
//
// Changes vs. Batch 7:
//   • shapeTransaction() now returns customer_reference, service_table,
//     service_id, fee_source.
//   • getTransactions() supports the Feedback filter (all|has|1-5)
//     via the admin_tx_ids_with_feedback RPC.
//   • getTransactions() search matches customer_reference, reference,
//     ref, provider_reference, description, and (when the string is
//     a UUID) id / user_id; user email/username via one join.
//   • getTransactions() batch-fetches feedback by BOTH reference
//     (any of reference/ref/customer_reference/provider_reference)
//     AND source_id (any of id/source_id/service_id).
//   • getTransaction() resolves the linked service record via
//     resolveServiceRecord() and returns service_record + service_kind.
//   • getTransaction() derives fee from the service record when the
//     ledger row's fee is 0, and sets fee_source accordingly.
//   • getTransaction() computes refund_policy for the UI: the Refund
//     button follows can_refund, NOT the ledger's own status.
//   • refundTransaction() delegates to refundService with the actual
//     method it exports (createRefundRequest / executeProviderRefund).
//   • approveRefund() / rejectRefund() pass idempotencyKey through.
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

const TIMEZONE = 'Africa/Lagos';
const WAT_OFFSET_MS = 60 * 60 * 1000;

// Only these service-record statuses make a purchase refundable
// from the admin Transactions page. transactions.refund_override
// can override with a reason.
const REFUNDABLE_SERVICE_STATUSES = Object.freeze(['failed', 'cancelled', 'manual_review']);

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
    'customer_reference', 'service_table', 'service_id',
    'revenue_ngn', 'revenue_usd', 'description',
    'ref', 'reference', 'provider', 'provider_reference',
    'source_type', 'source_id', 'category',
    'created_at', 'updated_at', 'completed_at', 'failed_at',
    'cancelled_at', 'refunded_at', 'reversed_at', 'failure_reason',
    'metadata'
].join(', ');

const TX_LIST_COLUMNS = [
    'id', 'user_id', 'type', 'status', 'currency', 'amount', 'fee',
    'customer_reference', 'reference', 'provider', 'provider_reference',
    'created_at', 'updated_at', 'completed_at', 'failed_at',
    'failure_reason'
].join(', ');

const SAFE_META_KEYS = new Set([
    'direction', 'balance_before', 'balance_after', 'currency_type',
    'original_transaction_id', 'original_reference', 'original_type',
    'original_amount', 'refund_amount', 'reason', 'cashback_type', 'source'
]);

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

function dateToInstant(v, which) {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        if (!y || !m || !d) return null;
        if (which === 'from') {
            const startUtc = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - WAT_OFFSET_MS;
            return new Date(startUtc).toISOString();
        }
        const endUtc = Date.UTC(y, m - 1, d, 23, 59, 59, 999) - WAT_OFFSET_MS;
        return new Date(endUtc).toISOString();
    }
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
}

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

function escapeLike(s) {
    return String(s || '').replace(/[%_\\]/g, (m) => '\\' + m);
}

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
        reference: t.reference || t.ref || null,
        customer_reference: t.customer_reference || null,
        type: t.type || null,
        type_label: prettyType(t.type),
        category: t.category || null,
        status: t.status || null,
        currency: ccy,
        absolute_amount: absolute,
        signed_amount: signed,
        amount: absolute,
        fee: toNumber(t.fee),
        fee_source: 'ledger',
        revenue_ngn: toNumber(t.revenue_ngn),
        revenue_usd: toNumber(t.revenue_usd),
        description: t.description || '',
        provider: t.provider || null,
        provider_reference: t.provider_reference || null,
        source_type: t.source_type || null,
        source_id: t.source_id || null,
        service_table: t.service_table || null,
        service_id: t.service_id || null,
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

// ─── Service record resolution + fee helper ────────────────────
// Add more sources here as the link columns are confirmed per table.
const SERVICE_SOURCES = [
    {
        table: 'airtime_transactions',
        link: 'ledger_transaction_id',
        kind: 'airtime',
        cols: 'id, reference, status, currency, total_amount, fee, fee_usd, fx_usd_ngn, operator_name, country_code, provider, provider_transaction_id, provider_status, failure_message, refunded, refund_status, created_at, completed_at'
    }
    // Pattern (add once verified):
    // { table: 'bill_payment_transactions', link: 'ledger_transaction_id', kind: 'bill', cols: '...' },
    // { table: 'giftcard_transactions',   link: 'ledger_transaction_id', kind: 'giftcard', cols: '...' },
    // { table: 'esim_transactions',       link: 'ledger_transaction_id', kind: 'esim', cols: '...' },
    // { table: 'marketplace_orders',      link: 'unified_transaction_id', kind: 'marketplace', cols: '...' },
];

async function resolveServiceRecord(tx) {
    for (const s of SERVICE_SOURCES) {
        try {
            let q = supabaseAdmin.from(s.table).select(s.cols).limit(1);
            if (tx.customer_reference) {
                q = q.eq('reference', tx.customer_reference);
            } else if (tx.id) {
                q = q.eq(s.link, tx.id);
            } else {
                continue;
            }
            const { data, error } = await q;
            if (!error && data && data[0]) {
                return { kind: s.kind, table: s.table, link: s.link, record: data[0] };
            }
        } catch (_) {
            // Table missing or column missing: skip and try the next source.
        }
    }
    return null;
}

function feeInWalletCurrency(row, walletCcy) {
    if (!row) return 0;
    const usd = Number(row.fee_usd ?? row.fee) || 0;
    const ccy = String(walletCcy || 'NGN').toUpperCase();
    if (ccy === 'USD') return Math.round(usd * 100) / 100;
    if (row.fee_ngn != null) return Math.round(Number(row.fee_ngn) * 100) / 100;
    const rate = Number(row.fx_usd_ngn) || 1600;
    return Math.round(usd * rate * 100) / 100;
}

function computeRefundPolicy({ tx, service, ledgerCapability, permissions }) {
    // If refundService already says it's not refundable at the ledger level
    // (e.g. already refunded, active refund in flight, not a debit), fail closed.
    if (ledgerCapability && ledgerCapability.eligible === false) {
        return { eligible: false, reason: ledgerCapability.reason, reason_label: ledgerCapability.reason_label };
    }

    // Service purchase: only failed, cancelled, or manual_review are refundable
    // unless the caller holds the override permission.
    const hasOverride = Array.isArray(permissions)
        && (permissions.includes('*') || permissions.includes('transactions.refund_override'));

    if (service) {
        const serviceStatus = String(service.record.status || '').toLowerCase();
        if (!REFUNDABLE_SERVICE_STATUSES.includes(serviceStatus) && !hasOverride) {
            return {
                eligible: false,
                reason: 'SERVICE_NOT_REFUNDABLE',
                reason_label: `Service status "${serviceStatus}" is not refundable. Use the refund override permission to proceed.`,
                service_status: serviceStatus
            };
        }
        return { eligible: true, methods: ['wallet'], override: hasOverride, service_status: serviceStatus };
    }

    // No linked service: fall back to the ledger capability as-is.
    return ledgerCapability || { eligible: false, reason: 'NO_CAPABILITY', reason_label: 'Refund not available.' };
}

// ─── Ledger probe (cached) ─────────────────────────────────────
let _ledgerTableProbe = null;
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

// ─── LIST ───────────────────────────────────────────────────────
async function getTransactions(query = {}) {
    const page = pageOf(strParam(query.page));
    const limit = limitOf(strParam(query.limit));
    const offset = (page - 1) * limit;

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

    // Feedback filter (all | has | 1-5). Uses the RPC added in the
    // migration so the filtering is done in the DB, not in JS.
    const feedbackFilter = strParam(query.feedback);
    if (feedbackFilter && feedbackFilter !== 'all') {
        let p_rating = null;
        if (feedbackFilter !== 'has') {
            const parsed = parseInt(feedbackFilter, 10);
            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 5) p_rating = parsed;
        }
        const { data: fbRows, error: fbErr } = await supabaseAdmin.rpc('admin_tx_ids_with_feedback', { p_rating });
        if (fbErr) {
            console.error('[TX LIST] feedback RPC failed', fbErr);
            q = q.eq('id', '00000000-0000-0000-0000-000000000000');
        } else {
            const ids = (fbRows || []).map(r => r && (r.source_id || r.id)).filter(Boolean);
            if (!ids.length) {
                q = q.eq('id', '00000000-0000-0000-0000-000000000000');
            } else {
                q = q.in('id', ids);
            }
        }
    }

    const typeFilter = strParam(query.type);
    if (typeFilter && txTypes.isValidType(typeFilter)) {
        q = q.eq('type', typeFilter.toLowerCase());
    }

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

    const search = sanitizeSearch(strParam(query.search));
    if (search) {
        const escaped = escapeLike(search);
        const orParts = [
            `ref.ilike.%${escaped}%`,
            `reference.ilike.%${escaped}%`,
            `customer_reference.ilike.%${escaped}%`,
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
        console.error('[TX LIST ERROR]', error);
        throw svcErr('TX_LIST_FAILED', 'Failed to load transactions.', 500);
    }

    const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);
    const ledgerAvailable = await _ledgerTableAvailable();

    // Feedback batch: match on reference OR source_id. Collect
    // every reference-shaped and id-shaped value on the page.
    const refs = [];
    const ids = [];
    (data || []).forEach(t => {
        if (t.reference) refs.push(t.reference);
        if (t.customer_reference) refs.push(t.customer_reference);
        if (t.provider_reference) refs.push(t.provider_reference);
        if (t.id) ids.push(t.id);
        if (t.source_id) ids.push(String(t.source_id));
        if (t.service_id) ids.push(String(t.service_id));
    });
    const fbRefs = refs.filter(r => r && /^[A-Za-z0-9_\-]{6,80}$/.test(r));
    const fbIds = ids.filter(v => typeof v === 'string' && v.length > 0);

    let feedbackByRef = {};
    let feedbackById = {};
    if (fbRefs.length || fbIds.length) {
        const orParts = [];
        if (fbRefs.length) orParts.push(`reference.in.(${fbRefs.map(fbSafeIn).join(',')})`);
        if (fbIds.length) orParts.push(`source_id.in.(${fbIds.map(fbSafeIn).join(',')})`);
        const { data: fbRows } = await supabaseAdmin
            .from('transaction_feedback')
            .select('reference, source_id, rating, rating_label')
            .or(orParts.join(','));
        (fbRows || []).forEach(fb => {
            const entry = { rating: fb.rating, label: fb.rating_label };
            if (fb.reference) feedbackByRef[fb.reference] = entry;
            if (fb.source_id) feedbackById[fb.source_id] = entry;
        });
    }

    return {
        transactions: (data || []).map(t => {
            const shaped = shapeTransaction(t, profilesById[t.user_id], ledgerAvailable);
            shaped.feedback =
                feedbackByRef[t.customer_reference] ||
                feedbackByRef[t.reference] ||
                feedbackByRef[t.provider_reference] ||
                feedbackById[t.id] ||
                feedbackById[String(t.source_id || '')] ||
                feedbackById[String(t.service_id || '')] ||
                null;
            return shaped;
        }),
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
            search: search || null,
            feedback: feedbackFilter || 'all'
        }
    };
}

// PostgREST .in() values need comma/quote escaping. The values here
// are refs and UUIDs; this guard is defensive only.
function fbSafeIn(s) {
    return String(s).replace(/[,()"\\]/g, '');
}

// ─── RECENT ─────────────────────────────────────────────────────
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

        const rpcMissing = error && (error.code === '42883' || error.code === 'PGRST202');
        if (!rpcMissing && error) {
            throw svcErr('TX_SUMMARY_FAILED', 'Summary query failed.', 500);
        }
    } catch (e) {
        if (e && e.status) throw e;
    }

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
async function getTransaction(id, { includeRefundCapability = false, canResolve = false, permissions = [] } = {}) {
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

    // Resolve linked service + profile in parallel.
    const servicePromise = resolveServiceRecord(tx);
    const profilePromise = tx.user_id
        ? supabaseAdmin
            .from('profiles')
            .select('id, username, email, role, status, created_at')
            .eq('id', tx.user_id)
            .maybeSingle()
            .then(({ data, error }) => error ? null : data)
        : Promise.resolve(null);

    // Related orders: match by source_id (an order integer id) or by
    // metadata.order_id. Try both; the RPC is optional.
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

    // Feedback lookup by any of: reference, ref, customer_reference,
    // provider_reference, id, source_id, service_id.
    const feedbackPromise = (async () => {
        const fbRefs = [tx.customer_reference, tx.reference, tx.ref, tx.provider_reference]
            .filter(r => r && /^[A-Za-z0-9_\-]{6,80}$/.test(String(r)));
        const fbIds = [tx.id, tx.source_id, tx.service_id]
            .filter(Boolean).map(String);
        if (!fbRefs.length && !fbIds.length) return null;
        const orParts = [];
        if (fbRefs.length) orParts.push(`reference.in.(${fbRefs.map(fbSafeIn).join(',')})`);
        if (fbIds.length)  orParts.push(`source_id.in.(${fbIds.map(fbSafeIn).join(',')})`);
        try {
            const { data: fbRow } = await supabaseAdmin
                .from('transaction_feedback')
                .select('rating, rating_label, comment, review_status, created_at')
                .or(orParts.join(','))
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            return fbRow ? {
                rating:        fbRow.rating,
                label:         fbRow.rating_label,
                comment:       fbRow.comment,
                review_status: fbRow.review_status,
                created_at:    fbRow.created_at
            } : null;
        } catch (_) {
            return null;
        }
    })();

    const [service, profile, relatedOrders, feedback] = await Promise.all([
        servicePromise, profilePromise, relatedOrdersPromise, feedbackPromise
    ]);

    // Refund capability + refund policy.
    let ledgerCapability = null;
    let ledgerCapabilityError = null;
    if (includeRefundCapability) {
        try { ledgerCapability = await refundSvc.getRefundCapability(id); }
        catch (e) { ledgerCapabilityError = e.code || 'CAPABILITY_UNAVAILABLE'; }
    }
    const refundPolicy = includeRefundCapability
        ? computeRefundPolicy({ tx, service, ledgerCapability, permissions })
        : null;

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

    const shaped = shapeTransaction(tx, profile, ledgerAvailable);

    // Fee derivation: if the ledger row has no fee but the service
    // record does, derive it in the transaction's own currency.
    if (service && !(Number(shaped.fee) > 0)) {
        const derived = feeInWalletCurrency(service.record, shaped.currency);
        if (derived > 0) {
            shaped.fee = derived;
            shaped.fee_source = 'service_record';
        }
    }

    // Customer reference fallback: prefer transactions.customer_reference,
    // then the service record's reference.
    if (!shaped.customer_reference && service?.record?.reference) {
        shaped.customer_reference = service.record.reference;
    }

    const canRefund = !!(refundPolicy && refundPolicy.eligible);

    return {
        transaction: shaped,
        user: profile,
        service_record: service ? service.record : null,
        service_kind: service ? service.kind : null,
        ledger_entries: ledgerEntries,
        ledger_available: ledgerAvailable,
        ledger_integrity: ledgerIntegrity,
        related_orders: relatedOrders.orders,
        related_orders_available: relatedOrders.available,
        provider_record: null,
        provider_record_type: null,
        webhooks: [],
        webhooks_available: false,
        audit,
        audit_available: auditAvailable,
        refunds,
        refunds_available: refundsAvailable,
        feedback,
        refund_capability: ledgerCapability,
        refund_capability_error: ledgerCapabilityError,
        refund_policy: refundPolicy,
        allowed_transitions: allowed,
        current_status: currentStatus,
        can_resolve: !!canResolve && allowed.length > 0,
        can_refund: canRefund
    };
}

// ─── STATUS CHANGE ──────────────────────────────────────────────
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

    if (rpcErr) throw svcErr('TX_STATUS_UPDATE_FAILED', 'Could not update status.', 500);
    if (!data || data.ok !== true) {
        const errCode = (data && data.error) || 'TX_STATUS_UPDATE_FAILED';
        if (errCode === 'TX_NOT_FOUND') throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);
        if (errCode === 'TX_CHANGED') {
            throw svcErr('TX_CHANGED',
                'Transaction was modified by another admin. Reload and try again.',
                409, { current_status: data.current_status });
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

// ─── REFUND ─────────────────────────────────────────────────────
async function refundTransaction({ transactionId, amount, reason, ctx, idempotencyKey }) {
    if (!UUID_RE.test(String(transactionId || ''))) {
        throw svcErr('TX_NOT_FOUND', 'Invalid transaction id.', 400);
    }
    if (!idempotencyKey) {
        throw svcErr('IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header is required.', 422);
    }

    // Fetch the transaction so we can resolve the linked service
    // record and compute the effective refund policy.
    const { data: tx, error: txErr } = await supabaseAdmin
        .from('transactions')
        .select(TX_COLUMNS)
        .eq('id', transactionId)
        .maybeSingle();
    if (txErr) throw svcErr('TX_NOT_FOUND', 'Failed to load transaction.', 500);
    if (!tx) throw svcErr('TX_NOT_FOUND', 'Transaction not found.', 404);

    const service = await resolveServiceRecord(tx);

    // Ledger-level capability (active refund, over-refund, etc).
    const capability = await refundSvc.getRefundCapability(transactionId);

    // Apply the policy: service purchases are refundable only if the
    // linked service record is failed / cancelled / manual_review.
    const policy = computeRefundPolicy({
        tx, service,
        ledgerCapability: capability,
        permissions: ctx.permissions || []
    });

    if (!policy.eligible) {
        throw svcErr('TX_NOT_REFUNDABLE',
            policy.reason_label || 'Refund not available.',
            422,
            { reason: policy.reason, reason_label: policy.reason_label });
    }

    const method = (policy.methods && policy.methods[0]) || 'wallet';

    // Delegate to the real refundService API.
    const args = { transactionId, amount, reason, ctx, idempotencyKey };
    if (method === 'provider') {
        return refundSvc.executeProviderRefund(args);
    }
    return refundSvc.createRefundRequest({ ...args, refundType: method });
}

async function approveRefund({ refundId, ctx, reason, idempotencyKey }) {
    return refundSvc.approveRefund({ refundId, ctx, reason, idempotencyKey });
}

async function rejectRefund({ refundId, ctx, reason, idempotencyKey }) {
    return refundSvc.rejectRefund({ refundId, ctx, reason, idempotencyKey });
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
                `customer_reference.ilike.%${escaped}%`,
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
            truncated = true;
        }
    }

    const userIds = [...new Set(rows.map(t => t.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);

    const header = [
        'Transaction ID', 'Customer Reference', 'Ledger Reference', 'Provider Reference',
        'Customer', 'Email',
        'Type', 'Direction', 'Status', 'Currency',
        'Amount (absolute)', 'Amount (signed)', 'Fee', 'Fee Source',
        'Revenue NGN', 'Revenue USD', 'Provider',
        'Description', 'Created (WAT)', 'Completed (WAT)', 'Failed (WAT)'
    ];
    const isTextFlags = [
        true, true, true, true,
        true, true,
        true, true, true, true,
        false, false, false, true,
        false, false, true,
        true, true, true, true
    ];

    const fmtDate = (iso) => {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return '';
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
            sh.customer_reference || '',
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
            sh.fee_source || '',
            sh.revenue_ngn != null ? sh.revenue_ngn.toFixed(2) : '',
            sh.revenue_usd != null ? sh.revenue_usd.toFixed(2) : '',
            sh.provider || '',
            sh.description || '',
            fmtDate(sh.created_at),
            fmtDate(sh.completed_at),
            fmtDate(sh.failed_at)
        ];
    });

    const csv = '\uFEFF'
        + csvRow(header, isTextFlags)
        + bodyLines.map(line => csvRow(line, isTextFlags)).join('');

    return {
        csv,
        rowCount: rows.length,
        truncated,
        timezone: TIMEZONE
    };
}

// ─── Type registry ─────────────────────────────────────────────
function getTypeRegistry() {
    return txTypes.publicList();
}

// ─── Exports ───────────────────────────────────────────────────
module.exports = {
    ALL_STATUSES,
    STATUS_GROUPS,
    ALLOWED_TRANSITIONS,
    REFUNDABLE_SERVICE_STATUSES,

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
        strParam,
        resolveServiceRecord,
        feeInWalletCurrency,
        computeRefundPolicy
    }
};