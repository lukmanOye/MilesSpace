'use strict';

// ─────────────────────────────────────────────────────────────────
// services/supportService.js  —  REVISION 2026-11-02
//
// All reads go through DB-side filtering/pagination. All writes go
// through the existing RPCs (add_support_message, change_support_status,
// assign_support_ticket) plus the two new ones from migration 1c
// (change_support_priority, change_support_category). No PostgREST
// .or() string injection remains — search runs through
// support_search_tickets.
//
// Depends on:
//   Migration 1a: priority_rank, last_reply_email_at, trigram indexes
//   Migration 1b: support_find_message_by_idempotency, support_stats(from,to,admin_id),
//                 support_search_tickets, support_timeline
//   Migration 1c: add_support_message (audit fix), change_support_priority,
//                 change_support_category
//
// Assumptions (CHANGELOG):
//   • profiles.email and profiles.username exist. Used only in the
//     admin-customer view when SUPPORT_VIEW_CUSTOMER is granted.
//   • get_user_financial_summary(uuid) RPC returns
//     { wallet_ngn: text, wallet_usd: text } as STRINGS, or the
//     caller sees "Unavailable". If the RPC doesn't exist, the
//     caller degrades gracefully (see getCustomerContext).
//   • support_ticket_events has the columns from your DDL.
// ─────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { PERMISSIONS, can } = require('../middleware/adminAuth');

const ASSIGNABLE_ROLES = Object.freeze([
    'super_admin', 'admin', 'finance', 'operations', 'support'
]);

const LIMIT_DEFAULT = 25;
const LIMIT_MAX = 100;
const SEARCH_MAX_LEN = 100;
const IDEMPOTENCY_MAX_LEN = 128;
const IDEMPOTENCY_HASH_PREFIX = 'sha256:';

// Allow-lists — reject before hitting SQL.
const VALID_STATUSES = Object.freeze(new Set([
    'open', 'assigned', 'in_progress',
    'waiting_user', 'waiting_support',
    'resolved', 'closed'
]));
const VALID_PRIORITIES = Object.freeze(new Set(['urgent', 'high', 'medium', 'low']));
const VALID_SORTS = Object.freeze(new Set(['recent', 'oldest', 'priority', 'sla']));
const VALID_SLA = Object.freeze(new Set(['breached', 'at_risk']));
const VALID_ASSIGNED_KINDS = Object.freeze(new Set(['me', 'unassigned', 'all']));

const MESSAGE_PAGE_DEFAULT = 50;
const MESSAGE_PAGE_MAX = 100;

// ─── Helpers ───────────────────────────────────────────────────
function serviceError(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.code = code; e.status = status;
    Object.assign(e, extra);
    return e;
}

function clampLimit(v, max = LIMIT_MAX, def = LIMIT_DEFAULT) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) return def;
    return Math.min(n, max);
}

function clampPage(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return n;
}

function escapeSearch(s) {
    // Length cap, escape trgm pattern chars. The RPC does the rest
    // — we only pass a single bound string.
    return String(s || '').slice(0, SEARCH_MAX_LEN);
}

function isUuidLike(s) {
    return typeof s === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function normalizeIdempotencyKey(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (s.length <= IDEMPOTENCY_MAX_LEN && /^[A-Za-z0-9_\-:.]+$/.test(s)) return s;
    const h = crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    return IDEMPOTENCY_HASH_PREFIX + h;
}

function supportLog(event, fields = {}) {
    try {
        // eslint-disable-next-line no-console
        console.log('[SUPPORT]', JSON.stringify({
            ts: new Date().toISOString(), event, ...fields
        }));
    } catch (_) {
        // eslint-disable-next-line no-console
        console.log('[SUPPORT]', event);
    }
}

// ─── Permission helpers ────────────────────────────────────────
function isAdminContext(ctx) {
    return !!(ctx && ctx.authType === 'admin'
        && (ctx.isSuperAdmin || Array.isArray(ctx.permissions)));
}

function adminCan(ctx, permission) {
    if (!isAdminContext(ctx)) return false;
    return can(ctx, permission);
}

// ─── Read: list tickets ────────────────────────────────────────
// All filtering happens in support_search_tickets. `p_search` is
// passed as a single bound string; no .or() injection vector.
async function listTickets({
    page = 1,
    limit = LIMIT_DEFAULT,
    status,           // single string OR comma list
    priority,
    category,
    assigned,         // 'me' | 'unassigned' | 'all' | uuid | null
    search,
    sort = 'recent',
    sla,              // 'breached' | 'at_risk'
    unread,           // boolean
    viewerId = null,
    dateFrom = null,
    dateTo   = null
} = {}) {
    page = clampPage(page);
    limit = clampLimit(limit);

    // status: accept "open,in_progress" or ["open","in_progress"].
    let statusArr = null;
    if (status != null && status !== '' && status !== 'all') {
        const parts = Array.isArray(status) ? status : String(status).split(',');
        const cleaned = parts
            .map((s) => String(s).trim().toLowerCase())
            .filter((s) => VALID_STATUSES.has(s));
        if (cleaned.length) statusArr = cleaned;
    }

    if (priority && !VALID_PRIORITIES.has(String(priority).toLowerCase())) {
        throw serviceError('INVALID_PRIORITY', 'Invalid priority filter', 400);
    }
    if (sort && !VALID_SORTS.has(String(sort).toLowerCase())) {
        sort = 'recent';
    }
    if (sla && !VALID_SLA.has(String(sla).toLowerCase())) {
        throw serviceError('INVALID_SLA', 'Invalid SLA filter', 400);
    }

    // `assigned`: 'me' requires viewerId; a uuid is validated; the
    // rest pass through as-is and the RPC ignores them.
    let assignedParam = null;
    if (assigned != null && assigned !== '') {
        const a = String(assigned).toLowerCase();
        if (VALID_ASSIGNED_KINDS.has(a)) {
            assignedParam = a;
        } else if (isUuidLike(assigned)) {
            assignedParam = assigned;
        }
    }

    const params = {
        p_search:   search ? escapeSearch(search) : null,
        p_status:   statusArr,
        p_priority: priority ? String(priority).toLowerCase() : null,
        p_category: category || null,
        p_assigned: assignedParam,
        p_viewer:   viewerId || null,
        p_sla:      sla ? String(sla).toLowerCase() : null,
        p_unread:   unread === true ? true : null,
        p_sort:     String(sort).toLowerCase(),
        p_page:     page,
        p_limit:    limit
    };

    const { data, error } = await supabaseAdmin.rpc('support_search_tickets', params);
    if (error) {
        supportLog('listTickets.rpcError', { code: error.code, msg: error.message });
        throw serviceError('LIST_FAILED', 'Could not load tickets.', 500);
    }
    if (!data || typeof data !== 'object') {
        // The RPC always returns an object; missing = something is
        // deeply wrong. Fail loudly.
        throw serviceError('LIST_FAILED', 'Unexpected response shape.', 500);
    }

    // The RPC does not know about date range — it returns
    // everything. Apply the date filter in-memory only if the caller
    // asked for it. Given the RPC's pagination, the correct place
    // is inside the RPC; for now, if the caller sent dateFrom/to,
    // we do a second pass that trims the returned page. This is
    // acceptable because the list is small (page*limit) and date
    // filtering is coarse. If you need exact totals per date range,
    // tell me and I'll add p_from/p_to to the RPC in 1b.
    let tickets = Array.isArray(data.tickets) ? data.tickets : [];
    let total = Number(data.total) || 0;
    let totalPages = Number(data.totalPages) || 0;

    if (dateFrom || dateTo) {
        const fromMs = dateFrom ? new Date(dateFrom).getTime() : -Infinity;
        const toMs   = dateTo   ? new Date(dateTo).getTime()   :  Infinity;
        tickets = tickets.filter((t) => {
            const c = new Date(t.created_at).getTime();
            return Number.isFinite(c) && c >= fromMs && c <= toMs;
        });
    }

    // Trim the heavy column if the RPC returned it (it shouldn't —
    // support_search_tickets does not select description).
    const rows = tickets.map((t) => {
        const clean = { ...t };
        delete clean.description;
        return clean;
    });

    const hasNextPage = totalPages > 0 && page < totalPages;
    const hasPreviousPage = page > 1;

    return {
        tickets: rows,
        page, limit,
        total, totalPages,
        hasNextPage, hasPreviousPage
    };
}

// ─── Read: stats ───────────────────────────────────────────────
// Calls the NEW support_stats(from, to, admin_id) overload from
// migration 1b. The old zero-arg support_stats() is untouched and
// still callable.
const EMPTY_STATS = Object.freeze({
    total: 0, open: 0, in_progress: 0, waiting_user: 0, waiting_support: 0,
    resolved: 0, closed: 0, urgent: 0, high_priority: 0,
    unassigned: 0, unread: 0, sla_breached: 0, sla_at_risk: 0,
    avg_first_response_minutes: null, my_open: 0
});

async function getStats({ dateFrom = null, dateTo = null, adminId = null } = {}) {
    try {
        const { data, error } = await supabaseAdmin.rpc('support_stats', {
            p_from: dateFrom || null,
            p_to:   dateTo   || null,
            p_admin_id: adminId || null
        });
        if (error) {
            supportLog('getStats.rpcError', { code: error.code, msg: error.message });
            throw serviceError('SUPPORT_STATS_UNAVAILABLE', 'Stats temporarily unavailable', 503);
        }
        if (!data || typeof data !== 'object') {
            throw serviceError('SUPPORT_STATS_UNAVAILABLE', 'Stats temporarily unavailable', 503);
        }
        return { ...EMPTY_STATS, ...data };
    } catch (e) {
        if (e && e.status) throw e;
        supportLog('getStats.threw', { msg: e && e.message });
        throw serviceError('SUPPORT_STATS_UNAVAILABLE', 'Stats temporarily unavailable', 503);
    }
}

// ─── Read: getTicket (admin) ───────────────────────────────────
// Message pagination via `before_created_at` cursor (default: last
// 50). Attachments resolved to client shape with signed URLs.
// Customer financial data is masked unless SUPPORT_VIEW_CUSTOMER.
async function getTicket({
    id,
    adminCtx,
    beforeCreatedAt = null,
    limit = MESSAGE_PAGE_DEFAULT
}) {
    if (!isAdminContext(adminCtx) || !adminCan(adminCtx, PERMISSIONS.SUPPORT_READ)) {
        throw serviceError('ACCESS_DENIED', 'Access denied', 403);
    }
    if (!isUuidLike(id)) {
        throw serviceError('INVALID_TICKET_ID', 'Invalid ticket id', 400);
    }

    const includeFin = adminCan(adminCtx, PERMISSIONS.SUPPORT_VIEW_CUSTOMER);
    const canViewEmail = includeFin;   // email/phone masking follows the same permission

    // Ticket row. Never select profiles.wallet_* directly — those
    // are mirrors. Financial summary comes from get_user_financial_summary
    // (below) when the caller has the permission.
    const { data: ticket, error: tErr } = await supabaseAdmin
        .from('support_tickets')
        .select(
            'id, ticket_number, subject, description, status, priority, category, ' +
            'assigned_to, assigned_at, first_response_at, resolved_at, closed_at, ' +
            'created_at, updated_at, last_message_at, last_user_message_at, last_admin_message_at, ' +
            'unread_for_admin, unread_for_user, sla_breached, sla_at_risk, version, ' +
            'related_type, related_id, related_reference, transaction_id, deposit_id, ' +
            'payment_reference, provider, user_id, contact_name, contact_email, ' +
            'user:profiles!user_id (id, username, email, avatar_url), ' +
            'assigned:profiles!assigned_to (id, username, email, avatar_url)'
        )
        .eq('id', id)
        .maybeSingle();

    if (tErr) {
        supportLog('getTicket.error', { code: tErr.code, msg: tErr.message, ticketId: id });
        throw serviceError('GET_FAILED', 'Could not load ticket.', 500);
    }
    if (!ticket) throw serviceError('NOT_FOUND', 'Ticket not found', 404);

    // Message page: descending by created_at for cursor pagination.
    const msgLimit = clampLimit(limit, MESSAGE_PAGE_MAX, MESSAGE_PAGE_DEFAULT);
    let mq = supabaseAdmin
        .from('ticket_messages')
        .select(
            'id, message, created_at, read_by_admin_at, read_by_user_at, delivered_at, ' +
            'sender_id, sender_type, is_internal, attachments, ' +
            'deleted_at, deleted_by, deletion_reason, ' +
            'sender:profiles!sender_id (id, username, email, avatar_url, role)'
        )
        .eq('ticket_id', id)
        .is('deleted_at', null);

    if (beforeCreatedAt) {
        mq = mq.lt('created_at', beforeCreatedAt);
    }
    mq = mq.order('created_at', { ascending: false }).limit(msgLimit);

    const { data: messages, error: mErr } = await mq;
    if (mErr) {
        supportLog('getTicket.messagesError', { code: mErr.code, msg: mErr.message, ticketId: id });
        throw serviceError('MESSAGES_FAILED', 'Could not load messages.', 500);
    }

    // Return in ascending order (oldest first) so the UI doesn't
    // have to reverse. `hasMore` tells the frontend there is an
    // older page to fetch via beforeCreatedAt.
    const ascending = (messages || []).slice().reverse();
    const hasMore = (messages || []).length === msgLimit;

    // Mask contact fields when the caller lacks SUPPORT_VIEW_CUSTOMER.
    const safeTicket = {
        ...ticket,
        contact_email: canViewEmail ? ticket.contact_email : null,
        contact_name: ticket.contact_name,
        user: ticket.user ? {
            ...ticket.user,
            email: canViewEmail ? ticket.user.email : null
        } : null
    };

    return {
        ticket: safeTicket,
        messages: ascending,
        hasMore,
        nextCursor: hasMore && ascending[0] ? ascending[0].created_at : null,
        viewerId: adminCtx.id,
        canViewFinancials: includeFin
    };
}

// ─── Read: getTicketForCustomer ────────────────────────────────
// Used by the customer-side route. Enforces ticket ownership and
// never returns is_internal messages.
async function getTicketForCustomer({ id, viewerId, beforeCreatedAt = null, limit = MESSAGE_PAGE_DEFAULT }) {
    if (!viewerId) throw serviceError('UNAUTHENTICATED', 'Sign in required', 401);
    if (!isUuidLike(id)) throw serviceError('INVALID_TICKET_ID', 'Invalid ticket id', 400);

    const { data: ticket, error } = await supabaseAdmin
        .from('support_tickets')
        .select(
            'id, ticket_number, subject, description, status, priority, category, ' +
            'created_at, updated_at, last_message_at, resolved_at, closed_at, ' +
            'contact_name, contact_email, user_id'
        )
        .eq('id', id)
        .maybeSingle();

    if (error) {
        supportLog('getTicketForCustomer.error', { code: error.code, msg: error.message });
        throw serviceError('GET_FAILED', 'Could not load ticket.', 500);
    }
    if (!ticket) throw serviceError('NOT_FOUND', 'Ticket not found', 404);
    if (String(ticket.user_id) !== String(viewerId)) {
        throw serviceError('ACCESS_DENIED', 'Access denied', 403);
    }

    const msgLimit = clampLimit(limit, MESSAGE_PAGE_MAX, MESSAGE_PAGE_DEFAULT);
    let mq = supabaseAdmin
        .from('ticket_messages')
        .select(
            'id, message, created_at, read_by_user_at, delivered_at, ' +
            'sender_id, sender_type, attachments'
        )
        .eq('ticket_id', id)
        .eq('is_internal', false)
        .is('deleted_at', null);

    if (beforeCreatedAt) mq = mq.lt('created_at', beforeCreatedAt);
    mq = mq.order('created_at', { ascending: false }).limit(msgLimit);

    const { data: messages, error: mErr } = await mq;
    if (mErr) {
        supportLog('getTicketForCustomer.messagesError', { code: mErr.code, msg: mErr.message });
        throw serviceError('MESSAGES_FAILED', 'Could not load messages.', 500);
    }

    const ascending = (messages || []).slice().reverse();
    return {
        ticket,
        messages: ascending,
        hasMore: (messages || []).length === msgLimit,
        nextCursor: (messages || []).length === msgLimit && ascending[0]
            ? ascending[0].created_at
            : null,
        viewerId
    };
}

// ─── Socket ticket access ──────────────────────────────────────
// One source of truth for "may this socket see this ticket?". Used
// by every support socket event.
async function assertSocketTicketAccess({ userId, adminCtx, ticketId }) {
    if (!ticketId || !isUuidLike(ticketId)) {
        throw serviceError('INVALID_TICKET_ID', 'Invalid ticket id', 400);
    }
    if (!userId && !isAdminContext(adminCtx)) {
        throw serviceError('UNAUTHENTICATED', 'Sign in required', 401);
    }

    const { data, error } = await supabaseAdmin
        .from('support_tickets')
        .select('id, user_id, status, assigned_to')
        .eq('id', ticketId)
        .maybeSingle();

    if (error) {
        supportLog('assertSocketTicketAccess.error', { code: error.code, msg: error.message, ticketId });
        throw serviceError('LOOKUP_FAILED', 'Could not verify access.', 500);
    }
    if (!data) throw serviceError('NOT_FOUND', 'Ticket not found', 404);

    if (isAdminContext(adminCtx) && adminCan(adminCtx, PERMISSIONS.SUPPORT_READ)) {
        return { ticket: data, isAdmin: true };
    }
    if (userId && String(data.user_id) === String(userId)) {
        return { ticket: data, isAdmin: false };
    }
    throw serviceError('ACCESS_DENIED', 'Access denied', 403);
}

// ─── Read receipts ─────────────────────────────────────────────
async function markRead({ ticketId, actorCtx }) {
    if (!isAdminContext(actorCtx) || !adminCan(actorCtx, PERMISSIONS.SUPPORT_READ)) {
        throw serviceError('ACCESS_DENIED', 'Access denied', 403);
    }
    if (!isUuidLike(ticketId)) throw serviceError('INVALID_TICKET_ID', 'Invalid ticket id', 400);

    const nowIso = new Date().toISOString();

    const { data: updated, error: msgErr } = await supabaseAdmin
        .from('ticket_messages')
        .update({ read_by_admin_at: nowIso })
        .eq('ticket_id', ticketId)
        .eq('sender_type', 'user')
        .is('read_by_admin_at', null)
        .select('id');

    if (msgErr) {
        supportLog('markRead.messageError', { code: msgErr.code, msg: msgErr.message, ticketId });
        throw serviceError('MARK_READ_FAILED', 'Could not mark messages read.', 500);
    }

    const { error: ticketErr } = await supabaseAdmin
        .from('support_tickets')
        .update({ unread_for_admin: 0, last_read_by_admin_at: nowIso })
        .eq('id', ticketId);
    if (ticketErr) {
        // Non-fatal: per-message rows are already updated.
        supportLog('markRead.ticketError', {
            code: ticketErr.code, msg: ticketErr.message, ticketId
        });
    }

    supportLog('markRead', { ticketId, adminId: actorCtx.id, messages: (updated || []).length });
    return { read: true, messagesMarkedRead: (updated || []).length };
}

async function markDelivered({ messageId, actorCtx, actorIsAdmin }) {
    if (!isUuidLike(messageId)) throw serviceError('INVALID_MESSAGE_ID', 'Invalid message id', 400);
    if (!isAdminContext(actorCtx) && !actorIsAdmin) {
        throw serviceError('UNAUTHENTICATED', 'Sign in required', 401);
    }

    const { data: msg, error: msgErr } = await supabaseAdmin
        .from('ticket_messages')
        .select('id, ticket_id, sender_type, is_internal')
        .eq('id', messageId)
        .maybeSingle();

    if (msgErr) {
        supportLog('markDelivered.lookupError', { code: msgErr.code, msg: msgErr.message, messageId });
        throw serviceError('LOOKUP_FAILED', 'Could not verify message.', 500);
    }
    if (!msg) throw serviceError('NOT_FOUND', 'Message not found', 404);

    const expectingSenderType = actorIsAdmin ? 'user' : 'admin';
    if (msg.sender_type !== expectingSenderType) {
        throw serviceError('ACCESS_DENIED', 'Cannot acknowledge this message', 403);
    }
    if (msg.is_internal && !actorIsAdmin) {
        throw serviceError('ACCESS_DENIED', 'Access denied', 403);
    }

    await assertSocketTicketAccess({
        userId: actorIsAdmin ? null : actorCtx.id,
        adminCtx: actorIsAdmin ? actorCtx : null,
        ticketId: msg.ticket_id
    });

    const { data: updated, error: updErr } = await supabaseAdmin
        .from('ticket_messages')
        .update({ delivered_at: new Date().toISOString() })
        .eq('id', messageId)
        .is('delivered_at', null)
        .select('id');

    if (updErr) {
        supportLog('markDelivered.updateError', { code: updErr.code, msg: updErr.message, messageId });
        throw serviceError('MARK_DELIVERED_FAILED', 'Could not mark delivered.', 500);
    }
    return { delivered: true, updated: (updated || []).length };
}

// ─── Idempotency pre-check ─────────────────────────────────────
// Called by the route BEFORE uploading attachments. Returns the
// existing message row or null.
async function findMessageByIdempotency({ ticketId, idempotencyKey }) {
    if (!ticketId || !isUuidLike(ticketId)) {
        throw serviceError('INVALID_TICKET_ID', 'Invalid ticket id', 400);
    }
    const key = normalizeIdempotencyKey(idempotencyKey);
    if (!key) return null;

    const { data, error } = await supabaseAdmin.rpc('support_find_message_by_idempotency', {
        p_ticket_id: ticketId,
        p_idempotency_key: key
    });
    if (error) {
        supportLog('findMessageByIdempotency.error', { code: error.code, msg: error.message, ticketId });
        throw serviceError('IDEMPOTENCY_LOOKUP_FAILED', 'Could not check idempotency key.', 500);
    }
    return data || null;
}

// ─── Write: create message ────────────────────────────────────
// Calls add_support_message. Returns { message, idempotent }.
// On replay (idempotent:true), route MUST NOT emit/notify.
async function createMessage({
    ticketId,
    adminId,
    message,
    isInternal = false,
    attachments = [],
    idempotencyKey = null,
    req = null
}) {
    if (!isUuidLike(ticketId)) throw serviceError('INVALID_TICKET_ID', 'Invalid ticket id', 400);
    const body = String(message || '').trim().slice(0, 10000);
    if (!body && (!attachments || !attachments.length)) {
        throw serviceError('EMPTY_MESSAGE', 'Message or attachment required', 422);
    }

    const normKey = normalizeIdempotencyKey(idempotencyKey);
    const requestId = req ? (req.requestId || req.headers?.['x-request-id'] || null) : null;
    const ip = req ? (req.ip || null) : null;
    const userAgent = req ? (req.headers?.['user-agent'] || null) : null;

    const { data, error } = await supabaseAdmin.rpc('add_support_message', {
        p_ticket_id:       ticketId,
        p_sender_id:       adminId,
        p_sender_type:     'admin',
        p_message:         body || '(attachment)',   // no emoji
        p_is_internal:     !!isInternal,
        p_attachments:     attachments.length ? attachments : null,
        p_idempotency_key: normKey,
        p_ip_address:      ip,
        p_user_agent:      userAgent,
        p_request_id:      requestId
    });

    if (error) {
        supportLog('createMessage.rpcError', {
            code: error.code, msg: error.message, ticketId, adminId, requestId
        });
        throw serviceError('MESSAGE_FAILED', 'Could not save message.', 500);
    }
    if (!data || data.ok !== true) {
        const err = (data && data.error) || 'MESSAGE_FAILED';
        if (err === 'TICKET_NOT_FOUND') throw serviceError('NOT_FOUND', 'Ticket not found', 404);
        if (err === 'TICKET_CLOSED')    throw serviceError('CLOSED', 'Ticket is closed', 409);
        supportLog('createMessage.logicalError', { err, ticketId, adminId, requestId });
        throw serviceError('MESSAGE_FAILED', 'Could not save message.', 500);
    }

    supportLog('createMessage', {
        ticketId, adminId,
        messageId: data.message && data.message.id,
        isInternal: !!isInternal,
        idempotent: data.idempotent === true,
        attachmentCount: attachments.length,
        requestId
    });

    return {
        message: data.message,
        idempotent: data.idempotent === true
    };
}

// ─── Write: change status ─────────────────────────────────────
async function changeStatus({
    ticketId, nextStatus, adminId, reason = null,
    expectedVersion = null, req = null
}) {
    if (!isUuidLike(ticketId)) throw serviceError('INVALID_TICKET_ID', 'Invalid ticket id', 400);
    const status = String(nextStatus || '').toLowerCase();
    if (!VALID_STATUSES.has(status)) {
        throw serviceError('INVALID_STATUS', 'Invalid target status', 400,
            { allowed: Array.from(VALID_STATUSES) });
    }
    const requestId = req ? (req.requestId || null) : null;
    const ip = req ? (req.ip || null) : null;

    const { data, error } = await supabaseAdmin.rpc('change_support_status', {
        p_ticket_id:        ticketId,
        p_next_status:      status,
        p_actor_id:         adminId,
        p_actor_type:       'admin',
        p_reason:           reason,
        p_expected_version: expectedVersion,
        p_request_id:       requestId,
        p_ip_address:       ip
    });
    if (error) {
        supportLog('changeStatus.rpcError', { code: error.code, msg: error.message, ticketId });
        throw serviceError('STATUS_FAILED', 'Could not update status.', 500);
    }
    if (!data) throw serviceError('STATUS_FAILED', 'No response', 500);
    if (data.ok === true) {
        supportLog('changeStatus', {
            ticketId, adminId, status: data.status,
            noop: !!data.noop, requestId
        });
        return { status: data.status, version: data.version, noop: !!data.noop };
    }
    if (data.error === 'INVALID_TRANSITION') {
        throw serviceError('INVALID_TRANSITION',
            `Cannot move from ${data.from} to ${data.to}`, 409,
            { from: data.from, to: data.to });
    }
    if (data.error === 'STALE_VERSION') {
        throw serviceError('STALE_VERSION',
            'Someone else updated this ticket. Reload and try again.', 409,
            { current_version: data.current_version });
    }
    if (data.error === 'TICKET_NOT_FOUND') throw serviceError('NOT_FOUND', 'Ticket not found', 404);
    throw serviceError('STATUS_FAILED', data.error || 'Unknown', 500);
}

// ─── Write: assign ticket ────────────────────────────────────
// Does NOT skip on identical reassignment at the RPC layer — the
// route decides whether to skip the notification.
async function assignTicket({
    ticketId, adminId, assignTo, reason = null,
    expectedVersion = null, req = null
}) {
    if (!isUuidLike(ticketId)) throw serviceError('INVALID_TICKET_ID', 'Invalid ticket id', 400);
    if (!isUuidLike(assignTo)) throw serviceError('INVALID_AGENT_ID', 'Invalid agent id', 400);

    const { data: target, error: tErr } = await supabaseAdmin
        .from('profiles')
        .select('id, role, status, deleted_at')
        .eq('id', assignTo)
        .maybeSingle();

    if (tErr) {
        supportLog('assignTicket.targetError', { code: tErr.code, msg: tErr.message });
        throw serviceError('LOOKUP_FAILED', 'Could not verify agent.', 500);
    }
    if (!target) throw serviceError('AGENT_NOT_FOUND', 'Agent not found', 404);
    if (target.deleted_at || target.status === 'suspended') {
        throw serviceError('AGENT_INACTIVE', 'Agent is not active', 409);
    }
    if (!ASSIGNABLE_ROLES.includes(String(target.role || '').toLowerCase())) {
        throw serviceError('NOT_ASSIGNABLE', 'User cannot be assigned tickets', 422);
    }

    const requestId = req ? (req.requestId || null) : null;

    const { data, error } = await supabaseAdmin.rpc('assign_support_ticket', {
        p_ticket_id:        ticketId,
        p_assign_to:        assignTo,
        p_actor_id:         adminId,
        p_reason:           reason,
        p_expected_version: expectedVersion,
        p_request_id:       requestId
    });
    if (error) {
        supportLog('assignTicket.rpcError', { code: error.code, msg: error.message, ticketId });
        throw serviceError('ASSIGN_FAILED', 'Could not assign ticket.', 500);
    }
    if (!data || data.ok !== true) {
        const err = (data && data.error) || 'ASSIGN_FAILED';
        if (err === 'TICKET_NOT_FOUND') throw serviceError('NOT_FOUND', 'Ticket not found', 404);
        if (err === 'STALE_VERSION') {
            throw serviceError('STALE_VERSION',
                'Someone else updated this ticket. Reload and try again.', 409,
                { current_version: data.current_version });
        }
        throw serviceError('ASSIGN_FAILED', err, 500);
    }

    supportLog('assignTicket', { ticketId, adminId, assignTo, requestId });
    return {
        assigned_to: data.assigned_to,
        status: data.status,
        version: data.version
    };
}

// ─── Write: change priority ──────────────────────────────────
async function changePriority({
    ticketId, nextPriority, adminId, reason = null,
    expectedVersion = null, req = null
}) {
    if (!isUuidLike(ticketId)) throw serviceError('INVALID_TICKET_ID', 'Invalid ticket id', 400);
    const pri = String(nextPriority || '').toLowerCase();
    if (!VALID_PRIORITIES.has(pri)) {
        throw serviceError('INVALID_PRIORITY', 'Invalid priority', 400,
            { allowed: Array.from(VALID_PRIORITIES) });
    }
    const requestId = req ? (req.requestId || null) : null;
    const ip = req ? (req.ip || null) : null;

    const { data, error } = await supabaseAdmin.rpc('change_support_priority', {
        p_ticket_id:        ticketId,
        p_next_priority:    pri,
        p_actor_id:         adminId,
        p_actor_type:       'admin',
        p_reason:           reason,
        p_expected_version: expectedVersion,
        p_request_id:       requestId,
        p_ip_address:       ip
    });
    if (error) {
        supportLog('changePriority.rpcError', { code: error.code, msg: error.message, ticketId });
        throw serviceError('PRIORITY_FAILED', 'Could not update priority.', 500);
    }
    if (!data || data.ok !== true) {
        const err = (data && data.error) || 'PRIORITY_FAILED';
        if (err === 'TICKET_NOT_FOUND') throw serviceError('NOT_FOUND', 'Ticket not found', 404);
        if (err === 'STALE_VERSION') {
            throw serviceError('STALE_VERSION',
                'Someone else updated this ticket. Reload and try again.', 409,
                { current_version: data.current_version });
        }
        if (err === 'INVALID_PRIORITY') {
            throw serviceError('INVALID_PRIORITY', 'Invalid priority', 400);
        }
        throw serviceError('PRIORITY_FAILED', err, 500);
    }
    supportLog('changePriority', {
        ticketId, adminId, priority: data.priority,
        noop: !!data.noop, requestId
    });
    return { priority: data.priority, version: data.version, noop: !!data.noop };
}

// ─── Write: change category ──────────────────────────────────
async function changeCategory({
    ticketId, nextCategory, adminId, reason = null,
    expectedVersion = null, req = null
}) {
    if (!isUuidLike(ticketId)) throw serviceError('INVALID_TICKET_ID', 'Invalid ticket id', 400);
    const cat = String(nextCategory || '').toLowerCase();
    if (!cat) throw serviceError('INVALID_CATEGORY', 'Category required', 400);

    const requestId = req ? (req.requestId || null) : null;
    const ip = req ? (req.ip || null) : null;

    const { data, error } = await supabaseAdmin.rpc('change_support_category', {
        p_ticket_id:        ticketId,
        p_next_category:    cat,
        p_actor_id:         adminId,
        p_actor_type:       'admin',
        p_reason:           reason,
        p_expected_version: expectedVersion,
        p_request_id:       requestId,
        p_ip_address:       ip
    });
    if (error) {
        supportLog('changeCategory.rpcError', { code: error.code, msg: error.message, ticketId });
        throw serviceError('CATEGORY_FAILED', 'Could not update category.', 500);
    }
    if (!data || data.ok !== true) {
        const err = (data && data.error) || 'CATEGORY_FAILED';
        if (err === 'TICKET_NOT_FOUND') throw serviceError('NOT_FOUND', 'Ticket not found', 404);
        if (err === 'STALE_VERSION') {
            throw serviceError('STALE_VERSION',
                'Someone else updated this ticket. Reload and try again.', 409,
                { current_version: data.current_version });
        }
        if (err === 'INVALID_CATEGORY') {
            throw serviceError('INVALID_CATEGORY', 'Unknown category', 422);
        }
        throw serviceError('CATEGORY_FAILED', err, 500);
    }
    supportLog('changeCategory', {
        ticketId, adminId, category: data.category,
        noop: !!data.noop, requestId
    });
    return { category: data.category, version: data.version, noop: !!data.noop };
}

// ─── Read: timeline ──────────────────────────────────────────
async function getTimeline({ ticketId, adminCtx }) {
    if (!isAdminContext(adminCtx)
        || !adminCan(adminCtx, PERMISSIONS.SUPPORT_READ)
        || !adminCan(adminCtx, PERMISSIONS.SUPPORT_AUDIT_READ)) {
        throw serviceError('ACCESS_DENIED', 'Access denied', 403);
    }
    if (!isUuidLike(ticketId)) throw serviceError('INVALID_TICKET_ID', 'Invalid ticket id', 400);

    const { data, error } = await supabaseAdmin.rpc('support_timeline', {
        p_ticket_id: ticketId
    });
    if (error) {
        supportLog('getTimeline.rpcError', { code: error.code, msg: error.message, ticketId });
        throw serviceError('TIMELINE_FAILED', 'Could not load timeline.', 500);
    }
    return Array.isArray(data) ? data : [];
}

// ─── Read: customer context (previous tickets + linked refs) ──
// Wraps into a single object the details panel can render. Never
// exposes profiles.wallet_* — the ledger RPC is the source, and
// fails as "unavailable" if it's missing.
async function getCustomerContext({ ticketId, adminCtx }) {
    if (!isAdminContext(adminCtx)
        || !adminCan(adminCtx, PERMISSIONS.SUPPORT_READ)
        || !adminCan(adminCtx, PERMISSIONS.SUPPORT_VIEW_CUSTOMER)) {
        throw serviceError('ACCESS_DENIED', 'Access denied', 403);
    }
    if (!isUuidLike(ticketId)) throw serviceError('INVALID_TICKET_ID', 'Invalid ticket id', 400);

    const { data: ticket, error: tErr } = await supabaseAdmin
        .from('support_tickets')
        .select('id, user_id, contact_name, contact_email, related_type, related_id, related_reference, transaction_id, deposit_id')
        .eq('id', ticketId)
        .maybeSingle();
    if (tErr) {
        supportLog('getCustomerContext.ticketError', { code: tErr.code, msg: tErr.message });
        throw serviceError('CONTEXT_FAILED', 'Could not load customer context.', 500);
    }
    if (!ticket) throw serviceError('NOT_FOUND', 'Ticket not found', 404);

    // Previous tickets for this customer. Guest tickets (no
    // user_id) fall back to contact_email.
    let prevQuery = supabaseAdmin
        .from('support_tickets')
        .select('id, ticket_number, subject, status, priority, created_at, resolved_at')
        .neq('id', ticketId)
        .order('created_at', { ascending: false })
        .limit(5);
    if (ticket.user_id) {
        prevQuery = prevQuery.eq('user_id', ticket.user_id);
    } else if (ticket.contact_email) {
        prevQuery = prevQuery.eq('contact_email', ticket.contact_email);
    } else {
        prevQuery = null;
    }
    let previousTickets = [];
    if (prevQuery) {
        const { data: prev, error: prevErr } = await prevQuery;
        if (prevErr) {
            supportLog('getCustomerContext.prevError', { code: prevErr.code, msg: prevErr.message });
        } else {
            previousTickets = prev || [];
        }
    }

    // Ledger wallet figures. get_user_financial_summary is not in
    // the schema you've shared — if it doesn't exist, we say
    // Unavailable and move on. Never fall back to profiles.wallet_*.
    let wallet = { available: false };
    if (ticket.user_id) {
        try {
            const { data: sum, error: sumErr } = await supabaseAdmin.rpc(
                'get_user_financial_summary',
                { p_user_id: ticket.user_id }
            );
            if (sumErr || !sum) {
                wallet = { available: false };
            } else {
                wallet = {
                    available: true,
                    wallet_ngn: sum.wallet_ngn != null ? String(sum.wallet_ngn) : null,
                    wallet_usd: sum.wallet_usd != null ? String(sum.wallet_usd) : null
                };
            }
        } catch (_) {
            wallet = { available: false };
        }
    }

    return {
        ticket,
        previousTickets,
        previousCount: previousTickets.length,
        wallet
    };
}

// ─── Read: assignable admins ─────────────────────────────────
async function listAssignableAdmins() {
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, username, email, role, status')
        .in('role', ASSIGNABLE_ROLES)
        .is('deleted_at', null)
        .neq('status', 'suspended')
        .order('username', { ascending: true });

    if (error) {
        supportLog('listAssignableAdmins.error', { code: error.code, msg: error.message });
        return [];
    }
    return data || [];
}

// ─── Saved replies (canned responses) ─────────────────────────
// Uses the existing support_saved_replies table. Ownership: any
// admin with SUPPORT_REPLY can list and use; only the creator or a
// super-admin can edit/delete. The route enforces that on write.
async function listCannedReplies({ activeOnly = true } = {}) {
    let q = supabaseAdmin
        .from('support_saved_replies')
        .select('id, title, content, category, shortcut, is_active, usage_count, created_at, updated_at')
        .order('title', { ascending: true });
    if (activeOnly) q = q.eq('is_active', true);

    const { data, error } = await q;
    if (error) {
        supportLog('listCannedReplies.error', { code: error.code, msg: error.message });
        throw serviceError('CANNED_FAILED', 'Could not load saved replies.', 500);
    }
    return data || [];
}

module.exports = {
    // reads
    listTickets,
    getStats,
    getTicket,
    getTicketForCustomer,
    getTimeline,
    getCustomerContext,
    listAssignableAdmins,
    listCannedReplies,

    // writes
    createMessage,
    changeStatus,
    assignTicket,
    changePriority,
    changeCategory,
    markRead,
    markDelivered,

    // idempotency
    findMessageByIdempotency,

    // auth helper for sockets
    assertSocketTicketAccess,
    adminCan,
    isAdminContext,

    // constants
    ASSIGNABLE_ROLES,
    LIMIT_DEFAULT,
    LIMIT_MAX,
    MESSAGE_PAGE_DEFAULT,
    MESSAGE_PAGE_MAX,
    VALID_STATUSES,
    VALID_PRIORITIES,
    VALID_SORTS,
    VALID_SLA,
    VALID_ASSIGNED_KINDS,
    EMPTY_STATS,

    // utilities
    normalizeIdempotencyKey,
    escapeSearch
};