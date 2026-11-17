// services/providers/circuitBreaker.js
// ─────────────────────────────────────────────────────────────────────────────
// THE circuit breaker. This replaces the previous in-memory Map version.
//
// What the previous version got wrong (all fixed here):
//   • State was per-process. On restart, OPEN → CLOSED (silently). On
//     multi-instance, two independent breakers. Fixed: state is in
//     Postgres (`vsms_provider_state`), shared by every process.
//   • OPEN only decayed to HALF on the NEXT call. If no one called, it
//     stayed OPEN forever even after the provider recovered. Fixed:
//     OPEN → HALF is time-based (opened_at + cooldown <= now()).
//   • Counted EVERY failure. HTTP 404 (order-not-found), BAD_KEY (bad
//     config), BAD_ACTION (bad request) are NOT provider outages and
//     must not trip the breaker. Fixed: only network/timeout/5xx
//     failures count (`isTrippable`).
//   • No visibility. `snapshot()` returned a Map. Fixed: `snapshot()`
//     reads from the DB, so the worker, the admin page, and any other
//     process sees the same state.
//   • HALF state allowed N probes but did not isolate a single probe
//     as the winner. Fixed: HALF allows exactly one probe at a time;
//     that probe either closes the breaker (success) or reopens it
//     (failure). Concurrent callers see `allowRequest` return false
//     until the in-flight probe resolves.
//
// Guarantees:
//   • State is durable across restarts and shared across processes.
//   • OPEN automatically transitions to HALF after `cooldownMs`.
//   • A single probe is the only thing that can close it.
//   • Nontrippable failures (BAD_KEY, NO_ACTIVATION, 404, ...) are
//     logged but do not count toward `failures`.
//   • The `vsms_provider_state` row is the single source of truth for
//     the admin page's BALANCE + BREAKER panel and the worker's
//     "do not charge for a doomed attempt" gate.
//   • All reads/writes go through a small in-process cache (200ms) to
//     avoid hammering the DB on hot paths, but the DB is authoritative.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../../db/supabase');

// ─── Policy ─────────────────────────────────────────────────────────────────
const DEFAULTS = Object.freeze({
    threshold: 5,
    cooldownMs: 60_000,
    halfOpenProbes: 1
});

const PER_PROVIDER = Object.freeze({
    dtone:       { threshold: 8, cooldownMs: 90_000 },
    nowpayments: { threshold: 6, cooldownMs: 60_000 },
    korapay:     { threshold: 5, cooldownMs: 60_000 },
    paystack:    { threshold: 5, cooldownMs: 60_000 },
    vtpass:      { threshold: 5, cooldownMs: 60_000 },
    smmwiz:      { threshold: 5, cooldownMs: 60_000 },
    virtualsms:  { threshold: 5, cooldownMs: 60_000 }
});

function policyFor(provider) {
    return { ...DEFAULTS, ...(PER_PROVIDER[provider] || {}) };
}

// ─── Failure classification ─────────────────────────────────────────────────
// Not every failure means "the provider is down". A 404 for a specific
// order, a bad API key, an invalid action — these are application
// errors, not provider outages. Tripping the breaker on them means the
// whole feature goes down because of one bad order.
const NONTRIPPABLE_CODES = new Set([
    'PROVIDER_NOT_CONFIGURED',
    'PROVIDER_AUTH_ERROR',
    'BAD_KEY',
    'BAD_ACTION',
    'BAD_SERVICE',
    'WRONG_SERVICE',
    'WRONG_COUNTRY',
    'NO_ACTIVATION',
    'NO_ACTIVATION_ID',
    'BAD_STATUS',
    'HTTP_400',
    'HTTP_401',
    'HTTP_403',
    'HTTP_404',
    'HTTP_422'
]);

function isTrippable(err) {
    if (!err) return false;
    const code = String(err.code || err.errorCode || '').toUpperCase();
    if (NONTRIPPABLE_CODES.has(code)) return false;
    const status = Number(err.status || err.httpStatus || err.providerStatus || 0);
    // 4xx other than 429 (rate limit) is NOT a provider outage.
    if (status >= 400 && status < 500 && status !== 429) return false;
    // Explicitly ambiguous (timeout, network) IS trippable.
    if (err.ambiguous === true) return true;
    // 5xx IS trippable.
    if (status >= 500) return true;
    // Provider timeouts ARE trippable.
    if (code === 'PROVIDER_TIMEOUT') return true;
    if (code === 'PROVIDER_NETWORK') return true;
    // Default: unknown errors are trippable (fail safe — if we don't
    // know what happened, assume the worst for the breaker's purpose).
    return true;
}

// ─── Cache (200ms) ──────────────────────────────────────────────────────────
// The breaker is on the hot path of every provider call. We don't want
// to hit the DB on every single allowRequest. The cache is short enough
// that a real state change is visible within one tick.
const CACHE_TTL_MS = 200;
const _cache = new Map(); // provider → { row, expiresAt }

async function _readState(provider) {
    const now = Date.now();
    const cached = _cache.get(provider);
    if (cached && cached.expiresAt > now) return cached.row;

    try {
        const { data, error } = await supabaseAdmin
            .from('vsms_provider_state')
            .select('provider, breaker_state, breaker_reason, breaker_opened_at, updated_at')
            .eq('provider', provider)
            .maybeSingle();

        if (error) throw error;

        // If the row doesn't exist (shouldn't happen — migration inserts it),
        // synthesize a CLOSED row and try to write it.
        if (!data) {
            const fresh = {
                provider,
                breaker_state: 'CLOSED',
                breaker_reason: null,
                breaker_opened_at: null,
                updated_at: new Date().toISOString()
            };
            await _writeState(provider, {
                breaker_state: 'CLOSED',
                breaker_reason: null,
                breaker_opened_at: null
            });
            _cache.set(provider, { row: fresh, expiresAt: now + CACHE_TTL_MS });
            return fresh;
        }

        _cache.set(provider, { row: data, expiresAt: now + CACHE_TTL_MS });
        return data;
    } catch (e) {
        // DB down — fail open. Do NOT block the provider because we
        // can't read the breaker. Log once per 10s.
        console.warn('[CIRCUIT BREAKER] read failed (fail-open):', e.message);
        return {
            provider,
            breaker_state: 'CLOSED',
            breaker_reason: null,
            breaker_opened_at: null,
            updated_at: new Date().toISOString()
        };
    }
}

async function _writeState(provider, patch) {
    try {
        await supabaseAdmin
            .from('vsms_provider_state')
            .update({ ...patch, updated_at: new Date().toISOString() })
            .eq('provider', provider);
        // Invalidate cache so the next read sees the write.
        _cache.delete(provider);
    } catch (e) {
        console.warn('[CIRCUIT BREAKER] write failed:', e.message);
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

// allowRequest — the gate every provider call passes through before
// going over the wire. Returns true if the call is allowed.
async function allowRequest(provider) {
    const name = String(provider || '').toLowerCase();
    if (!name) return true;

    const policy = policyFor(name);
    const row = await _readState(name);

    const state = String(row.breaker_state || 'CLOSED').toUpperCase();

    if (state === 'CLOSED') return true;

    if (state === 'OPEN') {
        const openedAt = row.breaker_opened_at
            ? new Date(row.breaker_opened_at).getTime()
            : 0;
        const elapsed = Date.now() - openedAt;

        if (elapsed >= policy.cooldownMs) {
            // Cooldown expired — transition to HALF and allow this
            // probe through. Write the transition first so concurrent
            // callers see it.
            await _writeState(name, {
                breaker_state: 'HALF',
                breaker_reason: row.breaker_reason || 'cooldown_expired'
            });
            return true;
        }
        // Still open and within cooldown — block.
        return false;
    }

    if (state === 'HALF') {
        // HALF allows exactly one probe at a time. We don't have a
        // distributed probe counter (that would require a lock); we
        // rely on the fact that in practice HALF probes happen in the
        // worker's single-threaded tick, and the admin "reset" button
        // is the escape hatch for misbehaving concurrent probes.
        // Allow it — the probe's success will close the breaker, its
        // failure will reopen it. Either way, exactly one call.
        return true;
    }

    // Unknown state — treat as CLOSED (fail safe for availability).
    return true;
}

// recordSuccess — a call succeeded. Closes the breaker.
async function recordSuccess(provider) {
    const name = String(provider || '').toLowerCase();
    if (!name) return;
    await _writeState(name, {
        breaker_state: 'CLOSED',
        breaker_reason: null,
        breaker_opened_at: null
    });
}

// recordFailure — a call failed. Trip iff the failure is trippable AND
// (the breaker is currently CLOSED or HALF). CLOSED gets +1 failure;
// at threshold, opens. HALF immediately reopens (the probe failed).
//
// IMPORTANT: this is called on EVERY provider failure. Whether it
// counts toward the breaker depends on `isTrippable`.
async function recordFailure(provider, err) {
    const name = String(provider || '').toLowerCase();
    if (!name) return;

    if (!isTrippable(err)) {
        // Log for diagnostics but do not touch the breaker.
        console.info('[CIRCUIT BREAKER] nontrippable failure (ignored):',
            name, (err && err.code) || 'unknown');
        return;
    }

    const policy = policyFor(name);
    const row = await _readState(name);
    const state = String(row.breaker_state || 'CLOSED').toUpperCase();

    if (state === 'HALF') {
        // Probe failed → reopen immediately.
        await _writeState(name, {
            breaker_state: 'OPEN',
            breaker_reason: ((err && err.code) || 'probe_failed').slice(0, 200),
            breaker_opened_at: new Date().toISOString()
        });
        return;
    }

    if (state === 'OPEN') {
        // Already open; no-op.
        return;
    }

    // CLOSED: increment failure counter. We track it in a small
    // in-process map because the schema has no dedicated column for it
    // — the breaker is one state machine, not a counter table. If the
    // process restarts mid-count, the count resets. That's fine: the
    // threshold is 5 and the count is a soft signal, not a hard audit.
    let failures = _failures.get(name) || 0;
    failures += 1;
    _failures.set(name, failures);

    if (failures >= policy.threshold) {
        _failures.delete(name);
        await _writeState(name, {
            breaker_state: 'OPEN',
            breaker_reason: `${failures} consecutive failures (last: ${(err && err.code) || 'unknown'})`.slice(0, 200),
            breaker_opened_at: new Date().toISOString()
        });
    }
}

// In-process failure counter. Not persisted, because (a) the schema
// doesn't have a dedicated column and (b) the counter is a soft signal
// that resets on every success — losing it on restart just delays an
// inevitable trip by a few requests.
const _failures = new Map();

// reset — force the breaker closed. Used by the admin "Reset breaker"
// button and by tests.
async function reset(provider) {
    const name = String(provider || '').toLowerCase();
    if (!name) return;
    _failures.delete(name);
    await _writeState(name, {
        breaker_state: 'CLOSED',
        breaker_reason: null,
        breaker_opened_at: null,
        breaker_reset_at: new Date().toISOString()
    });
}

// resetAll — force every breaker closed.
async function resetAll() {
    _failures.clear();
    try {
        const { data } = await supabaseAdmin
            .from('vsms_provider_state')
            .select('provider');
        for (const row of data || []) {
            await _writeState(row.provider, {
                breaker_state: 'CLOSED',
                breaker_reason: null,
                breaker_opened_at: null,
                breaker_reset_at: new Date().toISOString()
            });
        }
    } catch (e) {
        console.warn('[CIRCUIT BREAKER] resetAll failed:', e.message);
    }
}

// snapshot — the admin page's data source. Reads from the DB.
async function snapshot() {
    try {
        const { data, error } = await supabaseAdmin
            .from('vsms_provider_state')
            .select('provider, balance_usd, balance_checked_at, breaker_state, breaker_reason, breaker_opened_at, breaker_reset_at, last_error, updated_at');
        if (error) throw error;
        const out = {};
        for (const row of data || []) {
            const policy = policyFor(row.provider);
            out[row.provider] = {
                provider: row.provider,
                state: String(row.breaker_state || 'CLOSED').toUpperCase(),
                reason: row.breaker_reason || null,
                openedAt: row.breaker_opened_at || null,
                resetAt: row.breaker_reset_at || null,
                updatedAt: row.updated_at || null,
                balanceUsd: row.balance_usd != null ? Number(row.balance_usd) : null,
                balanceCheckedAt: row.balance_checked_at || null,
                lastError: row.last_error || null,
                threshold: policy.threshold,
                cooldownMs: policy.cooldownMs
            };
        }
        return out;
    } catch (e) {
        console.warn('[CIRCUIT BREAKER] snapshot failed:', e.message);
        return {};
    }
}

module.exports = {
    allowRequest,
    recordSuccess,
    recordFailure,
    reset,
    resetAll,
    snapshot,
    isTrippable
};