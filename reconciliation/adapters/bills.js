// reconciliation/adapters/bills.js
// ─────────────────────────────────────────────────────────────────
// Bills adapter. Delegates to billsReconciliationService.runSweep().
//
// ⚠️ IMPORTANT LIMITATION (same as airtime):
//   billsReconciliationService uses MAX_ATTEMPTS=20 hard cap and
//   its own setInterval scheduler. It has the same hard-stop issue
//   as airtime. The adapter cannot fix that without rewriting
//   billsReconciliationService.
//
//   billsReconciliationService.runSweep() also calls
//   LedgerService.refundTransaction() with the OLD positional
//   signature:
//     LedgerService.refundTransaction(userId, transactionId, reason)
//   But the actual signature is
//     refundTransaction({ userId, transactionId, reason, ... })
//   This means EVERY bills auto-refund in production throws inside
//   refundTransaction and is caught, ending with manual_review.
//   This is a pre-existing production bug — fixing it is out of
//   scope for the reconciliation engine, but you MUST fix it in
//   billsReconciliationService before this adapter can do its job.
//   See the migration note in deliverable 5.
// ─────────────────────────────────────────────────────────────────
'use strict';

const { supabaseAdmin } = require('../../db/supabase');
const billsWorker = require('../../services/billsReconciliationService');
const issuesBridge = require('../issuesBridge');

const KEY       = 'bills';
const PROVIDER  = 'vtpass';
const TABLE     = 'bill_payment_transactions';
const LOCK_NAME = `recon:${KEY}:${TABLE}`;

const PENDING_STATUSES = ['pending', 'processing', 'provider_unknown'];
const TERMINAL_STATUSES = ['completed', 'failed', 'refunded', 'cancelled'];

async function findCandidates(_limit) { return []; }

async function verify(_record) { throw new Error('bills.verify: not used'); }
function validate(_record, _verified) { throw new Error('bills.validate: not used'); }
async function settle(_record, _verified) { throw new Error('bills.settle: not used'); }
async function markFailed(_record, _verified) { throw new Error('bills.markFailed: not used'); }

async function runSweep() {
    const workerResult = await billsWorker.runSweep();

    const counts = {
        scanned:      workerResult.scanned         || 0,
        settled:      workerResult.completed       || 0,
        failed:       workerResult.refunded        || 0,
        manual_review:workerResult.manualReview    || 0,
        rate_limited: 0,
        skipped:      (workerResult.stillProcessing || 0) +
                      (workerResult.requeryFailed  || 0) +
                      (workerResult.refundFailed   || 0) +
                      (workerResult.errors         || 0)
    };

    await raiseIssuesForStuckRecords();

    return counts;
}

async function raiseIssuesForStuckRecords() {
    const { data: unknowns } = await supabaseAdmin
        .from(TABLE)
        .select('id, user_id, reference, customer_amount, status, provider_status, failure_reason')
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
            amount:         rec.customer_amount,
            currency:       'NGN',
            internalStatus: rec.status,
            providerStatus: rec.provider_status,
            reason:         rec.failure_reason || 'Provider returned unknown status',
            nextVerifyAt:   new Date(Date.now() + 30 * 60_000)
        });
    }

    const { data: manuals } = await supabaseAdmin
        .from(TABLE)
        .select('id, user_id, reference, customer_amount, status, provider_status, failure_reason')
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
            amount:         rec.customer_amount,
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

function amountFor(record) { return record.customer_amount || null; }
function currencyFor(_record) { return 'NGN'; }

// ─── listProviderTransactions ─────────────────────────────────
// VTpass does not expose a "list transactions for a day" endpoint
// on its standard plans. Like Kora, we accept a manual CSV:
//     data/vtpass-recon/{YYYY-MM-DD}.csv
// with columns: requestId,amount,status
async function listProviderTransactions(from, to) {
    const fs = require('fs');
    const path = require('path');
    const day = from.toISOString().slice(0, 10);
    const filePath = path.join(__dirname, '..', '..', 'data', 'vtpass-recon', `${day}.csv`);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const header = lines[0].split(',').map(s => s.trim().toLowerCase());
    const refIdx = header.indexOf('requestid');
    const amtIdx = header.indexOf('amount');
    const stIdx = header.indexOf('status');
    if (refIdx < 0 || amtIdx < 0 || stIdx < 0) {
        throw new Error('vtpass recon CSV is missing required columns');
    }
    return lines.slice(1).map(line => {
        const parts = line.split(',');
        return {
            provider_request_id: parts[refIdx],
            reference: parts[refIdx],
            amount: parts[amtIdx],
            currency: 'NGN',
            status: parts[stIdx],
            provider_status: parts[stIdx]
        };
    });
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

    _delegatesToWorker: true,
    runSweep
};