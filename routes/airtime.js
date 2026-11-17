// routes/airtime.js
// PRODUCTION-READY DT ONE AIRTIME ROUTES — Batch 7
//
// PRICING AUTHORITY: services/airtimePricing.js (BigInt only).
// ROUTING: services/airtimeService.js#resolveProvider.
// LEDGER: LedgerService.debitWallet / creditWallet — object signature.
// IDEMPOTENCY: IdempotencyService.check / claim / save / release.
//
// Batch 7 changes (2026-11-08):
//   + GET /by-key/:idempotencyKey — declared BEFORE /:reference so
//     Express doesn't treat 'by-key' as a reference. Used by the
//     front-end recovery flow (Airplane Mode mid-purchase).
//   + NGA global-topup gate. NGA is attempted via DT One by default;
//     USE_LOCAL_AIRTIME is returned ONLY when DT One cannot fulfil.
//     Restore the old hard-block by setting
//     app_config.airtime_global_allow_nga = 'false'.
//   + Separate rate-limit buckets for /availability and /preflight
//     (60 req/min/user each). Legacy rateLimitAirtime kept as an
//     alias for the generic bucket.
//   + /preflight accepts wallet_type omitted (default 'USD').
//
// Batch 8 changes (2026-11-10):
//   + Mirror every DT One airtime purchase into `orders` so Admin →
//     Orders and Revenue analytics see them. recordOrder() is
//     idempotent on (source_table='airtime_transactions', source_id).
//   + Writes on pending, completed, failed, provider_unknown. Never
//     blocks the purchase — recordOrder failures are logged only.
// ─────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { parsePhoneNumberFromString, getCountryCallingCode } = require('libphonenumber-js');
const countriesLib = require('i18n-iso-countries');

const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { LedgerService } = require('../services/ledgerService');
const IdempotencyService = require('../services/idempotencyService');
const dtoneService = require('../services/dtoneService');
const cacheService = require('../services/cacheService');
const airtimeReconciliation = require('../services/airtimeReconciliationService');
const adminSettings = require('../services/adminSettingsService');
const airtimePricing = require('../services/airtimePricing');
const airtimeService = require('../services/airtimeService');

// ★ NEW: order mirroring
const fulfillment = require('../services/billsFulfillment');
const recordOrder = (data) => fulfillment.recordOrder(data);

countriesLib.registerLocale(require('i18n-iso-countries/langs/en.json'));

// ─── SANITY: fail fast ───────────────────────────────────────────
(function verifyDependencies() {
    const checks = [
        ['supabaseAdmin', supabaseAdmin, 'object'],
        ['authMiddleware', authMiddleware, 'function'],
        ['LedgerService.getAllBalances', LedgerService?.getAllBalances, 'function'],
        ['LedgerService.debitWallet', LedgerService?.debitWallet, 'function'],
        ['LedgerService.creditWallet', LedgerService?.creditWallet, 'function'],
        ['IdempotencyService.check', IdempotencyService?.check, 'function'],
        ['IdempotencyService.claim', IdempotencyService?.claim, 'function'],
        ['IdempotencyService.release', IdempotencyService?.release, 'function'],
        ['IdempotencyService.save', IdempotencyService?.save, 'function'],
        ['dtoneService.getOperators', dtoneService?.getOperators, 'function'],
        ['dtoneService.createQuote', dtoneService?.createQuote, 'function'],
        ['dtoneService.confirmTransaction', dtoneService?.confirmTransaction, 'function'],
        ['airtimePricing.quoteGlobal', airtimePricing?.quoteGlobal, 'function'],
        ['airtimePricing.getAirtimeConfig', airtimePricing?.getAirtimeConfig, 'function'],
        ['airtimePricing.buildSnapshotGlobal', airtimePricing?.buildSnapshotGlobal, 'function'],
        ['airtimeService.resolveProvider', airtimeService?.resolveProvider, 'function'],
        ['fulfillment.recordOrder', fulfillment?.recordOrder, 'function']   // ★ NEW
    ];
    const missing = checks.filter(([, value, kind]) => typeof value !== kind);
    if (missing.length) {
        throw new Error(`[airtime] Missing dependencies: ${missing.map(([n]) => n).join(', ')}`);
    }
    console.log('✅ [airtime] All dependencies verified');
})();

// ─── INVARIANT CONSTANTS ─────────────────────────────────────────
const MAX_PIN_ATTEMPTS    = 4;
const PIN_LOCK_DURATION   = 60 * 60 * 1000;
const MAX_PROCESSING_MS   = 25 * 60 * 1000;
const DTONE_WEBHOOK_SECRET = process.env.DTONE_WEBHOOK_SECRET || null;
const IS_PRODUCTION        = process.env.NODE_ENV === 'production';

if (IS_PRODUCTION && !DTONE_WEBHOOK_SECRET) {
    throw new Error('[airtime] DTONE_WEBHOOK_SECRET required in production');
}

// ─── LOCAL CURRENCY FX ───────────────────────────────────────────
const USD_TO_LOCAL = {
    USD: 1,
    NGN: Number(process.env.MILESSPACE_USD_TO_NGN || 1600),
    GHS: Number(process.env.MILESSPACE_USD_TO_GHS || 15),
    KES: Number(process.env.MILESSPACE_USD_TO_KES || 129),
    ZAR: Number(process.env.MILESSPACE_USD_TO_ZAR || 18),
    INR: Number(process.env.MILESSPACE_USD_TO_INR || 83),
    AFN: Number(process.env.MILESSPACE_USD_TO_AFN || 70),
    EUR: Number(process.env.MILESSPACE_USD_TO_EUR || 0.92),
    GBP: Number(process.env.MILESSPACE_USD_TO_GBP || 0.79),
    PHP: Number(process.env.MILESSPACE_USD_TO_PHP || 58),
    IDR: Number(process.env.MILESSPACE_USD_TO_IDR || 16000),
    VND: Number(process.env.MILESSPACE_USD_TO_VND || 25000),
    PKR: Number(process.env.MILESSPACE_USD_TO_PKR || 278),
    BDT: Number(process.env.MILESSPACE_USD_TO_BDT || 120),
    EGP: Number(process.env.MILESSPACE_USD_TO_EGP || 49),
    TRY: Number(process.env.MILESSPACE_USD_TO_TRY || 34),
    MXN: Number(process.env.MILESSPACE_USD_TO_MXN || 20),
    BRL: Number(process.env.MILESSPACE_USD_TO_BRL || 5.5),
    RUB: Number(process.env.MILESSPACE_USD_TO_RUB || 95)
};
function getLocalRate(c) {
    const rate = USD_TO_LOCAL[String(c || '').toUpperCase()];
    return Number.isFinite(rate) && rate > 0 ? rate : null;
}

// ─── CACHES ──────────────────────────────────────────────────────
const inflightOperators = new Map();
const swrOperators = new Map();
const SWR_TTL_MS = 30 * 60 * 1000;
const productCache = new Map();
const productInflight = new Map();
const PRODUCT_TTL_MS = 5 * 60 * 1000;
let adminReconcileRunning = false;

// ─── RATE LIMIT ──────────────────────────────────────────────────
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX       = 60;
const rlBuckets = new Map();

function makeRateLimiter(bucketName) {
    return function rateLimit(req, res, next) {
        const userId = req.user?.id || req.ip || 'anon';
        const key = `${bucketName}:${userId}`;
        const now = Date.now();
        let bucket = rlBuckets.get(key);
        if (!bucket || now - bucket.start >= RL_WINDOW_MS) {
            bucket = { start: now, count: 0 };
            rlBuckets.set(key, bucket);
        }
        bucket.count++;
        if (bucket.count > RL_MAX) {
            const retryAfter = Math.ceil((RL_WINDOW_MS - (now - bucket.start)) / 1000);
            res.setHeader('Retry-After', String(retryAfter));
            return res.status(429).json({
                success: false,
                error: 'Too many requests. Please slow down.',
                code: 'RATE_LIMITED',
                retry_after_seconds: retryAfter
            });
        }
        next();
    };
}
const rateLimitAvailability = makeRateLimiter('availability');
const rateLimitPreflight    = makeRateLimiter('preflight');
const rateLimitAirtime      = makeRateLimiter('generic');

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rlBuckets.entries()) {
        if (now - v.start > RL_WINDOW_MS * 2) rlBuckets.delete(k);
    }
}, RL_WINDOW_MS * 2).unref?.();

// ─── HELPERS ─────────────────────────────────────────────────────
function generateReference() {
    return `AT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}
function maskPhone(phone) {
    return phone ? `****${String(phone).slice(-4)}` : 'N/A';
}
function getFlagFromAlpha3(alpha3) {
    try {
        const alpha2 = countriesLib.alpha3ToAlpha2(alpha3);
        if (!alpha2) return '🌐';
        return alpha2.toUpperCase().split('').map(c =>
            String.fromCodePoint(127397 + c.charCodeAt(0))
        ).join('');
    } catch { return '🌐'; }
}

function getDialCode(alpha3) {
    try {
        const alpha2 = countriesLib.alpha3ToAlpha2(alpha3);
        if (!alpha2) return '';
        const code = getCountryCallingCode(alpha2);
        return code ? '+' + code : '';
    } catch { return ''; }
}

function normalizeCountryCodes(value) {
    if (!value) return null;
    const input = String(value).trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(input)) return { iso3: input, iso2: countriesLib.alpha3ToAlpha2(input) || null };
    if (/^[A-Z]{2}$/.test(input)) return { iso2: input, iso3: countriesLib.alpha2ToAlpha3(input) || null };
    return null;
}
function getPublicCallbackUrl() {
    const appUrl = process.env.APP_URL;
    if (!appUrl) return undefined;
    const base = String(appUrl).replace(/\/+$/, '');
    if (!/^https:\/\//i.test(base)) return undefined;
    const lower = base.toLowerCase();
    if (lower.includes('localhost') || lower.includes('127.0.0.1') ||
        lower.includes('0.0.0.0') || lower.includes('::1') ||
        /\.local(\/|$)/.test(lower)) return undefined;
    return `${base}/api/airtime/webhook`;
}

// ─── NORMALIZERS ─────────────────────────────────────────────────
function normalizeOperatorList(raw) {
    const list = Array.isArray(raw) ? raw
        : Array.isArray(raw?.data) ? raw.data
        : Array.isArray(raw?.operators) ? raw.operators
        : Array.isArray(raw?.results) ? raw.results
        : null;
    if (!list) throw new Error('Unexpected DT One operators response shape');
    return list.filter(op => op && op.id != null && String(op.id).trim() !== '')
        .map(op => ({ ...op, id: String(op.id), name: String(op.name || `Operator ${op.id}`).trim() }));
}
function normalizeCountryList(raw) {
    const list = Array.isArray(raw) ? raw
        : Array.isArray(raw?.data) ? raw.data
        : Array.isArray(raw?.results) ? raw.results
        : [];
    const mapped = list.map(c => {
        if (!c) return null;
        const alpha3 = String(c.iso3 || c.iso_code || c.country_iso_code || c.code || '').trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(alpha3)) return null;
        const name = String(c.name || c.country_name || '').trim();
        if (!name) return null;
        return { iso3: alpha3, name };
    }).filter(Boolean);
    if (!mapped.length) throw new Error('No valid countries returned by DT One');
    return mapped;
}

// ─── CACHED CATALOG ──────────────────────────────────────────────
async function getCachedCountries() {
    return await cacheService.getOrSet('dtone_countries_v27', async () => {
        const raw = await dtoneService.getCountries('AIRTIME');
        const normalized = normalizeCountryList(raw);
        const mapped = normalized.map(c => ({
            code: c.iso3,
            iso3: c.iso3,
            iso2: countriesLib.alpha3ToAlpha2(c.iso3) || null,
            name: c.name,
            flag: getFlagFromAlpha3(c.iso3),
            dial: getDialCode(c.iso3),
            local: c.iso3 === 'NGA'
        }));
        mapped.sort((a, b) => a.name.localeCompare(b.name));
        console.info('[AIRTIME] Country catalog loaded', { count: mapped.length });
        return mapped;
    }, 24 * 60 * 60);
}

async function getCachedOperators(countryIso3) {
    const country = String(countryIso3 || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(country)) throw new Error(`Invalid ISO-3: ${country}`);
    return cacheService.getOrSet(`dtone_operators_v23_${country}`, async () => {
        const lite = typeof dtoneService.getOperatorsLite === 'function'
            ? await dtoneService.getOperatorsLite(country, 'AIRTIME')
            : await dtoneService.getOperators(country, 'AIRTIME');
        const operators = normalizeOperatorList(lite);
        if (!operators.length) throw new Error(`No airtime operators for ${country}`);
        console.info('[AIRTIME] Operators loaded', { country, count: operators.length });

        setImmediate(() => {
            const warm = operators.slice(0, 6);
            for (const op of warm) {
                getCachedAirtimeProducts(country, op.id).catch(() => {});
            }
        });

        return operators;
    }, 60 * 60);
}
async function getCachedOperatorsFast(countryIso3) {
    const country = String(countryIso3 || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(country)) throw new Error(`Invalid ISO-3: ${country}`);
    const cached = swrOperators.get(country);
    if (cached && Date.now() - cached.time < SWR_TTL_MS) return cached.data;
    if (inflightOperators.has(country)) return inflightOperators.get(country);
    const promise = (async () => {
        try {
            const fresh = await getCachedOperators(country);
            swrOperators.set(country, { data: fresh, time: Date.now() });
            return fresh;
        } finally { inflightOperators.delete(country); }
    })();
    inflightOperators.set(country, promise);
    if (cached && Array.isArray(cached.data) && cached.data.length) return cached.data;
    return promise;
}
async function getAirtimeProductsForOperator(iso3, operatorId) {
    const method = dtoneService.getProductsRaw || dtoneService.getProducts || dtoneService.getProductsForOperator;
    if (typeof method !== 'function') throw new Error('dtoneService has no product-fetch method');
    return await method.call(dtoneService, {
        countryIsoCode: iso3, operatorId: Number(operatorId),
        serviceId: 1, subserviceId: 11
    });
}
async function getCachedAirtimeProducts(iso3, operatorId) {
    const key = `${String(iso3).toUpperCase()}:${operatorId}`;
    const hit = productCache.get(key);
    if (hit && Date.now() - hit.time < PRODUCT_TTL_MS) return hit.data;
    if (productInflight.has(key)) return productInflight.get(key);
    const promise = (async () => {
        try {
            const products = await getAirtimeProductsForOperator(iso3, operatorId);
            if (Array.isArray(products) && products.length > 0) {
                productCache.set(key, { data: products, time: Date.now() });
            }
            return products;
        } finally { productInflight.delete(key); }
    })();
    productInflight.set(key, promise);
    return promise;
}

// ─── PRODUCT SELECTOR ────────────────────────────────────────────
function pickAirtimeProductWithoutAmount({ products }) {
    if (!Array.isArray(products) || !products.length) {
        const err = new Error('This network currently has no available products');
        err.code = 'NO_PRODUCTS'; throw err;
    }
    const rangedSource = products.filter(p => {
        if (p.type !== 'RANGED_VALUE_RECHARGE') return false;
        const modes = Array.isArray(p.accepted_calculation_modes) ? p.accepted_calculation_modes : [];
        return modes.includes('SOURCE_AMOUNT');
    });
    let selectedProduct = rangedSource.find(p =>
        String(p.source?.unit || '').toUpperCase() === 'USD');
    let sourceCurrency = 'USD', needsConversion = false, rate = 1;
    if (!selectedProduct) {
        for (const candidate of rangedSource) {
            const cur = String(candidate.source?.unit || '').toUpperCase();
            const r = getLocalRate(cur);
            if (r) { selectedProduct = candidate; sourceCurrency = cur; needsConversion = true; rate = r; break; }
        }
    }
    if (!selectedProduct) {
        const err = new Error('This network does not support variable recharge amounts.');
        err.code = 'RANGED_NOT_SUPPORTED'; throw err;
    }
    const pMin = Number(selectedProduct.source?.amount?.min);
    const pMax = Number(selectedProduct.source?.amount?.max);
    return {
        selectedProduct, sourceCurrency, needsConversion, rate,
        minUsd: Number.isFinite(pMin) ? Number((needsConversion ? pMin / rate : pMin).toFixed(2)) : null,
        maxUsd: Number.isFinite(pMax) ? Number((needsConversion ? pMax / rate : pMax).toFixed(2)) : null,
        destinationCurrency: String(
            selectedProduct.destination?.unit ||
            products.find(p => p.destination?.unit)?.destination?.unit ||
            ''
        ).toUpperCase() || null,
        ratePerUsd: (() => {
            const sMax = Number(selectedProduct.source?.amount?.max);
            const dMax = Number(selectedProduct.destination?.amount?.max);
            if (!Number.isFinite(sMax) || !Number.isFinite(dMax) || sMax <= 0) return null;
            const sMaxUsd = needsConversion && rate > 0 ? sMax / rate : sMax;
            if (!Number.isFinite(sMaxUsd) || sMaxUsd <= 0) return null;
            return dMax / sMaxUsd;
        })()
    };
}

function selectAirtimeProduct({ products, srcAmountUSD }) {
    const base = pickAirtimeProductWithoutAmount({ products });
    const { selectedProduct, sourceCurrency, needsConversion, rate } = base;
    const sourceAmountForProvider = needsConversion
        ? Math.round(srcAmountUSD * rate)
        : srcAmountUSD;
    const pMin = Number(selectedProduct.source?.amount?.min);
    const pMax = Number(selectedProduct.source?.amount?.max);
    if (Number.isFinite(pMin) && sourceAmountForProvider < pMin) {
        const humanMin = needsConversion ? (pMin / rate).toFixed(2) : pMin.toFixed(2);
        const err = new Error(`Minimum amount is $${humanMin}`);
        err.code = 'AMOUNT_BELOW_MIN'; err.min_amount_usd = Number(humanMin); throw err;
    }
    if (Number.isFinite(pMax) && sourceAmountForProvider > pMax) {
        const humanMax = needsConversion ? (pMax / rate).toFixed(2) : pMax.toFixed(2);
        const err = new Error(`Maximum amount is $${humanMax}`);
        err.code = 'AMOUNT_ABOVE_MAX'; err.max_amount_usd = Number(humanMax); throw err;
    }
    return { ...base, sourceAmountForProvider };
}

// ─── PIN ─────────────────────────────────────────────────────────
async function verifyTransactionPin(userId, pin) {
    if (!userId) return { valid: false, error: 'User ID required', code: 'USER_ID_REQUIRED' };
    if (!pin || !/^\d{4}$/.test(String(pin))) {
        return { valid: false, error: 'PIN must be exactly 4 digits', code: 'INVALID_FORMAT' };
    }
    const { data: profile, error } = await supabaseAdmin
        .from('profiles')
        .select('transaction_pin_hash, transaction_pin_attempts, transaction_pin_locked_until')
        .eq('id', userId).single();
    if (error || !profile) return { valid: false, error: 'User not found', code: 'USER_NOT_FOUND' };
    if (!profile.transaction_pin_hash) return { valid: false, error: 'PIN not set', code: 'PIN_NOT_SET', pinNotSet: true };
    if (profile.transaction_pin_locked_until) {
        const lockUntil = new Date(profile.transaction_pin_locked_until);
        if (lockUntil > new Date()) {
            const mins = Math.ceil((lockUntil.getTime() - Date.now()) / 60000);
            return { valid: false, error: `Try again in ${mins} minute(s).`, code: 'PIN_LOCKED', remaining_minutes: mins, can_reset: true };
        }
        await supabaseAdmin.from('profiles')
            .update({ transaction_pin_attempts: 0, transaction_pin_locked_until: null })
            .eq('id', userId);
    }
    const isValid = await bcrypt.compare(String(pin), profile.transaction_pin_hash);
    if (!isValid) {
        let rpcRes = null, rpcError = null;
        try {
            const r = await supabaseAdmin.rpc('increment_pin_attempts', {
                p_user_id: userId, p_max: MAX_PIN_ATTEMPTS, p_lock_ms: PIN_LOCK_DURATION
            });
            rpcRes = r?.data; rpcError = r?.error;
        } catch (e) { rpcError = e; }
        if (rpcError || !rpcRes || typeof rpcRes.attempts !== 'number') {
            if (IS_PRODUCTION) {
                return { valid: false, error: 'PIN verification temporarily unavailable.', code: 'PIN_SERVICE_UNAVAILABLE' };
            }
            rpcRes = { attempts: Number(profile.transaction_pin_attempts || 0) + 1, locked: false };
        }
        if (rpcRes.locked) return { valid: false, error: 'PIN locked for 1 hour.', code: 'PIN_LOCKED', remaining_minutes: 60, can_reset: true };
        const remaining = Math.max(0, MAX_PIN_ATTEMPTS - rpcRes.attempts);
        if (remaining === 0) return { valid: false, error: 'PIN locked for 1 hour.', code: 'PIN_LOCKED', remaining_minutes: 60, can_reset: true };
        return { valid: false, error: `Incorrect PIN. ${remaining} attempts left.`, code: 'INVALID_PIN', attempts_remaining: remaining };
    }
    await supabaseAdmin.from('profiles')
        .update({ transaction_pin_attempts: 0, transaction_pin_locked_until: null })
        .eq('id', userId);
    return { valid: true };
}

// ─── STATUS SYNC ─────────────────────────────────────────────────
async function syncAirtimeProviderStatus(transaction) {
    if (!transaction?.provider_transaction_id) return transaction;
    const currentStatus = String(transaction.status || '').toLowerCase();
    if (['completed','failed','refunded','manual_review','cancelled','reversed','provider_unknown'].includes(currentStatus)) return transaction;
    const ageMs = Date.now() - new Date(transaction.created_at).getTime();
    if (ageMs >= MAX_PROCESSING_MS) return { ...transaction, _stuck: true };
    try {
        const provider = await dtoneService.queryTransaction(transaction.provider_transaction_id);
        if (!provider || !provider.status) return transaction;
        const providerStatus = String(provider.status).toLowerCase();
        if (providerStatus === 'completed') {
            const { data: updated } = await supabaseAdmin.from('airtime_transactions')
                .update({ status: 'completed', provider_status: provider.providerStatus || 'COMPLETED',
                    completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                .eq('id', transaction.id).in('status', ['processing','pending'])
                .select('*').maybeSingle();
            return updated || { ...transaction, status: 'completed' };
        }
        if (providerStatus === 'not_found' || provider.notFound) {
            await supabaseAdmin.from('airtime_transactions')
                .update({ provider_status: provider.providerStatus || 'NOT_FOUND', updated_at: new Date().toISOString() })
                .eq('id', transaction.id).in('status', ['processing','pending']);
            return { ...transaction, provider_status: 'NOT_FOUND' };
        }
        if (['failed','cancelled','reversed'].includes(providerStatus)) {
            const { data: updated } = await supabaseAdmin.from('airtime_transactions')
                .update({ provider_status: provider.providerStatus || providerStatus.toUpperCase(),
                    failure_code: provider.errorCode || null, failure_message: provider.errorMessage || null,
                    updated_at: new Date().toISOString() })
                .eq('id', transaction.id).in('status', ['processing','pending'])
                .select('*').maybeSingle();
            return updated || transaction;
        }
        return { ...transaction, provider_status: provider.providerStatus || transaction.provider_status };
    } catch (error) {
        console.warn(`⚠️ [AIRTIME SYNC] ${transaction.reference}:`, error.message);
        return transaction;
    }
}

// ─── REFUND ──────────────────────────────────────────────────────
async function refundAirtime({ userId, amount, currency, reference, reason, kind }) {
    const refundRef = `REF-${String(kind || 'AT').toUpperCase()}-${reference}`;
    try {
        await LedgerService.creditWallet({
            userId, amount, currency,
            description: `Refund (${kind || 'airtime'}): ${reason}`,
            reference: refundRef,
            type: 'refund',
            metadata: { refund_reference: refundRef }
        });
        return { ok: true, refundReference: refundRef };
    } catch (err) {
        const msg = String(err?.message || '');
        if (msg.includes('duplicate') || msg.includes('23505') || msg.includes('unique')) {
            return { ok: true, refundReference: refundRef, alreadyRefunded: true };
        }
        console.error('❌ [AIRTIME] Refund failed:', msg);
        return { ok: false, error: msg, refundReference: refundRef };
    }
}

// ─── NGA GATE ────────────────────────────────────────────────────
async function allowGlobalForNga() {
    try {
        const v = await adminSettings.getRaw('airtime_global_allow_nga');
        return String(v ?? 'true').toLowerCase() !== 'false';
    } catch { return true; }
}

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

router.get('/health', async (req, res) => {
    let config = null;
    try { config = await airtimePricing.getAirtimeConfig(); } catch {}
    res.json({
        success: true, status: 'healthy', service: 'airtime', provider: 'dtone',
        env: dtoneService.env,
        global: config?.global || null,
        local: config?.local || null,
        callbackConfigured: Boolean(getPublicCallbackUrl()),
        webhookSignatureRequired: Boolean(DTONE_WEBHOOK_SECRET),
        timestamp: new Date().toISOString()
    });
});

router.get('/config', async (req, res) => {
    try {
        const cfg = await airtimePricing.getAirtimeConfig();
        return res.json({ success: true, data: cfg });
    } catch (e) {
        console.error('❌ /config:', e.message);
        return res.status(500).json({ success: false, error: 'Could not load configuration' });
    }
});

router.get('/countries', async (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=7200');
        const countries = await getCachedCountries();
        let ngaIsLocal = false;
        try {
            ngaIsLocal = (await airtimeService.resolveProvider({ countryIso3: 'NGA' })) === 'vtpass';
        } catch {}
        const decorated = countries.map(c => c.iso3 === 'NGA' ? { ...c, local: ngaIsLocal } : c);
        return res.json({ success: true, total: decorated.length, data: decorated });
    } catch (error) {
        console.error('❌ Countries error:', error.message);
        return res.status(503).json({
            success: false, error: 'Countries temporarily unavailable.', code: 'PROVIDER_UNAVAILABLE'
        });
    }
});

router.get('/operators', async (req, res) => {
    try {
        const { country } = req.query;
        if (!country) return res.status(400).json({ success: false, error: 'Country required', code: 'COUNTRY_REQUIRED' });
        const normalizedCountry = normalizeCountryCodes(country);
        if (!normalizedCountry?.iso3) return res.status(400).json({ success: false, error: 'Invalid country', code: 'INVALID_COUNTRY' });
        res.set('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
        let operators = [];
        try {
            operators = await getCachedOperatorsFast(normalizedCountry.iso3);
        } catch (err) {
            return res.status(503).json({
                success: false, error: 'Networks temporarily unavailable.',
                code: 'OPERATORS_UNAVAILABLE', country: normalizedCountry.iso3, data: []
            });
        }
        const data = operators.map(op => ({
            id: Number(op.id), name: op.name || `Operator ${op.id}`,
            logo: op.logo || dtoneService.getOperatorLogo(op.id, 1),
            logoMedium: op.logo_medium || dtoneService.getOperatorLogo(op.id, 2),
            logoLarge: op.logo_large || dtoneService.getOperatorLogo(op.id, 3)
        }));
        return res.json({
            success: true,
            country: { iso3: normalizedCountry.iso3, iso2: normalizedCountry.iso2 },
            total: data.length, data
        });
    } catch (error) {
        console.error('❌ Operators error:', error.message);
        return res.status(500).json({ success: false, error: 'Failed to load operators', code: 'SERVER_ERROR' });
    }
});

router.get('/availability', authMiddleware, rateLimitAvailability, async (req, res) => {
    try {
        const { country, operator_id } = req.query;
        if (!country || !operator_id) {
            return res.status(400).json({ success: false, error: 'country and operator_id required', code: 'MISSING_FIELDS' });
        }
        const normalizedCountry = normalizeCountryCodes(country);
        if (!normalizedCountry?.iso3 || !normalizedCountry?.iso2) {
            return res.status(400).json({ success: false, error: 'Invalid country', code: 'INVALID_COUNTRY' });
        }
        const iso3 = normalizedCountry.iso3;

        const cfg = await airtimePricing.getAirtimeConfig();
        if (!cfg.global.enabled) {
            return res.status(503).json({ success: false, error: 'Global airtime is currently disabled.', code: 'SERVICE_DISABLED' });
        }
        let provider;
        try { provider = await airtimeService.resolveProvider({ countryIso3: iso3 }); } catch { provider = 'dtone'; }
        const routedLocal = (provider === 'vtpass');
        if (routedLocal && !(await allowGlobalForNga())) {
            return res.status(409).json({
                success: false, error: 'Use Local Airtime for this country.',
                code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
            });
        }

        let operators = [];
        try { operators = await getCachedOperatorsFast(iso3); }
        catch {
            if (routedLocal) {
                return res.status(409).json({
                    success: false, error: 'Use Local Airtime for this country.',
                    code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
                });
            }
            return res.status(503).json({ success: false, error: 'Networks unavailable.', code: 'OPERATORS_UNAVAILABLE' });
        }

        const selectedOp = operators.find(op => String(op.id) === String(operator_id));
        if (!selectedOp) {
            if (routedLocal) {
                return res.status(409).json({
                    success: false, error: 'Use Local Airtime for this country.',
                    code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
                });
            }
            return res.status(400).json({ success: false, error: 'Selected network unavailable.', code: 'OPERATOR_NOT_FOUND' });
        }

        let products = [];
        try { products = await getCachedAirtimeProducts(iso3, selectedOp.id); }
        catch {
            if (routedLocal) {
                return res.status(409).json({
                    success: false, error: 'Use Local Airtime for this country.',
                    code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
                });
            }
            return res.status(503).json({ success: false, error: 'Could not check availability.', code: 'PRODUCT_FETCH_FAILED' });
        }

        let selection;
        try { selection = pickAirtimeProductWithoutAmount({ products }); }
        catch (selErr) {
            if (routedLocal && ['NO_PRODUCTS', 'RANGED_NOT_SUPPORTED'].includes(selErr.code)) {
                return res.status(409).json({
                    success: false, error: 'Use Local Airtime for this country.',
                    code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
                });
            }
            return res.json({
                success: true,
                available: false,
                operator_id: String(selectedOp.id),
                error: selErr.message,
                code: selErr.code || 'NO_PRODUCTS',
                global: { min: cfg.global.min, max: cfg.global.max, enabled: cfg.global.enabled }
            });
        }

        return res.json({
            success: true,
            available: true,
            operator_id: String(selectedOp.id),
            operator_name: selectedOp.name,
            product_id: selection.selectedProduct.id,
            min_usd: selection.minUsd,
            max_usd: selection.maxUsd,
            source_currency: selection.sourceCurrency,
            destination_currency: selection.destinationCurrency,
            rate_per_usd: selection.ratePerUsd,
            global: { min: cfg.global.min, max: cfg.global.max, enabled: cfg.global.enabled }
        });
    } catch (error) {
        console.error('❌ [AVAILABILITY]', error.message);
        return res.status(500).json({ success: false, error: error.message || 'Availability check failed', code: 'SERVER_ERROR' });
    }
});

router.get('/me', authMiddleware, async (req, res) => {
    try {
        const balances = await LedgerService.getAllBalances(req.user.id);
        const cfg = await airtimePricing.getAirtimeConfig();
        res.json({
            success: true,
            data: {
                wallet_ngn: balances.NGN || 0,
                wallet_usd: balances.USD || 0,
                usd_to_ngn: cfg.global.fx,
                fee_percent: cfg.global.feePercent,
                config: cfg
            }
        });
    } catch (error) {
        console.error('❌ Balance error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch balances' });
    }
});

router.post('/preflight', authMiddleware, rateLimitPreflight, async (req, res) => {
    try {
        const { country, phone, operator_id, source_amount_usd, wallet_type } = req.body || {};
        if (!country || !phone || !operator_id || source_amount_usd == null) {
            return res.status(400).json({ success: false, error: 'Missing fields', code: 'MISSING_FIELDS' });
        }
        const normalizedCountry = normalizeCountryCodes(country);
        if (!normalizedCountry?.iso3 || !normalizedCountry?.iso2) {
            return res.status(400).json({ success: false, error: 'Invalid country', code: 'INVALID_COUNTRY' });
        }
        const iso3 = normalizedCountry.iso3, iso2 = normalizedCountry.iso2;

        const cfg = await airtimePricing.getAirtimeConfig();
        if (!cfg.global.enabled) {
            return res.status(503).json({ success: false, error: 'Global airtime is currently disabled.', code: 'SERVICE_DISABLED' });
        }

        let provider;
        try { provider = await airtimeService.resolveProvider({ countryIso3: iso3 }); } catch { provider = 'dtone'; }
        const routedLocal = (provider === 'vtpass');
        if (routedLocal && !(await allowGlobalForNga())) {
            return res.status(409).json({
                success: false, error: 'Use Local Airtime for this country.',
                code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
            });
        }

        const srcAmountUSD = Number(source_amount_usd);
        if (!Number.isFinite(srcAmountUSD) || srcAmountUSD < cfg.global.min || srcAmountUSD > cfg.global.max) {
            return res.status(400).json({
                success: false,
                error: `Amount must be between $${cfg.global.min} and $${cfg.global.max}`,
                code: 'INVALID_AMOUNT',
                min_amount_usd: Number(cfg.global.min),
                max_amount_usd: Number(cfg.global.max)
            });
        }
        const parsed = parsePhoneNumberFromString(phone, iso2);
        if (!parsed || !parsed.isValid()) {
            return res.status(400).json({ success: false, error: `Invalid phone for ${iso3}`, code: 'INVALID_PHONE' });
        }
        const walletType = String(wallet_type || 'USD').toUpperCase();
        if (!['USD','NGN'].includes(walletType)) {
            return res.status(400).json({ success: false, error: 'Unsupported wallet', code: 'INVALID_WALLET' });
        }

        let operators = [];
        try { operators = await getCachedOperatorsFast(iso3); }
        catch {
            if (routedLocal) {
                return res.status(409).json({
                    success: false, error: 'Use Local Airtime for this country.',
                    code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
                });
            }
            return res.status(503).json({ success: false, error: 'Networks unavailable.', code: 'OPERATORS_UNAVAILABLE' });
        }

        const selectedOp = operators.find(op => String(op.id) === String(operator_id));
        if (!selectedOp) {
            if (routedLocal) {
                return res.status(409).json({
                    success: false, error: 'Use Local Airtime for this country.',
                    code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
                });
            }
            return res.status(400).json({ success: false, error: 'Selected network unavailable.', code: 'OPERATOR_NOT_FOUND' });
        }

        let products = [];
        try { products = await getCachedAirtimeProducts(iso3, selectedOp.id); }
        catch {
            if (routedLocal) {
                return res.status(409).json({
                    success: false, error: 'Use Local Airtime for this country.',
                    code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
                });
            }
            return res.status(503).json({ success: false, error: 'Could not check availability.', code: 'PRODUCT_FETCH_FAILED' });
        }

        let selection;
        try { selection = selectAirtimeProduct({ products, srcAmountUSD }); }
        catch (selErr) {
            if (routedLocal && ['NO_PRODUCTS', 'RANGED_NOT_SUPPORTED'].includes(selErr.code)) {
                return res.status(409).json({
                    success: false, error: 'Use Local Airtime for this country.',
                    code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
                });
            }
            return res.status(400).json({
                success: false, error: selErr.message, code: selErr.code || 'NO_PRODUCTS',
                min_amount_usd: selErr.min_amount_usd, max_amount_usd: selErr.max_amount_usd
            });
        }

        const quote = await airtimePricing.quoteGlobal({ sendUsd: srcAmountUSD, walletType });

        let balances = { USD: 0, NGN: 0 };
        try { balances = await LedgerService.getAllBalances(req.user.id); } catch {}
        const walletOptions = [
            {
                type: 'USD',
                required: Number(quote.totalUsd),
                balance: Number(balances.USD || 0),
                sufficient: Number(balances.USD || 0) >= Number(quote.totalUsd)
            },
            {
                type: 'NGN',
                required: Number(quote.totalNgn),
                balance: Number(balances.NGN || 0),
                sufficient: Number(balances.NGN || 0) >= Number(quote.totalNgn)
            }
        ];

        const estimatedDestinationAmount = (() => {
            if (!selection.ratePerUsd) return null;
            const n = Number(quote.sendUsd) * selection.ratePerUsd;
            return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
        })();

        return res.json({
            success: true,
            quote: {
                country: iso3,
                phone_masked: maskPhone(parsed.number),
                operator_id: String(selectedOp.id),
                operator_name: selectedOp.name,
                product_id: selection.selectedProduct.id,
                send_amount_usd: quote.sendUsd,
                fee_usd: quote.feeUsd,
                total_usd: quote.totalUsd,
                total_ngn: quote.totalNgn,
                usd_to_ngn: quote.fxUsdNgn,
                fee_percent: quote.feePercent,
                source_currency: selection.sourceCurrency,
                source_amount: selection.sourceAmountForProvider,
                needs_conversion: selection.needsConversion,
                min_usd: selection.minUsd,
                max_usd: selection.maxUsd,
                destination_currency: selection.destinationCurrency,
                estimated_destination_amount: estimatedDestinationAmount,
                rate_per_usd: selection.ratePerUsd,
                expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
            },
            wallet_options: walletOptions
        });
    } catch (error) {
        console.error('❌ [PREFLIGHT]', error.message);
        return res.status(500).json({ success: false, error: error.message || 'Preflight failed', code: 'SERVER_ERROR' });
    }
});

// ─── PURCHASE ────────────────────────────────────────────────────
router.post('/purchase', authMiddleware, async (req, res) => {
    let airtimeTxId = null;
    let debitedAmount = 0;
    let debitedCurrency = null;
    let debitedLedgerTxId = null;
    let idempotencyClaimed = false;
    let providerConfirmStarted = false;
    let providerQuoteCreated = false;
    let providerTransactionId = null;
    let orderId = null;                              // ★ NEW
    const userId = req.user.id;
    const idempotencyKey = req.headers['idempotency-key'];

    const releaseClaim = async () => {
        if (!idempotencyClaimed) return;
        try { await IdempotencyService.release(userId, idempotencyKey, '/api/airtime/purchase'); }
        catch (_) { /* best-effort */ }
        idempotencyClaimed = false;
    };

    try {
        const { country, phone, operator_id, source_amount_usd, wallet_type, transaction_pin } = req.body;

        if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 128) {
            return res.status(400).json({ success: false, error: 'Idempotency-Key required', code: 'IDEMPOTENCY_REQUIRED' });
        }
        if (!country || !phone || !operator_id || source_amount_usd == null || !wallet_type || !transaction_pin) {
            return res.status(400).json({ success: false, error: 'Missing fields', code: 'MISSING_FIELDS' });
        }

        const normalizedCountry = normalizeCountryCodes(country);
        if (!normalizedCountry?.iso3 || !normalizedCountry?.iso2) {
            return res.status(400).json({ success: false, error: 'Invalid country', code: 'INVALID_COUNTRY' });
        }
        const iso3 = normalizedCountry.iso3, iso2 = normalizedCountry.iso2;
        const srcAmountUSD = Number(source_amount_usd);

        const cfg = await airtimePricing.getAirtimeConfig();
        if (!cfg.global.enabled) {
            return res.status(503).json({ success: false, error: 'Global airtime is currently disabled.', code: 'SERVICE_DISABLED' });
        }
        let provider;
        try { provider = await airtimeService.resolveProvider({ countryIso3: iso3 }); } catch { provider = 'dtone'; }
        const routedLocal = (provider === 'vtpass');
        if (routedLocal && !(await allowGlobalForNga())) {
            return res.status(409).json({
                success: false, error: 'Use Local Airtime for this country.',
                code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
            });
        }

        if (!Number.isFinite(srcAmountUSD) || srcAmountUSD < cfg.global.min || srcAmountUSD > cfg.global.max) {
            return res.status(400).json({
                success: false, error: `Amount must be between $${cfg.global.min} and $${cfg.global.max}`,
                code: 'INVALID_AMOUNT',
                min_amount_usd: Number(cfg.global.min),
                max_amount_usd: Number(cfg.global.max)
            });
        }
        const parsed = parsePhoneNumberFromString(phone, iso2);
        if (!parsed || !parsed.isValid()) {
            return res.status(400).json({ success: false, error: `Invalid phone for ${iso3}`, code: 'INVALID_PHONE' });
        }
        const walletType = String(wallet_type).toUpperCase();
        if (!['USD', 'NGN'].includes(walletType)) {
            return res.status(400).json({ success: false, error: 'Unsupported wallet', code: 'INVALID_WALLET' });
        }

        const quote = await airtimePricing.quoteGlobal({ sendUsd: srcAmountUSD, walletType });
        const paymentCurrency = walletType;
        const paymentAmount = walletType === 'USD' ? quote.totalUsd : quote.totalNgn;
        if (!Number.isFinite(Number(paymentAmount)) || Number(paymentAmount) <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid payment amount', code: 'INVALID_AMOUNT' });
        }

        const pinResult = await verifyTransactionPin(userId, transaction_pin);
        if (!pinResult.valid) {
            return res.status(400).json({
                success: false, error: pinResult.error, code: pinResult.code,
                attempts_remaining: pinResult.attempts_remaining, can_reset: pinResult.can_reset
            });
        }

        const idempotentCheck = await IdempotencyService.check(userId, idempotencyKey, '/api/airtime/purchase');
        if (idempotentCheck && !idempotentCheck.__in_flight) {
            return res.json({ success: true, already_processed: true, data: idempotentCheck });
        }

        let operators = [];
        try { operators = await getCachedOperatorsFast(iso3); }
        catch {
            if (routedLocal) {
                return res.status(409).json({
                    success: false, error: 'Use Local Airtime for this country.',
                    code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
                });
            }
            return res.status(503).json({ success: false, error: 'Networks unavailable.', code: 'OPERATORS_UNAVAILABLE' });
        }
        const selectedOp = operators.find(op => String(op.id) === String(operator_id));
        if (!selectedOp) {
            if (routedLocal) {
                return res.status(409).json({
                    success: false, error: 'Use Local Airtime for this country.',
                    code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
                });
            }
            return res.status(400).json({ success: false, error: 'Selected network unavailable.', code: 'OPERATOR_NOT_FOUND' });
        }

        const balancesBefore = await LedgerService.getAllBalances(userId);
        const balance = walletType === 'USD' ? (balancesBefore.USD || 0) : (balancesBefore.NGN || 0);
        if (Number(balance) < Number(paymentAmount)) {
            return res.status(400).json({
                success: false,
                error: `Insufficient ${paymentCurrency}. Need ${Number(paymentAmount).toFixed(2)}, have ${Number(balance).toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE', required: Number(paymentAmount), balance: Number(balance)
            });
        }

        const claimed = await IdempotencyService.claim(
            userId, idempotencyKey, '/api/airtime/purchase',
            { country: iso3, phone: parsed.number, operator_id, amount: srcAmountUSD, wallet_type: walletType }
        );
        if (!claimed) {
            return res.status(409).json({ success: false, error: 'Already processing.', code: 'IDEMPOTENCY_IN_FLIGHT' });
        }
        idempotencyClaimed = true;

        let products = [];
        try {
            products = await getCachedAirtimeProducts(iso3, selectedOp.id);
        } catch (productsError) {
            await releaseClaim();
            if (routedLocal) {
                return res.status(409).json({
                    success: false, error: 'Use Local Airtime for this country.',
                    code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
                });
            }
            return res.status(503).json({ success: false, error: 'Could not load products', code: 'PRODUCT_FETCH_FAILED' });
        }

        let selection;
        try {
            selection = selectAirtimeProduct({ products, srcAmountUSD });
        } catch (selErr) {
            await releaseClaim();
            if (routedLocal && ['NO_PRODUCTS', 'RANGED_NOT_SUPPORTED'].includes(selErr.code)) {
                return res.status(409).json({
                    success: false, error: 'Use Local Airtime for this country.',
                    code: 'USE_LOCAL_AIRTIME', redirect: 'bills.html#airtime'
                });
            }
            return res.status(400).json({
                success: false, error: selErr.message, code: selErr.code || 'NO_PRODUCTS',
                min_amount_usd: selErr.min_amount_usd, max_amount_usd: selErr.max_amount_usd
            });
        }
        const { selectedProduct, sourceCurrency, sourceAmountForProvider } = selection;

        const reference = generateReference();
        const nowIso = new Date().toISOString();

        const { data: airtimeTx, error: airtimeError } = await supabaseAdmin
            .from('airtime_transactions')
            .insert({
                user_id: userId,
                reference,
                country_code: iso3,
                phone_number: parsed.number,
                operator_id: String(selectedOp.id),
                operator_name: selectedOp.name,
                destination_amount: 0,
                destination_currency: null,
                provider_cost: null,
                fee: quote.feeUsd,
                total_amount: paymentAmount,
                currency: paymentCurrency,
                wallet_type: walletType,
                payment_amount: paymentAmount,
                payment_currency: paymentCurrency,
                status: 'processing',
                provider: 'dtone',
                idempotency_key: idempotencyKey,
                reconciliation_attempts: 0,
                send_amount_usd: quote.sendUsd,
                fee_usd: quote.feeUsd,
                fee_percent: quote.feePercent,
                fx_usd_ngn: quote.fxUsdNgn,
                customer_total_ngn: quote.totalNgn,
                processing_at: nowIso,
                created_at: nowIso,
                updated_at: nowIso
            })
            .select().single();

        if (airtimeError) {
            await releaseClaim();
            throw airtimeError;
        }
        airtimeTxId = airtimeTx.id;

        // ★ NEW: mirror as an order (pending) so it's visible immediately
        try {
            orderId = await recordOrder({
                billTransactionId: airtimeTx.id,
                reference,
                userId,
                productType: 'airtime',
                serviceId: String(selectedOp.id),
                provider: 'dtone',
                currency: paymentCurrency,
                amount: paymentAmount,
                serviceFee: quote.feeUsd || 0,
                totalAmount: paymentAmount,
                providerCost: 0,
                status: 'pending',
                recipient: parsed.number,
                metadata: {
                    operator_name: selectedOp.name,
                    country: iso3,
                    wallet_type: walletType,
                    send_amount_usd: quote.sendUsd,
                    destination_currency: selection.destinationCurrency
                }
            });
        } catch (orderErr) {
            console.error('[AIRTIME] recordOrder (pending) failed:', orderErr.message);
        }

        // Ledger debit
        try {
            const debitResult = await LedgerService.debitWallet({
                userId,
                amount: paymentAmount,
                currency: paymentCurrency,
                description: `Airtime: ${iso3} ${maskPhone(parsed.number)}`,
                type: 'airtime_purchase',
                sourceType: 'airtime_transaction',
                sourceId: airtimeTx.id,
                metadata: { airtime_reference: reference }
            });
            if (!debitResult || debitResult.success !== true || !debitResult.transaction_id) {
                throw new Error(debitResult?.error || 'Ledger returned no transaction_id');
            }
            debitedAmount = paymentAmount;
            debitedCurrency = paymentCurrency;
            debitedLedgerTxId = debitResult.transaction_id;

            await supabaseAdmin.from('airtime_transactions')
                .update({ ledger_transaction_id: debitedLedgerTxId, updated_at: new Date().toISOString() })
                .eq('id', airtimeTx.id);
        } catch (debitError) {
            await supabaseAdmin.from('airtime_transactions').update({
                status: 'failed', failure_message: debitError.message, failed_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }).eq('id', airtimeTx.id).in('status', ['processing', 'pending']);

            // ★ NEW: mark order failed
            if (orderId) {
                await recordOrder({
                    billTransactionId: airtimeTx.id, reference, userId,
                    productType: 'airtime', serviceId: String(selectedOp.id), provider: 'dtone',
                    currency: paymentCurrency, amount: paymentAmount, serviceFee: quote.feeUsd || 0,
                    totalAmount: paymentAmount, providerCost: 0, status: 'failed',
                    recipient: parsed.number,
                    metadata: { failure_reason: debitError.message }
                }).catch(e => console.error('[AIRTIME] recordOrder (debit-failed) failed:', e.message));
            }

            await releaseClaim();
            return res.status(400).json({ success: false, error: debitError.message, code: 'DEBIT_FAILED' });
        }

        // Provider quote
        const callbackUrl = getPublicCallbackUrl();
        let quoteResult;
        try {
            quoteResult = await dtoneService.createQuote({
                productId: selectedProduct.id,
                phone: parsed.number,
                mode: 'RANGED_SOURCE',
                sourceAmount: sourceAmountForProvider,
                sourceCurrency,
                callbackUrl
            });
            providerQuoteCreated = true;
            providerTransactionId = quoteResult?.transactionId || null;
        } catch (error) {
            const providerData = error.providerData || {};
            const providerCode = String(providerData?.errors?.[0]?.code || providerData?.error?.code || '');
            const messageUp = String(error.message || '').toUpperCase();
            const isAmbiguous = error.code === 'PROVIDER_UNKNOWN' || error.ambiguous === true ||
                (providerCode === '' && /TIMEOUT|NETWORK|FETCH FAILED|SOCKET/i.test(messageUp));

            if (isAmbiguous) {
                await supabaseAdmin.from('airtime_transactions').update({
                    status: 'provider_unknown',
                    failure_message: 'Ambiguous provider response',
                    updated_at: new Date().toISOString()
                }).eq('id', airtimeTx.id).in('status', ['processing', 'pending']);

                // ★ NEW: leave order in pending (provider_unknown maps to pending)
                if (orderId) {
                    await recordOrder({
                        billTransactionId: airtimeTx.id, reference, userId,
                        productType: 'airtime', serviceId: String(selectedOp.id), provider: 'dtone',
                        currency: paymentCurrency, amount: paymentAmount, serviceFee: quote.feeUsd || 0,
                        totalAmount: paymentAmount, providerCost: 0, status: 'pending',
                        recipient: parsed.number,
                        metadata: { failure_reason: 'Ambiguous provider response', provider_unknown: true }
                    }).catch(e => console.error('[AIRTIME] recordOrder (provider_unknown) failed:', e.message));
                }

                return res.status(202).json({
                    success: true, reference, status: 'provider_unknown', refunded: false,
                    message: 'Being reconciled.',
                    data: { transaction_id: airtimeTx.id, reference, status: 'provider_unknown' }
                });
            }

            const refundCtx = await refundAirtime({
                userId, amount: paymentAmount, currency: paymentCurrency, reference,
                reason: `Provider rejected: ${error.message}`, kind: 'PRJ'
            });
            if (refundCtx.ok) {
                await supabaseAdmin.from('airtime_transactions').update({
                    status: 'failed', refunded: true,
                    failure_code: 'PROVIDER_ERROR',
                    failure_message: error.message,
                    failed_at: new Date().toISOString(),
                    refunded_at: new Date().toISOString(),
                    refund_reference: refundCtx.refundReference || null,
                    updated_at: new Date().toISOString()
                }).eq('id', airtimeTx.id).eq('refunded', false);

                // ★ NEW: mark order failed
                if (orderId) {
                    await recordOrder({
                        billTransactionId: airtimeTx.id, reference, userId,
                        productType: 'airtime', serviceId: String(selectedOp.id), provider: 'dtone',
                        currency: paymentCurrency, amount: paymentAmount, serviceFee: quote.feeUsd || 0,
                        totalAmount: paymentAmount, providerCost: 0, status: 'failed',
                        recipient: parsed.number,
                        metadata: { failure_reason: error.message }
                    }).catch(e => console.error('[AIRTIME] recordOrder (quote-failed) failed:', e.message));
                }

                await IdempotencyService.save(userId, idempotencyKey, '/api/airtime/purchase', {
                    transaction_id: airtimeTx.id, reference, status: 'failed',
                    refunded: true, error: error.message
                }).catch(() => {});
                return res.status(400).json({
                    success: false, error: error.message || 'Provider could not process this amount',
                    code: 'PROVIDER_ERROR'
                });
            } else {
                await supabaseAdmin.from('airtime_transactions').update({
                    status: 'manual_review',
                    failure_message: `Auto-refund failed: ${refundCtx.error || 'unknown'}. Provider: ${error.message}`,
                    failed_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }).eq('id', airtimeTx.id);

                // ★ NEW: mark order failed
                if (orderId) {
                    await recordOrder({
                        billTransactionId: airtimeTx.id, reference, userId,
                        productType: 'airtime', serviceId: String(selectedOp.id), provider: 'dtone',
                        currency: paymentCurrency, amount: paymentAmount, serviceFee: quote.feeUsd || 0,
                        totalAmount: paymentAmount, providerCost: 0, status: 'failed',
                        recipient: parsed.number,
                        metadata: { failure_reason: `Auto-refund failed: ${refundCtx.error || 'unknown'}` }
                    }).catch(e => console.error('[AIRTIME] recordOrder (manual-review) failed:', e.message));
                }

                return res.status(202).json({
                    success: true, reference, status: 'manual_review', refunded: false,
                    message: 'Under review — our team will contact you shortly.',
                    data: { transaction_id: airtimeTx.id, reference, status: 'manual_review' }
                });
            }
        }

        if (!quoteResult || !quoteResult.transactionId) {
            const refundCtx = await refundAirtime({
                userId, amount: paymentAmount, currency: paymentCurrency, reference,
                reason: 'Invalid quote from provider', kind: 'INQ'
            });
            const patch = refundCtx.ok
                ? { status: 'failed', refunded: true, failure_message: 'Provider did not return a valid quote',
                    refunded_at: new Date().toISOString(), refund_reference: refundCtx.refundReference || null,
                    updated_at: new Date().toISOString() }
                : { status: 'manual_review', failure_message: 'Invalid quote — auto-refund failed',
                    failed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
            await supabaseAdmin.from('airtime_transactions').update(patch).eq('id', airtimeTx.id);

            if (orderId) {
                await recordOrder({
                    billTransactionId: airtimeTx.id, reference, userId,
                    productType: 'airtime', serviceId: String(selectedOp.id), provider: 'dtone',
                    currency: paymentCurrency, amount: paymentAmount, serviceFee: quote.feeUsd || 0,
                    totalAmount: paymentAmount, providerCost: 0, status: 'failed',
                    recipient: parsed.number,
                    metadata: { failure_reason: 'Provider did not return a valid quote' }
                }).catch(e => console.error('[AIRTIME] recordOrder (invalid-quote) failed:', e.message));
            }

            await releaseClaim();
            return res.status(400).json({
                success: false, error: 'Provider did not return a valid quote', code: 'QUOTE_ERROR'
            });
        }

        const destAmount = quoteResult.destination?.amount;
        const destCurrency = quoteResult.destination?.unit;
        if (!destAmount || Number(destAmount) <= 0 || !destCurrency) {
            try { await dtoneService.cancelTransaction(quoteResult.transactionId); } catch (_) {}
            const refundCtx = await refundAirtime({
                userId, amount: paymentAmount, currency: paymentCurrency, reference,
                reason: 'Missing destination amount from provider', kind: 'MDD'
            });
            const patch = refundCtx.ok
                ? { status: 'failed', refunded: true, failure_message: 'Provider quote missing recipient amount',
                    refunded_at: new Date().toISOString(), refund_reference: refundCtx.refundReference || null,
                    updated_at: new Date().toISOString() }
                : { status: 'manual_review', failure_message: 'Missing destination — auto-refund failed',
                    updated_at: new Date().toISOString() };
            await supabaseAdmin.from('airtime_transactions').update(patch).eq('id', airtimeTx.id);

            if (orderId) {
                await recordOrder({
                    billTransactionId: airtimeTx.id, reference, userId,
                    productType: 'airtime', serviceId: String(selectedOp.id), provider: 'dtone',
                    currency: paymentCurrency, amount: paymentAmount, serviceFee: quote.feeUsd || 0,
                    totalAmount: paymentAmount, providerCost: 0, status: 'failed',
                    recipient: parsed.number,
                    metadata: { failure_reason: 'Provider quote missing recipient amount' }
                }).catch(e => console.error('[AIRTIME] recordOrder (missing-destination) failed:', e.message));
            }

            await releaseClaim();
            return res.status(400).json({
                success: false, error: 'Provider quote missing recipient amount', code: 'CALCULATION_ERROR'
            });
        }

        const snapshot = airtimePricing.buildSnapshotGlobal(quote, quoteResult);
        const providerCurrency = String(snapshot.provider_currency || 'USD').toUpperCase();
        const marginUnavailable = !['USD', 'NGN'].includes(providerCurrency);
        const marginNgn = marginUnavailable ? null : snapshot.margin_ngn;

        await supabaseAdmin.from('airtime_transactions').update({
            destination_amount: destAmount,
            destination_currency: destCurrency,
            provider_cost: snapshot.provider_cost,
            provider_currency: providerCurrency,
            provider_cost_ngn: snapshot.provider_cost_ngn,
            provider_cost_usd: snapshot.provider_cost_usd,
            margin_ngn: marginNgn,
            provider_transaction_id: String(quoteResult.transactionId),
            dtone_external_id: quoteResult.externalId ? String(quoteResult.externalId) : null,
            product_id: selectedProduct.id,
            metadata: marginUnavailable
                ? { margin_unavailable: true, provider_currency: providerCurrency }
                : null,
            updated_at: new Date().toISOString()
        }).eq('id', airtimeTx.id);

        let confirmResult = null;
        let providerAmbiguous = false;
        providerConfirmStarted = true;
        try {
            confirmResult = await dtoneService.confirmTransaction(quoteResult.transactionId);
        } catch (error) {
            console.error('❌ DT One confirm error:', error.message);
            if (error.definitiveRejection) {
                providerAmbiguous = false;
                confirmResult = {
                    status: error.normalized?.code || 'REJECTED',
                    normalized: error.normalized || { status: 'failed', final: true, code: 'REJECTED' },
                    errorCode: error.providerErrorCode || error.normalized?.code || null,
                    errorMessage: error.message
                };
            } else {
                providerAmbiguous = true;
                confirmResult = {
                    status: null,
                    normalized: { status: 'provider_unknown', final: false, code: 'UNKNOWN_PROVIDER_STATUS' },
                    errorCode: null,
                    errorMessage: error.message
                };
            }
        }

        let normalizedProviderStatus;
        if (confirmResult?.normalized) {
            normalizedProviderStatus = confirmResult.normalized;
        } else if (confirmResult?.status && typeof confirmResult.status === 'object') {
            normalizedProviderStatus = dtoneService.normalizeStatus(confirmResult.status);
        } else {
            normalizedProviderStatus = dtoneService.normalizeStatus({
                message: confirmResult?.status || null
            });
        }

        if (!providerAmbiguous && !normalizedProviderStatus.final) {
            try {
                const fresh = await dtoneService.queryTransaction(quoteResult.transactionId);
                if (fresh?.status && !fresh.notFound) {
                    const freshNormalized = dtoneService.normalizeStatus(fresh.raw?.status || { message: fresh.providerStatus });
                    normalizedProviderStatus = freshNormalized;
                    confirmResult = {
                        ...confirmResult,
                        status: fresh.providerStatus || fresh.status,
                        errorCode: fresh.errorCode || null,
                        errorMessage: fresh.errorMessage || null
                    };
                }
            } catch (e) {
                console.warn('⚠️ Post-confirm status check failed:', e.message);
            }
        }

        let finalStatus = 'processing';
        if (normalizedProviderStatus.status === 'completed') finalStatus = 'completed';
        else if (normalizedProviderStatus.final && ['failed', 'cancelled', 'reversed'].includes(normalizedProviderStatus.status)) {
            finalStatus = 'failed';
        } else if (providerAmbiguous) {
            finalStatus = 'provider_unknown';
        }

        const updatePatch = {
            status: finalStatus,
            provider_status: (typeof confirmResult?.status === 'string' ? confirmResult.status : null)
                || (confirmResult?.status?.message) || null,
            failure_code: confirmResult?.errorCode || null,
            failure_message: confirmResult?.errorMessage || null,
            completed_at: finalStatus === 'completed' ? new Date().toISOString() : null,
            failed_at: finalStatus === 'failed' ? new Date().toISOString() : null,
            updated_at: new Date().toISOString()
        };
        await supabaseAdmin.from('airtime_transactions').update(updatePatch)
            .eq('id', airtimeTx.id).in('status', ['processing', 'pending']);

        if (finalStatus === 'failed') {
            const refundCtx = await refundAirtime({
                userId, amount: paymentAmount, currency: paymentCurrency, reference,
                reason: confirmResult?.errorMessage || 'Provider rejected', kind: 'CNF'
            });
            if (refundCtx.ok) {
                await supabaseAdmin.from('airtime_transactions').update({
                    refunded: true, refunded_at: new Date().toISOString(),
                    refund_reference: refundCtx.refundReference || null,
                    updated_at: new Date().toISOString()
                }).eq('id', airtimeTx.id).eq('refunded', false);
            } else {
                await supabaseAdmin.from('airtime_transactions').update({
                    status: 'manual_review',
                    failure_message: `Auto-refund failed: ${refundCtx.error || 'unknown'}`,
                    updated_at: new Date().toISOString()
                }).eq('id', airtimeTx.id);
                finalStatus = 'manual_review';
            }
        }

        // ★ NEW: final order sync — completed / failed / pending
        if (orderId) {
            const orderStatus =
                finalStatus === 'completed' ? 'completed'
              : finalStatus === 'failed' || finalStatus === 'manual_review' ? 'failed'
              : 'pending';
            await recordOrder({
                billTransactionId: airtimeTx.id, reference, userId,
                productType: 'airtime', serviceId: String(selectedOp.id), provider: 'dtone',
                currency: paymentCurrency, amount: paymentAmount, serviceFee: quote.feeUsd || 0,
                totalAmount: paymentAmount, providerCost: 0, status: orderStatus,
                recipient: parsed.number,
                metadata: {
                    operator_name: selectedOp.name,
                    country: iso3,
                    wallet_type: walletType,
                    send_amount_usd: quote.sendUsd,
                    destination_currency: selection.destinationCurrency,
                    destination_amount: destAmount,
                    provider_status: (typeof confirmResult?.status === 'string' ? confirmResult.status : null) || null,
                    failure_code: confirmResult?.errorCode || null,
                    failure_reason: confirmResult?.errorMessage || null
                }
            }).catch(e => console.error('[AIRTIME] recordOrder (final) failed:', e.message));
        }

        const responseData = {
            transaction_id: airtimeTx.id, reference, status: finalStatus,
            refunded: finalStatus === 'failed',
            destination_amount: destAmount, destination_currency: destCurrency,
            amount_paid: paymentAmount, currency_paid: paymentCurrency,
            wallet_type: walletType,
            country: iso3, phone: maskPhone(parsed.number), operator: selectedOp.name,
            provider_ambiguous: providerAmbiguous,
            failure_code: confirmResult?.errorCode || null,
            failure_message: confirmResult?.errorMessage || null
        };
        await IdempotencyService.save(userId, idempotencyKey, '/api/airtime/purchase', responseData)
            .catch((e) => console.error('[airtime] idempotency save failed:', e.message));
        idempotencyClaimed = false;
        const balancesAfter = await LedgerService.getAllBalances(userId);
        return res.json({
            success: true, reference, status: finalStatus, refunded: finalStatus === 'failed',
            message: finalStatus === 'completed' ? 'Airtime sent successfully!'
                : finalStatus === 'processing' || finalStatus === 'provider_unknown' ? 'Airtime is being processed...'
                : finalStatus === 'manual_review' ? 'Under review — our team will contact you shortly.'
                : 'Airtime failed. Funds refunded.',
            data: { ...responseData, wallet_balance: { USD: balancesAfter.USD || 0, NGN: balancesAfter.NGN || 0 } }
        });

    } catch (error) {
        console.error('❌ Purchase error:', error.message);

        if (providerQuoteCreated && !providerConfirmStarted && providerTransactionId) {
            try { await dtoneService.cancelTransaction(providerTransactionId); }
            catch (e) { console.warn('[airtime] best-effort cancel failed:', e.message); }
        }

        if (airtimeTxId && debitedAmount > 0 && !providerConfirmStarted) {
            try {
                const refundCtx = await refundAirtime({
                    userId, amount: debitedAmount, currency: debitedCurrency,
                    reference: airtimeTxId, reason: 'Crash before provider call', kind: 'ROLLBACK'
                });
                if (refundCtx.ok) {
                    await supabaseAdmin.from('airtime_transactions').update({
                        status: 'failed', refunded: true,
                        failure_message: 'Crashed before provider call — auto-refunded',
                        refunded_at: new Date().toISOString(),
                        refund_reference: refundCtx.refundReference || null,
                        updated_at: new Date().toISOString()
                    }).eq('id', airtimeTxId).eq('refunded', false).in('status', ['processing', 'pending']);
                } else {
                    await supabaseAdmin.from('airtime_transactions').update({
                        status: 'manual_review',
                        failure_message: `Crash rollback failed: ${refundCtx.error || 'unknown'}`,
                        updated_at: new Date().toISOString()
                    }).eq('id', airtimeTxId);
                }
            } catch (e) {
                await supabaseAdmin.from('airtime_transactions').update({
                    status: 'manual_review',
                    failure_message: `Crash rollback failed: ${e.message}`,
                    updated_at: new Date().toISOString()
                }).eq('id', airtimeTxId);
            }

            // ★ NEW: mark order failed on crash rollback
            if (orderId) {
                await recordOrder({
                    billTransactionId: airtimeTxId, reference: airtimeTxId, userId,
                    productType: 'airtime', serviceId: null, provider: 'dtone',
                    currency: debitedCurrency || 'USD', amount: debitedAmount, serviceFee: 0,
                    totalAmount: debitedAmount, providerCost: 0, status: 'failed',
                    metadata: { failure_reason: `Crash before provider call: ${error.message}` }
                }).catch(e => console.error('[AIRTIME] recordOrder (crash) failed:', e.message));
            }
        } else if (airtimeTxId && providerConfirmStarted) {
            await supabaseAdmin.from('airtime_transactions').update({
                status: 'processing',
                failure_message: 'Ambiguous provider state',
                updated_at: new Date().toISOString()
            }).eq('id', airtimeTxId).in('status', ['processing', 'pending']);
            // Leave order as pending — provider reconciliation will update it later.
        }

        await releaseClaim();

        return res.status(500).json({ success: false, error: error.message || 'Purchase failed', code: 'SERVER_ERROR' });
    }
});

router.get('/history', authMiddleware, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
        const offset = (page - 1) * limit;
        const { data, error, count } = await supabaseAdmin
            .from('airtime_transactions').select('*', { count: 'exact' })
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) throw error;
            const enrichedData = (data || []).map(tx => ({
            ...tx,
            iso2: countriesLib.alpha3ToAlpha2(tx.country_code) || null,
            flag: getFlagFromAlpha3(tx.country_code),
            dial: getDialCode(tx.country_code)
        }));
        res.json({
            success: true, data: enrichedData,
            pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) || 1, hasMore: (offset + limit) < (count || 0) }
        });
    } catch (error) {
        console.error('❌ History error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch history' });
    }
});

router.get('/by-key/:key', authMiddleware, async (req, res) => {
    try {
        const key = String(req.params.key || '').trim();
        if (!key || key.length > 128) {
            return res.status(400).json({ success: false, code: 'INVALID_KEY', error: 'Invalid idempotency key.' });
        }
        const { data, error } = await supabaseAdmin
            .from('airtime_transactions')
            .select('reference, status, failure_message, created_at')
            .eq('user_id', req.user.id)
            .eq('idempotency_key', key)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) {
            console.error('❌ [by-key] query failed:', error.message);
            return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'Lookup failed.' });
        }
        if (!data) {
            return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'No transaction for this key yet.' });
        }
        return res.json({
            success: true,
            data: {
                reference: data.reference,
                status: data.status,
                failure_message: data.failure_message || null,
                created_at: data.created_at
            }
        });
    } catch (err) {
        console.error('❌ [by-key] unexpected:', err.message);
        return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: 'Lookup failed.' });
    }
});

router.get('/:reference', authMiddleware, async (req, res) => {
    try {
        const { data: transaction, error } = await supabaseAdmin
            .from('airtime_transactions').select('*')
            .eq('reference', req.params.reference).eq('user_id', req.user.id).single();
        if (error || !transaction) return res.status(404).json({ success: false, error: 'Transaction not found' });
        const tx = await syncAirtimeProviderStatus(transaction);
        tx.flag = getFlagFromAlpha3(tx.country_code);
        tx.dial = getDialCode(tx.country_code);
        if (tx.operator_id) tx.operator_logo = dtoneService.getOperatorLogo(tx.operator_id);
        res.json({ success: true, data: tx });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch transaction' });
    }
});

router.post('/webhook', async (req, res) => {
    try {
        const payload = req.body || {};
        if (IS_PRODUCTION && !DTONE_WEBHOOK_SECRET) {
            return res.status(503).json({ success: false, error: 'Webhook not configured' });
        }
        if (DTONE_WEBHOOK_SECRET) {
            const signature = req.headers['x-dtone-signature'] || req.headers['x-signature'] || req.headers['x-hub-signature'];
            if (!signature) return res.status(401).json({ success: false, error: 'Missing signature' });

            const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(payload);
            if (typeof req.rawBody !== 'string') {
                console.warn('[airtime webhook] req.rawBody missing — signature may be unreliable');
            }
            const expected = crypto.createHmac('sha256', DTONE_WEBHOOK_SECRET).update(rawBody).digest('hex');
            const provided = String(signature).replace(/^sha256=/, '');
            const providedBuf = Buffer.from(provided, 'hex');
            const expectedBuf = Buffer.from(expected, 'hex');
            if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
                return res.status(401).json({ success: false, error: 'Invalid signature' });
            }
        }
        const transactionId = payload.transaction_id || payload.id;
        const externalId = payload.external_id;
        if (!transactionId && !externalId) return res.status(400).json({ success: false, error: 'Missing identifier' });
        let rows = [];
        if (transactionId) {
            const r = await supabaseAdmin.from('airtime_transactions').select('*').eq('provider_transaction_id', String(transactionId));
            rows = r.data || [];
        }
        if (!rows.length && externalId) {
            const r = await supabaseAdmin.from('airtime_transactions').select('*').eq('dtone_external_id', externalId);
            rows = r.data || [];
        }
        if (!rows.length) return res.status(200).json({ success: true, message: 'Not found' });
        if (rows.length > 1) {
            for (const r of rows) {
                await supabaseAdmin.from('airtime_transactions')
                    .update({ status: 'manual_review', updated_at: new Date().toISOString() })
                    .eq('id', r.id).in('status', ['processing','pending']);
            }
            return res.status(200).json({ success: true, message: 'Ambiguous — flagged for review' });
        }
        const transaction = rows[0];
        try {
            const result = await airtimeReconciliation.forceReconcileAirtime(transaction.id);
            // ★ NEW: sync order from the reconciled state
            try {
                const { data: fresh } = await supabaseAdmin
                    .from('airtime_transactions').select('*').eq('id', transaction.id).maybeSingle();
                if (fresh) {
                    await recordOrder({
                        billTransactionId: fresh.id, reference: fresh.reference, userId: fresh.user_id,
                        productType: 'airtime', serviceId: fresh.operator_id, provider: 'dtone',
                        currency: fresh.currency || 'USD',
                        amount: fresh.payment_amount || fresh.total_amount,
                        serviceFee: fresh.fee || 0,
                        totalAmount: fresh.payment_amount || fresh.total_amount,
                        providerCost: 0,
                        status: fresh.status === 'completed' ? 'completed'
                              : fresh.status === 'failed' ? 'failed'
                              : 'pending',
                        recipient: fresh.phone_number,
                        metadata: { via: 'webhook', operator_name: fresh.operator_name }
                    });
                }
            } catch (orderSyncErr) {
                console.error('[AIRTIME webhook] recordOrder failed:', orderSyncErr.message);
            }
            return res.status(200).json({ success: true, reconciled: true, result });
        } catch (reconcileErr) {
            await supabaseAdmin.from('airtime_transactions').update({
                updated_at: new Date().toISOString(),
                metadata: { ...(transaction.metadata || {}), last_webhook: { received_at: new Date().toISOString(), payload, reconciliation_error: reconcileErr.message } }
            }).eq('id', transaction.id);
            return res.status(500).json({ success: false, error: 'Reconciliation failed' });
        }
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/admin/force-reconcile-all', authMiddleware, async (req, res) => {
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!adminEmails.includes(String(req.user.email || '').toLowerCase())) {
        return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    if (adminReconcileRunning) return res.status(409).json({ success: false, error: 'Already running', code: 'ALREADY_RUNNING' });
    adminReconcileRunning = true;
    const startedAt = new Date().toISOString();
    try {
        const { data: stuck, error } = await supabaseAdmin
            .from('airtime_transactions').select('id')
            .in('status', ['processing','pending','provider_unknown'])
            .order('created_at', { ascending: true }).limit(100);
        if (error) throw error;
        const results = [];
        for (const row of (stuck || [])) {
            try {
                const r = await airtimeReconciliation.forceReconcileAirtime(row.id);
                results.push({ id: row.id, ...r });
            } catch (e) {
                results.push({ id: row.id, success: false, error: e.message });
            }
        }
        res.json({ success: true, count: results.length, started_at: startedAt, results });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    } finally {
        adminReconcileRunning = false;
    }
});

module.exports = router;