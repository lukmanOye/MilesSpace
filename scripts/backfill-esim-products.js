// scripts/backfill-esim-products.js
//
// One-time backfill: import every currently-sellable eSIM plan into
// esim_products with enabled=true, so Batch 4b's switch from "read
// live provider catalog" to "read from esim_products" doesn't blank
// out the customer page.
//
// Safe to run multiple times. Uses ignoreDuplicates so re-runs are
// idempotent and never clobber an admin's custom pricing.
//
// Usage:
//   node scripts/backfill-esim-products.js
//   node scripts/backfill-esim-products.js --dry-run

'use strict';

require('dotenv').config();
const { supabaseAdmin } = require('../db/supabase');
const dtone = require('../services/dtoneService');
const adminSettings = require('../services/adminSettingsService');
const pricingEngine = require('../services/pricingEngine');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
    console.log('[ESIM BACKFILL] starting', DRY_RUN ? '(dry run)' : '');
    console.log('[ESIM BACKFILL] fetching provider catalog…');

    const rows = await dtone.getEsimProducts('GLOBAL', { includeRegionalAndGlobal: true });
    console.log('[ESIM BACKFILL] provider returned', rows.length, 'products');

    const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
    const markupUsd = await adminSettings.getMarkup('esim', 'USD');
    const markupNgn = await adminSettings.getMarkup('esim', 'NGN');

    const upserts = [];
    let skipped = 0;
    for (const r of rows) {
        const wholesaleCurrency = String(r.wholesaleCurrency || 'USD').toUpperCase();
        const wholesaleAmount   = String(r.wholesaleAmount ?? '0.00');
        let priced;
        try {
            priced = pricingEngine.calculatePrice({
                wholesaleAmount,
                wholesaleCurrency,
                usdToNgn:        String(usdToNgn),
                mode:            'global',
                value:           null,
                globalMarkupUsd: String(markupUsd),
                globalMarkupNgn: String(markupNgn)
            });
        } catch (e) {
            skipped++;
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
            wholesale_currency:  wholesaleCurrency,
            pricing_mode:        'global',
            pricing_value:       null,
            customer_price_usd:  priced.priceUsd,
            customer_price_ngn:  priced.priceNgn,
            enabled:             true,
            featured:            false,
            sort_order:          0,
            price_updated_at:    new Date().toISOString(),
            cost_checked_at:     new Date().toISOString()
        });
    }

    console.log(`[ESIM BACKFILL] ${upserts.length} priced, ${skipped} skipped (bad wholesale)`);

    if (DRY_RUN) {
        console.log('[ESIM BACKFILL] dry run — no writes');
        console.log('Sample:', JSON.stringify(upserts[0], null, 2));
        process.exit(0);
    }

    const BATCH = 100;
    let inserted = 0, conflicted = 0;
    for (let i = 0; i < upserts.length; i += BATCH) {
        const batch = upserts.slice(i, i + BATCH);
        const { data, error } = await supabaseAdmin
            .from('esim_products')
            .upsert(batch, { onConflict: 'provider,provider_product_id', ignoreDuplicates: true })
            .select('id');
        if (error) {
            console.error('[ESIM BACKFILL] batch error:', error.message);
            continue;
        }
        inserted += (data || []).length;
        conflicted += batch.length - (data || []).length;
    }

    console.log(`[ESIM BACKFILL] inserted ${inserted} new, ${conflicted} already existed`);
    console.log('[ESIM BACKFILL] done');
    process.exit(0);
}

main().catch((e) => {
    console.error('[ESIM BACKFILL] fatal:', e);
    process.exit(1);
});