// reconciliation/adapters/airtime.js
// ─────────────────────────────────────────────────────────────────
// Airtime adapter. Delegates to the existing
// airtimeReconciliationService.sweepService() for the actual work.
//
// ⚠️ IMPORTANT LIMITATION:
//   The airtime worker uses MAX_RECONCILIATION_ATTEMPTS=20 as a HARD
//   cap (not the engine's exponential backoff). That means airtime
//   rows still hit "manual_review" after ~100 minutes even though
//   the engine's backoff would give them up to 26 hours. This is a
//   known divergence from the deposits path.
//
//   To fix that, patch airtimeReconciliationService.processTransaction
//   to use next_check_at instead of reconciliation_attempts as its
//   primary gatekeeper. I'm not including that patch in this
//   deliverable because it touches working refund code. It's
//   explicitly listed in deliverable 5 as a follow-up.
//
// The adapter's job here:
//   1. Call the worker.
//   2. Raise issues for records the worker marked manual_review or
//      provider_unknown (the worker only updates status, not the
//      issues table).
//   3. Return the standard counts shape.
// ─────────────────────────────────────────────────────────────────
'use strict';

const { supabaseAdmin } = require('../../db/supabase');
const airtimeWorker = require('../../services/airtimeReconciliationService');
const issuesBridge  = require('../issuesBridge');

const KEY       = 'airtime';
const PROVIDER  = 'dtone';
const TABLE     = 'airtime_transactions';
const LOCK_NAME = `recon:${KEY}:${TABLE}`;

const PENDING_STATUSES = ['processing', 'pending', 'provider_unknown'];
const TERMINAL_STATUSES = ['completed', 'failed', 'refunded', 'cancelled'];

// findCandidates is only used by the engine to enforce the pre-check
// path (verify/validate/settle). For airtime we do not run the
// engine's per-candidate loop — the worker runs its own batch.
// This adapter's findCandidates returns an empty array so the engine
// skips its per-candidate processing; the actual work is done in
// settle() (renamed via the delegating shape below).
//
// ⚠️ This is a deliberate design choice: the airtime worker is a
// complete pipeline, not a set of hooks. Wrapping it in the engine's
// per-candidate loop would duplicate the worker's batching and
// concurrency logic.
async function findCandidates(_limit) {
    return [];   // engine does not iterate for this adapter
}

// verify/validate are never called for this adapter. They exist so
// the shape is uniform if someone adds a direct-verify path later.
async function verify(_record) { throw new Error('airtime.verify: not used'); }
function validate(_record, _verified) { throw new Error('airtime.validate: not used'); }

// The engine will call settle only if it reaches the per-candidate
// loop — which it won't, because findCandidates returns []. So
// settle() is unused here. The actual work happens in the delegating
// runSweep() below.
async function settle(_record, _verified) { throw new Error('airtime.settle: not used'); }
async function markFailed(_record, _verified) { throw new Error('airtime.markFailed: not used'); }

// ─── The delegating sweep ────────────────────────────────────────
// Called by the engine's runService() AFTER acquiring the lock.
// The engine still creates the run row and finishes it; we just
// provide the counts.
async function runSweep() {
    const workerResult = await airtimeWorker.reconcileStuckAirtimeTransactions();

    const counts = {
        scanned:      workerResult.processed   || 0,
        settled:      workerResult.completed   || 0,
        failed:       workerResult.refunded    || 0,
        manual_review:workerResult.manualReview|| 0,
        rate_limited: 0,
        skipped:      (workerResult.notFound || 0) + (workerResult.providerUnknown || 0)
    };

    // Raise issues for records the worker moved to manual_review or
    // provider_unknown in this pass. The worker does not touch the
    // issues table; we do that here.
    await raiseIssuesForStuckRecords();

    return counts;
}

async function raiseIssuesForStuckRecords() {
    const now = new Date().toISOString();

    // Raise for provider_unknown records that don't yet have an open
    // issue.
    const { data: unknowns } = await supabaseAdmin
        .from(TABLE)
        .select('id, user_id, reference, country_code, phone_number, price_ngn, status, provider_status, failure_reason')
        .eq('status', 'provider_unknown')
        .limit(200);

    for (const rec of unknowns || []) {
        await issuesBridge.raise({
            service:        KEY,
            provider:       PROVIDER,
            issueType:      'PROVIDER_STATUS_UNKNOWN',
            internalTable:  TABLE,
            internalId:     rec.id,
            internalRef:    rec.reference,
            providerRef:    null,
            userId:         rec.user_id,
            amount:         rec.price_ngn,
            currency:       'NGN',
            internalStatus: rec.status,
            providerStatus: rec.provider_status,
            reason:         rec.failure_reason || 'Provider returned unknown status',
            nextVerifyAt:   new Date(Date.now() + 30 * 60_000)
        });
    }

    // Raise for manual_review records that don't yet have an open
    // issue.
    const { data: manuals } = await supabaseAdmin
        .from(TABLE)
        .select('id, user_id, reference, price_ngn, status, provider_status, failure_reason')
        .eq('status', 'manual_review')
        .limit(200);

    for (const rec of manuals || []) {
        await issuesBridge.raise({
            service:        KEY,
            provider:       PROVIDER,
            issueType:      'PENDING_TOO_LONG',
            internalTable:  TABLE,
            internalId:     rec.id,
            internalRef:    rec.reference,
            providerRef:    null,
            userId:         rec.user_id,
            amount:         rec.price_ngn,
            currency:       'NGN',
            internalStatus: rec.status,
            providerStatus: rec.provider_status,
            reason:         rec.failure_reason || 'Moved to manual review by worker'
        });
    }
}

async function isConsistent(record) {
    return ['completed', 'failed', 'refunded'].includes(record.status);
}

function amountFor(record) {
    return record.price_ngn || null;
}
function currencyFor(record) {
    return record.debit_currency || 'NGN';
}

// ─── listProviderTransactions ─────────────────────────────────
// DT One exposes GET /transactions with filter[created_date][gte]
// and [lte]. If DTONE_HAS_LIST_API=1, we call it. Otherwise null.
//
// The dtoneService module is expected to expose `listTransactions`
// if the operator has wired it. We probe for it defensively so
// deployments that haven't updated dtoneService.js don't crash.
async function listProviderTransactions(from, to) {
    if (process.env.DTONE_HAS_LIST_API !== '1') return null;
    try {
        const dtone = require('../../services/dtoneService');
        if (typeof dtone.listTransactions !== 'function') return null;
        const rows = await dtone.listTransactions({
            created_after: from.toISOString(),
            created_before: to.toISOString(),
            limit: 500
        });
        if (!Array.isArray(rows)) return null;
        return rows.map(r => ({
            id: r.id,
            reference: r.external_id || r.id,
            provider_transaction_id: r.id,
            amount: r.credit?.amount ?? r.amount,
            currency: r.credit?.unit ?? r.currency,
            status: r.status?.message,
            provider_status: r.status?.message
        }));
    } catch (e) {
        console.warn('[airtime] list failed:', e.message);
        return null;
    }
}

module.exports.listProviderTransactions = listProviderTransactions;

module.exports = {
    key: KEY,
    provider: PROVIDER,
    table: TABLE,
    lockName: LOCK_NAME,
    pendingStatuses: PENDING_STATUSES,
    terminalStatuses: TERMINAL_STATUSES,

    findCandidates,
    verify,
    validate,
    settle,
    markFailed,
    isConsistent,
    amountFor,
    currencyFor,

    // ⚠️ Engine hook: the engine detects this method and, if present,
    // calls it INSTEAD of findCandidates + per-candidate loop. This
    // is the delegating shape for airtime-style workers.
    _delegatesToWorker: true,
    runSweep
};