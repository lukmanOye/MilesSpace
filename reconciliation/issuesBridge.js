// reconciliation/issuesBridge.js
// ─────────────────────────────────────────────────────────────────
// Thin bridge between the engine and reconciliationIssuesService.
//
// Why a bridge instead of calling issues.upsertIssue() directly
// from the engine:
//
//   1. The engine passes `service`, `provider`, `table`, `record`
//      and a `verdict` — the bridge does the field-name mapping.
//      If a future schema changes what `wallet_amount` is called,
//      one file changes.
//
//   2. The issue-type → severity mapping, and the "auto-close on
//      X" rule, live here. The engine never decides "is this
//      auto-closable" — it always raises, and the auto-close pass
//      (see autoClose.js) re-examines on every sweep.
//
//   3. The engine never writes to reconciliation_issue_notes. If
//      an adapter wants a note, it must add it explicitly via
//      issues.addNote.
//
// ─────────────────────────────────────────────────────────────────
'use strict';

const issues = require('../services/reconciliationIssuesService');

/**
 * Raise (or update) an issue for a failed verify step.
 *
 * @param {object} args
 * @param {string} args.service           adapter.key (e.g. 'kora')
 * @param {string} args.provider          adapter.provider (e.g. 'korapay')
 * @param {string} args.issueType         one of ISSUE_TYPES
 * @param {string} args.internalTable     e.g. 'deposit_requests'
 * @param {string} args.internalId        record.id
 * @param {string} args.internalRef       record.<ref column>
 * @param {string} [args.providerRef]
 * @param {string} [args.userId]
 * @param {number} [args.amount]
 * @param {string} [args.currency]
 * @param {string} [args.internalStatus]
 * @param {string} [args.providerStatus]
 * @param {string} [args.reason]
 * @param {Date}   [args.nextVerifyAt]
 * @param {string} [args.lastVerifyError]
 * @param {object} [args.metadata]
 */
async function raise(args) {
    if (!args || !args.service || !args.provider || !args.issueType) {
        throw Object.assign(
            new Error('issuesBridge.raise: service, provider, issueType required'),
            { code: 'ISSUES_BRIDGE_INPUT', status: 500 }
        );
    }
    try {
        return await issues.upsertIssue({
            service:         args.service,
            provider:        args.provider,
            issueType:       args.issueType,
            internalTable:   args.internalTable,
            internalId:      args.internalId,
            internalRef:     args.internalRef,
            providerRef:     args.providerRef || null,
            userId:          args.userId || null,
            amount:          args.amount != null ? args.amount : null,
            currency:        args.currency || null,
            internalStatus:  args.internalStatus || null,
            providerStatus:  args.providerStatus || null,
            reason:          args.reason || null,
            nextVerifyAt:    args.nextVerifyAt || null,
            lastVerifyError: args.lastVerifyError || null,
            metadata:        args.metadata || {}
        });
    } catch (err) {
        // The engine's job is to reconcile; a failed issue write must
        // not abort the sweep. Log loudly and continue. The next
        // sweep will re-attempt the raise.
        console.error(
            `[ISSUES BRIDGE] raise failed for ${args.service}/${args.internalId}:`,
            err.message, err.code
        );
        return null;
    }
}

/**
 * Close any open issues for a record. The engine calls this after
 * any settlement or terminal-state transition it is confident about.
 *
 * @param {object} args
 * @param {string} args.service
 * @param {string} args.internalId
 * @param {string} [args.notes]
 */
async function closeForRecord(args) {
    if (!args || !args.service || !args.internalId) return;
    try {
        await issues.closeByInternal({
            service: args.service,
            internalId: args.internalId,
            notes: args.notes || 'Auto-resolved by reconciliation sweep'
        });
    } catch (err) {
        console.error(
            `[ISSUES BRIDGE] close failed for ${args.service}/${args.internalId}:`,
            err.message
        );
    }
}

module.exports = { raise, closeForRecord };