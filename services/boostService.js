// services/boostService.js
// ─────────────────────────────────────────────────────────────────
// Boost — single authority for boost orders, pricing, refunds.
//
// Invariants:
//   • adminSettingsService is the source of truth for FX, markup,
//     flags and limits. It returns DECIMAL STRINGS — every read is
//     converted with Number() once and validated.
//   • boost_services.provider_rate is the only trusted cost column.
//   • markup_percent and boost_markup_pct are ALWAYS decimal
//     fractions (0.18 = 18%, 1.50 = 150%). No `n >= 1 ? n/100 : n`.
//   • Customer price is ROUNDED UP to 2 decimals, never below cost.
//   • Every money move passes a deterministic `reference`:
//       debit:          BOOSTDEBIT-<order_ref>
//       full refund:    BOOSTREF-<order_ref>
//       partial refund: BOOSTPART-<order_ref>
//     The ledger dedupes on reference → retries are safe.
//   • Order placement uses one RPC (`boost_place_order_atomic`)
//     that inserts as `awaiting_payment`, then the debit runs, then
//     a second RPC flips to `pending`. A crash between the two is
//     repaired by `reconcileAwaitingPayment()`.
//   • Refunds use `boost_finalize_refund_v2` (FOR UPDATE) and
//     `boost_apply_partial_refund` — both idempotent.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const adminSettings = require('./adminSettingsService');

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORDER_STATUSES = new Set([
    'awaiting_payment',
    'pending', 'processing', 'in_progress', 'partial',
    'partial_refunded',
    'completed', 'failed', 'refunded', 'cancelled',
    'provider_unknown', 'manual_review'
]);

const PENDING_STATUSES = new Set(['pending', 'processing', 'in_progress', 'partial', 'provider_unknown']);
const FAILED_STATUSES  = new Set(['failed', 'cancelled']);
const SUCCESS_STATUSES = new Set(['completed']);
const TERMINAL_STATUSES = new Set([
    'completed', 'failed', 'cancelled', 'refunded', 'partial_refunded'
]);
const ACTIVE_STATUSES = new Set([
    'pending', 'processing', 'in_progress', 'provider_unknown', 'partial'
]);

// Forward-only transitions for provider sync.
const ALLOWED_TRANSITIONS = Object.freeze({
    awaiting_payment: ['pending', 'failed'],   // only via internal flip
    pending:          ['processing', 'in_progress', 'completed', 'failed', 'cancelled', 'provider_unknown', 'manual_review'],
    processing:       ['in_progress', 'partial', 'completed', 'failed', 'provider_unknown', 'manual_review'],
    in_progress:      ['partial', 'completed', 'failed', 'provider_unknown'],
    partial:          ['completed', 'failed', 'partial_refunded', 'manual_review'],
    partial_refunded: [],
    provider_unknown: ['processing', 'in_progress', 'partial', 'completed', 'failed', 'manual_review'],
    manual_review:    ['completed', 'failed', 'refunded', 'processing'],
    completed:        [],
    failed:           ['refunded'],
    refunded:         [],
    cancelled:        ['refunded']
});

// Provider sync may not move a status "backwards". E.g. a stale
// "Pending" from the provider must not reset a `processing` order.
const FORWARD_ONLY_FROM_PROVIDER = new Set([
    'processing', 'in_progress', 'partial', 'completed', 'failed', 'provider_unknown'
]);

const ALLOWED_PLATFORMS = new Set([
    'instagram', 'tiktok', 'youtube', 'facebook', 'twitter',
    'telegram', 'whatsapp', 'discord', 'spotify', 'other'
]);

const ALLOWED_CATEGORIES = new Set([
    'followers', 'likes', 'views', 'comments', 'shares',
    'subscribers', 'members', 'streams', 'plays', 'other'
]);

// Link host allow-list per platform.
const PLATFORM_HOSTS = {
    instagram: ['instagram.com', 'instagr.am'],
    tiktok:    ['tiktok.com', 'vm.tiktok.com'],
    youtube:   ['youtube.com', 'youtu.be', 'm.youtube.com'],
    facebook:  ['facebook.com', 'fb.com', 'm.facebook.com'],
    twitter:   ['twitter.com', 'x.com', 't.co'],
    whatsapp:  ['wa.me', 'whatsapp.com'],
    telegram:  ['t.me', 'telegram.me', 'telegram.org'],
    discord:   ['discord.gg', 'discord.com'],
    spotify:   ['spotify.com', 'open.spotify.com'],
    other:     [] // no host restriction
};

// Link hint per category — used by getPublicService.
const LINK_HINTS = {
    followers:    'Your public profile URL, e.g. https://instagram.com/username',
    subscribers:  'Your channel URL',
    members:      'Your group or channel invite URL',
    likes:        'Direct URL to the post or video',
    views:        'Direct URL to the post or video',
    comments:     'Direct URL to the post or video',
    shares:       'Direct URL to the post or video',
    streams:      'Direct URL to the track or playlist',
    plays:        'Direct URL to the track or playlist',
    other:        'Public profile or post URL'
};

// ─── Helpers ─────────────────────────────────────────────────────

function limitOf(v, def = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
function pageOf(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}
function isoDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
}
function lagosDayEnd(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - 3600 * 1000).toISOString();
    }
    const dt = new Date(s);
    return isNaN(dt.getTime()) ? null : dt.toISOString();
}
function lagosDayStart(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - 3600 * 1000).toISOString();
    }
    const dt = new Date(s);
    return isNaN(dt.getTime()) ? null : dt.toISOString();
}
function startOfWatDay() {
    const OFFSET_MS = 60 * 60 * 1000;
    const now = new Date();
    const local = new Date(now.getTime() + OFFSET_MS);
    const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
    return new Date(Date.UTC(y, m, d, 0, 0, 0) - OFFSET_MS).toISOString();
}

function statusBadge(s) {
    s = String(s || '').toLowerCase();
    if (s === 'completed') return 'success';
    if (FAILED_STATUSES.has(s)) return 'danger';
    if (s === 'refunded' || s === 'partial_refunded') return 'info';
    if (s === 'provider_unknown' || s === 'manual_review') return 'purple';
    if (s === 'awaiting_payment') return 'neutral';
    if (PENDING_STATUSES.has(s)) return 'warn';
    return 'neutral';
}

function buildOrderRef() {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `BST-${date}-${rand}`;
}

function roundUp2(v) {
    const s = String(v == null ? '0' : v).trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) return '0.00';
    const neg = s.startsWith('-');
    const body = neg ? s.slice(1) : s;
    const [i, f = ''] = body.split('.');
    const frac = (f + '00').slice(0, 2);
    let intPart = BigInt(i || '0');
    let fracInt = Number(frac);
    if (f.length > 2 && /[1-9]/.test(f.slice(2))) {
        fracInt += 1;
        if (fracInt >= 100) { fracInt = 0; intPart += 1n; }
    }
    const fracStr = String(fracInt).padStart(2, '0');
    return (neg ? '-' : '') + intPart.toString() + '.' + fracStr;
}
function cmpDecimal(a, b) {
    const scale = Math.max(decimalScale(a), decimalScale(b));
    const A = toScaledBigInt(a, scale);
    const B = toScaledBigInt(b, scale);
    if (A === B) return 0;
    return A < B ? -1 : 1;
}
function decimalScale(s) {
    if (!/^-?\d+(\.\d+)?$/.test(s)) return 0;
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : s.length - dot - 1;
}
function toScaledBigInt(s, scale) {
    const neg = s.startsWith('-');
    const body = neg ? s.slice(1) : s;
    const [i, f = ''] = body.split('.');
    const frac = (f + '0'.repeat(scale)).slice(0, scale);
    const bi = BigInt((i || '0') + frac);
    return neg ? -bi : bi;
}

// Normalise a link for the duplicate guard: strip scheme, trailing
// slash, lower-case host, keep path.
function normaliseLink(url) {
    try {
        const u = new URL(String(url));
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        const path = (u.pathname || '').replace(/\/+$/, '');
        return host + path + (u.search || '');
    } catch (_) {
        return String(url || '').trim().toLowerCase();
    }
}

// Validate the host matches the platform. Returns { ok, reason }.
function validateLinkForPlatform(platform, url) {
    if (!/^https?:\/\//i.test(url)) {
        return { ok: false, code: 'INVALID_LINK_SCHEME', reason: 'Link must start with http:// or https://' };
    }
    let host;
    try {
        host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch (_) {
        return { ok: false, code: 'INVALID_LINK', reason: 'Link is not a valid URL' };
    }
    const allowed = PLATFORM_HOSTS[String(platform || '').toLowerCase()];
    if (!allowed || allowed.length === 0) return { ok: true };
    if (!allowed.some(h => host === h || host.endsWith('.' + h))) {
        return {
            ok: false,
            code: 'INVALID_LINK_HOST',
            reason: `This service needs a ${platform} link (${allowed.join(' or ')}). Got: ${host}`
        };
    }
    return { ok: true };
}

// ─── Admin settings readers (STRING → Number) ────────────────────

async function readUsdToNgn() {
    let raw;
    try { raw = await adminSettings.getRate('USD', 'NGN'); }
    catch (_) { raw = await adminSettings.getRaw('usd_to_ngn'); }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        const e = new Error('USD→NGN rate is not configured.');
        e.status = 503; e.code = 'RATE_NOT_CONFIGURED';
        throw e;
    }
    return n;
}

async function readGlobalMarkup() {
    // Always a decimal fraction: 0.18 = 18%, 1.50 = 150%.
    // NEVER apply the `n >= 1 ? n/100 : n` heuristic.
    let raw;
    try { raw = await adminSettings.getRaw('boost_markup_pct'); }
    catch (_) { raw = null; }
    if (raw == null) {
        try { raw = await adminSettings.getMarkup('boost', 'USD'); }
        catch (_) { raw = null; }
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 20) {
        const e = new Error('Boost markup is not configured or out of range.');
        e.status = 503; e.code = 'MARKUP_NOT_CONFIGURED';
        throw e;
    }
    return n;
}

async function readBoostEnabled() {
    try { return await adminSettings.isServiceEnabled('boost'); }
    catch { return false; }
}
async function readAllowNgn() {
    if (!adminSettings.KEY_REGISTRY || !adminSettings.KEY_REGISTRY.boost_allow_ngn) return true;
    try { return await adminSettings.getBoolean('boost_allow_ngn'); }
    catch { return true; }
}
async function readAllowUsd() {
    if (!adminSettings.KEY_REGISTRY || !adminSettings.KEY_REGISTRY.boost_allow_usd) return true;
    try { return await adminSettings.getBoolean('boost_allow_usd'); }
    catch { return true; }
}
async function readMinNgn() {
    if (!adminSettings.KEY_REGISTRY || !adminSettings.KEY_REGISTRY.boost_min_ngn) return 0;
    try { const n = Number(await adminSettings.getRaw('boost_min_ngn')); return Number.isFinite(n) && n > 0 ? n : 0; }
    catch { return 0; }
}
async function readMaxNgn() {
    if (!adminSettings.KEY_REGISTRY || !adminSettings.KEY_REGISTRY.boost_max_ngn) return 0;
    try { const n = Number(await adminSettings.getRaw('boost_max_ngn')); return Number.isFinite(n) && n > 0 ? n : 0; }
    catch { return 0; }
}

// ─── Public config ───────────────────────────────────────────────

async function getPublicConfig() {
    const [enabled, allowNgn, allowUsd, usdToNgn, minNgn, maxNgn] = await Promise.all([
        readBoostEnabled(), readAllowNgn(), readAllowUsd(),
        readUsdToNgn(), readMinNgn(), readMaxNgn()
    ]);
    return {
        service_enabled: enabled,
        allow_ngn:       allowNgn,
        allow_usd:       allowUsd,
        usd_to_ngn:      usdToNgn,
        min_ngn:         minNgn,
        max_ngn:         maxNgn
    };
}

// ─── Pricing context + per-service calculation ──────────────────

async function getPricingContext() {
    const [usdToNgn, globalMarkup] = await Promise.all([
        readUsdToNgn(),
        readGlobalMarkup()
    ]);
    return { usdToNgn, globalMarkup };
}

function computeServicePrice(svc, ctx) {
    const providerRate = Number(svc.provider_rate || 0);
    if (!Number.isFinite(providerRate) || providerRate <= 0) {
        return { source: 'none', usd_per_1k: null, ngn_per_1k: null,
                 margin_pct: null, below_cost: false, markup_used: null };
    }

    const custom = svc.custom_price != null ? Number(svc.custom_price) : null;
    const hasCustom = Number.isFinite(custom) && custom > 0;

    let source, usdPer1k, markupUsed;
    if (hasCustom) {
        source = 'custom';
        usdPer1k = custom;
        markupUsed = null;
    } else if (svc.markup_percent != null && Number.isFinite(Number(svc.markup_percent))) {
        // Stored as decimal (0.25 = 25%). This is deliberate.
        source = 'service';
        markupUsed = Number(svc.markup_percent);
        usdPer1k = providerRate * (1 + markupUsed);
    } else {
        source = 'global';
        markupUsed = ctx.globalMarkup;
        usdPer1k = providerRate * (1 + ctx.globalMarkup);
    }

    const ngnPer1k = usdPer1k * ctx.usdToNgn;
    const belowCost = usdPer1k < providerRate;
    const margin = usdPer1k > 0 ? (usdPer1k - providerRate) / usdPer1k : 0;

    return {
        source,
        usd_per_1k: usdPer1k,
        ngn_per_1k: ngnPer1k,
        margin_pct: margin,
        below_cost: belowCost,
        markup_used: markupUsed
    };
}

async function computeCharge({ service, quantity, walletCurrency }) {
    if (!Number.isInteger(quantity) || quantity < 1) {
        const e = new Error('Quantity must be a positive integer.');
        e.status = 422; e.code = 'INVALID_QUANTITY'; throw e;
    }
    if (service.min_quantity && quantity < service.min_quantity) {
        const e = new Error(`Minimum quantity is ${service.min_quantity}.`);
        e.status = 422; e.code = 'QUANTITY_BELOW_MIN'; throw e;
    }
    if (service.max_quantity && quantity > service.max_quantity) {
        const e = new Error(`Maximum quantity is ${service.max_quantity}.`);
        e.status = 422; e.code = 'QUANTITY_ABOVE_MAX'; throw e;
    }

    const ctx = await getPricingContext();
    const price = computeServicePrice(service, ctx);

    if (!price.usd_per_1k) {
        const e = new Error('Service has no valid provider rate.');
        e.status = 422; e.code = 'INVALID_SERVICE_RATE'; throw e;
    }
    if (price.below_cost) {
        const e = new Error('Service price is below provider cost.');
        e.status = 422; e.code = 'PRICE_BELOW_COST'; throw e;
    }

    const providerRate = Number(service.provider_rate);
    const providerCostUsd = (providerRate / 1000) * quantity;
    const customerUsdRaw = (price.usd_per_1k / 1000) * quantity;
    const customerUsd = Number(roundUp2(customerUsdRaw.toFixed(6)));

    const currency = String(walletCurrency || 'NGN').toUpperCase();
    const ngnPerUsd = ctx.usdToNgn;
    const providerCostNgn = providerCostUsd * ngnPerUsd;
    const customerNgn = customerUsd * ngnPerUsd;

    const chargeAmount = currency === 'USD' ? customerUsd : customerNgn;
    const providerCostCcy = currency === 'USD' ? providerCostUsd : providerCostNgn;
    const profit = chargeAmount - providerCostCcy;

    return {
        quantity,
        currency,
        usd_to_ngn: ctx.usdToNgn,
        source: price.source,
        markup_used: price.markup_used,
        provider_rate: providerRate,
        usd_per_1k: price.usd_per_1k,
        ngn_per_1k: price.ngn_per_1k,
        provider_cost_usd: roundUp2(providerCostUsd.toFixed(6)),
        provider_cost_ngn: roundUp2(providerCostNgn.toFixed(6)),
        customer_usd: roundUp2(customerUsd.toFixed(6)),
        customer_ngn: roundUp2(customerNgn.toFixed(6)),
        charge_amount: roundUp2(chargeAmount.toFixed(6)),
        provider_cost: roundUp2(providerCostCcy.toFixed(6)),
        profit: roundUp2(profit.toFixed(6)),
        below_cost: false
    };
}

async function quote({ userId, serviceId, quantity, walletCurrency }) {
    if (!userId || !UUID_RE.test(userId)) {
        const e = new Error('Invalid user.'); e.status = 400; e.code = 'INVALID_USER'; throw e;
    }
    const currency = String(walletCurrency || 'NGN').toUpperCase();
    if (!['NGN', 'USD'].includes(currency)) {
        const e = new Error('Invalid wallet.'); e.status = 422; e.code = 'INVALID_WALLET'; throw e;
    }
    await adminSettings.assertServiceEnabled('boost');

    const allowNgn = await readAllowNgn();
    const allowUsd = await readAllowUsd();
    if (currency === 'NGN' && !allowNgn) {
        const e = new Error('NGN payments are disabled.'); e.status = 422; e.code = 'CURRENCY_DISABLED'; throw e;
    }
    if (currency === 'USD' && !allowUsd) {
        const e = new Error('USD payments are disabled.'); e.status = 422; e.code = 'CURRENCY_DISABLED'; throw e;
    }

    const { data: service, error } = await supabaseAdmin
        .from('boost_services')
        .select('*')
        .eq('provider_service_id', String(serviceId))
        .eq('active', true).eq('visible_to_users', true)
        .maybeSingle();
    if (error || !service) {
        const e = new Error('Service not available.'); e.status = 404; e.code = 'SERVICE_NOT_FOUND'; throw e;
    }

    const charge = await computeCharge({ service, quantity, walletCurrency: currency });
    await assertWithinLimits({ chargeAmount: charge.charge_amount, currency, usdToNgn: charge.usd_to_ngn });

    const balances = await LedgerService.getAllBalances(userId);
    const balance = currency === 'USD' ? Number(balances.USD || 0) : Number(balances.NGN || 0);
    const canAfford = balance >= Number(charge.charge_amount);

    return {
        service_id: service.provider_service_id,
        service_name: service.name,
        currency,
        quantity,
        rate_per_1k: currency === 'USD' ? charge.customer_usd : charge.customer_ngn,
        charge_amount: charge.charge_amount,
        balance,
        can_afford: canAfford,
        usd_to_ngn: charge.usd_to_ngn,
        min_quantity: service.min_quantity,
        max_quantity: service.max_quantity
    };
}

async function assertWithinLimits({ chargeAmount, currency, usdToNgn }) {
    const minNgn = await readMinNgn();
    const maxNgn = await readMaxNgn();
    const ngnEq = currency === 'USD' ? Number(chargeAmount) * usdToNgn : Number(chargeAmount);
    if (minNgn > 0 && ngnEq < minNgn) {
        const e = new Error(`Minimum boost order is ₦${minNgn.toFixed(2)}.`);
        e.status = 400; e.code = 'BELOW_MIN_LIMIT'; e.min_ngn = minNgn; throw e;
    }
    if (maxNgn > 0 && ngnEq > maxNgn) {
        const e = new Error(`Maximum boost order is ₦${maxNgn.toFixed(2)}.`);
        e.status = 400; e.code = 'ABOVE_MAX_LIMIT'; e.max_ngn = maxNgn; throw e;
    }
}

// ─── Public catalog (cached, ETag-friendly) ─────────────────────

const CATALOG_CACHE_TTL_MS = 30 * 1000;
let _catalogCache = { at: 0, payload: null, version: null };

function invalidateCatalog() {
    _catalogCache = { at: 0, payload: null, version: null };
}

async function fetchAllActiveServices() {
    const out = [];
    const pageSize = 1000;
    let from = 0;
    for (let i = 0; i < 50; i++) {
        const { data, error } = await supabaseAdmin
            .from('boost_services')
            .select('id, provider_service_id, name, platform, category, provider_rate, markup_percent, custom_price, min_quantity, max_quantity, refill_allowed, refill_days, average_time, sort_order, service_type')
            .eq('active', true).eq('visible_to_users', true)
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) {
            if (error.code === '42P01') return [];
            throw error;
        }
        if (!data || !data.length) break;
        out.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return out;
}

async function getPublicCatalog() {
    const now = Date.now();
    if (_catalogCache.payload && (now - _catalogCache.at) < CATALOG_CACHE_TTL_MS) {
        return _catalogCache.payload;
    }
    const ctx = await getPricingContext();
    const rows = await fetchAllActiveServices();

    const services = rows.map(s => {
        const p = computeServicePrice(s, ctx);
        if (!p.usd_per_1k || p.below_cost) return null;
        return {
            id: String(s.provider_service_id),
            n:  s.name,
            p:  s.platform || 'other',
            c:  s.category || 'other',
            mn: Number(s.min_quantity) || 1,
            mx: Number(s.max_quantity) || 0,
            rf: Boolean(s.refill_allowed),
            t:  String(s.average_time || ''),  // may be empty — UI must not fabricate
            u:  Number(p.usd_per_1k.toFixed(4)),
            g:  Number((p.usd_per_1k * ctx.usdToNgn).toFixed(2))
        };
    }).filter(Boolean);

    const version = crypto.createHash('sha1')
        .update(JSON.stringify(services))
        .update(String(ctx.usdToNgn))
        .digest('hex')
        .slice(0, 16);

    _catalogCache = { at: now, payload: { services, usd_to_ngn: ctx.usdToNgn, version }, version };
    return _catalogCache.payload;
}

function autoDescription(svc) {
    const lines = [`${svc.name}.`];
    lines.push(svc.average_time
        ? `Delivery time: ${svc.average_time}.`
        : 'Delivery time: varies with order size.');
    lines.push(svc.refill_allowed
        ? `Refill: included${svc.refill_days ? ` for ${svc.refill_days} days` : ''}.`
        : 'Refill: not included. Drops are not replaced.');
    lines.push('Your profile or post must stay public until delivery finishes.');
    return lines.join('\n');
}

async function getPublicService(serviceId) {
    const { data: svc, error } = await supabaseAdmin
        .from('boost_services')
        .select('*')
        .eq('provider_service_id', String(serviceId))
        .eq('active', true).eq('visible_to_users', true)
        .maybeSingle();
    if (error || !svc) {
        const e = new Error('Service not found.'); e.status = 404; e.code = 'SERVICE_NOT_FOUND'; throw e;
    }
    const ctx = await getPricingContext();
    const price = computeServicePrice(svc, ctx);
    const own = (svc.description || '').trim();
    const isAuto = !own || own === svc.name;
    return {
        id: String(svc.provider_service_id),
        name: svc.name,
        platform: svc.platform,
        category: svc.category,
        min_quantity: svc.min_quantity,
        max_quantity: svc.max_quantity,
        refill_allowed: Boolean(svc.refill_allowed),
        refill_days: svc.refill_days || null,
        average_time: svc.average_time || null,
        description: isAuto ? autoDescription(svc) : own,
        description_is_auto: isAuto,
        link_hint: LINK_HINTS[svc.category] || LINK_HINTS.other,
        usd_per_1k: price.usd_per_1k ? Number(price.usd_per_1k.toFixed(4)) : null,
        ngn_per_1k: price.ngn_per_1k ? Number(price.ngn_per_1k.toFixed(2)) : null
    };
}

// ─── Ledger wrappers (OBJECT FORM, deterministic reference) ────
//
// Critical: the ledger's positional-arg normaliser does NOT forward
// `reference`. Only the object form does. So we always use object
// form and pass a deterministic reference.

async function ledgerDebit({ userId, amount, currency, description, reference, metadata }) {
    return LedgerService.debitWallet({
        userId,
        amount,
        currency,
        description,
        reference,
        metadata: metadata || {},
        type: 'boost_purchase'
    });
}

async function ledgerCredit({ userId, amount, currency, description, reference, metadata }) {
    return LedgerService.creditWallet({
        userId,
        amount,
        currency,
        description,
        reference,
        metadata: metadata || {},
        type: 'refund'
    });
}

// ─── Awaiting-payment reconciliation helpers ────────────────────

// If a debit exists (by reference) but the order is still awaiting
// payment, flip the order to pending. If no debit exists, cancel.
async function reconcileAwaitingPayment() {
    const { data: rows, error } = await supabaseAdmin
        .rpc('boost_reconcile_awaiting_payment');
    if (error) return { ok: false, error: error.message, processed: 0 };

    let completed = 0, cancelled = 0, errors = 0;
    for (const r of rows || []) {
        const ref = `BOOSTDEBIT-${r.order_ref}`;
        let debitTx = null;
        try {
            debitTx = await LedgerService.findTransactionByReference(ref);
        } catch (_) {}

        if (debitTx) {
            // Debit exists → flip to pending; the sync worker picks it up.
            const { data: flipped } = await supabaseAdmin
                .rpc('boost_flip_awaiting_to_pending', { p_order_id: r.order_id });
            if (flipped) completed++; else errors++;
        } else {
            // No debit → cancel. No refund needed.
            const { error: cancelErr } = await supabaseAdmin
                .from('boost_orders')
                .update({
                    status: 'cancelled',
                    cancelled_at: new Date().toISOString(),
                    failure_reason: 'awaiting_payment_timeout',
                    updated_at: new Date().toISOString()
                })
                .eq('id', r.order_id)
                .eq('status', 'awaiting_payment');
            if (!cancelErr) cancelled++; else errors++;
        }
    }
    return { ok: true, processed: rows.length, completed, cancelled, errors };
}

// If an order is refunded but the ledger credit is missing, credit it.
async function reconcileRefunds() {
    const { data: rows, error } = await supabaseAdmin.rpc('boost_reconcile_refunds');
    if (error) return { ok: false, error: error.message, processed: 0 };

    let credited = 0, errors = 0;
    for (const r of rows || []) {
        try {
            await ledgerCredit({
                userId: r.user_id,
                amount: Number(r.refund_amount),
                currency: r.currency,
                description: `Boost refund for ${r.order_ref}`,
                reference: r.refund_ref,
                metadata: { order_id: r.order_id, order_ref: r.order_ref, reason: 'reconciled' }
            });
            credited++;
        } catch (e) {
            errors++;
            console.error('[BOOST] reconcileRefunds failed for', r.order_ref, e.message);
        }
    }
    return { ok: true, processed: rows.length, credited, errors };
}

// ─── Order placement ────────────────────────────────────────────

async function placeOrder({ userId, serviceId, link, quantity, walletType, idempotencyKey, expectedAmount }) {
    if (!userId || !UUID_RE.test(userId)) {
        const e = new Error('Invalid user.'); e.status = 400; e.code = 'INVALID_USER'; throw e;
    }
    if (!link || typeof link !== 'string' || link.length > 500) {
        const e = new Error('Link is required.'); e.status = 422; e.code = 'INVALID_LINK'; throw e;
    }
    if (!idempotencyKey || String(idempotencyKey).length < 8 || String(idempotencyKey).length > 128) {
        const e = new Error('Idempotency-Key header is required (8–128 chars).');
        e.status = 400; e.code = 'IDEMPOTENCY_KEY_REQUIRED'; throw e;
    }
    const currency = String(walletType || 'NGN').toUpperCase();
    if (!['NGN', 'USD'].includes(currency)) {
        const e = new Error('Invalid wallet.'); e.status = 422; e.code = 'INVALID_WALLET'; throw e;
    }

    await adminSettings.assertServiceEnabled('boost');

    const allowNgn = await readAllowNgn();
    const allowUsd = await readAllowUsd();
    if (currency === 'NGN' && !allowNgn) {
        const e = new Error('NGN payments are disabled.'); e.status = 422; e.code = 'CURRENCY_DISABLED'; throw e;
    }
    if (currency === 'USD' && !allowUsd) {
        const e = new Error('USD payments are disabled.'); e.status = 422; e.code = 'CURRENCY_DISABLED'; throw e;
    }

    const idem = String(idempotencyKey).slice(0, 128);

    // Idempotency: compare service, quantity, link, wallet.
    const { data: existing } = await supabaseAdmin
        .from('boost_orders')
        .select('*')
        .eq('user_id', userId)
        .eq('idempotency_key', idem)
        .maybeSingle();
    if (existing) {
        const sameService  = String(existing.service_id) === String(serviceId);
        const sameQuantity = Number(existing.quantity) === Number(quantity);
        const sameWallet   = String(existing.currency).toUpperCase() === currency;
        const sameLink     = normaliseLink(existing.link) === normaliseLink(link);
        if (!sameService || !sameQuantity || !sameWallet || !sameLink) {
            const e = new Error('Idempotency key reused with a different payload.');
            e.status = 409; e.code = 'IDEMPOTENCY_CONFLICT'; throw e;
        }
        return { order: shapeOrder(existing), idempotent: true };
    }

    const { data: service, error: svcErr } = await supabaseAdmin
        .from('boost_services')
        .select('*')
        .eq('provider_service_id', String(serviceId))
        .eq('active', true).eq('visible_to_users', true)
        .maybeSingle();
    if (svcErr || !service) {
        const e = new Error('Service not available.'); e.status = 404; e.code = 'SERVICE_NOT_FOUND'; throw e;
    }

    // Link validation against platform hosts.
    const linkCheck = validateLinkForPlatform(service.platform, link);
    if (!linkCheck.ok) {
        const e = new Error(linkCheck.reason);
        e.status = 422; e.code = linkCheck.code; throw e;
    }

    // Duplicate protection: same user + service + normalised link + active status.
    const linkNorm = normaliseLink(link);
    const { data: dup } = await supabaseAdmin
        .from('boost_orders')
        .select('id, order_ref')
        .eq('user_id', userId)
        .eq('service_id', String(service.provider_service_id))
        .eq('dedupe_link_norm', linkNorm)
        .in('status', [...ACTIVE_STATUSES])
        .limit(1)
        .maybeSingle();
    if (dup) {
        const e = new Error(`An order for this link is already active (${dup.order_ref}). Wait for it to finish or pick a different link.`);
        e.status = 409; e.code = 'DUPLICATE_ACTIVE_ORDER';
        throw e;
    }

    const charge = await computeCharge({ service, quantity, walletCurrency: currency });
    await assertWithinLimits({ chargeAmount: charge.charge_amount, currency, usdToNgn: charge.usd_to_ngn });

    // expected_amount guard (1 minor unit tolerance).
    if (expectedAmount != null && String(expectedAmount).trim() !== '') {
        const expected = Number(expectedAmount);
        const actual = Number(charge.charge_amount);
        if (Number.isFinite(expected) && Math.abs(expected - actual) > 0.01) {
            const e = new Error('Price changed — please review and confirm the new total.');
            e.status = 409; e.code = 'PRICE_CHANGED';
            e.new_amount = charge.charge_amount; e.currency = currency;
            throw e;
        }
    }

    const balances = await LedgerService.getAllBalances(userId);
    const balance = currency === 'USD' ? Number(balances.USD || 0) : Number(balances.NGN || 0);
    if (balance < Number(charge.charge_amount)) {
        const e = new Error(`Insufficient ${currency} balance.`);
        e.status = 400; e.code = 'INSUFFICIENT_BALANCE';
        e.required = Number(charge.charge_amount); e.balance = balance;
        throw e;
    }

    const orderRef = buildOrderRef();

    // 1. Insert as awaiting_payment (idempotent RPC).
    const { data: insertedRow, error: insertErr } = await supabaseAdmin
        .rpc('boost_place_order_atomic', {
            p_user_id: userId,
            p_order_ref: orderRef,
            p_service_id: String(service.provider_service_id),
            p_service_name: service.name,
            p_platform: service.platform || 'other',
            p_category: service.category || 'other',
            p_link: link,
            p_dedupe_link_norm: linkNorm,
            p_quantity: quantity,
            p_total_amount: Number(charge.charge_amount),
            p_currency: currency,
            p_provider_rate: Number(service.provider_rate),
            p_markup_percent: charge.markup_used,
            p_usd_rate: charge.usd_to_ngn,
            p_provider_cost: Number(charge.provider_cost),
            p_profit_amount: Number(charge.profit),
            p_provider: 'smmwiz',
            p_idempotency_key: idem
        });
    if (insertErr) {
        console.error('[BOOST] atomic insert failed:', insertErr.message);
        const e = new Error('Failed to record order.'); e.status = 500; e.code = 'ORDER_INSERT_FAILED'; throw e;
    }

    const row = Array.isArray(insertedRow) ? insertedRow[0] : insertedRow;
    const orderId = row.id;

    // 2. Debit with deterministic reference. Idempotent by reference.
    const debitRef = `BOOSTDEBIT-${orderRef}`;
    const chargeAmount = Number(charge.charge_amount);
    try {
        await ledgerDebit({
            userId,
            amount: chargeAmount,
            currency,
            description: `Social boost: ${service.name} × ${quantity}`,
            reference: debitRef,
            metadata: {
                type: 'boost_order',
                order_id: orderId,
                order_ref: orderRef,
                service_id: service.provider_service_id,
                service_name: service.name,
                quantity
            }
        });
    } catch (debitErr) {
        console.error('[BOOST] ledger debit failed:', debitErr.message);
        // Row is stuck in awaiting_payment — a reconcile will cancel it.
        // Do NOT refund here: no debit happened.
        const e = new Error('Failed to debit wallet.');
        e.status = 400; e.code = 'DEBIT_FAILED'; throw e;
    }

    // 3. Flip to pending.
    const { data: flipped } = await supabaseAdmin
        .rpc('boost_flip_awaiting_to_pending', { p_order_id: orderId });

    // Non-fatal side effects
    try {
        await supabaseAdmin.from('transactions').insert({
            user_id: userId, type: 'boost', status: 'completed',
            currency, amount: chargeAmount,
            ref: orderRef, reference: orderRef,
            description: `Social boost: ${service.name} × ${quantity}`,
            provider: 'smmwiz',
            metadata: {
                order_id: orderId, service_id: service.provider_service_id,
                service_name: service.name, quantity, link,
                provider_cost: Number(charge.provider_cost),
                markup: charge.markup_used, usd_rate: charge.usd_to_ngn
            },
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });
    } catch (txErr) { console.warn('[BOOST] transaction insert failed:', txErr.message); }

    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title: 'Boost Order Placed',
            message: `Your ${service.name} order ${orderRef} has been received and is being queued.`,
            type: 'boost_placed', icon: '📈', link: '/boost', is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (_) {}

    // Re-read to reflect the pending status.
    const { data: fresh } = await supabaseAdmin
        .from('boost_orders').select('*').eq('id', orderId).maybeSingle();
    return { order: shapeOrder(fresh || row), idempotent: false };
}

// ─── Shape ──────────────────────────────────────────────────────

function shapeOrder(o, profile) {
    return {
        id: o.id,
        order_ref: o.order_ref,
        status: o.status,
        status_badge: statusBadge(o.status),
        user_id: o.user_id,
        user: profile ? {
            id: profile.id,
            username: profile.username || (profile.email ? profile.email.split('@')[0] : 'User'),
            email: profile.email || null
        } : null,
        service_id: o.service_id,
        service_name: o.service_name,
        platform: o.platform,
        category: o.category,
        link: o.link,
        quantity: o.quantity,
        total_amount: o.total_amount,
        currency: o.currency,
        provider_rate: o.provider_rate,
        markup_percent: o.markup_percent,
        usd_rate: o.usd_rate,
        provider_cost: o.provider_cost,
        profit_amount: o.profit_amount,
        provider: o.provider,
        api_order_id: o.api_order_id,
        provider_status: o.provider_status,
        start_count: o.start_count,
        remains: o.remains,
        admin_note: o.admin_note,
        failure_reason: o.failure_reason,
        refund_status: o.refund_status,
        refund_reference: o.refund_reference,
        refund_processed_at: o.refund_processed_at,
        refund_amount: o.refund_amount,
        verified_at_provider: o.verified_at_provider || false,
        verified_at_provider_at: o.verified_at_provider_at || null,
        provider_last_checked_at: o.provider_last_checked_at,
        last_polled_at: o.last_polled_at,
        created_at: o.created_at,
        updated_at: o.updated_at,
        completed_at: o.completed_at,
        failed_at: o.failed_at,
        cancelled_at: o.cancelled_at,
        allowed_transitions: ALLOWED_TRANSITIONS[o.status] || []
    };
}

function shapeUserOrder(o) {
    let status = String(o.status || 'pending').toLowerCase();
    if (status === 'provider_unknown' || status === 'manual_review' || status === 'in_progress') {
        status = 'processing';
    }
    if (status === 'awaiting_payment') status = 'pending';

    let failure_message = null;
    if (o.status === 'failed' || o.status === 'cancelled') {
        failure_message = o.refund_status === 'refunded'
            ? 'Your order was refunded to your wallet.'
            : 'The order did not complete. Support will review it.';
    }
    if (o.status === 'refunded' || o.status === 'partial_refunded') {
        failure_message = o.refund_amount
            ? `Order was refunded. Amount credited: ${o.refund_amount} ${o.currency}.`
            : 'Order was refunded.';
    }
    if (o.status === 'partial') {
        failure_message = 'The provider delivered part of this order. Support will review the shortfall.';
    }

    return {
        id: o.id,
        order_ref: o.order_ref,
        status,
        status_badge: statusBadge(status),
        service_id: o.service_id,
        service_name: o.service_name,
        platform: o.platform,
        category: o.category,
        link: o.link,
        quantity: o.quantity,
        total_amount: o.total_amount,
        currency: o.currency,
        failure_message,
        refund_status: o.refund_status,
        refund_amount: o.refund_amount,
        created_at: o.created_at,
        updated_at: o.updated_at,
        completed_at: o.completed_at
    };
}

// ─── List / detail ──────────────────────────────────────────────

function escapePostgrest(v) {
    return String(v).replace(/[%_,()"\\]/g, c => '\\' + c);
}

async function listOrders(query = {}, { forUserId = null, withCount = true } = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit);
    const offset = (page - 1) * limit;

    // `count: 'exact'` is expensive on large tables — it forces a
    // sequential scan to compute the exact number. Only ask for it
    // when the caller actually needs the total (the Orders tab does;
    // the Overview tile pulls 8 rows and doesn't need a total).
    const selectArgs = withCount ? { count: 'exact' } : undefined;

    let q = supabaseAdmin
        .from('boost_orders')
        .select('*', selectArgs)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (forUserId) q = q.eq('user_id', forUserId);
    else if (query.user_id && UUID_RE.test(query.user_id)) q = q.eq('user_id', query.user_id);

    if (query.status && query.status !== 'all' && ORDER_STATUSES.has(String(query.status).toLowerCase())) {
        q = q.eq('status', String(query.status).toLowerCase());
    }
    if (query.platform && query.platform !== 'all') q = q.eq('platform', query.platform);
    if (query.category && query.category !== 'all') q = q.eq('category', query.category);
    if (query.currency && query.currency !== 'all') q = q.eq('currency', String(query.currency).toUpperCase());

    const fromIso = lagosDayStart(query.from);
    const toIso = lagosDayEnd(query.to);
    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso) q = q.lte('created_at', toIso);

    if (query.search) {
        const safe = escapePostgrest(String(query.search).trim());
        const parts = [
            `order_ref.ilike.%${safe}%`,
            `service_name.ilike.%${safe}%`,
            `link.ilike.%${safe}%`,
            `api_order_id.ilike.%${safe}%`
        ];
        try {
            const { data: users } = await supabaseAdmin
                .from('profiles').select('id')
                .or(`email.ilike.%${safe}%,username.ilike.%${safe}%`)
                .limit(50);
            if (users?.length) parts.push(`user_id.in.(${users.map(u => u.id).join(',')})`);
        } catch (_) {}
        q = q.or(parts.join(','));
    }

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { orders: [], count: 0, page, limit, totalPages: 0, available: false };
        }
        const e = new Error('Failed to load boost orders.'); e.status = 500; e.code = 'BOOST_LIST_ERROR'; throw e;
    }

    let ordersOut;
    if (forUserId) {
        ordersOut = (data || []).map(shapeUserOrder);
    } else {
        const userIds = [...new Set((data || []).map(o => o.user_id).filter(Boolean))];
        let profilesById = {};
        if (userIds.length) {
            const { data: profiles } = await supabaseAdmin
                .from('profiles').select('id, username, email').in('id', userIds);
            for (const p of profiles || []) profilesById[p.id] = p;
        }
        ordersOut = (data || []).map(o => shapeOrder(o, profilesById[o.user_id]));
    }

    return {
        orders: ordersOut,
        count: count || 0, page, limit,
        totalPages: Math.ceil((count || 0) / limit),
        hasMore: page * limit < (count || 0),
        available: true
    };
}

async function getOrder(orderId) {
    if (!UUID_RE.test(String(orderId || ''))) {
        const e = new Error('Invalid order id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data: order, error } = await supabaseAdmin
        .from('boost_orders').select('*').eq('id', orderId).maybeSingle();
    if (error) { const e = new Error('Failed to load order.'); e.status = 500; e.code = 'BOOST_DETAIL_ERROR'; throw e; }
    if (!order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'BOOST_NOT_FOUND'; throw e; }

    let profile = null;
    if (order.user_id) {
        const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, status, created_at')
            .eq('id', order.user_id).maybeSingle();
        profile = p || null;
    }

    let transaction = null;
    try {
        const { data: t } = await supabaseAdmin
            .from('transactions')
            .select('id, ref, reference, type, status, currency, amount, description, created_at, completed_at')
            .eq('metadata->>order_id', order.id)
            .eq('type', 'boost')
            .maybeSingle();
        transaction = t || null;
    } catch (_) {}

    let refundTransaction = null;
    if (order.refund_reference) {
        try {
            const { data: t } = await supabaseAdmin
                .from('transactions')
                .select('id, ref, reference, type, status, currency, amount, description, created_at, completed_at')
                .eq('reference', order.refund_reference)
                .maybeSingle();
            refundTransaction = t || null;
        } catch (_) {}
    }

    return {
        order: shapeOrder(order, profile),
        user: profile,
        transaction,
        refund_transaction: refundTransaction
    };
}

// ─── Refund (atomic, idempotent) ────────────────────────────────

async function refundOrder({ orderId, reason, ctx, allowNonFailed = false, verifiedAtProvider = false }) {
    if (!UUID_RE.test(String(orderId || ''))) {
        const e = new Error('Invalid order id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    if (!reason || String(reason).trim().length < 4) {
        const e = new Error('A reason is required.'); e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }

    const { data: order, error } = await supabaseAdmin
        .from('boost_orders').select('*').eq('id', orderId).maybeSingle();
    if (error || !order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'BOOST_NOT_FOUND'; throw e; }

    if (order.refund_reference) {
        return { refund: { reference: order.refund_reference, amount: order.refund_amount || order.total_amount,
                           currency: order.currency, already_refunded: true } };
    }

    const status = String(order.status || '').toLowerCase();
    const refundable = allowNonFailed
        ? new Set(['failed', 'cancelled', 'provider_unknown', 'manual_review', 'partial'])
        : new Set(['failed', 'cancelled']);
    if (!refundable.has(status)) {
        const e = new Error(`Order status "${status}" is not refundable.`);
        e.status = 422; e.code = 'NOT_REFUNDABLE'; throw e;
    }

    // provider_unknown / manual_review / partial require verification.
    const needsVerify = ['provider_unknown', 'manual_review', 'partial'].includes(status);
    if (needsVerify && !verifiedAtProvider) {
        const e = new Error('Provider-verified refund requires verified_at_provider=true.');
        e.status = 422; e.code = 'VERIFICATION_REQUIRED'; throw e;
    }

    const refundRef = `BOOSTREF-${order.order_ref}`;
    const chargeAmount = Number(order.total_amount);
    const currency = order.currency;

    // 1. Claim the refund atomically in Postgres.
    const { data: rpcRow, error: rpcErr } = await supabaseAdmin.rpc('boost_finalize_refund_v2', {
        p_order_id: order.id,
        p_expected_status: status,
        p_refund_ref: refundRef,
        p_reason: String(reason).slice(0, 500)
    });

    if (rpcErr) {
        const msg = String(rpcErr.message || '');
        if (msg.includes('ORDER_STATE_CHANGED')) {
            const e = new Error('Order changed before the refund completed. Reload and try again.');
            e.status = 409; e.code = 'ORDER_STATE_CHANGED'; throw e;
        }
        const e = new Error('Failed to claim refund.');
        e.status = 500; e.code = 'REFUND_CLAIM_FAILED'; throw e;
    }

    const row = Array.isArray(rpcRow) ? rpcRow[0] : rpcRow;
    if (row?.already_refunded) {
        return { refund: { reference: refundRef, amount: Number(row.refund_amount || chargeAmount),
                           currency, already_refunded: true } };
    }

    // 2. Credit the wallet. Deterministic reference → idempotent.
    let creditResult = null;
    try {
        creditResult = await ledgerCredit({
            userId: order.user_id,
            amount: chargeAmount,
            currency,
            description: `Boost refund for ${order.order_ref}`,
            reference: refundRef,
            metadata: { type: 'boost_refund', order_id: order.id, order_ref: order.order_ref,
                        reason: String(reason).slice(0, 500) }
        });
    } catch (creditErr) {
        // Money did not move. The order is stuck as refunded with no
        // ledger row. reconcileRefunds() will credit it on the next
        // worker tick because it looks up by refund_reference.
        console.error('[BOOST] refund credit failed; reconciler will retry:', order.order_ref, creditErr.message);
        const e = new Error('Wallet refund deferred to reconciliation.');
        e.status = 202; e.code = 'REFUND_PENDING_RECONCILE';
        e.refund_reference = refundRef;
        throw e;
    }

    // 3. Best-effort side records + audit.
    try {
        await supabaseAdmin.from('transactions').insert({
            user_id: order.user_id, type: 'refund', status: 'completed',
            currency, amount: chargeAmount,
            ref: refundRef, reference: refundRef,
            source_id: order.id, source_type: 'boost_order',
            description: `Refund for boost ${order.order_ref}`,
            metadata: { order_id: order.id, order_ref: order.order_ref, reason: String(reason).slice(0, 500) },
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });
    } catch (txErr) {
        if (!String(txErr.message || '').includes('duplicate')) {
            console.warn('[BOOST] refund transaction insert failed:', txErr.message);
        }
    }

    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: order.user_id,
            title: 'Boost Refunded',
            message: `Your ${order.service_name} order ${order.order_ref} has been refunded.`,
            type: 'boost_refunded', icon: '💰', link: '/boost', is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (_) {}

    if (ctx) {
        try {
            await supabaseAdmin.from('admin_audit_logs').insert({
                admin_id: ctx.adminId || null, admin_email: ctx.adminEmail || null,
                action: 'boost.refund', target_type: 'boost_order', target_id: order.id,
                before: { status, refund_status: order.refund_status },
                after: { status: 'refunded', refund_reference: refundRef,
                         refund_amount: chargeAmount, verified_at_provider: verifiedAtProvider },
                reason: String(reason).slice(0, 500),
                ip_address: ctx.ip || null, user_agent: ctx.userAgent || null,
                request_id: ctx.requestId || null,
                created_at: new Date().toISOString()
            });
        } catch (e) { console.warn('[BOOST] audit insert failed:', e.message); }
    }

    return { refund: { reference: refundRef, amount: chargeAmount, currency, already_refunded: false } };
}

// Apply a partial refund: called by the sync worker when the provider
// reports Partial with a `remains` count. Idempotent via refund_ref.
async function applyPartialRefund({ orderId, remains, reason }) {
    if (!UUID_RE.test(String(orderId || ''))) {
        const e = new Error('Invalid order id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data: order, error } = await supabaseAdmin
        .from('boost_orders').select('*').eq('id', orderId).maybeSingle();
    if (error || !order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'BOOST_NOT_FOUND'; throw e; }

    const refundRef = `BOOSTPART-${order.order_ref}`;

    const { data: rpcRow, error: rpcErr } = await supabaseAdmin.rpc('boost_apply_partial_refund', {
        p_order_id: order.id,
        p_refund_ref: refundRef,
        p_remains: Number(remains) || 0
    });
    if (rpcErr) {
        const e = new Error('Failed to apply partial refund.');
        e.status = 500; e.code = 'PARTIAL_REFUND_FAILED'; throw e;
    }
    const row = Array.isArray(rpcRow) ? rpcRow[0] : rpcRow;
    const refundAmount = Number(row.refund_amount || 0);

    if (row.already_refunded || refundAmount <= 0) {
        return { refund: { reference: refundRef, amount: refundAmount,
                           currency: order.currency, already_refunded: !!row.already_refunded } };
    }

    try {
        await ledgerCredit({
            userId: order.user_id,
            amount: refundAmount,
            currency: order.currency,
            description: `Boost partial refund for ${order.order_ref}`,
            reference: refundRef,
            metadata: { type: 'boost_partial_refund', order_id: order.id,
                        order_ref: order.order_ref, remains, reason: reason || null }
        });
    } catch (creditErr) {
        console.error('[BOOST] partial refund credit failed; reconciler will retry:', order.order_ref, creditErr.message);
        const e = new Error('Wallet credit deferred to reconciliation.');
        e.status = 202; e.code = 'REFUND_PENDING_RECONCILE'; e.refund_reference = refundRef;
        throw e;
    }

    return { refund: { reference: refundRef, amount: refundAmount,
                       currency: order.currency, already_refunded: false } };
}

// ─── Status update ──────────────────────────────────────────────

async function updateOrderStatus({ orderId, status, note, ctx, verifiedAtProvider = false }) {
    if (!UUID_RE.test(String(orderId || ''))) {
        const e = new Error('Invalid order id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const next = String(status || '').toLowerCase();
    if (!ORDER_STATUSES.has(next)) {
        const e = new Error('Invalid status.'); e.status = 422; e.code = 'INVALID_STATUS'; throw e;
    }

    const { data: order } = await supabaseAdmin
        .from('boost_orders').select('*').eq('id', orderId).maybeSingle();
    if (!order) { const e = new Error('Order not found.'); e.status = 404; e.code = 'BOOST_NOT_FOUND'; throw e; }

    const current = String(order.status || '').toLowerCase();
    if (current === next) return { order: shapeOrder(order), no_op: true };

    const allowed = ALLOWED_TRANSITIONS[current] || [];
    if (!allowed.includes(next)) {
        const e = new Error(`Cannot transition from "${current}" to "${next}".`);
        e.status = 422; e.code = 'INVALID_STATUS_TRANSITION'; e.allowed_transitions = allowed;
        throw e;
    }

    const now = new Date().toISOString();
    const patch = { status: next, updated_at: now };
    if (note) patch.admin_note = String(note).slice(0, 1000);
    if (next === 'completed') patch.completed_at = now;
    if (next === 'failed' || next === 'cancelled') patch.failed_at = now;
    if (next === 'cancelled') patch.cancelled_at = now;
    if (next === 'refunded') {
        if (!verifiedAtProvider && ['provider_unknown', 'manual_review'].includes(current)) {
            const e = new Error('Refund of provider_unknown requires verification.');
            e.status = 422; e.code = 'VERIFICATION_REQUIRED'; throw e;
        }
        patch.verified_at_provider = verifiedAtProvider || order.verified_at_provider || false;
        patch.verified_at_provider_at = now;
        patch.verified_at_provider_by = ctx?.adminId || null;
    }

    const { data: updated, error: updErr } = await supabaseAdmin
        .from('boost_orders').update(patch).eq('id', orderId).eq('status', current)
        .select('*').maybeSingle();

    if (updErr) { const e = new Error('Failed to update order.'); e.status = 500; e.code = 'ORDER_UPDATE_FAILED'; throw e; }
    if (!updated) { const e = new Error('Order changed while editing.'); e.status = 409; e.code = 'ORDER_STATE_CHANGED'; throw e; }

    if (ctx) {
        try {
            await supabaseAdmin.from('admin_audit_logs').insert({
                admin_id: ctx.adminId || null, admin_email: ctx.adminEmail || null,
                action: `boost.status_${next}`, target_type: 'boost_order', target_id: order.id,
                before: { status: current }, after: { status: next },
                reason: note ? String(note).slice(0, 500) : null,
                ip_address: ctx.ip || null, user_agent: ctx.userAgent || null,
                request_id: ctx.requestId || null,
                created_at: new Date().toISOString()
            });
        } catch (e) { console.warn('[BOOST] audit insert failed:', e.message); }
    }

    return { order: shapeOrder(updated) };
}

// ─── Overview ──────────────────────────────────────────────────

async function getOverview(query = {}) {
    const range = String(query.range || '').toLowerCase();
    let fromIso, toIso;

    if (range === 'all') {
        // No date floor; use the beginning of time.
        fromIso = '1970-01-01T00:00:00.000Z';
        toIso = new Date().toISOString();
    } else if (query.from || query.to) {
        fromIso = lagosDayStart(query.from) || '1970-01-01T00:00:00.000Z';
        toIso = lagosDayEnd(query.to) || new Date().toISOString();
    } else {
        // No range and no explicit dates → default to today.
        fromIso = startOfWatDay();
        toIso = new Date().toISOString();
    }

    if (new Date(fromIso) > new Date(toIso)) {
        const e = new Error('Invalid range: from > to.'); e.status = 400; e.code = 'INVALID_RANGE'; throw e;
    }

    const rpc = await supabaseAdmin.rpc('boost_overview', { p_from: fromIso, p_to: toIso });
    if (!rpc.error && rpc.data) {
        const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
        return {
            total: Number(row.total || 0),
            pending: Number(row.pending || 0),
            processing: Number(row.processing || 0),
            completed: Number(row.completed || 0),
            failed: Number(row.failed || 0),
            refunded: Number(row.refunded || 0),
            revenueNgn: String(row.revenue_ngn || '0.00'),
            revenueUsd: String(row.revenue_usd || '0.00'),
            costNgn: String(row.cost_ngn || '0.00'),
            costUsd: String(row.cost_usd || '0.00'),
            profitNgn: String(row.profit_ngn || '0.00'),
            profitUsd: String(row.profit_usd || '0.00'),
            refundsNgn: String(row.refunds_ngn || '0.00'),
            refundsUsd: String(row.refunds_usd || '0.00'),
            uniqueCustomers: Number(row.unique_customers || 0),
            summaryAvailable: true,
            from: fromIso, to: toIso
        };
    }
    const e = new Error('Failed to aggregate overview.');
    e.status = 500; e.code = 'OVERVIEW_ERROR'; throw e;
}

// ─── User stats (RPC) ─────────────────────────────────────────

async function getUserStats(userId) {
    if (!userId || !UUID_RE.test(userId)) {
        const e = new Error('Invalid user.'); e.status = 400; e.code = 'INVALID_USER'; throw e;
    }
    const { data, error } = await supabaseAdmin.rpc('boost_user_stats', { p_user_id: userId });
    if (error) {
        const e = new Error('Failed to load boost stats.'); e.status = 500; e.code = 'STATS_ERROR'; throw e;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
        totalOrders:   Number(row?.total_orders || 0),
        completed:     Number(row?.completed || 0),
        pending:       Number(row?.pending || 0),
        processing:    Number(row?.processing || 0),
        failed:        Number(row?.failed || 0),
        totalSpentNGN: Number(row?.total_spent_ngn || 0),
        totalSpentUSD: Number(row?.total_spent_usd || 0)
    };
}

// ─── Services (admin) ──────────────────────────────────────────

async function listServices(query = {}, { withPricing = false } = {}) {
    const page = pageOf(query.page);
    const limit = limitOf(query.limit, 50, 200);
    const offset = (page - 1) * limit;

    let q = supabaseAdmin
        .from('boost_services')
        .select('*', { count: 'exact' })
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true })
        .range(offset, offset + limit - 1);

    if (query.active === 'true' || query.active === 'false') q = q.eq('active', query.active === 'true');
    if (query.visible === 'true' || query.visible === 'false') q = q.eq('visible_to_users', query.visible === 'true');
    if (query.platform && query.platform !== 'all') q = q.eq('platform', query.platform);
    if (query.category && query.category !== 'all') q = q.eq('category', query.category);
    if (query.search) {
        const safe = escapePostgrest(String(query.search).trim());
        q = q.or(`name.ilike.%${safe}%,provider_service_id.ilike.%${safe}%,description.ilike.%${safe}%`);
    }

    const { data, error, count } = await q;
    if (error) {
        if (error.code === '42P01') {
            return { services: [], count: 0, page, limit, totalPages: 0, available: false };
        }
        const e = new Error('Failed to load services.'); e.status = 500; e.code = 'SERVICE_LIST_ERROR'; throw e;
    }

    let out = data || [];
    if (withPricing && out.length) {
        const ctx = await getPricingContext();
        out = out.map(s => {
            const p = computeServicePrice(s, ctx);
            return {
                ...s,
                effective: {
                    source: p.source,
                    usd_per_1k: p.usd_per_1k ? Number(p.usd_per_1k.toFixed(4)) : null,
                    ngn_per_1k: p.ngn_per_1k ? Number(p.ngn_per_1k.toFixed(2)) : null,
                    margin_pct: p.margin_pct != null ? Number((p.margin_pct * 100).toFixed(2)) : null,
                    below_cost: p.below_cost
                }
            };
        });
    }

    return {
        services: out, count: count || 0, page, limit,
        totalPages: Math.ceil((count || 0) / limit),
        available: true
    };
}

const ALLOWED_SERVICE_FIELDS = [
    'name', 'description', 'platform', 'category', 'active', 'visible_to_users',
    'markup_percent', 'custom_price', 'min_quantity', 'max_quantity', 'sort_order',
    'refill_allowed', 'refill_days', 'dripfeed_allowed', 'average_time'
];

function validateServicePatch(patch, { currentRow = null } = {}) {
    const clean = {};
    for (const k of ALLOWED_SERVICE_FIELDS) if (patch[k] !== undefined) clean[k] = patch[k];

    if (clean.name !== undefined) {
        clean.name = String(clean.name).trim();
        if (clean.name.length < 2 || clean.name.length > 200) {
            const e = new Error('Name must be 2–200 characters.'); e.status = 422; e.code = 'INVALID_NAME'; throw e;
        }
    }
    if (clean.platform !== undefined) {
        clean.platform = String(clean.platform).toLowerCase();
        if (!ALLOWED_PLATFORMS.has(clean.platform)) {
            const e = new Error('Invalid platform.'); e.status = 422; e.code = 'INVALID_PLATFORM'; throw e;
        }
    }
    if (clean.category !== undefined) {
        clean.category = String(clean.category).toLowerCase();
        if (!ALLOWED_CATEGORIES.has(clean.category)) clean.category = 'other';
    }
    if (clean.markup_percent !== undefined && clean.markup_percent !== null) {
        const n = Number(clean.markup_percent);
        if (!Number.isFinite(n) || n < 0 || n > 20) {
            const e = new Error('Markup must be between 0 and 20 (0% to 2000%).');
            e.status = 422; e.code = 'INVALID_MARKUP'; throw e;
        }
        clean.markup_percent = n;
    }
    if (clean.custom_price !== undefined) {
        if (clean.custom_price === null) {
            clean.custom_price = null;
        } else {
            const n = Number(clean.custom_price);
            if (!Number.isFinite(n) || n <= 0) {
                const e = new Error('Custom price must be positive.');
                e.status = 422; e.code = 'INVALID_CUSTOM_PRICE'; throw e;
            }
            clean.custom_price = n;
        }
    }
    if (clean.min_quantity !== undefined && clean.min_quantity !== null) {
        const n = parseInt(clean.min_quantity, 10);
        if (!Number.isInteger(n) || n < 1) {
            const e = new Error('Min quantity must be a positive integer.'); e.status = 422; e.code = 'INVALID_MIN'; throw e;
        }
        clean.min_quantity = n;
    }
    if (clean.max_quantity !== undefined && clean.max_quantity !== null) {
        const n = parseInt(clean.max_quantity, 10);
        if (!Number.isInteger(n) || n < 1) {
            const e = new Error('Max quantity must be a positive integer.'); e.status = 422; e.code = 'INVALID_MAX'; throw e;
        }
        clean.max_quantity = n;
    }
    const mergedMin = clean.min_quantity !== undefined ? clean.min_quantity : (currentRow?.min_quantity ?? null);
    const mergedMax = clean.max_quantity !== undefined ? clean.max_quantity : (currentRow?.max_quantity ?? null);
    if (mergedMin != null && mergedMax != null && mergedMin > mergedMax) {
        const e = new Error('Min quantity must be ≤ max quantity.'); e.status = 422; e.code = 'INVALID_QUANTITY_RANGE'; throw e;
    }
    if (clean.active === true && currentRow) {
        const rate = Number(currentRow.provider_rate || 0);
        if (!Number.isFinite(rate) || rate <= 0) {
            const e = new Error('Cannot activate a service with no provider rate.');
            e.status = 422; e.code = 'NO_PROVIDER_RATE'; throw e;
        }
    }
    return clean;
}

async function updateService({ serviceId, patch, ctx }) {
    if (!UUID_RE.test(String(serviceId || ''))) {
        const e = new Error('Invalid service id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const { data: before } = await supabaseAdmin
        .from('boost_services').select('*').eq('id', serviceId).maybeSingle();
    if (!before) { const e = new Error('Service not found.'); e.status = 404; e.code = 'SERVICE_NOT_FOUND'; throw e; }

    const clean = validateServicePatch(patch, { currentRow: before });
    if (!Object.keys(clean).length) {
        const e = new Error('No recognized fields to update.'); e.status = 422; e.code = 'EMPTY_PATCH'; throw e;
    }
    clean.updated_at = new Date().toISOString();

    const { data: updated, error } = await supabaseAdmin
        .from('boost_services').update(clean).eq('id', serviceId).select('*').single();
    if (error) { const e = new Error('Failed to update service.'); e.status = 500; e.code = 'SERVICE_UPDATE_FAILED'; throw e; }

    if (ctx) {
        try {
            await supabaseAdmin.from('admin_audit_logs').insert({
                admin_id: ctx.adminId || null, admin_email: ctx.adminEmail || null,
                action: 'boost.service_update', target_type: 'boost_service', target_id: serviceId,
                before: { name: before.name, active: before.active, visible_to_users: before.visible_to_users,
                          markup_percent: before.markup_percent, custom_price: before.custom_price },
                after: clean,
                ip_address: ctx.ip || null, user_agent: ctx.userAgent || null,
                created_at: new Date().toISOString()
            });
        } catch (_) {}
    }

    invalidateCatalog();
    return { service: updated };
}

async function bulkUpdateServices({ ids, filters, patch, ctx }) {
    const clean = validateServicePatch(patch || {});
    if (!Object.keys(clean).length) {
        const e = new Error('No fields to update.'); e.status = 422; e.code = 'EMPTY_PATCH'; throw e;
    }

    // "Turn on" must set both active and visible_to_users.
    if (clean.active === true && clean.visible_to_users === undefined) {
        clean.visible_to_users = true;
    }

    clean.updated_at = new Date().toISOString();

    let q = supabaseAdmin.from('boost_services').update(clean);

    if (Array.isArray(ids) && ids.length) {
        const safeIds = ids.filter(i => UUID_RE.test(String(i)));
        if (!safeIds.length) {
            const e = new Error('No valid ids.'); e.status = 422; e.code = 'INVALID_IDS'; throw e;
        }
        q = q.in('id', safeIds);
    } else if (filters && typeof filters === 'object') {
        if (filters.active === 'true' || filters.active === 'false') q = q.eq('active', filters.active === 'true');
        if (filters.visible === 'true' || filters.visible === 'false') q = q.eq('visible_to_users', filters.visible === 'true');
        if (filters.platform && filters.platform !== 'all') q = q.eq('platform', filters.platform);
        if (filters.category && filters.category !== 'all') q = q.eq('category', filters.category);
        if (filters.search) {
            const safe = escapePostgrest(String(filters.search).trim());
            q = q.or(`name.ilike.%${safe}%,provider_service_id.ilike.%${safe}%`);
        }
    } else {
        const e = new Error('Provide ids or filters.'); e.status = 422; e.code = 'BULK_TARGET_REQUIRED'; throw e;
    }

    const { data, error } = await q.select('id');
    if (error) { const e = new Error('Bulk update failed.'); e.status = 500; e.code = 'BULK_UPDATE_FAILED'; throw e; }

    if (ctx) {
        try {
            await supabaseAdmin.from('admin_audit_logs').insert({
                admin_id: ctx.adminId || null, admin_email: ctx.adminEmail || null,
                action: 'boost.services_bulk_update', target_type: 'boost_service',
                target_id: Array.isArray(ids) && ids.length ? `ids:${ids.length}` : 'filters',
                after: { patch: clean, count: data?.length || 0 },
                ip_address: ctx.ip || null, user_agent: ctx.userAgent || null,
                created_at: new Date().toISOString()
            });
        } catch (_) {}
    }

    invalidateCatalog();
    return { updated: data?.length || 0 };
}

// ─── Admin config (read / save) ─────────────────────────────────

async function getAdminConfig() {
    const reg = adminSettings.KEY_REGISTRY || {};
    let usdToNgn = null;
    try { usdToNgn = Number(await adminSettings.getRate('USD', 'NGN')); } catch (_) {}

    let globalMarkupPct = null;
    try {
        const raw = await adminSettings.getRaw('boost_markup_pct');
        const n = Number(raw);
        if (Number.isFinite(n)) globalMarkupPct = Number((n * 100).toFixed(2));
    } catch (_) {}

    const enabled = await readBoostEnabled();
    let minNgn = null, maxNgn = null;
    if (reg.boost_min_ngn) { try { const n = Number(await adminSettings.getRaw('boost_min_ngn')); if (Number.isFinite(n)) minNgn = n; } catch (_) {} }
    if (reg.boost_max_ngn) { try { const n = Number(await adminSettings.getRaw('boost_max_ngn')); if (Number.isFinite(n)) maxNgn = n; } catch (_) {} }

    let allowNgn = true, allowUsd = true;
    if (reg.boost_allow_ngn) { try { allowNgn = await adminSettings.getBoolean('boost_allow_ngn'); } catch (_) {} }
    if (reg.boost_allow_usd) { try { allowUsd = await adminSettings.getBoolean('boost_allow_usd'); } catch (_) {} }

    let version = null;
    try { const v = await adminSettings.getRaw('config_version'); if (v != null) version = Number(v); } catch (_) {}

    return {
        usd_to_ngn: usdToNgn,
        markup_percent: globalMarkupPct,
        min_ngn: minNgn,
        max_ngn: maxNgn,
        enabled,
        allow_ngn: allowNgn,
        allow_usd: allowUsd,
        version,
        missing_settings: [
            !reg.boost_allow_ngn ? 'boost_allow_ngn' : null,
            !reg.boost_allow_usd ? 'boost_allow_usd' : null,
            !reg.boost_min_ngn ? 'boost_min_ngn' : null,
            !reg.boost_max_ngn ? 'boost_max_ngn' : null
        ].filter(Boolean)
    };
}

async function saveAdminConfig({ changes, reason, expectedVersion, confirmLargeChange, ctx }) {
    if (!changes || typeof changes !== 'object') {
        const e = new Error('changes object is required.'); e.status = 422; e.code = 'INVALID_PATCH'; throw e;
    }

    const patch = {};
    if (changes.usd_to_ngn !== undefined) {
        const n = Number(changes.usd_to_ngn);
        if (!Number.isFinite(n) || n <= 0) {
            const e = new Error('USD→NGN rate must be positive.'); e.status = 422; e.code = 'INVALID_RATE'; throw e;
        }
        patch.usd_to_ngn = String(n);
    }
    if (changes.markup_percent !== undefined) {
        const n = Number(changes.markup_percent);
        if (!Number.isFinite(n) || n < 0 || n > 2000) {
            const e = new Error('Markup must be between 0 and 2000%.'); e.status = 422; e.code = 'INVALID_MARKUP'; throw e;
        }
        // UI sends percent (18); registry stores decimal (0.1800).
        patch.boost_markup_pct = String((n / 100).toFixed(4));
    }
    if (changes.enabled !== undefined) patch.service_boost_enabled = String(!!changes.enabled);
    if (changes.allow_ngn !== undefined) {
        if (!adminSettings.KEY_REGISTRY.boost_allow_ngn) {
            const e = new Error('boost_allow_ngn is not registered.'); e.status = 422; e.code = 'SETTING_NOT_REGISTERED'; throw e;
        }
        patch.boost_allow_ngn = String(!!changes.allow_ngn);
    }
    if (changes.allow_usd !== undefined) {
        if (!adminSettings.KEY_REGISTRY.boost_allow_usd) {
            const e = new Error('boost_allow_usd is not registered.'); e.status = 422; e.code = 'SETTING_NOT_REGISTERED'; throw e;
        }
        patch.boost_allow_usd = String(!!changes.allow_usd);
    }
    if (changes.min_ngn !== undefined) {
        if (!adminSettings.KEY_REGISTRY.boost_min_ngn) {
            const e = new Error('boost_min_ngn is not registered.'); e.status = 422; e.code = 'SETTING_NOT_REGISTERED'; throw e;
        }
        const n = Number(changes.min_ngn);
        if (!Number.isFinite(n) || n < 0) {
            const e = new Error('Min ₦ must be non-negative.'); e.status = 422; e.code = 'INVALID_MIN'; throw e;
        }
        patch.boost_min_ngn = String(n.toFixed(2));
    }
    if (changes.max_ngn !== undefined) {
        if (!adminSettings.KEY_REGISTRY.boost_max_ngn) {
            const e = new Error('boost_max_ngn is not registered.'); e.status = 422; e.code = 'SETTING_NOT_REGISTERED'; throw e;
        }
        const n = Number(changes.max_ngn);
        if (!Number.isFinite(n) || n < 0) {
            const e = new Error('Max ₦ must be non-negative.'); e.status = 422; e.code = 'INVALID_MAX'; throw e;
        }
        patch.boost_max_ngn = String(n.toFixed(2));
    }

    if (!Object.keys(patch).length) {
        const e = new Error('No recognized fields to save.'); e.status = 422; e.code = 'EMPTY_PATCH'; throw e;
    }

    const result = await adminSettings.patchSettings(patch, {
        adminId: ctx.adminId,
        adminEmail: ctx.adminEmail,
        reason: reason || null,
        ip: ctx.ip || null,
        userAgent: ctx.userAgent || null,
        expectedVersion: expectedVersion != null ? String(expectedVersion) : null
    }, {
        expectedVersion: expectedVersion != null ? String(expectedVersion) : null,
        confirmLargeChange: !!confirmLargeChange
    });

    invalidateCatalog();
    return result;
}

// ─── Alerts ────────────────────────────────────────────────────

async function getAlerts(providerBalanceUsd = null) {
    const { data, error } = await supabaseAdmin.rpc('boost_alerts', {
        p_provider_balance_usd: providerBalanceUsd
    });
    if (error) {
        const e = new Error('Failed to load alerts.'); e.status = 500; e.code = 'ALERTS_ERROR'; throw e;
    }
    return data || {};
}

// ─── Exports ────────────────────────────────────────────────────

module.exports = {
    // Constants
    ORDER_STATUSES,
    ALLOWED_TRANSITIONS,
    PENDING_STATUSES,
    FAILED_STATUSES,
    SUCCESS_STATUSES,
    TERMINAL_STATUSES,
    ACTIVE_STATUSES,
    FORWARD_ONLY_FROM_PROVIDER,

    // Public / user
    getPricingContext,
    getPublicCatalog,
    getPublicService,
    getPublicConfig,
    quote,
    placeOrder,
    listOrders,
    getOrder,
    refundOrder,
    applyPartialRefund,
    updateOrderStatus,
    getOverview,
    getUserStats,

    // Admin
    listServices,
    updateService,
    bulkUpdateServices,
    getAdminConfig,
    saveAdminConfig,
    getAlerts,

    // Reconcilers (called from worker + route fallbacks)
    reconcileAwaitingPayment,
    reconcileRefunds,

    // Cache
    invalidateCatalog,

    // Shape
    shapeOrder,
    shapeUserOrder,

    // Internal helpers exposed for tests
    _internal: {
        normaliseLink,
        validateLinkForPlatform,
        computeServicePrice,
        computeCharge,
        roundUp2,
        escapePostgrest
    }
};