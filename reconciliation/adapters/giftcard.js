// reconciliation/adapters/giftcard.js
// ─────────────────────────────────────────────────────────────────
// Gift card adapter. Delegates to airtimeReconciliationService.sweepService().
// Same limitations and same refund-signature bug as airtime/eSIM.
// ─────────────────────────────────────────────────────────────────
'use strict';

const { supabaseAdmin } = require('../../db/supabase');
const airtimeWorker = require('../../services/airtimeReconciliationService');
const issuesBridge  = require('../issuesBridge');

const KEY       = 'giftcard';
const PROVIDER  = 'dtone';
const TABLE     = 'giftcard_transactions';
const LOCK_NAME = `recon:${KEY}:${TABLE}`;

const PENDING_STATUSES = ['processing', 'pending', 'provider_unknown'];
const TERMINAL_STATUSES = ['completed', 'failed', 'refunded', 'cancelled'];

async function findCandidates(_limit) { return []; }
async function verify(_record) { throw new Error('giftcard.verify: not used'); }
function validate(_record, _verified) { throw new Error('giftcard.validate: not used'); }
async function settle(_record, _verified) { throw new Error('giftcard.settle: not used'); }
async function markFailed(_record, _verified) { throw new Error('giftcard.markFailed: not used'); }

async function runSweep() {
    const serviceDef = airtimeWorker.SERVICES.find(s => s.table === TABLE);
    if (!serviceDef) throw new Error('GiftCard not wired in airtimeReconciliationService');

    const workerResult = await airtimeWorker.sweepService(serviceDef);

    const counts = {
        scanned:      workerResult.processed    || 0,
        settled:      workerResult.completed    || 0,
        failed:       workerResult.refunded     || 0,
        manual_review:workerResult.manualReview || 0,
        rate_limited: 0,
        skipped:      (workerResult.notFound         || 0) +
                      (workerResult.providerUnknown  || 0)
    };

    await raiseIssuesForStuckRecords();
    return counts;
}

async function raiseIssuesForStuckRecords() {
    const { data: unknowns } = await supabaseAdmin
        .from(TABLE)
        .select('id, user_id, reference, price_ngn, face_value, status, provider_status, failure_reason')
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
            userId:         rec.user_id,
            amount:         rec.price_ngn || rec.face_value,
            currency:       'NGN',
            internalStatus: rec.status,
            providerStatus: rec.provider_status,
            reason:         rec.failure_reason || 'Provider returned unknown status',
            nextVerifyAt:   new Date(Date.now() + 30 * 60_000)
        });
    }

    const { data: manuals } = await supabaseAdmin
        .from(TABLE)
        .select('id, user_id, reference, price_ngn, face_value, status, provider_status, failure_reason')
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
            userId:         rec.user_id,
            amount:         rec.price_ngn || rec.face_value,
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

function amountFor(record) { return record.price_ngn || record.face_value || null; }
function currencyFor(record) { return record.debit_currency || 'NGN'; }

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