// services/billsReconciliationService.js
// MilesSpace — Bills reconciliation worker
//
// CHANGES vs prior revision:
//   • Refund call now uses the LedgerService.refundTransaction OBJECT
//     signature. Prior code passed (userId, transactionId, reason)
//     positionally — the service destructures its first argument as an
//     object, so every refund threw and every failed bill landed in
//     manual_review without ever crediting the user.
//   • Candidate selection uses next_check_at, not "oldest pending first".
//   • Every transition into manual_review / provider_unknown also
//     raises an entry in reconciliation_issues via issuesBridge.
//   • Scheduler is self-rescheduling (no overlap on slow sweeps).
// ─────────────────────────────────────────────────────────────────
'use strict';

const { supabaseAdmin } = require('../db/supabase');
const vtpassService = require('./vtpassService');
const { LedgerService } = require('./ledgerService');

let _issuesBridge = null;
function issuesBridge() {
    if (_issuesBridge) return _issuesBridge;
    try {
        _issuesBridge = require('../reconciliation/issuesBridge');
    } catch (_) {
        _issuesBridge = { raise: async () => null, closeForRecord: async () => {} };
    }
    return _issuesBridge;
}

// ─── CONFIG ──────────────────────────────────────────────────────────
const INTERVAL_MS       = Number(process.env.BILLS_RECONCILE_INTERVAL_MS  || 5 * 60 * 1000);
const MIN_AGE_MS        = Number(process.env.BILLS_RECONCILE_MIN_AGE_MS   || 5 * 60 * 1000);
const MAX_AGE_HOURS     = Number(process.env.BILLS_RECONCILE_MAX_AGE_HOURS || 26);
const BATCH_SIZE        = Number(process.env.BILLS_RECONCILE_BATCH_SIZE    || 50);
const BASE_BACKOFF_MS   = 5 * 60 * 1000;
const MAX_BACKOFF_MS    = 6 * 60 * 60 * 1000;

let schedulerHandle = null;
let schedulerStopped = false;
let running = false;

// ─── BACKOFF ─────────────────────────────────────────────────────────
function getBackoffNextCheckAt(attempts, createdAt) {
    const n = Math.max(0, Number(attempts) || 0);
    const createdMs = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime();
    if (!Number.isFinite(createdMs)) return null;
    const waitMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, n));
    const proposed = Date.now() + waitMs;
    const ageCap = createdMs + MAX_AGE_HOURS * 3600 * 1000;
    if (proposed >= ageCap) return null;
    return new Date(proposed);
}

// ─── FIND STUCK ORDERS ───────────────────────────────────────────────
async function findStuckOrders() {
    const nowIso = new Date().toISOString();
    const legacyCutoff = new Date(Date.now() - MIN_AGE_MS).toISOString();

    const { data, error } = await supabaseAdmin
        .from('bill_payment_transactions')
        .select('*')
        .in('status', ['pending', 'processing', 'provider_unknown'])
        .or(`next_check_at.lte.${nowIso},and(next_check_at.is.null,created_at.lt.${legacyCutoff})`)
        .order('next_check_at', { ascending: true, nullsFirst: false })
        .limit(BATCH_SIZE);

    if (error) throw error;
    return data || [];
}

// ─── UPDATE ──────────────────────────────────────────────────────────
async function updateTransaction(transactionId, updates) {
    const { data, error } = await supabaseAdmin
        .from('bill_payment_transactions')
        .update({
            ...updates,
            updated_at: new Date().toISOString()
        })
        .eq('id', transactionId)
        .select()
        .single();
    if (error) throw error;
    return data;
}

// ─── ATTEMPT TRACKING ────────────────────────────────────────────────
async function recordAttempt(transactionId, { errorMessage = null, nextCheckAt = undefined, attempts } = {}) {
    const { data: tx } = await supabaseAdmin
        .from('bill_payment_transactions')
        .select('attempts, reconciliation_attempts, metadata, created_at')
        .eq('id', transactionId)
        .maybeSingle();
    if (!tx) return;

    const nextAttempts = Number.isFinite(attempts)
        ? attempts
        : ((tx.attempts || tx.reconciliation_attempts || 0) + 1);
    const now = new Date().toISOString();
    const nextAt = nextCheckAt === undefined
        ? getBackoffNextCheckAt(nextAttempts, tx.created_at)
        : nextCheckAt;

    await supabaseAdmin
        .from('bill_payment_transactions')
        .update({
            attempts: nextAttempts,
            reconciliation_attempts: nextAttempts,
            next_check_at: nextAt ? nextAt.toISOString() : null,
            last_reconciliation_at: now,
            updated_at: now,
            metadata: {
                ...(tx.metadata || {}),
                last_reconciliation_error: errorMessage,
                last_reconciliation_error_at: errorMessage ? now : (tx.metadata?.last_reconciliation_error_at || null),
                reconciliation_attempt: nextAttempts
            }
        })
        .eq('id', transactionId);
}

// ─── NOTIFICATION ────────────────────────────────────────────────────
async function createNotification(userId, title, message, type, link) {
    try {
        await supabaseAdmin.from('notifications').insert({
            user_id: userId,
            title,
            message,
            type,
            icon: type === 'success' ? '✅' : type === 'error' ? '❌' : '📌',
            link: link || '/bills',
            is_read: false,
            created_at: new Date().toISOString()
        });
    } catch (e) {
        console.error('[BILLS RECON] Notification error:', e.message);
    }
}

// ─── MANUAL REVIEW ───────────────────────────────────────────────────
async function moveToManualReview(order, reason) {
    const nextAttempts = (order.attempts || order.reconciliation_attempts || 0) + 1;
    await updateTransaction(order.id, {
        status: 'manual_review',
        failure_reason: reason,
        attempts: nextAttempts,
        reconciliation_attempts: nextAttempts,
        next_check_at: null
    });

    await issuesBridge().raise({
        service:        'bills',
        provider:       'vtpass',
        issueType:      'PENDING_TOO_LONG',
        internalTable:  'bill_payment_transactions',
        internalId:     order.id,
        internalRef:    order.reference,
        providerRef:    order.provider_request_id || null,
        userId:         order.user_id,
        amount:         order.customer_amount || null,
        currency:       'NGN',
        internalStatus: order.status,
        providerStatus: order.provider_status || null,
        reason
    });
}

async function moveToProviderUnknown(order, reason) {
    const nextAttempts = (order.attempts || order.reconciliation_attempts || 0) + 1;
    const nextAt = getBackoffNextCheckAt(nextAttempts, order.created_at);
    await updateTransaction(order.id, {
        status: 'provider_unknown',
        failure_reason: reason,
        attempts: nextAttempts,
        reconciliation_attempts: nextAttempts,
        next_check_at: nextAt ? nextAt.toISOString() : null
    });

    await issuesBridge().raise({
        service:        'bills',
        provider:       'vtpass',
        issueType:      'PROVIDER_STATUS_UNKNOWN',
        internalTable:  'bill_payment_transactions',
        internalId:     order.id,
        internalRef:    order.reference,
        providerRef:    order.provider_request_id || null,
        userId:         order.user_id,
        amount:         order.customer_amount || null,
        currency:       'NGN',
        internalStatus: order.status,
        providerStatus: order.provider_status || null,
        reason
    });
}

// ─── RECONCILE ONE ORDER ─────────────────────────────────────────────
async function reconcileOne(order) {
    const logPrefix = `[BILLS RECON ${order.reference}]`;
    const nextAttempts = (order.attempts || order.reconciliation_attempts || 0) + 1;

    // Age cap
    const ageMs = Date.now() - new Date(order.created_at).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours >= MAX_AGE_HOURS) {
        console.warn(`${logPrefix} age ${ageHours.toFixed(1)}h exceeds cap → manual_review`);
        await moveToManualReview(order, `Exceeded ${MAX_AGE_HOURS}h reconciliation window`);
        return { action: 'manual_review', orderId: order.id };
    }

    if (!order.provider_request_id) {
        await recordAttempt(order.id, {
            errorMessage: 'Missing provider_request_id'
        });
        return { action: 'skipped', orderId: order.id, reason: 'no_provider_request_id' };
    }

    // Requery VTpass.
    let requery;
    try {
        requery = await vtpassService.queryTransaction(order.provider_request_id);
    } catch (err) {
        console.warn(`${logPrefix} requery failed: ${err.message}`);
        await recordAttempt(order.id, {
            errorMessage: `Requery failed: ${err.message}`
        });
        return { action: 'requery_failed', orderId: order.id, reason: err.message };
    }

    if (requery.state === 'completed') {
        await updateTransaction(order.id, {
            status: 'completed',
            provider_status: requery.providerStatus,
            provider_code: requery.code,
            provider_transaction_id: requery.transactionId || order.provider_transaction_id,
            token: requery.token || order.token,
            units: requery.units || order.units,
            completed_at: new Date().toISOString(),
            attempts: nextAttempts,
            reconciliation_attempts: nextAttempts,
            next_check_at: null
        });

        await createNotification(
            order.user_id,
            'Transaction Completed',
            `Your ${order.service_type} purchase of ₦${parseFloat(order.customer_amount).toFixed(2)} was completed successfully.`,
            'success'
        );

        await issuesBridge().closeForRecord({
            service: 'bills',
            internalId: order.id,
            notes: 'Auto-resolved: VTpass confirmed completion'
        });

        return { action: 'completed', orderId: order.id };
    }

    if (requery.state === 'failed') {
        if (order.ledger_transaction_id && !order.refunded) {
            try {
                // ⚠️ OBJECT SIGNATURE. Prior code called this positionally
                // and every refund threw. This is the fix.
                const refundResult = await LedgerService.refundTransaction({
                    userId: order.user_id,
                    transactionId: order.ledger_transaction_id,
                    reason: requery.friendlyError || 'Provider transaction failed'
                });

                const refundOk = refundResult && refundResult.success === true;

                await updateTransaction(order.id, {
                    status: 'failed',
                    provider_status: requery.providerStatus,
                    provider_code: requery.code,
                    failure_reason: requery.friendlyError,
                    failed_at: new Date().toISOString(),
                    refunded: refundOk,
                    refunded_at: refundOk ? new Date().toISOString() : null,
                    attempts: nextAttempts,
                    reconciliation_attempts: nextAttempts,
                    next_check_at: null
                });

                if (refundOk) {
                    await createNotification(
                        order.user_id,
                        'Transaction Failed - Refunded',
                        `Your ${order.service_type} purchase of ₦${parseFloat(order.customer_amount).toFixed(2)} failed. Your wallet has been refunded.`,
                        'error'
                    );
                    await issuesBridge().closeForRecord({
                        service: 'bills',
                        internalId: order.id,
                        notes: 'Auto-resolved: failed bill refunded'
                    });
                    return { action: 'failed_refunded', orderId: order.id };
                }

                // Refund did not succeed — raise critical.
                await issuesBridge().raise({
                    service:        'bills',
                    provider:       'vtpass',
                    issueType:      'PROVIDER_FAILURE_NOT_REFUNDED',
                    internalTable:  'bill_payment_transactions',
                    internalId:     order.id,
                    internalRef:    order.reference,
                    providerRef:    order.provider_request_id,
                    userId:         order.user_id,
                    amount:         order.customer_amount || null,
                    currency:       'NGN',
                    internalStatus: order.status,
                    providerStatus: requery.providerStatus || null,
                    reason:         'Provider failure but refund did not complete'
                });
                return { action: 'refund_failed', orderId: order.id };
            } catch (refundError) {
                console.error(`${logPrefix} refund failed:`, refundError.message);
                await moveToManualReview(order, `Refund failed: ${refundError.message}`);
                await issuesBridge().raise({
                    service:        'bills',
                    provider:       'vtpass',
                    issueType:      'PROVIDER_FAILURE_NOT_REFUNDED',
                    internalTable:  'bill_payment_transactions',
                    internalId:     order.id,
                    internalRef:    order.reference,
                    providerRef:    order.provider_request_id,
                    userId:         order.user_id,
                    amount:         order.customer_amount || null,
                    currency:       'NGN',
                    internalStatus: order.status,
                    providerStatus: requery.providerStatus || null,
                    reason:         `Refund threw: ${refundError.message}`
                });
                return { action: 'refund_failed', orderId: order.id };
            }
        } else {
            await updateTransaction(order.id, {
                status: 'failed',
                provider_status: requery.providerStatus,
                provider_code: requery.code,
                failure_reason: requery.friendlyError,
                failed_at: new Date().toISOString(),
                attempts: nextAttempts,
                reconciliation_attempts: nextAttempts,
                next_check_at: null
            });
            return { action: 'failed_no_ledger', orderId: order.id };
        }
    }

    // Still processing.
    await recordAttempt(order.id, {
        errorMessage: `Still ${requery.state || 'processing'}`,
        attempts: nextAttempts
    });
    await updateTransaction(order.id, {
        status: 'processing',
        provider_status: requery.providerStatus,
        provider_code: requery.code
    });
    return { action: 'still_processing', orderId: order.id };
}

// ─── RUN SWEEP ───────────────────────────────────────────────────────
async function runSweep() {
    const startedAt = Date.now();

    const summary = {
        startedAt: new Date(startedAt).toISOString(),
        scanned: 0,
        completed: 0,
        refunded: 0,
        stillProcessing: 0,
        manualReview: 0,
        requeryFailed: 0,
        refundFailed: 0,
        errors: 0,
        durationMs: 0
    };

    let orders;
    try {
        orders = await findStuckOrders();
    } catch (err) {
        console.error('[BILLS RECON] findStuckOrders failed:', err.message);
        summary.errors++;
        summary.durationMs = Date.now() - startedAt;
        return summary;
    }

    summary.scanned = orders.length;

    for (const order of orders) {
        try {
            const result = await reconcileOne(order);
            switch (result.action) {
                case 'completed':          summary.completed++;        break;
                case 'failed_refunded':    summary.refunded++;         break;
                case 'failed_no_ledger':   summary.refunded++;         break;
                case 'still_processing':   summary.stillProcessing++;  break;
                case 'manual_review':      summary.manualReview++;     break;
                case 'requery_failed':     summary.requeryFailed++;    break;
                case 'refund_failed':      summary.refundFailed++;     break;
                default: break;
            }
        } catch (err) {
            console.error(`[BILLS RECON ${order.reference}] reconcileOne threw:`, err.message);
            summary.errors++;
        }
    }

    summary.durationMs = Date.now() - startedAt;
    return summary;
}

// ─── SCHEDULER ───────────────────────────────────────────────────────
function scheduleNext() {
    if (schedulerStopped) return;
    schedulerHandle = setTimeout(async () => {
        if (running) {
            console.warn('[BILLS RECON] previous sweep still running — skipping tick');
            scheduleNext();
            return;
        }
        running = true;
        try {
            const summary = await runSweep();
            if (summary.scanned > 0) {
                console.log(
                    `[BILLS RECON] Sweep: scanned=${summary.scanned} completed=${summary.completed} ` +
                    `refunded=${summary.refunded} still=${summary.stillProcessing} ` +
                    `manual=${summary.manualReview} duration=${summary.durationMs}ms`
                );
            }
        } catch (err) {
            console.error('[BILLS RECON] Sweep error:', err.message);
        } finally {
            running = false;
            scheduleNext();
        }
    }, INTERVAL_MS);
    if (schedulerHandle.unref) schedulerHandle.unref();
}

function startBillsReconciliationScheduler() {
    if (schedulerHandle) {
        console.log('[BILLS RECON] Scheduler already running');
        return schedulerHandle;
    }
    schedulerStopped = false;
    console.log(`[BILLS RECON] Starting scheduler (every ${Math.round(INTERVAL_MS / 1000)}s)`);

    // Initial run after 15s.
    schedulerHandle = setTimeout(async () => {
        try {
            const summary = await runSweep();
            console.log(
                `[BILLS RECON] Initial sweep: scanned=${summary.scanned} completed=${summary.completed} ` +
                `refunded=${summary.refunded} duration=${summary.durationMs}ms`
            );
        } catch (err) {
            console.error('[BILLS RECON] Initial sweep failed:', err.message);
        } finally {
            scheduleNext();
        }
    }, 15000);
    if (schedulerHandle.unref) schedulerHandle.unref();
    return schedulerHandle;
}

function stopBillsReconciliationScheduler() {
    schedulerStopped = true;
    if (schedulerHandle) {
        clearTimeout(schedulerHandle);
        schedulerHandle = null;
        console.log('[BILLS RECON] Scheduler stopped');
    }
}

module.exports = {
    startBillsReconciliationScheduler,
    stopBillsReconciliationScheduler,
    runSweep,
    reconcileOne,
    // Exported for adapter/tests.
    findStuckOrders,
    getBackoffNextCheckAt
};