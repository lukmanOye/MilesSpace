// reconciliation/runs.js
// ─────────────────────────────────────────────────────────────────
// Runs lifecycle. Every engine call opens a run row at the top and
// closes it in the finally block. A run row is the durable record
// that "at <time>, the engine looked at <service> and found <counts>".
//
// The admin page's "Recent runs" table reads this table directly.
// ─────────────────────────────────────────────────────────────────
'use strict';

const { supabaseAdmin } = require('../db/supabase');

function emptyCounts() {
    return {
        scanned:      0,
        settled:      0,
        failed:       0,
        manual_review:0,
        rate_limited: 0,
        skipped:      0
    };
}

async function createRun({ provider, service, type = 'sweep', ctx = {}, from = null, to = null }) {
    const { data, error } = await supabaseAdmin
        .from('reconciliation_runs')
        .insert({
            provider,
            service,
            type,
            status:               'running',
            range_from:            from,
            range_to:              to,
            triggered_by:          ctx.adminId || null,
            triggered_by_email:    ctx.adminEmail || null,
            started_at:            new Date().toISOString(),
            scanned:               0,
            settled:               0,
            failed:                0,
            manual_review:         0,
            rate_limited:          0,
            skipped:               0,
            lock_skipped:          false
        })
        .select('*')
        .single();
    if (error) throw new Error('Could not create reconciliation run: ' + error.message);
    return data;
}

async function finishRun(runId, { status = 'completed', counts = {}, error = null, lockSkipped = false } = {}) {
    const c = { ...emptyCounts(), ...(counts || {}) };
    const VALID_STATUSES = new Set(['running', 'completed', 'failed', 'rate_limited', 'skipped']);
    const safeStatus = VALID_STATUSES.has(status) ? status : 'completed';

    const patch = {
        status: safeStatus,
        scanned:       c.scanned       || 0,
        settled:       c.settled       || 0,
        failed:        c.failed        || 0,
        manual_review: c.manual_review || 0,
        rate_limited:  c.rate_limited  || 0,
        skipped:       c.skipped       || 0,
        lock_skipped:  Boolean(lockSkipped),
        error:         error || null,
        finished_at:   new Date().toISOString()
    };

    const { error: upErr } = await supabaseAdmin
        .from('reconciliation_runs')
        .update(patch)
        .eq('id', runId);

    if (!upErr) return;

    // If the status value itself was rejected (stale CHECK constraint
    // on a fresh deploy), try once more with 'failed' — which every
    // version of the constraint allows — so the row is never left
    // permanently in 'running'.
    if (upErr.code === '23514' || /check constraint/i.test(upErr.message || '')) {
        console.warn('[RUNS] status constraint rejected "' + safeStatus + '"; retrying as "failed"');
        const { error: retryErr } = await supabaseAdmin
            .from('reconciliation_runs')
            .update({ ...patch, status: 'failed', error: (error || '') + ' (invalid status "' + status + '")' })
            .eq('id', runId);
        if (retryErr) console.error('[RUNS] retry as failed also failed:', retryErr.message);
        return;
    }

    console.error('[RUNS] finishRun failed:', upErr.message);
}

module.exports = { createRun, finishRun, emptyCounts };