// routes/giftcardRoutes.js
// Gift Card Routes — MilesSpace
//
// SINGLE SOURCE OF TRUTH: gift_card_products (filtered by provider_env).
// Everything the customer can see in /products is purchasable in
// /purchase, at the same price, because both call
// giftCardAdminService.resolveProductPricing on the same row.
//
// SAFETY (unchanged):
//   • Idempotency-Key required on purchase.
//   • PIN checked atomically via RPCs.
//   • Wallet debit via LedgerService.
//   • Fail BEFORE debit if DT One rejects the product.
//   • Refund on definitive rejection.
//   • PROVIDER_UNKNOWN is non-terminal.
//
// SPEED:
//   • Parallel reads (PIN, idempotency, product, service gate).
//   • DT One preflight is cached per-product for 10 minutes.
//   • Returns 'processing' as soon as the provider accepts.
//
// Batch 2 (2026-11-10):
//   + Every gift card order is mirrored into `orders` so Admin →
//     Orders and Revenue analytics see them. recordOrder() is
//     idempotent on (source_table='giftcard_transactions', source_id).
//     SafeMarkFailed is the single point where gift card failures are
//     recorded — mirroring it here means every failure path updates
//     the order too, without duplicating recordOrder() calls.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const dns = require('dns').promises;
const dtoneService = require('../services/dtoneService');
const { LedgerService } = require('../services/ledgerService');
const adminSettings = require('../services/adminSettingsService');
const pricingEngine = require('../services/pricingEngine');
const giftCardAdmin = require('../services/giftCardAdminService');

// ★ NEW: order mirroring
const fulfillment = require('../services/billsFulfillment');
const recordOrder = (data) => fulfillment.recordOrder(data);

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const MAX_QUANTITY = 1;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

const IDEM_KEY_MIN_LEN = 16;
const IDEM_KEY_MAX_LEN = 100;

const PROVIDER_ENV = String(process.env.DTONE_ENV || '').toLowerCase() === 'production'
    ? 'production'
    : 'preprod';

const SUPPORTED_DEBIT_CURRENCIES = new Set(['USD', 'NGN']);

const ORDER_STATES = Object.freeze({
    PENDING: 'pending',
    PROCESSING: 'processing',
    PROVIDER_UNKNOWN: 'provider_unknown',
    COMPLETED: 'completed',
    FAILED: 'failed',
    REFUNDED: 'refunded',
    CANCELLED: 'cancelled',
    REVERSED: 'reversed',
    MANUAL_REVIEW: 'manual_review'
});

const TERMINAL_STATES = new Set([
    ORDER_STATES.COMPLETED, ORDER_STATES.FAILED,
    ORDER_STATES.REFUNDED, ORDER_STATES.CANCELLED,
    ORDER_STATES.REVERSED
]);

// ─── In-process caches ──────────────────────────────────────────────
const productAvailable = new Map();
const PRODUCT_CHECK_TTL_MS = 10 * 60 * 1000;

function isProductPreflightFresh(productId) {
    const row = productAvailable.get(String(productId));
    if (!row) return false;
    return (Date.now() - row.checkedAt) < PRODUCT_CHECK_TTL_MS;
}

function rememberProductState(productId, available) {
    productAvailable.set(String(productId), { available, checkedAt: Date.now() });
}

// ─── Email Validation ───────────────────────────────────────────────
const mxCache = new Map();
const MX_TTL_MS = 6 * 60 * 60 * 1000;

async function checkEmailDeliverable(raw) {
    const email = String(raw || '').trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { ok: false, code: 'EMAIL_INVALID', message: 'Enter a valid email address.', email };
    }
    const domain = email.split('@')[1];
    const hit = mxCache.get(domain);
    if (hit && Date.now() - hit.at < MX_TTL_MS) {
        return hit.ok ? { ok: true, email } : { ok: false, code: 'EMAIL_NOT_FOUND', message: 'Email not found.', email };
    }
    try {
        const mx = await Promise.race([
            dns.resolveMx(domain),
            new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 3000))
        ]);
        const ok = Array.isArray(mx) && mx.length > 0;
        mxCache.set(domain, { ok, at: Date.now() });
        return ok ? { ok: true, email } : { ok: false, code: 'EMAIL_NOT_FOUND', message: 'Email not found.', email };
    } catch (e) {
        if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') {
            mxCache.set(domain, { ok: false, at: Date.now() });
            return { ok: false, code: 'EMAIL_NOT_FOUND', message: 'Email not found.', email };
        }
        return { ok: true, email, uncertain: true };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function parseBalance(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function parsePage(v, fallback = 1) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseLimit(v, fallback = DEFAULT_PAGE_SIZE) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, MAX_PAGE_SIZE);
}

function stableRequestFingerprint({ productId, currency, quantity, deliveryEmail, countryIso3 }) {
    const payload = JSON.stringify({
        productId: String(productId || ''),
        currency: String(currency || '').toUpperCase(),
        quantity: Number(quantity) || 1,
        deliveryEmail: String(deliveryEmail || '').trim().toLowerCase(),
        countryIso3: String(countryIso3 || '').toUpperCase()
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

function timingSafeEqualHex(a, b) {
    try {
        const aBuf = Buffer.from(String(a || ''), 'hex');
        const bBuf = Buffer.from(String(b || ''), 'hex');
        if (aBuf.length !== bBuf.length) return false;
        return crypto.timingSafeEqual(aBuf, bBuf);
    } catch { return false; }
}

function summarizeProviderResponse(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        id: raw.id,
        external_id: raw.external_id,
        status: raw.status?.message || raw.status?.class?.message || raw.status,
        status_id: raw.status?.id || null,
        status_class_id: raw.status?.class?.id || null,
        error_code: raw.error?.code || raw.errors?.[0]?.code || null,
        error_message: raw.error?.message || raw.errors?.[0]?.message || null,
        has_pin: Boolean(raw.pin?.code || raw.pin?.serial)
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  DB WRITE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const CRITICAL_COLUMNS = new Set([
    'status', 'ledger_transaction_id', 'provider_transaction_id',
    'dtone_external_id', 'refunded', 'refund_status', 'delivery_status',
    'email_status', 'voucher_code', 'voucher_serial',
    'completed_at', 'refunded_at', 'failed_at'
]);

async function updateOrderCritical(orderId, patch) {
    const { data, error } = await supabaseAdmin
        .from('giftcard_transactions')
        .update(patch)
        .eq('id', orderId)
        .select('id')
        .maybeSingle();

    if (error || !data) {
        const e = new Error(
            `Failed to persist order state for ${orderId}: ${error?.message || 'no rows updated'}`
        );
        e.code = 'ORDER_STATE_PERSIST_FAILED';
        throw e;
    }
    return data;
}

const _missingColumnWarned = new Set();

async function updateOrderDiagnostic(orderId, patch) {
    let { error } = await supabaseAdmin
        .from('giftcard_transactions')
        .update(patch)
        .eq('id', orderId);
    if (!error) return true;

    const col = extractMissingColumn(error.message);
    if (col && Object.prototype.hasOwnProperty.call(patch, col)) {
        if (CRITICAL_COLUMNS.has(col)) {
            console.error(`❌ [GIFTCARDS] Attempted metadata fallback for critical column '${col}'`);
            return false;
        }
        if (!_missingColumnWarned.has(col)) {
            console.warn(`⚠️ [GIFTCARDS] Diagnostic column '${col}' missing — writing to metadata`);
            _missingColumnWarned.add(col);
        }
        const { [col]: missingValue, ...rest } = patch;
        if (missingValue !== undefined) {
            try {
                const { data: current } = await supabaseAdmin
                    .from('giftcard_transactions')
                    .select('metadata')
                    .eq('id', orderId)
                    .maybeSingle();
                rest.metadata = { ...(current?.metadata || {}), [col]: missingValue };
            } catch {}
        }
        const retry = await supabaseAdmin
            .from('giftcard_transactions').update(rest).eq('id', orderId);
        if (retry.error) return false;
        return true;
    }
    return false;
}

function extractMissingColumn(msg) {
    if (!msg) return null;
    const m = msg.match(/Could not find the '([^']+)' column/);
    return m ? m[1] : null;
}

// ★ NEW: safeMarkFailed now also mirrors the failure into `orders`.
// This is the single point where gift card debit/pre-debit failures
// happen, so every path that calls it also updates the order.
async function safeMarkFailed(orderId, reason) {
    try {
        await updateOrderCritical(orderId, {
            status: ORDER_STATES.FAILED,
            failure_reason: reason,
            failed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        });
    } catch (e) {
        console.error(`[GIFTCARDS] Could not mark order ${orderId} failed:`, e.message);
    }

    // Best-effort order mirror — never throw from a failure path.
    try {
        const { data: gc } = await supabaseAdmin
            .from('giftcard_transactions')
            .select('reference, user_id, card_name, country_iso3, country_name, face_value, face_currency, debit_amount, debit_currency, total_usd, delivery_email')
            .eq('id', orderId)
            .maybeSingle();
        if (gc) {
            await recordOrder({
                billTransactionId: orderId,
                reference: gc.reference,
                userId: gc.user_id,
                productType: 'giftcard',
                serviceId: gc.country_iso3 || null,
                provider: 'dtone',
                currency: gc.debit_currency || 'USD',
                amount: gc.debit_amount || 0,
                serviceFee: 0,
                totalAmount: gc.debit_amount || 0,
                providerCost: 0,
                status: 'failed',
                recipient: gc.delivery_email || null,
                metadata: {
                    card_name: gc.card_name,
                    country_name: gc.country_name,
                    face_value: gc.face_value,
                    face_currency: gc.face_currency,
                    failure_reason: reason
                }
            });
        }
    } catch (mirrorErr) {
        console.error('[GIFTCARDS safeMarkFailed] recordOrder failed:', mirrorErr.message);
    }
}

function getPublicCallbackUrl(pathname) {
    const base = String(process.env.APP_URL || '').replace(/\/+$/, '');
    if (!base || !base.startsWith('https://')) return null;
    return `${base}${pathname}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  PIN RPCs
// ═══════════════════════════════════════════════════════════════════════════

async function getUserPinState(userId) {
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('transaction_pin_hash, transaction_pin_locked_until, transaction_pin_attempts')
        .eq('id', userId)
        .maybeSingle();
    if (error) throw new Error('Could not load user PIN state');
    return data || {};
}

async function atomicRecordPinFailure(userId) {
    const { data, error } = await supabaseAdmin.rpc('record_pin_failure', { p_user_id: userId });
    if (error) {
        const e = new Error('Unable to verify transaction security right now.');
        e.code = 'PIN_SECURITY_ERROR';
        throw e;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.locked !== 'boolean' || !Number.isInteger(row.attempts_remaining)) {
        const e = new Error('Invalid PIN RPC response.');
        e.code = 'PIN_SECURITY_STATE_ERROR';
        throw e;
    }
    return row;
}

async function atomicResetPinAttempts(userId) {
    supabaseAdmin.rpc('reset_pin_attempts', { p_user_id: userId })
        .then(({ error }) => { if (error) console.error('[PIN RPC] reset failed:', error.message); })
        .catch((e) => console.error('[PIN RPC] reset failed:', e.message));
}

// ═══════════════════════════════════════════════════════════════════════════
//  PRODUCT LOOKUP + PREFLIGHT
// ═══════════════════════════════════════════════════════════════════════════

async function loadPurchasableProduct(productId) {
    const { data: row, error } = await supabaseAdmin
        .from('gift_card_products')
        .select('*')
        .eq('provider', 'dtone')
        .eq('provider_env', PROVIDER_ENV)
        .eq('provider_product_id', String(productId))
        .eq('enabled', true)
        .maybeSingle();

    if (error) {
        console.error('[GIFTCARDS loadPurchasableProduct]', error.message);
        return null;
    }
    if (!row) return null;
    if (row.available === false) return null;
    return row;
}

async function preflightProduct(productId) {
    if (isProductPreflightFresh(productId)) {
        const cached = productAvailable.get(String(productId));
        return { ok: cached.available, reason: cached.available ? null : 'PRODUCT_UNAVAILABLE' };
    }

    try {
        await dtoneService.getProductById(productId);
        rememberProductState(productId, true);
        return { ok: true, reason: null };
    } catch (e) {
        const status = e.response?.status;
        if (status === 404) {
            rememberProductState(productId, false);
            supabaseAdmin
                .from('gift_card_products')
                .update({ available: false, last_cost_error: 'PRODUCT_NOT_FOUND' })
                .eq('provider', 'dtone')
                .eq('provider_env', PROVIDER_ENV)
                .eq('provider_product_id', String(productId))
                .then(() => {})
                .catch(() => {});
            return { ok: false, reason: 'PRODUCT_UNAVAILABLE' };
        }
        if (status && status >= 500) {
            return { ok: true, reason: null };
        }
        console.warn('[GIFTCARDS preflight] non-404 provider error:', status, e.message);
        return { ok: false, reason: 'PRODUCT_UNAVAILABLE' };
    }
}

function mapProviderErrorToClient(err) {
    if (err?.definitiveRejection) {
        return { status: 502, code: 'PROVIDER_REJECTED', error: 'This gift card could not be processed.' };
    }
    if (err?.code === 'PROVIDER_UNKNOWN') {
        return null;
    }
    const status = err?.providerStatus || err?.response?.status;
    if (status === 429 || (status >= 500 && status < 600)) {
        return { status: 502, code: 'PROVIDER_BUSY', error: 'Provider is busy. Please try again shortly.' };
    }
    return { status: 502, code: 'PROVIDER_ERROR', error: 'This gift card could not be processed.' };
}

// ═══════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/wallet/balances', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        if (typeof LedgerService.getAllBalances !== 'function') {
            return res.status(500).json({
                success: false,
                error: 'Ledger balance lookup not available',
                code: 'LEDGER_UNAVAILABLE'
            });
        }
        const balances = await LedgerService.getAllBalances(userId);
        const usd = parseBalance(balances?.USD);
        const ngn = parseBalance(balances?.NGN);
        if (usd === null || ngn === null) {
            return res.status(502).json({
                success: false,
                error: 'Wallet balances unavailable',
                code: 'WALLET_PARSE_FAILED'
            });
        }
        res.json({ success: true, data: { USD: usd, NGN: ngn } });
    } catch (e) {
        console.error('[WALLET] Balance fetch failed:', e.message);
        res.status(500).json({
            success: false,
            error: 'Could not load wallet balances',
            code: 'WALLET_ERROR'
        });
    }
});

router.get('/giftcards/countries', authMiddleware, async (req, res) => {
    try {
        const { data: rows, error } = await supabaseAdmin
            .from('gift_card_products')
            .select('country_iso, country_name')
            .eq('provider', 'dtone')
            .eq('provider_env', PROVIDER_ENV)
            .eq('enabled', true);

        if (error) {
            return res.status(500).json({
                success: false,
                error: 'Could not load country list',
                code: 'COUNTRIES_FAILED'
            });
        }

        const seen = new Map();
        for (const r of rows || []) {
            const iso3 = String(r.country_iso || '').toUpperCase();
            if (!/^[A-Z]{3}$/.test(iso3)) continue;
            if (!seen.has(iso3)) {
                seen.set(iso3, {
                    iso3,
                    iso2: null,
                    name: r.country_name || iso3
                });
            }
        }
        const countries = Array.from(seen.values())
            .sort((a, b) => a.name.localeCompare(b.name));
        res.json({ success: true, data: countries });
    } catch (e) {
        console.error('[COUNTRIES] error:', e.message);
        res.status(500).json({
            success: false,
            error: 'Could not load country list',
            code: 'COUNTRIES_FAILED'
        });
    }
});

router.get('/giftcards/products', authMiddleware, async (req, res) => {
    const startTs = Date.now();
    try {
        let enabled = true;
        try { enabled = await adminSettings.isServiceEnabled('giftcards'); } catch { enabled = false; }
        if (!enabled) {
            return res.json({
                success: true,
                data: [],
                meta: { count: 0, enabled: false, reason: 'GIFTCARDS_DISABLED' }
            });
        }

        const page = parsePage(req.query.page, 1);
        const limit = parseLimit(req.query.limit, DEFAULT_PAGE_SIZE);
        const search = String(req.query.search || '').trim().toLowerCase();
        const country = String(req.query.country || '').toUpperCase() || null;

            let q = supabaseAdmin
            .from('gift_card_products')
            .select(
                'id, provider_product_id, brand, display_name, logo_url, ' +
                'country_iso, country_name, face_value, face_currency, ' +
                'wholesale_amount, wholesale_currency, pricing_mode, pricing_value, ' +
                'customer_price_ngn, customer_price_usd, featured, sort_order'
            )
            .eq('provider', 'dtone')
            .eq('provider_env', PROVIDER_ENV)
            .eq('enabled', true)
            .order('brand', { ascending: true })
            .order('country_name', { ascending: true });

        if (country) q = q.eq('country_iso', country);
        if (search) {
            const safe = search.replace(/[%_]/g, m => '\\' + m);
            q = q.or(`brand.ilike.%${safe}%,display_name.ilike.%${safe}%,country_name.ilike.%${safe}%`);
        }

        const { data: rows, error } = await q;
        if (error) {
            console.error('[GIFTCARDS /products] db query error:', error.message);
            return res.status(500).json({
                success: false,
                error: 'Gift cards are temporarily unavailable',
                code: 'PRODUCTS_FAILED'
            });
        }

        if (!rows || !rows.length) {
            return res.json({
                success: true,
                data: [],
                meta: { page, limit, total: 0, hasMore: false, count: 0 }
            });
        }

        const items = [];
        for (const row of rows) {
            let priced;
            try {
                priced = await giftCardAdmin.resolveProductPricing(row);
            } catch (e) {
                console.warn('[GIFTCARDS /products] price resolve failed for',
                    row.provider_product_id, e.message);
                continue;
            }
            items.push({
                productId:   row.provider_product_id,
                name:        row.display_name || row.brand,
                displayName: row.display_name || row.brand,
                logo:        row.logo_url || null,
                logo_url:    row.logo_url || null,
                countryIso:  row.country_iso || null,
                countryIso2: row.country_iso || null,
                countryName: row.country_name || row.country_iso || null,
                faceValue:   row.face_value != null ? Number(row.face_value) : null,
                currency:    row.face_currency || 'USD',
                priceUsd:    priced.priceUsd,
                priceNgn:    priced.priceNgn,
                featured:    Boolean(row.featured),
                pricingMode: row.pricing_mode || 'global'
            });
        }

        const total = items.length;
        const start = (page - 1) * limit;
        const slice = items.slice(start, start + limit);
        const hasMore = (start + limit) < total;

        res.set('X-Catalog-Source', 'db');
        res.set('X-Provider-Env', PROVIDER_ENV);
        res.set('X-Response-Ms', String(Date.now() - startTs));

        res.json({
            success: true,
            data: slice,
            meta: {
                page, limit, total, hasMore,
                returned: slice.length,
                count: total,
                catalogComplete: true
            }
        });
    } catch (e) {
        console.error('[GIFTCARDS /products] exception:', e.message);
        res.status(500).json({
            success: false,
            error: 'Gift cards are temporarily unavailable',
            code: 'PRODUCTS_FAILED'
        });
    }
});

router.post('/giftcards/validate-email', authMiddleware, async (req, res) => {
    const r = await checkEmailDeliverable(req.body?.email);
    if (!r.ok) return res.status(400).json({ success: false, code: r.code, error: r.message });
    res.json({ success: true, data: { email: r.email } });
});

router.post('/giftcards/purchase', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const idemKey = String(req.headers['idempotency-key'] || '').trim();

    if (!idemKey) {
        return res.status(400).json({
            success: false,
            error: 'Idempotency-Key header is required',
            code: 'IDEMPOTENCY_KEY_REQUIRED'
        });
    }
    if (idemKey.length < IDEM_KEY_MIN_LEN || idemKey.length > IDEM_KEY_MAX_LEN) {
        return res.status(400).json({
            success: false,
            error: `Idempotency-Key must be ${IDEM_KEY_MIN_LEN}-${IDEM_KEY_MAX_LEN} characters`,
            code: 'IDEMPOTENCY_KEY_INVALID'
        });
    }

    const { productId, countryIso3, currency = 'USD', deliveryEmail, quantity = 1, pin } = req.body || {};

    if (!/^\d+$/.test(String(productId || ''))) {
        return res.status(400).json({ success: false, error: 'Invalid productId', code: 'INVALID_PRODUCT' });
    }
    const currencyUpper = String(currency).toUpperCase();
    if (!SUPPORTED_DEBIT_CURRENCIES.has(currencyUpper)) {
        return res.status(400).json({
            success: false,
            error: 'Unsupported currency. Must be USD or NGN.',
            code: 'INVALID_CURRENCY'
        });
    }
        const emailCheck = await checkEmailDeliverable(deliveryEmail);
    if (!emailCheck.ok) {
        return res.status(400).json({
            success: false,
            error: emailCheck.message,
            code: emailCheck.code
        });
    }
    const emailStr = emailCheck.email;
    if (!/^\d{4}$/.test(String(pin || ''))) {
        return res.status(400).json({
            success: false,
            error: 'PIN must be 4 digits',
            code: 'INVALID_PIN_FORMAT'
        });
    }
    const qtyNum = parseInt(quantity, 10);
    if (!Number.isInteger(qtyNum) || qtyNum < 1 || qtyNum > MAX_QUANTITY) {
        return res.status(400).json({
            success: false,
            error: `Quantity must be between 1 and ${MAX_QUANTITY}`,
            code: 'INVALID_QUANTITY'
        });
    }

    const requestFingerprint = stableRequestFingerprint({
        productId, currency: currencyUpper, quantity: qtyNum, deliveryEmail: emailStr, countryIso3
    });

    try {
        // ─── PARALLEL READS ────────────────────────────────────
        const [
            serviceEnabled,
            existingResult,
            pinState,
            productRow
        ] = await Promise.all([
            adminSettings.isServiceEnabled('giftcards').catch(() => false),
            supabaseAdmin
                .from('giftcard_transactions')
                .select('id, reference, status, request_fingerprint')
                .eq('user_id', userId)
                .eq('idempotency_key', idemKey)
                .maybeSingle(),
            getUserPinState(userId),
            loadPurchasableProduct(productId)
        ]);

        if (!serviceEnabled) {
            return res.status(503).json({
                success: false,
                error: 'Gift cards are currently unavailable.',
                code: 'SERVICE_DISABLED'
            });
        }

        if (existingResult.error) {
            return res.status(500).json({
                success: false,
                error: 'Could not verify idempotency state',
                code: 'IDEMPOTENCY_LOOKUP_FAILED'
            });
        }
        const existing = existingResult.data;
        if (existing) {
            if (existing.request_fingerprint && existing.request_fingerprint !== requestFingerprint) {
                return res.status(409).json({
                    success: false,
                    error: 'Idempotency-Key was reused with a different request payload',
                    code: 'IDEMPOTENCY_KEY_REUSE'
                });
            }
            return res.json({
                success: true,
                data: {
                    transactionId: existing.id,
                    reference: existing.reference,
                    status: existing.status,
                    replayed: true
                }
            });
        }

        // ─── PIN CHECK ─────────────────────────────────────────
        if (pinState.transaction_pin_locked_until) {
            const until = new Date(pinState.transaction_pin_locked_until);
            if (until.getTime() > Date.now()) {
                const remaining = Math.ceil((until.getTime() - Date.now()) / 60000);
                return res.status(423).json({
                    success: false,
                    error: `PIN is locked. Try again in ${remaining} minutes.`,
                    code: 'PIN_LOCKED',
                    remaining_minutes: remaining
                });
            }
        }
        if (!pinState.transaction_pin_hash) {
            return res.status(400).json({
                success: false,
                error: 'You have not set a transaction PIN yet.',
                code: 'PIN_NOT_SET'
            });
        }
        const pinOk = await bcrypt.compare(String(pin), pinState.transaction_pin_hash);
        if (!pinOk) {
            let failure;
            try { failure = await atomicRecordPinFailure(userId); }
            catch (rpcErr) {
                return res.status(500).json({
                    success: false,
                    error: rpcErr.message || 'Unable to verify transaction security right now.',
                    code: rpcErr.code || 'PIN_SECURITY_ERROR'
                });
            }
            if (failure.locked) {
                return res.status(423).json({
                    success: false,
                    error: 'Too many incorrect attempts. PIN locked for 1 hour.',
                    code: 'PIN_LOCKED',
                    remaining_minutes: 60
                });
            }
            return res.status(401).json({
                success: false,
                error: 'Incorrect transaction PIN.',
                code: 'INVALID_PIN',
                attempts_remaining: failure.attempts_remaining
            });
            
        }
        
        if ((pinState.transaction_pin_attempts || 0) > 0) {
            atomicResetPinAttempts(userId);
        }

        // ─── PRODUCT PRESENT? ─────────────────────────────────
        if (!productRow) {
            return res.status(404).json({
                success: false,
                error: 'This gift card is no longer available.',
                code: 'PRODUCT_NOT_FOUND'
            });
        }

        // ─── DT ONE PREFLIGHT (cached) ────────────────────────
        const preflight = await preflightProduct(productId);
        if (!preflight.ok) {
            return res.status(409).json({
                success: false,
                error: 'This item is temporarily unavailable. Please pick another.',
                code: 'PRODUCT_UNAVAILABLE'
            });
        }

        // ─── PRICE (same function as /products) ───────────────
        let priced;
        try {
            priced = await giftCardAdmin.resolveProductPricing(productRow);
        } catch (e) {
            console.error('[GIFTCARDS /purchase] pricing failed:', e.message);
            return res.status(500).json({
                success: false,
                error: 'Pricing calculation failed',
                code: 'PRICING_ERROR'
            });
        }

        if (!pricingEngine.isValidDecimalString?.(String(priced.priceUsd)) &&
            typeof priced.priceUsd !== 'string') {
            return res.status(500).json({
                success: false,
                error: 'Pricing calculation failed',
                code: 'PRICING_ERROR'
            });
        }

        const debitAmountStr = currencyUpper === 'NGN'
            ? String(priced.priceNgn)
            : String(priced.priceUsd);
        const totalUsdStr = String(priced.priceUsd);
        const totalNgnStr = String(priced.priceNgn);

        const reference = `GFT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

        // ─── CREATE ORDER ─────────────────────────────────────
        const insertPayload = {
            user_id: userId,
            reference,
            idempotency_key: idemKey,
            request_fingerprint: requestFingerprint,
            country_iso3: productRow.country_iso || null,
            country_iso2: productRow.country_iso || null,
            country_name: productRow.country_name || null,
            product_id: productRow.provider_product_id,
            card_name: productRow.display_name || productRow.brand,
            face_value: productRow.face_value != null ? Number(productRow.face_value) : null,
            face_currency: productRow.face_currency || 'USD',
            quantity: qtyNum,
            wholesale_usd: null,
            price_usd: priced.priceUsd,
            fee_usd: '0.00',
            total_usd: totalUsdStr,
            price_ngn: totalNgnStr,
            debit_currency: currencyUpper,
            debit_amount: debitAmountStr,
            delivery_email: emailStr,
            status: ORDER_STATES.PENDING,
            refund_status: 'not_applicable',
            refunded: false,
            delivery_status: 'pending',
            email_status: 'pending',
            reconciliation_attempts: 0,
            provider_env: PROVIDER_ENV,
            metadata: {
                product_snapshot: {
                    providerProductId: productRow.provider_product_id,
                    brand: productRow.brand,
                    displayName: productRow.display_name,
                    countryIso: productRow.country_iso,
                    faceValue: productRow.face_value,
                    faceCurrency: productRow.face_currency,
                    pricingMode: productRow.pricing_mode
                },
                pricing_snapshot: {
                    price_usd: priced.priceUsd,
                    price_ngn: priced.priceNgn,
                    cost_ngn: priced.costNgn,
                    cost_usd: priced.costUsd,
                    margin_pct: priced.marginPct
                }
            }
        };

        const { data: order, error: insertErr } = await supabaseAdmin
            .from('giftcard_transactions')
            .insert(insertPayload)
            .select()
            .single();

        if (insertErr) {
            if (insertErr.code === '23505') {
                const { data: dup } = await supabaseAdmin
                    .from('giftcard_transactions')
                    .select('id, reference, status, request_fingerprint')
                    .eq('user_id', userId)
                    .eq('idempotency_key', idemKey)
                    .maybeSingle();
                if (dup) {
                    if (dup.request_fingerprint && dup.request_fingerprint !== requestFingerprint) {
                        return res.status(409).json({
                            success: false,
                            error: 'Idempotency-Key was reused with a different request payload',
                            code: 'IDEMPOTENCY_KEY_REUSE'
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            transactionId: dup.id,
                            reference: dup.reference,
                            status: dup.status,
                            replayed: true
                        }
                    });
                }
            }
            return res.status(500).json({
                success: false,
                error: 'Could not create order',
                code: 'ORDER_CREATE_FAILED'
            });
        }

        // ★ NEW: mirror as an order (pending) so it's visible immediately
        try {
            await recordOrder({
                billTransactionId: order.id,
                reference,
                userId,
                productType: 'giftcard',
                serviceId: productRow.country_iso || null,
                provider: 'dtone',
                currency: currencyUpper,
                amount: parseFloat(debitAmountStr),
                serviceFee: 0,
                totalAmount: parseFloat(debitAmountStr),
                providerCost: 0,
                status: 'pending',
                recipient: emailStr,
                metadata: {
                    card_name: productRow.display_name || productRow.brand,
                    country_name: productRow.country_name,
                    face_value: productRow.face_value,
                    face_currency: productRow.face_currency
                }
            });
        } catch (mirrorErr) {
            console.error('[GIFTCARDS] recordOrder (pending) failed:', mirrorErr.message);
        }

        // ─── DEBIT ────────────────────────────────────────────
        let ledgerResult;
        try {
            ledgerResult = await LedgerService.debitWallet(
                userId,
                debitAmountStr,
                currencyUpper,
                `Gift card purchase ${reference}`,
                {
                    type: 'giftcard_purchase',
                    order_id: order.id,
                    reference,
                    product_id: productRow.provider_product_id,
                    card_name: productRow.display_name || productRow.brand
                }
            );
        } catch (debitErr) {
            // safeMarkFailed already mirrors to orders — no duplicate call needed.
            await safeMarkFailed(order.id, `Wallet debit failed: ${debitErr.message}`);
            if (debitErr.code === 'INSUFFICIENT_BALANCE') {
                return res.status(400).json({
                    success: false,
                    error: 'Insufficient wallet balance.',
                    code: 'INSUFFICIENT_BALANCE'
                });
            }
            return res.status(500).json({
                success: false,
                error: 'Could not debit wallet',
                code: 'DEBIT_FAILED'
            });
        }

        if (!ledgerResult || ledgerResult.success !== true || !ledgerResult.transaction_id) {
            // safeMarkFailed mirrors to orders.
            await safeMarkFailed(
                order.id,
                `Wallet debit not confirmed: ${ledgerResult?.error || ledgerResult?.code || 'unknown'}`
            );
            return res.status(500).json({
                success: false,
                error: 'Could not debit wallet',
                code: 'DEBIT_FAILED'
            });
        }

        await updateOrderCritical(order.id, {
            ledger_transaction_id: ledgerResult.transaction_id,
            status: ORDER_STATES.PROCESSING,
            updated_at: new Date().toISOString()
        });

        // ─── PROVIDER CALL ────────────────────────────────────
        const callbackUrl = getPublicCallbackUrl('/api/webhooks/dtone/giftcard');

        let providerResult;
        try {
            providerResult = await dtoneService.purchaseGiftCard({
                productId: productRow.provider_product_id,
                countryIso3: productRow.country_iso,
                quantity: 1,
                externalId: reference,
                callbackUrl: callbackUrl || undefined,
                autoConfirm: true
            });
        } catch (providerErr) {
            const isDefinitive =
                providerErr.definitiveRejection === true ||
                providerErr.providerStatus === 'REJECTED';

            if (!isDefinitive && providerErr.code === 'PROVIDER_UNKNOWN') {
                await updateOrderCritical(order.id, {
                    status: ORDER_STATES.PROVIDER_UNKNOWN,
                    failure_reason: `Provider outcome unknown: ${providerErr.message}`,
                    updated_at: new Date().toISOString()
                });

                // ★ NEW: keep order pending (provider_unknown is not final)
                try {
                    await recordOrder({
                        billTransactionId: order.id, reference, userId,
                        productType: 'giftcard', serviceId: productRow.country_iso || null,
                        provider: 'dtone', currency: currencyUpper,
                        amount: parseFloat(debitAmountStr), serviceFee: 0,
                        totalAmount: parseFloat(debitAmountStr), providerCost: 0,
                        status: 'pending', recipient: emailStr,
                        metadata: {
                            card_name: productRow.display_name || productRow.brand,
                            country_name: productRow.country_name,
                            failure_reason: `Provider outcome unknown: ${providerErr.message}`,
                            provider_unknown: true
                        }
                    });
                } catch (mirrorErr) {
                    console.error('[GIFTCARDS] recordOrder (provider_unknown) failed:', mirrorErr.message);
                }

                return res.status(202).json({
                    success: true,
                    data: {
                        transactionId: order.id,
                        reference,
                        status: ORDER_STATES.PROVIDER_UNKNOWN,
                        debitAmount: debitAmountStr,
                        debitCurrency: currencyUpper,
                        totalUsd: totalUsdStr,
                        totalNgn: totalNgnStr
                    }
                });
            }

            console.error('[GIFTCARDS] provider rejected:', providerErr.message,
                summarizeProviderResponse(providerErr.providerData));

            try {
                const refundResult = await LedgerService.refundTransaction({
                    userId,
                    transactionId: ledgerResult.transaction_id,
                    reason: `Gift card rejected: ${providerErr.message}`
                });
                if (!refundResult || refundResult.success !== true) {
                    throw new Error(refundResult?.error || 'Refund did not succeed');
                }
                await updateOrderCritical(order.id, {
                    status: ORDER_STATES.REFUNDED,
                    refunded: true,
                    refund_status: 'completed',
                    refunded_at: new Date().toISOString(),
                    failure_reason: `Provider rejected: ${providerErr.message}`,
                    failed_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                });

                // ★ NEW: mark order failed (refunded orders do not count as revenue)
                try {
                    await recordOrder({
                        billTransactionId: order.id, reference, userId,
                        productType: 'giftcard', serviceId: productRow.country_iso || null,
                        provider: 'dtone', currency: currencyUpper,
                        amount: parseFloat(debitAmountStr), serviceFee: 0,
                        totalAmount: parseFloat(debitAmountStr), providerCost: 0,
                        status: 'failed', recipient: emailStr,
                        metadata: {
                            card_name: productRow.display_name || productRow.brand,
                            country_name: productRow.country_name,
                            failure_reason: `Provider rejected: ${providerErr.message}`,
                            refunded: true
                        }
                    });
                } catch (mirrorErr) {
                    console.error('[GIFTCARDS] recordOrder (refunded) failed:', mirrorErr.message);
                }

                const clientErr = mapProviderErrorToClient(providerErr);
                return res.status(clientErr.status).json({
                    success: false,
                    error: clientErr.error + ' Your wallet has been refunded.',
                    code: clientErr.code
                });
            } catch (refundErr) {
                console.error('[GIFTCARDS] refund failed:', refundErr.message);
                await updateOrderCritical(order.id, {
                    status: ORDER_STATES.MANUAL_REVIEW,
                    failure_reason: `Provider rejected and refund failed: ${refundErr.message}`,
                    refund_status: 'failed',
                    updated_at: new Date().toISOString()
                });

                // ★ NEW: mark order failed (manual review means we won't honour it as revenue)
                try {
                    await recordOrder({
                        billTransactionId: order.id, reference, userId,
                        productType: 'giftcard', serviceId: productRow.country_iso || null,
                        provider: 'dtone', currency: currencyUpper,
                        amount: parseFloat(debitAmountStr), serviceFee: 0,
                        totalAmount: parseFloat(debitAmountStr), providerCost: 0,
                        status: 'failed', recipient: emailStr,
                        metadata: {
                            card_name: productRow.display_name || productRow.brand,
                            country_name: productRow.country_name,
                            failure_reason: `Provider rejected and refund failed: ${refundErr.message}`,
                            manual_review: true
                        }
                    });
                } catch (mirrorErr) {
                    console.error('[GIFTCARDS] recordOrder (manual_review) failed:', mirrorErr.message);
                }

                return res.status(500).json({
                    success: false,
                    error: 'Purchase encountered a problem. Our team will resolve it.',
                    code: 'MANUAL_REVIEW'
                });
            }
        }

        const providerTxId = providerResult?.transactionId || null;
        const providerExternalId = providerResult?.externalId || reference;

        if (!providerTxId) {
            await updateOrderCritical(order.id, {
                status: ORDER_STATES.PROVIDER_UNKNOWN,
                dtone_external_id: providerExternalId,
                failure_reason: 'Provider returned no transaction ID',
                updated_at: new Date().toISOString()
            });

            // ★ NEW: leave order pending
            try {
                await recordOrder({
                    billTransactionId: order.id, reference, userId,
                    productType: 'giftcard', serviceId: productRow.country_iso || null,
                    provider: 'dtone', currency: currencyUpper,
                    amount: parseFloat(debitAmountStr), serviceFee: 0,
                    totalAmount: parseFloat(debitAmountStr), providerCost: 0,
                    status: 'pending', recipient: emailStr,
                    metadata: {
                        card_name: productRow.display_name || productRow.brand,
                        country_name: productRow.country_name,
                        failure_reason: 'Provider returned no transaction ID',
                        provider_unknown: true
                    }
                });
            } catch (mirrorErr) {
                console.error('[GIFTCARDS] recordOrder (no-tx-id) failed:', mirrorErr.message);
            }

            return res.status(202).json({
                success: true,
                data: {
                    transactionId: order.id,
                    reference,
                    status: ORDER_STATES.PROVIDER_UNKNOWN,
                    debitAmount: debitAmountStr,
                    debitCurrency: currencyUpper,
                    totalUsd: totalUsdStr,
                    totalNgn: totalNgnStr
                }
            });
        }

        await updateOrderCritical(order.id, {
            provider_transaction_id: String(providerTxId),
            dtone_external_id: providerExternalId,
            provider_status: providerResult.status || 'SUBMITTED',
            updated_at: new Date().toISOString()
        });

        await updateOrderDiagnostic(order.id, {
            provider_response_summary: summarizeProviderResponse(providerResult.raw)
        }).catch(() => {});

        // Order stays 'pending' in our mirror until webhook/reconciliation
        // marks it completed (via reconciliation.completeGiftCard) or failed.
        // No extra recordOrder call needed here — the pending call above
        // already created the row.

        return res.json({
            success: true,
            data: {
                transactionId: order.id,
                reference,
                status: ORDER_STATES.PROCESSING,
                debitAmount: debitAmountStr,
                debitCurrency: currencyUpper,
                totalUsd: totalUsdStr,
                totalNgn: totalNgnStr
            }
        });

    } catch (e) {
        console.error('[PURCHASE] Unexpected error:', e);
        res.status(500).json({
            success: false,
            error: 'Purchase failed',
            code: e.code || 'PURCHASE_FAILED'
        });
    }
});

router.get('/giftcards/status/:id', authMiddleware, async (req, res) => {
    try {
        const { data: order, error } = await supabaseAdmin
            .from('giftcard_transactions')
            .select('*')
            .eq('id', req.params.id)
            .eq('user_id', req.user.id)
            .maybeSingle();

        if (error || !order) {
            return res.status(404).json({
                success: false, error: 'Order not found', code: 'ORDER_NOT_FOUND'
            });
        }

        if (TERMINAL_STATES.has(order.status)) {
            return res.json({ success: true, data: shapeStatusResponse(order) });
        }
        if (!order.provider_transaction_id) {
            return res.json({ success: true, data: shapeStatusResponse(order) });
        }

        const lastReconciled = order.last_reconciled_at
            ? new Date(order.last_reconciled_at).getTime()
            : 0;
        if (Date.now() - lastReconciled < 4000) {
            return res.json({ success: true, data: shapeStatusResponse(order) });
        }

        await supabaseAdmin
            .from('giftcard_transactions')
            .update({ last_reconciled_at: new Date().toISOString() })
            .eq('id', order.id)
            .then(() => {})
            .catch(() => {});

        let result = null;
        try {
            result = await dtoneService.queryTransaction(order.provider_transaction_id);
        } catch (queryErr) {
            return res.json({ success: true, data: shapeStatusResponse(order) });
        }

        const reconciliation = require('../services/airtimeReconciliationService');
        if (result.status === 'completed') {
            try { await reconciliation.completeGiftCard(order, result); } catch {}
        } else if (result.isFinal && ['failed', 'cancelled', 'reversed'].includes(result.status)) {
            try { await reconciliation.refundGiftCard(order, result); } catch {}
        }

        const { data: fresh } = await supabaseAdmin
            .from('giftcard_transactions')
            .select('*')
            .eq('id', order.id)
            .maybeSingle();

        // ★ NEW: sync order from the reconciled state.
        // The reconciliation service itself is not modified — instead we
        // read the fresh row and mirror it here, so any caller (this
        // status route, webhook, admin tooling) gets the same behaviour.
        try {
            const f = fresh || order;
            if (f && f.status) {
                const orderStatus =
                    f.status === ORDER_STATES.COMPLETED ? 'completed'
                  : (f.status === ORDER_STATES.FAILED || f.status === ORDER_STATES.CANCELLED ||
                     f.status === ORDER_STATES.REVERSED || f.status === ORDER_STATES.REFUNDED ||
                     f.status === ORDER_STATES.MANUAL_REVIEW) ? 'failed'
                  : 'pending';
                await recordOrder({
                    billTransactionId: f.id,
                    reference: f.reference,
                    userId: f.user_id,
                    productType: 'giftcard',
                    serviceId: f.country_iso3 || null,
                    provider: 'dtone',
                    currency: f.debit_currency || 'USD',
                    amount: parseFloat(f.debit_amount || 0),
                    serviceFee: 0,
                    totalAmount: parseFloat(f.debit_amount || 0),
                    providerCost: 0,
                    status: orderStatus,
                    recipient: f.delivery_email || null,
                    metadata: {
                        card_name: f.card_name,
                        country_name: f.country_name,
                        face_value: f.face_value,
                        face_currency: f.face_currency,
                        failure_reason: f.failure_reason || null,
                        via: 'status_route'
                    }
                });
            }
        } catch (mirrorErr) {
            console.error('[GIFTCARDS /status] recordOrder failed:', mirrorErr.message);
        }

        return res.json({ success: true, data: shapeStatusResponse(fresh || order) });
    } catch (e) {
        return res.status(500).json({
            success: false,
            error: 'Could not check gift card status',
            code: 'STATUS_FAILED'
        });
    }
});

function shapeStatusResponse(t) {
    return {
        id: t.id,
        reference: t.reference,
        status: t.status,
        isFinal: TERMINAL_STATES.has(t.status),
        cardName: t.card_name,
        faceValue: Number(t.face_value) || 0,
        faceCurrency: t.face_currency,
        quantity: Number(t.quantity) || 1,
        voucherCode: t.status === ORDER_STATES.COMPLETED ? t.voucher_code : null,
        voucherSerial: t.status === ORDER_STATES.COMPLETED ? t.voucher_serial : null,
        instructions: t.instructions,
        errorMessage: t.failure_reason || null,
        totalUsd: Number(t.total_usd) || 0,
        totalNgn: Number(t.price_ngn) || 0,
        debitAmount: Number(t.debit_amount) || 0,
        debitCurrency: t.debit_currency,
        createdAt: t.created_at,
        completedAt: t.completed_at
    };
}

router.get('/giftcards/history', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('giftcard_transactions')
            .select(`
                id, reference, country_iso3, country_iso2, country_name,
                product_id, card_name, face_value, face_currency, quantity,
                total_usd, price_ngn, debit_amount, debit_currency, status,
                voucher_code, created_at, completed_at
            `)
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) throw error;

        const shaped = (data || []).map((t) => ({
            id: t.id,
            reference: t.reference,
            countryName: t.country_name,
            countryIso: t.country_iso3,
            countryIso2: t.country_iso2,
            productId: t.product_id,
            cardName: t.card_name,
            faceValue: Number(t.face_value) || 0,
            faceCurrency: t.face_currency,
            quantity: Number(t.quantity) || 1,
            totalUsd: Number(t.total_usd) || 0,
            totalNgn: Number(t.price_ngn) || 0,
            debitAmount: Number(t.debit_amount) || 0,
            debitCurrency: t.debit_currency,
            status: t.status,
            createdAt: t.created_at,
            completedAt: t.completed_at
        }));

        res.json({ success: true, data: shaped });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message, code: 'HISTORY_FAILED' });
    }
});

router.post('/webhooks/dtone/giftcard', express.json({ limit: '1mb' }), async (req, res) => {
    try {
        const payload = req.body || {};
        const signature = String(
            req.headers['x-dtone-signature'] || req.headers['x-signature'] || ''
        ).trim();

        const secret = process.env.DTONE_WEBHOOK_SECRET;
        if (secret) {
            if (!signature) return res.status(401).json({ success: false, error: 'Missing signature' });
            const expected = crypto
                .createHmac('sha256', secret)
                .update(JSON.stringify(payload))
                .digest('hex');
            if (!timingSafeEqualHex(expected, signature)) {
                return res.status(401).json({ success: false, error: 'Invalid signature' });
            }
        } else if (process.env.NODE_ENV === 'production') {
            return res.status(401).json({ success: false, error: 'Webhook auth not configured' });
        }

        const dtoneTxId = payload?.transaction_id || payload?.id || payload?.transactionId;
        const externalId = payload?.external_id || payload?.externalId;
        if (!dtoneTxId && !externalId) {
            return res.status(400).json({ success: false, error: 'Missing transaction identifier' });
        }

        let order = null;
        if (dtoneTxId) {
            const { data } = await supabaseAdmin
                .from('giftcard_transactions').select('*')
                .eq('provider_transaction_id', String(dtoneTxId)).maybeSingle();
            order = data;
        }
        if (!order && externalId) {
            const { data } = await supabaseAdmin
                .from('giftcard_transactions').select('*')
                .eq('dtone_external_id', String(externalId)).maybeSingle();
            order = data;
        }

        if (!order) {
            return res.status(200).json({ success: true, note: 'Order not found' });
        }

        try {
            const reconciliation = require('../services/airtimeReconciliationService');
            const result = await reconciliation.forceReconcileTransaction(
                'giftcard_transactions',
                order.id
            );

            // ★ NEW: sync order from reconciled state.
            try {
                const { data: fresh } = await supabaseAdmin
                    .from('giftcard_transactions').select('*').eq('id', order.id).maybeSingle();
                const f = fresh || order;
                if (f && f.status) {
                    const orderStatus =
                        f.status === ORDER_STATES.COMPLETED ? 'completed'
                      : (f.status === ORDER_STATES.FAILED || f.status === ORDER_STATES.CANCELLED ||
                         f.status === ORDER_STATES.REVERSED || f.status === ORDER_STATES.REFUNDED ||
                         f.status === ORDER_STATES.MANUAL_REVIEW) ? 'failed'
                      : 'pending';
                    await recordOrder({
                        billTransactionId: f.id,
                        reference: f.reference,
                        userId: f.user_id,
                        productType: 'giftcard',
                        serviceId: f.country_iso3 || null,
                        provider: 'dtone',
                        currency: f.debit_currency || 'USD',
                        amount: parseFloat(f.debit_amount || 0),
                        serviceFee: 0,
                        totalAmount: parseFloat(f.debit_amount || 0),
                        providerCost: 0,
                        status: orderStatus,
                        recipient: f.delivery_email || null,
                        metadata: {
                            card_name: f.card_name,
                            country_name: f.country_name,
                            face_value: f.face_value,
                            face_currency: f.face_currency,
                            failure_reason: f.failure_reason || null,
                            via: 'webhook'
                        }
                    });
                }
            } catch (mirrorErr) {
                console.error('[GIFTCARDS webhook] recordOrder failed:', mirrorErr.message);
            }

            return res.status(200).json({ success: true, result });
        } catch (verifyErr) {
            return res.status(200).json({
                success: true,
                note: 'Verification failed, deferred to reconciliation'
            });
        }
    } catch (e) {
        res.status(200).json({ success: false, error: e.message });
    }
});

module.exports = router;