// /js/admin-settings.js
// ─────────────────────────────────────────────────────────────────
// MilesSpace Admin → Settings, external script.
//
// Depends on:
//   /js/admin-session.js   → window.AdminSession.fetch()
//   /js/ui-kit.js          → window.UI.{toast,confirm,prompt,reason,stepUp,sheet}
//
// This file owns:
//   • state (flat/original/dirty/version/sections/meta)
//   • dirty-tracking with canonical comparison
//   • save pipeline with error-code handling
//   • per-panel rendering for every panel
//   • previews, providers, health, history, status banner
//   • role editor + permission groups
//   • MFA flows (enroll / disable / regenerate)
//   • Rate History & Audit tab pagination + CSV
//   • sheet, keyboard nav, boot
//
// Fixes applied vs the previous draft:
//   • wireLogo() is now inside bindGlobal() (was at module top level,
//     ran before the DOM existed, so the brand image fallback never
//     attached).
//   • crossFieldErrors(merged, patchKeys) only fires a rule when at
//     least one of the two keys is in the current patch. Toggling
//     maintenance_mode can no longer be blocked by a pre-existing
//     min_deposit > max_deposit inconsistency in the DB.
//   • The invalid-field toast names the exact offending fields.
// ─────────────────────────────────────────────────────────────────
'use strict';

(function () {
  // Guard: never run twice.
  if (window.__MS_SETTINGS_LOADED__) return;
  window.__MS_SETTINGS_LOADED__ = true;

  // ─── API ENDPOINTS ──────────────────────────────────────────
  const API = Object.freeze({
    all:              '/api/admin/settings',
    section:          (n) => '/api/admin/settings/section/' + encodeURIComponent(n),
    preview:          '/api/admin/settings/preview',
    rateHistory:      '/api/admin/settings/rates/history',
    restore:          '/api/admin/settings/restore',
    resetSection:     (n) => '/api/admin/settings/reset/' + encodeURIComponent(n),
    audit:            '/api/admin/settings/audit',
    auditCsv:         '/api/admin/settings/audit/export.csv',
    health:           '/api/admin/settings/health',
    providersStatus:  '/api/admin/settings/providers/status',
    me:               '/api/admin/me',
    mfaStatus:        '/api/admin/mfa/status',
    mfaEnroll:        '/api/admin/mfa/enroll',
    mfaVerify:        '/api/admin/mfa/verify-enrollment',
    mfaDisable:       '/api/admin/mfa/disable',
    mfaRegen:         '/api/admin/mfa/recovery-codes/regenerate',
    mfaStepUp:        '/api/admin/auth/step-up',
    roles:            '/api/admin/roles',
    rolesPerms:       '/api/admin/roles/permissions',
    rolesUserSearch:  '/api/admin/roles/users',
    rolesAssign:      '/api/admin/roles/assign',
    roleBySlug:       (s) => '/api/admin/roles/' + encodeURIComponent(s),
    stepUp:           '/api/admin/auth/step-up'
  });

  // ─── CLIENT-SIDE KEY METADATA ───────────────────────────────
  const KEY_META = Object.freeze({
    usd_to_ngn:                      { shape: 'decimal', decimals: 2, min: '1',  max: '1000000', financial: true, dangerous: true },
    deposit_fee_flat_ngn:            { shape: 'decimal', decimals: 2, financial: true },
    deposit_fee_pct:                 { shape: 'percent', decimals: 4, financial: true },
    deposit_fee_min_ngn:             { shape: 'decimal', decimals: 2, financial: true },
    deposit_fee_max_ngn:             { shape: 'decimal', decimals: 2, financial: true },
    deposit_rate_NGN:                { shape: 'decimal', decimals: 8, financial: true, dangerous: true },
    deposit_rate_GHS:                { shape: 'decimal', decimals: 8, financial: true, dangerous: true },
    deposit_rate_KES:                { shape: 'decimal', decimals: 8, financial: true, dangerous: true },
    deposit_rate_ZAR:                { shape: 'decimal', decimals: 8, financial: true, dangerous: true },
    deposit_rate_XOF:                { shape: 'decimal', decimals: 8, financial: true, dangerous: true },
    deposit_rate_XAF:                { shape: 'decimal', decimals: 8, financial: true, dangerous: true },
    deposit_rate_TZS:                { shape: 'decimal', decimals: 8, financial: true, dangerous: true },
    deposit_rate_EGP:                { shape: 'decimal', decimals: 8, financial: true, dangerous: true },
    giftcard_markup_pct_usd:         { shape: 'percent', decimals: 4, financial: true },
    giftcard_markup_pct_ngn:         { shape: 'percent', decimals: 4, financial: true },
    esim_markup_pct_usd:             { shape: 'percent', decimals: 4, financial: true },
    esim_markup_pct_ngn:             { shape: 'percent', decimals: 4, financial: true },
    airtime_markup_pct_usd:          { shape: 'percent', decimals: 4, financial: true },
    airtime_markup_pct_ngn:          { shape: 'percent', decimals: 4, financial: true },
    boost_markup_pct:                { shape: 'percent', decimals: 4, financial: true },
    marketplace_markup_pct:          { shape: 'percent', decimals: 4, financial: true },
    virtual_sms_markup_pct:          { shape: 'percent', decimals: 4, financial: true },
    min_deposit_ngn:                 { shape: 'decimal', decimals: 2, financial: true },
    max_deposit_ngn:                 { shape: 'decimal', decimals: 2, financial: true },
    daily_deposit_limit_ngn:         { shape: 'decimal', decimals: 2, financial: true },
    giftcard_min_trade_ngn:          { shape: 'decimal', decimals: 2 },
    giftcard_max_trade_ngn:          { shape: 'decimal', decimals: 2 },
    airtime_min_ngn:                 { shape: 'decimal', decimals: 2 },
    airtime_max_ngn:                 { shape: 'decimal', decimals: 2 },
    esim_min_ngn:                    { shape: 'decimal', decimals: 2 },
    esim_max_ngn:                    { shape: 'decimal', decimals: 2 },
    virtual_sms_min_ngn:             { shape: 'decimal', decimals: 2 },
    virtual_sms_max_ngn:             { shape: 'decimal', decimals: 2 },
    boost_min_ngn:                   { shape: 'decimal', decimals: 2 },
    boost_max_ngn:                   { shape: 'decimal', decimals: 2 },
    maintenance_mode:                { shape: 'boolean', dangerous: true },
    maintenance_message:             { shape: 'value',   dangerous: true, maxLength: 500 },
    emergency_stop_deposits:         { shape: 'boolean', dangerous: true },
    emergency_stop_purchases:        { shape: 'boolean', dangerous: true },
    emergency_stop_provider_requests:{ shape: 'boolean', dangerous: true },
    emergency_stop_wallet_mutations: { shape: 'boolean', dangerous: true },
    session_timeout_hours:           { shape: 'int', min: 1, max: 168 },
    failed_login_attempts:           { shape: 'int', min: 3, max: 20 },
    require_2fa:                     { shape: 'boolean' },
    config_version:                  { shape: 'int', writeForbidden: true }
  });

  const FINANCIAL_PREFIXES = Object.freeze([
    'usd_to_ngn', 'deposit_rate_', 'deposit_fee_',
    'giftcard_markup_', 'esim_markup_', 'airtime_markup_',
    'boost_markup_', 'marketplace_markup_', 'virtual_sms_markup_',
    'min_deposit_', 'max_deposit_', 'daily_deposit_',
    'giftcard_min_', 'giftcard_max_', 'airtime_min_', 'airtime_max_',
    'esim_min_', 'esim_max_', 'virtual_sms_min_', 'virtual_sms_max_',
    'boost_min_', 'boost_max_'
  ]);
  const DANGEROUS_KEYS = Object.freeze([
    'maintenance_mode', 'maintenance_message',
    'emergency_stop_deposits', 'emergency_stop_purchases',
    'emergency_stop_provider_requests', 'emergency_stop_wallet_mutations'
  ]);
  const EMERGENCY_KEYS = Object.freeze(new Set([
    'emergency_stop_deposits', 'emergency_stop_purchases',
    'emergency_stop_provider_requests', 'emergency_stop_wallet_mutations',
    'maintenance_mode', 'maintenance_message'
  ]));

  const RESET_FORBIDDEN_SECTIONS = new Set(['rates', 'fees', 'emergency']);

  // ─── STATE ──────────────────────────────────────────────────
  const State = {
    flat: {},
    original: {},
    dirty: {},
    version: null,
    isSuperAdmin: false,
    permissions: new Set(),
    currentSection: 'general',
    saving: false,
    loading: false,
    pendingIdempotencyKey: null,
    lastSaveStartedAt: 0,

    timezone: 'Africa/Lagos',

    historyLoaded: false,
    historyRows: [],
    historyFilterKey: '',
    historyLimit: 100,
    historyOffset: 0,
    historyTotal: 0,

    healthLoaded: false,
    healthData: null,

    providersStatus: null,

    rolesLoaded: false,
    rolesAvailable: true,
    roles: [],
    permissionGroups: [],

    auditLoaded: false,
    auditRows: [],
    auditFilters: { key: '', adminId: '', from: '', to: '' },
    auditLimit: 100,
    auditOffset: 0,
    auditTotal: 0
  };

  // ─── DOM HELPERS ────────────────────────────────────────────
  const $  = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const escapeHtml = (s) => s == null ? '' : String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  function formatDateTime(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('en-GB', {
        timeZone: State.timezone || 'Africa/Lagos',
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (_) { return String(iso); }
  }
  function timeAgo(iso) {
    if (!iso) return '—';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  // ─── DECIMAL-STRING HELPERS ─────────────────────────────────
  const DEC_RE = /^-?\d+(\.\d+)?$/;
  function isDecimalString(s) {
    return typeof s === 'string' && DEC_RE.test(s);
  }
  function canonicalDecimal(s, decimals) {
    if (s == null || s === '') return '';
    const str = String(s).trim();
    if (!DEC_RE.test(str)) return str;
    const neg = str.startsWith('-');
    const unsigned = neg ? str.slice(1) : str;
    const [i, f = ''] = unsigned.split('.');
    const pad = decimals == null ? 0 : decimals;
    const frac = pad === 0 ? '' : (f + '0'.repeat(pad)).slice(0, pad);
    return (neg ? '-' : '') + (i || '0') + (pad ? '.' + frac : '');
  }
  function percentDisplayToDecimal(display) {
    if (!isDecimalString(String(display || ''))) return '';
    const s = String(display);
    const neg = s.startsWith('-');
    const body = neg ? s.slice(1) : s;
    const [i, f = ''] = body.split('.');
    const paddedF = (f + '0000').slice(0, 4);
    const combined = (i || '0') + paddedF.slice(0, 2);
    const dot = combined.length - 2;
    let fracStr;
    let intStr;
    if (dot <= 0) {
      intStr = '0';
      fracStr = (combined + '0000').slice(0, 4);
    } else {
      intStr = combined.slice(0, dot);
      fracStr = (combined.slice(dot) + paddedF.slice(2) + '0000').slice(0, 4);
    }
    return (neg ? '-' : '') + (intStr || '0') + '.' + fracStr;
  }
  function decimalToPercentDisplay(dec, decimals) {
    if (!isDecimalString(String(dec || ''))) return '';
    const s = String(dec);
    const neg = s.startsWith('-');
    const body = neg ? s.slice(1) : s;
    const [i, f = ''] = body.split('.');
    const intStr = (i || '0');
    const fracStr = f + '00';
    const padded = intStr + fracStr;
    const dotAt = intStr.length + 2;
    let shownInt, shownFrac;
    if (padded.length <= dotAt) {
      shownInt = padded.padStart(dotAt, '0').slice(0, dotAt);
      shownFrac = padded.slice(dotAt).padEnd(4, '0').slice(0, 4);
    } else {
      shownInt = padded.slice(0, dotAt);
      shownFrac = padded.slice(dotAt).slice(0, 4);
    }
    shownFrac = shownFrac.replace(/0+$/, '');
    if (shownFrac.length < 2) shownFrac = (shownFrac + '00').slice(0, 2);
    return (neg ? '-' : '') + shownInt.replace(/^0+(?=\d)/, '') + '.' + shownFrac;
  }

  // ─── FIELD VALUE EXTRACTION ─────────────────────────────────
  function fieldForKey(key) {
    return document.querySelector('[data-key="' + CSS.escape(key) + '"]');
  }
  function currentDisplayValue(key) {
    const el = fieldForKey(key);
    if (!el) return null;
    if (el.type === 'checkbox') return el.checked ? 'true' : 'false';
    return String(el.value);
  }
  function displayToCanonical(key, display) {
    const meta = KEY_META[key] || {};
    if (meta.shape === 'percent') {
      const d = percentDisplayToDecimal(String(display || ''));
      return canonicalDecimal(d, meta.decimals != null ? meta.decimals : 4);
    }
    if (meta.shape === 'decimal') {
      return canonicalDecimal(String(display || ''), meta.decimals != null ? meta.decimals : 2);
    }
    if (meta.shape === 'boolean') {
      return display === true || display === 'true' || display === '1' ? 'true' : 'false';
    }
    if (meta.shape === 'int') {
      return String(display == null ? '' : display).trim();
    }
    return String(display == null ? '' : display);
  }
  function canonicalToDisplay(key, canonical) {
    const meta = KEY_META[key] || {};
    if (canonical == null) return '';
    if (meta.shape === 'percent') {
      return decimalToPercentDisplay(String(canonical), meta.decimals);
    }
    if (meta.shape === 'decimal') {
      return canonicalDecimal(String(canonical), meta.decimals != null ? meta.decimals : 2);
    }
    return String(canonical);
  }

  // ─── API WRAPPER ────────────────────────────────────────────
  async function api(url, opts) {
    opts = opts || {};
    try {
      const res = await AdminSession.fetch(url, opts);
      if (res.status === 401) {
        if (AdminSession.redirectToLogin) AdminSession.redirectToLogin();
        return { ok: false, reason: 'unauthorized' };
      }
      let body = null;
      try { body = await res.json(); } catch (_) { body = null; }
      if (!res.ok || !body || body.success === false) {
        return {
          ok: false,
          status: res.status,
          reason: (body && body.code) || 'api_error',
          error: (body && body.error) || ('HTTP ' + res.status),
          code: body && body.code,
          extra: body || {}
        };
      }
      return { ok: true, data: body.data !== undefined ? body.data : body, meta: body._meta || {} };
    } catch (e) {
      return { ok: false, reason: 'network_error', error: e.message || 'Network error' };
    }
  }

  // ─── STATUS BANNER ──────────────────────────────────────────
  function renderStatusBanner() {
    const host = $('statusBanner');
    if (!host) return;
    const flags = [
      { key: 'maintenance_mode',                label: 'Platform is in MAINTENANCE MODE' },
      { key: 'emergency_stop_deposits',         label: 'Deposits are STOPPED' },
      { key: 'emergency_stop_purchases',        label: 'Purchases are STOPPED' },
      { key: 'emergency_stop_provider_requests',label: 'Provider requests are STOPPED' },
      { key: 'emergency_stop_wallet_mutations', label: 'Wallet mutations are STOPPED' }
    ];
    const active = flags.filter(f => State.flat[f.key] === 'true' || State.flat[f.key] === true);
    if (!active.length) { host.style.display = 'none'; host.innerHTML = ''; return; }

    host.style.display = '';
    host.innerHTML = '';

    const bar = document.createElement('div');
    bar.style.cssText = 'background:var(--danger-bg);border:1px solid var(--danger);color:var(--danger);' +
                        'padding:12px 14px;border-radius:12px;margin-bottom:14px;display:flex;gap:12px;' +
                        'align-items:flex-start;flex-wrap:wrap;font-size:13px;font-weight:600';
    const icon = document.createElement('i');
    icon.className = 'fas fa-exclamation-triangle';
    icon.style.cssText = 'font-size:16px;flex-shrink:0;margin-top:2px';
    const msg = document.createElement('div');
    msg.style.cssText = 'flex:1;min-width:220px;line-height:1.5';
    msg.innerHTML = active.map(a => '⚠️ ' + escapeHtml(a.label)).join('<br>');
    bar.appendChild(icon);
    bar.appendChild(msg);

    const canEmergency = hasPerm('settings.emergency') || State.isSuperAdmin;
    if (canEmergency) {
      const offWrap = document.createElement('div');
      offWrap.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center';
      active.forEach(a => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn sm';
        btn.innerHTML = '<i class="fas fa-power-off" aria-hidden="true"></i> Turn off ' +
          escapeHtml(a.key.replace(/^emergency_stop_/, '').replace(/_/g, ' '));
        btn.addEventListener('click', async () => {
          const ok = await UI.confirm({
            title: 'Turn off ' + a.key,
            body: 'This will restore normal operation for the affected surface. Requires a reason.',
            okLabel: 'Turn off',
            kind: 'primary'
          });
          if (!ok) return;
          const reason = await UI.reason({ title: 'Reason required', message: 'Explain why ' + a.key + ' is being turned off.' });
          if (!reason) return;
          const patch = {}; patch[a.key] = 'false';
          const saved = await savePatch(patch, 'Turn off ' + a.key, reason, false);
          if (saved) await loadAll();
        });
        offWrap.appendChild(btn);
      });
      bar.appendChild(offWrap);
    }
    host.appendChild(bar);
  }

  // ─── PERMISSION / VISIBILITY ────────────────────────────────
  function hasPerm(p) {
    if (!p) return false;
    if (State.isSuperAdmin) return true;
    return State.permissions.has(p) || State.permissions.has('*');
  }
  function writePermissionForKey(key) {
    if (!key) return 'settings.manage';
    if (key === 'usd_to_ngn'
      || key === 'giftcard_wholesale_currency'
      || key.startsWith('deposit_rate_')
      || key.endsWith('_markup_pct_usd') || key.endsWith('_markup_pct_ngn')
      || key === 'boost_markup_pct' || key === 'marketplace_markup_pct'
      || key === 'virtual_sms_markup_pct') {
      return 'fx.manage';
    }
    if (key.startsWith('service_'))       return 'services.manage';
    if (key.startsWith('provider_'))      return 'providers.manage';
    if (key.startsWith('notify_'))        return 'notifications.manage';
    if (key === 'session_timeout_hours'
      || key === 'failed_login_attempts'
      || key === 'require_2fa'
      || key === 'email_verification')     return 'security.manage';
    if (EMERGENCY_KEYS.has(key))          return 'settings.emergency';
    return 'settings.manage';
  }

  function applyFieldAvailability() {
    $$('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const writable = hasPerm(writePermissionForKey(key));
      const field = el.closest('.field') || el.closest('.toggle-row');

      if (!(key in State.flat)) {
        if (field) field.style.display = 'none';
        return;
      }

      if (field) field.style.display = '';

      if (!writable) {
        el.disabled = true;
        el.setAttribute('aria-disabled', 'true');
        const f = el.closest('.field');
        if (f && !f.querySelector('.view-only-badge')) {
          const badge = document.createElement('span');
          badge.className = 'view-only-badge';
          badge.style.cssText = 'font-size:10px;font-weight:700;color:var(--text-faint);' +
                                'background:var(--surface-2);padding:2px 6px;border-radius:6px;' +
                                'margin-left:6px';
          badge.innerHTML = '<i class="fas fa-lock" aria-hidden="true"></i> View only';
          const label = f.querySelector('label');
          if (label) label.appendChild(badge);
        }
        if (el.type === 'checkbox') {
          const t = el.closest('label.toggle');
          if (t) t.style.opacity = '0.55';
        }
      } else {
        el.disabled = false;
        el.removeAttribute('aria-disabled');
        const f = el.closest('.field');
        const badge = f && f.querySelector('.view-only-badge');
        if (badge) badge.remove();
        if (el.type === 'checkbox') {
          const t = el.closest('label.toggle');
          if (t) t.style.opacity = '';
        }
      }
    });
  }

  function applyNotConfiguredBadges() {
    $$('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const val = State.flat[key];
      const meta = KEY_META[key] || {};
      const isFinancial = meta.financial === true;
      const field = el.closest('.field');
      const existing = field && field.querySelector('.not-configured-badge');
      if (isFinancial && val == null) {
        el.setAttribute('placeholder', 'NOT CONFIGURED');
        el.style.borderColor = 'var(--danger)';
        if (field && !existing) {
          const badge = document.createElement('div');
          badge.className = 'not-configured-badge';
          badge.style.cssText = 'font-size:11px;color:var(--danger);margin-top:4px;font-weight:600';
          badge.innerHTML = '<i class="fas fa-exclamation-triangle" aria-hidden="true"></i> Not configured — set a value';
          field.appendChild(badge);
        }
      } else {
        el.style.borderColor = '';
        if (existing) existing.remove();
      }
    });
  }

  // ─── LOAD + RENDER ──────────────────────────────────────────
  async function loadAll() {
    if (State.loading) return;
    State.loading = true;

    const refreshBtn = $('refreshBtn');
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.classList.add('spinning'); }

    const res = await api(API.all);

    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.classList.remove('spinning'); }
    State.loading = false;

    if (!res.ok) {
      UI.toast('Failed to load settings: ' + (res.error || res.reason || 'unknown'), 'error');
      return;
    }

    State.flat = {};
    State.original = {};
    State.dirty = {};

    const sections = res.data && res.data.sections ? res.data.sections : {};
    Object.keys(sections).forEach((section) => {
      const bucket = sections[section] || {};
      Object.keys(bucket).forEach((k) => { State.flat[k] = bucket[k]; });
    });
    State.version = res.data && res.data.version != null ? res.data.version : null;
    if (State.flat.timezone) State.timezone = String(State.flat.timezone);

    Object.keys(State.flat).forEach((k) => { State.original[k] = State.flat[k]; });

    renderAllFields();
    applyFieldAvailability();
    applyNotConfiguredBadges();
    renderStatusBanner();
    renderServicesPanel();
    renderProvidersPanel();
    loadProvidersStatus();

    updateVersionBadge();
    updateDirtyBar();
    updateSectionDots();
    refreshPreviews();
  }

  function renderAllFields() {
    $$('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      if (!(key in State.flat)) return;
      const raw = State.flat[key];
      const meta = KEY_META[key] || {};
      if (raw == null) { el.value = el.type === 'checkbox' ? false : ''; return; }
      if (el.type === 'checkbox') {
        el.checked = raw === true || raw === 'true' || raw === 1 || raw === '1';
      } else if (meta.shape === 'percent') {
        el.value = canonicalToDisplay(key, raw);
      } else if (meta.shape === 'decimal') {
        el.value = canonicalToDisplay(key, raw);
      } else {
        el.value = String(raw);
      }
    });
  }

  function updateVersionBadge() {
    const el = $('versionBadge');
    if (!el) return;
    if (State.version == null) {
      el.className = 'badge off';
      el.innerHTML = '<i class="fas fa-code-branch" aria-hidden="true"></i> v—';
    } else {
      el.className = 'badge ok';
      el.innerHTML = '<i class="fas fa-code-branch" aria-hidden="true"></i> v' + escapeHtml(String(State.version));
    }
  }

  // ─── DIRTY TRACKING ─────────────────────────────────────────
  function markDirty(key) {
    const meta = KEY_META[key] || {};
    const currentDisplay = currentDisplayValue(key);
    const currentCanonical = displayToCanonical(key, currentDisplay);
    const originalCanonical = canonicalDecimal(
      String(State.original[key] == null ? '' : State.original[key]),
      meta.decimals != null ? meta.decimals : 0
    );
    const same = String(currentCanonical) === String(originalCanonical);
    if (same) delete State.dirty[key];
    else State.dirty[key] = currentCanonical;
    updateDirtyBar();
    updateSectionDots();
  }

  function updateDirtyBar() {
    const bar = $('dirtyBar');
    const cnt = $('dirtyCount');
    if (!bar || !cnt) return;
    const n = Object.keys(State.dirty).length;
    if (n === 0) { bar.classList.remove('show'); return; }
    bar.classList.add('show');
    cnt.textContent = n + ' unsaved change' + (n === 1 ? '' : 's');
  }

  function updateSectionDots() {
    const sectionHas = {};
    Object.keys(State.dirty).forEach((key) => {
      const el = fieldForKey(key);
      if (!el) return;
      const panel = el.closest('.panel');
      if (!panel) return;
      sectionHas[panel.id.replace(/^panel-/, '')] = true;
    });
    $$('#sideMenu .m-item').forEach((btn) => {
      const dot = btn.querySelector('.dot');
      if (dot) dot.hidden = !sectionHas[btn.dataset.section];
    });
  }

  function discardDirty() {
    if (Object.keys(State.dirty).length === 0) return;
    State.dirty = {};
    renderAllFields();
    renderServicesPanel();
    renderProvidersPanel();
    applyFieldAvailability();
    applyNotConfiguredBadges();
    updateDirtyBar();
    updateSectionDots();
    UI.toast('Unsaved changes discarded', 'info');
  }

  function collectSectionPatch(section) {
    const panel = $('panel-' + section);
    if (!panel) return {};
    const patch = {};
    panel.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      if (!(key in State.dirty)) return;
      const canonical = State.dirty[key];
      if (State.original[key] != null) {
        patch[key] = { value: canonical, previous: String(State.original[key]) };
      } else {
        patch[key] = canonical;
      }
    });
    return patch;
  }

  function needsReason(keys) {
    return keys.some((k) => {
      if (DANGEROUS_KEYS.indexOf(k) !== -1) return true;
      for (let i = 0; i < FINANCIAL_PREFIXES.length; i++) {
        const p = FINANCIAL_PREFIXES[i];
        if (k === p || k.indexOf(p) === 0) return true;
      }
      return false;
    });
  }

  // ─── CROSS-FIELD VALIDATION (FIXED) ─────────────────────────
  // Only fires a rule when at least one of its two keys is in the
  // current patch. Prevents unrelated edits (e.g. maintenance_mode)
  // from being blocked by a pre-existing inconsistency in the DB
  // between two keys the user did not touch.
  function crossFieldErrors(merged, patchKeys) {
    const touched = patchKeys ? new Set(patchKeys) : null;
    const errs = [];
    function cmp(a, b) {
      if (!isDecimalString(a) || !isDecimalString(b)) return 0;
      const ai = a.indexOf('.'), bi = b.indexOf('.');
      const aF = ai < 0 ? 0 : a.length - ai - 1;
      const bF = bi < 0 ? 0 : b.length - bi - 1;
      const scale = Math.max(aF, bF, 8);
      const aP = canonicalDecimal(a, scale);
      const bP = canonicalDecimal(b, scale);
      if (aP === bP) return 0;
      return aP < bP ? -1 : 1;
    }
    function ck(aKey, bKey, label) {
      if (touched && !touched.has(aKey) && !touched.has(bKey)) return;
      const a = merged[aKey];
      const b = merged[bKey];
      if (a == null || b == null) return;
      if (cmp(String(a), String(b)) > 0) {
        errs.push({ field: aKey, message: label + ': ' + aKey + ' must be ≤ ' + bKey, aKey, bKey });
      }
    }
    ck('min_deposit_ngn', 'max_deposit_ngn', 'Deposit range');
    ck('max_deposit_ngn', 'daily_deposit_limit_ngn', 'Daily limit');
    ck('deposit_fee_min_ngn', 'deposit_fee_max_ngn', 'Deposit fee range');
    ck('deposit_fee_flat_ngn', 'deposit_fee_max_ngn', 'Flat fee within fee range');
    ck('giftcard_min_trade_ngn', 'giftcard_max_trade_ngn', 'Gift card range');
    ck('airtime_min_ngn', 'airtime_max_ngn', 'Airtime range');
    ck('esim_min_ngn', 'esim_max_ngn', 'eSIM range');
    ck('virtual_sms_min_ngn', 'virtual_sms_max_ngn', 'Virtual SMS range');
    ck('boost_min_ngn', 'boost_max_ngn', 'Boost range');
    return errs;
  }

  function setFieldError(key, message) {
    const el = fieldForKey(key);
    if (!el) return;
    const field = el.closest('.field');
    if (!field) return;
    field.classList.toggle('has-error', !!message);
    const err = field.querySelector('.error');
    if (err) err.textContent = message || '';
    if (message) {
      el.setAttribute('aria-invalid', 'true');
    } else {
      el.removeAttribute('aria-invalid');
    }
  }

  function clearAllFieldErrors() {
    $$('.field.has-error').forEach((f) => {
      f.classList.remove('has-error');
      const err = f.querySelector('.error');
      if (err) err.textContent = '';
      const inp = f.querySelector('[data-key]');
      if (inp) inp.removeAttribute('aria-invalid');
    });
  }

  function scrollToField(key) {
    const el = fieldForKey(key);
    if (!el) return;
    const panel = el.closest('.panel');
    if (panel && !panel.classList.contains('active')) {
      showSection(panel.id.replace(/^panel-/, ''));
    }
    try { el.focus({ preventScroll: false }); } catch (_) { el.focus && el.focus(); }
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
  }

  // ─── SAVE PIPELINE ──────────────────────────────────────────
  async function savePatch(patch, label, reasonOverride, viaDiffModal) {
    if (State.saving) return false;
    const keys = Object.keys(patch);
    if (!keys.length) { UI.toast('Nothing to save', 'info'); return true; }
    if (State.version == null) {
      UI.toast('Cannot save: config version unknown. Reload first.', 'error');
      return false;
    }

    clearAllFieldErrors();
    const merged = Object.assign({}, State.flat);
    keys.forEach((k) => {
      const v = patch[k] && typeof patch[k] === 'object' ? patch[k].value : patch[k];
      merged[k] = v;
    });
    const cf = crossFieldErrors(merged, keys);
    if (cf.length) {
      cf.forEach((e) => setFieldError(e.field, e.message));
      scrollToField(cf[0].field);
      const names = cf.map(e => e.field).filter((v, i, a) => a.indexOf(v) === i);
      UI.toast(
        'Fix ' + names.join(', ') + ' before saving. ' +
        (cf[0] && cf[0].message ? cf[0].message : ''),
        'warn'
      );
      return false;
    }

    let reason = reasonOverride || null;
    if (needsReason(keys) && !reason) {
      reason = await UI.reason({
        title: 'Reason required',
        message: 'This change affects financial or emergency settings. Enter a reason (min 4 chars).'
      });
      if (!reason) return false;
    }

    if (!viaDiffModal) {
      const confirmed = await reviewDiffModal(patch, label);
      if (!confirmed) return false;
    }

    return await _sendPatch(patch, { label, reason, confirmLargeChange: false });
  }

  async function _sendPatch(patch, ctx) {
    if (State.saving) return false;
    State.saving = true;

    const idemKey = crypto.randomUUID
      ? crypto.randomUUID()
      : 'idem-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    State.pendingIdempotencyKey = idemKey;
    State.lastSaveStartedAt = Date.now();

    $$('[data-action="save-section"], #dirtyBar [data-dirty-action="save"]')
      .forEach((b) => { b.disabled = true; b.classList.add('spinning'); });

    let res;
    try {
      res = await api(API.all, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idemKey
        },
        body: JSON.stringify({
          settings: patch,
          reason: ctx.reason || null,
          expectedVersion: State.version,
          confirmLargeChange: !!ctx.confirmLargeChange
        })
      });
    } finally {
      State.saving = false;
      $$('[data-action="save-section"], #dirtyBar [data-dirty-action="save"]')
        .forEach((b) => { b.disabled = false; b.classList.remove('spinning'); });
    }

    if (res.ok) {
      State.pendingIdempotencyKey = null;
      await _onSaveSuccess(res.data, ctx);
      return true;
    }

    const code = res.code || res.reason;

    if (code === 'LARGE_CHANGE_REQUIRES_CONFIRMATION') {
      const payload = res.extra || {};
      const key = payload.key;
      const oldV = payload.old_value;
      const newV = payload.new_value;
      const pct = _pctChange(oldV, newV);
      const ok = await UI.confirm({
        title: 'Confirm large change',
        body: 'The change to <strong>' + escapeHtml(key || 'this key') + '</strong> is ' +
              (pct ? '<strong>' + escapeHtml(pct) + '</strong> ' : '') + 'larger than 10%:' +
              '<div style="margin-top:10px;padding:10px;border-radius:8px;background:var(--surface-2);font-family:\'JetBrains Mono\',monospace;font-size:12px">' +
              escapeHtml(String(oldV)) + '  →  <strong>' + escapeHtml(String(newV)) + '</strong>' +
              '</div><p style="margin-top:10px">Send with confirmation to proceed.</p>',
        okLabel: 'Yes, apply this change',
        kind: 'danger'
      });
      if (!ok) { UI.toast('Save cancelled', 'info'); return false; }
      return await _sendPatch(patch, Object.assign({}, ctx, { confirmLargeChange: true }));
    }

    if (code === 'KEY_CONFLICT') {
      const payload = res.extra || {};
      await _handleKeyConflict(patch, ctx, payload);
      return false;
    }

    if (code === 'CONFIG_VERSION_CONFLICT' || code === 'CONFIG_VERSION_REQUIRED') {
      await _handleVersionConflict(patch, ctx, res.extra || {});
      return false;
    }

    if (code === 'CROSS_FIELD_INVALID') {
      const payload = res.extra || {};
      if (payload.aKey) setFieldError(payload.aKey, res.error || 'Conflicts with another field.');
      if (payload.bKey) setFieldError(payload.bKey, res.error || 'Conflicts with another field.');
      scrollToField(payload.aKey || payload.bKey);
      const named = [payload.aKey, payload.bKey].filter(Boolean).join(', ');
      UI.toast(
        'Server rejected the change' +
        (named ? ' (' + named + ')' : '') +
        ': ' + (res.error || 'cross-field rule violation.'),
        'error'
      );
      return false;
    }

    if (code === 'OUT_OF_RANGE' || code === 'INVALID_NUMBER' || code === 'INVALID_PERCENT'
      || code === 'INVALID_INT' || code === 'INVALID_BOOLEAN' || code === 'INVALID_CURRENCY'
      || code === 'INVALID_EMAIL' || code === 'INVALID_URL' || code === 'INVALID_ENUM'
      || code === 'TOO_LONG' || code === 'PERCENT_UNITS_AMBIGUOUS') {
      const payload = res.extra || {};
      const key = payload.key;
      if (key) {
        setFieldError(key, res.error || 'Invalid value.');
        scrollToField(key);
      }
      UI.toast(res.error || 'One of the fields is invalid.', 'error');
      return false;
    }

    if (code === 'REASON_REQUIRED') {
      const reason = await UI.reason({ title: 'Reason required', message: res.error || 'Enter a reason for this change.' });
      if (!reason) return false;
      return await _sendPatch(patch, Object.assign({}, ctx, { reason }));
    }

    if (code === 'PERMISSION_DENIED') {
      UI.toast(res.error || 'You do not have permission for one of these keys.', 'error');
      return false;
    }

    if (code === 'RATE_LIMITED' || res.status === 429) {
      const retry = (res.extra && (res.extra.retry_after_ms || res.extra['retry-after'])) || 30000;
      UI.toast('Too many saves. Retry in ' + Math.ceil(retry / 1000) + 's.', 'warn');
      return false;
    }

    if (code === 'CONFIG_NOT_READY') {
      UI.toast('Configuration is not ready. Run the migration and reload.', 'error');
      return false;
    }

    UI.toast('Save failed: ' + (res.error || code || 'unknown'), 'error');
    return false;
  }

  async function _onSaveSuccess(data, ctx) {
    if (data && data.version != null) State.version = data.version;

    const updated = Array.isArray(data && data.updated) ? data.updated : [];
    const values = data && data.values && typeof data.values === 'object' ? data.values : null;

    if (values) {
      updated.forEach((k) => {
        State.flat[k] = values[k];
        State.original[k] = values[k];
        delete State.dirty[k];
      });
    } else {
      const res = await api(API.all);
      if (res.ok && res.data && res.data.sections) {
        const fresh = {};
        Object.values(res.data.sections).forEach((s) => {
          Object.keys(s).forEach((k) => { fresh[k] = s[k]; });
        });
        updated.forEach((k) => {
          if (k in fresh) {
            State.flat[k] = fresh[k];
            State.original[k] = fresh[k];
          }
          delete State.dirty[k];
        });
        if (res.data.version != null) State.version = res.data.version;
      } else {
        updated.forEach((k) => { delete State.dirty[k]; });
      }
    }

    const unchanged = Array.isArray(data && data.unchanged) ? data.unchanged : [];
    unchanged.forEach((k) => { delete State.dirty[k]; });

    renderAllFields();
    applyFieldAvailability();
    applyNotConfiguredBadges();
    renderStatusBanner();
    renderServicesPanel();
    renderProvidersPanel();
    updateVersionBadge();
    updateDirtyBar();
    updateSectionDots();
    refreshPreviews();

    UI.toast(
      (ctx.label || 'Saved') + ' — ' + updated.length + ' key' + (updated.length === 1 ? '' : 's') + ' updated',
      'success'
    );
  }

  async function _handleKeyConflict(patch, ctx, payload) {
    const key = payload.key;
    const currentValue = payload.current_value;
    const userValue = patch[key] && typeof patch[key] === 'object' ? patch[key].value : patch[key];

    const res = await api(API.all);
    if (!res.ok || !res.data || !res.data.sections) {
      UI.toast('Conflict detected. Reload and try again.', 'error');
      return;
    }
    const fresh = {};
    Object.values(res.data.sections).forEach((s) => {
      Object.keys(s).forEach((k) => { fresh[k] = s[k]; });
    });

    if (key in fresh) {
      State.flat[key] = fresh[key];
      State.original[key] = fresh[key];
    }

    await UI.modal({
      title: 'Someone else edited this field',
      bodyHtml:
        '<p><strong>' + escapeHtml(key) + '</strong> was changed by another admin while you were editing.</p>' +
        '<div style="padding:10px;border-radius:8px;background:var(--surface-2);margin:10px 0;font-size:12.5px">' +
        'Their value: <strong>' + escapeHtml(String(currentValue)) + '</strong><br>' +
        'Your value:  <strong>' + escapeHtml(String(userValue)) + '</strong>' +
        '</div>' +
        '<p>Choose which value to keep, then save again to apply your other edits.</p>',
      okLabel: 'Keep my value',
      cancelLabel: 'Use theirs',
      kind: 'danger'
    }).then((keep) => {
      if (keep) {
        State.dirty[key] = userValue;
      } else {
        delete State.dirty[key];
        renderAllFields();
      }
      updateDirtyBar();
      updateSectionDots();
    });

    UI.toast('Conflict resolved. Review your other edits and save again.', 'info');
  }

  async function _handleVersionConflict(patch, ctx, extra) {
    const res = await api(API.all);
    if (!res.ok || !res.data) {
      UI.toast('Conflict detected. Reload and try again.', 'error');
      return;
    }
    const fresh = {};
    Object.values(res.data.sections || {}).forEach((s) => {
      Object.keys(s).forEach((k) => { fresh[k] = s[k]; });
    });
    Object.keys(fresh).forEach((k) => {
      if (!(k in State.dirty)) {
        State.flat[k] = fresh[k];
        State.original[k] = fresh[k];
      }
    });
    if (res.data.version != null) State.version = res.data.version;

    renderAllFields();
    updateVersionBadge();
    updateDirtyBar();
    updateSectionDots();

    UI.toast('Settings were reloaded. Your edits are preserved — save again to apply.', 'info');
  }

  function _pctChange(oldV, newV) {
    if (!isDecimalString(String(oldV)) || !isDecimalString(String(newV))) return null;
    const oldC = canonicalDecimal(String(oldV), 6);
    const newC = canonicalDecimal(String(newV), 6);
    const oldI = Number.parseFloat(oldC);
    const newI = Number.parseFloat(newC);
    if (!Number.isFinite(oldI) || oldI === 0) return null;
    const pct = ((newI - oldI) / oldI) * 100;
    const sign = pct > 0 ? '+' : '';
    return sign + pct.toFixed(2) + '%';
  }

  function reviewDiffModal(patch, label) {
    const keys = Object.keys(patch);
    const rows = keys.map((k) => {
      const oldV = State.original[k];
      const newV = patch[k] && typeof patch[k] === 'object' ? patch[k].value : patch[k];
      const meta = KEY_META[k] || {};
      const isFin = meta.financial === true;
      return {
        key: k,
        oldV: oldV == null ? '(not set)' : String(oldV),
        newV: newV == null ? '(not set)' : String(newV),
        financial: isFin
      };
    });
    const body =
      '<p>' + escapeHtml(label || 'Summary') + ' — ' + rows.length + ' key' + (rows.length === 1 ? '' : 's') + ' will be saved.</p>' +
      '<div style="max-height:40vh;overflow:auto;border:1px solid var(--border);border-radius:10px">' +
      '<table style="width:100%;border-collapse:collapse;font-size:12.5px">' +
      '<thead><tr style="background:var(--surface-2);text-align:left">' +
      '<th style="padding:8px 10px">Key</th><th style="padding:8px 10px">Old</th><th style="padding:8px 10px">New</th>' +
      '</tr></thead><tbody>' +
      rows.map((r) =>
        '<tr style="border-top:1px solid var(--border)' + (r.financial ? ';background:var(--warn-bg)' : '') + '">' +
        '<td style="padding:8px 10px;font-family:\'JetBrains Mono\',monospace;font-size:11.5px">' + escapeHtml(r.key) + '</td>' +
        '<td style="padding:8px 10px;color:var(--text-dim)">' + escapeHtml(r.oldV) + '</td>' +
        '<td style="padding:8px 10px;font-weight:600">' + escapeHtml(r.newV) + '</td>' +
        '</tr>'
      ).join('') +
      '</tbody></table></div>';
    return UI.confirm({
      title: 'Review before save',
      body: body,
      okLabel: 'Save now',
      kind: 'primary',
      wide: true
    });
  }

  function saveSection(section) {
    const patch = collectSectionPatch(section);
    if (!Object.keys(patch).length) { UI.toast('No changes in this section', 'info'); return; }
    savePatch(patch, 'Save ' + section, null, false);
  }

  async function saveAllDirty() {
    const patch = {};
    Object.keys(State.dirty).forEach((k) => {
      if (State.original[k] != null) {
        patch[k] = { value: State.dirty[k], previous: String(State.original[k]) };
      } else {
        patch[k] = State.dirty[k];
      }
    });
    if (!Object.keys(patch).length) return;
    await savePatch(patch, 'All changes', null, false);
  }

  // ─── PREVIEWS ───────────────────────────────────────────────
  let _previewTimer = null;
  function refreshPreviews() {
    clearTimeout(_previewTimer);
    _previewTimer = setTimeout(_runPreviews, 250);
  }
  async function _runPreviews() {
    const rateEl = $('set-usd_to_ngn');
    const previewEl = document.querySelector('[data-preview-for="usd_to_ngn"]');
    if (!rateEl || !previewEl) return;
    const v = String(rateEl.value || '').trim();
    if (!isDecimalString(v)) { previewEl.textContent = ''; return; }
    previewEl.textContent = '1 USD = ₦' + v.replace(/\.00$/, '');
  }

  // ─── PANELS: SERVICES / PROVIDERS ───────────────────────────
  const SERVICE_DEFS = [
    { key: 'giftcards',   label: 'Gift Cards',        icon: 'fa-gift' },
    { key: 'airtime',     label: 'Airtime & Data',    icon: 'fa-signal' },
    { key: 'bills',       label: 'Bills & Utilities', icon: 'fa-file-invoice' },
    { key: 'esim',        label: 'eSIM',              icon: 'fa-sim-card' },
    { key: 'virtual_sms', label: 'Virtual SMS',       icon: 'fa-comment-sms' },
    { key: 'boost',       label: 'Boost',             icon: 'fa-rocket' },
    { key: 'marketplace', label: 'Marketplace',       icon: 'fa-store' },
    { key: 'crypto',      label: 'Crypto',            icon: 'fa-brands fa-bitcoin' }
  ];
  const PROVIDER_DEFS = [
    { key: 'kora',        label: 'KoraPay',     icon: 'fa-credit-card' },
    { key: 'nowpayments', label: 'NowPayments', icon: 'fa-brands fa-bitcoin' },
    { key: 'vtpass',      label: 'VTpass',      icon: 'fa-signal' },
    { key: 'dtone',       label: 'DT One',      icon: 'fa-globe' }
  ];

  function renderServicesPanel() {
    const box = $('servicesForm');
    if (!box) return;
    const canManage = hasPerm('services.manage');
    box.innerHTML = SERVICE_DEFS.map((s) => {
      const key = 'service_' + s.key + '_enabled';
      if (!(key in State.flat)) return '';
      const checked = State.flat[key] === 'true' || State.flat[key] === true;
      return '<div class="toggle-row">' +
        '<div class="info"><div class="t"><i class="' + s.icon + '" aria-hidden="true" style="color:var(--text-dim);font-size:12px"></i> ' +
        escapeHtml(s.label) + '</div></div>' +
        '<label class="toggle"><input type="checkbox" data-key="' + key + '"' + (checked ? ' checked' : '') +
        (canManage ? '' : ' disabled') + '><span class="slider"></span></label>' +
        '</div>';
    }).join('');
    box.querySelectorAll('[data-key]').forEach((el) => {
      el.addEventListener('change', () => markDirty(el.dataset.key));
    });
  }

  function renderProvidersPanel() {
    const box = $('providersForm');
    if (!box) return;
    const canManage = hasPerm('providers.manage');
    box.innerHTML = PROVIDER_DEFS.map((p) => {
      const enabledKey = 'provider_' + p.key + '_enabled';
      const maintKey   = 'provider_' + p.key + '_maintenance';
      const timeoutKey = 'provider_' + p.key + '_timeout_ms';
      const retryKey   = 'provider_' + p.key + '_retry_count';
      const meta = State.providersStatus && State.providersStatus[p.key];
      const configured = meta ? !!meta.configured : true;
      const cfgBadge = !configured
        ? '<span class="badge err" style="margin-left:8px"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> Not configured</span>'
        : '';
      const disableAll = !canManage || !configured;

      return '<div class="section">' +
        '<div class="section-title"><i class="' + p.icon + '" aria-hidden="true"></i> ' +
        escapeHtml(p.label) + cfgBadge + '</div>' +
        '<div class="toggle-row">' +
          '<div class="info"><div class="t">Enabled</div><div class="d">Backend rejects requests when disabled.</div></div>' +
          '<label class="toggle"><input type="checkbox" data-key="' + enabledKey + '"' +
          ((State.flat[enabledKey] === 'true' || State.flat[enabledKey] === true) ? ' checked' : '') +
          (disableAll ? ' disabled' : '') + '><span class="slider"></span></label>' +
        '</div>' +
        '<div class="toggle-row">' +
          '<div class="info"><div class="t">Maintenance</div><div class="d">Requests fail fast while in maintenance.</div></div>' +
          '<label class="toggle"><input type="checkbox" data-key="' + maintKey + '"' +
          ((State.flat[maintKey] === 'true' || State.flat[maintKey] === true) ? ' checked' : '') +
          (disableAll ? ' disabled' : '') + '><span class="slider"></span></label>' +
        '</div>' +
        (timeoutKey in State.flat
          ? '<div class="field" style="margin-top:12px"><label for="set-' + timeoutKey + '">Timeout (ms)</label>' +
            '<input type="text" id="set-' + timeoutKey + '" data-key="' + timeoutKey + '"' +
            ' inputmode="numeric" autocomplete="off" value="' + escapeHtml(String(State.flat[timeoutKey] || '')) + '"' +
            (disableAll ? ' disabled' : '') + '></div>'
          : '') +
        (retryKey in State.flat
          ? '<div class="field" style="margin-top:12px"><label for="set-' + retryKey + '">Retry count</label>' +
            '<input type="text" id="set-' + retryKey + '" data-key="' + retryKey + '"' +
            ' inputmode="numeric" autocomplete="off" value="' + escapeHtml(String(State.flat[retryKey] || '')) + '"' +
            (disableAll ? ' disabled' : '') + '></div>'
          : '') +
        (configured && hasPerm('providers.test')
          ? '<button type="button" class="btn sm" data-provider-test="' + p.key + '" style="margin-top:12px">' +
            '<i class="fas fa-satellite-dish" aria-hidden="true"></i> Test connection</button>'
          : (configured ? '' : '<div style="font-size:11px;color:var(--text-faint);margin-top:12px">' +
            'Set the provider\'s env secrets to enable this panel.</div>')) +
        '</div>';
    }).join('');
    box.querySelectorAll('[data-key]').forEach((el) => {
      const isCheckbox = el.type === 'checkbox';
      el.addEventListener(isCheckbox ? 'change' : 'input', () => markDirty(el.dataset.key));
    });
    box.querySelectorAll('[data-provider-test]').forEach((btn) => {
      btn.addEventListener('click', () => testProvider(btn.dataset.providerTest, btn));
    });
  }

  async function loadProvidersStatus() {
    const res = await api(API.providersStatus);
    if (!res.ok) { State.providersStatus = null; return; }
    const providers = (res.data && res.data.providers) || [];
    const byKey = {};
    providers.forEach((p) => { byKey[p.key] = p; });
    State.providersStatus = byKey;
    renderProvidersPanel();
  }

  async function testProvider(key, btn) {
    if (!btn) return;
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = '<span class="ui-spin ui-spin-dark" style="width:12px;height:12px"></span> Testing…';
    const res = await api('/api/admin/providers/' + encodeURIComponent(key) + '/test', { method: 'POST' });
    btn.disabled = false;
    btn.innerHTML = original;
    if (res.ok) {
      UI.toast('Provider ' + key + ' is reachable.', 'success');
    } else if (res.status === 404) {
      UI.toast('Test endpoint not implemented. Add POST /api/admin/providers/:key/test to the backend.', 'warn');
    } else {
      UI.toast('Provider test failed: ' + (res.error || 'unknown'), 'error');
    }
  }

  // ─── FIELD LISTENERS ────────────────────────────────────────
  function wireFields() {
    $$('[data-key]').forEach((el) => {
      const handler = () => {
        markDirty(el.dataset.key);
        if (el.dataset.key === 'usd_to_ngn') refreshPreviews();
      };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
  }

  // ─── NAVIGATION ────────────────────────────────────────────
    function showSection(section) {
    if (!section) return;
    const panel = $('panel-' + section);
    if (!panel) return;
    // Leaving the MFA panel → wipe any rendered recovery codes.
    if (State.currentSection === 'mfa' && section !== 'mfa') {
      clearRecoveryCodes();
    }
    State.currentSection = section;

    $$('#sideMenu .m-item').forEach((el) => {
      const on = el.dataset.section === section;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
    });
    $$('.panel').forEach((p) => { p.classList.remove('active'); });
    panel.classList.add('active');

    if (section === 'roles' && !State.rolesLoaded) initRolesPanel();
    if (section === 'history') loadHistory();
    if (section === 'health') loadHealth();
        if (section === 'mfa') {
      // Fresh entry to the MFA panel — start with a clean slate.
      clearRecoveryCodes();
      loadMfaStatus();
    }
    if (section === 'emergency') renderStatusBanner();
    if (section === 'audit' && !State.auditLoaded) loadAudit();

    try { history.replaceState(null, '', '#' + section); } catch (_) {}
  }

  // ─── HISTORY (rate history) ────────────────────────────────
  async function loadHistory(reset) {
    const list = $('historyList');
    const stateEl = $('historyState');
    if (!list) return;
    if (reset) {
      State.historyOffset = 0;
      State.historyRows = [];
    }

    if (stateEl) { stateEl.hidden = true; stateEl.innerHTML = ''; }
    list.innerHTML = '<div class="state" style="padding:14px"><span class="skel" style="width:60%;margin:0 auto"></span></div>';

    const params = new URLSearchParams();
    params.set('limit', String(State.historyLimit));
    params.set('offset', String(State.historyOffset));
    if (State.historyFilterKey) params.set('key', State.historyFilterKey);

    const res = await api(API.rateHistory + '?' + params.toString());
    if (!res.ok) {
      list.innerHTML = '<div class="state" style="padding:14px"><i class="fas fa-triangle-exclamation"></i>' +
                       '<div class="msg">Unable to load history</div>' +
                       '<div class="sub">' + escapeHtml(res.error || res.reason || '') + '</div></div>';
      return;
    }
    const rows = Array.isArray(res.data && res.data.rows) ? res.data.rows : [];
    const total = Number(res.data && res.data.total) || rows.length;
    State.historyRows = State.historyRows.concat(rows);
    State.historyTotal = total;
    State.historyLoaded = true;
    State.historyOffset = State.historyRows.length;

    if (!State.historyRows.length) {
      list.innerHTML = '<div class="state" style="padding:22px"><i class="fas fa-inbox" aria-hidden="true"></i>' +
                       '<div class="msg">No rate changes yet</div></div>';
      return;
    }

    const canRestore = hasPerm('fx.manage');
    const canSeeKey = (k) => !k || hasPerm(writePermissionForKey(k));

    const html = State.historyRows.filter(r => canSeeKey(r.key)).map((r) => {
      const restoreBtn = canRestore
        ? '<button type="button" class="btn sm" data-history-restore="' + escapeHtml(r.id) + '"' +
          ' data-history-key="' + escapeHtml(r.key) + '"><i class="fas fa-rotate-left" aria-hidden="true"></i> Restore</button>'
        : '';
      return '<div class="hist-row">' +
        '<div class="when" title="' + escapeHtml(formatDateTime(r.changed_at)) + '">' + escapeHtml(timeAgo(r.changed_at)) + '</div>' +
        '<div class="what"><strong>' + escapeHtml(r.key) + '</strong>' +
          '<span class="from-to">' + escapeHtml(r.previous_value == null ? '—' : String(r.previous_value)) +
          ' → <strong style="color:var(--text)">' + escapeHtml(r.new_value == null ? '—' : String(r.new_value)) + '</strong></span></div>' +
        '<div class="by">' + escapeHtml(r.changed_by_display || r.changed_by_email || 'Unknown') + restoreBtn + '</div>' +
        '</div>';
    }).join('');

    const moreBtn = State.historyRows.length < State.historyTotal
      ? '<div style="text-align:center;padding:14px"><button type="button" class="btn" id="historyMoreBtn">' +
        '<i class="fas fa-chevron-down" aria-hidden="true"></i> Load more (' +
        (State.historyTotal - State.historyRows.length) + ' left)</button></div>'
      : '';

    list.innerHTML =
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
        '<div class="field" style="flex:1;min-width:220px;margin:0"><label for="historyKeyFilter">Filter by key</label>' +
        '<select id="historyKeyFilter"><option value="">All keys</option>' +
        Array.from(new Set(State.historyRows.map(r => r.key))).sort().map(k =>
          '<option value="' + escapeHtml(k) + '"' + (State.historyFilterKey === k ? ' selected' : '') + '>' + escapeHtml(k) + '</option>'
        ).join('') +
        '</select></div>' +
      '</div>' +
      html + moreBtn;

    const sel = $('historyKeyFilter');
    if (sel) sel.addEventListener('change', () => {
      State.historyFilterKey = sel.value;
      loadHistory(true);
    });
    const more = $('historyMoreBtn');
    if (more) more.addEventListener('click', () => loadHistory(false));

    list.querySelectorAll('[data-history-restore]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const historyId = btn.dataset.historyRestore;
        const key = btn.dataset.historyKey;
        const ok = await UI.confirm({
          title: 'Restore ' + key,
          body: 'This will overwrite the current value of ' + key + ' with the previous historical value. Requires a reason.',
          okLabel: 'Restore', kind: 'danger'
        });
        if (!ok) return;
        const reason = await UI.reason({
          title: 'Reason required',
          message: 'Why is ' + key + ' being restored?'
        });
        if (!reason) return;
        const res = await api(API.restore, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key,
            historyId,
            reason,
            expectedVersion: State.version
          })
        });
        if (!res.ok) {
          if (res.code === 'LARGE_CHANGE_REQUIRES_CONFIRMATION') {
            const payload = res.extra || {};
            const ok2 = await UI.confirm({
              title: 'Confirm restore',
              body: 'Restoring ' + key + ' from ' + payload.old_value + ' to ' + payload.new_value + ' is a large change. Continue?',
              okLabel: 'Restore', kind: 'danger'
            });
            if (!ok2) return;
            UI.toast('Retry the restore — the server rejected the first attempt. Reload and try again.', 'warn');
            return;
          }
          UI.toast('Restore failed: ' + (res.error || res.code || 'unknown'), 'error');
          return;
        }
        UI.toast('Value restored.', 'success');
        await loadAll();
        loadHistory(true);
      });
    });
  }

  // ─── HEALTH ────────────────────────────────────────────────
  async function loadHealth() {
    const list = $('healthList');
    const stateEl = $('healthState');
    if (!list) return;
    if (stateEl) { stateEl.hidden = true; stateEl.innerHTML = ''; }
    list.innerHTML = '<div class="state" style="padding:14px"><span class="skel" style="width:60%;margin:0 auto"></span></div>';

    const res = await api(API.health);
    if (!res.ok) {
      list.innerHTML = '<div class="state" style="padding:22px"><i class="fas fa-triangle-exclamation"></i>' +
                       '<div class="msg">Unable to load health</div>' +
                       '<div class="sub">' + escapeHtml(res.error || res.reason || '') + '</div></div>';
      return;
    }
    State.healthLoaded = true;
    const cfg = (res.data && res.data.configuration) || {};
    State.healthData = cfg;

    const pill = (v) => {
      if (v === 'ok' || v === 'configured') return 'ok';
      if (v === 'missing' || v === 'unavailable' || v === 'none-configured') return 'err';
      if (v === 'partial' || v === 'invalid' || v === 'all-disabled') return 'warn';
      return 'off';
    };
    const areas = [
      ['database', 'Database'],
      ['rates', 'Exchange rates'],
      ['fees', 'Deposit fees'],
      ['services', 'Services'],
      ['providers', 'Providers']
    ];

    let html = areas.map((a) => {
      const v = String(cfg[a[0]] || 'unknown');
      return '<div class="health-row"><div class="label">' + escapeHtml(a[1]) + '</div>' +
             '<div class="value"><span class="badge ' + pill(v) + '">' +
             escapeHtml(v.replace(/-/g, ' ')) + '</span></div></div>';
    }).join('');

    const stale = Array.isArray(cfg.stale_rates) ? cfg.stale_rates : [];
    const missing = Array.isArray(cfg.missing_keys) ? cfg.missing_keys : [];
    if (stale.length || missing.length) {
      html += '<div class="section" style="margin-top:14px">';
      if (stale.length) {
        html += '<div class="section-title"><i class="fas fa-clock" aria-hidden="true"></i> Stale rates</div>';
        stale.forEach((r) => {
          html += '<div class="health-row"><div class="label mono" style="font-size:12px">' + escapeHtml(r.key) + '</div>' +
                  '<div class="value" style="font-weight:400;color:var(--text-dim);font-size:11.5px">' +
                  escapeHtml(formatDateTime(r.last_changed)) + '</div></div>';
        });
      }
      if (missing.length) {
        html += '<div class="section-title" style="margin-top:10px"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> Missing keys</div>';
        missing.forEach((k) => {
          html += '<div class="health-row"><div class="label mono" style="font-size:12px">' + escapeHtml(k) + '</div>' +
                  '<div class="value"><span class="badge err">Not configured</span></div></div>';
        });
      }
      html += '</div>';
    }

    if (State.providersStatus && Object.keys(State.providersStatus).length) {
      html += '<div class="section" style="margin-top:14px">' +
              '<div class="section-title"><i class="fas fa-plug" aria-hidden="true"></i> Provider health</div>';
      Object.keys(State.providersStatus).forEach((key) => {
        const p = State.providersStatus[key];
        let status = 'ok';
        if (!p.configured) status = 'err';
        else if (p.maintenance) status = 'warn';
        else if (!p.enabled) status = 'off';
        html += '<div class="health-row"><div class="label">' + escapeHtml(p.label || key) + '</div>' +
                '<div class="value">' +
                '<span class="badge ' + pill(status) + '">' +
                (p.configured ? (p.maintenance ? 'Maintenance' : (p.enabled ? 'Enabled' : 'Disabled')) : 'Not configured') +
                '</span>' +
                (p.configured && p.timeoutMs ? ' <span style="font-size:11.5px;color:var(--text-dim)">timeout ' + p.timeoutMs + 'ms</span>' : '') +
                '</div></div>';
      });
      html += '</div>';
    }

    html += '<div class="health-row" style="margin-top:8px">' +
            '<div class="label">Config version</div>' +
            '<div class="value">v' + escapeHtml(String(cfg.version == null ? '—' : cfg.version)) + '</div></div>' +
            '<div class="health-row"><div class="label">Checked at</div>' +
            '<div class="value" style="font-weight:400;color:var(--text-dim)">' +
            escapeHtml(formatDateTime(cfg.checked_at)) + '</div></div>';

    list.innerHTML = html;
  }

  // ─── AUDIT TAB ─────────────────────────────────────────────
  async function loadAudit(reset) {
    if (reset) { State.auditOffset = 0; State.auditRows = []; }
    const list = $('auditList');
    const stateEl = $('auditState');
    if (!list) return;
    if (stateEl) { stateEl.hidden = true; stateEl.innerHTML = ''; }
    list.innerHTML = '<div class="state" style="padding:14px"><span class="skel" style="width:60%;margin:0 auto"></span></div>';

    const params = new URLSearchParams();
    params.set('limit', String(State.auditLimit));
    params.set('offset', String(State.auditOffset));
    const f = State.auditFilters || {};
    if (f.key)     params.set('key', f.key);
    if (f.adminId) params.set('adminId', f.adminId);
    if (f.from)    params.set('from', f.from);
    if (f.to)      params.set('to', f.to);

    const res = await api(API.audit + '?' + params.toString());
    if (!res.ok) {
      list.innerHTML = '<div class="state" style="padding:22px"><i class="fas fa-triangle-exclamation"></i>' +
                       '<div class="msg">Unable to load audit</div>' +
                       '<div class="sub">' + escapeHtml(res.error || res.reason || '') + '</div></div>';
      return;
    }
    const rows = Array.isArray(res.data && res.data.rows) ? res.data.rows : [];
    const total = Number(res.data && res.data.total) || rows.length;
    State.auditRows = State.auditRows.concat(rows);
    State.auditTotal = total;
    State.auditLoaded = true;
    State.auditOffset = State.auditRows.length;

    const canExport = hasPerm('audit.export');

    list.innerHTML =
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
        '<div class="field" style="flex:1;min-width:200px;margin:0"><label for="auditKeyFilter">Key</label>' +
        '<input id="auditKeyFilter" type="text" placeholder="e.g. usd_to_ngn" value="' + escapeHtml(f.key || '') + '"></div>' +
        '<div class="field" style="flex:1;min-width:180px;margin:0"><label for="auditAdminFilter">Admin ID</label>' +
        '<input id="auditAdminFilter" type="text" placeholder="UUID" value="' + escapeHtml(f.adminId || '') + '"></div>' +
        '<div class="field" style="flex:1;min-width:160px;margin:0"><label for="auditFrom">From</label>' +
        '<input id="auditFrom" type="date" value="' + escapeHtml(f.from || '') + '"></div>' +
        '<div class="field" style="flex:1;min-width:160px;margin:0"><label for="auditTo">To</label>' +
        '<input id="auditTo" type="date" value="' + escapeHtml(f.to || '') + '"></div>' +
        '<div style="display:flex;align-items:flex-end;gap:6px">' +
          '<button type="button" class="btn primary" id="auditApplyBtn">Apply</button>' +
          (canExport ? '<button type="button" class="btn" id="auditExportBtn"><i class="fas fa-download" aria-hidden="true"></i> CSV</button>' : '') +
        '</div>' +
      '</div>' +
      (rows.length
        ? '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">' +
          '<thead><tr style="background:var(--surface-2);text-align:left">' +
          '<th style="padding:8px 10px">When</th><th style="padding:8px 10px">Admin</th>' +
          '<th style="padding:8px 10px">Key</th><th style="padding:8px 10px">Change</th>' +
          '</tr></thead><tbody>' +
          rows.map((r) => {
            const before = r.before && typeof r.before === 'object' ? (r.before.value != null ? r.before.value : '') : '';
            const after  = r.after  && typeof r.after  === 'object' ? (r.after.value  != null ? r.after.value  : '') : '';
            return '<tr style="border-top:1px solid var(--border)">' +
              '<td style="padding:8px 10px;white-space:nowrap">' + escapeHtml(timeAgo(r.created_at)) + '</td>' +
              '<td style="padding:8px 10px">' + escapeHtml(r.admin_email || '—') + '</td>' +
              '<td style="padding:8px 10px;font-family:\'JetBrains Mono\',monospace;font-size:11.5px">' + escapeHtml(r.target_id || '—') + '</td>' +
              '<td style="padding:8px 10px"><span class="from-to mono" style="font-size:11px">' +
              escapeHtml(String(before)) + ' → <strong>' + escapeHtml(String(after)) + '</strong></span></td>' +
              '</tr>';
          }).join('') +
          '</tbody></table></div>'
        : '<div class="state" style="padding:22px"><i class="fas fa-inbox" aria-hidden="true"></i>' +
          '<div class="msg">No audit rows</div></div>') +
      (State.auditRows.length < State.auditTotal
        ? '<div style="text-align:center;padding:14px"><button type="button" class="btn" id="auditMoreBtn">' +
          '<i class="fas fa-chevron-down" aria-hidden="true"></i> Load more</button></div>'
        : '');

    const apply = $('auditApplyBtn');
    if (apply) apply.addEventListener('click', () => {
      State.auditFilters = {
        key: ($('auditKeyFilter') && $('auditKeyFilter').value || '').trim(),
        adminId: ($('auditAdminFilter') && $('auditAdminFilter').value || '').trim(),
        from: ($('auditFrom') && $('auditFrom').value) || '',
        to:   ($('auditTo') && $('auditTo').value) || ''
      };
      loadAudit(true);
    });
    const more = $('auditMoreBtn');
    if (more) more.addEventListener('click', () => loadAudit(false));
    const exp = $('auditExportBtn');
    if (exp) exp.addEventListener('click', () => {
      const params = new URLSearchParams();
      const f = State.auditFilters || {};
      if (f.key)     params.set('key', f.key);
      if (f.adminId) params.set('adminId', f.adminId);
      if (f.from)    params.set('from', f.from);
      if (f.to)      params.set('to', f.to);
      const url = API.auditCsv + '?' + params.toString();
      const a = document.createElement('a');
      a.href = url;
      a.download = 'settings-audit.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  // ─── ROLES ─────────────────────────────────────────────────
  async function initRolesPanel() {
    const rolesState = $('rolesState');
    if (rolesState) { rolesState.hidden = true; rolesState.innerHTML = ''; }
    const list = $('rolesList');
    if (list) list.innerHTML = '<div class="state" style="padding:22px"><span class="skel" style="width:60%;margin:0 auto"></span></div>';

    const results = await Promise.all([api(API.roles), api(API.rolesPerms)]);
    const rolesRes = results[0];
    const permsRes = results[1];

    if (!rolesRes.ok) {
      State.rolesLoaded = true;
      State.rolesAvailable = false;
      if (list) list.innerHTML = '<div class="state" style="padding:22px">' +
        '<i class="fas fa-triangle-exclamation"></i>' +
        '<div class="msg">Roles unavailable</div>' +
        '<div class="sub">' + escapeHtml(rolesRes.error || 'Unknown error') + '</div>' +
        '<button type="button" class="btn" id="rolesRetryBtn">Retry</button></div>';
      const btn = $('rolesRetryBtn');
      if (btn) btn.addEventListener('click', () => { State.rolesLoaded = false; initRolesPanel(); });
      return;
    }
    const d = rolesRes.data || {};
    if (d.available === false) {
      State.rolesLoaded = true;
      State.rolesAvailable = false;
      if (list) list.innerHTML = '<div class="state" style="padding:22px">' +
        '<i class="fas fa-triangle-exclamation"></i>' +
        '<div class="msg">Roles table not installed</div>' +
        '<div class="sub">Run the roles migration and retry.</div>' +
        '<button type="button" class="btn" id="rolesRetryBtn">Retry</button></div>';
      const btn = $('rolesRetryBtn');
      if (btn) btn.addEventListener('click', () => { State.rolesLoaded = false; initRolesPanel(); });
      return;
    }
    State.rolesLoaded = true;
    State.rolesAvailable = true;
    State.roles = Array.isArray(d.roles) ? d.roles : [];
    State.permissionGroups = Array.isArray(permsRes.data && permsRes.data.groups) ? permsRes.data.groups : [];
    renderRolesList();
  }

  function renderRolesList() {
    const box = $('rolesList');
    if (!box) return;
    if (!State.roles.length) {
      box.innerHTML = '<div class="state" style="padding:22px">' +
        '<i class="fas fa-inbox" aria-hidden="true"></i>' +
        '<div class="msg">No roles yet</div>' +
        '<div class="sub">Click New role to create one.</div></div>';
      return;
    }
    const canManage = hasPerm('admins.manage');
    box.innerHTML = State.roles.map((r) => {
      const isSystem = !!r.is_system;
      const permCount = Array.isArray(r.permissions) ? r.permissions.length : 0;
      const preview = Array.isArray(r.permissions) && r.permissions.indexOf('*') !== -1
        ? 'All permissions'
        : permCount + ' permission' + (permCount === 1 ? '' : 's');
      const editBtn = (!isSystem && canManage)
        ? '<button type="button" class="btn sm" data-role-edit="' + escapeHtml(r.slug) + '" title="Edit"><i class="fas fa-pen" aria-hidden="true"></i></button>' +
          '<button type="button" class="btn sm danger" data-role-delete="' + escapeHtml(r.slug) + '" title="Delete"><i class="fas fa-trash" aria-hidden="true"></i></button>'
        : '';
      return '<div class="role-row">' +
        '<div class="role-name">' +
        '<strong>' + escapeHtml(r.label) + ' ' +
        (isSystem ? '<span class="badge system">System</span>' : '<span class="badge custom">Custom</span>') +
        '</strong>' +
        '<span class="slug">' + escapeHtml(r.slug) + '</span>' +
        '<div class="role-meta"><span>' + escapeHtml(preview) + '</span><span>·</span><span>' +
        (r.user_count || 0) + ' user' + ((r.user_count || 0) === 1 ? '' : 's') + '</span></div>' +
        '</div>' +
        '<div class="role-actions">' +
        '<button type="button" class="btn sm" data-role-view="' + escapeHtml(r.slug) + '" title="View"><i class="fas fa-eye" aria-hidden="true"></i></button>' +
        editBtn +
        '</div></div>';
    }).join('');
    box.querySelectorAll('[data-role-view]').forEach((b) => {
      b.addEventListener('click', () => openRoleViewer(b.dataset.roleView));
    });
    box.querySelectorAll('[data-role-edit]').forEach((b) => {
      b.addEventListener('click', () => openRoleEditor(b.dataset.roleEdit));
    });
    box.querySelectorAll('[data-role-delete]').forEach((b) => {
      b.addEventListener('click', () => deleteRole(b.dataset.roleDelete));
    });
  }

  function openRoleViewer(slug) {
    const role = State.roles.find(r => r.slug === slug);
    if (!role) return;
    const perms = Array.isArray(role.permissions) ? role.permissions : [];
    const wildcard = perms.indexOf('*') !== -1;
    let body = '<p><strong>' + escapeHtml(role.label) + '</strong> — <code>' + escapeHtml(role.slug) + '</code></p>';
    if (role.description) body += '<p>' + escapeHtml(role.description) + '</p>';
    if (wildcard) {
      body += '<p><em>This role has all permissions.</em></p>';
    } else if (!perms.length) {
      body += '<p>No permissions.</p>';
    } else {
      const groups = State.permissionGroups.map((g) => {
        const matched = (g.permissions || []).filter(p => perms.indexOf(p.slug) !== -1);
        return matched.length ? { label: g.label, items: matched } : null;
      }).filter(Boolean);
      body += groups.map((g) =>
        '<div class="perm-group"><div class="perm-group-head">' + escapeHtml(g.label) + '</div>' +
        g.items.map(p => '<div class="perm-item">' + escapeHtml(p.label) + '</div>').join('') +
        '</div>'
      ).join('');
    }
    UI.modal({
      title: 'Permissions — ' + role.label,
      bodyHtml: body,
      okLabel: 'Close',
      cancelLabel: ''
    });
  }

  async function openRoleEditor(slug) {
    if (!hasPerm('admins.manage')) {
      UI.toast('Only Super Admins can edit roles.', 'error');
      return;
    }
    const isEdit = !!slug;
    const role = isEdit ? State.roles.find(r => r.slug === slug) : null;
    if (isEdit && !role) return;
    if (isEdit && role.is_system) { UI.toast('System roles cannot be edited.', 'warn'); return; }

    const currentPerms = {};
    ((role && role.permissions) || []).forEach(p => { currentPerms[p] = true; });

    const permsHtml = State.permissionGroups.map((g) =>
      '<div class="perm-group" data-perm-group="' + escapeHtml(g.key) + '">' +
        '<div class="perm-group-head"><span>' + escapeHtml(g.label) + '</span>' +
        '<button type="button" class="btn sm" data-perm-toggle="' + escapeHtml(g.key) + '">Toggle all</button></div>' +
        (g.permissions || []).map((p) => {
          const checked = currentPerms[p.slug] || currentPerms['*'];
          return '<label class="perm-item"><input type="checkbox" data-perm="' + escapeHtml(p.slug) + '"' +
            (checked ? ' checked' : '') + '>' +
            '<span>' + escapeHtml(p.label) +
            (p.sensitive ? ' <span class="badge err">sensitive</span>' : '') +
            '</span></label>';
        }).join('') +
      '</div>'
    ).join('');

    const bodyHtml =
      '<div class="field"><label for="roleEditorSlug">Slug</label>' +
      '<input type="text" id="roleEditorSlug" value="' + escapeHtml(role ? role.slug : '') + '"' +
      (isEdit ? ' disabled' : '') + ' autocomplete="off" autocapitalize="off" spellcheck="false"></div>' +
      '<div class="field"><label for="roleEditorLabel">Display label</label>' +
      '<input type="text" id="roleEditorLabel" value="' + escapeHtml(role ? role.label : '') + '" autocomplete="off"></div>' +
      '<div class="field"><label for="roleEditorDesc">Description</label>' +
      '<textarea id="roleEditorDesc" rows="2">' + escapeHtml(role ? (role.description || '') : '') + '</textarea></div>' +
      '<div style="font-weight:700;font-size:12.5px;margin:12px 0 8px">Permissions</div>' +
      permsHtml +
      '<div class="field" style="margin-top:12px"><label for="roleEditorReason">Reason (required)</label>' +
      '<textarea id="roleEditorReason" rows="2" placeholder="Explain why this role is being ' + (isEdit ? 'updated' : 'created') + '"></textarea></div>';

    const saved = await UI.modal({
      title: isEdit ? ('Edit role — ' + role.label) : 'Create role',
      bodyHtml,
      okLabel: isEdit ? 'Save changes' : 'Create role',
      kind: 'primary',
      wide: true,
      onSubmit: async (values) => {
        const $ = (id) => document.getElementById(id);
        const slugVal = isEdit ? role.slug : String(($('roleEditorSlug') && $('roleEditorSlug').value) || '').trim();
        const labelVal = String(($('roleEditorLabel') && $('roleEditorLabel').value) || '').trim();
        const descVal  = String(($('roleEditorDesc') && $('roleEditorDesc').value) || '').trim();
        const reasonVal = String(($('roleEditorReason') && $('roleEditorReason').value) || '').trim();
        const perms = Array.prototype.map.call(
          document.querySelectorAll('input[data-perm]:checked'),
          (b) => b.dataset.perm
        );
        if (!labelVal) throw _fieldError('Label is required.', 'roleEditorLabel');
        if (!perms.length) throw _fieldError('Select at least one permission.', 'roleEditorLabel');
        if (reasonVal.length < 4) throw _fieldError('Reason must be at least 4 characters.', 'roleEditorReason');
        if (!isEdit && !/^[a-z][a-z0-9_]{2,40}$/.test(slugVal)) {
          throw _fieldError('Slug must be 3-40 lowercase characters, starting with a letter.', 'roleEditorSlug');
        }
        const allPerms = [];
        State.permissionGroups.forEach(g => allPerms.push.apply(allPerms, g.permissions || []));
        const sensitive = perms.filter((p) => {
          const def = allPerms.find(x => x.slug === p);
          return def && def.sensitive;
        });
        let stepUpToken = null;
        if (sensitive.length) {
          const r = await UI.stepUp({
            reason: 'Granting sensitive permissions (' + sensitive.join(', ') + '). Verify to continue.'
          });
          if (!r) throw new Error('Step-up verification cancelled.');
          stepUpToken = r.verified ? true : null;
        }
        const url = isEdit ? API.roleBySlug(role.slug) : API.roles;
        const method = isEdit ? 'PUT' : 'POST';
        const payload = isEdit
          ? { label: labelVal, description: descVal, permissions: perms, reason: reasonVal,
              expectedUpdatedAt: role.updated_at || null,
              confirmSensitive: stepUpToken === true }
          : { slug: slugVal, label: labelVal, description: descVal, permissions: perms, reason: reasonVal,
              confirmSensitive: stepUpToken === true };
        const res = await api(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          if (res.code === 'SENSITIVE_PERMISSION_REQUIRES_CONFIRMATION') {
            throw new Error('Server requires step-up verification. Retry with the modal.');
          }
          if (res.code === 'STALE_VERSION' || res.code === 'UPDATED_AT_MISMATCH') {
            throw new Error('Another admin changed this role. Reload and try again.');
          }
          throw new Error(res.error || 'Save failed.');
        }
        UI.toast(isEdit ? 'Role updated.' : 'Role created.', 'success');
        State.rolesLoaded = false;
        initRolesPanel();
        return true;
      }
    }).then((v) => v === true);

    function _fieldError(msg, fieldId) {
      const el = document.getElementById(fieldId);
      if (el) { try { el.focus(); } catch (_) {} }
      const e = new Error(msg);
      e.field = fieldId;
      return e;
    }
  }

  async function deleteRole(slug) {
    if (!hasPerm('admins.manage')) return;
    const role = State.roles.find(r => r.slug === slug);
    if (!role) return;

    const reason = await UI.reason({
      title: 'Delete role — ' + role.label,
      message: 'Users assigned to ' + role.label + ' must be reassigned first. Enter a reason for the deletion.'
    });
    if (!reason) return;

    const ok = await UI.confirm({
      title: 'Delete role',
      body: 'Permanently delete role "' + role.label + '" (' + slug + ')?',
      okLabel: 'Delete role',
      kind: 'danger',
      typeToConfirm: slug
    });
    if (!ok) return;

    const res = await api(API.roleBySlug(slug), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    if (!res.ok) {
      UI.toast('Delete failed: ' + (res.error || res.code || 'unknown'), 'error');
      return;
    }
    UI.toast('Role deleted.', 'success');
    State.rolesLoaded = false;
    initRolesPanel();
  }

  // ─── MFA ───────────────────────────────────────────────────
  async function loadMfaStatus() {
    const pill = $('mfaStatusPill');
    const state = $('mfaState');
    const title = $('mfaStateTitle');
    const meta = $('mfaStateMeta');
    const enroll = $('mfaEnrollBlock');
    const enabled = $('mfaEnabledBlock');

    const res = await api(API.mfaStatus);
    if (!res.ok) {
      if (pill) { pill.className = 'badge err'; pill.textContent = 'Unavailable'; }
      if (title) title.textContent = 'Unable to load MFA status';
      if (meta) meta.textContent = res.reason === 'not_implemented'
        ? 'MFA endpoints not deployed on this server.'
        : (res.error || 'Unknown error');
      return;
    }
    const mfa = (res.data && res.data.mfa) || {};
    const on = !!mfa.enabled;
    if (pill) {
      pill.className = 'badge ' + (on ? 'ok' : 'off');
      pill.innerHTML = on
        ? '<i class="fas fa-circle-check" aria-hidden="true"></i> Enabled'
        : '<i class="fas fa-circle-xmark" aria-hidden="true"></i> Not enabled';
    }
    if (state) state.classList.toggle('on', on);
    if (title) title.textContent = on ? 'Two-factor authentication is ON' : 'Two-factor authentication is OFF';
    if (meta) meta.textContent = on
      ? 'Enabled ' + formatDateTime(mfa.enabled_at) + ' · ' +
        (mfa.recovery_codes_remaining || 0) + ' recovery codes remaining'
      : 'Enable 2FA to protect sensitive admin actions.';
        if (enroll) enroll.style.display = on ? 'none' : '';
    if (enabled) enabled.style.display = on ? '' : 'none';
    // NOTE: do NOT clear the recovery codes here. This function is
    // called immediately after an operation that shows them, so
    // clearing here wipes them the moment they render.
    // The clear happens in clearRecoveryCodes(), which is called
    // when the user opens the MFA panel fresh, clicks "I've saved
    // them", or leaves the panel.
  }

  // Explicit clear — separate function so we control WHEN it runs.
  function clearRecoveryCodes() {
    const rec = $('mfaRecoveryBlock');
    if (rec) rec.style.display = 'none';
    const list = $('recoveryCodesList');
    if (list) list.innerHTML = '';
  }

  function showRecoveryCodes(codes) {
    const block = $('mfaRecoveryBlock');
    const list = $('recoveryCodesList');
    if (!block || !list) return;
    list.innerHTML = codes.map(c => '<code>' + escapeHtml(c) + '</code>').join('');
    block.style.display = '';
    block.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function startMfaEnrollment() {
    const btn = $('mfaStartEnrollBtn');
    if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
    const res = await api(API.mfaEnroll, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
    if (!res.ok) { UI.toast('Could not start enrollment: ' + (res.error || 'unknown'), 'error'); return; }
    const e = (res.data && res.data.enrollment) || {};
    $('mfaQrImg').src = e.qr_data_url || '';
    $('mfaSecretText').textContent = e.secret || '—';
    $('mfaEnrollIntro').style.display = 'none';
    $('mfaEnrollQr').style.display = '';
  }

  async function confirmMfaEnrollment() {
    const code = ($('mfaVerifyCode').value || '').trim();
    if (!/^\d{6}$/.test(code)) { UI.toast('Enter the 6-digit code.', 'warn'); return; }
    const btn = $('mfaConfirmEnrollBtn');
    if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
    const res = await api(API.mfaVerify, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
    if (!res.ok) { UI.toast('Verification failed: ' + (res.error || 'unknown'), 'error'); return; }
    UI.toast('Two-factor authentication enabled.', 'success');
    $('mfaEnrollIntro').style.display = '';
    $('mfaEnrollQr').style.display = 'none';
    $('mfaVerifyCode').value = '';
    $('mfaQrImg').removeAttribute('src');
    $('mfaSecretText').textContent = '—';
    if (res.data && Array.isArray(res.data.recovery_codes)) showRecoveryCodes(res.data.recovery_codes);
    loadMfaStatus();
  }

  async function regenerateRecoveryCodes() {
    const r = await UI.prompt({
      title: 'Regenerate recovery codes',
      bodyHtml: '<p>Regenerating invalidates all previous recovery codes. Enter your current code and a reason.</p>',
      fields: [
        {
          name: 'code', label: 'Current 6-digit code', type: 'text',
          inputmode: 'numeric', pattern: '^\\d{6}$', required: true, minLength: 6, maxLength: 6,
          autocomplete: 'one-time-code', placeholder: '000000'
        },
        {
          name: 'reason', label: 'Reason', type: 'textarea',
          required: true, minLength: 4, maxLength: 500, rows: 2
        }
      ],
      okLabel: 'Regenerate'
    });
    if (!r) return;
    const res = await api(API.mfaRegen, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: String(r.code || '').trim(), reason: String(r.reason || '').trim() })
    });
    if (!res.ok) { UI.toast('Failed: ' + (res.error || 'unknown'), 'error'); return; }
    showRecoveryCodes((res.data && res.data.recovery_codes) || []);
    loadMfaStatus();
  }

  async function disableMfa() {
    const r = await UI.prompt({
      title: 'Disable two-factor authentication',
      bodyHtml: '<p>This reduces your account security. Enter your current code and a reason.</p>',
      fields: [
        {
          name: 'code', label: 'Current 6-digit code', type: 'text',
          inputmode: 'numeric', pattern: '^\\d{6}$', required: true, minLength: 6, maxLength: 6,
          autocomplete: 'one-time-code', placeholder: '000000'
        },
        {
          name: 'reason', label: 'Reason', type: 'textarea',
          required: true, minLength: 4, maxLength: 500, rows: 2
        }
      ],
      okLabel: 'Continue'
    });
    if (!r) return;
    const ok = await UI.confirm({
      title: 'Disable 2FA?',
      body: 'You will not be prompted for a code until you re-enable 2FA.',
      okLabel: 'Disable 2FA',
      kind: 'danger',
      typeToConfirm: 'DISABLE'
    });
    if (!ok) return;
    const res = await api(API.mfaDisable, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: String(r.code || '').trim(), reason: String(r.reason || '').trim() })
    });
    if (!res.ok) { UI.toast('Failed: ' + (res.error || 'unknown'), 'error'); return; }
    UI.toast('Two-factor authentication disabled.', 'success');
    loadMfaStatus();
  }

  // ─── RESET SECTION ─────────────────────────────────────────
  async function resetCurrentSection() {
    const section = State.currentSection;
    if (RESET_FORBIDDEN_SECTIONS.has(section)) {
      UI.toast('Reset is disabled for ' + section + ' — change individual keys instead.', 'error');
      return;
    }
    const ok = await UI.confirm({
      title: 'Reset section — ' + section,
      body: 'Restore every non-financial key in this section to its default. Requires a reason.',
      okLabel: 'Continue', kind: 'danger'
    });
    if (!ok) return;
    const reason = await UI.reason({
      title: 'Reason required',
      message: 'Why is the ' + section + ' section being reset?'
    });
    if (!reason) return;
    const confirmed = await UI.confirm({
      title: 'Confirm reset',
      body: 'Type RESET to confirm. This cannot be undone without manual editing.',
      okLabel: 'Reset now', kind: 'danger', typeToConfirm: 'RESET'
    });
    if (!confirmed) return;
    const res = await api(API.resetSection(section), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, expectedVersion: State.version })
    });
    if (!res.ok) {
      if (res.code === 'RESET_FORBIDDEN') { UI.toast(res.error || 'Reset is forbidden here.', 'error'); return; }
      if (res.code === 'NOTHING_TO_RESET') { UI.toast('Nothing to reset in this section.', 'info'); return; }
      UI.toast('Reset failed: ' + (res.error || 'unknown'), 'error');
      return;
    }
    UI.toast('Section reset.', 'success');
    await loadAll();
  }

  // ─── ADMIN PROFILE ─────────────────────────────────────────
  async function loadAdminProfile() {
    const res = await api(API.me);
    if (!res.ok) return;
    const u = (res.data && res.data.user) || res.data;
    if (!u) return;
    const name = u.username || (u.email ? u.email.split('@')[0] : 'Admin');
    const role = u.role || 'admin';
    State.isSuperAdmin = !!(res.data && res.data.isSuperAdmin) || !!u.isSuperAdmin;

    const permsIn = Array.isArray(u.permissions) ? u.permissions
      : (u.permissions && typeof u.permissions === 'object' ? u.permissions : null);
    State.permissions = new Set();
    if (Array.isArray(permsIn)) {
      permsIn.forEach(p => State.permissions.add(p));
    } else if (permsIn) {
      const ENUM = {
        DASHBOARD_READ: 'dashboard.read',
        USERS_READ: 'users.read', USERS_MANAGE: 'users.manage', USERS_SUSPEND: 'users.suspend',
        WALLETS_READ: 'wallets.read', WALLETS_ADJUST: 'wallets.adjust',
        TRANSACTIONS_READ: 'transactions.read', TRANSACTIONS_RESOLVE: 'transactions.resolve',
        TRANSACTIONS_REFUND: 'transactions.refund',
        DEPOSITS_READ: 'deposits.read', DEPOSITS_RESOLVE: 'deposits.resolve',
        CRYPTO_READ: 'crypto.read', CRYPTO_RESOLVE: 'crypto.resolve',
        FX_READ: 'fx.read', FX_MANAGE: 'fx.manage',
        PROVIDERS_READ: 'providers.read', PROVIDERS_MANAGE: 'providers.manage', PROVIDERS_TEST: 'providers.test',
        SERVICES_READ: 'services.read', SERVICES_MANAGE: 'services.manage',
        ORDERS_READ: 'orders.read', ORDERS_RESOLVE: 'orders.resolve',
        WEBHOOKS_READ: 'webhooks.read', WEBHOOKS_REPLAY: 'webhooks.replay',
        RECONCILIATION_READ: 'reconciliation.read', RECONCILIATION_RESOLVE: 'reconciliation.resolve',
        REPORTS_READ: 'reports.read', REPORTS_EXPORT: 'reports.export',
        NOTIFICATIONS_READ: 'notifications.read', NOTIFICATIONS_MANAGE: 'notifications.manage',
        SETTINGS_READ: 'settings.read', SETTINGS_MANAGE: 'settings.manage', SETTINGS_EMERGENCY: 'settings.emergency',
        ADMINS_READ: 'admins.read', ADMINS_MANAGE: 'admins.manage',
        AUDIT_READ: 'audit.read', AUDIT_EXPORT: 'audit.export',
        SYSTEM_HEALTH_READ: 'system.health.read',
        SECURITY_READ: 'security.read', SECURITY_MANAGE: 'security.manage',
        SESSIONS_READ: 'sessions.read', SESSIONS_REVOKE: 'sessions.revoke',
        SUPPORT_READ: 'support.read', SUPPORT_REPLY: 'support.reply',
        SUPPORT_INTERNAL_NOTE: 'support.internal_note',
        SUPPORT_ASSIGN: 'support.assign', SUPPORT_CHANGE_STATUS: 'support.change_status',
        SUPPORT_CLOSE: 'support.close', SUPPORT_REOPEN: 'support.reopen',
        SUPPORT_ATTACHMENTS: 'support.attachments',
        SUPPORT_DELETE_ATTACHMENT: 'support.delete_attachment',
        SUPPORT_MANAGE_CATEGORIES: 'support.manage_categories',
        SUPPORT_VIEW_CUSTOMER: 'support.view_customer',
        SUPPORT_AUDIT_READ: 'support.audit.read'
      };
      Object.keys(permsIn).forEach((k) => {
        if (permsIn[k] !== true) return;
        if (k === '*') { State.permissions.add('*'); return; }
        if (ENUM[k]) State.permissions.add(ENUM[k]);
        else if (k.indexOf('.') !== -1) State.permissions.add(k);
      });
    }

    ['adminName', 'chipName'].forEach((id) => { const el = $(id); if (el) el.textContent = name; });
    ['adminRole', 'chipRole'].forEach((id) => {
      const el = $(id);
      if (el) el.textContent = role.charAt(0).toUpperCase() + role.slice(1);
    });
    ['adminAvatar', 'chipAvatar'].forEach((id) => {
      const el = $(id);
      if (el) el.textContent = name.slice(0, 1).toUpperCase();
    });
    if (!hasPerm('admins.manage')) {
      const btn = $('rolesCreateBtn');
      if (btn) { btn.disabled = true; btn.title = 'Only Super Admins can create roles'; }
    }
  }

  // ─── BINDING ───────────────────────────────────────────────
  function bindGlobal() {
    const hb = $('hamburger'); if (hb) hb.addEventListener('click', () => setSidebarOpen(true));
    const sc = $('scrim'); if (sc) sc.addEventListener('click', () => setSidebarOpen(false));

    const sbBtn = $('sbCollapseBtn'); if (sbBtn) sbBtn.addEventListener('click', () => {
      $('appRoot').classList.toggle('sb-collapsed');
      try { localStorage.setItem('sb-collapsed', $('appRoot').classList.contains('sb-collapsed') ? '1' : '0'); } catch (_) {}
    });
    const sbClose = $('sbCloseBtn'); if (sbClose) sbClose.addEventListener('click', () => setSidebarOpen(false));

    document.querySelectorAll('[data-nav-toggle], [data-toggle-group]').forEach((btn) => {
      if (btn.closest('.perm-group')) return;
      btn.addEventListener('click', () => {
        const g = btn.closest('.nav-group');
        if (!g) return;
        g.classList.toggle('collapsed');
        btn.setAttribute('aria-expanded', String(!g.classList.contains('collapsed')));
        try {
          localStorage.setItem('navgroup:' + g.dataset.group, g.classList.contains('collapsed') ? 'collapsed' : 'open');
        } catch (_) {}
      });
    });
    try {
      document.querySelectorAll('.nav-group[data-group]').forEach((g) => {
        const s = localStorage.getItem('navgroup:' + g.dataset.group);
        if (s === 'collapsed') g.classList.add('collapsed');
        if (s === 'open') g.classList.remove('collapsed');
      });
    } catch (_) {}

    document.querySelectorAll('#sideMenu .m-item').forEach((btn) => {
      btn.addEventListener('click', () => showSection(btn.dataset.section));
    });

    const db = $('dirtyBar');
    if (db) db.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-dirty-action]');
      if (!btn) return;
      if (btn.dataset.dirtyAction === 'discard') {
        const ok = await UI.confirm({
          title: 'Discard unsaved changes',
          body: 'All unsaved edits will be reverted.',
          okLabel: 'Discard', kind: 'danger'
        });
        if (ok) discardDirty();
      } else if (btn.dataset.dirtyAction === 'save') {
        await saveAllDirty();
      }
    });

    document.querySelectorAll('[data-action="save-section"]').forEach((btn) => {
      btn.addEventListener('click', () => saveSection(btn.dataset.section));
    });

    document.querySelectorAll('[data-action="reset-section"]').forEach((btn) => {
      btn.addEventListener('click', () => resetCurrentSection());
    });

    const rl = $('refreshBtn');
    if (rl) rl.addEventListener('click', async () => {
      if (Object.keys(State.dirty).length > 0) {
        const ok = await UI.confirm({
          title: 'Discard unsaved changes?',
          body: 'You have unsaved changes. Reload from the server?',
          okLabel: 'Discard and reload', kind: 'danger'
        });
        if (!ok) return;
      }
      await loadAll();
    });

    const hr = $('historyReloadBtn'); if (hr) hr.addEventListener('click', () => loadHistory(true));
    const her = $('healthReloadBtn'); if (her) her.addEventListener('click', loadHealth);

    const dt = $('darkToggle'); if (dt) dt.addEventListener('click', toggleTheme);
    applyThemeIcon();
    const dTheme = $('drawerThemeBtn'); if (dTheme) dTheme.addEventListener('click', toggleTheme);

    // Fallback chain for the sidebar brand image (runs after DOM is ready).
    (function wireLogo() {
      const img = $('brandImg');
      const box = $('brandLogo');
      if (!img || !box) return;
      let tried = 0;
      img.addEventListener('error', function () {
        tried++;
        if (tried === 1) {
          img.src = '../images/miles.png';
        } else {
          box.innerHTML = '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="MilesSpace">'
            + '<rect width="32" height="32" rx="6" fill="#0f4c5c"/>'
            + '<text x="16" y="22" text-anchor="middle" font-family="Inter, sans-serif" font-size="16" font-weight="800" fill="#f5a623">M</text>'
            + '</svg>';
        }
      });
      if (img.complete && img.naturalWidth === 0) {
        try { img.dispatchEvent(new Event('error')); } catch (_) {}
      }
    })();

    const chip = $('adminChip');
    const menu = $('adminMenu');
    if (chip) chip.addEventListener('click', (e) => { e.stopPropagation(); if (menu) menu.classList.toggle('show'); });
    if (menu) menu.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'signout') {
        const ok = await UI.confirm({
          title: 'Sign out',
          body: 'Sign out of the admin dashboard?',
          okLabel: 'Sign out', cancelLabel: 'Cancel'
        });
        if (ok) { try { await AdminSession.logout(); } catch (_) {} }
      }
      menu.classList.remove('show');
    });
    document.addEventListener('click', (e) => {
      if (!chip || !menu) return;
      if (!chip.contains(e.target) && !menu.contains(e.target)) menu.classList.remove('show');
    });

    const rr = $('rolesReloadBtn'); if (rr) rr.addEventListener('click', () => { State.rolesLoaded = false; initRolesPanel(); });
    const rc = $('rolesCreateBtn'); if (rc) rc.addEventListener('click', () => openRoleEditor(null));
    wireUserSearch();

    const ms = $('mfaStartEnrollBtn'); if (ms) ms.addEventListener('click', startMfaEnrollment);
    const mc = $('mfaCancelEnrollBtn'); if (mc) mc.addEventListener('click', () => {
      $('mfaEnrollIntro').style.display = '';
      $('mfaEnrollQr').style.display = 'none';
      $('mfaVerifyCode').value = '';
      $('mfaQrImg').removeAttribute('src');
      $('mfaSecretText').textContent = '—';
    });
    const mcf = $('mfaConfirmEnrollBtn'); if (mcf) mcf.addEventListener('click', confirmMfaEnrollment);
    const mr = $('mfaRegenRecoveryBtn'); if (mr) mr.addEventListener('click', regenerateRecoveryCodes);
    const md = $('mfaDisableBtn'); if (md) md.addEventListener('click', disableMfa);
    const mdone = $('mfaDoneRecoveryBtn'); if (mdone) mdone.addEventListener('click', () => {
      const rec = $('mfaRecoveryBlock');
      const list = $('recoveryCodesList');
      if (list) list.innerHTML = '';
      if (rec) rec.style.display = 'none';
    });
    const mcopy = $('mfaCopyRecoveryBtn'); if (mcopy) mcopy.addEventListener('click', async () => {
      const codes = Array.from(document.querySelectorAll('#recoveryCodesList code')).map(c => c.textContent);
      try {
        await navigator.clipboard.writeText(codes.join('\n'));
        UI.toast('Recovery codes copied.', 'success');
      } catch (_) {
        UI.toast('Copy failed — write them down.', 'warn');
      }
    });
    const mdownload = $('mfaDownloadCodesBtn');
    if (mdownload) mdownload.addEventListener('click', () => {
      const codes = Array.from(document.querySelectorAll('#recoveryCodesList code')).map(c => c.textContent);
      if (!codes.length) return;
      const blob = new Blob([codes.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'milesspace-recovery-codes.txt';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    });

    wireFields();

    window.addEventListener('beforeunload', (e) => {
      if (Object.keys(State.dirty).length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    window.addEventListener('hashchange', () => {
      const sec = location.hash.replace('#', '');
      if (sec && $('panel-' + sec)) showSection(sec);
    });

    initTablistKeyboard();
  }

  function wireUserSearch() {
    const input = $('roleAssignSearch');
    if (!input) return;
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) {
        const box = $('roleSearchResults');
        if (box) box.innerHTML = '<div class="state" style="padding:14px"><div class="sub">Type at least 2 characters</div></div>';
        return;
      }
      timer = setTimeout(() => searchUsersForAssignment(q), 300);
    });
  }

  async function searchUsersForAssignment(q) {
    const box = $('roleSearchResults');
    if (!box) return;
    box.innerHTML = '<div class="state" style="padding:14px"><span class="skel" style="width:60%;margin:0 auto"></span></div>';
    const res = await api(API.rolesUserSearch + '?search=' + encodeURIComponent(q));
    if (!res.ok) {
      box.innerHTML = '<div class="state" style="padding:14px"><i class="fas fa-triangle-exclamation"></i>' +
        '<div class="sub">' + escapeHtml(res.error || 'Search failed') + '</div></div>';
      return;
    }
    const users = Array.isArray(res.data && res.data.users) ? res.data.users : [];
    if (!users.length) {
      box.innerHTML = '<div class="state" style="padding:14px"><div class="sub">No users found.</div></div>';
      return;
    }
    box.innerHTML = users.map((u) => {
      const name = u.username || (u.email ? u.email.split('@')[0] : 'User');
      const roleLabel = (State.roles.find(r => r.slug === u.role) || {}).label || u.role || '—';
      const options = State.roles.filter(r => r.slug !== 'super_admin' && r.slug !== u.role)
        .map(r => '<option value="' + escapeHtml(r.slug) + '">' + escapeHtml(r.label) + '</option>').join('');
      return '<div class="role-search-row">' +
        '<div class="info"><strong>' + escapeHtml(name) + '</strong>' +
        '<span>' + escapeHtml(u.email || '') + ' · current: ' + escapeHtml(roleLabel) + '</span></div>' +
        '<div class="assign">' +
        '<select data-assign-user="' + escapeHtml(u.id) + '"><option value="">Assign role…</option>' + options + '</select>' +
        '<button type="button" class="btn primary sm" data-assign-user-btn="' + escapeHtml(u.id) + '" disabled>' +
        '<i class="fas fa-check" aria-hidden="true"></i> Assign</button>' +
        '</div></div>';
    }).join('');
    box.querySelectorAll('select[data-assign-user]').forEach((sel) => {
      const uid = sel.dataset.assignUser;
      const btn = box.querySelector('button[data-assign-user-btn="' + CSS.escape(uid) + '"]');
      sel.addEventListener('change', () => { if (btn) btn.disabled = !sel.value; });
      if (btn) btn.addEventListener('click', () => {
        const row = sel.closest('.role-search-row');
        const name = row.querySelector('strong').textContent;
        assignRole(uid, sel.value, name);
      });
    });
  }

  async function assignRole(userId, roleSlug, userName) {
    if (!roleSlug) return;
    const role = State.roles.find(r => r.slug === roleSlug);
    if (!role) return;
    const reason = await UI.reason({
      title: 'Assign role',
      message: 'Change ' + userName + "'s role to " + role.label + '? Enter a reason.'
    });
    if (!reason) return;
    const res = await api(API.rolesAssign, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, role: roleSlug, reason })
    });
    if (!res.ok) { UI.toast('Assign failed: ' + (res.error || 'unknown'), 'error'); return; }
    UI.toast('Role assigned.', 'success');
    State.rolesLoaded = false;
    initRolesPanel();
    const inp = $('roleAssignSearch'); if (inp) inp.value = '';
    const box = $('roleSearchResults'); if (box) box.innerHTML = '';
  }

  // ─── THEME + DRAWER ────────────────────────────────────────
  function toggleTheme() {
    const root = document.documentElement;
    const isDark = root.classList.toggle('dark');
    try { localStorage.setItem('ms-theme', isDark ? 'dark' : 'light'); } catch (_) {}
    applyThemeIcon();
  }
  function applyThemeIcon() {
    const isDark = document.documentElement.classList.contains('dark');
    const icon = $('darkToggleIcon');
    if (icon) icon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
    const dIcon = $('drawerThemeIcon'); if (dIcon) dIcon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
    const dLabel = $('drawerThemeLabel'); if (dLabel) dLabel.textContent = isDark ? 'Light mode' : 'Dark mode';
  }
  function setSidebarOpen(open) {
    const sb = $('sidebar'), sc = $('scrim'), hb = $('hamburger');
    if (!sb) return;
    sb.classList.toggle('open', open);
    if (sc) sc.classList.toggle('show', open);
    if (hb) hb.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('lock', open);
  }

  // ─── TABLIST KEYBOARD NAV ──────────────────────────────────
  function initTablistKeyboard() {
    const tablist = $('sideMenu');
    if (!tablist) return;
    const tabs = Array.from(tablist.querySelectorAll('.m-item'));
    tabs.forEach((t) => {
      if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', t.classList.contains('active') ? '0' : '-1');
    });
    tablist.addEventListener('keydown', (e) => {
      const idx = tabs.indexOf(document.activeElement);
      if (idx === -1) return;
      let target = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') target = tabs[(idx + 1) % tabs.length];
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') target = tabs[(idx - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') target = tabs[0];
      else if (e.key === 'End') target = tabs[tabs.length - 1];
      if (!target) return;
      e.preventDefault();
      tabs.forEach(t => t.setAttribute('tabindex', '-1'));
      target.setAttribute('tabindex', '0');
      target.focus();
    });
    tabs.forEach((t) => t.addEventListener('click', () => {
      tabs.forEach(x => x.setAttribute('tabindex', '-1'));
      t.setAttribute('tabindex', '0');
    }));
  }

  // ─── BOOT ──────────────────────────────────────────────────
  async function init() {
    if (!AdminSession.getToken()) { AdminSession.redirectToLogin(); return; }
    bindGlobal();
    await loadAdminProfile();
    await loadAll();
    document.querySelectorAll('[data-action="reset-section"]').forEach((btn) => {
      if (btn._wired) return;
      btn._wired = true;
      btn.addEventListener('click', () => resetCurrentSection());
    });

    const initial = location.hash.replace('#', '');
    if (initial && $('panel-' + initial)) showSection(initial);
    else showSection('general');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 30);
  }

  window.MilesSettings = {
    state: State,
    reload: loadAll,
    section: showSection,
    saveAll: saveAllDirty
  };
})();