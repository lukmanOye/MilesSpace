/*!
 * MilesSpace Support Widget — v23.3
 * -----------------------------------------------------------------
 * Full-stack fixes: duplicate bubbles, realtime sync, layout, & perf.
 */

(function () {
    'use strict';

    if (window.__MILES_WIDGET_BOOTED__) return;

    // ── Page detection ─────────────────────────────────────
    var _pathname = String(window.location.pathname || '').toLowerCase();
    var IS_ADMIN_PAGE = _pathname.indexOf('/admin') === 0 || _pathname.indexOf('/admin/') !== -1;
    var IS_FRAMED = (function () { try { return window.self !== window.top; } catch (e) { return true; } })();
    var IS_DISABLED_BY_MARKUP = (function () {
        try {
            var b = document.body, h = document.documentElement;
            var flag = (b && b.getAttribute && b.getAttribute('data-miles-widget')) || (h && h.getAttribute && h.getAttribute('data-miles-widget'));
            return String(flag || '').toLowerCase() === 'off';
        } catch (e) { return false; }
    })();
    var IS_DISABLED_BY_GLOBAL = window.MILES_WIDGET_DISABLE === true;

    var EXCLUSION_REASON = null;
    if (IS_ADMIN_PAGE) EXCLUSION_REASON = 'admin-page';
    else if (IS_FRAMED) EXCLUSION_REASON = 'framed';
    else if (IS_DISABLED_BY_MARKUP) EXCLUSION_REASON = 'markup-disabled';
    else if (IS_DISABLED_BY_GLOBAL) EXCLUSION_REASON = 'global-disabled';

    if (EXCLUSION_REASON) {
        try {
            var toRemove = [];
            for (var i = 0; i < sessionStorage.length; i++) {
                var k = sessionStorage.key(i);
                if (k && k.indexOf('miles_guest_ticket_') === 0) toRemove.push(k);
            }
            for (var j = 0; j < toRemove.length; j++) sessionStorage.removeItem(toRemove[j]);
        } catch (e) {}
        window.MilesWidget = null;
        try { window.MilesWidgetDebugReason = EXCLUSION_REASON; } catch (e) {}
        return;
    }

    var AUTH_PAGES = ['/login.html', '/login', '/signup.html', '/signup', '/register.html', '/register', '/forgot-password.html', '/forgot-password', '/reset-password.html', '/reset-password', '/verify.html', '/verify'];
    var IS_AUTH_PAGE = AUTH_PAGES.indexOf(_pathname) !== -1;

    // ── Config ─────────────────────────────────────────────
    var CONFIG = {
        API_URL: '/api/support',
        MOBILE_BREAKPOINT: 520,
        POLL_INTERVAL_ACTIVE: 15000,
        POLL_INTERVAL_CHATS: 30000,
        POLL_INTERVAL_UNREAD: 60000,
        POLL_INTERVAL_GUEST: 20000,
        POLL_BACKOFF_MAX: 60000,
        MAX_MESSAGE_LENGTH: 5000,
        MESSAGE_MAX_LEN_SAFE: 5000,
        MAX_SUBJECT_LENGTH: 150,
        MAX_FILE_SIZE: 10 * 1024 * 1024,
        MAX_FILES_PER_MESSAGE: 5,
        ALLOWED_FILE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/csv'],
        STORAGE_PREFIX: 'miles_widget_',
        GUEST_TICKET_PREFIX: 'miles_guest_ticket_',
        GUEST_DRAFT_KEY: 'miles_widget_guest_draft',
        DESKTOP_BOTTOM: 24, DESKTOP_RIGHT: 24,
        MOBILE_BOTTOM: 16, MOBILE_RIGHT: 16,
        PANEL_GAP: 16,
        VIEWPORT_MARGIN: 16,
        DESKTOP_PANEL_W: 460,
        DESKTOP_PANEL_H: 720,
        DESKTOP_PANEL_H_MIN: 560,
        LAUNCHER_DESKTOP: 62,
        LAUNCHER_MOBILE: 56
    };

    // ── Helpers ────────────────────────────────────────────
    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"']/g, function (c) {
            switch (c) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                case "'": return '&#39;';
                default: return c;
            }
        });
    }
    function safeUrl(url, allowBlob) {
        if (!url || typeof url !== 'string') return '';
        var t = url.trim();
        if (/^javascript:/i.test(t)) return '';
        if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(t)) return t;
        if (allowBlob === true && /^blob:/i.test(t)) return t;
        if (/^(https?:)?\/\//i.test(t) || t.charAt(0) === '/') return t;
        return '';
    }
    function parseIsoTimestamp(s) {
        if (!s) return NaN;
        var str = String(s);
        if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(str)) { str = str.replace(' ', 'T') + 'Z'; }
        return new Date(str).getTime();
    }
    function formatFileSize(bytes) {
        var b = Number(bytes) || 0;
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
        return (b / 1048576).toFixed(1) + ' MB';
    }
    function fileIconForMime(mime) {
        if (!mime) return 'file';
        if (mime.indexOf('image/') === 0) return 'image';
        if (mime === 'application/pdf') return 'pdf';
        return 'file';
    }
    function guessMimeFromUrl(url) {
        var u = String(url || '').toLowerCase().split('?')[0];
        if (/\.(jpg|jpeg)$/.test(u)) return 'image/jpeg';
        if (/\.png$/.test(u)) return 'image/png';
        if (/\.gif$/.test(u)) return 'image/gif';
        if (/\.webp$/.test(u)) return 'image/webp';
        if (/\.pdf$/.test(u)) return 'application/pdf';
        if (/\.csv$/.test(u)) return 'text/csv';
        if (/\.txt$/.test(u)) return 'text/plain';
        return 'application/octet-stream';
    }
    function guessNameFromUrl(url) {
        try {
            var u = new URL(url);
            var last = u.pathname.split('/').filter(Boolean).pop() || 'attachment';
            return last.slice(0, 80);
        } catch (e) { return 'attachment'; }
    }

    function _placeholderTextsSet() { return { '📎 attachment': 1, '📎': 1, 'attachment': 1, '[attachment]': 1 }; }
    function _isPlaceholderText(txt) {
        if (!txt) return true;
        var t = String(txt).trim().toLowerCase();
        return _placeholderTextsSet()[t] === 1;
    }
    
    function normaliseAttachments(msg) {
        var out = [];
        var seen = {};
        function dedupKey(url) {
            try { var s = String(url); var q = s.indexOf('?'); return (q >= 0 ? s.slice(0, q) : s).toLowerCase(); }
            catch (e) { return String(url); }
        }
        function push(a) {
            if (!a) return;
            if (typeof a === 'string') {
                var url = safeUrl(a);
                if (!url) return;
                var k1 = dedupKey(url);
                if (seen[k1]) return;
                seen[k1] = 1;
                out.push({ url: url, name: guessNameFromUrl(url), mime: guessMimeFromUrl(url), size: null });
                return;
            }
            if (typeof a !== 'object') return;
            var isLocal = a._local === true;
            var u = safeUrl(a.url || a.secure_url || a.secureUrl || a.src || a.href || a.file_url, isLocal);
            if (!u) return;
            var k2 = dedupKey(u);
            if (seen[k2]) return;
            seen[k2] = 1;
            out.push({
                url: u,
                name: String(a.name || a.filename || a.originalname || guessNameFromUrl(u)).slice(0, 120),
                mime: String(a.mime || a.type || a.mimetype || a.content_type || guessMimeFromUrl(u)),
                size: isFinite(a.size) ? a.size : null,
                _local: isLocal
            });
        }
        if (Array.isArray(msg.attachments)) msg.attachments.forEach(push);
        else if (msg.attachments && typeof msg.attachments === 'object') push(msg.attachments);
        else if (typeof msg.attachments === 'string' && msg.attachments.trim()) {
            var raw = msg.attachments.trim();
            if (raw.charAt(0) === '[' || raw.charAt(0) === '{') {
                try {
                    var parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) parsed.forEach(push);
                    else push(parsed);
                } catch (e) { push(raw); }
            } else push(raw);
        }
        if (!out.length && msg.attachment_url) {
            push({ url: msg.attachment_url, type: msg.attachment_type, name: msg.attachment_name });
        }
        return out;
    }

    function timeAgoLabel(dateStr) {
        if (!dateStr) return '';
        var t = parseIsoTimestamp(dateStr);
        if (!isFinite(t)) return '';
        var s = Math.floor((Date.now() - t) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        if (s < 604800) return Math.floor(s / 86400) + 'd ago';
        return Math.floor(s / 604800) + 'w ago';
    }
    function isSameDay(a, b) {
        var ta = typeof a === 'number' ? a : parseIsoTimestamp(a);
        var tb = typeof b === 'number' ? b : parseIsoTimestamp(b);
        if (!isFinite(ta) || !isFinite(tb)) return false;
        var da = new Date(ta), db = new Date(tb);
        return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
    }
    function dateSeparator(dateStr) {
        var t = parseIsoTimestamp(dateStr);
        if (!isFinite(t)) return '';
        var d = new Date(t);
        var today = new Date();
        var y = new Date();
        y.setDate(today.getDate() - 1);
        if (isSameDay(d, today)) return 'Today';
        if (isSameDay(d, y)) return 'Yesterday';
        return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
    }
    function newRequestId() {
        try { if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID(); }
        catch (e) {}
        return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    }
    function safeStorageGet(storage, key) { try { return storage.getItem(key); } catch (e) { return null; } }
    function safeStorageSet(storage, key, value) { try { storage.setItem(key, value); return true; } catch (e) { return false; } }
    function safeStorageRemove(storage, key) { try { storage.removeItem(key); return true; } catch (e) { return false; } }

    function isAdminMessage(m) { return m && (m.sender_type === 'admin' || m.sender_type === 'support' || m.sender_type === 'agent' || m.sender_type === 'staff'); }
    function isPublicMessage(m) { return m && m.is_internal !== true; }
    function hasAgentReply(messages) {
        if (!Array.isArray(messages)) return false;
        for (var i = 0; i < messages.length; i++) {
            if (isAdminMessage(messages[i]) && isPublicMessage(messages[i])) return true;
        }
        return false;
    }

    function decodeJwtPayload(token) {
        try {
            var parts = String(token).split('.');
            if (parts.length !== 3) return null;
            var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            var json = decodeURIComponent(atob(b64).split('').map(function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join(''));
            return JSON.parse(json);
        } catch (e) { return null; }
    }
    function isJwtExpired(token) {
        var payload = decodeJwtPayload(token);
        if (!payload || !payload.exp) return false;
        return Date.now() >= payload.exp * 1000;
    }

    var _PROVIDER_RE = /dt\s*-?one|dtone|vt\s*-?pass|kora\s*-?pay|\bkora\b|now\s*-?payments/gi;
    function scrubProviders(text) {
        if (typeof text !== 'string') return text;
        if (window.MS && typeof window.MS.safeText === 'function') {
            try { return window.MS.safeText(text); } catch (e) {}
        }
        return text.replace(_PROVIDER_RE, 'our service partner');
    }

    function friendlyError(e) {
        if (!e) return 'Something went wrong. Please try again.';
        var code = String(e.code || '').toUpperCase();
        var status = Number(e.status || 0);
        var raw = String(e.message || '').trim();
        if (code === 'NETWORK_ERROR') return 'You seem to be offline. Your message was not sent.';
        if (code === 'SESSION_EXPIRED' || status === 401) return 'Please sign in again.';
        if (status === 403) return "You don't have access to this conversation.";
        if (code === 'RATE_LIMITED' || status === 429) return 'Too many attempts. Please wait a moment.';
        if (status >= 500) return 'Something went wrong on our side. Please try again.';
        if (/network|fetch|failed to fetch/i.test(raw)) return 'You seem to be offline. Your message was not sent.';
        var cleaned = scrubProviders(raw).replace(/\b[A-Z]{2,}_[A-Z_]{2,}\b/g, '').replace(/\s{2,}/g, ' ').trim();
        return cleaned || 'Something went wrong. Please try again.';
    }

    // ── Icons ──────────────────────────────────────────────
    var ICONS = {
        wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16.5" cy="14" r="1.1" fill="currentColor" stroke="none"/></svg>',
        deposit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/></svg>',
        airtime: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 20l4-4 4 4 4-6 4 2 2-6"/><circle cx="7" cy="16" r="1.4" fill="currentColor" stroke="none"/></svg>',
        data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h4"/></svg>',
        bills: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>',
        giftcard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="8" width="18" height="12" rx="2"/><path d="M3 12h18"/><path d="M12 8v12"/><path d="M8.5 8a2 2 0 110-4c1.5 0 3.5 2 3.5 4z"/><path d="M15.5 8a2 2 0 100-4c-1.5 0-3.5 2-3.5 4z"/></svg>',
        esim: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="3" width="14" height="18" rx="2"/><rect x="8" y="6" width="8" height="6" rx="1"/><path d="M8 15h8M8 18h5"/></svg>',
        marketplace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7l1.5-3h15L21 7"/><rect x="4" y="7" width="16" height="13" rx="1"/><path d="M9 11a3 3 0 006 0"/></svg>',
        virtual: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>',
        boost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19l6-6 4 4 6-8"/><path d="M15 8h5v5"/></svg>',
        account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c1.5-4 4.2-6 7.5-6s6 2 7.5 6"/></svg>',
        other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
        support: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 13a8 8 0 0116 0"/><rect x="2" y="13" width="5" height="6" rx="1.5"/><rect x="17" y="13" width="5" height="6" rx="1.5"/><path d="M20 19a4 4 0 01-4 4h-2"/></svg>',
        chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a8 8 0 01-11.6 7.2L4 20l1.1-4.3A8 8 0 1121 12z"/></svg>',
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
        minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>',
        send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
        search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
        bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 8a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 21a2 2 0 004 0"/></svg>',
        bellOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l18 18"/><path d="M6 8a6 6 0 0110.9-3.4M18 14c0-1 .2-2 0-3"/><path d="M4 14s2-1 2-6"/><path d="M10 21a2 2 0 004 0"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.6" fill="currentColor"/></svg>',
        image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5-5 5-4-4-4 4"/></svg>',
        paperclip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>',
        smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>',
        pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><path d="M14 2v6h6"/></svg>',
        file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/><path d="M14 2v6h6"/></svg>',
        back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 19l-7-7 7-7"/></svg>',
        plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
        clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
        star: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01z"/></svg>',
        starOutline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01z"/></svg>'
    };

    function iconMarkup(name, cls) {
        var svg = ICONS[name] || ICONS.other;
        return '<span class="miles-icon ' + (cls || '') + '" aria-hidden="true">' + svg + '</span>';
    }

    var STATUS_LABELS = {
        open: 'Open', assigned: 'Assigned', in_progress: 'In progress',
        waiting_user: 'Waiting on you', waiting_support: 'Waiting on support',
        resolved: 'Resolved', closed: 'Closed'
    };

    var DEFAULT_CATEGORIES = [];

    var HELP_ARTICLES = [
        { id: 'fund-wallet', categoryKey: 'funding', title: 'How do I fund my wallet?', summary: 'Add money to your MilesSpace wallet.', readTime: '2 min read', updatedAt: '2026-10-01', content: '<p>Open the <strong>Fund Wallet</strong> page and choose a payment method. Your balance updates once the provider confirms the payment.</p>' },
        { id: 'deposit-pending', categoryKey: 'funding', title: 'My deposit is still pending', summary: 'Deposits usually confirm within minutes.', readTime: '2 min read', updatedAt: '2026-10-01', content: '<p>Most deposits confirm within minutes. If yours has been pending over 30 minutes, contact support with the reference.</p>' },
        { id: 'airtime', categoryKey: 'airtime', title: 'How do I buy airtime?', summary: 'Send airtime to any supported number.', readTime: '2 min read', updatedAt: '2026-10-01', content: '<p>Open <strong>Airtime</strong>, pick the country and operator, enter the number and amount, and confirm.</p>' },
        { id: 'airtime-failed', categoryKey: 'airtime', title: 'I was charged but airtime did not arrive', summary: 'What to do if a purchase is stuck.', readTime: '2 min read', updatedAt: '2026-10-01', content: '<p>Wait 15 minutes first. If still missing, contact support with the order reference.</p>' },
        { id: 'data', categoryKey: 'data', title: 'How do I buy mobile data?', summary: 'Choose a plan and send data.', readTime: '2 min read', updatedAt: '2026-10-01', content: '<p>Open <strong>Data</strong>, pick the operator and a plan, then confirm.</p>' },
        { id: 'bills', categoryKey: 'bills', title: 'How do I pay a bill?', summary: 'Electricity, TV, and other billers.', readTime: '2 min read', updatedAt: '2026-10-01', content: '<p>Open <strong>Bills &amp; Utilities</strong>, choose the biller, enter your customer number, and confirm.</p>' },
        { id: 'esim', categoryKey: 'esim', title: 'How do I install my eSIM?', summary: 'Install your eSIM in a few steps.', readTime: '3 min read', updatedAt: '2026-10-01', content: '<p>Open the QR code we sent you after purchase. On your phone: <strong>Settings → Mobile Data → Add eSIM</strong>.</p>' },
        { id: 'gift', categoryKey: 'gift_cards', title: 'How do I buy a gift card?', summary: 'Purchase and receive gift cards.', readTime: '2 min read', updatedAt: '2026-10-01', content: '<p>Open <strong>Gift Cards</strong>, choose a card, select the value, and pay from your wallet.</p>' },
        { id: 'virtual', categoryKey: 'virtual_sms', title: 'What is a virtual number?', summary: 'Temporary numbers for SMS and OTP.', readTime: '2 min read', updatedAt: '2026-10-01', content: '<p>Virtual numbers are temporary phone numbers that receive SMS messages.</p>' },
        { id: 'boost', categoryKey: 'social_boosting', title: 'How does social boosting work?', summary: 'Increase engagement on your posts.', readTime: '2 min read', updatedAt: '2026-10-01', content: '<p>Open <strong>Boost</strong>, choose the platform and service, then paste your link.</p>' },
        { id: 'market', categoryKey: 'marketplace', title: 'How do I order from the marketplace?', summary: 'Buy from MilesSpace Marketplace.', readTime: '2 min read', updatedAt: '2026-10-01', content: '<p>Browse the Marketplace, choose an item, and complete checkout from your wallet.</p>' },
        { id: 'secure', categoryKey: 'account_security', title: 'How do I secure my account?', summary: 'Turn on 2FA and use a strong password.', readTime: '3 min read', updatedAt: '2026-10-01', content: '<p>Enable <strong>Two-Factor Authentication</strong> from Settings. Use a strong password and never share it.</p>' }
    ];

    // ── Styles ─────────────────────────────────────────────
    var WIDGET_STYLES = [
        '#miles-widget-root{--miles-primary:#0c3d4a;--miles-primary-light:#12556a;--miles-primary-dark:#082a33;--miles-accent:#f59e0b;--miles-bg:#f4f7fb;--miles-white:#ffffff;--miles-text:#0c1f26;--miles-text-dim:#5b7480;--miles-text-faint:#8fa3ab;--miles-border:rgba(12,61,74,0.10);--miles-success:#16a34a;--miles-danger:#dc2626;--miles-shadow:0 12px 40px rgba(8,42,51,0.18);--miles-radius:18px;font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;position:fixed;inset:auto 0 0 0;width:0;height:0;z-index:2147483000;pointer-events:none}',
        '#miles-widget-root,#miles-widget-root *{box-sizing:border-box}',
        '#miles-widget-root .miles-icon{display:inline-flex;width:18px;height:18px;flex-shrink:0}',
        '#miles-widget-root .miles-icon svg{width:100%;height:100%}',

        '#miles-launcher{position:fixed;bottom:24px;right:24px;width:62px;height:62px;border-radius:50%;background:linear-gradient(135deg,var(--miles-primary),var(--miles-primary-light));color:#fff;border:none;cursor:pointer;box-shadow:0 6px 24px rgba(12,61,74,0.35);display:flex;align-items:center;justify-content:center;z-index:2147483010;padding:0;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;transition:box-shadow .2s,background .2s;pointer-events:auto;will-change:transform}',
        '#miles-launcher .miles-icon{width:28px;height:28px;pointer-events:none}',
        '#miles-launcher:focus-visible{outline:3px solid var(--miles-accent);outline-offset:3px}',
        '#miles-launcher.dragging{cursor:grabbing;box-shadow:0 8px 40px rgba(12,61,74,0.6)}',
        '#miles-launcher .badge{position:absolute;top:-4px;right:-4px;background:var(--miles-danger);color:#fff;font-size:11px;font-weight:700;min-width:20px;height:20px;border-radius:99px;display:none;align-items:center;justify-content:center;padding:0 5px;border:2px solid #fff;pointer-events:none}',
        '#miles-launcher .badge.show{display:flex}',

        '#miles-panel{position:fixed;bottom:102px;right:24px;width:min(460px,calc(100vw - 32px));height:min(720px,calc(100dvh - 140px));min-height:min(460px,calc(100dvh - 32px));background:var(--miles-white);border-radius:var(--miles-radius);box-shadow:0 20px 60px rgba(8,42,51,0.28);display:none;flex-direction:column;overflow:hidden;border:1px solid var(--miles-border);pointer-events:auto;z-index:2147483001}',
        '#miles-panel.open{display:flex;animation:milesSlideUp .22s cubic-bezier(.4,0,.2,1)}',
        '@keyframes milesSlideUp{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}',

        '.miles-header{padding:16px 20px;background:linear-gradient(135deg,var(--miles-primary),var(--miles-primary-light));color:#fff;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding-top:calc(16px + env(safe-area-inset-top,0px))}',
        '.miles-header-left{display:flex;align-items:center;gap:12px;min-width:0}',
        '.miles-header-left .info h3{font-size:16px;font-weight:700;margin:0}',
        '.miles-header-left .info .status{font-size:12px;opacity:.85;display:flex;align-items:center;gap:6px;margin-top:2px}',
        '.miles-header-left .info .status .dot{width:7px;height:7px;border-radius:50%;background:#22c55e}',
        '.miles-header-actions{display:flex;gap:6px}',
        '.miles-header-actions button{width:40px;height:40px;border-radius:8px;background:rgba(255,255,255,.12);border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}',
        '.miles-header-actions button:hover{background:rgba(255,255,255,.22)}',
        '.miles-header-actions .miles-icon{width:16px;height:16px}',

        '.miles-offline-banner{display:none;padding:8px 16px;background:#fef3c7;color:#92400e;border-bottom:1px solid #fcd34d;font-size:12px;font-weight:600;text-align:center}',
        '.miles-offline-banner.show{display:block}',

        '.miles-tabs{display:flex;border-bottom:1px solid var(--miles-border);background:var(--miles-bg);flex-shrink:0;padding:0 8px}',
        '.miles-tabs .tab{flex:1;padding:12px 8px;font-size:13px;font-weight:600;color:var(--miles-text-dim);cursor:pointer;border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:6px;min-height:44px}',
        '.miles-tabs .tab.active{color:var(--miles-primary);border-bottom-color:var(--miles-primary)}',
        '.miles-tabs .tab .tab-badge{background:var(--miles-danger);color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:99px;display:none}',
        '.miles-tabs .tab .tab-badge.show{display:inline-block}',

        '.miles-content{flex:1;overflow:hidden;position:relative;background:var(--miles-bg)}',
        '.miles-tab-content{display:none;height:100%;overflow-y:auto;padding:18px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}',
        '.miles-tab-content.active{display:block}',

        '.miles-welcome{padding:6px 0 14px}',
        '.miles-welcome .greeting{font-size:20px;font-weight:700;color:var(--miles-text)}',
        '.miles-welcome .sub{font-size:13.5px;color:var(--miles-text-dim);margin-top:4px;line-height:1.5}',

        '.miles-suggestions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}',
        '.miles-suggestion{padding:14px 12px;background:var(--miles-white);border:1px solid var(--miles-border);border-radius:12px;cursor:pointer;text-align:left;font-size:13px;font-weight:600;color:var(--miles-text);display:flex;align-items:center;gap:10px;font-family:inherit;transition:border-color .15s,background .15s;min-height:44px}',
        '.miles-suggestion:hover{border-color:var(--miles-primary);background:#f0f7fa}',
        '.miles-suggestion .miles-icon{color:var(--miles-primary);flex-shrink:0;width:20px;height:20px}',

        '.miles-contact-btn{width:100%;margin-top:16px;padding:14px;border-radius:12px;background:var(--miles-primary);color:#fff;border:none;font-weight:700;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;font-family:inherit;min-height:48px}',
        '.miles-contact-btn:hover{background:var(--miles-primary-light)}',

        '#tab-chats{position:relative;overflow:hidden;padding:0!important}',
        '#tab-chats > .miles-conv-list,#tab-chats > .miles-message-view{position:absolute;inset:0;width:100%;height:100%}',
        '#tab-chats > .miles-conv-list{display:flex;flex-direction:column;background:var(--miles-white);z-index:1}',
        '#tab-chats > .miles-message-view{display:none;flex-direction:column;background:var(--miles-bg);z-index:2}',
        '#tab-chats > .miles-message-view.open{display:flex}',
        '#tab-chats > .miles-message-view.guest-mode .miles-input-area:not(#guestInputArea),#tab-chats > .miles-message-view.guest-mode #milesRatingSlot{display:none}',

        '.miles-conv-list .conv-header{padding:12px 16px;border-bottom:1px solid var(--miles-border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;background:var(--miles-bg);gap:8px}',
        '.miles-conv-list .conv-header h4{font-size:14px;font-weight:700;color:var(--miles-text)}',
        '.miles-conv-list .conv-header .conv-count{font-size:12px;color:var(--miles-text-dim)}',
        '.miles-conv-list .conv-header .new-ticket-btn{display:flex;align-items:center;gap:4px;padding:6px 12px;background:var(--miles-primary);color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;min-height:40px}',
        '.miles-conv-list .conv-search{padding:8px 14px;border-bottom:1px solid var(--miles-border);flex-shrink:0}',
        '.miles-conv-list .conv-search input{width:100%;padding:8px 12px;border:1px solid var(--miles-border);border-radius:8px;font-size:16px;outline:none;background:var(--miles-bg);font-family:inherit;min-height:44px}',

        '.miles-conv-items{flex:1;overflow-y:auto;padding:4px 0;overscroll-behavior:contain}',
        '.miles-conv-item{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;transition:background .15s;width:100%;border:0;border-left:3px solid transparent;background:transparent;color:inherit;font-family:inherit;text-align:left}',
        '.miles-conv-item:hover{background:var(--miles-bg)}',
        '.miles-conv-item.active{background:#fdf3e0;border-left-color:var(--miles-primary)}',
        '.miles-conv-item .avatar{width:42px;height:42px;border-radius:50%;background:var(--miles-primary);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;flex-shrink:0}',
        '.miles-conv-item .info{flex:1;min-width:0}',
        '.miles-conv-item .info .top{display:flex;justify-content:space-between;align-items:center;gap:6px}',
        '.miles-conv-item .info .subject{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.miles-conv-item .info .preview{font-size:12px;color:var(--miles-text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}',
        '.miles-conv-item .info .meta{font-size:10.5px;color:var(--miles-text-faint);margin-top:3px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
        '.miles-conv-item .status-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0;background:var(--miles-success)}',
        '.miles-conv-item .status-dot.waiting_user{background:var(--miles-accent)}',
        '.miles-conv-item .status-dot.resolved{background:var(--miles-text-faint)}',
        '.miles-conv-item .status-dot.closed{background:#94a3b8}',
        '.miles-conv-item .unread-badge{background:var(--miles-danger);color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:99px;min-width:18px;text-align:center;flex-shrink:0}',
        '.miles-conv-item .time-ago{font-size:10.5px;color:var(--miles-text-faint);white-space:nowrap;flex-shrink:0}',

        '.miles-conv-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;color:var(--miles-text-faint);text-align:center;height:100%}',
        '.miles-conv-empty .miles-icon{width:44px;height:44px;opacity:.35;margin-bottom:14px}',
        '.miles-conv-empty h4{font-size:16px;font-weight:700;color:var(--miles-text);margin-bottom:6px}',
        '.miles-conv-empty p{font-size:13px;margin:0;line-height:1.5}',
        '.miles-conv-empty .btn-primary{margin-top:14px;padding:10px 22px;background:var(--miles-primary);color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:13px;font-family:inherit;min-height:44px}',

        '.miles-msg-header{padding:12px 16px;border-bottom:1px solid var(--miles-border);background:var(--miles-white);display:flex;align-items:center;gap:10px;flex-shrink:0}',
        '.miles-msg-header .back-btn{background:none;border:none;cursor:pointer;font-size:18px;color:var(--miles-primary);padding:4px;display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px}',
        '.miles-msg-header .info{flex:1;min-width:0}',
        '.miles-msg-header .info .subject{font-weight:700;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.miles-msg-header .info .status{font-size:12px;color:var(--miles-text-dim);display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:2px}',
        '.miles-msg-header .info .status .dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:4px;background:var(--miles-success)}',
        '.miles-msg-header .info .status .dot.waiting_user{background:var(--miles-accent)}',
        '.miles-msg-header .info .status .dot.resolved{background:var(--miles-text-faint)}',
        '.miles-msg-header .info .status .dot.closed{background:#94a3b8}',
        '.miles-msg-header-actions{display:flex;gap:4px;flex-shrink:0}',
        '.miles-msg-header-actions button{padding:8px 12px;border-radius:7px;border:1px solid var(--miles-border);background:var(--miles-white);color:var(--miles-text-dim);font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit;min-height:40px}',

        '.miles-message-list{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:8px;overscroll-behavior:contain}',
        '.miles-msg{max-width:82%;padding:10px 14px;border-radius:12px;word-wrap:break-word;line-height:1.5;font-size:13.5px;animation:fadeIn .25s ease;overflow-wrap:anywhere}',
        '.miles-msg.user{align-self:flex-end;background:var(--miles-primary);color:#fff;border-bottom-right-radius:4px}',
        '.miles-msg.support{align-self:flex-start;background:var(--miles-white);color:var(--miles-text);border:1px solid var(--miles-border);border-bottom-left-radius:4px}',
        '.miles-msg.system{align-self:center;background:#eef2f5;color:var(--miles-text-dim);font-size:12px;max-width:92%;border-radius:20px;padding:5px 16px}',
        '.miles-msg.media-only{padding:4px;background:transparent;border:none}',
        '.miles-msg.user.media-only{background:transparent;color:var(--miles-text)}',
        '.miles-msg.media-only .miles-attachment{border:none;background:transparent;margin-top:0}',
        '.miles-msg.media-only .miles-attachment img{border-radius:10px}',
        '.miles-msg.media-only .time{color:var(--miles-text-faint);justify-content:flex-end;padding:2px 4px}',
        '.miles-msg-text{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}',
        '.miles-msg-text a{color:inherit;text-decoration:underline}',
        '.miles-msg .time{font-size:10.5px;opacity:.65;margin-top:4px;text-align:right;display:flex;align-items:center;justify-content:flex-end;gap:4px}',
        '.miles-msg.failed{border:1px solid var(--miles-danger)}',

        '.msg-status{display:inline-flex;width:14px;height:14px;flex-shrink:0;padding:0;background:none;border:none}',
        '.msg-status svg{width:100%;height:100%}',
        '.msg-status.sending{animation:spin 1s linear infinite;opacity:0.6}',
        '.msg-status.failed{color:var(--miles-danger);cursor:pointer}',
        '@keyframes spin{100%{transform:rotate(360deg)}}',

        '.miles-date-sep{align-self:center;font-size:11px;color:var(--miles-text-faint);padding:4px 12px;margin:6px 0}',

        '.miles-waiting-panel{margin:16px;padding:18px;border-radius:14px;background:#fff;border:1px solid var(--miles-border);text-align:center}',
        '.miles-waiting-panel .wp-icon{width:52px;height:52px;margin:0 auto 12px;border-radius:50%;background:#fdf3e0;display:flex;align-items:center;justify-content:center;color:var(--miles-accent)}',
        '.miles-waiting-panel .wp-icon .miles-icon{width:26px;height:26px}',
        '.miles-waiting-panel h4{font-size:15px;font-weight:700;color:var(--miles-text);margin-bottom:6px}',
        '.miles-waiting-panel p{font-size:12.5px;color:var(--miles-text-dim);line-height:1.55;margin:0}',
        '.miles-waiting-panel .wp-hint{margin-top:12px;font-size:11.5px;color:var(--miles-text-faint);padding-top:12px;border-top:1px solid var(--miles-border)}',

        '.miles-attachment{margin-top:6px;border:1px solid var(--miles-border);border-radius:8px;overflow:hidden;max-width:260px;background:var(--miles-bg);cursor:pointer}',
        '.miles-attachment img{display:block;max-width:100%;max-height:220px;object-fit:contain;width:auto;background:#00000008}',
        '.miles-attachment .attachment-info{display:flex;align-items:center;gap:8px;padding:8px 10px;font-size:11.5px;color:var(--miles-text-dim);background:var(--miles-white)}',
        '.miles-attachment .attachment-info .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.miles-msg.user .miles-attachment{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.2)}',
        '.miles-msg.user .miles-attachment .attachment-info{background:transparent;color:rgba(255,255,255,.85)}',

        '.miles-input-area{padding:10px 16px calc(16px + env(safe-area-inset-bottom,0px)) 16px;border-top:1px solid var(--miles-border);background:var(--miles-white);flex-shrink:0;position:relative}',
        '.miles-file-preview{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 8px 0}',
        '.miles-file-preview:empty{display:none}',
        '.miles-file-preview .file-item{display:flex;align-items:center;gap:6px;padding:5px 8px 5px 6px;background:var(--miles-bg);border:1px solid var(--miles-border);border-radius:6px;font-size:11.5px}',
        '.miles-file-preview .file-item.image-item{padding:0;overflow:hidden}',
        '.miles-file-preview .file-item.image-item img{width:44px;height:44px;object-fit:cover;display:block}',
        '.miles-file-preview .file-item .file-name{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.miles-file-preview .file-item .remove-file{cursor:pointer;color:var(--miles-danger);background:none;border:none;padding:4px;font-size:13px;line-height:1;font-weight:700;min-width:32px;min-height:32px}',

        '.miles-composer-box{background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:22px;padding:8px 10px;display:flex;flex-direction:column;transition:border-color .2s, box-shadow .2s}',
        '.miles-composer-box:focus-within{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.15);background:#fff}',

        '.miles-composer-textarea{width:100%;border:none;background:transparent;resize:none;padding:6px 8px;font-family:inherit;font-size:16px;color:var(--miles-text);outline:none;min-height:38px;max-height:120px;line-height:1.5;overflow-y:auto}',
        '.miles-composer-textarea::placeholder{color:#94a3b8}',

        '.miles-composer-actions{display:flex;align-items:center;justify-content:space-between;margin-top:4px}',
        '.miles-composer-left{display:flex;align-items:center;gap:2px}',

        '.miles-composer-btn{width:40px;height:40px;border-radius:50%;border:none;background:transparent;color:#64748b;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .15s, color .15s}',
        '.miles-composer-btn:hover{background:#e2e8f0;color:#0f172a}',
        '.miles-composer-btn .miles-icon{width:20px;height:20px}',

        '.miles-send-btn{width:42px;height:42px;border-radius:50%;background:#3b82f6;color:#fff;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .15s, transform .1s}',
        '.miles-send-btn:hover{background:#2563eb}',
        '.miles-send-btn:active{transform:scale(0.95)}',
        '.miles-send-btn:disabled{opacity:.4;cursor:not-allowed;background:#94a3b8}',
        '.miles-send-btn .miles-icon{width:20px;height:20px}',

        '.miles-send-status{font-size:11px;color:var(--miles-text-faint);padding:6px 4px 0 4px;min-height:14px;text-align:center}',
        '.miles-send-status.error{color:var(--miles-danger)}',

        '.miles-emoji-picker{position:absolute;bottom:calc(70px + env(safe-area-inset-bottom,0px));left:16px;background:#fff;border:1px solid var(--miles-border);border-radius:12px;box-shadow:0 10px 25px rgba(0,0,0,.1);padding:8px;display:none;grid-template-columns:repeat(6,1fr);gap:4px;z-index:10;width:220px;max-height:180px;overflow-y:auto}',
        '.miles-emoji-picker.open{display:grid}',
        '.miles-emoji-picker button{background:none;border:none;font-size:20px;cursor:pointer;padding:4px;border-radius:6px;display:flex;align-items:center;justify-content:center;min-height:32px}',
        '.miles-emoji-picker button:hover{background:#f1f5f9}',

        '.miles-drop-overlay{position:absolute;inset:0;background:rgba(12,61,74,.85);color:#fff;display:none;align-items:center;justify-content:center;flex-direction:column;gap:12px;z-index:20;border-radius:0}',
        '.miles-drop-overlay.show{display:flex}',
        '.miles-drop-overlay .miles-icon{width:48px;height:48px;opacity:.9}',
        '.miles-drop-overlay p{font-size:14px;font-weight:600}',

        '.miles-msg-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;color:var(--miles-text-faint);text-align:center;padding:24px}',
        '.miles-msg-empty .miles-icon{width:44px;height:44px;opacity:.35;margin-bottom:14px}',
        '.miles-msg-empty h4{font-size:15px;font-weight:700;color:var(--miles-text);margin-bottom:4px}',
        '.miles-msg-empty p{font-size:12.5px;margin:0;line-height:1.5}',

        '.miles-rating-box{margin:12px 16px;padding:14px;background:var(--miles-white);border:1px solid var(--miles-border);border-radius:12px;text-align:center}',
        '.miles-rating-box h5{font-size:13px;font-weight:700;color:var(--miles-text);margin-bottom:8px}',
        '.miles-rating-stars{display:flex;justify-content:center;gap:4px;margin-bottom:10px}',
        '.miles-rating-stars button{background:none;border:none;cursor:pointer;color:var(--miles-text-faint);padding:4px;min-width:44px;min-height:44px}',
        '.miles-rating-stars button .miles-icon{width:28px;height:28px}',
        '.miles-rating-stars button.active{color:var(--miles-accent)}',
        '.miles-rating-box textarea{width:100%;padding:8px 10px;border:1px solid var(--miles-border);border-radius:8px;font-size:16px;font-family:inherit;resize:vertical;min-height:50px;margin-bottom:8px}',
        '.miles-rating-box .submit-rating{padding:8px 18px;background:var(--miles-primary);color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:12.5px;min-height:44px}',
        '.miles-rating-done{font-size:12px;color:var(--miles-success);font-weight:600}',

        '.miles-help-search{margin-bottom:14px;position:relative}',
        '.miles-help-search input{width:100%;padding:10px 12px 10px 40px;border:1px solid var(--miles-border);border-radius:10px;font-size:16px;outline:none;background:var(--miles-white);font-family:inherit;min-height:44px}',
        '.miles-help-search .miles-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--miles-text-dim)}',
        '.miles-help-list{display:flex;flex-direction:column;gap:6px}',
        '.miles-help-item{padding:14px;background:var(--miles-white);border:1px solid var(--miles-border);border-radius:10px;cursor:pointer;display:flex;align-items:center;gap:12px;width:100%;text-align:left;font-family:inherit;min-height:52px}',
        '.miles-help-item:hover{border-color:var(--miles-primary)}',
        '.miles-help-item .icon{width:28px;text-align:center;flex-shrink:0;color:var(--miles-primary)}',
        '.miles-help-item .text{flex:1;font-size:13px;font-weight:600;color:var(--miles-text)}',
        '.miles-help-item .text .sub{font-size:11.5px;font-weight:400;color:var(--miles-text-dim);display:block;margin-top:2px}',

        '.miles-article-view{display:none;flex-direction:column;height:100%;background:var(--miles-white)}',
        '.miles-article-view.open{display:flex}',
        '.miles-article-header{padding:12px 16px;border-bottom:1px solid var(--miles-border);background:var(--miles-white);display:flex;align-items:center;gap:10px;flex-shrink:0}',
        '.miles-article-header .back-btn{background:none;border:none;cursor:pointer;font-size:18px;color:var(--miles-primary);padding:4px;min-width:44px;min-height:44px}',
        '.miles-article-body{flex:1;overflow-y:auto;padding:18px 20px;overscroll-behavior:contain}',
        '.miles-article-body h2{font-size:19px;font-weight:700;margin-bottom:6px}',
        '.miles-article-body .meta{font-size:11.5px;color:var(--miles-text-dim);margin-bottom:14px}',
        '.miles-article-body .content{font-size:13.5px;line-height:1.7}',
        '.miles-article-body .content p{margin-bottom:10px}',
        '.miles-article-body .content strong{color:var(--miles-primary)}',
        '.miles-article-body .article-actions{margin-top:18px;padding-top:18px;border-top:1px solid var(--miles-border);display:flex;flex-direction:column;gap:8px}',
        '.miles-article-body .btn-support{padding:12px;border-radius:10px;background:var(--miles-primary);color:#fff;border:none;font-weight:700;cursor:pointer;font-size:13px;font-family:inherit;min-height:44px}',
        '.miles-article-body .btn-back-help{padding:10px;border-radius:10px;background:var(--miles-bg);color:var(--miles-text);border:none;font-weight:600;cursor:pointer;font-size:12.5px;font-family:inherit;min-height:44px}',

        '.miles-guest-form{display:flex;flex-direction:column;gap:12px;padding:6px 2px}',
        '.miles-guest-form label{font-size:12px;font-weight:700;color:var(--miles-text-dim);text-transform:uppercase;letter-spacing:.04em}',
        '.miles-guest-form input,.miles-guest-form select,.miles-guest-form textarea{width:100%;padding:11px 14px;border:1px solid var(--miles-border);border-radius:10px;font-size:16px!important;outline:none;background:var(--miles-white);font-family:inherit;min-height:44px}',
        '.miles-guest-form input:focus,.miles-guest-form select:focus,.miles-guest-form textarea:focus{border-color:var(--miles-primary)}',
        '.miles-guest-form textarea{min-height:100px;resize:vertical}',
        '.miles-guest-form .submit-btn{padding:13px;border-radius:10px;background:var(--miles-primary);color:#fff;border:none;font-weight:700;cursor:pointer;font-size:13.5px;margin-top:4px;min-height:44px}',
        '.miles-honeypot{position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none}',
        '.miles-form-error{font-size:12.5px;color:var(--miles-danger);min-height:16px;font-weight:500}',
        '.miles-form-note{font-size:12px;color:var(--miles-text-faint);line-height:1.5}',

        '.miles-modal-overlay{position:fixed;inset:0;background:rgba(8,20,25,.55);z-index:2147483003;display:none;align-items:center;justify-content:center;padding:16px;pointer-events:auto}',
        '.miles-modal-overlay.open{display:flex}',
        '.miles-modal-box{width:440px;max-width:100%;height:auto;max-height:min(680px, calc(100dvh - 32px));background:var(--miles-white);border-radius:16px;box-shadow:var(--miles-shadow);display:flex;flex-direction:column;overflow:hidden}',

        '.miles-modal-head{padding:16px 18px;border-bottom:1px solid var(--miles-border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}',
        '.miles-modal-head h4{font-size:16px;font-weight:700}',
        '.miles-modal-head button{background:none;border:none;cursor:pointer;color:var(--miles-text-dim);padding:4px;min-width:44px;min-height:44px}',

        '#milesModalContent, #milesTicketForm { display:flex; flex-direction:column; min-height:0; flex:1; }',
        '.miles-modal-body{padding:18px;overflow-y:auto;display:flex;flex-direction:column;gap:14px;flex:1;min-height:0;overscroll-behavior:contain}',
        '.miles-modal-body label{font-size:12px;font-weight:700;color:var(--miles-text-dim);text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:6px}',

        '.miles-modal-body input,.miles-modal-body select,.miles-modal-body textarea{width:100%;padding:11px 14px;border:1px solid var(--miles-border);border-radius:10px;font-size:16px!important;outline:none;background:var(--miles-bg);font-family:inherit;min-height:44px}',

        '.miles-modal-body input:focus,.miles-modal-body select:focus,.miles-modal-body textarea:focus{border-color:var(--miles-primary)}',
        '.miles-modal-body textarea{min-height:90px;resize:vertical}',

        '.miles-modal-foot{padding:14px 18px calc(14px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--miles-border);flex-shrink:0; background:var(--miles-white); z-index:2;}',
        '.miles-modal-foot .submit-ticket-btn{width:100%;padding:13px;border-radius:10px;background:var(--miles-primary);color:#fff;border:none;font-weight:700;cursor:pointer;font-size:13.5px;min-height:48px}',
        '.miles-modal-foot .submit-ticket-btn:disabled{opacity:.6;cursor:not-allowed}',

        '.miles-modal-error{font-size:12.5px;color:var(--miles-danger);text-align:center}',
        '.miles-modal-success{display:flex;flex-direction:column;align-items:center;text-align:center;padding:22px 8px;gap:8px}',

        '.miles-lightbox{position:fixed;inset:0;background:rgba(8,20,25,.92);z-index:2147483005;display:none;align-items:center;justify-content:center;padding:24px;pointer-events:auto}',
        '.miles-lightbox.open{display:flex}',
        '.miles-lightbox img{max-width:100%;max-height:100%;border-radius:8px;object-fit:contain}',
        '.miles-lightbox .lb-close{position:absolute;top:16px;right:16px;width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.15);border:none;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer}',
        '.miles-lightbox .lb-open-original{position:absolute;bottom:16px;right:16px;padding:8px 14px;border-radius:8px;background:rgba(255,255,255,.15);color:#fff;font-size:12px;font-weight:700;text-decoration:none;min-height:40px;display:inline-flex;align-items:center}',

        '@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}',

        '@media (prefers-reduced-motion: reduce){#miles-panel.open,.miles-msg,.msg-status.sending,.miles-send-btn,.miles-composer-btn,.toast{animation:none!important;transition:none!important}}',

        '@media (max-width:520px){',
        '#miles-launcher{bottom:calc(16px + env(safe-area-inset-bottom,0px));right:16px;width:56px;height:56px}',
        '#miles-launcher .miles-icon{width:26px;height:26px}',
        '#miles-panel{inset:0!important;left:0!important;top:0!important;width:100%!important;height:100%!important;max-height:100dvh!important;min-height:0!important;border-radius:0!important;bottom:auto!important;right:auto!important}',
        '.miles-header{padding-top:calc(16px + env(safe-area-inset-top,0px))}',
        '.miles-tabs .tab{padding:12px 8px;font-size:12.5px;min-height:44px}',
        '.miles-composer-textarea{font-size:16px!important}',
        '.miles-input-area{padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}',
        '.miles-header-actions button{min-width:44px;min-height:44px}',
        '.miles-composer-btn{min-width:44px;min-height:44px}',
        '.miles-send-btn{min-width:44px;min-height:44px}',
        '.miles-modal-overlay{padding:0!important;align-items:flex-start!important}',
        '.miles-modal-box{width:100%!important;height:100dvh!important;max-height:100dvh!important;border-radius:0!important;display:flex;flex-direction:column}',
        '.miles-modal-head{padding-top:calc(16px + env(safe-area-inset-top,0px))!important;flex-shrink:0}',
        '.miles-modal-body{flex:1;overflow-y:auto;padding-bottom:0}',
        '.miles-modal-foot{flex-shrink:0;padding-bottom:calc(14px + env(safe-area-inset-bottom,0px))}',
        '}',

        '@media (max-width:520px) and (orientation:landscape){',
        '#miles-panel{inset:0!important;left:0!important;top:0!important;width:100%!important;height:100%!important;border-radius:0!important}',
        '}',

        '@media (max-height:500px) and (max-width:900px) and (pointer:coarse){',
        '#miles-panel{inset:0!important;left:0!important;top:0!important;width:100%!important;height:100%!important;max-height:100dvh!important;border-radius:0!important;bottom:auto!important;right:auto!important}',
        '.miles-modal-box{width:100%!important;height:100dvh!important;max-height:100dvh!important;border-radius:0!important}',
        '}',

        '#miles-widget-root.is-open #miles-launcher{visibility:hidden;pointer-events:none}',

        'html.miles-scroll-lock{overflow:hidden!important;height:100%!important}'
    ].join('');

    // ── Template ───────────────────────────────────────────
    function buildTemplate() {
        return '' +
        '<button id="miles-launcher" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Open support chat">' +
            '<span class="badge" id="milesBadge" aria-hidden="true">0</span>' +
            iconMarkup('chat') +
        '</button>' +

        '<div id="miles-panel" role="dialog" aria-modal="false" aria-label="MilesSpace Support" aria-hidden="true" inert>' +
            '<div class="miles-header">' +
                '<div class="miles-header-left">' +
                    '<div class="info">' +
                        '<h3>Miles Support</h3>' +
                        '<div class="status" id="milesStatusRow">' +
                            '<span class="dot" id="milesStatusDot"></span>' +
                            '<span id="milesStatusText">Support available</span>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="miles-header-actions">' +
                    '<button id="milesMuteBtn" type="button" title="Mute notifications" aria-pressed="false">' + iconMarkup('bell') + '</button>' +
                    '<button id="milesMinimize" type="button" title="Minimize">' + iconMarkup('minimize') + '</button>' +
                    '<button id="milesClose" type="button" title="Close">' + iconMarkup('close') + '</button>' +
                '</div>' +
            '</div>' +

            '<div class="miles-offline-banner" id="milesOfflineBanner">You are offline. Your message will be sent when you reconnect.</div>' +

            '<div class="miles-tabs" role="tablist">' +
                '<button class="tab active" data-tab="home" type="button" role="tab" aria-selected="true">Home</button>' +
                '<button class="tab" data-tab="chats" type="button" role="tab" aria-selected="false">Chats <span class="tab-badge" id="milesTabBadge">0</span></button>' +
                '<button class="tab" data-tab="help" type="button" role="tab" aria-selected="false">Help</button>' +
            '</div>' +

            '<div class="miles-content">' +

                '<div class="miles-tab-content active" id="tab-home" role="tabpanel">' +
                    '<div class="miles-welcome">' +
                        '<div class="greeting" id="milesGreeting">Hi there!</div>' +
                        '<div class="sub" id="milesAvailabilityText">Support available</div>' +
                    '</div>' +
                    '<div class="miles-suggestions" id="milesSuggestions"></div>' +
                    '<button class="miles-contact-btn" id="milesContactSupport" type="button">' + iconMarkup('support') + ' Contact human support</button>' +
                '</div>' +

                '<div class="miles-tab-content" id="tab-chats" role="tabpanel">' +
                    '<div class="miles-conv-list" id="milesConvList">' +
                        '<div class="conv-header">' +
                            '<div><h4>Conversations</h4><span class="conv-count" id="milesConvCount">0 chats</span></div>' +
                            '<button class="new-ticket-btn" id="milesNewTicketBtn" type="button" style="display:flex !important;">' + iconMarkup('plus') + ' New</button>' +
                        '</div>' +
                        '<div class="conv-search"><input type="text" id="milesConvSearch" placeholder="Search conversations..." /></div>' +
                        '<div class="miles-conv-items" id="milesConvItems" role="list">' +
                            '<div class="miles-conv-empty">' + iconMarkup('chat') + '<h4>No conversations</h4><p>Start a new conversation from the Home tab</p><button class="btn-primary" id="milesEmptyStartChat" type="button">Start a chat</button></div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="miles-message-view" id="milesMessageView">' +
                        '<div class="miles-msg-header">' +
                            '<button class="back-btn" id="milesMsgBack" aria-label="Back to conversations">' + iconMarkup('back') + '</button>' +
                            '<div class="info"><div class="subject" id="milesMsgSubject">Conversation</div><div class="status" id="milesMsgStatus"><span class="dot open"></span> Open</div></div>' +
                            '<div class="miles-msg-header-actions" id="milesMsgHeaderActions"></div>' +
                        '</div>' +
                        '<div class="miles-message-list" id="milesMessageList" role="log" aria-live="polite"><div class="miles-msg-empty">' + iconMarkup('chat') + '<p>No messages yet</p></div></div>' +
                        '<div id="milesRatingSlot"></div>' +

                        '<div class="miles-input-area" id="milesInputArea">' +
                            '<div class="miles-emoji-picker" id="milesEmojiPicker"></div>' +
                            '<div class="miles-file-preview" id="milesFilePreview"></div>' +
                            '<div class="miles-composer-box">' +
                                '<textarea class="miles-composer-textarea" id="milesInput" placeholder="Type a message…" rows="1" maxlength="' + CONFIG.MAX_MESSAGE_LENGTH + '"></textarea>' +
                                '<div class="miles-composer-actions">' +
                                    '<div class="miles-composer-left">' +
                                        '<button class="miles-composer-btn" id="milesAttachBtn" type="button" aria-label="Attach file">' + iconMarkup('paperclip') + '</button>' +
                                        '<button class="miles-composer-btn" id="milesEmojiBtn" type="button" aria-label="Insert emoji">' + iconMarkup('smile') + '</button>' +
                                    '</div>' +
                                    '<button class="miles-send-btn" id="milesSendBtn" type="button" aria-label="Send message">' + iconMarkup('send') + '</button>' +
                                '</div>' +
                            '</div>' +
                            '<input class="attach-input" type="file" id="milesFileInput" multiple accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/csv" tabindex="-1" aria-hidden="true" style="display:none">' +
                            '<div class="miles-send-status" id="milesSendStatus"></div>' +
                        '</div>' +
                    '</div>' +
                '</div>' +

                '<div class="miles-tab-content" id="tab-help" role="tabpanel">' +
                    '<div class="miles-help-search">' + iconMarkup('search') + '<input type="text" id="milesHelpSearch" placeholder="Search help articles…" autocomplete="off"></div>' +
                    '<div class="miles-help-list" id="milesHelpList"></div>' +
                    '<div class="miles-article-view" id="milesArticleView">' +
                        '<div class="miles-article-header">' +
                            '<button class="back-btn" id="milesArticleBack" aria-label="Back to help">' + iconMarkup('back') + '</button>' +
                            '<div class="info"><div class="title" id="milesArticleTitle">Article</div><div class="sub" id="milesArticleSub"></div></div>' +
                        '</div>' +
                        '<div class="miles-article-body" id="milesArticleBody"></div>' +
                    '</div>' +
                '</div>' +

            '</div>' +
        '</div>' +

        '<div class="miles-modal-overlay" id="milesModalOverlay" role="presentation">' +
            '<div class="miles-modal-box" role="dialog" aria-modal="true" aria-labelledby="milesModalTitle">' +
                '<div class="miles-modal-head">' +
                    '<h4 id="milesModalTitle">New support ticket</h4>' +
                    '<button id="milesModalClose" type="button" aria-label="Close">' + iconMarkup('close') + '</button>' +
                '</div>' +
                '<div id="milesModalContent"></div>' +
            '</div>' +
        '</div>' +

        '<div class="miles-lightbox" id="milesLightbox" role="dialog" aria-modal="true" aria-label="Image preview">' +
            '<button class="lb-close" id="milesLightboxClose" aria-label="Close">' + iconMarkup('close') + '</button>' +
            '<img id="milesLightboxImg" src="" alt="">' +
            '<a class="lb-open-original" id="milesLightboxOpen" href="#" target="_blank" rel="noopener noreferrer">Open original</a>' +
        '</div>';
    }

    // ── Formatting / compression / helpers (unchanged) ────
    function _linkify(escapedText) {
        return escapedText.replace(/(https?:\/\/[^\s<]+)/gi, function (m) {
            var clean = m.replace(/[.,;:!?)]+$/, '');
            var tail = m.slice(clean.length);
            return '<a href="' + clean + '" target="_blank" rel="noopener noreferrer">' + clean + '</a>' + tail;
        });
    }
    function _formatMessageWithLinks(text) { return _linkify(escapeHtml(text || '')); }

    function _renderAttachment(a) {
        var isImg = String(a.mime || '').indexOf('image/') === 0;
        var url = escapeHtml(a.url);
        var name = escapeHtml(a.name || 'attachment');
        var size = a.size != null ? escapeHtml(formatFileSize(a.size)) : '';
        if (isImg) {
            // Add a thumbnail transform if it's a Cloudinary URL and not a blob
            if (url.indexOf('res.cloudinary.com') !== -1 && url.indexOf('/upload/') !== -1 && url.indexOf('blob:') === -1) {
                url = url.replace('/upload/', '/upload/w_600,q_auto,f_auto/');
            }
            return '<div class="miles-attachment" data-att-url="' + escapeHtml(a.url) + '" data-att-name="' + name + '" data-att-mime="' + escapeHtml(a.mime || 'image/*') + '" data-att-img="1" tabindex="0" role="button">' +
                '<img src="' + url + '" alt="' + name + '" loading="lazy" decoding="async">' +
            '</div>';
        }
        return '<div class="miles-attachment" data-att-url="' + escapeHtml(a.url) + '" data-att-name="' + name + '" data-att-mime="' + escapeHtml(a.mime || '') + '" data-att-img="0" tabindex="0" role="button">' +
            '<div class="attachment-info file-only">' +
                iconMarkup(fileIconForMime(a.mime)) +
                '<span class="name">' + name + '</span>' +
                (size ? '<span class="size">' + size + '</span>' : '') +
            '</div>' +
        '</div>';
    }

    function buildMessageHtml(m) {
        var senderRaw = String(m.sender_type || '').toLowerCase();
        var cls = (senderRaw === 'user' || senderRaw === 'guest') ? 'user'
                : (senderRaw === 'system' ? 'system' : 'support');
        var t = parseIsoTimestamp(m.created_at);
        var time = isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        var attachments = normaliseAttachments(m);
        var hasAtt = attachments.length > 0;
        var bodyText = (m.message || '').trim();
        var suppressText = hasAtt && _isPlaceholderText(bodyText);
        var textHtml = suppressText ? '' : '<div class="miles-msg-text">' + _formatMessageWithLinks(bodyText) + '</div>';
        var attHtml = hasAtt ? attachments.map(_renderAttachment).join('') : '';
        var mediaOnly = hasAtt && suppressText && cls === 'user' ? ' media-only' : '';
        
        var statusIcon = '';
        if (cls === 'user') {
            if (m._status === 'sending') statusIcon = '<span class="msg-status sending" aria-label="Sending">' + iconMarkup('clock') + '</span>';
            else if (m._status === 'failed') statusIcon = '<button type="button" class="msg-status failed" data-retry="' + escapeHtml(String(m.id)) + '" aria-label="Retry sending">' + iconMarkup('error') + '</button>';
            else statusIcon = '<span class="msg-status sent" aria-label="Sent">' + iconMarkup('check') + '</span>';
        }

        return '<div class="miles-msg ' + cls + mediaOnly + (m._failed ? ' failed' : '') + '" data-msg-id="' + escapeHtml(String(m.id || '')) + '">' +
            textHtml + attHtml +
            '<div class="time">' + escapeHtml(time) + ' ' + statusIcon + '</div>' +
        '</div>';
    }

    function mergeMessages(existing, incoming) {
        var list = Array.isArray(existing) ? existing.slice() : [];
        var byId = {};
        var locals = [];
        
        function normText(t) { return _isPlaceholderText(t) ? '' : String(t||'').trim(); }
        
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (m && m.id != null) byId[String(m.id)] = m;
            if (m && typeof m.id === 'string' && m.id.indexOf('local-') === 0) locals.push(m);
        }
        
        var incomingArr = Array.isArray(incoming) ? incoming : [];
        for (var j = 0; j < incomingArr.length; j++) {
            var inc = incomingArr[j];
            if (!inc || inc.id == null) continue;
            var sid = String(inc.id);
            
            // 1. Existing ID: refresh details instead of ignore
            if (byId[sid]) {
                var ex = byId[sid];
                ex.created_at = ex.created_at || inc.created_at;
                if (ex._status !== 'sending' && Array.isArray(inc.attachments) && inc.attachments.length) {
                    ex.attachments = inc.attachments;
                }
                continue;
            }
            
            // 2. Local Match: try to reconcile optimistic messages
            var matchedLocal = null;
            if (String(inc.sender_type || '').toLowerCase() === 'user') {
                var incTime = parseIsoTimestamp(inc.created_at);
                var incText = normText(inc.message);
                var incAtt = Array.isArray(inc.attachments) ? inc.attachments.length : 0;
                
                for (var k = 0; k < locals.length; k++) {
                    var loc = locals[k];
                    // Do not skip based on _status here; a successfully sent message might still be local until poll catches up
                    var locTime = parseIsoTimestamp(loc.created_at);
                    if (!isFinite(incTime) || !isFinite(locTime)) continue;
                    if (Math.abs(incTime - locTime) > 2 * 60 * 1000) continue;
                    if (normText(loc.message) !== incText) continue;
                    var locAtt = Array.isArray(loc.attachments) ? loc.attachments.length : 0;
                    if (locAtt !== incAtt) continue;
                    matchedLocal = loc;
                    break;
                }
            }
            
            if (matchedLocal) {
                var idx = list.indexOf(matchedLocal);
                if (idx >= 0) list.splice(idx, 1);
                delete byId[String(matchedLocal.id)];
                var li = locals.indexOf(matchedLocal);
                if (li >= 0) locals.splice(li, 1);
                if (Array.isArray(matchedLocal.attachments)) {
                    for (var a = 0; a < matchedLocal.attachments.length; a++) {
                        var lu = matchedLocal.attachments[a] && matchedLocal.attachments[a].url;
                        if (lu && String(lu).indexOf('blob:') === 0) {
                            try { URL.revokeObjectURL(lu); } catch (e) {}
                        }
                    }
                }
            }
            list.push(inc);
            byId[sid] = inc;
        }
        list.sort(function (a, b) {
            var ta = parseIsoTimestamp(a && a.created_at);
            var tb = parseIsoTimestamp(b && b.created_at);
            if (!isFinite(ta) && !isFinite(tb)) return 0;
            if (!isFinite(ta)) return 1;
            if (!isFinite(tb)) return -1;
            return ta - tb;
        });
        return list;
    }

    function buildAttachmentFallback(infoEl, name, sizeText) {
        var wrap = document.createElement('div');
        wrap.className = 'attachment-info file-only';
        var iconSpan = document.createElement('span');
        iconSpan.className = 'miles-icon';
        iconSpan.setAttribute('aria-hidden', 'true');
        iconSpan.innerHTML = ICONS.file;
        wrap.appendChild(iconSpan);
        var nameSpan = document.createElement('span');
        nameSpan.className = 'name';
        nameSpan.textContent = name || 'attachment';
        wrap.appendChild(nameSpan);
        if (sizeText) {
            var sizeSpan = document.createElement('span');
            sizeSpan.className = 'size';
            sizeSpan.textContent = sizeText;
            wrap.appendChild(sizeSpan);
        }
        return wrap;
    }

    function handleAttachmentImgError(e) {
        var img = e.target;
        if (!img || img.tagName !== 'IMG') return;
        var parent = img.parentNode;
        if (!parent || !parent.classList || !parent.classList.contains('miles-attachment')) return;
        if (parent.getAttribute('data-att-img') === '0') return;
        parent.setAttribute('data-att-img', '0');
        var name = parent.getAttribute('data-att-name') || 'attachment';
        var sizeText = '';
        if (img.getAttribute('data-size')) sizeText = img.getAttribute('data-size');
        var fallback = buildAttachmentFallback(null, name, sizeText);
        try { parent.removeChild(img); } catch (err) {}
        parent.appendChild(fallback);
    }

    function compressImage(file) {
        return new Promise(function (resolve) {
            try {
                if (!file || typeof file !== 'object') { resolve(file); return; }
                var type = String(file.type || '').toLowerCase();
                if (type !== 'image/jpeg' && type !== 'image/png') { resolve(file); return; }
                if (!file.size || file.size <= 300 * 1024) { resolve(file); return; }
                var img = new Image();
                var url = null;
                try { url = URL.createObjectURL(file); } catch (e) { resolve(file); return; }
                var settled = false;
                function done(out) {
                    if (settled) return;
                    settled = true;
                    try { if (url) URL.revokeObjectURL(url); } catch (e) {}
                    resolve(out);
                }
                img.onload = function () {
                    try {
                        var longest = Math.max(img.naturalWidth || img.width || 0, img.naturalHeight || img.height || 0);
                        if (!longest || longest <= 1600) { done(file); return; }
                        var ratio = 1600 / longest;
                        var outW = Math.max(1, Math.round((img.naturalWidth || img.width) * ratio));
                        var outH = Math.max(1, Math.round((img.naturalHeight || img.height) * ratio));
                        var canvas = document.createElement('canvas');
                        canvas.width = outW;
                        canvas.height = outH;
                        var ctx = canvas.getContext('2d');
                        if (!ctx) { done(file); return; }
                        ctx.drawImage(img, 0, 0, outW, outH);
                        var isJpeg = type === 'image/jpeg';
                        var quality = 0.82;
                        function finishBlob(blob, converted) {
                            if (!blob) { done(file); return; }
                            if (!isJpeg && !converted) { done(file); return; }
                            if (!isJpeg && converted && blob.size >= file.size) { done(file); return; }
                            var newName = file.name || 'image';
                            if (converted && /\.png$/i.test(newName)) newName = newName.replace(/\.png$/i, '.jpg');
                            try {
                                var out = new File([blob], newName, { type: 'image/jpeg', lastModified: Date.now() });
                                done(out);
                            } catch (e) {
                                try {
                                    var b = new Blob([blob], { type: 'image/jpeg' });
                                    b.name = newName; b.type = 'image/jpeg'; b.lastModified = Date.now(); b.size = blob.size;
                                    done(b);
                                } catch (e2) { done(file); }
                            }
                        }
                        if (isJpeg) {
                            canvas.toBlob(function (blob) { finishBlob(blob, false); }, 'image/jpeg', quality);
                        } else {
                            canvas.toBlob(function (jpegBlob) {
                                if (!jpegBlob) { done(file); return; }
                                canvas.toBlob(function (pngBlob) {
                                    if (pngBlob && pngBlob.size < jpegBlob.size) {
                                        try {
                                            var out = new File([pngBlob], file.name, { type: 'image/png', lastModified: Date.now() });
                                            done(out);
                                        } catch (e) { done(file); }
                                    } else { finishBlob(jpegBlob, true); }
                                }, 'image/png');
                            }, 'image/jpeg', quality);
                        }
                    } catch (e) { done(file); }
                };
                img.onerror = function () { done(file); };
                img.src = url;
            } catch (e) { resolve(file); }
        });
    }

    // ── Widget ─────────────────────────────────────────────
    function MilesWidget(cfg) {
        this.apiUrl = (cfg && cfg.apiUrl) || CONFIG.API_URL;
        this.root = null;
        this.categories = DEFAULT_CATEGORIES.slice();
        this.categoryMap = new Map();
        this.userId = null;
        this.token = null;
        this.username = 'there';
        this.isAuthenticated = false;
        this.isAuthPage = IS_AUTH_PAGE;
        this.conversations = [];
        this.unreadByTicket = new Map();
        this.currentConversationId = null;
        this.currentGuestTicketNumber = null;
        this.knownMessageIds = new Set();
        this.messages = [];
        this._isLoadingMessages = false;
        this._lastConvSearch = '';
        this._guestCanReply = false;
        this._guestLastCount = 0;
        this._guestLastStatus = null;
        this.isOpen = false;
        this.currentTab = 'home';
        this.isProcessing = false;
        this.pendingFiles = [];
        this.previousUnread = 0;
        this.previousUnreadForTitle = 0;
        this._preparingFiles = false;
        this.pollTimer = null;
        this.unreadTimer = null;
        this.guestTimer = null;
        this.pollInFlight = false;
        this.unreadInFlight = false;
        this.guestInFlight = false;
        this.socketAttached = false;
        this.hasUserInteracted = false;
        this.audioCtx = null;
        this.muted = this._readMutePref();
        this.isDragging = false;
        this.hasMoved = false;
        this._suppressClick = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.dragOffsetX = 0;
        this.dragOffsetY = 0;
        this._modalTriggerEl = null;
        this._lastBreakpoint = null;
        this._resizeTimer = null;
        this._vvRaf = 0;
        this._panelFocusBefore = null;
        this._imageErrorBound = false;
        this._guestImageErrorBound = false;
        var self = this;
        this._boundGlobalKeydown = function (e) { self.onGlobalKeydown(e); };
        this._boundFirstInteraction = function () { self.hasUserInteracted = true; };
        this._boundConvClick = function (e) { self._handleConvClick(e); };
        this._boundHeaderClick = function (e) {
            var btn = e.target.closest('button[data-action="close-ticket"]');
            if (btn) { e.preventDefault(); self.closeCurrentTicket(); }
        };
        this._boundResize = function () { self.onWindowResize(); };
        this._boundVisibility = function () { self.onVisibilityChange(); };
        this._boundOnline = function () { self.onNetworkChange(); };
        this._boundSessionReady = function () { self.onSessionChange(); };
        this._boundSessionLogout = function () { self.onSessionChange(); };
        this.init();
    }

    MilesWidget.prototype._isRealPhone = function () {
        try {
            var sw = (window.screen && (window.screen.width || window.screen.availWidth)) || 9999;
            return sw <= 600;
        } catch (e) { return false; }
    };
    MilesWidget.prototype._applyRealPhoneClass = function () {
        try {
            var html = document.documentElement;
            if (this._isRealPhone()) html.classList.add('miles-real-phone');
            else html.classList.remove('miles-real-phone');
        } catch (e) {}
    };

    MilesWidget.prototype.init = function () {
        var self = this;
        this.getUserData();
        this._applyRealPhoneClass();
        this.injectStyles();
        this.injectMarkup();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () { self.setupWidget(); }, { once: true });
        } else {
            this.setupWidget();
        }
        window.addEventListener('resize', function () {
            self._applyRealPhoneClass();
            if (self.isOpen) {
                self.positionPanelToLauncher();
                self.syncMobileViewport();
            }
        }, { passive: true });
    };

    MilesWidget.prototype._readMutePref = function () {
        try { return localStorage.getItem(CONFIG.STORAGE_PREFIX + 'muted') === '1'; } catch (e) { return false; }
    };
    MilesWidget.prototype.getUserData = function () {
        if (this.isAuthPage) {
            this.userId = null; this.token = null; this.username = 'there'; this.isAuthenticated = false; return;
        }
        var u = (typeof window.getUser === 'function') ? (window.getUser() || {}) : {};
        var t = (typeof window.getAccessToken === 'function') ? window.getAccessToken() : null;
        this.userId = u.id || null;
        this.token = t || null;
        this.username = u.username || 'there';
        this.isAuthenticated = !!(this.userId && t && !isJwtExpired(t));
    };

    MilesWidget.prototype.resolveAuthAsync = function () {
        var self = this;
        if (this.isAuthPage || this.isAuthenticated) return Promise.resolve();
        if (typeof window.checkUserSession !== 'function') return Promise.resolve();
        return Promise.resolve(window.checkUserSession())
            .then(function (ok) {
                if (ok === false) return;
                self.getUserData();
                if (self.isAuthenticated) {
                    self.setGreeting();
                    self.loadConversations().catch(function () {});
                    self.refreshUnreadMap().catch(function () {});
                }
            }).catch(function () {});
    };

    MilesWidget.prototype.injectStyles = function () {
        if (document.getElementById('miles-widget-styles')) return;
        var el = document.createElement('style');
        el.id = 'miles-widget-styles';
        el.textContent = WIDGET_STYLES;
        document.head.appendChild(el);
    };
    MilesWidget.prototype.injectMarkup = function () {
        if (document.getElementById('miles-widget-root')) { this.root = document.getElementById('miles-widget-root'); return; }
        var root = document.createElement('div');
        root.id = 'miles-widget-root';
        root.innerHTML = buildTemplate();
        document.body.appendChild(root);
        this.root = root;
    };

    MilesWidget.prototype.loadCategories = function () {
        var self = this;
        return fetch(this.apiUrl + '/categories', { headers: { 'X-Request-Id': newRequestId() } })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (data && data.success && Array.isArray(data.data)) {
                    self.categories = data.data.map(function (c) {
                        return { key: c.key || c.slug, label: c.label || c.name || (c.key || c.slug), icon: c.icon || c.key || c.slug };
                    });
                    self.categoryMap = new Map(self.categories.map(function (c) { return [c.key, c]; }));
                }
            })
            .catch(function () { self.categories = []; self.categoryMap = new Map(); })
            .then(function () { self.renderSuggestions(); });
    };

    MilesWidget.prototype.renderSuggestions = function () {
        var sg = this.root && this.root.querySelector('#milesSuggestions');
        if (!sg) return;
        if (!this.categories.length) { sg.innerHTML = ''; return; }
        sg.innerHTML = this.categories.slice(0, 9).map(function (c) {
            return '<button class="miles-suggestion" type="button" data-category="' + escapeHtml(c.key) + '">' +
                   iconMarkup(c.icon || c.key) + ' ' + escapeHtml(c.label) + '</button>';
        }).join('');
    };

    MilesWidget.prototype.setupWidget = function () {
        var self = this;
        if (!this.root) return;
        if (this.root.dataset.milesReady === '1') return;
        this.root.dataset.milesReady = '1';
        var q = function (sel) { return self.root.querySelector(sel); };

        this.launcher = q('#miles-launcher');
        this.panel = q('#miles-panel');
        this.badge = q('#milesBadge');
        this.tabBadge = q('#milesTabBadge');
        this.offlineBanner = q('#milesOfflineBanner');
        this.convItems = q('#milesConvItems');
        this.convSearch = q('#milesConvSearch');
        this.convCount = q('#milesConvCount');
        this.newTicketBtn = q('#milesNewTicketBtn');
        this.messageView = q('#milesMessageView');
        this.messageList = q('#milesMessageList');
        this.msgSubject = q('#milesMsgSubject');
        this.msgStatus = q('#milesMsgStatus');
        this.msgBack = q('#milesMsgBack');
        this.msgHeaderActions = q('#milesMsgHeaderActions');
        this.ratingSlot = q('#milesRatingSlot');
        this.input = q('#milesInput');
        this.sendBtn = q('#milesSendBtn');
        this.sendStatus = q('#milesSendStatus');
        this.inputArea = q('#milesInputArea');
        this.emojiBtn = q('#milesEmojiBtn');
        this.emojiPicker = q('#milesEmojiPicker');
        this.helpList = q('#milesHelpList');
        this.helpSearch = q('#milesHelpSearch');
        this.articleView = q('#milesArticleView');
        this.articleTitle = q('#milesArticleTitle');
        this.articleSub = q('#milesArticleSub');
        this.articleBody = q('#milesArticleBody');
        this.articleBack = q('#milesArticleBack');
        this.statusText = q('#milesStatusText');
        this.statusDot = q('#milesStatusDot');
        this.availabilityText = q('#milesAvailabilityText');
        this.greeting = q('#milesGreeting');
        this.muteBtn = q('#milesMuteBtn');
        this.fileInput = q('#milesFileInput');
        this.attachBtn = q('#milesAttachBtn');
        this.filePreview = q('#milesFilePreview');
        this.modalOverlay = q('#milesModalOverlay');
        this.modalContent = q('#milesModalContent');
        this.modalClose = q('#milesModalClose');
        this.lightbox = q('#milesLightbox');
        this.lightboxImg = q('#milesLightboxImg');
        this.lightboxOpen = q('#milesLightboxOpen');
        this.lightboxClose = q('#milesLightboxClose');

        if (!this.launcher || !this.panel) return;
        this._setPanelInert(true);
        this.setGreeting();
        this.setupLauncherClick();
        this.setupEventListeners();
        this.setupPasteAndDrop();
        this.renderHelpArticles(HELP_ARTICLES);
        this.applyMuteUI();
        this.initializePosition();
        this.setupEmojiPicker();
        this.updateOfflineBanner();
        this.updateLauncherAriaLabel();

        window.addEventListener('resize', this._boundResize);
        window.addEventListener('orientationchange', this._boundResize);
        document.addEventListener('visibilitychange', this._boundVisibility);
        window.addEventListener('online', this._boundOnline);
        window.addEventListener('offline', this._boundOnline);
        window.addEventListener('session:ready', this._boundSessionReady);
        window.addEventListener('session:logout', this._boundSessionLogout);
        window.addEventListener('session:expired', this._boundSessionLogout);

        var afterCats = function () {
            self.fetchStatus();
            self.attachSocket();
            self.resolveAuthAsync().then(function () {
                if (self.isAuthenticated && !self.isAuthPage) {
                    self.loadConversations();
                    self.refreshUnreadMap();
                    self.startUnreadPolling();
                } else {
                    self.restoreGuestTicket();
                }
                self.switchTab('home');
                self.checkHashAndQuery();
            });
            window.MilesWidget = self;
            if (location.hash === '#support' || /[?&]support=1\b/.test(location.search)) {
                setTimeout(function () { self.checkHashAndQuery(); }, 100);
            }
        };
        Promise.resolve(this.loadCategories()).then(afterCats, afterCats);
    };

    MilesWidget.prototype.checkHashAndQuery = function () {
        var wantsOpen = location.hash === '#support' || /[?&]support=1\b/.test(location.search);
        if (!wantsOpen) return;
        this.open();
    };

    MilesWidget.prototype._setPanelInert = function (inertOn) {
        if (!this.panel) return;
        try {
            if (inertOn) {
                var active = document.activeElement;
                if (active && this.panel.contains(active)) {
                    if (this.launcher && typeof this.launcher.focus === 'function') this.launcher.focus({ preventScroll: true });
                    else if (typeof active.blur === 'function') active.blur();
                }
                this.panel.setAttribute('inert', '');
                this.panel.setAttribute('aria-hidden', 'true');
            } else {
                this.panel.removeAttribute('inert');
                this.panel.setAttribute('aria-hidden', 'false');
            }
        } catch (e) { this.panel.setAttribute('aria-hidden', inertOn ? 'true' : 'false'); }
    };

    MilesWidget.prototype.positionPanelToLauncher = function () {
        if (!this.panel || !this.launcher) return;
        if (this.panel.classList.contains('minimized')) return;
        if (this.isMobileFullScreenMode()) {
            this.panel.style.left = ''; this.panel.style.top = ''; this.panel.style.right = ''; this.panel.style.bottom = ''; this.panel.style.height = '';
            return;
        }
        this.panel.style.height = '';
        var lr = this.launcher.getBoundingClientRect();
        if (lr.width === 0) lr = { left: window.innerWidth - 90, top: window.innerHeight - 90, width: 62, height: 62, bottom: window.innerHeight - 24 };
        
        var pw = this.panel.offsetWidth || CONFIG.DESKTOP_PANEL_W;
        var ph = this.panel.offsetHeight || CONFIG.DESKTOP_PANEL_H;
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var margin = CONFIG.VIEWPORT_MARGIN;
        var gap = CONFIG.PANEL_GAP;
        var maxH = vh - 2 * margin;
        if (ph > maxH) ph = maxH;

        var spaceAbove = Math.max(0, lr.top - gap - margin);
        var spaceBelow = Math.max(0, vh - lr.bottom - gap - margin);

        var top;
        if (spaceAbove >= ph) top = lr.top - gap - ph;
        else if (spaceBelow >= ph) top = lr.bottom + gap;
        else if (spaceAbove >= spaceBelow) { top = margin; ph = Math.max(240, spaceAbove); }
        else { top = lr.bottom + gap; ph = Math.max(240, spaceBelow); }
        
        if (top < margin) top = margin;
        if (top + ph > vh - margin) ph = vh - margin - top;
        if (ph < 240) ph = 240;

        this.panel.style.height = ph + 'px';

        var centerX = lr.left + (lr.width / 2);
        var left = centerX - (pw / 2);
        if (left < margin) left = margin;
        if (left + pw > vw - margin) left = vw - pw - margin;
        if (left < margin) left = margin;

        this.panel.style.left = left + 'px';
        this.panel.style.top = top + 'px';
        this.panel.style.right = 'auto';
        this.panel.style.bottom = 'auto';
    };

    MilesWidget.prototype.isMobileFullScreenMode = function () {
        if (!this._isRealPhone()) return false;
        if (window.innerWidth <= CONFIG.MOBILE_BREAKPOINT) return true;
        try { if (window.matchMedia && window.matchMedia('(max-height:500px) and (max-width:900px) and (pointer:coarse)').matches) return true; }
        catch (e) {}
        return false;
    };

    MilesWidget.prototype.syncMobileViewport = function () {
        if (!this.panel || !this.isOpen) return;
        if (!this.isMobileFullScreenMode()) {
            this.panel.style.top = ''; this.panel.style.height = ''; this.panel.style.removeProperty('--miles-vh');
            return;
        }
        var vv = window.visualViewport;
        if (!vv) return;
        var h = Math.round(vv.height);
        this.panel.style.setProperty('--miles-vh', h + 'px');
        this.panel.style.top = Math.round(vv.offsetTop) + 'px';
        this.panel.style.height = h + 'px';
    };

    MilesWidget.prototype.setupLauncherClick = function () {
        var self = this;
        if (!this.launcher) return;
        this.launcher.addEventListener('click', function (e) {
            if (self._suppressClick) { self._suppressClick = false; return; }
            if (typeof e.button === 'number' && e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            self.toggle();
        });
        this.launcher.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        this.launcher.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); self.toggle(); }
        });
        
        // Dragging logic
        var DRAG_THRESHOLD_PX = 6; var HOLD_TO_DRAG_MS = 220;
        var holdTimer = null; var startLeft = 0, startTop = 0;
        var isTouchLike = false; var canDrag = false; var movedPastThreshold = false;

        function clearHold() { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } }

        function onDown(e) {
            isTouchLike = (e.pointerType === 'touch' || e.pointerType === 'pen');
            if (!isTouchLike && e.button !== 2) return; // Only right click on desktop, long press on mobile
            
            canDrag = true; movedPastThreshold = false; self._suppressClick = false;
            var rect = self.launcher.getBoundingClientRect();
            startLeft = rect.left; startTop = rect.top;
            self.dragStartX = e.clientX; self.dragStartY = e.clientY;
            self.dragOffsetX = e.clientX - rect.left; self.dragOffsetY = e.clientY - rect.top;
            self.hasMoved = false; self.isDragging = false;
            try { self.launcher.setPointerCapture(e.pointerId); } catch (err) {}
            clearHold();
            if (isTouchLike) {
                canDrag = false; // wait for hold
                holdTimer = setTimeout(function () { canDrag = true; try { if (navigator.vibrate) navigator.vibrate(8); } catch (err) {} }, HOLD_TO_DRAG_MS);
            } else {
                e.preventDefault();
            }
        }
        function onMove(e) {
            if (!canDrag) return;
            var dx = e.clientX - self.dragStartX; var dy = e.clientY - self.dragStartY;
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (!self.isDragging && dist < DRAG_THRESHOLD_PX) return;
            if (!self.isDragging) { self.isDragging = true; self.hasMoved = true; movedPastThreshold = true; self.launcher.classList.add('dragging'); }
            var newLeft = e.clientX - self.dragOffsetX; var newTop = e.clientY - self.dragOffsetY;
            var w = self.launcher.offsetWidth || CONFIG.LAUNCHER_DESKTOP; var h = self.launcher.offsetHeight || CONFIG.LAUNCHER_DESKTOP;
            newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - w)); newTop = Math.max(0, Math.min(newTop, window.innerHeight - h));
            self.launcher.style.left = newLeft + 'px'; self.launcher.style.top = newTop + 'px';
            self.launcher.style.right = 'auto'; self.launcher.style.bottom = 'auto';
            if (self.isOpen) self.positionPanelToLauncher();
            e.preventDefault();
        }
        function onUp(e) {
            clearHold(); try { self.launcher.releasePointerCapture(e.pointerId); } catch (err) {}
            self.launcher.classList.remove('dragging');
            if (movedPastThreshold) {
                self._suppressClick = true;
                var left = self.launcher.style.left; var top = self.launcher.style.top;
                if (left && top) { var keys = self.getPositionStorageKeys(self.getBreakpoint()); safeStorageSet(localStorage, keys.left, left); safeStorageSet(localStorage, keys.top, top); }
                setTimeout(function () { self._suppressClick = false; }, 400);
            }
            self.isDragging = false; self.hasMoved = false; canDrag = false;
        }
        function onCancel(e) {
            clearHold(); try { self.launcher.releasePointerCapture(e.pointerId); } catch (err) {}
            self.launcher.classList.remove('dragging');
            self.launcher.style.left = startLeft + 'px'; self.launcher.style.top = startTop + 'px';
            self.launcher.style.right = 'auto'; self.launcher.style.bottom = 'auto';
            self.isDragging = false; self.hasMoved = false; canDrag = false;
        }
        this.launcher.addEventListener('pointerdown', onDown);
        this.launcher.addEventListener('pointermove', onMove);
        this.launcher.addEventListener('pointerup', onUp);
        this.launcher.addEventListener('pointercancel', onCancel);
    };

    MilesWidget.prototype.setGreeting = function () {
        var h = new Date().getHours();
        var g = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
        if (this.greeting) this.greeting.textContent = this.isAuthenticated ? (g + ', ' + this.username + '!') : (g + '!');
    };
    MilesWidget.prototype.fetchStatus = function () {
        var self = this;
        fetch(this.apiUrl + '/status', { headers: { 'X-Request-Id': newRequestId() } })
            .then(function (r) { return r.json(); })
            .then(function (data) { if (self.availabilityText) self.availabilityText.textContent = (data && data.data && data.data.response_expectation) || 'We usually respond within a few hours.'; })
            .catch(function () { if (self.availabilityText) self.availabilityText.textContent = 'We usually respond within a few hours.'; });
    };

    MilesWidget.prototype.setupEventListeners = function () {
        var self = this;
        var q = function (sel) { return self.root.querySelector(sel); };
        var closeBtn = q('#milesClose'); if (closeBtn) closeBtn.addEventListener('click', function () { self.close(); });
        var minBtn = q('#milesMinimize'); if (minBtn) minBtn.addEventListener('click', function () { self.minimize(); });
        if (this.muteBtn) this.muteBtn.addEventListener('click', function () { self.toggleMute(); });

        var tabs = this.root.querySelector('.miles-tabs');
        if (tabs) tabs.addEventListener('click', function (e) { var btn = e.target.closest('.tab'); if (btn) self.switchTab(btn.dataset.tab); });

        if (this.sendBtn) this.sendBtn.addEventListener('click', function (e) { e.preventDefault(); self.sendMessage(); });

        if (this.input) {
            this.input.addEventListener('keydown', function (e) {
                var coarse = false;
                try { coarse = window.matchMedia && window.matchMedia('(pointer:coarse)').matches; } catch (err) {}
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); self.sendMessage(); }
            });
            this.input.addEventListener('input', function () {
                this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px';
                if (this.scrollHeight > 120) this.style.overflowY = 'auto'; else this.style.overflowY = 'hidden';
            });
        }
        if (this.attachBtn && this.fileInput) {
            this.attachBtn.addEventListener('click', function (e) { e.preventDefault(); self.fileInput.click(); });
            this.fileInput.addEventListener('change', function (e) { self.handleFiles(e.target.files); e.target.value = ''; });
        }
        if (this.msgBack) this.msgBack.addEventListener('click', function () { self.closeMessageView(); });
        if (this.articleBack) this.articleBack.addEventListener('click', function () { self.closeArticleView(); });

        var sg = q('#milesSuggestions');
        if (sg) sg.addEventListener('click', function (e) { var el = e.target.closest('.miles-suggestion'); if (el) self.requestHumanSupport({ category: el.dataset.category }); });

        var contactBtn = q('#milesContactSupport'); if (contactBtn) contactBtn.addEventListener('click', function () { self.requestHumanSupport(); });
        var emptyBtn = q('#milesEmptyStartChat'); if (emptyBtn) emptyBtn.addEventListener('click', function () { self.requestHumanSupport(); });
        if (this.newTicketBtn) this.newTicketBtn.addEventListener('click', function () { self.requestHumanSupport(); });

        if (this.helpSearch) this.helpSearch.addEventListener('input', function () {
            var query = self.helpSearch.value.trim().toLowerCase();
            if (!query) { self.renderHelpArticles(HELP_ARTICLES); return; }
            self.renderHelpArticles(HELP_ARTICLES.filter(function (a) {
                return a.title.toLowerCase().indexOf(query) !== -1 || a.summary.toLowerCase().indexOf(query) !== -1 || a.content.toLowerCase().indexOf(query) !== -1;
            }));
        });

        var searchDebounce = null;
        if (this.convSearch) this.convSearch.addEventListener('input', function () {
            clearTimeout(searchDebounce); searchDebounce = setTimeout(function () {
                self._lastConvSearch = self.convSearch.value.trim().toLowerCase(); self.filterConversations(self._lastConvSearch);
            }, 150);
        });

        if (this.convItems) this.convItems.addEventListener('click', this._boundConvClick);
        if (this.msgHeaderActions) this.msgHeaderActions.addEventListener('click', this._boundHeaderClick);
        if (this.modalClose) this.modalClose.addEventListener('click', function () { self.closeNewTicketModal(); });
        if (this.modalOverlay) this.modalOverlay.addEventListener('click', function (e) { if (e.target === self.modalOverlay) self.closeNewTicketModal(); });
        if (this.lightboxClose) this.lightboxClose.addEventListener('click', function () { self.closeLightbox(); });
        if (this.lightbox) this.lightbox.addEventListener('click', function (e) { if (e.target === self.lightbox) self.closeLightbox(); });

        document.addEventListener('keydown', this._boundGlobalKeydown);
        ['pointerdown', 'keydown'].forEach(function (evt) { document.addEventListener(evt, self._boundFirstInteraction, { once: true, passive: true }); });

        if (this.messageList) {
            this.messageList.addEventListener('click', function (e) {
                var retryBtn = e.target.closest('[data-retry]');
                if (retryBtn) { e.preventDefault(); var id = retryBtn.getAttribute('data-retry'); if (id) self.retryMessage(id); return; }
                
                var attEl = e.target.closest('.miles-attachment[data-att-url]');
                if (attEl) { e.preventDefault(); self.openLightbox(attEl.dataset.attUrl, attEl.dataset.attName); return; }
            });
        }

        if (!this._imageErrorBound && this.messageList) {
            this._imageErrorBound = true;
            this.messageList.addEventListener('error', handleAttachmentImgError, true);
        }
    };

    MilesWidget.prototype.setupPasteAndDrop = function () {
        var self = this;
        if (this.input) {
            this.input.addEventListener('paste', function (e) {
                var items = (e.clipboardData && e.clipboardData.items) || [];
                var files = [];
                for (var i = 0; i < items.length; i++) {
                    if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {
                        var f = items[i].getAsFile(); if (f) files.push(f);
                    }
                }
                if (files.length) { e.preventDefault(); self.handleFiles(files); }
            });
        }
        if (!this.messageView) return;
        var overlay = document.createElement('div');
        overlay.className = 'miles-drop-overlay';
        overlay.innerHTML = iconMarkup('paperclip') + '<p>Drop files to attach</p>';
        this.messageView.appendChild(overlay);
        this.dropOverlay = overlay;
        var counter = 0;
        this.messageView.addEventListener('dragenter', function (e) {
            if (!e.dataTransfer || !e.dataTransfer.types) return;
            if (Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') === -1) return;
            e.preventDefault(); counter++; overlay.classList.add('show');
        });
        this.messageView.addEventListener('dragover', function (e) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {} });
        this.messageView.addEventListener('dragleave', function () { counter--; if (counter <= 0) { counter = 0; overlay.classList.remove('show'); } });
        this.messageView.addEventListener('drop', function (e) {
            e.preventDefault(); counter = 0; overlay.classList.remove('show');
            var files = (e.dataTransfer && e.dataTransfer.files) || []; if (files.length) self.handleFiles(files);
        });
    };

    MilesWidget.prototype.setupEmojiPicker = function () {
        var self = this;
        var emojis = ['😀','😂','🥰','😍','🤔','😎','😭','👍','🙏','🔥','🎉','💡','❤️','✨','😊','👋','✅','⚠️','📌','💬'];
        if (this.emojiPicker) {
            this.emojiPicker.innerHTML = emojis.map(function(emoji) { return '<button type="button" data-emoji="' + emoji + '">' + emoji + '</button>'; }).join('');
            if (!this.emojiPicker._delegated) {
                this.emojiPicker._delegated = true;
                this.emojiPicker.addEventListener('click', function(e) { var btn = e.target.closest('button[data-emoji]'); if (btn) self.insertEmoji(btn.dataset.emoji); });
            }
        }
        if (this.emojiBtn && this.emojiPicker && !this.emojiBtn._delegated) {
            this.emojiBtn._delegated = true;
            this.emojiBtn.addEventListener('click', function(e) { e.preventDefault(); self.emojiPicker.classList.toggle('open'); });
            document.addEventListener('click', function(e) {
                if (self.emojiPicker && self.emojiPicker.classList.contains('open') && !self.emojiPicker.contains(e.target) && !self.emojiBtn.contains(e.target)) {
                    self.emojiPicker.classList.remove('open');
                }
            });
        }
    };

    MilesWidget.prototype.insertEmoji = function (emoji) {
        if (!this.input) return;
        var startPos = this.input.selectionStart; var endPos = this.input.selectionEnd; var text = this.input.value;
        this.input.value = text.substring(0, startPos) + emoji + text.substring(endPos, text.length);
        this.input.selectionStart = this.input.selectionEnd = startPos + emoji.length;
        this.input.focus(); this.input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    MilesWidget.prototype._handleConvClick = function (e) {
        var item = e.target.closest('.miles-conv-item'); if (!item) return;
        var id = item.dataset.id; if (!id) return;
        this.convItems.querySelectorAll('.miles-conv-item').forEach(function (el) { el.classList.remove('active'); });
        item.classList.add('active');
        this.selectConversation(id);
    };

    MilesWidget.prototype.onGlobalKeydown = function (e) {
        if (e.key !== 'Escape') return;
        if (this.lightbox && this.lightbox.classList.contains('open')) { this.closeLightbox(); return; }
        if (this.modalOverlay && this.modalOverlay.classList.contains('open')) { this.closeNewTicketModal(); return; }
        if (this.emojiPicker && this.emojiPicker.classList.contains('open')) { this.emojiPicker.classList.remove('open'); return; }
        if (this.isOpen) this.close();
    };

    MilesWidget.prototype._authFetch = function (path, opts) {
        opts = opts || {}; var url = this.apiUrl + path; var method = opts.method || 'GET'; var body = opts.body; var headers = {};
        if (opts.headers) for (var k in opts.headers) headers[k] = opts.headers[k];
        var isForm = (typeof FormData !== 'undefined') && (body instanceof FormData);
        if (!isForm && body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        if (!headers['X-Request-Id']) headers['X-Request-Id'] = newRequestId();

        if (typeof window.userFetch === 'function' && this.isAuthenticated && !this.isAuthPage) {
            return window.userFetch(url, { method: method, body: body, headers: headers });
        }
        var token = this.getToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;
        return fetch(url, { method: method, body: body, headers: headers, credentials: 'same-origin' });
    };

    MilesWidget.prototype.request = function (path, opts) {
        return this._authFetch(path, opts || {}).then(function (res) {
            return res.text().then(function (t) {
                var data = {}; try { data = t ? JSON.parse(t) : {}; } catch (e) {}
                if (res.status === 401) { var e1 = new Error('SESSION_EXPIRED'); e1.status = 401; e1.code = data.code; throw e1; }
                if (res.status === 403) { var e2 = new Error(data.error || 'ACCESS_DENIED'); e2.status = 403; e2.code = data.code; throw e2; }
                if (res.status === 429) { var e3 = new Error(data.error || 'RATE_LIMITED'); e3.status = 429; e3.code = data.code; throw e3; }
                if (res.status >= 500) { var e4 = new Error(data.error || 'SERVER_ERROR'); e4.status = res.status; e4.code = data.code; throw e4; }
                if (!res.ok) { var e5 = new Error(data.error || 'REQUEST_FAILED'); e5.status = res.status; e5.code = data.code; e5.field = data.field; throw e5; }
                return data;
            });
        }, function () { var en = new Error('NETWORK_ERROR'); en.code = 'NETWORK_ERROR'; throw en; });
    };

    MilesWidget.prototype.getToken = function () {
        if (this.token && !isJwtExpired(this.token)) return this.token;
        if (typeof window.getAccessToken === 'function') {
            var t = window.getAccessToken();
            if (t && !isJwtExpired(t)) {
                this.token = t;
                if (!this.userId && typeof window.getUser === 'function') {
                    var u = window.getUser() || {}; this.userId = u.id || null; this.username = u.username || this.username || 'there';
                }
                return t;
            }
        }
        return null;
    };

    MilesWidget.prototype.shouldPoll = function () {
        if (!this.isOpen || document.hidden || !navigator.onLine || this.currentTab !== 'chats' || this.isAuthPage || !this.isAuthenticated) return false;
        if (this.socketAttached) return false;
        return true;
    };

    MilesWidget.prototype.startPollingIfNeeded = function () {
        var self = this;
        if (this.pollTimer || !this.shouldPoll()) return;
        var baseInterval = this.currentConversationId ? CONFIG.POLL_INTERVAL_ACTIVE : CONFIG.POLL_INTERVAL_CHATS;
        var backoff = 1;
        var schedule = function () {
            if (!self.shouldPoll()) { self.stopPolling(); return; }
            var wait = Math.min(baseInterval * backoff, CONFIG.POLL_BACKOFF_MAX);
            self.pollTimer = setTimeout(function () {
                self.pollTimer = null;
                self.pollMessages().then(function (ok) {
                    backoff = ok === false ? Math.min(backoff * 2, 8) : 1;
                    schedule();
                }, function () { backoff = Math.min(backoff * 2, 8); schedule(); });
            }, wait);
        };
        schedule();
    };

    MilesWidget.prototype.stopPolling = function () { if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; } };

    MilesWidget.prototype.pollMessages = function () {
        var self = this;
        if (!this.currentConversationId || this.pollInFlight) return Promise.resolve(true);
        if (!this.shouldPoll()) { this.stopPolling(); return Promise.resolve(true); }
        this.pollInFlight = true;
        
        var latest = this.messages[this.messages.length - 1];
        var after = latest ? latest.created_at : null;
        var url = '/tickets/' + this.currentConversationId + '?messages_limit=50';
        if (after) url = '/tickets/' + this.currentConversationId + '/messages?after=' + encodeURIComponent(after);
        
        return this.request(url)
            .then(function (data) {
                if (data.success && data.data) {
                    var incoming = data.data.messages || data.data;
                    if (Array.isArray(incoming) && incoming.length) {
                        var fresh = incoming.filter(function (m) { return !self.knownMessageIds.has(m.id); });
                        if (fresh.length) {
                            var newSupport = false;
                            fresh.forEach(function(m) {
                                var mapped = Object.assign({}, m, { sender_type: m.sender_type === 'admin' ? 'support' : m.sender_type });
                                self.knownMessageIds.add(m.id);
                                if (mapped.sender_type === 'support') newSupport = true;
                            });
                            self.messages = mergeMessages(self.messages, fresh.map(function (m) {
                                return Object.assign({}, m, { sender_type: m.sender_type === 'admin' ? 'support' : m.sender_type });
                            }));
                            self.renderMessages();
                            if (newSupport) { self.playNotification(); self.markMessagesRead(); }
                        }
                    }
                }
                return true;
            })
            .catch(function () { return false; })
            .then(function (ok) { self.pollInFlight = false; return ok; });
    };

    MilesWidget.prototype.attachSocket = function () {
        if (this.socketAttached) return;
        var sock = window.__MILES_SOCKET__ || window.socket;
        if (!sock || typeof sock.on !== 'function') return;
        var self = this;
        this.socketAttached = true;
        
        // When disconnected, fall back to polling
        sock.on('disconnect', function() {
            self.socketAttached = false;
            self.startPollingIfNeeded();
        });
        sock.on('connect', function() {
            self.socketAttached = true;
            self.stopPolling();
        });

        sock.on('support:message:new', function (payload) {
            if (payload && payload.ticketId === self.currentConversationId) {
                self.markMessagesRead();
                self.pollMessages(); // Fetch just the new messages
            } else {
                self.refreshUnreadMap();
            }
        });
        
        sock.on('support:ticket:updated', function (payload) {
            if (payload && payload.ticketId === self.currentConversationId) {
                var idx = -1;
                for (var i = 0; i < self.conversations.length; i++) {
                    if (self.conversations[i].id === payload.ticketId) { idx = i; break; }
                }
                if (idx !== -1 && payload.status) {
                    self.conversations[idx].status = payload.status;
                    self.renderMessageHeader(self.conversations[idx]);
                    self.renderConversationList();
                }
            }
        });
        
        sock.on('support:unread:updated', function(payload) {
            if (payload && typeof payload.unreadCount === 'number') {
                self.previousUnread = payload.unreadCount;
                self.updateBadges(payload.unreadCount);
            }
        });
    };

    MilesWidget.prototype._guestStorageKey = function (ticketNumber) { return CONFIG.GUEST_TICKET_PREFIX + ticketNumber; };
    MilesWidget.prototype._saveGuestTicket = function (ticketNumber, token) {
        var payload = JSON.stringify({ ticketNumber: ticketNumber, token: token, ts: Date.now() });
        safeStorageSet(sessionStorage, this._guestStorageKey(ticketNumber), payload);
        safeStorageSet(sessionStorage, CONFIG.GUEST_TICKET_PREFIX + 'current', ticketNumber);
    };
    MilesWidget.prototype._loadGuestTicket = function (ticketNumber) {
        var raw = safeStorageGet(sessionStorage, this._guestStorageKey(ticketNumber));
        if (!raw) return null;
        try { var d = JSON.parse(raw); if (d && d.token) return d; } catch (e) {}
        return null;
    };
    MilesWidget.prototype._loadCurrentGuestTicket = function () {
        var num = safeStorageGet(sessionStorage, CONFIG.GUEST_TICKET_PREFIX + 'current');
        if (!num) return null;
        return this._loadGuestTicket(num);
    };
    MilesWidget.prototype._clearGuestTicket = function (ticketNumber) {
        safeStorageRemove(sessionStorage, this._guestStorageKey(ticketNumber));
        var current = safeStorageGet(sessionStorage, CONFIG.GUEST_TICKET_PREFIX + 'current');
        if (current === ticketNumber) safeStorageRemove(sessionStorage, CONFIG.GUEST_TICKET_PREFIX + 'current');
    };
    MilesWidget.prototype._saveGuestDraft = function (draft) { try { safeStorageSet(sessionStorage, CONFIG.GUEST_DRAFT_KEY, JSON.stringify(draft)); } catch (e) {} };
    MilesWidget.prototype._loadGuestDraft = function () { try { var raw = safeStorageGet(sessionStorage, CONFIG.GUEST_DRAFT_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } };
    MilesWidget.prototype._clearGuestDraft = function () { safeStorageRemove(sessionStorage, CONFIG.GUEST_DRAFT_KEY); };

    MilesWidget.prototype.restoreGuestTicket = function () {
        if (this.isAuthenticated && !this.isAuthPage) return;
        if (IS_ADMIN_PAGE) return;
        var stored = this._loadCurrentGuestTicket();
        if (!stored) { this.showGuestIntro(); return; }
        var self = this;
        this.currentGuestTicketNumber = stored.ticketNumber;
        fetch(this.apiUrl + '/public/tickets/' + encodeURIComponent(stored.ticketNumber), {
            headers: { 'X-Guest-Token': stored.token, 'X-Request-Id': newRequestId() }
        })
            .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; }); })
            .then(function (r) {
                if (!r.res.ok || !r.data.success) { self._clearGuestTicket(stored.ticketNumber); self.currentGuestTicketNumber = null; self.showGuestIntro(); return; }
                self._guestLastCount = (r.data.data.messages || []).length;
                self._guestLastStatus = r.data.data.status;
                self.renderGuestTicket(r.data.data);
                if (!self.guestTimer) self.startGuestPolling();
            })
            .catch(function () { self.showGuestIntro(); });
    };

    MilesWidget.prototype.startGuestPolling = function () {
        var self = this;
        if (this.guestTimer || !this.isOpen || !this.currentGuestTicketNumber || document.hidden || !navigator.onLine) return;
        var schedule = function () {
            if (self.guestTimer) return;
            self.guestTimer = setTimeout(function () {
                self.guestTimer = null;
                self.pollGuestTicket().then(function () { schedule(); }, function () { schedule(); });
            }, CONFIG.POLL_INTERVAL_GUEST);
        };
        schedule();
    };
    MilesWidget.prototype.stopGuestPolling = function () { if (this.guestTimer) { clearTimeout(this.guestTimer); this.guestTimer = null; } };

    MilesWidget.prototype.pollGuestTicket = function () {
        var self = this;
        if (this.guestInFlight || !this.currentGuestTicketNumber) return Promise.resolve();
        var stored = this._loadGuestTicket(this.currentGuestTicketNumber);
        if (!stored || !stored.token) return Promise.resolve();
        this.guestInFlight = true;
        return fetch(this.apiUrl + '/public/tickets/' + encodeURIComponent(this.currentGuestTicketNumber), {
            headers: { 'X-Guest-Token': stored.token, 'X-Request-Id': newRequestId() }
        })
            .then(function (res) { return res.json().catch(function () { return {}; }); })
            .then(function (data) {
                if (data && data.success && data.data) {
                    var count = (data.data.messages || []).length; var status = data.data.status;
                    if (count !== self._guestLastCount || status !== self._guestLastStatus) {
                        self._guestLastCount = count; self._guestLastStatus = status; self.renderGuestTicket(data.data);
                    }
                }
            })
            .catch(function () {})
            .then(function () { self.guestInFlight = false; });
    };

    MilesWidget.prototype.showGuestIntro = function () {
        if (!this.messageList || !this.messageView) return;
        var self = this;
        this.messageView.classList.add('open', 'guest-mode');
        this.messageList.innerHTML = '<div class="miles-msg-empty">' + iconMarkup('info') + '<h4>Contact support</h4><p style="font-size:13px;color:var(--miles-text-dim);margin-top:4px;">Send us a message and we\'ll reply to your email. No account required.</p><button class="btn-primary" id="milesGuestStartBtn" type="button" style="margin-top:14px;padding:10px 22px;background:var(--miles-primary);color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;">Write a message</button></div>';
        var b = this.messageList.querySelector('#milesGuestStartBtn');
        if (b) b.addEventListener('click', function () { self.openGuestForm(); });
        if (!this._guestImageErrorBound && this.messageList) { this._guestImageErrorBound = true; this.messageList.addEventListener('error', handleAttachmentImgError, true); }
    };

    MilesWidget.prototype.openGuestForm = function (prefill) {
        if (!this.messageList || !this.messageView) return;
        var self = this;
        prefill = prefill || {};
        var draft = this._loadGuestDraft() || {};
        var name = prefill.name || draft.name || ''; var email = prefill.email || draft.email || ''; var subject = prefill.subject || draft.subject || ''; var message = prefill.message || draft.message || ''; var category = prefill.category || draft.category || '';

        this.messageView.classList.add('open', 'guest-mode');
        var options = this.categories.length ? this.categories.map(function (c) { var sel = c.key === category ? ' selected' : ''; return '<option value="' + escapeHtml(c.key) + '"' + sel + '>' + escapeHtml(c.label) + '</option>'; }).join('') : '<option value="other">Other</option>';
        this.messageList.innerHTML =
            '<form class="miles-guest-form" id="milesGuestForm" novalidate style="padding:14px;">' +
                '<div class="miles-form-note">Tell us what you need help with. We\'ll email you a secure link to track the conversation.</div>' +
                '<div><label>Name</label><input name="name" type="text" required maxlength="120" autocomplete="name" value="' + escapeHtml(name) + '"></div>' +
                '<div><label>Email</label><input name="email" type="email" required maxlength="180" autocomplete="email" value="' + escapeHtml(email) + '"></div>' +
                '<div><label>Category</label><select name="category">' + options + '</select></div>' +
                '<div><label>Subject</label><input name="subject" type="text" required maxlength="150" value="' + escapeHtml(subject) + '"></div>' +
                '<div><label>Message</label><textarea name="message" required maxlength="' + CONFIG.MAX_MESSAGE_LENGTH + '">' + escapeHtml(message) + '</textarea></div>' +
                '<input type="text" name="website" class="miles-honeypot" tabindex="-1" autocomplete="off" aria-hidden="true">' +
                '<div class="miles-form-error" role="alert"></div>' +
                '<button class="submit-btn" type="submit">Send to support</button>' +
            '</form>';
        var form = this.messageList.querySelector('#milesGuestForm');
        if (form) {
            form.addEventListener('submit', function (e) { self.submitGuestForm(e); });
            ['name','email','subject','message'].forEach(function (field) { var el = form.querySelector('[name="' + field + '"]'); if (el) el.addEventListener('input', function () { self._saveGuestDraft(self._readGuestForm(form)); }); });
        }
    };

    MilesWidget.prototype._readGuestForm = function (form) {
        return { name: form.name.value.trim(), email: form.email.value.trim(), category: form.category.value, subject: form.subject.value.trim(), message: form.message.value.trim() };
    };
    MilesWidget.prototype._guestErrorMessage = function (body) {
        var code = String(body && body.code || '').toUpperCase();
        switch (code) {
            case 'INVALID_CATEGORY': return 'Please choose a valid category.';
            case 'INVALID_EMAIL': return 'Please enter a valid email address.';
            case 'MISSING_FIELDS':
                if (body && body.field === 'name') return 'Please enter your name.'; if (body && body.field === 'email') return 'Please enter your email.';
                if (body && body.field === 'subject') return 'Please enter a subject.'; if (body && body.field === 'message') return 'Please enter your message.';
                if (body && body.field === 'category') return 'Please choose a category.'; return 'Please fill in all required fields.';
            case 'RATE_LIMITED_IP': return 'Too many requests from this network. Please try again later.';
            case 'RATE_LIMITED_EMAIL': return 'Too many requests from this email. Please try again later.';
            case 'SERVER_ERROR': return 'Something went wrong on our side. Please try again in a moment.';
            default: return scrubProviders((body && body.error) || 'Could not send. Please try again.');
        }
    };

    MilesWidget.prototype.submitGuestForm = function (e) {
        e.preventDefault();
        var form = e.target; var err = form.querySelector('.miles-form-error'); var btn = form.querySelector('.submit-btn'); err.textContent = '';
        var draft = this._readGuestForm(form);
        if (!draft.name) { err.textContent = 'Please enter your name.'; form.name.focus(); return; }
        if (!draft.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email)) { err.textContent = 'Please enter a valid email address.'; form.email.focus(); return; }
        if (!draft.subject) { err.textContent = 'Please enter a subject.'; form.subject.focus(); return; }
        if (!draft.message) { err.textContent = 'Please enter your message.'; form.message.focus(); return; }
        this._saveGuestDraft(draft);
        var honeypot = form.querySelector('[name="website"]');
        if (honeypot && honeypot.value) { this._clearGuestDraft(); this.showGuestSuccess(draft.email, { ticket_number: '' }); return; }
        btn.disabled = true; btn.textContent = 'Sending…';
        var self = this;
        fetch(this.apiUrl + '/public/tickets', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': newRequestId() },
            body: JSON.stringify({ name: draft.name, email: draft.email, category: draft.category, subject: draft.subject, message: draft.message })
        })
        .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; }); })
        .then(function (r) {
            if (!r.res.ok || !r.data.success) { err.textContent = self._guestErrorMessage(r.data); btn.disabled = false; btn.textContent = 'Send to support'; return; }
            var d = r.data.data || {};
            if (d.ticket_number && d.access_token) { self._saveGuestTicket(d.ticket_number, d.access_token); self.currentGuestTicketNumber = d.ticket_number; }
            self._clearGuestDraft(); self.showGuestSuccess(draft.email, d);
        })
        .catch(function () { err.textContent = 'Could not reach MilesSpace. Please try again.'; btn.disabled = false; btn.textContent = 'Send to support'; });
    };

    MilesWidget.prototype.showGuestSuccess = function (email, data) {
        if (!this.messageList) return;
        var self = this;
        this.messageView.classList.add('guest-mode');
        this.messageList.innerHTML = '<div class="miles-msg-empty">' + iconMarkup('info') + '<h4>Message sent</h4><p style="font-size:13px;color:var(--miles-text-dim);margin-top:6px;line-height:1.5;">We sent a secure link to <strong>' + escapeHtml(email) + '</strong> so you can view updates and reply.</p>' + (data && data.ticket_number ? '<p style="font-size:12.5px;color:var(--miles-text-dim);margin-top:10px">Reference: <strong>' + escapeHtml(data.ticket_number) + '</strong></p>' : '') + '<button class="btn-primary" id="milesGuestViewBtn" type="button" style="margin-top:16px;padding:10px 22px;background:var(--miles-primary);color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;">View ticket</button></div>';
        var b = this.messageList.querySelector('#milesGuestViewBtn');
        if (b) b.addEventListener('click', function () { self.restoreGuestTicket(); });
    };

    MilesWidget.prototype.renderGuestTicket = function (ticket) {
        if (!this.messageList || !this.messageView) return;
        var self = this;
        this.messageView.classList.add('open', 'guest-mode');

        var messages = Array.isArray(ticket.messages) ? ticket.messages.filter(isPublicMessage) : [];
        var agentReplied = hasAgentReply(messages);

        var header = '<div class="miles-msg-header"><button class="back-btn" id="milesGuestBack" aria-label="Back">' + iconMarkup('back') + '</button><div class="info"><div class="subject">' + escapeHtml(ticket.subject || 'Support ticket') + '</div><div class="status"><span class="dot ' + escapeHtml(ticket.status || 'open') + '"></span> ' + escapeHtml(STATUS_LABELS[ticket.status] || ticket.status) + ' <span>· ' + escapeHtml(ticket.ticket_number || '') + '</span></div></div></div>';
        var listHtml = '';
        if (!messages.length) {
            listHtml = '<div class="miles-msg-empty">' + iconMarkup('chat') + '<p>No messages yet</p></div>';
        } else {
            var lastDate = null; var parts = [];
            for (var i = 0; i < messages.length; i++) {
                var m = messages[i];
                if (m.created_at) { if (!lastDate || !isSameDay(lastDate, m.created_at)) { parts.push('<div class="miles-date-sep">' + escapeHtml(dateSeparator(m.created_at)) + '</div>'); lastDate = m.created_at; } }
                parts.push(buildMessageHtml(m));
            }
            listHtml = parts.join('');
        }
        var isClosed = ticket.status === 'closed';
        var composerOrWaiting;
        if (isClosed) {
            composerOrWaiting = '<div class="miles-waiting-panel"><div class="wp-icon">' + iconMarkup('info') + '</div><h4>This ticket is closed</h4><p>If you still need help, reply to the email we sent you or start a new message from the Home tab.</p></div>';
        } else if (!agentReplied) {
            composerOrWaiting = '<div class="miles-waiting-panel"><div class="wp-icon">' + iconMarkup('clock') + '</div><h4>We\'ve received your message</h4><p>An agent will reply to <strong>' + escapeHtml(ticket.contact_email || 'your email') + '</strong> shortly. You\'ll be able to reply here once the agent has responded.</p><div class="wp-hint">You can safely close this window. We\'ll email you when there\'s a response.</div></div>';
        } else {
            composerOrWaiting = '<div class="miles-input-area" id="guestInputArea"><div class="miles-emoji-picker" id="milesGEmojiPicker"></div><div class="miles-file-preview" id="milesGFilePreview"></div><div class="miles-composer-box"><textarea class="miles-composer-textarea" id="milesGInput" placeholder="Type your reply…" rows="1" maxlength="' + CONFIG.MESSAGE_MAX_LEN_SAFE + '"></textarea><div class="miles-composer-actions"><div class="miles-composer-left"><button class="miles-composer-btn" id="milesGAttachBtn" type="button" aria-label="Attach file">' + iconMarkup('paperclip') + '</button><button class="miles-composer-btn" id="milesGEmojiBtn" type="button" aria-label="Insert emoji">' + iconMarkup('smile') + '</button></div><button class="miles-send-btn" id="milesGSendBtn" type="button" aria-label="Send message">' + iconMarkup('send') + '</button></div></div><input class="attach-input" type="file" id="milesGFileInput" multiple accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/csv" tabindex="-1" aria-hidden="true" style="display:none"><div class="miles-send-status" id="milesGSendStatus"></div></div>';
        }

        this.messageList.innerHTML = header + '<div class="miles-message-list" id="milesMessageListInner">' + listHtml + '</div><div id="milesRatingSlot"></div>' + composerOrWaiting;
        this._guestCanReply = agentReplied && !isClosed;
        if (this._guestCanReply) this._rebindGuestMessageControls();
        
        var back = this.messageList.querySelector('#milesGuestBack');
        if (back) back.addEventListener('click', function () { self.currentGuestTicketNumber = self.currentGuestTicketNumber || null; self.messageView.classList.add('guest-mode'); self.showGuestIntro(); });
        var inner = this.messageList.querySelector('#milesMessageListInner');
        if (inner && !inner._imgErrorBound) { inner._imgErrorBound = true; inner.addEventListener('error', handleAttachmentImgError, true); }
    };

    MilesWidget.prototype._rebindGuestMessageControls = function () {
        var self = this;
        this.input = this.root.querySelector('#milesGInput'); this.sendBtn = this.root.querySelector('#milesGSendBtn');
        this.attachBtn = this.root.querySelector('#milesGAttachBtn'); this.fileInput = this.root.querySelector('#milesGFileInput');
        this.filePreview = this.root.querySelector('#milesGFilePreview'); this.sendStatus = this.root.querySelector('#milesGSendStatus');
        this.emojiBtn = this.root.querySelector('#milesGEmojiBtn'); this.emojiPicker = this.root.querySelector('#milesGEmojiPicker');

        if (this.input && !this.input._delegated) {
            this.input._delegated = true;
            this.input.addEventListener('keydown', function (e) { var coarse = false; try { coarse = window.matchMedia && window.matchMedia('(pointer:coarse)').matches; } catch (err) {} if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); self.sendGuestMessage(); } });
            this.input.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 120) + 'px'; if (this.scrollHeight > 120) this.style.overflowY = 'auto'; else this.style.overflowY = 'hidden'; });
        }
        if (this.sendBtn && !this.sendBtn._delegated) { this.sendBtn._delegated = true; this.sendBtn.addEventListener('click', function (e) { e.preventDefault(); self.sendGuestMessage(); }); }
        if (this.attachBtn && this.fileInput && !this.attachBtn._delegated) {
            this.attachBtn._delegated = true;
            this.attachBtn.addEventListener('click', function (e) { e.preventDefault(); self.fileInput.click(); });
            this.fileInput.addEventListener('change', function (e) { self.handleFiles(e.target.files); e.target.value = ''; });
        }
        this.setupEmojiPicker();
    };

    MilesWidget.prototype.sendGuestMessage = function () {
        var self = this;
        if (!this._guestCanReply || !this.currentGuestTicketNumber || this.isProcessing) return Promise.resolve();
        var stored = this._loadGuestTicket(this.currentGuestTicketNumber);
        if (!stored || !stored.token) { this.openGuestForm(); return Promise.resolve(); }
        var message = this.input ? this.input.value.trim() : '';
        if (!message && !this.pendingFiles.length) return Promise.resolve();

        this.isProcessing = true; if (this.input) this.input.disabled = true; if (this.sendBtn) this.sendBtn.disabled = true;
        if (this.sendStatus) { this.sendStatus.textContent = 'Sending…'; this.sendStatus.classList.remove('error'); }
        var filesToSend = this.pendingFiles.slice(); var idemKey = newRequestId();
        var form = new FormData(); form.append('message', message || ''); filesToSend.forEach(function (f) { form.append('attachments', f); });
        this.pendingFiles = []; if (this.filePreview) this.filePreview.innerHTML = ''; if (this.input) { this.input.value = ''; this.input.style.height = 'auto'; }

        fetch(this.apiUrl + '/public/tickets/' + encodeURIComponent(this.currentGuestTicketNumber) + '/messages', {
            method: 'POST', headers: { 'X-Guest-Token': stored.token, 'X-Request-Id': idemKey, 'Idempotency-Key': idemKey }, body: form
        })
        .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; }); })
        .then(function (r) {
            if (!r.res.ok || !r.data.success) {
                if (r.res.status === 401 || r.res.status === 403) {
                    self._clearGuestTicket(self.currentGuestTicketNumber); self.currentGuestTicketNumber = null;
                    if (self.sendStatus) { self.sendStatus.textContent = 'Your access has expired. Please start a new message.'; self.sendStatus.classList.add('error'); }
                    return;
                }
                var err = new Error(r.data.error || 'Could not send.'); err.code = r.data.code; throw err;
            }
            if (self.sendStatus) self.sendStatus.textContent = 'Sent';
            return self.restoreGuestTicket();
        })
        .catch(function (e) { if (self.sendStatus) { self.sendStatus.textContent = friendlyError(e); self.sendStatus.classList.add('error'); } })
        .then(function () { self.isProcessing = false; if (self.input) self.input.disabled = false; if (self.sendBtn) self.sendBtn.disabled = false; });
    };

    MilesWidget.prototype.renderHelpArticles = function (articles) {
        if (!this.helpList) return;
        if (!articles || !articles.length) { this.helpList.innerHTML = '<div class="miles-msg-empty"><p>No help articles found.</p></div>'; return; }
        var self = this; var grouped = {};
        articles.forEach(function (a) { if (!grouped[a.categoryKey]) grouped[a.categoryKey] = []; grouped[a.categoryKey].push(a); });
        var html = '';
        Object.keys(grouped).forEach(function (key) {
            var cat = self.categoryMap.get(key); var label = cat ? cat.label : key;
            html += '<div style="margin-bottom:14px;"><div style="font-size:11.5px;font-weight:700;color:var(--miles-text-dim);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">' + escapeHtml(label) + '</div>';
            grouped[key].forEach(function (a) {
                var idx = HELP_ARTICLES.indexOf(a); var ic = cat ? (cat.icon || cat.key) : 'other';
                html += '<button class="miles-help-item" type="button" data-article-index="' + idx + '"><span class="icon">' + iconMarkup(ic) + '</span><span class="text">' + escapeHtml(a.title) + '<span class="sub">' + escapeHtml(a.summary) + '</span></span></button>';
            });
            html += '</div>';
        });
        this.helpList.innerHTML = html;
        this.helpList.querySelectorAll('.miles-help-item').forEach(function (btn) {
            btn.addEventListener('click', function () { var idx = parseInt(btn.dataset.articleIndex, 10); var article = HELP_ARTICLES[idx]; if (article) self.showArticle(article); });
        });
    };

    MilesWidget.prototype.showArticle = function (article) {
        if (!this.articleView || !this.articleBody) return;
        var self = this;
        this.articleTitle.textContent = article.title; this.articleSub.textContent = article.readTime;
        this.articleBody.innerHTML = '<h2>' + escapeHtml(article.title) + '</h2><div class="meta">' + escapeHtml(article.readTime) + ' · Updated ' + escapeHtml(article.updatedAt) + '</div><div class="content">' + article.content + '</div><div class="article-actions"><button class="btn-support" id="milesArticleContactBtn" type="button">' + iconMarkup('chat') + ' Still need help?</button><button class="btn-back-help" id="milesArticleBackHelp" type="button">← Back to help</button></div>';
        var backBtn = this.articleBody.querySelector('#milesArticleBackHelp'); if (backBtn) backBtn.addEventListener('click', function () { self.closeArticleView(); });
        var contactBtn = this.articleBody.querySelector('#milesArticleContactBtn'); if (contactBtn) contactBtn.addEventListener('click', function () { self.closeArticleView(); self.requestHumanSupport({ category: article.categoryKey, subject: article.title }); });
        this.helpList.style.display = 'none'; this.helpSearch.style.display = 'none'; this.articleView.classList.add('open');
    };
    MilesWidget.prototype.closeArticleView = function () { this.articleView.classList.remove('open'); this.helpList.style.display = ''; this.helpSearch.style.display = ''; };

    MilesWidget.prototype.loadConversations = function () {
        var self = this;
        if (this.isAuthPage || !this.isAuthenticated || !this.getToken()) return Promise.resolve();
        return this.request('/tickets?limit=20')
            .then(function (data) { if (data.success && Array.isArray(data.data)) { self.conversations = data.data; self.renderConversationList(); } })
            .catch(function (e) { if (e.message === 'SESSION_EXPIRED') { self.isAuthenticated = false; self.restoreGuestTicket(); } });
    };

    MilesWidget.prototype.renderConversationList = function () {
        if (!this.convItems) return;
        var self = this;
        if (!this.isAuthenticated || this.isAuthPage) {
            this.convItems.innerHTML = '<div class="miles-conv-empty">' + iconMarkup('chat') + '<h4>Sign in for full support</h4><p style="font-size:13px;color:var(--miles-text-dim);margin-top:6px;"><a href="/login" style="color:var(--miles-primary);font-weight:700;">Sign in</a> to view your conversations.</p><button class="btn-primary" id="milesGuestStartFromList" type="button">Continue as guest</button></div>';
            var g = this.convItems.querySelector('#milesGuestStartFromList'); if (g) g.addEventListener('click', function () { self.openGuestForm(); });
            if (this.convCount) this.convCount.textContent = '0 chats';
            return;
        }
        if (!this.conversations.length) {
            this.convItems.innerHTML = '<div class="miles-conv-empty">' + iconMarkup('chat') + '<h4>No conversations</h4><p>Start a new conversation from the Home tab</p><button class="btn-primary" id="milesConvEmptyStart" type="button">Start a chat</button></div>';
            var b = this.convItems.querySelector('#milesConvEmptyStart'); if (b) b.addEventListener('click', function () { self.requestHumanSupport(); });
            if (this.convCount) this.convCount.textContent = '0 chats';
            return;
        }
        var sorted = this.conversations.slice().sort(function (a, b) { return new Date(b.last_message_at || b.created_at) - new Date(a.last_message_at || a.created_at); });
        this.convItems.innerHTML = sorted.map(function (conv) {
            var isActive = self.currentConversationId === conv.id;
            var unread = self.unreadByTicket.get(conv.id) || conv.unread_for_user || 0;
            var timeAgo = timeAgoLabel(conv.last_message_at || conv.created_at);
            var initials = (conv.subject || 'Chat').trim().charAt(0).toUpperCase() || '?';
            var cat = self.categoryMap.get(conv.category); var catLabel = cat ? cat.label : (conv.category || 'General');
            var statusKey = conv.status || 'open';
            return '<button class="miles-conv-item ' + (isActive ? 'active' : '') + '" data-id="' + escapeHtml(conv.id) + '" role="listitem"><div class="avatar">' + escapeHtml(initials) + '</div><div class="info"><div class="top"><span class="subject">' + escapeHtml(conv.subject || 'Conversation') + '</span><span class="time-ago">' + escapeHtml(timeAgo) + '</span></div><div class="preview">' + escapeHtml(catLabel) + '</div><div class="meta"><span class="status-dot ' + escapeHtml(statusKey) + '"></span><span>' + escapeHtml(STATUS_LABELS[statusKey] || statusKey) + '</span><span>· ' + escapeHtml(conv.ticket_number || '') + '</span></div></div>' + (unread > 0 ? '<span class="unread-badge">' + (unread > 99 ? '99+' : unread) + '</span>' : '') + '</button>';
        }).join('');
        if (this.convCount) this.convCount.textContent = this.conversations.length + ' chat' + (this.conversations.length === 1 ? '' : 's');
        if (this._lastConvSearch) this.filterConversations(this._lastConvSearch);
    };

    MilesWidget.prototype.filterConversations = function (query) {
        if (!this.convItems) return;
        this.convItems.querySelectorAll('.miles-conv-item').forEach(function (item) {
            item.style.display = (!query || item.textContent.toLowerCase().indexOf(query) !== -1) ? '' : 'none';
        });
    };

    MilesWidget.prototype.selectConversation = function (id) {
        if (this.currentConversationId === id && this.messageView.classList.contains('open')) return Promise.resolve();
        
        // --- CLEAR LOCAL STATE TO PREVENT CROSS-CONTAMINATION ---
        this.messages = [];
        this.knownMessageIds = new Set();
        
        this.currentConversationId = id;
        this.messageView.classList.add('open');
        this.messageView.classList.remove('guest-mode');
        var conv = null;
        for (var i = 0; i < this.conversations.length; i++) { if (this.conversations[i].id === id) { conv = this.conversations[i]; break; } }
        this.renderMessageHeader(conv);
        
        // Emit join room for socket
        var sock = window.__MILES_SOCKET__ || window.socket;
        if (sock && this.socketAttached) {
            try { sock.emit('support:ticket:join', { ticketId: id }); } catch(e) {}
        }

        var self = this;
        return this.loadMessages(id, { force: true }).then(function () {
            self.renderConversationList();
            self.startPollingIfNeeded();
            self.markMessagesRead();
        });
    };

    MilesWidget.prototype.renderMessageHeader = function (conv) {
        if (!conv) { this.msgSubject.textContent = 'Conversation'; return; }
        this.msgSubject.textContent = conv.subject || 'Conversation';
        var statusKey = conv.status || 'open';
        this.msgStatus.innerHTML = '<span class="dot ' + escapeHtml(statusKey) + '"></span> ' + escapeHtml(STATUS_LABELS[statusKey] || statusKey) + ' <span>· ' + escapeHtml(conv.ticket_number || '') + '</span>';
        var isClosed = statusKey === 'closed';
        if (this.input) this.input.disabled = isClosed; if (this.sendBtn) this.sendBtn.disabled = isClosed; if (this.attachBtn) this.attachBtn.style.display = isClosed ? 'none' : '';
        if (this.msgHeaderActions) {
            this.msgHeaderActions.innerHTML = '';
            if (statusKey !== 'closed' && statusKey !== 'resolved') {
                var b = document.createElement('button'); b.type = 'button'; b.dataset.action = 'close-ticket'; b.textContent = 'Close'; b.style.minHeight = '44px'; this.msgHeaderActions.appendChild(b);
            }
        }
        this.renderRatingIfNeeded(conv);
    };

    MilesWidget.prototype.renderRatingIfNeeded = function (conv) {
        if (!this.ratingSlot) return;
        var self = this;
        if (!conv || (conv.status !== 'resolved' && conv.status !== 'closed')) { this.ratingSlot.innerHTML = ''; return; }
        this.ratingSlot.innerHTML = '<div class="miles-rating-box"><h5>How was your support experience?</h5><div class="miles-rating-stars">' + [1,2,3,4,5].map(function (n) { return '<button type="button" data-star="' + n + '" aria-label="Rate ' + n + ' out of 5">' + iconMarkup('starOutline') + '</button>'; }).join('') + '</div><textarea placeholder="Optional comment…" maxlength="500"></textarea><button class="submit-rating" disabled>Submit</button></div>';
        var selected = 0; var stars = Array.prototype.slice.call(this.ratingSlot.querySelectorAll('[data-star]')); var submit = this.ratingSlot.querySelector('.submit-rating');
        function paint() { stars.forEach(function (s, i) { s.classList.toggle('active', i < selected); s.innerHTML = i < selected ? iconMarkup('star') : iconMarkup('starOutline'); }); }
        stars.forEach(function (s) { s.addEventListener('click', function () { selected = parseInt(s.dataset.star, 10); paint(); submit.disabled = selected === 0; }); });
        submit.addEventListener('click', function () {
            if (!selected) return;
            submit.disabled = true; submit.textContent = 'Submitting…';
            var commentEl = self.ratingSlot.querySelector('textarea');
            self.request('/tickets/' + conv.id + '/rating', { method: 'POST', body: JSON.stringify({ rating: selected, comment: (commentEl && commentEl.value.trim()) || undefined }) })
            .then(function () { self.ratingSlot.innerHTML = '<div class="miles-rating-box"><span class="miles-rating-done">Thanks for your feedback!</span></div>'; })
            .catch(function (err) {
                if (err.code === 'ALREADY_RATED') { self.ratingSlot.innerHTML = '<div class="miles-rating-box"><span class="miles-rating-done">You already rated this ticket.</span></div>'; }
                else { submit.disabled = false; submit.textContent = 'Submit'; }
            });
        });
    };

    MilesWidget.prototype.closeCurrentTicket = function () {
        var self = this;
        if (!this.currentConversationId) return Promise.resolve();
        var localConv = null;
        for (var i = 0; i < this.conversations.length; i++) { if (this.conversations[i].id === this.currentConversationId) { localConv = this.conversations[i]; break; } }
        if (localConv && localConv.status === 'closed') { this.renderMessageHeader(localConv); return Promise.resolve(); }
        return this.request('/tickets/' + this.currentConversationId + '/close', { method: 'POST' })
            .then(function () {
                for (var i = 0; i < self.conversations.length; i++) { if (self.conversations[i].id === self.currentConversationId) { self.conversations[i].status = 'closed'; self.renderMessageHeader(self.conversations[i]); break; } }
                self.renderConversationList();
            })
            .catch(function (e) {
                if (e && (e.code === 'TICKET_ALREADY_CLOSED' || e.status === 409)) {
                    for (var i = 0; i < self.conversations.length; i++) { if (self.conversations[i].id === self.currentConversationId) { self.conversations[i].status = 'closed'; self.renderMessageHeader(self.conversations[i]); break; } }
                    self.renderConversationList();
                }
            });
    };

    MilesWidget.prototype.closeMessageView = function () {
        // Emit leave room for socket
        var sock = window.__MILES_SOCKET__ || window.socket;
        if (sock && this.socketAttached && this.currentConversationId) {
            try { sock.emit('support:ticket:leave', { ticketId: this.currentConversationId }); } catch(e) {}
        }
        
        this.messageView.classList.remove('open');
        this.messageView.classList.remove('guest-mode');
        this.currentConversationId = null;
        this.stopPolling();
        this.stopGuestPolling();
        this.renderConversationList();
    };

    MilesWidget.prototype.loadMessages = function (ticketId, opts) {
        opts = opts || {};
        var self = this;
        if (!ticketId || this._isLoadingMessages) return Promise.resolve();
        this._isLoadingMessages = true;
        return this.request('/tickets/' + ticketId + '?messages_limit=50')
            .then(function (data) {
                if (data.success && data.data && data.data.messages) {
                    var incoming = data.data.messages.filter(function (m) { return m.is_internal !== true; }).map(function (m) {
                        var c = {}; for (var k in m) c[k] = m[k];
                        c.sender_type = m.sender_type === 'admin' ? 'support' : m.sender_type;
                        return c;
                    });
                    self.messages = mergeMessages(self.messages, incoming);
                    incoming.forEach(function (m) { self.knownMessageIds.add(m.id); });
                    self.renderMessages();
                }
            })
            .catch(function () {})
            .then(function () { self._isLoadingMessages = false; });
    };

    MilesWidget.prototype.renderMessages = function () {
        if (!this.messageList) return;
        var self = this;
        if (!this.messages.length) {
            this.messageList.innerHTML = '<div class="miles-msg-empty">' + iconMarkup('chat') + '<p>No messages yet</p></div>';
            return;
        }
        
        var lastDate = null; var parts = [];
        for (var i = 0; i < this.messages.length; i++) {
            var m = this.messages[i];
            if (m.created_at) { if (!lastDate || !isSameDay(lastDate, m.created_at)) { parts.push('<div class="miles-date-sep">' + escapeHtml(dateSeparator(m.created_at)) + '</div>'); lastDate = m.created_at; } }
            parts.push(buildMessageHtml(m));
        }
        
        var inner = this.messageList.querySelector('#milesMessageListInner') || this.messageList;
        inner.innerHTML = parts.join('');
        
        if (!this._imageErrorBound && inner) {
            this._imageErrorBound = true;
            inner.addEventListener('error', handleAttachmentImgError, true);
        }

        this.scrollToBottom();
    };

    MilesWidget.prototype._formatMessage = function (text) { return _formatMessageWithLinks(text); };
    
    MilesWidget.prototype.scrollToBottom = function () {
        if (!this.messageList) return;
        var list = this.messageList;
        var inner = list.querySelector('#milesMessageListInner') || list;
        requestAnimationFrame(function () { inner.scrollTop = inner.scrollHeight; });
    };

    MilesWidget.prototype.openLightbox = function (url, name) {
        if (!this.lightbox || !url) return;
        // Use original full res URL if possible by stripping transforms
        var fullUrl = url.replace('/upload/w_600,q_auto,f_auto/', '/upload/');
        this.lightboxImg.src = fullUrl; this.lightboxImg.alt = name || 'Image'; this.lightboxOpen.href = fullUrl;
        this.lightbox.classList.add('open'); this.lightboxClose.focus();
    };

    MilesWidget.prototype.closeLightbox = function () {
        if (!this.lightbox) return;
        this.lightbox.classList.remove('open'); this.lightboxImg.src = '';
    };

    MilesWidget.prototype.handleFiles = function (files) {
        var self = this;
        if (!files || !files.length) return Promise.resolve();
        var fileArray = []; for (var i = 0; i < files.length; i++) fileArray.push(files[i]);
        if (this._preparingFiles) return Promise.resolve();
        this._preparingFiles = true; this.setSendStatus('Preparing images…');

        return Promise.all(fileArray.map(function (f) { return compressImage(f); }))
            .then(function (processed) {
                var errors = []; var valid = [];
                for (var i = 0; i < processed.length; i++) {
                    var file = processed[i]; if (!file) continue;
                    if (file.size > CONFIG.MAX_FILE_SIZE) { errors.push(file.name + ' is too large.'); continue; }
                    if (CONFIG.ALLOWED_FILE_TYPES.indexOf(file.type) === -1) { errors.push(file.name + ' is not supported.'); continue; }
                    valid.push(file);
                }
                if (errors.length) { self.setSendStatus(errors.join(', '), true); setTimeout(function () { self.setSendStatus(''); }, 4000); }
                if (self.pendingFiles.length + valid.length > CONFIG.MAX_FILES_PER_MESSAGE) {
                    self.setSendStatus('Maximum ' + CONFIG.MAX_FILES_PER_MESSAGE + ' files.', true); setTimeout(function () { self.setSendStatus(''); }, 3000); return;
                }
                self.pendingFiles = self.pendingFiles.concat(valid); self.renderFilePreview();
                if (!errors.length) self.setSendStatus('');
            })
            .catch(function () { self.setSendStatus('Could not prepare some files.', true); setTimeout(function () { self.setSendStatus(''); }, 3000); })
            .then(function () { self._preparingFiles = false; });
    };

    MilesWidget.prototype.removePendingFile = function (index) {
        var removed = this.pendingFiles[index];
        if (removed && removed._previewUrl && removed._previewUrl.indexOf('blob:') === 0) { try { URL.revokeObjectURL(removed._previewUrl); } catch (e) {} }
        this.pendingFiles.splice(index, 1);
        this.renderFilePreview();
    };

    MilesWidget.prototype._buildPreviewUrl = function (file) {
        if (file._previewUrl) return file._previewUrl;
        try { if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') { var url = URL.createObjectURL(file); file._previewUrl = url; return url; } } catch (e) {}
        return '';
    };
    MilesWidget.prototype._buildDataUrl = function (file, cb) {
        try { var reader = new FileReader(); reader.onload = function () { cb(String(reader.result || '')); }; reader.onerror = function () { cb(''); }; reader.readAsDataURL(file); } catch (e) { cb(''); }
    };

    MilesWidget.prototype.renderFilePreview = function () {
        if (!this.filePreview) return;
        var self = this;
        if (!this.pendingFiles.length) { this.filePreview.innerHTML = ''; return; }
        this.filePreview.innerHTML = this.pendingFiles.map(function (file, index) {
            if (file.type.indexOf('image/') === 0) {
                var url = self._buildPreviewUrl(file);
                if (!url) {
                    self._buildDataUrl(file, function (dataUrl) { if (dataUrl) { file._previewUrl = dataUrl; self.renderFilePreview(); } });
                    return '<div class="file-item image-item" title="' + escapeHtml(file.name) + '"><div style="width:44px;height:44px;background:var(--miles-bg)"></div><button class="remove-file" type="button" data-index="' + index + '" aria-label="Remove">✕</button></div>';
                }
                return '<div class="file-item image-item" title="' + escapeHtml(file.name) + '"><img src="' + url + '" alt=""><button class="remove-file" type="button" data-index="' + index + '" aria-label="Remove">✕</button></div>';
            }
            return '<div class="file-item">' + iconMarkup(fileIconForMime(file.type)) + '<span class="file-name">' + escapeHtml(file.name) + '</span><span class="file-size">' + escapeHtml(formatFileSize(file.size)) + '</span><button class="remove-file" type="button" data-index="' + index + '" aria-label="Remove">✕</button></div>';
        }).join('');
        this.filePreview.querySelectorAll('.remove-file').forEach(function (btn) { btn.addEventListener('click', function () { self.removePendingFile(parseInt(btn.dataset.index, 10)); }); });
    };

    MilesWidget.prototype.setSendStatus = function (text, isError) {
        if (!this.sendStatus) return;
        this.sendStatus.textContent = text || '';
        this.sendStatus.classList.toggle('error', !!isError);
    };

    MilesWidget.prototype.sendMessage = function () {
        var self = this;
        if (!this.isAuthenticated || !this.getToken()) { this.openGuestForm(); return Promise.resolve(); }
        if (!this.currentConversationId) { var draft2 = this.input ? this.input.value.trim() : ''; this.openNewTicketModal(draft2 ? { message: draft2 } : {}); return Promise.resolve(); }
        var message = this.input.value.trim();
        if (!message && !this.pendingFiles.length) return Promise.resolve();
        if (this.isProcessing) return Promise.resolve();

        var ticketId = this.currentConversationId;
        this.isProcessing = true; this.input.disabled = true; if (this.sendBtn) this.sendBtn.disabled = true; this.setSendStatus('Sending…');

        var localId = 'local-' + Date.now();
        var idemKey = newRequestId();
        var filesToSend = this.pendingFiles.slice();

        var localAttachments = filesToSend.map(function (f) {
            var u = ''; try { u = URL.createObjectURL(f); } catch (e) { u = ''; }
            return { url: u, name: f.name, mime: f.type || '', size: f.size, _local: true };
        });

        var localMsg = { id: localId, sender_type: 'user', message: message, created_at: new Date().toISOString(), _status: 'sending', _idem: idemKey, attachments: localAttachments, _files: filesToSend };
        this.messages = mergeMessages(this.messages, [localMsg]);
        this.renderMessages();

        this.input.value = ''; this.input.style.height = 'auto'; this.pendingFiles = []; this.renderFilePreview();

        var form = new FormData();
        form.append('message', message || '');
        filesToSend.forEach(function (f) { form.append('attachments', f); });

        return this._authFetch('/tickets/' + ticketId + '/messages', {
            method: 'POST', body: form, headers: { 'X-Request-Id': idemKey, 'Idempotency-Key': idemKey }
        })
            .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; }); })
            .then(function (r) {
                if (!r.res.ok) { var e = new Error(r.data.error || 'Failed'); e.code = r.data.code; throw e; }
                
                var serverMsg = (r.data && r.data.data) || {};
                // Handle flat response shape (data = message row)
                if (serverMsg.message && !serverMsg.id) serverMsg = serverMsg.message;
                if (!serverMsg.id) throw new Error('Bad server response');
                
                var serverAtts = normaliseAttachments({ attachments: serverMsg.attachments });
                
                for (var i = 0; i < self.messages.length; i++) {
                    if (self.messages[i].id === localId) {
                        self.messages[i].id = serverMsg.id;
                        self.messages[i]._status = 'sent';
                        self.messages[i].created_at = serverMsg.created_at || self.messages[i].created_at;
                        
                        // Keep blob previews if server attachments have URLs, swap them out
                        if (serverAtts.length) {
                            if (Array.isArray(self.messages[i].attachments)) {
                                for (var a = 0; a < self.messages[i].attachments.length; a++) {
                                    var lu = self.messages[i].attachments[a] && self.messages[i].attachments[a].url;
                                    if (lu && String(lu).indexOf('blob:') === 0) { try { URL.revokeObjectURL(lu); } catch (e2) {} }
                                }
                            }
                            self.messages[i].attachments = serverAtts;
                            self.messages[i]._files = null;
                        }
                        break;
                    }
                }
                self.knownMessageIds.add(serverMsg.id);
                self.setSendStatus('Sent');
                self.renderMessages();
                return self.loadConversations();
            })
            .then(function () { setTimeout(function () { self.setSendStatus(''); }, 1500); })
            .catch(function (e) {
                for (var i = 0; i < self.messages.length; i++) {
                    if (self.messages[i].id === localId) { self.messages[i]._status = 'failed'; self.messages[i]._failed = true; break; }
                }
                self.renderMessages(); self.setSendStatus(friendlyError(e), true);
            })
            .then(function () { self.isProcessing = false; self.input.disabled = false; if (self.sendBtn) self.sendBtn.disabled = false; self.input.focus(); });
    };

    MilesWidget.prototype.retryMessage = function (localId) {
        var self = this;
        var msg = null;
        for (var i = 0; i < this.messages.length; i++) { if (this.messages[i].id === localId) { msg = this.messages[i]; break; } }
        if (!msg || msg._status !== 'failed') return;

        msg._status = 'sending'; msg._failed = false; this.renderMessages(); this.setSendStatus('Retrying…');

        var form = new FormData();
        form.append('message', msg.message || '');
        var files = msg._files || [];
        for (var f = 0; f < files.length; f++) form.append('attachments', files[f]);

        var idemKey = msg._idem || newRequestId(); // Reuse same idem key
        this._authFetch('/tickets/' + this.currentConversationId + '/messages', {
            method: 'POST', body: form, headers: { 'X-Request-Id': idemKey, 'Idempotency-Key': idemKey }
        })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (data && data.success && data.data) {
                msg._status = 'sent';
                msg.id = data.data.id;
                msg.created_at = data.data.created_at;
                self.knownMessageIds.add(data.data.id);
                self.setSendStatus('Sent'); setTimeout(function() { self.setSendStatus(''); }, 1500);
            } else {
                msg._status = 'failed'; msg._failed = true; self.setSendStatus('Failed', true);
            }
            self.renderMessages();
        })
        .catch(function () { msg._status = 'failed'; msg._failed = true; self.setSendStatus('Failed', true); self.renderMessages(); });
    };

    MilesWidget.prototype.openNewTicketModal = function (prefill) {
        if (!this.isAuthenticated || !this.getToken() || this.isAuthPage) { this.openGuestForm(prefill || {}); return; }
        if (!this.modalOverlay || this._ticketInFlight) return;
        prefill = prefill || {};
        var self = this; this._modalTriggerEl = document.activeElement;
        var options = this.categories.length ? this.categories.map(function (c) { return '<option value="' + escapeHtml(c.key) + '"' + (c.key === prefill.category ? ' selected' : '') + '>' + escapeHtml(c.label) + '</option>'; }).join('') : '<option value="other">Other</option>';
        this.modalContent.innerHTML = '<form id="milesTicketForm" novalidate><div class="miles-modal-body"><div><label>Category</label><select name="category">' + options + '</select></div><div><label>Subject</label><input name="subject" type="text" required maxlength="' + CONFIG.MAX_SUBJECT_LENGTH + '" value="' + escapeHtml(prefill.subject || '') + '" placeholder="Briefly describe your issue"></div><div><label>Message</label><textarea name="message" required maxlength="' + CONFIG.MAX_MESSAGE_LENGTH + '" placeholder="Tell us what is going on">' + escapeHtml(prefill.message || '') + '</textarea></div><div><label>Related reference (optional)</label><input name="reference" type="text" maxlength="80" value="' + escapeHtml(prefill.reference || '') + '" placeholder="Transaction or order reference"></div><div class="miles-modal-error" role="alert"></div></div><div class="miles-modal-foot"><button class="submit-ticket-btn" type="submit">Create ticket</button></div></form>';
        var form = this.modalContent.querySelector('#milesTicketForm'); form.addEventListener('submit', function (e) { self.submitNewTicketForm(e); });
        this.modalOverlay.classList.add('open');
        var isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
        if (!isTouch) { var subjectInput = form.querySelector('[name="subject"]'); requestAnimationFrame(function () { if (subjectInput) subjectInput.focus(); }); }
    };

    MilesWidget.prototype.closeNewTicketModal = function () {
        if (!this.modalOverlay) return;
        this.modalOverlay.classList.remove('open');
        if (this._modalTriggerEl && this._modalTriggerEl.focus) this._modalTriggerEl.focus();
    };

    MilesWidget.prototype.submitNewTicketForm = function (e) {
        e.preventDefault();
        if (this._ticketInFlight) return;
        var self = this; var form = e.target; var err = form.querySelector('.miles-modal-error'); var btn = form.querySelector('.submit-ticket-btn');
        var category = form.category.value; var subject = form.subject.value.trim(); var description = form.message.value.trim(); var reference = form.reference.value.trim();
        err.textContent = '';
        if (!subject) { err.textContent = 'Subject is required.'; form.subject.focus(); return; }
        if (!description) { err.textContent = 'Message is required.'; form.message.focus(); return; }
        btn.disabled = true; btn.textContent = 'Creating…'; this._ticketInFlight = true;
        var body = { category: category, subject: subject, description: description, priority: 'medium' };
        if (reference) body.related_reference = reference;
        var idemKey = newRequestId();
        this._authFetch('/tickets', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'X-Request-Id': idemKey, 'Idempotency-Key': idemKey } })
            .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; }); })
            .then(function (r) {
                if (!r.res.ok || !r.data.success) { var er = new Error(r.data.error || 'Could not create ticket.'); er.code = r.data.code; throw er; }
                var ticket = r.data.data;
                self.modalContent.innerHTML = '<div class="miles-modal-success">' + iconMarkup('info') + '<h5>Ticket ' + escapeHtml(ticket.ticket_number) + ' created</h5><p>We will respond in your conversation shortly.</p></div>';
                self.conversations.unshift(ticket); self.renderConversationList();
                setTimeout(function () { self.closeNewTicketModal(); self.switchTab('chats'); self.selectConversation(ticket.id); }, 900);
            })
            .catch(function (e2) { btn.disabled = false; btn.textContent = 'Create ticket'; err.textContent = friendlyError(e2); })
            .then(function () { self._ticketInFlight = false; });
    };

    MilesWidget.prototype.requestHumanSupport = function (opts) {
        opts = opts || {};
        if (this.isAuthenticated && !this.isAuthPage) {
            if (this.currentConversationId) { this.switchTab('chats'); if (this.input) this.input.focus(); }
            else { this.openNewTicketModal(opts); }
            return;
        }
        var stored = this._loadCurrentGuestTicket();
        if (stored) { this.restoreGuestTicket(); return; }
        this.openGuestForm(opts);
    };

    MilesWidget.prototype.toggleMute = function () { this.muted = !this.muted; safeStorageSet(localStorage, CONFIG.STORAGE_PREFIX + 'muted', this.muted ? '1' : '0'); this.applyMuteUI(); };
    MilesWidget.prototype.applyMuteUI = function () { if (!this.muteBtn) return; this.muteBtn.innerHTML = this.muted ? iconMarkup('bellOff') : iconMarkup('bell'); this.muteBtn.setAttribute('aria-pressed', String(this.muted)); this.muteBtn.title = this.muted ? 'Unmute' : 'Mute'; };

    MilesWidget.prototype.playNotification = function () {
        if (this.muted || !this.hasUserInteracted) return;
        try {
            if (!this.audioCtx) { var Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return; this.audioCtx = new Ctx(); }
            if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
            var ctx = this.audioCtx; var osc = ctx.createOscillator(); var gain = ctx.createGain();
            osc.type = 'sine'; osc.frequency.value = 720;
            gain.gain.setValueAtTime(0.0001, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
            osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.3);
        } catch (e) {}
    };

    MilesWidget.prototype.refreshUnreadMap = function () {
        var self = this;
        if (this.isAuthPage || !this.isAuthenticated || this.unreadInFlight) return Promise.resolve();
        this.unreadInFlight = true;
        return this.request('/unread')
            .then(function (data) {
                if (data.success && data.data) {
                    var map = new Map(); (data.data.tickets || []).forEach(function (t) { map.set(t.ticket_id, t.unread_count); });
                    self.unreadByTicket = map; var total = data.data.total_unread || 0;
                    if (total > self.previousUnread) self.playNotification();
                    self.previousUnread = total; self.previousUnreadForTitle = total;
                    self.updateBadges(total); self.updateDocumentTitle();
                }
            })
            .catch(function () {})
            .then(function () { self.unreadInFlight = false; });
    };

    MilesWidget.prototype.updateBadges = function (total) {
        var unreadTotal = (typeof total === 'number') ? total : (this.previousUnread || 0);
        if (this.badge) { this.badge.textContent = String(unreadTotal); this.badge.classList.toggle('show', unreadTotal > 0 && !this.isOpen); }
        if (this.tabBadge) { this.tabBadge.textContent = String(unreadTotal); this.tabBadge.classList.toggle('show', unreadTotal > 0); }
        this.updateLauncherAriaLabel();
    };

    MilesWidget.prototype.updateLauncherAriaLabel = function () {
        if (!this.launcher) return;
        var unread = this.previousUnread || 0; var base = this.isOpen ? 'Close support chat' : 'Open support chat';
        this.launcher.setAttribute('aria-label', unread > 0 ? (base + ' (' + unread + ' unread)') : base);
    };

    MilesWidget.prototype.updateDocumentTitle = function () {
        var base = document.documentElement.getAttribute('data-miles-title-base') || document.title;
        if (!document.documentElement.getAttribute('data-miles-title-base')) document.documentElement.setAttribute('data-miles-title-base', base);
        var stripped = base.replace(/^\(\d+\)\s*/, '');
        if (document.hidden && this.previousUnreadForTitle > 0) document.title = '(' + this.previousUnreadForTitle + ') ' + stripped;
        else document.title = stripped;
    };

    MilesWidget.prototype.startUnreadPolling = function () {
        var self = this;
        if (this.unreadTimer || this.isAuthPage || !this.isAuthenticated || document.hidden || !navigator.onLine) return;
        var schedule = function () {
            if (self.unreadTimer || document.hidden || !navigator.onLine) return;
            var wait = Math.round(CONFIG.POLL_INTERVAL_UNREAD * (1 + (Math.random() * 0.2 - 0.1)));
            self.unreadTimer = setTimeout(function () {
                self.unreadTimer = null;
                self.refreshUnreadMap().then(function () { if (!self.isOpen) schedule(); }, function () { if (!self.isOpen) schedule(); });
            }, wait);
        };
        schedule();
    };

    MilesWidget.prototype.stopUnreadPolling = function () { if (this.unreadTimer) { clearTimeout(this.unreadTimer); this.unreadTimer = null; } };

    MilesWidget.prototype.markMessagesRead = function () {
        var self = this;
        if (this.isAuthPage || !this.currentConversationId) return;
        this.unreadByTicket.set(this.currentConversationId, 0); this.renderConversationList();
        this.request('/tickets/' + this.currentConversationId + '/read', { method: 'POST' })
            .then(function () { self.refreshUnreadMap(); })
            .catch(function () {});
    };

    MilesWidget.prototype.switchTab = function (tabName) {
        this.currentTab = tabName;
        this.root.querySelectorAll('.miles-tabs .tab').forEach(function (tab) { var active = tab.dataset.tab === tabName; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); });
        this.root.querySelectorAll('.miles-tab-content').forEach(function (content) { content.classList.toggle('active', content.id === 'tab-' + tabName); });
        if (tabName === 'chats') {
            if (this.isAuthenticated && !this.isAuthPage) { this.loadConversations(); if (this.currentConversationId) this.loadMessages(this.currentConversationId); }
            else { this.restoreGuestTicket(); }
            this.startPollingIfNeeded();
        } else {
            this.stopPolling();
        }
    };

    MilesWidget.prototype.toggle = function () { if (this.isOpen) this.close(); else this.open(); };

    MilesWidget.prototype.open = function () {
        if (this.isOpen) return;
        this.isOpen = true;
        this.getUserData(); this.setGreeting();
        this._panelFocusBefore = document.activeElement;

        // Neutralize any stuck CSS animation and enforce visible state
        this.panel.style.animation = 'none';
        this.panel.style.opacity = '1';
        this.panel.style.transform = 'none';
        this.panel.style.visibility = 'visible';
        this.panel.style.pointerEvents = 'auto';

        this.panel.classList.add('open');
        this._setPanelInert(false);
        this.panel.setAttribute('aria-modal', this.isMobileFullScreenMode() ? 'true' : 'false');
        this.launcher.setAttribute('aria-expanded', 'true');
        
        try { this.root.classList.add('is-open'); } catch (e) {}

        if (this.isMobileFullScreenMode()) {
            document.documentElement.classList.add('miles-scroll-lock');
            this._scrollLockY = window.scrollY;
        }

        var self = this;
        requestAnimationFrame(function () {
            self.positionPanelToLauncher();
            self.syncMobileViewport();
            
            try {
                var pr = self.panel.getBoundingClientRect();
                var visible = pr.width > 0 && pr.height > 0 && pr.top < window.innerHeight && pr.bottom > 0 && pr.left < window.innerWidth && pr.right > 0;
                if (!visible) { self.applyDefaultLauncherPosition(self.getBreakpoint()); self.positionPanelToLauncher(); }
            } catch (e) {}

            var focusTarget = self.panel.querySelector('.miles-tab.active .tab, .miles-tab-content.active');
            if (focusTarget && typeof focusTarget.focus === 'function') { try { focusTarget.focus({ preventScroll: true }); } catch (e) {} }
        });

        this.updateBadges(this.previousUnread || 0);
        this.attachSocket();
        if (this.isAuthenticated && !this.isAuthPage) {
            this.loadConversations();
            this.refreshUnreadMap();
            if (this.currentConversationId) this.markMessagesRead();
        }
        requestAnimationFrame(function () { if (self.currentTab === 'chats' && self.input && !self.input.disabled) self.input.focus(); });
        this.startPollingIfNeeded();
        if (!this.isAuthenticated || this.isAuthPage) this.startGuestPolling();
        if (this.isAuthenticated && !this.isAuthPage) this.stopUnreadPolling();
    };

    MilesWidget.prototype.close = function () {
        if (!this.isOpen) return;
        this.isOpen = false;
        this._setPanelInert(true);
        this.panel.classList.remove('open');
        this.panel.style.animation = ''; this.panel.style.opacity = ''; this.panel.style.transform = ''; this.panel.style.visibility = ''; this.panel.style.pointerEvents = '';
        this.panel.setAttribute('aria-modal', 'false');
        this.launcher.setAttribute('aria-expanded', 'false');
        
        try { this.root.classList.remove('is-open'); } catch (e) {}

        this.stopPolling(); this.stopGuestPolling();
        if (document.documentElement.classList.contains('miles-scroll-lock')) {
            document.documentElement.classList.remove('miles-scroll-lock');
            if (typeof this._scrollLockY === 'number') { try { window.scrollTo(0, this._scrollLockY); } catch (e) {} this._scrollLockY = undefined; }
        }
        if (this.isAuthenticated && !this.isAuthPage) this.startUnreadPolling();
        this.updateBadges(this.previousUnread || 0);
        this.updateLauncherAriaLabel();
        if (this._panelFocusBefore && typeof this._panelFocusBefore.focus === 'function') { try { this._panelFocusBefore.focus({ preventScroll: true }); } catch (e) {} }
        else if (this.launcher && typeof this.launcher.focus === 'function') { try { this.launcher.focus({ preventScroll: true }); } catch (e) {} }
    };

    MilesWidget.prototype.minimize = function () {
        if (this.isMobileFullScreenMode()) { this.close(); return; }
        var minimized = this.panel.classList.toggle('minimized');
        if (minimized) {
            this.panel.style.height = '60px';
            var content = this.panel.querySelector('.miles-content'); var tabs = this.panel.querySelector('.miles-tabs');
            if (content) content.style.display = 'none'; if (tabs) tabs.style.display = 'none';
            this.stopPolling();
        } else {
            this.panel.style.height = '';
            var content2 = this.panel.querySelector('.miles-content'); var tabs2 = this.panel.querySelector('.miles-tabs');
            if (content2) content2.style.display = ''; if (tabs2) tabs2.style.display = '';
            this.startPollingIfNeeded();
        }
    };

    MilesWidget.prototype.onVisibilityChange = function () {
        var self = this;
        if (document.hidden) { this.stopPolling(); this.stopGuestPolling(); this.stopUnreadPolling(); }
        else {
            if (this.isAuthenticated && !this.isAuthPage) this.refreshUnreadMap().catch(function () {});
            if (this.isOpen && this.currentGuestTicketNumber) this.pollGuestTicket().catch(function () {});
            this.startPollingIfNeeded();
            if (this.isOpen && this.currentGuestTicketNumber) this.startGuestPolling();
            if (this.isAuthenticated && !this.isAuthPage) this.startUnreadPolling();
        }
        this.updateDocumentTitle();
    };

    MilesWidget.prototype.onNetworkChange = function () {
        var self = this;
        this.updateOfflineBanner();
        if (!navigator.onLine) { this.stopPolling(); this.stopGuestPolling(); this.stopUnreadPolling(); }
        else {
            if (this.isAuthenticated && !this.isAuthPage) this.refreshUnreadMap().catch(function () {});
            if (this.isOpen && this.currentGuestTicketNumber) this.pollGuestTicket().catch(function () {});
            this.startPollingIfNeeded();
            if (this.isOpen && this.currentGuestTicketNumber) this.startGuestPolling();
            if (this.isAuthenticated && !this.isAuthPage) this.startUnreadPolling();
        }
        this.updateSendButtonOfflineState();
    };

    MilesWidget.prototype.updateOfflineBanner = function () { if (!this.offlineBanner) return; this.offlineBanner.classList.toggle('show', !navigator.onLine); };
    MilesWidget.prototype.updateSendButtonOfflineState = function () { var offline = !navigator.onLine; if (this.sendBtn) { this.sendBtn.disabled = offline || this.isProcessing; this.sendBtn.title = offline ? 'You are offline. Reconnect to send.' : ''; } };

    MilesWidget.prototype.onSessionChange = function () {
        var prevUserId = this.userId;
        this.getUserData();
        var changed = (prevUserId !== this.userId) || !this.isAuthenticated;
        if (!changed) return;
        this.stopPolling(); this.stopGuestPolling(); this.stopUnreadPolling();
        this.conversations = []; this.unreadByTicket = new Map(); this.currentConversationId = null; this.messages = []; this.knownMessageIds = new Set();
        this.previousUnread = 0; this.previousUnreadForTitle = 0;
        this.updateBadges(0); this.updateDocumentTitle(); this.setGreeting();
        if (this.isAuthenticated && !this.isAuthPage) { this.loadConversations(); this.refreshUnreadMap(); this.startUnreadPolling(); }
        else { this.restoreGuestTicket(); }
    };

    MilesWidget.prototype.onWindowResize = function () {
        var self = this;
        clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(function () {
            if (self.isDragging || !self.launcher) return;
            var b = self.getBreakpoint();
            if (b !== self._lastBreakpoint) {
                if (self.panel) { self.panel.style.left = ''; self.panel.style.top = ''; self.panel.style.right = ''; self.panel.style.bottom = ''; self.panel.style.height = ''; }
                self.applyPositionForBreakpoint(b); self.applyLauncherAvoidance();
                if (self.isOpen) self.positionPanelToLauncher();
                return;
            }
            var rect = self.launcher.getBoundingClientRect();
            var w = self.launcher.offsetWidth || CONFIG.LAUNCHER_DESKTOP; var h = self.launcher.offsetHeight || CONFIG.LAUNCHER_DESKTOP;
            var off = rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight;
            if (off) { self.applyPositionForBreakpoint(b); self.applyLauncherAvoidance(); return; }
            if (self.launcher.style.left && self.launcher.style.left !== 'auto') {
                self.launcher.style.left = Math.max(0, Math.min(rect.left, window.innerWidth - w)) + 'px';
                self.launcher.style.top  = Math.max(0, Math.min(rect.top,  window.innerHeight - h)) + 'px';
            }
            if (self.isOpen) self.positionPanelToLauncher();
            self.applyLauncherAvoidance(); self.syncMobileViewport();
        }, 150);
    };

    MilesWidget.prototype.getBreakpoint = function () { return window.innerWidth <= CONFIG.MOBILE_BREAKPOINT ? 'mobile' : 'desktop'; };
    MilesWidget.prototype.getPositionStorageKeys = function (bp) { var b = bp || this.getBreakpoint(); return { left: CONFIG.STORAGE_PREFIX + 'launcher_left_' + b, top: CONFIG.STORAGE_PREFIX + 'launcher_top_' + b }; };
    MilesWidget.prototype.getDefaultEdgeOffsets = function (bp) { var b = bp || this.getBreakpoint(); return b === 'mobile' ? { bottom: CONFIG.MOBILE_BOTTOM, right: CONFIG.MOBILE_RIGHT } : { bottom: CONFIG.DESKTOP_BOTTOM, right: CONFIG.DESKTOP_RIGHT }; };
    
    MilesWidget.prototype.applyDefaultLauncherPosition = function (bp) {
        if (!this.launcher) return;
        var off = this.getDefaultEdgeOffsets(bp);
        this.launcher.style.inset = 'auto'; this.launcher.style.transform = 'none';
        this.launcher.style.left = 'auto'; this.launcher.style.top = 'auto';
        this.launcher.style.right = off.right + 'px'; this.launcher.style.bottom = off.bottom + 'px';
    };

    MilesWidget.prototype.clearStoredPosition = function (bp) { var keys = this.getPositionStorageKeys(bp); safeStorageRemove(localStorage, keys.left); safeStorageRemove(localStorage, keys.top); };

    MilesWidget.prototype.applyLauncherAvoidance = function () {
        if (!this.launcher || (this.launcher.style.left && this.launcher.style.left !== 'auto')) return;
        var nav = document.querySelector('.mnav, .bottom-nav');
        if (!nav) return;
        var rect = nav.getBoundingClientRect(); if (!rect.width && !rect.height) return;
        var navBottomFromViewport = window.innerHeight - rect.top; var safeB = 0;
        try { var cs = window.getComputedStyle(document.documentElement); var raw = cs.getPropertyValue('--safe-b') || '0px'; safeB = parseFloat(raw) || 0; } catch (e) {}
        var bottom = Math.max(CONFIG.MOBILE_BOTTOM, navBottomFromViewport + 12 + safeB);
        this.launcher.style.left = 'auto'; this.launcher.style.top = 'auto';
        this.launcher.style.right = CONFIG.MOBILE_RIGHT + 'px'; this.launcher.style.bottom = bottom + 'px';
    };

    MilesWidget.prototype.applyPositionForBreakpoint = function (bp) {
        if (!this.launcher) return;
        var b = bp || this.getBreakpoint(); var keys = this.getPositionStorageKeys(b);
        var sLeft = safeStorageGet(localStorage, keys.left); var sTop = safeStorageGet(localStorage, keys.top);
        if (sLeft && sTop) {
            var w = this.launcher.offsetWidth || CONFIG.LAUNCHER_DESKTOP; var h = this.launcher.offsetHeight || CONFIG.LAUNCHER_DESKTOP;
            var rLeft = parseFloat(sLeft); var rTop = parseFloat(sTop);
            var off = !isFinite(rLeft) || !isFinite(rTop) || rLeft + w <= 0 || rTop + h <= 0 || rLeft >= window.innerWidth || rTop >= window.innerHeight;
            if (off) { this.applyDefaultLauncherPosition(b); this.clearStoredPosition(b); }
            else {
                this.launcher.style.left = Math.max(0, Math.min(rLeft, window.innerWidth - w)) + 'px';
                this.launcher.style.top  = Math.max(0, Math.min(rTop,  window.innerHeight - h)) + 'px';
                this.launcher.style.right = 'auto'; this.launcher.style.bottom = 'auto';
            }
        } else { this.applyDefaultLauncherPosition(b); }
        this._lastBreakpoint = b;
    };

    MilesWidget.prototype.initializePosition = function () { this.applyPositionForBreakpoint(this.getBreakpoint()); this.applyLauncherAvoidance(); };

    MilesWidget.prototype.debugInfo = function () {
        var mode = 'desktop';
        if (this.isMobileFullScreenMode()) mode = window.innerWidth <= CONFIG.MOBILE_BREAKPOINT ? 'mobile-fullscreen' : 'short-landscape';
        function rect(el) { if (!el || !el.getBoundingClientRect) return null; var r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left }; }
        function computed(el) { if (!el) return null; try { var cs = window.getComputedStyle(el); return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, pointerEvents: cs.pointerEvents, position: cs.position, zIndex: cs.zIndex }; } catch (e) { return null; } }
        var lr = rect(this.launcher); var pr = rect(this.panel);
        var launcherInsideViewport = false;
        if (lr) launcherInsideViewport = lr.left >= 0 && lr.top >= 0 && lr.right <= window.innerWidth && lr.bottom <= window.innerHeight;
        var topmostAtLauncherCentre = null;
        if (lr) { try { var cx = Math.round(lr.left + lr.width / 2); var cy = Math.round(lr.top + lr.height / 2); var el = document.elementFromPoint(cx, cy); topmostAtLauncherCentre = el ? (el.id || el.className || el.tagName) : null; } catch (e) {} }
        return { initialized: true, path: location.pathname, exclusionReason: window.MilesWidgetDebugReason || null, isOpen: !!this.isOpen, isMinimized: !!(this.panel && this.panel.classList.contains('minimized')), innerWidth: window.innerWidth, innerHeight: window.innerHeight, breakpoint: this.getBreakpoint(), mode: mode, launcherExists: !!this.launcher, panelExists: !!this.panel, launcherRect: lr, panelRect: pr, launcherComputed: computed(this.launcher), panelComputed: computed(this.panel), launcherInsideViewport: launcherInsideViewport, topmostAtLauncherCentre: topmostAtLauncherCentre, ariaExpanded: this.launcher ? this.launcher.getAttribute('aria-expanded') : null };
    };

    MilesWidget.prototype.destroy = function () {
        this.stopPolling(); this.stopGuestPolling(); this.stopUnreadPolling();
        document.removeEventListener('keydown', this._boundGlobalKeydown); document.removeEventListener('visibilitychange', this._boundVisibility);
        window.removeEventListener('resize', this._boundResize); window.removeEventListener('orientationchange', this._boundResize);
        window.removeEventListener('online', this._boundOnline); window.removeEventListener('offline', this._boundOnline);
        window.removeEventListener('session:ready', this._boundSessionReady); window.removeEventListener('session:logout', this._boundSessionLogout); window.removeEventListener('session:expired', this._boundSessionLogout);
        if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
        var styleEl = document.getElementById('miles-widget-styles'); if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
        window.__MILES_WIDGET_BOOTED__ = false; window.MilesWidget = null;
    };

    function initMilesWidget() {
        if (window.MilesWidget && typeof window.MilesWidget.open === 'function') return;
        try { window.MilesWidget = new MilesWidget({ apiUrl: CONFIG.API_URL }); window.__MILES_WIDGET_BOOTED__ = true; }
        catch (e) { window.__MILES_WIDGET_BOOTED__ = false; try { window.MilesWidgetDebugReason = 'init-failed'; } catch (e2) {} if (window.console && console.warn) console.warn('[MilesWidget] failed to initialize:', (e && e.message) || e); }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMilesWidget, { once: true });
    else initMilesWidget();
})();