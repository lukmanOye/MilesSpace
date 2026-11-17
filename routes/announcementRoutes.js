// routes/announcementRoutes.js
// Public:   GET /api/announcements/active
// Admin:    mounted at /api/admin/announcements via `router.admin`

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

const TITLE_MAX = 60;
const BODY_MAX  = 160;
const CTA_MAX   = 24;
const HEX_RE    = /^#[0-9a-fA-F]{6}$/; // not used for theme, only for any future badge
const LINK_RE_REL = /^\/($|[^/])/;
const LINK_RE_HTTPS = /^https:\/\//i;
const THEMES = new Set(['c1','c2','c3','c4','c5']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

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
function normStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}
function normLink(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (LINK_RE_REL.test(s) || LINK_RE_HTTPS.test(s)) return s;
  throw Object.assign(new Error('link must start with "/" (no "//") or "https://"'),
    { status: 422, code: 'INVALID_LINK' });
}
function normTheme(v) {
  if (v == null || v === '') return 'c1';
  const s = String(v).trim().toLowerCase();
  if (!THEMES.has(s)) throw Object.assign(new Error('theme must be c1..c5'),
    { status: 422, code: 'INVALID_THEME' });
  return s;
}
function normSchedule(startsAt, endsAt) {
  const s = startsAt ? String(startsAt).trim() : null;
  const e = endsAt   ? String(endsAt).trim()   : null;
  const sIso = s && ISO_DATE_RE.test(s) ? new Date(s).toISOString() : null;
  const eIso = e && ISO_DATE_RE.test(e) ? new Date(e).toISOString() : null;
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
function publicWindowQuery(q) {
  const now = new Date().toISOString();
  return q
    .eq('active', true)
    .or(`starts_at.is.null,starts_at.lte.${now}`)
    .or(`ends_at.is.null,ends_at.gte.${now}`);
}

// ─── PUBLIC ────────────────────────────────────────────────────
router.get('/active', async (req, res) => {
  try {
    let q = supabaseAdmin
      .from('dashboard_announcements')
      .select('id, title, body, cta_label, link, theme, sort_order, starts_at, ends_at')
      .order('sort_order', { ascending: true })
      .limit(10);
    q = publicWindowQuery(q);
    const { data, error } = await q;
    if (error) {
      console.error('[ANNOUNCEMENTS] public active:', error.message);
      return ok(res, []);
    }
    res.setHeader('Cache-Control', 'public, max-age=30');
    ok(res, data || []);
  } catch (e) {
    console.error('[ANNOUNCEMENTS] public active exception:', e.message);
    res.setHeader('Cache-Control', 'public, max-age=30');
    ok(res, []);
  }
});

// ─── ADMIN ─────────────────────────────────────────────────────
const adminRouter = express.Router();

async function audit(req, action, targetId, before, after) {
  try {
    await recordAdminAction({
      adminId:    req.adminContext?.id,
      adminEmail: req.adminContext?.email,
      adminRole:  req.adminContext?.role,
      action,
      targetType: 'dashboard_announcement',
      targetId,
      before:     before || null,
      after:      after  || null,
      result:     'success',
      req
    });
  } catch (e) {
    console.warn('[ANNOUNCEMENTS] audit failed:', e.message);
  }
}

adminRouter.get(
  '/',
  requirePermission(PERMISSIONS.SETTINGS_READ),
  async (req, res) => {
    try {
      const { data, error } = await supabaseAdmin
        .from('dashboard_announcements')
        .select('*')
        .order('sort_order', { ascending: true });
      if (error) throw error;
      ok(res, data || []);
    } catch (e) {
      console.error('[ANNOUNCEMENTS] admin list:', e.message);
      fail(res, 500, 'LIST_FAILED', 'Could not load announcements.');
    }
  }
);

adminRouter.post(
  '/',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  async (req, res) => {
    try {
      const body = req.body || {};
      const title = normStr(body.title, TITLE_MAX);
      const text  = normStr(body.body,  BODY_MAX);
      if (!title) return fail(res, 422, 'TITLE_REQUIRED', 'Title is required.');
      if (!text)  return fail(res, 422, 'BODY_REQUIRED',  'Body is required.');

      const cta   = normStr(body.cta_label, CTA_MAX);
      const link  = normLink(body.link);
      const theme = normTheme(body.theme);
      const { starts_at, ends_at } = normSchedule(body.starts_at, body.ends_at);
      const active = body.active === undefined ? true : Boolean(body.active);

      const { data: maxRow } = await supabaseAdmin
        .from('dashboard_announcements')
        .select('sort_order')
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextSort = ((maxRow && maxRow.sort_order) || 0) + 1;

      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin
        .from('dashboard_announcements')
        .insert({
          title,
          body: text,
          cta_label: cta,
          link,
          theme,
          sort_order: nextSort,
          active,
          starts_at,
          ends_at,
          created_at: now,
          updated_at: now,
          created_by: req.adminContext?.id || null,
          updated_by: req.adminContext?.id || null
        })
        .select('*')
        .single();
      if (error) throw error;

      await audit(req, 'announcement.create', data.id, null, {
        title, theme, active
      });
      ok(res, data, 201);
    } catch (e) {
      if (e.status) return fail(res, e.status, e.code, e.message);
      console.error('[ANNOUNCEMENTS] admin create:', e.message);
      fail(res, 500, 'CREATE_FAILED', 'Could not create announcement.');
    }
  }
);

adminRouter.put(
  '/:id',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  async (req, res) => {
    try {
      const id = uuidOrThrow(req.params.id);
      const body = req.body || {};

      const { data: before } = await supabaseAdmin
        .from('dashboard_announcements').select('*').eq('id', id).maybeSingle();
      if (!before) return fail(res, 404, 'NOT_FOUND', 'Announcement not found.');

      const patch = {};
      if ('title'     in body) {
        const t = normStr(body.title, TITLE_MAX);
        if (!t) return fail(res, 422, 'TITLE_REQUIRED', 'Title cannot be empty.');
        patch.title = t;
      }
      if ('body'      in body) {
        const t = normStr(body.body, BODY_MAX);
        if (!t) return fail(res, 422, 'BODY_REQUIRED', 'Body cannot be empty.');
        patch.body = t;
      }
      if ('cta_label' in body) patch.cta_label = normStr(body.cta_label, CTA_MAX);
      if ('link'      in body) patch.link      = normLink(body.link);
      if ('theme'     in body) patch.theme     = normTheme(body.theme);
      if ('active'    in body) patch.active    = Boolean(body.active);

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
        .from('dashboard_announcements')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;

      await audit(req, 'announcement.update', id, before, patch);
      ok(res, data);
    } catch (e) {
      if (e.status) return fail(res, e.status, e.code, e.message);
      console.error('[ANNOUNCEMENTS] admin update:', e.message);
      fail(res, 500, 'UPDATE_FAILED', 'Could not update announcement.');
    }
  }
);

adminRouter.delete(
  '/:id',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  async (req, res) => {
    try {
      const id = uuidOrThrow(req.params.id);
      const { data: before } = await supabaseAdmin
        .from('dashboard_announcements').select('*').eq('id', id).maybeSingle();
      if (!before) return fail(res, 404, 'NOT_FOUND', 'Announcement not found.');

      const { error } = await supabaseAdmin.from('dashboard_announcements').delete().eq('id', id);
      if (error) throw error;

      await audit(req, 'announcement.delete', id, before, null);
      ok(res, { id });
    } catch (e) {
      if (e.status) return fail(res, e.status, e.code, e.message);
      console.error('[ANNOUNCEMENTS] admin delete:', e.message);
      fail(res, 500, 'DELETE_FAILED', 'Could not delete announcement.');
    }
  }
);

adminRouter.post(
  '/reorder',
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
      if (!ids || !ids.length) return fail(res, 422, 'IDS_REQUIRED', 'Provide { ids: [...] }.');
      if (!ids.every(isUuid)) return fail(res, 422, 'INVALID_IDS', 'Every id must be a UUID.');

      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from('dashboard_announcements')
        .select('id')
        .in('id', ids);
      if (fetchErr) throw fetchErr;
      if (!existing || existing.length !== ids.length) {
        return fail(res, 422, 'UNKNOWN_IDS', 'Some ids do not exist.');
      }

      const now = new Date().toISOString();
      const updates = ids.map((id, i) =>
        supabaseAdmin.from('dashboard_announcements').update({
          sort_order: i + 1,
          updated_at: now,
          updated_by: req.adminContext?.id || null
        }).eq('id', id)
      );
      const results = await Promise.all(updates);
      const firstErr = results.find(r => r.error);
      if (firstErr) throw firstErr.error;

      await audit(req, 'announcement.reorder', null, null, { ids });
      ok(res, { ids });
    } catch (e) {
      if (e.status) return fail(res, e.status, e.code, e.message);
      console.error('[ANNOUNCEMENTS] admin reorder:', e.message);
      fail(res, 500, 'REORDER_FAILED', 'Could not reorder announcements.');
    }
  }
);

router.admin = adminRouter;
module.exports = router;