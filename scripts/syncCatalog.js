// scripts/syncCatalog.js
//
// One-shot CLI: pull the ENTIRE DT One catalog for a service and
// upsert into gift_card_products or esim_products, keyed by
// (provider, provider_env, provider_product_id).
//
// Usage:
//   node scripts/syncCatalog.js giftcard --enable
//   node scripts/syncCatalog.js esim --enable
//   node scripts/syncCatalog.js giftcard          # import, do NOT enable
//
// Rules:
//   • If the provider fetch was truncated, do NOT disable missing rows.
//   • New rows default to enabled=false unless --enable is passed.
//   • pricing_mode defaults to 'global'.
//   • Logs: fetched, upserted, newly-seen, disabled, rejected-by-reason.

require('dotenv').config();
const { supabaseAdmin } = require('../db/supabase');
const dtoneService = require('../services/dtoneService');

const PROVIDER_ENV = String(process.env.DTONE_ENV || '').toLowerCase() === 'production'
    ? 'production'
    : 'preprod';

const args = process.argv.slice(2);
const service = String(args[0] || '').toLowerCase();
const shouldEnable = args.includes('--enable');

if (!['giftcard', 'esim'].includes(service)) {
    console.error('Usage: node scripts/syncCatalog.js <giftcard|esim> [--enable]');
    process.exit(1);
}

async function syncGiftCards() {
    console.log(`[sync] giftcard — env=${PROVIDER_ENV} enable=${shouldEnable}`);
    const result = await dtoneService.getGiftCardProducts(null, {
        productType: 'FIXED_VALUE_PIN_PURCHASE',
        maxPages: 100,
        maxTotalMs: 120000,
        requestTimeoutMs: 15000,
        requireComplete: true
    });

    const rows = Array.isArray(result?.products) ? result.products : [];
    const truncated = Boolean(result?.truncated);
    const truncationReason = result?.truncationReason || null;

    console.log(`[sync] fetched ${rows.length} products; truncated=${truncated}`);

    // Upsert in batches.
    const BATCH = 100;
    let upserted = 0;
    let newlySeen = 0;
    let disabled = 0;
    const rejections = { no_id: 0, no_name: 0, no_cost: 0 };

    // Snapshot of existing ids so we can measure "newly seen".
    const { data: existingRows } = await supabaseAdmin
        .from('gift_card_products')
        .select('provider_product_id')
        .eq('provider', 'dtone')
        .eq('provider_env', PROVIDER_ENV);
    const existingIds = new Set((existingRows || []).map(r => String(r.provider_product_id)));

    const fetchedIds = new Set();

    for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const upserts = [];

        for (const p of chunk) {
            const pid = String(p.productId || '');
            if (!pid) { rejections.no_id++; continue; }
            if (!p.name) { rejections.no_name++; continue; }
            const wholesaleAmount = Number(p.wholesaleAmount);
            if (!Number.isFinite(wholesaleAmount) || wholesaleAmount <= 0) {
                rejections.no_cost++;
                continue;
            }
            fetchedIds.add(pid);
            if (!existingIds.has(pid)) newlySeen++;

            upserts.push({
                provider: 'dtone',
                provider_env: PROVIDER_ENV,
                provider_product_id: pid,
                brand: p.name,
                display_name: null,
                country_iso: p.countryIso || null,
                country_name: p.countryName || null,
                face_value: p.faceValue ?? null,
                face_currency: p.currency || 'USD',
                wholesale_amount: String(p.wholesaleAmount),
                wholesale_currency: String(p.wholesaleCurrency || 'USD').toUpperCase(),
                pricing_mode: 'global',
                enabled: shouldEnable,
                available: true,
                last_synced_at: new Date().toISOString()
            });
        }

        if (!upserts.length) continue;

        const { data: up, error } = await supabaseAdmin
            .from('gift_card_products')
            .upsert(upserts, {
                onConflict: 'provider,provider_env,provider_product_id',
                ignoreDuplicates: false
            })
            .select('id');

        if (error) {
            console.error('[sync] giftcard upsert failed:', error.message);
            continue;
        }
        upserted += (up || []).length;
    }

    // Disable rows that disappeared — ONLY if the fetch was NOT truncated.
    if (!truncated) {
        const toDisable = [...existingIds].filter(id => !fetchedIds.has(id));
        if (toDisable.length) {
            const { data: dis, error } = await supabaseAdmin
                .from('gift_card_products')
                .update({ enabled: false, available: false, updated_at: new Date().toISOString() })
                .eq('provider', 'dtone')
                .eq('provider_env', PROVIDER_ENV)
                .in('provider_product_id', toDisable)
                .select('id');
            if (!error) disabled = (dis || []).length;
        }
    } else {
        console.warn('[sync] WARNING: fetch truncated — NOT disabling missing rows');
        console.warn('[sync] truncation reason:', truncationReason);
    }

    console.log(`[sync] done — upserted=${upserted} newlySeen=${newlySeen} disabled=${disabled}`);
    console.log('[sync] rejections:', rejections);
}

async function syncEsim() {
    console.log(`[sync] esim — env=${PROVIDER_ENV} enable=${shouldEnable}`);

    // Fetch all plans: global + regional + every country.
    // getEsimProducts('GLOBAL', {includeRegionalAndGlobal:true}) returns
    // only global+regional rows. For country rows we call it once per
    // distinct operator.country.iso_code from the global response, plus
    // a full unfiltered scan via /products directly.
    const rawAll = await dtoneService.getAllPages('/products', {
        service_id: '13'
    }, {
        dedupeKey: 'id',
        maxPages: 100,
        maxTotalMs: 120000,
        requestTimeoutMs: 15000,
        requireComplete: true
    });

    const items = Array.isArray(rawAll?.items) ? rawAll.items : (Array.isArray(rawAll) ? rawAll : []);
    const truncated = Boolean(rawAll?.truncated);

    console.log(`[sync] fetched ${items.length} raw esim products; truncated=${truncated}`);

    const described = items
        .map(p => {
            try { return dtoneService._describeEsimProduct(p); }
            catch { return null; }
        })
        .filter(Boolean);

    const BATCH = 100;
    let upserted = 0;
    let newlySeen = 0;
    let disabled = 0;
    const rejections = { no_id: 0, no_cost: 0 };

    const { data: existingRows } = await supabaseAdmin
        .from('esim_products')
        .select('provider_product_id')
        .eq('provider', 'dtone')
        .eq('provider_env', PROVIDER_ENV);
    const existingIds = new Set((existingRows || []).map(r => String(r.provider_product_id)));
    const fetchedIds = new Set();

    for (let i = 0; i < described.length; i += BATCH) {
        const chunk = described.slice(i, i + BATCH);
        const upserts = [];

        for (const p of chunk) {
            const pid = String(p.productId || '');
            if (!pid) { rejections.no_id++; continue; }
            const wholesaleAmount = Number(p.wholesaleAmount);
            if (!Number.isFinite(wholesaleAmount) || wholesaleAmount <= 0) {
                rejections.no_cost++;
                continue;
            }
            fetchedIds.add(pid);
            if (!existingIds.has(pid)) newlySeen++;

            const countryIso3 = (p.coverageRegions || [])
                .map(r => String(r.code || '').toUpperCase())
                .find(c => /^[A-Z]{3}$/.test(c)) || null;

            upserts.push({
                provider: 'dtone',
                provider_env: PROVIDER_ENV,
                provider_product_id: pid,
                name: p.planName,
                display_name: null,
                logo_url: null,
                coverage_type: p.coverageType,
                regions: p.coverageRegions || [],
                country_iso3: p.coverageType === 'country' ? countryIso3 : null,
                data_mb: p.dataMb || null,
                validity_days: p.validityDays || null,
                wholesale_amount: String(p.wholesaleAmount),
                wholesale_currency: String(p.wholesaleCurrency || 'USD').toUpperCase(),
                pricing_mode: 'global',
                enabled: shouldEnable,
                available: true,
                last_synced_at: new Date().toISOString()
            });
        }

        if (!upserts.length) continue;

        const { data: up, error } = await supabaseAdmin
            .from('esim_products')
            .upsert(upserts, {
                onConflict: 'provider,provider_env,provider_product_id',
                ignoreDuplicates: false
            })
            .select('id');

        if (error) {
            console.error('[sync] esim upsert failed:', error.message);
            continue;
        }
        upserted += (up || []).length;
    }

    if (!truncated) {
        const toDisable = [...existingIds].filter(id => !fetchedIds.has(id));
        if (toDisable.length) {
            const { data: dis, error } = await supabaseAdmin
                .from('esim_products')
                .update({ enabled: false, available: false, updated_at: new Date().toISOString() })
                .eq('provider', 'dtone')
                .eq('provider_env', PROVIDER_ENV)
                .in('provider_product_id', toDisable)
                .select('id');
            if (!error) disabled = (dis || []).length;
        }
    } else {
        console.warn('[sync] WARNING: fetch truncated — NOT disabling missing rows');
    }

    console.log(`[sync] done — upserted=${upserted} newlySeen=${newlySeen} disabled=${disabled}`);
    console.log('[sync] rejections:', rejections);
}

(async () => {
    try {
        if (service === 'giftcard') await syncGiftCards();
        else await syncEsim();
        process.exit(0);
    } catch (e) {
        console.error('[sync] fatal:', e.message);
        process.exit(1);
    }
})();