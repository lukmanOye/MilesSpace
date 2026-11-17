// /js/ui-kit.js
// ─────────────────────────────────────────────────────────────────
// Reusable admin UI primitives.
//
// Zero dependencies. Exposes a single global: window.UI.
//
// Public API:
//   UI.toast(msg, kind, { action })              kind: info|success|warn|error
//   UI.confirm({ title, body, okLabel, kind, typeToConfirm })
//   UI.prompt({ title, fields, okLabel, validate, onSubmit })
//   UI.reason({ title, message, min })           wrapper over prompt
//   UI.stepUp({ reason })                        TOTP modal
//   UI.sheet({ title, rows })                    mobile bottom-sheet picker
//   UI.modal({ title, bodyHtml, actions })       low-level
//   UI.close()                                   close the top modal/sheet
//
// Guarantees:
//   • Promise-based; resolves values or null on cancel.
//   • Inline validation on submit — modal stays open, keeps typed text,
//     focuses first invalid field, sets aria-invalid + aria-describedby.
//   • Async submit shows a spinner on OK and disables it. Server errors
//     appear INSIDE the modal (never as a toast).
//   • Focus trap, Escape to cancel, focus restoration, scroll lock
//     that works on iOS.
//   • Stacks (opening a modal from a modal is fine).
//   • Mobile: bottom-sheet style under 820px, 44px tap targets,
//     inputs at 16px to prevent iOS zoom.
//   • Enter submits except in <textarea>. Escape cancels the topmost.
//   • No memory leaks: listeners and DOM are removed in finally.
//   • No native alert/confirm/prompt.
// ─────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  if (window.UI) return; // idempotent

  // ─── STACK + STATE ─────────────────────────────────────────────
  var modalStack = [];
  var sheetStack = [];
  var nextId = 0;
  var uid = function (prefix) { return (prefix || 'ui') + '-' + (++nextId); };

  // ─── SCROLL LOCK (iOS-safe) ────────────────────────────────────
  // Uses position:fixed with a top offset — the only pattern that
  // actually prevents body scroll on iOS Safari without also
  // breaking position:sticky in the page. Restores exactly on close.
  var lockState = null;
  function lockScroll() {
    if (lockState) { lockState.count++; return; }
    var y = window.pageYOffset || document.documentElement.scrollTop || 0;
    var body = document.body;
    lockState = {
      count: 1,
      y: y,
      prev: {
        position: body.style.position,
        top:      body.style.top,
        left:     body.style.left,
        right:    body.style.right,
        width:    body.style.width,
        overflow: body.style.overflow
      }
    };
    body.style.position = 'fixed';
    body.style.top = '-' + y + 'px';
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';
  }
  function unlockScroll() {
    if (!lockState) return;
    lockState.count--;
    if (lockState.count > 0) return;
    var body = document.body;
    var s = lockState;
    lockState = null;
    body.style.position = s.prev.position;
    body.style.top      = s.prev.top;
    body.style.left     = s.prev.left;
    body.style.right    = s.prev.right;
    body.style.width    = s.prev.width;
    body.style.overflow = s.prev.overflow;
    // Restore scroll position on the NEXT tick so the browser has
    // finished layout with the styles we just reverted.
    requestAnimationFrame(function () { window.scrollTo(0, s.y); });
  }

  // ─── DOM HELPERS ──────────────────────────────────────────────
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        var v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'attrs') {
          for (var a in v) if (v[a] != null) node.setAttribute(a, String(v[a]));
        } else if (k === 'on') {
          for (var ev in v) if (typeof v[ev] === 'function') node.addEventListener(ev, v[ev]);
        } else if (k === 'style' && typeof v === 'object') {
          for (var sp in v) node.style[sp] = v[sp];
        } else if (k in node) {
          try { node[k] = v; } catch (_) { node.setAttribute(k, String(v)); }
        } else {
          node.setAttribute(k, String(v));
        }
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null || c === false) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function escapeHtml(s) {
    return s == null ? '' : String(s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // ─── FOCUS TRAP ───────────────────────────────────────────────
  var FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function trapFocus(container, e) {
    var items = Array.prototype.slice.call(container.querySelectorAll(FOCUSABLE))
      .filter(function (n) { return n.offsetParent !== null; });
    if (!items.length) { e.preventDefault(); return; }
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === container)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }

  // ─── STYLE INJECTION ──────────────────────────────────────────
  // All CSS lives in one <style> tag with a data-ui-kit marker so
  // it is injected exactly once, even if the script is loaded twice.
  function injectStyles() {
    if (document.querySelector('style[data-ui-kit="1"]')) return;
    var css = ''
      + '.ui-scrim{position:fixed;inset:0;background:rgba(8,21,26,.58);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);z-index:1600;display:none;align-items:center;justify-content:center}'
      + '.ui-scrim.ui-open{display:flex}'
      + '.ui-modal{background:var(--surface,#fff);color:var(--text,#0c1f26);border:1px solid var(--border,rgba(15,76,92,.10));border-radius:14px;width:min(540px,100%);max-height:88vh;max-height:88dvh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 48px -16px rgba(8,42,51,.32);margin:14px;overscroll-behavior:contain;animation:ui-sheet-in .22s ease}'
      + '@keyframes ui-sheet-in{from{transform:translateY(18px);opacity:0}to{transform:none;opacity:1}}'
      + '.ui-modal.ui-wide{width:min(680px,100%)}'
      + '.ui-head{padding:16px 18px;border-bottom:1px solid var(--border,rgba(15,76,92,.10));display:flex;align-items:center;justify-content:space-between;gap:10px;flex-shrink:0}'
      + '.ui-head h3{margin:0;font-size:15px;font-weight:800}'
      + '.ui-x{width:32px;height:32px;border-radius:8px;border:1px solid var(--border,rgba(15,76,92,.10));background:transparent;color:var(--text-dim,#506b77);display:flex;align-items:center;justify-content:center;font-size:13px;flex:none;cursor:pointer}'
      + '.ui-x:hover{background:var(--surface-2,#f4f7fb)}'
      + '.ui-body{padding:16px 18px;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;font-size:13px;line-height:1.55;flex:1}'
      + '.ui-body p{margin:0 0 10px;color:var(--text-dim,#506b77)}'
      + '.ui-body p:last-child{margin-bottom:0}'
      + '.ui-field{margin-bottom:12px}'
      + '.ui-field:last-child{margin-bottom:0}'
      + '.ui-field label{display:block;font-size:12.5px;font-weight:600;margin-bottom:6px}'
      + '.ui-field .ui-help{font-size:11px;color:var(--text-faint,#7d949d);margin-top:4px;line-height:1.45}'
      + '.ui-field input[type="text"],.ui-field input[type="email"],.ui-field input[type="password"],.ui-field input[type="number"],.ui-field input[type="url"],.ui-field select,.ui-field textarea{width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--border-strong,rgba(15,76,92,.20));font-size:16px;font-family:inherit;color:var(--text,#0c1f26);background:var(--surface,#fff);transition:border-color .15s,box-shadow .15s}'
      + '.ui-field input:focus,.ui-field select:focus,.ui-field textarea:focus{outline:none;border-color:var(--brand,#0f4c5c);box-shadow:0 0 0 3px rgba(15,76,92,.10)}'
      + '.ui-field textarea{resize:vertical;min-height:80px}'
      + '.ui-field .ui-error{display:none;font-size:11.5px;color:var(--danger,#c62222);margin-top:4px}'
      + '.ui-field.ui-invalid input,.ui-field.ui-invalid select,.ui-field.ui-invalid textarea{border-color:var(--danger,#c62222)}'
      + '.ui-field.ui-invalid .ui-error{display:block}'
      + '.ui-field .ui-counter{font-size:11px;color:var(--text-faint,#7d949d);text-align:right;margin-top:4px}'
      + '.ui-foot{padding:12px 18px;border-top:1px solid var(--border,rgba(15,76,92,.10));display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;flex-shrink:0;padding-bottom:max(12px,env(safe-area-inset-bottom,0px))}'
      + '.ui-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--border,rgba(15,76,92,.10));background:var(--surface,#fff);border-radius:9px;padding:0 14px;min-height:42px;font-size:13px;font-weight:600;color:var(--brand,#0f4c5c);cursor:pointer;transition:background .15s,color .15s}'
      + '.ui-btn:hover:not(:disabled){background:var(--gold-soft,#fde3ad);color:var(--brand-deep,#0a3542)}'
      + '.ui-btn:disabled{opacity:.55;cursor:not-allowed}'
      + '.ui-btn.ui-primary{background:var(--brand,#0f4c5c);color:#fff;border-color:var(--brand,#0f4c5c)}'
      + '.ui-btn.ui-primary:hover:not(:disabled){background:var(--brand-light,#14607a);color:#fff}'
      + '.ui-btn.ui-danger{background:var(--danger,#c62222);color:#fff;border-color:var(--danger,#c62222)}'
      + '.ui-btn.ui-danger:hover:not(:disabled){background:#a71b1b;color:#fff}'
      + '.ui-btn .ui-spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:ui-spin .8s linear infinite;display:inline-block}'
      + '.ui-btn .ui-spin-dark{width:14px;height:14px;border:2px solid var(--border-strong,rgba(15,76,92,.20));border-top-color:var(--brand,#0f4c5c);border-radius:50%;animation:ui-spin .8s linear infinite;display:inline-block}'
      + '@keyframes ui-spin{to{transform:rotate(360deg)}}'
      + '.ui-banner{padding:10px 12px;border-radius:9px;background:var(--danger-bg,#fdeaea);color:var(--danger,#c62222);font-size:12.5px;font-weight:600;margin-bottom:12px;display:none}'
      + '.ui-banner.ui-show{display:block}'
      + '.ui-toast-stack{position:fixed;bottom:calc(74px + env(safe-area-inset-bottom,0px));right:max(14px,env(safe-area-inset-right,0px));left:max(14px,env(safe-area-inset-left,0px));display:flex;flex-direction:column;align-items:flex-end;gap:8px;z-index:2000;pointer-events:none}'
      + '.ui-toast{background:var(--brand-deep,#0a3542);color:#fff;padding:11px 14px;border-radius:11px;font-size:12.8px;font-weight:500;box-shadow:0 20px 48px -16px rgba(8,42,51,.32);border-left:3px solid var(--gold,#f5a623);display:flex;align-items:center;gap:9px;max-width:420px;pointer-events:auto;animation:ui-toast-in .22s ease}'
      + '.ui-toast.ui-success{border-left-color:var(--success,#15803d)}'
      + '.ui-toast.ui-error{border-left-color:var(--danger,#c62222)}'
      + '.ui-toast.ui-warn{border-left-color:var(--warn,#b45f06)}'
      + '.ui-toast .ui-toast-msg{flex:1;min-width:0}'
      + '.ui-toast .ui-toast-action{background:none;border:0;color:var(--gold,#f5a623);font-weight:700;cursor:pointer;font-size:12px;padding:2px 6px;flex:none}'
      + '.ui-toast .ui-toast-x{background:none;border:0;color:rgba(255,255,255,.6);cursor:pointer;font-size:14px;padding:0 2px;flex:none}'
      + '@keyframes ui-toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}'
      + '.ui-sheet-scrim{position:fixed;inset:0;background:rgba(8,21,26,.58);z-index:1600;display:none;align-items:flex-end;justify-content:center}'
      + '.ui-sheet-scrim.ui-open{display:flex}'
      + '.ui-sheet{background:var(--surface,#fff);color:var(--text,#0c1f26);border:1px solid var(--border,rgba(15,76,92,.10));border-bottom:0;border-radius:18px 18px 0 0;width:min(540px,100%);max-height:85vh;max-height:85dvh;display:flex;flex-direction:column;overflow:hidden;animation:ui-sheet-in .22s ease;padding-bottom:env(safe-area-inset-bottom,0px)}'
      + '.ui-sheet-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border,rgba(15,76,92,.10))}'
      + '.ui-sheet-head h3{margin:0;font-size:15px;font-weight:800}'
      + '.ui-sheet-list{padding:6px 8px 14px;overflow-y:auto;overscroll-behavior:contain}'
      + '.ui-sheet-row{display:flex;align-items:center;gap:12px;width:100%;min-height:48px;padding:10px 12px;border-radius:10px;text-align:left;background:none;border:0;color:var(--text,#0c1f26);cursor:pointer;font-size:13.5px}'
      + '.ui-sheet-row:hover,.ui-sheet-row:focus{background:var(--surface-2,#f4f7fb)}'
      + '@media (max-width:820px){'
      +   '.ui-scrim.ui-sheet-mode{align-items:flex-end;justify-content:stretch}'
      +   '.ui-modal{border-radius:16px 16px 0 0;margin:0;width:100%;max-width:100%;max-height:92vh;max-height:92dvh;animation:ui-mobile-sheet-in .22s ease}'
      +   '.ui-x{width:44px;height:44px}'
      +   '.ui-foot{padding-bottom:max(14px,env(safe-area-inset-bottom,0px))}'
      +   '.ui-foot .ui-btn{min-height:44px;flex:1}'
      + '}'
      + '@media (prefers-reduced-motion:reduce){'
      +   '.ui-modal,.ui-sheet,.ui-toast{animation-duration:.01ms!important}'
      + '}'
      + '@keyframes ui-mobile-sheet-in{from{transform:translateY(20px);opacity:0}to{transform:none;opacity:1}}'
      ;
    var style = document.createElement('style');
    style.setAttribute('data-ui-kit', '1');
    style.textContent = css;
    document.head.appendChild(style);
  }
  injectStyles();

  // ─── TOAST ────────────────────────────────────────────────────
  function toastStack() {
    var s = document.getElementById('ui-toast-stack');
    if (!s) {
      s = el('div', { id: 'ui-toast-stack', class: 'ui-toast-stack', attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' } });
      document.body.appendChild(s);
    }
    return s;
  }
  function toast(msg, kind, opts) {
    kind = kind || 'info';
    opts = opts || {};
    var stack = toastStack();
    var iconName = { info: 'fa-circle-info', success: 'fa-circle-check', error: 'fa-circle-xmark', warn: 'fa-triangle-exclamation' }[kind] || 'fa-circle-info';
    var node = el('div', { class: 'ui-toast ui-' + kind }, [
      el('i', { class: 'fas ' + iconName, attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'ui-toast-msg', text: String(msg == null ? '' : msg) })
    ]);
    if (opts.action && typeof opts.action.onClick === 'function') {
      var actionBtn = el('button', { type: 'button', class: 'ui-toast-action', text: String(opts.action.label || 'Retry') });
      actionBtn.addEventListener('click', function () {
        try { opts.action.onClick(); } finally { dismiss(); }
      });
      node.appendChild(actionBtn);
    }
    var closeBtn = el('button', { type: 'button', class: 'ui-toast-x', attrs: { 'aria-label': 'Dismiss' }, html: '&times;' });
    node.appendChild(closeBtn);
    stack.appendChild(node);
    var removeTimer = setTimeout(dismiss, typeof opts.duration === 'number' ? opts.duration : 4200);
    function dismiss() {
      clearTimeout(removeTimer);
      node.style.opacity = '0';
      node.style.transition = 'opacity .2s';
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 220);
    }
    closeBtn.addEventListener('click', dismiss);
    return { dismiss: dismiss };
  }

  // ─── MODAL CORE ──────────────────────────────────────────────
  // Everything (confirm, prompt, stepUp) builds on top of this.
  //
  // cfg:
  //   title        string
  //   bodyHtml     string | HTMLElement
  //   fields       array (optional, see _buildField)
  //   actions      [{ label, kind, onClick, primary }]
  //   initialFocus HTMLElement | selector string | null
  //   onSubmit     async fn(values) → void | object
  //   validate     fn(values) → {field: message} | null
  //   typeToConfirm string (optional) — user must type this exact text
  //   wide         boolean
  //   onClose      fn()
  //
  // Resolves the collected values object on successful submit, or
  // null on cancel/escape/backdrop click.
  function modal(cfg) {
    cfg = cfg || {};
    return new Promise(function (resolve) {
      var id = uid('ui-modal');
      var opener = document.activeElement;

      var scrim = el('div', { class: 'ui-scrim', attrs: { role: 'presentation' } });
      var wrap  = el('div', {
        class: 'ui-modal' + (cfg.wide ? ' ui-wide' : ''),
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id + '-title', tabindex: '-1' }
      });
      var head  = el('div', { class: 'ui-head' }, [
        el('h3', { id: id + '-title', text: cfg.title || 'Confirm' }),
        el('button', { type: 'button', class: 'ui-x', attrs: { 'aria-label': 'Close' }, html: '<i class="fas fa-xmark" aria-hidden="true"></i>' })
      ]);
      var body  = el('div', { class: 'ui-body' });
      var banner = el('div', { class: 'ui-banner', attrs: { role: 'alert' } });
      body.appendChild(banner);
      var fieldsHost = el('div', { class: 'ui-fields' });
      body.appendChild(fieldsHost);

      if (cfg.bodyHtml) {
        if (typeof cfg.bodyHtml === 'string') {
          fieldsHost.insertAdjacentHTML('afterbegin', cfg.bodyHtml);
        } else {
          fieldsHost.appendChild(cfg.bodyHtml);
        }
      }

      // Build declared fields.
      var fieldEntries = [];
      (cfg.fields || []).forEach(function (f) {
        var entry = _buildField(f);
        fieldEntries.push(entry);
        fieldsHost.appendChild(entry.wrap);
      });

      // typeToConfirm
      var typeToConfirmEntry = null;
      if (cfg.typeToConfirm) {
        typeToConfirmEntry = _buildField({
          name: '__confirm',
          label: 'Type "' + cfg.typeToConfirm + '" to confirm',
          type: 'text',
          required: true,
          autocomplete: 'off',
          pattern: '^' + cfg.typeToConfirm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
          help: 'This action requires typing the exact word to proceed.'
        });
        fieldsHost.appendChild(typeToConfirmEntry.wrap);
      }

      var foot = el('div', { class: 'ui-foot' });
      var cancelBtn = el('button', { type: 'button', class: 'ui-btn', text: cfg.cancelLabel || 'Cancel' });
      var okBtn = el('button', {
        type: 'button',
        class: 'ui-btn ' + (cfg.kind === 'danger' ? 'ui-danger' : 'ui-primary'),
        text: cfg.okLabel || 'Confirm'
      });
      foot.appendChild(cancelBtn);
      foot.appendChild(okBtn);

      wrap.appendChild(head);
      wrap.appendChild(body);
      wrap.appendChild(foot);
      scrim.appendChild(wrap);

      // Read all collected values.
      function readValues() {
        var values = {};
        fieldEntries.forEach(function (fe) {
          if (fe.name === '__confirm') return;
          values[fe.name] = fe.getValue();
        });
        return values;
      }
      function readConfirm() {
        return typeToConfirmEntry ? String(typeToConfirmEntry.getValue() || '') : null;
      }
      function showBanner(msg) {
        if (!msg) { banner.textContent = ''; banner.classList.remove('ui-show'); return; }
        banner.textContent = String(msg);
        banner.classList.add('ui-show');
      }
      function clearFieldErrors() {
        fieldEntries.forEach(function (fe) {
          fe.setError('');
        });
      }
      function focusFirstInvalid(errorMap) {
        for (var i = 0; i < fieldEntries.length; i++) {
          var fe = fieldEntries[i];
          if (errorMap[fe.name]) {
            fe.focus();
            return true;
          }
        }
        return false;
      }
      function applyErrors(errorMap) {
        fieldEntries.forEach(function (fe) {
          fe.setError(errorMap[fe.name] || '');
        });
      }
      function clientValidate() {
        var values = readValues();
        var errors = {};

        fieldEntries.forEach(function (fe) {
          if (fe.name === '__confirm') return;
          var err = fe.validateValue(values[fe.name]);
          if (err) errors[fe.name] = err;
        });

        if (typeToConfirmEntry) {
          var confirmVal = readConfirm();
          if (confirmVal !== cfg.typeToConfirm) {
            errors.__confirm = 'Type "' + cfg.typeToConfirm + '" exactly to proceed.';
          }
        }

        if (cfg.validate) {
          try {
            var v = cfg.validate(values);
            if (v && typeof v === 'object') {
              for (var k in v) if (v[k]) errors[k] = v[k];
            }
          } catch (e) {
            errors.__general = e.message || 'Validation failed.';
          }
        }

        return { values: values, errors: errors };
      }
      function setSubmitting(on) {
        okBtn.disabled = !!on;
        cancelBtn.disabled = !!on;
        if (on) {
          okBtn._originalHtml = okBtn.innerHTML;
          okBtn.innerHTML = '<span class="ui-spin"></span>' + (cfg.okLabel || 'Confirm');
        } else if (okBtn._originalHtml != null) {
          okBtn.innerHTML = okBtn._originalHtml;
          okBtn._originalHtml = null;
        }
      }
      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        scrim.classList.remove('ui-open');
        modalStack = modalStack.filter(function (m) { return m.scrim !== scrim; });
        if (typeof cfg.onClose === 'function') { try { cfg.onClose(); } catch (_) {} }
        if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
        unlockScroll();
        if (opener && typeof opener.focus === 'function') {
          try { opener.focus({ preventScroll: true }); } catch (_) { try { opener.focus(); } catch (_) {} }
        }
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          // Only close if this is the topmost modal.
          var top = modalStack[modalStack.length - 1];
          if (top && top.scrim === scrim) close(null);
          return;
        }
        if (e.key === 'Tab') { trapFocus(wrap, e); return; }
        if (e.key === 'Enter') {
          var target = e.target;
          if (target && target.tagName === 'TEXTAREA') return;
          if (target && target.tagName === 'BUTTON') return; // let buttons click
          e.preventDefault();
          submit();
        }
      }
      async function submit() {
        showBanner('');
        clearFieldErrors();
        var check = clientValidate();
        if (Object.keys(check.errors).length) {
          applyErrors(check.errors);
          if (!focusFirstInvalid(check.errors) && check.errors.__general) {
            showBanner(check.errors.__general);
          }
          return;
        }
        setSubmitting(true);
        try {
          if (typeof cfg.onSubmit === 'function') {
            var result = await cfg.onSubmit(check.values);
            setSubmitting(false);
            close(result === undefined ? check.values : result);
          } else {
            setSubmitting(false);
            close(check.values);
          }
        } catch (err) {
          setSubmitting(false);
          var msg = (err && err.message) || 'Request failed. Please try again.';
          showBanner(msg);
          // Focus the first field referenced by the error, if any.
          if (err && err.field && err.field in check.values) {
            var fe = fieldEntries.filter(function (x) { return x.name === err.field; })[0];
            if (fe) fe.focus();
          }
        }
      }

      cancelBtn.addEventListener('click', function () { close(null); });
      okBtn.addEventListener('click', submit);
      head.querySelector('.ui-x').addEventListener('click', function () { close(null); });
      scrim.addEventListener('mousedown', function (e) {
        if (e.target === scrim) close(null);
      });

      document.body.appendChild(scrim);
      scrim.classList.add('ui-open');
      // Sheet mode on small screens for the whole page.
      if (window.matchMedia && window.matchMedia('(max-width:820px)').matches) {
        scrim.classList.add('ui-sheet-mode');
      }
      lockScroll();
      document.addEventListener('keydown', onKey, true);
      modalStack.push({ scrim: scrim, close: close });

      // Focus initial element on the next frame.
      requestAnimationFrame(function () {
        var target = null;
        if (cfg.initialFocus) {
          target = typeof cfg.initialFocus === 'string'
            ? wrap.querySelector(cfg.initialFocus)
            : cfg.initialFocus;
        }
        if (!target) {
          target = fieldEntries[0] ? fieldEntries[0].inputEl() : null;
        }
        if (!target) target = okBtn;
        try { target.focus({ preventScroll: true }); } catch (_) { try { target.focus(); } catch (_) {} }
      });
    });
  }

  // ─── FIELD BUILDER ────────────────────────────────────────────
  // Each field entry provides:
  //   wrap        the DOM node
  //   name
  //   getValue    () => any
  //   inputEl     () => HTMLElement
  //   focus       ()
  //   setError    (msg)
  //   validateValue (val) => errMsg|null
  function _buildField(spec) {
    spec = spec || {};
    var name = spec.name || ('field-' + uid('f'));
    var type = spec.type || 'text';
    var id = 'ui-f-' + name + '-' + (++nextId);
    var errId = id + '-err';
    var helpId = spec.help ? (id + '-help') : null;

    var wrap = el('div', { class: 'ui-field' });
    var labelEl = null;
    if (spec.label) {
      labelEl = el('label', { attrs: { for: id }, text: spec.label });
      wrap.appendChild(labelEl);
    }

    var inputEl;
    if (type === 'textarea') {
      inputEl = el('textarea', {
        id: id,
        name: name,
        rows: spec.rows || 3,
        attrs: {
          placeholder: spec.placeholder || '',
          maxlength: spec.maxLength || null
        }
      });
    } else if (type === 'select') {
      inputEl = el('select', { id: id, name: name });
      (spec.options || []).forEach(function (opt) {
        inputEl.appendChild(el('option', { value: opt.value, text: opt.label }));
      });
    } else {
      var attrs = {
        type: type,
        id: id,
        name: name,
        placeholder: spec.placeholder || '',
        autocomplete: spec.autocomplete || 'off',
        autocapitalize: spec.autocapitalize || 'off',
        spellcheck: 'false',
        inputmode: spec.inputmode || null,
        pattern: spec.pattern || null,
        minlength: spec.minLength || null,
        maxlength: spec.maxLength || null
      };
      inputEl = el('input', attrs);
    }
    if (spec.value != null) {
      if (inputEl.type === 'checkbox') inputEl.checked = !!spec.value;
      else inputEl.value = String(spec.value);
    }
    wrap.appendChild(inputEl);

    if (helpId) {
      wrap.appendChild(el('div', { class: 'ui-help', id: helpId, text: spec.help }));
    }
    var errEl = el('div', { class: 'ui-error', id: errId });
    wrap.appendChild(errEl);

    // Reason counter is a well-known pattern — auto-wire if the
    // field is named reason/notes with minLength.
    var counter = null;
    if (spec.minLength && type === 'textarea') {
      counter = el('div', { class: 'ui-counter', text: '0 / ' + spec.minLength + ' min' });
      wrap.appendChild(counter);
      inputEl.addEventListener('input', function () {
        var n = inputEl.value.length;
        counter.textContent = n + ' / ' + spec.minLength + ' min';
        counter.style.color = n >= spec.minLength ? 'var(--success,#15803d)' : '';
      });
    }

    function getValue() {
      if (inputEl.type === 'checkbox') return inputEl.checked;
      return inputEl.value;
    }
    function setError(msg) {
      if (msg) {
        inputEl.setAttribute('aria-invalid', 'true');
        inputEl.setAttribute('aria-describedby', errId + (helpId ? ' ' + helpId : ''));
        errEl.textContent = String(msg);
        wrap.classList.add('ui-invalid');
      } else {
        inputEl.removeAttribute('aria-invalid');
        inputEl.removeAttribute('aria-describedby');
        errEl.textContent = '';
        wrap.classList.remove('ui-invalid');
      }
    }
    function focus() {
      try { inputEl.focus(); } catch (_) {}
      try { inputEl.select && inputEl.select(); } catch (_) {}
    }
    function validateValue(v) {
      var str = v == null ? '' : String(v);
      if (spec.required && !str.trim()) return spec.requiredMessage || 'This field is required.';
      if (spec.minLength && str && str.length < spec.minLength) {
        return 'Must be at least ' + spec.minLength + ' characters.';
      }
      if (spec.maxLength && str.length > spec.maxLength) {
        return 'Must be at most ' + spec.maxLength + ' characters.';
      }
      if (spec.pattern && str) {
        var re = new RegExp(spec.pattern);
        if (!re.test(str)) return spec.patternMessage || 'Invalid format.';
      }
      if (type === 'email' && str && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) {
        return 'Enter a valid email address.';
      }
      return null;
    }

    return {
      wrap: wrap,
      name: name,
      getValue: getValue,
      inputEl: function () { return inputEl; },
      focus: focus,
      setError: setError,
      validateValue: validateValue
    };
  }

  // ─── PUBLIC: confirm ─────────────────────────────────────────
  function confirm(opts) {
    opts = opts || {};
    return modal({
      title: opts.title || 'Confirm',
      bodyHtml: opts.body
        ? (typeof opts.body === 'string' && opts.body.indexOf('<') !== -1
            ? opts.body
            : '<p>' + escapeHtml(String(opts.body)) + '</p>')
        : null,
      okLabel: opts.okLabel || 'Confirm',
      cancelLabel: opts.cancelLabel != null ? opts.cancelLabel : 'Cancel',
      kind: opts.kind || 'primary',
      typeToConfirm: opts.typeToConfirm || null,
      wide: !!opts.wide
    }).then(function (r) {
      // typeToConfirm path: r is the values object. Anything else
      // means cancelled.
      if (r == null) return false;
      if (opts.typeToConfirm) return r && r.__confirm === opts.typeToConfirm;
      return true;
    });
  }

  // ─── PUBLIC: prompt ──────────────────────────────────────────
  function prompt(opts) {
    opts = opts || {};
    return modal({
      title: opts.title || 'Enter a value',
      bodyHtml: opts.bodyHtml || null,
      fields: Array.isArray(opts.fields) ? opts.fields : [],
      okLabel: opts.okLabel || 'Submit',
      cancelLabel: opts.cancelLabel != null ? opts.cancelLabel : 'Cancel',
      kind: opts.kind || 'primary',
      wide: !!opts.wide,
      validate: typeof opts.validate === 'function' ? opts.validate : null,
      onSubmit: typeof opts.onSubmit === 'function' ? opts.onSubmit : null
    });
  }

  // ─── PUBLIC: reason (wrapper over prompt) ────────────────────
  function reason(opts) {
    opts = opts || {};
    var min = typeof opts.min === 'number' ? opts.min : 4;
    return modal({
      title: opts.title || 'Reason required',
      bodyHtml: '<p>' + escapeHtml(opts.message || 'Enter a reason for this change. It will be recorded in the audit log.') + '</p>',
      fields: [{
        name: 'reason',
        label: 'Reason',
        type: 'textarea',
        required: true,
        minLength: min,
        maxLength: 500,
        placeholder: 'Minimum ' + min + ' characters',
        rows: 3
      }],
      okLabel: opts.okLabel || 'Submit'
    }).then(function (v) {
      if (!v || !v.reason) return null;
      var trimmed = String(v.reason).trim();
      return trimmed.length >= min ? trimmed : null;
    });
  }

  // ─── PUBLIC: stepUp (TOTP) ───────────────────────────────────
  // Assumption: /api/admin/auth/step-up { code } → { success: true }
  // and it re-stamps user_sessions.mfa_verified for this session.
  // If the endpoint differs, pass opts.endpoint.
  function stepUp(opts) {
    opts = opts || {};
    var endpoint = opts.endpoint || '/api/admin/auth/step-up';
    var totpField = {
      name: 'code',
      label: 'Authenticator code',
      type: 'text',
      inputmode: 'numeric',
      pattern: '^\\d{6}$',
      patternMessage: 'Enter the 6-digit code from your authenticator app.',
      required: true,
      minLength: 6,
      maxLength: 6,
      autocomplete: 'one-time-code',
      placeholder: '000000'
    };
    return modal({
      title: opts.title || 'Verify to continue',
      bodyHtml: '<p>' + escapeHtml(opts.reason || 'Enter the 6-digit code from your authenticator app to confirm this action.') + '</p>',
      fields: [totpField],
      okLabel: opts.okLabel || 'Verify',
      onSubmit: async function (values) {
        var fetcher = (window.AdminSession && typeof window.AdminSession.fetch === 'function')
          ? window.AdminSession.fetch
          : function (url, o) { return fetch(url, Object.assign({ credentials: 'include' }, o)); };
        var res;
        try {
          res = await fetcher(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: String(values.code || '').trim() })
          });
        } catch (e) {
          var err = new Error('Network error. Please try again.');
          throw err;
        }
        var body = null;
        try { body = await res.json(); } catch (_) { body = null; }
        if (!res.ok || (body && body.success === false)) {
          var msg = (body && (body.error || body.message)) || 'Verification failed.';
          var e2 = new Error(msg);
          e2.field = 'code';
          throw e2;
        }
        return { verified: true };
      }
    });
  }

  // ─── PUBLIC: sheet ───────────────────────────────────────────
  // Mobile bottom-sheet picker. rows: [{ label, sublabel?, onSelect }].
  function sheet(opts) {
    opts = opts || {};
    var rows = Array.isArray(opts.rows) ? opts.rows : [];
    return new Promise(function (resolve) {
      var opener = document.activeElement;
      var scrim = el('div', { class: 'ui-sheet-scrim', attrs: { role: 'presentation' } });
      var wrap = el('div', { class: 'ui-sheet', attrs: { role: 'dialog', 'aria-modal': 'true', tabindex: '-1' } });
      var head = el('div', { class: 'ui-sheet-head' }, [
        el('h3', { text: opts.title || 'Choose' }),
        el('button', { type: 'button', class: 'ui-x', attrs: { 'aria-label': 'Close' }, html: '<i class="fas fa-xmark" aria-hidden="true"></i>' })
      ]);
      var list = el('div', { class: 'ui-sheet-list' });
      rows.forEach(function (r, i) {
        var btn = el('button', { type: 'button', class: 'ui-sheet-row' }, [
          el('span', { style: { flex: '1', minWidth: '0' } }, [
            el('div', { style: { fontWeight: '600' }, text: r.label || '' }),
            r.sublabel ? el('div', { style: { fontSize: '11.5px', color: 'var(--text-dim)' }, text: r.sublabel }) : null
          ]),
          el('i', { class: 'fas fa-chevron-right', attrs: { 'aria-hidden': 'true' } })
        ]);
        btn.addEventListener('click', function () {
          close(i);
        });
        list.appendChild(btn);
      });
      wrap.appendChild(head);
      wrap.appendChild(list);
      scrim.appendChild(wrap);

      function close(val) {
        scrim.classList.remove('ui-open');
        sheetStack = sheetStack.filter(function (s) { return s.scrim !== scrim; });
        if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
        unlockScroll();
        if (opener && typeof opener.focus === 'function') {
          try { opener.focus({ preventScroll: true }); } catch (_) {}
        }
        resolve(val);
      }
      function onKey(e) {
        if (e.key === 'Escape') {
          var top = sheetStack[sheetStack.length - 1];
          if (top && top.scrim === scrim) { e.preventDefault(); close(null); }
        } else if (e.key === 'Tab') {
          trapFocus(wrap, e);
        }
      }
      head.querySelector('.ui-x').addEventListener('click', function () { close(null); });
      scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(null); });

      document.body.appendChild(scrim);
      scrim.classList.add('ui-open');
      lockScroll();
      document.addEventListener('keydown', onKey, true);
      sheetStack.push({ scrim: scrim, close: close });
      requestAnimationFrame(function () {
        var first = list.querySelector('.ui-sheet-row');
        if (first) first.focus();
      });
    });
  }

  // ─── PUBLIC: raw modal ───────────────────────────────────────
  function publicModal(cfg) { return modal(cfg); }
  function closeTop() {
    if (sheetStack.length) { sheetStack[sheetStack.length - 1].close(null); return; }
    if (modalStack.length) { modalStack[modalStack.length - 1].close(null); }
  }

  // ─── EXPOSE ──────────────────────────────────────────────────
  window.UI = {
    toast: toast,
    confirm: confirm,
    prompt: prompt,
    reason: reason,
    stepUp: stepUp,
    sheet: sheet,
    modal: publicModal,
    close: closeTop,
    _escape: escapeHtml,
    _el: el
  };
})();