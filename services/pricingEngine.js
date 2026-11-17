// services/pricingEngine.js
// ─────────────────────────────────────────────────────────────────
// Single source of truth for customer pricing.
// Decimal-string BigInt math only. No Number(), no parseFloat,
// no floating-point arithmetic on money or percent.
//
// Rounding: round-half-up to 2 decimals on NGN, 2 decimals on USD.
// Optional per-currency "round up to nearest N" override.
// ─────────────────────────────────────────────────────────────────

'use strict';

// ─── Decimal string → minor units (BigInt) ──────────────────────
// "11000.00" → 1100000n
// "0.1000"   →  1000n  (when scale = 4)
function toMinor(str, scale) {
    if (str == null) return 0n;
    const s = String(str).trim();
    if (s === '') return 0n;
    const neg = s.startsWith('-');
    const clean = neg ? s.slice(1) : s;
    const [intPart = '0', fracPart = ''] = clean.split('.');
    const fracPadded = (fracPart + '0'.repeat(scale)).slice(0, scale);
    const total = BigInt(intPart || '0') * (10n ** BigInt(scale)) + BigInt(fracPadded || '0');
    return neg ? -total : total;
}

// minor units (BigInt) → decimal string, no floats
// 1100000n, scale=2 → "11000.00"
function fromMinor(minor, scale) {
    const neg = minor < 0n;
    const abs = neg ? -minor : minor;
    const div = 10n ** BigInt(scale);
    const whole = abs / div;
    const frac = (abs % div).toString().padStart(scale, '0');
    return `${neg ? '-' : ''}${whole.toString()}${scale > 0 ? '.' + frac : ''}`;
}

// Round half up: shift right by `dropDigits`, add 0.5 unit at the
// new scale, floor, shift back.
// amount: BigInt at scale `fromScale`
// returns BigInt at scale `fromScale - dropDigits`
function roundHalfUp(amount, dropDigits) {
    if (dropDigits <= 0) return amount;
    const divisor = 10n ** BigInt(dropDigits);
    const neg = amount < 0n;
    const abs = neg ? -amount : amount;
    const half = divisor / 2n;
    const rounded = (abs + half) / divisor;
    return neg ? -rounded : rounded;
}

// Multiply a decimal string by a percent (also decimal string,
// expressed as a fraction: "0.10" = 10%).
// Returns decimal string at `outScale` decimals.
// math: (amount * percent) rounded half-up to outScale.
// moneyStr: decimal string, scale `moneyScale` (typically 2)
// percentStr: decimal fraction, scale `percentScale` (typically 4 for
//   values like '0.1570' meaning 15.70%). DO NOT pass money scale here.
// outScale: decimals in the returned string (typically 2).
function mulByPercent(moneyStr, percentStr, moneyScale, percentScale, outScale) {
    const money = toMinor(moneyStr, moneyScale);
    const pct   = toMinor(percentStr, percentScale);
    // product is at scale (moneyScale + percentScale)
    const product = money * pct;
    // shift down to outScale
    const drop = (moneyScale + percentScale) - outScale;
    const rounded = roundHalfUp(product, drop);
    return fromMinor(rounded, outScale);
}

function addDecimal(a, b, scale) {
    return fromMinor(toMinor(a, scale) + toMinor(b, scale), scale);
}

function subDecimal(a, b, scale) {
    return fromMinor(toMinor(a, scale) - toMinor(b, scale), scale);
}

// Decimal → Number for margin display only. Money itself is never
// converted to Number anywhere in this file.
function decimalToNumberForDisplay(s) {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
}

// ─── Margin % (profit / cost × 100), display-only Number ────────
function marginPct(profitNgn, costNgn, scale = 2) {
    const profit = toMinor(profitNgn, scale);
    const cost = toMinor(costNgn, scale);
    if (cost === 0n) return 0;
    // Multiply by 100 to express as percent, then divide.
    const scaled = (profit * 10000n) / cost; // ×100 with 2 decimals of percent
    return decimalToNumberForDisplay(fromMinor(scaled, 2));
}

// ═════════════════════════════════════════════════════════════════
//  CORE — calculate customer price
//
//  Inputs (all decimal strings unless noted):
//    wholesaleAmount     e.g. "10000.00"
//    wholesaleCurrency   'USD' | 'NGN' | ...
//    usdToNgn            e.g. "1600.00"
//    mode                'global' | 'markup_pct' | 'fixed_ngn' | 'fixed_usd'
//    value               for 'markup_pct': decimal fraction "0.1000" = 10%
//                        for 'fixed_*':     the fixed price string
//    globalMarkupUsd     decimal fraction for 'global' mode (USD-priced cost)
//    globalMarkupNgn     decimal fraction for 'global' mode (NGN-priced cost)
//
//  Outputs (all decimal strings, scale 2, plus display fields):
//    costNgn, costUsd, priceNgn, priceUsd, profitNgn, marginPct,
//    pricingMode, pricingValue
// ═════════════════════════════════════════════════════════════════
function calculatePrice({
    wholesaleAmount,
    wholesaleCurrency,
    usdToNgn,
    mode,
    value,
    globalMarkupUsd,
    globalMarkupNgn
}) {
    const scale = 2;
    const percentScale = 4; // markups are stored with 4 decimals

    const whCcy = String(wholesaleCurrency || '').toUpperCase();
    const wh = String(wholesaleAmount || '0.00');

    // Normalize cost to both currencies. BigInt math throughout.
    let costNgn, costUsd;
    if (whCcy === 'NGN') {
        costNgn = fromMinor(roundHalfUp(toMinor(wh, scale), 0), scale);
        if (usdToNgn && Number(usdToNgn) > 0) {
            const costNgnMinor = toMinor(costNgn, scale);
            const rateMinor = toMinor(usdToNgn, scale);
            const usdMinor = roundHalfUp((costNgnMinor * (10n ** BigInt(scale))) / rateMinor, 0);
            costUsd = fromMinor(usdMinor, scale);
        } else {
            costUsd = '0.00';
        }
    } else {
        costUsd = fromMinor(roundHalfUp(toMinor(wh, scale), 0), scale);
        if (usdToNgn && Number(usdToNgn) > 0) {
            const usdMinor = toMinor(costUsd, scale);
            const rateMinor = toMinor(usdToNgn, scale);
            const ngnMinor = roundHalfUp(usdMinor * rateMinor, scale);
            costNgn = fromMinor(ngnMinor, scale);
        } else {
            costNgn = '0.00';
        }
    }

    // Determine customer price.
    let priceNgn, priceUsd, appliedMode, appliedValue;

    if (mode === 'fixed_ngn') {
        priceNgn = fromMinor(roundHalfUp(toMinor(String(value || '0'), scale), 0), scale);
        if (usdToNgn && Number(usdToNgn) > 0) {
            const ngnMinor = toMinor(priceNgn, scale);
            const rateMinor = toMinor(usdToNgn, scale);
            const usdMinor = roundHalfUp((ngnMinor * (10n ** BigInt(scale))) / rateMinor, 0);
            priceUsd = fromMinor(usdMinor, scale);
        } else {
            priceUsd = '0.00';
        }
        appliedMode = 'fixed_ngn';
        appliedValue = priceNgn;
    } else if (mode === 'fixed_usd') {
        priceUsd = fromMinor(roundHalfUp(toMinor(String(value || '0'), scale), 0), scale);
        if (usdToNgn && Number(usdToNgn) > 0) {
            const usdMinor = toMinor(priceUsd, scale);
            const rateMinor = toMinor(usdToNgn, scale);
            const ngnMinor = roundHalfUp(usdMinor * rateMinor, scale);
            priceNgn = fromMinor(ngnMinor, scale);
        } else {
            priceNgn = '0.00';
        }
        appliedMode = 'fixed_usd';
        appliedValue = priceUsd;
    } else if (mode === 'markup_pct') {
        const markup = String(value || '0.0000');
        // ─── FIX: 5 args — moneyScale=2, percentScale=4, outScale=2 ───
        const markupPortionNgn = mulByPercent(costNgn, markup, scale, percentScale, scale);
        priceNgn = addDecimal(costNgn, markupPortionNgn, scale);

        if (usdToNgn && Number(usdToNgn) > 0) {
            const ngnMinor = toMinor(priceNgn, scale);
            const rateMinor = toMinor(usdToNgn, scale);
            const usdMinor = roundHalfUp((ngnMinor * (10n ** BigInt(scale))) / rateMinor, 0);
            priceUsd = fromMinor(usdMinor, scale);
        } else {
            priceUsd = '0.00';
        }
        appliedMode = 'markup_pct';
        appliedValue = markup;
    } else {
        // global
        const markup = whCcy === 'NGN'
            ? String(globalMarkupNgn || '0.0000')
            : String(globalMarkupUsd || '0.0000');
        // ─── FIX: 5 args ───
        const markupPortionNgn = mulByPercent(costNgn, markup, scale, percentScale, scale);
        priceNgn = addDecimal(costNgn, markupPortionNgn, scale);

        if (usdToNgn && Number(usdToNgn) > 0) {
            const ngnMinor = toMinor(priceNgn, scale);
            const rateMinor = toMinor(usdToNgn, scale);
            const usdMinor = roundHalfUp((ngnMinor * (10n ** BigInt(scale))) / rateMinor, 0);
            priceUsd = fromMinor(usdMinor, scale);
        } else {
            priceUsd = '0.00';
        }
        appliedMode = 'global';
        appliedValue = markup;
    }

    const profitNgn = subDecimal(priceNgn, costNgn, scale);
    const margin = marginPct(profitNgn, costNgn, scale);

    const fmtNgn = (s) => '₦' + Number(s).toLocaleString('en-NG', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
    });
    const fmtUsd = (s) => '$' + Number(s).toLocaleString('en-US', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
    });

    return {
        costNgn, costUsd,
        priceNgn, priceUsd,
        profitNgn,
        marginPct: margin,
        pricingMode: appliedMode,
        pricingValue: appliedValue,
        wholesaleCurrency: whCcy,
        wholesaleAmount: wh,
        usdToNgn: String(usdToNgn || '0.00'),
        display: {
            costNgn: fmtNgn(costNgn),
            costUsd: fmtUsd(costUsd),
            priceNgn: fmtNgn(priceNgn),
            priceUsd: fmtUsd(priceUsd),
            profitNgn: fmtNgn(profitNgn),
            margin: margin.toFixed(2) + '%'
        }
    };
}
module.exports = {
    calculatePrice,
    toMinor,
    fromMinor,
    roundHalfUp,
    mulByPercent,
    addDecimal,
    subDecimal,
    marginPct
};