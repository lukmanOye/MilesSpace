// workers/boostWorker.js
// ─────────────────────────────────────────────────────────────────
// Boost background worker.
//
// Run once per process:   node workers/boostWorker.js
// Or wire it from server.js after boot:
//     if (process.env.BOOST_WORKER === 'true') require('./workers/boostWorker');
//
// Every 60 s:
//   1. recoverStuckSubmissions   (submitting > 3 min → provider_unknown)
//   2. submitPendingBoostOrders  (pending, no api_order_id → provider)
//   3. syncPendingBoostOrders    (batch poll for active orders)
//   4. reconcileAwaitingPayment  (order awaiting_payment > 2 min)
//   5. reconcileRefunds          (refunded order with no ledger credit)
//
// Every 1 h:
//   6. boost_rate_limits_gc      (delete stale rate-limit rows)
//
// Concurrency:
//   • pg_try_advisory_lock(987654321) — only one instance runs a
//     given tick. If the lock is held, we skip.
//   • The lock is released at the end of each tick.
//
// Failure mode:
//   • Each step runs inside its own try/catch so a failure in one
//     does not block the others.
//   • Nothing throws out of runTick(). The worker never crashes the
//     process.
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');
const boostService = require('../services/boostService');
const syncService  = require('../services/boostSyncService');

const WORKER_LOCK_ID   = 987654321;
const TICK_INTERVAL_MS = 60 * 1000;
const GC_INTERVAL_MS   = 60 * 60 * 1000;

let tickTimer = null;
let gcTimer = null;
let running = false;
let shuttingDown = false;

async function acquireLock() {
    try {
        const { data, error } = await supabaseAdmin.rpc('pg_try_advisory_lock', {
            key: WORKER_LOCK_ID
        });
        if (error) {
            // Some Supabase setups expose this differently; fall back
            // to a simple SELECT.
            const { data: row, error: e2 } = await supabaseAdmin
                .rpc('pg_try_advisory_lock_int', { key: WORKER_LOCK_ID });
            if (e2) return false;
            return row === true;
        }
        return data === true;
    } catch (_) {
        return false;
    }
}

async function releaseLock() {
    try {
        await supabaseAdmin.rpc('pg_advisory_unlock', { key: WORKER_LOCK_ID });
    } catch (_) {
        try {
            await supabaseAdmin.rpc('pg_advisory_unlock_int', { key: WORKER_LOCK_ID });
        } catch (_) {}
    }
}

async function step(name, fn) {
    const started = Date.now();
    try {
        const result = await fn();
        const ms = Date.now() - started;
        const summary = typeof result === 'object'
            ? JSON.stringify(result).slice(0, 200)
            : String(result).slice(0, 200);
        console.log(`[boost-worker] ${name} ok (${ms}ms) ${summary}`);
        return result;
    } catch (e) {
        console.error(`[boost-worker] ${name} FAILED:`, e.message);
        return { ok: false, error: e.message };
    }
}

async function runTick() {
    if (running || shuttingDown) return;
    running = true;
    const gotLock = await acquireLock();
    if (!gotLock) {
        console.log('[boost-worker] tick skipped (lock held by another instance)');
        running = false;
        return;
    }
    try {
        // 1. Stuck submissions → provider_unknown
        await step('recoverStuckSubmissions', () => syncService.recoverStuckSubmissions());

        // 2. Pending → provider
        await step('submitPendingBoostOrders', () =>
            syncService.submitPendingBoostOrders({ limit: 25 }));

        // 3. Active orders → status poll (batch or 5-parallel)
        await step('syncPendingBoostOrders', () =>
            syncService.syncPendingBoostOrders({ limit: 100 }));

        // 4. awaiting_payment > 2 min — complete or cancel
        await step('reconcileAwaitingPayment', () =>
            boostService.reconcileAwaitingPayment());

        // 5. Refunded but no ledger credit → credit it
        await step('reconcileRefunds', () =>
            boostService.reconcileRefunds());
    } finally {
        await releaseLock();
        running = false;
    }
}

async function runGc() {
    try {
        const { data, error } = await supabaseAdmin.rpc('boost_rate_limits_gc');
        if (error) throw new Error(error.message);
        if (typeof data === 'number' && data > 0) {
            console.log(`[boost-worker] rate-limit GC deleted ${data} rows`);
        }
    } catch (e) {
        console.error('[boost-worker] rate-limit GC failed:', e.message);
    }
}

function start() {
    if (tickTimer || gcTimer) return;

    const env = String(process.env.NODE_ENV || 'development').toLowerCase();
    const providerConfigured = syncService.isProviderConfigured();
    const dryRun = syncService.isDryRun();

    console.log('[boost-worker] starting');
    console.log('[boost-worker] provider configured:', providerConfigured, '· dry-run:', dryRun);
    if (!providerConfigured) {
        console.warn('[boost-worker] SMMWIZ_API_KEY not set — submission and status sync will no-op');
    }
    if (env === 'production' && dryRun) {
        console.warn('[boost-worker] DRY-RUN is ON in production — real orders will NOT be submitted to SMMWiz');
    }

    // Kick off immediately so a cold start catches pending orders.
    runTick().catch(e => console.error('[boost-worker] first tick failed:', e.message));
    runGc().catch(() => {});

    tickTimer = setInterval(() => runTick().catch(() => {}), TICK_INTERVAL_MS);
    gcTimer   = setInterval(() => runGc().catch(() => {}), GC_INTERVAL_MS);

    // Ensure timers do not keep the event loop alive during tests.
    if (tickTimer.unref) tickTimer.unref();
    if (gcTimer.unref)   gcTimer.unref();
}

function stop() {
    shuttingDown = true;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (gcTimer)   { clearInterval(gcTimer);   gcTimer = null; }
    console.log('[boost-worker] stopped');
}

function init() {
    start();
    process.once('SIGTERM', () => { stop(); });
    process.once('SIGINT',  () => { stop(); });
    return { stop, tick: runTick };
}

module.exports = { init, start, stop, runTick, runGc };

// If executed directly (`node workers/boostWorker.js`), boot it.
if (require.main === module) {
    init();
}