// services/auditLogService.js
// ─────────────────────────────────────────────────────────────────
// Central audit log authority.
//
//   record()              insert one audit row (append-only).
//   recordMany()          batched insert (chunks of 500).
//   list()                paginated read with filters (page OR keyset).
//   get()                 single row + admin + target + correlation chain.
//   summary()             KPI counts (single RPC).
//   facets()              categories / actions / severities / results /
//                         actor_types / providers.
//   distinctAdmins()      dropdown for the admin filter.
//   recent()              cheap query for the timeline.
//   exportCsv()           paginated export with CSV-injection guard.
//   verifyIntegrity()     chain check (currently no-op while chain
//                         is deferred — see migration).
//   recordUserActivity()  NOT YET — user_activity_logs deferred.
//
// Contract:
//   • Action classification comes from services/auditActions.
//     There is no local ACTION_MAP.
//   • Every before/after/metadata is scrubbed before insert.
//     reason / adminNote / failureMessage go through scrubText.
//   • record() forwards ALL caller-supplied fields. Fields the
//     strict middleware passes must reach the row:
//       actorType, actorUserId, failureCode, durationMs,
//       correlationId, provider, operation, metadata.
//   • In production, unregistered actions are rejected unless the
//     caller passes allowUnregistered: true (used only by
//     recordUserActivity, which is itself deferred).
//   • Reads never throw anything other than typed errors:
//       status:400 INVALID_DATE / INVALID_ID / INVALID_FILTER
//       status:500 AUDIT_READ_FAILED
// ─────────────────────────────────────────────────────────────────

'use strict';

const { supabaseAdmin } = require('../db/supabase');

// Canonical registry. Do not duplicate these in this file.
const auditActions = require('./auditActions');
const scrubber     = require('./auditScrubber');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESULTS     = Object.freeze(['success', 'failure', 'partial']);
const ACTOR_TYPES = Object.freeze(['admin', 'system', 'scheduler', 'webhook', 'provider', 'customer']);
const SEVERITIES  = Object.freeze(['low', 'medium', 'high', 'critical']);

// Safe fallbacks in case auditActions.js is missing an export.
const safeClassify = typeof auditActions.classify === 'function'
    ? auditActions.classify
    : (action) => ({ category: 'system', severity: 'medium' });

const safeMergeSeverity = typeof auditActions.mergeSeverity === 'function'
    ? auditActions.mergeSeverity
    : (a, b) => {
        const rank = { low: 0, medium: 1, high: 2, critical: 3 };
        const av = rank[String(a).toLowerCase()] ?? 1;
        const bv = rank[String(b).toLowerCase()] ?? 1;
        return av >= bv ? a : b;
    };

const STRICT_ACTIONS = auditActions.STRICT_ACTIONS instanceof Set
    ? auditActions.STRICT_ACTIONS
    : new Set();

const IS_PROD = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

// ─── Typed errors ───────────────────────────────────────────────

function badRequest(code, message, extra = {}) {
    const e = new Error(message || code);
    e.status = 400;
    e.code = code;
    Object.assign(e, extra);
    return e;
}
function readFailed(cause) {
    const e = new Error('Failed to read audit log.');
    e.status = 500;
    e.code = 'AUDIT_READ_FAILED';
    e.cause = cause;
    return e;
}

// ─── Input normalisation ────────────────────────────────────────

function clampLimit(v, def = 50, max = 200) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
function clampPage(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}
function parseDateOr400(s, fieldName) {
    if (!s) return null;
    const d = new Date(s);
    if (isNaN(d.getTime())) {
        throw badRequest('INVALID_DATE', `${fieldName} is not a valid date.`, { field: fieldName });
    }
    return d.toISOString();
}
function truncate(s, n) {
    if (s === null || s === undefined) return null;
    const str = String(s);
    return str.length > n ? str.slice(0, n) : str;
}

// PostgREST .or() escape: strip characters that break the filter
// grammar, then escape % and _ inside the LIKE pattern.
function escapeOrTerm(input) {
    if (input === null || input === undefined) return null;
    // Remove characters that would start a new filter clause.
    let s = String(input).replace(/[(),]/g, ' ');
    // Escape LIKE wildcards.
    s = s.replace(/[%_\\]/g, m => '\\' + m);
    // Trim to a sane length.
    return s.trim().slice(0, 100);
}

// ─── record ─────────────────────────────────────────────────────

async function record(opts = {}) {
    if (!opts.action) {
        const e = new Error('auditLogService.record: action is required');
        e.code = 'AUDIT_ACTION_REQUIRED';
        throw e;
    }

    const action = String(opts.action).slice(0, 120);

    // In production, unknown actions are rejected unless the caller
    // explicitly opts in. This stops a typo from silently creating a
    // permanent unsearchable audit row.
    const knownAction = auditActions.isRegistered
        ? auditActions.isRegistered(action)
        : (typeof auditActions.classify === 'function'
            ? auditActions.classify(action).category !== 'system' ||
              action.toLowerCase().startsWith('system.')
            : true);
    if (IS_PROD && !knownAction && opts.allowUnregistered !== true) {
        const e = new Error(`Unregistered audit action: ${action}`);
        e.code = 'AUDIT_ACTION_UNREGISTERED';
        e.status = 400;
        throw e;
    }

    // Classify. If the caller supplied a category/severity, trust
    // theirs but ensure severity can only escalate.
    const classification = safeClassify(action);
    const category = opts.category || classification.category || 'system';
    const callerSeverity = opts.severity && SEVERITIES.includes(String(opts.severity).toLowerCase())
        ? String(opts.severity).toLowerCase()
        : null;
    const severity = callerSeverity
        ? safeMergeSeverity(classification.severity, callerSeverity)
        : classification.severity;

    const result = RESULTS.includes(String(opts.result))
        ? String(opts.result)
        : 'success';

    const actorType = ACTOR_TYPES.includes(String(opts.actorType))
        ? String(opts.actorType)
        : 'admin';

    const durationMs =
        Number.isFinite(Number(opts.durationMs)) && Number(opts.durationMs) >= 0
            ? Math.min(Math.round(Number(opts.durationMs)), 24 * 60 * 60 * 1000)
            : null;

    // Scrub payloads.
    const scrubbedRecord = scrubber.scrubRecord(opts.before, opts.after);
    const scrubbedMeta   = opts.metadata && typeof opts.metadata === 'object'
        ? scrubber.safeJson(opts.metadata)
        : null;

    const row = {
        admin_id:       opts.adminId && UUID_RE.test(String(opts.adminId)) ? String(opts.adminId) : null,
        admin_email:    truncate(opts.adminEmail, 320),
        admin_role:     truncate(opts.adminRole, 60),
        actor_type:     actorType,
        actor_user_id:  opts.actorUserId && UUID_RE.test(String(opts.actorUserId)) ? String(opts.actorUserId) : null,
        action:         action,
        category:       truncate(category, 60),
        severity:       truncate(severity, 20),
        target_type:    truncate(opts.targetType, 60),
        target_id:      truncate(opts.targetId, 200),
        before:         scrubbedRecord.before,
        after:          scrubbedRecord.after,
        metadata:       scrubbedMeta || {},
        reason:         scrubber.scrubText(opts.reason, 500),
        admin_note:     scrubber.scrubText(opts.adminNote, 2000),
        failure_code:   truncate(opts.failureCode, 100),
        duration_ms:    durationMs,
        correlation_id: truncate(opts.correlationId, 100),
        provider:       truncate(opts.provider, 60),
        operation:      truncate(opts.operation, 120),
        result:         result,
        ip_address:     truncate(opts.ip, 60),
        user_agent:     truncate(opts.userAgent, 500),
        device:         detectDevice(opts.userAgent),
        location:       truncate(opts.location, 200),
        request_id:     truncate(opts.requestId, 100),
        session_id:     truncate(opts.sessionId, 100),
        created_at:     new Date().toISOString()
    };

    const { data, error } = await supabaseAdmin
        .from('admin_audit_logs')
        .insert(row)
        .select('id')
        .maybeSingle();

    if (error) {
        console.error('[auditLog] insert failed:', error.message);
        const e = new Error('Failed to record audit entry.');
        e.status = 500;
        e.code = 'AUDIT_INSERT_FAILED';
        throw e;
    }
    return data && data.id ? data.id : null;
}

async function recordMany(rows = []) {
    if (!Array.isArray(rows) || !rows.length) return [];

    const prepared = [];
    for (const r of rows) {
        try {
            // Build a row via the same pipeline, but do not write —
            // call record() only for the side effects we want, or
            // duplicate the normalisation here. We duplicate here so
            // recordMany is not N individual network calls.
            if (!r || !r.action) continue;

            const action = String(r.action).slice(0, 120);
            const classification = safeClassify(action);
            const category = r.category || classification.category || 'system';
            const callerSeverity = r.severity && SEVERITIES.includes(String(r.severity).toLowerCase())
                ? String(r.severity).toLowerCase()
                : null;
            const severity = callerSeverity
                ? safeMergeSeverity(classification.severity, callerSeverity)
                : classification.severity;
            const result = RESULTS.includes(String(r.result)) ? String(r.result) : 'success';
            const actorType = ACTOR_TYPES.includes(String(r.actorType)) ? String(r.actorType) : 'admin';
            const durationMs = Number.isFinite(Number(r.durationMs)) && Number(r.durationMs) >= 0
                ? Math.min(Math.round(Number(r.durationMs)), 24 * 60 * 60 * 1000)
                : null;

            const scrubbed = scrubber.scrubRecord(r.before, r.after);
            const meta = r.metadata && typeof r.metadata === 'object'
                ? scrubber.safeJson(r.metadata)
                : null;

            prepared.push({
                admin_id:       r.adminId && UUID_RE.test(String(r.adminId)) ? String(r.adminId) : null,
                admin_email:    truncate(r.adminEmail, 320),
                admin_role:     truncate(r.adminRole, 60),
                actor_type:     actorType,
                actor_user_id:  r.actorUserId && UUID_RE.test(String(r.actorUserId)) ? String(r.actorUserId) : null,
                action:         action,
                category:       truncate(category, 60),
                severity:       truncate(severity, 20),
                target_type:    truncate(r.targetType, 60),
                target_id:      truncate(r.targetId, 200),
                before:         scrubbed.before,
                after:          scrubbed.after,
                metadata:       meta || {},
                reason:         scrubber.scrubText(r.reason, 500),
                admin_note:     scrubber.scrubText(r.adminNote, 2000),
                failure_code:   truncate(r.failureCode, 100),
                duration_ms:    durationMs,
                correlation_id: truncate(r.correlationId, 100),
                provider:       truncate(r.provider, 60),
                operation:      truncate(r.operation, 120),
                result:         result,
                ip_address:     truncate(r.ip, 60),
                user_agent:     truncate(r.userAgent, 500),
                device:         detectDevice(r.userAgent),
                location:       truncate(r.location, 200),
                request_id:     truncate(r.requestId, 100),
                session_id:     truncate(r.sessionId, 100),
                created_at:     new Date().toISOString()
            });
        } catch (_) {
            // Skip a malformed row; do not abort the whole batch.
        }
    }

    if (!prepared.length) return [];

    const insertedIds = [];
    const CHUNK = 500;
    for (let i = 0; i < prepared.length; i += CHUNK) {
        const slice = prepared.slice(i, i + CHUNK);
        const { data, error } = await supabaseAdmin
            .from('admin_audit_logs')
            .insert(slice)
            .select('id');
        if (error) {
            console.error('[auditLog] batch insert failed:', error.message);
            const e = new Error('Failed to record audit entries.');
            e.status = 500;
            e.code = 'AUDIT_INSERT_FAILED';
            throw e;
        }
        (data || []).forEach(r => insertedIds.push(r.id));
    }
    return insertedIds;
}

// ─── list ───────────────────────────────────────────────────────

async function list(params = {}) {
    const page     = clampPage(params.page);
    const limit    = clampLimit(params.limit, 50, 200);
    const offset   = (page - 1) * limit;

    const fromIso = parseDateOr400(params.from, 'from');
    const toIso   = parseDateOr400(params.to,   'to');

    // Keyset cursor support (page+limit still works for the UI).
    const cursor = params.cursor && typeof params.cursor === 'object' ? params.cursor : null;

    let q = supabaseAdmin
        .from('admin_audit_logs')
        .select(
            'id, admin_id, admin_email, admin_role, actor_type, actor_user_id, ' +
            'action, category, severity, target_type, target_id, reason, ' +
            'failure_code, duration_ms, correlation_id, provider, operation, ' +
            'result, ip_address, device, request_id, created_at',
            { count: 'estimated' }
        )
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });

    if (params.adminId && UUID_RE.test(String(params.adminId))) {
        q = q.eq('admin_id', String(params.adminId));
    }

    if (params.category && params.category !== 'all') {
        const cats = Array.isArray(params.categories) && params.categories.length
            ? params.categories
            : [params.category];
        const clean = cats.map(c => String(c)).filter(Boolean);
        if (clean.length === 1) q = q.eq('category', clean[0]);
        else if (clean.length > 1) q = q.in('category', clean);
    } else if (Array.isArray(params.categories) && params.categories.length) {
        q = q.in('category', params.categories.map(c => String(c)));
    }

    if (params.action && params.action !== 'all')       q = q.eq('action', String(params.action));
    if (params.severity && params.severity !== 'all')   q = q.eq('severity', String(params.severity));
    if (params.result && params.result !== 'all')       q = q.eq('result', String(params.result));
    if (params.actorType && params.actorType !== 'all') q = q.eq('actor_type', String(params.actorType));
    if (params.provider && params.provider !== 'all')   q = q.eq('provider', String(params.provider));
    if (params.correlationId) q = q.eq('correlation_id', String(params.correlationId));
    if (params.requestId)     q = q.eq('request_id', String(params.requestId));

    if (fromIso) q = q.gte('created_at', fromIso);
    if (toIso)   q = q.lte('created_at', toIso);

    if (cursor && cursor.created_at && cursor.id) {
        // Strictly-less-than the cursor in (created_at, id) descending order.
        q = q.or(
            `created_at.lt.${cursor.created_at},` +
            `and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`
        );
    } else {
        q = q.range(offset, offset + limit - 1);
    }

    if (params.search) {
        const safe = escapeOrTerm(params.search);
        if (safe) {
            q = q.or(
                `action.ilike.%${safe}%,` +
                `admin_email.ilike.%${safe}%,` +
                `target_id.ilike.%${safe}%,` +
                `request_id.ilike.%${safe}%,` +
                `correlation_id.ilike.%${safe}%,` +
                `reason.ilike.%${safe}%`
            );
        }
    }

    const { data, error, count } = await q;
    if (error) throw readFailed(error.message);

    // Enrich with admin display names.
    const adminIds = [...new Set((data || []).map(r => r.admin_id).filter(Boolean))];
    const adminsById = {};
    if (adminIds.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, role')
            .in('id', adminIds);
        (profiles || []).forEach(p => { adminsById[p.id] = p; });
    }

    const entries = (data || []).map(r => ({
        ...r,
        admin_username: adminsById[r.admin_id] ? adminsById[r.admin_id].username : null,
        admin_display:
            (adminsById[r.admin_id] && adminsById[r.admin_id].username) ||
            r.admin_email ||
            'Unknown admin'
    }));

    // Neighbour ids for drawer Prev/Next. Only computed when the UI
    // asks for it (cheap query, but skip when not needed).
    let prev_id = null, next_id = null;
    if (entries.length === 1 && params.withNeighbours === '1' && UUID_RE.test(String(entries[0].id))) {
        const anchor = entries[0];
        const [prevRes, nextRes] = await Promise.all([
            supabaseAdmin.from('admin_audit_logs')
                .select('id')
                .lt('created_at', anchor.created_at)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle(),
            supabaseAdmin.from('admin_audit_logs')
                .select('id')
                .gt('created_at', anchor.created_at)
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle()
        ]);
        prev_id = prevRes.data && prevRes.data.id ? prevRes.data.id : null;
        next_id = nextRes.data && nextRes.data.id ? nextRes.data.id : null;
    }

    const total = typeof count === 'number' ? count : null;

    return {
        entries,
        count: total != null ? total : null,
        page, limit,
        totalPages: total != null ? Math.ceil(total / limit) : null,
        hasMore: entries.length === limit,
        next_cursor: entries.length
            ? { created_at: entries[entries.length - 1].created_at, id: entries[entries.length - 1].id }
            : null,
        prev_id, next_id
    };
}

// ─── get ────────────────────────────────────────────────────────

async function get(id) {
    if (!UUID_RE.test(String(id || ''))) {
        throw badRequest('INVALID_ID', 'Invalid audit entry id.');
    }
    const { data, error } = await supabaseAdmin
        .from('admin_audit_logs')
        .select('*')
        .eq('id', id)
        .maybeSingle();
    if (error) throw readFailed(error.message);
    if (!data) {
        const e = new Error('Audit entry not found.');
        e.status = 404;
        e.code = 'AUDIT_NOT_FOUND';
        throw e;
    }

    // Admin context.
    let admin = null;
    if (data.admin_id && UUID_RE.test(String(data.admin_id))) {
        const { data: p } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email, role')
            .eq('id', data.admin_id)
            .maybeSingle();
        admin = p || null;
    }

    // Resolved target.
    let target = null;
    if (data.target_id && UUID_RE.test(String(data.target_id))) {
        const idStr = String(data.target_id);
        if (data.target_type === 'profile' || data.target_type === 'user') {
            const { data: u } = await supabaseAdmin
                .from('profiles')
                .select('id, username, email, status, role')
                .eq('id', idStr).maybeSingle();
            target = u || null;
        } else if (data.target_type === 'transaction') {
            const { data: t } = await supabaseAdmin
                .from('transactions')
                .select('id, reference, type, status, amount, currency, user_id')
                .eq('id', idStr).maybeSingle();
            target = t || null;
        }
    }

    // Correlation chain.
    let chain = [];
    if (data.correlation_id) {
        const { data: chainRows } = await supabaseAdmin
            .from('admin_audit_logs')
            .select('id, action, severity, result, created_at')
            .eq('correlation_id', data.correlation_id)
            .order('created_at', { ascending: true })
            .limit(50);
        chain = chainRows || [];
    }

    return { entry: data, admin, target, chain };
}

// ─── summary / facets / distinctAdmins ─────────────────────────

async function summary(params = {}) {
    const fromIso = parseDateOr400(params.from, 'from');
    const toIso   = parseDateOr400(params.to,   'to');

    const { data, error } = await supabaseAdmin.rpc('admin_audit_summary', {
        p_from:     fromIso,
        p_to:       toIso,
        p_admin_id: params.adminId && UUID_RE.test(String(params.adminId)) ? String(params.adminId) : null,
        p_category: params.category && params.category !== 'all' ? String(params.category) : null,
        p_severity: params.severity && params.severity !== 'all' ? String(params.severity) : null,
        p_result:   params.result && params.result !== 'all' ? String(params.result) : null
    });
    if (error) {
        if (error.code === '42883' || error.code === 'PGRST202') {
            return { available: false, reason: 'RPC_NOT_DEPLOYED',
                     total: null, today: null, critical: null, failed: null, security: null };
        }
        throw readFailed(error.message);
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
        available: true,
        total:    Number(row && row.total    || 0),
        today:    Number(row && row.today    || 0),
        critical: Number(row && row.critical || 0),
        failed:   Number(row && row.failed   || 0),
        security: Number(row && row.security || 0)
    };
}

async function facets() {
    const { data, error } = await supabaseAdmin.rpc('admin_audit_facets');
    if (error) {
        if (error.code === '42883' || error.code === 'PGRST202') {
            // Fallback to whatever the registry knows about.
            const cats = Array.isArray(auditActions.CATEGORIES) ? auditActions.CATEGORIES : [];
            const acts = Array.isArray(auditActions.ACTIONS)
                ? auditActions.ACTIONS
                : (auditActions.ACTION_MAP
                    ? Object.keys(auditActions.ACTION_MAP)
                    : []);
            return {
                categories:  cats,
                actions:     acts,
                severities:  [...SEVERITIES],
                results:     [...RESULTS],
                actor_types: [...ACTOR_TYPES],
                providers:   []
            };
        }
        throw readFailed(error.message);
    }
    const row = Array.isArray(data) ? data[0] : (data || {});
    return {
        categories:  Array.isArray(row.categories)  ? row.categories  : [],
        actions:     Array.isArray(row.actions)     ? row.actions     : [],
        severities:  Array.isArray(row.severities)  ? row.severities  : [...SEVERITIES],
        results:     Array.isArray(row.results)     ? row.results     : [...RESULTS],
        actor_types: Array.isArray(row.actor_types) ? row.actor_types : [...ACTOR_TYPES],
        providers:   Array.isArray(row.providers)   ? row.providers   : []
    };
}

async function distinctAdmins() {
    const { data, error } = await supabaseAdmin.rpc('admin_audit_distinct_admins');
    if (error) {
        // Fallback to a plain distinct query if the RPC is missing.
        if (error.code === '42883' || error.code === 'PGRST202') {
            const { data: rows } = await supabaseAdmin
                .from('admin_audit_logs')
                .select('admin_id, admin_email')
                .not('admin_id', 'is', null)
                .order('admin_email', { ascending: true })
                .limit(500);
            return rows || [];
        }
        return [];
    }
    return Array.isArray(data) ? data : [];
}

// ─── recent ────────────────────────────────────────────────────

async function recent(limit = 20, filters = {}) {
    const cap = clampLimit(limit, 20, 200);
    const sinceIso = parseDateOr400(filters.since, 'since');

    const { data, error } = await supabaseAdmin.rpc('admin_audit_recent', {
        p_limit:          cap,
        p_since:          sinceIso,
        p_admin_id:       filters.adminId && UUID_RE.test(String(filters.adminId)) ? String(filters.adminId) : null,
        p_category:       filters.category && filters.category !== 'all' ? String(filters.category) : null,
        p_severity:       filters.severity && filters.severity !== 'all' ? String(filters.severity) : null,
        p_result:         filters.result && filters.result !== 'all' ? String(filters.result) : null,
        p_actor_type:     filters.actorType && filters.actorType !== 'all' ? String(filters.actorType) : null,
        p_provider:       filters.provider && filters.provider !== 'all' ? String(filters.provider) : null,
        p_correlation_id: filters.correlationId ? String(filters.correlationId) : null,
        p_search:         filters.search ? String(filters.search).slice(0, 100) : null
    });
    if (error) {
        if (error.code === '42883' || error.code === 'PGRST202') {
            // Fallback: direct query.
            let q = supabaseAdmin
                .from('admin_audit_logs')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(cap);
            if (sinceIso) q = q.gt('created_at', sinceIso);
            const { data: rows } = await q;
            return rows || [];
        }
        throw readFailed(error.message);
    }
    return Array.isArray(data) ? data : [];
}

// ─── exportCsv ─────────────────────────────────────────────────

function csvEscape(v) {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    // CSV-injection guard: prefix dangerous leading characters.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    // Quote if it contains comma, quote, newline, or leading/trailing space.
    if (/[",\n\r]/.test(s) || /^\s|\s$/.test(s)) {
        s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

async function exportCsv(filters = {}, options = {}) {
    const maxRows = clampLimit(options.maxRows, 50000, 100000);
    const includeSensitive = options.includeSensitive === true;

    const header = [
        'created_at', 'actor_type', 'admin_email', 'admin_role',
        'action', 'category', 'severity', 'result',
        'target_type', 'target_id', 'provider', 'operation',
        'correlation_id', 'request_id', 'duration_ms',
        'failure_code', 'reason'
    ];
    if (includeSensitive) {
        header.push('ip_address', 'user_agent');
    }

    const lines = [header.join(',')];
    let rowCount = 0;
    let truncated = false;

    const BATCH = 1000;
    let cursor = null;

    // Walk in keyset order until maxRows is reached or data ends.
    for (;;) {
        const remaining = maxRows - rowCount;
        if (remaining <= 0) { truncated = true; break; }
        const limit = Math.min(BATCH, remaining);

        let q = supabaseAdmin
            .from('admin_audit_logs')
            .select(
                'id, created_at, actor_type, admin_email, admin_role, action, category, ' +
                'severity, result, target_type, target_id, provider, operation, ' +
                'correlation_id, request_id, duration_ms, failure_code, reason, ' +
                'ip_address, user_agent'
            )
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .limit(limit);

        if (filters.from) q = q.gte('created_at', parseDateOr400(filters.from, 'from'));
        if (filters.to)   q = q.lte('created_at', parseDateOr400(filters.to,   'to'));
        if (filters.adminId && UUID_RE.test(String(filters.adminId))) q = q.eq('admin_id', String(filters.adminId));
        if (filters.category && filters.category !== 'all') q = q.eq('category', String(filters.category));
        if (filters.action && filters.action !== 'all')     q = q.eq('action', String(filters.action));
        if (filters.severity && filters.severity !== 'all') q = q.eq('severity', String(filters.severity));
        if (filters.result && filters.result !== 'all')     q = q.eq('result', String(filters.result));
        if (filters.actorType && filters.actorType !== 'all') q = q.eq('actor_type', String(filters.actorType));
        if (filters.provider && filters.provider !== 'all') q = q.eq('provider', String(filters.provider));
        if (filters.correlationId) q = q.eq('correlation_id', String(filters.correlationId));
        if (filters.requestId)     q = q.eq('request_id', String(filters.requestId));
        if (filters.search) {
            const safe = escapeOrTerm(filters.search);
            if (safe) {
                q = q.or(
                    `action.ilike.%${safe}%,` +
                    `admin_email.ilike.%${safe}%,` +
                    `target_id.ilike.%${safe}%,` +
                    `request_id.ilike.%${safe}%,` +
                    `correlation_id.ilike.%${safe}%,` +
                    `reason.ilike.%${safe}%`
                );
            }
        }

        if (cursor) {
            q = q.or(
                `created_at.lt.${cursor.created_at},` +
                `and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`
            );
        }

        const { data, error } = await q;
        if (error) throw readFailed(error.message);
        if (!data || !data.length) break;

        for (const r of data) {
            const row = header.map(k => {
                if (k === 'ip_address' && !includeSensitive) return '';
                if (k === 'user_agent' && !includeSensitive) return '';
                return csvEscape(r[k]);
            });
            lines.push(row.join(','));
            rowCount++;
            if (rowCount >= maxRows) { truncated = true; break; }
        }

        if (data.length < limit) break;
        const last = data[data.length - 1];
        cursor = { created_at: last.created_at, id: last.id };
        if (rowCount >= maxRows) { truncated = true; break; }
    }

    // UTF-8 BOM so Excel opens it correctly.
    const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
    return { csv, rowCount, truncated };
}

// ─── verifyIntegrity ───────────────────────────────────────────
//
// Chain is deferred (migration created prev_hash / row_hash but no
// trigger yet). This returns a "not_enabled" result so the UI can
// display it honestly, not a fake "verified".

async function verifyIntegrity(/* from, to */) {
    return { enabled: false, checked: 0, first_broken_id: null };
}

// ─── detectDevice ──────────────────────────────────────────────

function detectDevice(ua) {
    const s = String(ua || '');
    if (!s) return null;
    const os =
        /Windows/i.test(s)  ? 'Windows' :
        /Mac OS X/i.test(s) ? 'macOS'   :
        /Android/i.test(s)  ? 'Android' :
        /iPhone|iPad|iOS/i.test(s) ? 'iOS' :
        /Linux/i.test(s)    ? 'Linux'   : null;
    const browser =
        /Edg\//i.test(s)    ? 'Edge' :
        /Chrome\//i.test(s) ? 'Chrome' :
        /Firefox\//i.test(s)? 'Firefox' :
        /Safari\//i.test(s) ? 'Safari' : null;
    if (!os && !browser) return null;
    return [browser, os].filter(Boolean).join(' / ');
}

// ─── recordUserActivity — deferred ─────────────────────────────

async function recordUserActivity() {
    throw Object.assign(
        new Error('recordUserActivity is not enabled: user_activity_logs is deferred.'),
        { code: 'USER_ACTIVITY_NOT_ENABLED', status: 501 }
    );
}

module.exports = {
    // Constants re-exported for routes that want to validate input.
    RESULTS,
    ACTOR_TYPES,
    SEVERITIES,
    STRICT_ACTIONS,

    // Writers.
    record,
    recordMany,
    recordUserActivity,

    // Readers.
    list,
    get,
    summary,
    facets,
    distinctAdmins,
    recent,
    exportCsv,
    verifyIntegrity
};