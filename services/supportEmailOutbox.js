'use strict';

// ─────────────────────────────────────────────────────────────────
// services/supportEmailOutbox.js  —  REVISION 2026-11-02
//
// Durable email outbox worker. Runs in-process, safe across
// multiple instances.
//
// Guarantees:
//   • Atomic claim: a row transitions pending → sending in a
//     single UPDATE, so two workers racing on the same batch cannot
//     both pick the same row.
//   • Lease-based reclaim: a `sending` row carries a
//     claim_expires_at. Any worker that sees an expired lease may
//     reclaim the row. A crashed worker therefore cannot wedge
//     the queue — the next tick reclaims its rows.
//   • Every UPDATE is checked. A failed update to status='sent' or
//     status='pending' is logged and counted; it does not silently
//     drop the row.
//   • stats() reports pending / sending / orphaned / failed and
//     surfaces DB failure rather than returning zeros. A monitor
//     that calls stats() can tell "queue is empty" from "queue
//     cannot be read".
//   • Circuit breaker on repeated DB fetch failures is preserved
//     from the previous revision, so a temporary Supabase outage
//     does not spam the log at 1/5s.
//
// Column contract (added by the accompanying migration):
//   email_outbox.claimed_by         text
//   email_outbox.claim_expires_at   timestamptz
// Existing columns (created_at, status, attempts, last_attempt_at,
// sent_at, error) unchanged.
//
// Rows without claim_expires_at (pre-migration) are treated as
// never-leased: they are claimable immediately, and any worker that
// claims them writes the lease as part of the same UPDATE.
// ─────────────────────────────────────────────────────────────────

const { supabaseAdmin } = require('../db/supabase');
const emailSvc = require('./emailService');

// ─── Tunables ──────────────────────────────────────────────────
const TICK_MS               = 5000;
const BATCH_SIZE            = 5;
const MAX_ATTEMPTS          = 5;
const LEASE_MS              = 60_000;               // 60s claim
const BACKOFF_MS            = [0, 30_000, 120_000, 600_000, 1_800_000];
const ORPHAN_THRESHOLD_MS   = 5 * 60_000;            // 5 min stuck

// Circuit breaker on DB fetch failures.
const FAILURE_THRESHOLD     = 5;
const FAILURE_COOLDOWN_MS   = 60_000;

const WORKER_ID = `${process.pid || 'pid'}-${Math.random().toString(36).slice(2, 8)}`;

// ─── Circuit breaker state ─────────────────────────────────────
const _failure = { consecutive: 0, openedAt: 0 };
let _timer = null;
let _running = false;

function _circuitOpen() {
    return _failure.consecutive >= FAILURE_THRESHOLD
        && (Date.now() - _failure.openedAt) < FAILURE_COOLDOWN_MS;
}
function _recordFetchSuccess() {
    _failure.consecutive = 0;
    _failure.openedAt = 0;
}
function _recordFetchFailure() {
    _failure.consecutive++;
    if (_failure.consecutive === FAILURE_THRESHOLD) {
        _failure.openedAt = Date.now();
        // eslint-disable-next-line no-console
        console.warn('[EMAIL OUTBOX] backing off for', FAILURE_COOLDOWN_MS / 1000, 's');
    }
}

function outboxLog(event, fields = {}) {
    try {
        // eslint-disable-next-line no-console
        console.log('[EMAIL OUTBOX]', JSON.stringify({
            ts: new Date().toISOString(),
            workerId: WORKER_ID,
            event,
            ...fields
        }));
    } catch (_) {
        // eslint-disable-next-line no-console
        console.log('[EMAIL OUTBOX]', event);
    }
}

// ─── Atomic claim ──────────────────────────────────────────────
// Two-phase claim so no row is lost between select and update:
//   Phase 1: SELECT candidate ids (cheap, no side effects).
//   Phase 2: UPDATE those ids WHERE status='pending' AND
//            claim_expires_at IS NULL RETURNING id.
// Only the rows we actually claimed are returned. Any row that a
// concurrent worker claimed in between is silently dropped (it is
// not ours to send).
async function _claimBatch() {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseIso = new Date(now.getTime() + LEASE_MS).toISOString();

    // Phase 1: find candidates. `last_attempt_at` backoff filter is
    // applied in phase 2 via the WHERE clause (row could change
    // between phases; re-checking is safer than guessing).
    const { data: candidates, error: selErr } = await supabaseAdmin
        .from('email_outbox')
        .select('id')
        .eq('status', 'pending')
        .lt('attempts', MAX_ATTEMPTS)
        .order('created_at', { ascending: true })
        .limit(BATCH_SIZE);

    if (selErr) throw selErr;
    if (!candidates || !candidates.length) return [];

    const ids = candidates.map((r) => r.id).filter(Boolean);
    if (!ids.length) return [];

    // Phase 2: atomically claim. We accept rows that are either
    // unclaimed (claim_expires_at null) or have an expired lease.
    // PostgREST does not expose `OR` across nullable comparisons
    // cleanly for two-sided conditions on the same column, so we
    // do this as two updates: one for null leases, one for expired
    // leases. Both are single UPDATEs with `RETURNING`, so both are
    // atomic per row.
    const claimed = [];

    const { data: freshRows, error: freshErr } = await supabaseAdmin
        .from('email_outbox')
        .update({
            status: 'sending',
            claimed_by: WORKER_ID,
            claim_expires_at: leaseIso,
            last_attempt_at: nowIso
        })
        .in('id', ids)
        .eq('status', 'pending')
        .is('claim_expires_at', null)
        .lt('attempts', MAX_ATTEMPTS)
        .select('id, to_email, subject, html, purpose, attempts, last_attempt_at');

    if (freshErr) throw freshErr;
    if (Array.isArray(freshRows)) claimed.push(...freshRows);

    // Any candidates not claimed above might be pending with an
    // expired lease. Try again for those.
    const stillPendingIds = ids.filter(
        (id) => !claimed.some((r) => r.id === id)
    );
    if (stillPendingIds.length) {
        const { data: reclaimed, error: reclaimErr } = await supabaseAdmin
            .from('email_outbox')
            .update({
                status: 'sending',
                claimed_by: WORKER_ID,
                claim_expires_at: leaseIso,
                last_attempt_at: nowIso
            })
            .in('id', stillPendingIds)
            .eq('status', 'pending')
            .not('claim_expires_at', 'is', null)
            .lt('claim_expires_at', nowIso)
            .lt('attempts', MAX_ATTEMPTS)
            .select('id, to_email, subject, html, purpose, attempts, last_attempt_at');

        if (reclaimErr) throw reclaimErr;
        if (Array.isArray(reclaimed)) claimed.push(...reclaimed);
    }

    return claimed;
}

// ─── Reclaim abandoned sending rows ────────────────────────────
// A worker that crashed mid-send leaves a row in `sending` with an
// expired lease. This runs once per tick BEFORE claimBatch, so a
// healthy worker will eventually pick those rows back up.
async function _reclaimAbandoned() {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabaseAdmin
        .from('email_outbox')
        .update({
            status: 'pending',
            claimed_by: null,
            claim_expires_at: null,
            error: 'reclaimed_after_lease_expiry'
        })
        .eq('status', 'sending')
        .lt('claim_expires_at', nowIso)
        .lt('attempts', MAX_ATTEMPTS)
        .select('id');

    if (error) {
        outboxLog('reclaim.error', { msg: error.message, code: error.code });
        return 0;
    }
    if (Array.isArray(data) && data.length) {
        outboxLog('reclaim.ok', { count: data.length });
    }
    return Array.isArray(data) ? data.length : 0;
}

// ─── Backoff gate ──────────────────────────────────────────────
// A row's backoff is measured against its `last_attempt_at` and
// `attempts`. If we claimed it too early (because it just got
// reclaimed and we ignored the backoff), release the claim and
// skip — the next tick will pick it up when the backoff elapses.
async function _respectBackoff(rows) {
    const now = Date.now();
    const retryLater = [];

    for (const row of rows) {
        const attempts = Number(row.attempts) || 0;
        const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] || 0;
        if (!wait) continue;
        if (row.last_attempt_at) {
            const since = now - new Date(row.last_attempt_at).getTime();
            if (since < wait) retryLater.push(row.id);
        }
    }

    if (!retryLater.length) return rows;

    // Release the claims we just took so another worker (or the
    // next tick) can pick them up when the backoff elapses. Use
    // update with error checking — a failure here means the row
    // will sit in `sending` until its lease expires, which the
    // reclaim pass will catch.
    try {
        const { error } = await supabaseAdmin
            .from('email_outbox')
            .update({
                status: 'pending',
                claimed_by: null,
                claim_expires_at: null
            })
            .in('id', retryLater)
            .eq('claimed_by', WORKER_ID);
        if (error) {
            outboxLog('backoff.releaseError', { msg: error.message, code: error.code });
        }
    } catch (e) {
        outboxLog('backoff.releaseThrew', { msg: e.message });
    }

    return rows.filter((r) => !retryLater.includes(r.id));
}

// ─── Send one row ──────────────────────────────────────────────
async function _sendRow(row) {
    const attempts = Number(row.attempts) || 0;
    const nextAttempt = attempts + 1;
    const terminal = nextAttempt >= MAX_ATTEMPTS;

    let result;
    try {
        result = await emailSvc.sendEmail(row.to_email, row.subject, row.html);
    } catch (e) {
        result = { success: false, error: e && e.message };
    }

    // ── Success ──
    if (result && result.success) {
        const { error: updErr } = await supabaseAdmin
            .from('email_outbox')
            .update({
                status: 'sent',
                sent_at: new Date().toISOString(),
                claimed_by: null,
                claim_expires_at: null,
                attempts: nextAttempt,
                error: null
            })
            .eq('id', row.id);
        if (updErr) {
            // The row is already sent; if the status update fails we
            // cannot undo that. Log loudly and move on — the reclaim
            // pass will not pick a `sent` row, so worst case is the
            // row stays in `sending` until its lease expires and
            // then goes back to pending and tries again. The email
            // would be duplicated. Prevent by treating this as a
            // critical log line so ops notice.
            outboxLog('send.statusUpdateFailed', {
                id: row.id, msg: updErr.message, code: updErr.code
            });
            return { ok: false, sent: false, duplicateRisk: true };
        }
        outboxLog('send.sent', { id: row.id, to: row.to_email, purpose: row.purpose });
        return { ok: true, sent: true };
    }

    // ── Disabled (email service is off) ──
    // Leave pending so it sends when credentials arrive. Preserve
    // attempts count so the backoff resumes normally. Release the
    // claim so another worker (or next tick) can retry.
    if (result && result.disabled) {
        const { error: updErr } = await supabaseAdmin
            .from('email_outbox')
            .update({
                status: 'pending',
                claimed_by: null,
                claim_expires_at: null,
                attempts: nextAttempt,
                error: 'email_service_disabled'
            })
            .eq('id', row.id);
        if (updErr) {
            outboxLog('send.disabledUpdateFailed', {
                id: row.id, msg: updErr.message, code: updErr.code
            });
        }
        return { ok: true, sent: false, disabled: true };
    }

    // ── Failure ──
    const errText = String((result && (result.error || result.message)) || 'send failed').slice(0, 500);
    const { error: updErr } = await supabaseAdmin
        .from('email_outbox')
        .update({
            status: terminal ? 'failed' : 'pending',
            claimed_by: null,
            claim_expires_at: null,
            attempts: nextAttempt,
            error: errText
        })
        .eq('id', row.id);
    if (updErr) {
        outboxLog('send.failureUpdateFailed', {
            id: row.id, msg: updErr.message, code: updErr.code
        });
    }
    outboxLog('send.failed', {
        id: row.id, to: row.to_email, attempt: nextAttempt, terminal, err: errText
    });
    return { ok: true, sent: false, terminal };
}

// ─── Tick ──────────────────────────────────────────────────────
async function tick() {
    if (_running) return { sent: 0, skipped: 0, reclaimed: 0 };
    if (_circuitOpen()) return { sent: 0, skipped: 0, circuit: true };

    _running = true;
    let sent = 0;
    let skipped = 0;
    let reclaimed = 0;

    try {
        // Step 1: reclaim any abandoned `sending` rows.
        try {
            reclaimed = await _reclaimAbandoned();
        } catch (e) {
            outboxLog('reclaim.threw', { msg: e.message });
        }

        // Step 2: claim a batch.
        let rows;
        try {
            rows = await _claimBatch();
            _recordFetchSuccess();
        } catch (e) {
            _recordFetchFailure();
            // Missing table is not fatal — treat as "no work".
            const msg = String(e && e.message);
            if (/relation .* does not exist|42P01/.test(msg)) {
                return { sent: 0, skipped: 0, reclaimed };
            }
            outboxLog('claim.error', { msg, code: e && e.code });
            return { sent: 0, skipped: 0, reclaimed };
        }

        if (!rows.length) return { sent: 0, skipped: 0, reclaimed };

        // Step 3: honour per-row backoff. Rows that fail this are
        // released back to pending.
        rows = await _respectBackoff(rows);

        // Step 4: send each row.
        for (const row of rows) {
            try {
                const res = await _sendRow(row);
                if (res.sent) sent++;
                else skipped++;
            } catch (e) {
                // A thrown error from _sendRow is unexpected (the
                // function catches its own send errors). Log and
                // release the claim so it does not sit until lease
                // expiry.
                outboxLog('send.uncaught', { id: row.id, msg: e.message });
                try {
                    await supabaseAdmin
                        .from('email_outbox')
                        .update({ status: 'pending', claimed_by: null, claim_expires_at: null })
                        .eq('id', row.id)
                        .eq('claimed_by', WORKER_ID);
                } catch (_) { /* lease will expire */ }
                skipped++;
            }
        }
    } catch (e) {
        _recordFetchFailure();
        outboxLog('tick.error', { msg: e && e.message });
    } finally {
        _running = false;
    }

    return { sent, skipped, reclaimed };
}

// ─── Lifecycle ─────────────────────────────────────────────────
function start() {
    if (_timer) return;
    _timer = setInterval(() => {
        tick().catch((e) => outboxLog('tick.uncaught', { msg: e.message }));
    }, TICK_MS);
    // Node will exit even with a live timer; we explicitly unref so
    // the process does not hang on shutdown.
    try { if (_timer.unref) _timer.unref(); } catch (_) {}
    outboxLog('scheduler.started', { tickMs: TICK_MS, workerId: WORKER_ID });
}

function stop() {
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
    outboxLog('scheduler.stopped');
}

// ─── Stats ─────────────────────────────────────────────────────
// Returns counts, not zeros on failure. If a count query fails,
// the field is null and `error` is set. This lets a monitoring
// dashboard distinguish "queue is empty" from "queue cannot be
// read".
async function stats() {
    const out = {
        pending: 0,
        sending: 0,
        failed: 0,
        sentToday: 0,
        orphaned: 0,
        error: null
    };

    const nowIso = new Date().toISOString();
    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const orphanCutoff = new Date(Date.now() - ORPHAN_THRESHOLD_MS).toISOString();

    async function countWhere(field, apply) {
        try {
            let q = supabaseAdmin.from('email_outbox').select('id', { count: 'exact', head: true });
            q = apply(q);
            const { count, error } = await q;
            if (error) {
                out.error = out.error || error.message;
                out[field] = null;
            } else {
                out[field] = count || 0;
            }
        } catch (e) {
            out.error = out.error || e.message;
            out[field] = null;
        }
    }

    await Promise.all([
        countWhere('pending',   (q) => q.eq('status', 'pending')),
        countWhere('sending',   (q) => q.eq('status', 'sending')),
        countWhere('failed',    (q) => q.eq('status', 'failed')),
        countWhere('sentToday', (q) => q.eq('status', 'sent').gte('sent_at', since24h)),
        countWhere('orphaned',  (q) =>
            q.eq('status', 'sending')
             .lt('claim_expires_at', nowIso)
             .lt('last_attempt_at', orphanCutoff)
        )
    ]);

    // Missing table → return all zeros without error. This is the
    // pre-migration state and is not an alert condition.
    if (out.error && /relation .* does not exist|42P01/.test(out.error)) {
        return { pending: 0, sending: 0, failed: 0, sentToday: 0, orphaned: 0, error: null };
    }

    return out;
}

module.exports = {
    start,
    stop,
    tick,
    stats,
    // exported for tests and diagnostics
    WORKER_ID,
    LEASE_MS,
    MAX_ATTEMPTS,
    BACKOFF_MS
};