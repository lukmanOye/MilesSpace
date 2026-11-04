// /js/admin-shell.js
// ════════════════════════════════════════════════════════════════
// MilesSpace Admin Shell
// ════════════════════════════════════════════════════════════════
// Single source of truth for the sidebar, topbar, theme, and all
// shared utility functions. Page JS uses window.MS.* for everything.
// No inline onclick. Event delegation everywhere.

(function(global){
  'use strict';

  // ─── NAV CONFIG (single source) ─────────────────────────────
  const NAV = [
    { label: 'Overview', items: [
      { href: '/admin/money-overview.html', icon: 'fa-chart-line',      label: 'Money Overview', key: 'money-overview' },
      { href: '/admin/dashboard.html',       icon: 'fa-gauge-high',     label: 'Dashboard',      key: 'dashboard' },
    ]},
    { label: 'Customers', items: [
      { href: '/admin/users.html',    icon: 'fa-users',           label: 'Users',       key: 'users' },
      { href: '/admin/support.html',  icon: 'fa-headset',         label: 'Support',     key: 'support' },
    ]},
    { label: 'Money', items: [
      { href: '/admin/transactions.html',    icon: 'fa-arrow-right-arrow-left', label: 'Transactions',   key: 'transactions' },
      { href: '/admin/deposits.html',        icon: 'fa-circle-down',            label: 'Deposits',       key: 'deposits' },
      { href: '/admin/ledger.html',          icon: 'fa-book',                  label: 'Ledger',         key: 'ledger' },
      { href: '/admin/reconciliation.html',  icon: 'fa-rotate',                label: 'Reconciliation', key: 'reconciliation' },
      { href: '/admin/refunds.html',         icon: 'fa-rotate-left',           label: 'Refunds',        key: 'refunds' },
      { href: '/admin/approvals.html',       icon: 'fa-clipboard-check',       label: 'Approvals',      key: 'approvals', badgeKey: 'approvalsCount' },
    ]},
    { label: 'Services', items: [
      { href: '/admin/sellgift.html',    icon: 'fa-gift',                label: 'Gift Cards',   key: 'sellgift' },
      { href: '/admin/airtime-data.html',icon: 'fa-signal',              label: 'Airtime & Data', key: 'airtime' },
      { href: '/admin/bills.html',       icon: 'fa-file-invoice-dollar', label: 'Bills & Utilities', key: 'bills' },
      { href: '/admin/esim.html',        icon: 'fa-sim-card',            label: 'eSIM',         key: 'esim' },
      { href: '/admin/virtual-sms.html', icon: 'fa-mobile-screen',       label: 'Virtual SMS',  key: 'vsm' },
      { href: '/admin/boost.html',       icon: 'fa-arrow-trend-up',      label: 'Boost',        key: 'boost' },
      { href: '/admin/marketplace-products.html', icon: 'fa-box',        label: 'Marketplace',  key: 'marketplace' },
    ]},
    { label: 'System', items: [
      { href: '/admin/audit.html',    icon: 'fa-scroll', label: 'Audit Logs', key: 'audit' },
      { href: '/admin/settings.html', icon: 'fa-gear',   label: 'Settings',   key: 'settings' },
    ]},
  ];

  // ─── STATE ──────────────────────────────────────────────────
  let _requestSeq = 0;
  let _toastId = 0;

  // ─── UTILITIES ──────────────────────────────────────────────
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, m => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[m]));
  }

  function initials(name) {
    if (!name) return '—';
    const parts = String(name).trim().split(/\s+/);
    return parts.length === 1
      ? parts[0].slice(0, 2).toUpperCase()
      : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Money — safe decimal-string formatting.
  const CCY_SYMBOLS = { NGN: '₦', USD: '$', GHS: 'GH₵', KES: 'KSh', ZAR: 'R', EUR: '€', GBP: '£' };
  function fmtMoney(v, ccy) {
    if (v == null || v === '') return '—';
    // Accept decimal strings or numbers.
    const s = String(v);
    const n = Number(s);
    if (!Number.isFinite(n)) return '—';
    const c = String(ccy || '').toUpperCase();
    const sym = CCY_SYMBOLS[c] || (c ? c + ' ' : '');
    return sym + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtInt(v) {
    if (v == null) return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US');
  }

  function timeAgo(iso) {
    if (!iso) return '—';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (!Number.isFinite(s) || s < 0) return '—';
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString();
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function debounce(fn, ms = 300) {
    let t = null;
    return function(...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // Copy to clipboard with fallback.
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      ta.remove();
      return true;
    }
  }

  // ─── TOASTS ─────────────────────────────────────────────────
  function toast(msg, kind = 'info', ms = 3600) {
    let stack = document.getElementById('toastStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toastStack';
      stack.className = 'toast-stack';
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    const icons = {
      success: 'fa-circle-check',
      error: 'fa-circle-xmark',
      warn: 'fa-triangle-exclamation',
      info: 'fa-circle-info'
    };
    el.innerHTML = `<i class="fas ${icons[kind] || icons.info}" aria-hidden="true"></i><span>${esc(msg)}</span>`;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      el.style.transition = 'all 200ms ease';
      setTimeout(() => el.remove(), 220);
    }, ms);
    while (stack.children.length > 5) stack.firstElementChild.remove();
  }

  // ─── SCROLL LOCK (iOS-safe) ────────────────────────────────
  let _scrollLockY = 0;
  let _scrollLockCount = 0;
  function lockScroll() {
    _scrollLockCount++;
    if (_scrollLockCount > 1) return;
    _scrollLockY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${_scrollLockY}px`;
    document.body.style.width = '100%';
  }
  function unlockScroll() {
    _scrollLockCount = Math.max(0, _scrollLockCount - 1);
    if (_scrollLockCount > 0) return;
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    window.scrollTo(0, _scrollLockY);
  }

  // ─── API WRAPPER with AbortController + step-up ────────────
  async function api(url, opts = {}) {
    const mySeq = ++_requestSeq;
    const ctrl = new AbortController();
    const { signal: userSignal, ...rest } = opts;

    // Combine signals if user passed one
    if (userSignal) {
      userSignal.addEventListener('abort', () => ctrl.abort());
    }

    if (!window.AdminSession || typeof window.AdminSession.fetch !== 'function') {
      return { ok: false, status: 0, code: 'NO_SESSION', error: 'Session not loaded' };
    }

    try {
      const res = await AdminSession.fetch(url, { ...rest, signal: ctrl.signal });

      // If a newer call started, ignore this response.
      if (mySeq !== _requestSeq) {
        return { ok: false, aborted: true, stale: true };
      }

      let json = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try { json = await res.json(); } catch (_) {}
      }

      // Step-up challenge
      if (!res.ok && json) {
        if (json.code === 'STEP_UP_REQUIRED' ||
            json.code === 'MFA_REQUIRED' ||
            json.code === 'STEP_UP_EXPIRED') {
          const mfa = await promptMFA(json);
          if (!mfa) {
            return { ok: false, status: 403, code: 'STEP_UP_CANCELLED', error: 'Verification cancelled' };
          }
          // Retry once with the same headers/body/Idempotency-Key
          try {
            const retryRes = await AdminSession.fetch(url, rest);
            let retryJson = null;
            if ((retryRes.headers.get('content-type') || '').includes('application/json')) {
              try { retryJson = await retryRes.json(); } catch (_) {}
            }
            if (retryRes.ok) return { ok: true, data: retryJson, status: retryRes.status };
            return {
              ok: false, status: retryRes.status,
              code: retryJson?.code || ('HTTP_' + retryRes.status),
              error: retryJson?.error || 'Request failed',
              requestId: retryJson?.request_id || retryRes.headers.get('X-Request-Id')
            };
          } catch (e) {
            return { ok: false, status: 0, code: 'NETWORK_ERROR', error: e.message };
          }
        }
      }

      if (!res.ok) {
        return {
          ok: false, status: res.status,
          code: json?.code || ('HTTP_' + res.status),
          error: json?.error || 'Request failed',
          requestId: json?.request_id || res.headers.get('X-Request-Id')
        };
      }
      return { ok: true, data: json, status: res.status };
    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, aborted: true };
      return { ok: false, status: 0, code: 'NETWORK_ERROR', error: e.message || 'Network error' };
    }
  }

  // MFA prompt — uses AdminSession.verify() if available, otherwise
  // a simple password/code modal. Returns true on success.
  async function promptMFA(triggerBody) {
    if (window.AdminSession && typeof window.AdminSession.verify === 'function') {
      try {
        await window.AdminSession.verify();
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  // ─── REASON MODAL ───────────────────────────────────────────
  function reasonModal({ title, message, confirmText = 'Confirm', kind = 'primary', minLength = 4 }) {
    return new Promise((resolve) => {
      const scrim = document.createElement('div');
      scrim.className = 'modal-scrim open';
      scrim.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h3>${esc(title || 'Confirm')}</h3>
            <button type="button" class="x" data-modal-close><i class="fas fa-xmark"></i></button>
          </div>
          <div class="modal-body">
            ${message ? `<p style="font-size:13px;color:var(--text-dim);line-height:1.5;margin-bottom:14px">${esc(message)}</p>` : ''}
            <div class="form-row">
              <label for="reasonInput">Reason<span class="req">*</span></label>
              <textarea id="reasonInput" rows="3" placeholder="Why? (min ${minLength} chars)"></textarea>
              <div class="help">Recorded in the audit log.</div>
            </div>
          </div>
          <div class="modal-foot">
            <button type="button" class="btn btn-ghost" data-modal-cancel>Cancel</button>
            <button type="button" class="btn btn-${kind}" data-modal-confirm>${esc(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(scrim);
      lockScroll();

      const ta = scrim.querySelector('#reasonInput');
      const confirmBtn = scrim.querySelector('[data-modal-confirm]');
      const close = (result) => {
        scrim.remove();
        unlockScroll();
        resolve(result);
      };
      scrim.addEventListener('click', (e) => {
        if (e.target === scrim) close(null);
        if (e.target.closest('[data-modal-close]') || e.target.closest('[data-modal-cancel]')) close(null);
        if (e.target.closest('[data-modal-confirm]')) {
          const reason = (ta.value || '').trim();
          if (reason.length < minLength) {
            toast(`Reason must be at least ${minLength} characters.`, 'error');
            return;
          }
          close(reason);
        }
      });
      setTimeout(() => ta.focus(), 50);
    });
  }

  // ─── CONFIRM MODAL ──────────────────────────────────────────
  function confirmModal({ title, message, confirmText = 'Confirm', kind = 'primary' }) {
    return new Promise((resolve) => {
      const scrim = document.createElement('div');
      scrim.className = 'modal-scrim open';
      scrim.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h3>${esc(title || 'Confirm')}</h3>
            <button type="button" class="x" data-modal-close><i class="fas fa-xmark"></i></button>
          </div>
          <div class="modal-body">
            <p style="font-size:13px;color:var(--text-dim);line-height:1.55">${esc(message || 'Are you sure?')}</p>
          </div>
          <div class="modal-foot">
            <button type="button" class="btn btn-ghost" data-modal-cancel>Cancel</button>
            <button type="button" class="btn btn-${kind}" data-modal-confirm>${esc(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(scrim);
      lockScroll();
      const close = (result) => { scrim.remove(); unlockScroll(); resolve(result); };
      scrim.addEventListener('click', (e) => {
        if (e.target === scrim) close(false);
        if (e.target.closest('[data-modal-close]') || e.target.closest('[data-modal-cancel]')) close(false);
        if (e.target.closest('[data-modal-confirm]')) close(true);
      });
    });
  }

  // ─── CSV DOWNLOAD ──────────────────────────────────────────
  async function downloadCsv(url, { filename = 'export.csv', method = 'GET', body = null, headers = {} } = {}) {
    if (!window.AdminSession || typeof window.AdminSession.fetch !== 'function') {
      toast('Session not loaded.', 'error');
      return false;
    }
    try {
      const res = await AdminSession.fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined
      });
      if (!res.ok) {
        let err = null;
        try { err = await res.json(); } catch (_) {}
        toast(err?.error || `Export failed (${res.status})`, 'error');
        return false;
      }
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/csv')) {
        let err = null;
        try { err = await res.json(); } catch (_) {}
        toast(err?.error || 'Server returned no CSV.', 'error');
        return false;
      }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(objUrl); } catch (_) {} }, 2000);
      return true;
    } catch (e) {
      toast('Export failed: ' + (e.message || 'network'), 'error');
      return false;
    }
  }

  // ─── URL STATE ─────────────────────────────────────────────
  function getUrlState() {
    return new URLSearchParams(window.location.search);
  }
  function setUrlState(params, { replace = true } = {}) {
    const url = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }

  // ─── RENDER SIDEBAR ────────────────────────────────────────
  function renderSidebar(activeKey) {
    const brandHtml = `
      <div class="brand">
        <img src="/images/miles.png" alt="" onerror="this.style.display='none'">
        <div class="brand-text">
          <strong>MilesSpace</strong>
          <span>Admin Console</span>
        </div>
        <button class="sb-collapse-btn" id="sbCollapseBtn" aria-label="Collapse sidebar" type="button">
          <i class="fas fa-angles-left"></i>
        </button>
      </div>`;
    const navHtml = NAV.map(group => `
      <span class="nav-label">${esc(group.label)}</span>
      ${group.items.map(item => `
        <a href="${esc(item.href)}" class="nav-item ${item.key === activeKey ? 'active' : ''}" ${item.key === activeKey ? 'aria-current="page"' : ''}>
          <span class="ic"><i class="fas ${esc(item.icon)}"></i></span>
          <span class="txt">${esc(item.label)}</span>
          ${item.badgeKey ? `<span class="badge-count" data-badge="${esc(item.badgeKey)}" hidden>0</span>` : ''}
        </a>`).join('')}
    `).join('');
    const footHtml = `
      <div class="sidebar-foot" role="button" tabindex="0" id="sidebarFoot" aria-label="Admin account settings">
        <div class="av" id="adminAvatar">AD</div>
        <div class="who">
          <strong id="adminName">Admin</strong>
          <span id="adminRole">admin</span>
        </div>
      </div>`;
    return `<aside class="sidebar" id="sidebar" aria-label="Admin navigation">
      ${brandHtml}
      <nav class="nav-scroll" role="navigation">${navHtml}</nav>
      ${footHtml}
    </aside>
    <div class="scrim" id="scrim" aria-hidden="true"></div>`;
  }

  // ─── RENDER TOPBAR ─────────────────────────────────────────
  function renderTopbar({ title, breadcrumb }) {
    const crumbHtml = breadcrumb && Array.isArray(breadcrumb)
      ? breadcrumb.map((part, i) => {
        const el = part.href
          ? `<a href="${esc(part.href)}" style="color:inherit;text-decoration:none">${esc(part.label)}</a>`
          : `<span>${esc(part.label)}</span>`;
        return i > 0 ? `<span>/</span>${el}` : el;
      }).join('')
      : '';
    return `<header class="topbar">
      <button class="hamburger" id="hamburger" aria-label="Open navigation" type="button">
        <i class="fas fa-bars"></i>
      </button>
      <button class="sb-toggle-desktop" id="sbToggleDesktop" aria-label="Toggle sidebar" type="button">
        <i class="fas fa-bars"></i>
      </button>
      <div class="topbar-left">
        <div class="page-title">
          <h1>${esc(title || 'Admin')}</h1>
          <div class="crumb">
            <span class="live-dot" aria-hidden="true"></span>
            ${crumbHtml}
          </div>
        </div>
      </div>
      <div class="topbar-right">
        <button class="icon-btn" id="themeToggle" aria-label="Toggle dark mode" type="button">
          <i class="fas fa-moon"></i>
        </button>
        <div class="admin-chip" title="Signed in admin">
          <div class="av" id="chipAvatar">AD</div>
          <div class="info">
            <strong id="chipName">Admin</strong>
            <span id="chipRole">admin</span>
          </div>
        </div>
      </div>
    </header>`;
  }

  // ─── THEME ─────────────────────────────────────────────────
  function initTheme() {
    const isDark = document.documentElement.classList.contains('dark');
    const btn = document.getElementById('themeToggle');
    if (btn) btn.innerHTML = `<i class="fas ${isDark ? 'fa-sun' : 'fa-moon'}"></i>`;
    btn?.addEventListener('click', () => {
      const dark = !document.documentElement.classList.contains('dark');
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.classList.toggle('light', !dark);
      try { localStorage.setItem('ms-theme', dark ? 'dark' : 'light'); } catch (_) {}
      btn.innerHTML = `<i class="fas ${dark ? 'fa-sun' : 'fa-moon'}"></i>`;
    });
  }

  // ─── IDENTITY ──────────────────────────────────────────────
  function initIdentity() {
    try {
      const u = window.AdminSession?.getUser?.();
      if (!u) return;
      const name = u.name || u.username || u.email || 'Admin';
      const role = u.role || 'admin';
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('adminName', name);
      set('adminRole', role);
      set('chipName', name);
      set('chipRole', role);
      set('adminAvatar', initials(name));
      set('chipAvatar', initials(name));
    } catch (_) {}
  }

  // ─── SIDEBAR INTERACTIONS ──────────────────────────────────
  function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const scrim = document.getElementById('scrim');
    const hbg = document.getElementById('hamburger');
    const app = document.getElementById('appRoot');
    if (!sidebar || !app) return;

    const isMobile = () => window.matchMedia('(max-width:900px)').matches;

    function openMobile() {
      if (!isMobile()) return;
      sidebar.classList.add('open');
      scrim?.classList.add('show');
      hbg?.setAttribute('aria-expanded', 'true');
      document.body.classList.add('sb-open');
    }
    function closeMobile() {
      sidebar.classList.remove('open');
      scrim?.classList.remove('show');
      hbg?.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('sb-open');
    }

    hbg?.addEventListener('click', () => {
      if (sidebar.classList.contains('open')) closeMobile();
      else openMobile();
    });
    scrim?.addEventListener('click', closeMobile);

    sidebar.querySelectorAll('.nav-item').forEach(a => {
      a.addEventListener('click', () => { if (isMobile()) closeMobile(); });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sidebar.classList.contains('open')) closeMobile();
    });
    window.addEventListener('resize', () => { if (!isMobile()) closeMobile(); });

    // Collapse
    const applyCollapsed = (v) => {
      app.classList.toggle('sb-collapsed', v);
      try { localStorage.setItem('ms_sb_collapsed', v ? '1' : '0'); } catch (_) {}
    };
    try { if (localStorage.getItem('ms_sb_collapsed') === '1') app.classList.add('sb-collapsed'); } catch (_) {}
    document.getElementById('sbCollapseBtn')?.addEventListener('click', () => applyCollapsed(!app.classList.contains('sb-collapsed')));
    document.getElementById('sbToggleDesktop')?.addEventListener('click', () => applyCollapsed(!app.classList.contains('sb-collapsed')));

    // Sidebar footer click → settings
    document.getElementById('sidebarFoot')?.addEventListener('click', () => {
      window.location.href = '/admin/settings.html';
    });
  }

  // ─── INIT ──────────────────────────────────────────────────
  function init(options = {}) {
    const { activeKey = '', title = 'Admin', breadcrumb = [] } = options;
    const root = document.getElementById('appRoot');
    if (!root) return;

    // Inject sidebar + scrim
    root.innerHTML = renderSidebar(activeKey) + '<div class="main" id="main">' + renderTopbar({ title, breadcrumb }) + '<div class="content" id="content"></div></div>';

    initIdentity();
    initTheme();
    initSidebar();

    // Copy buttons (delegated)
    document.body.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) {
        e.preventDefault();
        const text = copyBtn.getAttribute('data-copy');
        if (text) copyText(text).then(ok => ok && toast('Copied.', 'success', 1200));
      }
    });
  }

  // ─── EXPORT ───────────────────────────────────────────────
  global.MS = {
    NAV,
    init,
    // Utilities
    esc,
    initials,
    fmtMoney,
    fmtInt,
    timeAgo,
    fmtDateTime,
    debounce,
    copyText,
    toast,
    lockScroll,
    unlockScroll,
    // Modal
    reasonModal,
    confirmModal,
    // API
    api,
    // CSV
    downloadCsv,
    // URL state
    getUrlState,
    setUrlState,
    // Refs
    get $() { return (s, r = document) => r.querySelector(s); },
    get $$() { return (s, r = document) => Array.from(r.querySelectorAll(s)); },
  };

})(window);