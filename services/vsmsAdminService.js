// services/vsmsAdminService.js
// ─────────────────────────────────────────────────────────────────────────────
// Admin Virtual SMS — service layer.
//
// Reads and manages the same virtual_sms_orders table the customer flow
// writes to. Admin operations:
//
//   • stats / list / detail / events / provider logs
//   • sync          — ask the provider for the current state, apply
//   • cancel        — provider cancel (setStatus=8) then refund
//   • release       — provider releases the number (no refund)
//   • retry         — provider setStatus=3 (resend SMS)
//   • refund        — refund without provider cancel (uses shared helper)
//   • changeStatus  — manual status transition (via vsmsOrderService)
//   • reveal        — return OTP + full phone (always audited)
//   • attention     — Needs Attention queue (RPC)
//   • catalogue     — countries / services admin overrides
//
// Every refund, every transition, every provider call routes through:
//   • vsmsOrderService.refundOrderSafely
//   • vsmsOrderService.transition
//   • vsmsProvider
//
// Nothing here calls LedgerService.creditWallet directly. Nothing here
// writes virtual_sms_orders.status directly. Every state change writes
// virtual_sms_order_events + virtual_sms_admin_actions + admin_audit_logs.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const adminSettings = require('./adminSettingsService');
const orderService = require('./vsmsOrderService');
const provider = require('./vsmsProvider');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const FAILED_STATUSES = new Set(['failed', 'cancelled', 'expired', 'reversed']);
const PENDING_STATUSES = new Set(['pending', 'processing', 'active', 'sms_received', 'manual_review']);

// ─── Helpers ─────────────────────────────────────────────────────────────
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
// Inclusive end-of-day for a date-only input.
function endOfDayIso(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const d = new Date(s + 'T23:59:59.999Z');
        return isNaN(d.getTime()) ? null : d.toISOString();
    }
    return isoDate(s);
}

function statusBadge(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'completed') return 'success';
    if (FAILED_STATUSES.has(s)) return 'danger';
    if (s === 'refunded') return 'info';
    if (s === 'manual_review') return 'purple';
    if (s === 'sms_received') return 'success';
    if (s === 'active') return 'success';
    if (PENDING_STATUSES.has(s)) return 'warn';
    return 'neutral';
}

function maskPhone(p) {
    if (!p) return '—';
    const s = String(p);
    if (s.length <= 4) return s;
    return '••••' + s.slice(-4);
}
function maskEmail(e) {
    if (!e) return null;
    const s = String(e);
    const at = s.indexOf('@');
    if (at <= 0) return '•••';
    const user = s.slice(0, at);
    const domain = s.slice(at);
    return user.slice(0, 2) + '•••' + domain;
}

async function recordAdminAudit({ ctx, action, targetId, before, after, reason }) {
    try {
        await supabaseAdmin.from('admin_audit_logs').insert({
            admin_id:    ctx?.adminId || null,
            admin_email: ctx?.adminEmail || null,
            action,
            target_type: 'virtual_sms_order',
            target_id:   targetId,
            before:      before || null,
            after:       after || null,
            reason:      reason ? String(reason).slice(0, 500) : null,
            ip_address:  ctx?.ip || null,
            user_agent:  ctx?.userAgent || null,
            request_id:  ctx?.requestId || null,
            created_at:  new Date().toISOString()
        });
    } catch (e) {
        console.warn('[VSMS ADMIN] admin_audit_logs insert failed:', e.message);
    }
}

async function recordAdminAction({ ctx, orderId, action, oldStatus, newStatus, reason, metadata }) {
    try {
        await supabaseAdmin.from('virtual_sms_admin_actions').insert({
            admin_id:   ctx?.adminId || null,
            order_id:   orderId,
            action,
            old_status: oldStatus || null,
            new_status: newStatus || null,
            reason:     reason ? String(reason).slice(0, 500) : null,
            metadata:   metadata || null,
            ip_address: ctx?.ip || null,
            user_agent: ctx?.userAgent || null,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.warn('[VSMS ADMIN] virtual_sms_admin_actions insert failed:', e.message);
    }
}

// ─── Row shaping ─────────────────────────────────────────────────────────
function shapeOrder(raw, profile, { includeSensitive = false } = {}) {
    const o = {
        id:         raw.id,
        user_id:    raw.user_id,
        user: profile ? {
            id:       profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email:    profile.email || null
        } : { id: raw.user_id, username: 'Unknown', email: null },
        email_masked: profile ? maskEmail(profile.email) : null,

        country_id:   raw.country_id ?? null,
        country_name: raw.country_name || null,
        service_code: raw.service_code,
        service_name: raw.service_name || raw.service_code,

        phone_number:  raw.phone_number  || null,
        phone_masked:  maskPhone(raw.phone_number),
        activation_id: raw.activation_id || null,
        provider:      'virtualsms',

        status:         raw.status,
        status_badge:   statusBadge(raw.status),
        sms_status:     raw.sms_status || (raw.sms_code ? 'received' : 'waiting'),
        otp_status:     raw.otp_status || (raw.sms_code ? 'received' : 'pending'),
        refund_status:  raw.refund_status || null,
        needs_attention: !!raw.needs_attention,
        attention_reason: raw.attention_reason || null,
        check_attempts:  Number(raw.check_attempts)  || 0,
        refund_attempts: Number(raw.refund_attempts) || 0,

        price_usd:          raw.price_usd          ?? null,
        price_ngn:          raw.price_ngn          ?? null,
        provider_cost_usd:  raw.provider_cost_usd  ?? null,
        charge_currency:    raw.charge_currency    || 'NGN',
        charge_amount:      raw.charge_amount      ?? null,
        exchange_rate:      raw.exchange_rate      ?? null,

        ledger_transaction_id: raw.ledger_transaction_id || null,
        ledger_reference:      raw.ledger_reference      || null,
        refund_transaction_id: raw.refund_transaction_id || null,

        has_sms_code:    Boolean(raw.sms_code),
        sms_received_at: raw.sms_received_at || null,
        completed_confirmed_at: raw.completed_confirmed_at || null,
        failure_code:    raw.failure_code    || null,
        failure_message: raw.failure_message || null,

        created_at:     raw.created_at,
        updated_at:     raw.updated_at     || null,
        activated_at:   raw.activated_at   || null,
        completed_at:   raw.completed_at   || null,
        cancelled_at:   raw.cancelled_at   || null,
        refunded_at:    raw.refunded_at    || null,
        expired_at:     raw.expired_at     || null,
        expires_at:     raw.expires_at     || null,
        cancel_available_at: raw.cancel_available_at || null,

        profit_usd: computeProfitUsd(raw)
    };

    if (includeSensitive) {
        o.sms_code = raw.sms_code || null;
        o.sms_message = raw.sms_message || null;
        o.sms_sender = raw.sms_sender || null;
        o.provider_response = raw.provider_response || null;
    }
    return o;
}

function computeProfitUsd(raw) {
    const priceUsd = Number(raw.price_usd);
    const costUsd  = Number(raw.provider_cost_usd);
    if (!Number.isFinite(priceUsd) || !Number.isFinite(costUsd)) return null;
    return (priceUsd - costUsd).toFixed(2);
}

async function loadProfilesByIds(userIds) {
    if (!userIds.length) return {};
    const { data } = await supabaseAdmin
        .from('profiles')
        .select('id, username, email')
        .in('id', userIds);
    const out = {};
    for (const p of data || []) out[p.id] = p;
    return out;
}

async function loadVsmsById(id) {
    if (!UUID_RE.test(String(id || ''))) {
        const e = new Error('Invalid order id'); e.status = 400; e.code = 'INVALID_ID';
        throw e;
    }
    const { data, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error) {
        const e = new Error('Failed to load VSMS order'); e.status = 500; e.code = 'VSMS_DETAIL_ERROR';
        throw e;
    }
    if (!data) {
        const e = new Error('VSMS order not found'); e.status = 404; e.code = 'VSMS_NOT_FOUND';
        throw e;
    }
    return data;
}

// ─── STATS ───────────────────────────────────────────────────────────────
// Uses the new range-aware RPC. `range` can be 'today' | '7d' | '30d' | 'all'.
function resolveRange(range) {
    const now = new Date();
    const r = String(range || 'today').toLowerCase();
    if (r === 'all') {
        return { from: new Date('2020-01-01T00:00:00Z').toISOString(), to: now.toISOString() };
    }
    if (r === '7d') {
        return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), to: now.toISOString() };
    }
    if (r === '30d') {
        return { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), to: now.toISOString() };
    }
    // today — WAT midnight
    const OFFSET_MS = 60 * 60 * 1000;
    const local = new Date(now.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
    const start = new Date(Date.UTC(y, m, d, 0, 0, 0) - OFFSET_MS);
    return { from: start.toISOString(), to: now.toISOString() };
}

async function getStats(query = {}) {
    let fromIso, toIso;
    if (query.from || query.to) {
        fromIso = isoDate(query.from) || new Date('2020-01-01T00:00:00Z').toISOString();
        toIso   = endOfDayIso(query.to) || new Date().toISOString();
    } else {
        const r = resolveRange(query.range);
        fromIso = r.from;
        toIso   = r.to;
    }

    const rpc = await supabaseAdmin.rpc('virtual_sms_admin_stats', {
        p_from: fromIso, p_to: toIso
    });

    if (!rpc.error && rpc.data) {
        const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
        const num = v => Number(v || 0);
        return {
            range: query.range || (query.from || query.to ? 'custom' : 'today'),
            from:  fromIso,
            to:    toIso,
            counts: {
                total:         num(row.total),
                pending:       num(row.pending),
                processing:    num(row.processing),
                active:        num(row.active),
                sms_received:  num(row.sms_received),
                completed:     num(row.completed),
                failed:        num(row.failed),
                expired:       num(row.expired),
                cancelled:     num(row.cancelled),
                refunded:      num(row.refunded),
                manual_review: num(row.manual_review),
                needs_attention: num(row.needs_attention),
                waiting_sms:   num(row.waiting_sms)
            },
            revenue: {
                ngn:              String(row.revenue_ngn  || '0.00'),
                usd:              String(row.revenue_usd  || '0.00'),
                combined_ngn:     String(row.revenue_combined_ngn || '0.00')
            },
            cost: {
                usd_total:        String(row.cost_usd     || '0.00'),
                ngn_share:        String(row.cost_ngn     || '0.00')
            },
            profit: {
                ngn:              String(row.profit_ngn   || '0.00'),
                usd:              String(row.profit_usd   || '0.00'),
                combined_ngn:     String(row.profit_combined_ngn || '0.00')
            },
            refunds: {
                count:            num(row.refunded_count),
                amount_ngn:       String(row.refunded_amount_ngn || '0.00'),
                amount_usd:       String(row.refunded_amount_usd || '0.00')
            },
            timing: {
                avg_time_to_code_seconds: row.avg_time_to_code_seconds != null
                    ? Number(row.avg_time_to_code_seconds)
                    : null
            },
            fx_rate: Number(row.current_fx_rate) || 1600,
            summaryAvailable: true
        };
    }

    if (rpc.error?.code !== '42883' && rpc.error?.code !== 'PGRST202') {
        const e = new Error('Failed to aggregate VSMS stats');
        e.status = 500; e.code = 'VSMS_STATS_ERROR'; e.cause = rpc.error.message;
        throw e;
    }

    // Fallback: bounded read + Node aggregation.
    return await fallbackStats(fromIso, toIso, query.range || 'today');
}

async function fallbackStats(fromIso, toIso, range) {
    const { data, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('*')
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
        .limit(5000);
    if (error) {
        if (error.code === '42P01') {
            return emptyStats(fromIso, toIso, range, 'VSMS_TABLE_NOT_FOUND');
        }
        const e = new Error('Failed to read VSMS orders');
        e.status = 500; e.code = 'VSMS_STATS_ERROR'; throw e;
    }

    const rows = data || [];
    const num = v => Number(v || 0);
    const fx = await adminSettings.getRaw('usd_to_ngn').then(v => Number(v) || 1600).catch(() => 1600);

    let revenueNgn = 0, revenueUsd = 0;
    let costUsd = 0, costNgnShare = 0;
    let profitNgn = 0, profitUsd = 0;
    let refundedAmountNgn = 0, refundedAmountUsd = 0;
    let totalTimeToCode = 0, codesWithTime = 0;
    const counts = {
        total: rows.length, pending: 0, processing: 0, active: 0,
        sms_received: 0, completed: 0, failed: 0, expired: 0,
        cancelled: 0, refunded: 0, manual_review: 0,
        needs_attention: 0, waiting_sms: 0
    };

    for (const r of rows) {
        const st = String(r.status || '').toLowerCase();
        if (st === 'pending') counts.pending++;
        else if (st === 'processing') counts.processing++;
        else if (st === 'active') counts.active++;
        else if (st === 'sms_received') counts.sms_received++;
        else if (st === 'completed') counts.completed++;
        else if (st === 'failed') counts.failed++;
        else if (st === 'expired') counts.expired++;
        else if (st === 'cancelled') counts.cancelled++;
        else if (st === 'refunded') counts.refunded++;
        else if (st === 'manual_review') counts.manual_review++;
        if (r.needs_attention) counts.needs_attention++;
        if (['processing','active'].includes(st) && !r.sms_code) counts.waiting_sms++;

        if (st === 'completed') {
            const amt = num(r.charge_amount);
            const cost = num(r.provider_cost_usd);
            const rate = num(r.exchange_rate) || fx;
            if (String(r.charge_currency).toUpperCase() === 'USD') {
                revenueUsd += amt;
                costUsd += cost;
                profitUsd += amt - cost;
            } else {
                revenueNgn += amt;
                costNgnShare += cost * rate;
                profitNgn += amt - cost * rate;
            }
        }
        if (st === 'refunded') {
            const amt = num(r.charge_amount);
            if (String(r.charge_currency).toUpperCase() === 'USD') refundedAmountUsd += amt;
            else refundedAmountNgn += amt;
        }
        if (r.sms_received_at && r.created_at && st === 'completed') {
            totalTimeToCode += (new Date(r.sms_received_at) - new Date(r.created_at)) / 1000;
            codesWithTime++;
        }
    }

    return {
        range, from: fromIso, to: toIso,
        counts,
        revenue: {
            ngn: revenueNgn.toFixed(2),
            usd: revenueUsd.toFixed(2),
            combined_ngn: (revenueNgn + revenueUsd * fx).toFixed(2)
        },
        cost: { usd_total: costUsd.toFixed(2), ngn_share: costNgnShare.toFixed(2) },
        profit: {
            ngn: profitNgn.toFixed(2),
            usd: profitUsd.toFixed(2),
            combined_ngn: (profitNgn + profitUsd * fx).toFixed(2)
        },
        refunds: {
            count: counts.refunded,
            amount_ngn: refundedAmountNgn.toFixed(2),
            amount_usd: refundedAmountUsd.toFixed(2)
        },
        timing: { avg_time_to_code_seconds: codesWithTime > 0 ? totalTimeToCode / codesWithTime : null },
        fx_rate: fx,
        summaryAvailable: true
    };
}

function emptyStats(fromIso, toIso, range, reason) {
    return {
        range, from: fromIso, to: toIso,
        counts: {
            total: 0, pending: 0, processing: 0, active: 0, sms_received: 0,
            completed: 0, failed: 0, expired: 0, cancelled: 0, refunded: 0,
            manual_review: 0, needs_attention: 0, waiting_sms: 0
        },
        revenue: { ngn: '0.00', usd: '0.00', combined_ngn: '0.00' },
        cost: { usd_total: '0.00', ngn_share: '0.00' },
        profit: { ngn: '0.00', usd: '0.00', combined_ngn: '0.00' },
        refunds: { count: 0, amount_ngn: '0.00', amount_usd: '0.00' },
        timing: { avg_time_to_code_seconds: null },
        fx_rate: 1600,
        summaryAvailable: false, reason
    };
}

// ─── ATTENTION QUEUE ─────────────────────────────────────────────────────
async function getAttentionQueue(limit = 100) {
    const rpc = await supabaseAdmin.rpc('virtual_sms_attention_queue', {
        p_limit: Math.min(Math.max(Number(limit) || 100, 1), 500)
    });
    if (rpc.error) {
        if (rpc.error.code === '42883' || rpc.error.code === 'PGRST202') {
            return { items: [], available: false, reason: 'RPC_NOT_DEPLOYED' };
        }
        const e = new Error('Failed to load attention queue');
        e.status = 500; e.code = 'ATTENTION_ERROR'; throw e;
    }
    return { items: rpc.data || [], available: true };
}

// ─── LIST ────────────────────────────────────────────────────────────────
async function listOrders(query = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('virtual_sms_orders')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    const status = String(query.status || '').toLowerCase();
    if (status && status !== 'all') q = q.eq('status', status);

    if (query.country) q = q.eq('country_id', Number(query.country));
    if (query.service) q = q.eq('service_code', query.service);
    if (query.user_id && UUID_RE.test(query.user_id)) q = q.eq('user_id', query.user_id);

    if (query.sms_received === 'yes') q = q.not('sms_code', 'is', null);
    else if (query.sms_received === 'no') q = q.is('sms_code', null);

    if (query.refunded === 'yes') q = q.eq('status', 'refunded');
    else if (query.refunded === 'no') q = q.neq('status', 'refunded');

    const fromIso = isoDate(query.from);
    const toIso   = endOfDayIso(query.to);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso)   q = q.lte('created_at', toIso);

    // Search — UUID match is exact; anything else is a text-only search.
    // We deliberately do NOT interpolate `id::text.ilike` in .or() —
    // PostgREST does not support that reliably.
    if (query.search) {
        const raw = String(query.search).trim();
        const isUuid = UUID_RE.test(raw);
        if (isUuid) {
            q = q.eq('id', raw);
        } else {
            const safe = raw.replace(/[%_\\]/g, m => '\\' + m);
            const orParts = [
                `phone_number.ilike.%${safe}%`,
                `activation_id.ilike.%${safe}%`,
                `service_code.ilike.%${safe}%`,
                `service_name.ilike.%${safe}%`,
                `ledger_reference.ilike.%${safe}%`
            ];
            // Optionally match by user (email/username)
            try {
                const { data: users } = await supabaseAdmin
                    .from('profiles')
                    .select('id')
                    .or(`email.ilike.%${safe}%,username.ilike.%${safe}%`)
                    .limit(50);
                if (users?.length) {
                    orParts.push(`user_id.in.(${users.map(u => u.id).join(',')})`);
                }
            } catch { /* optional */ }
            q = q.or(orParts.join(','));
        }
    }

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { orders: [], count: 0, page, limit, totalPages: 0, hasMore: false, available: false, reason: 'VSMS_TABLE_NOT_FOUND' };
        }
        const e = new Error('Failed to load VSMS orders');
        e.status = 500; e.code = 'VSMS_LIST_ERROR'; e.cause = error.message;
        throw e;
    }

    const userIds = [...new Set((data || []).map(o => o.user_id).filter(Boolean))];
    const profilesById = await loadProfilesByIds(userIds);
    const orders = (data || []).map(o => shapeOrder(o, profilesById[o.user_id]));

    return {
        orders, count: count || 0, page, limit,
        totalPages: Math.ceil((count || 0) / limit),
        hasMore: page * limit < (count || 0),
        available: true
    };
}

// ─── DETAIL ──────────────────────────────────────────────────────────────
async function getOrder(id, { revealSensitive = false } = {}) {
    const raw = await loadVsmsById(id);

    let user = null;
    if (raw.user_id) {
        const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, status, created_at')
            .eq('id', raw.user_id)
            .maybeSingle();
        user = p || null;
    }

    let transaction = null;
    if (raw.ledger_transaction_id) {
        const { data: t } = await supabaseAdmin
            .from('transactions')
            .select('id, ref, reference, type, status, currency, amount, fee, description, created_at, completed_at, failure_reason')
            .eq('id', raw.ledger_transaction_id)
            .maybeSingle();
        transaction = t || null;
    }

    let refundTransaction = null;
    if (raw.refund_transaction_id) {
        const { data: t } = await supabaseAdmin
            .from('transactions')
            .select('id, ref, reference, type, status, currency, amount, description, created_at, completed_at')
            .eq('id', raw.refund_transaction_id)
            .maybeSingle();
        refundTransaction = t || null;
    }

    let ledgerEntries = [];
    if (raw.ledger_transaction_id) {
        try {
            const { data: le } = await supabaseAdmin
                .from('ledger_entries')
                .select('id, transaction_id, account_id, entry_type, amount_minor, currency, balance_before, balance_after, description, created_at')
                .eq('transaction_id', raw.ledger_transaction_id)
                .order('created_at', { ascending: true });
            ledgerEntries = le || [];
        } catch { /* optional */ }
    }

    const [events, providerLogs, adminActions] = await Promise.all([
        getOrderEvents(id),
        getProviderLogs(id),
        getAdminActions(id)
    ]);

    return {
        order: shapeOrder(raw, user, { includeSensitive: revealSensitive }),
        user,
        transaction,
        refund_transaction: refundTransaction,
        ledger_entries: ledgerEntries,
        events,
        provider_logs: providerLogs,
        admin_actions: adminActions,
        timeline: buildTimeline(raw, events)
    };
}

function buildTimeline(raw, events) {
    const list = [];
    if (raw.created_at)      list.push({ at: raw.created_at,      kind: 'order_created',    label: 'Order created' });
    if (raw.activated_at)    list.push({ at: raw.activated_at,    kind: 'number_activated', label: `Number assigned${raw.phone_number ? ': ' + maskPhone(raw.phone_number) : ''}` });
    if (raw.sms_received_at) list.push({ at: raw.sms_received_at, kind: 'sms_received',     label: 'SMS received' });
    if (raw.completed_at)    list.push({ at: raw.completed_at,    kind: 'completed',        label: 'Order completed' });
    if (raw.cancelled_at)    list.push({ at: raw.cancelled_at,    kind: 'cancelled',        label: 'Order cancelled' });
    if (raw.refunded_at)     list.push({ at: raw.refunded_at,     kind: 'refunded',         label: 'Order refunded' });
    if (raw.expired_at)      list.push({ at: raw.expired_at,      kind: 'expired',          label: 'Order expired' });

    for (const e of events || []) {
        list.push({
            at: e.created_at,
            kind: e.event_type || 'event',
            label: e.message || e.event_type,
            old_status: e.old_status,
            new_status: e.new_status
        });
    }

    list.sort((a, b) => new Date(a.at) - new Date(b.at));
    return list;
}

async function getOrderEvents(id) {
    if (!UUID_RE.test(String(id || ''))) return [];
    try {
        const { data, error } = await supabaseAdmin
            .from('virtual_sms_order_events')
            .select('id, event_type, old_status, new_status, message, provider_response, metadata, created_at')
            .eq('order_id', id)
            .order('created_at', { ascending: true });
        if (error) { if (error.code === '42P01') return []; return []; }
        return data || [];
    } catch { return []; }
}

async function getProviderLogs(id) {
    if (!UUID_RE.test(String(id || ''))) return [];
    try {
        const { data, error } = await supabaseAdmin
            .from('virtual_sms_provider_logs')
            .select('id, action, endpoint_name, response_status, success, error_code, error_message, duration_ms, created_at')
            .eq('order_id', id)
            .order('created_at', { ascending: true });
        if (error) { if (error.code === '42P01') return []; return []; }
        return data || [];
    } catch { return []; }
}

async function getAdminActions(id) {
    if (!UUID_RE.test(String(id || ''))) return [];
    try {
        const { data, error } = await supabaseAdmin
            .from('virtual_sms_admin_actions')
            .select('id, admin_id, action, old_status, new_status, reason, metadata, created_at')
            .eq('order_id', id)
            .order('created_at', { ascending: true });
        if (error) { if (error.code === '42P01') return []; return []; }
        return data || [];
    } catch { return []; }
}

// ─── SYNC ────────────────────────────────────────────────────────────────
async function syncOrder({ orderId, ctx }) {
    const order = await loadVsmsById(orderId);

    // No activation → nothing to sync with the provider. Ask the worker
    // to resolve the order's ambiguity (if it's processing).
    if (!order.activation_id) {
        if (order.status === 'processing') {
            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    next_check_at: new Date(Date.now() + 1000).toISOString(),
                    needs_attention: true,
                    attention_reason: 'Admin triggered sync; no activation id',
                    updated_at: new Date().toISOString()
                })
                .eq('id', order.id);
            await recordAdminAction({
                ctx, orderId: order.id,
                action: 'sync_no_activation',
                oldStatus: order.status, newStatus: order.status,
                reason: 'Admin sync — no activation id; nudged worker'
            });
            return { synced: true, resolved: 'processing' };
        }
        return { synced: true, resolved: 'no_activation', status: order.status };
    }

    // Query provider.
    const result = await provider.getStatus({
        activationId: order.activation_id,
        orderId: order.id
    });

    await recordAdminAction({
        ctx, orderId: order.id,
        action: 'sync',
        oldStatus: order.status, newStatus: order.status,
        reason: `Provider returned: ${result.kind}`,
        metadata: { provider_kind: result.kind }
    });

    // Code received → store + complete.
    if (result.kind === 'STATUS_OK' && result.smsCode) {
        const stored = await orderService.storeSmsAndComplete({
            orderId: order.id,
            smsCode: result.smsCode,
            smsText: result.smsText || null,
            providerRaw: result.raw || null
        });
        return { synced: true, resolved: stored.completed ? 'completed' : 'sms_received' };
    }

    // Provider cancelled → refund.
    if (result.kind === 'STATUS_CANCEL') {
        const refund = await orderService.refundOrderSafely({
            orderId: order.id,
            reason:  'Provider reported cancellation (admin sync)',
            actor:   { type: 'admin', adminId: ctx.adminId, adminEmail: ctx.adminEmail }
        });
        return { synced: true, resolved: 'refunded', refund: refund.refund };
    }

    // Waiting / unknown → record the check, no state change.
    await recordAdminAction({
        ctx, orderId: order.id,
        action: 'sync_checked',
        oldStatus: order.status, newStatus: order.status,
        reason: 'Admin sync — provider still waiting'
    });
    return { synced: true, resolved: result.kind || 'unknown' };
}

// ─── CANCEL + REFUND ─────────────────────────────────────────────────────
async function cancelOrder({ orderId, ctx, reason, confirmCodeWasReceived }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED';
        throw e;
    }
    const result = await orderService.cancelByAdmin({
        orderId,
        ctx: { ...ctx, confirmCodeWasReceived: !!confirmCodeWasReceived },
        reason
    });
    return {
        cancelled:   true,
        order:       result.order,
        refund:      result.refund,
        already:     !!result.already
    };
}

// ─── RELEASE ─────────────────────────────────────────────────────────────
async function releaseNumber({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED';
        throw e;
    }
    const order = await loadVsmsById(orderId);
    if (!order.activation_id) {
        const e = new Error('Order has no number to release.');
        e.status = 422; e.code = 'NO_ACTIVATION'; throw e;
    }

    let result;
    try {
        result = await provider.setStatus({
            activationId: order.activation_id,
            status: 8,
            orderId: order.id
        });
    } catch (err) {
        const e = new Error('Provider release failed.');
        e.status = 502; e.code = 'PROVIDER_RELEASE_FAILED'; throw e;
    }

    // Record event + audit. Do NOT change the order's status.
    await orderService.recordEvent({
        orderId: order.id,
        eventType: 'number_released',
        oldStatus: order.status,
        newStatus: order.status,
        message: 'Number released by admin',
        providerResponse: result.raw
    });
    await recordAdminAudit({
        ctx, action: 'virtual_sms.release_number',
        targetId: order.id, before: null,
        after: { activation_id: order.activation_id }, reason
    });
    await recordAdminAction({
        ctx, orderId: order.id, action: 'release_number',
        oldStatus: order.status, newStatus: order.status, reason
    });

    return { released: true, provider: result.kind };
}

// ─── RETRY (resend SMS) ──────────────────────────────────────────────────
async function retryOrder({ orderId, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED';
        throw e;
    }
    const order = await loadVsmsById(orderId);
    if (!order.activation_id) {
        const e = new Error('Order has no activation to retry.');
        e.status = 422; e.code = 'NO_ACTIVATION'; throw e;
    }
    if (order.sms_code) {
        const e = new Error('SMS has already been received; resend is not available.');
        e.status = 409; e.code = 'SMS_ALREADY_RECEIVED'; throw e;
    }

    let result;
    try {
        result = await provider.setStatus({
            activationId: order.activation_id,
            status: 3,
            orderId: order.id
        });
    } catch (err) {
        const e = new Error('Provider resend failed.');
        e.status = 502; e.code = 'PROVIDER_RETRY_FAILED'; throw e;
    }

    await orderService.recordEvent({
        orderId: order.id,
        eventType: 'sms_retry',
        oldStatus: order.status,
        newStatus: order.status,
        message: 'SMS resend requested by admin',
        providerResponse: result.raw
    });
    await recordAdminAudit({
        ctx, action: 'virtual_sms.retry',
        targetId: order.id, before: null, after: null, reason
    });
    await recordAdminAction({
        ctx, orderId: order.id, action: 'retry',
        oldStatus: order.status, newStatus: order.status, reason
    });

    return { retried: true, provider: result.kind };
}

// ─── REFUND (without provider cancel) ────────────────────────────────────
async function refundOrder({ orderId, ctx, reason, confirmCodeWasReceived }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED';
        throw e;
    }
    const order = await loadVsmsById(orderId);

    if (order.status === 'refunded') {
        return {
            already: true,
            order,
            refund: { already_refunded: true, transaction_id: order.refund_transaction_id }
        };
    }
    if (order.sms_code && !confirmCodeWasReceived) {
        const e = new Error('A code has already been delivered. Send confirmCodeWasReceived: true to override.');
        e.status = 409; e.code = 'SMS_CODE_DELIVERED'; throw e;
    }
    if (!['failed','cancelled','expired','manual_review'].includes(order.status)
        && !confirmCodeWasReceived) {
        const e = new Error('Only failed, cancelled, expired, or manual-review orders can be refunded without an override.');
        e.status = 422; e.code = 'NOT_REFUNDABLE'; throw e;
    }

    const result = await orderService.refundOrderSafely({
        orderId,
        reason,
        actor: { type: 'admin', adminId: ctx.adminId, adminEmail: ctx.adminEmail }
    });

    // Admin-specific audit.
    await recordAdminAction({
        ctx, orderId,
        action: 'refund',
        oldStatus: order.status,
        newStatus: result.order?.status || 'refunded',
        reason,
        metadata: { transaction_id: result.refund?.transaction_id, already: result.refund?.already_refunded }
    });

    return {
        order:  result.order,
        refund: result.refund,
        already: !!result.refund?.already_refunded
    };
}

// ─── MANUAL STATUS CHANGE ────────────────────────────────────────────────
async function changeStatus({ orderId, nextStatus, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED';
        throw e;
    }
    const order = await loadVsmsById(orderId);
    const current = String(order.status || '').toLowerCase();
    const next    = String(nextStatus || '').toLowerCase();

    if (current === next) return { order: shapeOrder(order, null), no_op: true };

    const updated = await orderService.transition({
        orderId,
        fromStatus: current,
        toStatus:   next,
        eventType:  'admin_status_change',
        reason,
        ctx
    });

    return { order: shapeOrder(updated, null) };
}

// ─── REVEAL (sensitive — always audited) ─────────────────────────────────
async function revealSensitive({ orderId, ctx, revealFullNumber = false }) {
    const order = await loadVsmsById(orderId);

    const payload = {
        sms_code:         order.sms_code || null,
        sms_message:      order.sms_message || null,
        sms_sender:       order.sms_sender || null,
        provider_response: order.provider_response || null
    };
    if (revealFullNumber) {
        payload.phone_number = order.phone_number || null;
    } else {
        payload.phone_masked = maskPhone(order.phone_number);
    }

    await recordAdminAudit({
        ctx,
        action: revealFullNumber ? 'virtual_sms.reveal_full_number' : 'virtual_sms.reveal_code',
        targetId: orderId,
        before: null,
        after: {
            revealed: revealFullNumber ? 'phone_number' : 'sms_code',
            has_sms_code: !!order.sms_code
        },
        reason: revealFullNumber ? 'Reveal full number' : 'Reveal SMS code'
    });

    return payload;
}

// ─── PROVIDER HEALTH ─────────────────────────────────────────────────────
async function getProviderHealth() {
    const configured = Boolean(process.env.VSMS_API_KEY);
    const started = Date.now();
    let reachable = false, latencyMs = null, lastError = null;

    try {
        const r = await provider.getBalance();
        reachable = r.kind !== 'UNKNOWN' || r.balance != null;
        latencyMs = Date.now() - started;
    } catch (e) {
        lastError = e.message;
        latencyMs = Date.now() - started;
    }

    let state = null;
    try {
        const { data } = await supabaseAdmin
            .from('vsms_provider_state')
            .select('balance_usd, balance_checked_at, breaker_state, breaker_reason, breaker_opened_at, updated_at')
            .eq('provider', 'virtualsms')
            .maybeSingle();
        state = data;
    } catch { /* optional */ }

    return {
        provider:    'virtualsms',
        label:       'VirtualSMS',
        configured,
        reachable,
        latencyMs,
        lastError,
        balance:     state?.balance_usd      != null ? Number(state.balance_usd) : null,
        balance_checked_at: state?.balance_checked_at || null,
        breaker: {
            state:     state?.breaker_state     || 'CLOSED',
            reason:    state?.breaker_reason    || null,
            opened_at: state?.breaker_opened_at || null
        },
        status: !configured ? 'not_configured'
              : !reachable  ? 'unreachable'
              : (state?.breaker_state === 'OPEN') ? 'degraded'
              : 'operational'
    };
}

async function healthCheckProvider({ ctx }) {
    const started = Date.now();
    let reachable = false, error = null;
    try {
        const r = await provider.getBalance();
        reachable = r.kind === 'BALANCE' || r.kind === 'UNKNOWN';
    } catch (e) {
        error = e.message;
    }
    const result = {
        configured: Boolean(process.env.VSMS_API_KEY),
        reachable,
        latencyMs: Date.now() - started,
        lastError: error
    };
    await recordAdminAudit({
        ctx, action: 'virtual_sms.health_check',
        targetId: 'virtualsms', before: null, after: result, reason: null
    });
    return result;
}

// ─── CATALOGUE ───────────────────────────────────────────────────────────
async function getCatalogueCountries({ limit = 200, offset = 0 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    const { data, error, count } = await supabaseAdmin
        .from('virtual_sms_countries')
        .select('id, name, custom_name, flag, enabled, sort_order, block_reason:block_reason', { count: 'exact' })
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true })
        .range(off, off + lim - 1);
    if (error) {
        const e = new Error('Failed to load countries');
        e.status = 500; e.code = 'CATALOGUE_ERROR'; throw e;
    }
    return {
        countries: (data || []).map(c => ({
            id: c.id,
            name: c.name,
            custom_name: c.custom_name || null,
            display_name: c.custom_name || c.name,
            flag: c.flag,
            enabled: c.enabled,
            sort_order: c.sort_order
        })),
        count: count || 0,
        limit: lim,
        offset: off
    };
}

async function updateCatalogueCountry({ id, patch, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const allowed = ['enabled', 'sort_order', 'custom_name', 'flag'];
    const update = {};
    for (const k of allowed) if (patch && k in patch) update[k] = patch[k];
    if (!Object.keys(update).length) {
        const e = new Error('No valid fields to update.'); e.status = 422; e.code = 'INVALID_PATCH'; throw e;
    }
    update.updated_at = new Date().toISOString();
    const { data, error } = await supabaseAdmin
        .from('virtual_sms_countries')
        .update(update)
        .eq('id', Number(id))
        .select('*')
        .maybeSingle();
    if (error) {
        const e = new Error('Failed to update country'); e.status = 500; e.code = 'CATALOGUE_UPDATE_FAILED'; throw e;
    }
    await recordAdminAudit({
        ctx, action: 'virtual_sms.catalogue_country_update',
        targetId: String(id), before: null, after: update, reason
    });
    await recordAdminAction({
        ctx, orderId: null, action: 'catalogue_country_update',
        oldStatus: null, newStatus: null, reason,
        metadata: { country_id: id, update }
    });
    return data;
}

async function getCatalogueServices({ countryId = null, limit = 200, offset = 0 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    let q = supabaseAdmin
        .from('virtual_sms_services')
        .select('id, country_id, service_code, service_name, custom_name, provider_cost_usd, available_count, enabled, price_override_ngn, last_synced_at, missing_syncs', { count: 'exact' })
        .order('service_name', { ascending: true })
        .range(off, off + lim - 1);
    if (countryId) q = q.eq('country_id', Number(countryId));
    const { data, error, count } = await q;
    if (error) {
        const e = new Error('Failed to load services'); e.status = 500; e.code = 'CATALOGUE_ERROR'; throw e;
    }
    return {
        services: (data || []).map(s => ({
            id: s.id,
            country_id: s.country_id,
            service_code: s.service_code,
            service_name: s.custom_name || s.service_name || s.service_code,
            custom_name: s.custom_name || null,
            provider_cost_usd: Number(s.provider_cost_usd) || 0,
            available_count: s.available_count,
            enabled: s.enabled,
            price_override_ngn: s.price_override_ngn != null ? Number(s.price_override_ngn) : null,
            last_synced_at: s.last_synced_at,
            missing_syncs: s.missing_syncs || 0
        })),
        count: count || 0, limit: lim, offset: off
    };
}

async function updateCatalogueService({ id, patch, ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    const allowed = ['enabled', 'custom_name', 'price_override_ngn'];
    const update = {};
    for (const k of allowed) if (patch && k in patch) update[k] = patch[k];
    if (!Object.keys(update).length) {
        const e = new Error('No valid fields to update.'); e.status = 422; e.code = 'INVALID_PATCH'; throw e;
    }
    update.updated_at = new Date().toISOString();
    const { data, error } = await supabaseAdmin
        .from('virtual_sms_services')
        .update(update)
        .eq('id', id)
        .select('*')
        .maybeSingle();
    if (error) {
        const e = new Error('Failed to update service'); e.status = 500; e.code = 'CATALOGUE_UPDATE_FAILED'; throw e;
    }
    await recordAdminAudit({
        ctx, action: 'virtual_sms.catalogue_service_update',
        targetId: String(id), before: null, after: update, reason
    });
    return data;
}

async function syncCatalogueNow({ ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    // Nudge the worker: reset last catalogue sync time.
    await supabaseAdmin
        .from('vsms_provider_state')
        .update({ updated_at: new Date(Date.now() - 20 * 60_000).toISOString() })
        .eq('provider', 'virtualsms');
    await recordAdminAudit({
        ctx, action: 'virtual_sms.catalogue_sync_requested',
        targetId: 'catalogue', before: null, after: null, reason
    });
    return { requested: true };
}

// ─── PROVIDER LOGS ───────────────────────────────────────────────────────
async function getProviderLogsRecent({ limit = 100 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const { data, error } = await supabaseAdmin
        .from('virtual_sms_provider_logs')
        .select('id, order_id, action, endpoint_name, response_status, success, error_code, error_message, duration_ms, created_at')
        .order('created_at', { ascending: false })
        .limit(lim);
    if (error) {
        const e = new Error('Failed to load provider logs'); e.status = 500; e.code = 'PROVIDER_LOGS_ERROR'; throw e;
    }
    return { logs: data || [] };
}

async function resetBreaker({ ctx, reason }) {
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }
    try {
        const { reset } = require('./providers/circuitBreaker');
        reset('virtualsms');
    } catch { /* breaker not importable */ }
    await supabaseAdmin
        .from('vsms_provider_state')
        .update({
            breaker_state: 'CLOSED',
            breaker_reason: null,
            breaker_reset_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('provider', 'virtualsms');
    await recordAdminAudit({
        ctx, action: 'virtual_sms.breaker_reset',
        targetId: 'virtualsms', before: null, after: { state: 'CLOSED' }, reason
    });
    return { reset: true };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────
module.exports = {
    // Stats
    getStats,
    getAttentionQueue,

    // List / detail
    listOrders,
    getOrder,

    // Actions
    syncOrder,
    cancelOrder,
    releaseNumber,
    retryOrder,
    refundOrder,
    changeStatus,
    revealSensitive,

    // Provider
    getProviderHealth,
    healthCheckProvider,
    getProviderLogsRecent,
    resetBreaker,

    // Catalogue
    getCatalogueCountries,
    updateCatalogueCountry,
    getCatalogueServices,
    updateCatalogueService,
    syncCatalogueNow,

    // Shape util (used by routes)
    maskPhone,
    maskEmail
};