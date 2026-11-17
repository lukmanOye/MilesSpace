// services/reportsService.js
'use strict';

const { supabaseAdmin } = require('../db/supabase');

// ─── Helpers ────────────────────────────────────────────────────────────────

function normCcy(c) {
    const u = String(c || 'NGN').toUpperCase().trim();
    return (u === 'NGN' || u === 'USD') ? u : 'NGN';
}
function fmtMoney(n) { return Number(n || 0).toFixed(2); }
function pctChange(curr, prev) {
    if (!prev || Number(prev) === 0) return null;
    return Math.round(((Number(curr) - Number(prev)) / Number(prev)) * 10000) / 100;
}
function hasPerm(ctx, key) {
    if (!ctx || !ctx.permissions) return false;
    const p = ctx.permissions;
    if (p === '*') return true;
    if (Array.isArray(p)) return p.includes('*') || p.includes(key);
    if (p instanceof Set) return p.has('*') || p.has(key);
    if (typeof p === 'object') return !!p[key] || !!p['*'];
    return false;
}
function watBounds() {
    const now = new Date();
    const watOffset = 1 * 60 * 60 * 1000;
    const local = new Date(now.getTime() + watOffset);
    const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
    return new Date(Date.UTC(y, m, d, 0, 0, 0) - watOffset).toISOString();
}
function getScope(query) {
    let from, to;
    const now = new Date();

    // 1. If explicit dates are provided (Custom range)
    if (query.from && query.to) {
        from = query.from;
        to = query.to;
    } 
    // 2. If a preset is provided
    else if (query.preset) {
        const p = String(query.preset).toLowerCase();
        const watOffset = 1 * 60 * 60 * 1000;
        const local = new Date(now.getTime() + watOffset);
        const y = local.getUTCFullYear();
        const m = local.getUTCMonth();
        const d = local.getUTCDate();

        if (p === 'today') {
            from = new Date(Date.UTC(y, m, d, 0, 0, 0) - watOffset).toISOString();
            to = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - watOffset).toISOString();
        } else if (p === 'yesterday') {
            from = new Date(Date.UTC(y, m, d - 1, 0, 0, 0) - watOffset).toISOString();
            to = new Date(Date.UTC(y, m, d - 1, 23, 59, 59, 999) - watOffset).toISOString();
        } else if (p === '7d') {
            from = new Date(Date.UTC(y, m, d - 6, 0, 0, 0) - watOffset).toISOString();
            to = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - watOffset).toISOString();
        } else if (p === '30d') {
            from = new Date(Date.UTC(y, m, d - 29, 0, 0, 0) - watOffset).toISOString();
            to = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - watOffset).toISOString();
        } else if (p === 'thismonth') {
            from = new Date(Date.UTC(y, m, 1, 0, 0, 0) - watOffset).toISOString();
            to = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - watOffset).toISOString();
        } else if (p === 'lastmonth') {
            from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - watOffset).toISOString();
            to = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999) - watOffset).toISOString(); // Day 0 is last day of prev month
        }
    }

    // 3. Fallback to today if somehow neither is set
    if (!from || !to) {
        const watOffset = 1 * 60 * 60 * 1000;
        const local = new Date(now.getTime() + watOffset);
        const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
        from = new Date(Date.UTC(y, m, d, 0, 0, 0) - watOffset).toISOString();
        to = new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - watOffset).toISOString();
    }

    const ccy = query.currency === 'NGN' || query.currency === 'USD' ? query.currency : null;
    return { from, to, currency: ccy };
}

const cache = new Map();
const CACHE_TTL = 30_000;

// ─── Meta ───────────────────────────────────────────────────────────────────

async function getMeta(ctx) {
    let fx = null;
    try {
        const r = await supabaseAdmin.rpc('revenue_meta');
        if (r.data) fx = String(Array.isArray(r.data) ? r.data[0].usd_to_ngn : r.data.usd_to_ngn);
    } catch (_) {}

    // Safe default
    let types = [];
    try {
        const m = require('./transactionTypes');
        if (m && typeof m.publicList === 'function') {
            types = m.publicList();
        } else if (m && Array.isArray(m.TYPES)) {
            types = m.TYPES;
        } else {
            // Fallback if transactionTypes is shaped weirdly
            types = ['wallet_debit', 'wallet_credit', 'deposit', 'withdrawal', 'refund'];
        }
    } catch (_) {
        types = ['wallet_debit', 'wallet_credit', 'deposit', 'withdrawal', 'refund'];
    }

    let providers = [];
    try {
        const r = await supabaseAdmin.rpc('reports_distinct_providers');
        if (!r.error && Array.isArray(r.data)) providers = r.data.map(x => x.provider).filter(Boolean).sort();
    } catch (_) {}

    let products = [];
    try {
        const r = await supabaseAdmin.rpc('reports_distinct_products');
        if (!r.error && Array.isArray(r.data)) products = r.data.map(x => x.product_type).filter(Boolean).sort();
    } catch (_) {}

    return {
        available: true,
        can_reveal_pii: hasPerm(ctx, 'users.pii_reveal'),
        fx_rate: fx || '1600',
        transaction_types: types, // guaranteed array
        providers: providers,     // guaranteed array
        product_types: products   // guaranteed array
    };
}

// ─── Overview ───────────────────────────────────────────────────────────────

async function getOverview(query, ctx) {
    const scope = getScope(query);
    const prevFrom = new Date(new Date(scope.from).getTime() - (new Date(scope.to).getTime() - new Date(scope.from).getTime())).toISOString();
    const cacheKey = JSON.stringify(scope);
    
    if (!query.fresh && cache.has(cacheKey)) {
        const c = cache.get(cacheKey);
        if (Date.now() - c.at < CACHE_TTL) return c.val;
    }

    const [revR, prevRevR, fundR, refundR, activeR, newR, byProdR, byProvR] = await Promise.all([
        supabaseAdmin.rpc('revenue_summary', { p_from: scope.from, p_to: scope.to, p_currency: scope.currency }),
        supabaseAdmin.rpc('revenue_summary', { p_from: prevFrom, p_to: scope.from, p_currency: scope.currency }),
        supabaseAdmin.rpc('revenue_funding_summary', { p_from: scope.from, p_to: scope.to, p_currency: scope.currency }),
        supabaseAdmin.rpc('reports_refunds_summary', { p_from: scope.from, p_to: scope.to }),
        supabaseAdmin.rpc('reports_active_customers', { p_from: scope.from, p_to: scope.to, p_currency: scope.currency }),
        supabaseAdmin.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', scope.from).lte('created_at', scope.to),
        supabaseAdmin.rpc('revenue_by_product', { p_from: scope.from, p_to: scope.to, p_currency: scope.currency }),
        supabaseAdmin.rpc('reports_provider_performance', { p_from: scope.from, p_to: scope.to })
    ]);

    let revenue = { available: true, byCurrency: [] };
    if (!revR.error) {
        const cur = revR.data || [];
        const prv = (!prevRevR.error && prevRevR.data) ? prevRevR.data : [];
        
        revenue.byCurrency = cur.map(r => {
            const ccy = normCcy(r.currency);
            return {
                currency: ccy,
                gross: fmtMoney(r.gross_revenue),
                net: fmtMoney(r.net_revenue),
                refunds: fmtMoney(r.refunds),
                providerCost: fmtMoney(r.provider_cost),
                profit: fmtMoney(r.gross_profit),
                orders: Number(r.total_orders),
                completed: Number(r.completed_orders),
                failed: Number(r.failed_orders),
                changePct: pctChange(r.gross_revenue, (prv.find(p => normCcy(p.currency) === ccy) || {}).gross_revenue),
                marginPct: Number(r.gross_revenue) > 0 ? (Number(r.gross_profit) / Number(r.gross_revenue)) * 100 : 0,
                costCoverage: Number(r.cost_coverage_pct),
                estimated: Boolean(r.is_estimated),
                costUnconvertible: Number(r.cost_unconvertible_orders || 0)
            };
        });
    } else {
        revenue = { available: false, reason: revR.error.message };
    }

    let funding = { available: true, byCurrency: [] };
    if (!fundR.error) {
        funding.byCurrency = (fundR.data || []).map(r => ({
            currency: normCcy(r.currency),
            count: Number(r.deposits_count),
            total: fmtMoney(r.deposits_total),
            average: fmtMoney(r.avg_deposit),
            largest: fmtMoney(r.largest_deposit)
        }));
    } else {
        funding = { available: false, reason: fundR.error.message };
    }

    let refunds = { available: true, byCurrency: [] };
    if (!refundR.error) {
        refunds.byCurrency = (refundR.data || []).map(r => ({
            currency: normCcy(r.currency),
            count: Number(r.count),
            amount: fmtMoney(r.amount)
        }));
    } else {
        refunds = { available: false, reason: refundR.error.message };
    }

    let customers = { available: true, byCurrency: [] };
    if (!activeR.error) {
        customers.byCurrency = (activeR.data || []).map(r => ({
            currency: normCcy(r.currency),
            active: Number(r.active_customers)
        }));
        customers.newCustomers = newR.count || 0;
    } else {
        customers = { available: false, reason: activeR.error.message };
    }

    const byProduct = (!byProdR.error && byProdR.data) ? byProdR.data.slice(0, 10).map(r => ({ ...r, currency: normCcy(r.currency) })) : [];
    const byProvider = (!byProvR.error && byProvR.data) ? byProvR.data.slice(0, 10).map(r => ({ ...r, currency: normCcy(r.currency) })) : [];

    const res = {
        available: true,
        period: { from: scope.from, to: scope.to, label: 'custom' },
        revenue, funding, refunds, customers,
        by_product: byProduct,
        by_provider: byProvider
    };

    cache.set(cacheKey, { val: res, at: Date.now() });
    return res;
}

// ─── Timeseries ─────────────────────────────────────────────────────────────

async function getTimeseries(query) {
    const scope = getScope(query);
    const granularity = ['day', 'week', 'month'].includes(String(query.granularity)) ? String(query.granularity) : 'day';
    const r = await supabaseAdmin.rpc('revenue_timeseries', {
        p_from: scope.from, p_to: scope.to, p_granularity: granularity, p_currency: scope.currency
    });
    if (r.error) return { available: false, reason: r.error.message };

    return {
        available: true,
        points: (r.data || []).map(p => ({
            bucket: p.bucket,
            currency: normCcy(p.currency),
            revenue: fmtMoney(p.revenue),
            profit: fmtMoney(p.profit),
            refunds: fmtMoney(p.refunds),
            orders: Number(p.orders)
        }))
    };
}

// ─── Providers ──────────────────────────────────────────────────────────────

async function getProviders(query) {
    const scope = getScope(query);
    const r = await supabaseAdmin.rpc('reports_provider_performance', { p_from: scope.from, p_to: scope.to });
    
    if (r.error) return { available: false, reason: r.error.message };

    const grouped = new Map();
    for (const row of r.data) {
        const ccy = normCcy(row.currency);
        const key = `${row.provider}::${ccy}`;
        
        const total = Number(row.total_orders);
        const comp = Number(row.completed_orders);
        const fail = Number(row.failed_orders);
        const sample = comp + fail;
        
        let sr = 0;
        if (sample > 0) sr = (comp / sample) * 100;
        
        grouped.set(key, {
            provider: row.provider,
            currency: ccy,
            orders: total,
            completed: comp,
            failed: fail,
            revenue: fmtMoney(row.revenue),
            providerCost: fmtMoney(row.provider_cost),
            profit: fmtMoney(row.profit),
            successRate: sr,
            lowVolume: sample < 10
        });
    }

    return { available: true, providers: [...grouped.values()] };
}

// ─── Products ───────────────────────────────────────────────────────────────

async function getProducts(query) {
    const scope = getScope(query);
    const r = await supabaseAdmin.rpc('revenue_by_product', { p_from: scope.from, p_to: scope.to, p_currency: scope.currency });
    if (r.error) return { available: false, reason: r.error.message };

    const byCurrency = new Map();
    for (const row of (r.data || [])) {
        const ccy = normCcy(row.currency);
        if (!byCurrency.has(ccy)) byCurrency.set(ccy, { currency: ccy, totalRevenue: 0, rows: [] });
        const acc = byCurrency.get(ccy);
        acc.totalRevenue += Number(row.revenue || 0);
        acc.rows.push({
            product: row.product,
            currency: ccy,
            orders: Number(row.orders || 0),
            revenue: fmtMoney(row.revenue),
            providerCost: fmtMoney(row.provider_cost),
            refunds: fmtMoney(row.refunds),
            profit: fmtMoney(row.profit),
            marginPct: Number(row.margin_pct || 0)
        });
    }

    const products = [];
    for (const acc of byCurrency.values()) {
        for (const row of acc.rows) {
            row.share_pct = acc.totalRevenue > 0 ? (Number(row.revenue) / acc.totalRevenue) * 100 : 0;
            products.push(row);
        }
    }

    return { available: true, products };
}

// ─── Customers ──────────────────────────────────────────────────────────────

async function getCustomers(query, ctx) {
    const scope = getScope(query);
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit) || 25));
    const offset = (page - 1) * limit;
    
    const r = await supabaseAdmin.rpc('revenue_top_customers', {
        p_from: scope.from, p_to: scope.to, p_currency: scope.currency, p_limit: 5000
    });
    if (r.error) return { available: false, reason: r.error.message };

    const sorted = (r.data || []).sort((a, b) => Number(b.spent || 0) - Number(a.spent || 0));
    const paged = sorted.slice(offset, offset + limit);
    const userIds = paged.map(r => r.user_id).filter(Boolean);
    
    let profilesById = {};
    if (userIds.length) {
        const { data: profiles } = await supabaseAdmin.from('profiles').select('id, username, email, created_at, status').in('id', userIds);
        (profiles || []).forEach(p => { profilesById[p.id] = p; });
    }

    const canReveal = hasPerm(ctx, 'users.pii_reveal');
    const customers = paged.map(c => {
        const p = profilesById[c.user_id] || {};
        let email = p.email || '';
        if (!canReveal && email) email = email.substring(0, 2) + '***' + email.substring(email.indexOf('@'));
        
        return {
            user: {
                id: c.user_id,
                username: p.username || (p.email ? String(p.email).split('@')[0] : 'User'),
                email: email,
                created_at: p.created_at || null,
                status: p.status || null
            },
            currency: normCcy(c.currency),
            orders: Number(c.orders),
            spent: fmtMoney(c.spent),
            refunded: fmtMoney(c.refunded),
            netSpend: fmtMoney(c.net_spend),
            lastOrder: c.last_order
        };
    });

    return {
        available: true,
        customers,
        summary: { total_customers: sorted.length, new_customers: 0 },
        pagination: { page, limit, total: sorted.length, totalPages: Math.ceil(sorted.length / limit) }
    };
}

// ─── Transactions ───────────────────────────────────────────────────────────

async function getTransactions(query, ctx) {
    const scope = getScope(query);
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(query.limit) || 25));
    const sort = ['created_at','amount'].includes(query.sort) ? query.sort : 'created_at';
    const asc = query.order === 'asc';
    
    let q = supabaseAdmin.from('transactions')
        .select('id, user_id, type, status, currency, amount, fee, reference, provider, provider_reference, created_at', { count: 'exact' })
        .gte('created_at', scope.from).lte('created_at', scope.to)
        .order(sort, { ascending: asc })
        .range((page - 1) * limit, page * limit - 1);

    if (scope.currency) q = q.eq('currency', scope.currency);
    if (query.type && query.type !== 'all') q = q.eq('type', query.type);
    if (query.status && query.status !== 'all') q = q.eq('status', query.status);
    if (query.search) q = q.ilike('reference', `%${query.search}%`);

    const { data, count, error } = await q;
    if (error) return { available: false, reason: error.message };

    const userIds = [...new Set((data || []).map(t => t.user_id).filter(Boolean))];
    let profilesById = {};
    if (userIds.length) {
        const { data: profiles } = await supabaseAdmin.from('profiles').select('id, username, email').in('id', userIds);
        (profiles || []).forEach(p => { profilesById[p.id] = p; });
    }

    const canReveal = hasPerm(ctx, 'users.pii_reveal');
    const transactions = (data || []).map(t => {
        const p = profilesById[t.user_id] || {};
        const raw = Number(t.amount);
        let email = p.email || '';
        if (!canReveal && email) email = email.substring(0, 2) + '***' + email.substring(email.indexOf('@'));
        
        return {
            id: t.id,
            reference: t.reference,
            user: { id: t.user_id, username: p.username || 'User', email: email },
            type: t.type,
            status: t.status,
            currency: normCcy(t.currency),
            direction: raw >= 0 ? 'credit' : 'debit',
            absolute_amount: fmtMoney(Math.abs(raw)),
            signed_amount: fmtMoney(raw),
            fee: fmtMoney(t.fee),
            provider: t.provider,
            providerReference: t.provider_reference,
            createdAt: t.created_at
        };
    });

    return {
        available: true,
        transactions,
        pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) }
    };
}

// ─── Export ─────────────────────────────────────────────────────────────────

async function exportReport({ report, query }) {
    if (report === 'transactions') {
        const r = await getTransactions({ ...query, limit: 5000 }, {});
        if (!r.available) throw new Error(r.reason);
        const lines = ['ID,Reference,Type,Status,Currency,Amount,Created'];
        for (const t of r.transactions) {
            lines.push(`${t.id},${t.reference},${t.type},${t.status},${t.currency},${t.signed_amount},${t.createdAt}`);
        }
        return { csv: lines.join('\n'), row_count: r.transactions.length, truncated: false };
    }
    throw new Error('Invalid report kind');
}

module.exports = { getMeta, getOverview, getTimeseries, getProviders, getProducts, getCustomers, getTransactions, exportReport };