// routes/admin/airtimeAdminRoutes.js
// Airtime & Data admin API.
//
// Batch 7 changes (2026-11-08):
//   • GET /airtime/orders/export.csv is declared BEFORE
//     GET /airtime/orders/:id (fixes INVALID_ID when id='export.csv').
//   • CSV export includes the new wallet/payment columns:
//     wallet_type, payment_amount, payment_currency, send_amount_usd,
//     fee_usd, fee_percent, fx_usd_ngn, ledger_transaction_id,
//     provider_transaction_id, refund_reference. All existing columns
//     stay first and in the same order.
//
// Batch 5 + fixes (unchanged):
//   • All permission gates use PERMISSIONS.* constants from
//     middleware/adminAuth.js.
//   • Every handler goes through sendErr / handleException so
//     server-side Supabase 401s never leak as auth errors.
//   • serviceCtx() bridges req.adminContext → the shape
//     airtimeService expects (adminId, adminEmail, ip, ...).
//   • GET /airtime/config, /airtime/providers/:provider/balance,
//     /airtime/providers (live adapter healthCheck).
//   • Routing PUT rejects vtpass for non-NGA (INVALID_PROVIDER).
'use strict';

const express = require('express');
const router  = express.Router();

const {
    requirePermission,
    PERMISSIONS
} = require('../../middleware/adminAuth');

const airtimeService = require('../../services/airtimeService');
const airtimePricing = require('../../services/airtimePricing');
const adminSettings  = require('../../services/adminSettingsService');
const dtoneAdapter   = require('../../services/airtimeProviders/dtoneAdapter');
const vtpassAdapter  = require('../../services/airtimeProviders/vtpassAdapter');

// ═══════════════════════════════════════════════════════════════
//  PERMISSION RESOLUTION
//
//  Pick the first permission that actually exists in the registry.
//  This prevents `requirePermission(undefined)` (which the
//  middleware interprets as "no check" and then the profile lookup
//  still runs — but a missing sid/authContext surfaces as a 401).
// ═══════════════════════════════════════════════════════════════
function firstDefined(...candidates) {
    for (const c of candidates) {
        if (typeof c === 'string' && c) return c;
    }
    return null;
}

const P_SETTINGS_READ     = firstDefined(PERMISSIONS.SETTINGS_READ,     PERMISSIONS.SETTINGS_MANAGE);
const P_SETTINGS_MANAGE   = firstDefined(PERMISSIONS.SETTINGS_MANAGE,   PERMISSIONS.SETTINGS_READ);
const P_PROVIDERS_READ    = firstDefined(PERMISSIONS.PROVIDERS_READ,    PERMISSIONS.PROVIDERS_MANAGE, PERMISSIONS.SETTINGS_READ);
const P_PROVIDERS_MANAGE  = firstDefined(PERMISSIONS.PROVIDERS_MANAGE,  PERMISSIONS.SETTINGS_MANAGE);
const P_ORDERS_READ       = firstDefined(PERMISSIONS.ORDERS_READ);
const P_ORDERS_MANAGE     = firstDefined(PERMISSIONS.ORDERS_MANAGE,     PERMISSIONS.ORDERS_RESOLVE, PERMISSIONS.ORDERS_READ);

// If the registry is somehow missing even ORDERS_READ, fail the
// whole module loudly at boot — never silently accept every caller.
if (!P_ORDERS_READ) {
    throw new Error(
        '[AIRTIME ADMIN] PERMISSIONS.ORDERS_READ is not exported by ' +
        'middleware/adminAuth.js. Cannot boot airtime admin routes.'
    );
}

// ═══════════════════════════════════════════════════════════════
//  SAFE_MESSAGES
// ═══════════════════════════════════════════════════════════════
const SAFE_MESSAGES = {
    INVALID_ID:               'Invalid order identifier.',
    AO_NOT_FOUND:             'Order not found.',
    REASON_REQUIRED:          'A reason of at least 4 characters is required.',
    ALREADY_COMPLETED:        'This order is already completed.',
    IN_REFUND_STATE:          'This order is already in a refund state.',
    ALREADY_REFUNDED:         'This order has already been refunded.',
    NOT_REFUNDABLE:           'Only failed orders can be refunded.',
    NO_TRANSACTION:           'This order has no wallet transaction to refund.',
    TX_NOT_FOUND:             'The original wallet transaction was not found.',
    TX_NOT_REFUNDABLE:        'The original wallet transaction is not in a refundable state.',
    LEDGER_REFUND_FAILED:     'Wallet refund failed. Please try again or contact support.',
    INVALID_STATUS_TRANSITION:'This status change is not allowed for the current order state.',
    UNKNOWN_PROVIDER:         'Unknown provider on this order.',
    UNKNOWN_PROVIDER_NAME:    'Unknown provider.',
    AUDIT_WRITE_FAILED:       'Audit logging failed. The action was aborted for safety.',
    INVALID_COUNTRY:          'Invalid country code.',
    INVALID_PROVIDER:         'Invalid provider.',
    INVALID_SCOPE:            'Invalid scope. Must be all, local, or global.',
    CONFIGURATION_CHANGED:    'The configuration changed while you were editing it. Reload and try again.',
    ROUTE_EXISTS:             'A route for this country/network already exists.',
    ROUTING_READ_FAILED:      'Failed to load routing configuration.',
    ROUTING_WRITE_FAILED:     'Failed to save routing configuration.',
    SERVICE_DISABLED:         'This service is currently unavailable.',
    USE_LOCAL_AIRTIME:        'Use Local Airtime for Nigeria.',
    INVALID_AMOUNT:           'Invalid amount.',
    INVALID_NETWORK:          'Invalid network.',
    NETWORK_REQUIRED:         'Country and network are required.',
    UNKNOWN_ACTION:           'Unknown action.',
    INVALID_BODY:             'Invalid request body.',
    LIST_FAILED:              'Failed to load airtime orders.',
    OVERVIEW_FAILED:          'Failed to load the airtime overview.'
};

// ═══════════════════════════════════════════════════════════════
//  RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════
function sendOk(res, data) {
    return res.json({ success: true, data });
}

function sendErr(res, status, code, message) {
    const safeMsg = SAFE_MESSAGES[code] || message || 'Request failed.';
    const requestId = res.locals?.requestId || null;
    return res.status(status).json({
        success: false,
        code,
        error: safeMsg,
        ...(requestId ? { request_id: requestId } : {})
    });
}

function handleException(res, err, fallbackCode, fallbackStatus = 500) {
    // Supabase Postgres errors sometimes carry .status = 401 when the
    // server-side role lacks privileges. That is a server error, NOT
    // an auth error. Never let it reach the client as 401/403.
    const incoming = Number(err?.status) || 0;
    const safeStatus = (incoming >= 400 && incoming < 500 && incoming !== 401 && incoming !== 403)
        ? incoming
        : fallbackStatus;

    const code = err?.code || fallbackCode;
    console.error(`[AIRTIME ADMIN] ${code} (was ${incoming}):`, err?.message || err);
    return sendErr(res, safeStatus, code, err?.message);
}

// ═══════════════════════════════════════════════════════════════
//  SERVICE CONTEXT
//
//  airtimeService.recordAudit() reads ctx.adminId / ctx.adminEmail,
//  while req.adminContext uses .id / .email. This helper bridges
//  the two so audit rows carry the right actor id.
// ═══════════════════════════════════════════════════════════════
function serviceCtx(req) {
    const ac = req.adminContext || {};
    return {
        adminId:     ac.id || ac.adminId || null,
        adminEmail:  ac.email || ac.adminEmail || null,
        ip:          ac.ip || req.ip || null,
        userAgent:   ac.userAgent || req.get('user-agent') || null,
        requestId:   ac.requestId || req.id || null,
        permissions: req.adminPermissions || ac.permissions || {}
    };
}

// ═══════════════════════════════════════════════════════════════
//  LIST ORDERS
// ═══════════════════════════════════════════════════════════════
router.get('/airtime/orders', requirePermission(P_ORDERS_READ), async (req, res) => {
    try {
        const result = await airtimeService.listOrders(req.query);
        return sendOk(res, result);
    } catch (e) {
        return handleException(res, e, 'LIST_FAILED');
    }
});

// ═══════════════════════════════════════════════════════════════
//  OVERVIEW
// ═══════════════════════════════════════════════════════════════
router.get('/airtime/overview', requirePermission(P_ORDERS_READ), async (req, res) => {
    try {
        const overview = await airtimeService.getOverview(req.query);
        return sendOk(res, { overview });
    } catch (e) {
        return handleException(res, e, 'OVERVIEW_FAILED');
    }
});

// ═══════════════════════════════════════════════════════════════
//  CSV EXPORT — MUST be declared BEFORE '/airtime/orders/:id'
//  so Express does not treat 'export.csv' as an order ID.
// ═══════════════════════════════════════════════════════════════
router.get('/airtime/orders/export.csv', requirePermission(P_ORDERS_READ), async (req, res) => {
    try {
        const result = await airtimeService.listOrders({
            ...req.query,
            page: 1,
            limit: 10000
        });
        const rows = result.orders || [];

        const header = [
            // existing columns — SAME ORDER
            'created_at', 'scope', 'provider', 'order_ref', 'status',
            'country', 'network', 'phone_masked',
            'amount', 'currency', 'customer_total_ngn',
            'provider_cost_ngn', 'margin_ngn',
            'failure_code', 'failure_reason', 'refunded',
            // appended columns (additive — never reorder above)
            'wallet_type', 'payment_amount', 'payment_currency',
            'send_amount_usd', 'fee_usd', 'fee_percent', 'fx_usd_ngn',
            'ledger_transaction_id', 'provider_transaction_id',
            'refund_reference'
        ];
        const csv = [header.join(',')];

        for (const r of rows) {
            const cells = [
                r.created_at || '',
                r.scope || '',
                r.provider || '',
                r.order_ref || '',
                r.status || '',
                r.country_iso3 || '',
                r.network_name || r.network_code || '',
                r.phone_masked || '',
                r.amount ?? '',
                r.currency || '',
                r.customer_price_ngn ?? '',
                r.provider_cost_ngn ?? '',
                r.margin_ngn ?? '',
                r.failure_code || '',
                (r.failure_reason || '').replace(/[,"\n]/g, ' '),
                r.refunded ? 'yes' : 'no',
                // appended cells
                r.wallet_type || '',
                r.payment_amount ?? '',
                r.payment_currency || '',
                r.send_amount_usd ?? '',
                r.fee_usd ?? '',
                r.fee_percent ?? '',
                r.fx_usd_ngn ?? r.fx_rate ?? '',
                r.transaction_id || '',
                r.provider_transaction_id || '',
                r.refund_reference || ''
            ].map(v => {
                const s = String(v == null ? '' : v);
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            });
            csv.push(cells.join(','));
        }

        const filename = `airtime-orders-${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(csv.join('\n'));
    } catch (e) {
        return handleException(res, e, 'LIST_FAILED');
    }
});

// ═══════════════════════════════════════════════════════════════
//  ORDER DETAIL — AFTER export.csv
// ═══════════════════════════════════════════════════════════════
router.get('/airtime/orders/:id', requirePermission(P_ORDERS_READ), async (req, res) => {
    try {
        const payload = await airtimeService.getOrder(req.params.id);
        return sendOk(res, payload);
    } catch (e) {
        return handleException(res, e, 'AO_NOT_FOUND', 404);
    }
});

// ═══════════════════════════════════════════════════════════════
//  ACTIONS
// ═══════════════════════════════════════════════════════════════
router.post('/airtime/orders/:id/sync', requirePermission(P_ORDERS_MANAGE), async (req, res) => {
    try {
        const result = await airtimeService.syncOrder({
            orderId: req.params.id,
            ctx: serviceCtx(req)
        });
        return sendOk(res, result);
    } catch (e) { return handleException(res, e, 'LIST_FAILED'); }
});

router.post('/airtime/orders/:id/retry', requirePermission(P_ORDERS_MANAGE), async (req, res) => {
    try {
        const result = await airtimeService.retryOrder({
            orderId: req.params.id,
            ctx: serviceCtx(req),
            reason: req.body?.reason
        });
        return sendOk(res, result);
    } catch (e) { return handleException(res, e, 'LIST_FAILED'); }
});

router.post('/airtime/orders/:id/refund', requirePermission(P_ORDERS_MANAGE), async (req, res) => {
    try {
        const result = await airtimeService.refundOrder({
            orderId: req.params.id,
            ctx: serviceCtx(req),
            reason: req.body?.reason
        });
        return sendOk(res, result);
    } catch (e) { return handleException(res, e, 'LEDGER_REFUND_FAILED', 400); }
});

router.post('/airtime/orders/:id/review', requirePermission(P_ORDERS_MANAGE), async (req, res) => {
    try {
        const result = await airtimeService.reviewOrder({
            orderId: req.params.id,
            ctx: serviceCtx(req),
            reason: req.body?.reason
        });
        return sendOk(res, result);
    } catch (e) { return handleException(res, e, 'INVALID_STATUS_TRANSITION', 422); }
});

// ═══════════════════════════════════════════════════════════════
//  PROVIDERS — list + per-provider balance + health check
// ═══════════════════════════════════════════════════════════════
router.get('/airtime/providers', requirePermission(P_PROVIDERS_READ), async (req, res) => {
    try {
        // 1. Try the cached DB row first (fast path).
        const dbHealth = await airtimeService.getProviderHealth();

        // 2. Live-fetch each adapter so we never show "unknown".
        const providers = {};
        for (const [key, adapter] of Object.entries({
            dtone: dtoneAdapter,
            vtpass: vtpassAdapter
        })) {
            const dbRow = dbHealth[key] || {};
            let live = null;
            let liveError = null;

            try {
                live = await adapter.healthCheck();
            } catch (e) {
                liveError = e.message || String(e);
            }

            const configured = live?.configured ?? dbRow.configured ?? null;
            const reachable  = live?.reachable  ?? dbRow.reachable  ?? null;

            const status = !configured
                ? 'not_configured'
                : !reachable
                    ? 'unreachable'
                    : 'operational';

            // Extract scalar balance from either shape
            const rawBal = live?.balance != null
                ? live.balance
                : (live?.balances && typeof live.balances === 'object')
                    ? (live.balances.NGN ?? live.balances.USD ?? Object.values(live.balances)[0])
                    : null;
            const scalarBalance = rawBal != null && Number.isFinite(Number(rawBal))
                ? Number(rawBal)
                : null;

            let threshold = null;
            try {
                threshold = key === 'dtone'
                    ? Number(await adminSettings.getRaw('provider_balance_alert_dtone_usd').catch(() => 100))
                    : Number(await adminSettings.getRaw('provider_balance_alert_vtpass_ngn').catch(() => 10000));
            } catch (_) { /* optional */ }

            providers[key] = {
                provider: key,
                label: key === 'dtone' ? 'DT One' : 'VTpass',
                status,
                configured,
                reachable,
                environment: live?.environment || dbRow.environment || null,
                latencyMs: live?.latencyMs ?? dbRow.latencyMs ?? null,
                lastSuccess: dbRow.lastSuccess || null,
                lastFailure: dbRow.lastFailure || null,
                recentCount: dbRow.recentCount || 0,
                lastError: liveError || live?.lastError || dbRow.lastError || null,
                balance: scalarBalance,
                balances: live?.balances || null,
                alertThreshold: Number.isFinite(threshold) ? threshold : null,
                low: scalarBalance != null && Number.isFinite(threshold) && scalarBalance < threshold
            };
        }

        return sendOk(res, { providers });
    } catch (e) {
        return handleException(res, e, 'LIST_FAILED');
    }
});

router.get('/airtime/providers/:provider/balance', requirePermission(P_PROVIDERS_READ), async (req, res) => {
    try {
        const provider = String(req.params.provider || '').toLowerCase();
        const adapter = provider === 'dtone'
            ? dtoneAdapter
            : provider === 'vtpass'
                ? vtpassAdapter
                : null;

        if (!adapter) {
            return sendErr(res, 400, 'UNKNOWN_PROVIDER_NAME', 'Unknown provider.');
        }

        const live = await adapter.healthCheck();
        const threshold = provider === 'dtone'
            ? Number(await adminSettings.getRaw('provider_balance_alert_dtone_usd').catch(() => 100))
            : Number(await adminSettings.getRaw('provider_balance_alert_vtpass_ngn').catch(() => 10000));

        const low = live.balance != null
            && Number.isFinite(threshold)
            && live.balance < threshold;

        return sendOk(res, {
            provider,
            balance: live.balance ?? null,
            balances: live.balances || null,
            configured: !!live.configured,
            reachable: !!live.reachable,
            lastError: live.lastError || null,
            alertThreshold: Number.isFinite(threshold) ? threshold : null,
            low
        });
    } catch (e) {
        return handleException(res, e, 'LIST_FAILED');
    }
});

router.post('/airtime/providers/:provider/health-check', requirePermission(P_PROVIDERS_MANAGE), async (req, res) => {
    try {
        const result = await airtimeService.healthCheckProvider({
            provider: req.params.provider,
            ctx: serviceCtx(req)
        });
        return sendOk(res, result);
    } catch (e) {
        return handleException(res, e, 'UNKNOWN_PROVIDER_NAME', 400);
    }
});

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════
router.get('/airtime/config', requirePermission(P_SETTINGS_READ), async (req, res) => {
    try {
        const cfg = await airtimePricing.getAirtimeConfig();
        const links = {
            airtime_global_enabled: '/admin/settings.html#services',
            airtime_local_enabled:  '/admin/settings.html#services',
            airtime_global_fee_pct: '/admin/settings.html#pricing',
            airtime_local_fee_pct:  '/admin/settings.html#pricing',
            airtime_global_min_usd: '/admin/settings.html#limits',
            airtime_global_max_usd: '/admin/settings.html#limits',
            airtime_local_min_ngn:  '/admin/settings.html#limits',
            airtime_local_max_ngn:  '/admin/settings.html#limits',
            usd_to_ngn:             '/admin/settings.html#rates'
        };
        return sendOk(res, { ...cfg, links });
    } catch (e) {
        return handleException(res, e, 'LIST_FAILED');
    }
});

// ═══════════════════════════════════════════════════════════════
//  ROUTING
// ═══════════════════════════════════════════════════════════════
router.get('/airtime/routing', requirePermission(P_ORDERS_READ), async (req, res) => {
    try {
        const rows = await airtimeService.listRouting();
        return sendOk(res, { routing: rows });
    } catch (e) {
        return handleException(res, e, 'ROUTING_READ_FAILED');
    }
});

router.put('/airtime/routing', requirePermission(P_SETTINGS_MANAGE), async (req, res) => {
    try {
        const {
            country,
            network,
            primary_provider,
            enabled = true,
            priority = 1,
            expected_version = null,
            reason
        } = req.body || {};

        if (!country) {
            return sendErr(res, 400, 'INVALID_BODY', 'Country is required.');
        }

        if (
            String(primary_provider || '').toLowerCase() === 'vtpass' &&
            String(country || '').toUpperCase() !== 'NGA'
        ) {
            return sendErr(res, 422, 'INVALID_PROVIDER',
                'VTpass only serves Nigeria. Use DT One for other countries.');
        }

        const result = await airtimeService.setRouting({
            countryIso3: country,
            networkCode: network,
            primaryProvider: primary_provider,
            enabled,
            priority,
            expectedVersion: expected_version,
            ctx: serviceCtx(req),
            reason
        });
        return sendOk(res, result);
    } catch (e) {
        return handleException(res, e, 'ROUTING_WRITE_FAILED');
    }
});

module.exports = router;