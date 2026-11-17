// scripts/test-pricing.js
'use strict';
const { calculatePrice } = require('../services/pricingEngine');

const cases = [
    // [name, wholesaleAmount, wholesaleCurrency, mode, value, usdToNgn, expectedPriceNgn, expectedProfit]
    ['10% markup on 10000 NGN', '10000.00', 'NGN', 'markup_pct', '0.1000', '1600.00', '11000.00', '1000.00'],
    ['15.7% markup on 10000 NGN', '10000.00', 'NGN', 'markup_pct', '0.1570', '1600.00', '11570.00', '1570.00'],
    ['global 10% on 10000 NGN', '10000.00', 'NGN', 'global', null, '1600.00', '11000.00', '1000.00'],
    ['fixed_ngn 12500', '10000.00', 'NGN', 'fixed_ngn', '12500.00', '1600.00', '12500.00', '2500.00'],
    ['global 10% on 100 USD', '100.00', 'USD', 'global', null, '1600.00', '176000.00', '16000.00'],
    ['fixed_usd 120 USD', '100.00', 'USD', 'fixed_usd', '120.00', '1600.00', '192000.00', '32000.00'],
];

let pass = 0, fail = 0;
for (const [name, wh, cur, mode, value, fx, wantPrice, wantProfit] of cases) {
    const r = calculatePrice({
        wholesaleAmount: wh,
        wholesaleCurrency: cur,
        usdToNgn: fx,
        mode,
        value,
        globalMarkupUsd: '0.1000',
        globalMarkupNgn: '0.1000'
    });
    const okPrice = r.priceNgn === wantPrice;
    const okProfit = r.profitNgn === wantProfit;
    if (okPrice && okProfit) {
        console.log(`PASS  ${name}  →  ${r.priceNgn} NGN (profit ${r.profitNgn})`);
        pass++;
    } else {
        console.error(`FAIL  ${name}`);
        console.error(`      expected priceNgn=${wantPrice} profitNgn=${wantProfit}`);
        console.error(`      got      priceNgn=${r.priceNgn} profitNgn=${r.profitNgn}`);
        fail++;
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);