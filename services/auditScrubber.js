// services/auditScrubber.js
// ─────────────────────────────────────────────────────────────────
// Central scrubber. Every before/after/metadata written to the
// audit log passes through scrub(); every free-text field (reason,
// admin_note, failure_message) passes through scrubText().
//
// Design:
//   • Key redaction is TOKEN-BASED, not substring regex.
//     A key like "shipping_address" or "company" or "tokens_used"
//     is NOT redacted. A key like "api_key", "apiKey", "pin",
//     "card_number", "authorization" IS redacted.
//   • Free-text redaction catches inline "authorization: Bearer xxx"
//     and "password=xxx" style leaks inside strings that could not
//     be redacted at the key level.
//   • Bounded: depth 6, 200 keys per object, 200 array items,
//     4000 chars per string.
//   • Cycle-safe: uses WeakSet.
//   • Never throws. If a value cannot be serialised (Buffer, stream,
//     exotic object), it is replaced with '[OPAQUE_OBJECT]'.
//
// This module is a pure function library — no DB, no config, no
// side effects. It can be unit-tested in isolation.
// ─────────────────────────────────────────────────────────────────

'use strict';

// ─── SENSITIVE TOKENS ────────────────────────────────────────────
//
// Exact tokens that, when found in a key, cause the value to be
// redacted. Compared after splitting the key on _ - . and camelCase.
//
// "api_key"     → ['api', 'key']        → 'key' matches? yes  → REDACT
// "apikey"      → ['apikey']            → matches             → REDACT
// "apiKey"      → ['api', 'Key']        → 'key' matches? yes  → REDACT
// "shipping"    → ['shipping']          → 'pin' is not a token → KEEP
// "company"     → ['company']           → 'pan' is not a token → KEEP
// "tokens_used" → ['tokens', 'used']    → 'tokens' matches    → REDACT
// "session_id_hint" → in SAFE_KEY_ALLOW → KEEP
const SENSITIVE_TOKENS = new Set([
    'password', 'passwd', 'pwd',
    'secret', 'secrets',
    'token', 'tokens',
    'key', 'apikey', 'api_key',
    'privatekey', 'private',
    'webhooksecret',
    'mfa', 'totp',
    'recovery',
    'authorization', 'auth', 'bearer',
    'cookie', 'cookies',
    'pin', 'pins',
    'cvv', 'cvc', 'cvn',
    'pan',
    'cardnumber', 'card',
    'iban',
    'accountnumber',
    'sortcode', 'routing',
    'signature',
    'sessionid',
    'ssn'
]);

// Explicit safe-list. Keys that would otherwise match a sensitive
// token but are safe identifiers we WANT to see in the audit log.
const SAFE_KEY_ALLOW = new Set([
    'session_id_hint',
    'sessionid_hint',
    'request_id',
    'requestid',
    'correlation_id',
    'correlationid',
    'idempotency_key',
    'idempotencykey',
    'transaction_id',
    'transactionid',
    'order_id',
    'orderid',
    'user_id',
    'userid',
    'admin_id',
    'adminid',
    'target_id',
    'targetid',
    'source_id',
    'sourceid'
]);

const MAX_STRING = 4000;
const MAX_DEPTH  = 6;
const MAX_KEYS   = 200;
const MAX_ARRAY  = 200;

// ─── Key tokenisation ────────────────────────────────────────────
//
// Split "apiKey" → ['api', 'Key']
// Split "API_KEY" → ['API', 'KEY']
// Split "shipping_address" → ['shipping', 'address']
// Split "tokens_used" → ['tokens', 'used']
//
// We lowercase each token before testing so 'KEY' and 'key' both
// match the token 'key'.
function tokeniseKey(key) {
    const s = String(key);
    // Insert a boundary before uppercase runs that follow a lower
    // or digit: "apiKey" -> "api Key", "cardNumber" -> "card Number"
    const cased = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return cased
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map(t => t.toLowerCase());
}

// Does this key look like a secret?
function isSensitiveKey(key) {
    const raw = String(key);
    if (SAFE_KEY_ALLOW.has(raw.toLowerCase())) return false;
    // Also allow anything ending in _id / _ids — those are UUIDs, not secrets.
    // (Guards against a future SAFE_KEY_ALLOW miss.)
    if (/_ids?$/.test(raw.toLowerCase())) return false;
    const tokens = tokeniseKey(raw);
    for (const t of tokens) {
        if (SENSITIVE_TOKENS.has(t)) return true;
    }
    // Exact compact forms that tokenisation splits awkwardly.
    const lower = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const t of SENSITIVE_TOKENS) {
        // Only match the compact form when the token itself is >3 chars,
        // to avoid "pan" matching "companion" style false positives.
        if (t.length > 3 && lower === t) return true;
    }
    return false;
}

// ─── Free-text scrubbing ─────────────────────────────────────────
//
// Catches leaked secrets that are embedded in strings — the case
// where someone writes before: { note: 'called provider with key
// sk_abc123' } and no key redaction can see the "key" because it's
// not a key, it's a value.

const TEXT_REDACTIONS = [
    // Authorization: Bearer xxx / authorization=bearer xxx
    [/(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi,           '$1[REDACTED]'],
    [/(authorization\s*[:=]\s*)[^\s,;"']+/gi,                    '$1[REDACTED]'],
    // API key = xxx  /  api_key=xxx  /  apiKey: xxx
    [/(api[_-]?key\s*[:=]\s*)[^\s,;&"']+/gi,                     '$1[REDACTED]'],
    // secret / password / token
    [/(\bsecret\s*[:=]\s*)[^\s,;&"']+/gi,                        '$1[REDACTED]'],
    [/(\bpassword\s*[:=]\s*)[^\s,;&"']+/gi,                      '$1[REDACTED]'],
    [/(\btoken\s*[:=]\s*)[^\s,;&"']+/gi,                         '$1[REDACTED]'],
    // card numbers in text: a run of 13-19 digits, optionally with spaces/dashes
    [/(\b\d[\d -]{11,17}\d\b)/g,                                 '[REDACTED_CARD]'],
    // Nigerian BVN/NIN: 11 digits
    [/(\b\d{11}\b)/g,                                            '[REDACTED_ID]']
];

function scrubString(s) {
    if (typeof s !== 'string') return s;
    let out = s;
    for (const [re, replacement] of TEXT_REDACTIONS) {
        out = out.replace(re, replacement);
    }
    if (out.length > MAX_STRING) {
        out = out.slice(0, MAX_STRING) + '…[truncated]';
    }
    return out;
}

// ─── Structural scrubbing ────────────────────────────────────────

function isPlainObject(v) {
    if (!v || typeof v !== 'object') return false;
    if (Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function scrub(value, depth, seen) {
    depth = depth || 0;
    seen  = seen  || new WeakSet();

    if (value === null || value === undefined) return value;

    if (depth > MAX_DEPTH) return '[MAX_DEPTH]';

    const t = typeof value;

    if (t === 'string')  return scrubString(value);
    if (t === 'number')  return value;
    if (t === 'boolean') return value;
    if (t === 'bigint')  return value.toString();
    if (t === 'function' || t === 'symbol') return '[UNSERIALIZABLE]';

    if (value instanceof Date) return value.toISOString();

    if (t === 'object') {
        if (seen.has(value)) return '[CYCLE]';
        seen.add(value);

        if (Array.isArray(value)) {
            const out = new Array(Math.min(value.length, MAX_ARRAY));
            for (let i = 0; i < out.length; i++) {
                out[i] = scrub(value[i], depth + 1, seen);
            }
            if (value.length > MAX_ARRAY) out.push('[TRUNCATED_ARRAY]');
            return out;
        }

        if (value instanceof Error) {
            return {
                name: value.name,
                message: scrubString(value.message || ''),
                code: value.code || null
            };
        }

        if (!isPlainObject(value)) {
            return '[OPAQUE_OBJECT]';
        }

        const out = {};
        const keys = Object.keys(value);
        let count = 0;
        for (const k of keys) {
            if (count >= MAX_KEYS) {
                out.__truncated__ = true;
                break;
            }
            count++;
            if (isSensitiveKey(k)) {
                out[k] = '[REDACTED]';
            } else {
                out[k] = scrub(value[k], depth + 1, seen);
            }
        }
        return out;
    }

    return value;
}

// ─── Public API ──────────────────────────────────────────────────

function scrubValue(value) {
    try { return scrub(value); }
    catch { return null; }
}

function scrubRecord(before, after) {
    return {
        before: before === undefined ? null : scrubValue(before),
        after:  after  === undefined ? null : scrubValue(after)
    };
}

function scrubText(s, max) {
    if (s === null || s === undefined) return null;
    const cleaned = scrubString(String(s)).replace(/\s+/g, ' ').trim();
    const cap = Number.isFinite(max) && max > 0 ? max : 500;
    return cleaned.slice(0, cap);
}

function safeJson(value) {
    try { return scrub(value); }
    catch { return null; }
}

module.exports = {
    scrub: scrubValue,
    scrubRecord,
    scrubText,
    scrubString,
    safeJson,
    // Exported for tests. Not part of the public contract.
    _isSensitiveKey: isSensitiveKey,
    _tokeniseKey:    tokeniseKey
};