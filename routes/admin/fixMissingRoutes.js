// routes/admin/fixMissingRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../../db/supabase');
const { requirePermission, PERMISSIONS } = require('../../middleware/adminAuth');

// ═══════════════════════════════════════════════════════════════════
//  GET /api/admin/deposits/stats
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/deposits/stats',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        try {
            const [koraCompleted, koraPending, koraFailed, cryptoCompleted, cryptoPending, cryptoManual] = await Promise.all([
                supabaseAdmin.from('deposit_requests').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
                supabaseAdmin.from('deposit_requests').select('id', { count: 'exact', head: true }).in('status', ['pending', 'processing']),
                supabaseAdmin.from('deposit_requests').select('id', { count: 'exact', head: true }).in('status', ['failed', 'expired', 'cancelled']),
                supabaseAdmin.from('crypto_deposits').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
                supabaseAdmin.from('crypto_deposits').select('id', { count: 'exact', head: true }).in('status', ['pending', 'processing', 'partially_paid']),
                supabaseAdmin.from('crypto_deposits').select('id', { count: 'exact', head: true }).eq('status', 'manual_review')
            ]);
            return res.json({
                success: true,
                stats: {
                    kora: { completed: koraCompleted.count || 0, pending: koraPending.count || 0, failed: koraFailed.count || 0 },
                    crypto: { completed: cryptoCompleted.count || 0, pending: cryptoPending.count || 0, manual_review: cryptoManual.count || 0 }
                }
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message });
        }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  GET /api/admin/deposits  (paginated list)
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/deposits',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        try {
            const page = Math.max(1, parseInt(req.query.page) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
            const from = (page - 1) * limit;
            const to = from + limit - 1;

            let koraQ = supabaseAdmin.from('deposit_requests').select('*', { count: 'exact' });
            let cryptoQ = supabaseAdmin.from('crypto_deposits').select('*', { count: 'exact' });

            if (req.query.status && req.query.status !== 'all') {
                koraQ = koraQ.eq('status', req.query.status);
                cryptoQ = cryptoQ.eq('status', req.query.status);
            }
            if (req.query.search) {
                koraQ = koraQ.or(`internal_reference.ilike.%${req.query.search}%,provider_reference.ilike.%${req.query.search}%`);
                cryptoQ = cryptoQ.or(`nowpayments_payment_id.ilike.%${req.query.search}%`);
            }
            if (req.query.from) {
                koraQ = koraQ.gte('created_at', req.query.from);
                cryptoQ = cryptoQ.gte('created_at', req.query.from);
            }
            if (req.query.to) {
                koraQ = koraQ.lte('created_at', req.query.to);
                cryptoQ = cryptoQ.lte('created_at', req.query.to);
            }

            const [kora, crypto] = await Promise.all([koraQ, cryptoQ]);
            const allDeposits = [
                ...(kora.data || []).map(d => ({ ...d, source: 'kora', reference: d.internal_reference, provider_reference: d.provider_reference })),
                ...(crypto.data || []).map(d => ({ ...d, source: 'crypto', reference: d.nowpayments_payment_id, provider_reference: d.nowpayments_payment_id }))
            ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            const totalCount = allDeposits.length;
            const paginated = allDeposits.slice(from, to + 1);

            // Enrich with user info
            const userIds = [...new Set(paginated.map(d => d.user_id).filter(Boolean))];
            let profilesById = {};
            if (userIds.length) {
                const { data: profiles } = await supabaseAdmin.from('profiles').select('id, username, email').in('id', userIds);
                (profiles || []).forEach(p => { profilesById[p.id] = p; });
            }

            const deposits = paginated.map(d => {
                const p = profilesById[d.user_id] || {};
                return {
                    id: d.id,
                    source: d.source,
                    reference: d.reference,
                    user: { username: p.username || 'User', email: p.email || '' },
                    method: d.source === 'kora' ? 'KoraPay' : 'NowPayments',
                    payment_amount: d.payment_amount || d.requested_usd || null,
                    payment_currency: d.payment_currency || 'USD',
                    wallet_amount: d.wallet_amount || d.credited_amount || d.requested_usd || null,
                    wallet_currency: d.wallet_currency || 'USD',
                    customer_rate: d.customer_rate || null,
                    fee_amount: d.fee_amount || d.fee_usd || null,
                    fee_currency: d.fee_currency || 'USD',
                    status: d.status,
                    created_at: d.created_at
                };
            });

            return res.json({
                success: true,
                deposits,
                count: totalCount,
                page,
                limit,
                totalPages: Math.ceil(totalCount / limit)
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message });
        }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  GET /api/admin/deposits/:source/:id
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/deposits/:source/:id',
    requirePermission(PERMISSIONS.DEPOSITS_READ),
    async (req, res) => {
        const { source, id } = req.params;
        try {
            const table = source === 'crypto' ? 'crypto_deposits' : 'deposit_requests';
            const { data: deposit, error } = await supabaseAdmin.from(table).select('*').eq('id', id).maybeSingle();
            if (error || !deposit) {
                return res.status(404).json({ success: false, error: 'Deposit not found.' });
            }
            const { data: profile } = await supabaseAdmin.from('profiles').select('id, username, email').eq('id', deposit.user_id).maybeSingle();
            return res.json({
                success: true,
                deposit,
                user: profile || { username: 'Unknown', email: '' },
                webhooks: [],
                transaction: null
            });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message });
        }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  GET /api/admin/ledger/balances
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/ledger/balances',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        try {
            const { data, error } = await supabaseAdmin.from('ledger_accounts').select('currency, available_balance, held_balance');
            if (error) throw error;
            const totals = {};
            for (const row of data || []) {
                const ccy = String(row.currency || 'NGN').toUpperCase();
                if (!totals[ccy]) totals[ccy] = { available: 0n, held: 0n };
                totals[ccy].available += BigInt(Math.round(Number(row.available_balance || 0) * 100));
                totals[ccy].held += BigInt(Math.round(Number(row.held_balance || 0) * 100));
            }
            const out = {};
            for (const [ccy, t] of Object.entries(totals)) {
                out[ccy] = {
                    available: (Number(t.available) / 100).toFixed(2),
                    held: (Number(t.held) / 100).toFixed(2),
                    total: (Number(t.available + t.held) / 100).toFixed(2)
                };
            }
            return res.json({ success: true, balances: out });
        } catch (e) {
            return res.status(500).json({ success: false, error: e.message });
        }
    }
);

// ═══════════════════════════════════════════════════════════════════
//  GET /api/admin/ledger  (paginated entries)
// ═══════════════════════════════════════════════════════════════════
router.get(
    '/ledger',
    requirePermission(PERMISSIONS.WALLETS_READ),
    async (req, res) => {
        try {
            const page = Math.max(1, parseInt(req.query.page) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
            const from = (page - 1) * limit;
            const to = from + limit - 1;

            // ── 1. Build the ledger query ────────────────────────
            // ledger_entries has: transaction_id, account_id, currency,
            // amount_minor, balance_before, balance_after, etc.
            // There is NO user_id. The user is on the linked transaction.
            let q = supabaseAdmin
                .from('ledger_entries')
                .select(`
                    id, account_id, transaction_id, entry_type, amount_minor,
                    currency, balance_before, balance_after, description, created_at
                `, { count: 'exact' })
                .order('created_at', { ascending: false })
                .range(from, to);

            if (req.query.currency && req.query.currency !== 'all') {
                q = q.eq('currency', req.query.currency.toUpperCase());
            }
            if (req.query.direction === 'credit') {
                q = q.gt('amount_minor', 0);
            }
            if (req.query.direction === 'debit') {
                q = q.lt('amount_minor', 0);
            }
            if (req.query.search) {
                q = q.ilike('description', `%${req.query.search}%`);
            }

            const { data: rows, count, error } = await q;
            if (error) throw error;

            if (!rows || rows.length === 0) {
                return res.json({
                    success: true, entries: [], count: 0,
                    page, limit, totalPages: 0
                });
            }

            // ── 2. Bulk-load transactions for those entries ──────
            const txIds = [...new Set(rows.map(r => r.transaction_id).filter(Boolean))];
            const { data: txRows } = await supabaseAdmin
                .from('transactions')
                .select('id, user_id, reference, customer_reference, type')
                .in('id', txIds);
            const txById = new Map((txRows || []).map(t => [t.id, t]));

            // ── 3. Bulk-load the user profiles for those txns ────
            const userIds = [...new Set((txRows || []).map(t => t.user_id).filter(Boolean))];
            let profilesById = new Map();
            if (userIds.length) {
                const { data: profiles } = await supabaseAdmin
                    .from('profiles')
                    .select('id, username, email')
                    .in('id', userIds);
                profilesById = new Map((profiles || []).map(p => [p.id, p]));
            }

            // ── 4. Shape the response ────────────────────────────
            const entries = rows.map(e => {
                const tx = e.transaction_id ? txById.get(e.transaction_id) : null;
                const profile = tx?.user_id ? profilesById.get(tx.user_id) : null;
                const minor = Number(e.amount_minor || 0);
                return {
                    id: e.id,
                    entry_type: e.entry_type,
                    direction: minor >= 0 ? 'credit' : 'debit',
                    amount: (Math.abs(minor) / 100).toFixed(2),
                    currency: e.currency,
                    balance_before: (Number(e.balance_before || 0) / 100).toFixed(2),
                    balance_after: (Number(e.balance_after || 0) / 100).toFixed(2),
                    description: e.description || '',
                    created_at: e.created_at,
                    transaction_reference: tx?.customer_reference || tx?.reference || '—',
                    user: {
                        username: profile?.username || 'Unknown',
                        email: profile?.email || ''
                    }
                };
            });

            return res.json({
                success: true,
                entries,
                count: count || 0,
                page,
                limit,
                totalPages: Math.ceil((count || 0) / limit)
            });
        } catch (e) {
            console.error('[LEDGER]', e.message);
            return res.status(500).json({ success: false, error: 'Failed to load ledger entries.' });
        }
    }
);

module.exports = router;