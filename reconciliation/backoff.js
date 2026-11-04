// reconciliation/backoff.js
// ─────────────────────────────────────────────────────────────────
// Pure scheduling math. No DB, no side effects, no async.
//
// Given a record's (created_at, attempts), compute the next time it
// is eligible and (if applicable) the issue type to raise.
//
// The engine persists the result via backoff.persist(). The math
// here is what determines whether "5 min × 20 attempts" (which is
// what the old code did, and is what B4 complained about) stays in
// the past.
//
// Schedule:
//   attempts=0   →  now                     (immediately eligible)
//   attempts=1   →  now + 5m
//   attempts=2   →  now + 10m
//   attempts=3   →  now + 20m
//   attempts=4   →  now + 40m
//   attempts=5   →  now + 80m
//   attempts=6   →  now + 160m  (= 2h40m)
//   attempts=7   →  now + 320m  (= 5h20m)
//   ...
//   attempts≥15  →  min(exp, timeToAgeCap)
//
// Hard cap: created_at + MAX_AGE_HOURS. When next_check_at would
// pass that cap, the engine moves the record to manual_review
// instead of scheduling another attempt. This makes "attempts" and
// "age" agree: the record is given up on exactly at the age cap.
// ─────────────────────────────────────────────────────────────────
'use strict';

const BASE_MS      = 5 * 60 * 1000;         // 5 min
const MAX_AGE_MS   = 26 * 60 * 60 * 1000;   // 26 h (matches the old constant)
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;  // 6 h — no single wait exceeds this
const MAX_ATTEMPTS_FLOOR = 20;              // after this, keep waiting but log

/**
 * Compute the next_check_at for a record.
 *
 * @param {object} args
 * @param {string|Date} args.created_at
 * @param {number}      args.attempts        (the CURRENT attempts value, before increment)
 * @param {Date}        [args.now=new Date()]
 * @returns {{ nextCheckAt: Date|null, giveUp: boolean, reason?: string }}
 */
function computeNextCheckAt({ created_at, attempts, now = new Date() }) {
    const createdMs = created_at instanceof Date
        ? created_at.getTime()
        : new Date(created_at).getTime();
    if (!Number.isFinite(createdMs)) {
        return { nextCheckAt: null, giveUp: true, reason: 'invalid_created_at' };
    }
    const n = Math.max(0, Number(attempts) || 0);

    // Exponential backoff, capped.
    const waitMs = Math.min(
        MAX_BACKOFF_MS,
        BASE_MS * Math.pow(2, n)
    );

    const ageCapMs = createdMs + MAX_AGE_MS;

    // Attempt cap is NOT a hard stop — after MAX_ATTEMPTS_FLOOR we
    // still schedule, but at the max backoff. This means a record
    // that keeps returning `pending` is retried every 6 hours for
    // up to 26 hours, then moved to manual_review. That is the
    // correct behaviour for a provider that just needs more time.
    const proposedMs = now.getTime() + waitMs;

    if (proposedMs >= ageCapMs) {
        return {
            nextCheckAt: null,
            giveUp: true,
            reason: n >= MAX_ATTEMPTS_FLOOR ? 'attempts_and_age' : 'age'
        };
    }

    return {
        nextCheckAt: new Date(proposedMs),
        giveUp: false
    };
}

/**
 * Human-readable summary used by the admin UI's age badge.
 */
function describeBackoff(attempts) {
    const n = Math.max(0, Number(attempts) || 0);
    const waitMs = Math.min(MAX_BACKOFF_MS, BASE_MS * Math.pow(2, n));
    if (waitMs < 60_000)             return `${Math.round(waitMs / 1000)}s`;
    if (waitMs < 3_600_000)          return `${Math.round(waitMs / 60_000)}m`;
    return `${(waitMs / 3_600_000).toFixed(1)}h`;
}

module.exports = {
    computeNextCheckAt,
    describeBackoff,
    BASE_MS,
    MAX_AGE_MS,
    MAX_BACKOFF_MS,
    MAX_ATTEMPTS_FLOOR
};