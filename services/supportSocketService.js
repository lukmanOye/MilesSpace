'use strict';

// ─────────────────────────────────────────────────────────────────
// services/supportSocketService.js  —  REVISION 2026-11-02
//
// Realtime layer for the support desk. Socket.IO is a DELIVERY
// LAYER, not the source of truth. Every emit* method is called by
// an HTTP route AFTER the DB write commits. This service never
// writes message rows. The only writes it makes are delivery and
// read receipts, and those go through supportService, which itself
// verifies ownership.
//
// Auth contract (set by io.use in server.js — see go 5a):
//   socket.userId    string  — REQUIRED, authenticated profile id
//   socket.userType  'admin'|'user'  — REQUIRED
//   socket.adminCtx  object|null — REQUIRED for admin sockets;
//                                  exactly the shape
//                                  buildAdminContext() produces
//   socket.userName  string  — optional display name
//   socket.sessionId string|null
//
// This file does NOT fall back to role-name checks. If a socket
// arrives without userType, it is disconnected.
//
// Revalidation:
//   • Every 5 minutes per admin socket, we re-run
//     adminAuth.resolvePermissionsForUser() with the socket's
//     session. If the permission set, role, or sessionId has
//     changed, we disconnect with code 'AUTH_REVALIDATION_FAILED'.
//   • An external caller (e.g. the admin-roles route after a role
//     change) can call `socketService.revalidateUserSockets(userId)`
//     to force revalidation of every socket for that user
//     immediately.
//   • Customer sockets are not revalidated — their sessions can
//     only be revoked on next request anyway, and the ticket access
//     check runs per-event.
//
// Typing:
//   • After a successful join, a typing event only checks (a)
//     room membership in memory and (b) a rate limit bucket in
//     memory. No DB query.
//   • Typing state is per (socket.id, ticketId), so two tabs of
//     the same admin produce two independent typing indicators.
//   • The typing TTL is 3 s; a client that goes silent auto-stops.
//
// Emits:
//   • emitNewMessage() strips attachments to {id,name,size,mime}.
//     No public_id, no storage, no resource_type, no url. The
//     frontend resolves URLs on click via
//     GET /support/tickets/:id/attachments/:attachmentId/url.
//   • Internal notes are NEVER emitted to a ticket room. The
//     route also refuses to call emitNewMessage for them. Belt
//     and braces.
//   • The admin-wide room is 'support:admins' (joined by server.js
//     only for sockets with SUPPORT_READ).
// ─────────────────────────────────────────────────────────────────

const { supabaseAdmin } = require('../db/supabase');
const support = require('./supportService');
const adminAuth = require('../middleware/adminAuth');

const PERMISSIONS = adminAuth.PERMISSIONS;
const can = adminAuth.can;

// ─── Bounds + timings ──────────────────────────────────────────
const MAX_TYPING_ENTRIES            = 500;
const TYPING_TTL_MS                 = 3000;
const TYPING_MIN_INTERVAL_MS        = 1500;
const MAX_TICKET_ROOMS_PER_SOCKET   = 20;
const RECEIPT_RATE_WINDOW_MS        = 1000;
const RECEIPT_RATE_MAX              = 20;
const TYPING_RATE_WINDOW_MS         = 2000;
const TYPING_RATE_MAX               = 3;
const ADMIN_REVALIDATE_INTERVAL_MS  = 5 * 60 * 1000;

// ─── Logging ───────────────────────────────────────────────────
function socketLog(event, fields = {}) {
    try {
        // eslint-disable-next-line no-console
        console.log('[SUPPORT-SOCKET]', JSON.stringify({
            ts: new Date().toISOString(), event, ...fields
        }));
    } catch (_) {
        // eslint-disable-next-line no-console
        console.log('[SUPPORT-SOCKET]', event);
    }
}

function socketError(code, message, extra = {}) {
    return { ok: false, code, error: message, ...extra };
}

function safeAck(ack, payload) {
    if (typeof ack === 'function') {
        try { ack(payload); } catch (_) { /* never throw from ack */ }
    }
}

// ─── Connection auth contract ─────────────────────────────────
function readConnectionAuth(socket) {
    const userId   = socket.userId;
    const userType = socket.userType;
    const adminCtx = socket.adminCtx;

    if (!userId || typeof userId !== 'string') return null;

    if (userType === 'admin') {
        if (!adminCtx || adminCtx.authType !== 'admin') return null;
        if (String(adminCtx.id) !== String(userId)) return null;
        if (!adminCtx.isSuperAdmin && !Array.isArray(adminCtx.permissions)) return null;
        return { userId, userType: 'admin', adminCtx };
    }
    if (userType === 'user') {
        return { userId, userType: 'user', adminCtx: null };
    }
    return null;
}

// ─── Minimal attachment shape for emits ────────────────────────
// Callers must pass the already-resolved attachment array from
// add_support_message (which contains public_id, storage, etc.).
// We strip everything the client does not need.
function minimalAttachment(a) {
    if (!a || typeof a !== 'object') return null;
    return {
        id:   a.id   || null,
        name: a.name || 'attachment',
        size: a.size || 0,
        mime: a.mime || 'application/octet-stream'
    };
}

class SupportSocketService {
    constructor(io) {
        if (!io || typeof io.on !== 'function') {
            throw new Error('SupportSocketService requires a Socket.IO server instance');
        }
        this.io = io;

        // socket.id -> { socket, userId, userType, adminCtx, ticketRooms:Set,
        //                receiptWindow: Map, typingWindow: Map,
        //                revalidateTimer: Timeout|null }
        this.sockets = new Map();

        // `${socket.id}:${ticketId}` -> { timeout, lastStartAt }
        // Per-socket, not per-user, so two tabs don't collide.
        this.typingEntries = new Map();

        this.setupEvents();
        this._revalidateTimer = setInterval(
            () => this._revalidateAllAdmins(),
            ADMIN_REVALIDATE_INTERVAL_MS
        );
        try { if (this._revalidateTimer.unref) this._revalidateTimer.unref(); } catch (_) {}
    }

    // ─── Permission helpers ────────────────────────────────────
    _can(adminCtx, permission) {
        if (!adminCtx) return false;
        if (adminCtx.isSuperAdmin) return true;
        if (Array.isArray(adminCtx.permissions) && adminCtx.permissions.includes('*')) return true;
        return can(adminCtx, permission);
    }

    // ─── Rate-limit buckets ────────────────────────────────────
    _rateOk(entry, bucket, key, max, windowMs) {
        const now = Date.now();
        let win = entry[bucket].get(key);
        if (!win || now >= win.resetAt) {
            entry[bucket].set(key, { count: 1, resetAt: now + windowMs });
            return true;
        }
        if (win.count >= max) return false;
        win.count++;
        return true;
    }

    // ─── Setup ─────────────────────────────────────────────────
    setupEvents() {
        this.io.on('connection', (socket) => {
            const auth = readConnectionAuth(socket);
            if (!auth) {
                socketLog('connection.rejected', { socketId: socket.id });
                try { socket.disconnect(true); } catch (_) {}
                return;
            }

            const entry = {
                socket,
                userId:       auth.userId,
                userType:     auth.userType,
                adminCtx:     auth.adminCtx,
                ticketRooms:  new Set(),
                receiptWindow: new Map(),
                typingWindow: new Map()
            };
            this.sockets.set(socket.id, entry);

            socketLog('connection.open', {
                socketId: socket.id,
                userId:   entry.userId,
                userType: entry.userType
            });

            // ── TYPING ─────────────────────────────────────────
            socket.on('support:typing:start', (data, ack) =>
                this._handleTyping(entry, data, true).then((r) => safeAck(ack, r)));
            socket.on('support:typing:stop', (data, ack) =>
                this._handleTyping(entry, data, false).then((r) => safeAck(ack, r)));

            // ── TICKET ROOM JOIN / LEAVE ──────────────────────
            socket.on('support:ticket:join', (data, ack) =>
                this._handleJoin(entry, data).then((r) => safeAck(ack, r)));
            socket.on('support:ticket:leave', (data, ack) =>
                this._handleLeave(entry, data).then((r) => safeAck(ack, r)));

            // ── DELIVERY / READ RECEIPTS ──────────────────────
            socket.on('support:message:delivered', (data, ack) =>
                this._handleDelivered(entry, data).then((r) => safeAck(ack, r)));
            socket.on('support:message:read', (data, ack) =>
                this._handleRead(entry, data).then((r) => safeAck(ack, r)));

            // ── VIEW (compat with older clients) ──────────────
            socket.on('support:ticket:view', (data, ack) =>
                this._handleJoin(entry, data).then((r) => safeAck(ack, r)));

            // ── EXPLICIT REVALIDATION (client-triggered) ──────
            socket.on('support:revalidate', (data, ack) => {
                if (entry.userType !== 'admin') {
                    return safeAck(ack, { ok: true, revalidated: false });
                }
                this._revalidateSocket(entry).then((r) => safeAck(ack, r));
            });

            socket.on('disconnect', () => this._handleDisconnect(entry));
        });
    }

    // ─── TYPING ────────────────────────────────────────────────
    async _handleTyping(entry, data, isStart) {
        const ticketId = data && data.ticketId;
        if (!ticketId || typeof ticketId !== 'string') {
            return socketError('INVALID_TICKET_ID', 'Invalid ticket id');
        }
        // Fast path: must be in the room before we touch anything else.
        if (!entry.ticketRooms.has(ticketId)) {
            return socketError('NOT_IN_ROOM', 'Join the ticket first');
        }
        // Rate gate before any DB call.
        if (isStart && !this._rateOk(entry, 'typingWindow', ticketId,
                TYPING_RATE_MAX, TYPING_RATE_WINDOW_MS)) {
            return { ok: true, throttled: true };
        }

        const key = `${entry.socket.id}:${ticketId}`;
        const now = Date.now();
        const prev = this.typingEntries.get(key);
        if (prev && isStart && now - prev.lastStartAt < TYPING_MIN_INTERVAL_MS) {
            return { ok: true, throttled: true };
        }
        if (prev && prev.timeout) clearTimeout(prev.timeout);

        const room = `ticket:${ticketId}`;

        if (isStart) {
            this.io.to(room).emit('support:typing:start', {
                ticketId,
                userId: entry.userId,
                socketId: entry.socket.id,
                isAdmin: entry.userType === 'admin',
                username: (entry.adminCtx && entry.adminCtx.username) || 'User'
            });

            const timeout = setTimeout(() => {
                this.io.to(room).emit('support:typing:stop', {
                    ticketId, userId: entry.userId, socketId: entry.socket.id
                });
                this.typingEntries.delete(key);
            }, TYPING_TTL_MS);

            this.typingEntries.set(key, { timeout, lastStartAt: now });
            this._boundTypingMap();
        } else {
            this.io.to(room).emit('support:typing:stop', {
                ticketId, userId: entry.userId, socketId: entry.socket.id
            });
            this.typingEntries.delete(key);
        }
        return { ok: true };
    }

    _boundTypingMap() {
        if (this.typingEntries.size <= MAX_TYPING_ENTRIES) return;
        const oldest = this.typingEntries.keys().next().value;
        if (!oldest) return;
        const row = this.typingEntries.get(oldest);
        if (row && row.timeout) clearTimeout(row.timeout);
        this.typingEntries.delete(oldest);
    }

    // ─── JOIN / LEAVE ──────────────────────────────────────────
    async _handleJoin(entry, data) {
        const ticketId = data && data.ticketId;
        if (!ticketId || typeof ticketId !== 'string') {
            return socketError('INVALID_TICKET_ID', 'Invalid ticket id');
        }
        if (entry.ticketRooms.has(ticketId)) {
            return { ok: true, alreadyJoined: true, ticketId };
        }
        if (entry.ticketRooms.size >= MAX_TICKET_ROOMS_PER_SOCKET) {
            return socketError('TOO_MANY_ROOMS', 'Too many open tickets on this connection');
        }

        try {
            await support.assertSocketTicketAccess({
                userId:   entry.userType === 'user' ? entry.userId : null,
                adminCtx: entry.userType === 'admin' ? entry.adminCtx : null,
                ticketId
            });
        } catch (e) {
            socketLog('join.denied', {
                socketId: entry.socket.id, userId: entry.userId, ticketId,
                code: e.code || 'ACCESS_DENIED'
            });
            return socketError(e.code || 'ACCESS_DENIED', 'Access denied');
        }

        try { entry.socket.join(`ticket:${ticketId}`); } catch (_) {
            return socketError('JOIN_FAILED', 'Could not join ticket room');
        }
        entry.ticketRooms.add(ticketId);

        socketLog('join.ok', {
            socketId: entry.socket.id, userId: entry.userId,
            userType: entry.userType, ticketId
        });
        return { ok: true, ticketId };
    }

    async _handleLeave(entry, data) {
        const ticketId = data && data.ticketId;
        if (!ticketId || typeof ticketId !== 'string') {
            return socketError('INVALID_TICKET_ID', 'Invalid ticket id');
        }
        if (!entry.ticketRooms.has(ticketId)) return { ok: true, notJoined: true };

        try { entry.socket.leave(`ticket:${ticketId}`); } catch (_) {}
        entry.ticketRooms.delete(ticketId);

        const key = `${entry.socket.id}:${ticketId}`;
        const row = this.typingEntries.get(key);
        if (row && row.timeout) clearTimeout(row.timeout);
        this.typingEntries.delete(key);

        return { ok: true };
    }

    // ─── DELIVERY RECEIPT ──────────────────────────────────────
    async _handleDelivered(entry, data) {
        if (!this._rateOk(entry, 'receiptWindow', 'delivered',
                RECEIPT_RATE_MAX, RECEIPT_RATE_WINDOW_MS)) {
            return socketError('RATE_LIMITED', 'Too many events');
        }
        const messageId = data && data.messageId;
        if (!messageId || typeof messageId !== 'string') {
            return socketError('INVALID_MESSAGE_ID', 'Invalid message id');
        }
        try {
            const result = await support.markDelivered({
                messageId,
                actorCtx:     entry.userType === 'admin' ? entry.adminCtx : { id: entry.userId },
                actorIsAdmin: entry.userType === 'admin'
            });
            return { ok: true, ...result };
        } catch (e) {
            return socketError(e.code || 'MARK_DELIVERED_FAILED', 'Could not mark delivered');
        }
    }

    // ─── READ RECEIPT ──────────────────────────────────────────
    async _handleRead(entry, data) {
        if (!this._rateOk(entry, 'receiptWindow', 'read',
                RECEIPT_RATE_MAX, RECEIPT_RATE_WINDOW_MS)) {
            return socketError('RATE_LIMITED', 'Too many events');
        }
        const messageId = data && data.messageId;
        const ticketId  = data && data.ticketId;
        if (!messageId || typeof messageId !== 'string') {
            return socketError('INVALID_MESSAGE_ID', 'Invalid message id');
        }
        if (!ticketId || typeof ticketId !== 'string') {
            return socketError('INVALID_TICKET_ID', 'Invalid ticket id');
        }
        if (!entry.ticketRooms.has(ticketId)) {
            return socketError('NOT_IN_ROOM', 'Join the ticket first');
        }

        try {
            if (entry.userType === 'admin') {
                const result = await support.markRead({
                    ticketId,
                    actorCtx: entry.adminCtx
                });
                try {
                    await supabaseAdmin
                        .from('ticket_messages')
                        .update({ read_by_admin_at: new Date().toISOString() })
                        .eq('id', messageId)
                        .eq('ticket_id', ticketId)
                        .is('read_by_admin_at', null);
                } catch (_) { /* non-fatal */ }
                return { ok: true, ...result };
            } else {
                const { data: msg, error } = await supabaseAdmin
                    .from('ticket_messages')
                    .select('id, ticket_id, sender_type, is_internal')
                    .eq('id', messageId)
                    .maybeSingle();
                if (error) return socketError('LOOKUP_FAILED', 'Could not verify message');
                if (!msg) return socketError('NOT_FOUND', 'Message not found');
                if (msg.ticket_id !== ticketId) {
                    return socketError('ACCESS_DENIED', 'Message does not belong to that ticket');
                }
                if (msg.is_internal) return socketError('ACCESS_DENIED', 'Access denied');
                if (msg.sender_type !== 'admin') {
                    return socketError('ACCESS_DENIED', 'Cannot mark your own message read');
                }
                await supabaseAdmin
                    .from('ticket_messages')
                    .update({ read_by_user_at: new Date().toISOString() })
                    .eq('id', messageId)
                    .is('read_by_user_at', null);
                return { ok: true };
            }
        } catch (e) {
            return socketError(e.code || 'MARK_READ_FAILED', 'Could not mark read');
        }
    }

    // ─── REVALIDATION ──────────────────────────────────────────
    async _revalidateSocket(entry) {
        if (entry.userType !== 'admin') return { ok: true, revalidated: false };
        try {
            const sessionId = entry.adminCtx && entry.adminCtx.sessionId;
            const resolved = await adminAuth.resolvePermissionsForUser(
                entry.userId, sessionId || null
            );
            if (!resolved.ok) {
                socketLog('revalidate.failed', {
                    socketId: entry.socket.id, userId: entry.userId,
                    code: resolved.code
                });
                this._disconnectWith(entry, 'AUTH_REVALIDATION_FAILED', resolved.code);
                return { ok: false, code: 'AUTH_REVALIDATION_FAILED' };
            }

            const oldRole   = String(entry.adminCtx.role || '');
            const newRole   = String(resolved.ctx.role || '');
            const oldPerms  = entry.adminCtx.isSuperAdmin
                ? ['*']
                : (entry.adminCtx.permissions || []).slice().sort();
            const newPerms  = resolved.ctx.isSuperAdmin
                ? ['*']
                : (resolved.ctx.permissions || []).slice().sort();

            const permsChanged =
                JSON.stringify(oldPerms) !== JSON.stringify(newPerms)
                || oldRole !== newRole;

            // Refresh the in-memory ctx either way — a permission
            // that was narrowed is enforced from this point on even
            // before the socket reconnects.
            entry.adminCtx = resolved.ctx;
            entry.socket.adminCtx = resolved.ctx;

            // If SUPPORT_READ was revoked, leave the support:admins
            // room and any ticket room the socket joined.
            const hadSupportRead = oldPerms.includes('support.read') || oldPerms.includes('*');
            const hasSupportRead = newPerms.includes('support.read') || newPerms.includes('*');
            if (hadSupportRead && !hasSupportRead) {
                try { entry.socket.leave('support:admins'); } catch (_) {}
                for (const tid of entry.ticketRooms) {
                    try { entry.socket.leave(`ticket:${tid}`); } catch (_) {}
                }
                entry.ticketRooms.clear();
            }

            return { ok: true, revalidated: true, permsChanged };
        } catch (e) {
            socketLog('revalidate.threw', {
                socketId: entry.socket.id, userId: entry.userId, msg: e.message
            });
            return { ok: false, code: 'REVALIDATE_ERROR' };
        }
    }

    async _revalidateAllAdmins() {
        const admins = Array.from(this.sockets.values())
            .filter((e) => e.userType === 'admin');
        if (!admins.length) return;
        for (const entry of admins) {
            try { await this._revalidateSocket(entry); }
            catch (_) { /* logged inside */ }
        }
    }

    _disconnectWith(entry, code, detail) {
        try {
            entry.socket.emit('support:auth:invalidated', {
                code: code || 'AUTH_INVALIDATED',
                detail: detail || null,
                timestamp: new Date().toISOString()
            });
        } catch (_) {}
        try { entry.socket.disconnect(true); } catch (_) {}
    }

    // Public — call from admin-roles route after a role change.
    async revalidateUserSockets(userId) {
        if (!userId) return { revalidated: 0 };
        const targets = Array.from(this.sockets.values())
            .filter((e) => e.userType === 'admin' && String(e.userId) === String(userId));
        for (const entry of targets) {
            try { await this._revalidateSocket(entry); } catch (_) {}
        }
        return { revalidated: targets.length };
    }

    // ─── DISCONNECT ────────────────────────────────────────────
    _handleDisconnect(entry) {
        for (const [key, row] of this.typingEntries) {
            if (key.startsWith(`${entry.socket.id}:`)) {
                if (row && row.timeout) clearTimeout(row.timeout);
                this.typingEntries.delete(key);
            }
        }
        for (const ticketId of entry.ticketRooms) {
            try { entry.socket.leave(`ticket:${ticketId}`); } catch (_) {}
        }
        entry.ticketRooms.clear();
        entry.receiptWindow.clear();
        entry.typingWindow.clear();
        this.sockets.delete(entry.socket.id);

        socketLog('connection.close', {
            socketId: entry.socket.id,
            userId: entry.userId,
            userType: entry.userType
        });
    }

    // ─────────────────────────────────────────────────────────────
    //  Emit methods — called by HTTP routes after DB commit
    // ─────────────────────────────────────────────────────────────

    emitNewMessage(ticketId, message, senderId, senderIsAdmin) {
        if (!ticketId || !message || !message.id) {
            socketLog('emitNewMessage.skipped', { reason: 'missing arg', ticketId });
            return;
        }
        // Internal notes must NEVER be emitted. Route also blocks
        // this. Belt and braces.
        if (message.is_internal === true) {
            socketLog('emitNewMessage.skipped', { reason: 'internal', ticketId });
            return;
        }

        const attachments = Array.isArray(message.attachments)
            ? message.attachments.map(minimalAttachment).filter(Boolean)
            : [];

        this.io.to(`ticket:${ticketId}`).emit('support:message:new', {
            ticketId,
            message: {
                id:          message.id,
                message:     message.message,
                sender_id:   message.sender_id,
                sender_type: message.sender_type,
                created_at:  message.created_at,
                attachments
            },
            senderId:  senderId || message.sender_id || null,
            isAdmin:   !!senderIsAdmin,
            timestamp: new Date().toISOString()
        });

        // Admin-wide room: bump the list row for users who are not
        // viewing this ticket.
        if (senderIsAdmin === false) {
            this.io.to('support:admins').emit('support:list:bump', {
                ticketId,
                last_message_at: message.created_at,
                unread_delta: 1,
                is_internal: false,
                timestamp: new Date().toISOString()
            });
        }
    }

    emitTicketUpdate(ticketId, update) {
        if (!ticketId) return;
        const payload = {
            ticketId,
            ...(update || {}),
            timestamp: new Date().toISOString()
        };
        this.io.to(`ticket:${ticketId}`).emit('support:ticket:updated', payload);
        this.io.to('support:admins').emit('support:ticket:updated', payload);
    }

    emitTicketAssigned(ticketId, assignedTo, assignedToName) {
        if (!ticketId) return;
        const payload = {
            ticketId,
            assignedTo,
            assignedToName: assignedToName || null,
            timestamp: new Date().toISOString()
        };
        this.io.to(`ticket:${ticketId}`).emit('support:ticket:assigned', payload);
        this.io.to('support:admins').emit('support:ticket:assigned', payload);
    }

    emitUnreadUpdate(userId, unreadCount) {
        if (!userId) return;
        this.io.to(`user:${userId}`).emit('support:unread:updated', {
            unreadCount,
            timestamp: new Date().toISOString()
        });
    }

    // Legacy compat: real typing now flows through
    // support:typing:start / :stop.
    emitTyping(ticketId, userId, username, isAdmin) {
        if (!ticketId) return;
        this.io.to(`ticket:${ticketId}`).emit('support:typing', {
            ticketId, userId, username, isAdmin,
            timestamp: new Date().toISOString()
        });
    }

    // ─── Diagnostics ──────────────────────────────────────────
    stats() {
        const out = {
            sockets: this.sockets.size,
            typingEntries: this.typingEntries.size,
            socketsByType: { admin: 0, user: 0 },
            ticketRooms: 0
        };
        for (const s of this.sockets.values()) {
            out.socketsByType[s.userType]++;
            out.ticketRooms += s.ticketRooms.size;
        }
        return out;
    }

    // Called on process shutdown.
    close() {
        try { clearInterval(this._revalidateTimer); } catch (_) {}
        for (const [, row] of this.typingEntries) {
            if (row && row.timeout) clearTimeout(row.timeout);
        }
        this.typingEntries.clear();
        for (const entry of this.sockets.values()) {
            try { entry.socket.disconnect(true); } catch (_) {}
        }
        this.sockets.clear();
    }
}

module.exports = SupportSocketService;