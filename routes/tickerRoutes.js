// routes/tickerRoutes.js
// Public:   GET /api/ticker/items     (active only, inside schedule window)
// Public:   GET /api/ticker/active    (same as items, kept for backward-compat)
// Admin:    mounted separately at /api/admin/ticker/* via `router.admin`
// Uses adminAuth middleware. No hardcoded JWT secrets.

'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { supabaseAdmin } = require('../db/supabase');
const {
  requirePermission,
  recordAdminAction,
  PERMISSIONS
} = require('../middleware/adminAuth');

// ─── Constants ──────────────────────────────────────────────────
const TEXT_MAX        = 200;
const BADGE_MAX       = 20;
const HEX_RE          = /^#[0-9a-fA-F]{6}$/;
const LINK_RE_REL     = /^\/($|[^/])/;
const LINK_RE_HTTPS   = /^https:\/\//i;
const ISO_DATE_RE     = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

// ─── Small helpers ─────────────────────────────────────────────
function ok(res, data, status = 200) {
  if (res.headersSent) return;
  res.status(status).json({ success: true, data: data === undefined ? null : data });
}
function fail(res, status, code, message) {
  if (res.headersSent) return;
  res.status(status).json({ success: false, code, message });
}
function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// Trim to null on empty, cap length
function normStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

// Validate + normalise a link. Returns the cleaned link or throws.
function normLink(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (LINK_RE_REL.test(s) || LINK_RE_HTTPS.test(s)) return s;
  throw Object.assign(new Error('link must start with "/" (no "//") or "https://"'),
    { status: 422, code: 'INVALID_LINK' });
}

// Validate + normalise a badge color. Returns '#rrggbb' or null.
function normBadgeColor(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (!HEX_RE.test(s)) throw Object.assign(new Error('badge_color must be #RRGGBB'),
    { status: 422, code: 'INVALID_BADGE_COLOR' });
  return s.toLowerCase();
}

// Validate + normalise a schedule. Returns { starts_at, ends_at } as ISO strings or null.
function normSchedule(startsAt, endsAt) {
  const s = startsAt ? String(startsAt).trim() : null;
  const e = endsAt   ? String(endsAt).trim()   : null;
  const sIso = s && ISO_DATE_RE.test(s) ? new Date(s).toISOString() : (s ? null : null);
  const eIso = e && ISO_DATE_RE.test(e) ? new Date(e).toISOString() : (e ? null : null);
  if (s && !sIso) throw Object.assign(new Error('starts_at must be a valid ISO timestamp'),
    { status: 422, code: 'INVALID_START' });
  if (e && !eIso) throw Object.assign(new Error('ends_at must be a valid ISO timestamp'),
    { status: 422, code: 'INVALID_END' });
  if (sIso && eIso && new Date(eIso) <= new Date(sIso)) {
    throw Object.assign(new Error('ends_at must be after starts_at'),
      { status: 422, code: 'INVALID_WINDOW' });
  }
  return { starts_at: sIso, ends_at: eIso };
}

function uuidOrThrow(id) {
  if (!isUuid(id)) throw Object.assign(new Error('Invalid id'), { status: 400, code: 'INVALID_ID' });
  return id;
}

// Compute the "public window" filter — active AND inside starts_at/ends_at
function publicWindowQuery(q) {
  const now = new Date().toISOString();
  return q
    .eq('active', true)
    .or(`starts_at.is.null,starts_at.lte.${now}`)
    .or(`ends_at.is.null,ends_at.gte.${now}`);
}

// ─── PUBLIC — GET /api/ticker/items ─────────────────────────────
router.get('/items', async (req, res) => {
  try {
    let q = supabaseAdmin
      .from('ticker_items')
      .select('id, icon, text, badge, badge_color, link, title, sort_order, starts_at, ends_at')
      .order('sort_order', { ascending: true })
      .limit(20);
    q = publicWindowQuery(q);

    const { data, error } = await q;
    if (error) {
      // Public route must not leak DB errors — log, return empty.
      console.error('[TICKER] items public:', error.message);
      return ok(res, []);
    }
    res.setHeader('Cache-Control', 'public, max-age=30');
    ok(res, data || []);
  } catch (e) {
    console.error('[TICKER] items public exception:', e.message);
    res.setHeader('Cache-Control', 'public, max-age=30');
    ok(res, []);
  }
});

// ─── PUBLIC — GET /api/ticker/active (kept for backward-compat) ─
router.get('/active', async (req, res) => {
  try {
    let q = supabaseAdmin
      .from('ticker_items')
      .select('id, icon, text, badge, badge_color, link, title, sort_order, starts_at, ends_at')
      .order('sort_order', { ascending: true })
      .limit(20);
    q = publicWindowQuery(q);
    const { data, error } = await q;
    if (error) {
      console.error('[TICKER] active public:', error.message);
      return ok(res, []);
    }
    res.setHeader('Cache-Control', 'public, max-age=30');
    ok(res, data || []);
  } catch (e) {
    console.error('[TICKER] active public exception:', e.message);
    res.setHeader('Cache-Control', 'public, max-age=30');
    ok(res, []);
  }
});

// ─── ADMIN sub-router ─────────────────────────────────────────
const adminRouter = express.Router();

function adminCtx(req) {
  return {
    adminId:    req.adminContext?.id    || null,
    adminEmail: req.adminContext?.email || null,
    adminRole:  req.adminContext?.role  || null,
    ip:         req.ip || req.headers['x-forwarded-for'] || null,
    userAgent:  req.headers['user-agent'] || null,
    requestId:  req.headers['x-request-id'] || crypto.randomUUID()
  };
}

async function audit(req, action, targetId, before, after) {
  try {
    await recordAdminAction({
      adminId:    req.adminContext?.id,
      adminEmail: req.adminContext?.email,
      adminRole:  req.adminContext?.role,
      action,
      targetType: 'ticker_item',
      targetId,
      before:     before || null,
      after:      after  || null,
      result:     'success',
      req
    });
  } catch (e) {
    console.warn('[TICKER] audit failed:', e.message);
  }
}

// GET /api/admin/ticker/items — ALL items (active + inactive + scheduled)
adminRouter.get(
  '/items',
  requirePermission(PERMISSIONS.SETTINGS_READ),
  async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from('ticker_items')
        .select('*')
        .order('sort_order', { ascending: true });
      if (error) throw error;
      ok(res, data || []);
    } catch (e) {
      console.error('[TICKER] admin list:', e.message);
      fail(res, 500, 'LIST_FAILED', 'Could not load ticker items.');
    }
  }
);

// POST /api/admin/ticker/items — create
adminRouter.post(
  '/items',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  async (req, res) => {
    try {
      const body = req.body || {};
      const text = normStr(body.text, TEXT_MAX);
      if (!text) return fail(res, 422, 'TEXT_REQUIRED', 'Text is required.');

      const badge       = normStr(body.badge, BADGE_MAX);
      const badgeColor  = normBadgeColor(body.badge_color);
      const link        = normLink(body.link);
      const icon        = normStr(body.icon, 16) || '📌';
      const title       = normStr(body.title, 60);
      const { starts_at, ends_at } = normSchedule(body.starts_at, body.ends_at);
      const active      = body.active === undefined ? true : Boolean(body.active);

      // sort_order = max + 1
      const { data: maxRow } = await supabaseAdmin
        .from('ticker_items')
        .select('sort_order')
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextSort = ((maxRow && maxRow.sort_order) || 0) + 1;

      const now = new Date().toISOString();
      const insert = {
        icon,
        text,
        badge,
        badge_color: badgeColor,
        link,
        title,
        sort_order: nextSort,
        active,
        starts_at,
        ends_at,
        created_at: now,
        updated_at: now,
        created_by: req.adminContext?.id || null,
        updated_by: req.adminContext?.id || null
      };

      const { data, error } = await supabaseAdmin
        .from('ticker_items')
        .insert(insert)
        .select('*')
        .single();
      if (error) throw error;

      await audit(req, 'ticker.create', data.id, null, {
        text, badge, badge_color: badgeColor, link, active
      });

      ok(res, data, 201);
    } catch (e) {
      if (e.status) return fail(res, e.status, e.code, e.message);
      console.error('[TICKER] admin create:', e.message);
      fail(res, 500, 'CREATE_FAILED', 'Could not create ticker item.');
    }
  }
);

// PUT /api/admin/ticker/items/:id — update (whitelisted fields)
adminRouter.put(
  '/items/:id',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  async (req, res) => {
    try {
      const id = uuidOrThrow(req.params.id);
      const body = req.body || {};

      // Fetch current for audit + for optimistic changes
      const { data: before, error: getErr } = await supabaseAdmin
        .from('ticker_items').select('*').eq('id', id).maybeSingle();
      if (getErr) throw getErr;
      if (!before) return fail(res, 404, 'NOT_FOUND', 'Ticker item not found.');

      const patch = {};
      if ('icon'       in body) patch.icon        = normStr(body.icon, 16) || '📌';
      if ('text'       in body) {
        const t = normStr(body.text, TEXT_MAX);
        if (!t) return fail(res, 422, 'TEXT_REQUIRED', 'Text cannot be empty.');
        patch.text = t;
      }
      if ('badge'      in body) patch.badge       = normStr(body.badge, BADGE_MAX);
      if ('badge_color' in body) patch.badge_color = normBadgeColor(body.badge_color);
      if ('link'       in body) patch.link        = normLink(body.link);
      if ('title'      in body) patch.title       = normStr(body.title, 60);
      if ('active'     in body) patch.active      = Boolean(body.active);

      if ('starts_at' in body || 'ends_at' in body) {
        const sched = normSchedule(
          'starts_at' in body ? body.starts_at : before.starts_at,
          'ends_at'   in body ? body.ends_at   : before.ends_at
        );
        patch.starts_at = sched.starts_at;
        patch.ends_at   = sched.ends_at;
      }

      if (!Object.keys(patch).length) {
        return fail(res, 422, 'EMPTY_PATCH', 'No recognised fields to update.');
      }
      patch.updated_at = new Date().toISOString();
      patch.updated_by = req.adminContext?.id || null;

      const { data, error } = await supabaseAdmin
        .from('ticker_items')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;

      await audit(req, 'ticker.update', id, before, patch);
      ok(res, data);
    } catch (e) {
      if (e.status) return fail(res, e.status, e.code, e.message);
      console.error('[TICKER] admin update:', e.message);
      fail(res, 500, 'UPDATE_FAILED', 'Could not update ticker item.');
    }
  }
);

// DELETE /api/admin/ticker/items/:id
adminRouter.delete(
  '/items/:id',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  async (req, res) => {
    try {
      const id = uuidOrThrow(req.params.id);
      const { data: before } = await supabaseAdmin
        .from('ticker_items').select('*').eq('id', id).maybeSingle();
      if (!before) return fail(res, 404, 'NOT_FOUND', 'Ticker item not found.');

      const { error } = await supabaseAdmin.from('ticker_items').delete().eq('id', id);
      if (error) throw error;

      await audit(req, 'ticker.delete', id, before, null);
      ok(res, { id });
    } catch (e) {
      if (e.status) return fail(res, e.status, e.code, e.message);
      console.error('[TICKER] admin delete:', e.message);
      fail(res, 500, 'DELETE_FAILED', 'Could not delete ticker item.');
    }
  }
);

// POST /api/admin/ticker/reorder — { ids: [uuid, uuid, ...] }
adminRouter.post(
  '/reorder',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
      if (!ids || !ids.length) return fail(res, 422, 'IDS_REQUIRED', 'Provide { ids: [...] }.');
      if (!ids.every(isUuid)) return fail(res, 422, 'INVALID_IDS', 'Every id must be a UUID.');

      // Fetch current set to validate all IDs exist
      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from('ticker_items')
        .select('id, sort_order')
        .in('id', ids);
      if (fetchErr) throw fetchErr;
      if (!existing || existing.length !== ids.length) {
        return fail(res, 422, 'UNKNOWN_IDS', 'Some ids do not exist.');
      }

      // One pass: new sort_order = index + 1
      const now = new Date().toISOString();
      const updates = ids.map((id, i) =>
        supabaseAdmin.from('ticker_items').update({
          sort_order: i + 1,
          updated_at: now,
          updated_by: req.adminContext?.id || null
        }).eq('id', id)
      );
      const results = await Promise.all(updates);
      const firstErr = results.find(r => r.error);
      if (firstErr) throw firstErr.error;

      await audit(req, 'ticker.reorder', null, null, { ids });
      ok(res, { ids });
    } catch (e) {
      if (e.status) return fail(res, e.status, e.code, e.message);
      console.error('[TICKER] admin reorder:', e.message);
      fail(res, 500, 'REORDER_FAILED', 'Could not reorder ticker items.');
    }
  }
);

// Expose the admin router so app.js can mount it at /api/admin/ticker
router.admin = adminRouter;

module.exports = router;