// public/js/admin-operational-sidebar.js
// ─────────────────────────────────────────────────────────────────
// Single owner of the admin sidebar for every admin page.
//
// Contract (do not break — every admin page depends on it):
//   • <aside id="sidebar"> is the ONLY DOM element the page needs.
//   • window.ADMIN_PERMISSIONS  : string[]  (permission slugs) | null
//   • window.ADMIN_PROFILE      : { user } | null
//   • document event "admin:ready" fires ONCE with { permissions, user }
//     — after /me resolves, or after 8 seconds (fail-safe).
//   • The sidebar owns: brand, collapse btn, nav, group toggles,
//     mobile drawer open/close, profile hydration of #adminName,
//     #adminAvatar, #chipName, #chipRole, #chipAvatar if present.
//   • Pages MUST NOT load /api/admin/me themselves. Read from
//     window.ADMIN_PROFILE or subscribe to "admin:ready".
//
// A11y:
//   • <nav role="navigation" aria-label="Admin navigation">
//   • .nav-item[aria-current="page"] on the active link
//   • .nav-group-head[aria-expanded="true|false"]
//   • Drawer mode (≤900px): focus trap, Escape to close, return
//     focus to #hamburger, scrim click closes.
//
// Mobile behaviour:
//   • ≤900px the sidebar is off-canvas. Toggled by #hamburger.
//   • On close, focus returns to #hamburger if it exists.
//   • Sidebar has its own scroll container so the page never
//     scrolls when the drawer is open (body[data-drawer="open"]).
// ─────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    if (window.__ADMIN_OPS_SIDEBAR_MOUNTED__) return;
    window.__ADMIN_OPS_SIDEBAR_MOUNTED__ = true;

    // ─── Menu definition ────────────────────────────────────────
    // `perm` (optional) — permission slug required to see the item.
    // `permAny` (optional) — array; item visible if caller has ANY.
    // No `perm` — item is always shown (e.g. Overview).
    var GROUPS = [
        {
            key: 'operational',
            label: 'Operational',
            collapsed: false,
            items: [
                { href: '/admin/dashboard',                          icon: 'fa-gauge-high',             text: 'Overview',       permAny: ['dashboard.read'] },
                { href: '/admin/webhooks',                           icon: 'fa-link',                   text: 'Webhooks',       perm: 'webhooks.read' },
                { href: '/admin/orders',                             icon: 'fa-receipt',                text: 'Orders',         perm: 'orders.read' },
                { href: '/admin/orders?status=failed',               icon: 'fa-triangle-exclamation',   text: 'Failed Orders',  perm: 'orders.read', siblingOf: '/admin/orders' },
                { href: '/admin/providers',                          icon: 'fa-plug',                   text: 'Providers',      perm: 'providers.read' },
                { href: '/admin/reconciliation',                     icon: 'fa-arrows-rotate',          text: 'Reconciliation', perm: 'reconciliation.read' }
            ]
        },
        {
            key: 'customers',
            label: 'Customers',
            collapsed: false,
            items: [
                { href: '/admin/users',   icon: 'fa-users',    text: 'Users',   perm: 'users.read' },
                { href: '/admin/support', icon: 'fa-comments', text: 'Support', perm: 'support.read' }
            ]
        },
        {
            key: 'money',
            label: 'Money',
            collapsed: false,
            items: [
                { href: '/admin/transactions', icon: 'fa-credit-card', text: 'Transactions', perm: 'transactions.read' },
                { href: '/admin/deposits',     icon: 'fa-circle-down', text: 'Deposits',     perm: 'deposits.read' },
                { href: '/admin/ledger',       icon: 'fa-book',        text: 'Ledger',       perm: 'wallets.read' }
            ]
        },
        {
            key: 'services',
            label: 'Services',
            collapsed: false,
            items: [
                { href: '/admin/sellgift',             icon: 'fa-gift',                 text: 'Gift Cards',    permAny: ['services.read', 'services.manage'] },
                { href: '/admin/airtime-data',         icon: 'fa-signal',               text: 'Airtime & Data',permAny: ['services.read', 'services.manage'] },
                { href: '/admin/bills',                icon: 'fa-file-invoice-dollar',  text: 'Bills',         permAny: ['services.read', 'services.manage'] },
                { href: '/admin/esim',                 icon: 'fa-satellite-dish',       text: 'eSIM',          permAny: ['services.read', 'services.manage'] },
                { href: '/admin/virtual-sms',          icon: 'fa-mobile-screen',        text: 'Virtual SMS',   permAny: ['services.read', 'services.manage'] },
                { href: '/admin/boost',                icon: 'fa-chart-line',           text: 'Boost',         permAny: ['services.read', 'services.manage'] },
                { href: '/admin/marketplace-products', icon: 'fa-box',                  text: 'Marketplace',   permAny: ['services.read', 'services.manage'] }
            ]
        },
        {
            key: 'analytics',
            label: 'Analytics',
            collapsed: true,
            items: [
                { href: '/admin/revenue',  icon: 'fa-chart-column', text: 'Revenue', perm: 'reports.read' },
                { href: '/admin/reports',  icon: 'fa-file-lines',   text: 'Reports', perm: 'reports.read' }
            ]
        },
        {
            key: 'system',
            label: 'System',
            collapsed: true,
            items: [
                { href: '/admin/notifications', icon: 'fa-bell', text: 'Notifications', perm: 'notifications.read' },
                { href: '/admin/settings',      icon: 'fa-gear', text: 'Settings',      perm: 'settings.read' }
            ]
        }
    ];

    // ─── Constants ─────────────────────────────────────────────
    var MOBILE_QUERY = '(max-width: 900px)';
    var LS_COLLAPSE_KEY   = 'admin.sidebar.collapsed';
    var LS_GROUP_PREFIX   = 'admin.sidebar.group.';
    var PERMISSIONS_GLOBAL = 'ADMIN_PERMISSIONS';
    var PROFILE_GLOBAL     = 'ADMIN_PROFILE';
    var READY_EVENT        = 'admin:ready';
    var ME_TIMEOUT_MS      = 8000;

    // ─── Escape ────────────────────────────────────────────────
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
        });
    }
    function lsGet(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }
    function lsSet(key, value) {
        try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
    }
    function initialsOf(name) {
        var n = String(name || '').trim();
        if (!n) return 'A';
        var parts = n.split(/\s+/).filter(Boolean);
        if (!parts.length) return 'A';
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    // ─── Active-link detection ─────────────────────────────────
    // Path must match (case-insensitively) AND, if the item has a
    // query, the current query must match it exactly. Sibling
    // specificity is handled by the caller: /admin/orders without
    // query is only active when the current URL has no `status`
    // query (because "Failed Orders" is a more specific sibling).
    function normPath(p) {
        if (!p) return '';
        var s = String(p);
        // strip trailing slash
        if (s.length > 1 && s.charAt(s.length - 1) === '/') s = s.slice(0, -1);
        // strip .html
        s = s.replace(/\.html$/i, '');
        return s.toLowerCase();
    }
    function normQuery(q) {
        if (!q) return '';
        // sort params for stable comparison
        var pairs = String(q).replace(/^\?/, '').split('&').filter(Boolean).map(function (kv) {
            var i = kv.indexOf('=');
            var k = i === -1 ? kv : kv.slice(0, i);
            var v = i === -1 ? '' : kv.slice(i + 1);
            return [decodeURIComponent(k), decodeURIComponent(v)];
        });
        pairs.sort(function (a, b) {
            if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
            return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
        });
        return pairs.map(function (p) {
            return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]);
        }).join('&');
    }
    function hrefParts(href) {
        var i = href.indexOf('?');
        return {
            path: normPath(i === -1 ? href : href.slice(0, i)),
            query: normQuery(i === -1 ? '' : href.slice(i + 1))
        };
    }
    function currentParts() {
        var path = (function () { try { return window.location.pathname; } catch (e) { return ''; } })();
        var search = (function () { try { return window.location.search; } catch (e) { return ''; } })();
        return { path: normPath(path), query: normQuery(search) };
    }

    function computeActiveHref() {
        var cur = currentParts();
        // Iterate ALL items, find the most specific match. A match
        // is: same path AND (item.query === current.query OR
        // item.query === '' AND current.query === '').
        // If an item has a query and the current does not, it does
        // NOT match. If the current has a query and no item matches
        // it exactly, fall back to the query-less sibling.
        var exactMatches = [];
        var pathMatches = [];
        for (var gi = 0; gi < GROUPS.length; gi++) {
            var items = GROUPS[gi].items || [];
            for (var ii = 0; ii < items.length; ii++) {
                var it = items[ii];
                var hp = hrefParts(it.href);
                if (hp.path !== cur.path) continue;
                pathMatches.push(it.href);
                if (hp.query === cur.query) {
                    exactMatches.push(it.href);
                }
            }
        }
        if (exactMatches.length) return exactMatches[0];
        // No exact query match — return the query-less sibling if any,
        // so /admin/orders.html?status=unknown-crap still lights up
        // "Orders" (a safer default than lighting up nothing).
        for (var pm = 0; pm < pathMatches.length; pm++) {
            if (hrefParts(pathMatches[pm]).query === '') return pathMatches[pm];
        }
        return null;
    }

    // ─── Permission check ──────────────────────────────────────
    // Returns true/false/null. null = "permissions not resolved".
    function hasPerm(item) {
        var perms = window[PERMISSIONS_GLOBAL];
        if (perms === null || perms === undefined) return null; // unresolved
        if (!Array.isArray(perms)) return false;
        // wildcard / super-admin
        if (perms.indexOf('*') !== -1) return true;
        if (item.perm) return perms.indexOf(item.perm) !== -1;
        if (Array.isArray(item.permAny)) {
            for (var i = 0; i < item.permAny.length; i++) {
                if (perms.indexOf(item.permAny[i]) !== -1) return true;
            }
            return false;
        }
        return true;
    }

    // ─── Render ────────────────────────────────────────────────
    function renderShell(aside) {
        // Pre-compute active BEFORE we build the HTML so we don't
        // re-walk GROUPS for each item.
        var activeHref = computeActiveHref();

        var html = '';

        // Brand
        html += '<div class="brand">';
        html += '<img class="brand-logo" src="/images/miles.png" alt="" width="32" height="32" data-brand-img>';
        html += '<div class="brand-mark" aria-hidden="true" style="display:none" data-brand-mark>M</div>';
        html += '<div class="brand-text"><strong>MilesSpace</strong><span>Admin</span></div>';
        html += '<button class="sb-collapse-btn" id="sbCollapseBtn" type="button" aria-label="Collapse sidebar" title="Collapse sidebar">';
        html += '<i class="fas fa-angles-left" aria-hidden="true"></i>';
        html += '</button>';
        html += '</div>';

        // Nav
        html += '<nav class="nav-scroll" role="navigation" aria-label="Admin navigation">';
        for (var gi = 0; gi < GROUPS.length; gi++) {
            var g = GROUPS[gi];
            var stored = lsGet(LS_GROUP_PREFIX + g.key);
            var isCollapsed = stored === 'collapsed' ? true : stored === 'open' ? false : !!g.collapsed;
            var groupClass = 'nav-group' + (isCollapsed ? ' collapsed' : '');

            html += '<div class="' + groupClass + '" data-group="' + esc(g.key) + '">';
            html += '<button type="button" class="nav-group-head" aria-expanded="' + (isCollapsed ? 'false' : 'true') + '" aria-controls="nav-group-' + esc(g.key) + '">';
            html += '<span class="nav-label">' + esc(g.label) + '</span>';
            html += '<span class="chev" aria-hidden="true"><i class="fas fa-chevron-down"></i></span>';
            html += '</button>';
            html += '<div class="nav-items" id="nav-group-' + esc(g.key) + '">';

            for (var ii = 0; ii < g.items.length; ii++) {
                var it = g.items[ii];
                // Before /me resolves, hide perm-gated items to avoid
                // flashing them. Non-perm items always render.
                var permState = hasPerm(it);
                var hidden = (permState === false);
                var isActive = activeHref === it.href;
                var cls = 'nav-item' + (isActive ? ' active' : '');
                var ariaCurrent = isActive ? ' aria-current="page"' : '';
                var hiddenAttr = hidden ? ' hidden' : '';
                var titleAttr = ' title="' + esc(it.text) + '"';
                html += '<a href="' + esc(it.href) + '" class="' + cls + '"' + ariaCurrent + titleAttr + ' data-perm-gated="' + (permState === null || hidden ? '1' : '0') + '" data-perm-key="' + esc(it.perm || (it.permAny || []).join(',')) + '"' + hiddenAttr + '>';
                html += '<span class="ic" aria-hidden="true"><i class="fas ' + esc(it.icon) + '"></i></span>';
                html += '<span class="nav-item-text">' + esc(it.text) + '</span>';
                html += '</a>';
            }

            html += '</div>';
            html += '</div>';
        }
        html += '</nav>';

        // Footer
        html += '<div class="sidebar-foot">';
        html += '<div class="av" id="adminAvatar">A</div>';
        html += '<div class="who"><strong id="adminName">Admin</strong><span id="adminRole">Admin</span></div>';
        html += '</div>';

        aside.innerHTML = html;

        // Brand image fallback
        var img = aside.querySelector('[data-brand-img]');
        var mark = aside.querySelector('[data-brand-mark]');
        if (img) {
            img.addEventListener('error', function () {
                img.style.display = 'none';
                if (mark) mark.style.display = 'flex';
            }, { once: true });
        }

        // Collapse button
        var collapseBtn = aside.querySelector('#sbCollapseBtn');
        if (collapseBtn) {
            collapseBtn.addEventListener('click', function () {
                var root = document.getElementById('appRoot');
                if (!root) return;
                root.classList.toggle('sb-collapsed');
                var collapsed = root.classList.contains('sb-collapsed');
                lsSet(LS_COLLAPSE_KEY, collapsed ? '1' : '0');
            });
        }

        // Restore collapsed state
        if (lsGet(LS_COLLAPSE_KEY) === '1') {
            var appRoot = document.getElementById('appRoot');
            if (appRoot) appRoot.classList.add('sb-collapsed');
        }

        // Group toggles
        aside.querySelectorAll('.nav-group-head').forEach(function (head) {
            head.addEventListener('click', function () {
                var g = head.closest('.nav-group');
                if (!g) return;
                g.classList.toggle('collapsed');
                var collapsed = g.classList.contains('collapsed');
                head.setAttribute('aria-expanded', String(!collapsed));
                lsSet(LS_GROUP_PREFIX + g.getAttribute('data-group'), collapsed ? 'collapsed' : 'open');
            });
        });
    }

    // ─── Hydrate profile + permissions ─────────────────────────
    function applyPermissions(perms) {
        var aside = document.getElementById('sidebar');
        if (!aside) return;
        var isResolved = Array.isArray(perms);
        var superAdmin = isResolved && (perms.indexOf('*') !== -1);

        aside.querySelectorAll('[data-perm-gated]').forEach(function (el) {
            if (!isResolved) return; // still hidden
            var key = el.getAttribute('data-perm-key') || '';
            var keys = key.split(',').filter(Boolean);
            var visible;
            if (superAdmin) visible = true;
            else if (keys.length === 0) visible = true;
            else visible = keys.some(function (k) { return perms.indexOf(k) !== -1; });
            if (visible) el.removeAttribute('hidden');
            else el.setAttribute('hidden', '');
        });

        // Hide entire empty groups
        aside.querySelectorAll('.nav-group').forEach(function (g) {
            var visibleItems = g.querySelectorAll('.nav-item:not([hidden])').length;
            if (isResolved && visibleItems === 0) g.setAttribute('hidden', '');
            else g.removeAttribute('hidden');
        });
    }

    function applyProfile(user) {
        if (!user) return;
        var name = user.username || (user.email ? String(user.email).split('@')[0] : 'Admin');
        var role = user.role || 'admin';
        var roleDisplay = String(role).replace(/[_-]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
        var initials = initialsOf(name);

        var map = {
            adminName:   name,
            adminRole:   roleDisplay,
            adminAvatar: initials,
            chipName:    name,
            chipRole:    roleDisplay,
            chipAvatar:  initials
        };
        Object.keys(map).forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.textContent = map[id];
        });
    }

    function fetchMe() {
        // Prefer AdminSession.fetch so the bearer token is attached.
        var fetcher = (window.AdminSession && typeof window.AdminSession.fetch === 'function')
            ? window.AdminSession.fetch.bind(window.AdminSession)
            : null;
        if (!fetcher) {
            return Promise.resolve(null);
        }
        return fetcher('/api/admin/me', { method: 'GET' })
            .then(function (res) {
                if (!res || !res.ok) return null;
                return res.json().catch(function () { return null; });
            })
            .catch(function () { return null; });
    }

    function hydrate() {
        var resolved = false;
        var timeoutId = setTimeout(function () {
            if (resolved) return;
            resolved = true;
            // Fail-safe: permissions unknown. Leave perm-gated items hidden.
            if (window[PERMISSIONS_GLOBAL] === undefined) {
                window[PERMISSIONS_GLOBAL] = null;
            }
            if (window[PROFILE_GLOBAL] === undefined) {
                window[PROFILE_GLOBAL] = null;
            }
            try {
                document.dispatchEvent(new CustomEvent(READY_EVENT, {
                    detail: { permissions: window[PERMISSIONS_GLOBAL], user: null, failed: true }
                }));
            } catch (e) { /* ignore */ }
        }, ME_TIMEOUT_MS);

        fetchMe().then(function (payload) {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeoutId);

            // Payload shape: { success, data: { user, session } }
            var data = (payload && payload.data) || null;
            var user = (data && data.user) || null;
            var perms = (user && Array.isArray(user.permissions)) ? user.permissions : null;

            window[PROFILE_GLOBAL] = user;
            window[PERMISSIONS_GLOBAL] = perms;

            if (user) applyProfile(user);
            applyPermissions(perms);

            try {
                document.dispatchEvent(new CustomEvent(READY_EVENT, {
                    detail: { permissions: perms, user: user, failed: false }
                }));
            } catch (e) { /* ignore */ }
        });
    }

    // ─── Mobile drawer ─────────────────────────────────────────
    function isMobile() {
        try { return window.matchMedia(MOBILE_QUERY).matches; } catch (e) { return false; }
    }

    function focusables(root) {
        if (!root) return [];
        var sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
        return Array.prototype.slice.call(root.querySelectorAll(sel)).filter(function (el) {
            return el.offsetParent !== null || el === document.activeElement;
        });
    }

    var previousFocus = null;

    function openDrawer() {
        var aside = document.getElementById('sidebar');
        var scrim = document.getElementById('scrim');
        if (!aside) return;
        if (!isMobile()) return;
        previousFocus = document.activeElement;
        aside.classList.add('open');
        if (scrim) scrim.classList.add('show');
        document.body.setAttribute('data-drawer', 'open');

        // Focus trap
        var handler = function (e) {
            if (e.key === 'Escape') {
                closeDrawer();
                e.preventDefault();
                return;
            }
            if (e.key !== 'Tab') return;
            var f = focusables(aside);
            if (!f.length) return;
            var first = f[0];
            var last = f[f.length - 1];
            if (e.shiftKey) {
                if (document.activeElement === first || document.activeElement === aside) {
                    last.focus();
                    e.preventDefault();
                }
            } else {
                if (document.activeElement === last) {
                    first.focus();
                    e.preventDefault();
                }
            }
        };
        aside.__focusTrap = handler;
        document.addEventListener('keydown', handler);
    }

    function closeDrawer() {
        var aside = document.getElementById('sidebar');
        var scrim = document.getElementById('scrim');
        if (!aside) return;
        aside.classList.remove('open');
        if (scrim) scrim.classList.remove('show');
        document.body.removeAttribute('data-drawer');
        if (aside.__focusTrap) {
            document.removeEventListener('keydown', aside.__focusTrap);
            delete aside.__focusTrap;
        }
        // Return focus to hamburger
        var hb = document.getElementById('hamburger');
        if (hb) hb.focus();
        previousFocus = null;
    }

    function wireMobile() {
        var aside = document.getElementById('sidebar');
        var scrim = document.getElementById('scrim');
        var hb = document.getElementById('hamburger');
        if (hb) {
            hb.addEventListener('click', function () {
                if (aside && aside.classList.contains('open')) closeDrawer();
                else openDrawer();
            });
        }
        if (scrim) {
            scrim.addEventListener('click', closeDrawer);
        }
        // Navigating a link closes the drawer (fresh page anyway, but
        // avoids a stuck focus trap on browsers that keep the page
        // alive via view transitions).
        if (aside) {
            aside.addEventListener('click', function (e) {
                var a = e.target.closest('a[href]');
                if (a) closeDrawer();
            });
        }
    }

    // ─── Mount ─────────────────────────────────────────────────
    function mount() {
        var aside = document.getElementById('sidebar');
        if (!aside) {
            // Page has no sidebar placeholder. Do nothing.
            return;
        }
        renderShell(aside);
        wireMobile();
        hydrate();

        // If the viewport switches from mobile to desktop while the
        // drawer is open, close the drawer cleanly.
        try {
            var mq = window.matchMedia(MOBILE_QUERY);
            var onChange = function () {
                if (!mq.matches) {
                    var a = document.getElementById('sidebar');
                    var s = document.getElementById('scrim');
                    if (a && a.classList.contains('open')) {
                        a.classList.remove('open');
                        if (s) s.classList.remove('show');
                        document.body.removeAttribute('data-drawer');
                        if (a.__focusTrap) {
                            document.removeEventListener('keydown', a.__focusTrap);
                            delete a.__focusTrap;
                        }
                    }
                }
            };
            if (mq.addEventListener) mq.addEventListener('change', onChange);
            else if (mq.addListener) mq.addListener(onChange);
        } catch (e) { /* ignore */ }

        // Escape closes the drawer at the document level even if focus
        // is not on the sidebar (e.g. focus on the hamburger).
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            var a = document.getElementById('sidebar');
            if (a && a.classList.contains('open')) closeDrawer();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }
})();