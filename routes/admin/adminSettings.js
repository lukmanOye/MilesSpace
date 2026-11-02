// routes/adminSettings.js
// ─────────────────────────────────────────────────────────────────
// Admin Settings HTTP surface.
//
// Contract with frontend (settings.html):
//   GET    /api/admin/settings                        → { sections, version }
//   GET    /api/admin/settings/section/:name          → { values }
//   PATCH  /api/admin/settings                        → { settings, reason?, expectedVersion, confirmLargeChange? }
//   POST   /api/admin/settings/reset/:name            → { reason, expectedVersion }
//   POST   /api/admin/settings/reset-all              → 422 RESET_ALL_FORBIDDEN (forbidden)
//   GET    /api/admin/settings/rates/history          → { rows[], total, offset, limit }
//   GET    /api/admin/settings/audit                  → { rows[], total, offset, limit }
//   GET    /api/admin/settings/audit/export.csv       → text/csv
//   POST   /api/admin/settings/restore                → { key, historyId, reason, expectedVersion }
//   GET    /api/admin/settings/health                 → health
//   GET    /api/admin/settings/providers/status       → providers[] (no secrets)
//   POST   /api/admin/settings/preview                → markup / rate / fee previews
//
// Envelope: { success, data, _meta } on success; { success, error, code, ... } on failure.
//
// Headers:
//   Authorization:   Bearer <jwt>                     (required)
//   Idempotency-Key: <opaque>                         (optional — PATCH only, 10 min TTL)
//
// All responses include Cache-Control: no-store.
// ─────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router = express.Router();
const svc = require('../../services/adminSettingsService');
const {
    requirePermission,
    recordAdminAction,
    PERMISSIONS,
    getClientIp
} = require('../../middleware/adminAuth');

// ═══════════════════════════════════════════════════════════════
//  RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════
function _noStore(res) {
    if (res.headersSent) return;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Vary', 'Authorization');
}

function ok(res, data, meta) {
    if (res.headersSent) return;
    _noStore(res);
    res.json({
        success: true,
        data: data === undefined ? null : data,
        _meta: meta || {}
    });
}

function fail(res, status, code, message, extra) {
    if (res.headersSent) return;
    _noStore(res);
    res.status(status).json({
        success: false,
        error: message,
        code,
        ...(extra || {})
    });
}

// Structured error handler — maps every code the service emits to a
// proper HTTP status plus the payload the frontend needs. This is
// what makes the "conflict modal with old vs current value" work.
function sendErr(res, err) {
    if (res.headersSent) return;
    const status = err?.status || 500;
    const code   = err?.code   || 'SETTINGS_ERROR';
    const message = status >= 500
        ? 'Something went wrong. Please try again.'
        : (err?.message || 'Request failed');

    if (status >= 500) {
        // Never log the message body — it may contain config values.
        console.error('[ADMIN SETTINGS]', code);
    }

    const body = { success: false, error: message, code };

    // Preserve fields the frontend needs for structured error display.
    if (Array.isArray(err?.keys)) body.keys = err.keys;
    if (Array.isArray(err?.invalid)) body.invalid = err.invalid;
    if (Array.isArray(err?.allowed)) body.allowed = err.allowed;
    if (err?.key) body.key = err.key;
    if (err?.required) body.required = err.required;
    if (err?.current_version != null) body.current_version = err.current_version;

    // Per-key conflict payload (F.7).
    if (code === 'KEY_CONFLICT') {
        body.key = err.key;
        body.current_value = err.current_value;
        body.expected_value = err.expected_value;
    }
    // Large change payload (F.5).
    if (code === 'LARGE_CHANGE_REQUIRES_CONFIRMATION') {
        body.key = err.key;
        body.old_value = err.old_value;
        body.new_value = err.new_value;
    }
    // Cross-field validation (C.8).
    if (code === 'CROSS_FIELD_INVALID') {
        body.aKey = err.aKey;
        body.bKey = err.bKey;
    }
    // Range validation.
    if (err?.min != null) body.min = err.min;
    if (err?.max != null) body.max = err.max;

    _noStore(res);
    res.status(status).json(body);
}

// ═══════════════════════════════════════════════════════════════
//  CTX BUILDER
//
//  `req.adminContext.permissions` is authoritative — populated by
//  adminAuth middleware after re-reading from the DB. This file
//  NEVER trusts req.body.role or any caller-supplied isSuperAdmin.
// ═══════════════════════════════════════════════════════════════
function buildCtx(req, extras = {}) {
    return {
        adminId:       req.adminContext?.id || null,
        adminEmail:    req.adminContext?.email || null,
        permissions:   req.adminContext?.permissions || [],
        isSuperAdmin:  !!req.adminContext?.isSuperAdmin,
        ip:            getClientIp(req),
        userAgent:     req.headers['user-agent'] || null,
        correlationId: req.correlationId || null,
        idempotencyKey: req.headers['idempotency-key'] || null,
        reason:        extras.reason || null,
        expectedVersion: extras.expectedVersion != null ? extras.expectedVersion : null,
        confirmLargeChange: extras.confirmLargeChange === true
    };
}

// ═══════════════════════════════════════════════════════════════
//  RATE LIMIT — 500 req/min per admin across the settings surface.
//  Separate from the write-specific 30/min applied inside the
//  service. This is a coarse protection against runaway loops.
// ═══════════════════════════════════════════════════════════════
const RATE_LIMIT_PER_MIN = Number(process.env.SETTINGS_READS_PER_MIN || 500);
const _rateLog = new Map();   // adminId → [timestamps]

function rateLimit(req, res, next) {
    const adminId = req.adminContext?.id;
    if (!adminId) return next();

    const now = Date.now();
    const win = 60_000;
    const bucket = (_rateLog.get(adminId) || []).filter(t => now - t < win);
    if (bucket.length >= RATE_LIMIT_PER_MIN) {
        return fail(res, 429, 'RATE_LIMITED',
            'Too many requests. Slow down and retry.');
    }
    bucket.push(now);
    _rateLog.set(adminId, bucket);
    if (_rateLog.size > 2000) {
        const first = _rateLog.keys().next().value;
        if (first) _rateLog.delete(first);
    }
    next();
}

// ═══════════════════════════════════════════════════════════════
//  OUTER AUDIT WRAPPER
//
//  The atomic RPC writes one audit row per changed key inside the
//  transaction (durable). This outer row captures the batch intent,
//  which is what operators search on. Best-effort: failure here
//  does NOT roll back the primary write.
// ═══════════════════════════════════════════════════════════════
async function recordSettingsRequest(req, action, keys, before, after, result) {
    try {
        await recordAdminAction({
            adminId:      req.adminContext?.id,
            adminEmail:   req.adminContext?.email,
            adminRole:    req.adminContext?.role,
            action,
            targetType:   'app_config_batch',
            targetId:     keys && keys.length ? keys.slice(0, 5).join(',') : null,
            before:       before || null,
            after:        after || null,
            reason:       after?.reason || null,
            result,
            req
        });
    } catch (e) {
        console.warn('[ADMIN SETTINGS] outer audit failed:', e.message);
    }
}

// ═══════════════════════════════════════════════════════════════
//  GET /api/admin/settings
//  Full config — filtered by caller permissions
// ═══════════════════════════════════════════════════════════════
router.get(
    '/settings',
    requirePermission(PERMISSIONS.SETTINGS_READ),
    rateLimit,
    async (req, res) => {
        try {
            const ctx = buildCtx(req);
            const sections = await svc.getSettingsBySectionAll(ctx);
            const flat = await svc.getAllSettings(ctx);
            const version = flat.config_version != null ? flat.config_version : null;
            ok(res, { sections, version }, { request_id: req.correlationId || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  GET /api/admin/settings/section/:name
// ═══════════════════════════════════════════════════════════════
router.get(
    '/settings/section/:name',
    requirePermission(PERMISSIONS.SETTINGS_READ),
    rateLimit,
    async (req, res) => {
        try {
            const ctx = buildCtx(req);
            const values = await svc.getSection(req.params.name, ctx);
            ok(res, { values }, { request_id: req.correlationId || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  PATCH /api/admin/settings
//  Body: { settings: {...}, reason?, expectedVersion, confirmLargeChange? }
//  Header: Idempotency-Key (optional)
//
//  settings may be:
//    { key: "value" }                         — plain
//    { key: { value, previous } }              — per-key CAS (F.7)
//  The two shapes may be mixed.
// ═══════════════════════════════════════════════════════════════
router.patch(
    '/settings',
    requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    rateLimit,
    async (req, res) => {
        try {
            const body = req.body || {};
            const settings = body.settings;
            if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
                return fail(res, 422, 'INVALID_PATCH', 'settings must be an object');
            }
            const keys = Object.keys(settings);
            if (!keys.length) {
                return fail(res, 422, 'EMPTY_PATCH', 'No settings to update');
            }
            if (body.expectedVersion == null) {
                return fail(res, 409, 'CONFIG_VERSION_REQUIRED',
                    'expectedVersion is required. Reload settings and retry.');
            }

            const ctx = buildCtx(req, {
                reason: typeof body.reason === 'string' ? body.reason : null,
                expectedVersion: Number(body.expectedVersion),
                confirmLargeChange: body.confirmLargeChange === true
            });

            const result = await svc.patchSettings(settings, ctx, {
                expectedVersion: Number(body.expectedVersion),
                confirmLargeChange: body.confirmLargeChange === true,
                idempotencyKey: ctx.idempotencyKey
            });

            await recordSettingsRequest(req, 'settings.batch_update', keys,
                null, { reason: ctx.reason, keys, confirmLargeChange: ctx.confirmLargeChange }, 'success');

            ok(res, result, {
                request_id: req.correlationId || null,
                idempotent: !!ctx.idempotencyKey
            });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/settings/reset/:name
//
//  Forbidden sections are rejected here BEFORE any DB call so the
//  UI gets a clean 403 with no wasted work.
// ═══════════════════════════════════════════════════════════════
router.post(
    '/settings/reset/:name',
    requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    rateLimit,
    async (req, res) => {
        try {
            const section = String(req.params.name || '').toLowerCase();
            if (svc.RESET_FORBIDDEN_SECTIONS.has(section)) {
                return fail(res, 403, 'RESET_FORBIDDEN',
                    `Section "${section}" cannot be reset. Change individual keys instead so each change is audited.`,
                    { section });
            }
            const body = req.body || {};
            if (body.expectedVersion == null) {
                return fail(res, 409, 'CONFIG_VERSION_REQUIRED',
                    'expectedVersion is required. Reload settings and retry.');
            }
            const ctx = buildCtx(req, {
                reason: typeof body.reason === 'string' && body.reason.trim().length >= 4
                    ? body.reason
                    : null,
                expectedVersion: Number(body.expectedVersion)
            });
            if (!ctx.reason) {
                return fail(res, 422, 'REASON_REQUIRED', 'A reason of at least 4 characters is required for reset.');
            }

            const result = await svc.resetSection(section, ctx);

            await recordSettingsRequest(req, 'settings.section_reset', [section],
                null, { reason: ctx.reason }, 'success');

            ok(res, result, { request_id: req.correlationId || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/settings/reset-all
//  Hard-forbidden by F.6 — reject before any DB work.
// ═══════════════════════════════════════════════════════════════
router.post(
    '/settings/reset-all',
    requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    rateLimit,
    async (_req, res) => {
        return fail(res, 403, 'RESET_ALL_FORBIDDEN',
            'A full reset is not permitted. Change individual keys instead so every change is audited and reversible.');
    }
);

// ═══════════════════════════════════════════════════════════════
//  GET /api/admin/settings/rates/history
//  Query: key?, limit?, offset?
// ═══════════════════════════════════════════════════════════════
router.get(
    '/settings/rates/history',
    requirePermission(PERMISSIONS.SETTINGS_READ),
    rateLimit,
    async (req, res) => {
        try {
            const ctx = buildCtx(req);
            const result = await svc.getRateHistory({
                key: req.query.key || null,
                limit: req.query.limit,
                offset: req.query.offset
            }, ctx);
            ok(res, result, { request_id: req.correlationId || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  GET /api/admin/settings/audit
//  Query: key?, adminId?, from?, to?, limit?, offset?
//
//  Read requires AUDIT_READ (same as before — no change to the
//  permission gate, just to the shape).
// ═══════════════════════════════════════════════════════════════
router.get(
    '/settings/audit',
    requirePermission(PERMISSIONS.AUDIT_READ),
    rateLimit,
    async (req, res) => {
        try {
            const ctx = buildCtx(req);
            const result = await svc.getAuditPaged({
                key:     req.query.key || null,
                adminId: req.query.adminId || null,
                from:    req.query.from || null,
                to:      req.query.to || null,
                limit:   req.query.limit,
                offset:  req.query.offset
            }, ctx);
            ok(res, result, { request_id: req.correlationId || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  GET /api/admin/settings/audit/export.csv
//  Capped at 5000 rows. Audited (the export itself is a change to
//  consider).
// ═══════════════════════════════════════════════════════════════
router.get(
    '/settings/audit/export.csv',
    requirePermission(PERMISSIONS.AUDIT_EXPORT),
    rateLimit,
    async (req, res) => {
        try {
            const ctx = buildCtx(req);
            const csv = await svc.exportAuditCsv({
                key:     req.query.key || null,
                adminId: req.query.adminId || null,
                from:    req.query.from || null,
                to:      req.query.to || null
            }, ctx);

            // Log the export — an audit of an audit read.
            try {
                await recordAdminAction({
                    adminId: ctx.adminId,
                    adminEmail: ctx.adminEmail,
                    adminRole: req.adminContext?.role,
                    action: 'settings.audit_exported',
                    targetType: 'settings_audit',
                    targetId: null,
                    after: { row_count_hint: 'capped_5000' },
                    result: 'success',
                    req
                });
            } catch (_) { /* non-fatal */ }

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            _noStore(res);
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="settings-audit-${stamp}.csv"`);
            res.send(csv);
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/settings/restore
//  Body: { key, historyId, reason, expectedVersion }
//  Restores a previous value from fx_rate_history. Requires
//  SETTINGS_MANAGE + a reason (financial keys are enforced by the
//  service anyway).
// ═══════════════════════════════════════════════════════════════
router.post(
    '/settings/restore',
    requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    rateLimit,
    async (req, res) => {
        try {
            const body = req.body || {};
            if (!body.key) return fail(res, 422, 'INVALID_BODY', 'key is required');
            if (!body.historyId) return fail(res, 422, 'INVALID_BODY', 'historyId is required');
            if (body.expectedVersion == null) {
                return fail(res, 409, 'CONFIG_VERSION_REQUIRED',
                    'expectedVersion is required. Reload settings and retry.');
            }
            if (!body.reason || String(body.reason).trim().length < 4) {
                return fail(res, 422, 'REASON_REQUIRED', 'A reason of at least 4 characters is required.');
            }

            const ctx = buildCtx(req, {
                reason: body.reason,
                expectedVersion: Number(body.expectedVersion),
                confirmLargeChange: true
            });

            const result = await svc.restoreValue({
                key: body.key,
                historyId: body.historyId,
                reason: body.reason
            }, ctx);

            await recordSettingsRequest(req, 'settings.restore', [body.key],
                null, { reason: ctx.reason, historyId: body.historyId }, 'success');

            ok(res, result, { request_id: req.correlationId || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  GET /api/admin/settings/providers/status
//  Never returns secret values — only configured yes/no plus the
//  booleans the UI needs. Provider secrets stay in env vars.
// ═══════════════════════════════════════════════════════════════
router.get(
    '/settings/providers/status',
    requirePermission(PERMISSIONS.SETTINGS_READ),
    rateLimit,
    async (req, res) => {
        try {
            const ctx = buildCtx(req);
            const providers = await svc.getProvidersStatus(ctx);
            ok(res, { providers }, { request_id: req.correlationId || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  POST /api/admin/settings/preview
//  Body: { kind: 'markup'|'rate'|'fee', ... }
//    markup: { service, currency, amount }
//    rate:   { currency, amount }
//    fee:    { feeType, amount }
//
//  Pure read-only computation. No writes. All math is decimal-string
//  via the service.
// ═══════════════════════════════════════════════════════════════
router.post(
    '/settings/preview',
    requirePermission(PERMISSIONS.SETTINGS_READ),
    rateLimit,
    async (req, res) => {
        try {
            const body = req.body || {};
            const kind = String(body.kind || '').toLowerCase();
            if (!['markup', 'rate', 'fee'].includes(kind)) {
                return fail(res, 422, 'INVALID_PREVIEW_KIND',
                    'kind must be one of: markup, rate, fee');
            }
            if (body.amount == null || body.amount === '') {
                return fail(res, 422, 'INVALID_BODY', 'amount is required');
            }
            const result = await svc.preview({
                kind,
                service:  body.service,
                currency: body.currency,
                amount:   String(body.amount),
                feeType:  body.feeType || 'deposit'
            });
            ok(res, result, { request_id: req.correlationId || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  GET /api/admin/settings/health
// ═══════════════════════════════════════════════════════════════
router.get(
    '/settings/health',
    requirePermission(PERMISSIONS.SYSTEM_HEALTH_READ || PERMISSIONS.SETTINGS_READ),
    rateLimit,
    async (req, res) => {
        try {
            const health = await svc.getHealth();
            ok(res, { configuration: health }, { request_id: req.correlationId || null });
        } catch (err) { sendErr(res, err); }
    }
);

// ═══════════════════════════════════════════════════════════════
//  MODULE EXPORTS
// ═══════════════════════════════════════════════════════════════
module.exports = router;