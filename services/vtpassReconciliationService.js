// services/vtpassReconciliationService.js
// Background worker: resolves pending VTpass orders every 60–120 s.
'use strict';

const { supabaseAdmin } = require('../db/supabase');
const vtpassService = require('./vtpassService');
const { attemptRefund, createNotification } = require('./billsFulfillment');

const MAX_AGE_MS = 25 * 60 * 1000;
const MIN_AGE_MS = 90 * 1000;
const BATCH_SIZE = 50;

let sweepRunning = false;

async function runSweep() {
    if (sweepRunning) return { scanned: 0, completed: 0, refunded: 0, manualReview: 0 };
    sweepRunning = true;
    const counts = { scanned: 0, completed: 0, refunded: 0, stillProcessing: 0, manualReview: 0, requeryFailed: 0, refundFailed: 0 };
    try {
        const ageCutoff = new Date(Date.now() - MIN_AGE_MS).toISOString();
        const { data: pending, error } = await supabaseAdmin
            .from('bill_payment_transactions')
            .select('*')
            .in('service_type', ['airtime', 'data', 'electricity', 'tv'])
            .eq('status', 'processing')
            .not('provider_request_id', 'is', null)
            .lt('created_at', ageCutoff)
            .order('created_at', { ascending: true })
            .limit(BATCH_SIZE);

        if (error) { console.warn('[VTPASS RECON] read failed:', error.message); return counts; }
        counts.scanned = (pending || []).length;

        for (const row of (pending || [])) {
            // Claim atomically.
            const { data: claimed } = await supabaseAdmin
                .from('bill_payment_transactions')
                .update({
                    last_reconciliation_at: new Date().toISOString(),
                    reconciliation_attempts: (row.reconciliation_attempts || 0) + 1
                })
                .eq('id', row.id).eq('status', 'processing')
                .select('*').maybeSingle();
            if (!claimed) continue;

            let result;
            try {
                result = await vtpassService.queryTransaction(claimed.provider_request_id);
            } catch (e) {
                counts.requeryFailed++;
                continue;
            }

            const state = result.state || 'processing';

            if (state === 'completed') {
                await supabaseAdmin.from('bill_payment_transactions')
                    .update({
                        status: 'completed',
                        provider_status: result.providerStatus || 'COMPLETED',
                        provider_code: result.code || null,
                        token: result.token || claimed.token,
                        units: result.units || claimed.units,
                        completed_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', claimed.id).eq('status', 'processing');
                counts.completed++;
                await createNotification(claimed.user_id, 'Purchase completed',
                    `Your ${claimed.service_type} order ${claimed.reference} was delivered.`, 'success', '/bills');
                continue;
            }

            if (state === 'failed') {
                const refundOutcome = await attemptRefund({
                    userId: claimed.user_id,
                    ledgerTransactionId: claimed.ledger_transaction_id,
                    reason: result.friendlyError || result.errorMessage || 'Provider failed',
                    sourceContext: { bill_transaction_id: claimed.id, reference: claimed.reference, via: 'reconciler' }
                });
                const refunded = !!refundOutcome.success;
                await supabaseAdmin.from('bill_payment_transactions')
                    .update({
                        status: refunded ? 'refunded' : 'failed',
                        provider_status: result.providerStatus || 'FAILED',
                        provider_code: result.code || null,
                        failure_reason: result.friendlyError || result.errorMessage || 'Provider failed',
                        failed_at: new Date().toISOString(),
                        refunded,
                        refunded_at: refunded ? new Date().toISOString() : null,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', claimed.id).eq('status', 'processing');
                if (refunded) {
                    counts.refunded++;
                    await createNotification(claimed.user_id, 'Purchase failed — refunded',
                        `Your ${claimed.service_type} order was not completed. Your wallet has been refunded.`,
                        'error', '/bills');
                } else {
                    counts.refundFailed++;
                    await supabaseAdmin.from('bill_payment_transactions')
                        .update({ status: 'manual_review', updated_at: new Date().toISOString() })
                        .eq('id', claimed.id);
                    counts.manualReview++;
                }
                continue;
            }

            // Still processing — check age.
            const ageMs = Date.now() - new Date(claimed.created_at).getTime();
            if (ageMs >= MAX_AGE_MS) {
                await supabaseAdmin.from('bill_payment_transactions')
                    .update({ status: 'manual_review', failure_reason: 'Exceeded 25min without final status', updated_at: new Date().toISOString() })
                    .eq('id', claimed.id).eq('status', 'processing');
                counts.manualReview++;
            } else {
                counts.stillProcessing++;
            }
        }
    } finally {
        sweepRunning = false;
    }
    return counts;
}

let intervalId = null;
function start() {
    if (intervalId) return;
    intervalId = setInterval(() => {
        runSweep().catch(e => console.error('[VTPASS RECON] sweep error:', e.message));
    }, 90 * 1000);
    console.log('[VTPASS RECON] Worker started (90s interval)');
}
function stop() {
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
}

module.exports = { runSweep, start, stop };