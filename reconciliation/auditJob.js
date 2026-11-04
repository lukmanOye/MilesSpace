// reconciliation/auditJob.js
// ─────────────────────────────────────────────────────────────────
// Daily audit — provider list vs internal records vs ledger.
//
// For each service and a target date, this job:
//   1. Asks the adapter for the provider's transaction list for the
//      day (listProviderTransactions). If null → skipped (no list
//      API available for this provider; log to run.metadata).
//   2. Fetches all internal records that should correspond to that
//      list, keyed by provider reference.
//   3. Compares:
//        - provider success with no internal record → MISSING_WEBHOOK
//        - amount/currency disagree                → AMOUNT_MISMATCH
//        - two provider rows sharing a ref        → DUPLICATE
//        - internal 'completed' with no ledger    → LEDGER_MISMATCH
//        - provider failure with debit, no refund → PROVIDER_FAILURE_NOT_REFUNDED
//   4. Persists a run row (type='audit') with per-service counts.
//   5. Persists a reconciliation_audit_summary row per service.
//
// Idempotency:
//   The partial unique index on reconciliation_issues (service,
//   internal_id WHERE status IN open) makes every raise a no-op if
//   the issue already exists. Running the audit twice on the same
//   day for the same service produces the same set of open issues,
//   not two sets.
//
//   The audit does NOT auto-close anything. Issues close via the
//   engine's auto-close pass, not the audit. The audit is diagnostic.
//
// Money-move risk:
//   Zero. The audit cannot credit or refund. It can only create
//   issues and run rows. Even a provider list full of fabricated
//   successes would only create issues, which the admin then has to
//   act on. This is deliberate — the audit is a safety net that
//   cannot itself cause a double-credit.
// ─────────────────────────────────────────────────────────────────
'use strict';

const { supabaseAdmin } = require('../db/supabase');
const issuesSvc = require('../services/reconciliationIssuesService');
const { getAdapter, listAdapters } = require('./adapters');

const PROVIDER_REF_FIELDS = {
    kora:         (r) => r.provider_reference || r.merchant_reference,
    nowpayments:  (r) => r.nowpayments_payment_id,
    airtime:      (r) => r.provider_transaction_id || r.dtone_external_id,
    bills:        (r) => r.provider_request_id,
    esim:         (r) => r.provider_transaction_id || r.dtone_external_id,
    giftcard:     (r) => r.provider_transaction_id || r.dtone_external_id
};

const INTERNAL_STATUS_COLUMN = 'status';

function log(...a)    { console.log('[RECON AUDIT]', ...a); }
function logErr(...a) { console.error('[RECON AUDIT]', ...a); }

// ─── Date window ─────────────────────────────────────────────────
// `forDate` is 'YYYY-MM-DD'. Interpreted as UTC day.
function dateWindow(forDate) {
    const from = new Date(`${forDate}T00:00:00Z`);
    const to = new Date(`${forDate}T23:59:59.999Z`);
    if (Number.isNaN(from.getTime())) {
        throw Object.assign(new Error('Invalid date (expected YYYY-MM-DD)'), { status: 400, code: 'INVALID_DATE' });
    }
    return { from, to };
}

// ─── Load internal records ───────────────────────────────────────
async function loadInternalRecords(adapter, from, to) {
    const { data, error } = await supabaseAdmin
        .from(adapter.table)
        .select('*')
        .gte('created_at', from.toISOString())
        .lte('created_at', to.toISOString());
    if (error) throw error;
    return data || [];
}

// ─── Compare one service ─────────────────────────────────────────
async function auditOneService({ adapter, forDate, runId }) {
    const counts = {
        provider_count: 0,
        internal_count: 0,
        ledger_count: 0,
        missing_webhook_count: 0,
        amount_mismatch_count: 0,
        duplicate_count: 0,
        ledger_mismatch_count: 0,
        provider_failure_no_refund_count: 0
    };

    let from, to;
    try {
        ({ from, to } = dateWindow(forDate));
    } catch (e) {
        return { skipped: true, reason: 'invalid_date', counts };
    }

    if (typeof adapter.listProviderTransactions !== 'function') {
        log(`${adapter.key}: no listProviderTransactions — skipping`);
        return { skipped: true, reason: 'no_provider_list', counts };
    }

    let providerRows;
    try {
        providerRows = await adapter.listProviderTransactions(from, to);
    } catch (e) {
        logErr(`${adapter.key}: provider list failed — ${e.message}`);
        return { skipped: true, reason: `provider_list_failed: ${e.message}`, counts };
    }
    if (providerRows === null) {
        return { skipped: true, reason: 'provider_list_unavailable', counts };
    }
    if (!Array.isArray(providerRows)) {
        return { skipped: true, reason: 'provider_list_not_array', counts };
    }

    counts.provider_count = providerRows.length;

    const internalRows = await loadInternalRecords(adapter, from, to);
    counts.internal_count = internalRows.length;

    const getRef = PROVIDER_REF_FIELDS[adapter.key];
    if (!getRef) {
        return { skipped: true, reason: 'no_ref_extractor', counts };
    }

    // ── Index internal records by provider reference ─────────────
    const byRef = new Map();
    for (const row of internalRows) {
        const ref = getRef(row);
        if (!ref) continue;
        if (!byRef.has(ref)) byRef.set(ref, []);
        byRef.get(ref).push(row);
    }

    // ── Index provider rows by reference (detects DUPLICATE) ─────
    const providerByRef = new Map();
    for (const p of providerRows) {
        const ref = p.reference || p.payment_reference || p.id || p.payment_id;
        if (!ref) continue;
        if (!providerByRef.has(ref)) providerByRef.set(ref, []);
        providerByRef.get(ref).push(p);
    }

    // ── DUPLICATE — the provider returned two rows for one reference ─
    for (const [ref, rows] of providerByRef) {
        if (rows.length > 1) {
            // The internal row (if any) is a single row; the duplicate
            // is on the provider side.
            const internal = byRef.get(ref)?.[0] || null;
            counts.duplicate_count++;
            await issuesSvc.upsertIssue({
                service:        adapter.key,
                provider:       adapter.provider,
                issueType:      'DUPLICATE',
                internalTable:  adapter.table,
                internalId:     internal?.id || null,
                internalRef:    internal?.reference || ref,
                providerRef:    ref,
                userId:         internal?.user_id || null,
                amount:         null,
                currency:       null,
                internalStatus: internal?.status || null,
                providerStatus: 'duplicate',
                reason:         `Provider returned ${rows.length} rows for reference ${ref} on ${forDate}`,
                metadata:       { provider_row_ids: rows.map(r => r.id || r.payment_id).slice(0, 5) },
                actor:          'system:audit'
            }).catch(e => logErr(`raise DUPLICATE failed: ${e.message}`));
        }
    }

    // ── Compare each provider row against its internal counterpart ─
    for (const p of providerRows) {
        const ref = p.reference || p.payment_reference || p.id || p.payment_id;
        if (!ref) continue;

        const providerStatus = String(p.status || p.provider_status || '').toLowerCase();
        const providerAmount = Number(p.amount ?? p.price_amount ?? p.outcome_amount ?? 0);
        const providerCurrency = String(p.currency || p.price_currency || '').toUpperCase();

        const internal = byRef.get(ref)?.[0] || null;

        if (!internal) {
            // Provider has a row we don't. Two sub-cases:
            //   - provider succeeded → MISSING_WEBHOOK
            //   - provider failed    → ignore (we correctly have nothing)
            if (['success', 'successful', 'completed', 'finished'].includes(providerStatus)) {
                counts.missing_webhook_count++;
                await issuesSvc.upsertIssue({
                    service:        adapter.key,
                    provider:       adapter.provider,
                    issueType:      'MISSING_WEBHOOK',
                    internalTable:  adapter.table,
                    internalId:     null,          // no internal row exists
                    internalRef:    null,
                    providerRef:    ref,
                    userId:         null,
                    amount:         providerAmount || null,
                    currency:       providerCurrency || null,
                    internalStatus: null,
                    providerStatus,
                    reason:         `Provider success with no internal record (${forDate})`,
                    metadata:       { provider_row: { amount: providerAmount, currency: providerCurrency } },
                    actor:          'system:audit'
                }).catch(e => logErr(`raise MISSING_WEBHOOK failed: ${e.message}`));
            }
            continue;
        }

        // Both sides have a row. Check amounts.
        const internalAmount = Number(
            internal.amount ?? internal.wallet_amount ?? internal.price_ngn ??
            internal.requested_usd ?? 0
        );
        const internalCurrency = String(
            internal.currency || internal.wallet_currency || internal.debit_currency || ''
        ).toUpperCase();

        if (providerAmount > 0 && internalAmount > 0 &&
            providerCurrency && internalCurrency &&
            providerCurrency === internalCurrency &&
            Math.abs(providerAmount - internalAmount) / Math.max(providerAmount, internalAmount) > 0.02) {
            counts.amount_mismatch_count++;
            await issuesSvc.upsertIssue({
                service:        adapter.key,
                provider:       adapter.provider,
                issueType:      'AMOUNT_MISMATCH',
                internalTable:  adapter.table,
                internalId:     internal.id,
                internalRef:    internal.reference || null,
                providerRef:    ref,
                userId:         internal.user_id || null,
                amount:         internalAmount,
                currency:       internalCurrency,
                internalStatus: internal.status,
                providerStatus,
                reason:         `Provider ${providerAmount} ${providerCurrency} vs internal ${internalAmount} ${internalCurrency}`,
                metadata:       { provider_amount: providerAmount, internal_amount: internalAmount },
                actor:          'system:audit'
            }).catch(e => logErr(`raise AMOUNT_MISMATCH failed: ${e.message}`));
        }

        // Ledger check for deposits.
        if (internal.status === 'completed' &&
            ['deposit_requests', 'crypto_deposits'].includes(adapter.table)) {
            const sourceType = adapter.table === 'deposit_requests' ? 'kora_deposit' : 'crypto_deposit';
            const { data: tx } = await supabaseAdmin
                .from('transactions')
                .select('id, status')
                .eq('source_type', sourceType)
                .eq('source_id', internal.id)
                .eq('type', 'deposit')
                .maybeSingle();
            if (!tx || tx.status !== 'completed') {
                counts.ledger_mismatch_count++;
                await issuesSvc.upsertIssue({
                    service:        adapter.key,
                    provider:       adapter.provider,
                    issueType:      'LEDGER_MISMATCH',
                    internalTable:  adapter.table,
                    internalId:     internal.id,
                    internalRef:    internal.reference || null,
                    providerRef:    ref,
                    userId:         internal.user_id || null,
                    amount:         internalAmount || null,
                    currency:       internalCurrency || null,
                    internalStatus: internal.status,
                    providerStatus,
                    reason:         `Internal status=completed but no completed ledger transaction (${forDate})`,
                    actor:          'system:audit'
                }).catch(e => logErr(`raise LEDGER_MISMATCH failed: ${e.message}`));
            } else {
                counts.ledger_count++;
            }
        }

        // Provider failed but internal record has no refund.
        if (['failed', 'expired', 'rejected'].includes(providerStatus) &&
            ['airtime_transactions', 'bill_payment_transactions',
             'esim_transactions', 'giftcard_transactions'].includes(adapter.table)) {
            const refunded = internal.refunded === true ||
                String(internal.status || '').toLowerCase() === 'refunded';
            if (!refunded && internal.ledger_transaction_id) {
                counts.provider_failure_no_refund_count++;
                await issuesSvc.upsertIssue({
                    service:        adapter.key,
                    provider:       adapter.provider,
                    issueType:      'PROVIDER_FAILURE_NOT_REFUNDED',
                    internalTable:  adapter.table,
                    internalId:     internal.id,
                    internalRef:    internal.reference || null,
                    providerRef:    ref,
                    userId:         internal.user_id || null,
                    amount:         internalAmount || null,
                    currency:       internalCurrency || null,
                    internalStatus: internal.status,
                    providerStatus,
                    reason:         `Provider ${providerStatus}, internal not refunded (${forDate})`,
                    actor:          'system:audit'
                }).catch(e => logErr(`raise PROVIDER_FAILURE_NOT_REFUNDED failed: ${e.message}`));
            }
        }
    }

    return { skipped: false, counts };
}

// ─── Public: run a full audit ────────────────────────────────────
/**
 * @param {object} opts
 * @param {string} [opts.forDate]    'YYYY-MM-DD', defaults to yesterday UTC
 * @param {string} [opts.service]    limit to one adapter, or undefined for all
 * @param {object} [opts.ctx]        { adminId, adminEmail } when triggered manually
 */
async function runDailyAudit(opts = {}) {
    const forDate = opts.forDate || (() => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
    })();

    const { from, to } = dateWindow(forDate);
    log(`Starting daily audit for ${forDate}`);

    const adaptersToRun = opts.service
        ? [getAdapter(opts.service)]
        : listAdapters().map(a => getAdapter(a.key));

    const overall = {
        for_date: forDate,
        by_service: {},
        total_scanned: 0,
        total_issues_raised: 0
    };

    for (const adapter of adaptersToRun) {
        // One run row per service so failures are isolated.
        const { data: run, error: runErr } = await supabaseAdmin
            .from('reconciliation_runs')
            .insert({
                provider: adapter.provider,
                service: adapter.key,
                type: 'audit',
                status: 'running',
                range_from: from.toISOString(),
                range_to: to.toISOString(),
                triggered_by: opts.ctx?.adminId || null,
                triggered_by_email: opts.ctx?.adminEmail || null,
                metadata: { audit_date: forDate },
                started_at: new Date().toISOString()
            })
            .select('*')
            .single();

        if (runErr) {
            logErr(`run insert failed for ${adapter.key}:`, runErr.message);
            overall.by_service[adapter.key] = { error: runErr.message };
            continue;
        }

        let result;
        try {
            result = await auditOneService({ adapter, forDate, runId: run.id });
        } catch (e) {
            logErr(`${adapter.key}: audit threw — ${e.message}`);
            await supabaseAdmin
                .from('reconciliation_runs')
                .update({
                    status: 'failed',
                    error: e.message,
                    finished_at: new Date().toISOString()
                })
                .eq('id', run.id);
            overall.by_service[adapter.key] = { error: e.message };
            continue;
        }

        if (result.skipped) {
            await supabaseAdmin
                .from('reconciliation_runs')
                .update({
                    status: 'skipped',
                    scanned: result.counts.provider_count || 0,
                    skipped: result.counts.internal_count || 0,
                    metadata: { audit_date: forDate, skip_reason: result.reason },
                    finished_at: new Date().toISOString()
                })
                .eq('id', run.id);
            overall.by_service[adapter.key] = { skipped: true, reason: result.reason };
            continue;
        }

        // Persist the summary row.
        try {
            await supabaseAdmin
                .from('reconciliation_audit_summary')
                .insert({
                    run_id: run.id,
                    service: adapter.key,
                    audit_date: forDate,
                    provider_count: result.counts.provider_count,
                    internal_count: result.counts.internal_count,
                    ledger_count: result.counts.ledger_count,
                    missing_webhook_count: result.counts.missing_webhook_count,
                    amount_mismatch_count: result.counts.amount_mismatch_count,
                    duplicate_count: result.counts.duplicate_count,
                    ledger_mismatch_count: result.counts.ledger_mismatch_count,
                    provider_failure_no_refund_count: result.counts.provider_failure_no_refund_count
                });
        } catch (e) {
            logErr(`summary insert failed for ${adapter.key}:`, e.message);
        }

        await supabaseAdmin
            .from('reconciliation_runs')
            .update({
                status: 'completed',
                scanned: result.counts.provider_count,
                settled: result.counts.internal_count,
                failed: (result.counts.missing_webhook_count || 0) +
                        (result.counts.amount_mismatch_count || 0) +
                        (result.counts.duplicate_count || 0) +
                        (result.counts.ledger_mismatch_count || 0) +
                        (result.counts.provider_failure_no_refund_count || 0),
                metadata: { audit_date: forDate, counts: result.counts },
                finished_at: new Date().toISOString()
            })
            .eq('id', run.id);

        overall.by_service[adapter.key] = result.counts;
        overall.total_scanned += result.counts.provider_count || 0;
        overall.total_issues_raised +=
            (result.counts.missing_webhook_count || 0) +
            (result.counts.amount_mismatch_count || 0) +
            (result.counts.duplicate_count || 0) +
            (result.counts.ledger_mismatch_count || 0) +
            (result.counts.provider_failure_no_refund_count || 0);
    }

    log(`Daily audit complete: ${overall.total_issues_raised} issue(s) raised across ${overall.total_scanned} provider row(s)`);
    return overall;
}

module.exports = { runDailyAudit, dateWindow };