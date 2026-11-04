// reconciliation/autoClose.js
// ─────────────────────────────────────────────────────────────────
// Auto-close pass — "if the internal record is now consistent,
// close the issue".
//
// The engine calls this after every sweep. It scans open issues
// that are older than 5 minutes (younger ones are still being
// actively worked by the sweep) and, for each, asks the adapter:
// "is this record now terminal AND consistent with the ledger?"
//
// The adapter answers via adapter.isConsistent(record, ledgerCheck)
// which the adapter implements (see deliverable 4).
//
// What "consistent" means per service:
//   kora         record.status='completed' AND credit ledger row exists
//   nowpayments  record.status='completed' AND credit ledger row exists
//   airtime      record.status IN ('completed','refunded')
//   bills        record.status IN ('completed','refunded')
//   esim         record.status IN ('completed','refunded')
//   giftcard     record.status IN ('completed','refunded')
//
// This is the pass that closes issues when a webhook settled the
// record while the issue was open. Without it, an issue can stay
// open for the full 26-hour manual-review window even after the
// user has been credited. That happens today; the admin sees
// "PENDING_TOO_LONG" on a deposit the user already got.
// ─────────────────────────────────────────────────────────────────
'use strict';

const { supabaseAdmin } = require('../db/supabase');

const MIN_AGE_MS = 5 * 60 * 1000;
const BATCH_SIZE = 100;

/**
 * @param {object} args
 * @param {object} args.adapter           the adapter for this service
 * @param {function} args.issuesBridge   { raise, closeForRecord }
 * @returns {Promise<{ scanned, closed }>}
 */
async function runAutoClose({ adapter, issuesBridge }) {
    if (!adapter) return { scanned: 0, closed: 0 };

    const cutoff = new Date(Date.now() - MIN_AGE_MS).toISOString();

    const { data: openIssues, error } = await supabaseAdmin
        .from('reconciliation_issues')
        .select('id, service, internal_table, internal_id, internal_status, issue_type')
        .eq('service', adapter.key)
        .in('status', ['open', 'assigned', 'investigating'])
        .lt('created_at', cutoff)
        .order('created_at', { ascending: true })
        .limit(BATCH_SIZE);

    if (error) {
        console.warn('[AUTOCLOSE] read failed:', error.message);
        return { scanned: 0, closed: 0 };
    }
    if (!openIssues || !openIssues.length) return { scanned: 0, closed: 0 };

    let closed = 0;
    for (const issue of openIssues) {
        try {
            // Fetch the current internal record.
            const { data: record, error: recErr } = await supabaseAdmin
                .from(adapter.table)
                .select('*')
                .eq('id', issue.internal_id)
                .maybeSingle();
            if (recErr || !record) continue;

            // Ask the adapter. If the adapter doesn't implement
            // isConsistent, skip (do not guess).
            if (typeof adapter.isConsistent !== 'function') continue;

            const consistent = await adapter.isConsistent(record);
            if (consistent !== true) continue;

            await issuesBridge.closeForRecord({
                service: adapter.key,
                internalId: issue.internal_id,
                notes: `Auto-closed by sweep: ${adapter.key} record ${record.status} is now terminal and consistent.`
            });
            closed++;
        } catch (err) {
            console.warn(
                `[AUTOCLOSE] issue ${issue.id} check failed:`,
                err.message
            );
            // Continue — never fail the whole pass on one record.
        }
    }

    return { scanned: openIssues.length, closed };
}

module.exports = { runAutoClose };