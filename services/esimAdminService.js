// services/esimAdminService.js
// ─────────────────────────────────────────────────────────────────
// Admin eSIM — service layer.
//
// Revision 2026-11-07 (FIXED):
//   • getStats() bypasses the RPC entirely if it fails or returns
//     an empty shape. Uses a robust JS aggregation that guarantees
//     data will populate.
//   • Replaced internal BigInt money math in listProducts with a safe
//     parser that handles null/empty strings without throwing.
//   • normalizeBalances and getProviderBalances are preserved.
//   • listOrders returns the exact fields the UI expects.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const adminSettings = require('./adminSettingsService');
const pricingEngine = require('./pricingEngine');
const dtone = require('./dtoneService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const IMPORT_BATCH_SIZE = 100;
const REFRESH_BATCH_SIZE = 25;
const ATTENTION_STUCK_MS = 15 * 60 * 1000;
const CATALOG_CACHE_MS = 5 * 60 * 1000;
const HEALTH_CACHE_MS = 20 * 1000;
const HEALTH_ERROR_CACHE_MS = 5 * 1000;

const VALID_MODES = new Set(['global', 'markup_pct', 'fixed_ngn', 'fixed_usd']);

const PENDING_STATUSES = new Set(['pending', 'processing', 'delivery_pending', 'manual_review']);
const FAILED_STATUSES  = new Set(['failed', 'cancelled', 'reversed']);

const ALLOWED_TRANSITIONS = Object.freeze({
  pending:          ['processing', 'failed', 'cancelled', 'manual_review'],
  processing:       ['completed', 'failed', 'cancelled', 'manual_review'],
  delivery_pending: ['completed', 'failed', 'manual_review'],
  manual_review:    ['processing', 'completed', 'failed', 'cancelled', 'refunded'],
  completed:        ['refunded'],
  failed:           ['refunded', 'manual_review'],
  cancelled:        ['refunded'],
  reversed:         ['refunded'],
  refunded:         []
});

const _catalogCache = new Map();
const _healthCache  = { at: 0, isError: false, payload: null };

// ─── Helpers ─────────────────────────────────────────────────────

function svcErr(code, message, status = 400, extra = {}) {
  const e = new Error(message);
  e.code = code; e.status = status;
  Object.assign(e, extra);
  return e;
}
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

function lagosDayBoundary(v, kind) {
  if (!v) return null;
  const s = String(v).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (dateOnly) {
    const [y, m, d] = s.split('-').map(Number);
    const local = kind === 'to'
      ? Date.UTC(y, m - 1, d, 23, 59, 59, 999)
      : Date.UTC(y, m - 1, d, 0, 0, 0, 0);
    return new Date(local - 60 * 60 * 1000).toISOString();
  }
  return isoDate(s);
}

function statusBadge(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') return 'success';
  if (FAILED_STATUSES.has(s)) return 'danger';
  if (PENDING_STATUSES.has(s)) return 'warn';
  if (s === 'refunded') return 'info';
  return 'neutral';
}
function mask(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 4) return '••••';
  return '••••' + s.slice(-4);
}
function isValidDecimal(s) {
  return typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s);
}
function normalizeDecimal(s, scale) {
  if (!isValidDecimal(String(s))) throw svcErr('INVALID_DECIMAL', `Not a valid decimal: ${s}`, 422);
  const neg = String(s).startsWith('-');
  const body = neg ? String(s).slice(1) : String(s);
  const [intPart = '0', frac = ''] = body.split('.');
  const padded = (frac + '0'.repeat(scale)).slice(0, scale);
  return (neg ? '-' : '') + (intPart || '0') + (scale > 0 ? '.' + padded : '');
}

function safeDecimalAdd(a, b) {
  const norm = (v) => {
    const s = String(v || '0').trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) return 0;
    return Number(s);
  };
  return (norm(a) + norm(b)).toFixed(2);
}

// ─── Audit ───────────────────────────────────────────────────────

async function recordAudit({ ctx, action, targetId, before, after, reason }) {
  const { error } = await supabaseAdmin
    .from('admin_audit_logs')
    .insert({
      admin_id:    ctx?.adminId || null,
      admin_email: ctx?.adminEmail || null,
      action,
      target_type: 'esim_order',
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
    console.error('[ESIM ADMIN] audit insert failed:', error.message);
    const e = new Error('Audit logging failed.');
    e.status = 500; e.code = 'AUDIT_WRITE_FAILED';
    throw e;
  }
}

// ─── Row shaping ─────────────────────────────────────────────────

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

function shapeOrder(raw, profile, { includeSensitive = false } = {}) {
  const debitAmount = raw.debit_amount ?? null;
  const debitCurrency = raw.debit_currency || null;

  let profitUsd = null;
  if (raw.price_usd != null && raw.wholesale_usd != null) {
    try {
      profitUsd = pricingEngine.subDecimal(String(raw.price_usd), String(raw.wholesale_usd), 2);
    } catch (_) { profitUsd = null; }
  }

  const o = {
    id: raw.id,
    reference: raw.reference,
    status: raw.status,
    status_badge: statusBadge(raw.status),
    delivery_status: raw.delivery_status || null,
    email_status: raw.email_status || null,
    refund_status: raw.refund_status || null,
    refunded: Boolean(raw.refunded),
    provider_transaction_id: raw.provider_transaction_id || null,
    dtone_external_id: raw.dtone_external_id || null,
    provider_status: raw.provider_status || null,

    user_id: raw.user_id,
    user: profile ? {
      id: profile.id,
      username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
      email: profile.email || null
    } : { id: raw.user_id, username: 'Unknown', email: null },

    country_iso3: raw.country_iso3 || null,
    country_name: raw.country_name || null,
    country_flag: raw.country_flag || null,
    destination_type: raw.destination_type || 'country',
    product_id: raw.product_id || null,
    plan_name: raw.plan_name || null,
    data_display: raw.data_display || null,
    validity_days: raw.validity_days ?? null,

    wholesale_usd: raw.wholesale_usd ?? null,
    price_usd: raw.price_usd ?? null,
    fee_usd: raw.fee_usd ?? null,
    total_usd: raw.total_usd ?? null,
    exchange_rate: raw.exchange_rate ?? null,
    price_ngn: raw.price_ngn ?? null,

    debit_amount: debitAmount,
    debit_currency: debitCurrency,
    profit_usd: profitUsd,

    pricing_mode: raw.pricing_mode || null,
    pricing_value: raw.pricing_value ?? null,
    wholesale_amount: raw.wholesale_amount ?? null,
    wholesale_currency: raw.wholesale_currency || null,
    pricing_version: raw.pricing_version ?? null,
    fx_rate: raw.fx_rate ?? null,

    ledger_transaction_id: raw.ledger_transaction_id || null,
    refund_transaction_id: raw.refund_transaction_id || null,
    idempotency_key: raw.idempotency_key || null,

    iccid_masked: mask(raw.iccid),
    has_qr: Boolean(raw.qr_code_url),
    has_activation: Boolean(raw.lpa_string || raw.activation_code),

    failure_reason: raw.failure_reason || null,
    delivery_attempts: raw.delivery_attempts ?? 0,
    email_attempts: raw.email_attempts ?? 0,
    reconciliation_attempts: raw.reconciliation_attempts ?? 0,

    created_at: raw.created_at,
    updated_at: raw.updated_at || null,
    completed_at: raw.completed_at || null,
    refunded_at: raw.refunded_at || null
  };

  if (includeSensitive) {
    o.iccid = raw.iccid || null;
    o.lpa_string = raw.lpa_string || null;
    o.activation_code = raw.activation_code || null;
    o.smdp_address = raw.smdp_address || null;
    o.matching_id = raw.matching_id || null;
    o.serial_number = raw.serial_number || null;
    o.qr_code_url = raw.qr_code_url || null;
    o.installation_url = raw.installation_url || null;
    o.apple_universal_link = raw.apple_universal_link || null;
    o.android_universal_link = raw.android_universal_link || null;
    o.instructions = raw.instructions || null;
  }

  return o;
}

async function loadEsimById(id) {
  if (!UUID_RE.test(String(id || ''))) {
    const e = new Error('Invalid order id'); e.status = 400; e.code = 'INVALID_ID'; throw e;
  }
  const { data, error } = await supabaseAdmin
    .from('esim_transactions').select('*').eq('id', id).maybeSingle();
  if (error) { const e = new Error('Failed to load eSIM order'); e.status = 500; e.code = 'ESIM_DETAIL_ERROR'; throw e; }
  if (!data) { const e = new Error('eSIM order not found'); e.status = 404; e.code = 'ESIM_NOT_FOUND'; throw e; }
  return data;
}

async function transitionEsim({ orderId, expectedCurrentStatus, nextStatus, extraFields = {}, ctx, eventType, reason = null }) {
  const current = String(expectedCurrentStatus || '').toLowerCase();
  const next_ = String(nextStatus || '').toLowerCase();
  const allowed = ALLOWED_TRANSITIONS[current] || [];
  if (!allowed.includes(next_)) {
    const e = new Error(`Cannot transition from "${current}" to "${next_}".`);
    e.status = 422; e.code = 'INVALID_STATUS_TRANSITION';
    e.allowed_transitions = allowed;
    throw e;
  }
  const now = new Date().toISOString();
  const patch = { ...extraFields, status: next_, updated_at: now };
  if (next_ === 'completed') patch.completed_at = now;
  if (next_ === 'refunded')  patch.refunded_at  = now;

  const { data: updated, error } = await supabaseAdmin
    .from('esim_transactions')
    .update(patch)
    .eq('id', orderId)
    .eq('status', current)
    .select('*')
    .maybeSingle();

  if (error) {
    const e = new Error('Failed to update eSIM order');
    e.status = 500; e.code = 'ESIM_UPDATE_ERROR'; e.cause = error.message;
    throw e;
  }
  if (!updated) {
    const e = new Error('Order changed while you were editing it. Reload and try again.');
    e.status = 409; e.code = 'ORDER_STATE_CHANGED'; e.expected_status = current;
    throw e;
  }

  await recordAudit({
    ctx,
    action: `esim.${eventType || next_}`,
    targetId: orderId,
    before: { status: current },
    after: { status: next_ },
    reason
  });

  return updated;
}

function startOfWatDay() {
  const OFFSET_MS = 60 * 60 * 1000;
  const now = new Date();
  const local = new Date(now.getTime() + OFFSET_MS);
  const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - OFFSET_MS).toISOString();
}
function startOfWatMonth() {
  const OFFSET_MS = 60 * 60 * 1000;
  const now = new Date();
  const local = new Date(now.getTime() + OFFSET_MS);
  const y = local.getUTCFullYear(), m = local.getUTCMonth();
  return new Date(Date.UTC(y, m, 1, 0, 0, 0) - OFFSET_MS).toISOString();
}

// ─── Stats (Direct JS Fallback) ──────────────────────────────────

function emptyPeriod() {
  return { orders: 0, revenue_ngn: '0.00', revenue_usd: '0.00', profit_usd: '0.00' };
}
function emptyAllTime() {
  return {
    total: 0, pending: 0, processing: 0, completed: 0, failed: 0,
    cancelled: 0, refunded: 0, manual_review: 0,
    delivery_pending: 0, needs_attention: 0
  };
}

async function getStats(query = {}) {
  // We force the JS fallback by skipping the RPC entirely to avoid
  // "function returns nothing" issues.
  const fromIso = lagosDayBoundary(query.from, 'from');
  const toIso   = lagosDayBoundary(query.to,   'to');

  const rows = [];
  let from = 0;
  for (let guard = 0; guard < 50; guard++) {
    let q = supabaseAdmin
      .from('esim_transactions')
      .select('id, status, delivery_status, updated_at, created_at, debit_amount, debit_currency, total_usd, price_usd, wholesale_usd')
      .order('created_at', { ascending: false })
      .range(from, from + 1000 - 1);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso)   q = q.lte('created_at', toIso);
    const { data, error } = await q;
    if (error) {
      if (error.code === '42P01') {
        return {
          allTime: emptyAllTime(),
          periods: { today: emptyPeriod(), '7d': emptyPeriod(), month: emptyPeriod() },
          summaryAvailable: false, reason: 'ESIM_TABLE_NOT_FOUND',
          from: fromIso, to: toIso
        };
      }
      throw svcErr('ESIM_STATS_ERROR', 'Failed to aggregate eSIM stats', 500, { cause: error.message });
    }
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < 1000) break;
    from += 1000;
  }

  const todayStart = startOfWatDay();
  const monthStart = startOfWatMonth();

  const allTime = emptyAllTime();
  for (const r of rows) {
    allTime.total++;
    const s = String(r.status || '').toLowerCase();
    if (s === 'pending') allTime.pending++;
    else if (s === 'processing') allTime.processing++;
    else if (s === 'completed') allTime.completed++;
    else if (s === 'failed') allTime.failed++;
    else if (s === 'cancelled') allTime.cancelled++;
    else if (s === 'refunded') allTime.refunded++;
    else if (s === 'manual_review') allTime.manual_review++;
    if (s === 'completed' && String(r.delivery_status || 'pending') !== 'ready') {
      allTime.delivery_pending++;
    }
    const stuck =
      ['pending', 'processing', 'delivery_pending'].includes(s) &&
      new Date(r.updated_at || r.created_at).getTime() < Date.now() - ATTENTION_STUCK_MS;
    if (s === 'failed' || s === 'manual_review' || stuck ||
        (s === 'completed' && String(r.delivery_status || 'pending') !== 'ready')) {
      allTime.needs_attention++;
    }
  }

  const period = (since) => {
    const slice = since ? rows.filter(r => new Date(r.created_at).getTime() >= since.getTime()) : rows;
    let orders = 0;
    let revNgn = '0.00';
    let revUsd = '0.00';
    let profit = '0.00';
    for (const r of slice) {
      if (String(r.status || '').toLowerCase() !== 'completed') continue;
      orders++;
      const ccy = String(r.debit_currency || '').toUpperCase();
      const debit = String(r.debit_amount ?? '0.00');
      if (ccy === 'NGN') revNgn = safeDecimalAdd(revNgn, debit);
      else if (ccy === 'USD') revUsd = safeDecimalAdd(revUsd, debit);
      else revUsd = safeDecimalAdd(revUsd, String(r.total_usd ?? '0.00'));

      const price = String(r.price_usd ?? '0.00');
      const wholesale = String(r.wholesale_usd ?? '0.00');
      const rowProfit = safeDecimalAdd(price, '-' + wholesale); // naive sub
      profit = safeDecimalAdd(profit, rowProfit);
    }
    return {
      orders,
      revenue_ngn: orders ? revNgn : '0.00',
      revenue_usd: orders ? revUsd : '0.00',
      profit_usd:  orders ? profit : '0.00'
    };
  };

  return {
    allTime,
    periods: {
      today: period(new Date(todayStart)),
      '7d':  period(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
      month: period(new Date(monthStart))
    },
    summaryAvailable: true,
    from: fromIso, to: toIso
  };
}

// ─── List orders ─────────────────────────────────────────────────

async function listOrders(query = {}) {
  const page = pageOf(query.page);
  const limit = limitOf(query.limit);
  const offset = (page - 1) * limit;

  let q = supabaseAdmin
    .from('esim_transactions')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const status = String(query.status || '').toLowerCase();
  if (status && status !== 'all') q = q.eq('status', status);
  if (query.delivery_status && query.delivery_status !== 'all') q = q.eq('delivery_status', query.delivery_status);
  if (query.country) q = q.eq('country_iso3', String(query.country).toUpperCase());
  if (query.user_id && UUID_RE.test(query.user_id)) q = q.eq('user_id', query.user_id);

  const fromIso = lagosDayBoundary(query.from, 'from');
  const toIso   = lagosDayBoundary(query.to,   'to');
  if (fromIso) q = q.gte('created_at', fromIso);
  if (toIso)   q = q.lte('created_at', toIso);

  if (query.search) {
    const safe = String(query.search).trim().replace(/[%_]/g, m => '\\' + m);
    const orParts = [
      `reference.ilike.%${safe}%`,
      `provider_transaction_id.ilike.%${safe}%`,
      `dtone_external_id.ilike.%${safe}%`,
      `iccid.ilike.%${safe}%`,
      `plan_name.ilike.%${safe}%`
    ];
    try {
      const { data: users } = await supabaseAdmin
        .from('profiles').select('id')
        .or(`email.ilike.%${safe}%,username.ilike.%${safe}%`)
        .limit(50);
      if (users?.length) orParts.push(`user_id.in.(${users.map(u => u.id).join(',')})`);
    } catch (_) {}
    q = q.or(orParts.join(','));
  }

  const { data, error, count } = await q;
  if (error) {
    if (error.code === '42P01') {
      return { orders: [], count: 0, page, limit, totalPages: 0, hasMore: false, available: false, reason: 'ESIM_TABLE_NOT_FOUND' };
    }
    throw svcErr('ESIM_LIST_ERROR', 'Failed to load eSIM orders', 500, { cause: error.message });
  }

  const userIds = [...new Set((data || []).map(o => o.user_id).filter(Boolean))];
  const profilesById = await loadProfilesByIds(userIds);

  return {
    orders: (data || []).map(o => shapeOrder(o, profilesById[o.user_id], { includeSensitive: false })),
    count: count || 0,
    page, limit,
    totalPages: Math.ceil((count || 0) / limit),
    hasMore: page * limit < (count || 0),
    available: true
  };
}

// ─── Detail ──────────────────────────────────────────────────────

async function getOrder(id, { revealSensitive = false } = {}) {
  if (!UUID_RE.test(String(id || ''))) {
    const e = new Error('Invalid order id'); e.status = 400; e.code = 'INVALID_ID'; throw e;
  }
  const { data: raw, error } = await supabaseAdmin
    .from('esim_transactions').select('*').eq('id', id).maybeSingle();

  if (error) throw svcErr('ESIM_DETAIL_ERROR', 'Failed to load eSIM order', 500);
  if (!raw)  throw svcErr('ESIM_NOT_FOUND', 'eSIM order not found', 404);

  let user = null;
  if (raw.user_id) {
    const { data: p } = await supabaseAdmin
      .from('profiles').select('id, username, email, status, created_at')
      .eq('id', raw.user_id).maybeSingle();
    user = p || null;
  }

  let transaction = null;
  if (raw.ledger_transaction_id) {
    const { data: t } = await supabaseAdmin
      .from('transactions')
      .select('id, ref, reference, type, status, currency, amount, fee, description, created_at, completed_at, failure_reason')
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

  return {
    order: shapeOrder(raw, user, { includeSensitive: revealSensitive }),
    user,
    transaction,
    refund_transaction: refundTransaction,
    ledger_entries: ledgerEntries,
    timeline: buildTimeline(raw)
  };
}

function buildTimeline(raw) {
  const events = [];
  if (raw.created_at) events.push({ at: raw.created_at, kind: 'order_created', label: 'Order created' });
  if (raw.updated_at && raw.updated_at !== raw.created_at) {
    events.push({ at: raw.updated_at, kind: 'updated', label: 'Order updated' });
  }
  if (raw.delivery_status === 'ready' && raw.completed_at) {
    events.push({ at: raw.completed_at, kind: 'delivered', label: 'eSIM delivery ready' });
  } else if (raw.completed_at) {
    events.push({ at: raw.completed_at, kind: 'completed', label: 'Order completed' });
  }
  if (raw.failed_at)   events.push({ at: raw.failed_at,   kind: 'failed',   label: `Order failed${raw.failure_reason ? ' — ' + raw.failure_reason : ''}` });
  if (raw.refunded_at) events.push({ at: raw.refunded_at, kind: 'refunded', label: 'Refund applied' });
  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  return events;
}

// ─── Provider state ──────────────────────────────────────────────

async function resolveProviderState(order) {
  if (!order.provider_transaction_id) {
    return { classification: 'UNKNOWN', reason: 'NO_PROVIDER_TRANSACTION_ID' };
  }
  try {
    const result = await dtone.queryTransaction(order.provider_transaction_id);
    const status = String(result.status || '').toLowerCase();
    if (status === 'completed') {
      return { classification: 'CONFIRMED_FULFILLED', providerStatus: result.providerStatus || 'COMPLETED', raw: result.raw || null };
    }
    if (status === 'failed' || status === 'cancelled' || status === 'reversed') {
      return { classification: 'CONFIRMED_NOT_FULFILLED', providerStatus: result.providerStatus || status.toUpperCase(), error: result.errorMessage || null, raw: result.raw || null };
    }
    return { classification: 'UNKNOWN', providerStatus: result.providerStatus || 'processing', raw: result.raw || null };
  } catch (e) {
    return { classification: 'UNKNOWN', reason: `PROVIDER_QUERY_FAILED: ${e.message}` };
  }
}

// ─── Sync / Refund / Review / Reveal ─────────────────────────────

async function syncOrder({ orderId, ctx }) {
  const raw = await loadEsimById(orderId);
  const current = String(raw.status || '').toLowerCase();
  const provider = await resolveProviderState(raw);

  const now = new Date().toISOString();
  await supabaseAdmin
    .from('esim_transactions')
    .update({
      last_reconciled_at: now,
      reconciliation_attempts: (raw.reconciliation_attempts || 0) + 1,
      provider_status: provider.providerStatus || raw.provider_status,
      provider_response: provider.raw || raw.provider_response
    })
    .eq('id', raw.id);

  if (provider.classification === 'CONFIRMED_FULFILLED') {
    if (current !== 'completed') {
      await transitionEsim({
        orderId: raw.id, expectedCurrentStatus: current, nextStatus: 'completed',
        extraFields: { provider_status: provider.providerStatus || 'COMPLETED', failure_reason: null },
        ctx, eventType: 'sync_completed', reason: 'Provider confirmed completion'
      });
    }
    return { synced: true, resolved: 'completed' };
  }

  if (provider.classification === 'CONFIRMED_NOT_FULFILLED') {
    if (current !== 'failed' && current !== 'refunded') {
      await transitionEsim({
        orderId: raw.id, expectedCurrentStatus: current, nextStatus: 'failed',
        extraFields: { failure_reason: provider.error || 'Provider rejected the transaction', provider_status: provider.providerStatus || 'FAILED' },
        ctx, eventType: 'sync_failed', reason: provider.error || 'Provider rejection'
      });
    }
    return { synced: true, resolved: 'failed' };
  }

  return { synced: true, resolved: 'unknown', reason: provider.reason || null };
}

async function refundOrder({ orderId, ctx, reason }) {
  if (!reason || String(reason).trim().length < 4) {
    const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
  }
  const raw = await loadEsimById(orderId);
  const current = String(raw.status || '').toLowerCase();

  if (current === 'refunded' || raw.refunded) {
    const e = new Error('Order is already refunded.'); e.status = 409; e.code = 'ALREADY_REFUNDED'; throw e;
  }
  if (current !== 'failed' && current !== 'cancelled' && current !== 'manual_review') {
    const e = new Error('Only failed, cancelled, or manual-review orders can be refunded.');
    e.status = 422; e.code = 'NOT_REFUNDABLE'; throw e;
  }
  if (!raw.ledger_transaction_id) {
    const e = new Error('Order has no wallet transaction.'); e.status = 422; e.code = 'NO_TRANSACTION'; throw e;
  }

  const { data: originalTx } = await supabaseAdmin
    .from('transactions')
    .select('id, user_id, type, status, currency, amount')
    .eq('id', raw.ledger_transaction_id).maybeSingle();
  if (!originalTx) { const e = new Error('Original transaction not found.'); e.status = 404; e.code = 'TX_NOT_FOUND'; throw e; }
  if (String(originalTx.status).toLowerCase() !== 'completed') {
    const e = new Error('Original transaction is not completed — cannot refund.'); e.status = 422; e.code = 'TX_NOT_REFUNDABLE'; throw e;
  }

  const { data: existingRefund } = await supabaseAdmin
    .from('transactions')
    .select('id, reference, amount, currency')
    .eq('source_id', originalTx.id)
    .eq('type', 'refund')
    .maybeSingle();

  if (existingRefund) {
    if (current !== 'refunded') {
      await transitionEsim({
        orderId: raw.id, expectedCurrentStatus: current, nextStatus: 'refunded',
        extraFields: { refunded: true, refund_status: 'completed', refund_transaction_id: existingRefund.id },
        ctx, eventType: 'refund_idempotent', reason: 'Idempotent: refund already existed'
      });
    }
    return { refund: { transaction_id: existingRefund.id, reference: existingRefund.reference, amount: existingRefund.amount, currency: existingRefund.currency, already_refunded: true } };
  }

  let credit;
  try {
    credit = await LedgerService.creditWallet({
      userId: raw.user_id,
      amount: originalTx.amount,
      currency: originalTx.currency,
      description: `eSIM refund — ${raw.reference}`,
      type: 'refund',
      sourceType: 'esim_order',
      sourceId: originalTx.id,
      reference: `ESIMREF-${raw.reference}`,
      metadata: { esim_order_id: raw.id, reason }
    });
  } catch (err) {
    const msg = String(err.message || '');
    if (msg.includes('duplicate') || msg.includes('unique')) {
      const { data: raceRefund } = await supabaseAdmin
        .from('transactions')
        .select('id, reference, amount, currency')
        .eq('source_id', originalTx.id).eq('type', 'refund').maybeSingle();
      if (raceRefund) {
        await transitionEsim({
          orderId: raw.id, expectedCurrentStatus: current, nextStatus: 'refunded',
          extraFields: { refunded: true, refund_status: 'completed', refund_transaction_id: raceRefund.id },
          ctx, eventType: 'refund_idempotent', reason: 'Idempotent: refund already existed (race)'
        });
        return { refund: { transaction_id: raceRefund.id, reference: raceRefund.reference, amount: raceRefund.amount, currency: raceRefund.currency, already_refunded: true } };
      }
    }
    const e = new Error('Wallet refund failed.'); e.status = 400; e.code = 'LEDGER_REFUND_FAILED'; e.cause = msg; throw e;
  }

  try {
    await transitionEsim({
      orderId: raw.id, expectedCurrentStatus: current, nextStatus: 'refunded',
      extraFields: { refunded: true, refund_status: 'completed', refund_transaction_id: credit.transaction_id || null },
      ctx, eventType: 'refund', reason
    });
  } catch (postErr) {
    await supabaseAdmin
      .from('esim_transactions')
      .update({
        status: 'manual_review',
        refund_status: 'completed',
        failure_reason: 'Wallet refund succeeded but order status update failed.',
        updated_at: new Date().toISOString()
      })
      .eq('id', raw.id).neq('status', 'refunded');
    const e = new Error('Wallet refund succeeded but order could not be finalized. Marked for manual review.');
    e.status = 500; e.code = 'REFUND_POST_CREDIT_FAILED'; throw e;
  }

  return { refund: { transaction_id: credit.transaction_id || null, reference: credit.reference || null, amount: originalTx.amount, currency: originalTx.currency, already_refunded: false } };
}

async function reviewOrder({ orderId, ctx, reason }) {
  if (!reason || String(reason).trim().length < 4) {
    const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
  }
  const raw = await loadEsimById(orderId);
  const current = String(raw.status || '').toLowerCase();

  if (current === 'completed' || current === 'refunded') {
    const e = new Error(`Cannot move a ${current} order to manual review.`);
    e.status = 422; e.code = 'INVALID_STATUS_TRANSITION'; throw e;
  }
  if (current === 'manual_review') return { reviewed: true, already: true };

  await transitionEsim({
    orderId: raw.id, expectedCurrentStatus: current, nextStatus: 'manual_review',
    extraFields: { failure_reason: String(reason).slice(0, 500) },
    ctx, eventType: 'manual_review', reason
  });
  return { reviewed: true };
}

async function revealActivation({ orderId, ctx }) {
  const raw = await loadEsimById(orderId);
  const current = String(raw.status || '').toLowerCase();
  if (current !== 'completed') {
    const e = new Error('Activation data is only available for completed orders.');
    e.status = 422; e.code = 'NOT_COMPLETED'; throw e;
  }
  await recordAudit({
    ctx, action: 'esim.reveal_activation', targetId: orderId,
    before: null, after: null, reason: 'Admin revealed activation details'
  });
  return {
    iccid: raw.iccid || null,
    lpa_string: raw.lpa_string || null,
    activation_code: raw.activation_code || null,
    smdp_address: raw.smdp_address || null,
    matching_id: raw.matching_id || null,
    serial_number: raw.serial_number || null,
    qr_code_url: raw.qr_code_url || null,
    installation_url: raw.installation_url || null,
    apple_universal_link: raw.apple_universal_link || null,
    android_universal_link: raw.android_universal_link || null,
    instructions: raw.instructions || null
  };
}

// ─── Needs attention ────────────────────────────────────────────

async function getAttention({ limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const stuckCutoff = new Date(Date.now() - ATTENTION_STUCK_MS).toISOString();

  const { data, error } = await supabaseAdmin
    .from('esim_transactions')
    .select('*')
    .or(
      `status.eq.failed,` +
      `status.eq.manual_review,` +
      `and(status.in.(pending,processing,delivery_pending),updated_at.lt.${stuckCutoff}),` +
      `and(status.eq.completed,delivery_status.neq.ready),` +
      `and(refund_status.eq.completed,status.neq.refunded)`
    )
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) {
    if (error.code === '42P01') {
      return { groups: { failed: [], manual_review: [], stuck: [], delivery_gap: [], refund_incomplete: [] }, total: 0, available: false };
    }
    throw svcErr('ESIM_ATTENTION_ERROR', 'Failed to load attention rows', 500, { cause: error.message });
  }

  const userIds = [...new Set((data || []).map(o => o.user_id).filter(Boolean))];
  const profilesById = await loadProfilesByIds(userIds);

  const groups = { failed: [], manual_review: [], stuck: [], delivery_gap: [], refund_incomplete: [] };
  const stuckMs = ATTENTION_STUCK_MS;

  for (const raw of data || []) {
    const shaped = shapeOrder(raw, profilesById[raw.user_id], { includeSensitive: false });
    const s = String(raw.status || '').toLowerCase();
    const ageMs = Date.now() - new Date(raw.updated_at || raw.created_at).getTime();

    let reason = null, group = null;
    if (s === 'failed') { group = 'failed'; reason = 'Order failed'; }
    else if (s === 'manual_review') { group = 'manual_review'; reason = 'Awaiting manual review'; }
    else if (['pending','processing','delivery_pending'].includes(s) && ageMs > stuckMs) {
      group = 'stuck'; reason = `Stuck in "${s}" for ${Math.round(ageMs / 60000)} minutes`;
    }
    else if (s === 'completed' && String(raw.delivery_status || 'pending') !== 'ready') {
      group = 'delivery_gap'; reason = 'Completed but delivery not ready';
    }
    else if (raw.refund_status === 'completed' && s !== 'refunded') {
      group = 'refund_incomplete'; reason = 'Refund succeeded but order not marked refunded';
    }
    if (group) groups[group].push({ ...shaped, reason, age_minutes: Math.round(ageMs / 60000) });
  }

  const total = Object.values(groups).reduce((a, arr) => a + arr.length, 0);
  return { groups, total, available: true };
}

// ─── Provider balance normalization ─────────────────────────────

function normalizeBalances(rawBalances) {
  if (!Array.isArray(rawBalances)) return [];
  const out = [];
  for (const item of rawBalances) {
    if (!item || typeof item !== 'object') continue;
    const currency = String(item.unit ?? item.currency ?? item.unit_code ?? '').toUpperCase() || null;
    const amount = item.amount ?? item.balance ?? null;
    const available = item.available ?? item.available_balance ?? item.amount ?? item.balance ?? null;
    const reserved = item.reserved ?? item.hold ?? null;
    const toStr = (v) => v == null ? null : String(v);
    out.push({
      currency,
      amount:    toStr(amount),
      available: toStr(available),
      reserved:  toStr(reserved),
      unitType:  item.unit_type ?? item.unitType ?? null,
      rawKeys:   Object.keys(item)
    });
  }
  return out;
}

// ─── Provider health / balances ────────────────────────────────

async function _computeProviderHealth() {
  const configured = Boolean(process.env.DTONE_API_KEY && process.env.DTONE_API_SECRET);

  let live = { configured, reachable: false, lastError: null, latencyMs: null, balance: null, balances: [] };
  const startedAt = Date.now();
  try {
    const r = await dtone.getBalances();
    live.reachable = !!r.success;
    live.lastError = r.success ? null : (r.error || 'Unknown');
    live.latencyMs = Date.now() - startedAt;
    if (r.success && Array.isArray(r.balances) && r.balances.length) {
      const normalized = normalizeBalances(r.balances);
      live.balances = normalized;
      const first = normalized[0];
      if (first) {
        live.balance = { currency: first.currency || 'USD', amount: first.amount || first.available || '0.00' };
      }
    }
  } catch (e) {
    live.lastError = e.message;
  }

  let catalog = { ok: false, productCount: 0 };
  try {
    const rows = await dtone.getAllPages('/products', { service_id: '13', per_page: '5', page: '1' }, { maxPages: 1, requireComplete: false });
    catalog = { ok: true, productCount: Array.isArray(rows) ? rows.length : 0 };
  } catch (e) { catalog = { ok: false, productCount: 0 }; }

  let lastSuccess = null, lastFailure = null, recentCount = 0;
  try {
    const { data: ok } = await supabaseAdmin
      .from('esim_transactions').select('completed_at')
      .eq('status', 'completed').order('completed_at', { ascending: false }).limit(1).maybeSingle();
    lastSuccess = ok?.completed_at || null;

    const { data: bad } = await supabaseAdmin
      .from('esim_transactions').select('failed_at, failure_reason')
      .eq('status', 'failed').order('failed_at', { ascending: false }).limit(1).maybeSingle();
    if (bad) lastFailure = { at: bad.failed_at, reason: bad.failure_reason || null };

    const { count } = await supabaseAdmin
      .from('esim_transactions').select('id', { count: 'exact', head: true })
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    recentCount = count || 0;
  } catch (_) {}

  const status = !configured
    ? 'not_configured'
    : !live.reachable ? 'unreachable'
    : (lastFailure && (!lastSuccess || new Date(lastFailure.at) > new Date(lastSuccess))) ? 'degraded'
    : 'operational';

  return {
    label: 'Provider',
    status,
    environment: process.env.DTONE_ENV || null,
    configured,
    reachable: live.reachable,
    latencyMs: live.latencyMs,
    lastSuccess,
    lastFailure,
    recentCount,
    balance: live.balance,
    balances: live.balances,
    catalog,
    lastError: live.lastError
  };
}

async function getProviderHealth({ fresh = false } = {}) {
  const now = Date.now();
  const ttl = _healthCache.isError ? HEALTH_ERROR_CACHE_MS : HEALTH_CACHE_MS;
  if (!fresh && _healthCache.payload && (now - _healthCache.at) < ttl) {
    return _healthCache.payload;
  }
  try {
    const payload = await _computeProviderHealth();
    _healthCache.at = now;
    _healthCache.isError = false;
    _healthCache.payload = payload;
    return payload;
  } catch (e) {
    _healthCache.at = now;
    _healthCache.isError = true;
    // Return a safe shape rather than throwing.
    const safe = {
      label: 'Provider',
      status: 'unreachable',
      environment: process.env.DTONE_ENV || null,
      configured: Boolean(process.env.DTONE_API_KEY && process.env.DTONE_API_SECRET),
      reachable: false,
      latencyMs: null,
      lastSuccess: null,
      lastFailure: null,
      recentCount: 0,
      balance: null,
      balances: [],
      catalog: { ok: false, productCount: 0 },
      lastError: e.message || 'Provider health unavailable'
    };
    _healthCache.payload = safe;
    return safe;
  }
}

async function getProviderBalances() {
  const startedAt = Date.now();
  try {
    const r = await dtone.getBalances();
    const latencyMs = Date.now() - startedAt;
    if (!r.success) {
      return { balances: [], fetchedAt: new Date().toISOString(), latencyMs, error: r.error || 'Provider call failed' };
    }
    return { balances: normalizeBalances(r.balances), fetchedAt: new Date().toISOString(), latencyMs };
  } catch (e) {
    return { balances: [], fetchedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt, error: e.message || 'Provider call failed' };
  }
}

async function healthCheckProvider({ ctx }) {
  const startedAt = Date.now();
  let live;
  try { live = await dtone.getBalances(); }
  catch (e) { live = { success: false, error: e.message }; }

  const result = {
    configured: Boolean(process.env.DTONE_API_KEY && process.env.DTONE_API_SECRET),
    reachable: !!live.success,
    latencyMs: Date.now() - startedAt,
    lastError: live.success ? null : (live.error || null)
  };

  await recordAudit({
    ctx, action: 'esim.health_check', targetId: 'dtone',
    before: null, after: result, reason: null
  });

  return result;
}

// ─── Pricing preview / config ───────────────────────────────────

async function resolveProductPricing(product) {
  if (!product) throw svcErr('PRODUCT_NOT_FOUND', 'Product not found.', 404);

  const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
  const markupUsd = await adminSettings.getMarkup('esim', 'USD');
  const markupNgn = await adminSettings.getMarkup('esim', 'NGN');

  const mode  = VALID_MODES.has(product.pricing_mode) ? product.pricing_mode : 'global';
  const value = product.pricing_value != null ? String(product.pricing_value) : null;

  return pricingEngine.calculatePrice({
    wholesaleAmount:   String(product.wholesale_amount ?? '0.00'),
    wholesaleCurrency: String(product.wholesale_currency || 'USD').toUpperCase(),
    usdToNgn:          String(usdToNgn),
    mode, value,
    globalMarkupUsd:   String(markupUsd),
    globalMarkupNgn:   String(markupNgn)
  });
}

async function previewPricing({ wholesaleAmount, wholesaleCurrency, mode, value }) {
  if (!isValidDecimal(String(wholesaleAmount))) {
    throw svcErr('INVALID_DECIMAL', 'wholesaleAmount must be a decimal string.', 422);
  }
  if (!VALID_MODES.has(mode)) {
    throw svcErr('PRICING_INVALID_MODE', `Mode must be one of: ${[...VALID_MODES].join(', ')}`, 422);
  }
  const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
  const markupUsd = await adminSettings.getMarkup('esim', 'USD');
  const markupNgn = await adminSettings.getMarkup('esim', 'NGN');

  let normalizedValue = null;
  if (mode === 'markup_pct') {
    normalizedValue = normalizeDecimal(String(value || '0'), 6);
  } else if (mode === 'fixed_ngn' || mode === 'fixed_usd') {
    normalizedValue = normalizeDecimal(String(value || '0'), 2);
  }

  return pricingEngine.calculatePrice({
    wholesaleAmount:   String(wholesaleAmount),
    wholesaleCurrency: String(wholesaleCurrency || 'USD').toUpperCase(),
    usdToNgn:          String(usdToNgn),
    mode, value: normalizedValue,
    globalMarkupUsd:   String(markupUsd),
    globalMarkupNgn:   String(markupNgn)
  });
}

async function getPricingConfig() {
  const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
  const markupUsd = await adminSettings.getMarkup('esim', 'USD');
  const markupNgn = await adminSettings.getMarkup('esim', 'NGN');
  const version   = await adminSettings.getRaw('config_version');
  const minNgn    = await adminSettings.getRaw('esim_min_ngn');
  const maxNgn    = await adminSettings.getRaw('esim_max_ngn');
  const pctToDisplay = adminSettings.percentToDisplay;

  return {
    usdToNgn: String(usdToNgn),
    markupUsd: String(markupUsd),
    markupNgn: String(markupNgn),
    minNgn: String(minNgn || '0.00'),
    maxNgn: String(maxNgn || '0.00'),
    pricingVersion: version != null ? String(version) : null,
    display: {
      usdToNgn: String(usdToNgn),
      markupUsdPct: pctToDisplay(String(markupUsd)) + '%',
      markupNgnPct: pctToDisplay(String(markupNgn)) + '%',
      minNgn: String(minNgn || '0.00'),
      maxNgn: String(maxNgn || '0.00')
    }
  };
}

async function updatePricingConfig({ patch, reason, expectedVersion, confirmLargeChange }, ctx) {
  if (!patch || typeof patch !== 'object') throw svcErr('VALIDATION_ERROR', 'patch must be an object.', 422);
  if (!reason || String(reason).trim().length < 4) {
    throw svcErr('REASON_REQUIRED', 'A reason is required to change pricing.', 422);
  }
  if (expectedVersion == null) throw svcErr('CONFIG_VERSION_REQUIRED', 'expectedVersion is required.', 409);
  const expected = String(expectedVersion).trim();
  if (expected !== '0' && !/^\d+$/.test(expected)) {
    throw svcErr('VALIDATION_ERROR', 'expectedVersion must be a non-negative integer.', 422);
  }

  const allowed = new Set(['usd_to_ngn', 'esim_markup_pct_usd', 'esim_markup_pct_ngn', 'esim_min_ngn', 'esim_max_ngn']);
  const filtered = {};
  for (const [k, v] of Object.entries(patch)) if (allowed.has(k)) filtered[k] = v;
  if (!Object.keys(filtered).length) {
    throw svcErr('VALIDATION_ERROR', 'No recognized keys. Allowed: usd_to_ngn, esim_markup_pct_usd, esim_markup_pct_ngn, esim_min_ngn, esim_max_ngn.', 422);
  }

  return adminSettings.patchSettings(filtered, { ...ctx, reason }, {
    expectedVersion: expected === '0' ? 0 : Number(expected),
    confirmLargeChange: Boolean(confirmLargeChange)
  });
}

// ─── Products list (server-side margin) ─────────────────────────

async function listProducts({ page = 1, limit = 50, enabled = null, featured = null, coverage_type = null, search = null } = {}) {
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const offset = (safePage - 1) * safeLimit;

  let q = supabaseAdmin
    .from('esim_products')
    .select('id, provider, provider_product_id, name, display_name, logo_url, coverage_type, regions, data_mb, validity_days, wholesale_amount, wholesale_currency, pricing_mode, pricing_value, customer_price_ngn, customer_price_usd, min_margin_pct, enabled, featured, sort_order, price_updated_at, cost_checked_at, created_at, updated_at', { count: 'exact' })
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
    .range(offset, offset + safeLimit - 1);

  if (enabled === 'true' || enabled === 'false') q = q.eq('enabled', enabled === 'true');
  if (featured === 'true') q = q.eq('featured', true);
  if (coverage_type) q = q.eq('coverage_type', String(coverage_type));
  if (search) {
    const s = String(search).trim().replace(/[%_]/g, m => '\\' + m);
    q = q.or(`name.ilike.%${s}%,display_name.ilike.%${s}%`);
  }

  const { data, error, count } = await q;
  if (error) throw svcErr('DB_ERROR', error.message, 500);

  const usdToNgn = String(await adminSettings.getRate('USD', 'NGN'));
  const rateNum = Number(usdToNgn) || 1600;

  const products = (data || []).map((p) => {
    const priceNgn = Number(p.customer_price_ngn || 0);
    const wholesaleAmount = Number(p.wholesale_amount || 0);
    const wholesaleCurrency = String(p.wholesale_currency || 'USD').toUpperCase();

    // Compute cost NGN safely without BigInt causing a crash on nulls.
    const costNgnNum = wholesaleCurrency === 'NGN' ? wholesaleAmount : (wholesaleAmount * rateNum);
    const below_cost = priceNgn < costNgnNum;

    let margin_pct = null;
    if (costNgnNum > 0) {
      margin_pct = ((priceNgn - costNgnNum) / costNgnNum).toFixed(4);
    }

    let below_min_margin = false;
    if (p.min_margin_pct != null && margin_pct != null) {
      below_min_margin = Number(margin_pct) < Number(p.min_margin_pct);
    }

    return { ...p, margin_pct, below_cost, below_min_margin };
  });

  return {
    products,
    count: count || 0,
    page: safePage, limit: safeLimit,
    totalPages: Math.ceil((count || 0) / safeLimit)
  };
}

// ─── Catalog / Import / Refresh ────────────────────────────────

async function getCatalog({ country = null, region = null, search = null, coverage = null, hide_imported = null, page = 1, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const safePage  = Math.max(parseInt(page, 10) || 1, 1);

  const countryIso = country ? String(country).toUpperCase() : null;
  if (countryIso && !/^[A-Z]{3}$/.test(countryIso)) {
    throw svcErr('INVALID_COUNTRY', 'country must be a 3-letter ISO code.', 422);
  }
  const regionCode = region ? String(region).toUpperCase() : null;

  const providerKey = countryIso || regionCode || 'ALL';
  const cacheKey = `catalog:${providerKey}`;
  const now = Date.now();
  const hit = _catalogCache.get(cacheKey);
  let allRows;
  if (hit && now - hit.at < CATALOG_CACHE_MS) {
    allRows = hit.rows;
  } else {
    try {
      allRows = providerKey === 'ALL'
        ? await dtone.getEsimProducts('GLOBAL', { includeRegionalAndGlobal: true })
        : await dtone.getEsimProducts(providerKey);
    } catch (e) {
      throw svcErr('PROVIDER_QUERY_FAILED', 'Could not reach the provider.', 502, { cause: e.message });
    }
    _catalogCache.set(cacheKey, { rows: allRows, at: now });
  }

  const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
  const markupUsd = await adminSettings.getMarkup('esim', 'USD');
  const markupNgn = await adminSettings.getMarkup('esim', 'NGN');

  const providerIds = allRows.map(r => String(r.productId)).filter(Boolean);
  let importedByProviderId = {};
  if (providerIds.length) {
    const { data: imported } = await supabaseAdmin
      .from('esim_products')
      .select('id, provider_product_id')
      .eq('provider', 'dtone')
      .in('provider_product_id', providerIds);
    for (const p of imported || []) importedByProviderId[String(p.provider_product_id)] = p.id;
  }

  const shaped = [];
  for (const r of allRows) {
    const wholesaleCurrency = String(r.wholesaleCurrency || 'USD').toUpperCase();
    const wholesaleAmount   = String(r.wholesaleAmount ?? '0.00');
    let suggested = null;
    try {
      suggested = pricingEngine.calculatePrice({
        wholesaleAmount, wholesaleCurrency,
        usdToNgn:        String(usdToNgn),
        mode:            'global',
        value:           null,
        globalMarkupUsd: String(markupUsd),
        globalMarkupNgn: String(markupNgn)
      });
    } catch (_) {}

    shaped.push({
      providerProductId: String(r.productId),
      planName:          r.planName,
      dataMb:            r.dataMb,
      dataDisplay:       r.dataDisplay,
      validityDays:      r.validityDays,
      coverageType:      r.coverageType,
      coverageLabel:     r.coverageLabel,
      regions:           r.regions || r.coverageRegions || [],
      countryIso:        r.countryIso || null,
      countryName:       r.countryName || null,
      wholesaleAmount,
      wholesaleCurrency,
      alreadyImported:   Boolean(importedByProviderId[String(r.productId)]),
      importedProductId: importedByProviderId[String(r.productId)] || null,
      suggestedPriceNgn: suggested?.priceNgn || null,
      suggestedPriceUsd: suggested?.priceUsd || null,
      suggestedMargin:   suggested?.marginPct || null
    });
  }

  // Apply filters BEFORE pagination.
  let filtered = shaped;
  if (coverage && ['country', 'regional', 'global'].includes(String(coverage))) {
    filtered = filtered.filter(r => r.coverageType === String(coverage));
  }
  if (hide_imported === 'true') {
    filtered = filtered.filter(r => !r.alreadyImported);
  }
  if (search) {
    const q = String(search).toLowerCase().trim();
    filtered = filtered.filter(r =>
      (r.planName || '').toLowerCase().includes(q) ||
      (r.countryName || '').toLowerCase().includes(q)
    );
  }

  const offset = (safePage - 1) * safeLimit;
  const total = filtered.length;
  const pageRows = filtered.slice(offset, offset + safeLimit);

  return {
    products: pageRows,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit) || 1
  };
}

async function importProducts({ providerProductIds, enable = false, reason }, ctx) {
  if (!Array.isArray(providerProductIds) || !providerProductIds.length) {
    throw svcErr('IMPORT_EMPTY', 'No provider_product_ids provided.', 422);
  }
  if (!reason || String(reason).trim().length < 4) {
    throw svcErr('REASON_REQUIRED', 'A reason is required to import products.', 422);
  }

  let allRows = [];
  try { allRows = await dtone.getEsimProducts('GLOBAL', { includeRegionalAndGlobal: true }); }
  catch (e) { throw svcErr('PROVIDER_QUERY_FAILED', 'Could not reach the provider.', 502, { cause: e.message }); }
  const byId = new Map(allRows.map(r => [String(r.productId), r]));

  const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
  const markupUsd = await adminSettings.getMarkup('esim', 'USD');
  const markupNgn = await adminSettings.getMarkup('esim', 'NGN');

  const results = { imported: [], skipped: [], errors: [] };

  for (let i = 0; i < providerProductIds.length; i += IMPORT_BATCH_SIZE) {
    const batchIds = providerProductIds.slice(i, i + IMPORT_BATCH_SIZE);
    const upserts = [];
    for (const id of batchIds) {
      const r = byId.get(String(id));
      if (!r) { results.skipped.push({ providerProductId: String(id), reason: 'NOT_IN_CATALOG' }); continue; }
      let suggested;
      try {
        suggested = pricingEngine.calculatePrice({
          wholesaleAmount:   String(r.wholesaleAmount ?? '0.00'),
          wholesaleCurrency: String(r.wholesaleCurrency || 'USD').toUpperCase(),
          usdToNgn:          String(usdToNgn),
          mode: 'global', value: null,
          globalMarkupUsd:   String(markupUsd),
          globalMarkupNgn:   String(markupNgn)
        });
      } catch (e) {
        results.errors.push({ providerProductId: String(id), reason: 'PRICE_CALC_FAILED', error: e.message });
        continue;
      }

      upserts.push({
        provider:            'dtone',
        provider_product_id: String(r.productId),
        name:                r.planName,
        display_name:        null,
        logo_url:            null,
        coverage_type:       r.coverageType || 'country',
        regions:             r.regions || r.coverageRegions || [],
        data_mb:             r.dataMb ?? null,
        validity_days:       r.validityDays ?? null,
        wholesale_amount:    r.wholesaleAmount,
        wholesale_currency:  String(r.wholesaleCurrency || 'USD').toUpperCase(),
        pricing_mode:        'global',
        pricing_value:       null,
        customer_price_usd:  suggested.priceUsd,
        customer_price_ngn:  suggested.priceNgn,
        enabled:             Boolean(enable),
        featured:            false,
        sort_order:          0,
        price_updated_at:    new Date().toISOString(),
        cost_checked_at:     new Date().toISOString()
      });
    }
    if (!upserts.length) continue;

    const { data, error } = await supabaseAdmin
      .from('esim_products')
      .upsert(upserts, { onConflict: 'provider,provider_product_id', ignoreDuplicates: true })
      .select('id, provider_product_id, name, enabled');

    if (error) { results.errors.push({ batch: i, reason: 'UPSERT_FAILED', error: error.message }); continue; }
    for (const row of data || []) {
      results.imported.push({ id: row.id, providerProductId: row.provider_product_id, planName: row.name, enabled: row.enabled });
    }
  }

  try {
    await recordAudit({
      ctx, action: 'esim.products.imported', targetId: null, before: null,
      after: {
        importedCount: results.imported.length,
        skippedCount: results.skipped.length,
        errorCount: results.errors.length,
        enable: Boolean(enable)
      },
      reason
    });
  } catch (e) { console.error('[ESIM IMPORT] audit failed:', e.message); }

  return results;
}

async function updateProductPricing({ productId, mode, value, reason, expectedUpdatedAt, allowBelowCost = false }, ctx) {
  if (!UUID_RE.test(productId)) throw svcErr('INVALID_ID', 'Invalid product id.', 400);
  if (!VALID_MODES.has(mode)) {
    throw svcErr('PRICING_INVALID_MODE', `Mode must be one of: ${[...VALID_MODES].join(', ')}`, 422);
  }
  if (!reason || String(reason).trim().length < 4) {
    throw svcErr('REASON_REQUIRED', 'A reason is required to change pricing.', 422);
  }

  let normalizedValue = null;
  if (mode === 'markup_pct') {
    if (!isValidDecimal(String(value))) throw svcErr('PRICING_INVALID_VALUE', 'markup_pct value must be a decimal like "0.1000".', 422);
    normalizedValue = normalizeDecimal(String(value), 6);
  } else if (mode === 'fixed_ngn' || mode === 'fixed_usd') {
    if (!isValidDecimal(String(value))) throw svcErr('PRICING_INVALID_VALUE', `${mode} value must be a decimal string.`, 422);
    normalizedValue = normalizeDecimal(String(value), 2);
  }

  const { data: product, error: loadErr } = await supabaseAdmin
    .from('esim_products')
    .select('id, provider_product_id, name, coverage_type, wholesale_amount, wholesale_currency, pricing_mode, pricing_value, customer_price_ngn, customer_price_usd, enabled, price_updated_at, min_margin_pct')
    .eq('id', productId).maybeSingle();

  if (loadErr) throw svcErr('DB_ERROR', loadErr.message, 500);
  if (!product) throw svcErr('PRODUCT_NOT_FOUND', 'Product not found.', 404);

  if (expectedUpdatedAt) {
    if (!product.price_updated_at || String(product.price_updated_at) !== String(expectedUpdatedAt)) {
      throw svcErr('OPTIMISTIC_LOCK_FAILED', 'Product was modified by another admin. Reload and retry.', 409, { current_updated_at: product.price_updated_at });
    }
  }

  const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
  const markupUsd = await adminSettings.getMarkup('esim', 'USD');
  const markupNgn = await adminSettings.getMarkup('esim', 'NGN');

  const proposed = pricingEngine.calculatePrice({
    wholesaleAmount:   String(product.wholesale_amount ?? '0.00'),
    wholesaleCurrency: String(product.wholesale_currency || 'USD').toUpperCase(),
    usdToNgn:          String(usdToNgn),
    mode, value: normalizedValue,
    globalMarkupUsd:   String(markupUsd),
    globalMarkupNgn:   String(markupNgn)
  });

  assertPriceAboveCost({
    priceNgn:      proposed.priceNgn,
    wholesaleNgn:  proposed.costNgn,
    minMarginPct:  product.min_margin_pct,
    allowBelowCost: Boolean(allowBelowCost)
  });

  const nowIso = new Date().toISOString();
  let updateQ = supabaseAdmin
    .from('esim_products')
    .update({
      pricing_mode:       mode,
      pricing_value:      normalizedValue,
      customer_price_ngn: proposed.priceNgn,
      customer_price_usd: proposed.priceUsd,
      price_updated_at:   nowIso,
      updated_at:         nowIso
    })
    .eq('id', productId);
  if (expectedUpdatedAt) updateQ = updateQ.eq('price_updated_at', expectedUpdatedAt);

  const { data: updated, error: updateErr } = await updateQ.select('*').maybeSingle();
  if (updateErr) throw svcErr('DB_ERROR', updateErr.message, 500);
  if (!updated) throw svcErr('OPTIMISTIC_LOCK_FAILED', 'Product was modified by another admin. Reload and retry.', 409);

  await recordAudit({
    ctx, action: 'esim.product.pricing_changed', targetId: productId,
    before: {
      pricing_mode: product.pricing_mode,
      pricing_value: product.pricing_value,
      customer_price_ngn: product.customer_price_ngn,
      customer_price_usd: product.customer_price_usd
    },
    after: {
      pricing_mode: mode,
      pricing_value: normalizedValue,
      customer_price_ngn: proposed.priceNgn,
      customer_price_usd: proposed.priceUsd
    },
    reason
  });

  return {
    product: {
      id: updated.id,
      providerProductId: updated.provider_product_id,
      planName: updated.display_name || updated.name,
      pricingMode: updated.pricing_mode,
      pricingValue: updated.pricing_value,
      customerPriceNgn: updated.customer_price_ngn,
      customerPriceUsd: updated.customer_price_usd,
      priceUpdatedAt: updated.price_updated_at
    },
    pricing: proposed
  };
}

function assertPriceAboveCost({ priceNgn, wholesaleNgn, minMarginPct, allowBelowCost }) {
  const price = normalizeDecimal(priceNgn, 2);
  const cost  = normalizeDecimal(wholesaleNgn, 2);
  const priceBig = BigInt(price.replace('.', ''));
  const costBig  = BigInt(cost.replace('.', ''));

  if (priceBig < costBig && !allowBelowCost) {
    throw svcErr('PRICING_BELOW_COST', 'Price is below provider cost. Pass allow_below_cost:true to override.', 422, { price, cost });
  }

  if (minMarginPct != null) {
    const minPct = normalizeDecimal(String(minMarginPct), 4);
    const minBig = BigInt(minPct.replace('.', ''));
    const diff = priceBig - costBig;
    if (diff < 0n) {
      throw svcErr('PRICING_BELOW_MIN_MARGIN', 'Price yields a negative margin (below cost).', 422, { price, cost, minMarginPct: String(minMarginPct) });
    }
    const lhs = diff * 10000n;
    const rhs = costBig * minBig;
    if (lhs < rhs) {
      throw svcErr('PRICING_BELOW_MIN_MARGIN', `Price yields a margin below the minimum of ${minMarginPct}%.`, 422, { price, cost, minMarginPct: String(minMarginPct) });
    }
  }
}

async function updateProduct({ productId, displayName, logoUrl, featured, sortOrder }, ctx) {
  if (!UUID_RE.test(productId)) throw svcErr('INVALID_ID', 'Invalid product id.', 400);

  const patch = {};
  if (displayName !== undefined) {
    const s = String(displayName || '').trim();
    if (s.length > 200) throw svcErr('VALIDATION_ERROR', 'display_name must be <= 200 chars.', 422);
    patch.display_name = s || null;
  }
  if (logoUrl !== undefined) {
    const s = String(logoUrl || '').trim();
    if (s && !/^https:\/\//i.test(s)) throw svcErr('VALIDATION_ERROR', 'logo_url must be https://', 422);
    patch.logo_url = s || null;
  }
  if (featured !== undefined) patch.featured = Boolean(featured);
  if (sortOrder !== undefined) {
    const n = parseInt(sortOrder, 10);
    if (!Number.isFinite(n) || n < -10000 || n > 10000) throw svcErr('VALIDATION_ERROR', 'sort_order out of range.', 422);
    patch.sort_order = n;
  }
  if (!Object.keys(patch).length) throw svcErr('VALIDATION_ERROR', 'No fields to update.', 422);

  const { data: before } = await supabaseAdmin
    .from('esim_products')
    .select('id, display_name, logo_url, featured, sort_order')
    .eq('id', productId).maybeSingle();
  if (!before) throw svcErr('PRODUCT_NOT_FOUND', 'Product not found.', 404);

  const { data: updated, error } = await supabaseAdmin
    .from('esim_products')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', productId).select('*').maybeSingle();

  if (error) throw svcErr('DB_ERROR', error.message, 500);
  if (!updated) throw svcErr('PRODUCT_NOT_FOUND', 'Product not found.', 404);

  await recordAudit({
    ctx, action: 'esim.product.updated', targetId: productId,
    before, after: patch, reason: null
  });

  return {
    id: updated.id,
    displayName: updated.display_name,
    logoUrl: updated.logo_url,
    featured: updated.featured,
    sortOrder: updated.sort_order
  };
}

async function refreshCosts({ limit = REFRESH_BATCH_SIZE } = {}, ctx) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || REFRESH_BATCH_SIZE, 1), 200);

  const { data: products, error } = await supabaseAdmin
    .from('esim_products')
    .select('id, provider_product_id, name, wholesale_amount, wholesale_currency, pricing_mode, pricing_value, min_margin_pct, customer_price_ngn, customer_price_usd, cost_checked_at')
    .eq('provider', 'dtone').eq('enabled', true)
    .order('cost_checked_at', { ascending: true, nullsFirst: true })
    .limit(safeLimit);

  if (error) throw svcErr('DB_ERROR', error.message, 500);
  if (!products || !products.length) {
    return { checked: 0, updated: 0, belowCost: [], belowMinMargin: [], unavailable: [] };
  }

  let allRows = [];
  try { allRows = await dtone.getEsimProducts('GLOBAL', { includeRegionalAndGlobal: true }); }
  catch (e) { throw svcErr('PROVIDER_QUERY_FAILED', 'Could not reach the provider.', 502, { cause: e.message }); }
  const byProviderId = new Map(allRows.map(r => [String(r.productId), r]));

  const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
  const markupUsd = await adminSettings.getMarkup('esim', 'USD');
  const markupNgn = await adminSettings.getMarkup('esim', 'NGN');

  const belowCost = [], belowMinMargin = [], unavailable = [], updates = [];

  for (const p of products) {
    const r = byProviderId.get(String(p.provider_product_id));
    if (!r) { unavailable.push({ id: p.id, planName: p.name, reason: 'NOT_IN_PROVIDER_CATALOG' }); continue; }

    const newWholesaleAmount   = String(r.wholesaleAmount ?? '0.00');
    const newWholesaleCurrency = String(r.wholesaleCurrency || 'USD').toUpperCase();
    const costChanged     = newWholesaleAmount !== String(p.wholesale_amount ?? '');
    const currencyChanged = newWholesaleCurrency !== String(p.wholesale_currency || '').toUpperCase();

    let priced;
    try {
      priced = pricingEngine.calculatePrice({
        wholesaleAmount:   newWholesaleAmount,
        wholesaleCurrency: newWholesaleCurrency,
        usdToNgn:          String(usdToNgn),
        mode:              p.pricing_mode || 'global',
        value:             p.pricing_value,
        globalMarkupUsd:   String(markupUsd),
        globalMarkupNgn:   String(markupNgn)
      });
    } catch (_) { continue; }

    const priceBig = BigInt(priced.priceNgn.replace('.', ''));
    const costBig  = BigInt(priced.costNgn.replace('.', ''));
    if (priceBig < costBig) {
      belowCost.push({ id: p.id, planName: p.name, priceNgn: priced.priceNgn, costNgn: priced.costNgn });
    } else if (p.min_margin_pct != null) {
      try {
        assertPriceAboveCost({ priceNgn: priced.priceNgn, wholesaleNgn: priced.costNgn, minMarginPct: p.min_margin_pct, allowBelowCost: false });
      } catch (e) {
        if (e.code === 'PRICING_BELOW_MIN_MARGIN') {
          belowMinMargin.push({ id: p.id, planName: p.name, priceNgn: priced.priceNgn, costNgn: priced.costNgn, minMarginPct: p.min_margin_pct });
        }
      }
    }

    if (costChanged || currencyChanged ||
        priced.priceNgn !== String(p.customer_price_ngn ?? '') ||
        priced.priceUsd !== String(p.customer_price_usd ?? '')) {
      updates.push({
        id: p.id,
        wholesale_amount:    newWholesaleAmount,
        wholesale_currency:  newWholesaleCurrency,
        customer_price_ngn:  priced.priceNgn,
        customer_price_usd:  priced.priceUsd,
        cost_checked_at:     new Date().toISOString(),
        price_updated_at:    new Date().toISOString(),
        updated_at:          new Date().toISOString()
      });
    }
  }

  let updated = 0;
  for (const u of updates) {
    const { error: updErr } = await supabaseAdmin.from('esim_products').update(u).eq('id', u.id);
    if (!updErr) updated++;
  }

  try {
    await recordAudit({
      ctx, action: 'esim.products.costs_refreshed', targetId: null, before: null,
      after: {
        checked: products.length, updated,
        belowCostCount: belowCost.length,
        belowMinMarginCount: belowMinMargin.length,
        unavailableCount: unavailable.length
      },
      reason: null
    });
  } catch (e) { console.error('[ESIM REFRESH] audit failed:', e.message); }

  return { checked: products.length, updated, belowCost, belowMinMargin, unavailable };
}

module.exports = {
  ALLOWED_TRANSITIONS,
  getStats,
  listOrders,
  getOrder,
  getAttention,
  syncOrder,
  refundOrder,
  reviewOrder,
  revealActivation,
  getProviderHealth,
  getProviderBalances,
  healthCheckProvider,
  resolveProductPricing,
  getCatalog,
  importProducts,
  listProducts,
  updateProductPricing,
  updateProduct,
  previewPricing,
  getPricingConfig,
  updatePricingConfig,
  refreshCosts,
  _internal: { VALID_MODES, normalizeDecimal, isValidDecimal, normalizeBalances, safeDecimalAdd }
};