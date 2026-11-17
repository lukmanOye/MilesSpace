// services/vsmsProvider.js
// ─────────────────────────────────────────────────────────────────────────────
// THE Virtual SMS provider module. Every VSMS provider call in the entire
// system goes through this file:
//   • routes/virtual-router.js
//   • services/vsmsOrderService.js
//   • services/vsmsWorker.js
//   • services/vsmsAdminService.js
//
// Guarantees:
//   • Rate limit: shared token bucket, 5 req/s, no per-instance serialisation
//   • Timeout: provider_virtualsms_timeout_ms (default 15000ms), via AbortController
//   • Logging: every call writes to virtual_sms_provider_logs (redacted)
//   • Parsing: JSON or SMS-Activate plain text; unknown → AMBIGUOUS
//   • No retries on non-idempotent actions (getNumber, setStatus)
//   • Retries on read-only actions (getStatus, getCountries, getPrices, getBalance)
//   • User-Agent: MilesSpace/1.0
//   • API key never logged
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const adminSettings = require('./adminSettingsService');
const { allowRequest, recordSuccess, recordFailure } = require('./providers/circuitBreaker');

const BASE_URL = 'https://api.virtualsms.de/stubs/handler_api';
const DEFAULT_TIMEOUT_MS = 15000;

// ─── Rate limiter (token bucket, shared process-wide) ─────────────────────
class TokenBucket {
    constructor(ratePerSec, capacity) {
        this.rate = ratePerSec / 1000;   // tokens/ms
        this.capacity = capacity;
        this.tokens = capacity;
        this.lastRefill = Date.now();
        this.queue = [];
        this.running = false;
    }
    _refill() {
        const now = Date.now();
        this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.rate);
        this.lastRefill = now;
    }
    acquire() {
        return new Promise(resolve => {
            this.queue.push(resolve);
            this._drain();
        });
    }
    _drain() {
        if (this.running) return;
        this.running = true;
        const pump = () => {
            this._refill();
            while (this.queue.length > 0 && this.tokens >= 1) {
                this.tokens -= 1;
                this.queue.shift()();
            }
            if (this.queue.length > 0) {
                setTimeout(pump, 30);
            } else {
                this.running = false;
            }
        };
        pump();
    }
}
const limiter = new TokenBucket(5, 5);

// ─── Helpers ──────────────────────────────────────────────────────────────
function apiKey() { return process.env.VSMS_API_KEY || ''; }

function maskValue(v) {
    if (v == null) return v;
    const s = String(v);
    if (s.length <= 4) return '•••';
    return '•••' + s.slice(-4);
}

function maskPhone(p) {
    if (!p) return p;
    const s = String(p);
    if (s.length <= 4) return s;
    return '•••' + s.slice(-4);
}

function redactForLog(obj) {
    if (obj == null) return obj;
    if (typeof obj === 'string') {
        // Redact API key if present
        const k = apiKey();
        return k ? obj.replace(new RegExp(k, 'g'), '[REDACTED]') : obj;
    }
    if (typeof obj !== 'object') return obj;
    let copy;
    try { copy = JSON.parse(JSON.stringify(obj)); } catch { return null; }
    const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 5) return;
        for (const k of Object.keys(o)) {
            const lk = String(k).toLowerCase();
            if (['api_key','apikey','key','token','authorization','secret','phone','phone_number','number'].includes(lk)) {
                o[k] = maskValue(o[k]);
            } else if (typeof o[k] === 'object') {
                walk(o[k], depth + 1);
            }
        }
    };
    walk(copy, 0);
    return copy;
}

async function getTimeoutMs() {
    try {
        const v = await adminSettings.getRaw('provider_virtualsms_timeout_ms');
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n >= 1000 && n <= 120000) return n;
    } catch { /* fall through */ }
    return DEFAULT_TIMEOUT_MS;
}

async function recordProviderLog({
    orderId, action, endpointName,
    requestPayload, responsePayload, responseStatus,
    success, errorCode, errorMessage, durationMs, classification
}) {
    try {
        const payload = {
            order_id:       orderId || null,
            provider:       'virtualsms',
            action:         action || null,
            endpoint_name:  endpointName || action || null,
            request_payload:  requestPayload  ? redactForLog(requestPayload)  : null,
            response_payload: responsePayload ? redactForLog(responsePayload) : null,
            response_status:  responseStatus  ?? null,
            success:          !!success,
            error_code:       errorCode || null,
            error_message:    errorMessage ? String(errorMessage).slice(0, 500) : null,
            duration_ms:      durationMs ?? null
        };
        // Attach classification metadata alongside (in the jsonb column,
        // not a separate field — schema doesn't have a `classification`
        // column so we tuck it in the response payload object).
        if (classification) {
            payload.response_payload = payload.response_payload && typeof payload.response_payload === 'object'
                ? { ...payload.response_payload, _classification: classification }
                : { _classification: classification, raw: payload.response_payload || null };
        }
        await supabaseAdmin.from('virtual_sms_provider_logs').insert(payload);
    } catch (e) {
        if (!String(e.message || '').includes('42P01')) {
            console.warn('[VSMS PROVIDER] provider-log insert failed:', e.message);
        }
    }
}

// ─── Response parser ──────────────────────────────────────────────────────
// Accepts raw text OR a parsed object. Returns a normalised object with
// a `kind` field. The `kind` values are:
//   NUMBER_ASSIGNED       — activation id + phone returned
//   STATUS_OK             — code received (for getStatus)
//   STATUS_WAIT_CODE      — waiting
//   STATUS_WAIT_RETRY     — asked to resend
//   STATUS_CANCEL         — provider cancelled the activation
//   ACCESS_CANCEL         — cancel confirmed
//   ACCESS_ACTIVATION     — setStatus 6 confirmed
//   ACCESS_RETRY          — setStatus 3 confirmed
//   BALANCE               — balance returned
//   EARLY_CANCEL_DENIED   — provider refuses cancel (minimum hold)
//   DEFINITE_FAILURE      — a specific refusal code (NO_NUMBERS etc.)
//   UNKNOWN               — anything we can't classify (AMBIGUOUS)
//
// NEVER throws. NEVER classifies an unknown reply as success.
function parse(raw) {
    // Object case (JSON response from provider).
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const obj = raw;
        // getNumberV2 with activation
        const activationId = String(obj.activationId || obj.activation_id || obj.id || '');
        const phoneNumber  = String(obj.phoneNumber  || obj.phone_number  || obj.phone || '');
        if (activationId && phoneNumber) {
            return { kind: 'NUMBER_ASSIGNED', activationId, phoneNumber, cost: obj.cost || obj.activationCost || null, raw: obj };
        }
        // getStatusV2 with status
        const status = String(obj.status || '').toUpperCase();
        if (status === 'STATUS_OK') {
            return { kind: 'STATUS_OK', smsCode: String(obj.code || obj.smsCode || ''), smsText: obj.text || obj.smsText || null, raw: obj };
        }
        if (status === 'STATUS_WAIT_CODE') return { kind: 'STATUS_WAIT_CODE', raw: obj };
        if (status === 'STATUS_WAIT_RETRY') return { kind: 'STATUS_WAIT_RETRY', code: obj.code || null, raw: obj };
        if (status === 'STATUS_CANCEL') return { kind: 'STATUS_CANCEL', raw: obj };
        if (status === 'ACCESS_CANCEL') return { kind: 'ACCESS_CANCEL', raw: obj };
        if (status === 'ACCESS_ACTIVATION') return { kind: 'ACCESS_ACTIVATION', raw: obj };
        if (status === 'ACCESS_RETRY') return { kind: 'ACCESS_RETRY', raw: obj };
        // getBalance
        if (obj.balance != null) return { kind: 'BALANCE', balance: Number(obj.balance) || 0, raw: obj };
        // Explicit failure codes as fields
        const code = String(obj.error || obj.code || '').toUpperCase();
        if (code) {
            const cls = classifyDefiniteFailure(code);
            if (cls) return { kind: 'DEFINITE_FAILURE', code, message: cls.message, raw: obj };
        }
        return { kind: 'UNKNOWN', raw: obj };
    }

    // String / plain-text case (SMS-Activate style).
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return { kind: 'UNKNOWN', raw: s };

    // ACCESS_NUMBER:<id>:<phone>
    const accessNumber = /^ACCESS_NUMBER:([^:]+):(.+)$/.exec(s);
    if (accessNumber) {
        return { kind: 'NUMBER_ASSIGNED', activationId: accessNumber[1], phoneNumber: accessNumber[2], raw: s };
    }

    // STATUS_OK:<code>  or  STATUS_OK:<code>:<text>
    const statusOk = /^STATUS_OK:([^:]+)(?::(.+))?$/.exec(s);
    if (statusOk) {
        return { kind: 'STATUS_OK', smsCode: statusOk[1], smsText: statusOk[2] || null, raw: s };
    }

    // STATUS_WAIT_CODE  /  STATUS_WAIT_RETRY:<code>  /  STATUS_CANCEL
    if (s === 'STATUS_WAIT_CODE') return { kind: 'STATUS_WAIT_CODE', raw: s };
    const waitRetry = /^STATUS_WAIT_RETRY(?::(.+))?$/.exec(s);
    if (waitRetry) return { kind: 'STATUS_WAIT_RETRY', code: waitRetry[1] || null, raw: s };
    if (s === 'STATUS_CANCEL') return { kind: 'STATUS_CANCEL', raw: s };

    // ACCESS_CANCEL  /  ACCESS_ACTIVATION  /  ACCESS_RETRY
    if (s === 'ACCESS_CANCEL') return { kind: 'ACCESS_CANCEL', raw: s };
    if (s === 'ACCESS_ACTIVATION') return { kind: 'ACCESS_ACTIVATION', raw: s };
    if (s === 'ACCESS_RETRY') return { kind: 'ACCESS_RETRY', raw: s };
    if (s === 'EARLY_CANCEL_DENIED') return { kind: 'EARLY_CANCEL_DENIED', raw: s };

    // BALANCE:<amount>  or  ACCESS_BALANCE:<amount>
    const bal = /^(?:ACCESS_)?BALANCE:([0-9.]+)$/.exec(s);
    if (bal) return { kind: 'BALANCE', balance: Number(bal[1]) || 0, raw: s };

    // Definite failure codes.
    const cls = classifyDefiniteFailure(s);
    if (cls) return { kind: 'DEFINITE_FAILURE', code: s, message: cls.message, raw: s };

    return { kind: 'UNKNOWN', raw: s };
}

function classifyDefiniteFailure(code) {
    const map = {
        NO_NUMBERS:              { message: 'No numbers available for this service.' },
        NO_BALANCE:              { message: 'Provider is out of balance.' },
        BAD_KEY:                 { message: 'Provider rejected the API key.' },
        BAD_ACTION:              { message: 'Invalid provider action.' },
        BAD_SERVICE:             { message: 'Service is not available from the provider.' },
        WRONG_SERVICE:           { message: 'Service is not available for this country.' },
        WRONG_COUNTRY:           { message: 'Country is not supported.' },
        WRONG_MAX_PRICE:         { message: 'Provider price changed.' },
        BANNED:                  { message: 'Service is banned for this account.' },
        NO_ACTIVATION:           { message: 'Provider does not recognize the activation.' },
        BAD_STATUS:              { message: 'Invalid status code.' },
        INSUFFICIENT_BALANCE:    { message: 'Provider balance is insufficient.' },
        SMS_ALREADY_SENT:        { message: 'SMS already sent.' },
        NO_ACTIVATION_ID:        { message: 'Missing activation id.' }
    };
    return map[String(code || '').trim().toUpperCase()] || null;
}

// ─── Core fetch ───────────────────────────────────────────────────────────
// opts.retry — true means retry on timeout / 5xx (only for read-only actions)
async function call({ action, params, orderId, retry }) {
    const key = apiKey();
    if (!key) {
        const err = new Error('VSMS_API_KEY is not configured.');
        err.code = 'PROVIDER_NOT_CONFIGURED';
        err.status = 503;
        throw err;
    }

    // Circuit breaker check.
    if (!allowRequest('virtualsms')) {
        const err = new Error('Provider circuit breaker is open.');
        err.code = 'PROVIDER_CIRCUIT_OPEN';
        err.status = 503;
        await recordProviderLog({
            orderId, action, endpointName: action,
            success: false, errorCode: 'CIRCUIT_OPEN',
            errorMessage: 'Circuit breaker is open',
            durationMs: 0
        });
        throw err;
    }

    const url = new URL(BASE_URL);
    url.searchParams.append('api_key', key);
    for (const [k, v] of Object.entries(params || {})) {
        if (v === undefined || v === null) continue;
        url.searchParams.append(k, String(v));
    }

    const timeoutMs = await getTimeoutMs();
    const started = Date.now();
    const maxAttempts = retry ? 3 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Rate limiter (per attempt, since we go over the wire each time).
        await limiter.acquire();

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url.toString(), {
                signal: controller.signal,
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'User-Agent': 'MilesSpace/1.0'
                }
            });
            clearTimeout(timeout);
            const durationMs = Date.now() - started;

            let text;
            try { text = await response.text(); } catch { text = ''; }

            // Parse body — JSON or plain text.
            let body;
            try { body = JSON.parse(text); } catch { body = text; }

            if (!response.ok) {
                const err = new Error(`Provider HTTP ${response.status}`);
                err.code = response.status === 401 || response.status === 403
                    ? 'PROVIDER_AUTH_ERROR'
                    : `HTTP_${response.status}`;
                err.providerStatus = response.status;
                err.providerBody = body;
                err.durationMs = durationMs;
                err.ambiguous = response.status >= 500;
                err.definitive = response.status >= 400 && response.status < 500;

                await recordProviderLog({
                    orderId, action, endpointName: action,
                    requestPayload: params, responsePayload: body,
                    responseStatus: response.status,
                    success: false, errorCode: err.code,
                    errorMessage: err.message, durationMs,
                    classification: response.status >= 500 ? 'AMBIGUOUS' : 'DEFINITE_FAILURE'
                });

                // Retry only on 5xx for read-only.
                if (retry && response.status >= 500 && attempt < maxAttempts) {
                    lastError = err;
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                    continue;
                }

                // 5xx without retry → ambiguous. Record failure against breaker.
                if (response.status >= 500) {
                    recordFailure('virtualsms');
                } else if (response.status === 401 || response.status === 403) {
                    recordFailure('virtualsms');
                }

                throw err;
            }

            // Successful HTTP. Parse.
            const parsed = parse(body);

            await recordProviderLog({
                orderId, action, endpointName: action,
                requestPayload: params, responsePayload: body,
                responseStatus: response.status,
                success: true,
                durationMs,
                classification: parsed.kind
            });

            recordSuccess('virtualsms');

            return { parsed, body, durationMs, status: response.status };
        } catch (e) {
            clearTimeout(timeout);
            const durationMs = Date.now() - started;

            if (e.name === 'AbortError') {
                const err = new Error('Provider request timed out.');
                err.code = 'PROVIDER_TIMEOUT';
                err.ambiguous = true;
                err.durationMs = durationMs;

                await recordProviderLog({
                    orderId, action, endpointName: action,
                    requestPayload: params,
                    success: false, errorCode: 'PROVIDER_TIMEOUT',
                    errorMessage: `Timed out after ${timeoutMs}ms`,
                    durationMs,
                    classification: 'AMBIGUOUS'
                });

                if (retry && attempt < maxAttempts) {
                    lastError = err;
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                    continue;
                }
                recordFailure('virtualsms');
                throw err;
            }

            if (e.providerStatus || e.code === 'PROVIDER_TIMEOUT') {
                if (retry && attempt < maxAttempts && (e.ambiguous || e.providerStatus >= 500)) {
                    lastError = e;
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                    continue;
                }
                throw e;
            }

            // Network / unknown.
            const err = new Error(e.message || 'Provider request failed.');
            err.code = 'PROVIDER_NETWORK';
            err.ambiguous = true;
            err.durationMs = durationMs;

            await recordProviderLog({
                orderId, action, endpointName: action,
                requestPayload: params,
                success: false, errorCode: 'PROVIDER_NETWORK',
                errorMessage: err.message, durationMs,
                classification: 'AMBIGUOUS'
            });

            if (retry && attempt < maxAttempts) {
                lastError = err;
                await new Promise(r => setTimeout(r, 1000 * attempt));
                continue;
            }
            recordFailure('virtualsms');
            throw err;
        }
    }

    throw lastError || new Error('Provider request failed after retries.');
}

// ─── Public API ───────────────────────────────────────────────────────────

// getNumber — NON-IDEMPOTENT. NEVER retries.
async function getNumber({ service, country, orderId }) {
    try {
        const { parsed, body } = await call({
            action: 'getNumberV2',
            params: { service, country, orderId },
            orderId,
            retry: false
        });
        if (parsed.kind === 'NUMBER_ASSIGNED') {
            return {
                kind: 'NUMBER_ASSIGNED',
                activationId: parsed.activationId,
                phoneNumber:  parsed.phoneNumber,
                cost:         parsed.cost,
                raw:          body
            };
        }
        if (parsed.kind === 'DEFINITE_FAILURE') {
            return {
                kind: 'DEFINITE_FAILURE',
                code: parsed.code,
                message: parsed.message,
                raw: body
            };
        }
        // Anything else is AMBIGUOUS — do not treat as success, do not
        // trigger an instant refund.
        return {
            kind: 'AMBIGUOUS',
            reason: `Unexpected provider response (${parsed.kind})`,
            raw: body
        };
    } catch (e) {
        // Timeouts and network errors are AMBIGUOUS — the number might
        // actually have been purchased at the provider.
        if (e.code === 'PROVIDER_TIMEOUT' || e.ambiguous) {
            return { kind: 'AMBIGUOUS', reason: e.message, raw: null };
        }
        throw e;
    }
}

// getStatus — read-only, retries on 5xx.
async function getStatus({ activationId, orderId }) {
    try {
        const { parsed, body } = await call({
            action: 'getStatusV2',
            params: { id: activationId },
            orderId,
            retry: true
        });
        return {
            kind:     parsed.kind,
            smsCode:  parsed.smsCode,
            smsText:  parsed.smsText,
            raw:      body
        };
    } catch (e) {
        return { kind: 'UNKNOWN', raw: null, error: e.message };
    }
}

// setStatus — NON-IDEMPOTENT. NEVER retries.
// status: 6 (complete) | 3 (resend) | 8 (cancel)
async function setStatus({ activationId, status, orderId }) {
    const { parsed, body } = await call({
        action: 'setStatus',
        params: { id: activationId, status },
        orderId,
        retry: false
    });
    return { kind: parsed.kind, raw: body };
}

// getBalance — read-only.
async function getBalance() {
    try {
        const { parsed, body } = await call({
            action: 'getBalance',
            params: {},
            orderId: null,
            retry: true
        });
        return { kind: parsed.kind, balance: parsed.balance, raw: body };
    } catch (e) {
        return { kind: 'UNKNOWN', balance: null, raw: null, error: e.message };
    }
}

// getCountries — read-only.
async function getCountries() {
    const { body } = await call({
        action: 'getCountries',
        params: {},
        orderId: null,
        retry: true
    });
    return body;
}

// getServicesList — read-only.
async function getServicesList(countryId) {
    const { body } = await call({
        action: 'getServicesList',
        params: { country: countryId },
        orderId: null,
        retry: true
    });
    return body;
}

// getPrices — read-only.
async function getPrices(countryId) {
    const { body } = await call({
        action: 'getPrices',
        params: { country: countryId },
        orderId: null,
        retry: true
    });
    return body;
}

module.exports = {
    // Core
    parse,
    getNumber,
    getStatus,
    setStatus,
    getBalance,
    getCountries,
    getServicesList,
    getPrices,

    // Diagnostics
    maskPhone
};