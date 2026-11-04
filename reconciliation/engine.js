// reconciliation/engine.js
// ─────────────────────────────────────────────────────────────────
// The sweep engine.
//
// One file. Owns:
//   • leasing          (lock.acquire / heartbeat / release)
//   • rate limiting    (ratelimit.getBucket)
//   • backoff          (backoff.computeNextCheckAt)
//   • runs             (runs.createRun / finishRun)
//   • issues           (issuesBridge.raise / closeForRecord)
//   • auto-close       (autoClose.runAutoClose)
//   • pre-manual-review final check (see runService, `pending` case)
//
// Does NOT own:
//   • money movement   (adapter.settle does; via the ledger)
//   • provider calls   (adapter.verify does)
//   • what counts as   (adapter defines pending/success/failure)
//     success/failure
//
// Adapter contract:
//   {
//     key,               // 'kora'
//     provider,          // 'korapay'
//     table,             // 'deposit_requests'
//     lockName,          // 'recon:kora:deposit_requests'
//     pendingStatuses,   // ['pending','processing','processing_credit']
//     terminalStatuses,  // ['completed','failed','expired','refunded']
//
//     findCandidates(limit),                   // → array of records
//     verify(record),                          // → { verdict, ... }
//     validate(record, verified),              // → true | { issueType, reason }
//     settle(record, verified),                // → { completed: bool, reason?: string }
//     isConsistent(record),                    // → true | false
//     markFailed(record, verified),            // → void (deposits only)
//   }
//
// Standard counts shape:
//   { scanned, settled, failed, manual_review, rate_limited, skipped }
// ─────────────────────────────────────────────────────────────────
'use strict';

const lock        = require('./lock');
const ratelimit   = require('./ratelimit');
const backoff     = require('./backoff');
const runs        = require('./runs');
const autoClose   = require('./autoClose');
const issuesBridge = require('./issuesBridge');

const BATCH_SIZE              = 50;
const HEARTBEAT_INTERVAL_MS   = 5 * 60 * 1000;   // 1/2 of default lease
const PROVIDER_TIMEOUT_MS     = 15_000;

function log(...args)    { console.log('[RECON]',  ...args); }
function logErr(...args) { console.error('[RECON]', ...args); }

// ─── Timeout wrapper ─────────────────────────────────────────────
// Provider calls must never hang the sweep. If an adapter forgets a
// timeout, the engine supplies one.
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label || 'call'} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─── Status mapping ──────────────────────────────────────────────
// The adapter's verdict is the single source of truth. The engine
// never inspects the raw provider status; that is the adapter's job.
function isHttp429(err) {
    const status =
        (err && err.status) ||
        (err && err.response && err.response.status) ||
        (err && err.providerHttpStatus) ||
        null;
    return status === 429;
}

// ─── Persist candidate state ─────────────────────────────────────
// Every candidate gets its next_check_at / attempts updated on exit.
// Failure to persist is logged, not thrown — the next sweep will
// re-evaluate anyway, and a thrown error here would abort the whole
// sweep for one bad record.
async function persistCandidate(adapter, record, { attempts, nextCheckAt, lastError, status, failureReason }) {
    const patch = {
        attempts,
        next_check_at: nextCheckAt ? nextCheckAt.toISOString() : null,
        last_reconciliation_at: new Date().toISOString()
    };
    if (status !== undefined)        patch.status = status;
    if (failureReason !== undefined) patch.failure_reason = failureReason;

    const { error } = await adapter._supabase
        .from(adapter.table)
        .update(patch)
        .eq('id', record.id);

    if (error) {
        logErr(`[${adapter.key}] persist failed for ${record.id}:`, error.message);
        return false;
    }
    return true;
}

// ─── The single candidate ────────────────────────────────────────
// Returns one of:
//   { outcome: 'settled' }
//   { outcome: 'failed' }
//   { outcome: 'manual_review' }
//   { outcome: 'rate_limited' }
//   { outcome: 'skipped' }
//
// Also updates the record's next_check_at / attempts on exit.
async function processCandidate(adapter, record, runContext) {
    const currentAttempts = Number(record.attempts) || 0;
    const nextAttempts = currentAttempts + 1;
    const schedule = backoff.computeNextCheckAt({
        created_at: record.created_at,
        attempts: currentAttempts,
        now: new Date()
    });

    // ── Give up? ──────────────────────────────────────────────────
    // Checked BEFORE calling the provider. If we're past the age cap
    // we do not spend a provider call on this record again.
    if (schedule.giveUp) {
        // Final provider check before manual_review (core principle #4).
        // We allow exactly one last verify even at the age cap, so an
        // in-flight success can still settle.
        const lastCheck = await tryVerifyWithRateLimit(adapter, record, runContext);
        if (lastCheck.rateLimited) {
            // Provider is 429ing at the last minute. Raise manual_review
            // anyway — we can't determine the outcome.
            await raiseManualReview(adapter, record, {
                providerStatus: null,
                reason: `Exceeded ${backoff.MAX_AGE_MS / 3_600_000}h cap while provider rate-limited (${schedule.reason})`
            });
            return { outcome: 'manual_review' };
        }
        if (lastCheck.verifyResult) {
            const verdict = lastCheck.verifyResult.verdict;
            if (verdict === 'success') {
                return await settleSuccess(adapter, record, lastCheck.verifyResult, { nextAttempts, nextCheckAt: null });
            }
            if (verdict === 'failure') {
                return await settleFailure(adapter, record, lastCheck.verifyResult, { nextAttempts, nextCheckAt: null });
            }
        }
        await raiseManualReview(adapter, record, {
            providerStatus: lastCheck.verifyResult ? lastCheck.verifyResult.providerStatus : null,
            reason: `Exceeded ${backoff.MAX_AGE_MS / 3_600_000}h cap (${schedule.reason}) after final check`
        });
        return { outcome: 'manual_review' };
    }

    // ── Rate limit ────────────────────────────────────────────────
    const bucket = ratelimit.getBucket(adapter.provider);
    const rate = await bucket.acquire();
    if (!rate.ok) {
        // Provider is in cooldown. Do NOT call it. Record rate_limited
        // and schedule a retry at the usual backoff.
        await persistCandidate(adapter, record, {
            attempts: nextAttempts,
            nextCheckAt: schedule.nextCheckAt
        });
        return { outcome: 'rate_limited' };
    }

    // ── Verify ────────────────────────────────────────────────────
    let verified;
    try {
        verified = await withTimeout(
            adapter.verify(record),
            PROVIDER_TIMEOUT_MS,
            `${adapter.key}.verify`
        );
    } catch (err) {
        if (isHttp429(err)) {
            bucket.trigger429();
            await persistCandidate(adapter, record, {
                attempts: nextAttempts,
                nextCheckAt: schedule.nextCheckAt
            });
            return { outcome: 'rate_limited' };
        }
        logErr(`[${adapter.key}] verify threw for ${record.id}:`, err.message);
        // Unknown outcome — raise and schedule.
        await issuesBridge.raise({
            service:         adapter.key,
            provider:        adapter.provider,
            issueType:       'VERIFICATION_FAILED',
            internalTable:   adapter.table,
            internalId:      record.id,
            internalRef:     record.reference || record.internal_reference || record.order_id || null,
            providerRef:     record.provider_reference || record.nowpayments_payment_id || null,
            userId:          record.user_id,
            amount:          pickAmount(record),
            currency:        pickCurrency(record),
            internalStatus:  record.status,
            providerStatus:  null,
            reason:          'Provider verify threw: ' + err.message,
            nextVerifyAt:    schedule.nextCheckAt || new Date(Date.now() + 5 * 60_000)
        });
        await persistCandidate(adapter, record, {
            attempts: nextAttempts,
            nextCheckAt: schedule.nextCheckAt || new Date(Date.now() + 5 * 60_000)
        });
        return { outcome: 'skipped' };
    }

    if (!verified || typeof verified.verdict !== 'string') {
        // Adapter contract violation — treat as unknown.
        await issuesBridge.raise({
            service:         adapter.key,
            provider:        adapter.provider,
            issueType:       'VERIFICATION_FAILED',
            internalTable:   adapter.table,
            internalId:      record.id,
            internalRef:     record.reference || record.internal_reference || null,
            providerRef:     null,
            userId:          record.user_id,
            amount:          pickAmount(record),
            currency:        pickCurrency(record),
            internalStatus:  record.status,
            providerStatus:  null,
            reason:          'Adapter returned no valid verdict'
        });
        await persistCandidate(adapter, record, {
            attempts: nextAttempts,
            nextCheckAt: schedule.nextCheckAt
        });
        return { outcome: 'skipped' };
    }

    // ── Dispatch ──────────────────────────────────────────────────
    switch (verified.verdict) {
        case 'success': {
            const validation = await adapter.validate(record, verified);
            if (validation !== true) {
                // AMOUNT_MISMATCH or similar. Never credit.
                await issuesBridge.raise({
                    service:         adapter.key,
                    provider:        adapter.provider,
                    issueType:       (validation && validation.issueType) || 'AMOUNT_MISMATCH',
                    internalTable:   adapter.table,
                    internalId:      record.id,
                    internalRef:     record.reference || record.internal_reference || null,
                    providerRef:     verified.providerRef || null,
                    userId:          record.user_id,
                    amount:          pickAmount(record),
                    currency:        pickCurrency(record),
                    internalStatus:  record.status,
                    providerStatus:  verified.providerStatus || null,
                    reason:          (validation && validation.reason) || 'Provider success but amounts differ'
                });
                await persistCandidate(adapter, record, {
                    attempts: nextAttempts,
                    nextCheckAt: null,
                    status: 'manual_review',
                    failureReason: 'AMOUNT_MISMATCH'
                });
                return { outcome: 'manual_review' };
            }
            return await settleSuccess(adapter, record, verified, { nextAttempts, nextCheckAt: null });
        }

        case 'failure': {
            return await settleFailure(adapter, record, verified, { nextAttempts, nextCheckAt: null });
        }

        case 'pending': {
            // Normal case. Schedule a retry and, if the adapter says
            // this record has been pending too long, raise
            // PENDING_TOO_LONG — but keep sweeping.
            const nextAt = schedule.nextCheckAt;
            await persistCandidate(adapter, record, {
                attempts: nextAttempts,
                nextCheckAt: nextAt
            });
            if (shouldRaisePendingTooLong(record, nextAttempts)) {
                await issuesBridge.raise({
                    service:         adapter.key,
                    provider:        adapter.provider,
                    issueType:       'PENDING_TOO_LONG',
                    internalTable:   adapter.table,
                    internalId:      record.id,
                    internalRef:     record.reference || record.internal_reference || null,
                    providerRef:     verified.providerRef || null,
                    userId:          record.user_id,
                    amount:          pickAmount(record),
                    currency:        pickCurrency(record),
                    internalStatus:  record.status,
                    providerStatus:  verified.providerStatus || null,
                    reason:          `Provider still pending after ${nextAttempts} attempts`,
                    nextVerifyAt:    nextAt || new Date(Date.now() + 30 * 60_000)
                });
            }
            return { outcome: 'skipped' };
        }

        case 'unknown': {
            // Provider returned a status the adapter does not
            // recognise. Raise PROVIDER_STATUS_UNKNOWN, schedule a
            // retry (backoff is longer for unknown than pending).
            const nextAt = schedule.nextCheckAt;
            await issuesBridge.raise({
                service:         adapter.key,
                provider:        adapter.provider,
                issueType:       'PROVIDER_STATUS_UNKNOWN',
                internalTable:   adapter.table,
                internalId:      record.id,
                internalRef:     record.reference || record.internal_reference || null,
                providerRef:     verified.providerRef || null,
                userId:          record.user_id,
                amount:          pickAmount(record),
                currency:        pickCurrency(record),
                internalStatus:  record.status,
                providerStatus:  verified.providerStatus || null,
                reason:          `Provider returned unrecognised status: ${verified.providerStatus || '(none)'}`
            });
            await persistCandidate(adapter, record, {
                attempts: nextAttempts,
                nextCheckAt: nextAt || new Date(Date.now() + 30 * 60_000)
            });
            return { outcome: 'skipped' };
        }

        default: {
            // Adapter returned a verdict the engine does not know
            // about. Treat as unknown; this is a bug in the adapter.
            logErr(`[${adapter.key}] unknown verdict "${verified.verdict}" for ${record.id}`);
            await issuesBridge.raise({
                service:         adapter.key,
                provider:        adapter.provider,
                issueType:       'VERIFICATION_FAILED',
                internalTable:   adapter.table,
                internalId:      record.id,
                internalRef:     record.reference || record.internal_reference || null,
                providerRef:     null,
                userId:          record.user_id,
                amount:          pickAmount(record),
                currency:        pickCurrency(record),
                internalStatus:  record.status,
                providerStatus:  verified.providerStatus || null,
                reason:          `Adapter returned unknown verdict "${verified.verdict}"`
            });
            await persistCandidate(adapter, record, {
                attempts: nextAttempts,
                nextCheckAt: schedule.nextCheckAt
            });
            return { outcome: 'skipped' };
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────
async function tryVerifyWithRateLimit(adapter, record, runContext) {
    const bucket = ratelimit.getBucket(adapter.provider);
    const rate = await bucket.acquire();
    if (!rate.ok) return { rateLimited: true };
    try {
        const verified = await withTimeout(
            adapter.verify(record),
            PROVIDER_TIMEOUT_MS,
            `${adapter.key}.verify`
        );
        return { verifyResult: verified };
    } catch (err) {
        if (isHttp429(err)) {
            bucket.trigger429();
            return { rateLimited: true };
        }
        return { verifyError: err };
    }
}

async function settleSuccess(adapter, record, verified, { nextAttempts, nextCheckAt }) {
    let result;
    try {
        result = await adapter.settle(record, verified);
    } catch (err) {
        logErr(`[${adapter.key}] settle threw for ${record.id}:`, err.message);
        await issuesBridge.raise({
            service:         adapter.key,
            provider:        adapter.provider,
            issueType:       'PROVIDER_SUCCESS_INTERNAL_INCOMPLETE',
            internalTable:   adapter.table,
            internalId:      record.id,
            internalRef:     record.reference || record.internal_reference || null,
            providerRef:     verified.providerRef || null,
            userId:          record.user_id,
            amount:          pickAmount(record),
            currency:        pickCurrency(record),
            internalStatus:  record.status,
            providerStatus:  verified.providerStatus || null,
            reason:          'Settle threw: ' + err.message
        });
        await persistCandidate(adapter, record, {
            attempts: nextAttempts,
            nextCheckAt: nextAttempts >= 10 ? null : new Date(Date.now() + 5 * 60_000)
        });
        return { outcome: 'failed' };
    }

    if (result && result.completed === true) {
        await issuesBridge.closeForRecord({
            service: adapter.key,
            internalId: record.id,
            notes: 'Auto-resolved: provider confirmed success and settlement completed'
        });
        return { outcome: 'settled' };
    }

    await issuesBridge.raise({
        service:         adapter.key,
        provider:        adapter.provider,
        issueType:       'PROVIDER_SUCCESS_INTERNAL_INCOMPLETE',
        internalTable:   adapter.table,
        internalId:      record.id,
        internalRef:     record.reference || record.internal_reference || null,
        providerRef:     verified.providerRef || null,
        userId:          record.user_id,
        amount:          pickAmount(record),
        currency:        pickCurrency(record),
        internalStatus:  record.status,
        providerStatus:  verified.providerStatus || null,
        reason:          'Settle returned: ' + ((result && result.reason) || 'not completed')
    });
    await persistCandidate(adapter, record, {
        attempts: nextAttempts,
        nextCheckAt: nextAttempts >= 10 ? null : new Date(Date.now() + 5 * 60_000)
    });
    return { outcome: 'failed' };
}

async function settleFailure(adapter, record, verified, { nextAttempts, nextCheckAt }) {
    // For deposits: mark the record failed/expired. Never refund
    // (there's nothing to refund — the wallet was never credited).
    // For purchases: adapter.settle handles the refund through the
    // ledger; the adapter owns the decision.
    try {
        if (typeof adapter.markFailed === 'function') {
            await adapter.markFailed(record, verified);
        } else {
            // Purchase path — settle handles refund.
            const result = await adapter.settle(record, verified);
            if (!result || result.completed !== true) {
                await issuesBridge.raise({
                    service:         adapter.key,
                    provider:        adapter.provider,
                    issueType:       'PROVIDER_FAILURE_NOT_REFUNDED',
                    internalTable:   adapter.table,
                    internalId:      record.id,
                    internalRef:     record.reference || record.internal_reference || null,
                    providerRef:     verified.providerRef || null,
                    userId:          record.user_id,
                    amount:          pickAmount(record),
                    currency:        pickCurrency(record),
                    internalStatus:  record.status,
                    providerStatus:  verified.providerStatus || null,
                    reason:          'Provider failure but refund did not complete: ' + ((result && result.reason) || 'unknown')
                });
            }
        }
    } catch (err) {
        logErr(`[${adapter.key}] settleFailure threw for ${record.id}:`, err.message);
        await issuesBridge.raise({
            service:         adapter.key,
            provider:        adapter.provider,
            issueType:       'PROVIDER_FAILURE_NOT_REFUNDED',
            internalTable:   adapter.table,
            internalId:      record.id,
            internalRef:     record.reference || record.internal_reference || null,
            providerRef:     verified.providerRef || null,
            userId:          record.user_id,
            amount:          pickAmount(record),
            currency:        pickCurrency(record),
            internalStatus:  record.status,
            providerStatus:  verified.providerStatus || null,
            reason:          'Failure settle threw: ' + err.message
        });
        await persistCandidate(adapter, record, {
            attempts: nextAttempts,
            nextCheckAt: null
        });
        return { outcome: 'manual_review' };
    }

    await issuesBridge.closeForRecord({
        service: adapter.key,
        internalId: record.id,
        notes: 'Auto-resolved: provider reported terminal failure and record handled'
    });
    return { outcome: 'failed' };
}

async function raiseManualReview(adapter, record, { providerStatus, reason }) {
    await persistCandidate(adapter, record, {
        attempts: (Number(record.attempts) || 0) + 1,
        nextCheckAt: null,
        status: 'manual_review',
        failureReason: reason
    });
    await issuesBridge.raise({
        service:         adapter.key,
        provider:        adapter.provider,
        issueType:       'PENDING_TOO_LONG',
        internalTable:   adapter.table,
        internalId:      record.id,
        internalRef:     record.reference || record.internal_reference || null,
        providerRef:     null,
        userId:          record.user_id,
        amount:          pickAmount(record),
        currency:        pickCurrency(record),
        internalStatus:  record.status,
        providerStatus,
        reason
    });
}

function shouldRaisePendingTooLong(record, nextAttempts) {
    // Raise a single issue after 6 attempts (i.e. around t=35m). The
    // unique-open-issue index ensures repeated raises are no-ops; the
    // upsert path increments reconciliation_attempts instead.
    return nextAttempts >= 6;
}

function pickAmount(record) {
    // Best-effort. Adapters can override by exposing amountFor(record),
    // but the common case is one of these.
    return (
        record.wallet_amount           ??
        record.wallet_credit_usd       ??
        record.price_ngn               ??
        record.total_usd               ??
        record.amount                  ??
        null
    );
}
function pickCurrency(record) {
    return (
        record.wallet_currency        ??
        (record.wallet_credit_usd != null ? 'USD' : null) ??
        record.currency               ??
        null
    );
}

// ─── The public entry point ─────────────────────────────────────
/**
 * Run one sweep for one service. Never throws — a failed sweep
 * still updates its run row and returns counts.
 *
 * @param {object} adapter
 * @param {object} [ctx={}]              { adminId, adminEmail }
 * @returns {Promise<object>}            standard counts shape
 */
async function runService(adapter, ctx = {}) {
    const counts = runs.emptyCounts();
    const lockName = adapter.lockName || `recon:${adapter.key}:${adapter.table}`;

    // ── In-process guard ──────────────────────────────────────────
    if (!lock.tryProcessGuard(lockName)) {
        log(`[${adapter.key}] already running in this process — skip`);
        const run = await runs.createRun({
            provider: adapter.provider,
            service: adapter.key,
            ctx
        });
        await runs.finishRun(run.id, {
            status: 'skipped',
            counts,
            lockSkipped: true
        });
        return counts;
    }

    // ── DB lease ──────────────────────────────────────────────────
    const lease = await lock.acquire(lockName);
    if (!lease.ok) {
        log(`[${adapter.key}] lease not acquired (${lease.reason}) — skip`);
        lock.clearProcessGuard(lockName);
        const run = await runs.createRun({
            provider: adapter.provider,
            service: adapter.key,
            ctx
        });
        await runs.finishRun(run.id, {
            status: 'skipped',
            counts,
            lockSkipped: true
        });
        return counts;
    }

    // ── Run ───────────────────────────────────────────────────────
    const run = await runs.createRun({
        provider: adapter.provider,
        service: adapter.key,
        ctx
    });

    // Heartbeat timer — extends the lease so a long sweep can't lose it.
    let heartbeatAlive = true;
    const hbTimer = setInterval(async () => {
        const ok = await lock.heartbeat(lockName);
        if (!ok) {
            heartbeatAlive = false;
            logErr(`[${adapter.key}] heartbeat lost — stopping new candidates`);
        }
    }, HEARTBEAT_INTERVAL_MS);

    try {
        // ── 1. Candidates ────────────────────────────────────────
        const candidates = await adapter.findCandidates(BATCH_SIZE);
        counts.scanned = Array.isArray(candidates) ? candidates.length : 0;

        // ── 2. Process ───────────────────────────────────────────
        for (const record of candidates || []) {
            if (!heartbeatAlive) {
                counts.skipped += (candidates.length - counts.settled - counts.failed - counts.manual_review - counts.rate_limited);
                break;
            }
            if (ratelimit.isCoolingDown(adapter.provider)) {
                counts.rate_limited++;
                continue;
            }
            try {
                const result = await processCandidate(adapter, record, { run, ctx });
                if (result.outcome === 'settled')       counts.settled++;
                else if (result.outcome === 'failed')   counts.failed++;
                else if (result.outcome === 'manual_review') counts.manual_review++;
                else if (result.outcome === 'rate_limited')  counts.rate_limited++;
                else                                        counts.skipped++;
            } catch (err) {
                logErr(`[${adapter.key}] candidate ${record.id} threw:`, err.message);
                counts.skipped++;
            }
        }

        // ── 3. Auto-close pass ───────────────────────────────────
        // Re-examine open issues for this service. Any issue whose
        // internal record is now terminal and consistent gets closed.
        // This is what catches a webhook settling a record while the
        // issue was open.
        const closed = await autoClose.runAutoClose({
            adapter,
            issuesBridge
        });
        log(`[${adapter.key}] auto-close pass: scanned=${closed.scanned} closed=${closed.closed}`);

        // ── 4. Finish ────────────────────────────────────────────
        await runs.finishRun(run.id, { status: 'completed', counts });
    } catch (err) {
        logErr(`[${adapter.key}] sweep failed:`, err.message);
        await runs.finishRun(run.id, {
            status: 'failed',
            counts,
            error: err.message
        });
    } finally {
        clearInterval(hbTimer);
        await lock.release(lockName);
        lock.clearProcessGuard(lockName);
    }

    return counts;
}

module.exports = {
    runService,
    // Exported for testing.
    _processCandidate: processCandidate,
    _persistCandidate: persistCandidate
};