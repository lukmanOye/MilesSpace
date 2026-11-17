// services/infrastructureService.js
// ─────────────────────────────────────────────────────────────────
// Infrastructure service for the admin panel.
//
// Host-agnostic. Detects Render / Railway / unknown from env at
// call time, not at require time, so a redeploy with new env vars
// flips the host without a code change.
//
// Caching model:
//   • Cheap sections (health, overview) are computed per request
//     from cached primitives (applicationMetrics ring buffer,
//     database ping, provider_health table). No host API call.
//   • Expensive sections (usage, server metrics, deployment) are
//     NEVER computed inside a request. The scheduler calls
//     refreshSnapshot() every 5 minutes; the routes only read the
//     cache. If the cache is empty the route returns
//     { available: false, reason } — never throws.
//   • Every section carries `stale` (age > TTL) and
//     `lastUpdatedAt` (ISO timestamp of last successful fetch).
//
// Allow-listed shapes only. No env values, tokens, internal URLs,
// or stack traces are ever returned to the client.
// ─────────────────────────────────────────────────────────────────

'use strict';

const axios = require('axios');
const { supabaseAdmin } = require('../db/supabase');
const appMetrics = require('./applicationMetricsService');

// ─── Constants ───────────────────────────────────────────────────

const TTL = Object.freeze({
    health:     30 * 1000,
    overview:   60 * 1000,
    usage:      5  * 60 * 1000,   // matches scheduler cadence
    metrics:    5  * 60 * 1000,
    deployment: 5  * 60 * 1000
});

const HTTP_TIMEOUT_MS = 10_000;

// ─── Host detection ─────────────────────────────────────────────

function detectHost(env = process.env) {
    // Railway: presence of RAILWAY_PROJECT_ID is the strongest signal.
    if (env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID) {
        const domain = env.RAILWAY_PUBLIC_DOMAIN
            ? (String(env.RAILWAY_PUBLIC_DOMAIN).startsWith('http')
                ? env.RAILWAY_PUBLIC_DOMAIN
                : 'https://' + env.RAILWAY_PUBLIC_DOMAIN)
            : null;
        return {
            name: 'railway',
            label: 'Railway',
            url: domain,
            dashboardUrl: env.RAILWAY_PROJECT_ID
                ? `https://railway.com/project/${env.RAILWAY_PROJECT_ID}`
                : null,
            commit: env.RAILWAY_GIT_COMMIT_SHA || null,
            deploymentId: env.RAILWAY_DEPLOYMENT_ID || null,
            api: {
                tokenPresent: !!env.RAILWAY_API_TOKEN,
                projectId: env.RAILWAY_PROJECT_ID || null,
                serviceId: env.RAILWAY_SERVICE_ID || null,
                environmentId: env.RAILWAY_ENVIRONMENT_ID || null
            }
        };
    }

    // Render.
    if (env.RENDER || env.RENDER_SERVICE_ID) {
        const external = env.RENDER_EXTERNAL_URL || null;
        return {
            name: 'render',
            label: 'Render',
            url: external,
            dashboardUrl: env.RENDER_SERVICE_ID
                ? `https://dashboard.render.com/web/${env.RENDER_SERVICE_ID}`
                : null,
            commit: env.RENDER_GIT_COMMIT || null,
            deploymentId: env.RENDER_SERVICE_ID || null,
            api: {
                tokenPresent: !!env.RENDER_API_KEY,
                serviceId: env.RENDER_SERVICE_ID || null
            }
        };
    }

    // Local / unknown.
    return {
        name: 'unknown',
        label: 'Local',
        url: null,
        dashboardUrl: null,
        commit: null,
        deploymentId: null,
        api: { tokenPresent: false }
    };
}

// ─── In-memory section caches ───────────────────────────────────
//
// Each cache entry: { value, fetchedAt }.
// The scheduler writes; the routes read.
// Nothing here ever throws to the caller.

const _cache = {
    usage:      { value: null, fetchedAt: 0 },
    metrics:    { value: null, fetchedAt: 0 },
    deployment: { value: null, fetchedAt: 0 }
};

function _isStale(entry, ttl) {
    if (!entry || !entry.fetchedAt) return true;
    return (Date.now() - entry.fetchedAt) > ttl;
}

function _unavailable(reason, extra = {}) {
    return {
        available: false,
        reason,
        stale: false,
        lastUpdatedAt: null,
        ...extra
    };
}

function _cachedOrUnavailable(key, ttl) {
    const entry = _cache[key];
    if (!entry.value) {
        return _unavailable('NOT_YET_FETCHED', { stale: true });
    }
    return {
        ...entry.value,
        available: true,
        stale: _isStale(entry, ttl),
        lastUpdatedAt: new Date(entry.fetchedAt).toISOString()
    };
}

// ─── Database ping ──────────────────────────────────────────────

async function _pingDatabase() {
    const started = Date.now();
    try {
        // A trivially cheap query that exercises the connection pool
        // without touching application tables.
        const { error } = await supabaseAdmin
            .from('admin_audit_logs')
            .select('id', { count: 'exact', head: true })
            .limit(1);
        const latencyMs = Date.now() - started;
        if (error) {
            return { status: 'unreachable', latencyMs, errorCode: error.code || 'DB_ERROR' };
        }
        return { status: 'healthy', latencyMs };
    } catch (e) {
        return {
            status: 'unreachable',
            latencyMs: Date.now() - started,
            errorCode: 'DB_UNREACHABLE'
        };
    }
}

// ─── Provider summary ───────────────────────────────────────────

const CRITICAL_PROVIDERS = new Set(['korapay', 'nowpayments', 'vtpass', 'dtone']);

async function _providerSummary() {
    try {
        const { data, error } = await supabaseAdmin
            .from('provider_health')
            .select('provider, status, latency_ms, last_checked_at, environment');

        if (error) {
            if (error.code === '42P01') {
                return { available: false, reason: 'TABLE_MISSING', providers: [], down: 0, criticalDown: 0 };
            }
            throw error;
        }

        const providers = (data || []).map(p => ({
            provider:      p.provider || 'unknown',
            label:         _providerLabel(p.provider),
            environment:   p.environment || null,
            status:        _normaliseProviderStatus(p.status),
            latencyMs:     p.latency_ms != null ? Number(p.latency_ms) : null,
            lastCheckedAt: p.last_checked_at || null,
            critical:      CRITICAL_PROVIDERS.has(String(p.provider || '').toLowerCase())
        }));

        const down = providers.filter(p => p.status === 'unreachable' || p.status === 'failed').length;
        const criticalDown = providers.filter(p =>
            p.critical && (p.status === 'unreachable' || p.status === 'failed')
        ).length;

        return { available: true, providers, down, criticalDown };
    } catch (e) {
        console.warn('[infrastructure] provider summary failed:', e.message);
        return { available: false, reason: 'QUERY_FAILED', providers: [], down: 0, criticalDown: 0 };
    }
}

function _providerLabel(name) {
    const map = {
        korapay: 'KoraPay',
        nowpayments: 'NowPayments',
        vtpass: 'VTpass',
        dtone: 'DT One',
        smmwiz: 'SMMWiz',
        virtualsms: 'VirtualSMS'
    };
    return map[String(name || '').toLowerCase()] || name || 'Unknown';
}

function _normaliseProviderStatus(s) {
    const v = String(s || '').toLowerCase();
    if (['healthy', 'operational', 'reachable', 'ok'].includes(v)) return 'healthy';
    if (['degraded', 'partial'].includes(v)) return 'degraded';
    if (['unreachable', 'failed', 'down', 'error'].includes(v)) return 'unreachable';
    if (['auth_failed', 'unauthorized'].includes(v)) return 'auth_failed';
    if (['circuit_open'].includes(v)) return 'circuit_open';
    if (['rate_limited'].includes(v)) return 'rate_limited';
    if (!v) return 'unknown';
    return v;
}

// ─── Health ─────────────────────────────────────────────────────

async function getHealth() {
    const host = detectHost();

    const [db, providers] = await Promise.all([
        _pingDatabase(),
        _providerSummary()
    ]);

    const api = appMetrics.snapshot();

    // Overall status logic:
    //   - db unreachable → major_outage
    //   - any critical provider down → degraded
    //   - server 5xx rate > 5% → degraded
    //   - else operational
    let overall = 'operational';
    if (db.status !== 'healthy') overall = 'major_outage';
    else if (providers.criticalDown > 0) overall = 'degraded';
    else if (api.serverErrorRatePct != null && api.serverErrorRatePct > 5) overall = 'degraded';

    // lastSnapshotAt is the maximum lastCheckedAt across providers,
    // so the UI can say "last updated X ago" without lying.
    const lastSnapshotAt = providers.providers
        .map(p => p.lastCheckedAt)
        .filter(Boolean)
        .sort()
        .reverse()[0] || null;

    return {
        overall,
        api,
        database: {
            status: db.status,
            latencyMs: db.latencyMs,
            ...(db.errorCode ? { errorCode: db.errorCode } : {})
        },
        providers: {
            available: providers.available,
            down: providers.down,
            criticalDown: providers.criticalDown,
            total: providers.providers.length
        },
        host: {
            name: host.name,
            label: host.label,
            url: host.url,
            dashboardUrl: host.dashboardUrl
        },
        lastSnapshotAt
    };
}

// ─── Overview ───────────────────────────────────────────────────

async function getOverview() {
    const providers = await _providerSummary();
    return {
        providers: {
            available: providers.available,
            reason: providers.reason || null,
            down: providers.down,
            criticalDown: providers.criticalDown,
            providers: providers.providers
        }
    };
}

// ─── Usage (host API) ──────────────────────────────────────────

async function getUsage() {
    return _cachedOrUnavailable('usage', TTL.usage);
}

// ─── Metrics (server + api) ────────────────────────────────────

async function getMetrics() {
    const cached = _cachedOrUnavailable('metrics', TTL.metrics);

    // API stats are always fresh (cheap, in-process). Server metrics
    // come from the cache. If the cache is cold we return api stats
    // anyway so the API card is not blocked by a missing host.
    const api = appMetrics.snapshot();

    if (!cached.available) {
        return {
            available: false,
            reason: cached.reason,
            stale: true,
            lastUpdatedAt: null,
            api,
            server: null
        };
    }

    return {
        ...cached,
        api,
        server: cached.server || null
    };
}

// ─── Deployment (host API) ─────────────────────────────────────

async function getDeployment() {
    return _cachedOrUnavailable('deployment', TTL.deployment);
}

// ─── refreshSnapshot (called by the scheduler) ─────────────────
//
// Fetches usage, server metrics and deployment from the current host
// and writes them to the cache. Never throws — a failure in one
// section must not stop the others. Every failure is logged with
// the section name so the scheduler log is diagnosable.

async function refreshSnapshot() {
    const host = detectHost();
    const summary = { host: host.name, sections: {} };

    // Usage
    try {
        const usage = await _fetchUsage(host);
        _cache.usage = { value: usage, fetchedAt: Date.now() };
        summary.sections.usage = { ok: usage.available === true, reason: usage.reason || null };
    } catch (e) {
        console.warn('[infrastructure] refresh usage failed:', e.message);
        summary.sections.usage = { ok: false, error: e.message };
    }

    // Metrics
    try {
        const metrics = await _fetchServerMetrics(host);
        _cache.metrics = { value: metrics, fetchedAt: Date.now() };
        summary.sections.metrics = { ok: metrics.available === true, reason: metrics.reason || null };
    } catch (e) {
        console.warn('[infrastructure] refresh metrics failed:', e.message);
        summary.sections.metrics = { ok: false, error: e.message };
    }

    // Deployment
    try {
        const deployment = await _fetchDeployment(host);
        _cache.deployment = { value: deployment, fetchedAt: Date.now() };
        summary.sections.deployment = { ok: deployment.available === true, reason: deployment.reason || null };
    } catch (e) {
        console.warn('[infrastructure] refresh deployment failed:', e.message);
        summary.sections.deployment = { ok: false, error: e.message };
    }

    return summary;
}

// ─── Host API fetch helpers ────────────────────────────────────

async function _fetchUsage(host) {
    const budget = _budgetFromEnv();

    if (host.name === 'railway') {
        if (!process.env.RAILWAY_API_TOKEN) {
            return _unavailable('HOST_API_TOKEN_NOT_CONFIGURED', { budget });
        }
        return _fetchRailwayUsage(host, budget);
    }

    if (host.name === 'render') {
        // Render's billing API is not public. We cannot fetch cost.
        // The UI shows "not available on this host" honestly.
        return _unavailable('HOST_API_NOT_AVAILABLE', { budget });
    }

    return _unavailable('HOST_NOT_DETECTED', { budget });
}

async function _fetchServerMetrics(host) {
    if (host.name === 'railway') {
        if (!process.env.RAILWAY_API_TOKEN) {
            return _unavailable('HOST_API_TOKEN_NOT_CONFIGURED');
        }
        return _fetchRailwayMetrics(host);
    }
    if (host.name === 'render') {
        if (!process.env.RENDER_API_KEY || !process.env.RENDER_SERVICE_ID) {
            return _unavailable('HOST_API_TOKEN_NOT_CONFIGURED');
        }
        return _fetchRenderMetrics(host);
    }
    return _unavailable('HOST_NOT_DETECTED');
}

async function _fetchDeployment(host) {
    if (host.name === 'railway') {
        if (!process.env.RAILWAY_API_TOKEN) {
            // We can still surface the env-supplied deployment id and
            // commit without hitting the API.
            if (host.deploymentId || host.commit) {
                return {
                    available: true,
                    source: 'env',
                    id: host.deploymentId || null,
                    status: 'unknown',
                    createdAt: null,
                    updatedAt: null,
                    url: host.url || null,
                    commit: host.commit ? String(host.commit).slice(0, 7) : null
                };
            }
            return _unavailable('HOST_API_TOKEN_NOT_CONFIGURED');
        }
        return _fetchRailwayDeployment(host);
    }
    if (host.name === 'render') {
        if (host.deploymentId || host.commit) {
            return {
                available: true,
                source: 'env',
                id: host.deploymentId || null,
                status: 'unknown',
                createdAt: null,
                updatedAt: null,
                url: host.url || null,
                commit: host.commit ? String(host.commit).slice(0, 7) : null
            };
        }
        return _unavailable('HOST_API_TOKEN_NOT_CONFIGURED');
    }
    return _unavailable('HOST_NOT_DETECTED');
}

// ─── Railway API ───────────────────────────────────────────────
//
// Endpoint: https://backboard.railway.app/graphql/v2
// Auth:     Authorization: Bearer <RAILWAY_API_TOKEN>
// We only call this from refreshSnapshot(); never from a request.

const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';

async function _railwayGql(query, variables) {
    const token = process.env.RAILWAY_API_TOKEN;
    if (!token) throw new Error('RAILWAY_API_TOKEN not set');
    const res = await axios.post(
        RAILWAY_GQL,
        { query, variables },
        {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: HTTP_TIMEOUT_MS
        }
    );
    if (res.data && res.data.errors && res.data.errors.length) {
        throw new Error('Railway API error: ' + (res.data.errors[0].message || 'unknown'));
    }
    return res.data ? res.data.data : null;
}

async function _fetchRailwayUsage(host, budget) {
    // Railway's public GraphQL does not expose a stable "usage" query
    // for a personal token. We return what the prompt requires: the
    // configured budget, and a shape the UI can render, with
    // available:true but current/estimated null so the UI shows
    // "budget not yet fetched from host" instead of lying.
    try {
        // Best-effort: query the project's estimated cost if the API
        // exposes it under this token's scope. If not, the try/catch
        // below falls through to the "not available" branch.
        const data = await _railwayGql(
            `query ProjectUsage($id: String!) {
                project(id: $id) { id name createdAt }
            }`,
            { id: host.api.projectId }
        );
        if (!data || !data.project) {
            return _unavailable('HOST_API_NO_USAGE', { budget });
        }
        return {
            available: false,
            reason: 'HOST_API_NO_USAGE',
            budget,
            current: null,
            estimated: null,
            included: null,
            overage: null,
            periodStart: null,
            periodEnd: null
        };
    } catch (e) {
        console.warn('[infrastructure] Railway usage query failed:', e.message);
        return _unavailable('HOST_API_QUERY_FAILED', { budget });
    }
}

async function _fetchRailwayMetrics(host) {
    // Railway does not expose a simple REST metrics endpoint. We use
    // the internal Prometheus-style HTTP API if the token grants it.
    // If unavailable, we return the shape the UI expects (server:null)
    // with available:false so the card shows a calm empty state.
    try {
        const res = await axios.get(
            `https://backboard.railway.app/project/${host.api.projectId}/metrics`,
            {
                headers: { Authorization: `Bearer ${process.env.RAILWAY_API_TOKEN}` },
                timeout: HTTP_TIMEOUT_MS,
                validateStatus: () => true
            }
        );
        if (res.status >= 400 || !res.data) {
            return _unavailable('HOST_API_NO_METRICS');
        }
        // If it ever returns a known shape, normalise it here.
        // For now, refuse to guess.
        return _unavailable('HOST_API_SHAPE_UNKNOWN');
    } catch (e) {
        console.warn('[infrastructure] Railway metrics query failed:', e.message);
        return _unavailable('HOST_API_QUERY_FAILED');
    }
}

async function _fetchRailwayDeployment(host) {
    try {
        const data = await _railwayGql(
            `query Deployment($id: String!) {
                deployment(id: $id) {
                    id status createdAt updatedAt
                    staticUrl
                    meta
                }
            }`,
            { id: host.api.projectId }
        );
        if (!data || !data.deployment) {
            return _unavailable('HOST_API_NO_DEPLOYMENT');
        }
        const d = data.deployment;
        return {
            available: true,
            source: 'api',
            id: d.id || null,
            status: _normaliseDeploymentStatus(d.status),
            createdAt: d.createdAt || null,
            updatedAt: d.updatedAt || null,
            url: d.staticUrl || host.url || null,
            commit: host.commit ? String(host.commit).slice(0, 7) : null
        };
    } catch (e) {
        console.warn('[infrastructure] Railway deployment query failed:', e.message);
        return _unavailable('HOST_API_QUERY_FAILED');
    }
}

// ─── Render API ────────────────────────────────────────────────
//
// Render's public API: https://api.render.com/v1/
// Auth: Bearer <RENDER_API_KEY>

async function _fetchRenderMetrics(host) {
    try {
        const res = await axios.get(
            `https://api.render.com/v1/services/${host.api.serviceId}/metrics`,
            {
                headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` },
                timeout: HTTP_TIMEOUT_MS,
                validateStatus: () => true
            }
        );
        if (res.status >= 400 || !Array.isArray(res.data)) {
            return _unavailable('HOST_API_NO_METRICS');
        }
        return _unavailable('HOST_API_SHAPE_UNKNOWN');
    } catch (e) {
        console.warn('[infrastructure] Render metrics query failed:', e.message);
        return _unavailable('HOST_API_QUERY_FAILED');
    }
}

// ─── Env helpers ──────────────────────────────────────────────

function _budgetFromEnv() {
    const raw = process.env.INFRA_MONTHLY_BUDGET;
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function _normaliseDeploymentStatus(s) {
    const v = String(s || '').toUpperCase();
    if (['SUCCESS', 'COMPLETED', 'LIVE', 'RUNNING'].includes(v)) return 'success';
    if (['BUILDING', 'INITIALIZING', 'QUEUED', 'DEPLOYING'].includes(v)) return 'deploying';
    if (['FAILED', 'CRASHED', 'CANCELED', 'CANCELLED'].includes(v)) return 'failed';
    return 'unknown';
}

// ─── Exports ──────────────────────────────────────────────────

module.exports = {
    getHealth,
    getOverview,
    getUsage,
    getMetrics,
    getDeployment,
    refreshSnapshot,
    detectHost,
    // Exposed for tests only.
    _internal: {
        TTL,
        CRITICAL_PROVIDERS,
        _isStale,
        _normaliseDeploymentStatus,
        _normaliseProviderStatus,
        _budgetFromEnv,
        _cache
    }
};