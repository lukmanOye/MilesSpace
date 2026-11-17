// routes/esimRoutes.js — COMPLETE PRODUCTION eSIM ROUTES
// Mounted at: /api/esim
// Webhook mounted separately at: /api/webhooks/dtone/esim
//
// PRICING AUTHORITY:
//   Every customer-facing price is recomputed from admin settings
//   on each request via adminSettingsService:
//     • esim_markup_pct_usd / esim_markup_pct_ngn → markup
//     • usd_to_ngn                               → FX
//     • service_esim_enabled                     → feature gate
//     • esim_min_ngn / esim_max_ngn              → per-order limits
//   There is no trust in any `selling_price_*` column anywhere.
//
// BALANCE SOURCE: profiles.wallet_ngn / wallet_usd
//   (matches /api/auth/me, /api/wallet/me, and the dashboard)
//
// HISTORY: reads esim_transactions, returns FULL detail per row
//   (QR, activation code, LPA string, serial, ICCID, install links)
//
// Batch 2 (2026-11-10):
//   + Mirror every eSIM order into `orders` so Admin → Orders and
//     Revenue analytics see them. recordOrder() is idempotent on
//     (source_table='esim_transactions', source_id). Called from
//     /purchase, finalizeEsimOrder(), and refundEsimOrder() so the
//     order tracks the transaction through its full lifecycle,
//     including status-poll and webhook completions.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const dns = require('dns').promises;
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const { LedgerService } = require('../services/ledgerService');
const adminSettings = require('../services/adminSettingsService');
const emailService = require('../services/emailService');
const dtoneService = require('../services/dtoneService');
const pricingEngine = require('../services/pricingEngine');
const esimAdminService = require('../services/esimAdminService');

// ★ NEW: order mirroring
const fulfillment = require('../services/billsFulfillment');
const recordOrder = (data) => fulfillment.recordOrder(data);

// ─── ISO3 → ISO2 lookup (used by lookupEsimPlan for country_flag) ───
const ISO3_TO_ISO2 = {
    USA:'US',GBR:'GB',CAN:'CA',AUS:'AU',DEU:'DE',FRA:'FR',ITA:'IT',ESP:'ES',NLD:'NL',BEL:'BE',
    CHE:'CH',AUT:'AT',SWE:'SE',NOR:'NO',DNK:'DK',FIN:'FI',IRL:'IE',PRT:'PT',POL:'PL',CZE:'CZ',
    GRC:'GR',TUR:'TR',RUS:'RU',UKR:'UA',JPN:'JP',KOR:'KR',CHN:'CN',IND:'IN',IDN:'ID',THA:'TH',
    VNM:'VN',PHL:'PH',MYS:'MY',SGP:'SG',HKG:'HK',TWN:'TW',NZL:'NZ',ZAF:'ZA',NGA:'NG',KEN:'KE',
    GHA:'GH',EGY:'EG',MAR:'MA',TUN:'TN',DZA:'DZ',SEN:'SN',CIV:'CI',CMR:'CM',UGA:'UG',TZA:'TZ',
    ZMB:'ZM',ZWE:'ZW',BWA:'BW',NAM:'NA',MOZ:'MZ',AGO:'AO',BRA:'BR',ARG:'AR',CHL:'CL',COL:'CO',
    PER:'PE',MEX:'MX',ISR:'IL',SAU:'SA',ARE:'AE',QAT:'QA',KWT:'KW',BHR:'BH',OMN:'OM',JOR:'JO',
    LBN:'LB',PAK:'PK',BGD:'BD',LKA:'LK',NPL:'NP'
};

// ─── CONFIG ──────────────────────────────────────────────────────────────
const SERVICE_FEE_PCT = '0.02';
const CACHE_TTL = 5 * 60 * 1000;
const MAX_RECONCILE_ATTEMPTS = 20;
const MAX_AGE_MINUTES = 26 * 60;
const EMAIL_MAX_ATTEMPTS = 5;
const EMAIL_RETRY_BACKOFF_MIN = [2, 5, 15, 60, 240];
const QR_BUCKET = 'esim-qr';
const QR_SIGNED_URL_TTL_SEC = 60 * 60 * 24 * 7;
const STALE_SENDING_MS = 10 * 60 * 1000;
const PROVIDER_ENV = String(process.env.DTONE_ENV || '').toLowerCase() === 'production' ? 'production' : 'preprod';

const cache = {
    countries: { data: null, timestamp: 0 },
    plans: new Map(),
    ttl: CACHE_TTL
};

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function makeErr(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    Object.assign(e, extra);
    return e;
}

// ════════════════════════════════════════════════════════════════════════
//  EMAIL VALIDATION (DNS MX Lookup)
// ════════════════════════════════════════════════════════════════════════
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
        return hit.ok ? { ok: true, email }
                      : { ok: false, code: 'EMAIL_NOT_FOUND', message: 'Email not found.', email };
    }
    try {
        const mx = await Promise.race([
            dns.resolveMx(domain),
            new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 3000))
        ]);
        const ok = Array.isArray(mx) && mx.length > 0;
        mxCache.set(domain, { ok, at: Date.now() });
        return ok ? { ok: true, email }
                  : { ok: false, code: 'EMAIL_NOT_FOUND', message: 'Email not found.', email };
    } catch (e) {
        if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') {
            mxCache.set(domain, { ok: false, at: Date.now() });
            return { ok: false, code: 'EMAIL_NOT_FOUND', message: 'Email not found.', email };
        }
        return { ok: true, email, uncertain: true };
    }
}

// ════════════════════════════════════════════════════════════════════════
//  PRICING — resolved from admin settings
// ════════════════════════════════════════════════════════════════════════
async function resolveEsimPricing({ wholesaleUsd }) {
    if (!isMoneyString(String(wholesaleUsd ?? ''))) {
        throw makeErr('PROVIDER_COST_MISSING', 'Wholesale price is not configured for this plan.', 503);
    }
    const wholesaleStr = String(wholesaleUsd);

    const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
    const markupUsd = await adminSettings.getMarkup('esim', 'USD');
    const markupNgn = await adminSettings.getMarkup('esim', 'NGN');

    const result = pricingEngine.calculatePrice({
        wholesaleAmount:   wholesaleStr,
        wholesaleCurrency: 'USD',
        usdToNgn:          String(usdToNgn),
        mode:              'global',
        value:             null,
        globalMarkupUsd:   String(markupUsd),
        globalMarkupNgn:   String(markupNgn)
    });

    const feeUsdStr = pricingEngine.mulByPercent(result.priceUsd, SERVICE_FEE_PCT, 2, 2, 2);
    const feeNgnStr = pricingEngine.mulByPercent(result.priceNgn, SERVICE_FEE_PCT, 2, 2, 2);
    const totalUsdStr = pricingEngine.addDecimal(result.priceUsd, feeUsdStr, 2);
    const totalNgnStr = pricingEngine.addDecimal(result.priceNgn, feeNgnStr, 2);

    return {
        priceUsd: result.priceUsd,
        priceNgn: result.priceNgn,
        feeUsd:   feeUsdStr,
        feeNgn:   feeNgnStr,
        totalUsd: totalUsdStr,
        totalNgn: totalNgnStr,
        usdToNgn: String(usdToNgn),
        markupUsd: String(markupUsd),
        markupNgn: String(markupNgn),
        marginPct: result.marginPct
    };
}

function isMoneyString(s) {
    if (typeof s !== 'string') return false;
    if (!/^\d+(\.\d+)?$/.test(s)) return false;
    const n = Number(s);
    return Number.isFinite(n) && n > 0;
}

function compareMoney(a, b) {
    const scale = 4;
    const toBig = (s) => {
        const neg = String(s).startsWith('-');
        const body = neg ? String(s).slice(1) : String(s);
        const [i = '0', f = ''] = body.split('.');
        const padded = (f + '0'.repeat(scale)).slice(0, scale);
        const bi = BigInt(i || '0') * (10n ** BigInt(scale)) + BigInt(padded || '0');
        return neg ? -bi : bi;
    };
    const A = toBig(a), B = toBig(b);
    return A === B ? 0 : (A < B ? -1 : 1);
}

async function assertWithinLimits({ totalNgn, totalUsd, usdToNgn }) {
    const minNgnStr = String(await adminSettings.getRaw('esim_min_ngn') || '0.00');
    const maxNgnStr = String(await adminSettings.getRaw('esim_max_ngn') || '0.00');

    let ngnEquivalentStr;
    if (isMoneyString(String(totalNgn ?? ''))) {
        ngnEquivalentStr = String(totalNgn);
    } else if (isMoneyString(String(totalUsd ?? ''))) {
        const usdMinor = BigInt(String(totalUsd).replace('.', ''));
        const rateMinor = BigInt(String(usdToNgn).replace('.', ''));
        const ngnBig = (usdMinor * rateMinor) / 100n;
        ngnEquivalentStr = (ngnBig / 100n).toString() + '.' +
            (ngnBig % 100n).toString().padStart(2, '0');
    } else {
        return;
    }

    if (isMoneyString(minNgnStr) && compareMoney(minNgnStr, '0.00') > 0 &&
        compareMoney(ngnEquivalentStr, minNgnStr) < 0) {
        throw makeErr('BELOW_MIN_LIMIT', `Minimum eSIM order is ₦${minNgnStr}.`, 400, { min_ngn: minNgnStr });
    }
    if (isMoneyString(maxNgnStr) && compareMoney(maxNgnStr, '0.00') > 0 &&
        compareMoney(ngnEquivalentStr, maxNgnStr) > 0) {
        throw makeErr('ABOVE_MAX_LIMIT', `Maximum eSIM order is ₦${maxNgnStr}.`, 400, { max_ngn: maxNgnStr });
    }
}

// ════════════════════════════════════════════════════════════════════════
//  PIN VERIFICATION — atomic RPCs
// ════════════════════════════════════════════════════════════════════════
async function verifyTransactionPin(userId, pin) {
    if (!userId) return { valid: false, error: 'User ID required', code: 'USER_ID_REQUIRED' };
    if (!pin || !/^\d{4}$/.test(String(pin))) {
        return { valid: false, error: 'PIN must be exactly 4 digits', code: 'INVALID_FORMAT' };
    }

    const { data: profile, error } = await supabaseAdmin
        .from('profiles')
        .select('transaction_pin_hash, transaction_pin_attempts, transaction_pin_locked_until')
        .eq('id', userId)
        .single();

    if (error || !profile) return { valid: false, error: 'User not found', code: 'USER_NOT_FOUND' };
    if (!profile.transaction_pin_hash) {
        return { valid: false, error: 'PIN not set', code: 'PIN_NOT_SET', pinNotSet: true };
    }
    if (profile.transaction_pin_locked_until) {
        const lockUntil = new Date(profile.transaction_pin_locked_until);
        if (lockUntil > new Date()) {
            const mins = Math.ceil((lockUntil.getTime() - Date.now()) / 60000);
            return {
                valid: false,
                error: `Try again in ${mins} minute(s).`,
                code: 'PIN_LOCKED',
                remaining_minutes: mins,
                can_reset: true
            };
        }
    }

    const isValid = await bcrypt.compare(String(pin), profile.transaction_pin_hash);

    if (!isValid) {
        const { data, error: rpcErr } = await supabaseAdmin.rpc('record_pin_failure', { p_user_id: userId });
        if (rpcErr) return { valid: false, error: 'PIN security error.', code: 'PIN_SECURITY_ERROR' };
        
        const row = Array.isArray(data) ? data[0] : data;
        if (row?.locked) {
            return { valid: false, error: 'PIN locked for 1 hour.', code: 'PIN_LOCKED', remaining_minutes: 60, can_reset: true };
        }
        return { valid: false, error: `Incorrect PIN. ${row?.attempts_remaining ?? 0} attempts left.`, code: 'INVALID_PIN', attempts_remaining: row?.attempts_remaining ?? 0 };
    }

    if ((profile.transaction_pin_attempts || 0) > 0) {
        supabaseAdmin.rpc('reset_pin_attempts', { p_user_id: userId }).catch(() => {});
    }

    return { valid: true };
}

// ════════════════════════════════════════════════════════════════════════
//  DESTINATION TYPE RESOLVER
// ════════════════════════════════════════════════════════════════════════
function resolveDestination(input) {
    if (!input) return null;
    const type = String(input.type || 'country').toLowerCase();
    const code = String(input.code || input.iso3 || '').toUpperCase();

    if (type === 'global' || code === 'GLOBAL' || code === 'WWW') return { type: 'global', code: 'GLOBAL', iso3: null };
    if (type === 'regional') return { type: 'regional', code, iso3: null };
    if (/^[A-Z]{3}$/.test(code)) return { type: 'country', code, iso3: code };
    return null;
}

// ════════════════════════════════════════════════════════════════════════
//  QR GENERATION — Private bucket + signed URL
// ════════════════════════════════════════════════════════════════════════
async function generateEsimQr(lpaString, reference) {
    if (!lpaString) throw new Error('Missing eSIM activation code');
    const buffer = await QRCode.toBuffer(lpaString, { errorCorrectionLevel: 'M', margin: 2, width: 800, type: 'png' });
    const filename = `${reference || Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;

    const { error: uploadError } = await supabaseAdmin.storage.from(QR_BUCKET).upload(filename, buffer, { contentType: 'image/png', cacheControl: '0', upsert: false });
    if (uploadError) return await QRCode.toDataURL(lpaString, { errorCorrectionLevel: 'M', margin: 2, width: 800 });

    const { data: signed, error: signError } = await supabaseAdmin.storage.from(QR_BUCKET).createSignedUrl(filename, QR_SIGNED_URL_TTL_SEC);
    if (signError || !signed?.signedUrl) return await QRCode.toDataURL(lpaString, { errorCorrectionLevel: 'M', margin: 2, width: 800 });

    return signed.signedUrl;
}

// ════════════════════════════════════════════════════════════════════════
//  GET /me
// ════════════════════════════════════════════════════════════════════════
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const { data: user, error } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, wallet_ngn, wallet_usd, avatar_url, role, status, transaction_pin_hash')
            .eq('id', req.user.id)
            .single();

        if (error || !user) return res.status(404).json({ success: false, error: 'User not found' });
        if (user.status === 'suspended') return res.status(403).json({ success: false, error: 'Account suspended' });

        let walletNgn = num(user.wallet_ngn);
        let walletUsd = num(user.wallet_usd);

        if (walletNgn === 0 || walletUsd === 0) {
            try {
                const balances = await LedgerService.getAllBalances(user.id);
                if (walletNgn === 0 && num(balances.NGN) > 0) walletNgn = num(balances.NGN);
                if (walletUsd === 0 && num(balances.USD) > 0) walletUsd = num(balances.USD);
            } catch (e) { console.warn('[ESIM /me] ledger fallback failed:', e.message); }
        }

        res.json({
            success: true,
            data: {
                id: user.id,
                name: user.username || user.email?.split('@')[0] || 'Account',
                email: user.email || '',
                avatarUrl: user.avatar_url || null,
                walletBalanceUsd: walletUsd,
                walletBalanceNgn: walletNgn,
                role: user.role || 'user',
                hasPin: Boolean(user.transaction_pin_hash)
            }
        });
    } catch (error) {
        console.error('❌ GET /me error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch user' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /history
// ════════════════════════════════════════════════════════════════════════
router.get('/history', authMiddleware, async (req, res) => {
    try {
        const { data: txns, error } = await supabaseAdmin
            .from('esim_transactions')
            .select(`id, reference, dtone_external_id, provider_transaction_id, country_iso2, country_iso3, country_name, country_flag, plan_name, data_display, data_mb, validity_days, price_usd, fee_usd, total_usd, price_ngn, debit_currency, debit_amount, exchange_rate, status, delivery_status, email_status, qr_code_url, activation_code, lpa_string, serial_number, iccid, smdp_address, matching_id, installation_url, apple_universal_link, android_universal_link, instructions, failure_reason, refunded, refund_status, delivery_attempts, last_delivery_error, email_attempts, last_email_error, created_at, updated_at, completed_at, failed_at, refunded_at`)
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) {
            if (error.code === '42P01') return res.json({ success: true, data: [] });
            throw error;
        }

        const formatted = (txns || []).map(t => ({
            id: t.id,
            reference: t.reference,
            externalId: t.dtone_external_id,
            providerTransactionId: t.provider_transaction_id,
            countryIso2: t.country_iso2,
            countryIso3: t.country_iso3,
            countryName: t.country_name,
            countryFlag: t.country_flag,
            planName: t.plan_name,
            dataAmount: t.data_display,
            dataMb: t.data_mb,
            validityDays: t.validity_days,
            priceUsd: num(t.price_usd),
            feeUsd: num(t.fee_usd),
            totalUsd: num(t.total_usd),
            priceNgn: num(t.price_ngn),
            debitCurrency: t.debit_currency,
            debitAmount: num(t.debit_amount),
            exchangeRate: num(t.exchange_rate),
            status: t.status,
            deliveryStatus: t.delivery_status,
            emailStatus: t.email_status,
            refunded: !!t.refunded,
            refundStatus: t.refund_status,
            failureReason: t.failure_reason || null,
            qrCodeUrl: t.qr_code_url || null,
            activationCode: t.activation_code || null,
            lpaString: t.lpa_string || null,
            smdpAddress: t.smdp_address || null,
            matchingId: t.matching_id || null,
            serial: t.serial_number || null,
            iccid: t.iccid || null,
            installationUrl: t.installation_url || null,
            appleUniversalLink: t.apple_universal_link || null,
            androidUniversalLink: t.android_universal_link || null,
            instructions: t.instructions || null,
            deliveryAttempts: t.delivery_attempts || 0,
            lastDeliveryError: t.last_delivery_error || null,
            emailAttempts: t.email_attempts || 0,
            lastEmailError: t.last_email_error || null,
            createdAt: t.created_at,
            updatedAt: t.updated_at,
            completedAt: t.completed_at,
            failedAt: t.failed_at,
            refundedAt: t.refunded_at
        }));

        res.json({ success: true, data: formatted, meta: { count: formatted.length } });
    } catch (error) {
        console.error('❌ GET /history error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch eSIM history' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /countries — derived from esim_products (enabled only)
// ════════════════════════════════════════════════════════════════════════
router.get('/countries', authMiddleware, async (req, res) => {
    try {
        if (cache.countries.data && (Date.now() - cache.countries.timestamp) < CACHE_TTL) {
            return res.json({ success: true, data: cache.countries.data });
        }

        const { data: rows, error } = await supabaseAdmin
            .from('esim_products')
            .select('coverage_type, regions, country_iso3')
            .eq('provider', 'dtone')
            .eq('provider_env', PROVIDER_ENV)
            .eq('enabled', true);

        if (error) return res.status(500).json({ success: false, error: 'Failed to fetch countries' });

        const seen = new Map();
        for (const row of rows || []) {
            if (row.coverage_type !== 'country') continue;
            const regions = Array.isArray(row.regions) ? row.regions : [];
            for (const reg of regions) {
                const code = String(reg?.code || '').toUpperCase();
                if (!/^[A-Z]{3}$/.test(code)) continue;
                if (!seen.has(code)) {
                    seen.set(code, { iso3: code, iso2: ISO3_TO_ISO2[code] || '', name: reg.name || code });
                }
            }
        }
        const countries = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));

        cache.countries.data = countries;
        cache.countries.timestamp = Date.now();
        res.json({ success: true, data: countries });
    } catch (error) {
        if (cache.countries.data) return res.json({ success: true, data: cache.countries.data });
        res.status(500).json({ success: false, error: 'Failed to fetch countries' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /plans — prices computed live from admin settings
// ════════════════════════════════════════════════════════════════════════
router.get('/plans', authMiddleware, async (req, res) => {
    const type = String(req.query.type || '').toLowerCase();
    const countryQ = String(req.query.country || '').toUpperCase();
    const regionQ = String(req.query.region || '').toUpperCase();

    let queryKey;
    let filter = null;

    if (type === 'global' || countryQ === 'GLOBAL') {
        queryKey = 'GLOBAL';
        filter = { type: 'coverage', value: 'global' };
    } else if (regionQ) {
        queryKey = `REGION:${regionQ}`;
        filter = { type: 'region', value: regionQ };
    } else if (/^[A-Z]{3}$/.test(countryQ)) {
        queryKey = countryQ;
        filter = { type: 'country', value: countryQ };
    } else {
        return res.status(400).json({ success: false, error: 'country (3-letter) or type=global or region required' });
    }

    try {
        const enabled = await adminSettings.isServiceEnabled('esim');
        if (!enabled) return res.json({ success: true, data: [], enabled: false, reason: 'ESIM_DISABLED' });

        const cached = cache.plans.get(queryKey);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            return res.json({ success: true, data: cached.data, enabled: true });
        }

        let q = supabaseAdmin
            .from('esim_products')
            .select('id, provider_product_id, name, display_name, logo_url, coverage_type, regions, data_mb, validity_days, wholesale_amount, wholesale_currency, pricing_mode, pricing_value, customer_price_ngn, customer_price_usd, featured, sort_order')
            .eq('provider', 'dtone')
            .eq('provider_env', PROVIDER_ENV)
            .eq('enabled', true);

        if (filter.type === 'coverage') q = q.eq('coverage_type', 'global');
        else if (filter.type === 'country') q = q.eq('coverage_type', 'country');
        else if (filter.type === 'region') q = q.eq('coverage_type', 'regional');

        q = q.order('sort_order', { ascending: true }).order('customer_price_usd', { ascending: true });

        const { data: rows, error } = await q;
        if (error) return res.status(500).json({ success: false, error: 'Failed to load plans' });
        if (!rows || !rows.length) {
            cache.plans.set(queryKey, { data: [], timestamp: Date.now() });
            return res.json({ success: true, data: [], enabled: true, meta: { query: queryKey, count: 0 } });
        }

        let filteredRows = rows;
        if (filter.type === 'country' || filter.type === 'region') {
            const want = String(filter.value).toUpperCase();
            filteredRows = rows.filter(r => {
                const regions = Array.isArray(r.regions) ? r.regions : [];
                return regions.some(reg => String(reg?.code || '').toUpperCase() === want);
            });
        }

        if (!filteredRows.length) {
            cache.plans.set(queryKey, { data: [], timestamp: Date.now() });
            return res.json({ success: true, data: [], enabled: true, meta: { query: queryKey, count: 0 } });
        }

        const plans = [];
        for (const row of filteredRows) {
            let priced;
            try {
                priced = await esimAdminService.resolveProductPricing(row);
            } catch (e) {
                continue;
            }

            const feeUsdStr = pricingEngine.mulByPercent(priced.priceUsd, SERVICE_FEE_PCT, 2, 2, 2);
            const totalUsd = pricingEngine.addDecimal(priced.priceUsd, feeUsdStr, 2);
            const feeNgnStr = pricingEngine.mulByPercent(priced.priceNgn, SERVICE_FEE_PCT, 2, 2, 2);
            const totalNgn = pricingEngine.addDecimal(priced.priceNgn, feeNgnStr, 2);

            plans.push({
                productId:     row.provider_product_id,
                planName:      row.display_name || row.name,
                displayName:   row.display_name || row.name,
                logoUrl:       row.logo_url || null,
                featured:      Boolean(row.featured),
                dataAmount:    row.data_mb != null ? (row.data_mb >= 1024 ? `${(row.data_mb / 1024).toFixed(0)} GB` : `${row.data_mb} MB`) : null,
                dataMb:        row.data_mb,
                validityDays:  row.validity_days,
                priceUsd:      priced.priceUsd,
                priceNgn:      priced.priceNgn,
                feeUsd:        feeUsdStr,
                feeNgn:        feeNgnStr,
                totalUsd:      totalUsd,
                totalNgn:      totalNgn,
                coverageType:  row.coverage_type,
                coverageLabel: row.coverage_type === 'global' ? 'Global' : row.coverage_type === 'regional' ? (row.regions?.[0]?.name || 'Regional') : (row.regions?.[0]?.name || 'Country-specific'),
                isGlobal:      row.coverage_type === 'global',
                isRegional:    row.coverage_type === 'regional',
                marginPct:     priced.marginPct
            });
        }

        plans.sort((a, b) => {
            const order = { country: 0, regional: 1, global: 2 };
            const diff = (order[a.coverageType] ?? 0) - (order[b.coverageType] ?? 0);
            if (diff !== 0) return diff;
            return compareMoney(a.priceUsd, b.priceUsd);
        });

        cache.plans.set(queryKey, { data: plans, timestamp: Date.now() });
        const usdToNgn = await adminSettings.getRate('USD', 'NGN');
        return res.json({ success: true, data: plans, enabled: true, meta: { query: queryKey, usdToNgn: String(usdToNgn), count: plans.length } });
    } catch (error) {
        console.error(`❌ GET /plans error [${queryKey}]:`, error.message);
        return res.status(500).json({ success: false, error: 'Failed to fetch plans' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /rates
// ════════════════════════════════════════════════════════════════════════
router.get('/rates', authMiddleware, async (req, res) => {
    try {
        const usdToNgn = await adminSettings.getRate('USD', 'NGN');
        res.json({ success: true, data: { usdToNgn } });
    } catch {
        res.json({ success: true, data: { usdToNgn: 1600 } });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  POST /validate-email
// ════════════════════════════════════════════════════════════════════════
router.post('/validate-email', authMiddleware, async (req, res) => {
    const r = await checkEmailDeliverable(req.body?.email);
    if (!r.ok) return res.status(400).json({ success: false, code: r.code, error: r.message });
    res.json({ success: true, data: { email: r.email } });
});

// ════════════════════════════════════════════════════════════════════════
//  POST /purchase
// ════════════════════════════════════════════════════════════════════════
router.post('/purchase', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const { productId, countryIso3, destinationType, destinationCode, deliveryEmail, currency, pin } = req.body;

    if (!productId) return res.status(400).json({ success: false, error: 'productId is required' });
    if (!pin || !/^\d{4}$/.test(String(pin))) return res.status(400).json({ success: false, error: 'Transaction PIN (4 digits) is required', code: 'PIN_REQUIRED' });

    const destination = resolveDestination({ type: destinationType, code: destinationCode || countryIso3 });
    if (!destination) return res.status(400).json({ success: false, error: 'Valid country or global destination is required' });

    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!idempotencyKey) return res.status(400).json({ success: false, error: 'Idempotency-Key header is required', code: 'IDEMPOTENCY_KEY_REQUIRED' });

    const { data: existingOrder } = await supabaseAdmin
        .from('esim_transactions')
        .select('id, reference, status, dtone_external_id')
        .eq('user_id', userId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

    if (existingOrder) {
        return res.json({ success: true, data: { transactionId: existingOrder.id, reference: existingOrder.reference, externalId: existingOrder.dtone_external_id, status: existingOrder.status, already_processed: true } });
    }

    const pinCheck = await verifyTransactionPin(userId, pin);
    if (!pinCheck.valid) {
        const status = pinCheck.code === 'PIN_LOCKED' ? 423 : pinCheck.code === 'INVALID_PIN' ? 401 : pinCheck.code === 'PIN_NOT_SET' ? 400 : 422;
        return res.status(status).json({ success: false, error: pinCheck.error, code: pinCheck.code, attempts_remaining: pinCheck.attempts_remaining, remaining_minutes: pinCheck.remaining_minutes, can_reset: pinCheck.can_reset, pinNotSet: pinCheck.pinNotSet || false });
    }

    let orderId = null;
    let walletDebited = false;
    let debitResult = null;
    let providerTransactionId = null;

    try {
        await adminSettings.assertServiceEnabled('esim');

        const { data: profile } = await supabaseAdmin.from('profiles').select('id, username, email, wallet_ngn, wallet_usd').eq('id', userId).single();
        if (!profile) return res.status(404).json({ success: false, error: 'User not found' });

        // Server-side email re-validation
        const emailCheck = await checkEmailDeliverable(deliveryEmail || profile.email);
        if (!emailCheck.ok) return res.status(400).json({ success: false, code: emailCheck.code, error: emailCheck.message });
        const email = emailCheck.email;

        let usdToNgn;
        try {
            usdToNgn = await adminSettings.getRate('USD', 'NGN');
        } catch (rateErr) {
            if (rateErr.code === 'RATE_NOT_CONFIGURED' || rateErr.code === 'CONFIG_NOT_READY') return res.status(503).json({ success: false, error: 'USD→NGN rate is not configured.', code: 'RATE_NOT_CONFIGURED' });
            throw rateErr;
        }

        let planInfo = await lookupEsimPlan(destination, productId);
        if (!planInfo) {
            const fallbackDestination = await inferDestinationForProduct(productId);
            if (fallbackDestination) planInfo = await lookupEsimPlan(fallbackDestination, productId);
        }
        if (!planInfo) return res.status(404).json({ success: false, error: 'Plan not found or unavailable', code: 'PRODUCT_UNAVAILABLE' });

        const priced = await resolveEsimPricing({ wholesaleUsd: planInfo.wholesaleUsd });
        await assertWithinLimits({ totalUsd: priced.totalUsd, totalNgn: priced.totalNgn, usdToNgn: priced.usdToNgn });

        let walletUsdStr = String(profile.wallet_usd ?? '0.00');
        let walletNgnStr = String(profile.wallet_ngn ?? '0.00');
        try {
            if (compareMoney(walletUsdStr, '0.00') === 0 || compareMoney(walletNgnStr, '0.00') === 0) {
                const balances = await LedgerService.getAllBalances(userId);
                if (compareMoney(walletUsdStr, '0.00') === 0) walletUsdStr = String(balances.USD ?? '0.00');
                if (compareMoney(walletNgnStr, '0.00') === 0) walletNgnStr = String(balances.NGN ?? '0.00');
            }
        } catch (e) { console.warn('[ESIM /purchase] ledger fallback failed:', e.message); }

        let debitCurrency, debitAmount;
        if (currency === 'USD') {
            if (compareMoney(walletUsdStr, priced.totalUsd) < 0) return res.status(400).json({ success: false, code: 'INSUFFICIENT_BALANCE', error: `Insufficient USD. Required: $${priced.totalUsd}, Available: $${walletUsdStr}`, data: { requiredUsd: priced.totalUsd, availableUsd: walletUsdStr } });
            debitCurrency = 'USD'; debitAmount = priced.totalUsd;
        } else if (currency === 'NGN') {
            if (compareMoney(walletNgnStr, priced.totalNgn) < 0) return res.status(400).json({ success: false, code: 'INSUFFICIENT_BALANCE', error: `Insufficient NGN. Required: ₦${priced.totalNgn}, Available: ₦${walletNgnStr}`, data: { requiredNgn: priced.totalNgn, availableNgn: walletNgnStr } });
            debitCurrency = 'NGN'; debitAmount = priced.totalNgn;
        } else {
            if (compareMoney(walletUsdStr, priced.totalUsd) >= 0) { debitCurrency = 'USD'; debitAmount = priced.totalUsd; }
            else if (compareMoney(walletNgnStr, priced.totalNgn) >= 0) { debitCurrency = 'NGN'; debitAmount = priced.totalNgn; }
            else return res.status(400).json({ success: false, code: 'INSUFFICIENT_BALANCE', error: `Insufficient balance. Required: $${priced.totalUsd} or ₦${priced.totalNgn}`, data: { requiredUsd: priced.totalUsd, availableUsd: walletUsdStr, requiredNgn: priced.totalNgn, availableNgn: walletNgnStr } });
        }

        orderId = crypto.randomUUID();
        const reference = 'ESIM-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

        const { error: orderError } = await supabaseAdmin.from('esim_transactions').insert({
            id: orderId, user_id: userId, reference, idempotency_key: idempotencyKey,
            country_iso2: planInfo.countryIso2 || '', country_iso3: planInfo.countryIso3 || destination.iso3 || destination.code || null,
            country_name: planInfo.countryName || destination.code || 'Global', country_flag: planInfo.countryFlag || null,
            destination_type: planInfo.destinationType || destination.type, product_id: productId, plan_name: planInfo.planName,
            data_display: planInfo.dataDisplay, data_mb: planInfo.dataMb || 0, validity_days: planInfo.validityDays,
            wholesale_usd: planInfo.wholesaleUsd || 0, price_usd: priced.priceUsd, fee_usd: priced.feeUsd, total_usd: priced.totalUsd,
            exchange_rate: priced.usdToNgn, price_ngn: priced.totalNgn, debit_currency: debitCurrency, debit_amount: debitAmount,
            delivery_email: email, status: 'pending', delivery_status: 'pending', email_status: 'pending', refund_status: 'not_applicable',
            reconciliation_attempts: 0, delivery_attempts: 0, email_attempts: 0, refund_attempts: 0,
            created_at: new Date().toISOString(), updated_at: new Date().toISOString()
        });

        if (orderError) {
            if (orderError.code === '23505') {
                const { data: dup } = await supabaseAdmin.from('esim_transactions').select('id, reference, status, dtone_external_id').eq('user_id', userId).eq('idempotency_key', idempotencyKey).maybeSingle();
                if (dup) return res.json({ success: true, data: { transactionId: dup.id, reference: dup.reference, externalId: dup.dtone_external_id, status: dup.status, already_processed: true } });
            }
            throw new Error(`Order insert failed: ${orderError.message}`);
        }

        // ★ NEW: mirror as an order (pending) so it's visible immediately
        // Non-fatal — a mirror failure must never break a purchase.
        try {
            await recordOrder({
                billTransactionId: orderId,
                reference,
                userId,
                productType: 'esim',
                serviceId: planInfo.countryIso3 || destination.code || 'GLOBAL',
                provider: 'dtone',
                currency: debitCurrency,
                amount: debitAmount,
                serviceFee: priced.feeNgn || 0,
                totalAmount: debitAmount,
                providerCost: planInfo.wholesaleUsd || 0,
                status: 'pending',
                recipient: email,
                metadata: {
                    plan_name: planInfo.planName,
                    country_name: planInfo.countryName,
                    data_display: planInfo.dataDisplay,
                    validity_days: planInfo.validityDays
                }
            });
        } catch (orderMirrorErr) {
            console.error('[ESIM] recordOrder (pending) failed:', orderMirrorErr.message);
        }

        debitResult = await LedgerService.debitWallet(userId, debitAmount, debitCurrency, `eSIM: ${planInfo.planName} (${planInfo.countryName})`, { order_id: orderId, reference, service: 'esim', product_id: productId, destination: destination.code });

        if (!debitResult?.success) throw new Error(debitResult?.error || 'Wallet debit failed');
        walletDebited = true;

        await supabaseAdmin.from('esim_transactions').update({ ledger_transaction_id: debitResult.transaction_id, status: 'processing', updated_at: new Date().toISOString() }).eq('id', orderId);

        const quote = await dtoneService.createQuote({
            productId, phone: null, mode: 'FIXED', callbackUrl: getPublicCallbackUrl('/api/webhooks/dtone/esim'), orderReference: reference
        });

        if (!quote?.transactionId) throw new Error('DT One did not return a transaction ID');

        providerTransactionId = String(quote.transactionId);
        const dtoneExternalId = quote.externalId || null;

        await supabaseAdmin.from('esim_transactions').update({
            provider_transaction_id: providerTransactionId, dtone_external_id: dtoneExternalId, provider_status: 'CREATED', provider_response: quote.raw || quote, updated_at: new Date().toISOString()
        }).eq('id', orderId);

        const confirmation = await dtoneService.confirmTransaction(providerTransactionId);
        const providerStatus = String(confirmation?.status?.message || confirmation?.status?.class?.message || 'SUBMITTED').toUpperCase();

        await supabaseAdmin.from('esim_transactions').update({ provider_status: providerStatus, provider_response: confirmation || {}, updated_at: new Date().toISOString() }).eq('id', orderId);

        const normalized = dtoneService.normalizeStatus(confirmation?.status || providerStatus);

        if (normalized.final && normalized.status === 'completed') {
            // finalizeEsimOrder will recordOrder(status='completed') internally.
            await finalizeEsimOrder(orderId, providerTransactionId);
            const { data: fresh } = await supabaseAdmin.from('esim_transactions').select('*').eq('id', orderId).single();
            return res.json({ success: true, data: shapeCompleted(fresh) });
        }

        if (normalized.final && ['failed', 'cancelled', 'reversed'].includes(normalized.status)) {
            // refundEsimOrder will recordOrder(status='failed') internally.
            await refundEsimOrder(userId, orderId, `Provider: ${normalized.code}`);
            return res.json({ success: true, data: { transactionId: orderId, reference, externalId: dtoneExternalId, status: normalized.status } });
        }

        // Still processing — the pending recordOrder already covers this state.
        return res.json({ success: true, data: { transactionId: orderId, reference, externalId: dtoneExternalId, status: 'processing' } });

    } catch (error) {
        console.error('❌ POST /purchase error:', error.message, error.providerData || '');

        if (orderId) {
            try {
                const isAmbiguous = error.code === 'PROVIDER_UNKNOWN' || error.message?.includes('timeout') || error.message?.includes('aborted') || error.message?.includes('socket hang up');
                
                if (walletDebited && !providerTransactionId) {
                    if (isAmbiguous) {
                        await supabaseAdmin.from('esim_transactions').update({ status: 'provider_unknown', failure_reason: `Provider outcome unknown: ${error.message}`, updated_at: new Date().toISOString() }).eq('id', orderId);
                        // ★ NEW: leave order as pending (provider_unknown is not yet final)
                        await recordOrder({
                            billTransactionId: orderId, reference: null, userId,
                            productType: 'esim', serviceId: null, provider: 'dtone',
                            currency: null, amount: 0, serviceFee: 0, totalAmount: 0, providerCost: 0,
                            status: 'pending', recipient: null,
                            metadata: { failure_reason: `Provider outcome unknown: ${error.message}`, provider_unknown: true }
                        }).catch(e => console.error('[ESIM] recordOrder (provider-unknown) failed:', e.message));
                    } else {
                        await refundEsimOrder(userId, orderId, error.message || 'DT One transaction creation failed');
                        // refundEsimOrder's internal recordOrder(status='failed') handles the order mirror.
                    }
                } else if (walletDebited && providerTransactionId) {
                    await supabaseAdmin.from('esim_transactions').update({ status: 'processing', failure_reason: `Post-quote error: ${error.message}`, updated_at: new Date().toISOString() }).eq('id', orderId);
                    // Order stays pending — reconciliation/webhook will finalize.
                } else {
                    await supabaseAdmin.from('esim_transactions').update({ status: 'failed', failure_reason: error.message, failed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', orderId);
                    // ★ NEW: mark order failed
                    await recordOrder({
                        billTransactionId: orderId, reference: null, userId,
                        productType: 'esim', serviceId: null, provider: 'dtone',
                        currency: null, amount: 0, serviceFee: 0, totalAmount: 0, providerCost: 0,
                        status: 'failed', recipient: null,
                        metadata: { failure_reason: error.message }
                    }).catch(e => console.error('[ESIM] recordOrder (pre-debit-fail) failed:', e.message));
                }
            } catch (cleanupErr) { console.error('❌ Cleanup failed:', cleanupErr.message); }
        }

        const providerStatus = error.providerStatus || error.response?.status;
        
        if (providerStatus === 401 || providerStatus === 403) {
            console.error(`🚨 [ESIM PURCHASE] Critical provider error: ${providerStatus}`);
            return res.status(502).json({ success: false, error: 'Service temporarily unavailable.', code: 'PROVIDER_ERROR' });
        }
        
        if (providerStatus === 429) {
            return res.status(502).json({ success: false, error: 'Provider is busy. Please try again shortly.', code: 'PROVIDER_BUSY' });
        }

        if (providerStatus === 404 || providerStatus === 422) {
            return res.status(409).json({ success: false, error: 'This plan is temporarily unavailable. Please pick another.', code: 'PRODUCT_UNAVAILABLE' });
        }
        
        if (providerStatus && providerStatus >= 500) {
            return res.status(502).json({ success: false, error: 'Provider is busy. Please try again shortly.', code: 'PROVIDER_BUSY' });
        }

        if (error.code === 'PROVIDER_UNKNOWN') {
            return res.status(202).json({ success: true, data: { transactionId: orderId, reference: null, status: 'provider_unknown' } });
        }

        if (error.status && error.code) {
            return res.status(error.status).json({ success: false, error: error.message, code: error.code, min_ngn: error.min_ngn, max_ngn: error.max_ngn, service: error.service });
        }

        return res.status(500).json({ success: false, error: error.message || 'Failed to create eSIM order' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  GET /status/:transactionId
// ════════════════════════════════════════════════════════════════════════
router.get('/status/:transactionId', authMiddleware, async (req, res) => {
    try {
        const { transactionId } = req.params;
        const { data: order, error } = await supabaseAdmin.from('esim_transactions').select('*').eq('id', transactionId).eq('user_id', req.user.id).maybeSingle();

        if (error || !order) return res.status(404).json({ success: false, error: 'Order not found' });

        if (order.status === 'completed' && order.delivery_status === 'ready') return res.json({ success: true, data: shapeCompleted(order) });
        if (order.status === 'completed' && order.delivery_status !== 'ready') return res.json({ success: true, data: { status: 'delivery_pending', isFinal: false, qrCodeUrl: null, errorMessage: 'Your payment was successful. We are retrieving your eSIM details.' } });
        if (['failed', 'refunded', 'cancelled', 'reversed', 'manual_review'].includes(order.status)) return res.json({ success: true, data: { status: order.status, isFinal: true, qrCodeUrl: null, errorMessage: order.failure_reason || 'Order could not be completed' } });

        if (order.provider_transaction_id) {
            try {
                const dtoneResult = await dtoneService.queryTransaction(order.provider_transaction_id);

                if (dtoneResult.notFound && order.dtone_external_id) {
                    const alt = await dtoneService.getTransactionByExternalId(order.dtone_external_id);
                    if (alt) {
                        const altStatus = dtoneService.normalizeStatus(alt.status || alt);
                        if (altStatus.final && altStatus.status === 'completed') {
                            await finalizeEsimOrder(order.id, order.provider_transaction_id, { raw: alt });
                            const fresh = await supabaseAdmin.from('esim_transactions').select('*').eq('id', order.id).single();
                            return res.json({ success: true, data: shapeCompleted(fresh.data) });
                        }
                        if (altStatus.final && ['failed', 'cancelled', 'reversed'].includes(altStatus.status)) {
                            await refundEsimOrder(order.user_id, order.id, `External lookup: ${altStatus.code}`);
                            return res.json({ success: true, data: { status: altStatus.status, isFinal: true, qrCodeUrl: null, errorMessage: 'Provider rejected order' } });
                        }
                    }
                }

                if (dtoneResult.status === 'completed') {
                    await finalizeEsimOrder(order.id, order.provider_transaction_id, dtoneResult);
                    const fresh = await supabaseAdmin.from('esim_transactions').select('*').eq('id', order.id).single();
                    if (fresh?.delivery_status === 'ready') return res.json({ success: true, data: shapeCompleted(fresh.data) });
                    return res.json({ success: true, data: { status: 'delivery_pending', isFinal: false, qrCodeUrl: null, errorMessage: 'Provider confirmed. Fetching your eSIM details now.' } });
                }

                if (dtoneResult.isFinal && ['failed', 'cancelled', 'reversed'].includes(dtoneResult.status)) {
                    await refundEsimOrder(req.user.id, order.id, dtoneResult.errorMessage || `Provider: ${dtoneResult.providerStatus}`);
                    return res.json({ success: true, data: { status: dtoneResult.status, isFinal: true, qrCodeUrl: null, errorMessage: dtoneResult.errorMessage || 'Provider rejected order' } });
                }

                await supabaseAdmin.from('esim_transactions').update({ provider_status: dtoneResult.providerStatus, provider_response: dtoneResult.raw, reconciliation_attempts: (order.reconciliation_attempts || 0) + 1, last_reconciled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', order.id);
            } catch (dtoneErr) { console.warn('⚠️ DT One status query failed:', dtoneErr.message); }
        }

        const elapsedMin = (Date.now() - new Date(order.created_at).getTime()) / 60000;
        if (elapsedMin > MAX_AGE_MINUTES && (order.reconciliation_attempts || 0) >= MAX_RECONCILE_ATTEMPTS) {
            await supabaseAdmin.from('esim_transactions').update({ status: 'manual_review', failure_reason: `Exceeded ${MAX_AGE_MINUTES} min without final status`, updated_at: new Date().toISOString() }).eq('id', order.id);
            // ★ NEW: sync order to failed (manual review means we can't guarantee completion)
            await recordOrder({
                billTransactionId: order.id, reference: order.reference, userId: order.user_id,
                productType: 'esim', serviceId: order.country_iso3, provider: 'dtone',
                currency: order.debit_currency, amount: order.debit_amount, serviceFee: order.fee_usd || 0,
                totalAmount: order.debit_amount, providerCost: order.wholesale_usd || 0,
                status: 'failed', recipient: order.delivery_email,
                metadata: { failure_reason: `Exceeded ${MAX_AGE_MINUTES} min without final status`, manual_review: true }
            }).catch(e => console.error('[ESIM status] recordOrder (manual-review) failed:', e.message));
            return res.json({ success: true, data: { status: 'manual_review', isFinal: true, qrCodeUrl: null, errorMessage: 'We are confirming this order with our provider. Our team will contact you shortly.' } });
        }

        res.json({ success: true, data: { status: 'processing', isFinal: false, qrCodeUrl: null, errorMessage: null } });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to check order status' });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════════
function shapeCompleted(t) {
    if (!t) return null;
    return {
        transactionId: t.id, reference: t.reference, countryName: t.country_name, countryFlag: t.country_flag, planName: t.plan_name, dataAmount: t.data_display, validityDays: t.validity_days, totalUsd: parseFloat(t.total_usd) || 0, status: 'completed', isFinal: true, qrCodeUrl: t.qr_code_url, activationCode: t.activation_code, lpaString: t.lpa_string, serial: t.serial_number, iccid: t.iccid, installationUrl: t.installation_url, appleUniversalLink: t.apple_universal_link, androidUniversalLink: t.android_universal_link, smdpAddress: t.smdp_address, matchingId: t.matching_id, instructions: t.instructions, deliveryStatus: t.delivery_status, emailStatus: t.email_status, errorMessage: null
    };
}

async function finalizeEsimOrder(orderId, dtoneTxId, dtoneResultOverride = null) {
    const { data: existing } = await supabaseAdmin.from('esim_transactions').select('*').eq('id', orderId).single();
    if (!existing) return { success: false };
    if (existing.status === 'completed' && existing.delivery_status === 'ready') {
        if (!existing.email_sent) queueEsimEmail(orderId);
        return { success: true, alreadyFinalized: true };
    }

    let dtoneResult = dtoneResultOverride;
    if (!dtoneResult) {
        try { dtoneResult = await dtoneService.queryTransaction(dtoneTxId); }
        catch (e) { dtoneResult = { raw: {} }; }
    }

    const delivery = dtoneService.extractEsimDelivery(dtoneResult);
    if (!delivery?.lpaString) {
        await supabaseAdmin.from('esim_transactions').update({ provider_response: dtoneResult?.raw || {}, provider_status: dtoneResult?.providerStatus || 'COMPLETED', delivery_status: 'pending', delivery_attempts: (existing.delivery_attempts || 0) + 1, last_delivery_error: 'Provider completed transaction but eSIM activation data was not found', updated_at: new Date().toISOString() }).eq('id', orderId);
        return { success: false, deliveryPending: true };
    }

    let qrCodeUrl = delivery.qrCodeUrl;
    if (!qrCodeUrl) {
        try { qrCodeUrl = await generateEsimQr(delivery.lpaString, existing.reference); }
        catch (qrErr) {
            await supabaseAdmin.from('esim_transactions').update({ delivery_status: 'pending', delivery_attempts: (existing.delivery_attempts || 0) + 1, last_delivery_error: `QR generation failed: ${qrErr.message}`, updated_at: new Date().toISOString() }).eq('id', orderId);
            return { success: false, deliveryPending: true };
        }
    }

    const now = new Date().toISOString();
    const { data: claimed } = await supabaseAdmin.from('esim_transactions').update({
        status: 'completed', completed_at: now, qr_code_url: qrCodeUrl, activation_code: delivery.activationCode || delivery.lpaString,
        lpa_string: delivery.lpaString, serial_number: delivery.serial || null, iccid: delivery.iccid || null,
        installation_url: delivery.installationUrl || null, apple_universal_link: delivery.appleUniversalLink || null,
        android_universal_link: delivery.androidUniversalLink || null, smdp_address: delivery.smdpAddress || null,
        matching_id: delivery.matchingId || null, instructions: delivery.instructions || null, delivery_status: 'ready',
        delivery_attempts: (existing.delivery_attempts || 0) + 1, provider_response: dtoneResult.raw || existing.provider_response,
        provider_status: dtoneResult.providerStatus || 'COMPLETED', updated_at: now
    }).eq('id', orderId).in('status', ['processing', 'pending', 'completed']).select('*').maybeSingle();

    if (!claimed) return { success: true, alreadyFinalized: true };

    // ★ NEW: mirror as completed order (covers webhook and status-poll completions)
    try {
        await recordOrder({
            billTransactionId: orderId,
            reference: claimed.reference,
            userId: claimed.user_id,
            productType: 'esim',
            serviceId: claimed.country_iso3 || 'GLOBAL',
            provider: 'dtone',
            currency: claimed.debit_currency,
            amount: claimed.debit_amount,
            serviceFee: claimed.fee_usd || 0,
            totalAmount: claimed.debit_amount,
            providerCost: claimed.wholesale_usd || 0,
            status: 'completed',
            recipient: claimed.delivery_email,
            metadata: {
                plan_name: claimed.plan_name,
                country_name: claimed.country_name,
                data_display: claimed.data_display,
                validity_days: claimed.validity_days,
                iccid: claimed.iccid,
                serial: claimed.serial_number
            }
        });
    } catch (orderMirrorErr) {
        console.error('[ESIM finalize] recordOrder (completed) failed:', orderMirrorErr.message);
    }

    queueEsimEmail(orderId);
    return { success: true };
}

function queueEsimEmail(orderId) {
    setImmediate(async () => {
        try {
            const { data: order } = await supabaseAdmin.from('esim_transactions').select('*').eq('id', orderId).single();
            if (order) await trySendEsimEmail(order);
        } catch (e) { console.error(`❌ Email queue error for ${orderId}:`, e.message); }
    });
}

async function trySendEsimEmail(order) {
    if (!order || order.email_sent) return true;
    if (!order.delivery_email) return false;

    const isStaleSending = order.email_status === 'sending' && order.updated_at && (Date.now() - new Date(order.updated_at).getTime()) > STALE_SENDING_MS;
    if (order.email_status === 'sending' && !isStaleSending) return true;
    if ((order.email_attempts || 0) >= EMAIL_MAX_ATTEMPTS) {
        await supabaseAdmin.from('esim_transactions').update({ email_status: 'failed', last_email_error: 'Max attempts reached', updated_at: new Date().toISOString() }).eq('id', order.id);
        return false;
    }

    const { data: claimed } = await supabaseAdmin.from('esim_transactions').update({ email_status: 'sending', email_attempts: (order.email_attempts || 0) + 1, updated_at: new Date().toISOString() }).eq('id', order.id).eq('email_sent', false).or(`email_status.neq.sending,updated_at.lt.${new Date(Date.now() - STALE_SENDING_MS).toISOString()}`).select('*').maybeSingle();
    if (!claimed) return true;

    try {
        const { data: profile } = await supabaseAdmin.from('profiles').select('username').eq('id', claimed.user_id).maybeSingle();
        const emailRes = await emailService.sendEsimDeliveryEmail({
            email: claimed.delivery_email, username: profile?.username || 'Traveller', reference: claimed.reference,
            countryName: claimed.country_name, planName: claimed.plan_name, dataDisplay: claimed.data_display,
            validityDays: claimed.validity_days, totalUsd: claimed.total_usd, totalNgn: claimed.price_ngn,
            debitCurrency: claimed.debit_currency, debitAmount: claimed.debit_amount, qrCodeUrl: claimed.qr_code_url,
            activationCode: claimed.activation_code, lpaString: claimed.lpa_string, smdpAddress: claimed.smdp_address,
            matchingId: claimed.matching_id, instructions: claimed.instructions
        });

        if (emailRes?.success) {
            await supabaseAdmin.from('esim_transactions').update({ email_sent: true, email_sent_at: new Date().toISOString(), email_message_id: emailRes.messageId || null, email_status: 'sent', last_email_error: null, next_email_retry_at: null, updated_at: new Date().toISOString() }).eq('id', order.id);
            return true;
        }

        const attempt = claimed.email_attempts || 1;
        const backoffMin = EMAIL_RETRY_BACKOFF_MIN[Math.min(attempt - 1, EMAIL_RETRY_BACKOFF_MIN.length - 1)];
        const nextRetry = new Date(Date.now() + backoffMin * 60 * 1000);
        await supabaseAdmin.from('esim_transactions').update({ email_status: attempt >= EMAIL_MAX_ATTEMPTS ? 'failed' : 'pending', last_email_error: emailRes?.error || emailRes?.message || 'Unknown error', next_email_retry_at: attempt >= EMAIL_MAX_ATTEMPTS ? null : nextRetry.toISOString(), updated_at: new Date().toISOString() }).eq('id', order.id);
        return false;
    } catch (e) {
        const attempt = claimed.email_attempts || 1;
        const backoffMin = EMAIL_RETRY_BACKOFF_MIN[Math.min(attempt - 1, EMAIL_RETRY_BACKOFF_MIN.length - 1)];
        const nextRetry = new Date(Date.now() + backoffMin * 60 * 1000);
        await supabaseAdmin.from('esim_transactions').update({ email_status: attempt >= EMAIL_MAX_ATTEMPTS ? 'failed' : 'pending', last_email_error: e.message, next_email_retry_at: attempt >= EMAIL_MAX_ATTEMPTS ? null : nextRetry.toISOString(), updated_at: new Date().toISOString() }).eq('id', order.id);
        return false;
    }
}

async function refundEsimOrder(userId, orderId, reason) {
    try {
        const { data: order } = await supabaseAdmin.from('esim_transactions').select('*').eq('id', orderId).single();
        if (!order) return;
        if (order.refunded === true || order.status === 'refunded') return;
        if (order.refund_status === 'completed') return;

        const { data: claimed } = await supabaseAdmin.from('esim_transactions').update({ refund_status: 'processing', refund_attempts: (order.refund_attempts || 0) + 1, failure_reason: reason, updated_at: new Date().toISOString() }).eq('id', orderId).in('refund_status', ['not_applicable', 'failed']).eq('refunded', false).select('*').maybeSingle();
        if (!claimed) return;

        try {
            if (claimed.ledger_transaction_id) {
                await LedgerService.refundTransaction({ userId: claimed.user_id, transactionId: claimed.ledger_transaction_id, reason: `eSIM refund: ${reason}` });
            }
            await supabaseAdmin.from('esim_transactions').update({ status: 'refunded', refunded: true, refund_status: 'completed', refunded_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', orderId);

            // ★ NEW: mark order failed (refunded orders should not count as revenue)
            try {
                await recordOrder({
                    billTransactionId: orderId,
                    reference: claimed.reference,
                    userId: claimed.user_id,
                    productType: 'esim',
                    serviceId: claimed.country_iso3 || 'GLOBAL',
                    provider: 'dtone',
                    currency: claimed.debit_currency,
                    amount: claimed.debit_amount,
                    serviceFee: claimed.fee_usd || 0,
                    totalAmount: claimed.debit_amount,
                    providerCost: claimed.wholesale_usd || 0,
                    status: 'failed',
                    recipient: claimed.delivery_email,
                    metadata: {
                        failure_reason: reason,
                        refunded: true,
                        plan_name: claimed.plan_name,
                        country_name: claimed.country_name
                    }
                });
            } catch (orderMirrorErr) {
                console.error('[ESIM refund] recordOrder (failed) failed:', orderMirrorErr.message);
            }
        } catch (refundErr) {
            await supabaseAdmin.from('esim_transactions').update({ refund_status: 'failed', refund_error: refundErr.message, updated_at: new Date().toISOString() }).eq('id', orderId);
        }
    } catch (err) { console.error('❌ eSIM refund handler error:', err.message); }
}

async function lookupEsimPlan(destination, productId) {
    try {
        const { data: row, error } = await supabaseAdmin.from('esim_products').select('*').eq('provider', 'dtone').eq('provider_env', PROVIDER_ENV).eq('provider_product_id', String(productId)).eq('enabled', true).maybeSingle();
        if (error || !row) return null;

        const destType = destination.type;
        if (destType === 'global' && row.coverage_type !== 'global') return null;
        if (destType === 'country' && row.coverage_type !== 'country') return null;
        if (destType === 'country') {
            const codes = (row.regions || []).map(r => String(r.code || '').toUpperCase());
            if (!codes.includes(String(destination.code).toUpperCase())) return null;
        }

        let wholesaleUsdStr;
        const whCcy = String(row.wholesale_currency || 'USD').toUpperCase();
        if (whCcy === 'USD') { wholesaleUsdStr = String(row.wholesale_amount ?? '0.00'); }
        else if (whCcy === 'NGN') {
            const usdToNgn = await adminSettings.getRate('USD', 'NGN');
            const ngnMinor  = BigInt(String(row.wholesale_amount || '0').replace('.', ''));
            const rateMinor = BigInt(String(usdToNgn).replace('.', ''));
            const usdMinor  = (ngnMinor * 100n) / rateMinor;
            wholesaleUsdStr = (usdMinor / 100n).toString() + '.' + (usdMinor % 100n).toString().padStart(2, '0');
        } else { return null; }

        const planDestType = row.coverage_type;
        const planDestCode = planDestType === 'global' ? 'GLOBAL' : (row.regions?.[0]?.code || null);

        return {
            productId: row.provider_product_id, planName: row.display_name || row.name,
            dataDisplay: row.data_mb != null ? (row.data_mb >= 1024 ? `${(row.data_mb / 1024).toFixed(0)} GB` : `${row.data_mb} MB`) : null,
            dataMb: row.data_mb, validityDays: row.validity_days, wholesaleUsd: wholesaleUsdStr,
            destinationType: planDestType, countryIso3: planDestType === 'country' ? planDestCode : null,
            countryIso2: planDestCode && planDestCode.length === 3 ? (ISO3_TO_ISO2[planDestCode] || '') : '',
            countryName: row.regions?.[0]?.name || row.name || (planDestCode || 'Global'), countryFlag: null
        };
    } catch (e) { return null; }
}

async function inferDestinationForProduct(productId) {
    try {
        const { data: row, error } = await supabaseAdmin.from('esim_products').select('provider_product_id, coverage_type, regions, enabled').eq('provider', 'dtone').eq('provider_env', PROVIDER_ENV).eq('provider_product_id', String(productId)).eq('enabled', true).maybeSingle();
        if (error || !row) return null;
        if (row.coverage_type === 'global') return { type: 'global', code: 'GLOBAL', iso3: null };
        if (row.coverage_type === 'regional') {
            const code = row.regions?.[0]?.code || null;
            return code ? { type: 'regional', code, iso3: null } : null;
        }
        const code = row.regions?.[0]?.code || null;
        if (!code) return null;
        return { type: 'country', code, iso3: code };
    } catch { return null; }
}

function getPublicCallbackUrl(path) {
    const base = process.env.APP_URL || '';
    if (!/^https:\/\//i.test(base)) return undefined;
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(base)) return undefined;
    return `${base.replace(/\/$/, '')}${path}`;
}

module.exports = router;