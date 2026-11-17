// middleware/adminAuditStrict.js
// ─────────────────────────────────────────────────────────────────
// Strict audit writer for money-moving and permission-changing
// admin actions.
//
// Contract:
//   • Every field the audit UI reads is forwarded to
//     auditLogService.record() — nothing is dropped.
//   • If the write fails, the promise REJECTS. Callers rely on that
//     to abort the operation; a money move without a record is
//     forbidden.
//   • If the caller passed no `req` (background job, cron, worker),
//     strict still works — request-only fields are simply null.
//   • Nothing sensitive is written by accident; the audit service's
//     scrubber handles before/after/metadata. This file never
//     bypasses the scrubber.
//
// Exports:
//   recordAdminActionStrict(opts)   — one row
//   withAudit(fn, auditOpts)        — intent + outcome, one
//                                     correlation id, both rows
//                                     pass through strict.
//   buildCorrelationId()            — helper used by withAudit and
//                                     callers that need to correlate
//                                     across calls.
//
// Why not a Postgres RPC for wallet moves?
//   The ledger tables use their own RPCs (process_transaction_v2).
//   We cannot add an audit insert to that RPC without modifying a
//   file that belongs to the ledger. The intent + outcome pattern
//   gives us the same external guarantees (both rows visible, same
//   correlation id, no orphan audit) with no cross-module edit.
//   The only residual risk — process dies between intent and
//   outcome — is visible in the audit list as an unmatched
//   "intent" row and is caught by reconcileAuditIntents (see
//   below).
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const auditLog = require('../services/auditLogService');

// Best-effort require of the shared IP helper. If your adminAuth
// does not export getClientIp, fall back to the raw socket.
let getClientIp;
try {
    ({ getClientIp } = require('./adminAuth'));
    if (typeof getClientIp !== 'function') getClientIp = null;
} catch {
    getClientIp = null;
}

// ─── Helpers ────────────────────────────────────────────────────

function _ip(req) {
    if (!req) return null;
    try {
        if (typeof getClientIp === 'function') {
            const ip = getClientIp(req);
            if (ip) return String(ip);
        }
    } catch (_) { /* fall through */ }
    return req.ip
        || (req.headers && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : null)
        || (req.socket && req.socket.remoteAddress)
        || null;
}

function _ua(req) {
    if (!req || !req.headers) return null;
    return req.headers['user-agent'] || null;
}

function _requestId(req) {
    if (!req) return null;
    return req.requestId || (req.headers && req.headers['x-request-id']) || null;
}

function _sessionId(req) {
    if (!req) return null;
    return req.adminContext && req.adminContext.sessionId
        ? req.adminContext.sessionId
        : (req.sessionId || null);
}

function buildCorrelationId() {
    return 'audit-' + crypto.randomBytes(12).toString('hex');
}

function _guessTargetType(action) {
    if (typeof action !== 'string') return null;
    const prefix = action.split('.')[0];
    switch (prefix) {
        case 'wallet':         return 'wallet';
        case 'transaction':    return 'transaction';
        case 'order':          return 'order';
        case 'user':           return 'profile';
        case 'admin':          return 'admin';
        case 'setting':        return 'setting';
        case 'provider':       return 'provider';
        case 'webhook':        return 'webhook';
        case 'reconciliation': return 'reconciliation';
        case 'report':         return 'report';
        default:               return null;
    }
}

// ─── Core: recordAdminActionStrict ──────────────────────────────

async function recordAdminActionStrict(opts = {}) {
    if (!opts || !opts.action) {
        const e = new Error('recordAdminActionStrict: action is required');
        e.code = 'AUDIT_ACTION_REQUIRED';
        throw e;
    }

    // Prefer the authenticated admin from req when not passed
    // explicitly. This keeps a caller from forgetting the actor.
    const ctx = opts.req && opts.req.adminContext ? opts.req.adminContext : {};

    const adminId      = opts.adminId      || ctx.id      || null;
    const adminEmail   = opts.adminEmail   || ctx.email   || null;
    const adminRole    = opts.adminRole    || ctx.role    || null;

    if (!adminId) {
        // A strict write with no actor is a bug in the caller.
        // We reject rather than write an audit row that says
        // "someone did this".
        const e = new Error(
            'recordAdminActionStrict: adminId is required (no authenticated admin in req, and none passed explicitly)'
        );
        e.code = 'AUDIT_ACTOR_REQUIRED';
        throw e;
    }

    const targetType = opts.targetType || _guessTargetType(opts.action);
    const targetId   = opts.targetId != null ? String(opts.targetId) : null;

    const correlationId =
        opts.correlationId
        || (ctx.correlationId)
        || (opts.req && opts.req.correlationId)
        || null;

    const payload = {
        adminId,
        adminEmail,
        adminRole,

        action:        opts.action,
        category:      opts.category      || null,
        severity:      opts.severity      || null,
        targetType,
        targetId,

        before:        opts.before        !== undefined ? opts.before : null,
        after:         opts.after         !== undefined ? opts.after  : null,
        reason:        opts.reason        !== undefined ? opts.reason : null,
        adminNote:     opts.adminNote     !== undefined ? opts.adminNote : null,

        result:        opts.result        || 'success',
        failureCode:   opts.failureCode   || null,
        durationMs:    opts.durationMs    != null ? Number(opts.durationMs) : null,

        actorType:     opts.actorType     || 'admin',
        actorUserId:   opts.actorUserId   || null,

        correlationId,
        provider:      opts.provider      || null,
        operation:     opts.operation     || null,
        metadata:      opts.metadata      || null,

        ip:            opts.ip            || _ip(opts.req),
        userAgent:     opts.userAgent     || _ua(opts.req),
        location:      opts.location      || null,
        requestId:     opts.requestId     || _requestId(opts.req),
        sessionId:     opts.sessionId     || _sessionId(opts.req)
    };

    return auditLog.record(payload);
}

// ─── withAudit ─────────────────────────────────────────────────
//
// Wraps a money-moving operation in two audit writes with the same
// correlation id:
//
//   1. intent   — result: 'partial', before the operation runs.
//   2. outcome  — result: 'success' | 'failure', after the
//                 operation returns or throws.
//
// If the intent write fails, the operation never runs. If the
// operation fails, the outcome row is still written (result
// 'failure') and the error is re-thrown so the caller's route
// handles it normally.
//
// Usage:
//   const { result, auditIds } = await withAudit(
//       () => LedgerService.debitWallet(...),
//       {
//           req,
//           action: 'wallet.debit',
//           targetType: 'wallet',
//           targetId: walletId,
//           reason: 'Admin manual debit',
//           intentBefore:  { balance_before: 100 },
//           outcomeBefore: (r) => ({ balance_before: 100, balance_after:  r.balance_after }),
//           outcomeAfter:  (r) => ({ amount: r.amount, reference: r.reference })
//       }
//   );
//
// auditOpts fields:
//   • req                — the Express request (for IP / UA / requestId)
//   • action             — the audit action name (required)
//   • targetType, targetId
//   • reason, adminNote
//   • provider, operation, metadata
//   • intentBefore       — value written to `before` on the intent row
//   • intentAfter        — value written to `after` on the intent row
//                          (rarely set; usually null)
//   • outcomeBefore      — value OR function (r) → value
//   • outcomeAfter       — value OR function (r) → value
//   • outcomeSuccessMetadata   — function (r) → object (merged with intent metadata)
//   • outcomeFailureMetadata   — function (e) → object
//   • onOutcomeWriteFailure    — 'throw' (default) | 'log'
//                                What to do if the *outcome* row
//                                fails to write. 'throw' re-throws
//                                so the caller can decide. 'log'
//                                only logs. Never silent.

async function withAudit(fn, auditOpts = {}) {
    if (typeof fn !== 'function') {
        const e = new Error('withAudit: fn must be a function');
        e.code = 'AUDIT_INVALID_CALL';
        throw e;
    }
    if (!auditOpts || !auditOpts.action) {
        const e = new Error('withAudit: auditOpts.action is required');
        e.code = 'AUDIT_ACTION_REQUIRED';
        throw e;
    }

    const correlationId = auditOpts.correlationId || buildCorrelationId();
    const startedAt = Date.now();

    // ─── 1. Intent row ────────────────────────────────────────────
    const intentId = await recordAdminActionStrict({
        req:          auditOpts.req,
        action:       auditOpts.action,
        category:     auditOpts.category,
        severity:     auditOpts.severity,
        targetType:   auditOpts.targetType,
        targetId:     auditOpts.targetId,
        reason:       auditOpts.reason,
        adminNote:    auditOpts.adminNote,
        actorType:    auditOpts.actorType,
        actorUserId:  auditOpts.actorUserId,
        provider:     auditOpts.provider,
        operation:    auditOpts.operation,
        correlationId,
        metadata:     {
            phase: 'intent',
            ...(auditOpts.intentMetadata && typeof auditOpts.intentMetadata === 'object'
                ? auditOpts.intentMetadata
                : {})
        },
        before:       auditOpts.intentBefore !== undefined ? auditOpts.intentBefore : null,
        after:        auditOpts.intentAfter  !== undefined ? auditOpts.intentAfter  : null,
        result:       'partial'
    });

    // ─── 2. The actual operation ──────────────────────────────────
    let operationResult = null;
    let operationError  = null;
    try {
        operationResult = await fn();
    } catch (e) {
        operationError = e;
    }

    // ─── 3. Outcome row ───────────────────────────────────────────
    const durationMs = Date.now() - startedAt;
    const succeeded  = operationError === null;

    const resolve = (v) => {
        if (typeof v === 'function') {
            try { return v(succeeded ? operationResult : operationError); }
            catch (_) { return null; }
        }
        return v !== undefined ? v : null;
    };

    const outcomeMetadata = succeeded
        ? resolve(auditOpts.outcomeSuccessMetadata)
        : resolve(auditOpts.outcomeFailureMetadata);

    let outcomeId = null;
    try {
        outcomeId = await recordAdminActionStrict({
            req:          auditOpts.req,
            action:       auditOpts.action,
            category:     auditOpts.category,
            severity:     auditOpts.severity,
            targetType:   auditOpts.targetType,
            targetId:     auditOpts.targetId,
            reason:       auditOpts.reason,
            adminNote:    auditOpts.adminNote,
            actorType:    auditOpts.actorType,
            actorUserId:  auditOpts.actorUserId,
            provider:     auditOpts.provider,
            operation:    auditOpts.operation,
            correlationId,
            metadata:     {
                phase: 'outcome',
                ...(outcomeMetadata && typeof outcomeMetadata === 'object' ? outcomeMetadata : {})
            },
            before:       resolve(auditOpts.outcomeBefore),
            after:        resolve(auditOpts.outcomeAfter),
            result:       succeeded ? 'success' : 'failure',
            failureCode:  succeeded ? null : (operationError.code || 'OPERATION_FAILED'),
            durationMs
        });
    } catch (auditErr) {
        console.error(
            '[adminAuditStrict] outcome write failed',
            { correlationId, intentId, action: auditOpts.action, error: auditErr.message }
        );
        if (auditOpts.onOutcomeWriteFailure !== 'log') {
            // Default: re-throw so a money move does not silently
            // complete without a matching outcome row.
            const e = new Error(
                'Audit outcome write failed; operation result was: ' +
                (succeeded ? 'success' : 'failure')
            );
            e.code = 'AUDIT_OUTCOME_WRITE_FAILED';
            e.correlationId = correlationId;
            e.intentId = intentId;
            e.operationResult = operationResult;
            e.operationError = operationError;
            throw e;
        }
    }

    // ─── 4. Surface the operation result as before ────────────────
    if (operationError) {
        // Preserve the original error shape but attach audit context
        // so the caller can log it.
        try {
            operationError.audit = {
                correlationId,
                intentId,
                outcomeId
            };
        } catch (_) { /* error may be frozen */ }
        throw operationError;
    }

    return {
        result: operationResult,
        auditIds: { intent: intentId, outcome: outcomeId, correlationId }
    };
}

// ─── reconcileAuditIntents ─────────────────────────────────────
//
// Finds intent rows (result='partial', metadata.phase='intent')
// older than `olderThanMinutes` that have no matching outcome row
// in the same correlation group. These are cases where the process
// died between the intent write and the outcome write.
//
// It does not guess whether the operation succeeded — it only
// surfaces the pairs so an admin (or an alert) can investigate.
// Called from the worker; safe on empty tables.

async function findOrphanAuditIntents({ olderThanMinutes = 15, limit = 100 } = {}) {
    const { supabaseAdmin } = require('../db/supabase');
    const cutoff = new Date(Date.now() - Math.max(1, Number(olderThanMinutes)) * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
        .from('admin_audit_logs')
        .select('id, action, correlation_id, created_at, admin_email')
        .eq('result', 'partial')
        .not('correlation_id', 'is', null)
        .lt('created_at', cutoff)
        .order('created_at', { ascending: true })
        .limit(Math.min(Math.max(Number(limit) || 100, 1), 500));

    if (error) throw error;
    if (!data || !data.length) return [];

    const correlationIds = [...new Set(data.map(r => r.correlation_id))];
    const { data: outcomes } = await supabaseAdmin
        .from('admin_audit_logs')
        .select('correlation_id')
        .in('correlation_id', correlationIds)
        .neq('result', 'partial');

    const hasOutcome = new Set((outcomes || []).map(r => r.correlation_id));

    return data
        .filter(r => !hasOutcome.has(r.correlation_id))
        .map(r => ({
            intent_id:        r.id,
            action:           r.action,
            correlation_id:   r.correlation_id,
            admin_email:      r.admin_email,
            intent_created_at: r.created_at
        }));
}

module.exports = {
    recordAdminActionStrict,
    withAudit,
    buildCorrelationId,
    findOrphanAuditIntents
};