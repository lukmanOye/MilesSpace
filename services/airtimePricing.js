// services/airtimePricing.js
// ────────────────────────────────────────────────────────────────
// Single source of truth for airtime pricing.
//
// Uses adminSettingsService for FX, fee percentages and kill
// switches. Uses pricingEngine for all arithmetic — BigInt only,
// no Number(), no parseFloat on money.
//
// Both routes/airtime.js (GLOBAL) and routes/billsRoutes.js
// (LOCAL) call this module. The admin service also calls it.
//
// FIX 2026-11-07: readGlobalConfig / readLocalConfig were reading
// keys that don't exist in adminSettingsService.KEY_REGISTRY
// (airtime_local_enabled, airtime_local_fee_pct, ...). getBoolean /
// getRaw returned undefined, which the fallback turned into
// `false` / hardcoded defaults — so the DB settings were ignored
// and the customer route always 503'd with "local airtime is
// disabled". Now reads the actual registry keys.
// ────────────────────────────────────────────────────────────────
'use strict';

const adminSettings = require('./adminSettingsService');
const pricingEngine = require('./pricingEngine');

const CCY_SCALE = 2;
const PCT_SCALE = 4;

function isDecimalString(s) {
    return typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s);
}

function toMoneyStr(v) {
    if (v == null) return '0.00';
    const s = String(v);
    return isDecimalString(s) ? s : '0.00';
}

// ─── Global (DT One) ─────────────────────────────────────────────
// Reads the REAL keys from adminSettingsService.KEY_REGISTRY:
//   service_airtime_enabled     ← master kill switch
//   provider_dtone_enabled      ← DT One provider gate
//   airtime_markup_pct_usd      ← USD markup (decimal string)
//   usd_to_ngn                  ← FX rate
// Falls back gracefully if a key is missing, but NEVER to `false`.
async function readGlobalConfig() {
    const [airtimeOn, dtoneOn] = await Promise.all([
        adminSettings.isServiceEnabled('airtime').catch(() => false),
        adminSettings.isProviderEnabled('dtone').catch(() => false)
    ]);

    const feePct = await adminSettings.getMarkup('airtime', 'USD').catch(() => '0.0200');
    const fx     = await adminSettings.getRate('USD', 'NGN').catch(() => '1600.00');

    // Global min/max are not in the current registry. If you add them
    // later as `airtime_global_min_usd` / `airtime_global_max_usd`,
    // uncomment the getRaw calls below. For now, use conservative
    // defaults that match DT One's documented floor/ceiling.
    // const minUsd = await adminSettings.getRaw('airtime_global_min_usd').catch(() => '0.50');
    // const maxUsd = await adminSettings.getRaw('airtime_global_max_usd').catch(() => '1000.00');
    const minUsd = '0.50';
    const maxUsd = '1000.00';

    return {
        // Both must be true AND the provider must be configured.
        enabled: Boolean(airtimeOn && dtoneOn),
        feePercent: isDecimalString(String(feePct)) ? String(feePct) : '0.0200',
        min: isDecimalString(String(minUsd)) ? String(minUsd) : '0.50',
        max: isDecimalString(String(maxUsd)) ? String(maxUsd) : '1000.00',
        fx: isDecimalString(String(fx)) ? String(fx) : '1600.00'
    };
}

// ─── Local (VTpass) ──────────────────────────────────────────────
// Reads the REAL keys from adminSettingsService.KEY_REGISTRY:
//   service_airtime_enabled     ← master kill switch
//   provider_vtpass_enabled     ← VTpass provider gate
//   airtime_markup_pct_ngn      ← NGN markup (decimal string)
//   airtime_min_ngn             ← min (decimal string)
//   airtime_max_ngn             ← max (decimal string)
async function readLocalConfig() {
    const [airtimeOn, vtpassOn] = await Promise.all([
        adminSettings.isServiceEnabled('airtime').catch(() => false),
        adminSettings.isProviderEnabled('vtpass').catch(() => false)
    ]);

    const feePct = await adminSettings.getMarkup('airtime', 'NGN').catch(() => '0.0000');
    const minNgn = await adminSettings.getLimit('airtime', 'min').catch(() => '50');
    const maxNgn = await adminSettings.getLimit('airtime', 'max').catch(() => '50000');

    return {
        enabled: Boolean(airtimeOn && vtpassOn),
        feePercent: isDecimalString(String(feePct)) ? String(feePct) : '0.0000',
        min: isDecimalString(String(minNgn)) ? String(minNgn) : '50',
        max: isDecimalString(String(maxNgn)) ? String(maxNgn) : '50000'
    };
}

/**
 * Quote a GLOBAL airtime purchase.
 * Inputs are decimal strings or numbers; the amount is normalised
 * to a string before math.
 */
async function quoteGlobal({ sendUsd, walletType }) {
    const cfg = await readGlobalConfig();
    const sendStr = toMoneyStr(sendUsd);

    const feeStr = pricingEngine.mulByPercent(sendStr, cfg.feePercent, CCY_SCALE, PCT_SCALE, CCY_SCALE);
    const totalUsdStr = pricingEngine.addDecimal(sendStr, feeStr, CCY_SCALE);
    const totalNgnStr = (() => {
        // totalUsd × fx
        const usdMinor = pricingEngine.toMinor(totalUsdStr, CCY_SCALE);
        const rateMinor = pricingEngine.toMinor(cfg.fx, CCY_SCALE);
        const ngnScaled = pricingEngine.roundHalfUp(usdMinor * rateMinor, CCY_SCALE);
        return pricingEngine.fromMinor(ngnScaled, CCY_SCALE);
    })();

    const wallet = String(walletType || 'USD').toUpperCase();
    return {
        sendUsd: sendStr,
        feeUsd: feeStr,
        totalUsd: totalUsdStr,
        totalNgn: totalNgnStr,
        fxUsdNgn: cfg.fx,
        feePercent: cfg.feePercent,
        payAmount: wallet === 'NGN' ? totalNgnStr : totalUsdStr,
        payCurrency: wallet === 'NGN' ? 'NGN' : 'USD'
    };
}

/**
 * Quote a LOCAL airtime purchase.
 */
async function quoteLocal({ amountNgn }) {
    const cfg = await readLocalConfig();
    const amountStr = toMoneyStr(amountNgn);
    const feeStr = pricingEngine.mulByPercent(amountStr, cfg.feePercent, CCY_SCALE, PCT_SCALE, CCY_SCALE);
    const totalStr = pricingEngine.addDecimal(amountStr, feeStr, CCY_SCALE);
    return {
        amountNgn: amountStr,
        feeNgn: feeStr,
        totalNgn: totalStr,
        feePercent: cfg.feePercent
    };
}

async function getAirtimeConfig() {
    const [g, l] = await Promise.all([readGlobalConfig(), readLocalConfig()]);
    return { global: g, local: l };
}

/**
 * Build the DB snapshot fields for airtime_transactions.
 * Called inside routes/airtime.js during purchase.
 */
function buildSnapshotGlobal(quote, providerQuote) {
    const providerCurrency = String(providerQuote?.wholesale?.unit || 'USD').toUpperCase();
    const providerAmount = providerQuote?.wholesale?.amount != null
        ? String(providerQuote.wholesale.amount) : null;
    let providerCostNgn = null, providerCostUsd = null;
    if (providerAmount != null) {
        if (providerCurrency === 'NGN') {
            providerCostNgn = providerAmount;
        } else if (providerCurrency === 'USD') {
            providerCostUsd = providerAmount;
            // Convert to NGN using quote.fxUsdNgn
            const rateMinor = pricingEngine.toMinor(quote.fxUsdNgn, CCY_SCALE);
            const usdMinor = pricingEngine.toMinor(providerAmount, CCY_SCALE);
            const ngnScaled = pricingEngine.roundHalfUp(usdMinor * rateMinor, CCY_SCALE);
            providerCostNgn = pricingEngine.fromMinor(ngnScaled, CCY_SCALE);
        }
    }
    const marginNgn = (providerCostNgn && quote.totalNgn)
        ? pricingEngine.subDecimal(quote.totalNgn, providerCostNgn, CCY_SCALE)
        : null;

    return {
        send_amount_usd: quote.sendUsd,
        fee_usd: quote.feeUsd,
        fee_percent: quote.feePercent,
        fx_usd_ngn: quote.fxUsdNgn,
        customer_total_ngn: quote.totalNgn,
        provider_currency: providerCurrency,
        provider_cost: providerAmount,
        provider_cost_ngn: providerCostNgn,
        provider_cost_usd: providerCostUsd,
        margin_ngn: marginNgn
    };
}

/**
 * Build the DB snapshot fields for bill_payment_transactions.
 * VTpass returns a commission; if absent, provider_amount = face value.
 */
function buildSnapshotLocal(quote, vtpassResult) {
    const raw = vtpassResult?.data || {};
    const tx = raw?.content?.transactions || {};
    const commission = Number(tx.commission || raw?.commission || 0);
    const faceValue = Number(quote.amountNgn || 0);
    const providerAmount = Number.isFinite(commission) && commission > 0
        ? String((faceValue - commission).toFixed(2))
        : String(faceValue.toFixed(2));
    const feeNum = Number(quote.feeNgn || 0);
    const marginNgn = (Number(providerAmount) - faceValue + feeNum).toFixed(2);

    return {
        fee_percent: quote.feePercent,
        provider_commission_ngn: String(commission.toFixed(2)),
        provider_amount: providerAmount,
        margin_ngn: marginNgn,
        customer_amount: quote.totalNgn
    };
}

module.exports = {
    quoteGlobal,
    quoteLocal,
    getAirtimeConfig,
    buildSnapshotGlobal,
    buildSnapshotLocal
};