// services/webhookService.js
// ─────────────────────────────────────────────────────────────────
// Webhook receipt + idempotent processing + admin operations.
//
// Works against the schema as deployed:
//   webhook_events.order_id          integer
//   kora_webhook_events.order_id     integer
//   provider_webhook_events.order_id text
//
// No dependency on admin_webhook_events_v or admin_webhook_stats.
// All aggregation happens in JS.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const providerFactory = require('./providers/providerFactory');
const providerMetadata = require('./providers/providerMetadata');
const orderStatus = require('./orderStatusService');
const { sanitizeProviderError } = require('./providers/providerBase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SENSITIVE_HEADER_PARTS = [
    'authorization', 'cookie', 'secret', 'api-key', 'api_key', 'apikey',
    'x-signature', 'x-hub-signature', 'x-korapay-signature',
    'x-paystack-signature', 'x-nowpayments-sig', 'x-vsms-signature',
    'x-smmwiz-signature'
];

const MAX_PAYLOAD_BYTES = 64 * 1024;
const STUCK_PROCESSING_MS = 5 * 60 * 1000;

// ─── Table routing ───────────────────────────────────────────────

function getTableName(provider) {
    const p = String(provider || '').toLowerCase();
    if (p === 'korapay') return 'kora_webhook_events';
    if (p === 'nowpayments') return 'provider_webhook_events';
    return 'webhook_events';
}

function getTableColumns(provider) {
    const p = String(provider || '').toLowerCase();
    if (p === 'korapay') {
        return {
            id: 'id',
            provider: 'provider',
            eventId: 'provider_event_ref',
            fingerprint: 'provider_event_ref',
            eventType: 'event_type',
            providerReference: 'provider_reference',
            orderId: 'order_id',
            orderIdKind: 'integer',
            payload: 'payload',
            headers: 'headers',
            signatureStatus: 'signature_status',
            legacySignatureValid: 'signature_valid',
            status: 'processing_status',
            error: 'processing_error',
            receivedAt: 'received_at',
            processedAt: 'processed_at',
            duplicateCount: 'duplicate_count',
            lastDuplicateAt: 'last_duplicate_at',
            attempts: 'attempts'
        };
    }
    if (p === 'nowpayments') {
        return {
            id: 'id',
            provider: 'provider',
            eventId: 'event_hash',
            fingerprint: 'event_hash',
            eventType: 'event_type',
            providerReference: 'payment_id',
            orderId: 'order_id',
            orderIdKind: 'text',          // <- the one deviation
            payload: 'payload',
            headers: 'headers',
            signatureStatus: 'signature_status',
            legacySignatureValid: 'signature_valid',
            status: 'processing_status',
            error: 'processing_error',
            receivedAt: 'received_at',
            processedAt: 'processed_at',
            duplicateCount: 'duplicate_count',
            lastDuplicateAt: 'last_duplicate_at',
            attempts: 'attempts'
        };
    }
    return {
        id: 'id',
        provider: 'provider',
        eventId: 'event_id',
        fingerprint: 'event_fingerprint',
        eventType: 'event_type',
        providerReference: null,
        orderId: 'order_id',
        orderIdKind: 'integer',
        payload: 'payload',
        headers: 'headers',
        signatureStatus: 'signature_status',
        legacySignatureValid: 'signature_valid',
        status: 'processing_status',
        error: 'processing_error',
        receivedAt: 'received_at',
        processedAt: 'processed_at',
        duplicateCount: 'duplicate_count',
        lastDuplicateAt: 'last_duplicate_at',
        attempts: 'attempts'
    };
}

function encodeOrderId(provider, orderId) {
    if (orderId == null) return null;
    const kind = getTableColumns(provider).orderIdKind;
    return kind === 'text' ? String(orderId) : Number(orderId);
}

function decodeOrderId(provider, raw) {
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

// ─── Helpers ─────────────────────────────────────────────────────

function sha256Hex(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

function maskHeaders(h) {
    if (!h || typeof h !== 'object') return null;
    const out = {};
    for (const k of Object.keys(h)) {
        const lk = String(k).toLowerCase();
        if (SENSITIVE_HEADER_PARTS.some(p => lk.includes(p))) out[k] = '[MASKED]';
        else {
            const v = h[k];
            out[k] = typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v;
        }
    }
    return out;
}

function capPayload(payload) {
    try {
        const raw = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
        if (Buffer.byteLength(raw, 'utf8') <= MAX_PAYLOAD_BYTES) return payload;
        return { __truncated: true, size: Buffer.byteLength(raw, 'utf8'), preview: raw.slice(0, 2048) };
    } catch {
        return { __truncated: true, error: 'unserializable payload' };
    }
}

function signatureStatusFor(provider, adapter) {
    const meta = providerMetadata.getMetadata(provider);
    if (meta && meta.supportsWebhook === false) return 'not_supported';
    if (!adapter || typeof adapter.verifyWebhook !== 'function') return 'not_supported';
    return null; // decision deferred to caller
}

// ─── Event lookup ───────────────────────────────────────────────

async function findEventById(id) {
    if (!UUID_RE.test(String(id || ''))) return null;
    const tables = [
        { table: 'webhook_events', provider: null },
        { table: 'kora_webhook_events', provider: 'korapay' },
        { table: 'provider_webhook_events', provider: 'nowpayments' }
    ];
    for (const t of tables) {
        const { data, error } = await supabaseAdmin
            .from(t.table)
            .select('*')
            .eq('id', id)
            .maybeSingle();
        if (error) continue;
        if (data) {
            const provider = t.provider || data.provider || 'general';
            return { event: data, provider, table: t.table, cols: getTableColumns(provider) };
        }
    }
    return null;
}

async function findOrder({ providerOrderId, provider }) {
    if (!providerOrderId) return null;

    const sel = 'id, order_ref, user_id, status, payment_status, fulfillment_status, refund_status, refund_reference, total_amount, currency, provider, provider_order_id, provider_reference, metadata, attempt_number, parent_order_id';

    const { data: byProviderOrder } = await supabaseAdmin
        .from('orders')
        .select(sel)
        .eq('provider', provider)
        .eq('provider_order_id', String(providerOrderId))
        .maybeSingle();
    if (byProviderOrder) return byProviderOrder;

    const { data: byRef } = await supabaseAdmin
        .from('orders')
        .select(sel)
        .eq('provider', provider)
        .eq('provider_reference', String(providerOrderId))
        .maybeSingle();
    if (byRef) return byRef;

    try {
        const { data: byExt } = await supabaseAdmin
            .from('orders')
            .select(sel)
            .eq('provider', provider)
            .eq('external_reference', String(providerOrderId))
            .maybeSingle();
        if (byExt) return byExt;
    } catch { /* column may not exist */ }

    return null;
}

// ─── Persist (idempotent) ───────────────────────────────────────

async function persistWebhook({
    provider, eventId, fingerprint, eventType,
    providerOrderId, payload, headers, signatureStatus
}) {
    const now = new Date().toISOString();
    const table = getTableName(provider);
    const cols = getTableColumns(provider);

    const row = {};
    row[cols.provider] = provider;
    row[cols.eventType] = eventType || null;
    row[cols.status] = 'received';
    row[cols.receivedAt] = now;
    row[cols.payload] = capPayload(payload || null);
    row[cols.headers] = maskHeaders(headers);
    row[cols.signatureStatus] = signatureStatus;
    row[cols.legacySignatureValid] = signatureStatus === 'valid';

    if (cols.eventId) row[cols.eventId] = eventId || null;
    if (cols.fingerprint) row[cols.fingerprint] = fingerprint || null;
    // Never set order_id here — set only after the order resolves.
    // Write the provider's own reference to its natural column.
    if (provider === 'korapay' && providerOrderId) {
        row[cols.providerReference] = String(providerOrderId);
    }
    if (provider === 'nowpayments' && providerOrderId) {
        row[cols.providerReference] = String(providerOrderId);
    }

    const { data, error } = await supabaseAdmin
        .from(table)
        .insert(row)
        .select('*')
        .maybeSingle();

    if (error) {
        if (error.code === '23505') {
            const { data: existing } = await supabaseAdmin
                .from(table)
                .select('*')
                .eq(cols.fingerprint, fingerprint)
                .maybeSingle();

            if (existing) {
                const status = existing[cols.status];
                const receivedAt = existing[cols.receivedAt];
                const ageMs = receivedAt ? (Date.now() - new Date(receivedAt).getTime()) : Infinity;
                const stuck = (status === 'received' || status === 'processing') && ageMs > STUCK_PROCESSING_MS;

                if (status === 'failed' || stuck) {
                    const patch = { [cols.status]: 'received', [cols.error]: null };
                    if (existing[cols.attempts] != null) patch[cols.attempts] = (existing[cols.attempts] || 0) + 1;
                    await supabaseAdmin.from(table).update(patch).eq(cols.id, existing.id);
                    return { duplicate: false, resumed: true, event: { ...existing, ...patch } };
                }

                const dupPatch = {
                    [cols.duplicateCount]: (existing[cols.duplicateCount] || 0) + 1,
                    [cols.lastDuplicateAt]: now
                };
                await supabaseAdmin.from(table).update(dupPatch).eq(cols.id, existing.id);
                return { duplicate: true, event: existing };
            }
            return { duplicate: true };
        }
        throw new Error(`Failed to persist webhook to ${table}: ${error.message}`);
    }
    return { duplicate: false, event: data };
}

async function markEvent(provider, id, patch) {
    const table = getTableName(provider);
    const cols = getTableColumns(provider);

    const dbPatch = {};
    if (patch.processing_status != null) dbPatch[cols.status] = patch.processing_status;
    if (patch.processing_error !== undefined) dbPatch[cols.error] = patch.processing_error;
    if (patch.order_id != null) dbPatch[cols.orderId] = encodeOrderId(provider, patch.order_id);
    if (patch.processed_at) dbPatch[cols.processedAt] = patch.processed_at;

    try {
        await supabaseAdmin.from(table).update(dbPatch).eq(cols.id, id);
    } catch (e) {
        console.warn(`[webhook] markEvent failed on ${table}:`, e.message);
    }
}

// ─── Atomic claim for reprocess ─────────────────────────────────

async function claimForReprocess(provider, id) {
    const table = getTableName(provider);
    const cols = getTableColumns(provider);
    const stuckCutoff = new Date(Date.now() - STUCK_PROCESSING_MS).toISOString();

    const { data: first, error: e1 } = await supabaseAdmin
        .from(table)
        .update({ [cols.status]: 'processing', [cols.error]: null })
        .eq(cols.id, id)
        .in(cols.status, ['failed', 'received', 'ignored'])
        .select('*')
        .maybeSingle();
    if (e1) throw new Error(`claim failed: ${e1.message}`);
    if (first) return first;

    const { data: stuck, error: e2 } = await supabaseAdmin
        .from(table)
        .update({ [cols.status]: 'processing', [cols.error]: null })
        .eq(cols.id, id)
        .eq(cols.status, 'processing')
        .lt(cols.receivedAt, stuckCutoff)
        .select('*')
        .maybeSingle();
    if (e2) throw new Error(`claim failed: ${e2.message}`);
    if (stuck) return stuck;

    const { data: current } = await supabaseAdmin
        .from(table)
        .select('*')
        .eq(cols.id, id)
        .maybeSingle();
    if (!current) {
        const e = new Error('Webhook event not found.');
        e.status = 404; e.code = 'EVENT_NOT_FOUND'; throw e;
    }
    if (current[cols.status] === 'processed') {
        const e = new Error('Already processed.');
        e.status = 409; e.code = 'ALREADY_PROCESSED'; throw e;
    }
    const e = new Error('Event is currently being processed. Try again in a few minutes.');
    e.status = 409; e.code = 'IN_PROGRESS'; throw e;
}

// ─── Pipeline ───────────────────────────────────────────────────

async function runPipeline({ event, provider, source, actorId, parsed }) {
    const cols = getTableColumns(provider);

    const providerOrderId = parsed?.providerOrderId
        || (event[cols.providerReference] ? String(event[cols.providerReference]) : null);
    const order = await findOrder({ providerOrderId, provider });

    if (!order) {
        await markEvent(provider, event.id, {
            processing_status: 'ignored',
            processing_error: 'No matching local order',
            processed_at: new Date().toISOString()
        });
        return { ok: true, outcome: 'ignored', reason: 'NO_ORDER' };
    }

    // Link order_id WITHOUT touching provider_reference.
    await supabaseAdmin
        .from(getTableName(provider))
        .update({ [cols.orderId]: encodeOrderId(provider, order.id) })
        .eq(cols.id, event.id);

    try {
        const result = await orderStatus.processProviderUpdate({
            order,
            providerStatus: parsed?.status,
            providerResponse: parsed?.raw,
            source,
            actorType: source === 'webhook' ? 'webhook' : 'admin',
            actorId: actorId || undefined
        });

        await supabaseAdmin
            .from('orders')
            .update({
                webhook_status: 'processed',
                webhook_received_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id);

        await markEvent(provider, event.id, {
            processing_status: 'processed',
            processing_error: null,
            processed_at: new Date().toISOString()
        });

        return { ok: true, outcome: 'processed', updated: !!result.updated, status: result.status };
    } catch (err) {
        const safe = sanitizeProviderError(err.message || 'Processing failed', 500);
        await supabaseAdmin
            .from('orders')
            .update({
                webhook_status: 'failed',
                webhook_received_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', order.id)
            .then(() => {}, () => {});
        await markEvent(provider, event.id, {
            processing_status: 'failed',
            processing_error: safe,
            processed_at: new Date().toISOString()
        });
        const e = new Error(safe);
        e.status = 422;
        e.code = 'PROCESSING_FAILED';
        e.safe = safe;
        throw e;
    }
}

// ─── Public: receive ────────────────────────────────────────────

async function handleWebhook({ provider: providerName, rawBody, payload, headers }) {
    const provider = String(providerName || '').toLowerCase();
    const adapter = providerFactory.get(provider);
    if (!adapter) return { ok: false, code: 'UNKNOWN_PROVIDER' };

    let signatureStatus = signatureStatusFor(provider, adapter);
    if (signatureStatus == null) {
        let verify;
        try {
            verify = await adapter.verifyWebhook({ rawBody, payload, headers });
        } catch (e) {
            verify = { ok: false, signatureValid: false, reason: e.message || 'verify_threw' };
        }
        signatureStatus = (verify.ok === false || verify.signatureValid === false) ? 'invalid' : 'valid';
    }

    const parsed = adapter.parseWebhook ? (adapter.parseWebhook(payload) || {}) : {};
    const rawForHash = typeof rawBody === 'string' ? rawBody : JSON.stringify(payload || {});
    const fingerprint = adapter.fingerprint ? adapter.fingerprint(payload) : sha256Hex(rawForHash);
    const eventId = parsed.eventId || null;

    if (signatureStatus === 'invalid') {
        try {
            await persistWebhook({
                provider, eventId, fingerprint,
                eventType: parsed.eventType || null,
                providerOrderId: parsed.providerOrderId || null,
                payload, headers, signatureStatus: 'invalid'
            });
            const table = getTableName(provider);
            const cols = getTableColumns(provider);
            await supabaseAdmin
                .from(table)
                .update({
                    [cols.status]: 'failed',
                    [cols.error]: 'INVALID_SIGNATURE',
                    [cols.processedAt]: new Date().toISOString()
                })
                .eq(cols.fingerprint, fingerprint);
        } catch (e) {
            console.error('[webhook] persist (invalid sig) failed:', e.message);
        }
        return { ok: false, code: 'INVALID_SIGNATURE' };
    }

    let persisted;
    try {
        persisted = await persistWebhook({
            provider, eventId, fingerprint,
            eventType: parsed.eventType || null,
            providerOrderId: parsed.providerOrderId || null,
            payload, headers, signatureStatus: 'valid'
        });
    } catch (e) {
        console.error('[webhook] persist failed:', e.message);
        return { ok: false, code: 'PERSIST_FAILED' };
    }
    if (persisted.duplicate && !persisted.resumed) return { ok: true, already_processed: true };

    try {
        const r = await runPipeline({ event: persisted.event, provider, source: 'webhook', parsed });
        return { ok: true, ...r };
    } catch (e) {
        return { ok: false, code: 'PROCESSING_FAILED', reason: e.safe || e.message };
    }
}

// ─── Admin: detail ──────────────────────────────────────────────

async function getEventDetail(id, { canReplay }) {
    const found = await findEventById(id);
    if (!found) {
        const e = new Error('Webhook event not found.');
        e.status = 404; e.code = 'EVENT_NOT_FOUND'; throw e;
    }
    const { event, provider, cols } = found;

    let order = null;
    const orderId = decodeOrderId(provider, event[cols.orderId]);
    if (orderId) {
        const { data } = await supabaseAdmin
            .from('orders')
            .select('id, order_ref, status, provider, provider_order_id, total_amount, currency')
            .eq('id', orderId)
            .maybeSingle();
        order = data || null;
    }

    return {
        event: {
            id: event.id,
            provider,
            event_id: event[cols.eventId] || null,
            event_type: event[cols.eventType] || null,
            event_fingerprint: event[cols.fingerprint] || null,
            provider_order_id: event[cols.providerReference] || null,
            order_id: orderId,
            signature_status: event[cols.signatureStatus]
                || (event[cols.legacySignatureValid] === true ? 'valid'
                    : event[cols.legacySignatureValid] === false ? 'invalid' : null),
            processing_status: event[cols.status] || null,
            processing_error: event[cols.error] || null,
            duplicate_count: event[cols.duplicateCount] || 0,
            last_duplicate_at: event[cols.lastDuplicateAt] || null,
            attempts: event[cols.attempts] || 0,
            received_at: event[cols.receivedAt] || null,
            processed_at: event[cols.processedAt] || null,
            headers: event[cols.headers] ? maskHeaders(event[cols.headers]) : null,
            payload: canReplay ? event[cols.payload] : null,
            payload_hidden: !canReplay
        },
        order
    };
}

// ─── Admin: reprocess / ignore ─────────────────────────────────

async function reprocessWebhook({ eventId, ctx }) {
    if (!UUID_RE.test(String(eventId || ''))) {
        const e = new Error('Invalid event id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const found = await findEventById(eventId);
    if (!found) {
        const e = new Error('Webhook event not found.');
        e.status = 404; e.code = 'EVENT_NOT_FOUND'; throw e;
    }
    const { provider, cols } = found;
    const beforeStatus = found.event[cols.status];

    const claimed = await claimForReprocess(provider, eventId);

    if (claimed[cols.signatureStatus] === 'invalid') {
        const e = new Error('Cannot reprocess a webhook whose signature was invalid.');
        e.status = 422; e.code = 'INVALID_SIGNATURE'; throw e;
    }

    const adapter = providerFactory.get(provider);
    const parsed = adapter?.parseWebhook ? (adapter.parseWebhook(claimed[cols.payload]) || {}) : {};

    const result = await runPipeline({ event: claimed, provider, source: 'admin_replay', actorId: ctx?.adminId, parsed });
    return { ...result, before_status: beforeStatus, after_status: claimed[cols.status] };
}

async function ignoreWebhook({ eventId, reason }) {
    if (!UUID_RE.test(String(eventId || ''))) {
        const e = new Error('Invalid event id.'); e.status = 400; e.code = 'INVALID_ID'; throw e;
    }
    const trimmed = String(reason || '').trim();
    if (trimmed.length < 4) {
        const e = new Error('A reason of at least 4 characters is required.');
        e.status = 422; e.code = 'REASON_REQUIRED'; throw e;
    }

    const found = await findEventById(eventId);
    if (!found) {
        const e = new Error('Webhook event not found.');
        e.status = 404; e.code = 'EVENT_NOT_FOUND'; throw e;
    }
    const { provider, table, cols, event } = found;

    if (event[cols.status] === 'processed') {
        const e = new Error('A processed webhook cannot be ignored.');
        e.status = 409; e.code = 'ALREADY_PROCESSED'; throw e;
    }

    const { data, error } = await supabaseAdmin
        .from(table)
        .update({
            [cols.status]: 'ignored',
            [cols.error]: trimmed.slice(0, 500),
            [cols.processedAt]: new Date().toISOString()
        })
        .eq(cols.id, eventId)
        .neq(cols.status, 'processed')
        .select('*')
        .maybeSingle();

    if (error || !data) {
        const e = new Error('Event could not be ignored (already processed or not found).');
        e.status = 409; e.code = 'IGNORE_CONFLICT'; throw e;
    }
    return { outcome: 'ignored', before_status: event[cols.status], after_status: 'ignored', event: data };
}

// ─── Admin: list / stats / providers ───────────────────────────

const LIST_SELECTS = {
    webhook_events:          'id, provider, event_type, event_id, order_id, processing_status, processing_error, duplicate_count, received_at, processed_at, signature_status, signature_valid',
    kora_webhook_events:     'id, provider, event_type, provider_event_ref, provider_reference, order_id, processing_status, processing_error, duplicate_count, received_at, processed_at, signature_status, signature_valid',
    provider_webhook_events: 'id, provider, event_type, event_hash, payment_id, order_id, processing_status, processing_error, duplicate_count, received_at, processed_at, signature_status, signature_valid'
};

function normalizeRow(table, r) {
    if (table === 'kora_webhook_events') {
        return {
            id: r.id, source_table: table,
            provider: r.provider || 'korapay',
            event_type: r.event_type,
            event_id: r.provider_event_ref,
            order_id: r.order_id != null ? Number(r.order_id) : null,
            provider_reference: r.provider_reference,
            signature_status: r.signature_status || (r.signature_valid === true ? 'valid' : r.signature_valid === false ? 'invalid' : null),
            processing_status: r.processing_status,
            processing_error: r.processing_error,
            duplicate_count: r.duplicate_count || 0,
            received_at: r.received_at,
            processed_at: r.processed_at
        };
    }
    if (table === 'provider_webhook_events') {
        return {
            id: r.id, source_table: table,
            provider: r.provider || 'nowpayments',
            event_type: r.event_type,
            event_id: r.event_hash,
            order_id: r.order_id != null ? Number(r.order_id) : null,
            provider_reference: r.payment_id,
            signature_status: r.signature_status || (r.signature_valid === true ? 'valid' : r.signature_valid === false ? 'invalid' : null),
            processing_status: r.processing_status,
            processing_error: r.processing_error,
            duplicate_count: r.duplicate_count || 0,
            received_at: r.received_at,
            processed_at: r.processed_at
        };
    }
    return {
        id: r.id, source_table: 'webhook_events',
        provider: r.provider || 'general',
        event_type: r.event_type,
        event_id: r.event_id,
        order_id: r.order_id != null ? Number(r.order_id) : null,
        provider_reference: null,
        signature_status: r.signature_status || (r.signature_valid === true ? 'valid' : r.signature_valid === false ? 'invalid' : null),
        processing_status: r.processing_status,
        processing_error: r.processing_error,
        duplicate_count: r.duplicate_count || 0,
        received_at: r.received_at,
        processed_at: r.processed_at
    };
}

// Fetch up to `cap` rows from one table, applying DB-side filters where
// possible. PostgREST caps at 1000; we page internally.
async function fetchTable({ table, provider, status, orderId, search, cap = 2000 }) {
    let all = [];
    let from = 0;
    const pageSize = 1000;
    while (all.length < cap) {
        let q = supabaseAdmin
            .from(table)
            .select(LIST_SELECTS[table])
            .order('received_at', { ascending: false })
            .range(from, from + pageSize - 1);

        if (provider && provider !== 'all') q = q.eq('provider', provider);
        if (status && status !== 'all' && status !== 'duplicate') q = q.eq('processing_status', status);
        if (status === 'duplicate') q = q.gt('duplicate_count', 0);
        if (orderId != null) {
            // webhook_events / kora are integer; provider is text. Both accept
            // the string form of a positive integer in an equality match.
            q = q.eq('order_id', table === 'provider_webhook_events' ? String(orderId) : orderId);
        }
        if (search) {
            const s = String(search).replace(/[,()]/g, ' ').trim();
            if (s) {
                const like = `%${s}%`;
                if (table === 'kora_webhook_events') {
                    q = q.or(`provider_reference.ilike.${like},provider_event_ref.ilike.${like},order_id::text.ilike.${like}`);
                } else if (table === 'provider_webhook_events') {
                    q = q.or(`payment_id.ilike.${like},event_hash.ilike.${like},order_id::text.ilike.${like}`);
                } else {
                    q = q.or(`event_id.ilike.${like},order_id::text.ilike.${like}`);
                }
            }
        }

        const { data, error } = await q;
        if (error) throw new Error(`list(${table}) failed: ${error.message}`);
        if (!data || data.length === 0) break;
        all = all.concat(data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return all.map(r => normalizeRow(table, r));
}

async function listEvents({ page = 1, limit = 25, provider, status, orderId, search } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));

    const tables = ['webhook_events', 'kora_webhook_events', 'provider_webhook_events'];
    const results = await Promise.all(tables.map(t =>
        fetchTable({ table: t, provider, status, orderId, search }).catch(e => {
            console.error('[webhook] fetchTable error', t, e.message);
            return [];
        })
    ));

    let all = [].concat(...results);
    all.sort((a, b) => new Date(b.received_at || 0) - new Date(a.received_at || 0));

    const total = all.length;
    const from = (safePage - 1) * safeLimit;
    const pageRows = all.slice(from, from + safeLimit);

    return {
        webhooks: pageRows,
        count: total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.max(1, Math.ceil(total / safeLimit))
    };
}

async function getStats({ provider } = {}) {
    const tables = ['webhook_events', 'kora_webhook_events', 'provider_webhook_events'];
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // One head query per status per table = 6×3 = 18 round trips if we did
    // it naively. Do it in parallel per table, but grouped: fetch one row
    // per table with count exact for each status is still N queries. Instead
    // fetch a lightweight page per table and aggregate in JS. Since we only
    // need counts (not rows), use head+count for each filter but fire them
    // in parallel.
    const filters = [
        { key: 'received',  apply: q => q.eq('processing_status', 'received') },
        { key: 'processing', apply: q => q.eq('processing_status', 'processing') },
        { key: 'processed', apply: q => q.eq('processing_status', 'processed') },
        { key: 'failed',    apply: q => q.eq('processing_status', 'failed') },
        { key: 'ignored',   apply: q => q.eq('processing_status', 'ignored') },
        { key: 'last_24h',  apply: q => q.gte('received_at', since24h) },
        { key: 'failed_24h', apply: q => q.eq('processing_status', 'failed').gte('received_at', since24h) }
    ];

    const jobs = [];
    for (const t of tables) {
        for (const f of filters) {
            let q = supabaseAdmin.from(t).select('id', { count: 'exact', head: true });
            if (provider && provider !== 'all') q = q.eq('provider', provider);
            q = f.apply(q);
            jobs.push(q.then(({ count }) => ({ table: t, key: f.key, count: count || 0 }))
                       .catch(() => ({ table: t, key: f.key, count: 0 })));
        }
    }

    const results = await Promise.all(jobs);
    const agg = {
        received: 0, processing: 0, processed: 0, failed: 0, ignored: 0,
        last_24h: 0, failed_24h: 0, duplicates: 0, total: 0
    };
    for (const r of results) {
        if (r.key === 'last_24h' || r.key === 'failed_24h') agg[r.key] += r.count;
        else { agg[r.key] = (agg[r.key] || 0) + r.count; agg.total += r.count; }
    }

    // duplicates = sum(duplicate_count). One query per table.
    await Promise.all(tables.map(async (t) => {
        try {
            let q = supabaseAdmin.from(t).select('duplicate_count').gt('duplicate_count', 0);
            if (provider && provider !== 'all') q = q.eq('provider', provider);
            const { data } = await q;
            if (Array.isArray(data)) {
                agg.duplicates += data.reduce((s, r) => s + (Number(r.duplicate_count) || 0), 0);
            }
        } catch { /* skip */ }
    }));

    // oldest unprocessed
    let oldest = null;
    await Promise.all(tables.map(async (t) => {
        try {
            let q = supabaseAdmin.from(t)
                .select('received_at')
                .in('processing_status', ['received', 'processing'])
                .order('received_at', { ascending: true })
                .limit(1);
            if (provider && provider !== 'all') q = q.eq('provider', provider);
            const { data } = await q;
            const ts = data?.[0]?.received_at;
            if (ts && (!oldest || new Date(ts) < new Date(oldest))) oldest = ts;
        } catch { /* skip */ }
    }));

    return { ...agg, oldest_unprocessed_at: oldest };
}

async function listProviders() {
    const names = providerFactory.list();
    const results = [];
    for (const name of names) {
        const meta = providerMetadata.getMetadata(name) || {};
        if (meta.supportsWebhook === false) continue;
        const adapter = providerFactory.get(name);
        const signatureMode = (adapter && typeof adapter.verifyWebhook === 'function') ? 'hmac' : 'none';

        // last_received_at + failed_24h from the correct table
        const table = getTableName(name);
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        let last_received_at = null;
        let failed_24h = 0;
        try {
            const { data } = await supabaseAdmin
                .from(table)
                .select('received_at')
                .eq('provider', name)
                .order('received_at', { ascending: false })
                .limit(1);
            last_received_at = data?.[0]?.received_at || null;
        } catch { /* skip */ }
        try {
            const { count } = await supabaseAdmin
                .from(table)
                .select('id', { count: 'exact', head: true })
                .eq('provider', name)
                .eq('processing_status', 'failed')
                .gte('received_at', since24h);
            failed_24h = count || 0;
        } catch { /* skip */ }

        results.push({
            name,
            label: adapter?.label || meta.label || name,
            enabled: !!meta.enabled,
            critical: !!meta.critical,
            signature_mode: signatureMode,
            supports_webhook: true,
            last_received_at,
            failed_24h
        });
    }
    return results;
}

// ─── Exports ────────────────────────────────────────────────────

module.exports = {
    handleWebhook,
    reprocessWebhook,
    ignoreWebhook,
    getEventDetail,
    listEvents,
    getStats,
    listProviders,
    findEventById,
    maskHeaders
};