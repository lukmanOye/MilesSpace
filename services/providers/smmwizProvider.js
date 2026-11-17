'use strict';

const crypto = require('crypto');
const axios = require('axios');
const {
    ProviderError, notSupported, withTimeout, TIMEOUTS,
    HEALTH_STRATEGY, shapeProviderError, sanitizeProviderError
} = require('./providerBase');

const NAME = 'smmwiz';
const LABEL = 'SMMWiz';
const API_URL = 'https://smmwiz.com/api/v2';

function apiKey() { return process.env.SMMWIZ_API_KEY || null; }
function isConfigured() { return Boolean(apiKey()); }

async function callApi(params, { timeoutMs = TIMEOUTS.READ } = {}) {
    if (!isConfigured()) {
        throw new ProviderError('SMMWIZ_API_KEY is not set.', { code: 'PROVIDER_NOT_CONFIGURED', category: 'CONFIGURATION', httpStatus: 503 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await axios.post(API_URL, null, {
            params: { key: apiKey(), ...params },
            signal: controller.signal,
            validateStatus: () => true,
            timeout: timeoutMs
        });
        clearTimeout(timer);
        if (res.status >= 400) {
            throw new ProviderError(`SMMWiz HTTP ${res.status}`, {
                code: `HTTP_${res.status}`,
                httpStatus: 502,
                ambiguous: res.status >= 500,
                definitive: res.status >= 400 && res.status < 500,
                providerData: res.data
            });
        }
        if (res.data && res.data.error) {
            throw new ProviderError(sanitizeProviderError(String(res.data.error), 300), {
                code: 'PROVIDER_REJECTED', category: 'VALIDATION',
                definitive: true, httpStatus: 422, providerData: res.data
            });
        }
        return res.data;
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError' || e.code === 'ERR_CANCELED') {
            throw new ProviderError('SMMWiz request timed out', { code: 'PROVIDER_TIMEOUT', category: 'TIMEOUT', ambiguous: true, httpStatus: 504 });
        }
        if (e instanceof ProviderError) throw e;
        throw new ProviderError(sanitizeProviderError(e.message || 'SMMWiz request failed', 300), { code: 'NETWORK', category: 'NETWORK', ambiguous: true, httpStatus: 502 });
    }
}

function normalizeStatus(providerStatus) {
    const s = String(providerStatus || '').toLowerCase().trim();
    if (!s) return null;
    if (s === 'pending') return 'pending';
    if (s === 'in progress' || s === 'in_progress') return 'in_progress';
    if (s === 'processing' || s === 'started') return 'processing';
    if (s === 'partial' || s === 'partially completed') return 'partial';
    if (['completed','complete','finished','done'].includes(s)) return 'completed';
    if (['canceled','cancelled'].includes(s)) return 'cancelled';
    if (s === 'failed' || s === 'error') return 'failed';
    if (s === 'refunded') return 'refunded';
    return null;
}

async function getOrderStatus(order) {
    if (!order?.provider_order_id) return { status: null, raw: null };
    const data = await callApi({ action: 'status', order: order.provider_order_id });
    return { status: String(data?.status || '').toLowerCase() || null, raw: data };
}

// ── ADDED: batch status — task 17 ──────────────────────────────
// Returns a map keyed by provider order id, e.g.
//   { "123": { status, start_count, remains, raw }, "456": {...} }
// Throws ProviderError({ code: 'BATCH_UNSUPPORTED', definitive: true })
// when the provider answers with a single-status object instead of
// a map, so callers can fall back to per-order polling.
async function getOrderStatusBatch(providerOrderIds) {
    const ids = (providerOrderIds || []).map(String).filter(Boolean);
    if (!ids.length) return {};
    if (ids.length > 100) {
        throw new ProviderError('Too many orders in one batch (max 100).', {
            code: 'BATCH_TOO_LARGE', category: 'VALIDATION', definitive: true, httpStatus: 400
        });
    }
    const data = await callApi({ action: 'status', orders: ids.join(',') }, { timeoutMs: TIMEOUTS.WRITE });
    // SMMWiz answers with { "123": {status,...}, "456": {...} } for
    // multi-order requests and with a single {status,...} object for
    // single-order. Detect the wrong shape so we can fall back.
    if (data && typeof data === 'object' && 'status' in data && !('order' in data) && !ids.every(id => id in data)) {
        throw new ProviderError('SMMWiz returned a single-order response for a batch request.', {
            code: 'BATCH_UNSUPPORTED', category: 'PROVIDER_4XX', definitive: true, httpStatus: 422
        });
    }
    const out = {};
    for (const id of ids) {
        const row = data && data[id];
        if (row && typeof row === 'object') {
            out[id] = {
                status: String(row.status || '').toLowerCase() || null,
                start_count: row.start_count ?? null,
                remains: row.remains ?? null,
                raw: row
            };
        }
    }
    return out;
}

async function createOrder({ serviceId, link, quantity }) {
    const data = await callApi({ action: 'add', service: serviceId, link, quantity });
    const providerOrderId = data?.order || data?.id;
    if (!providerOrderId) throw new ProviderError('SMMWiz did not return an order id.', { code: 'MISSING_PROVIDER_ORDER_ID', category: 'PROVIDER_4XX', ambiguous: true });
    return { providerOrderId: String(providerOrderId), raw: data };
}

async function cancelOrder() { return notSupported('SMMWIZ_CANCEL_NOT_DOCUMENTED'); }
async function refundOrder() { return notSupported('SMMWIZ_REFUND_NOT_DOCUMENTED'); }

// ── ADDED: refill — task 22 ────────────────────────────────────
// Requests a refill for a completed order. Returns { refillId, raw }.
// Propagates ProviderError on rejection so callers can map to 422.
async function refillOrder(order) {
    if (!order?.provider_order_id) {
        throw new ProviderError('Refill needs a provider order id.', {
            code: 'MISSING_PROVIDER_ORDER_ID', category: 'VALIDATION', definitive: true, httpStatus: 400
        });
    }
    const data = await callApi({ action: 'refill', order: order.provider_order_id }, { timeoutMs: TIMEOUTS.WRITE });
    const refillId = data?.refill || data?.id || null;
    return { refillId: refillId ? String(refillId) : null, raw: data };
}

async function getBalance() {
    try { return { supported: true, raw: await callApi({ action: 'balance' }) }; }
    catch (e) { return { supported: false, error: sanitizeProviderError(e.message, 200) }; }
}

function verifyWebhook({ payload, rawBody, headers }) {
    const secret = process.env.SMMWIZ_WEBHOOK_SECRET;
    if (!secret) {
        if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
            return { ok: false, signatureValid: false, reason: 'MISSING_WEBHOOK_SECRET' };
        }
        return { ok: true, signatureValid: false, reason: 'SMMWIZ_WEBHOOK_SECRET not set — dev mode, accepted unverified' };
    }
    const sig = String(headers?.['x-smmwiz-signature'] || '').trim();
    if (!sig) return { ok: false, signatureValid: false, reason: 'MISSING_SIGNATURE' };
    const body = rawBody || JSON.stringify(payload || {});
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    try {
        const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
        return { ok, signatureValid: true, reason: ok ? null : 'SIGNATURE_MISMATCH' };
    } catch {
        return { ok: false, signatureValid: false, reason: 'SIGNATURE_INVALID' };
    }
}

function parseWebhook(payload) {
    if (!payload || typeof payload !== 'object') return { providerOrderId: null, status: null, eventType: null, raw: payload };
    const providerOrderId = String(payload.order || payload.order_id || payload.orderId || payload.id || '') || null;
    const status = String(payload.status || payload.state || '').toLowerCase() || null;
    const eventType = String(payload.event || payload.event_type || payload.type || (status ? `order.${status}` : '')) || null;
    return { providerOrderId, status, eventType, raw: payload };
}

function fingerprint(payload) {
    try {
        const id = payload?.order || payload?.id;
        if (id) return `smmwiz-${id}-${payload?.status || ''}`;
        const stable = JSON.stringify(payload, Object.keys(payload || {}).sort());
        return crypto.createHash('sha256').update(stable).digest('hex');
    } catch { return null; }
}

async function healthCheck() {
    if (!isConfigured()) {
        return {
            configured: false, reachable: false, authenticated: false, functional: false,
            healthStrategy: HEALTH_STRATEGY.BALANCE,
            errorCode: 'NOT_CONFIGURED', errorCategory: 'CONFIGURATION',
            errorMessage: 'SMMWIZ_API_KEY missing'
        };
    }
    const started = Date.now();
    try {
        await withTimeout(() => callApi({ action: 'balance' }, { timeoutMs: TIMEOUTS.HEALTH }), TIMEOUTS.HEALTH, 'smmwiz.healthCheck');
        return {
            configured: true, reachable: true, authenticated: true, functional: true,
            latencyMs: Date.now() - started,
            environment: 'live',
            healthStrategy: HEALTH_STRATEGY.BALANCE
        };
    } catch (e) {
        const shaped = shapeProviderError(e);
        const authFail = shaped.httpStatus === 401 || shaped.httpStatus === 403;
        return {
            configured: true, reachable: !authFail, authenticated: !authFail, functional: false,
            latencyMs: Date.now() - started,
            environment: 'live',
            healthStrategy: HEALTH_STRATEGY.BALANCE,
            errorCode: shaped.code,
            errorCategory: shaped.category,
            errorMessage: sanitizeProviderError(shaped.message, 300)
        };
    }
}
// ── ADDED: services listing — task 8 ───────────────────────────
// Returns the raw provider services array. Same shape as
// getBalance: { supported, raw } on success, { supported: false,
// error } when the provider rejects (not configured, network).
async function listServices() {
    const data = await callApi({ action: 'services' }, { timeoutMs: TIMEOUTS.WRITE });
    const arr = Array.isArray(data) ? data : (data && data.services) || [];
    return { supported: true, services: arr };
}

module.exports = {
    name: NAME, label: LABEL, isConfigured, healthCheck,
    healthStrategy: HEALTH_STRATEGY.BALANCE,
    listServices,
    getOrderStatus,
    getOrderStatusBatch,   // ── ADDED ──
    createOrder,
    cancelOrder,
    refundOrder,
    refillOrder,           // ── ADDED ──
    getBalance,
    verifyWebhook, parseWebhook, normalizeStatus, fingerprint
};