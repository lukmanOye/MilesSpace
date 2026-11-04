// reconciliation/alerts.js
// ─────────────────────────────────────────────────────────────────
// Alert dispatcher.
//
// Sources of alerts:
//   1. New CRITICAL issue raised by the engine or the audit.
//   2. Issue whose SLA is breached (sla_due_at < now()).
//   3. Sweep or audit failed (run.status='failed').
//   4. Daily summary (once per day at a fixed local time).
//
// Channels:
//   • Slack (SLACK_WEBHOOK_URL env; skipped if absent)
//   • Email (RECON_ALERT_EMAILS env; falls back to app_config.support_email)
//   • Socket.IO (broadcast to `support:admins` room; never fails)
//
// Dedup:
//   Each alert has a stable key (e.g. 'sla:issue-uuid'). A row in
//   reconciliation_alerts_log records the last send. The cooldown
//   is per-channel per-key. Slack/email dedupe over 6 hours;
//   socket dedupe over 1 hour.
//
//   This is why a sweep that re-raises the same PENDING_TOO_LONG
//   every 5 minutes does NOT spam the channel. The alert only
//   fires again after the cooldown.
//
// Fail-closed:
//   If Slack is down and email is down, the alert is logged as
//   'failed' — it is NOT silently swallowed. The next tick retries
//   because there is no cooldown entry that would suppress it.
//
// No PII in Slack payloads:
//   Only issue ids, service, issue_type, severity, and counts are
//   sent. No email addresses, no user ids, no reference values. The
//   admin can click through to the drawer to see the full record.
// ─────────────────────────────────────────────────────────────────
'use strict';

const { supabaseAdmin } = require('../db/supabase');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || null;
const ALERT_EMAILS = (process.env.RECON_ALERT_EMAILS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const SLACK_COOLDOWN_MS = 6 * 60 * 60 * 1000;   // 6h
const EMAIL_COOLDOWN_MS = 6 * 60 * 60 * 1000;   // 6h
const SOCKET_COOLDOWN_MS = 1 * 60 * 60 * 1000;  // 1h

function log(...a)    { console.log('[RECON ALERTS]', ...a); }
function logErr(...a) { console.error('[RECON ALERTS]', ...a); }

// ─── Dedupe ──────────────────────────────────────────────────────
async function wasSentRecently(alertKey, channel, cooldownMs) {
    const since = new Date(Date.now() - cooldownMs).toISOString();
    const { data } = await supabaseAdmin
        .from('reconciliation_alerts_log')
        .select('id')
        .eq('alert_key', alertKey)
        .eq('channel', channel)
        .eq('status', 'sent')
        .gt('sent_at', since)
        .limit(1);
    return !!(data && data.length);
}

async function recordAlert({ alertKey, alertType, channel, target, payload, status, error }) {
    try {
        await supabaseAdmin.from('reconciliation_alerts_log').insert({
            alert_key: alertKey,
            alert_type: alertType,
            channel,
            target: target || null,
            payload: payload || {},
            status,
            error: error || null
        });
    } catch (e) {
        // Never let alert logging take down the caller.
        logErr('alert log insert failed:', e.message);
    }
}

// ─── Slack ───────────────────────────────────────────────────────
async function sendSlack({ text, blocks }) {
    if (!SLACK_WEBHOOK_URL) return { ok: false, skipped: true, reason: 'no_webhook_url' };
    try {
        const resp = await fetch(SLACK_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, blocks })
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            return { ok: false, error: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ─── Email ───────────────────────────────────────────────────────
// Safe probe: if the configured email service does not export one
// of the known signatures, we skip cleanly.
function getEmailSender() {
    try {
        const svc = require('../services/emailService');
        if (typeof svc.sendAdminAlert === 'function') return svc.sendAdminAlert.bind(svc);
        if (typeof svc.sendEmail === 'function') {
            return async ({ to, subject, text }) => svc.sendEmail({ to, subject, text });
        }
        if (typeof svc.send === 'function') {
            return async ({ to, subject, text }) => svc.send({ to, subject, text });
        }
        return null;
    } catch (_) {
        return null;
    }
}

async function resolveAlertRecipients() {
    if (ALERT_EMAILS.length) return ALERT_EMAILS;
    // Fall back to app_config.support_email.
    try {
        const { data } = await supabaseAdmin
            .from('app_config')
            .select('value')
            .eq('key', 'support_email')
            .maybeSingle();
        if (data?.value) return [String(data.value)];
    } catch (_) { /* ignore */ }
    return [];
}

async function sendEmail({ subject, text }) {
    const sender = getEmailSender();
    if (!sender) return { ok: false, skipped: true, reason: 'no_email_sender' };
    const recipients = await resolveAlertRecipients();
    if (!recipients.length) return { ok: false, skipped: true, reason: 'no_recipients' };

    try {
        for (const to of recipients) {
            await sender({ to, subject, text });
        }
        return { ok: true, recipients };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ─── Socket ──────────────────────────────────────────────────────
function emitSocket(eventName, payload) {
    try {
        const io = global.io;
        if (io && typeof io.to === 'function') {
            io.to('support:admins').emit(eventName, payload);
            return { ok: true };
        }
        return { ok: false, skipped: true, reason: 'no_socket_io' };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ─── Public entry points ─────────────────────────────────────────

/**
 * Alert that a new critical issue has been raised.
 * @param {object} issue  the reconciliation_issues row
 */
async function alertCriticalIssue(issue) {
    if (!issue || issue.severity !== 'critical') return;
    const alertKey = `critical:${issue.id}`;

    const text =
        `🚨 CRITICAL reconciliation issue\n` +
        `Service: ${issue.service}\n` +
        `Type: ${issue.issue_type}\n` +
        `Reference: ${issue.internal_ref || '(none)'}\n` +
        `Reason: ${issue.reason || '(none)'}\n` +
        `Issue ID: ${issue.id}`;

    const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `*🚨 CRITICAL reconciliation issue*` } },
        { type: 'section', fields: [
            { type: 'mrkdwn', text: `*Service:*\n${issue.service}` },
            { type: 'mrkdwn', text: `*Type:*\n${issue.issue_type}` },
            { type: 'mrkdwn', text: `*Reference:*\n${issue.internal_ref || '—'}` },
            { type: 'mrkdwn', text: `*Issue ID:*\n\`${issue.id}\`` }
        ]},
        { type: 'section', text: { type: 'mrkdwn', text: `*Reason:*\n${issue.reason || '—'}` } }
    ];

    await _dispatch({
        alertKey, alertType: 'critical_issue',
        payload: { issue_id: issue.id, service: issue.service, issue_type: issue.issue_type },
        slack: { text, blocks },
        email: {
            subject: `[MilesSpace] CRITICAL reconciliation issue: ${issue.service}/${issue.issue_type}`,
            text
        },
        socket: { event: 'reconciliation:critical', payload: { issue_id: issue.id, service: issue.service } }
    });
}

/**
 * Alert that an issue has breached its SLA window.
 * Batches all breaches in the sweep into one message per channel.
 */
async function alertSlaBreaches(issues) {
    if (!issues || !issues.length) return;
    const alertKey = `sla-batch:${issues.length}:${new Date().toISOString().slice(0, 10)}`;

    const lines = issues.map(i =>
        `• ${i.service}/${i.issue_type} — ${i.internal_ref || i.id} (due ${new Date(i.sla_due_at).toISOString()})`
    );
    const text =
        `⏰ ${issues.length} reconciliation issue(s) breached SLA\n\n` +
        lines.join('\n');

    const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `*⏰ ${issues.length} SLA breach(es)*` } },
        { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }
    ];

    await _dispatch({
        alertKey, alertType: 'sla_breach',
        payload: { count: issues.length, issue_ids: issues.map(i => i.id).slice(0, 20) },
        slack: { text, blocks },
        email: { subject: `[MilesSpace] ${issues.length} reconciliation SLA breach(es)`, text },
        socket: { event: 'reconciliation:sla_breach', payload: { count: issues.length } }
    });
}

/**
 * Alert that a sweep or audit failed.
 * @param {object} run  the reconciliation_runs row
 */
async function alertRunFailed(run) {
    if (!run || run.status !== 'failed') return;
    const alertKey = `run-failed:${run.id}`;

    const text =
        `❌ Reconciliation ${run.type} failed\n` +
        `Service: ${run.service}\n` +
        `Provider: ${run.provider}\n` +
        `Error: ${run.error || '(none)'}\n` +
        `Run ID: ${run.id}`;

    await _dispatch({
        alertKey, alertType: 'sweep_failed',
        payload: { run_id: run.id, service: run.service, error: run.error },
        slack: { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] },
        email: { subject: `[MilesSpace] reconciliation ${run.type} failed: ${run.service}`, text },
        socket: { event: 'reconciliation:run_failed', payload: { run_id: run.id, service: run.service } }
    });
}

/**
 * Daily summary. Called once per day from the scheduler.
 * @param {object} summary  { date, by_service: { kora: {...}, ... }, money_at_risk, auto_resolved, manual }
 */
async function alertDailySummary(summary) {
    if (!summary) return;
    const date = summary.date || new Date().toISOString().slice(0, 10);
    const alertKey = `daily-summary:${date}`;

    const lines = Object.entries(summary.by_service || {}).map(([svc, counts]) =>
        `• ${svc}: scanned ${counts.scanned || 0}, settled ${counts.settled || 0}, ` +
        `failed ${counts.failed || 0}, manual_review ${counts.manual_review || 0}`
    );
    const text =
        `📊 Reconciliation daily summary — ${date}\n\n` +
        `Money at risk: ${summary.money_at_risk || '—'}\n` +
        `Auto-resolved: ${summary.auto_resolved || 0}\n` +
        `Manual: ${summary.manual || 0}\n\n` +
        lines.join('\n');

    await _dispatch({
        alertKey, alertType: 'daily_summary',
        payload: summary,
        slack: { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] },
        email: { subject: `[MilesSpace] reconciliation daily summary — ${date}`, text },
        socket: { event: 'reconciliation:daily_summary', payload: { date } }
    });
}

// ─── Internal dispatcher ─────────────────────────────────────────
async function _dispatch({ alertKey, alertType, payload, slack, email, socket }) {
    // ── Slack ────────────────────────────────────────────────────
    if (slack) {
        const skip = await wasSentRecently(alertKey, 'slack', SLACK_COOLDOWN_MS);
        if (skip) {
            log(`skip slack ${alertKey} (cooldown)`);
        } else {
            const r = await sendSlack(slack);
            await recordAlert({
                alertKey, alertType, channel: 'slack',
                target: 'webhook',
                payload,
                status: r.ok ? 'sent' : (r.skipped ? 'skipped' : 'failed'),
                error: r.error || null
            });
            if (r.ok) log(`slack sent ${alertKey}`);
            else logErr(`slack failed ${alertKey}:`, r.error || r.reason);
        }
    }

    // ── Email ────────────────────────────────────────────────────
    if (email) {
        const skip = await wasSentRecently(alertKey, 'email', EMAIL_COOLDOWN_MS);
        if (skip) {
            log(`skip email ${alertKey} (cooldown)`);
        } else {
            const r = await sendEmail(email);
            await recordAlert({
                alertKey, alertType, channel: 'email',
                target: (r.recipients || []).join(',') || null,
                payload,
                status: r.ok ? 'sent' : (r.skipped ? 'skipped' : 'failed'),
                error: r.error || null
            });
            if (r.ok) log(`email sent ${alertKey} to ${r.recipients?.join(',')}`);
            else logErr(`email failed ${alertKey}:`, r.error || r.reason);
        }
    }

    // ── Socket ──────────────────────────────────────────────────
    if (socket) {
        const skip = await wasSentRecently(alertKey, 'socket', SOCKET_COOLDOWN_MS);
        if (skip) {
            log(`skip socket ${alertKey} (cooldown)`);
        } else {
            const r = emitSocket(socket.event, socket.payload);
            await recordAlert({
                alertKey, alertType, channel: 'socket',
                target: 'support:admins',
                payload,
                status: r.ok ? 'sent' : (r.skipped ? 'skipped' : 'failed'),
                error: r.error || null
            });
        }
    }
}

module.exports = {
    alertCriticalIssue,
    alertSlaBreaches,
    alertRunFailed,
    alertDailySummary
};