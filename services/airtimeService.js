// services/airtimeService.js
// ─────────────────────────────────────────────────────────────────
// Airtime — service layer.
//
// Reads from admin_airtime_orders_v (UNION of DT One + VTpass).
// Writes dispatch to the correct table by row source.
//
// Batch 7 changes (2026-11-08):
//   • getOverview returns byWallet.{USD,NGN} on BOTH the RPC path
//     and the fallback view path, so the admin UI can render the
//     wallet split bar and the two "Paid from X wallet" KPIs.
//   • listOrders accepts a `wallet=USD|NGN|all` query filter (Part C3).
//   • listOrders response includes the new wallet/payment fields
//     (wallet_type, payment_amount, payment_currency, send_amount_usd,
//     fee_usd, fee_percent, fx_usd_ngn, ledger_transaction_id,
//     refund_reference) — Part C2 (list side).
//   • normalizeRow exposes the same fields so getOrder's drawer
//     Payment section renders correctly — Part C2 (detail side).
//   • getOrder top-level response also carries these fields for
//     convenience.
//
// Batch 5 changes (unchanged):
//   • getOverview calls the RPC `admin_airtime_overview` (renamed
//     from `airtime_overview`, and takes p_scope). Falls back to a
//     view query if the RPC is not yet deployed.
//   • buildTimeline reads failure_reason on VTpass rows too.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');

const dtoneAdapter  = require('./airtimeProviders/dtoneAdapter');
const vtpassAdapter = require('./airtimeProviders/vtpassAdapter');

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORDER_STATUSES = new Set([
    'pending', 'processing', 'completed', 'failed', 'refunded',
    'manual_review', 'cancelled', 'reversed', 'provider_unknown',
    'pending_payment', 'paid', 'provider_pending',
    'reconciliation_required', 'refund_pending'
]);

const PENDING_STATUSES = new Set([
    'pending', 'processing', 'provider_unknown', 'pending_payment',
    'paid', 'provider_pending', 'refund_pending', 'reconciliation_required'
]);
const FAILED_STATUSES = new Set(['failed', 'cancelled', 'reversed']);

const ALLOWED_TRANSITIONS = Object.freeze({
    pending:                 ['processing', 'cancelled', 'failed', 'reconciliation_required'],
    processing:              ['provider_pending', 'reconciliation_required', 'completed', 'failed'],
    provider_pending:        ['processing', 'reconciliation_required', 'completed', 'failed'],
    provider_unknown:        ['processing', 'reconciliation_required', 'completed', 'failed'],
    reconciliation_required: ['processing', 'provider_pending', 'completed', 'failed', 'refunded'],
    manual_review:           ['processing', 'failed', 'refunded', 'cancelled'],
    completed:               [],
    failed:                  ['refund_pending', 'cancelled'],
    refund_pending:          ['refunded', 'failed'],
    refunded:                [],
    cancelled:               ['failed'],
    reversed:                ['refunded']
});

const PROVIDERS = { dtone: dtoneAdapter, vtpass: vtpassAdapter };

// ─── Helpers ─────────────────────────────────────────────────────

function limitOf(v, def = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return def;
    return Math.min(n, max);
}
function pageOf(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return n;
}
function isoDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
function statusBadge(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'completed') return 'success';
    if (FAILED_STATUSES.has(s)) return 'danger';
    if (PENDING_STATUSES.has(s)) return 'warn';
    if (s === 'refunded') return 'info';
    return 'neutral';
}
function maskPhone(phone) {
    if (!phone) return '—';
    const s = String(phone);
    if (s.length <= 4) return s;
    return `${'•'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}
function buildAttemptReference(provider, orderRef, attemptNo) {
    const prefix = provider === 'vtpass' ? 'VTP' : 'DT';
    return `${prefix}-${orderRef}-A${attemptNo}`.slice(0, 40);
}

// ─── Audit (fail-loud) ───────────────────────────────────────────

async function recordAudit({ ctx, action, targetId, before, after, reason }) {
    const { error } = await supabaseAdmin
        .from('admin_audit_logs')
        .insert({
            admin_id:    ctx?.adminId || null,
            admin_email: ctx?.adminEmail || null,
            action,
            target_type: 'airtime_order',
            target_id:   targetId,
            before:      before || null,
            after:       after || null,
            reason:      reason ? String(reason).slice(0, 500) : null,
            ip_address:  ctx?.ip || null,
            user_agent:  ctx?.userAgent || null,
            request_id:  ctx?.requestId || null,
            created_at:  new Date().toISOString()
        });
    if (error) {
        console.error('[AIRTIME] audit insert failed:', error.message);
        const e = new Error('Audit logging failed.');
        e.status = 500; e.code = 'AUDIT_WRITE_FAILED';
        throw e;
    }
}

// ─── Provider events (best-effort) ───────────────────────────────

async function recordProviderEvent({
    orderId, attemptId = null, provider, eventId = null,
    eventType, providerStatus = null, providerTransactionId = null,
    providerReference = null, payload = null, processingStatus = 'processed'
}) {
    try {
        await supabaseAdmin.from('airtime_provider_events').insert({
            order_id: orderId,
            attempt_id: attemptId,
            provider,
            event_id: eventId,
            event_type: eventType,
            provider_status: providerStatus,
            provider_transaction_id: providerTransactionId,
            provider_reference: providerReference,
            payload_summary: payload ? summarizeProviderPayload(payload) : null,
            processing_status: processingStatus,
            received_at: new Date().toISOString(),
            processed_at: new Date().toISOString()
        });
    } catch (e) {
        if (!String(e.message || '').includes('duplicate')) {
            console.warn('[AIRTIME] provider event insert failed:', e.message);
        }
    }
}

function summarizeProviderPayload(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const k of ['id', 'transactionId', 'transaction_id', 'external_id', 'status', 'code']) {
        if (raw[k] !== undefined) out[k] = raw[k];
    }
    if (raw.content?.transactions) {
        const tx = raw.content.transactions;
        out.vtpass = {
            transactionId: tx.transactionId || tx.transaction_id || null,
            status: tx.status || null,
            unique_element: tx.unique_element || null
        };
    }
    if (raw.status && typeof raw.status === 'object') {
        out.dtone = {
            status_id: raw.status.id || null,
            class_id: raw.status.class?.id || null,
            message: raw.status.message || raw.status.class?.message || null
        };
    }
    return out;
}

// ═════════════════════════════════════════════════════════════════
//  ROUTING
// ═════════════════════════════════════════════════════════════════

async function resolveProvider({ countryIso3, networkCode = null }) {
    const country = String(countryIso3 || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(country)) {
        const e = new Error('countryIso3 must be a 3-letter ISO code.');
        e.status = 422; e.code = 'INVALID_COUNTRY'; throw e;
    }

    let query = supabaseAdmin
        .from('airtime_provider_routes')
        .select('provider, priority, network_code, country_iso3, enabled')
        .eq('country_iso3', country)
        .eq('enabled', true);

    if (networkCode) {
        query = query.or(`network_code.eq.${String(networkCode).toUpperCase()},network_code.is.null`);
    } else {
        query = query.is('network_code', null);
    }
    query = query.order('network_code', { ascending: false, nullsFirst: false })
                 .order('priority', { ascending: true })
                 .limit(1);

    const { data, error } = await query.maybeSingle();

    if (error && error.code !== 'PGRST116') {
        const e = new Error('Failed to resolve airtime provider route.');
        e.status = 500; e.code = 'ROUTING_READ_FAILED'; e.cause = error.message;
        throw e;
    }

    if (data?.provider) return String(data.provider).toLowerCase();

    if (country === 'NGA') return 'vtpass';
    return 'dtone';
}

async function listRouting() {
    const { data, error } = await supabaseAdmin
        .from('airtime_provider_routes')
        .select('id, country_iso3, network_code, provider, priority, enabled, reason, updated_by, updated_at, version')
        .order('country_iso3', { ascending: true })
        .order('network_code', { ascending: true, nullsFirst: true })
        .order('priority', { ascending: true });

    if (error) {
        if (error.code === '42P01') {
            return [
                { country: 'NGA', network: null, provider: 'vtpass', priority: 1, enabled: true, source: 'default' },
                { country: 'GHA', network: null, provider: 'dtone',  priority: 1, enabled: true, source: 'default' },
                { country: 'KEN', network: null, provider: 'dtone',  priority: 1, enabled: true, source: 'default' },
                { country: 'ZAF', network: null, provider: 'dtone',  priority: 1, enabled: true, source: 'default' }
            ];
        }
        const e = new Error('Failed to list routing.'); e.status = 500; e.code = 'ROUTING_READ_FAILED'; throw e;
    }
    return (data || []).map(r => ({
        id: r.id,
        country: r.country_iso3,
        network: r.network_code || null,
        provider: r.provider,
        priority: r.priority,
        enabled: r.enabled,
        reason: r.reason,
        updated_by: r.updated_by,
        updated_at: r.updated_at,
        version: r.version
    }));
}

async function setRouting({ countryIso3, networkCode = null, primaryProvider, enabled = true, priority = 1, expectedVersion = null, ctx, reason }) {
    const country = String(countryIso3 || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(country)) {
        const e = new Error('countryIso3 must be a 3-letter ISO code.');
        e.status = 422; e.code = 'INVALID_COUNTRY'; throw e;
    }
    const provider = String(primaryProvider || '').toLowerCase();
    if (!PROVIDERS[provider]) {
        const e = new Error(`Unknown provider: ${primaryProvider}`);
        e.status = 422; e.code = 'INVALID_PROVIDER'; throw e;
    }
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }

    // Sanity: VTpass only serves Nigeria.
    if (provider === 'vtpass' && country !== 'NGA') {
        const e = new Error('VTpass only serves Nigeria. Use DT One for other countries.');
        e.status = 422; e.code = 'INVALID_PROVIDER'; throw e;
    }

    const network = networkCode ? String(networkCode).toUpperCase() : null;
    const nowIso = new Date().toISOString();

    let lookup = supabaseAdmin
        .from('airtime_provider_routes')
        .select('id, version')
        .eq('country_iso3', country);
    lookup = network ? lookup.eq('network_code', network) : lookup.is('network_code', null);

    const { data: existing } = await lookup.maybeSingle();

    if (existing) {
        if (expectedVersion != null && Number(existing.version) !== Number(expectedVersion)) {
            const e = new Error('Routing config changed while you were editing it. Reload and try again.');
            e.status = 409; e.code = 'CONFIGURATION_CHANGED';
            e.current_version = existing.version; throw e;
        }
        const { data: updated, error } = await supabaseAdmin
            .from('airtime_provider_routes')
            .update({
                provider, priority, enabled,
                reason: String(reason).slice(0, 500),
                updated_by: ctx?.adminId || null,
                updated_at: nowIso,
                version: (existing.version || 1) + 1
            })
            .eq('id', existing.id)
            .eq('version', existing.version)
            .select('*')
            .maybeSingle();

        if (error) { const e = new Error('Failed to update routing.'); e.status = 500; e.code = 'ROUTING_WRITE_FAILED'; throw e; }
        if (!updated) {
            const e = new Error('Routing config changed while you were editing it. Reload and try again.');
            e.status = 409; e.code = 'CONFIGURATION_CHANGED'; throw e;
        }

        await recordAudit({
            ctx, action: 'airtime.routing_updated',
            targetId: updated.id,
            before: { version: existing.version },
            after: { provider, priority, enabled, version: updated.version },
            reason
        });
        return { country, network, provider, priority, enabled, version: updated.version };
    }

    const { data: inserted, error } = await supabaseAdmin
        .from('airtime_provider_routes')
        .insert({
            country_iso3: country, network_code: network,
            provider, priority, enabled,
            reason: String(reason).slice(0, 500),
            updated_by: ctx?.adminId || null,
            updated_at: nowIso, version: 1
        })
        .select('*')
        .single();

    if (error) {
        if (error.code === '23505') {
            const e = new Error('A route for this country/network already exists.');
            e.status = 409; e.code = 'ROUTE_EXISTS'; throw e;
        }
        const e = new Error('Failed to insert routing.'); e.status = 500; e.code = 'ROUTING_WRITE_FAILED'; throw e;
    }

    await recordAudit({
        ctx, action: 'airtime.routing_created',
        targetId: inserted.id, before: null,
        after: { provider, priority, enabled }, reason
    });
    return { country, network, provider, priority, enabled, version: 1 };
}

// ═════════════════════════════════════════════════════════════════
//  PROVIDER STATE
// ═════════════════════════════════════════════════════════════════

async function resolveProviderState(order) {
    const provider = PROVIDERS[order.provider];
    if (!provider) return { classification: 'UNKNOWN', reason: 'UNKNOWN_PROVIDER' };

    try {
        const result = await provider.getStatus({
            providerTransactionId: order.provider_transaction_id,
            providerReference:     order.provider_reference
        });

        const classification = result.classification || 'UNKNOWN';

        await recordProviderEvent({
            orderId: order.id,
            provider: order.provider,
            eventType: 'status_query',
            providerStatus: result.providerStatus || null,
            providerTransactionId: result.providerTransactionId || null,
            providerReference: order.provider_reference,
            payload: result.rawResponse || null
        });

        return {
            classification,
            providerStatus: result.providerStatus || null,
            providerTransactionId: result.providerTransactionId || null,
            rawResponse: result.rawResponse || null
        };
    } catch (e) {
        await recordProviderEvent({
            orderId: order.id,
            provider: order.provider,
            eventType: 'status_query_failed',
            providerReference: order.provider_reference,
            processingStatus: 'failed'
        });
        return { classification: 'UNKNOWN', reason: `PROVIDER_QUERY_FAILED: ${e.message}` };
    }
}

// ═════════════════════════════════════════════════════════════════
//  ROW NORMALIZATION
// ═════════════════════════════════════════════════════════════════

function normalizeRow(raw, source, profile) {
    if (source === 'dtone') {
        return {
            id: raw.id,
            source: 'dtone',
            scope: 'global',
            order_ref: raw.reference,
            provider: 'dtone',
            provider_transaction_id: raw.provider_transaction_id || null,
            provider_reference: raw.dtone_external_id || raw.provider_reference || null,
            status: raw.status,
            status_badge: statusBadge(raw.status),
            user_id: raw.user_id,
            user: profile ? {
                id: profile.id,
                username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
                email: profile.email || null
            } : { id: raw.user_id, username: 'Unknown', email: null },
            country_iso3: raw.country_code || null,
            country_name: null,
            network_code: raw.operator_id ? String(raw.operator_id) : null,
            network_name: raw.operator_name || null,
            phone_masked: maskPhone(raw.phone_number),
            amount: raw.destination_amount ?? null,
            currency: raw.destination_currency || null,
            customer_price_ngn: raw.customer_total_ngn ?? (raw.currency === 'NGN' ? raw.total_amount ?? null : null),
            provider_cost_ngn: raw.provider_cost_ngn ?? null,
            provider_cost_usd: raw.provider_cost_usd ?? null,
            margin_ngn: raw.margin_ngn ?? null,
            fx_rate: raw.fx_usd_ngn ?? raw.exchange_rate ?? null,
            send_amount_usd: raw.send_amount_usd ?? null,
            fee_amount: raw.fee_usd ?? null,
            // NEW (Part C2, detail side): expose the wallet/payment fields
            // so the admin drawer's Payment section renders correctly.
            fee_usd: raw.fee_usd ?? null,
            fee_percent: raw.fee_percent ?? null,
            fx_usd_ngn: raw.fx_usd_ngn ?? null,
            wallet_type: raw.wallet_type ?? ((raw.currency || '').toUpperCase() || null),
            payment_amount: raw.payment_amount ?? raw.total_amount ?? null,
            payment_currency: raw.payment_currency ?? raw.currency ?? null,
            refund_reference: raw.refund_reference ?? null,
            idempotency_key: raw.idempotency_key ?? null,
            failure_code: raw.failure_code || null,
            failure_reason: raw.failure_message || null,
            transaction_id: raw.ledger_transaction_id || null,
            refund_transaction_id: raw.refund_transaction_id || null,
            refunded: Boolean(raw.refunded),
            created_at: raw.created_at,
            updated_at: raw.updated_at || null,
            completed_at: raw.completed_at || null,
            failed_at: raw.failed_at || null,
            refunded_at: raw.refunded_at || null,
            raw
        };
    }

    return {
        id: raw.id,
        source: 'vtpass',
        scope: 'local',
        order_ref: raw.reference,
        provider: 'vtpass',
        provider_transaction_id: raw.provider_transaction_id || null,
        provider_reference: raw.provider_request_id || null,
        status: raw.status,
        status_badge: statusBadge(raw.status),
        user_id: raw.user_id,
        user: profile ? {
            id: profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email: profile.email || null
        } : { id: raw.user_id, username: 'Unknown', email: null },
        country_iso3: 'NGA',
        country_name: 'Nigeria',
        network_code: raw.network || null,
        network_name: raw.network ? String(raw.network).toUpperCase() : null,
        phone_masked: maskPhone(raw.recipient),
        amount: raw.base_amount ?? null,
        currency: raw.currency || 'NGN',
        customer_price_ngn: raw.customer_amount ?? null,
        provider_cost_ngn: raw.provider_amount ?? null,
        provider_cost_usd: null,
        margin_ngn: raw.margin_ngn ?? null,
        fx_rate: null,
        send_amount_usd: null,
        fee_amount: raw.service_fee ?? null,
        // NEW (Part C2, detail side): VTpass is always NGN.
        fee_usd: null,
        fee_percent: null,
        fx_usd_ngn: null,
        wallet_type: 'NGN',
        payment_amount: raw.customer_amount ?? null,
        payment_currency: 'NGN',
        refund_reference: null,
        idempotency_key: raw.idempotency_key ?? null,
        failure_code: raw.provider_code || null,
        failure_reason: raw.failure_reason || null,
        transaction_id: raw.ledger_transaction_id || null,
        refund_transaction_id: raw.refund_transaction_id || null,
        refunded: Boolean(raw.refunded),
        created_at: raw.created_at,
        updated_at: raw.updated_at || null,
        completed_at: raw.completed_at || null,
        failed_at: raw.failed_at || null,
        refunded_at: raw.refunded_at || null,
        raw
    };
}

// ═════════════════════════════════════════════════════════════════
//  ORDERS — list (reads admin_airtime_orders_v)
// ═════════════════════════════════════════════════════════════════

async function listOrders(query = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    const fromIso = isoDate(query.from);
    const toIso = isoDate(query.to);
    const scope = query.scope && ['all', 'local', 'global'].includes(String(query.scope).toLowerCase())
        ? String(query.scope).toLowerCase() : 'all';

    let q = supabaseAdmin
        .from('admin_airtime_orders_v')
        .select('*', { count: 'exact' });

    if (scope === 'local') q = q.eq('scope', 'local');
    if (scope === 'global') q = q.eq('scope', 'global');
    if (query.status && query.status !== 'all') q = q.eq('status', String(query.status).toLowerCase());
    if (query.provider && query.provider !== 'all') q = q.eq('provider', String(query.provider).toLowerCase());
    // Part C3: wallet filter — 'USD' | 'NGN' | 'all' (default)
    if (query.wallet && query.wallet !== 'all') {
        const w = String(query.wallet).toUpperCase();
        if (w === 'USD' || w === 'NGN') q = q.eq('wallet_type', w);
    }
    if (query.country) q = q.eq('country_iso3', String(query.country).toUpperCase());
    if (query.network) q = q.eq('network_code', query.network);
    if (query.user_id && UUID_RE.test(query.user_id)) q = q.eq('user_id', query.user_id);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso)   q = q.lte('created_at', toIso);
    if (query.amountMin != null) q = q.gte('customer_total_ngn', query.amountMin);
    if (query.amountMax != null) q = q.lte('customer_total_ngn', query.amountMax);

    if (query.search) {
        const safe = String(query.search).trim().replace(/[%_,]/g, m => '\\' + m);
        q = q.or(
            `order_ref.ilike.%${safe}%,` +
            `phone.ilike.%${safe}%,` +
            `provider_reference.ilike.%${safe}%,` +
            `provider_transaction_id.ilike.%${safe}%,` +
            `username.ilike.%${safe}%,` +
            `email.ilike.%${safe}%`
        );
    }

    q = q.order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { orders: [], count: 0, page, limit, totalPages: 0, hasMore: false, available: false, reason: 'VIEW_MISSING' };
        }
        const e = new Error('Failed to load airtime orders');
        e.status = 500; e.code = 'AIRTIME_LIST_ERROR';
        e.cause = error.message;
        throw e;
    }

    const total = count || 0;
    const orders = (data || []).map(r => ({
        id:               r.id,
        source:           r.source,
        scope:            r.scope,
        provider:         r.provider,
        order_ref:        r.order_ref,
        user_id:          r.user_id,
        user:             { id: r.user_id, username: r.username || 'Unknown', email: r.email || null },
        status:           r.status,
        status_badge:     statusBadge(r.status),
        country_iso3:     r.country_iso3,
        country_name:     r.country_name,
        network_code:     r.network_code,
        network_name:     r.network_name,
        phone_masked:     maskPhone(r.phone),
        recipient_amount: r.recipient_amount,
        recipient_currency: r.recipient_currency,
        amount:           r.customer_paid_amount,
        currency:         r.customer_paid_currency,
        customer_price_ngn: r.customer_total_ngn,
        provider_cost_ngn:  r.provider_cost_ngn,
        margin_ngn:         r.margin_ngn,
        fee_amount:         r.fee_amount,
        fx_rate:            r.fx_usd_ngn,
        failure_code:       r.failure_code,
        failure_reason:     r.failure_reason,
        provider_reference: r.provider_reference,
        provider_transaction_id: r.provider_transaction_id,
        transaction_id:     r.ledger_transaction_id,
        refunded:           Boolean(r.refunded),
        created_at:         r.created_at,
        updated_at:         r.updated_at,
        completed_at:       r.completed_at,
        failed_at:          r.failed_at,

        // ── Part C2: wallet + payment fields the admin UI displays ──
        wallet_type:        r.wallet_type || (r.customer_paid_currency || r.currency || '').toUpperCase() || null,
        payment_amount:     r.payment_amount ?? r.customer_paid_amount ?? null,
        payment_currency:   r.payment_currency || r.customer_paid_currency || r.currency || null,
        send_amount_usd:    r.send_amount_usd ?? null,
        fee_usd:            r.fee_usd ?? null,
        fee_percent:        r.fee_percent ?? null,
        fx_usd_ngn:         r.fx_usd_ngn ?? null,
        ledger_transaction_id: r.ledger_transaction_id || null,
        refund_reference:   r.refund_reference || null
    }));

    return {
        orders, count: total, page, limit,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
        available: true
    };
}

// ═════════════════════════════════════════════════════════════════
//  OVERVIEW — RPC admin_airtime_overview, fallback to view query
// ═════════════════════════════════════════════════════════════════

async function getOverview(query = {}) {
    const fromIso = isoDate(query.from) || startOfWatDay();
    const toIso   = isoDate(query.to)   || new Date().toISOString();
    const scope = query.scope && ['all', 'local', 'global'].includes(String(query.scope).toLowerCase())
        ? String(query.scope).toLowerCase() : 'all';

    // ── 1. Try the RPC ─────────────────────────────────────────
    try {
        const { data, error } = await supabaseAdmin.rpc('admin_airtime_overview', {
            p_from: fromIso, p_to: toIso, p_scope: scope
        });
        if (!error && data) {
            const row = typeof data === 'string' ? JSON.parse(data) : data;
            const num = v => Number(v || 0);
            const str = v => (v == null ? null : String(v));
            const norm = (s) => {
                const src = s || {};
                return {
                    orders:        num(src.orders),
                    completed:     num(src.completed),
                    pending:       num(src.pending),
                    failed:        num(src.failed),
                    refunded:      num(src.refunded),
                    manual_review: num(src.manual_review),
                    salesNgn:      str(src.sales_ngn  ?? src.salesNgn)  || '0.00',
                    costNgn:       str(src.cost_ngn   ?? src.costNgn)   || '0.00',
                    marginNgn:     str(src.margin_ngn ?? src.marginNgn) || '0.00'
                };
            };
                        const totals = norm(row.totals || row);
            const global = norm(row.global);
            const local  = norm(row.local);

            // ── SANITY GUARD ─────────────────────────────────────
            // The RPC is producing "Orders: 0 / Completed: 4" because
            // its COUNT(*) is wrong. Fall through to the view query,
            // which is authoritative, so the admin UI never shows
            // contradictory numbers.
            if (totals.completed > 0 && totals.orders === 0) {
                console.warn('[AIRTIME] RPC totals.orders=0 but completed>0 — falling through to view query.');
                throw new Error('RPC_INCONSISTENT');
            }
            // ─────────────────────────────────────────────────────

            const successRate = totals.orders > 0
                ? Math.round((totals.completed / totals.orders) * 1000) / 10 : 0;

            // Part C4: wallet split — pass-through the RPC's shape
            // if present, or derive it defensively from row.byWallet.
            const byWallet = (() => {
                const b = row.byWallet || {};
                const pick = (src) => ({
                    orders:       num(src?.orders),
                    completed:    num(src?.completed),
                    amount:       num(src?.amount),
                    customer_ngn: num(src?.customer_ngn ?? src?.customerNgn)
                });
                return { USD: pick(b.USD), NGN: pick(b.NGN) };
            })();

            return {
                total:        totals.orders,
                completed:    totals.completed,
                pending:      totals.pending,
                failed:       totals.failed,
                refunded:     totals.refunded,
                manual_review:totals.manual_review,
                salesNgn:     totals.salesNgn,
                costNgn:      totals.costNgn,
                marginNgn:    totals.marginNgn,
                successRate,
                byWallet,
                scopes:       { local, global },
                providers: {
                    dtone:  { ...global },
                    vtpass: { ...local }
                },
                series: {
                    local:  Array.isArray(row.series_local)  ? row.series_local  : [],
                    global: Array.isArray(row.series_global) ? row.series_global : []
                },
                summaryAvailable: true,
                from: fromIso, to: toIso
            };
        }
        if (error && error.code !== '42883' && error.code !== 'PGRST202') {
            console.warn('[AIRTIME] RPC admin_airtime_overview failed:', error.message);
        }
    } catch (e) {
        console.warn('[AIRTIME] RPC admin_airtime_overview threw:', e.message);
    }

    // ── 2. Fallback: query the view ────────────────────────────
    // Part C4: select the wallet columns too so byWallet can be
    // computed from the fallback path when the RPC is not deployed.
    let q = supabaseAdmin
        .from('admin_airtime_orders_v')
        .select('scope, status, customer_total_ngn, provider_cost_ngn, margin_ngn, created_at, wallet_type, payment_amount, payment_currency, customer_paid_amount, customer_paid_currency')
        .gte('created_at', fromIso)
        .lte('created_at', toIso);
    if (scope !== 'all') q = q.eq('scope', scope);

    const { data: rows, error } = await q;
    if (error) {
        return {
            total: 0, completed: 0, pending: 0, failed: 0, refunded: 0,
            manual_review: 0,
            salesNgn: '0.00', costNgn: '0.00', marginNgn: '0.00',
            successRate: 0,
            byWallet: { USD: { orders: 0, completed: 0, amount: 0, customer_ngn: 0 },
                        NGN: { orders: 0, completed: 0, amount: 0, customer_ngn: 0 } },
            scopes: { local: {}, global: {} },
            providers: { dtone: {}, vtpass: {} },
            series: { local: [], global: [] },
            summaryAvailable: false,
            from: fromIso, to: toIso
        };
    }

    const isFailed   = s => ['failed','cancelled','reversed'].includes(s);
    const isTerminal = s => ['completed','failed','cancelled','reversed','refunded'].includes(s);

    const summarize = (arr) => {
        const completed = arr.filter(r => r.status === 'completed');
        const sales = completed.reduce((a, r) => a + Number(r.customer_total_ngn || 0), 0);
        const cost  = completed.reduce((a, r) => a + Number(r.provider_cost_ngn || 0), 0);
        const margin = completed.reduce((a, r) => a + Number(r.margin_ngn || 0), 0);
        return {
            orders:        arr.length,
            completed:     completed.length,
            pending:       arr.filter(r => !isTerminal(r.status)).length,
            failed:        arr.filter(r => isFailed(r.status)).length,
            refunded:      arr.filter(r => r.status === 'refunded').length,
            manual_review: arr.filter(r => r.status === 'manual_review').length,
            salesNgn:      sales.toFixed(2),
            costNgn:       cost.toFixed(2),
            marginNgn:     margin.toFixed(2)
        };
    };

    const global = summarize((rows || []).filter(r => r.scope === 'global'));
    const local  = summarize((rows || []).filter(r => r.scope === 'local'));
    const total  = summarize(rows || []);

    const successRate = total.orders > 0
        ? Math.round((total.completed / total.orders) * 1000) / 10 : 0;

    // Part C4: wallet split — computed from the view rows.
    const byWallet = (() => {
        const empty = () => ({ orders: 0, completed: 0, amount: 0, customer_ngn: 0 });
        const out = { USD: empty(), NGN: empty() };
        for (const r of (rows || [])) {
            const w = String(r.wallet_type || r.customer_paid_currency || r.currency || '').toUpperCase();
            if (w !== 'USD' && w !== 'NGN') continue;
            out[w].orders += 1;
            if (r.status === 'completed') {
                out[w].completed += 1;
                const amt = Number(r.payment_amount ?? r.customer_paid_amount ?? 0);
                if (Number.isFinite(amt)) out[w].amount += amt;
                const ngn = Number(r.customer_total_ngn ?? 0);
                if (Number.isFinite(ngn)) out[w].customer_ngn += ngn;
            }
        }
        for (const k of ['USD', 'NGN']) {
            out[k].amount = Math.round(out[k].amount * 100) / 100;
            out[k].customer_ngn = Math.round(out[k].customer_ngn * 100) / 100;
        }
        return out;
    })();

    return {
        total:        total.orders,
        completed:    total.completed,
        pending:      total.pending,
        failed:       total.failed,
        refunded:     total.refunded,
        manual_review:total.manual_review,
        salesNgn:     total.salesNgn,
        costNgn:      total.costNgn,
        marginNgn:    total.marginNgn,
        successRate,
        byWallet,
        scopes:       { local, global },
        providers: {
            dtone:  { ...global },
            vtpass: { ...local }
        },
        series: { local: [], global: [] },
        summaryAvailable: true,
        from: fromIso, to: toIso
    };
}

function startOfWatDay() {
    const OFFSET_MS = 60 * 60 * 1000;
    const now = new Date();
    const local = new Date(now.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
    return new Date(Date.UTC(y, m, d, 0, 0, 0) - OFFSET_MS).toISOString();
}

// ═════════════════════════════════════════════════════════════════
//  ORDER DETAIL
// ═════════════════════════════════════════════════════════════════

async function getOrder(id) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid order id'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }

    let raw = null, source = null;
    {
        const { data, error } = await supabaseAdmin
            .from('airtime_transactions').select('*').eq('id', id).maybeSingle();
        if (!error && data) { raw = data; source = 'dtone'; }
    }
    if (!raw) {
        const { data, error } = await supabaseAdmin
            .from('bill_payment_transactions').select('*')
            .eq('id', id).eq('service_type', 'airtime').maybeSingle();
        if (!error && data) { raw = data; source = 'vtpass'; }
    }
    if (!raw) {
        const e = new Error('Airtime order not found'); e.status = 404; e.code = 'AO_NOT_FOUND'; throw e;
    }

    let user = null;
    if (raw.user_id) {
        const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, status, created_at')
            .eq('id', raw.user_id).maybeSingle();
        user = p || null;
    }

    let transaction = null;
    if (raw.ledger_transaction_id) {
        const { data: t } = await supabaseAdmin
            .from('transactions')
            .select('id, ref, reference, type, status, currency, amount, fee, description, metadata, created_at, completed_at, failure_reason')
            .eq('id', raw.ledger_transaction_id).maybeSingle();
        transaction = t || null;
    }

    let refundTransaction = null;
    if (raw.refund_transaction_id) {
        const { data: t } = await supabaseAdmin
            .from('transactions')
            .select('id, ref, reference, type, status, currency, amount, description, created_at, completed_at')
            .eq('id', raw.refund_transaction_id).maybeSingle();
        refundTransaction = t || null;
    }

    let ledgerEntries = [];
    if (raw.ledger_transaction_id) {
        try {
            const { data: le } = await supabaseAdmin
                .from('ledger_entries')
                .select('id, transaction_id, account_id, entry_type, amount, currency, balance_before, balance_after, description, created_at')
                .eq('transaction_id', raw.ledger_transaction_id)
                .order('created_at', { ascending: true });
            ledgerEntries = le || [];
        } catch (_) {}
    }

    let attempts = [];
    if (source === 'dtone') {
        try {
            const { data: at } = await supabaseAdmin
                .from('airtime_order_attempts')
                .select('id, attempt_no, provider, external_id, provider_transaction_id, provider_status, status, failure_reason, created_at, updated_at, completed_at')
                .eq('order_id', id).order('attempt_no', { ascending: true });
            attempts = at || [];
        } catch (_) {}
    }

    let providerEvents = [];
    try {
        const { data: pe } = await supabaseAdmin
            .from('airtime_provider_events')
            .select('id, event_type, provider, provider_status, provider_transaction_id, provider_reference, processing_status, received_at')
            .eq('order_id', id).order('received_at', { ascending: true }).limit(100);
        providerEvents = pe || [];
    } catch (_) {}

    const timeline = buildTimeline(raw, source);
    const normalized = normalizeRow(raw, source, user);

    return {
        order: normalized,
        user,
        // Part C2: expose the wallet/payment fields directly so the
        // drawer's Payment section can read them without digging.
        wallet_type: normalized.wallet_type,
        payment_amount: normalized.payment_amount,
        payment_currency: normalized.payment_currency,
        send_amount_usd: normalized.send_amount_usd,
        fee_usd: normalized.fee_usd,
        fee_percent: normalized.fee_percent,
        fx_usd_ngn: normalized.fx_usd_ngn,
        idempotency_key: normalized.idempotency_key,
        provider_snapshot: {
            provider: normalized.provider,
            provider_product_id: source === 'dtone' ? (raw.product_id || null) : (raw.variation_code || null),
            provider_transaction_id: normalized.provider_transaction_id,
            provider_reference: normalized.provider_reference,
            provider_status: raw.provider_status || null,
            last_provider_check_at: raw.last_reconciliation_at || null,
            provider_check_attempts: raw.reconciliation_attempts ?? 0,
            reconciliation_attempts: raw.reconciliation_attempts ?? 0
        },
        pricing_snapshot: {
            send_amount_usd:    raw.send_amount_usd ?? null,
            fee_usd:            raw.fee_usd ?? null,
            fee_percent:        raw.fee_percent ?? null,
            fx_usd_ngn:         raw.fx_usd_ngn ?? raw.exchange_rate ?? null,
            amount:             raw.amount ?? raw.base_amount ?? null,
            currency:           normalized.currency,
            customer_price_ngn: normalized.customer_price_ngn,
            customer_paid_amount: normalized.amount,
            customer_paid_currency: normalized.currency,
            provider_cost_ngn:  normalized.provider_cost_ngn,
            provider_cost_usd:  normalized.provider_cost_usd,
            margin_ngn:         normalized.margin_ngn,
            margin_percent: (() => {
                const cost = Number(normalized.provider_cost_ngn || 0);
                const margin = Number(normalized.margin_ngn || 0);
                return cost > 0 ? Math.round((margin / cost) * 10000) / 100 : null;
            })()
        },
        failure: {
            code:   normalized.failure_code,
            reason: normalized.failure_reason
        },
        delivery: {
            phone_masked: normalized.phone_masked,
            network_code: normalized.network_code,
            network_name: normalized.network_name,
            country_iso3: normalized.country_iso3,
            country_name: normalized.country_name
        },
        transaction,
        refund_transaction: refundTransaction,
        ledger_entries: ledgerEntries,
        attempts,
        provider_events: providerEvents,
        timeline
    };
}

function buildTimeline(raw, source) {
    const events = [];
    if (raw.created_at) events.push({ at: raw.created_at, kind: 'order_created', label: 'Order created' });
    if (raw.processing_at) events.push({ at: raw.processing_at, kind: 'processing', label: 'Processing started' });
    if (raw.completed_at) events.push({ at: raw.completed_at, kind: 'completed', label: 'Order completed' });
    const reason = raw.failure_message || raw.failure_reason || null;
    if (raw.failed_at) events.push({ at: raw.failed_at, kind: 'failed', label: `Order failed${reason ? ' — ' + reason : ''}` });
    if (raw.refunded_at) events.push({ at: raw.refunded_at, kind: 'refunded', label: 'Order refunded' });
    events.sort((a, b) => new Date(a.at) - new Date(b.at));
    return events;
}

// ═════════════════════════════════════════════════════════════════
//  MUTATIONS
// ═════════════════════════════════════════════════════════════════

async function loadOrderByAnyId(orderId) {
    if (!UUID_RE.test(String(orderId || ''))) {
        const e = new Error('Invalid order id'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    {
        const { data, error } = await supabaseAdmin
            .from('airtime_transactions').select('*').eq('id', orderId).maybeSingle();
        if (!error && data) return { raw: data, source: 'dtone' };
    }
    {
        const { data, error } = await supabaseAdmin
            .from('bill_payment_transactions').select('*')
            .eq('id', orderId).eq('service_type', 'airtime').maybeSingle();
        if (!error && data) return { raw: data, source: 'vtpass' };
    }
    const e = new Error('Airtime order not found'); e.status = 404; e.code = 'AO_NOT_FOUND'; throw e;
}

async function retryOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const { raw: order, source } = await loadOrderByAnyId(orderId);

    const current = String(order.status || '').toLowerCase();
    if (current === 'completed') {
        const e = new Error('Order is already completed.'); e.status = 409; e.code = 'ALREADY_COMPLETED'; throw e;
    }
    if (current === 'refunded' || current === 'refund_pending') {
        const e = new Error('Order is in a refund state — retry is not allowed.');
        e.status = 409; e.code = 'IN_REFUND_STATE'; throw e;
    }

    const normalized = normalizeRow(order, source, null);
    const providerState = await resolveProviderState(normalized);

    if (providerState.classification === 'CONFIRMED_FULFILLED') {
        await completeOrder(source, order, ctx, 'retry_detected_completed_at_provider');
        return { outcome: 'delivered_existing' };
    }

    if (providerState.classification === 'UNKNOWN') {
        await markReconciliation(source, order, ctx,
            `Retry refused: provider state unknown (${providerState.reason || providerState.providerStatus || 'unknown'}).`);
        return { outcome: 'reconciliation_required' };
    }

    const adapter = PROVIDERS[normalized.provider];
    if (!adapter) {
        const e = new Error('Unknown provider on order.'); e.status = 422; e.code = 'UNKNOWN_PROVIDER'; throw e;
    }

    const attemptNo = Number(order.reconciliation_attempts || 0) + 1;
    const externalId = buildAttemptReference(normalized.provider, normalized.order_ref, attemptNo);

    let purchaseResult;
    try {
        const wholesaleAmount =
            source === 'dtone'
                ? (order.send_amount_usd || order.provider_cost || order.destination_amount || order.base_amount)
                : (order.base_amount || order.customer_amount);
        const wholesaleCurrency =
            source === 'dtone'
                ? (order.provider_currency || 'USD')
                : 'NGN';

        purchaseResult = await adapter.purchase({
            order: {
                phone_number: order.phone_number || order.recipient,
                network_code: order.operator_id ? String(order.operator_id) : order.network,
                wholesale_amount: wholesaleAmount,
                wholesale_currency: wholesaleCurrency,
                provider_product_id: order.product_id || order.variation_code,
                product_mode: source === 'dtone' ? 'RANGED_SOURCE' : 'FIXED'
            },
            attempt: { provider_reference: externalId },
            callbackUrl: null
        });
    } catch (e) {
        if (e.ambiguous) {
            await markReconciliation(source, order, ctx, 'Provider request outcome is unknown.');
            return { outcome: 'reconciliation_required' };
        }
        await markFailed(source, order, ctx, e.code || 'PROVIDER_PURCHASE_REJECTED',
            'Provider rejected the purchase request.', reason);
        return { outcome: 'failed' };
    }

    const patch = source === 'dtone'
        ? {
            provider_transaction_id: purchaseResult.providerTransactionId || order.provider_transaction_id,
            dtone_external_id: purchaseResult.providerReference || externalId,
            provider_status: purchaseResult.providerStatus || null,
            status: 'processing',
            failure_code: null,
            failure_message: null,
            processing_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            reconciliation_attempts: (order.reconciliation_attempts || 0) + 1
        }
        : {
            provider_transaction_id: purchaseResult.providerTransactionId || order.provider_transaction_id,
            provider_request_id: purchaseResult.providerReference || externalId,
            provider_status: purchaseResult.providerStatus || null,
            status: 'processing',
            failure_reason: null,
            processing_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            reconciliation_attempts: (order.reconciliation_attempts || 0) + 1
        };

    const table = source === 'dtone' ? 'airtime_transactions' : 'bill_payment_transactions';
    await supabaseAdmin.from(table).update(patch).eq('id', order.id);

    await recordAudit({
        ctx, action: 'airtime.retry', targetId: order.id,
        before: { status: current }, after: { status: 'processing' }, reason
    });

    return { outcome: 'retried' };
}

async function syncOrder({ orderId, ctx }) {
    const { raw: order, source } = await loadOrderByAnyId(orderId);
    const normalized = normalizeRow(order, source, null);
    const providerState = await resolveProviderState(normalized);

    const table = source === 'dtone' ? 'airtime_transactions' : 'bill_payment_transactions';
    const now = new Date().toISOString();

    await supabaseAdmin.from(table).update({
        last_reconciliation_at: now,
        reconciliation_attempts: (order.reconciliation_attempts || 0) + 1,
        provider_status: providerState.providerStatus || order.provider_status
    }).eq('id', order.id);

    if (providerState.classification === 'CONFIRMED_FULFILLED') {
        await completeOrder(source, order, ctx, 'admin_sync_completed_at_provider');
        return { synced: true, resolved: 'completed' };
    }

    if (providerState.classification === 'CONFIRMED_NOT_FULFILLED') {
        await markFailed(source, order, ctx,
            providerState.providerStatus || 'PROVIDER_REJECTED',
            'Provider confirmed the transaction was not fulfilled.', null);
        return { synced: true, resolved: 'failed' };
    }

    await markReconciliation(source, order, ctx,
        `Sync outcome unknown: ${providerState.reason || providerState.providerStatus || 'unknown'}`);
    return { synced: true, resolved: 'unknown' };
}

async function refundOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const { raw: order, source } = await loadOrderByAnyId(orderId);
    const current = String(order.status || '').toLowerCase();

    if (current === 'refunded') {
        const e = new Error('Order is already refunded.'); e.status = 409; e.code = 'ALREADY_REFUNDED'; throw e;
    }
    if (current !== 'failed' && current !== 'refund_pending') {
        const e = new Error('Only failed orders can be refunded.'); e.status = 422; e.code = 'NOT_REFUNDABLE'; throw e;
    }
    if (!order.ledger_transaction_id) {
        const e = new Error('Order has no wallet transaction.'); e.status = 422; e.code = 'NO_TRANSACTION'; throw e;
    }

    const { data: originalTx } = await supabaseAdmin
        .from('transactions')
        .select('id, user_id, type, status, currency, amount')
        .eq('id', order.ledger_transaction_id).maybeSingle();
    if (!originalTx) { const e = new Error('Original transaction not found.'); e.status = 404; e.code = 'TX_NOT_FOUND'; throw e; }
    if (String(originalTx.status).toLowerCase() !== 'completed') {
        const e = new Error('Original transaction is not completed — cannot refund.'); e.status = 422; e.code = 'TX_NOT_REFUNDABLE'; throw e;
    }

    const { data: existingRefund } = await supabaseAdmin
        .from('transactions')
        .select('id, reference, amount, currency')
        .eq('source_id', originalTx.id).eq('type', 'refund').maybeSingle();

    if (existingRefund) {
        await applyRefundPatch(source, order, existingRefund, ctx, reason, true);
        return {
            refund: {
                transaction_id: existingRefund.id,
                reference: existingRefund.reference,
                amount: existingRefund.amount,
                currency: existingRefund.currency,
                already_refunded: true
            }
        };
    }

    let creditResult;
    try {
        creditResult = await LedgerService.creditWallet({
            userId: order.user_id,
            amount: originalTx.amount,
            currency: originalTx.currency,
            description: `Airtime order refund: ${order.reference}`,
            type: 'refund',
            sourceType: 'airtime_order',
            sourceId: originalTx.id,
            reference: `AIRREF-${order.reference}`,
            metadata: { airtime_order_id: order.id, order_ref: order.reference, reason, source }
        });
    } catch (ledgerErr) {
        const msg = String(ledgerErr.message || '');
        if (msg.includes('duplicate') || msg.includes('unique')) {
            const { data: raceRefund } = await supabaseAdmin
                .from('transactions')
                .select('id, reference, amount, currency')
                .eq('source_id', originalTx.id).eq('type', 'refund').maybeSingle();
            if (raceRefund) {
                await applyRefundPatch(source, order, raceRefund, ctx, reason, true);
                return {
                    refund: {
                        transaction_id: raceRefund.id,
                        reference: raceRefund.reference,
                        amount: raceRefund.amount,
                        currency: raceRefund.currency,
                        already_refunded: true
                    }
                };
            }
        }
        const e = new Error('Wallet refund failed.'); e.status = 400; e.code = 'LEDGER_REFUND_FAILED'; e.cause = msg; throw e;
    }

    await applyRefundPatch(source, order, creditResult, ctx, reason, false);

    return {
        refund: {
            transaction_id: creditResult.transaction_id || null,
            reference: creditResult.reference || null,
            amount: originalTx.amount,
            currency: originalTx.currency,
            already_refunded: false
        }
    };
}

async function applyRefundPatch(source, order, refundResult, ctx, reason, alreadyRefunded) {
    const table = source === 'dtone' ? 'airtime_transactions' : 'bill_payment_transactions';
    const now = new Date().toISOString();

    const patch = source === 'dtone'
        ? {
            status: 'refunded',
            refunded: true,
            refund_status: 'completed',
            refund_transaction_id: refundResult.transaction_id || null,
            refund_reference: refundResult.reference || null,
            refunded_at: now,
            updated_at: now
        }
        : {
            status: 'refunded',
            refunded: true,
            refund_transaction_id: refundResult.transaction_id || null,
            refund_reference: refundResult.reference || null,
            refunded_at: now,
            updated_at: now
        };

    await supabaseAdmin.from(table).update(patch).eq('id', order.id);

    await recordAudit({
        ctx,
        action: alreadyRefunded ? 'airtime.refund_idempotent' : 'airtime.refund',
        targetId: order.id,
        before: { status: order.status, amount: refundResult.amount },
        after: { status: 'refunded', refund_transaction_id: refundResult.transaction_id || null },
        reason
    });
}

async function reviewOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const { raw: order, source } = await loadOrderByAnyId(orderId);
    const current = String(order.status || '').toLowerCase();

    if (current === 'completed' || current === 'refunded') {
        const e = new Error(`Cannot move a ${current} order to reconciliation.`);
        e.status = 422; e.code = 'INVALID_STATUS_TRANSITION'; throw e;
    }

    await markReconciliation(source, order, ctx, reason);
    return { reviewed: true };
}

async function completeOrder(source, order, ctx, eventLabel) {
    const table = source === 'dtone' ? 'airtime_transactions' : 'bill_payment_transactions';
    const now = new Date().toISOString();
    const patch = source === 'dtone'
        ? { status: 'completed', provider_status: 'COMPLETED', completed_at: now, updated_at: now, failure_code: null, failure_message: null }
        : { status: 'completed', provider_status: 'COMPLETED', completed_at: now, updated_at: now, failure_reason: null };

    await supabaseAdmin.from(table).update(patch).eq('id', order.id);

    await recordAudit({
        ctx: ctx || { adminId: null, adminEmail: null },
        action: `airtime.${eventLabel || 'completed'}`,
        targetId: order.id,
        before: { status: order.status },
        after: { status: 'completed' },
        reason: null
    });
}

async function markFailed(source, order, ctx, failureCode, failureReason, reason) {
    const table = source === 'dtone' ? 'airtime_transactions' : 'bill_payment_transactions';
    const now = new Date().toISOString();
    const patch = source === 'dtone'
        ? {
            status: 'failed',
            failed_at: now,
            failure_code: failureCode || 'PROVIDER_FAILED',
            failure_message: failureReason || 'Provider rejected the transaction.',
            updated_at: now
        }
        : {
            status: 'failed',
            failed_at: now,
            failure_reason: failureReason || 'Provider rejected the transaction.',
            updated_at: now
        };

    await supabaseAdmin.from(table).update(patch).eq('id', order.id);

    await recordAudit({
        ctx: ctx || { adminId: null, adminEmail: null },
        action: 'airtime.failed',
        targetId: order.id,
        before: { status: order.status },
        after: { status: 'failed', failure_code: failureCode },
        reason
    });
}

async function markReconciliation(source, order, ctx, reason) {
    const table = source === 'dtone' ? 'airtime_transactions' : 'bill_payment_transactions';
    const now = new Date().toISOString();
    const patch = source === 'dtone'
        ? {
            status: 'manual_review',
            failure_code: 'RECONCILIATION_REQUIRED',
            failure_message: String(reason || '').slice(0, 500),
            updated_at: now
        }
        : {
            status: 'manual_review',
            failure_reason: String(reason || '').slice(0, 500),
            updated_at: now
        };

    await supabaseAdmin.from(table).update(patch).eq('id', order.id);

    await recordAudit({
        ctx: ctx || { adminId: null, adminEmail: null },
        action: 'airtime.reconciliation_required',
        targetId: order.id,
        before: { status: order.status },
        after: { status: 'manual_review' },
        reason
    });
}

// ═════════════════════════════════════════════════════════════════
//  PROVIDER HEALTH
// ═════════════════════════════════════════════════════════════════

async function getProviderHealth() {
    const { data, error } = await supabaseAdmin
        .from('airtime_provider_health')
        .select('*');

    const cached = error?.code === '42P01' ? [] : (data || []);

    const out = {};
    for (const name of Object.keys(PROVIDERS)) {
        const row = (cached || []).find(r => r.provider === name);
        if (row) {
            out[name] = {
                provider: name,
                status: row.status || 'unknown',
                configured: row.configured ?? null,
                reachable: row.reachable ?? null,
                lastSuccess: row.last_success || null,
                lastFailure: row.last_failure_at ? { at: row.last_failure_at, reason: row.last_failure_reason || null } : null,
                recentCount: row.recent_orders_24h || 0,
                latencyMs: row.latency_ms ?? null,
                lastHealthCheck: row.last_health_check || null,
                consecutiveFailures: row.consecutive_failures ?? 0,
                circuitState: row.circuit_state || 'closed',
                lastError: row.last_error || null
            };
        } else {
            out[name] = {
                provider: name,
                status: 'unknown',
                configured: null, reachable: null,
                lastSuccess: null, lastFailure: null, recentCount: 0,
                latencyMs: null, lastHealthCheck: null,
                consecutiveFailures: 0, circuitState: 'closed', lastError: null
            };
        }
    }
    return out;
}

async function healthCheckProvider({ provider, ctx }) {
    const adapter = PROVIDERS[provider];
    if (!adapter) { const e = new Error(`Unknown provider: ${provider}`); e.status = 400; e.code = 'UNKNOWN_PROVIDER'; throw e; }

    const startedAt = Date.now();
    let live;
    try { live = await adapter.healthCheck(); }
    catch (e) { live = { configured: true, reachable: false, lastError: e.message }; }
    const latencyMs = Date.now() - startedAt;
    const now = new Date().toISOString();

    try {
        await supabaseAdmin
            .from('airtime_provider_health')
            .upsert({
                provider,
                configured: live.configured,
                reachable: live.reachable,
                last_health_check: now,
                last_error: live.lastError || null,
                latency_ms: latencyMs,
                updated_at: now
            }, { onConflict: 'provider' });
    } catch (e) {
        if (!String(e.message || '').includes('42P01')) {
            console.warn('[AIRTIME] health upsert failed:', e.message);
        }
    }

    await recordAudit({
        ctx, action: `airtime.health_check_${provider}`,
        targetId: provider, before: null, after: live, reason: null
    });

    return { ...live, latencyMs };
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
    ORDER_STATUSES,
    ALLOWED_TRANSITIONS,

    resolveProvider,
    listRouting,
    setRouting,

    listOrders,
    getOverview,
    getOrder,

    retryOrder,
    refundOrder,
    syncOrder,
    reviewOrder,

    getProviderHealth,
    healthCheckProvider,

    resolveProviderState
};