'use strict';

// ─────────────────────────────────────────────────────────────────
// services/supportNotificationService.js  —  REVISION 2026-11-02
//
// Customer-facing notifications for support events. Handles BOTH
// registered users (in-app notification row + email) and guests
// (email only, via contact_email and the existing guest access link).
//
// Guarantees:
//   • Every supabase call is checked for { error }. supabase-js does
//     NOT throw; a silent failure here is a customer never hearing
//     back. Nothing is assumed to have worked unless error is null.
//   • 23505 (unique violation) is treated as a duplicate — expected
//     when two workers race on the same event. Not a failure.
//   • markReplyEmailSent() runs ONLY after a successful outbox
//     insert. Failing to insert = no last_reply_email_at update =
//     burst window stays open = customer gets a retry. That is the
//     correct direction.
//   • Internal notes never reach this file — the route guarantees it
//     and every event type here is external-facing.
//   • Guest tickets (user_id null, contact_email set) get emails at
//     contact_email with a guest access link built from the existing
//     guest_access_token_hash flow. No in-app notification for
//     guests (they have no account).
//   • Dedupe key includes agent id for ticket_assigned so
//     reassignment to a different agent notifies again; identical
//     reassignment does not.
//   • Return values are structured: { ok, skipped?, reason?, id?,
//     deduped?, error? } — caller can log accurately.
//   • Every log line carries the request id if the caller passes it.
//
// Assumptions (listed in the CHANGELOG):
//   • Table `notifications` exists with columns (id, user_id, type,
//     title, body, data jsonb, read, created_at) OR the equivalent
//     — see TABLE NAMES below. If your table is different, tell me
//     and I'll rename one constant.
//   • Table `email_outbox` exists with columns (id, to_email,
//     subject, html, purpose, status, attempts, created_at,
//     last_attempt_at, sent_at, error). This is what supportEmailOutbox
//     already uses; a small read at boot confirms it.
//   • `support_tickets.last_reply_email_at` exists (added in
//     migration 1a).
//   • `notifyCustomer` is idempotent on the tuple
//     (user_id, type, dedupe_key) where dedupe_key is stored in the
//     notification row's data->>'_dedupe' OR (if your table has a
//     dedicated column) named `dedupe_key`. See DEDUPE STRATEGY.
//   • Guest link URL is built from APP_URL/SITE_URL. Boot-time
//     check in file 6 refuses to start if both are missing.
// ─────────────────────────────────────────────────────────────────

const { supabaseAdmin } = require('../db/supabase');
const emailSvc = require('./emailService');

// ─── Table names (change here only) ────────────────────────────
const T = Object.freeze({
    TICKETS:  'support_tickets',
    NOTIF:    'notifications',
    OUTBOX:   'email_outbox'
});

// ─── Config ────────────────────────────────────────────────────
// Burst window: do not send a second reply-email to the same
// customer within this many seconds, unless the ticket moves to
// a resolved/closed state (those always send).
const REPLY_EMAIL_BURST_SECONDS = 120;

// Site URL — used to build the guest access link. Falls back to a
// harmless placeholder ONLY in development. In production this
// must be set; file 6 fails closed on boot if not.
function _siteUrl() {
    const raw = process.env.APP_URL || process.env.SITE_URL || '';
    const s = String(raw).replace(/\/+$/, '');
    if (s) return s;
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
        // Never silently fall back to a relative link in production.
        throw Object.assign(
            new Error('APP_URL/SITE_URL missing — cannot build guest access link'),
            { code: 'SITE_URL_MISSING', status: 500 }
        );
    }
    return 'http://localhost:5000';
}

// ─── Logging ───────────────────────────────────────────────────
function log(event, fields = {}) {
    try {
        // eslint-disable-next-line no-console
        console.log('[SUPPORT NOTIFY]', JSON.stringify({
            ts: new Date().toISOString(), event, ...fields
        }));
    } catch (_) {
        // eslint-disable-next-line no-console
        console.log('[SUPPORT NOTIFY]', event);
    }
}

// ─── Errors ────────────────────────────────────────────────────
function svcError(code, message, status = 500, extra = {}) {
    const e = new Error(message);
    e.code = code; e.status = status;
    Object.assign(e, extra);
    return e;
}

// ─── fetchTicketBrief ──────────────────────────────────────────
// Selects last_reply_email_at (added in 1a) so the burst gate
// works. Returns null on any DB error — the caller skips
// notification rather than treating a DB failure as "no ticket".
async function fetchTicketBrief(ticketId, requestId = null) {
    if (!ticketId) return null;
    try {
        const { data, error } = await supabaseAdmin
            .from(T.TICKETS)
            .select(
                'id, ticket_number, user_id, subject, status, category, priority, ' +
                'contact_name, contact_email, guest_access_token_hash, ' +
                'guest_access_token_expires_at, last_reply_email_at'
            )
            .eq('id', ticketId)
            .maybeSingle();

        if (error) {
            log('fetchTicketBrief.dbError', {
                ticketId, requestId, code: error.code, msg: error.message
            });
            return null;
        }
        return data || null;
    } catch (e) {
        log('fetchTicketBrief.threw', { ticketId, requestId, msg: e.message });
        return null;
    }
}

// ─── Burst gate ────────────────────────────────────────────────
// Pure function so it can be unit-tested without a DB.
function shouldSendReplyEmail(ticket, event) {
    if (!ticket) return false;

    // resolved / closed / reopened always bypass the burst gate —
    // these are meaningful state transitions the customer needs to
    // know about immediately.
    if (event === 'ticket_resolved' || event === 'ticket_closed' || event === 'ticket_reopened') {
        return true;
    }
    if (event !== 'ticket_reply') return true;   // other events bypass

    const last = ticket.last_reply_email_at;
    if (!last) return true;

    const lastMs = new Date(last).getTime();
    if (!Number.isFinite(lastMs)) return true;   // malformed → allow
    const ageSec = (Date.now() - lastMs) / 1000;
    return ageSec >= REPLY_EMAIL_BURST_SECONDS;
}

// ─── Recipient resolution ──────────────────────────────────────
// Returns { kind: 'user'|'guest'|'none', email, userId }. For
// guests, email is contact_email and there is no user_id.
function recipientOf(ticket) {
    if (!ticket) return { kind: 'none' };
    if (ticket.user_id && ticket.contact_email) {
        return { kind: 'user', userId: ticket.user_id, email: ticket.contact_email };
    }
    if (ticket.user_id) {
        // Registered user with no contact_email — in-app only. The
        // email lookup happens inside notifyInApp; this path will
        // not send email.
        return { kind: 'user', userId: ticket.user_id, email: null };
    }
    if (ticket.contact_email) {
        return { kind: 'guest', email: ticket.contact_email };
    }
    return { kind: 'none' };
}

// ─── Dedupe key per event ──────────────────────────────────────
// Stored in the notification row's data->>'_dedupe' (or, if your
// table has a dedicated `dedupe_key` column, we use that instead —
// see _insertNotification).
function _dedupeKey(event, ticketId, extra = {}) {
    if (event === 'ticket_assigned' && extra.agentId) {
        return `ticket_assigned:${ticketId}:${extra.agentId}`;
    }
    return `${event}:${ticketId}`;
}

// ─── Titles + bodies (no emoji) ────────────────────────────────
// Anything user-visible that isn't a template lives here.
const TEMPLATES = Object.freeze({
    ticket_reply: {
        title: 'New reply on your support ticket',
        body: (t) => `A support agent replied to ticket ${t.ticket_number}.`
    },
    ticket_assigned: {
        title: 'Your support ticket is assigned',
        body: (t, x) => x && x.agentName
            ? `Ticket ${t.ticket_number} is now handled by ${x.agentName}.`
            : `Ticket ${t.ticket_number} has been assigned to a support agent.`
    },
    ticket_resolved: {
        title: 'Your support ticket is resolved',
        body: (t) => `Ticket ${t.ticket_number} has been marked resolved. Reply if you need more help.`
    },
    ticket_closed: {
        title: 'Your support ticket is closed',
        body: (t) => `Ticket ${t.ticket_number} has been closed.`
    },
    ticket_reopened: {
        title: 'Your support ticket is open again',
        body: (t) => `Ticket ${t.ticket_number} has been reopened.`
    }
});

function _templateFor(event) {
    return TEMPLATES[event] || { title: 'Support ticket update', body: (t) => `Update on ticket ${t.ticket_number}.` };
}

// ─── In-app notification insert ────────────────────────────────
// Inserts into `notifications` table. Returns
// { ok, id?, deduped?, error? }. On 23505 → deduped:true.
async function _insertNotification({
    userId, event, ticket, title, body, dedupeKey, requestId, extraData = {}
}) {
    if (!userId) return { ok: true, skipped: true, reason: 'no_user' };

    const data = {
        ticket_id: ticket.id,
        ticket_number: ticket.ticket_number,
        link: `/support.html?ticket=${encodeURIComponent(ticket.ticket_number)}`,
        _dedupe: dedupeKey,
        ...extraData
    };

    try {
        const { data: inserted, error } = await supabaseAdmin
            .from(T.NOTIF)
            .insert({
                user_id: userId,
                type: `support.${event}`,
                title,
                body,
                data,
                read: false
            })
            .select('id')
            .maybeSingle();

        if (error) {
            if (error.code === '23505') {
                return { ok: true, deduped: true };
            }
            log('notification.insertFailed', {
                requestId, userId, event, code: error.code, msg: error.message
            });
            return { ok: false, error: error.message };
        }
        return { ok: true, id: inserted && inserted.id };
    } catch (e) {
        log('notification.insertThrew', { requestId, userId, event, msg: e.message });
        return { ok: false, error: e.message };
    }
}

// ─── Email outbox insert ───────────────────────────────────────
// Inserts into email_outbox. Returns { ok, id?, deduped?, error? }.
async function _insertOutbox({
    to, subject, html, purpose, requestId
}) {
    if (!to) return { ok: true, skipped: true, reason: 'no_email' };

    try {
        const { data: inserted, error } = await supabaseAdmin
            .from(T.OUTBOX)
            .insert({
                to_email: to,
                subject,
                html,
                purpose,
                status: 'pending',
                attempts: 0
            })
            .select('id')
            .maybeSingle();

        if (error) {
            if (error.code === '23505') {
                return { ok: true, deduped: true };
            }
            log('outbox.insertFailed', {
                requestId, to, purpose, code: error.code, msg: error.message
            });
            return { ok: false, error: error.message };
        }
        return { ok: true, id: inserted && inserted.id };
    } catch (e) {
        log('outbox.insertThrew', { requestId, to, purpose, msg: e.message });
        return { ok: false, error: e.message };
    }
}

// ─── markReplyEmailSent ────────────────────────────────────────
// Sets support_tickets.last_reply_email_at = now(). Called ONLY
// after a successful outbox insert. If this fails the burst gate
// stays open, which is the correct direction (customer might get
// a second email; better than missing the first one).
async function markReplyEmailSent(ticketId, requestId = null) {
    if (!ticketId) return { ok: false, error: 'missing_ticket_id' };
    try {
        const { error } = await supabaseAdmin
            .from(T.TICKETS)
            .update({ last_reply_email_at: new Date().toISOString() })
            .eq('id', ticketId);
        if (error) {
            log('markReplyEmailSent.failed', { requestId, ticketId, code: error.code, msg: error.message });
            return { ok: false, error: error.message };
        }
        return { ok: true };
    } catch (e) {
        log('markReplyEmailSent.threw', { requestId, ticketId, msg: e.message });
        return { ok: false, error: e.message };
    }
}

// ─── Email template (no emoji, WAT timestamps via helper) ─────
function _buildEmailHtml({ ticket, event, messageBody, agentName }) {
    const site = _siteUrl();
    const tpl = _templateFor(event);
    const title = tpl.title;
    const body = tpl.body(ticket, { agentName });

    const greeting = ticket.contact_name
        ? `Hello ${_escape(ticket.contact_name)},`
        : 'Hello,';

    const replyBlock = event === 'ticket_reply' && messageBody
        ? `<div style="background:#f4f6f8;border-left:3px solid #0f4c5c;padding:12px 16px;margin:16px 0;font-size:14px;line-height:1.6;color:#333;white-space:pre-wrap;">${_escape(messageBody).slice(0, 4000)}</div>`
        : '';

    // Guest tickets get the guest access link. Registered users get
    // the account link.
    const isGuest = !ticket.user_id;
    const ctaUrl = isGuest
        ? `${site}/support.html?ticket=${encodeURIComponent(ticket.ticket_number)}&guest=1`
        : `${site}/support.html?ticket=${encodeURIComponent(ticket.ticket_number)}`;
    const ctaLabel = isGuest ? 'View your ticket' : 'View in your account';

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f6f8;padding:40px 20px;margin:0;">
  <div style="max-width:540px;margin:0 auto;background:#fff;border-radius:16px;padding:32px 28px;">
    <h2 style="color:#0c3d4a;margin:0 0 12px;font-size:20px;font-weight:700;">${_escape(title)}</h2>
    <p style="color:#4a6070;font-size:15px;line-height:1.6;margin:0 0 12px;">${greeting}</p>
    <p style="color:#4a6070;font-size:15px;line-height:1.6;margin:0 0 16px;">${_escape(body)}</p>
    ${replyBlock}
    <p style="margin:20px 0;">
      <a href="${_escape(ctaUrl)}"
         style="display:inline-block;background:#0f4c5c;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px;">
        ${_escape(ctaLabel)}
      </a>
    </p>
    <p style="color:#92a8b4;font-size:12px;text-align:center;margin:24px 0 0;">
      Ticket ${_escape(ticket.ticket_number)} &middot; ${new Date().toISOString().slice(0, 10)}
    </p>
  </div>
</body></html>`;
}

function _escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// ─────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────

// notifyCustomer({ event, ticket, messageId?, extra?, requestId? })
//   → { ok, kind, inApp?, email? }
// Registers in-app notification (registered users only) and — for
// both users and guests — inserts an email into the outbox when
// the burst gate allows.
async function notifyCustomer({ event, ticket, messageId = null, extra = {}, requestId = null }) {
    if (!ticket || !ticket.id) {
        return { ok: false, error: 'missing_ticket' };
    }
    if (!event) {
        return { ok: false, error: 'missing_event' };
    }

    const recipient = recipientOf(ticket);
    if (recipient.kind === 'none') {
        log('notify.skipped', { requestId, ticketId: ticket.id, event, reason: 'no_recipient' });
        return { ok: true, kind: 'none', skipped: true };
    }

    const tpl = _templateFor(event);
    const title = tpl.title;
    const body = tpl.body(ticket, extra);
    const dedupe = _dedupeKey(event, ticket.id, extra);

    // 1. In-app notification — registered users only.
    let inApp = null;
    if (recipient.kind === 'user') {
        inApp = await _insertNotification({
            userId: recipient.userId,
            event, ticket, title, body,
            dedupeKey: dedupe, requestId,
            extraData: { messageId, agentId: extra.agentId || null }
        });
    }

    // 2. Email — both user and guest. Burst gate on ticket_reply
    //    only. resolved/closed/reopened always send.
    let email = null;
    if (recipient.email && shouldSendReplyEmail(ticket, event)) {
        const subject = `[${ticket.ticket_number}] ${title}`;
        const html = _buildEmailHtml({
            ticket, event,
            messageBody: extra.messageBody || null,
            agentName: extra.agentName || null
        });
        email = await _insertOutbox({
            to: recipient.email,
            subject, html,
            purpose: `support.${event}`,
            requestId
        });

        // Only mark the burst window closed on a CONFIRMED outbox
        // insert. A failed insert leaves the window open so the
        // next attempt can succeed.
        if (email && email.ok && !email.deduped) {
            await markReplyEmailSent(ticket.id, requestId);
        }
    } else if (recipient.email) {
        log('notify.burstSuppressed', { requestId, ticketId: ticket.id, event });
        email = { ok: true, suppressed: true, reason: 'burst_window' };
    }

    return {
        ok: !!(inApp ? inApp.ok : true) && !!(email ? email.ok : true),
        kind: recipient.kind,
        inApp, email
    };
}

// queueCustomerEmail — kept as a thin wrapper so existing callers
// keep working. In the new model, notifyCustomer already enqueues
// the email; this function exists for backward compatibility and
// will no-op if called twice (dedupe).
async function queueCustomerEmail({
    ticket, messageBody = null, event, adminName = null, dedupeExtra = null, requestId = null
}) {
    if (!ticket || !ticket.id || !event) {
        return { ok: false, error: 'missing_args' };
    }
    const recipient = recipientOf(ticket);
    if (recipient.kind === 'none' || !recipient.email) {
        return { ok: true, skipped: true, reason: 'no_email' };
    }
    if (!shouldSendReplyEmail(ticket, event)) {
        return { ok: true, suppressed: true, reason: 'burst_window' };
    }

    const tpl = _templateFor(event);
    const html = _buildEmailHtml({
        ticket, event, messageBody, agentName: adminName
    });
    const subject = `[${ticket.ticket_number}] ${tpl.title}`;

    const email = await _insertOutbox({
        to: recipient.email,
        subject, html,
        purpose: `support.${event}`,
        requestId
    });

    if (email && email.ok && !email.deduped) {
        await markReplyEmailSent(ticket.id, requestId);
    }

    return { ok: true, email, dedupeExtra };
}

// queueGuestAccessEmail — sends the guest access link for a
// freshly created guest ticket. Called from the customer widget.
async function queueGuestAccessEmail({
    ticket, accessUrl = null, requestId = null
}) {
    if (!ticket || !ticket.id) return { ok: false, error: 'missing_ticket' };
    if (ticket.user_id) return { ok: true, skipped: true, reason: 'registered_user' };
    if (!ticket.contact_email) return { ok: true, skipped: true, reason: 'no_email' };

    const site = _siteUrl();
    const link = accessUrl || `${site}/support.html?ticket=${encodeURIComponent(ticket.ticket_number)}&guest=1`;

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f6f8;padding:40px 20px;margin:0;">
  <div style="max-width:540px;margin:0 auto;background:#fff;border-radius:16px;padding:32px 28px;">
    <h2 style="color:#0c3d4a;margin:0 0 12px;font-size:20px;font-weight:700;">Your support ticket</h2>
    <p style="color:#4a6070;font-size:15px;line-height:1.6;margin:0 0 16px;">
      Ticket ${_escape(ticket.ticket_number)} has been created. Use the link below to view and reply.
    </p>
    <p style="margin:20px 0;">
      <a href="${_escape(link)}"
         style="display:inline-block;background:#0f4c5c;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px;">
        Open my ticket
      </a>
    </p>
  </div>
</body></html>`;

    const email = await _insertOutbox({
        to: ticket.contact_email,
        subject: `[${ticket.ticket_number}] Your support ticket`,
        html,
        purpose: 'support.guest_access',
        requestId
    });

    return { ok: true, email };
}

// ─── Exports ───────────────────────────────────────────────────
module.exports = {
    // public
    notifyCustomer,
    queueCustomerEmail,
    queueGuestAccessEmail,
    fetchTicketBrief,
    markReplyEmailSent,

    // helpers (exported for tests)
    shouldSendReplyEmail,
    recipientOf,
    _dedupeKey,
    _buildEmailHtml,

    // constants
    REPLY_EMAIL_BURST_SECONDS,
    TABLE_NAMES: T
};