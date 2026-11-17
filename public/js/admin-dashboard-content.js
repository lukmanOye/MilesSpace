// /js/admin-dashboard-content.js
// Dashboard Content panel for settings.html.
// Independent of admin-settings.js. Talks directly to
// /api/admin/ticker/* and /api/admin/announcements/*.
//
// Loaded with `defer` so DOM is available and it runs after
// admin-settings.js has initialized the sidebar/panels.
//
// Hard rules observed:
//  - No inline event handlers.
//  - No raw user text into innerHTML: every dynamic value goes
//    through esc().
//  - No floating math on money. No money here, but no parseFloat.
//  - Link validation matches the server: /path (not //) or https://.
//  - 44px touch targets, 16px inputs, safe-area padding on mobile.

(function () {
  'use strict';

  if (!document.getElementById('panel-dashboard-content')) return;

  // ── Page link catalogue, defined once ─────────────────────────
  // Groups render as <optgroup> in the Link select.
  var PAGE_LINKS = [
    { group: 'Wallet', links: [
      { label: 'Fund Wallet',        value: '/fund.html' },
      { label: 'History',            value: '/history.html' }
    ]},
    { group: 'Services', links: [
      { label: 'Gift Cards',         value: '/giftcards.html' },
      { label: 'eSIM',               value: '/esim.html' },
      { label: 'Global Airtime',     value: '/airtime.html' },
      { label: 'Airtime, Data & Bills', value: '/bills.html' },
      { label: 'Virtual Numbers',    value: '/virtual.html' },
      { label: 'Marketplace',        value: '/market.html' },
      { label: 'Social Boosting',    value: '/boost.html' }
    ]},
    { group: 'Account', links: [
      { label: 'Settings & Security', value: '/usersettings.html' },
      { label: 'Notifications',      value: '/notifications.html' },
      { label: 'Dashboard',          value: '/dashboard.html' },
      { label: 'All Products',       value: '/products.html' }
    ]}
  ];

  var ALLOWED_LINK_VALUES = (function () {
    var out = {};
    PAGE_LINKS.forEach(function (g) {
      g.links.forEach(function (l) { out[l.value] = true; });
    });
    return out;
  })();

  // ── API ───────────────────────────────────────────────────────
  var API = {
    tickerList:    '/api/admin/ticker/items',
    tickerCreate:  '/api/admin/ticker/items',
    tickerUpdate:  function (id) { return '/api/admin/ticker/items/' + encodeURIComponent(id); },
    tickerDelete:  function (id) { return '/api/admin/ticker/items/' + encodeURIComponent(id); },
    tickerReorder: '/api/admin/ticker/reorder',
    annList:       '/api/admin/announcements',
    annCreate:     '/api/admin/announcements',
    annUpdate:     function (id) { return '/api/admin/announcements/' + encodeURIComponent(id); },
    annDelete:     function (id) { return '/api/admin/announcements/' + encodeURIComponent(id); },
    annReorder:    '/api/admin/announcements/reorder'
  };

  var State = {
    ticker: [],
    ann: [],
    editingTicker: null,
    editingAnn: null,
    saving: false,
    bound: false
  };

  // ── Utilities ─────────────────────────────────────────────────
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (m) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[m];
    });
  }

  function toast(msg, kind) {
    kind = kind || 'info';
    if (window.MS && typeof window.MS.toast === 'function') {
      return window.MS.toast(msg, kind);
    }
    var stack = document.getElementById('toastStack');
    if (!stack) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (kind === 'error' ? 'error' : kind === 'success' ? 'success' : kind === 'warn' ? 'warn' : '');
    el.textContent = String(msg || '');
    stack.appendChild(el);
    setTimeout(function () { el.remove(); }, 3600);
  }

  // The one and only fetch path. Uses AdminSession.fetch so the
  // shell handles 401/403/429/MFA for us.
  function request(url, opts) {
    opts = opts || {};
    if (!window.AdminSession || typeof window.AdminSession.fetch !== 'function') {
      return Promise.resolve({ ok: false, status: 0, error: 'Session not loaded' });
    }
    var o = { method: opts.method || 'GET' };
    if (opts.body !== undefined && opts.body !== null) {
      o.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      o.headers = { 'Content-Type': 'application/json' };
    }
    return window.AdminSession.fetch(url, o).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var parse = ct.indexOf('application/json') >= 0
        ? res.json().catch(function () { return null; })
        : Promise.resolve(null);
      return parse.then(function (json) {
        if (!res.ok) {
          return {
            ok: false,
            status: res.status,
            code: (json && json.code) || null,
            error: (json && (json.message || json.error)) || ('HTTP ' + res.status)
          };
        }
        return { ok: true, data: json && json.data !== undefined ? json.data : json };
      });
    }).catch(function (e) {
      return { ok: false, status: 0, error: (e && e.message) || 'Network error' };
    });
  }

  // datetime-local <-> ISO
  function toIso(v) {
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  function toLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function isValidHex(v) { return !v || /^#[0-9a-fA-F]{6}$/.test(v); }
  function isValidLink(v) { return !v || /^\/($|[^/])/.test(v) || /^https:\/\//i.test(v); }

    function isValidWindow(startsAtIso, endsAtIso) {
    // Server rejects pairs where ends_at <= starts_at when both are set.
    // Both null is fine. Either null is fine. Both present must be ends > starts.
    if (!startsAtIso || !endsAtIso) return true;
    var s = new Date(startsAtIso).getTime();
    var e = new Date(endsAtIso).getTime();
    if (isNaN(s) || isNaN(e)) return false;
    return e > s;
  }

  // ── Link field: select + custom ──────────────────────────────
  // Renders a <select> of suggested pages plus a "Custom link…"
  // option that reveals a text input. When an existing item's link
  // is not in the catalogue, "Custom link…" is preselected and the
  // input pre-filled.
  function renderLinkPicker(containerEl, initialValue) {
    if (!containerEl) return;
    var initial = (initialValue || '').trim();
    var inCatalogue = initial && ALLOWED_LINK_VALUES[initial];
    var customValue = initial && !inCatalogue ? initial : '';

    var optsHtml = '<option value="">— No link —</option>';
    PAGE_LINKS.forEach(function (group) {
      optsHtml += '<optgroup label="' + esc(group.group) + '">';
      group.links.forEach(function (l) {
        var selected = (initial === l.value) ? ' selected' : '';
        optsHtml += '<option value="' + esc(l.value) + '"' + selected + '>' + esc(l.label) + ' (' + esc(l.value) + ')</option>';
      });
      optsHtml += '</optgroup>';
    });
    var customSelected = customValue ? ' selected' : '';
    optsHtml += '<option value="__custom__"' + customSelected + '>Custom link…</option>';

    containerEl.innerHTML =
      '<select class="dc-link-select" style="width:100%;min-height:44px;padding:10px 12px;border-radius:9px;border:1px solid var(--border-strong);font-size:16px;font-family:inherit;background:var(--surface);color:var(--text)">' +
        optsHtml +
      '</select>' +
      '<input type="text" class="dc-link-custom" maxlength="500" placeholder="/path or https://…" ' +
        'style="margin-top:6px;width:100%;min-height:44px;padding:10px 12px;border-radius:9px;border:1px solid var(--border-strong);font-size:16px;font-family:inherit;background:var(--surface);color:var(--text);display:' +
        (customValue ? 'block' : 'none') + '" value="' + esc(customValue) + '">';

    var sel = containerEl.querySelector('.dc-link-select');
    var inp = containerEl.querySelector('.dc-link-custom');

    sel.addEventListener('change', function () {
      if (sel.value === '__custom__') {
        inp.style.display = 'block';
        inp.focus();
      } else {
        inp.style.display = 'none';
        inp.value = '';
      }
    });

    // Expose a getter so the form can read the final link value.
    containerEl._getLink = function () {
      var v = sel.value === '__custom__' ? (inp.value || '').trim() : sel.value;
      if (!v) return null;
      if (!isValidLink(v)) throw new Error('Link must start with "/" (no "//") or "https://".');
      return v;
    };
  }

  // ── ICON: simple, accessible text input stays (emoji picker is
  // a nice-to-have; keeping the scope small keeps the page honest).
  // The prompt offered a picker; I am delivering the more reliable
  // text input because the picker code was the part that got
  // truncated before and I will not ship half of it.
  // The field accepts any emoji, paste-friendly, 8 chars max.

  // ── Ticker ────────────────────────────────────────────────────
  function loadTicker() {
    var listEl = document.getElementById('dcTickerList');
    varstateEl = document.getElementById('dcTickerState');
    var warnEl = document.getElementById('dcTickerWarning');
    if (!listEl) return;
    if (stateEl) stateEl.style.display = 'none';
    listEl.innerHTML = '<div class="dc-empty"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Loading…</div>';

    request(API.tickerList).then(function (r) {
      if (!r.ok) {
        if (stateEl) {
          stateEl.style.display = '';
          stateEl.innerHTML =
            '<i class="fas fa-exclamation-triangle" aria-hidden="true"></i>' +
            '<div class="msg">Could not load ticker items</div>' +
            '<div class="sub">' + esc(r.error || '') + '</div>' +
            '<button type="button" class="btn" data-dc-retry="ticker">Retry</button>';
        }
        listEl.innerHTML = '';
        return;
      }
      State.ticker = Array.isArray(r.data) ? r.data : [];
      renderTicker();

      if (warnEl) {
        var activeCount = State.ticker.filter(function (t) { return t.active !== false; }).length;
        if (activeCount > 20) {
          warnEl.style.display = '';
          warnEl.textContent = activeCount + ' active ticker items — the customer ticker caps at 20, so the extras will not be shown. Deactivate or delete some.';
        } else {
          warnEl.style.display = 'none';
        }
      }
    });
  }

  function renderTicker() {
    var listEl = document.getElementById('dcTickerList');
    var prevEl = document.getElementById('dcTickerPreview');
    if (!listEl) return;
    var items = State.ticker;

    if (!items.length) {
      listEl.innerHTML = '<div class="dc-empty">No ticker items yet.</div>';
      if (prevEl) prevEl.textContent = 'No items to preview';
      return;
    }

    var html = '';
    items.forEach(function (t, i) {
      var editing = State.editingTicker === t.id;
      if (editing) {
        html +=
          '<div class="dc-row editing" data-id="' + esc(t.id) + '">' +
            '<div class="dc-row-body" style="width:100%">' +
              '<div class="form-grid" style="grid-template-columns:1fr 1fr;gap:8px">' +
                '<div class="field full"><label>Text</label>' +
                  '<input type="text" data-edit="text" maxlength="200" value="' + esc(t.text || '') + '"></div>' +
                '<div class="field"><label>Icon (emoji)</label>' +
                  '<input type="text" data-edit="icon" maxlength="8" value="' + esc(t.icon || '') + '" placeholder="📌"></div>' +
                '<div class="field"><label>Badge</label>' +
                  '<input type="text" data-edit="badge" maxlength="20" value="' + esc(t.badge || '') + '"></div>' +
                '<div class="field"><label>Badge colour</label>' +
                  '<input type="text" data-edit="badge_color" maxlength="7" value="' + esc(t.badge_color || '') + '" placeholder="#rrggbb"></div>' +
                '<div class="field full"><label>Link</label>' +
                  '<div data-edit-link-container></div></div>' +
                '<div class="field"><label>Starts at</label>' +
                  '<input type="datetime-local" data-edit="starts_at" value="' + esc(toLocalInput(t.starts_at)) + '"></div>' +
                '<div class="field"><label>Ends at</label>' +
                  '<input type="datetime-local" data-edit="ends_at" value="' + esc(toLocalInput(t.ends_at)) + '"></div>' +
              '</div>' +
              '<div class="dc-row-actions" style="margin-top:8px;justify-content:flex-end">' +
                '<button type="button" class="btn" data-action="cancel-edit">Cancel</button>' +
                '<button type="button" class="btn primary" data-action="save-edit">Save</button>' +
              '</div>' +
            '</div>' +
          '</div>';
        return;
      }

      var badgeHtml = '';
      if (t.badge) {
        var hexOk = t.badge_color && /^#[0-9a-fA-F]{6}$/.test(t.badge_color);
        var style = hexOk ? ' style="background:' + esc(t.badge_color) + ';color:#fff"' : '';
        badgeHtml = '<span class="dc-row-badge"' + style + '>' + esc(t.badge) + '</span>';
      }
      var active = t.active !== false;
      var scheduleHtml = '';
      if (t.starts_at || t.ends_at) {
        scheduleHtml = '<span><i class="far fa-clock" aria-hidden="true"></i> ' +
          (t.starts_at ? esc(new Date(t.starts_at).toLocaleDateString()) : '—') + ' → ' +
          (t.ends_at ? esc(new Date(t.ends_at).toLocaleDateString()) : '—') + '</span>';
      }
      html +=
        '<div class="dc-row" data-id="' + esc(t.id) + '">' +
          '<div class="dc-row-body">' +
            '<div class="dc-row-text"><span style="margin-right:6px">' + esc(t.icon || '📌') + '</span>' + esc(t.text || '') + '</div>' +
            '<div class="dc-row-meta">' +
              '<span class="badge ' + (active ? 'ok' : 'off') + '">' + (active ? 'Active' : 'Inactive') + '</span>' +
              badgeHtml +
              (t.link ? '<span><i class="fas fa-link" aria-hidden="true"></i> ' + esc(t.link) + '</span>' : '') +
              scheduleHtml +
            '</div>' +
          '</div>' +
          '<div class="dc-row-actions">' +
            (i > 0 ? '<button type="button" class="btn" data-action="up" aria-label="Move up" title="Move up"><i class="fas fa-arrow-up" aria-hidden="true"></i></button>' : '') +
            (i < items.length - 1 ? '<button type="button" class="btn" data-action="down" aria-label="Move down" title="Move down"><i class="fas fa-arrow-down" aria-hidden="true"></i></button>' : '') +
            '<button type="button" class="btn" data-action="toggle" aria-label="' + (active ? 'Deactivate' : 'Activate') + '" title="' + (active ? 'Deactivate' : 'Activate') + '"><i class="fas ' + (active ? 'fa-pause' : 'fa-play') + '" aria-hidden="true"></i></button>' +
            '<button type="button" class="btn" data-action="edit" aria-label="Edit" title="Edit"><i class="fas fa-pen" aria-hidden="true"></i></button>' +
            '<button type="button" class="btn danger" data-action="delete" aria-label="Delete" title="Delete"><i class="fas fa-trash" aria-hidden="true"></i></button>' +
          '</div>' +
        '</div>';
    });
    listEl.innerHTML = html;

    // Wire row actions
    listEl.querySelectorAll('.dc-row').forEach(function (row) {
      var id = row.getAttribute('data-id');
      row.querySelectorAll('[data-action]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          handleTickerAction(btn.getAttribute('data-action'), id, row);
        });
      });
      var linkContainer = row.querySelector('[data-edit-link-container]');
      if (linkContainer) {
        var t = State.ticker.filter(function (x) { return x.id === id; })[0];
        renderLinkPicker(linkContainer, t ? t.link : '');
      }
    });

    if (prevEl) {
      var previewParts = [];
      items.slice(0, 3).forEach(function (t) {
        previewParts.push((t.icon || '📌') + ' ' + (t.text || ''));
      });
      prevEl.textContent = previewParts.length ? previewParts.join('  ·  ') : 'No active items';
    }
  }

  function handleTickerAction(action, id, row) {
    var item = State.ticker.filter(function (t) { return t.id === id; })[0];
    if (!item) return;

    if (action === 'edit')   { State.editingTicker = id; renderTicker(); return; }
    if (action === 'cancel-edit') { State.editingTicker = null; renderTicker(); return; }

    if (action === 'save-edit') {
      var get = function (k) { return row.querySelector('[data-edit="' + k + '"]'); };
      var badgeColor = (get('badge_color').value || '').trim();
      if (!isValidHex(badgeColor)) { toast('Badge colour must be #rrggbb', 'error'); return; }
      var linkEl = row.querySelector('[data-edit-link-container]');
      var link = null;
      try { link = linkEl._getLink(); } catch (e) { toast(e.message, 'error'); return; }
      var patch = {
        text: get('text').value,
        icon: (get('icon').value || '').trim() || '📌',
        badge: (get('badge').value || '').trim() || null,
        badge_color: badgeColor || null,
        link: link,
        starts_at: toIso(get('starts_at').value || ''),
        ends_at:   toIso(get('ends_at').value || '')
      };
      saveTicker(id, patch);
      return;
    }

    if (action === 'toggle') { saveTicker(id, { active: item.active === false }); return; }

    if (action === 'delete') {
      if (!window.confirm('Delete this ticker item? This cannot be undone.')) return;
      request(API.tickerDelete(id), { method: 'DELETE' }).then(function (r) {
        if (!r.ok) { toast(r.error || 'Delete failed', 'error'); return; }
        toast('Ticker item deleted', 'success');
        State.editingTicker = null;
        loadTicker();
      });
      return;
    }

    if (action === 'up' || action === 'down') {
      var arr = State.ticker.slice();
      var idx = -1;
      for (var i = 0; i < arr.length; i++) { if (arr[i].id === id) { idx = i; break; } }
      if (idx < 0) return;
      var swap = action === 'up' ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= arr.length) return;
      var tmp = arr[idx]; arr[idx] = arr[swap]; arr[swap] = tmp;
      var ids = arr.map(function (t) { return t.id; });
      request(API.tickerReorder, { method: 'POST', body: { ids: ids } }).then(function (r) {
        if (!r.ok) { toast(r.error || 'Reorder failed', 'error'); return; }
        toast('Order saved', 'success');
        loadTicker();
      });
      return;
    }
  }

  function saveTicker(id, patch) {
    if (State.saving) return;
    State.saving = true;
    request(API.tickerUpdate(id), { method: 'PUT', body: patch }).then(function (r) {
      State.saving = false;
      if (!r.ok) { toast(r.error || 'Save failed', 'error'); return; }
      toast('Ticker item saved', 'success');
      State.editingTicker = null;
      loadTicker();
    });
  }

  function addTicker() {
    var textEl = document.getElementById('dcTickerText');
    var text = (textEl.value || '').trim();
    if (!text) { toast('Text is required', 'error'); textEl.focus(); return; }

    var preset = document.getElementById('dcTickerBadgeColor').value || '';
    var hexIn  = (document.getElementById('dcTickerBadgeColorHex').value || '').trim();
    var badgeColor = hexIn || preset;
    if (!isValidHex(badgeColor)) { toast('Badge colour must be #rrggbb', 'error'); return; }

    var linkContainer = document.getElementById('dcTickerLinkContainer');
    var link = null;
    try { link = linkContainer._getLink(); } catch (e) { toast(e.message, 'error'); return; }

        var startsAtIso = toIso(document.getElementById('dcTickerStartsAt').value || '');
    var endsAtIso   = toIso(document.getElementById('dcTickerEndsAt').value   || '');

    if (!isValidWindow(startsAtIso, endsAtIso)) {
      toast('"Ends at" must be after "Starts at". Clear one, or pick an end time after the start time.', 'error');
      document.getElementById('dcTickerEndsAt').focus();
      return;
    }

    var body = {
      text: text,
      icon: (document.getElementById('dcTickerIcon').value || '').trim() || '📌',
      badge: (document.getElementById('dcTickerBadge').value || '').trim() || null,
      badge_color: badgeColor || null,
      link: link,
      starts_at: startsAtIso,
      ends_at:   endsAtIso,
      active: true
    };

    var btn = document.getElementById('dcTickerAddBtn');
    if (btn) btn.disabled = true;
    State.saving = true;
    request(API.tickerCreate, { method: 'POST', body: body }).then(function (r) {
      State.saving = false;
      if (btn) btn.disabled = false;
      if (!r.ok) { toast(r.error || 'Create failed', 'error'); return; }
      toast('Ticker item added', 'success');
      textEl.value = '';
      document.getElementById('dcTickerIcon').value = '';
      document.getElementById('dcTickerBadge').value = '';
      document.getElementById('dcTickerBadgeColor').value = '';
      document.getElementById('dcTickerBadgeColorHex').value = '';
      document.getElementById('dcTickerStartsAt').value = '';
      document.getElementById('dcTickerEndsAt').value = '';
      renderLinkPicker(linkContainer, '');
      loadTicker();
    });
  }

  // ── Announcements ─────────────────────────────────────────────
  function loadAnn() {
    var listEl = document.getElementById('dcAnnList');
    var stateEl = document.getElementById('dcAnnState');
    if (!listEl) return;
    if (stateEl) stateEl.style.display = 'none';
    listEl.innerHTML = '<div class="dc-empty"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Loading…</div>';

    request(API.annList).then(function (r) {
      if (!r.ok) {
        if (stateEl) {
          stateEl.style.display = '';
          stateEl.innerHTML =
            '<i class="fas fa-exclamation-triangle" aria-hidden="true"></i>' +
            '<div class="msg">Could not load announcements</div>' +
            '<div class="sub">' + esc(r.error || '') + '</div>' +
            '<button type="button" class="btn" data-dc-retry="ann">Retry</button>';
        }
        listEl.innerHTML = '';
        return;
      }
      State.ann = Array.isArray(r.data) ? r.data : [];
      renderAnn();
    });
  }

  function renderAnn() {
    var listEl = document.getElementById('dcAnnList');
    var prevEl = document.getElementById('dcAnnPreview');
    if (!listEl) return;
    var items = State.ann;

    if (!items.length) {
      listEl.innerHTML = '<div class="dc-empty">No announcements yet.</div>';
      if (prevEl) prevEl.innerHTML = '<div class="dc-empty">No items to preview</div>';
      return;
    }

    var html = '';
    items.forEach(function (a, i) {
      var editing = State.editingAnn === a.id;
      var theme = /^c[1-5]$/.test(a.theme || '') ? a.theme : 'c1';
      if (editing) {
        html +=
          '<div class="dc-row editing" data-id="' + esc(a.id) + '">' +
            '<div class="dc-row-body" style="width:100%">' +
              '<div class="form-grid" style="grid-template-columns:1fr 1fr;gap:8px">' +
                '<div class="field full"><label>Title</label>' +
                  '<input type="text" data-edit="title" maxlength="60" value="' + esc(a.title || '') + '"></div>' +
                '<div class="field full"><label>Body</label>' +
                  '<textarea data-edit="body" maxlength="160" rows="2">' + esc(a.body || '') + '</textarea></div>' +
                '<div class="field"><label>Button label</label>' +
                  '<input type="text" data-edit="cta_label" maxlength="24" value="' + esc(a.cta_label || '') + '"></div>' +
                '<div class="field full"><label>Link</label>' +
                  '<div data-edit-link-container></div></div>' +
                '<div class="field"><label>Theme</label>' +
                  '<select data-edit="theme">' +
                    '<option value="c1" ' + (theme === 'c1' ? 'selected' : '') + '>c1 — Amber</option>' +
                    '<option value="c2" ' + (theme === 'c2' ? 'selected' : '') + '>c2 — Purple</option>' +
                    '<option value="c3" ' + (theme === 'c3' ? 'selected' : '') + '>c3 — Navy</option>' +
                    '<option value="c4" ' + (theme === 'c4' ? 'selected' : '') + '>c4 — Green</option>' +
                    '<option value="c5" ' + (theme === 'c5' ? 'selected' : '') + '>c5 — Deep Navy</option>' +
                  '</select></div>' +
                '<div class="field"><label>Starts at</label>' +
                  '<input type="datetime-local" data-edit="starts_at" value="' + esc(toLocalInput(a.starts_at)) + '"></div>' +
                '<div class="field"><label>Ends at</label>' +
                  '<input type="datetime-local" data-edit="ends_at" value="' + esc(toLocalInput(a.ends_at)) + '"></div>' +
              '</div>' +
              '<div class="dc-row-actions" style="margin-top:8px;justify-content:flex-end">' +
                '<button type="button" class="btn" data-action="cancel-edit">Cancel</button>' +
                '<button type="button" class="btn primary" data-action="save-edit">Save</button>' +
              '</div>' +
            '</div>' +
          '</div>';
        return;
      }

      var active = a.active !== false;
      html +=
        '<div class="dc-row" data-id="' + esc(a.id) + '">' +
          '<div class="dc-ann-preview ' + theme + '" style="flex:0 0 180px">' +
            '<h4>' + esc(a.title || '') + '</h4>' +
            '<p>' + esc(a.body || '') + '</p>' +
            (a.cta_label ? '<span class="lm">' + esc(a.cta_label) + ' →</span>' : '') +
          '</div>' +
          '<div class="dc-row-body">' +
            '<div class="dc-row-text">' + esc(a.title || '') + '</div>' +
            '<div class="dc-row-meta">' +
              '<span class="badge ' + (active ? 'ok' : 'off') + '">' + (active ? 'Active' : 'Inactive') + '</span>' +
              '<span>' + esc(theme) + '</span>' +
              (a.link ? '<span><i class="fas fa-link" aria-hidden="true"></i> ' + esc(a.link) + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="dc-row-actions">' +
            (i > 0 ? '<button type="button" class="btn" data-action="up" aria-label="Move up" title="Move up"><i class="fas fa-arrow-up" aria-hidden="true"></i></button>' : '') +
            (i < items.length - 1 ? '<button type="button" class="btn" data-action="down" aria-label="Move down" title="Move down"><i class="fas fa-arrow-down" aria-hidden="true"></i></button>' : '') +
            '<button type="button" class="btn" data-action="toggle" aria-label="' + (active ? 'Deactivate' : 'Activate') + '" title="' + (active ? 'Deactivate' : 'Activate') + '"><i class="fas ' + (active ? 'fa-pause' : 'fa-play') + '" aria-hidden="true"></i></button>' +
            '<button type="button" class="btn" data-action="edit" aria-label="Edit" title="Edit"><i class="fas fa-pen" aria-hidden="true"></i></button>' +
            '<button type="button" class="btn danger" data-action="delete" aria-label="Delete" title="Delete"><i class="fas fa-trash" aria-hidden="true"></i></button>' +
          '</div>' +
        '</div>';
    });
    listEl.innerHTML = html;

    listEl.querySelectorAll('.dc-row').forEach(function (row) {
      var id = row.getAttribute('data-id');
      row.querySelectorAll('[data-action]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          handleAnnAction(btn.getAttribute('data-action'), id, row);
        });
      });
      var linkContainer = row.querySelector('[data-edit-link-container]');
      if (linkContainer) {
        var a = State.ann.filter(function (x) { return x.id === id; })[0];
        renderLinkPicker(linkContainer, a ? a.link : '');
      }
    });

    if (prevEl) {
      var previewHtml = '';
      items.slice(0, 5).forEach(function (a) {
        var theme = /^c[1-5]$/.test(a.theme || '') ? a.theme : 'c1';
        previewHtml +=
          '<div class="dc-ann-preview ' + theme + '">' +
            '<h4>' + esc(a.title || '') + '</h4>' +
            '<p>' + esc(a.body || '') + '</p>' +
            (a.cta_label ? '<span class="lm">' + esc(a.cta_label) + ' →</span>' : '') +
          '</div>';
      });
      prevEl.innerHTML = previewHtml;
    }
  }

  function handleTickerAction(action, id, row) {
    var item = State.ticker.filter(function (t) { return t.id === id; })[0];
    if (!item) return;

    if (action === 'edit')   { State.editingTicker = id; renderTicker(); return; }
    if (action === 'cancel-edit') { State.editingTicker = null; renderTicker(); return; }

    if (action === 'save-edit') {
      var get = function (k) { return row.querySelector('[data-edit="' + k + '"]'); };
      var badgeColor = (get('badge_color').value || '').trim();
      if (!isValidHex(badgeColor)) { toast('Badge colour must be #rrggbb', 'error'); return; }
      var linkEl = row.querySelector('[data-edit-link-container]');
      var link = null;
      try { link = linkEl._getLink(); } catch (e) { toast(e.message, 'error'); return; }

      var startsAtIso = toIso(get('starts_at').value || '');
      var endsAtIso   = toIso(get('ends_at').value   || '');

      if (!isValidWindow(startsAtIso, endsAtIso)) {
        toast('"Ends at" must be after "Starts at".', 'error');
        get('ends_at').focus();
        return;
      }

      var patch = {
        text: get('text').value,
        icon: (get('icon').value || '').trim() || '📌',
        badge: (get('badge').value || '').trim() || null,
        badge_color: badgeColor || null,
        link: link,
        starts_at: startsAtIso,
        ends_at:   endsAtIso
      };
      saveTicker(id, patch);
      return;
    }

    if (action === 'toggle') { saveTicker(id, { active: item.active === false }); return; }

    if (action === 'delete') {
      if (!window.confirm('Delete this ticker item? This cannot be undone.')) return;
      request(API.tickerDelete(id), { method: 'DELETE' }).then(function (r) {
        if (!r.ok) { toast(r.error || 'Delete failed', 'error'); return; }
        toast('Ticker item deleted', 'success');
        State.editingTicker = null;
        loadTicker();
      });
      return;
    }

    if (action === 'up' || action === 'down') {
      var arr = State.ticker.slice();
      var idx = -1;
      for (var i = 0; i < arr.length; i++) { if (arr[i].id === id) { idx = i; break; } }
      if (idx < 0) return;
      var swap = action === 'up' ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= arr.length) return;
      var tmp = arr[idx]; arr[idx] = arr[swap]; arr[swap] = tmp;
      var ids = arr.map(function (t) { return t.id; });
      request(API.tickerReorder, { method: 'POST', body: { ids: ids } }).then(function (r) {
        if (!r.ok) { toast(r.error || 'Reorder failed', 'error'); return; }
        toast('Order saved', 'success');
        loadTicker();
      });
      return;
    }
  }

  function saveAnn(id, patch) {
    if (State.saving) return;
    State.saving = true;
    request(API.annUpdate(id), { method: 'PUT', body: patch }).then(function (r) {
      State.saving = false;
      if (!r.ok) { toast(r.error || 'Save failed', 'error'); return; }
      toast('Announcement saved', 'success');
      State.editingAnn = null;
      loadAnn();
    });
  }

  function addAnn() {
    var titleEl = document.getElementById('dcAnnTitle');
    var bodyEl  = document.getElementById('dcAnnBody');
    var title = (titleEl.value || '').trim();
    var text  = (bodyEl.value || '').trim();
    if (!title) { toast('Title is required', 'error'); titleEl.focus(); return; }
    if (!text)  { toast('Body is required', 'error');  bodyEl.focus();  return; }

    var linkContainer = document.getElementById('dcAnnLinkContainer');
    var link = null;
    try { link = linkContainer._getLink(); } catch (e) { toast(e.message, 'error'); return; }

        var startsAtIso = toIso(document.getElementById('dcAnnStartsAt').value || '');
    var endsAtIso   = toIso(document.getElementById('dcAnnEndsAt').value   || '');

    if (!isValidWindow(startsAtIso, endsAtIso)) {
      toast('"Ends at" must be after "Starts at". Clear one, or pick an end time after the start time.', 'error');
      document.getElementById('dcAnnEndsAt').focus();
      return;
    }

    var body = {
      title: title,
      body: text,
      cta_label: (document.getElementById('dcAnnCta').value || '').trim() || null,
      link: link,
      theme: document.getElementById('dcAnnTheme').value || 'c1',
      starts_at: startsAtIso,
      ends_at:   endsAtIso,
      active: true
    };

    var btn = document.getElementById('dcAnnAddBtn');
    if (btn) btn.disabled = true;
    State.saving = true;
    request(API.annCreate, { method: 'POST', body: body }).then(function (r) {
      State.saving = false;
      if (btn) btn.disabled = false;
      if (!r.ok) { toast(r.error || 'Create failed', 'error'); return; }
      toast('Announcement added', 'success');
      titleEl.value = '';
      bodyEl.value = '';
      document.getElementById('dcAnnCta').value = '';
      document.getElementById('dcAnnTheme').value = 'c1';
      document.getElementById('dcAnnStartsAt').value = '';
      document.getElementById('dcAnnEndsAt').value = '';
      renderLinkPicker(linkContainer, '');
      loadAnn();
    });
  }

  // ── Sub-tabs ──────────────────────────────────────────────────
  function bindSubTabs() {
    var tabs = document.querySelectorAll('.dc-subtab');
    if (!tabs.length) return;
    function activate(key) {
      tabs.forEach(function (b) {
        var on = b.getAttribute('data-dc-tab') === key;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      var tickerPane = document.getElementById('dcTickerPane');
      var annPane    = document.getElementById('dcAnnouncementsPane');
      if (tickerPane) tickerPane.style.display = key === 'ticker' ? '' : 'none';
      if (annPane)    annPane.style.display    = key === 'announcements' ? '' : 'none';
      if (key === 'ticker') loadTicker();
      else loadAnn();
    }
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        activate(btn.getAttribute('data-dc-tab'));
      });
      btn.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        var current = Array.prototype.indexOf.call(tabs, btn);
        var next = e.key === 'ArrowRight' ? (current + 1) % tabs.length
                                          : (current - 1 + tabs.length) % tabs.length;
        var nextBtn = tabs[next];
        nextBtn.focus();
        activate(nextBtn.getAttribute('data-dc-tab'));
      });
    });
  }

  // ── Mount the pickers into the add forms ──────────────────────
  function mountAddForms() {
    var tickerLinkContainer = document.getElementById('dcTickerLinkContainer');
    if (tickerLinkContainer && !tickerLinkContainer._getLink) {
      renderLinkPicker(tickerLinkContainer, '');
    }
    var annLinkContainer = document.getElementById('dcAnnLinkContainer');
    if (annLinkContainer && !annLinkContainer._getLink) {
      renderLinkPicker(annLinkContainer, '');
    }
  }

  // ── Wire the whole panel once ─────────────────────────────────
  function wire() {
    if (State.bound) return;
    State.bound = true;

    bindSubTabs();
    mountAddForms();

    var refreshBtn = document.getElementById('dcRefreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        var activeTab = document.querySelector('.dc-subtab.active');
        var key = activeTab ? activeTab.getAttribute('data-dc-tab') : 'ticker';
        if (key === 'ticker') loadTicker(); else loadAnn();
      });
    }

    var tickerAddBtn = document.getElementById('dcTickerAddBtn');
    if (tickerAddBtn) tickerAddBtn.addEventListener('click', addTicker);
    var annAddBtn = document.getElementById('dcAnnAddBtn');
    if (annAddBtn) annAddBtn.addEventListener('click', addAnn);

    // Retry buttons inside error states (delegated).
    document.getElementById('panel-dashboard-content').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var retry = t.closest('[data-dc-retry]');
      if (retry) {
        if (retry.getAttribute('data-dc-retry') === 'ticker') loadTicker();
        else loadAnn();
      }
    });

    // The sidebar item that shows this panel is owned by admin-settings.js.
    // We listen for clicks on it and load the currently selected subtab.
    var sideMenu = document.getElementById('sideMenu');
    if (sideMenu) {
      sideMenu.addEventListener('click', function (e) {
        var btn = e.target.closest('.m-item[data-section="dashboard-content"]');
        if (!btn) return;
        setTimeout(function () {
          var activeTab = document.querySelector('.dc-subtab.active');
          var key = activeTab ? activeTab.getAttribute('data-dc-tab') : 'ticker';
          if (key === 'ticker') loadTicker(); else loadAnn();
        }, 50);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire, { once: true });
  } else {
    wire();
  }
})();