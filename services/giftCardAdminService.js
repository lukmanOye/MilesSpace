// services/giftCardAdminService.js
// ─────────────────────────────────────────────────────────────────
// Admin operations for gift cards: catalog browse, import, pricing,
// cost refresh. All pricing flows through services/pricingEngine so
// the admin preview, product row, and customer charge are guaranteed
// identical.
//
// Conventions:
//   • Money and percent are decimal strings. No Number(), no
//     parseFloat, no floating-point math on money or percent.
//   • Every state change is audited via orderLifecycle.recordAudit.
//   • Optimistic concurrency on every pricing write using
//     price_updated_at as the version token.
//   • Route layer never touches the DB. This service is the boundary.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const adminSettings = require('./adminSettingsService');
const pricingEngine = require('./pricingEngine');
const dtoneService = require('./dtoneService');

// ─── Constants ──────────────────────────────────────────────────
const VALID_MODES = new Set(['global', 'markup_pct', 'fixed_ngn', 'fixed_usd']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PRICING_PERMISSION = adminSettings.PROVIDER_REGISTRY ? 'settings.manage' : null; // for documentation only
const IMPORT_BATCH_SIZE = 100;
const REFRESH_BATCH_SIZE = 25;

// ─── Errors ─────────────────────────────────────────────────────
function svcErr(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    Object.assign(e, extra);
    return e;
}

// ─── Helpers ────────────────────────────────────────────────────
function isUuid(v) {
    return typeof v === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function clampInt(v, def, max) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1) return def;
    return Math.min(n, max);
}

function isValidDecimal(s) {
    return typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s);
}

// Normalize a decimal string to a fixed scale, no floats.
function normalizeDecimal(s, scale) {
    if (!isValidDecimal(String(s))) {
        throw svcErr('INVALID_DECIMAL', `Not a valid decimal: ${s}`, 422);
    }
    const neg = String(s).startsWith('-');
    const body = neg ? String(s).slice(1) : String(s);
    const [intPart = '0', frac = ''] = body.split('.');
    const padded = (frac + '0'.repeat(scale)).slice(0, scale);
    return (neg ? '-' : '') + (intPart || '0') + (scale > 0 ? '.' + padded : '');
}

// ─── Pricing resolution — the ONLY place customer price is computed ──

/**
 * Given a product row from gift_card_products, resolve the customer
 * price under its own pricing_mode/pricing_value, falling back to
 * the current global rules if mode is 'global' or missing.
 *
 * Also pulls the current admin global markups and FX once per call.
 * Returns the exact shape that pricingEngine.calculatePrice returns
 * plus a `fromCache` flag for the routes to expose to the admin UI.
 */
async function resolveProductPricing(product) {
    if (!product) throw svcErr('PRODUCT_NOT_FOUND', 'Product not found.', 404);

    const usdToNgn     = await adminSettings.getRate('USD', 'NGN');
    const markupUsd    = await adminSettings.getMarkup('giftcard', 'USD');
    const markupNgn    = await adminSettings.getMarkup('giftcard', 'NGN');

    const mode  = VALID_MODES.has(product.pricing_mode) ? product.pricing_mode : 'global';
    const value = product.pricing_value != null ? String(product.pricing_value) : null;

    const result = pricingEngine.calculatePrice({
        wholesaleAmount:   String(product.wholesale_amount ?? '0.00'),
        wholesaleCurrency: String(product.wholesale_currency || 'USD').toUpperCase(),
        usdToNgn:          String(usdToNgn),
        mode,
        value,
        globalMarkupUsd:   String(markupUsd),
        globalMarkupNgn:   String(markupNgn)
    });

    return {
        ...result,
        fromCache: false,
        productId: product.id,
        providerProductId: product.provider_product_id
    };
}

/**
 * Assert price is above the provider cost, optionally enforcing a
 * minimum margin. Called from the updateProductPricing path.
 */
function assertPriceAboveCost({ priceNgn, wholesaleNgn, minMarginPct, allowBelowCost }) {
    const price = normalizeDecimal(priceNgn, 2);
    const cost  = normalizeDecimal(wholesaleNgn, 2);

    // Compare via BigInt so no float rounding sneaks in.
    const priceBig = BigInt(price.replace('.', ''));
    const costBig  = BigInt(cost.replace('.', ''));

    if (priceBig < costBig && !allowBelowCost) {
        throw svcErr('PRICING_BELOW_COST',
            'Price is below provider cost. Pass allow_below_cost:true to override.',
            422,
            { price, cost }
        );
    }

    if (minMarginPct != null) {
        // margin% = (price - cost) / cost * 100
        const minPct = normalizeDecimal(String(minMarginPct), 4);
        const minBig = BigInt(minPct.replace('.', ''));
        // (price - cost) * 10000 >= cost * minPct * 100
        // Rewritten as BigInt to avoid division:
        const diff = priceBig - costBig;
        if (diff < 0n) {
            throw svcErr('PRICING_BELOW_MIN_MARGIN',
                `Price yields a negative margin (below cost).`,
                422,
                { price, cost, minMarginPct: String(minMarginPct) }
            );
        }
        const lhs = diff * 10000n;      // percent * 100 * price-scale cancels
        const rhs = costBig * minBig;   // cost * minPct * 100
        if (lhs < rhs) {
            throw svcErr('PRICING_BELOW_MIN_MARGIN',
                `Price yields a margin below the minimum of ${minMarginPct}%.`,
                422,
                { price, cost, minMarginPct: String(minMarginPct) }
            );
        }
    }
}

// ─── Catalog ────────────────────────────────────────────────────

/**
 * Browse the provider catalog. Returns each row with wholesale
 * numbers, an `already_imported` flag, and a `suggested_price_ngn`
 * computed under the current global rules.
 *
 * Tolerates a truncated catalog: the response includes `truncated`
 * and `truncation_reason` when the provider paginated past our
 * budget.
 */
async function getCatalog({ country = null, subservice = null, search = null, page = 1, limit = DEFAULT_LIMIT } = {}) {
    const safeLimit = clampInt(limit, DEFAULT_LIMIT, MAX_LIMIT);
    const safePage  = clampInt(page, 1, 10000);
    const offset    = (safePage - 1) * safeLimit;

    const countryIso = country ? String(country).toUpperCase() : null;
    if (countryIso && !/^[A-Z]{3}$/.test(countryIso)) {
        throw svcErr('INVALID_COUNTRY', 'country must be a 3-letter ISO code.', 422);
    }

    // Fetch provider catalog (single source of truth for wholesale).
    const providerResult = await dtoneService.getGiftCardProducts(countryIso, {
        subserviceKey: subservice || null,
        productType: 'FIXED_VALUE_PIN_PURCHASE',
        maxPages: 20,
        maxTotalMs: 30000,
        requestTimeoutMs: 10000,
        requireComplete: true
    });

    const truncated        = Boolean(providerResult?.truncated);
    const truncationReason = providerResult?.truncationReason || null;
    const rows = Array.isArray(providerResult?.products) ? providerResult.products : [];

    // Load current admin pricing rules once.
    const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
    const markupUsd = await adminSettings.getMarkup('giftcard', 'USD');
    const markupNgn = await adminSettings.getMarkup('giftcard', 'NGN');

    // Look up already-imported rows in one query.
    const providerIds = rows.map(r => String(r.productId)).filter(Boolean);
    let importedByProviderId = {};
    if (providerIds.length) {
        const { data: imported } = await supabaseAdmin
            .from('gift_card_products')
            .select('id, provider_product_id')
            .eq('provider', 'dtone')
            .in('provider_product_id', providerIds);
        for (const p of imported || []) importedByProviderId[String(p.provider_product_id)] = p.id;
    }

    // Shape + suggest price.
    const shaped = rows.map(r => {
        const wholesaleCurrency = String(r.wholesaleCurrency || 'USD').toUpperCase();
        const wholesaleAmount   = String(r.wholesaleAmount ?? '0.00');
        let suggested;
        try {
            suggested = pricingEngine.calculatePrice({
                wholesaleAmount,
                wholesaleCurrency,
                usdToNgn:        String(usdToNgn),
                mode:            'global',
                value:           null,
                globalMarkupUsd: String(markupUsd),
                globalMarkupNgn: String(markupNgn)
            });
        } catch (e) {
            suggested = null;
        }

        return {
            providerProductId: String(r.productId),
            name:              r.name,
            description:       r.description || null,
            faceValue:         r.faceValue,
            faceCurrency:      r.currency,
            countryIso:        r.countryIso || null,
            countryIso2:       r.countryIso2 || null,
            countryName:       r.countryName || null,
            wholesaleAmount,
            wholesaleCurrency,
            alreadyImported:   Boolean(importedByProviderId[String(r.productId)]),
            importedProductId: importedByProviderId[String(r.productId)] || null,
            suggestedPriceNgn: suggested?.priceNgn || null,
            suggestedPriceUsd: suggested?.priceUsd || null,
            suggestedMargin:   suggested?.marginPct || null
        };
    });

    // Optional search and paginate in Node (provider catalog is small
    // enough that filtering here keeps the code simple and consistent).
    let filtered = shaped;
    if (search) {
        const q = String(search).toLowerCase().trim();
        filtered = filtered.filter(r =>
            (r.name || '').toLowerCase().includes(q) ||
            (r.countryName || '').toLowerCase().includes(q)
        );
    }

    const total = filtered.length;
    const page_ = filtered.slice(offset, offset + safeLimit);

    return {
        products: page_,
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit) || 1,
        truncated,
        truncationReason
    };
}

// ─── Import ─────────────────────────────────────────────────────

/**
 * Import one or more provider products into gift_card_products.
 * Idempotent: upserts on (provider, provider_product_id) and never
 * overwrites an existing row's pricing fields.
 */
async function importProducts({ providerProductIds, enable = false, reason }, ctx) {
    if (!Array.isArray(providerProductIds) || !providerProductIds.length) {
        throw svcErr('IMPORT_EMPTY', 'No provider_product_ids provided.', 422);
    }
    if (!reason || String(reason).trim().length < 4) {
        throw svcErr('REASON_REQUIRED', 'A reason is required to import products.', 422);
    }

    // Fetch the full provider catalog once to look up each id.
    const providerResult = await dtoneService.getGiftCardProducts(null, {
        productType: 'FIXED_VALUE_PIN_PURCHASE',
        maxPages: 20,
        maxTotalMs: 30000,
        requestTimeoutMs: 10000,
        requireComplete: true
    });
    const rows = Array.isArray(providerResult?.products) ? providerResult.products : [];
    const byId = new Map(rows.map(r => [String(r.productId), r]));

    // Load current admin pricing config once.
    const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
    const markupUsd = await adminSettings.getMarkup('giftcard', 'USD');
    const markupNgn = await adminSettings.getMarkup('giftcard', 'NGN');

    const results = { imported: [], skipped: [], errors: [] };

    // Batch into IMPORT_BATCH_SIZE to keep each upsert small.
    for (let i = 0; i < providerProductIds.length; i += IMPORT_BATCH_SIZE) {
        const batchIds = providerProductIds.slice(i, i + IMPORT_BATCH_SIZE);

        const upserts = [];
        for (const id of batchIds) {
            const r = byId.get(String(id));
            if (!r) {
                results.skipped.push({ providerProductId: String(id), reason: 'NOT_IN_CATALOG' });
                continue;
            }

            let suggested;
            try {
                suggested = pricingEngine.calculatePrice({
                    wholesaleAmount:   String(r.wholesaleAmount ?? '0.00'),
                    wholesaleCurrency: String(r.wholesaleCurrency || 'USD').toUpperCase(),
                    usdToNgn:          String(usdToNgn),
                    mode:              'global',
                    value:             null,
                    globalMarkupUsd:   String(markupUsd),
                    globalMarkupNgn:   String(markupNgn)
                });
            } catch (e) {
                results.errors.push({ providerProductId: String(id), reason: 'PRICE_CALC_FAILED', error: e.message });
                continue;
            }

            upserts.push({
                provider:            'dtone',
                provider_product_id: String(r.productId),
                brand:               r.name,                     // legacy column name
                display_name:        null,
                logo_url:            null,
                country_iso:         r.countryIso || null,
                country_name:        r.countryName || null,
                face_value:          r.faceValue,
                face_currency:       r.currency || 'USD',
                wholesale_amount:    r.wholesaleAmount,
                wholesale_currency:  String(r.wholesaleCurrency || 'USD').toUpperCase(),
                pricing_mode:        'global',
                pricing_value:       null,
                customer_price_ngn:  suggested.priceNgn,
                customer_price_usd:  suggested.priceUsd,
                enabled:             Boolean(enable),
                featured:            false,
                sort_order:          0,
                price_updated_at:    new Date().toISOString(),
                cost_checked_at:     new Date().toISOString()
            });
        }

        if (!upserts.length) continue;

        const { data, error } = await supabaseAdmin
            .from('gift_card_products')
            .upsert(upserts, {
                onConflict: 'provider,provider_product_id',
                ignoreDuplicates: true    // do NOT clobber pricing on re-import
            })
            .select('id, provider_product_id, brand, enabled');

        if (error) {
            results.errors.push({ batch: i, reason: 'UPSERT_FAILED', error: error.message });
            continue;
        }

        for (const row of data || []) {
            results.imported.push({
                id: row.id,
                providerProductId: row.provider_product_id,
                name: row.brand,
                enabled: row.enabled
            });
        }
    }

    // Audit once per import operation, not per row.
    try {
        const orderLifecycle = require('./orderLifecycle');
        await orderLifecycle.recordAudit({
            ctx,
            table: 'gift_card_products',
            action: 'gift_card.products.imported',
            targetId: null,
            before: null,
            after: {
                importedCount: results.imported.length,
                skippedCount:  results.skipped.length,
                errorCount:    results.errors.length,
                enable:        Boolean(enable)
            },
            reason
        });
    } catch (auditErr) {
        // Import is a data operation, not a money operation — log but
        // do not fail.
        console.error('[GIFT CARD IMPORT] audit failed:', auditErr.message);
    }

    return results;
}

// ─── Update product pricing ────────────────────────────────────

/**
 * Update the pricing mode/value for a single product.
 * Enforces:
 *   • Valid mode
 *   • Margin guard unless allow_below_cost:true
 *   • Optimistic concurrency via expected_updated_at
 */
async function updateProductPricing({
    productId,
    mode,
    value,
    reason,
    expectedUpdatedAt,
    allowBelowCost = false
}, ctx) {
    if (!isUuid(productId)) throw svcErr('INVALID_ID', 'Invalid product id.', 400);
    if (!VALID_MODES.has(mode)) {
        throw svcErr('PRICING_INVALID_MODE', `Mode must be one of: ${[...VALID_MODES].join(', ')}`, 422);
    }
    if (!reason || String(reason).trim().length < 4) {
        throw svcErr('REASON_REQUIRED', 'A reason is required to change pricing.', 422);
    }

    // Mode-specific value validation.
    let normalizedValue = null;
    if (mode === 'markup_pct') {
        if (!isValidDecimal(String(value))) {
            throw svcErr('PRICING_INVALID_VALUE', 'markup_pct value must be a decimal like "0.1000".', 422);
        }
        normalizedValue = normalizeDecimal(String(value), 6);
        // Reject the classic 0.10 vs 10 mistake.
        if (BigInt(normalizedValue.replace('.', '')) >= 1000000n && allowBelowCost !== true) {
            throw svcErr('PRICING_INVALID_VALUE',
                'markup_pct must be a fraction (0.1000 = 10%), not a percentage (10.0000).',
                422,
                { value: normalizedValue }
            );
        }
    } else if (mode === 'fixed_ngn' || mode === 'fixed_usd') {
        if (!isValidDecimal(String(value))) {
            throw svcErr('PRICING_INVALID_VALUE', `${mode} value must be a decimal string.`, 422);
        }
        normalizedValue = normalizeDecimal(String(value), 2);
    }
    // global mode ignores `value`.

    // Load product.
    const { data: product, error: loadErr } = await supabaseAdmin
        .from('gift_card_products')
        .select('id, provider_product_id, brand, country_name, wholesale_amount, wholesale_currency, pricing_mode, pricing_value, customer_price_ngn, customer_price_usd, enabled, price_updated_at, min_margin_pct')
        .eq('id', productId)
        .maybeSingle();

    if (loadErr) throw svcErr('DB_ERROR', loadErr.message, 500);
    if (!product)  throw svcErr('PRODUCT_NOT_FOUND', 'Product not found.', 404);

    // Optimistic concurrency.
    if (expectedUpdatedAt) {
        if (!product.price_updated_at || String(product.price_updated_at) !== String(expectedUpdatedAt)) {
            throw svcErr('OPTIMISTIC_LOCK_FAILED',
                'Product was modified by another admin. Reload and retry.',
                409,
                { current_updated_at: product.price_updated_at }
            );
        }
    }

    // Compute the proposed price to run the margin guard.
    const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
    const markupUsd = await adminSettings.getMarkup('giftcard', 'USD');
    const markupNgn = await adminSettings.getMarkup('giftcard', 'NGN');

    const proposed = pricingEngine.calculatePrice({
        wholesaleAmount:   String(product.wholesale_amount ?? '0.00'),
        wholesaleCurrency: String(product.wholesale_currency || 'USD').toUpperCase(),
        usdToNgn:          String(usdToNgn),
        mode,
        value:             normalizedValue,
        globalMarkupUsd:   String(markupUsd),
        globalMarkupNgn:   String(markupNgn)
    });

    // Margin guard. min_margin_pct is per-product; the platform-wide
    // default is undefined and means "no minimum beyond below-cost".
    assertPriceAboveCost({
        priceNgn:    proposed.priceNgn,
        wholesaleNgn: proposed.costNgn,
        minMarginPct: product.min_margin_pct,
        allowBelowCost: Boolean(allowBelowCost)
    });

    // Write. The .eq('price_updated_at', ...) makes this an atomic
    // compare-and-set even under race, so two admins cannot both
    // write past the check above.
    const nowIso = new Date().toISOString();
    let updateQ = supabaseAdmin
        .from('gift_card_products')
        .update({
            pricing_mode:       mode,
            pricing_value:      normalizedValue,
            customer_price_ngn: proposed.priceNgn,
            customer_price_usd: proposed.priceUsd,
            price_updated_at:   nowIso
        })
        .eq('id', productId);

    if (expectedUpdatedAt) {
        updateQ = updateQ.eq('price_updated_at', expectedUpdatedAt);
    }

    const { data: updated, error: updateErr } = await updateQ.select('*').maybeSingle();

    if (updateErr) throw svcErr('DB_ERROR', updateErr.message, 500);
    if (!updated)  throw svcErr('OPTIMISTIC_LOCK_FAILED',
        'Product was modified by another admin. Reload and retry.',
        409);

    // Audit.
    const orderLifecycle = require('./orderLifecycle');
    await orderLifecycle.recordAudit({
        ctx,
        table: 'gift_card_products',
        action: 'gift_card.product.pricing_changed',
        targetId: productId,
        before: {
            pricing_mode:       product.pricing_mode,
            pricing_value:      product.pricing_value,
            customer_price_ngn: product.customer_price_ngn,
            customer_price_usd: product.customer_price_usd
        },
        after: {
            pricing_mode:       mode,
            pricing_value:      normalizedValue,
            customer_price_ngn: proposed.priceNgn,
            customer_price_usd: proposed.priceUsd
        },
        reason
    });

    return {
        product: {
            id:                 updated.id,
            providerProductId:  updated.provider_product_id,
            name:               updated.brand,
            pricingMode:        updated.pricing_mode,
            pricingValue:       updated.pricing_value,
            customerPriceNgn:   updated.customer_price_ngn,
            customerPriceUsd:   updated.customer_price_usd,
            priceUpdatedAt:     updated.price_updated_at
        },
        pricing: proposed
    };
}

// ─── Update product metadata ────────────────────────────────────

/**
 * Update display fields. Does NOT touch pricing.
 */
async function updateProduct({ productId, displayName, logoUrl, featured, sortOrder }, ctx) {
    if (!isUuid(productId)) throw svcErr('INVALID_ID', 'Invalid product id.', 400);

    const patch = {};
    if (displayName !== undefined) {
        const s = String(displayName || '').trim();
        if (s.length > 200) throw svcErr('VALIDATION_ERROR', 'display_name must be ≤ 200 chars.', 422);
        patch.display_name = s || null;
    }
    if (logoUrl !== undefined) {
        const s = String(logoUrl || '').trim();
        if (s && !/^https:\/\//i.test(s)) {
            throw svcErr('VALIDATION_ERROR', 'logo_url must be https://', 422);
        }
        patch.logo_url = s || null;
    }
    if (featured !== undefined)     patch.featured   = Boolean(featured);
    if (sortOrder !== undefined) {
        const n = parseInt(sortOrder, 10);
        if (!Number.isFinite(n) || n < -10000 || n > 10000) {
            throw svcErr('VALIDATION_ERROR', 'sort_order out of range.', 422);
        }
        patch.sort_order = n;
    }
    if (!Object.keys(patch).length) {
        throw svcErr('VALIDATION_ERROR', 'No fields to update.', 422);
    }

    const { data: before } = await supabaseAdmin
        .from('gift_card_products')
        .select('id, display_name, logo_url, featured, sort_order')
        .eq('id', productId)
        .maybeSingle();
    if (!before) throw svcErr('PRODUCT_NOT_FOUND', 'Product not found.', 404);

    const { data: updated, error } = await supabaseAdmin
        .from('gift_card_products')
        .update(patch)
        .eq('id', productId)
        .select('*')
        .maybeSingle();

    if (error)    throw svcErr('DB_ERROR', error.message, 500);
    if (!updated) throw svcErr('PRODUCT_NOT_FOUND', 'Product not found.', 404);

    const orderLifecycle = require('./orderLifecycle');
    await orderLifecycle.recordAudit({
        ctx,
        table: 'gift_card_products',
        action: 'gift_card.product.updated',
        targetId: productId,
        before,
        after: patch,
        reason: null
    });

    return {
        id:          updated.id,
        displayName: updated.display_name,
        logoUrl:     updated.logo_url,
        featured:    updated.featured,
        sortOrder:   updated.sort_order
    };
}

// ─── Preview pricing (for admin calculator) ────────────────────

/**
 * Pure pricing preview. Does not touch the DB for anything except
 * reading the current global markups and FX.
 */
async function previewPricing({ wholesaleAmount, wholesaleCurrency, mode, value }) {
    if (!isValidDecimal(String(wholesaleAmount))) {
        throw svcErr('INVALID_DECIMAL', 'wholesaleAmount must be a decimal string.', 422);
    }
    if (!VALID_MODES.has(mode)) {
        throw svcErr('PRICING_INVALID_MODE', `Mode must be one of: ${[...VALID_MODES].join(', ')}`, 422);
    }

    const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
    const markupUsd = await adminSettings.getMarkup('giftcard', 'USD');
    const markupNgn = await adminSettings.getMarkup('giftcard', 'NGN');

    let normalizedValue = null;
    if (mode === 'markup_pct') {
        normalizedValue = normalizeDecimal(String(value || '0'), 6);
    } else if (mode === 'fixed_ngn' || mode === 'fixed_usd') {
        normalizedValue = normalizeDecimal(String(value || '0'), 2);
    }

    return pricingEngine.calculatePrice({
        wholesaleAmount:   String(wholesaleAmount),
        wholesaleCurrency: String(wholesaleCurrency || 'USD').toUpperCase(),
        usdToNgn:          String(usdToNgn),
        mode,
        value:             normalizedValue,
        globalMarkupUsd:   String(markupUsd),
        globalMarkupNgn:   String(markupNgn)
    });
}

// ─── Global pricing config ─────────────────────────────────────

/**
 * Return the current global gift card pricing rules with display
 * strings for the admin UI.
 */
async function getPricingConfig() {
    const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
    const markupUsd = await adminSettings.getMarkup('giftcard', 'USD');
    const markupNgn = await adminSettings.getMarkup('giftcard', 'NGN');
    const version   = await adminSettings.getRaw('config_version');

    // Percent display conversion without Number().
    const pctToDisplay = adminSettings.percentToDisplay;

    return {
        usdToNgn: String(usdToNgn),
        markupUsd: String(markupUsd),
        markupNgn: String(markupNgn),
        pricingVersion: version != null ? String(version) : null,
        display: {
            usdToNgn: String(usdToNgn),
            markupUsdPct: pctToDisplay(String(markupUsd)) + '%',
            markupNgnPct: pctToDisplay(String(markupNgn)) + '%'
        }
    };
}

/**
 * Update the global gift card pricing rules. Delegates entirely to
 * adminSettings.patchSettings so the version check, reason
 * requirement, large-change guard, and audit all flow through the
 * single source of truth.
 */
async function updatePricingConfig({ patch, reason, expectedVersion, confirmLargeChange }, ctx) {
    if (!patch || typeof patch !== 'object') {
        throw svcErr('VALIDATION_ERROR', 'patch must be an object.', 422);
    }
    if (!reason || String(reason).trim().length < 4) {
        throw svcErr('REASON_REQUIRED', 'A reason is required to change pricing.', 422);
    }
    if (expectedVersion == null) {
        throw svcErr('CONFIG_VERSION_REQUIRED', 'expectedVersion is required.', 409);
    }

    // Only allow the three gift card pricing keys.
    const allowed = new Set([
        'usd_to_ngn',
        'giftcard_markup_pct_usd',
        'giftcard_markup_pct_ngn'
    ]);
    const filtered = {};
    for (const [k, v] of Object.entries(patch)) {
        if (allowed.has(k)) filtered[k] = v;
    }
    if (!Object.keys(filtered).length) {
        throw svcErr('VALIDATION_ERROR',
            'No recognized keys. Allowed: usd_to_ngn, giftcard_markup_pct_usd, giftcard_markup_pct_ngn.',
            422);
    }

    return adminSettings.patchSettings(filtered, {
        ...ctx,
        reason
    }, {
        expectedVersion,
        confirmLargeChange: Boolean(confirmLargeChange)
    });
}

// ─── Refresh costs ─────────────────────────────────────────────

/**
 * Re-read the wholesale cost from the provider for enabled products
 * and refresh the cached customer prices. Flags products where the
 * new price falls below cost or below the configured min margin.
 *
 * Rate limiting is enforced at the route layer, not here.
 */
async function refreshCosts({ limit = REFRESH_BATCH_SIZE } = {}, ctx) {
    const safeLimit = clampInt(limit, REFRESH_BATCH_SIZE, 200);

    // Load enabled products, oldest cost check first.
    const { data: products, error } = await supabaseAdmin
        .from('gift_card_products')
        .select('id, provider_product_id, brand, wholesale_amount, wholesale_currency, pricing_mode, pricing_value, min_margin_pct, cost_checked_at')
        .eq('provider', 'dtone')
        .eq('enabled', true)
        .order('cost_checked_at', { ascending: true, nullsFirst: true })
        .limit(safeLimit);

    if (error) throw svcErr('DB_ERROR', error.message, 500);

    if (!products || !products.length) {
        return { checked: 0, updated: 0, belowCost: [], belowMinMargin: [], unavailable: [] };
    }

    // Load the full provider catalog once.
    const providerResult = await dtoneService.getGiftCardProducts(null, {
        productType: 'FIXED_VALUE_PIN_PURCHASE',
        maxPages: 20,
        maxTotalMs: 30000,
        requestTimeoutMs: 10000,
        requireComplete: true
    });
    const rows = Array.isArray(providerResult?.products) ? providerResult.products : [];
    const byProviderId = new Map(rows.map(r => [String(r.productId), r]));

    const usdToNgn  = await adminSettings.getRate('USD', 'NGN');
    const markupUsd = await adminSettings.getMarkup('giftcard', 'USD');
    const markupNgn = await adminSettings.getMarkup('giftcard', 'NGN');

    const belowCost       = [];
    const belowMinMargin  = [];
    const unavailable     = [];
    const updates         = [];

    for (const p of products) {
        const r = byProviderId.get(String(p.provider_product_id));
        if (!r) {
            unavailable.push({ id: p.id, name: p.brand, reason: 'NOT_IN_PROVIDER_CATALOG' });
            continue;
        }

        const newWholesaleAmount   = String(r.wholesaleAmount ?? '0.00');
        const newWholesaleCurrency = String(r.wholesaleCurrency || 'USD').toUpperCase();
        const costChanged          = newWholesaleAmount !== String(p.wholesale_amount ?? '');
        const currencyChanged      = newWholesaleCurrency !== String(p.wholesale_currency || '').toUpperCase();

        // Recompute the customer price under the product's own rules.
        let priced;
        try {
            priced = pricingEngine.calculatePrice({
                wholesaleAmount:   newWholesaleAmount,
                wholesaleCurrency: newWholesaleCurrency,
                usdToNgn:          String(usdToNgn),
                mode:              p.pricing_mode || 'global',
                value:             p.pricing_value,
                globalMarkupUsd:   String(markupUsd),
                globalMarkupNgn:   String(markupNgn)
            });
        } catch (e) {
            continue;
        }

        // Price vs cost.
        const priceBig = BigInt(priced.priceNgn.replace('.', ''));
        const costBig  = BigInt(priced.costNgn.replace('.', ''));
        if (priceBig < costBig) {
            belowCost.push({ id: p.id, name: p.brand, priceNgn: priced.priceNgn, costNgn: priced.costNgn });
        } else if (p.min_margin_pct != null) {
            try {
                assertPriceAboveCost({
                    priceNgn:     priced.priceNgn,
                    wholesaleNgn: priced.costNgn,
                    minMarginPct: p.min_margin_pct,
                    allowBelowCost: false
                });
            } catch (e) {
                if (e.code === 'PRICING_BELOW_MIN_MARGIN') {
                    belowMinMargin.push({ id: p.id, name: p.brand, priceNgn: priced.priceNgn, costNgn: priced.costNgn, minMarginPct: p.min_margin_pct });
                }
            }
        }

        // Record the update if cost or price changed.
        if (costChanged || currencyChanged ||
            priced.priceNgn !== String(p.customer_price_ngn ?? '') ||
            priced.priceUsd !== String(p.customer_price_usd ?? '')) {
            updates.push({
                id: p.id,
                wholesale_amount:    newWholesaleAmount,
                wholesale_currency:  newWholesaleCurrency,
                customer_price_ngn:  priced.priceNgn,
                customer_price_usd:  priced.priceUsd,
                cost_checked_at:     new Date().toISOString(),
                price_updated_at:    new Date().toISOString()
            });
        }
    }

    // Apply updates one by one so a failure on one doesn't roll back
    // the whole batch.
    let updated = 0;
    for (const u of updates) {
        const { error: updErr } = await supabaseAdmin
            .from('gift_card_products')
            .update(u)
            .eq('id', u.id);
        if (!updErr) updated++;
    }

    // Audit — one entry for the batch.
    try {
        const orderLifecycle = require('./orderLifecycle');
        await orderLifecycle.recordAudit({
            ctx,
            table: 'gift_card_products',
            action: 'gift_card.products.costs_refreshed',
            targetId: null,
            before: null,
            after: {
                checked: products.length,
                updated,
                belowCostCount: belowCost.length,
                belowMinMarginCount: belowMinMargin.length,
                unavailableCount: unavailable.length
            },
            reason: null
        });
    } catch (auditErr) {
        console.error('[GIFT CARD REFRESH] audit failed:', auditErr.message);
    }

    return {
        checked: products.length,
        updated,
        belowCost,
        belowMinMargin,
        unavailable
    };
}

// ─── Exports ────────────────────────────────────────────────────

module.exports = {
    // Catalog
    getCatalog,
    importProducts,

    // Pricing
    updateProductPricing,
    previewPricing,
    getPricingConfig,
    updatePricingConfig,
    refreshCosts,

    // Metadata
    updateProduct,

    // Reused by routes + services that need to compute a price the
    // same way the admin sees it
    resolveProductPricing,
    assertPriceAboveCost,

    // Internal helpers exposed for the routes and tests
    _internal: {
        VALID_MODES,
        normalizeDecimal,
        isValidDecimal
    }
};