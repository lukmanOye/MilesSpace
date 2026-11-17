// public/js/admin-sidebar.js
// ─────────────────────────────────────────────────────────────────
// Shared sidebar for every admin page.
// Injects the canonical markup into <aside id="sidebar"> and sets
// .active on the current page's link based on location.pathname.
// Safe to include on every admin page. If a page has its own sidebar
// markup, that markup is replaced.
//
// Icons are Font Awesome class strings. No emoji, no unicode glyphs.
// The renderer wraps each icon in <i class="...">.
//
// Auto-expand behaviour: a group declared with `collapsed: true` will
// still render expanded if it contains the current page's link. This
// ensures the active nav item is always visible (e.g. opening
// /admin/reports.html shows the "Analytics" group open so the
// "Reports" link is visible). Manually clicking the group header
// still collapses it — the auto-expand only affects initial render.
// ─────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    if (window.__ADMIN_SIDEBAR_MOUNTED__) return;
    window.__ADMIN_SIDEBAR_MOUNTED__ = true;

    var GROUPS = [
        {
            label: 'Overview',
            items: [
                { href: '/admin/dashboard.html', icon: 'fa-solid fa-chart-line', text: 'Dashboard' }
            ]
        },
        {
            label: 'Customers',
            items: [
                { href: '/admin/users.html', icon: 'fa-solid fa-user-group', text: 'Users' },
                { href: '/admin/support.html', icon: 'fa-solid fa-comments', text: 'Support' }
            ]
        },
        {
            label: 'Money',
            items: [
                { href: '/admin/transactions.html', icon: 'fa-solid fa-credit-card', text: 'Transactions' },
                { href: '/admin/deposits.html', icon: 'fa-solid fa-inbox', text: 'Deposits' },
                { href: '/admin/ledger.html', icon: 'fa-solid fa-book', text: 'Ledger' },
                { href: '/admin/reconciliation.html', icon: 'fa-solid fa-arrows-rotate', text: 'Reconciliation' }
            ]
        },
        {
            label: 'Services',
            items: [
                { href: '/admin/sellgift.html', icon: 'fa-solid fa-gift', text: 'Gift Cards' },
                { href: '/admin/airtime-data.html', icon: 'fa-solid fa-signal', text: 'Airtime & Data' },
                { href: '/admin/bills.html', icon: 'fa-solid fa-file-invoice', text: 'Bills' },
                { href: '/admin/esim.html', icon: 'fa-solid fa-sim-card', text: 'eSIM' },
                { href: '/admin/virtual-sms.html', icon: 'fa-solid fa-mobile-screen-button', text: 'Virtual SMS' },
                { href: '/admin/boost.html', icon: 'fa-solid fa-rocket', text: 'Boost' },
                { href: '/admin/marketplace-products.html', icon: 'fa-solid fa-box', text: 'Marketplace' }
            ]
        },
        {
            label: 'Operations',
            items: [
                { href: '/admin/orders.html', icon: 'fa-solid fa-list-check', text: 'Orders' },
                { href: '/admin/orders.html?status=failed', icon: 'fa-solid fa-triangle-exclamation', text: 'Failed Orders' },
                { href: '/admin/providers.html', icon: 'fa-solid fa-plug', text: 'Providers' },
                { href: '/admin/webhooks.html', icon: 'fa-solid fa-link', text: 'Webhooks' }
            ]
        },
        {
            label: 'Analytics',
            collapsed: true,
            items: [
                { href: '/admin/revenue.html', icon: 'fa-solid fa-chart-pie', text: 'Revenue' },
                { href: '/admin/reports.html', icon: 'fa-solid fa-file-lines', text: 'Reports' }
            ]
        },
        {
            label: 'System',
            collapsed: true,
            items: [
                { href: '/admin/notifications.html', icon: 'fa-solid fa-bell', text: 'Notifications' },
                { href: '/admin/settings.html', icon: 'fa-solid fa-gear', text: 'Settings' }
            ]
        }
    ];

    function escapeAttr(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
        });
    }

    function currentPath() {
        try { return window.location.pathname; } catch (e) { return ''; }
    }

    function isActive(href) {
        var a = href.split('?')[0];
        var p = currentPath();
        if (a === p) return true;
        // Allow /admin/x and /admin/x.html to match each other
        if (a.replace(/\.html$/, '') === p.replace(/\.html$/, '')) return true;
        return false;
    }

    // A group is "active" if any of its items matches the current page.
    // Used to force-open a group that would otherwise render collapsed.
    function groupHasActive(g) {
        return g.items.some(function (it) { return isActive(it.href); });
    }

    function render() {
        var aside = document.getElementById('sidebar');
        if (!aside) return;

        var html = '';
        html += '<div class="brand">';
        html +=   '<img class="brand-logo" src="/images/miles.png" alt="MilesSpace" width="32" height="32"';
        html +=     ' onerror="this.style.display=\'none\';this.insertAdjacentHTML(\'afterend\',\'<div class=&quot;brand-mark&quot; aria-hidden=&quot;true&quot;>M</div>\')">';
        html +=   '<div class="brand-text"><strong>MilesSpace</strong><span>Admin</span></div>';
        html +=   '<button class="sb-collapse-btn" id="sbCollapseBtn" type="button" aria-label="Collapse sidebar"><i class="fa-solid fa-angles-left"></i></button>';
        html += '</div>';

        html += '<nav class="nav-scroll" aria-label="Primary">';
        GROUPS.forEach(function (g) {
            var effectiveCollapsed = g.collapsed && !groupHasActive(g);
            var groupClass = 'nav-group' + (effectiveCollapsed ? ' collapsed' : '');
            html += '<div class="' + groupClass + '">';
            html +=   '<button type="button" class="nav-group-head" aria-expanded="' + (effectiveCollapsed ? 'false' : 'true') + '">';
            html +=     '<span class="nav-label">' + escapeAttr(g.label) + '</span>';
            html +=     '<span class="chev"><i class="fa-solid fa-chevron-down"></i></span>';
            html +=   '</button>';
            html +=   '<div class="nav-items">';
            g.items.forEach(function (it) {
                var active = isActive(it.href) ? ' active' : '';
                html += '<a href="' + escapeAttr(it.href) + '" class="nav-item' + active + '">';
                html +=   '<span class="ic" aria-hidden="true"><i class="' + escapeAttr(it.icon) + '"></i></span>';
                html +=   '<span>' + escapeAttr(it.text) + '</span>';
                html += '</a>';
            });
            html +=   '</div>';
            html += '</div>';
        });
        html += '</nav>';

        html += '<div class="sidebar-foot">';
        html +=   '<div class="av" id="adminAvatar">DA</div>';
        html +=   '<div class="who"><strong id="adminName">Admin</strong><span id="adminRole">Admin</span></div>';
        html += '</div>';

        aside.innerHTML = html;

        // Wire collapse button
        var collapseBtn = document.getElementById('sbCollapseBtn');
        collapseBtn && collapseBtn.addEventListener('click', function () {
            var root = document.getElementById('appRoot');
            if (root) root.classList.toggle('sb-collapsed');
        });

        // Wire group toggles
        aside.querySelectorAll('.nav-group-head').forEach(function (head) {
            head.addEventListener('click', function () {
                var g = head.closest('.nav-group');
                if (!g) return;
                g.classList.toggle('collapsed');
                head.setAttribute('aria-expanded', String(!g.classList.contains('collapsed')));
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', render);
    } else {
        render();
    }
})();