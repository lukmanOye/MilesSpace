// services/vsmsWorker.js
// ─────────────────────────────────────────────────────────────────────────────
// THE background worker. Runs every 10 seconds.
//
// Bootstrap (add ONE line to server.js after reconScheduler.start()):
//   if (String(process.env.VSMS_WORKER || '').toLowerCase() === 'true') {
//       require('./services/vsmsWorker').start();
//   }
//
// Each tick runs:
//   1. SMS POLLER      — active/processing orders → getStatusV2 → store code
//   2. EXPIRY          — active/processing with no code and past expires_at
//   3. AMBIGUOUS       — processing with no activation_id, older than 90s
//   4. ORPHAN DEBITS   — pending with a ledger row but no transition
//   5. REFUND RETRIES  — *_pending_refund or refund_status='failed'
//   6. COMPLETE RETRIES — sms_received where setStatus 6 is not confirmed
//   7. CATALOGUE SYNC  — every 10 min
//   8. PROVIDER BALANCE — every 5 min
//
// Every tick is wrapped in try/catch. One bad order never stops the loop.
// Multi-instance safe via vsms_worker_lock heartbeat.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const orderService = require('./vsmsOrderService');
const provider = require('./vsmsProvider');
const adminSettings = require('./adminSettingsService');

const TICK_MS = 10_000;
const LOCK_HEARTBEAT_MS = 30_000;
const LOCK_STALE_MS = 90_000;
const SMS_BATCH = 20;
const PROVIDER_RATE_LIMITER_PER_SEC = 5;

const CATALOGUE_SYNC_MS = 10 * 60_000;
const BALANCE_CHECK_MS  = 5  * 60_000;

// ─── State ────────────────────────────────────────────────────────────────
const state = {
    started: false,
    timer: null,
    heartbeatTimer: null,
    holderId: `${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    lastTickAt: null,
    lastCatalogueSyncAt: null,
    lastBalanceCheckAt: null,
    lastError: null,
    counters: {
        smsPolls: 0,
        smsCodes: 0,
        expiries: 0,
        ambiguousResolved: 0,
        orphanDebits: 0,
        refundRetries: 0,
        completeRetries: 0,
        catalogueSyncs: 0,
        balanceChecks: 0,
        ticks: 0
    }
};

// ─── Rate limiter (per-tick, but shared across the whole process) ─────────
class TokenBucket {
    constructor(ratePerSec, burst) {
        this.ratePerMs = ratePerSec / 1000;
        this.capacity = burst != null ? burst : ratePerSec;
        this.tokens = this.capacity;
        this.lastRefill = Date.now();
        this.queue = [];
        this.processing = false;
    }
    _refill() {
        const now = Date.now();
        this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.ratePerMs);
        this.lastRefill = now;
    }
    async acquire() {
        return new Promise(resolve => {
            this.queue.push(resolve);
            this._process();
        });
    }
    _process() {
        if (this.processing) return;
        this.processing = true;
        const next = () => {
            this._refill();
            while (this.queue.length > 0 && this.tokens >= 1) {
                this.tokens -= 1;
                const r = this.queue.shift();
                r();
            }
            if (this.queue.length > 0) {
                setTimeout(next, Math.max(20, Math.ceil(1000 / (this.ratePerMs * 1000))));
            } else {
                this.processing = false;
            }
        };
        next();
    }
}
const limiter = new TokenBucket(PROVIDER_RATE_LIMITER_PER_SEC, PROVIDER_RATE_LIMITER_PER_SEC);

// ─── DB lock ──────────────────────────────────────────────────────────────
async function acquireLock() {
    const now = new Date().toISOString();
    const staleCutoff = new Date(Date.now() - LOCK_STALE_MS).toISOString();
    const { data, error } = await supabaseAdmin
        .from('vsms_worker_lock')
        .update({
            lock_holder:  state.holderId,
            locked_at:    now,
            heartbeat_at: now
        })
        .or(`lock_holder.is.null,lock_holder.eq.${state.holderId},heartbeat_at.lt.${staleCutoff}`)
        .eq('id', 1)
        .select('lock_holder')
        .maybeSingle();
    if (error) {
        console.warn('[VSMS WORKER] acquireLock error:', error.message);
        return false;
    }
    return data && data.lock_holder === state.holderId;
}

async function heartbeat() {
    try {
        await supabaseAdmin
            .from('vsms_worker_lock')
            .update({ heartbeat_at: new Date().toISOString() })
            .eq('id', 1)
            .eq('lock_holder', state.holderId);
    } catch (e) {
        console.warn('[VSMS WORKER] heartbeat error:', e.message);
    }
}

async function releaseLock() {
    try {
        await supabaseAdmin
            .from('vsms_worker_lock')
            .update({ lock_holder: null, locked_at: null, heartbeat_at: null })
            .eq('id', 1)
            .eq('lock_holder', state.holderId);
    } catch (e) {
        console.warn('[VSMS WORKER] releaseLock error:', e.message);
    }
}

// ─── Tick steps ───────────────────────────────────────────────────────────

// Step 1: SMS poller.
async function pollActiveOrders() {
    const nowIso = new Date().toISOString();
    const { data: orders, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('*')
        .in('status', ['active', 'processing'])
        .not('activation_id', 'is', null)
        .gt('expires_at', nowIso)
        .or(`next_check_at.is.null,next_check_at.lte.${nowIso}`)
        .order('next_check_at', { ascending: true, nullsFirst: true })
        .limit(SMS_BATCH);

    if (error) {
        console.warn('[VSMS WORKER] poll query failed:', error.message);
        return;
    }
    if (!orders || orders.length === 0) return;

    for (const order of orders) {
        await limiter.acquire();
        state.counters.smsPolls += 1;
        try {
            const result = await provider.getStatus({
                activationId: order.activation_id,
                orderId:      order.id
            });

            // Determine the next-check delay by order age.
            const ageMs = Date.now() - new Date(order.created_at).getTime();
            const nextDelayMs = ageMs < 120_000 ? 3000
                              : ageMs < 300_000 ? 5000
                              : 10_000;
            const nextCheckAt = new Date(Date.now() + nextDelayMs).toISOString();

            // Bump check_attempts and set next_check_at on every poll.
            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    check_attempts: (Number(order.check_attempts) || 0) + 1,
                    next_check_at:  nextCheckAt,
                    provider_status: result.kind || 'UNKNOWN',
                    updated_at:     new Date().toISOString()
                })
                .eq('id', order.id);

            // CODE RECEIVED
            if (result.kind === 'STATUS_OK' && result.smsCode) {
                await orderService.storeSmsAndComplete({
                    orderId: order.id,
                    smsCode: result.smsCode,
                    smsText: result.smsText || null,
                    providerRaw: result.raw || null
                });
                state.counters.smsCodes += 1;
                continue;
            }

            // PROVIDER CANCELLED — refund.
            if (result.kind === 'STATUS_CANCEL') {
                await orderService.refundOrderSafely({
                    orderId: order.id,
                    reason: 'Provider reported the number was cancelled.',
                    actor: { type: 'system', source: 'poll' }
                });
                continue;
            }

            // WAIT / RETRY — nothing to do this tick.
        } catch (e) {
            // Provider threw. Log and continue. The next tick will retry
            // because next_check_at was already reset above (or will
            // remain in the past — either way it re-enters the batch).
            console.warn('[VSMS WORKER] poll order failed:', order.id, e.message);
        }
    }
}

// Step 2: Expiry.
async function expireOrders() {
    const nowIso = new Date().toISOString();
    const { data: orders, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('id')
        .in('status', ['active', 'processing'])
        .is('sms_code', null)
        .lt('expires_at', nowIso)
        .limit(20);

    if (error) {
        console.warn('[VSMS WORKER] expiry query failed:', error.message);
        return;
    }
    for (const { id } of orders || []) {
        try {
            const result = await orderService.expireOrder({ orderId: id });
            if (result && result.refund) {
                state.counters.expiries += 1;
            }
        } catch (e) {
            console.warn('[VSMS WORKER] expiry failed:', id, e.message);
        }
    }
}

// Step 3: Ambiguous resolver.
async function resolveAmbiguousOrders() {
    const cutoff = new Date(Date.now() - 90_000).toISOString();
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();

    const { data: orders, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('*')
        .eq('status', 'processing')
        .is('activation_id', null)
        .lt('updated_at', cutoff)
        .limit(10);

    if (error) return;

    for (const order of orders || []) {
        try {
            // If it's been processing for over 5 minutes, we're done waiting.
            // Treat as definite failure and refund.
            const ageMs = Date.now() - new Date(order.created_at).getTime();
            if (ageMs > 5 * 60_000) {
                await orderService.refundOrderSafely({
                    orderId: order.id,
                    reason: 'Provider never returned a number (ambiguous response) — auto refund',
                    actor: { type: 'system', source: 'ambiguous_timeout' }
                });
                state.counters.ambiguousResolved += 1;
                continue;
            }

            // Otherwise, ask the provider whether an activation exists
            // for this order. We pass the order ID — the provider may
            // or may not support query-by-order, but the request itself
            // is idempotent and side-effect-free.
            // (SMS-Activate-compatible providers do NOT support this,
            //  so we skip the call and mark needs_attention.)
            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    needs_attention: true,
                    attention_reason: 'Ambiguous: provider call may have created an activation',
                    next_check_at: new Date(Date.now() + 30_000).toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', order.id);

            // After the first pass we still leave it in 'processing' so
            // the worker keeps watching it. It's the 5-min timeout above
            // that actually resolves it.
        } catch (e) {
            console.warn('[VSMS WORKER] ambiguous resolve failed:', order.id, e.message);
        }
    }
}

// Step 4: Orphan debits (pending + ledger exists but no transition).
async function resolveOrphanDebits() {
    const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
    const { data: orders, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('*')
        .eq('status', 'pending')
        .lt('created_at', cutoff)
        .limit(10);

    if (error) return;

    for (const order of orders || []) {
        try {
            // Was there a ledger transaction at VSMS-{id}?
            const ref = order.ledger_reference || `VSMS-${order.id}`;
            const ledgerTx = await providerLookupLedgerByReference(ref);

            if (ledgerTx) {
                // Debit happened but the order didn't advance. Attach
                // and move to processing so the worker can resolve the
                // provider side. Do NOT refund here — the provider call
                // never ran, so there is nothing to cancel.
                await supabaseAdmin
                    .from('virtual_sms_orders')
                    .update({
                        ledger_transaction_id: ledgerTx.id,
                        ledger_reference:      ref,
                        status:                'processing',
                        needs_attention:       true,
                        attention_reason:      'Orphan debit recovered; provider call was never made',
                        next_check_at:         new Date(Date.now() + 90_000).toISOString(),
                        updated_at:            new Date().toISOString()
                    })
                    .eq('id', order.id)
                    .eq('status', 'pending');
                state.counters.orphanDebits += 1;
            } else {
                // No ledger row — nothing was debited. Mark failed, no refund needed.
                await orderService.transition({
                    orderId:    order.id,
                    fromStatus: 'pending',
                    toStatus:   'failed',
                    patch:      { failure_code: 'ORPHAN_NO_DEBIT', failure_message: 'No debit was made' },
                    eventType:  'orphan_no_debit',
                    silentAudit: true
                }).catch(() => {});
            }
        } catch (e) {
            console.warn('[VSMS WORKER] orphan debit failed:', order.id, e.message);
        }
    }
}

// Look up a ledger transaction by reference. Uses LedgerService directly
// via a raw read (we don't want to import the full method if the reference
// doesn't exist).
async function providerLookupLedgerByReference(reference) {
    try {
        const { data } = await supabaseAdmin
            .from('transactions')
            .select('id, reference, user_id, type, status, amount, currency')
            .eq('reference', reference)
            .maybeSingle();
        return data || null;
    } catch { return null; }
}

// Step 5: Refund retries.
async function retryRefunds() {
    const { data: orders, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('*')
        .or('refund_status.eq.failed,status.in.(cancelling,expiring,failing)')
        .lt('refund_attempts', 5)
        .order('updated_at', { ascending: true })
        .limit(10);

    if (error) return;

    for (const order of orders || []) {
        try {
            await orderService.refundOrderSafely({
                orderId: order.id,
                reason:  'Auto-retry refund (worker)',
                actor:   { type: 'system', source: 'retry' }
            });
            state.counters.refundRetries += 1;
        } catch (e) {
            // refundOrderSafely already increments refund_attempts on
            // ledger failure. Nothing more to do here.
            console.warn('[VSMS WORKER] refund retry failed:', order.id, e.message);
        }
    }
}

// Step 6: Complete retries (sms_received where setStatus 6 is not confirmed).
async function retryCompletions() {
    const { data: orders, error } = await supabaseAdmin
        .from('virtual_sms_orders')
        .select('*')
        .eq('status', 'sms_received')
        .is('completed_confirmed_at', null)
        .or(`next_check_at.is.null,next_check_at.lte.${new Date().toISOString()}`)
        .limit(10);

    if (error) return;

    for (const order of orders || []) {
        if (!order.activation_id) continue;
        try {
            await limiter.acquire();
            await provider.setStatus({
                activationId: order.activation_id,
                status: 6,
                orderId: order.id
            });
            // If setStatus succeeded, transition to completed.
            await orderService.transition({
                orderId:    order.id,
                fromStatus: 'sms_received',
                toStatus:   'completed',
                patch:      { completed_confirmed_at: new Date().toISOString() },
                eventType:  'completed_confirmed',
                reason:     'setStatus 6 confirmed on retry',
                silentAudit: true
            }).catch(e => {
                if (e.code !== 'ORDER_STATE_CHANGED') throw e;
            });
            state.counters.completeRetries += 1;
        } catch (e) {
            await supabaseAdmin
                .from('virtual_sms_orders')
                .update({
                    next_check_at: new Date(Date.now() + 60_000).toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', order.id)
                .eq('status', 'sms_received');
            console.warn('[VSMS WORKER] complete retry failed:', order.id, e.message);
        }
    }
}

// Step 7: Catalogue sync (every 10 min).
async function syncCatalogue() {
    if (state.lastCatalogueSyncAt && (Date.now() - state.lastCatalogueSyncAt) < CATALOGUE_SYNC_MS) return;
    state.lastCatalogueSyncAt = Date.now();

    try {
        const countries = await provider.getCountries();
        const countryEntries = [];
        for (const [name, c] of Object.entries(countries || {})) {
            if (!c || typeof c !== 'object') continue;
            if (c.visible === 0 || c.visible === '0' || c.visible === false) continue;
            const id = parseInt(c.id, 10);
            const eng = c.eng || name;
            if (!Number.isFinite(id) || id <= 0) continue;
            if (id === 12) continue; // USA intentionally skipped
            countryEntries.push({
                id,
                name: eng,
                flag: c.flag || null,
                enabled: true,
                provider_name: 'virtualsms',
                last_synced_at: new Date().toISOString()
            });
        }
        if (countryEntries.length > 0) {
            await supabaseAdmin.from('virtual_sms_countries').upsert(countryEntries, { onConflict: 'id' });
        }

        // For each enabled country: services + prices.
        const { data: dbCountries } = await supabaseAdmin
            .from('virtual_sms_countries')
            .select('id')
            .eq('enabled', true)
            .limit(200);

        for (const { id } of dbCountries || []) {
            await limiter.acquire();
            let svcList = [];
            let prices = {};
            try {
                const s = await provider.getServicesList(id);
                if (Array.isArray(s)) svcList = s;
                else if (s && Array.isArray(s.services)) svcList = s.services;
                else if (s && typeof s === 'object') {
                    svcList = Object.entries(s)
                        .filter(([k]) => !['success','error','status'].includes(k))
                        .map(([code, info]) => ({ code, name: (info && info.name) || code }));
                }
            } catch { /* provider may not return this country */ }

            try {
                await limiter.acquire();
                const p = await provider.getPrices(id);
                if (p && typeof p === 'object') {
                    prices = p[String(id)] || p;
                }
            } catch { /* fall back to zero cost */ }

            if (!svcList.length) continue;

            const entries = svcList
                .map(s => {
                    const code = String(s.code || '').trim();
                    if (!code) return null;
                    const price = prices[code] || {};
                    const count = parseInt(price.count, 10) || 0;
                    const cost  = parseFloat(price.cost) || 0;
                    return {
                        country_id:        id,
                        service_code:      code,
                        service_name:      s.name || code.toUpperCase(),
                        provider_cost_usd: cost,
                        available_count:   count,
                        enabled:           count > 0 && cost > 0,
                        last_synced_at:    new Date().toISOString()
                    };
                })
                .filter(Boolean);

            if (entries.length > 0) {
                try {
                    await supabaseAdmin
                        .from('virtual_sms_services')
                        .upsert(entries, { onConflict: 'country_id,service_code' });
                } catch (e) {
                    console.warn('[VSMS WORKER] services upsert failed:', id, e.message);
                }
            }
        }
        state.counters.catalogueSyncs += 1;
    } catch (e) {
        console.warn('[VSMS WORKER] catalogue sync error:', e.message);
    }
}

// Step 8: Provider balance check (every 5 min).
async function checkBalance() {
    if (state.lastBalanceCheckAt && (Date.now() - state.lastBalanceCheckAt) < BALANCE_CHECK_MS) return;
    state.lastBalanceCheckAt = Date.now();

    try {
        const result = await provider.getBalance();
        const now = new Date().toISOString();

        let balanceUsd = null;
        if (result && result.kind === 'BALANCE' && result.balance != null) {
            balanceUsd = Number(result.balance);
        }

        await supabaseAdmin
            .from('vsms_provider_state')
            .update({
                balance_usd:        balanceUsd,
                balance_checked_at: now,
                updated_at:         now
            })
            .eq('provider', 'virtualsms');

        // Low-balance alert.
        try {
            const thresholdRaw = await adminSettings.getRaw('virtual_sms_low_balance_usd');
            const threshold = parseFloat(thresholdRaw);
            if (Number.isFinite(threshold) && balanceUsd != null && balanceUsd < threshold) {
                await orderService.notifyAdmins(
                    'VirtualSMS balance is low',
                    `Provider balance is $${balanceUsd.toFixed(2)} (threshold $${threshold.toFixed(2)}). Top up to avoid outages.`
                );
            }
        } catch { /* threshold not configured */ }

        state.counters.balanceChecks += 1;
    } catch (e) {
        await supabaseAdmin
            .from('vsms_provider_state')
            .update({
                last_error: e.message ? String(e.message).slice(0, 500) : null,
                updated_at: new Date().toISOString()
            })
            .eq('provider', 'virtualsms');
    }
}

// ─── Tick ─────────────────────────────────────────────────────────────────
async function tick() {
    const hasLock = await acquireLock();
    if (!hasLock) return;
    state.lastTickAt = new Date().toISOString();
    state.counters.ticks += 1;

    try { await pollActiveOrders(); } catch (e) { console.warn('[VSMS WORKER] step1:', e.message); }
    try { await expireOrders(); } catch (e) { console.warn('[VSMS WORKER] step2:', e.message); }
    try { await resolveAmbiguousOrders(); } catch (e) { console.warn('[VSMS WORKER] step3:', e.message); }
    try { await resolveOrphanDebits(); } catch (e) { console.warn('[VSMS WORKER] step4:', e.message); }
    try { await retryRefunds(); } catch (e) { console.warn('[VSMS WORKER] step5:', e.message); }
    try { await retryCompletions(); } catch (e) { console.warn('[VSMS WORKER] step6:', e.message); }
    try { await syncCatalogue(); } catch (e) { console.warn('[VSMS WORKER] step7:', e.message); }
    try { await checkBalance(); } catch (e) { console.warn('[VSMS WORKER] step8:', e.message); }

    // Log a compact tick summary every 6 ticks (~once a minute).
    if (state.counters.ticks % 6 === 0) {
        console.log('[VSMS WORKER] tick', state.counters.ticks, JSON.stringify(state.counters));
    }
}

// ─── Start / stop ─────────────────────────────────────────────────────────
function start() {
    if (state.started) return;
    state.started = true;

    console.log('[VSMS WORKER] starting, holder:', state.holderId);

    // First tick in 5 seconds (give the server time to settle).
    setTimeout(() => {
        tick().catch(e => console.error('[VSMS WORKER] first tick error:', e.message));
    }, 5000);

    state.timer = setInterval(() => {
        tick().catch(e => console.error('[VSMS WORKER] tick error:', e.message));
    }, TICK_MS);

    state.heartbeatTimer = setInterval(() => {
        heartbeat().catch(() => {});
    }, LOCK_HEARTBEAT_MS);

    // Graceful shutdown.
    const shutdown = async () => {
        console.log('[VSMS WORKER] stopping…');
        if (state.timer) clearInterval(state.timer);
        if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
        await releaseLock();
        process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}

function stop() {
    if (state.timer) clearInterval(state.timer);
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.timer = null;
    state.heartbeatTimer = null;
    state.started = false;
    releaseLock().catch(() => {});
}

function snapshot() {
    return {
        ...state.counters,
        lastTickAt: state.lastTickAt,
        lastCatalogueSyncAt: state.lastCatalogueSyncAt,
        lastBalanceCheckAt: state.lastBalanceCheckAt,
        lastError: state.lastError,
        holderId: state.holderId
    };
}

module.exports = { start, stop, snapshot };