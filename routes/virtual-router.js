// routes/virtual-router.js
// ─────────────────────────────────────────────────────────────────────────────
// USER-FACING Virtual SMS API.
//
// This file is the SINGLE user-facing entrypoint. It:
//   • Enforces feature/service/emergency/provider gates on every request.
//   • Computes prices LIVE from admin settings (never from stale cache).
//   • Requires Idempotency-Key on POST /order (400 otherwise).
//   • Calls the provider exactly ONCE per order.
//   • On definite failure, refunds immediately via orderService.
//   • On ambiguity, returns { status: 'processing' } and the worker resolves.
//   • Reads from the DB only on status/active/orders (no provider calls).
//   • Never echoes internal error messages.
//   • Never writes virtual_sms_orders.status directly — every transition
//     goes through vsmsOrderService.
//
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { LedgerService } = require('../services/ledgerService');
const adminSettings = require('../services/adminSettingsService');
const pricingEngine = require('../services/pricingEngine');
const orderService = require('../services/vsmsOrderService');
const provider = require('../services/vsmsProvider');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Error helper ─────────────────────────────────────────────────────────
function makeErr(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    Object.assign(e, extra);
    return e;
}

function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code = err?.code || 'VIRTUAL_SMS_ERROR';
    const message = status >= 500
        ? 'Something went wrong. Please try again.'
        : (err?.message || 'Request failed.');

    if (status >= 500) {
        console.error('[VSMS USER]', code, err?.message);
    }

    const body = { success: false, error: message, code };
    if (err?.min_ngn != null) body.min_ngn = err.min_ngn;
    if (err?.max_ngn != null) body.max_ngn = err.max_ngn;
    if (err?.can_cancel_at) body.can_cancel_at = err.can_cancel_at;
    if (err?.wait_seconds != null) body.wait_seconds = err.wait_seconds;
    if (err?.required_amount != null) body.required_amount = err.required_amount;
    if (err?.available_amount != null) body.available_amount = err.available_amount;

    res.status(status).json(body);
}

// ─── Rate limiters ────────────────────────────────────────────────────────
const orderLimiter = rateLimit({
    windowMs: 60_000,
    max: 6,
    keyGenerator: (req) => req.user?.id || req.ip,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many orders. Slow down.', code: 'RATE_LIMIT' }
});
const statusLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    keyGenerator: (req) => req.user?.id || req.ip,
    standardHeaders: true,
    legacyHeaders: false
});
const cancelLimiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    keyGenerator: (req) => req.user?.id || req.ip,
    standardHeaders: true,
    legacyHeaders: false
});
const retryLimiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    keyGenerator: (req) => req.user?.id || req.ip,
    standardHeaders: true,
    legacyHeaders: false
});

// ─── Live pricing ─────────────────────────────────────────────────────────
// THE single price calculator. Called once per request. Reads settings
// ONCE per request, not per row. Uses pricingEngine.calculatePrice so
// the result matches every other service in the platform.
//
// Returns { priceUsd, priceNgn, wholesaleUsd, markup, usdToNgn }.
// priceUsd and priceNgn are DECIMAL STRINGS from pricingEngine — never
// Number() them.
async function resolveLivePrice({ providerCostUsd }) {
    const wholesaleUsd = Number(providerCostUsd);
    if (!Number.isFinite(wholesaleUsd) || wholesaleUsd <= 0) {
        throw makeErr('PROVIDER_COST_MISSING',
            'Provider cost is not configured for this service.', 503);
    }

    // Read rate + markup ONCE per request.
    let markup, usdToNgn;
    try {
        markup   = await adminSettings.getMarkup('virtual_sms', 'USD');
        usdToNgn = await adminSettings.getRate('USD', 'NGN');
    } catch (e) {
        throw makeErr(
            'PRICING_NOT_READY',
            'Pricing is temporarily unavailable. Please try again.',
            503
        );
    }

    const priced = pricingEngine.calculatePrice({
        wholesaleAmount:   wholesaleUsd.toFixed(6),
        wholesaleCurrency: 'USD',
        usdToNgn:          String(usdToNgn),
        mode:              'markup_pct',
        value:             String(markup),
        globalMarkupUsd:   String(markup),
        globalMarkupNgn:   String(markup)
    });

    // Round UP to the nearest cent/kobo (pricingEngine uses half-up;
    // we bump UP so the customer never pays less than cost+markup).
    const priceUsdStr = roundUpMoney(priced.priceUsd);
    const priceNgnStr = roundUpMoney(priced.priceNgn);

    const priceUsdNum = parseFloat(priceUsdStr);
    const priceNgnNum = parseFloat(priceNgnStr);

    // Sanity: price must never be below cost.
    const costNgnNum = wholesaleUsd * parseFloat(String(usdToNgn));
    if (priceNgnNum < costNgnNum - 0.01) {
        throw makeErr('PRICE_BELOW_COST',
            'Pricing error: computed price is below cost. Please contact support.', 503);
    }

    return {
        priceUsd:    priceUsdNum,
        priceNgn:    priceNgnNum,
        wholesaleUsd,
        markup:      String(markup),
        usdToNgn:    Number(usdToNgn)
    };
}

// Round a decimal string UP to the next 0.01.
function roundUpMoney(s) {
    const str = String(s == null ? '0' : s);
    const m = /^(-?\d+)(?:\.(\d+))?$/.exec(str);
    if (!m) return '0.00';
    const neg = str.startsWith('-');
    const intPart = m[1].replace('-', '');
    const fracPart = (m[2] || '');
    // 2 decimals
    if (fracPart.length <= 2) {
        return (neg ? '-' : '') + intPart + '.' + (fracPart.padEnd(2, '0'));
    }
    const keep = fracPart.slice(0, 2);
    const rest = fracPart.slice(2);
    const roundUp = /[1-9]/.test(rest);
    let cents = BigInt(intPart) * 100n + BigInt(keep);
    if (roundUp) cents += 1n;
    const whole = cents / 100n;
    const frac = (cents % 100n).toString().padStart(2, '0');
    return (neg ? '-' : '') + whole.toString() + '.' + frac;
}

// ─── Limits ───────────────────────────────────────────────────────────────
async function assertWithinLimits({ chargeAmount, chargeCurrency, usdToNgn }) {
    let minNgn = 0, maxNgn = 0;
    try {
        minNgn = Number(await adminSettings.getRaw('virtual_sms_min_ngn'));
        maxNgn = Number(await adminSettings.getRaw('virtual_sms_max_ngn'));
    } catch { /* defaults remain 0 */ }

    const ngnEquiv = String(chargeCurrency).toUpperCase() === 'USD'
        ? Number(chargeAmount) * usdToNgn
        : Number(chargeAmount);

    if (Number.isFinite(minNgn) && minNgn > 0 && ngnEquiv < minNgn - 0.01) {
        throw makeErr('BELOW_MIN_LIMIT',
            `Minimum order for Virtual SMS is ₦${minNgn.toFixed(2)}.`,
            400, { min_ngn: minNgn });
    }
    if (Number.isFinite(maxNgn) && maxNgn > 0 && ngnEquiv > maxNgn + 0.01) {
        throw makeErr('ABOVE_MAX_LIMIT',
            `Maximum order for Virtual SMS is ₦${maxNgn.toFixed(2)}.`,
            400, { max_ngn: maxNgn });
    }
}

// ─── Gates ────────────────────────────────────────────────────────────────
async function assertAllGatesBeforeDebit() {
    // Service enabled?
    await adminSettings.assertServiceEnabled('virtual_sms');
    // Emergency gates.
    await adminSettings.assertOperationAllowed('purchase');
    await adminSettings.assertOperationAllowed('wallet_mutation');
    // Provider enabled?
    try {
        await adminSettings.assertProviderEnabled('virtualsms');
    } catch (e) {
        if (e.code === 'PROVIDER_NOT_CONFIGURED' || e.code === 'PROVIDER_DISABLED') {
            throw makeErr('PROVIDER_UNAVAILABLE',
                'The SMS provider is temporarily unavailable. Please try again shortly.',
                503);
        }
        throw e;
    }
}

async function assertProviderBreakerOpen() {
    const { data } = await supabaseAdmin
        .from('vsms_provider_state')
        .select('breaker_state')
        .eq('provider', 'virtualsms')
        .maybeSingle();
    if (data && data.breaker_state === 'OPEN') {
        throw makeErr('PROVIDER_OUT_OF_BALANCE',
            'The SMS provider is temporarily unavailable. Please try again shortly.',
            503);
    }
}

// ═════════════════════════════════════════════════════════════════════════
//  GET /countries — catalogue only, from DB
// ═════════════════════════════════════════════════════════════════════════
router.get('/countries', async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('virtual_sms_countries')
            .select('id, name, flag, sort_order')
            .eq('enabled', true)
            .order('sort_order', { ascending: true })
            .order('name', { ascending: true });

        if (error) throw error;

        const countries = (data || []).map(c => ({
            id: c.id,
            eng: c.name,
            name: c.name,
            flag: c.flag || '🌐'
        }));

        res.json({ success: true, countries, enabled: true, server_now: new Date().toISOString() });
    } catch (e) {
        sendErr(res, e);
    }
});

// ═════════════════════════════════════════════════════════════════════════
//  GET /services-with-prices?country=X
//  Cache the CATALOGUE (cost, count) for 5 min. Compute PRICE live.
// ═════════════════════════════════════════════════════════════════════════
const catalogueCache = new Map();   // countryId → { data, ts }
const CATALOGUE_TTL_MS = 5 * 60_000;

router.get('/services-with-prices', async (req, res) => {
    try {
        // Feature gate — but still return the catalogue shape.
        let enabled = true;
        try { enabled = await adminSettings.isServiceEnabled('virtual_sms'); } catch {}
        if (!enabled) {
            return res.json({
                success: true, services: [], enabled: false,
                reason: 'VIRTUAL_SMS_DISABLED',
                server_now: new Date().toISOString()
            });
        }

        const countryId = parseInt(req.query.country, 10);
        if (!Number.isFinite(countryId) || countryId <= 0) {
            return res.status(400).json({ success: false, error: 'country parameter required', code: 'INVALID_COUNTRY' });
        }
        if (countryId === 12) {
            return res.json({ success: true, services: [], blocked: true, server_now: new Date().toISOString() });
        }

        // Circuit breaker — do not show prices when provider is dead.
        try { await assertProviderBreakerOpen(); }
        catch (breakerErr) {
            if (breakerErr.code === 'PROVIDER_OUT_OF_BALANCE') {
                return res.json({
                    success: true, services: [], enabled: false,
                    reason: 'PROVIDER_OUT_OF_BALANCE',
                    server_now: new Date().toISOString()
                });
            }
            throw breakerErr;
        }

        // Get the catalogue (cost + count) — cached.
        let catalogue = catalogueCache.get(countryId);
        if (!catalogue || (Date.now() - catalogue.ts) > CATALOGUE_TTL_MS) {
            const { data, error } = await supabaseAdmin
                .from('virtual_sms_services')
                .select('service_code, service_name, available_count, provider_cost_usd, custom_name, missing_syncs')
                .eq('country_id', countryId)
                .eq('enabled', true)
                .gt('available_count', 0)
                .order('service_name', { ascending: true });
            if (error) throw error;

            catalogue = {
                data: (data || []).map(s => ({
                    code:  s.service_code,
                    name:  s.custom_name || s.service_name || s.service_code,
                    count: s.available_count,
                    cost:  Number(s.provider_cost_usd) || 0,
                    missingSyncs: s.missing_syncs || 0
                })),
                ts: Date.now()
            };
            catalogueCache.set(countryId, catalogue);
        }

        // Read markup + rate ONCE per request.
        let markup, usdToNgn;
        try {
            markup   = await adminSettings.getMarkup('virtual_sms', 'USD');
            usdToNgn = await adminSettings.getRate('USD', 'NGN');
        } catch {
            return res.json({
                success: true, services: [], enabled: true,
                reason: 'PRICING_NOT_READY',
                server_now: new Date().toISOString()
            });
        }

        // Compute price per row (pure math, no DB).
        const services = [];
        for (const row of catalogue.data) {
            if (!(row.cost > 0)) continue;
            try {
                const priced = pricingEngine.calculatePrice({
                    wholesaleAmount:   Number(row.cost).toFixed(6),
                    wholesaleCurrency: 'USD',
                    usdToNgn:          String(usdToNgn),
                    mode:              'markup_pct',
                    value:             String(markup),
                    globalMarkupUsd:   String(markup),
                    globalMarkupNgn:   String(markup)
                });
                services.push({
                    code:       row.code,
                    name:       row.name,
                    count:      row.count,
                    sellingUSD: parseFloat(roundUpMoney(priced.priceUsd)),
                    sellingNGN: parseFloat(roundUpMoney(priced.priceNgn)),
                    cost:       row.cost,
                    available:  row.count > 0
                });
            } catch (e) {
                // Skip a row that can't be priced — do not fail the page.
                console.warn('[VSMS USER] price compute failed for', row.code, e.message);
            }
        }

        res.json({
            success: true,
            services,
            enabled: true,
            server_now: new Date().toISOString()
        });
    } catch (e) {
        console.error('[VSMS USER] /services-with-prices error:', e.message);
        res.json({
            success: true, services: [], enabled: true,
            reason: 'CATALOGUE_ERROR',
            server_now: new Date().toISOString()
        });
    }
});

// ═════════════════════════════════════════════════════════════════════════
//  GET /countries-for-service?service=wa — service-first flow
// ═════════════════════════════════════════════════════════════════════════
router.get('/countries-for-service', async (req, res) => {
    try {
        const service = String(req.query.service || '').trim().toLowerCase();
        if (!service) return res.status(400).json({ success: false, error: 'service required', code: 'INVALID_SERVICE' });

        const { data, error } = await supabaseAdmin
            .from('virtual_sms_services')
            .select('country_id, available_count, provider_cost_usd, virtual_sms_countries!inner(id, name, flag)')
            .eq('service_code', service)
            .eq('enabled', true)
            .gt('available_count', 0)
            .order('provider_cost_usd', { ascending: true });

        if (error) throw error;

        let markup, usdToNgn;
        try {
            markup   = await adminSettings.getMarkup('virtual_sms', 'USD');
            usdToNgn = await adminSettings.getRate('USD', 'NGN');
        } catch {
            return res.json({ success: true, countries: [], reason: 'PRICING_NOT_READY' });
        }

        const countries = [];
        for (const row of data || []) {
            if (!(Number(row.provider_cost_usd) > 0)) continue;
            try {
                const priced = pricingEngine.calculatePrice({
                    wholesaleAmount:   Number(row.provider_cost_usd).toFixed(6),
                    wholesaleCurrency: 'USD',
                    usdToNgn:          String(usdToNgn),
                    mode:              'markup_pct',
                    value:             String(markup),
                    globalMarkupUsd:   String(markup),
                    globalMarkupNgn:   String(markup)
                });
                countries.push({
                    id:         row.virtual_sms_countries.id,
                    eng:        row.virtual_sms_countries.name,
                    flag:       row.virtual_sms_countries.flag || '🌐',
                    count:      row.available_count,
                    sellingUSD: parseFloat(roundUpMoney(priced.priceUsd)),
                    sellingNGN: parseFloat(roundUpMoney(priced.priceNgn))
                });
            } catch { /* skip */ }
        }
        countries.sort((a, b) => a.sellingUSD - b.sellingUSD);

        res.json({ success: true, countries, server_now: new Date().toISOString() });
    } catch (e) {
        sendErr(res, e);
    }
});

// ═════════════════════════════════════════════════════════════════════════
//  GET /popular-services — pinned services for the UI
// ═════════════════════════════════════════════════════════════════════════
router.get('/popular-services', async (req, res) => {
    const POPULAR = ['wa', 'tg', 'go', 'fb', 'ig', 'tk', 'dc', 'tw', 'ub'];
    try {
        const { data, error } = await supabaseAdmin
            .from('virtual_sms_services')
            .select('service_code, service_name')
            .in('service_code', POPULAR)
            .eq('enabled', true)
            .gt('available_count', 0)
            .limit(50);
        if (error) throw error;
        const seen = new Set();
        const services = [];
        for (const row of data || []) {
            if (seen.has(row.service_code)) continue;
            seen.add(row.service_code);
            services.push({ code: row.service_code, name: row.service_name });
        }
        res.json({ success: true, services });
    } catch (e) {
        sendErr(res, e);
    }
});

// ═════════════════════════════════════════════════════════════════════════
//  POST /order — the single place an order is created
// ═════════════════════════════════════════════════════════════════════════
router.post('/order', authMiddleware, orderLimiter, async (req, res) => {
    try {
        const userId = req.user.id;
        const body = req.body || {};

        // ── Validate input ──────────────────────────────────────────────
        const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
        if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
            return res.status(400).json({
                success: false,
                error: 'An Idempotency-Key header (8-200 characters) is required.',
                code: 'IDEMPOTENCY_KEY_REQUIRED'
            });
        }

        const countryId = parseInt(body.country, 10);
        if (!Number.isFinite(countryId) || countryId <= 0) {
            return makeErr('INVALID_COUNTRY', 'country is required', 400);
        }
        if (countryId === 12) {
            throw makeErr('COUNTRY_BLOCKED', 'This country is not supported.', 400);
        }

        const serviceCode = String(body.service || '').trim().toLowerCase();
        if (!serviceCode) {
            throw makeErr('INVALID_SERVICE', 'service is required', 400);
        }

        const currency = body.currency === 'USD' ? 'USD' : 'NGN';

        // ── Gates ───────────────────────────────────────────────────────
        await assertAllGatesBeforeDebit();
        await assertProviderBreakerOpen();

        // ── Duplicate short-circuit ─────────────────────────────────────
        const { data: existing } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('*')
            .eq('user_id', userId)
            .eq('idempotency_key', idempotencyKey)
            .maybeSingle();
        if (existing) {
            return res.json({
                success: true,
                orderId:       existing.id,
                activationId:  existing.activation_id,
                phoneNumber:   existing.phone_number,
                status:        existing.status,
                chargeCurrency: existing.charge_currency,
                chargeAmount:  Number(existing.charge_amount),
                priceUsd:      Number(existing.price_usd),
                priceNgn:      Number(existing.price_ngn),
                expiresAt:     existing.expires_at,
                service:       existing.service_name || existing.service_code,
                transaction: {
                    id:        existing.ledger_transaction_id,
                    reference: existing.ledger_reference
                },
                duplicate:     true
            });
        }

        // ── Catalogue row ───────────────────────────────────────────────
        const { data: serviceRow, error: svcErr } = await supabaseAdmin
            .from('virtual_sms_services')
            .select('service_name, custom_name, available_count, provider_cost_usd')
            .eq('country_id', countryId)
            .eq('service_code', serviceCode)
            .eq('enabled', true)
            .maybeSingle();

        if (svcErr) throw svcErr;
        if (!serviceRow) {
            throw makeErr('SERVICE_NOT_FOUND', 'This service is not available for the selected country.', 400);
        }
        if (Number(serviceRow.available_count) <= 0) {
            throw makeErr('NO_INVENTORY', 'No numbers are currently available for this service.', 409);
        }
        if (!(Number(serviceRow.provider_cost_usd) > 0)) {
            throw makeErr('PROVIDER_COST_MISSING',
                'This service is temporarily unavailable. Please choose another.', 503);
        }

        const serviceName = serviceRow.custom_name || serviceRow.service_name || serviceCode;

        // ── Live price ──────────────────────────────────────────────────
        const priced = await resolveLivePrice({ providerCostUsd: serviceRow.provider_cost_usd });
        const chargeAmount   = currency === 'USD' ? priced.priceUsd : priced.priceNgn;
        const chargeCurrency = currency;

        // ── Expected amount check (PRICE_CHANGED) ───────────────────────
        if (body.expectedAmount != null) {
            const expected = Number(body.expectedAmount);
            if (Number.isFinite(expected) && Math.abs(expected - chargeAmount) > 0.01) {
                return res.status(409).json({
                    success: false,
                    error: `Price updated to ${chargeCurrency === 'USD' ? '$' : '₦'}${chargeAmount.toFixed(2)}. Please confirm to continue.`,
                    code: 'PRICE_CHANGED',
                    data: {
                        newAmount:    chargeAmount,
                        newCurrency:  chargeCurrency,
                        priceUsd:     priced.priceUsd,
                        priceNgn:     priced.priceNgn
                    }
                });
            }
        }

        // ── Limits ──────────────────────────────────────────────────────
        await assertWithinLimits({
            chargeAmount,
            chargeCurrency,
            usdToNgn: priced.usdToNgn
        });

        // ── Per-user active-order cap ──────────────────────────────────
        const maxActive = await orderService.getMaxActivePerUser();
        const { count: activeCount } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .in('status', ['active', 'processing', 'sms_received']);
        if ((activeCount || 0) >= maxActive) {
            throw makeErr('ACTIVE_ORDERS_LIMIT',
                `You already have ${maxActive} active rental${maxActive === 1 ? '' : 's'}. Wait for one to finish.`,
                409,
                { limit: maxActive });
        }

        // ── Balance pre-check (authoritative: ledger) ───────────────────
        let ledgerBalance = 0;
        try {
            ledgerBalance = await LedgerService.getBalance(userId, chargeCurrency);
        } catch { /* fall through — the debit will be the final authority */ }
        if (ledgerBalance + 0.005 < chargeAmount) {
            throw makeErr('INSUFFICIENT_BALANCE',
                `Insufficient ${chargeCurrency} balance. Required: ${chargeAmount.toFixed(2)}, Available: ${ledgerBalance.toFixed(2)}.`,
                402,
                { required_amount: chargeAmount, available_amount: ledgerBalance });
        }

        // ── Create + debit (idempotent) ─────────────────────────────────
        let created;
        try {
            created = await orderService.createAndDebitOrder({
                userId,
                countryId,
                serviceCode,
                serviceName,
                priceUsd:         priced.priceUsd,
                priceNgn:         priced.priceNgn,
                providerCostUsd:  priced.wholesaleUsd,
                exchangeRate:     priced.usdToNgn,
                chargeCurrency,
                chargeAmount,
                idempotencyKey
            });
        } catch (e) {
            if (e.code === 'DUPLICATE_REQUEST' && e.existing_order) {
                // Return the existing order's current state.
                const o = e.existing_order;
                return res.json({
                    success: true,
                    orderId:       o.id,
                    status:        o.status,
                    activationId:  o.activation_id,
                    phoneNumber:   o.phone_number,
                    chargeCurrency: o.charge_currency,
                    chargeAmount:  Number(o.charge_amount),
                    expiresAt:     o.expires_at,
                    duplicate:     true
                });
            }
            throw e;
        }

        // ── Single provider call ────────────────────────────────────────
        const providerResult = await provider.getNumber({
            service:  serviceCode,
            country:  countryId,
            orderId:  created.order.id
        });

        // ── Apply provider result ───────────────────────────────────────
        let applied;
        try {
            applied = await orderService.applyProviderPurchaseResult({
                orderId: created.order.id,
                providerResult
            });
        } catch (e) {
            console.error('[VSMS USER] applyProviderPurchaseResult threw:', e.message);
            // The order exists with a debit. Mark needs_attention, return 202
            // so the user gets a "securing number" card and the worker resolves.
            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    needs_attention: true,
                    attention_reason: 'applyProviderPurchaseResult threw: ' + String(e.message).slice(0, 400),
                    next_check_at: new Date(Date.now() + 10_000).toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', created.order.id);
            return res.status(202).json({
                success: true,
                orderId: created.order.id,
                status: 'processing',
                message: 'Your order is being processed.',
                expiresAt: created.order.expires_at,
                chargeCurrency,
                chargeAmount,
                transaction: {
                    id: created.ledgerTransactionId,
                    reference: created.order.ledger_reference
                }
            });
        }

        // ── Shape the response ─────────────────────────────────────────
        const finalOrder = applied.order;
        if (applied.resolved === 'active') {
            return res.json({
                success: true,
                orderId:      finalOrder.id,
                activationId: finalOrder.activation_id,
                phoneNumber:  finalOrder.phone_number,
                status:       'active',
                service:      serviceName,
                chargeCurrency: finalOrder.charge_currency,
                chargeAmount:   Number(finalOrder.charge_amount),
                priceUsd:       Number(finalOrder.price_usd),
                priceNgn:       Number(finalOrder.price_ngn),
                expiresAt:      finalOrder.expires_at,
                canCancelAt:    finalOrder.cancel_available_at,
                transaction: {
                    id:        finalOrder.ledger_transaction_id,
                    reference: finalOrder.ledger_reference
                }
            });
        }
        if (applied.resolved === 'refunded') {
            return res.status(200).json({
                success: false,
                error: 'No numbers were available — your payment has been refunded automatically.',
                code: 'PROVIDER_FAILURE_REFUNDED',
                data: {
                    orderId: finalOrder.id,
                    status: 'refunded',
                    refund: applied.refund
                }
            });
        }
        // processing / unknown
        return res.status(202).json({
            success: true,
            orderId: finalOrder.id,
            status: 'processing',
            message: 'Your order is being processed.',
            expiresAt: finalOrder.expires_at,
            chargeCurrency: finalOrder.charge_currency,
            chargeAmount:   Number(finalOrder.charge_amount),
            transaction: {
                id:        finalOrder.ledger_transaction_id,
                reference: finalOrder.ledger_reference
            }
        });

    } catch (e) {
        sendErr(res, e);
    }
});

// ═════════════════════════════════════════════════════════════════════════
//  GET /status?id= — DB only, no provider call
// ═════════════════════════════════════════════════════════════════════════
router.get('/status', authMiddleware, statusLimiter, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.query;
        if (!UUID_RE.test(String(id || ''))) {
            return res.status(400).json({ success: false, error: 'id required', code: 'INVALID_ID' });
        }

        const { data: order, error } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .maybeSingle();
        if (error) throw error;
        if (!order) return res.status(404).json({ success: false, error: 'Order not found', code: 'NOT_FOUND' });

        // Refund info
        let refund = null;
        if (order.refund_transaction_id) {
            refund = {
                amount:   Number(order.charge_amount),
                currency: order.charge_currency
            };
        }

        res.json({
            success: true,
            id:              order.id,
            status:          order.status,
            code:            order.sms_code || null,
            sms_text:        order.sms_message || null,
            phone:           order.phone_number,
            expires_at:      order.expires_at,
            created_at:      order.created_at,
            activated_at:    order.activated_at,
            sms_received_at: order.sms_received_at,
            completed_at:    order.completed_at,
            cancelled_at:    order.cancelled_at,
            refunded_at:     order.refunded_at,
            can_cancel_at:   order.cancel_available_at,
            server_now:      new Date().toISOString(),
            refund
        });
    } catch (e) { sendErr(res, e); }
});

// ═════════════════════════════════════════════════════════════════════════
//  GET /active — ALL active orders, no side effects
// ═════════════════════════════════════════════════════════════════════════
router.get('/active', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const { data: orders, error } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('*')
            .eq('user_id', userId)
            .in('status', ['processing', 'active', 'sms_received'])
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;

        const countryIds = [...new Set((orders || []).map(o => o.country_id).filter(Boolean))];
        const countryMap = {};
        if (countryIds.length) {
            const { data: countries } = await supabaseAdmin
                .from('virtual_sms_countries')
                .select('id, name')
                .in('id', countryIds);
            (countries || []).forEach(c => { countryMap[c.id] = c.name; });
        }

        const shaped = (orders || []).map(o => ({
            id:             o.id,
            phone:          o.phone_number,
            country:        countryMap[o.country_id] || o.country_name || 'Unknown',
            country_id:     o.country_id,
            service:        o.service_name || o.service_code,
            service_code:   o.service_code,
            status:         o.status,
            expires_at:     o.expires_at,
            created_at:     o.created_at,
            activated_at:   o.activated_at,
            can_cancel_at:  o.cancel_available_at,
            sms_code:       o.sms_code,
            sms_text:       o.sms_message,
            charge_currency: o.charge_currency || 'NGN',
            charge_amount:  Number(o.charge_amount) || 0
        }));

        res.json({ success: true, orders: shaped, server_now: new Date().toISOString() });
    } catch (e) { sendErr(res, e); }
});

// ═════════════════════════════════════════════════════════════════════════
//  POST /cancel — user-initiated, idempotent
// ═════════════════════════════════════════════════════════════════════════
router.post('/cancel', authMiddleware, cancelLimiter, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.body || {};
        if (!UUID_RE.test(String(id || ''))) {
            return res.status(400).json({ success: false, error: 'id required', code: 'INVALID_ID' });
        }
        const result = await orderService.cancelByUser({
            orderId: id,
            userId,
            reason:  'User cancelled — full refund'
        });
        res.json({
            success: true,
            order: result.order,
            refund: result.refund
        });
    } catch (e) { sendErr(res, e); }
});

// ═════════════════════════════════════════════════════════════════════════
//  POST /retry (resend)
// ═════════════════════════════════════════════════════════════════════════
router.post('/retry', authMiddleware, retryLimiter, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.body || {};
        if (!UUID_RE.test(String(id || ''))) {
            return res.status(400).json({ success: false, error: 'id required', code: 'INVALID_ID' });
        }
        const { data: order, error } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('*')
            .eq('id', id)
            .eq('user_id', userId)
            .maybeSingle();
        if (error) throw error;
        if (!order) return res.status(404).json({ success: false, error: 'Order not found', code: 'NOT_FOUND' });
        if (order.sms_code) return res.status(400).json({ success: false, error: 'SMS already received', code: 'SMS_ALREADY_RECEIVED' });
        if (order.status !== 'active') return res.status(400).json({ success: false, error: 'Cannot resend for this order', code: 'ORDER_INACTIVE' });
        if (!order.activation_id) return res.status(400).json({ success: false, error: 'No activation id', code: 'NO_ACTIVATION' });

        // Rate limit: 3 per order total.
        const { count } = await supabaseAdmin
            .from('virtual_sms_order_events')
            .select('id', { count: 'exact', head: true })
            .eq('order_id', order.id)
            .eq('event_type', 'sms_retry');
        if ((count || 0) >= 3) {
            return res.status(429).json({ success: false, error: 'Resend limit reached for this order', code: 'RESEND_LIMIT' });
        }

        const result = await provider.setStatus({
            activationId: order.activation_id,
            status: 3,
            orderId: order.id
        });
        await orderService.recordEvent({
            orderId: order.id,
            eventType: 'sms_retry',
            oldStatus: order.status,
            newStatus: order.status,
            message: 'User requested resend',
            providerResponse: result.raw
        });
        res.json({ success: true, message: 'Resend requested' });
    } catch (e) { sendErr(res, e); }
});

// ═════════════════════════════════════════════════════════════════════════
//  GET /orders — paginated, includes code for the last 24h
// ═════════════════════════════════════════════════════════════════════════
router.get('/orders', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit  = Math.min(parseInt(req.query.limit, 10) || 20, 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        const { data: orders, error, count } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        const countryIds = [...new Set((orders || []).map(o => o.country_id).filter(Boolean))];
        const countryMap = {};
        if (countryIds.length) {
            const { data: countries } = await supabaseAdmin
                .from('virtual_sms_countries')
                .select('id, name')
                .in('id', countryIds);
            (countries || []).forEach(c => { countryMap[c.id] = c.name; });
        }

        const now = Date.now();
        const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
        const shaped = (orders || []).map(o => {
            const createdMs = new Date(o.created_at).getTime();
            const within24h = (now - createdMs) < TWENTY_FOUR_HOURS;
            return {
                id:             o.id,
                country:        countryMap[o.country_id] || o.country_name || 'Unknown',
                country_id:     o.country_id,
                service:        o.service_name || o.service_code,
                phone:          o.phone_number,
                price_usd:      Number(o.price_usd) || 0,
                price_ngn:      Number(o.price_ngn) || 0,
                charge_currency: o.charge_currency || 'NGN',
                charge_amount:  Number(o.charge_amount) || 0,
                status:         o.status,
                sms_code:       within24h ? (o.sms_code || null) : null,
                sms_text:       within24h ? (o.sms_message || null) : null,
                refund:         o.refund_transaction_id ? {
                    amount:   Number(o.charge_amount) || 0,
                    currency: o.charge_currency || 'NGN'
                } : null,
                created_at:     o.created_at,
                expires_at:     o.expires_at,
                completed_at:   o.completed_at,
                cancelled_at:   o.cancelled_at,
                refunded_at:    o.refunded_at
            };
        });

        res.json({
            success: true,
            orders: shaped,
            pagination: { total: count || 0, limit, offset }
        });
    } catch (e) { sendErr(res, e); }
});

// ═════════════════════════════════════════════════════════════════════════
//  POST /orders/:id/check — nudge the worker for one order
// ═════════════════════════════════════════════════════════════════════════
router.post('/orders/:id/check', authMiddleware, statusLimiter, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        if (!UUID_RE.test(String(id || ''))) {
            return res.status(400).json({ success: false, error: 'id required', code: 'INVALID_ID' });
        }
        const { data: order } = await supabaseAdmin
            .from('virtual_sms_orders')
            .select('id, status, next_check_at')
            .eq('id', id)
            .eq('user_id', userId)
            .maybeSingle();
        if (!order) return res.status(404).json({ success: false, error: 'Order not found', code: 'NOT_FOUND' });

        // Nudge the worker: set next_check_at to now if the order is
        // still resolvable.
        if (['processing', 'active'].includes(order.status)) {
            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    next_check_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', order.id);
        }

        res.json({ success: true, status: order.status, message: 'Refreshing…' });
    } catch (e) { sendErr(res, e); }
});

// ═════════════════════════════════════════════════════════════════════════
//  GET /me — user info for the wallet display (unchanged contract)
// ═════════════════════════════════════════════════════════════════════════
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { data: user, error } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, avatar_url, role, status')
            .eq('id', userId)
            .single();
        if (error || !user) return res.status(404).json({ success: false, error: 'User not found' });
        if (user.status === 'suspended') return res.status(403).json({ success: false, error: 'Account suspended' });

        let walletNgn = 0, walletUsd = 0;
        try {
            walletNgn = await LedgerService.getBalance(userId, 'NGN');
            walletUsd = await LedgerService.getBalance(userId, 'USD');
        } catch { /* fall back to 0 */ }

        res.json({
            success: true,
            user: {
                id:          user.id,
                username:    user.username || user.email?.split('@')[0] || 'User',
                email:       user.email,
                avatar_url:  user.avatar_url || null,
                wallet_usd:  walletUsd,
                wallet_ngn:  walletNgn,
                role:        user.role || 'user'
            },
            server_now: new Date().toISOString()
        });
    } catch (e) { sendErr(res, e); }
});

// ═════════════════════════════════════════════════════════════════════════
//  GET /health
// ═════════════════════════════════════════════════════════════════════════
router.get('/health', async (req, res) => {
    let enabled = null;
    try { enabled = await adminSettings.isServiceEnabled('virtual_sms'); } catch {}
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service_enabled: enabled
    });
});

module.exports = router;