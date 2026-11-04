/* ═══════════════════════════════════════════════════════════════════════
   MilesSpace Shell — shared sidebar, stale banner, history drawer.
   Load with `defer`. Exposes window.MS.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  window.MS = window.MS || {};

  /* ── 1. Escaper ──────────────────────────────────────────────────── */
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* ── 2. Provider / status scrubbing ──────────────────────────────── */
  const PROVIDER_RE = /dt\s*-?one|dtone|vt\s*-?pass|kora\s*-?pay|\bkora\b|now\s*-?payments/gi;

  function safeText(s) {
    if (typeof s !== 'string') return s;
    return s.replace(PROVIDER_RE, 'our service partner');
  }

  const SAFE_KEYS = new Set([
    'error', 'message', 'failure_message', 'failureReason', 'errorMessage',
    'status_message', 'description', 'reason', 'title'
  ]);

  function scrubDeep(obj, depth) {
    if (depth > 5 || obj == null) return obj;
    if (Array.isArray(obj)) {
      if (obj.length > 300) return obj;
      for (let i = 0; i < obj.length; i++) {
        const v = obj[i];
        if (v && typeof v === 'object') scrubDeep(v, depth + 1);
        else if (typeof v === 'string') { /* leave as-is — arrays use index, not key */ }
      }
      return obj;
    }
    if (typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (SAFE_KEYS.has(k) && typeof v === 'string') {
          obj[k] = safeText(v);
        } else if (v && typeof v === 'object') {
          scrubDeep(v, depth + 1);
        }
      }
    }
    return obj;
  }

  /* Wrap window.userFetch once */
  if (typeof window.userFetch === 'function' && !window.__msWrapped) {
    window.__msWrapped = true;
    const orig = window.userFetch;
    window.userFetch = function () {
      const result = orig.apply(this, arguments);
      if (!result || typeof result.then !== 'function') return result;

      return result.then(res => {
        try {
          const url = String(arguments[0] || '');
          const isScoped = /(history|transactions|orders|status|check|purchase|deposit|wallet|notifications)/i.test(url);
          if (!isScoped || !res || typeof res.json !== 'function') return res;

          const origJson = res.json.bind(res);
          let cached = null;
          let called = false;

          res.json = function () {
            if (called) return Promise.resolve(cached);
            called = true;
            return origJson().then(body => {
              cached = scrubDeep(body, 0);
              return cached;
            });
          };
        } catch (_) { /* silent */ }
        return res;
      });
    };
  }

  /* ── Status normalisation ────────────────────────────────────────── */
  const STATUS_MAP = {
    completed: 'completed', success: 'completed', successful: 'completed',
    finished: 'completed', delivered: 'completed', sms_received: 'completed',
    pending: 'pending', initiated: 'pending', waiting: 'pending',
    awaiting_payment: 'pending', created: 'pending', queued: 'pending',
    partial: 'pending',
    processing: 'processing', in_progress: 'processing',
    provider_unknown: 'processing', confirming: 'processing',
    confirmed: 'processing', submitted: 'processing', active: 'processing',
    under_review: 'manual_review', manual_review: 'manual_review',
    partially_paid: 'manual_review', review: 'manual_review',
    failed: 'failed', declined: 'failed', error: 'failed', expired: 'failed',
    rejected: 'failed', cancelled: 'failed', canceled: 'failed',
    refunded: 'refunded', reversed: 'refunded'
  };

  function statusKey(s) {
    return STATUS_MAP[String(s || '').toLowerCase()] || 'pending';
  }

  function statusLabel(s) {
    const raw = String(s || '');
    const k = statusKey(raw);
    if (k === 'completed')    return 'Completed';
    if (k === 'pending')      return 'Pending';
    if (k === 'processing')   return 'Processing';
    if (k === 'manual_review') return 'Under review';
    if (k === 'refunded')     return 'Refunded';
    if (k === 'failed') {
      const low = raw.toLowerCase();
      if (low === 'cancelled' || low === 'canceled') return 'Cancelled';
      return 'Failed';
    }
    if (raw.toLowerCase() === 'partial') return 'Partial';
    if (raw.toLowerCase() === 'active')  return 'Active';
    // Fallback: title-case, but never leak provider_unknown / manual_review
    if (/provider/.test(raw.toLowerCase())) return 'Processing';
    return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Pending';
  }

  /* ── 3. Shell (sidebar) ──────────────────────────────────────────── */

  const MENU = [
    { href: 'dashboard.html',   label: 'Dashboard',              icon: 'fa-home' },
    { href: 'boost.html',       label: 'Social Boosting',        icon: 'fa-chart-line' },
    { href: 'virtual.html',     label: 'Virtual Numbers',        icon: 'fa-phone-alt' },
    { href: 'market.html',      label: 'Marketplace',            icon: 'fa-store' },
    { href: 'airtime.html',     label: 'Global Airtime',         icon: 'fa-globe' },
    { href: 'bills.html',       label: 'Airtime, Data & Bills',  icon: 'fa-file-invoice-dollar' },
    { href: 'esim.html',        label: 'Buy eSIM',               icon: 'fa-sim-card' },
    { href: 'giftcards.html',   label: 'Gift Cards',             icon: 'fa-gift' },
    { href: 'history.html',     label: 'History',                icon: 'fa-history' },
    { href: 'fund.html',        label: 'Fund Account',           icon: 'fa-wallet' }
  ];

  const ACCOUNT = [
    { href: 'usersettings.html',  label: 'Settings',      icon: 'fa-user-cog' },
    { href: 'notifications.html', label: 'Notifications', icon: 'fa-bell' }
  ];

  function currentPage() {
    const base = (location.pathname.split('/').pop() || '').split('?')[0].split('#')[0];
    return base || 'dashboard.html';
  }

  function buildMenuMarkup() {
    const page = currentPage();
    const menuHtml = MENU.map(l => {
      const active = l.href === page;
      return `<a href="${esc(l.href)}" class="sb-lnk${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}><i class="fas ${esc(l.icon)}"></i> ${esc(l.label)}</a>`;
    }).join('');

    const accHtml = ACCOUNT.map(l => {
      const active = l.href === page;
      return `<a href="${esc(l.href)}" class="sb-lnk${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}><i class="fas ${esc(l.icon)}"></i> ${esc(l.label)}</a>`;
    }).join('');

    return `
      <div class="sb-brand">
        <div class="sb-lic"><img src="/images/miles.png" alt="MilesSpace" onerror="this.style.display='none'"></div>
        MilesSpace
      </div>
      <p class="sb-sec">Menu</p>
      <nav class="sb-nav">${menuHtml}</nav>
      <p class="sb-sec">Account</p>
      <nav class="sb-nav">${accHtml}</nav>
    `;
  }

  function buildFootMarkup() {
    return `
      <div class="sb-prof">
        <a href="usersettings.html" class="sb-prof-link">
          <div id="sbAv">U</div>
          <div class="sb-ui">
            <p id="sbName">Loading…</p>
            <p id="sbEmail"></p>
          </div>
        </a>
        <button id="logoutBtn" title="Logout" aria-label="Logout">
          <i class="fas fa-sign-out-alt"></i>
        </button>
      </div>
    `;
  }

  function fillUserFields() {
    const u = (typeof window.getUser === 'function') ? window.getUser() : null;
    if (!u) return;
    const name = u.username || u.full_name || u.email?.split('@')[0] || 'User';
    const initial = name.charAt(0).toUpperCase() || 'U';

    const sbName = document.getElementById('sbName');
    const sbEmail = document.getElementById('sbEmail');
    const sbAv = document.getElementById('sbAv');

    if (sbName) sbName.textContent = name;
    if (sbEmail) sbEmail.textContent = u.email || '';
    if (sbAv && !sbAv.querySelector('img')) {
      sbAv.textContent = initial;
    }
  }

  function initSidebar() {
    const sb = document.getElementById('sb');
    if (!sb || sb.dataset.msBound === '1') return;
    sb.dataset.msBound = '1';

    sb.classList.add('sidebar');

    // Preserve the existing .sb-foot so page scripts keep their refs
    const existingFoot = sb.querySelector('.sb-foot');

    // Build and insert new markup BEFORE the foot
    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildMenuMarkup();
    const brandNode = wrapper.children;

    // Clear everything except .sb-foot
    Array.from(sb.children).forEach(child => {
      if (child !== existingFoot) child.remove();
    });

    // Prepend the new markup
    const fragment = document.createDocumentFragment();
    while (brandNode.length) fragment.appendChild(brandNode[0]);
    sb.insertBefore(fragment, sb.firstChild);

    // If .sb-foot missing, add it at the end
    if (!existingFoot) {
      const footEl = document.createElement('div');
      footEl.className = 'sb-foot';
      footEl.innerHTML = buildFootMarkup();
      sb.appendChild(footEl);
    } else {
      // Ensure IDs exist in the existing foot
      if (!existingFoot.querySelector('#sbAv')) {
        const av = document.createElement('div');
        av.id = 'sbAv';
        av.textContent = 'U';
        existingFoot.insertBefore(av, existingFoot.firstChild);
      }
    }

    // Ensure overlay exists
    let ov = document.getElementById('ov');
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'ov';
      ov.id = 'ov';
      document.body.insertBefore(ov, document.body.firstChild);
    }
    ov.classList.add('ov');

    fillUserFields();
    window.addEventListener('session:ready', fillUserFields);

    // Open / close with capture to block page handlers
    function isOpen() { return sb.classList.contains('open'); }
    function open() {
      sb.classList.add('open');
      ov.classList.add('on');
      document.body.classList.add('sb-open');
      document.body.classList.add('lock');
      const hbg = document.getElementById('hbg');
      if (hbg) hbg.setAttribute('aria-expanded', 'true');
    }
    function close() {
      sb.classList.remove('open');
      ov.classList.remove('on');
      document.body.classList.remove('sb-open');
      document.body.classList.remove('lock');
      const hbg = document.getElementById('hbg');
      if (hbg) hbg.setAttribute('aria-expanded', 'false');
    }
    function toggle() { isOpen() ? close() : open(); }

    window.addEventListener('click', function (e) {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#hbg')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggle();
        return;
      }
      if (t.closest('#ov')) {
        e.stopImmediatePropagation();
        close();
        return;
      }
      if (t.closest('#sb .sb-lnk')) {
        close();
      }
    }, true);

    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) {
        e.stopImmediatePropagation();
        close();
      }
    }, true);

    // Expose for pages that want it
    window.MS.sidebar = { open, close, toggle, isOpen };
  }

  /* ── 4. SWR ──────────────────────────────────────────────────────── */
  function swr(key, fetcher, render, opts) {
    const ttl = (opts && opts.ttl) || 300000;
    const user = (typeof window.getUser === 'function') ? window.getUser() : null;
    const nsKey = 'ms:' + (user && user.id || 'anon') + ':' + key;

    let cached = null;
    try {
      const raw = sessionStorage.getItem(nsKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && (Date.now() - parsed.t) < ttl) cached = parsed.data;
      }
    } catch (_) { /* ignore */ }

    if (cached) {
      try { render(cached, true); } catch (e) { /* swallow */ }
    }

    return Promise.resolve()
      .then(fetcher)
      .then(fresh => {
        if (fresh == null) return fresh;
        try { sessionStorage.setItem(nsKey, JSON.stringify({ t: Date.now(), data: fresh })); } catch (_) {}
        try { render(fresh, false); } catch (e) { /* swallow */ }
        return fresh;
      })
      .catch(err => {
        // Do not cache errors
        throw err;
      });
  }

  /* ── 5. History drawer ───────────────────────────────────────────── */
  function historyDrawer(opts) {
    const id = opts.id || ('ms-hist-' + Math.random().toString(36).slice(2, 8));
    const title = opts.title || 'History';
    const subtitle = opts.subtitle || '';
    const pageSize = opts.pageSize || 20;
    const emptyText = opts.emptyText || 'Nothing here yet.';
    const keyOf = opts.keyOf || ((it, i) => (it && (it.id || it.reference)) || i);

    // Build DOM once per id
    let ov = document.querySelector('.ms-hd-ov[data-for="' + id + '"]');
    let drawer = document.querySelector('.ms-hd[data-for="' + id + '"]');

    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'ms-hd-ov';
      ov.setAttribute('data-for', id);
      document.body.appendChild(ov);
    }
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.className = 'ms-hd';
      drawer.setAttribute('data-for', id);
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-modal', 'true');
      drawer.setAttribute('aria-labelledby', id + '-title');
      drawer.innerHTML = `
        <div class="ms-hd-head">
          <div class="ms-hd-head-text">
            <div class="ms-hd-title-main" id="${esc(id)}-title">${esc(title)}</div>
            <div class="ms-hd-subtitle">${esc(subtitle)}</div>
          </div>
          <button class="ms-hd-close" type="button" aria-label="Close">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="ms-hd-list" id="${esc(id)}-list"></div>
      `;
      document.body.appendChild(drawer);
    }

    const listEl = drawer.querySelector('.ms-hd-list');
    const closeBtn = drawer.querySelector('.ms-hd-close');

    let items = [];
    let page = 1;
    let hasMore = false;
    let loading = false;
    let lastFocus = null;

    const api = {
      id,
      items,
      listEl,
      open,
      close,
      reload,
      appendPage
    };

    function setScrollLock(on) {
      document.body.classList.toggle('lock', on);
    }

    function close() {
      drawer.classList.remove('open');
      ov.classList.remove('on');
      setScrollLock(false);
      if (lastFocus && typeof lastFocus.focus === 'function') {
        try { lastFocus.focus(); } catch (_) {}
      }
      lastFocus = null;
    }

    function showSkeletons() {
      listEl.innerHTML = Array(3).fill(
        '<div class="ms-hd-skel"><div class="sk-line"></div><div class="sk-line short"></div></div>'
      ).join('');
    }

    function showError(err) {
      listEl.innerHTML = `<div class="ms-hd-empty">
        <i class="fas fa-triangle-exclamation" style="color:#ef4444"></i>
        <div style="font-weight:700;color:#0f1b3d;margin-bottom:4px">Could not load history</div>
        <div style="margin-bottom:12px">${esc(err && err.message || 'Please try again.')}</div>
        <button class="ms-hd-more" type="button" data-retry="1">Retry</button>
      </div>`;
      const rb = listEl.querySelector('[data-retry]');
      if (rb) rb.addEventListener('click', () => reload());
    }

    function renderItems(reset) {
      if (!items.length) {
        listEl.innerHTML = `<div class="ms-hd-empty"><i class="fas fa-inbox"></i>${esc(emptyText)}</div>`;
        listEl.dispatchEvent(new CustomEvent('ms:list-rendered', { bubbles: true }));
        return;
      }

      const itemsHtml = items.map((it, i) => {
        try {
          return opts.render(it, i);
        } catch (e) {
          return `<div class="ms-hd-item" data-i="${i}"><div class="ms-hd-title">Render error</div></div>`;
        }
      }).join('');

      const moreHtml = hasMore
        ? `<button class="ms-hd-more" type="button" data-more="1">Load more</button>`
        : '';

      listEl.innerHTML = itemsHtml + moreHtml;

      // attach data-i to each rendered item
      listEl.querySelectorAll('.ms-hd-item').forEach((el, i) => {
        if (!el.hasAttribute('data-i')) el.setAttribute('data-i', String(i));
        el.addEventListener('click', () => {
          const idx = Number(el.dataset.i);
          const it = items[idx];
          if (!it) return;
          try { close(); } catch (_) {}
          if (typeof opts.onItemClick === 'function') opts.onItemClick(it, idx, el);
        });
      });

      const moreBtn = listEl.querySelector('[data-more]');
      if (moreBtn) {
        moreBtn.addEventListener('click', () => appendPage());
      }

      listEl.dispatchEvent(new CustomEvent('ms:list-rendered', { bubbles: true }));
    }

    function appendPage() {
      if (loading || !hasMore) return;
      loading = true;
      page += 1;
      const moreBtn = listEl.querySelector('[data-more]');
      if (moreBtn) {
        moreBtn.disabled = true;
        moreBtn.textContent = 'Loading…';
      }

      Promise.resolve()
        .then(() => opts.load(page, pageSize))
        .then(res => {
          const fresh = (res && res.items) || [];
          hasMore = !!(res && res.hasMore);
          const seen = new Set(items.map((it, i) => keyOf(it, i)));
          for (const it of fresh) {
            const k = keyOf(it, -1);
            if (seen.has(k)) continue;
            seen.add(k);
            items.push(it);
          }
          api.items = items;
          renderItems(false);
        })
        .catch(err => {
          if (moreBtn) {
            moreBtn.disabled = false;
            moreBtn.textContent = 'Load more';
          }
          // Silent — user can retry
        })
        .finally(() => {
          loading = false;
        });
    }

    function reload() {
      page = 1;
      items = [];
      api.items = items;
      showSkeletons();
      loading = true;

      Promise.resolve()
        .then(() => opts.load(1, pageSize))
        .then(res => {
          items = (res && res.items) || [];
          hasMore = !!(res && res.hasMore);
          api.items = items;
          renderItems(true);
        })
        .catch(err => showError(err))
        .finally(() => {
          loading = false;
        });
    }

    function open() {
      lastFocus = document.activeElement;
      drawer.classList.add('open');
      ov.classList.add('on');
      setScrollLock(true);
      reload();
    }

    // Close handlers
    if (ov.dataset.bound !== '1') {
      ov.dataset.bound = '1';
      ov.addEventListener('click', close);
    }
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.classList.contains('open')) close();
    });

    return api;
  }

  /* ── 6. Stale banner ─────────────────────────────────────────────── */
  const staleMaps = {
    lastMessage: new Map(),
    cooldownUntil: new Map(),
    terminal: new Map(),
    blocked: new Map(),
    inFlight: new Map()
  };

  function parseTimestamp(ts) {
    if (!ts) return NaN;
    let s = String(ts);
    // If no timezone designator, treat as UTC
    if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(s)) {
      s = s.replace(' ', 'T') + 'Z';
    }
    return new Date(s).getTime();
  }

  function normaliseRec(rec) {
    if (!rec) return null;
    const ref = rec.reference || rec.ref || rec.orderRef || rec.order_ref
      || rec.transactionId || rec.id;
    const created = rec.created_at || rec.createdAt || rec.created;
    const status = String(rec.status || '').toLowerCase();
    return { ref, created, status, _raw: rec };
  }

  function bannerMessage(status) {
    const k = statusKey(status);
    if (k === 'manual_review') {
      return { main: 'A specialist is checking this for you.', tail: '' };
    }
    if (k === 'processing') {
      return { main: 'Confirming with the provider.', tail: ' Most complete within a few more minutes.' };
    }
    return { main: 'Taking longer than expected.', tail: ' Most complete within a few more minutes.' };
  }

  function staleInit(cfg) {
    const rowsSel = cfg.rows;
    if (!rowsSel) return;
    const staleMs = cfg.staleMs || 600000;
    const stalable = cfg.stalable || ['pending', 'processing', 'under_review', 'provider_unknown', 'manual_review'];
    const stalableSet = new Set(stalable.map(s => s.toLowerCase()));
    const mountMode = cfg.mount || 'after';
    const colspan = cfg.colspan || 1;
    const observeSel = cfg.observe || 'body';
    const toastFn = cfg.toast || function () {};
    const refreshFn = cfg.refresh || function () {};

    function isStale(rec) {
      const n = normaliseRec(rec);
      if (!n || !n.ref) return false;
      if (!stalableSet.has(n.status)) return false;
      const t = parseTimestamp(n.created);
      if (!isFinite(t)) return false;
      return (Date.now() - t) > staleMs;
    }

    function rowFor(el) {
      try { return cfg.record(el) || null; } catch (_) { return null; }
    }

    function findBannerAfter(el) {
      if (mountMode === 'tr') {
        const next = el.nextElementSibling;
        if (next && next.classList && next.classList.contains('ms-stale-tr')) return next;
        return null;
      }
      const next = el.nextElementSibling;
      if (next && next.classList && next.classList.contains('tx-stale-banner')) return next;
      if (el.querySelector) {
        const inner = el.querySelector('.tx-stale-banner');
        if (inner) return inner;
      }
      return null;
    }

    function buildBanner(ref, status) {
      const { main, tail } = bannerMessage(status);
      const wrap = document.createElement('div');
      wrap.className = 'tx-stale-banner';
      wrap.setAttribute('role', 'status');
      wrap.innerHTML = '<span><strong>' + esc(main) + '</strong>' + esc(tail) + '</span>' +
        '<button type="button" data-check="' + esc(String(ref)) + '">Check status</button>';
      return wrap;
    }

    function applyCooldown(btn, ref) {
      const until = staleMaps.cooldownUntil.get(ref);
      if (until && until > Date.now()) {
        btn.disabled = true;
        btn.textContent = 'Wait a moment';
        const ms = until - Date.now();
        setTimeout(() => {
          if (staleMaps.cooldownUntil.get(ref) <= Date.now()) {
            staleMaps.cooldownUntil.delete(ref);
            if (btn.isConnected) {
              btn.disabled = false;
              btn.textContent = 'Check status';
            }
          }
        }, Math.min(ms, 120000));
        return true;
      }
      return false;
    }

    function wireButton(banner, ref) {
      const btn = banner.querySelector('button[data-check]');
      if (!btn) return;

      const last = staleMaps.lastMessage.get(ref);
      if (last) {
        const span = banner.querySelector('span');
        if (span) span.innerHTML = '<strong>' + esc(last) + '</strong>';
      }

      if (staleMaps.terminal.get(ref)) {
        btn.remove();
        return;
      }
      if (staleMaps.blocked.get(ref)) {
        btn.disabled = true;
        btn.textContent = 'Contact support';
        return;
      }
      if (applyCooldown(btn, ref)) return;

      btn.addEventListener('click', function () {
        if (staleMaps.inFlight.get(ref)) return;
        staleMaps.inFlight.set(ref, true);
        btn.disabled = true;
        btn.textContent = 'Checking…';

        const fetcher = (typeof window.userFetch === 'function')
          ? window.userFetch
          : function (url, o) { return fetch(url, Object.assign({}, o, { credentials: 'include' })); };

        fetcher('/api/transactions/' + encodeURIComponent(ref) + '/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
        })
          .then(function (resp) {
            return resp.json().catch(() => ({})).then(function (body) {
              return { ok: resp.ok, status: resp.status, body };
            });
          })
          .then(function (r) {
            staleMaps.inFlight.delete(ref);

            if (r.ok && r.body && r.body.data) {
              const data = r.body.data;
              const msg = safeText(data.status_message || 'Updated.');
              staleMaps.lastMessage.set(ref, msg);
              const span = banner.querySelector('span');
              if (span) span.innerHTML = '<strong>' + esc(msg) + '</strong>';

              const k = statusKey(data.status);
              const raw = String(data.status || '').toLowerCase();
              if (k === 'completed' || k === 'failed' || k === 'refunded' || raw === 'cancelled' || raw === 'reversed') {
                staleMaps.terminal.set(ref, true);
                btn.remove();
                toastFn('Status updated.', 'ok');
                setTimeout(() => { try { refreshFn(); } catch (_) {} }, 400);
              } else {
                btn.disabled = false;
                btn.textContent = 'Check status';
              }
              return;
            }

            if (r.status === 429) {
              const wait = Math.max(1000, Math.min(120000,
                (r.body && (r.body.retry_after_ms || (r.body.data && r.body.data.retry_after_ms))) || 30000));
              staleMaps.cooldownUntil.set(ref, Date.now() + wait);
              btn.textContent = 'Wait a moment';
              setTimeout(() => {
                if (staleMaps.cooldownUntil.get(ref) <= Date.now()) {
                  staleMaps.cooldownUntil.delete(ref);
                  if (btn.isConnected) {
                    btn.disabled = false;
                    btn.textContent = 'Check status';
                  }
                }
              }, wait);
              return;
            }

            if (r.status === 404 || (r.status === 400 && /NOT_FOUND|UNSUPPORTED/.test(String((r.body && r.body.code) || '')))) {
              const msg = "We couldn't re-check this automatically. Please contact support with reference " + ref + ".";
              staleMaps.lastMessage.set(ref, msg);
              staleMaps.blocked.set(ref, true);
              const span = banner.querySelector('span');
              if (span) span.innerHTML = '<strong>' + esc(msg) + '</strong>';
              btn.disabled = true;
              btn.textContent = 'Contact support';
              return;
            }

            if (r.status === 401) {
              if (window.redirectToUserLogin) window.redirectToUserLogin();
              return;
            }

            btn.disabled = false;
            btn.textContent = 'Check status';
            const errMsg = safeText((r.body && r.body.error) || 'Could not check status right now.');
            try { toastFn(errMsg, 'err'); } catch (_) {}
          })
          .catch(function () {
            staleMaps.inFlight.delete(ref);
            btn.disabled = false;
            btn.textContent = 'Check status';
            try { toastFn('Could not check status right now.', 'err'); } catch (_) {}
          });
      });
    }

    function injectBanner(el, rec) {
      const n = normaliseRec(rec);
      if (!n || !n.ref) return;

      const existing = findBannerAfter(el);
      if (existing) {
        // Refresh button state on re-render
        const btn = existing.querySelector('button[data-check]');
        if (btn) {
          if (staleMaps.terminal.get(n.ref)) btn.remove();
          else if (staleMaps.blocked.get(n.ref)) {
            btn.disabled = true;
            btn.textContent = 'Contact support';
          } else {
            applyCooldown(btn, n.ref);
          }
        }
        return;
      }

      const banner = buildBanner(n.ref, n.status);

      if (mountMode === 'tr') {
        const tr = document.createElement('tr');
        tr.className = 'ms-stale-tr';
        const td = document.createElement('td');
        td.setAttribute('colspan', String(colspan));
        td.appendChild(banner);
        tr.appendChild(td);
        el.parentNode.insertBefore(tr, el.nextSibling);
      } else {
        el.parentNode.insertBefore(banner, el.nextSibling);
      }

      wireButton(banner, n.ref);
    }

    function isVisible(el) {
      return el.getClientRects().length > 0;
    }

    let scanning = false;
    function scan() {
      if (scanning) return;
      scanning = true;
      try {
        const rows = document.querySelectorAll(rowsSel);
        let soonest = Infinity;
        const now = Date.now();

        rows.forEach(el => {
          if (!isVisible(el)) {
            // Remove banner for a now-hidden row (fund.html desktop/mobile swap)
            const ex = findBannerAfter(el);
            if (ex) ex.remove();
            return;
          }
          const rec = rowFor(el);
          const n = normaliseRec(rec);
          if (!n || !n.ref) return;

          if (isStale(rec)) {
            injectBanner(el, rec);
          } else if (stalableSet.has(n.status)) {
            const t = parseTimestamp(n.created);
            if (isFinite(t)) {
              const wait = t + staleMs - now;
              if (wait > 0 && wait < soonest) soonest = wait;
            }
          }
        });

        if (isFinite(soonest) && soonest > 0) {
          const delay = Math.max(1000, Math.min(600000, soonest));
          setTimeout(scan, delay);
        }
      } finally {
        scanning = false;
      }
    }

    let debounce = null;
    const observer = new MutationObserver(muts => {
      // Ignore mutations that only add/remove our own banner nodes
      let relevant = false;
      for (const m of muts) {
        if (m.type !== 'childList') continue;
        const all = [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)];
        for (const n of all) {
          if (n.nodeType === 1 && (n.classList.contains('tx-stale-banner') || n.classList.contains('ms-stale-tr'))) continue;
          relevant = true;
          break;
        }
        if (relevant) break;
      }
      if (!relevant) return;
      clearTimeout(debounce);
      debounce = setTimeout(scan, 250);
    });

    const observeEl = document.querySelector(observeSel) || document.body;
    observer.observe(observeEl, { childList: true, subtree: true });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(scan, 200);
    });
    window.addEventListener('orientationchange', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(scan, 300);
    });

    scan();
  }

  /* ── 7. Assemble ─────────────────────────────────────────────────── */
  Object.assign(window.MS, {
    esc,
    safeText,
    statusKey,
    statusLabel,
    swr,
    historyDrawer,
    stale: { init: staleInit }
  });

  /* ── 8. Boot the sidebar on DOM ready ────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSidebar, { once: true });
  } else {
    initSidebar();
  }
})();