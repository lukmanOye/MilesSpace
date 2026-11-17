// scripts/seed-fake-esim-products.js
//
// One-off test seed for the preprod environment. DT One's preprod
// catalog is empty by design, so we insert a few fake esim_products
// rows to exercise the admin UI, pricing, and purchase flow without
// hitting production DT One.
//
// Runs against whatever DTONE_ENV is set. Do NOT run in production.
//
// Cleanup when you switch to production:
//   DELETE FROM esim_products WHERE provider_product_id LIKE '999%';

'use strict';

require('dotenv').config();

const { supabaseAdmin } = require('../db/supabase');
const pricingEngine = require('../services/pricingEngine');
const adminSettings = require('../services/adminSettingsService');

if (String(process.env.DTONE_ENV || '').toLowerCase() === 'production') {
    console.error('[SEED] refusing to run in production');
    console.error('[SEED] set DTONE_ENV=preprod in .env, or delete this guard deliberately');
    process.exit(1);
}

async function main() {
    const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
    const markupUsd = await adminSettings.getMarkup('esim', 'USD');
    const markupNgn = await adminSettings.getMarkup('esim', 'NGN');

    console.log('[SEED] usdToNgn:', usdToNgn, 'markupUsd:', markupUsd, 'markupNgn:', markupNgn);

    const fakes = [
        {
            pid: '999001',
            name: 'USA · 1 GB · 7 days',
            coverageType: 'country',
            regions: [{ code: 'USA', name: 'United States' }],
            countryIso3: 'USA',
            countryName: 'United States',
            dataMb: 1024,
            days: 7,
            wholesale: '5.00'
        },
        {
            pid: '999002',
            name: 'USA · 3 GB · 30 days',
            coverageType: 'country',
            regions: [{ code: 'USA', name: 'United States' }],
            countryIso3: 'USA',
            countryName: 'United States',
            dataMb: 3072,
            days: 30,
            wholesale: '15.00'
        },
        {
            pid: '999003',
            name: 'Global · 5 GB · 30 days',
            coverageType: 'global',
            regions: [{ code: 'WWW', name: 'Global' }],
            countryIso3: null,
            countryName: 'Global',
            dataMb: 5120,
            days: 30,
            wholesale: '25.00'
        }
    ];

    let inserted = 0;
    let updated = 0;
    let errored = 0;

    for (const f of fakes) {
        let priced;
        try {
            priced = pricingEngine.calculatePrice({
                wholesaleAmount:   f.wholesale,
                wholesaleCurrency: 'USD',
                usdToNgn:          String(usdToNgn),
                mode:              'global',
                value:             null,
                globalMarkupUsd:   String(markupUsd),
                globalMarkupNgn:   String(markupNgn)
            });
        } catch (e) {
            console.error('[SEED] price failed for', f.pid, e.message);
            errored++;
            continue;
        }

        // Check if row already exists so we can report insert-vs-update.
        const { data: existing } = await supabaseAdmin
            .from('esim_products')
            .select('id')
            .eq('provider', 'dtone')
            .eq('provider_product_id', f.pid)
            .maybeSingle();

        const { error } = await supabaseAdmin.from('esim_products').upsert({
            provider:            'dtone',
            provider_product_id: f.pid,
            name:                f.name,
            display_name:        f.name,
            logo_url:            null,
            coverage_type:       f.coverageType,
            regions:             f.regions,
            data_mb:             f.dataMb,
            validity_days:       f.days,
            wholesale_amount:    f.wholesale,
            wholesale_currency:  'USD',
            pricing_mode:        'global',
            pricing_value:       null,
            customer_price_usd:  priced.priceUsd,
            customer_price_ngn:  priced.priceNgn,
            min_margin_pct:      null,
            enabled:             true,
            featured:            f.pid === '999001',   // one featured sample
            sort_order:          0,
            price_updated_at:    new Date().toISOString(),
            cost_checked_at:     new Date().toISOString()
        }, { onConflict: 'provider,provider_product_id' });

        if (error) {
            console.error('[SEED] failed for', f.pid, ':', error.message);
            errored++;
            continue;
        }

        if (existing) updated++; else inserted++;
        console.log(
            `[SEED] ${existing ? 'updated' : 'inserted'} ${f.pid}  ${f.name}  ` +
            `→ NGN ${priced.priceNgn}, USD ${priced.priceUsd}, margin ${priced.marginPct}%`
        );
    }

    console.log(`\n[SEED] done — inserted ${inserted}, updated ${updated}, errored ${errored}`);
    process.exit(errored > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error('[SEED] fatal:', e);
    process.exit(1);
});