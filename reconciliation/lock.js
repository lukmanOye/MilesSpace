// reconciliation/lock.js
// ─────────────────────────────────────────────────────────────────
// Fail-closed lease for reconciliation sweeps.
//
// Replaces the previous pg_try_advisory_lock-via-Supabase-RPC scheme
// that FAILED OPEN (returned true on RPC error or exception). Two
// concurrent sweeps racing the same deposit could both proceed and
// double-credit. This module makes contention observable and
// fail-closed by construction:
//
//   • acquire() returns { ok: false, reason } if the row is held
//     by another owner and not yet expired.
//   • acquire() throws only on real DB errors. A caller that catches
//     must treat the throw as "not acquired" (skip), never as "acquired."
//
// The engine calls acquire() at the top of runService(); on
// { ok: false } it returns a `skipped` counts object and the run
// row is finished with lock_skipped=true. Nothing else runs.
//
// Lease semantics:
//   • Default lease: 10 minutes.
//   • The engine heartbeats at 1/2 the lease; that extends the
//     expiry, so a long sweep never loses its lock mid-flight.
//   • A clean finish calls release() which sets released_at=now()
//     AND locked_until=now(), so the NEXT sweep starts immediately
//     instead of waiting for the 10-minute window.
//   • A crashed process leaves locked_until in the future; the
//     next acquire() reclaims after expiry, incrementing
//     reclaim_count. An operator watching recon_locks sees this.
// ─────────────────────────────────────────────────────────────────
'use strict';

const os = require('os');
const { supabaseAdmin } = require('../db/supabase');

const DEFAULT_LEASE_MS = 10 * 60 * 1000;   // 10 minutes

// A single process owns a single "owner" identity for its whole life.
// Including hostname makes a multi-instance deployment visible in the
// table (each Render instance gets a distinct owner), and the pid
// disambiguates a process that restarted on the same host.
const OWNER = `${os.hostname() || 'unknown'}:${process.pid}:${Date.now().toString(36)}`;

// ─── Helper: bump lease ───────────────────────────────────────────
function leaseEndIso(leaseMs) {
    return new Date(Date.now() + leaseMs).toISOString();
}

// ─── Acquire ──────────────────────────────────────────────────────
/**
 * Try to acquire `name`. Never throws for contention — only for real
 * DB errors, and even then the caller must skip on throw.
 *
 * @param {string} name          e.g. 'recon:kora:deposit_requests'
 * @param {object} [opts]
 * @param {number} [opts.leaseMs=600000]
 * @returns {Promise<{ ok: boolean, reason?: string, owner?: string, until?: string }>}
 */
async function acquire(name, opts = {}) {
    if (!name || typeof name !== 'string') {
        const e = new Error('lock.acquire: name is required');
        e.code = 'LOCK_INVALID_NAME';
        throw e;
    }
    const leaseMs = Number.isFinite(opts.leaseMs) ? opts.leaseMs : DEFAULT_LEASE_MS;
    const until = leaseEndIso(leaseMs);
    const nowIso = new Date().toISOString();

    // One atomic UPDATE ... RETURNING does acquire, renew (same owner)
    // and reclaim (expired) in a single statement. The PostgREST
    // client does not expose arbitrary UPDATE ... RETURNING, so we
    // route this through an RPC. The RPC is created by migration
    // 20261104_01_recon_locks.sql.
    //
    // If the RPC doesn't exist (pre-migration), we fall back to a
    // read-then-write that CAN race. The engine also holds a
    // process-local lock that guarantees two sweeps in the same
    // process cannot overlap, so the fallback is only reachable on
    // a fresh deploy before the migration runs. We log a warning
    // once per call so it is visible.
    try {
        const { data, error } = await supabaseAdmin.rpc('recon_lock_acquire', {
            p_name: name,
            p_owner: OWNER,
            p_until: until
        });

        if (!error) {
            // RPC returns a single row: { acquired boolean, reason text }
            const row = Array.isArray(data) ? data[0] : data;
            if (row && row.acquired === true) {
                return { ok: true, owner: OWNER, until };
            }
            return {
                ok: false,
                reason: (row && row.reason) || 'held_by_other',
                owner: (row && row.current_owner) || null,
                until: (row && row.current_until) || null
            };
        }

        // RPC missing (PGRST202) — fall through to fallback.
        if (error.code !== 'PGRST202') {
            console.error('[LOCK] acquire RPC error:', error.message, error.code);
            return { ok: false, reason: `rpc_error:${error.code || 'unknown'}` };
        }
        // Missing RPC — visible warning once per process.
        if (!acquire._warnedMissingRpc) {
            console.warn(
                '[LOCK] recon_lock_acquire RPC is missing. ' +
                'Apply migration 20261104_01_recon_locks.sql. ' +
                'Falling back to non-atomic read-then-write; sweeps in the same ' +
                'process are still serialized by the in-process guard.'
            );
            acquire._warnedMissingRpc = true;
        }
    } catch (err) {
        console.error('[LOCK] acquire exception:', err.message);
        return { ok: false, reason: `exception:${err.message}` };
    }

    // ── Fallback: read-then-write ────────────────────────────────
    // Not atomic. Only used pre-migration. Never widens correctness
    // guarantees beyond "no overlap within one process."
    try {
        const { data: existing, error: readErr } = await supabaseAdmin
            .from('recon_locks')
            .select('name, owner, locked_until, released_at')
            .eq('name', name)
            .maybeSingle();
        if (readErr) {
            console.error('[LOCK] fallback read failed:', readErr.message);
            return { ok: false, reason: `fallback_read:${readErr.code}` };
        }

        const now = Date.now();
        const expired =
            !existing ||
            !existing.locked_until ||
            new Date(existing.locked_until).getTime() < now ||
            (existing.released_at && new Date(existing.released_at).getTime() < now);
        const sameOwner = existing && existing.owner === OWNER;

        if (!expired && !sameOwner) {
            return {
                ok: false,
                reason: 'held_by_other',
                owner: existing.owner,
                until: existing.locked_until
            };
        }

        // Upsert. Race here is possible pre-migration; the RPC path
        // (once migration runs) eliminates it.
        const row = {
            name,
            owner: OWNER,
            locked_until: until,
            heartbeat_at: nowIso,
            acquired_at: existing && sameOwner ? existing.acquired_at || nowIso : nowIso,
            released_at: null
        };
        const { error: upErr } = await supabaseAdmin
            .from('recon_locks')
            .upsert(row, { onConflict: 'name' });
        if (upErr) {
            console.error('[LOCK] fallback upsert failed:', upErr.message);
            return { ok: false, reason: `fallback_upsert:${upErr.code}` };
        }
        return { ok: true, owner: OWNER, until };
    } catch (err) {
        console.error('[LOCK] fallback exception:', err.message);
        return { ok: false, reason: `fallback_exception:${err.message}` };
    }
}

// ─── Heartbeat ────────────────────────────────────────────────────
/**
 * Extend the lease. Called by the engine at 1/2 lease so a long
 * sweep does not lose its lock. Returns true on success.
 *
 * If this returns false during a sweep, the engine will finish the
 * current candidate and then stop — it will NOT start a new
 * candidate, because ownership may have transferred.
 */
async function heartbeat(name, leaseMs = DEFAULT_LEASE_MS) {
    const until = leaseEndIso(leaseMs);
    const nowIso = new Date().toISOString();
    try {
        const { data, error } = await supabaseAdmin.rpc('recon_lock_heartbeat', {
            p_name: name,
            p_owner: OWNER,
            p_until: until
        });
        if (!error) {
            const row = Array.isArray(data) ? data[0] : data;
            return Boolean(row && row.heartbeat === true);
        }
        if (error.code === 'PGRST202') {
            // Fallback
            const { data: updated, error: upErr } = await supabaseAdmin
                .from('recon_locks')
                .update({ locked_until: until, heartbeat_at: nowIso })
                .eq('name', name)
                .eq('owner', OWNER)
                .select('name')
                .maybeSingle();
            if (upErr) {
                console.warn('[LOCK] heartbeat fallback failed:', upErr.message);
                return false;
            }
            return Boolean(updated);
        }
        console.warn('[LOCK] heartbeat RPC error:', error.message, error.code);
        return false;
    } catch (err) {
        console.warn('[LOCK] heartbeat exception:', err.message);
        return false;
    }
}

// ─── Release ──────────────────────────────────────────────────────
/**
 * Release the lock early. Called in the engine's finally block.
 * Errors here are logged but never re-thrown — the engine has
 * already done its work, and a failed release only delays the
 * NEXT sweep by up to `leaseMs`.
 */
async function release(name) {
    const nowIso = new Date().toISOString();
    try {
        const { error } = await supabaseAdmin.rpc('recon_lock_release', {
            p_name: name,
            p_owner: OWNER
        });
        if (!error) return;
        if (error.code !== 'PGRST202') {
            console.warn('[LOCK] release RPC error:', error.message, error.code);
            return;
        }
        // Fallback
        const { error: upErr } = await supabaseAdmin
            .from('recon_locks')
            .update({ released_at: nowIso, locked_until: nowIso })
            .eq('name', name)
            .eq('owner', OWNER);
        if (upErr) console.warn('[LOCK] release fallback failed:', upErr.message);
    } catch (err) {
        console.warn('[LOCK] release exception:', err.message);
    }
}

// ─── In-process guard ────────────────────────────────────────────
// Two runService('kora') calls in the same Node process are
// serialized by this set, independent of the DB lock. This is
// belt-and-braces: even if the DB lock acquisition races pre-
// migration, no two sweeps in the same process overlap.
const inFlight = new Set();

function tryProcessGuard(name) {
    if (inFlight.has(name)) return false;
    inFlight.add(name);
    return true;
}
function clearProcessGuard(name) {
    inFlight.delete(name);
}

module.exports = {
    OWNER,
    DEFAULT_LEASE_MS,
    acquire,
    heartbeat,
    release,
    tryProcessGuard,
    clearProcessGuard
};