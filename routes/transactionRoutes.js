// routes/transactionRoutes.js
// ─────────────────────────────────────────────────────────────────
// GENERAL ACTIVITY history — service orders and purchases.
//
// SCOPE — what this file returns:
//   • Airtime orders (DT One — airtime_transactions)
//   • Airtime / Data / Electricity / TV / bills (VTpass — bill_payment_transactions)
//   • eSIM orders (DT One — esim_transactions)
//   • Gift-card orders (DT One — giftcard_transactions)   ← NEW
//   • Virtual SMS orders
//   • Marketplace purchases
//   • Social-boosting orders
//   • Any other non-financial service rows already in `transactions`
//
// SCOPE — what this file does NOT return:
//   • Deposits / wallet debits / wallet credits / refunds / withdrawals
//     → those live behind GET /api/wallet/transactions
//
// ENDPOINTS (paths preserved; behaviour hardened):
//   GET  /                                  list (paginated)
//   GET  /stats                             aggregate counters
//   GET  /purchases                         marketplace orders list
//   GET  /purchases/:reference/deliverable  ownership-checked secrets
//   GET  /purchase-map                      reference → status map
//   POST /download/:reference               atomic download count
//   GET  /export/csv                        bounded CSV
//   GET  /:id                               MUST be registered LAST
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();

const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

// ═══ CONFIG ═══
const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 50;
const PER_SOURCE_CAP = 200;
const MERGE_CAP     = 500;
const EXPORT_MAX_ROWS = 10000;
const EXPORT_MAX_DAYS = 366;

// ─── SERVICE-ONLY TYPES ───────────────────────────────────────────
const SERVICE_TYPES = Object.freeze([
    'airtime', 'data', 'bundle', 'esim',
    'gift', 'giftcard', 'gift_card',
    'marketplace', 'purchase',
    'boost', 'virtual', 'virtual_sms',
    'bills', 'electricity', 'cable', 'internet', 'water', 'education'
]);

const CUSTOMER_STATUS_MAP = Object.freeze({
    completed:  'completed',
    success:    'completed',
    successful: 'completed',
    finished:   'completed',
    refunded:   'refunded',
    failed:     'failed',
    declined:   'failed',
    cancelled:  'cancelled',
    canceled:   'cancelled',
    reversed:   'reversed',
    pending:    'pending',
    processing: 'processing',
    submitted:  'processing',
    created:    'processing',
    confirmed:  'processing',
    manual_review: 'processing'
});

// ═══ HELPERS ═══
function parseLimit(value) {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed < 1) return DEFAULT_LIMIT;
    return Math.min(parsed, MAX_LIMIT);
}
function parsePage(value) {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed) || parsed < 1) return 1;
    return parsed;
}
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
function up(v) { return String(v || '').toUpperCase(); }
function lower(v) { return String(v || '').toLowerCase(); }
function toIso(v) {
    if (!v) return null;
    try { return new Date(v).toISOString(); } catch { return null; }
}
function newReqId() {
    return 'tx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
function csvCell(v) {
    const s = String(v == null ? '' : v);
    return `"${s.replace(/"/g, '""')}"`;
}

const SEARCH_RE = /^[A-Za-z0-9_\- ]{1,64}$/;
function sanitizeSearch(value) {
    if (!value) return null;
    const s = String(value).trim();
    if (!s) return null;
    if (!SEARCH_RE.test(s)) return null;
    return s;
}

function amountForCurrency(row, currency) {
    const ccy = up(currency) || 'NGN';
    const order = ccy === 'USD'
        ? [row.amount_usd, row.total_usd, row.price_usd, row.amount, row.total_amount, row.price]
        : [row.amount_ngn, row.total_ngn, row.price_ngn, row.amount, row.total_amount, row.price];

    for (const v of order) {
        const n = Number(v);
        if (Number.isFinite(n) && n !== 0) return Math.abs(n);
    }
    return 0;
}

function feeForCurrency(row, currency) {
    const ccy = up(currency) || 'NGN';
    const order = ccy === 'USD'
        ? [row.fee_usd, row.revenue_usd, row.milespace_fee_usd, row.fee]
        : [row.fee_ngn, row.revenue_ngn, row.milespace_fee_ngn, row.fee];

    for (const v of order) {
        const n = Number(v);
        if (Number.isFinite(n) && n !== 0) return Math.abs(n);
    }
    return 0;
}

function customerSafeDescription(record, fallback) {
    const type = lower(record.type || record.service_type);

    if (type === 'airtime') {
        const cc = record.country_code || record.network || '';
        const phone = (record.phone_number || record.recipient)
            ? `****${String(record.phone_number || record.recipient).slice(-4)}`
            : '';
        return `Airtime${cc ? ' to ' + cc : ''}${phone ? ' ' + phone : ''}`.trim();
    }
    if (type === 'esim') {
        const country = record.country_name || '';
        const plan = record.plan_name || '';
        return `eSIM${country ? ' for ' + country : ''}${plan ? ' — ' + plan : ''}`.trim();
    }
    if (type === 'data') {
        const plan = record.plan_name || record.variation_code || '';
        const phone = (record.phone_number || record.recipient)
            ? ` ****${String(record.phone_number || record.recipient).slice(-4)}`
            : '';
        return `Data${plan ? ' — ' + plan : ''}${phone}`.trim();
    }
    if (type === 'electricity') {
        const meter = record.recipient ? `meter ****${String(record.recipient).slice(-4)}` : '';
        return `Electricity${meter ? ' — ' + meter : ''}`.trim();
    }
    if (type === 'tv') {
        const sm = record.recipient ? `smartcard ****${String(record.recipient).slice(-4)}` : '';
        return `TV subscription${sm ? ' — ' + sm : ''}`.trim();
    }
    if (type === 'bills') {
        return record.description || 'Bill payment';
    }
    if (type === 'marketplace' || type === 'purchase') {
        return record.product_title || 'Marketplace purchase';
    }
    if (type === 'gift' || type === 'giftcard' || type === 'gift_card') {
        return record.card_name ? `Gift card — ${record.card_name}` : 'Gift card order';
    }
    if (type === 'boost') return 'Social boosting';
    if (type === 'virtual' || type === 'virtual_sms') return 'Virtual number';

    return record.description || fallback || 'Transaction';
}

function toCustomerStatus(status) {
    const s = lower(status);
    return CUSTOMER_STATUS_MAP[s] || 'processing';
}

// ═══════════════════════════════════════════════════════════════════
//  CUSTOMER-SAFE OUTPUT
// ═══════════════════════════════════════════════════════════════════
function toCustomer(record) {
    if (!record) return null;

    const delivery = {};
    const type = lower(record.type);

    if (type === 'airtime') {
        if (record.metadata?.country_code) delivery.country_code = record.metadata.country_code;
        if (record.phone_number) delivery.phone_masked = `****${String(record.phone_number).slice(-4)}`;
        if (record.metadata?.destination_amount) {
            delivery.recipient_amount = record.metadata.destination_amount;
            delivery.recipient_currency = record.metadata.destination_currency || null;
        }
    } else if (type === 'esim') {
        if (record.metadata?.plan_name) delivery.plan_name = record.metadata.plan_name;
        if (record.metadata?.country_name) delivery.country_name = record.metadata.country_name;
        if (record.metadata?.data_display) delivery.data_display = record.metadata.data_display;
        if (record.metadata?.validity_days) delivery.validity_days = record.metadata.validity_days;
    } else if (type === 'marketplace' || type === 'purchase') {
        if (record.product_title) delivery.product_title = record.product_title;
    } else if (type === 'electricity') {
        if (record.metadata?.token) delivery.token = record.metadata.token;
        if (record.metadata?.units) delivery.units = record.metadata.units;
    } else if (type === 'data' || type === 'tv' || type === 'bills') {
        if (record.metadata?.network) delivery.network = record.metadata.network;
        if (record.metadata?.recipient) delivery.recipient_masked = `****${String(record.metadata.recipient).slice(-4)}`;
    } else if (type === 'giftcard' || type === 'gift' || type === 'gift_card') {
        if (record.metadata?.card_name) delivery.card_name = record.metadata.card_name;
        if (record.metadata?.face_value) delivery.face_value = record.metadata.face_value;
        if (record.metadata?.face_currency) delivery.face_currency = record.metadata.face_currency;
    }

    return {
        id:          record.id,
        reference:   record.reference,
        type:        record.type,
        status:      toCustomerStatus(record.status),
        currency:    record.currency,
        amount:      record.amount,
        fee:         record.fee,
        net_amount:  record.net_amount,
        description: record.description,
        category:    record.category,
        delivery,
        created_at:  record.created_at,
        updated_at:  record.updated_at,
        completed_at: record.completed_at,
        failed_at:   record.failed_at,
        cancelled_at: record.cancelled_at,
        refunded_at: record.refunded_at
    };
}

// ═══════════════════════════════════════════════════════════════════
//  ROW MAPPERS  (internal shape → canonical intermediate)
// ═══════════════════════════════════════════════════════════════════

function mapTransaction(t) {
    const currency = up(t.currency || t.wallet_used || 'NGN');
    const amount = amountForCurrency(t, currency);
    const fee = feeForCurrency(t, currency);

    return {
        id: t.id,
        reference: t.ref || t.reference || t.id,
        type: t.type || 'purchase',
        status: t.status || 'pending',
        currency,
        wallet_used: t.wallet_used || currency,
        amount,
        fee,
        net_amount: Math.max(0, amount - fee),
        description: customerSafeDescription({ ...t, type: t.type }, t.description),
        category: t.category || null,
        source_type: t.source_type || null,
        source_id: t.source_id || null,
        created_at: t.created_at,
        updated_at: t.updated_at,
        completed_at: t.completed_at || null,
        failed_at: t.failed_at || null,
        cancelled_at: t.cancelled_at || null,
        refunded_at: t.refunded_at || t.reversed_at || null
    };
}

function mapAirtimeToTransaction(a) {
    const currency = up(a.currency || 'USD');
    const amount = amountForCurrency(a, currency);
    const fee = feeForCurrency(a, currency);
    const phone = a.phone_number ? String(a.phone_number) : '';

    return {
        id: a.id,
        reference: a.reference || a.id,
        type: 'airtime',
        status: a.status || 'pending',
        currency,
        wallet_used: currency,
        amount,
        fee,
        net_amount: Math.max(0, amount - fee),
        description: customerSafeDescription(
            { type: 'airtime', country_code: a.country_code, phone_number: phone },
            'Airtime purchase'
        ),
        category: null,
        source_type: 'airtime',
        source_id: a.id,
        phone_number: phone,
        metadata: {
            country_code: a.country_code || null,
            phone_number: phone || null,
            destination_amount: a.destination_amount ?? null,
            destination_currency: a.destination_currency ?? null
        },
        created_at: a.created_at,
        updated_at: a.updated_at,
        completed_at: a.completed_at || null,
        failed_at: a.failed_at || null,
        cancelled_at: null,
        refunded_at: a.refunded ? a.updated_at : null
    };
}

function mapEsimToTransaction(e) {
    const currency = up(e.currency || 'USD');
    const amount = amountForCurrency(e, currency);
    const fee = feeForCurrency(e, currency);

    return {
        id: e.id,
        reference: e.reference || e.id,
        type: 'esim',
        status: e.status || 'pending',
        currency,
        wallet_used: currency,
        amount,
        fee,
        net_amount: Math.max(0, amount - fee),
        description: customerSafeDescription(
            { type: 'esim', country_name: e.country_name, plan_name: e.plan_name },
            'eSIM purchase'
        ),
        category: null,
        source_type: 'esim',
        source_id: e.id,
        metadata: {
            country_name: e.country_name || null,
            plan_name: e.plan_name || null,
            data_display: e.data_display || null,
            validity_days: e.validity_days || null
        },
        created_at: e.created_at,
        updated_at: e.updated_at,
        completed_at: e.completed_at || null,
        failed_at: e.failed_at || null,
        cancelled_at: e.cancelled_at || null,
        refunded_at: e.refunded ? e.updated_at : null
    };
}

function mapMarketplace(o, linkedTx = null) {
    const currency = up(
        o.currency ||
        (linkedTx && linkedTx.currency) ||
        o.wallet_type ||
        'NGN'
    );

    let amount = 0;
    if (linkedTx) amount = amountForCurrency(linkedTx, currency);
    if (amount === 0) amount = amountForCurrency(o, currency);

    const fee = (linkedTx && feeForCurrency(linkedTx, currency)) || feeForCurrency(o, currency);

    return {
        id: o.id,
        reference: o.order_ref || o.reference || o.id,
        type: 'marketplace',
        status: o.status || 'pending',
        currency,
        wallet_used: currency,
        amount,
        fee,
        net_amount: Math.max(0, amount - fee),
        description: o.product_title || o.description || 'Marketplace purchase',
        category: 'marketplace',
        source_type: 'marketplace',
        source_id: o.id,
        product_title: o.product_title || null,
        metadata: {
            product_title: o.product_title || null,
            product_id: o.product_id || null,
            delivered: !!o.delivered,
            delivered_at: o.delivered_at || null
        },
        created_at: o.created_at,
        updated_at: o.updated_at,
        completed_at: o.completed_at || o.delivered_at || null,
        failed_at: o.failed_at || null,
        cancelled_at: o.cancelled_at || null,
        refunded_at: o.refunded_at || null
    };
}

function mapBillPaymentToTransaction(b) {
    const currency = up(b.currency || 'NGN');

    let amount = num(b.customer_amount);
    if (amount === 0) amount = amountForCurrency(b, currency);

    const fee = num(b.service_fee);

    const serviceType = lower(b.service_type) || 'bills';
    const reference = b.reference || b.id;

    const metadata = {
        network: b.network || null,
        recipient: b.recipient || null,
        token: b.token || null,
        units: b.units || null
    };
    if (b.metadata && typeof b.metadata === 'object') {
        if (b.metadata.plan_name) metadata.plan_name = b.metadata.plan_name;
        if (b.metadata.customer_name) metadata.customer_name = b.metadata.customer_name;
    }

    return {
        id: b.id,
        reference,
        type: serviceType,
        status: b.status || 'pending',
        currency,
        wallet_used: currency,
        amount,
        fee,
        net_amount: Math.max(0, amount - fee),
        description: customerSafeDescription(
            {
                type: serviceType,
                network: b.network,
                recipient: b.recipient,
                phone_number: b.recipient,
                plan_name: b.metadata?.plan_name,
                country_code: b.network
            },
            `${serviceType} purchase`
        ),
        category: null,
        source_type: 'vtpass',
        source_id: b.id,
        metadata,
        created_at: b.created_at,
        updated_at: b.updated_at,
        completed_at: b.completed_at || null,
        failed_at: b.failed_at || null,
        cancelled_at: null,
        refunded_at: b.refunded ? (b.refunded_at || b.updated_at) : null
    };
}

// ── map a DT One giftcard_transactions row to canonical shape ────
// Provider fields (provider_response, provider_status,
// provider_transaction_id, voucher_code, voucher_serial,
// email_message_id) are NOT included here — voucher codes live behind
// /purchases/:reference/deliverable. Admin/support routes get their
// own shape from the admin endpoints.
function mapGiftCardToTransaction(g) {
    const currency = up(g.currency || g.debit_currency || 'USD');

    let amount = num(g.amount);
    if (amount === 0) amount = amountForCurrency(g, currency);

    const fee = num(g.fee) || feeForCurrency(g, currency);

    return {
        id: g.id,
        reference: g.reference || g.id,
        type: 'giftcard',
        status: g.status || 'pending',
        currency,
        wallet_used: currency,
        amount,
        fee,
        net_amount: Math.max(0, amount - fee),
        description: customerSafeDescription(
            { type: 'giftcard', card_name: g.card_name },
            'Gift card order'
        ),
        category: null,
        source_type: 'dtone',
        source_id: g.id,
        metadata: {
            card_name: g.card_name || null,
            face_value: g.face_value ?? null,
            face_currency: g.face_currency || null,
            delivered: !!g.email_sent,
            delivered_at: g.email_sent_at || null
        },
        created_at: g.created_at,
        updated_at: g.updated_at,
        completed_at: g.completed_at || null,
        failed_at: g.failed_at || null,
        cancelled_at: null,
        refunded_at: g.refunded ? (g.refunded_at || g.updated_at) : null
    };
}

async function attachLinkedTransactions(userId, orders) {
    if (!orders || orders.length === 0) return new Map();

    const orderIds = orders.map(o => o.id).filter(Boolean);
    const orderRefs = orders.map(o => o.order_ref).filter(Boolean);
    const linkMap = new Map();

    if (orderIds.length > 0) {
        const { data: txById } = await supabaseAdmin
            .from('transactions')
            .select('id, user_id, source_id, source_type, reference, ref, amount, amount_ngn, amount_usd, fee, revenue_ngn, revenue_usd, currency, status, created_at')
            .eq('user_id', userId)
            .eq('source_type', 'marketplace')
            .in('source_id', orderIds);

        (txById || []).forEach(tx => {
            if (tx.source_id) linkMap.set(String(tx.source_id), tx);
        });
    }

    if (orderRefs.length > 0) {
        const { data: txByRef } = await supabaseAdmin
            .from('transactions')
            .select('id, user_id, reference, ref, amount, amount_ngn, amount_usd, fee, revenue_ngn, revenue_usd, currency, status, created_at')
            .eq('user_id', userId)
            .in('reference', orderRefs);

        (txByRef || []).forEach(tx => {
            const ref = tx.reference || tx.ref;
            if (ref && !linkMap.has(String(ref))) {
                linkMap.set(String(ref), tx);
            }
        });
    }

    return linkMap;
}

// ═══════════════════════════════════════════════════════════════════
//  GET /  — General Activity (paginated, customer-safe)
// ═══════════════════════════════════════════════════════════════════
router.get('/', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const page = parsePage(req.query.page);
        const limit = parseLimit(req.query.limit);
        const offset = (page - 1) * limit;
        const type = req.query.type && req.query.type !== 'all' ? lower(req.query.type) : null;
        const status = req.query.status && req.query.status !== 'all' ? lower(req.query.status) : null;
        const search = sanitizeSearch(req.query.search);

        if (req.query.search && !search) {
            return res.status(400).json({
                success: false,
                code: 'INVALID_SEARCH',
                error: 'Search must be 1-64 characters: letters, numbers, hyphens, underscores, or spaces.'
            });
        }

        const warnings = [];
        const truncated = {};

        // ─── 1. Service rows in `transactions` ────────────────────
        let mainQ = supabaseAdmin
            .from('transactions')
            .select('*')
            .eq('user_id', userId)
            .in('type', SERVICE_TYPES)
            .order('created_at', { ascending: false })
            .limit(PER_SOURCE_CAP);

        if (type && SERVICE_TYPES.includes(type)) mainQ = mainQ.eq('type', type);
        if (status) mainQ = mainQ.eq('status', status);
        if (search) mainQ = mainQ.or(
            `ref.ilike.%${search}%,reference.ilike.%${search}%,description.ilike.%${search}%`
        );

        const { data: mainTx, error: mainErr } = await mainQ;
        if (mainErr && mainErr.code !== '42P01') {
            console.error('[TX] main query error:', mainErr);
            return res.status(503).json({
                success: false,
                code: 'MAIN_SOURCE_UNAVAILABLE',
                error: 'Could not load transactions from primary source.',
                detail: mainErr.message
            });
        }
        if (mainErr?.code === '42P01') warnings.push('transactions table missing');
        if ((mainTx || []).length === PER_SOURCE_CAP) truncated.transactions = true;

        // ─── 2. Airtime rows (DT One international airtime) ───────
        let airtimeRows = [];
        const includeAirtime = !type || type === 'airtime';
        if (includeAirtime) {
            let airQ = supabaseAdmin
                .from('airtime_transactions')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(PER_SOURCE_CAP);

            if (status) airQ = airQ.eq('status', status);
            if (search) airQ = airQ.or(
                `reference.ilike.%${search}%,phone_number.ilike.%${search}%`
            );

            const { data: rows, error: airErr } = await airQ;
            if (airErr && airErr.code !== '42P01') {
                console.error('[TX] airtime query error:', airErr);
                warnings.push('airtime source unavailable');
            } else if (!airErr) {
                airtimeRows = rows || [];
                if (airtimeRows.length === PER_SOURCE_CAP) truncated.airtime = true;
            }
        }

        // ─── 3. eSIM rows ─────────────────────────────────────────
        let esimRows = [];
        const includeEsim = !type || type === 'esim';
        if (includeEsim) {
            let eQ = supabaseAdmin
                .from('esim_transactions')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(PER_SOURCE_CAP);

            if (status) eQ = eQ.eq('status', status);
            if (search) eQ = eQ.or(
                `reference.ilike.%${search}%,country_name.ilike.%${search}%`
            );

            const { data: rows, error: eErr } = await eQ;
            if (eErr && eErr.code !== '42P01') {
                console.warn('[TX] eSIM query error (non-fatal):', eErr.message);
                warnings.push('esim source unavailable');
            } else if (!eErr) {
                esimRows = rows || [];
                if (esimRows.length === PER_SOURCE_CAP) truncated.esim = true;
            }
        }

        // ─── 4. Gift card rows ────────────────────────────────────
        let giftRows = [];
        const includeGift = !type || ['gift', 'giftcard', 'gift_card'].includes(type);
        if (includeGift) {
            let gQ = supabaseAdmin
                .from('giftcard_transactions')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(PER_SOURCE_CAP);

            if (status) gQ = gQ.eq('status', status);
            if (search) gQ = gQ.or(
                `reference.ilike.%${search}%,card_name.ilike.%${search}%`
            );

            const { data: rows, error: gErr } = await gQ;
            if (gErr && gErr.code !== '42P01') {
                console.warn('[TX] giftcard query error (non-fatal):', gErr.message);
                warnings.push('giftcard source unavailable');
            } else if (!gErr) {
                giftRows = rows || [];
                if (giftRows.length === PER_SOURCE_CAP) truncated.giftcard = true;
            }
        }

        // ─── 5. Marketplace orders ────────────────────────────────
        let marketRows = [];
        const includeMarket = !type || type === 'marketplace' || type === 'purchase';
        if (includeMarket) {
            let mQ = supabaseAdmin
                .from('marketplace_orders')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(PER_SOURCE_CAP);

            if (status) mQ = mQ.eq('status', status);

            const { data: rows, error: mErr } = await mQ;
            if (mErr && mErr.code !== '42P01') {
                console.warn('[TX] marketplace query error (non-fatal):', mErr.message);
                warnings.push('marketplace source unavailable');
            } else if (!mErr) {
                marketRows = rows || [];
                if (marketRows.length === PER_SOURCE_CAP) truncated.marketplace = true;
            }
        }

        // ─── 6. VTpass bill payments ──────────────────────────────
        let billRows = [];
        const includeBills = !type || ['airtime', 'data', 'electricity', 'tv', 'bills'].includes(type);
        if (includeBills) {
            let bQ = supabaseAdmin
                .from('bill_payment_transactions')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(PER_SOURCE_CAP);

            if (type && ['airtime', 'data', 'electricity', 'tv', 'bills'].includes(type)) {
                bQ = bQ.eq('service_type', type);
            }
            if (status) bQ = bQ.eq('status', status);
            if (search) {
                bQ = bQ.or(
                    `reference.ilike.%${search}%,recipient.ilike.%${search}%,service_id.ilike.%${search}%`
                );
            }

            const { data: rows, error: bErr } = await bQ;
            if (bErr && bErr.code !== '42P01') {
                console.warn('[TX] bills query error (non-fatal):', bErr.message);
                warnings.push('bills source unavailable');
            } else if (!bErr) {
                billRows = rows || [];
                if (billRows.length === PER_SOURCE_CAP) truncated.bills = true;
            }
        }

        // ─── 7. Merge + map ───────────────────────────────────────
        const linkMap = await attachLinkedTransactions(userId, marketRows);

        const mainMapped   = (mainTx || []).map(mapTransaction);
        const airMapped    = airtimeRows.map(mapAirtimeToTransaction);
        const esimMapped   = esimRows.map(mapEsimToTransaction);
        const giftMapped   = giftRows.map(mapGiftCardToTransaction);
        const marketMapped = marketRows.map(o => {
            const linkedTx = linkMap.get(String(o.id)) || linkMap.get(String(o.order_ref)) || null;
            return mapMarketplace(o, linkedTx);
        });
        const billMapped   = billRows.map(mapBillPaymentToTransaction);

        // De-dupe: marketplace orders win over a `transactions` row
        // with the same reference.
        const marketRefs = new Set(marketMapped.map(m => String(m.reference)));
        const filteredMain = mainMapped.filter(m => {
            if (!['marketplace', 'purchase'].includes(lower(m.type))) return true;
            return !marketRefs.has(String(m.reference));
        });

        // De-dupe: bill_payment_transactions win over `transactions`
        // rows that share the same reference for airtime/data/tv/
        // electricity/bills types.
        const billRefs = new Set(billMapped.map(b => String(b.reference)));
        const filteredMainAfterBills = filteredMain.filter(m => {
            const t = lower(m.type);
            if (!['airtime', 'data', 'electricity', 'tv', 'bills'].includes(t)) return true;
            return !billRefs.has(String(m.reference));
        });

        // De-dupe: giftcard_transactions win over `transactions` rows
        // for gift/giftcard/gift_card types.
        const giftRefs = new Set(giftMapped.map(g => String(g.reference)));
        const filteredMainAfterGifts = filteredMainAfterBills.filter(m => {
            const t = lower(m.type);
            if (!['gift', 'giftcard', 'gift_card'].includes(t)) return true;
            return !giftRefs.has(String(m.reference));
        });

        // De-dupe DT One airtime against VTpass airtime (VTpass wins
        // when the same reference exists in both).
        const filteredAir = airMapped.filter(a => !billRefs.has(String(a.reference)));

        const merged = [
            ...filteredMainAfterGifts,
            ...marketMapped,
            ...billMapped,
            ...giftMapped,
            ...esimMapped,
            ...filteredAir
        ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        if (merged.length > MERGE_CAP) {
            warnings.push('history truncated — refine filters or date range');
            merged.length = MERGE_CAP;
        }

        const totalCount = merged.length;
        const paged = merged.slice(offset, offset + limit);
        const safePaged = paged.map(toCustomer);
        const partial = warnings.length > 0;

        res.json({
            success: true,
            partial,
            warnings,
            truncated,
            data: safePaged,
            count: totalCount,
            pagination: {
                page,
                limit,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limit) || 1,
                hasMore: page < (Math.ceil(totalCount / limit) || 1)
            }
        });
    } catch (error) {
        console.error('❌ Transaction error:', error);
        res.status(500).json({
            success: false,
            code: 'TRANSACTION_LOAD_FAILED',
            error: error.message || 'Failed to load transactions'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /stats
// ═══════════════════════════════════════════════════════════════════
router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const warnings = [];

        try {
            const { data, error } = await supabaseAdmin.rpc('transaction_stats_for_user', {
                p_user_id: userId
            });
            if (!error && data) {
                return res.json({ success: true, partial: false, warnings: [], stats: data });
            }
            if (error && !/function|does not exist|schema cache/i.test(String(error.message))) {
                console.warn('[TX/stats] RPC failed, using fallback:', error.message);
                warnings.push('server-side stats unavailable');
            }
        } catch (rpcErr) {
            console.warn('[TX/stats] RPC threw, using fallback:', rpcErr.message);
            warnings.push('server-side stats unavailable');
        }

        const [mainRes, airRes, esimRes, giftRes, marketRes, billRes] = await Promise.all([
            supabaseAdmin
                .from('transactions')
                .select('id, type, status, created_at')
                .eq('user_id', userId)
                .in('type', SERVICE_TYPES)
                .order('created_at', { ascending: false })
                .limit(PER_SOURCE_CAP),
            supabaseAdmin
                .from('airtime_transactions')
                .select('id, status, created_at')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(PER_SOURCE_CAP),
            supabaseAdmin
                .from('esim_transactions')
                .select('id, status, created_at')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(PER_SOURCE_CAP),
            supabaseAdmin
                .from('giftcard_transactions')
                .select('id, status, created_at')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(PER_SOURCE_CAP),
            supabaseAdmin
                .from('marketplace_orders')
                .select('id, status, created_at')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(PER_SOURCE_CAP),
            supabaseAdmin
                .from('bill_payment_transactions')
                .select('id, service_type, status, created_at')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(PER_SOURCE_CAP)
        ]);

        if (mainRes.error && mainRes.error.code !== '42P01') warnings.push('transactions source unavailable');
        if (airRes.error && airRes.error.code !== '42P01') warnings.push('airtime source unavailable');
        if (esimRes.error && esimRes.error.code !== '42P01') warnings.push('esim source unavailable');
        if (giftRes.error && giftRes.error.code !== '42P01') warnings.push('giftcard source unavailable');
        if (marketRes.error && marketRes.error.code !== '42P01') warnings.push('marketplace source unavailable');
        if (billRes.error && billRes.error.code !== '42P01') warnings.push('bills source unavailable');

        const rows = [
            ...((mainRes.data || []).map(r => ({ type: r.type, status: r.status, created_at: r.created_at }))),
            ...((airRes.data || []).map(r => ({ type: 'airtime', status: r.status, created_at: r.created_at }))),
            ...((esimRes.data || []).map(r => ({ type: 'esim', status: r.status, created_at: r.created_at }))),
            ...((giftRes.data || []).map(r => ({ type: 'giftcard', status: r.status, created_at: r.created_at }))),
            ...((marketRes.data || []).map(r => ({ type: 'marketplace', status: r.status, created_at: r.created_at }))),
            ...((billRes.data || []).map(r => ({ type: r.service_type || 'bills', status: r.status, created_at: r.created_at })))
        ];

        const stats = calculateStats(rows);
        const partial = warnings.length > 0;

        res.json({ success: true, partial, warnings, stats });
    } catch (error) {
        console.error('❌ Stats error:', error);
        res.status(500).json({
            success: false,
            code: 'STATS_LOAD_FAILED',
            error: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /purchases  — marketplace orders list
// ═══════════════════════════════════════════════════════════════════
router.get('/purchases', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const { data, error } = await supabaseAdmin
            .from('marketplace_orders')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(PER_SOURCE_CAP);

        if (error) {
            console.error('[TX/purchases] query error:', error.message);
            return res.status(503).json({
                success: false,
                code: 'PURCHASES_UNAVAILABLE',
                error: 'Your purchases are temporarily unavailable. Please try again.'
            });
        }

        const orders = data || [];
        const linkMap = await attachLinkedTransactions(userId, orders);

        const mapped = orders.map(o => {
            const linkedTx = linkMap.get(String(o.id)) || linkMap.get(String(o.order_ref)) || null;
            return toCustomer(mapMarketplace(o, linkedTx));
        });

        return res.json({
            success: true,
            data: mapped,
            count: mapped.length,
            truncated: orders.length === PER_SOURCE_CAP
        });
    } catch (e) {
        console.error('❌ /transactions/purchases error:', e);
        return res.status(500).json({
            success: false,
            code: 'PURCHASES_FAILED',
            error: 'Could not load your purchases. Please try again.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /purchases/:reference/deliverable
// ═══════════════════════════════════════════════════════════════════
router.get('/purchases/:reference/deliverable', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { reference } = req.params;
        if (!reference || reference.length > 200) {
            return res.status(400).json({ success: false, code: 'INVALID_REFERENCE' });
        }

        const { data: order, error } = await supabaseAdmin
            .from('marketplace_orders')
            .select(
                'id, order_ref, user_id, status, delivered, delivered_at, ' +
                'product_title, download_token, download_count, ' +
                'delivered_data, metadata, instructions'
            )
            .or(`order_ref.eq.${reference},id.eq.${reference}`)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            console.error('[TX/deliverable] query error:', error.message);
            return res.status(503).json({
                success: false,
                code: 'DELIVERABLE_UNAVAILABLE',
                error: 'This deliverable is temporarily unavailable. Please try again.'
            });
        }

        if (!order) {
            return res.status(404).json({
                success: false,
                code: 'ORDER_NOT_FOUND',
                error: 'Order not found.'
            });
        }

        if (lower(order.status) !== 'completed' || !order.delivered) {
            return res.status(409).json({
                success: false,
                code: 'DELIVERABLE_NOT_AVAILABLE',
                error: 'This order has not been delivered yet. Please check back shortly.'
            });
        }

        const meta = order.metadata || {};
        const credentials =
            meta.credentials ||
            meta.login_credentials ||
            meta.account_details ||
            null;

        return res.json({
            success: true,
            data: {
                reference: order.order_ref || order.id,
                product_title: order.product_title || null,
                delivered_at: toIso(order.delivered_at),
                credentials,
                instructions: order.instructions || meta.instructions || null,
                delivered_data: order.delivered_data || meta.delivered_data || null,
                download_token: order.download_token || null,
                download_count: num(order.download_count)
            }
        });
    } catch (e) {
        console.error('❌ /purchases/:reference/deliverable error:', e);
        return res.status(500).json({
            success: false,
            code: 'DELIVERABLE_FAILED',
            error: 'Could not load this deliverable. Please try again.'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /purchase-map
// ═══════════════════════════════════════════════════════════════════
router.get('/purchase-map', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const map = {};

        const { data: transactions } = await supabaseAdmin
            .from('transactions')
            .select('id, ref, reference, type, status, currency, amount, amount_ngn, amount_usd, description, created_at')
            .eq('user_id', userId)
            .in('type', SERVICE_TYPES)
            .in('status', ['completed', 'processing'])
            .order('created_at', { ascending: false })
            .limit(100);

        (transactions || []).forEach(t => {
            const ref = t.ref || t.reference || t.id;
            if (!ref) return;
            const currency = up(t.currency || 'NGN');
            map[ref] = {
                transaction_id: t.id,
                reference: ref,
                type: t.type,
                status: toCustomerStatus(t.status),
                amount: amountForCurrency(t, currency),
                currency,
                description: customerSafeDescription(t, t.type),
                purchased_at: t.created_at
            };
        });

        const { data: airtimeRows } = await supabaseAdmin
            .from('airtime_transactions')
            .select('id, reference, status, currency, total_amount, amount, country_code, phone_number, created_at')
            .eq('user_id', userId)
            .in('status', ['completed', 'processing', 'pending'])
            .order('created_at', { ascending: false })
            .limit(100);

        (airtimeRows || []).forEach(a => {
            const ref = a.reference;
            if (!ref || map[ref]) return;
            const currency = up(a.currency || 'USD');
            map[ref] = {
                transaction_id: a.id,
                reference: ref,
                type: 'airtime',
                status: toCustomerStatus(a.status),
                amount: amountForCurrency(a, currency),
                currency,
                description: customerSafeDescription(
                    { type: 'airtime', country_code: a.country_code, phone_number: a.phone_number },
                    'Airtime purchase'
                ),
                purchased_at: a.created_at
            };
        });

        const { data: billRows } = await supabaseAdmin
            .from('bill_payment_transactions')
            .select('id, reference, service_type, status, currency, customer_amount, base_amount, network, recipient, created_at')
            .eq('user_id', userId)
            .in('status', ['completed', 'processing', 'pending'])
            .order('created_at', { ascending: false })
            .limit(100);

        (billRows || []).forEach(b => {
            const ref = b.reference;
            if (!ref || map[ref]) return;
            const currency = up(b.currency || 'NGN');
            const serviceType = lower(b.service_type) || 'bills';
            map[ref] = {
                transaction_id: b.id,
                reference: ref,
                type: serviceType,
                status: toCustomerStatus(b.status),
                amount: num(b.customer_amount) || amountForCurrency(b, currency),
                currency,
                description: customerSafeDescription(
                    {
                        type: serviceType,
                        network: b.network,
                        recipient: b.recipient,
                        phone_number: b.recipient
                    },
                    `${serviceType} purchase`
                ),
                purchased_at: b.created_at
            };
        });

        const { data: giftRows } = await supabaseAdmin
            .from('giftcard_transactions')
            .select('id, reference, status, currency, amount, card_name, created_at')
            .eq('user_id', userId)
            .in('status', ['completed', 'processing', 'pending'])
            .order('created_at', { ascending: false })
            .limit(100);

        (giftRows || []).forEach(g => {
            const ref = g.reference;
            if (!ref || map[ref]) return;
            const currency = up(g.currency || 'USD');
            map[ref] = {
                transaction_id: g.id,
                reference: ref,
                type: 'giftcard',
                status: toCustomerStatus(g.status),
                amount: amountForCurrency(g, currency),
                currency,
                description: customerSafeDescription(
                    { type: 'giftcard', card_name: g.card_name },
                    'Gift card order'
                ),
                purchased_at: g.created_at
            };
        });

        res.json({ success: true, map });
    } catch (error) {
        console.error('❌ Purchase map error:', error);
        res.json({ success: true, map: {} });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  POST /download/:reference
// ═══════════════════════════════════════════════════════════════════
router.post('/download/:reference', authMiddleware, async (req, res) => {
    const reqId = newReqId();
    try {
        const userId = req.user.id;
        const { reference } = req.params;
        if (!reference || reference.length > 200) {
            return res.status(400).json({ success: false, code: 'INVALID_REFERENCE' });
        }

        const { data: order, error } = await supabaseAdmin
            .from('marketplace_orders')
            .select('id, order_ref, user_id, status, delivered, product_title, download_token, download_count')
            .or(`order_ref.eq.${reference},id.eq.${reference}`)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            console.error(`[TX/download] query error reqId=${reqId}:`, error.message);
            return res.status(503).json({
                success: false,
                code: 'DOWNLOAD_UNAVAILABLE',
                error: 'Download service is temporarily unavailable.'
            });
        }

        if (!order) {
            return res.status(404).json({
                success: false,
                code: 'DOWNLOAD_NOT_AVAILABLE',
                error: 'Download not available.'
            });
        }

        if (lower(order.status) !== 'completed' || !order.delivered) {
            return res.status(409).json({
                success: false,
                code: 'DELIVERABLE_NOT_AVAILABLE',
                error: 'This order has not been delivered yet.'
            });
        }
        if (!order.download_token) {
            return res.status(404).json({
                success: false,
                code: 'DOWNLOAD_NOT_AVAILABLE',
                error: 'Download not available for this order.'
            });
        }

        let newCount = num(order.download_count) + 1;
        let rpcOk = false;
        try {
            const { data, error: rpcErr } = await supabaseAdmin.rpc('increment_download_count', {
                p_order_id: order.id
            });
            if (!rpcErr) {
                rpcOk = true;
                const row = Array.isArray(data) ? data[0] : data;
                if (row && Number.isFinite(Number(row.download_count))) {
                    newCount = Number(row.download_count);
                }
            } else if (!/function|does not exist|schema cache/i.test(String(rpcErr.message))) {
                console.warn(`[TX/download] increment RPC failed reqId=${reqId}:`, rpcErr.message);
            }
        } catch (rpcErr) {
            console.warn(`[TX/download] increment RPC threw reqId=${reqId}:`, rpcErr.message);
        }

        if (!rpcOk) {
            const { error: updErr } = await supabaseAdmin
                .from('marketplace_orders')
                .update({
                    download_count: newCount,
                    last_download_at: new Date().toISOString()
                })
                .eq('id', order.id)
                .eq('download_count', order.download_count);
            if (updErr) {
                console.warn(`[TX/download] fallback update failed reqId=${reqId}:`, updErr.message);
            }
        }

        return res.json({
            success: true,
            download_token: order.download_token,
            product_name: order.product_title || 'Product',
            download_count: newCount,
            message: 'Download initiated successfully'
        });
    } catch (e) {
        console.error(`❌ /download reqId=${reqId}:`, e);
        return res.status(500).json({ success: false, code: 'DOWNLOAD_FAILED' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /export/csv
// ═══════════════════════════════════════════════════════════════════
router.get('/export/csv', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { currency = 'all' } = req.query;
        let fromDate = null;
        let toDate = null;

        if (req.query.from) {
            const d = new Date(req.query.from);
            if (isNaN(d.getTime())) {
                return res.status(400).json({ success: false, code: 'INVALID_FROM', error: 'Invalid "from" date.' });
            }
            fromDate = d;
        }
        if (req.query.to) {
            const d = new Date(req.query.to);
            if (isNaN(d.getTime())) {
                return res.status(400).json({ success: false, code: 'INVALID_TO', error: 'Invalid "to" date.' });
            }
            toDate = d;
        }

        if (fromDate && toDate) {
            const days = (toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000);
            if (days > EXPORT_MAX_DAYS) {
                return res.status(400).json({
                    success: false,
                    code: 'EXPORT_WINDOW_TOO_LARGE',
                    error: `Export window cannot exceed ${EXPORT_MAX_DAYS} days.`
                });
            }
        }

        let q = supabaseAdmin
            .from('transactions')
            .select('ref, reference, type, status, currency, amount, amount_ngn, amount_usd, fee, revenue_ngn, revenue_usd, description, created_at')
            .eq('user_id', userId)
            .in('type', SERVICE_TYPES)
            .order('created_at', { ascending: false })
            .limit(EXPORT_MAX_ROWS);

        if (currency && currency !== 'all') q = q.eq('currency', currency);
        if (fromDate) q = q.gte('created_at', fromDate.toISOString());
        if (toDate) {
            const end = new Date(toDate.getTime());
            end.setDate(end.getDate() + 1);
            q = q.lt('created_at', end.toISOString());
        }

        const { data: transactions, error: txErr } = await q;
        if (txErr) {
            console.error('[TX/export] transactions query error:', txErr.message);
            return res.status(503).json({
                success: false,
                code: 'EXPORT_SOURCE_UNAVAILABLE',
                error: 'Could not load transactions for export.'
            });
        }

        let aq = supabaseAdmin
            .from('airtime_transactions')
            .select('reference, status, currency, total_amount, fee, country_code, phone_number, operator_name, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(EXPORT_MAX_ROWS);

        if (currency && currency !== 'all') aq = aq.eq('currency', currency);
        if (fromDate) aq = aq.gte('created_at', fromDate.toISOString());
        if (toDate) {
            const end = new Date(toDate.getTime());
            end.setDate(end.getDate() + 1);
            aq = aq.lt('created_at', end.toISOString());
        }

        const { data: airtimeTx, error: airErr } = await aq;
        if (airErr && airErr.code !== '42P01') {
            console.error('[TX/export] airtime query error:', airErr.message);
        }

        let bq = supabaseAdmin
            .from('bill_payment_transactions')
            .select('reference, service_type, status, currency, customer_amount, base_amount, service_fee, network, recipient, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(EXPORT_MAX_ROWS);

        if (currency && currency !== 'all') bq = bq.eq('currency', currency);
        if (fromDate) bq = bq.gte('created_at', fromDate.toISOString());
        if (toDate) {
            const end = new Date(toDate.getTime());
            end.setDate(end.getDate() + 1);
            bq = bq.lt('created_at', end.toISOString());
        }

        const { data: billTx, error: billErr } = await bq;
        if (billErr && billErr.code !== '42P01') {
            console.error('[TX/export] bills query error:', billErr.message);
        }

        let gq = supabaseAdmin
            .from('giftcard_transactions')
            .select('reference, status, currency, amount, fee, card_name, face_value, face_currency, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(EXPORT_MAX_ROWS);

        if (currency && currency !== 'all') gq = gq.eq('currency', currency);
        if (fromDate) gq = gq.gte('created_at', fromDate.toISOString());
        if (toDate) {
            const end = new Date(toDate.getTime());
            end.setDate(end.getDate() + 1);
            gq = gq.lt('created_at', end.toISOString());
        }

        const { data: giftTx, error: giftErr } = await gq;
        if (giftErr && giftErr.code !== '42P01') {
            console.error('[TX/export] giftcard query error:', giftErr.message);
        }

        const mainRows = (transactions || []).map(t => {
            const currency2 = up(t.currency || 'NGN');
            return {
                reference: t.ref || t.reference || '',
                type: t.type || '',
                status: toCustomerStatus(t.status),
                currency: currency2,
                amount: amountForCurrency(t, currency2),
                fee: feeForCurrency(t, currency2),
                description: customerSafeDescription(t, t.description),
                created_at: t.created_at ? new Date(t.created_at).toISOString() : ''
            };
        });

        const airRows = (airtimeTx || []).map(a => {
            const currency2 = up(a.currency || 'USD');
            return {
                reference: a.reference || '',
                type: 'airtime',
                status: toCustomerStatus(a.status),
                currency: currency2,
                amount: amountForCurrency(a, currency2),
                fee: feeForCurrency(a, currency2),
                description: customerSafeDescription(
                    { type: 'airtime', country_code: a.country_code, phone_number: a.phone_number },
                    'Airtime'
                ),
                created_at: a.created_at ? new Date(a.created_at).toISOString() : ''
            };
        });

        const billExportRows = (billTx || []).map(b => {
            const currency2 = up(b.currency || 'NGN');
            const serviceType = lower(b.service_type) || 'bills';
            const amount = num(b.customer_amount) || amountForCurrency(b, currency2);
            const fee = num(b.service_fee);
            return {
                reference: b.reference || '',
                type: serviceType,
                status: toCustomerStatus(b.status),
                currency: currency2,
                amount,
                fee,
                description: customerSafeDescription(
                    {
                        type: serviceType,
                        network: b.network,
                        recipient: b.recipient,
                        phone_number: b.recipient
                    },
                    `${serviceType} purchase`
                ),
                created_at: b.created_at ? new Date(b.created_at).toISOString() : ''
            };
        });

        const giftExportRows = (giftTx || []).map(g => {
            const currency2 = up(g.currency || 'USD');
            return {
                reference: g.reference || '',
                type: 'giftcard',
                status: toCustomerStatus(g.status),
                currency: currency2,
                amount: amountForCurrency(g, currency2),
                fee: feeForCurrency(g, currency2),
                description: customerSafeDescription(
                    { type: 'giftcard', card_name: g.card_name },
                    'Gift card'
                ),
                created_at: g.created_at ? new Date(g.created_at).toISOString() : ''
            };
        });

        const all = [...mainRows, ...airRows, ...billExportRows, ...giftExportRows]
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, EXPORT_MAX_ROWS);

        if (all.length === 0) {
            return res.status(404).json({
                success: false,
                code: 'NO_TRANSACTIONS',
                error: 'No transactions found for export'
            });
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename=milesspace-transactions-${Date.now()}.csv`
        );

        res.write(
            ['Reference', 'Type', 'Status', 'Currency', 'Amount', 'Fee', 'Description', 'Date']
                .map(csvCell)
                .join(',') + '\n'
        );

        for (const t of all) {
            res.write(
                [
                    csvCell(t.reference),
                    csvCell(t.type),
                    csvCell(t.status),
                    csvCell(t.currency),
                    csvCell(num(t.amount).toFixed(2)),
                    csvCell(num(t.fee).toFixed(2)),
                    csvCell(t.description),
                    csvCell(t.created_at)
                ].join(',') + '\n'
            );
        }

        return res.end();
    } catch (error) {
        console.error('❌ CSV export error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                code: 'CSV_EXPORT_FAILED',
                error: error.message || 'CSV export failed'
            });
        } else {
            res.end();
        }
    }
});

// ═══════════════════════════════════════════════════════════════════
//  GET /:id  — MUST BE REGISTERED LAST
// ═══════════════════════════════════════════════════════════════════
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        if (!id || id.length > 200) {
            return res.status(400).json({ success: false, error: 'Invalid id' });
        }

        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

        if (isUuid) {
            const { data: transaction } = await supabaseAdmin
                .from('transactions')
                .select('*')
                .eq('id', id)
                .eq('user_id', userId)
                .in('type', SERVICE_TYPES)
                .maybeSingle();

            if (transaction) {
                return res.json({ success: true, transaction: toCustomer(mapTransaction(transaction)) });
            }
        }

        const { data: byRef } = await supabaseAdmin
            .from('transactions')
            .select('*')
            .or(`ref.eq.${id},reference.eq.${id}`)
            .eq('user_id', userId)
            .in('type', SERVICE_TYPES)
            .maybeSingle();

        if (byRef) {
            return res.json({ success: true, transaction: toCustomer(mapTransaction(byRef)) });
        }

        if (isUuid) {
            const { data: order } = await supabaseAdmin
                .from('marketplace_orders')
                .select('*')
                .eq('id', id)
                .eq('user_id', userId)
                .maybeSingle();

            if (order) {
                const linkMap = await attachLinkedTransactions(userId, [order]);
                const linkedTx = linkMap.get(String(order.id)) || linkMap.get(String(order.order_ref)) || null;
                return res.json({ success: true, transaction: toCustomer(mapMarketplace(order, linkedTx)) });
            }
        }

        const { data: orderByRef } = await supabaseAdmin
            .from('marketplace_orders')
            .select('*')
            .eq('order_ref', id)
            .eq('user_id', userId)
            .maybeSingle();

        if (orderByRef) {
            const linkMap = await attachLinkedTransactions(userId, [orderByRef]);
            const linkedTx = linkMap.get(String(orderByRef.id)) || linkMap.get(String(orderByRef.order_ref)) || null;
            return res.json({ success: true, transaction: toCustomer(mapMarketplace(orderByRef, linkedTx)) });
        }

        if (isUuid) {
            const { data: airtime } = await supabaseAdmin
                .from('airtime_transactions')
                .select('*')
                .eq('id', id)
                .eq('user_id', userId)
                .maybeSingle();

            if (airtime) {
                return res.json({ success: true, transaction: toCustomer(mapAirtimeToTransaction(airtime)) });
            }
        }

        const { data: airtimeByRef } = await supabaseAdmin
            .from('airtime_transactions')
            .select('*')
            .eq('reference', id)
            .eq('user_id', userId)
            .maybeSingle();

        if (airtimeByRef) {
            return res.json({ success: true, transaction: toCustomer(mapAirtimeToTransaction(airtimeByRef)) });
        }

        if (isUuid) {
            const { data: bill } = await supabaseAdmin
                .from('bill_payment_transactions')
                .select('*')
                .eq('id', id)
                .eq('user_id', userId)
                .maybeSingle();

            if (bill) {
                return res.json({ success: true, transaction: toCustomer(mapBillPaymentToTransaction(bill)) });
            }
        }

        const { data: billByRef } = await supabaseAdmin
            .from('bill_payment_transactions')
            .select('*')
            .eq('reference', id)
            .eq('user_id', userId)
            .maybeSingle();

        if (billByRef) {
            return res.json({ success: true, transaction: toCustomer(mapBillPaymentToTransaction(billByRef)) });
        }

        if (isUuid) {
            const { data: gift } = await supabaseAdmin
                .from('giftcard_transactions')
                .select('*')
                .eq('id', id)
                .eq('user_id', userId)
                .maybeSingle();

            if (gift) {
                return res.json({ success: true, transaction: toCustomer(mapGiftCardToTransaction(gift)) });
            }
        }

        const { data: giftByRef } = await supabaseAdmin
            .from('giftcard_transactions')
            .select('*')
            .eq('reference', id)
            .eq('user_id', userId)
            .maybeSingle();

        if (giftByRef) {
            return res.json({ success: true, transaction: toCustomer(mapGiftCardToTransaction(giftByRef)) });
        }

        return res.status(404).json({
            success: false,
            code: 'TRANSACTION_NOT_FOUND',
            error: 'Transaction not found'
        });
    } catch (error) {
        console.error('❌ Transaction detail error:', error);
        res.status(500).json({
            success: false,
            code: 'TRANSACTION_DETAIL_FAILED',
            error: error.message || 'Failed to load transaction'
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  STATS HELPER
// ═══════════════════════════════════════════════════════════════════
function calculateStats(rows) {
    let giftOrders = 0, marketOrders = 0, boostOrders = 0;
    let smsOrders = 0, airtimeOrders = 0, esimOrders = 0;
    let totalOrders = 0;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let monthlyCount = 0;

    (rows || []).forEach(t => {
        const type = lower(t.type);

        if (['giftcard', 'gift_card', 'gift'].includes(type)) giftOrders++;
        if (['marketplace', 'purchase'].includes(type)) marketOrders++;
        if (type === 'boost') boostOrders++;
        if (type === 'virtual_sms') smsOrders++;
        if (type === 'airtime') airtimeOrders++;
        if (type === 'esim') esimOrders++;

        if ([
            'giftcard', 'gift_card', 'gift',
            'marketplace', 'purchase',
            'boost', 'virtual_sms', 'airtime', 'esim',
            'data', 'electricity', 'tv', 'bills'
        ].includes(type)) {
            totalOrders++;
        }

        if (t.created_at && new Date(t.created_at) >= monthStart) monthlyCount++;
    });

    return {
        totalTransactions: (rows || []).length,
        giftOrders,
        marketOrders,
        boostOrders,
        smsOrders,
        airtimeOrders,
        esimOrders,
        totalOrders,
        monthlyCount
    };
}

module.exports = router;