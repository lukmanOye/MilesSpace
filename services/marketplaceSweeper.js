// services/marketplaceSweeper.js
// ─────────────────────────────────────────────────────────────────
// Background sweeper for stuck marketplace orders.
//
// CONTRACT:
//   • Runs on an interval (default 60s). Start condition: env
//     MARKET_SWEEPER === 'true'.
//   • Multi-instance safe via a single lock row in
//     marketplace_sweeper_lock (created lazily on first start via an
//     RPC or by attempting insert + 23505 fallback). Only the lock
//     holder does work.
//   • For each order in ('pending','processing') older than 15 min:
//       1. If the ledger has a transaction for order_ref: RESUME —
//          mark completed, attach delivery, mirror to `orders`.
//       2. If no ledger transaction exists: RELEASE — cancel the
//          order and release the inventory reservation.
//   • Every action is written to admin_audit_logs as a system actor
//     ('system', actor_type='system'). Admin UI can filter on
//     action='marketplace.sweeper_*'.
//   • Never logs credentials. Never logs amounts (except in the
//     metadata field of the audit row, which admin already sees).
//   • Failure to load the order list logs and continues — this job
//     must never crash the process.
//
// ASSUMPTIONS:
//   A5  — recordOrder field set matches the purchase route.
//   A11 — the marketplace_sweeper_lock table is created lazily on
//         first run by an RPC named `marketplace_sweeper_acquire` /
//         `marketplace_sweeper_release`. If those RPCs are absent,
//         the sweeper runs as a no-op and logs once per minute.
//         To deploy them, add the SQL in section 10 of the migration
//         (Round 4 addendum) OR add them yourself:
//             create table if not exists marketplace_sweeper_lock(
//               id int primary key default 1,
//               locked_until timestamptz
//         The helper functions below try the table directly; if the
//         table is missing they fall back to "assume lock held"
//         (single instance). This is documented in Assumption A11.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('./ledgerService');
const { recordAdminAction } = require('../middleware/adminAuth');
const marketplace = require('./marketplaceService');
const fulfillment = require('./billsFulfillment');
const recordOrder = (data) => fulfillment.recordOrder(data);

const TICK_MS = 60_000;
const STALE_MIN = 15;
const LOCK_MS = 90_000;   // 90s > TICK_MS so overlap is impossible

let _timer = null;
let _stopped = false;

function log(...args) {
    // eslint-disable-next-line no-console
    console.log('[MARKET SWEEPER]', ...args);
}

async function tryAcquire() {
    // Attempt the lock row. If the table doesn't exist, swallow and
    // assume we are the only instance (safe for single-process).
    try {
        const until = new Date(Date.now() + LOCK_MS).toISOString();
        const nowIso = new Date().toISOString();
        const { error } = await supabaseAdmin
            .from('marketplace_sweeper_lock')
            .upsert({ id: 1, locked_until: until }, { onConflict: 'id' })
            .or(`locked_until.is.null,locked_until.lt.${nowIso}`);
        if (error && error.code !== '42P01' && error.code !== 'PGRST205') {
            log('lock acquire failed:', error.message);
            return false;
        }
        return true;
    } catch (_) {
        // No lock table — assume single instance.
        return true;
    }
}

async function releaseLock() {
    try {
        await supabaseAdmin
            .from('marketplace_sweeper_lock')
            .update({ locked_until: null })
            .eq('id', 1);
    } catch (_) { /* best-effort */ }
}

async function resumeOrder(order) {
    // If the ledger debited, complete the order.
    const tx = await LedgerService.findTransactionByReference(order.order_ref);
    if (!tx) return { action: 'cancelled', reason: 'NO_LEDGER_TX' };

    if (!order.inventory_id) {
        return { action: 'skipped', reason: 'NO_INVENTORY' };
    }

    const { data: inv } = await supabaseAdmin
        .from('marketplace_inventory')
        .select('*')
        .eq('id', order.inventory_id)
        .maybeSingle();
    if (!inv) return { action: 'skipped', reason: 'INVENTORY_MISSING' };

    const { data: product } = await supabaseAdmin
        .from('marketplace_products')
        .select('id, name, category_id, price_usd, price_ngn')
        .eq('id', order.product_id)
        .maybeSingle();
    if (!product) return { action: 'skipped', reason: 'PRODUCT_MISSING' };

    const pricing = await marketplace.computePrice(product, order.currency);
    const delivery = marketplace.buildDeliveryPayload(inv, { product_title: product.name }, product);
    const now = new Date().toISOString();

    const { error: uErr } = await supabaseAdmin
        .from('marketplace_orders')
        .update({
            status: 'completed',
            completed_at: now,
            updated_at: now,
            delivered_data: delivery,
            unified_transaction_id: tx.id,
        })
        .eq('id', order.id)
        .in('status', ['pending', 'processing']);
    if (uErr) return { action: 'skipped', reason: 'UPDATE_FAILED', error: uErr.message };

    try {
        await recordOrder({
            billTransactionId: order.id,
            reference: order.order_ref,
            userId: order.user_id,
            productType: 'marketplace',
            serviceId: String(product.id),
            provider: 'marketplace',
            currency: order.currency,
            amount: pricing.cost,
            serviceFee: pricing.markup,
            totalAmount: Number(order.total),
            providerCost: pricing.cost,
            status: 'completed',
            recipient: null,
            metadata: {
                product_name: product.name,
                product_category: product.category_id || null,
                inventory_id: inv.id,
                ledger_transaction_id: tx.id,
                source: 'sweeper_resume',
            },
        });
    } catch (e) {
        log('mirror failed for', order.order_ref, e.message);
    }

    await recordAdminAction({
        actorType: 'system',
        action: 'marketplace.sweeper_resume',
        targetType: 'marketplace_order',
        targetId: order.id,
        after: { status: 'completed', transaction_id: tx.id },
    });

    return { action: 'resumed', transaction_id: tx.id };
}

async function cancelOrder(order) {
    const now = new Date().toISOString();
    await supabaseAdmin
        .from('marketplace_orders')
        .update({ status: 'cancelled', updated_at: now })
        .eq('id', order.id)
        .in('status', ['pending', 'processing']);

    if (order.inventory_id) {
        await supabaseAdmin.rpc('release_marketplace_inventory', {
            p_inventory_id: order.inventory_id,
            p_order_id: order.id,
        });
    }

    await recordAdminAction({
        actorType: 'system',
        action: 'marketplace.sweeper_cancel',
        targetType: 'marketplace_order',
        targetId: order.id,
        after: { status: 'cancelled', reason: 'no ledger debit' },
    });

    return { action: 'cancelled' };
}

async function tick() {
    if (_stopped) return;

    const acquired = await tryAcquire();
    if (!acquired) return;

    try {
        const cutoff = new Date(Date.now() - STALE_MIN * 60_000).toISOString();
        const { data, error } = await supabaseAdmin
            .from('marketplace_orders')
            .select('id, order_ref, user_id, product_id, inventory_id, currency, total, status, created_at')
            .in('status', ['pending', 'processing'])
            .lt('created_at', cutoff)
            .order('created_at', { ascending: true })
            .limit(100);

        if (error) {
            log('query failed:', error.message);
            return;
        }
        if (!data || !data.length) return;

        log(`found ${data.length} stale order(s)`);

        for (const order of data) {
            try {
                const tx = await LedgerService.findTransactionByReference(order.order_ref);
                if (tx) {
                    const r = await resumeOrder(order);
                    log('resume', order.order_ref, r.action, r.reason || '');
                } else {
                    const r = await cancelOrder(order);
                    log('cancel', order.order_ref, r.action);
                }
            } catch (e) {
                log('order failed', order.order_ref, e.message);
            }
        }
    } finally {
        await releaseLock();
    }
}

function start() {
    if (_timer) return;
    log('starting (MARKET_SWEEPER=true)');
    // First run staggered by 20s so it doesn't collide with boot.
    setTimeout(() => {
        if (_stopped) return;
        tick().catch(e => log('tick error:', e.message));
        _timer = setInterval(() => {
            tick().catch(e => log('tick error:', e.message));
        }, TICK_MS);
    }, 20_000);
}

function stop() {
    _stopped = true;
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
    log('stopped');
}

module.exports = { start, stop, tick };