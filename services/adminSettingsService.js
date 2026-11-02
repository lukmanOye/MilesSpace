// services/adminSettingsService.js
// ─────────────────────────────────────────────────────────────────
// MILESSPACE SETTINGS — SINGLE SOURCE OF TRUTH (production v3)
// ─────────────────────────────────────────────────────────────────
// Write path: single Postgres RPC `admin_settings_patch_atomic` that
//   does version check + upsert + audit + rate-history in one txn.
// Read path: every entry filtered by per-key `requiredPermission`.
//   A caller who lacks a key's permission simply does not receive
//   that key in the response.
// Authority: `req.adminContext.permissions` is re-read from the DB by
//   adminAuth middleware — this service never trusts a `role` string
//   passed in from a caller.
// Units: `percent` shape accepts DECIMAL STRINGS ONLY ('0.1570' = 15.7%).
//   The frontend multiplies by 100 for display using string math. No
//   Number() is ever called on a percent value in this file.
// Financial keys: FAIL CLOSED. If a financial key's row is missing
//   or cannot be parsed, every caller of that key throws
//   503 CONFIG_NOT_READY. No silent fallback to a hardcoded default.
// Emergency keys: dedicated 3-second cache so a kill switch propagates
//   within one request cycle.
// ─────────────────────────────────────────────────────────────────

'use strict';

const crypto = require('crypto');
const { supabaseAdmin } = require('../db/supabase');
const { PERMISSIONS } = require('../middleware/adminAuth');

// ─── Allowed currencies ───────────────────────────────────────────
const ALLOWED_CURRENCIES = Object.freeze([
    'NGN','USD','GHS','KES','ZAR','XOF','XAF','TZS','EGP'
]);
const ALLOWED_CURRENCIES_SET = new Set(ALLOWED_CURRENCIES);

// ─── Permission constants used by the registry ────────────────────
// Kept as locals so the registry below can reference them without
// pulling in the whole adminAuth module again at parse-time.
const P = {
    SETTINGS_READ:      PERMISSIONS.SETTINGS_READ,
    SETTINGS_MANAGE:    PERMISSIONS.SETTINGS_MANAGE,
    SETTINGS_EMERGENCY: PERMISSIONS.SETTINGS_EMERGENCY || 'settings.emergency',
    FX_MANAGE:          PERMISSIONS.FX_MANAGE,
    PROVIDERS_MANAGE:   PERMISSIONS.PROVIDERS_MANAGE,
    SECURITY_MANAGE:    PERMISSIONS.SECURITY_MANAGE,
    NOTIFICATIONS_MANAGE: PERMISSIONS.NOTIFICATIONS_MANAGE,
    SERVICES_MANAGE:    PERMISSIONS.SERVICES_MANAGE
};

// ─── Key registry ─────────────────────────────────────────────────
// Every entry:
//   shape:      'value' | 'boolean' | 'int' | 'decimal' | 'percent'
//               | 'currency' | 'email' | 'url' | 'enum'
//   section:    UI grouping
//   requiredPermission: permission a caller MUST have to WRITE
//               this key. Reads are filtered by the same permission
//               unless requiredPermission is null (then anyone with
//               SETTINGS_READ may read it).
//   financial:  if true, missing/invalid rows FAIL CLOSED (503).
//   dangerous:  if true, requires reason + (for some) step-up.
//   orphan:     true when no consumer code is known to read this key.
//               The service logs these once at startup so we can
//               audit and remove them (F.11).
// ─────────────────────────────────────────────────────────────────
const KEY_REGISTRY = Object.freeze({
    // ─── General ──────────────────────────────────────────────
    platform_name: {
        shape: 'value', section: 'general', default: 'MilesSpace',
        maxLength: 60, requiredPermission: P.SETTINGS_MANAGE
    },
    company_name: {
        shape: 'value', section: 'general',
        default: 'MilesSpace Digital Technology',
        maxLength: 120, requiredPermission: P.SETTINGS_MANAGE
    },
    support_email: {
        shape: 'email', section: 'general',
        default: 'support@milesspace.com',
        requiredPermission: P.SETTINGS_MANAGE
    },
    support_phone: {
        shape: 'value', section: 'general',
        default: '+234 800 000 0000',
        maxLength: 30, requiredPermission: P.SETTINGS_MANAGE
    },
    website_url: {
        shape: 'url', section: 'general',
        default: 'https://milesspace.com',
        httpsOnly: true, requiredPermission: P.SETTINGS_MANAGE
    },
    default_currency: {
        shape: 'currency', section: 'general', default: 'NGN',
        requiredPermission: P.SETTINGS_MANAGE
    },
    timezone: {
        shape: 'enum', section: 'general', default: 'Africa/Lagos',
        values: ['Africa/Lagos','UTC','Europe/London','America/New_York'],
        requiredPermission: P.SETTINGS_MANAGE
    },
    maintenance_mode: {
        shape: 'boolean', section: 'general', default: 'false',
        dangerous: true, requiredPermission: P.SETTINGS_EMERGENCY
    },
    maintenance_message: {
        shape: 'value', section: 'general',
        default: 'MilesSpace is currently undergoing scheduled maintenance. Please try again later.',
        maxLength: 500, dangerous: true,
        requiredPermission: P.SETTINGS_EMERGENCY
    },

    // ─── FX rate ──────────────────────────────────────────────
    usd_to_ngn: {
        shape: 'decimal', section: 'rates', default: '1600',
        min: '1', max: '1000000', decimals: 2,
        financial: true, dangerous: true,
        requiredPermission: P.FX_MANAGE
    },
    giftcard_wholesale_currency: {
        shape: 'currency', section: 'rates', default: 'NGN',
        requiredPermission: P.FX_MANAGE
    },

    // ─── Deposit rates (USD per 1 unit local) ─────────────────
    deposit_rate_NGN: {
        shape: 'decimal', section: 'fees', default: '0.000625',
        min: '0', max: '10000', decimals: 8,
        financial: true, dangerous: true,
        requiredPermission: P.FX_MANAGE
    },
    deposit_rate_GHS: {
        shape: 'decimal', section: 'fees', default: '0.083',
        min: '0', max: '10000', decimals: 8,
        financial: true, dangerous: true,
        requiredPermission: P.FX_MANAGE
    },
    deposit_rate_KES: {
        shape: 'decimal', section: 'fees', default: '0.0077',
        min: '0', max: '10000', decimals: 8,
        financial: true, dangerous: true,
        requiredPermission: P.FX_MANAGE
    },
    deposit_rate_ZAR: {
        shape: 'decimal', section: 'fees', default: '0.054',
        min: '0', max: '10000', decimals: 8,
        financial: true, dangerous: true,
        requiredPermission: P.FX_MANAGE
    },
    deposit_rate_XOF: {
        shape: 'decimal', section: 'fees', default: '0.0016',
        min: '0', max: '10000', decimals: 8,
        financial: true, dangerous: true,
        requiredPermission: P.FX_MANAGE
    },
    deposit_rate_XAF: {
        shape: 'decimal', section: 'fees', default: '0.0016',
        min: '0', max: '10000', decimals: 8,
        financial: true, dangerous: true,
        requiredPermission: P.FX_MANAGE
    },
    deposit_rate_TZS: {
        shape: 'decimal', section: 'fees', default: '0.0004',
        min: '0', max: '10000', decimals: 8,
        financial: true, dangerous: true,
        requiredPermission: P.FX_MANAGE
    },
    deposit_rate_EGP: {
        shape: 'decimal', section: 'fees', default: '0.0204',
        min: '0', max: '10000', decimals: 8,
        financial: true, dangerous: true,
        requiredPermission: P.FX_MANAGE
    },

    // ─── Deposit fees ─────────────────────────────────────────
    deposit_fee_flat_ngn: {
        shape: 'decimal', section: 'fees', default: '50',
        min: '0', max: '100000', decimals: 2,
        financial: true, requiredPermission: P.SETTINGS_MANAGE
    },
    deposit_fee_pct: {
        shape: 'percent', section: 'fees', default: '0',
        min: '0', max: '0.10', decimals: 4,
        financial: true, requiredPermission: P.SETTINGS_MANAGE
    },
    deposit_fee_min_ngn: {
        shape: 'decimal', section: 'fees', default: '50',
        min: '0', max: '1000000', decimals: 2,
        financial: true, requiredPermission: P.SETTINGS_MANAGE
    },
    deposit_fee_max_ngn: {
        shape: 'decimal', section: 'fees', default: '2000',
        min: '0', max: '10000000', decimals: 2,
        financial: true, requiredPermission: P.SETTINGS_MANAGE
    },

    // ─── Service pricing markups ──────────────────────────────
    giftcard_markup_pct_usd: {
        shape: 'percent', section: 'pricing', default: '0.1570',
        min: '0', max: '0.90', decimals: 4,
        financial: true, requiredPermission: P.FX_MANAGE
    },
    giftcard_markup_pct_ngn: {
        shape: 'percent', section: 'pricing', default: '0.1570',
        min: '0', max: '0.90', decimals: 4,
        financial: true, requiredPermission: P.FX_MANAGE
    },
    esim_markup_pct_usd: {
        shape: 'percent', section: 'pricing', default: '0.1500',
        min: '0', max: '0.90', decimals: 4,
        financial: true, requiredPermission: P.FX_MANAGE
    },
    esim_markup_pct_ngn: {
        shape: 'percent', section: 'pricing', default: '0.1500',
        min: '0', max: '0.90', decimals: 4,
        financial: true, requiredPermission: P.FX_MANAGE
    },
    airtime_markup_pct_usd: {
        shape: 'percent', section: 'pricing', default: '0.0500',
        min: '0', max: '0.90', decimals: 4,
        financial: true, requiredPermission: P.FX_MANAGE
    },
    airtime_markup_pct_ngn: {
        shape: 'percent', section: 'pricing', default: '0.0500',
        min: '0', max: '0.90', decimals: 4,
        financial: true, requiredPermission: P.FX_MANAGE
    },
    boost_markup_pct: {
        shape: 'percent', section: 'pricing', default: '0.1800',
        min: '0', max: '0.90', decimals: 4,
        financial: true, requiredPermission: P.FX_MANAGE
    },
    marketplace_markup_pct: {
        shape: 'percent', section: 'pricing', default: '0.2000',
        min: '0', max: '0.90', decimals: 4,
        financial: true, requiredPermission: P.FX_MANAGE
    },
    virtual_sms_markup_pct: {
        shape: 'percent', section: 'pricing', default: '0.1500',
        min: '0', max: '0.90', decimals: 4,
        financial: true, requiredPermission: P.FX_MANAGE
    },

    // ─── Wallet limits ────────────────────────────────────────
    min_deposit_ngn: {
        shape: 'decimal', section: 'wallet', default: '1000',
        min: '0', max: '1000000000', decimals: 2,
        financial: true, requiredPermission: P.SETTINGS_MANAGE
    },
    max_deposit_ngn: {
        shape: 'decimal', section: 'wallet', default: '5000000',
        min: '0', max: '1000000000', decimals: 2,
        financial: true, requiredPermission: P.SETTINGS_MANAGE
    },
    daily_deposit_limit_ngn: {
        shape: 'decimal', section: 'wallet', default: '10000000',
        min: '0', max: '1000000000', decimals: 2,
        financial: true, requiredPermission: P.SETTINGS_MANAGE
    },

    // ─── Transaction limits ───────────────────────────────────
    giftcard_min_trade_ngn: {
        shape: 'decimal', section: 'limits', default: '5000',
        min: '0', max: '1000000000', decimals: 2,
        requiredPermission: P.SETTINGS_MANAGE
    },
    giftcard_max_trade_ngn: {
        shape: 'decimal', section: 'limits', default: '1000000',
        min: '0', max: '1000000000', decimals: 2,
        requiredPermission: P.SETTINGS_MANAGE
    },
    airtime_min_ngn: {
        shape: 'decimal', section: 'limits', default: '50',
        min: '0', max: '1000000', decimals: 2,
        requiredPermission: P.SETTINGS_MANAGE
    },
    airtime_max_ngn: {
        shape: 'decimal', section: 'limits', default: '100000',
        min: '0', max: '1000000000', decimals: 2,
        requiredPermission: P.SETTINGS_MANAGE
    },
    esim_min_ngn: {
        shape: 'decimal', section: 'limits', default: '5000',
        min: '0', max: '1000000000', decimals: 2,
        requiredPermission: P.SETTINGS_MANAGE
    },
    esim_max_ngn: {
        shape: 'decimal', section: 'limits', default: '500000',
        min: '0', max: '1000000000', decimals: 2,
        requiredPermission: P.SETTINGS_MANAGE
    },
    virtual_sms_min_ngn: {
        shape: 'decimal', section: 'limits', default: '500',
        min: '0', max: '100000000', decimals: 2,
        requiredPermission: P.SETTINGS_MANAGE
    },
    virtual_sms_max_ngn: {
        shape: 'decimal', section: 'limits', default: '100000',
        min: '0', max: '1000000000', decimals: 2,
        requiredPermission: P.SETTINGS_MANAGE
    },
    boost_min_ngn: {
        shape: 'decimal', section: 'limits', default: '1000',
        min: '0', max: '1000000000', decimals: 2,
        requiredPermission: P.SETTINGS_MANAGE
    },
    boost_max_ngn: {
        shape: 'decimal', section: 'limits', default: '1000000',
        min: '0', max: '1000000000', decimals: 2,
        requiredPermission: P.SETTINGS_MANAGE
    },

    // ─── Service flags — withdrawals intentionally ABSENT ────
    service_giftcards_enabled: {
        shape: 'boolean', section: 'services', default: 'true',
        requiredPermission: P.SERVICES_MANAGE
    },
    service_airtime_enabled: {
        shape: 'boolean', section: 'services', default: 'true',
        requiredPermission: P.SERVICES_MANAGE
    },
    service_bills_enabled: {
        shape: 'boolean', section: 'services', default: 'true',
        requiredPermission: P.SERVICES_MANAGE
    },
    service_esim_enabled: {
        shape: 'boolean', section: 'services', default: 'true',
        requiredPermission: P.SERVICES_MANAGE
    },
    service_virtual_sms_enabled: {
        shape: 'boolean', section: 'services', default: 'true',
        requiredPermission: P.SERVICES_MANAGE
    },
    service_boost_enabled: {
        shape: 'boolean', section: 'services', default: 'true',
        requiredPermission: P.SERVICES_MANAGE
    },
    service_marketplace_enabled: {
        shape: 'boolean', section: 'services', default: 'true',
        requiredPermission: P.SERVICES_MANAGE
    },
    service_crypto_enabled: {
        shape: 'boolean', section: 'services', default: 'false',
        requiredPermission: P.SERVICES_MANAGE
    },

    // ─── Provider gates ──────────────────────────────────────
    provider_kora_enabled: {
        shape: 'boolean', section: 'providers', default: 'true',
        requiredPermission: P.PROVIDERS_MANAGE
    },
    provider_kora_maintenance: {
        shape: 'boolean', section: 'providers', default: 'false',
        requiredPermission: P.PROVIDERS_MANAGE
    },
    provider_kora_timeout_ms: {
        shape: 'int', section: 'providers', default: '20000',
        min: 1000, max: 120000, requiredPermission: P.PROVIDERS_MANAGE
    },
    provider_kora_retry_count: {
        shape: 'int', section: 'providers', default: '2',
        min: 0, max: 5, requiredPermission: P.PROVIDERS_MANAGE
    },
    provider_nowpayments_enabled: {
        shape: 'boolean', section: 'providers', default: 'true',
        requiredPermission: P.PROVIDERS_MANAGE
    },
    provider_nowpayments_maintenance: {
        shape: 'boolean', section: 'providers', default: 'false',
        requiredPermission: P.PROVIDERS_MANAGE
    },
    provider_nowpayments_timeout_ms: {
        shape: 'int', section: 'providers', default: '20000',
        min: 1000, max: 120000, requiredPermission: P.PROVIDERS_MANAGE
    },
    provider_vtpass_enabled: {
        shape: 'boolean', section: 'providers', default: 'true',
        requiredPermission: P.PROVIDERS_MANAGE
    },
    provider_vtpass_maintenance: {
        shape: 'boolean', section: 'providers', default: 'false',
        requiredPermission: P.PROVIDERS_MANAGE
    },
    provider_vtpass_timeout_ms: {
        shape: 'int', section: 'providers', default: '20000',
        min: 1000, max: 120000, requiredPermission: P.PROVIDERS_MANAGE
    },
    provider_dtone_enabled: {
        shape: 'boolean', section: 'providers', default: 'true',
        requiredPermission: P.PROVIDERS_MANAGE
    },
    provider_dtone_maintenance: {
        shape: 'boolean', section: 'providers', default: 'false',
        requiredPermission: P.PROVIDERS_MANAGE
    },
    provider_dtone_timeout_ms: {
        shape: 'int', section: 'providers', default: '20000',
        min: 1000, max: 120000, requiredPermission: P.PROVIDERS_MANAGE
    },

    // ─── Notification toggles ─────────────────────────────────
    notify_deposit_success: {
        shape: 'boolean', section: 'notifications', default: 'true',
        requiredPermission: P.NOTIFICATIONS_MANAGE
    },
    notify_deposit_failed: {
        shape: 'boolean', section: 'notifications', default: 'true',
        requiredPermission: P.NOTIFICATIONS_MANAGE
    },
    notify_purchase_success: {
        shape: 'boolean', section: 'notifications', default: 'true',
        requiredPermission: P.NOTIFICATIONS_MANAGE
    },
    notify_purchase_failed: {
        shape: 'boolean', section: 'notifications', default: 'true',
        requiredPermission: P.NOTIFICATIONS_MANAGE
    },
    notify_refund_completed: {
        shape: 'boolean', section: 'notifications', default: 'true',
        requiredPermission: P.NOTIFICATIONS_MANAGE
    },
    notify_login_alert: {
        shape: 'boolean', section: 'notifications', default: 'true',
        requiredPermission: P.NOTIFICATIONS_MANAGE
    },
    notify_password_changed: {
        shape: 'boolean', section: 'notifications', default: 'true',
        requiredPermission: P.NOTIFICATIONS_MANAGE
    },
    notify_2fa_enabled: {
        shape: 'boolean', section: 'notifications', default: 'true',
        requiredPermission: P.NOTIFICATIONS_MANAGE
    },
    notify_admin_webhook_failure: {
        shape: 'boolean', section: 'notifications', default: 'true',
        requiredPermission: P.NOTIFICATIONS_MANAGE
    },
    notify_admin_provider_outage: {
        shape: 'boolean', section: 'notifications', default: 'true',
        requiredPermission: P.NOTIFICATIONS_MANAGE
    },
    notify_admin_large_deposit: {
        shape: 'boolean', section: 'notifications', default: 'true',
        requiredPermission: P.NOTIFICATIONS_MANAGE
    },
    notify_admin_reconciliation_mismatch: {
        shape: 'boolean', section: 'notifications', default: 'true',
        requiredPermission: P.NOTIFICATIONS_MANAGE
    },

    // ─── Security ─────────────────────────────────────────────
    session_timeout_hours: {
        shape: 'int', section: 'security', default: '8',
        min: 1, max: 168, requiredPermission: P.SECURITY_MANAGE
    },
    failed_login_attempts: {
        shape: 'int', section: 'security', default: '5',
        min: 3, max: 20, requiredPermission: P.SECURITY_MANAGE
    },
    require_2fa: {
        shape: 'boolean', section: 'security', default: 'true',
        requiredPermission: P.SECURITY_MANAGE
    },
    email_verification: {
        shape: 'boolean', section: 'security', default: 'true',
        requiredPermission: P.SECURITY_MANAGE
    },

    // ─── Emergency ────────────────────────────────────────────
    emergency_stop_deposits: {
        shape: 'boolean', section: 'emergency', default: 'false',
        dangerous: true, requiredPermission: P.SETTINGS_EMERGENCY
    },
    emergency_stop_purchases: {
        shape: 'boolean', section: 'emergency', default: 'false',
        dangerous: true, requiredPermission: P.SETTINGS_EMERGENCY
    },
    emergency_stop_provider_requests: {
        shape: 'boolean', section: 'emergency', default: 'false',
        dangerous: true, requiredPermission: P.SETTINGS_EMERGENCY
    },
    emergency_stop_wallet_mutations: {
        shape: 'boolean', section: 'emergency', default: 'false',
        dangerous: true, requiredPermission: P.SETTINGS_EMERGENCY
    },

    // ─── Internal ─────────────────────────────────────────────
    config_version: {
        shape: 'int', section: 'internal', default: '1',
        min: 1, max: 9999999999,
        requiredPermission: P.SETTINGS_MANAGE,
        writeForbidden: true
    }
});

// ─── Derived sets ────────────────────────────────────────────────
const ALL_KEYS = Object.keys(KEY_REGISTRY);
const FINANCIAL_KEYS = new Set(
    Object.entries(KEY_REGISTRY).filter(([, s]) => s.financial).map(([k]) => k)
);
const DANGEROUS_KEYS = new Set(
    Object.entries(KEY_REGISTRY).filter(([, s]) => s.dangerous).map(([k]) => k)
);
const EMERGENCY_KEYS = new Set([
    'emergency_stop_deposits','emergency_stop_purchases',
    'emergency_stop_provider_requests','emergency_stop_wallet_mutations',
    'maintenance_mode','maintenance_message'
]);
const RATE_KEYS = new Set([
    'usd_to_ngn',
    'deposit_rate_NGN','deposit_rate_GHS','deposit_rate_KES','deposit_rate_ZAR',
    'deposit_rate_XOF','deposit_rate_XAF','deposit_rate_TZS','deposit_rate_EGP',
    'deposit_fee_flat_ngn','deposit_fee_pct','deposit_fee_min_ngn','deposit_fee_max_ngn',
    'giftcard_markup_pct_usd','giftcard_markup_pct_ngn',
    'esim_markup_pct_usd','esim_markup_pct_ngn',
    'airtime_markup_pct_usd','airtime_markup_pct_ngn',
    'boost_markup_pct','marketplace_markup_pct','virtual_sms_markup_pct'
]);
const SECTION_KEYS = (() => {
    const map = {};
    for (const [key, spec] of Object.entries(KEY_REGISTRY)) {
        const s = spec.section || 'general';
        if (!map[s]) map[s] = [];
        map[s].push(key);
    }
    return Object.freeze(map);
})();

// ─── Service & provider registries (unchanged semantics) ────────
const SERVICE_REGISTRY = Object.freeze({
    giftcards:    { label: 'Gift Cards',        enabledKey: 'service_giftcards_enabled' },
    airtime:      { label: 'Airtime & Data',    enabledKey: 'service_airtime_enabled' },
    bills:        { label: 'Bills & Utilities', enabledKey: 'service_bills_enabled' },
    esim:         { label: 'eSIM',              enabledKey: 'service_esim_enabled' },
    virtual_sms:  { label: 'Virtual SMS',       enabledKey: 'service_virtual_sms_enabled' },
    boost:        { label: 'Boost',             enabledKey: 'service_boost_enabled' },
    marketplace:  { label: 'Marketplace',       enabledKey: 'service_marketplace_enabled' },
    crypto:       { label: 'Crypto',            enabledKey: 'service_crypto_enabled' }
    // Withdrawals, KYC, Virtual Cards intentionally removed.
});
const PROVIDER_REGISTRY = Object.freeze({
    kora: {
        label: 'KoraPay',
        enabledKey: 'provider_kora_enabled',
        maintenanceKey: 'provider_kora_maintenance',
        timeoutKey: 'provider_kora_timeout_ms',
        retryKey: 'provider_kora_retry_count',
        secretEnv: ['KORA_SECRET_KEY','KORA_PUBLIC_KEY']
    },
    nowpayments: {
        label: 'NowPayments',
        enabledKey: 'provider_nowpayments_enabled',
        maintenanceKey: 'provider_nowpayments_maintenance',
        timeoutKey: 'provider_nowpayments_timeout_ms',
        secretEnv: ['NOWPAYMENTS_API_KEY','NOWPAYMENTS_IPN_SECRET']
    },
    vtpass: {
        label: 'VTpass',
        enabledKey: 'provider_vtpass_enabled',
        maintenanceKey: 'provider_vtpass_maintenance',
        timeoutKey: 'provider_vtpass_timeout_ms',
        secretEnv: ['VTPASS_API_KEY','VTPASS_PUBLIC_KEY','VTPASS_SECRET_KEY']
    },
    dtone: {
        label: 'DT One',
        enabledKey: 'provider_dtone_enabled',
        maintenanceKey: 'provider_dtone_maintenance',
        timeoutKey: 'provider_dtone_timeout_ms',
        secretEnv: ['DTONE_API_KEY','DTONE_API_SECRET','DTONE_WEBHOOK_SECRET']
    }
});

// ─── Error helpers ───────────────────────────────────────────────
function validationError(code, message, extra = {}) {
    const e = new Error(message);
    e.status = 422; e.code = code;
    Object.assign(e, extra);
    return e;
}
function forbiddenError(code, message, extra = {}) {
    const e = new Error(message);
    e.status = 403; e.code = code;
    Object.assign(e, extra);
    return e;
}
function conflictError(code, message, extra = {}) {
    const e = new Error(message);
    e.status = 409; e.code = code;
    Object.assign(e, extra);
    return e;
}
function notReadyError(code, message, extra = {}) {
    const e = new Error(message);
    e.status = 503; e.code = code;
    Object.assign(e, extra);
    return e;
}

// ─── Decimal-string arithmetic helpers (NO Number() on money) ────
// All comparisons, min/max checks, and percent conversions use
// BigInt scaled to a common scale. Percent display conversion
// (0.1570 → 15.70) is pure string manipulation.
const DEC_RE = /^-?\d+(\.\d+)?$/;

function isValidDecimalString(s) {
    return typeof s === 'string' && DEC_RE.test(s);
}

function decimalScale(s) {
    if (!isValidDecimalString(s)) return 0;
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : s.length - dot - 1;
}

// Convert decimal string to BigInt scaled to `scale`.
function toScaledBigInt(s, scale) {
    if (!isValidDecimalString(s)) throw new Error('toScaledBigInt: not a decimal string');
    const neg = s.startsWith('-');
    const body = neg ? s.slice(1) : s;
    const [i, f = ''] = body.split('.');
    const frac = (f + '0'.repeat(scale)).slice(0, scale);
    const padded = (i || '0') + frac;
    const bi = BigInt(padded || '0');
    return neg ? -bi : bi;
}

// Convert scaled BigInt back to decimal string at `scale`.
function fromScaledBigInt(bi, scale) {
    const neg = bi < 0n;
    const abs = neg ? -bi : bi;
    const divisor = 10n ** BigInt(scale);
    const intPart = abs / divisor;
    const fracPart = abs % divisor;
    const frac = fracPart.toString().padStart(scale, '0');
    return (neg ? '-' : '') + intPart.toString() + '.' + frac;
}

// Compare two decimal strings. Returns -1 / 0 / 1.
function cmpDecimal(a, b) {
    const scale = Math.max(decimalScale(a), decimalScale(b));
    const A = toScaledBigInt(a, scale);
    const B = toScaledBigInt(b, scale);
    if (A === B) return 0;
    return A < B ? -1 : 1;
}
// Percent display conversion — pure string math.
// Stored: '0.1570'  Display: '15.70'
// No Number(), no float, no rounding errors.
function percentToDisplay(stored) {
    if (!isValidDecimalString(stored)) return '';
    const neg = stored.startsWith('-');
    const body = neg ? stored.slice(1) : stored;
    // Multiply by 100 = shift decimal point two places right.
    const [i, f = ''] = body.split('.');
    const allDigits = (i || '0') + f;
    const dotPos = (i || '0').length + 2;    // where the decimal point lands
    let result;
    if (allDigits.length <= dotPos) {
        result = allDigits.padEnd(dotPos + 1, '0');
        result = result.slice(0, dotPos) + '.' + result.slice(dotPos);
    } else {
        result = allDigits.slice(0, dotPos) + '.' + allDigits.slice(dotPos);
    }
    // Trim to 4 decimals to match the stored scale (0.1570 → 15.70).
    const [ri, rf = ''] = result.split('.');
    const rf4 = (rf + '0000').slice(0, 4).replace(/0+$/, '') || '0';
    return (neg ? '-' : '') + ri + '.' + rf4;
}

// Reverse: display '15.70' → stored '0.1570'
function displayToPercent(display) {
    if (!isValidDecimalString(display)) throw new Error('displayToPercent: not a decimal string');
    const neg = display.startsWith('-');
    const body = neg ? display.slice(1) : display;
    const [i, f = ''] = body.split('.');
    // Divide by 100 = shift decimal point two places left.
    const padded = f.padEnd(2, '0');
    const newInt = i === '0' ? '0' : i.slice(0, Math.max(0, i.length - 2)) || '0';
    const takeFrac = i.length < 2 ? i.padStart(2, '0') : i.slice(-2);
    const newFrac = (takeFrac + padded).slice(0, 6).replace(/0+$/, '') || '0';
    const composed = newInt + '.' + newFrac;
    // Scale to 4 decimals.
    const [ci, cf = ''] = composed.split('.');
    const scaled = (cf + '0000').slice(0, 4);
    return (neg ? '-' : '') + ci + '.' + scaled;
}

// ─── Validation ──────────────────────────────────────────────────
// `normalize()` returns the canonical string that will be stored.
// It NEVER uses Number() on money/rates/percent — only string math
// and BigInt comparison.
function normalize(key, rawValue) {
    const spec = KEY_REGISTRY[key];
    if (!spec) {
        throw validationError('UNKNOWN_SETTING_KEY', `Unknown setting key: ${key}`, { key });
    }

    // Booleans
    if (spec.shape === 'boolean') {
        if (rawValue === true || rawValue === 'true' || rawValue === 1 || rawValue === '1') return 'true';
        if (rawValue === false || rawValue === 'false' || rawValue === 0 || rawValue === '0') return 'false';
        throw validationError('INVALID_BOOLEAN', `${key} must be true or false`, { key });
    }

    // Int
    if (spec.shape === 'int') {
        if (rawValue === '' || rawValue == null) {
            throw validationError('INVALID_INT', `${key} must be an integer`, { key });
        }
        const s = String(rawValue).trim();
        if (!/^\d+$/.test(s)) throw validationError('INVALID_INT', `${key} must be an integer`, { key });
        const n = BigInt(s);
        if (spec.min != null && n < BigInt(spec.min)) throw validationError('OUT_OF_RANGE', `${key} must be ≥ ${spec.min}`, { key, min: spec.min });
        if (spec.max != null && n > BigInt(spec.max)) throw validationError('OUT_OF_RANGE', `${key} must be ≤ ${spec.max}`, { key, max: spec.max });
        return s;
    }

    // Decimal
    if (spec.shape === 'decimal') {
        const s = String(rawValue == null ? '' : rawValue).trim();
        if (!isValidDecimalString(s)) {
            throw validationError('INVALID_NUMBER', `${key} must be a decimal number (e.g. 0.0077)`, { key });
        }
        const neg = s.startsWith('-');
        const unsigned = neg ? s.slice(1) : s;
        const [i, f = ''] = unsigned.split('.');
        const frac = (f + '0'.repeat(spec.decimals)).slice(0, spec.decimals);
        const norm = (neg ? '-' : '') + (i || '0') + '.' + frac;
        if (spec.min != null && cmpDecimal(norm, spec.min) < 0) {
            throw validationError('OUT_OF_RANGE', `${key} must be ≥ ${spec.min}`, { key, min: spec.min });
        }
        if (spec.max != null && cmpDecimal(norm, spec.max) > 0) {
            throw validationError('OUT_OF_RANGE', `${key} must be ≤ ${spec.max}`, { key, max: spec.max });
        }
        return norm;
    }

    // Percent — DECIMAL STRING ONLY. '0.1570' = 15.7%.
    if (spec.shape === 'percent') {
        const s = String(rawValue == null ? '' : rawValue).trim();
        if (!isValidDecimalString(s)) {
            throw validationError('INVALID_PERCENT', `${key} must be a decimal (0.1570 = 15.70%)`, { key });
        }
        // Reject the obvious unit bug: if the frontend sends '15.70',
        // it means the caller forgot to divide. Anything ≥ 1 is
        // either 100%+ (out of range here) or a units mistake.
        if (cmpDecimal(s, '1') >= 0 && spec.max && cmpDecimal(spec.max, '1') < 0) {
            throw validationError('PERCENT_UNITS_AMBIGUOUS',
                `${key}: send decimal (0.1570), not percentage (15.70). The frontend converts for display.`,
                { key, got: s });
        }
        const neg = s.startsWith('-');
        const unsigned = neg ? s.slice(1) : s;
        const [i, f = ''] = unsigned.split('.');
        const frac = (f + '0'.repeat(spec.decimals)).slice(0, spec.decimals);
        const norm = (neg ? '-' : '') + (i || '0') + '.' + frac;
        if (spec.min != null && cmpDecimal(norm, spec.min) < 0) {
            throw validationError('OUT_OF_RANGE', `${key} must be ≥ ${spec.min}`, { key, min: spec.min });
        }
        if (spec.max != null && cmpDecimal(norm, spec.max) > 0) {
            throw validationError('OUT_OF_RANGE', `${key} must be ≤ ${spec.max}`, { key, max: spec.max });
        }
        return norm;
    }

    // Currency
    if (spec.shape === 'currency') {
        const c = String(rawValue || '').trim().toUpperCase();
        if (!ALLOWED_CURRENCIES_SET.has(c)) {
            throw validationError('INVALID_CURRENCY',
                `${key} must be one of: ${ALLOWED_CURRENCIES.join(', ')}`,
                { key, allowed: ALLOWED_CURRENCIES });
        }
        return c;
    }

    // Email
    if (spec.shape === 'email') {
        const s = String(rawValue || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 200) {
            throw validationError('INVALID_EMAIL', `${key} must be a valid email address`, { key });
        }
        return s;
    }

    // URL
    if (spec.shape === 'url') {
        const s = String(rawValue || '').trim();
        let u;
        try { u = new URL(s); } catch { throw validationError('INVALID_URL', `${key} must be a valid URL`, { key }); }
        if (spec.httpsOnly && u.protocol !== 'https:') {
            throw validationError('INVALID_URL', `${key} must use https://`, { key });
        }
        return s;
    }

    // Enum
    if (spec.shape === 'enum') {
        const s = String(rawValue);
        if (!spec.values.includes(s)) {
            throw validationError('INVALID_ENUM',
                `${key} must be one of: ${spec.values.join(', ')}`,
                { key, allowed: spec.values });
        }
        return s;
    }

    // value (default)
    const s = String(rawValue == null ? '' : rawValue);
    if (spec.maxLength && s.length > spec.maxLength) {
        throw validationError('TOO_LONG', `${key} must be at most ${spec.maxLength} characters`, { key, maxLength: spec.maxLength });
    }
    return s;
}

// ─── Cross-field validation (decimal-string safe) ────────────────
function validateCrossField(merged) {
    const compare = (a, b, label) => {
        const A = merged[a], B = merged[b];
        if (A == null || B == null) return;
        if (!isValidDecimalString(String(A)) || !isValidDecimalString(String(B))) return;
        if (cmpDecimal(String(A), String(B)) > 0) {
            throw validationError('CROSS_FIELD_INVALID',
                `${label}: ${a} (${A}) must be ≤ ${b} (${B})`,
                { aKey: a, bKey: b });
        }
    };
    compare('min_deposit_ngn',        'max_deposit_ngn',        'Deposit range');
    compare('max_deposit_ngn',        'daily_deposit_limit_ngn','Daily limit');
    compare('deposit_fee_min_ngn',    'deposit_fee_max_ngn',    'Deposit fee range');
    compare('deposit_fee_flat_ngn',   'deposit_fee_max_ngn',    'Flat fee within fee range');
    compare('giftcard_min_trade_ngn', 'giftcard_max_trade_ngn', 'Gift card range');
    compare('airtime_min_ngn',        'airtime_max_ngn',        'Airtime range');
    compare('esim_min_ngn',           'esim_max_ngn',           'eSIM range');
    compare('virtual_sms_min_ngn',    'virtual_sms_max_ngn',    'Virtual SMS range');
    compare('boost_min_ngn',          'boost_max_ngn',          'Boost range');
}

// ─── Cache (two TTLs) ────────────────────────────────────────────
// 45s for general keys, 3s for emergency/maintenance so a kill
// switch propagates within one request cycle. Both caches invalidate
// after write. Single-instance assumption is fine per your hosting
// budget note.
const CACHE_TTL_MS = 45 * 1000;
const EMERGENCY_CACHE_TTL_MS = 3 * 1000;
const _cache = { raw: null, fetchedAt: 0, promise: null };
const _emergencyCache = { raw: null, fetchedAt: 0 };

function invalidateCache() {
    _cache.raw = null;
    _cache.fetchedAt = 0;
    _emergencyCache.raw = null;
    _emergencyCache.fetchedAt = 0;
}

async function readRawFromDb() {
    const { data, error } = await supabaseAdmin
        .from('app_config')
        .select('key, value')
        .in('key', ALL_KEYS);
    if (error) throw new Error(`Failed to read app_config: ${error.message}`);
    const raw = {};
    for (const row of data || []) raw[row.key] = row.value;
    return raw;
}

async function getRawCached({ force = false } = {}) {
    if (!force && _cache.raw && (Date.now() - _cache.fetchedAt) < CACHE_TTL_MS) return _cache.raw;
    if (_cache.promise) return _cache.promise;
    _cache.promise = (async () => {
        try {
            const stored = await readRawFromDb();
            const merged = {};
            for (const [key, spec] of Object.entries(KEY_REGISTRY)) {
                // Financial keys: DO NOT fall back to spec.default.
                // Their value must come from the DB, or the key is
                // absent so callers fail closed.
                if (spec.financial) {
                    if (stored[key] !== undefined) merged[key] = stored[key];
                } else {
                    merged[key] = stored[key] !== undefined ? stored[key] : spec.default;
                }
            }
            _cache.raw = merged;
            _cache.fetchedAt = Date.now();
            // Emergency keys expire faster — cache separately.
            const emergency = {};
            for (const k of EMERGENCY_KEYS) {
                if (merged[k] !== undefined) emergency[k] = merged[k];
            }
            _emergencyCache.raw = emergency;
            _emergencyCache.fetchedAt = Date.now();
            return merged;
        } finally {
            _cache.promise = null;
        }
    })();
    return _cache.promise;
}

async function getEmergencyRaw(key) {
    if (_emergencyCache.raw && (Date.now() - _emergencyCache.fetchedAt) < EMERGENCY_CACHE_TTL_MS) {
        if (key in _emergencyCache.raw) return _emergencyCache.raw[key];
    }
    // Expired or missing — refresh just this one key from DB.
    const { data, error } = await supabaseAdmin
        .from('app_config')
        .select('value')
        .eq('key', key)
        .maybeSingle();
    if (error) throw notReadyError('CONFIG_READ_FAILED', `Cannot read ${key}`, { key });
    if (!data) throw notReadyError('CONFIG_NOT_READY', `${key} is not configured`, { key });
    return data.value;
}

// ─── Display value ───────────────────────────────────────────────
function displayValue(spec, raw) {
    if (raw == null) return null;
    switch (spec.shape) {
        case 'boolean':
            return raw === true || raw === 'true' || raw === '1' || raw === 1;
        case 'int':
            return /^\d+$/.test(String(raw)) ? String(raw) : null;
        case 'decimal':
        case 'percent':
            return isValidDecimalString(String(raw)) ? String(raw) : null;
        default:
            return String(raw);
    }
}

// ─── Authority / permission resolution ───────────────────────────
// The caller is `ctx` built by routes. We only trust:
//   - adminId  (id of authenticated admin)
//   - permissions (from req.adminContext, itself derived from DB)
// We never trust `isSuperAdmin` from the caller. Super admin is
// resolved by adminAuth middleware and stored in permissions as '*'.
function ctxHasPermission(ctx, permission) {
    if (!ctx || !permission) return false;
    const perms = ctx.permissions || [];
    return perms.includes('*') || perms.includes(permission);
}

// ─── READ ────────────────────────────────────────────────────────
async function getAllSettings(ctx = null) {
    const raw = await getRawCached();
    const flat = {};
    for (const [key, spec] of Object.entries(KEY_REGISTRY)) {
        // Permission filter: skip keys the caller cannot read.
        if (spec.requiredPermission && !ctxHasPermission(ctx, spec.requiredPermission)) continue;
        const v = raw[key];
        if (v == null) {
            // Financial key with no row → report absent, do not fabricate.
            flat[key] = null;
            continue;
        }
        flat[key] = displayValue(spec, v);
    }
    return flat;
}

async function getSettingsBySectionAll(ctx = null) {
    const flat = await getAllSettings(ctx);
    const out = {};
    for (const [key, spec] of Object.entries(KEY_REGISTRY)) {
        if (!(key in flat)) continue;
        const s = spec.section || 'general';
        if (!out[s]) out[s] = {};
        out[s][key] = flat[key];
    }
    return out;
}

async function getSection(section, ctx = null) {
    const all = await getSettingsBySectionAll(ctx);
    if (all[section]) return all[section];
    if (SECTION_KEYS[section]) return {};
    throw Object.assign(new Error(`Unknown section: ${section}`), { status: 404, code: 'UNKNOWN_SECTION' });
}

// ─── Raw readers — the ONLY place that may throw CONFIG_NOT_READY ─
async function getRaw(key) {
    const spec = KEY_REGISTRY[key];
    if (!spec) return undefined;
    if (EMERGENCY_KEYS.has(key)) {
        try {
            return await getEmergencyRaw(key);
        } catch (e) {
            if (spec.financial) throw notReadyError('CONFIG_NOT_READY', `${key} is not configured`, { key });
            return spec.default;
        }
    }
    const raw = await getRawCached();
    const v = raw[key];
    if (v == null && spec.financial) {
        // FAIL CLOSED — no fallback.
        throw notReadyError('CONFIG_NOT_READY',
            `Financial setting ${key} is missing. Seed it before use.`,
            { key });
    }
    return v != null ? v : spec.default;
}

async function getNumber(key) {
    const spec = KEY_REGISTRY[key];
    if (!spec) throw new Error(`Unknown key: ${key}`);
    const v = await getRaw(key);
    // Always return a STRING to prevent downstream float math.
    // Consumers that need math must use the decimal helpers below
    // or Postgres NUMERIC.
    if (spec.shape === 'decimal' || spec.shape === 'percent' || spec.shape === 'int') {
        if (!isValidDecimalString(String(v)) && !/^\d+$/.test(String(v))) {
            throw notReadyError('CONFIG_NOT_READY', `${key} has an invalid value: ${v}`, { key });
        }
        return String(v);
    }
    throw new Error(`getNumber() called on non-numeric key: ${key}`);
}

async function getBoolean(key) {
    const v = await getRaw(key);
    return v === true || v === 'true' || v === '1' || v === 1;
}

async function getString(key) {
    const v = await getRaw(key);
    return v == null ? '' : String(v);
}

// ─── WRITE — rate limit + idempotency ───────────────────────────
const WRITE_RATE_LIMIT_PER_MIN = Number(process.env.SETTINGS_WRITES_PER_MIN || 30);
const _writeLog = new Map();     // adminId → [timestamps]
const _idempotency = new Map();  // adminId + key → { response, exp }

function _checkWriteRate(adminId) {
    const now = Date.now();
    const windowMs = 60_000;
    const log = (_writeLog.get(adminId) || []).filter(t => now - t < windowMs);
    if (log.length >= WRITE_RATE_LIMIT_PER_MIN) {
        throw Object.assign(new Error('Too many settings writes. Slow down.'), {
            status: 429, code: 'RATE_LIMITED'
        });
    }
    log.push(now);
    _writeLog.set(adminId, log);
}

function _idempotencyGet(adminId, key) {
    const row = _idempotency.get(`${adminId}:${key}`);
    if (!row) return null;
    if (row.exp < Date.now()) { _idempotency.delete(`${adminId}:${key}`); return null; }
    return row.response;
}
function _idempotencySet(adminId, key, response) {
    _idempotency.set(`${adminId}:${key}`, { response, exp: Date.now() + 10 * 60_000 });
    if (_idempotency.size > 500) {
        const first = _idempotency.keys().next().value;
        if (first) _idempotency.delete(first);
    }
}

// ─── Large-change guard (F.5) ────────────────────────────────────
const LARGE_CHANGE_PCT = '0.10';    // 10% — string

function _isLargeChange(oldVal, newVal) {
    if (!isValidDecimalString(String(oldVal)) || !isValidDecimalString(String(newVal))) return false;
    const oldBi = toScaledBigInt(String(oldVal), 6);
    if (oldBi === 0n) return false;   // can't calculate % of zero
    const newBi = toScaledBigInt(String(newVal), 6);
    const diffBi = newBi > oldBi ? newBi - oldBi : oldBi - newBi;
    // diff / old > 0.10  ⟺  diff * 100 > old * 10 (in same scale)
    const threshold = toScaledBigInt(LARGE_CHANGE_PCT, 6);
    return diffBi > (oldBi * threshold) / toScaledBigInt('1.000000', 6);
}

// ─── Patch ───────────────────────────────────────────────────────
async function patchSettings(patch, ctx = {}, options = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw validationError('INVALID_PATCH', 'patch must be an object');
    }

    // Strip meta keys
    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
        if (k === 'reason' || k === 'expectedVersion' || k === 'confirmLargeChange') continue;
        clean[k] = v;
    }
    if (!Object.keys(clean).length) throw validationError('EMPTY_PATCH', 'No settings to update');

    if (!ctx.adminId) {
        throw forbiddenError('ADMIN_REQUIRED', 'Admin context is required to modify settings.');
    }

    // Rate limit
    _checkWriteRate(ctx.adminId);

    // Idempotency
    const idemKey = options.idempotencyKey || ctx.idempotencyKey || null;
    if (idemKey) {
        const cached = _idempotencyGet(ctx.adminId, idemKey);
        if (cached) return cached;
    }

    // Per-key permission checks and per-key compare-and-set
    for (const key of Object.keys(clean)) {
        const spec = KEY_REGISTRY[key];
        if (!spec) throw validationError('UNKNOWN_SETTING_KEY', `Unknown setting key: ${key}`, { key });
        if (spec.writeForbidden) {
            throw validationError('RESERVED_KEY', `${key} cannot be edited directly`);
        }
        if (spec.requiredPermission && !ctxHasPermission(ctx, spec.requiredPermission)) {
            throw forbiddenError('PERMISSION_DENIED',
                `You do not have permission to change ${key}`,
                { key, required: spec.requiredPermission });
        }
    }

    // Normalize
    const normalized = {};
    const previous = {};
    for (const [key, rawValue] of Object.entries(clean)) {
        // Per-key compare-and-set: caller may pass { value, previous }.
        // The `previous` is the value the caller last saw; we compare
        // against the CURRENT row. On mismatch → KEY_CONFLICT for
        // exactly that key, so unrelated edits do not fail the whole
        // request (F.7).
        if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
            && 'value' in rawValue) {
            normalized[key] = normalize(key, rawValue.value);
            if ('previous' in rawValue) previous[key] = String(rawValue.previous);
        } else {
            normalized[key] = normalize(key, rawValue);
        }
    }

    // Cross-field validation
    const existing = await getRawCached();
    const merged = { ...existing, ...normalized };
    validateCrossField(merged);

    // Reason required for financial/dangerous/emergency
    const touched = Object.keys(normalized);
    const needsReason = touched.some(k => FINANCIAL_KEYS.has(k) || DANGEROUS_KEYS.has(k) || EMERGENCY_KEYS.has(k));
    if (needsReason) {
        if (!ctx.reason || String(ctx.reason).trim().length < 4) {
            throw validationError('REASON_REQUIRED',
                'A reason of at least 4 characters is required for this change',
                { keys: touched });
        }
    }

    // Large-change guard for rate keys
    if (!options.confirmLargeChange && !ctx.confirmLargeChange) {
        for (const key of touched) {
            if (!RATE_KEYS.has(key)) continue;
            const old = existing[key];
            const now = normalized[key];
            if (old != null && now != null && _isLargeChange(String(old), String(now))) {
                throw validationError('LARGE_CHANGE_REQUIRES_CONFIRMATION',
                    `Change to ${key} is more than ${LARGE_CHANGE_PCT} (10%). ` +
                    `Send confirmLargeChange: true with a reason to proceed.`,
                    { key, old_value: String(old), new_value: String(now) });
            }
        }
    }

    // Version
    const expectedVersion = options.expectedVersion != null
        ? String(options.expectedVersion)
        : (ctx.expectedVersion != null ? String(ctx.expectedVersion) : null);
    if (!expectedVersion || !/^\d+$/.test(expectedVersion) || expectedVersion === '0') {
        throw conflictError('CONFIG_VERSION_REQUIRED',
            'expectedVersion is required. Reload settings and retry.');
    }

    // Per-key compare-and-set — verify the row hasn't moved since the
    // caller captured it.
    for (const [key, expected] of Object.entries(previous)) {
        const current = existing[key];
        if (current != null && String(current) !== String(expected)) {
            throw conflictError('KEY_CONFLICT',
                `${key} was changed by another admin. Current value: ${current}`,
                { key, current_value: String(current), expected_value: expected });
        }
    }

    // Build the RPC payload — all values are STRINGS.
    const settingsJson = {};
    for (const [k, v] of Object.entries(normalized)) settingsJson[k] = String(v);

    const { data, error } = await supabaseAdmin.rpc('admin_settings_patch_atomic', {
        p_admin_id:         ctx.adminId,
        p_admin_email:      ctx.adminEmail || ctx.email || null,
        p_settings:         settingsJson,
        p_expected_version: Number(expectedVersion),
        p_reason:           ctx.reason ? String(ctx.reason).slice(0, 500) : null,
        p_ip:               ctx.ip || null,
        p_user_agent:       ctx.userAgent || null
    });

    if (error) {
        const msg = String(error.message || '');
        if (/CONFIG_VERSION_CONFLICT/.test(msg)) {
            const m = /got\s+(\d+)/i.exec(msg);
            throw conflictError('CONFIG_VERSION_CONFLICT',
                'Another admin saved this section first. Reload and retry.',
                { current_version: m ? Number(m[1]) : null });
        }
        if (/CONFIG_VERSION_REQUIRED/.test(msg)) {
            throw conflictError('CONFIG_VERSION_REQUIRED', 'expectedVersion is required.');
        }
        if (/INVALID_PATCH/.test(msg)) {
            throw validationError('INVALID_PATCH', 'Malformed settings payload.');
        }
        if (/KEY_TOO_LONG/.test(msg)) {
            throw validationError('TOO_LONG', 'One of the setting keys is too long.');
        }
        console.error('[adminSettings] atomic patch failed:', error.message);
        throw Object.assign(new Error('Failed to save settings. Please try again.'),
            { status: 500, code: 'SAVE_FAILED' });
    }

    const result = data || {};
    invalidateCache();

    const response = {
        version:   result.version != null ? Number(result.version) : null,
        updated:   Array.isArray(result.updated)   ? result.updated   : [],
        unchanged: Array.isArray(result.unchanged) ? result.unchanged : []
    };
    if (idemKey) _idempotencySet(ctx.adminId, idemKey, response);
    return response;
}// ─── Reset ────────────────────────────────────────────────────────
// F.6 — a full reset is forbidden for rates / fees / emergency.
// Those sections must be edited key-by-key so the audit trail is
// explicit. Non-financial sections (notifications, security,
// providers, services) may be reset with a reason.
const RESET_FORBIDDEN_SECTIONS = new Set(['rates', 'fees', 'emergency']);

async function resetSection(section, ctx = {}) {
    if (!SECTION_KEYS[section]) {
        throw Object.assign(new Error(`Unknown section: ${section}`),
            { status: 404, code: 'UNKNOWN_SECTION' });
    }
    if (RESET_FORBIDDEN_SECTIONS.has(section)) {
        throw forbiddenError('RESET_FORBIDDEN',
            `Resetting the "${section}" section is forbidden. Change individual keys instead so each change is audited.`,
            { section });
    }
    if (!ctx.reason || String(ctx.reason).trim().length < 4) {
        throw validationError('REASON_REQUIRED', 'A reason is required for reset.');
    }
    if (ctx.expectedVersion == null) {
        throw conflictError('CONFIG_VERSION_REQUIRED', 'expectedVersion is required for reset.');
    }
    const patch = {};
    for (const key of SECTION_KEYS[section]) {
        const spec = KEY_REGISTRY[key];
        if (!spec) continue;
        if (spec.writeForbidden) continue;
        if (spec.financial) continue;    // never reset a financial key
        patch[key] = spec.default;
    }
    if (!Object.keys(patch).length) {
        throw validationError('NOTHING_TO_RESET', `Section "${section}" has no resettable keys.`);
    }
    return patchSettings(patch, {
        ...ctx,
        reason: ctx.reason || `Reset ${section}`
    }, {
        expectedVersion: ctx.expectedVersion,
        confirmLargeChange: true,
        idempotencyKey: ctx.idempotencyKey || null
    });
}

async function resetAll(ctx = {}) {
    throw forbiddenError('RESET_ALL_FORBIDDEN',
        'A full reset is not permitted. Change individual keys instead so every change is audited and reversible.');
}

// ─── Decimal-string domain helpers ───────────────────────────────
// These replace the old toCents/fromCents float logic. All math is
// done with BigInt scaled to the currency scale (2 for NGN/USD).

const CCY_SCALE = 2;

function moneyAdd(a, b) {
    return fromScaledBigInt(
        toScaledBigInt(a, CCY_SCALE) + toScaledBigInt(b, CCY_SCALE),
        CCY_SCALE
    );
}
function moneySub(a, b) {
    return fromScaledBigInt(
        toScaledBigInt(a, CCY_SCALE) - toScaledBigInt(b, CCY_SCALE),
        CCY_SCALE
    );
}
function moneyMulByPercent(money, pctDecimal) {
    // money × (1 + pct) using BigInt, scaled at CCY_SCALE.
    const pctBi = toScaledBigInt(pctDecimal, 6);       // e.g. 0.1570 → 157000n
    const baseBi = toScaledBigInt(money, CCY_SCALE);   // e.g. 10000.00 → 1000000n
    const oneBi = toScaledBigInt('1.000000', 6);
    const mult = oneBi + pctBi;
    // result = base × mult / 10^6, back to CCY_SCALE
    const scaled = (baseBi * mult) / (10n ** 6n);
    return fromScaledBigInt(scaled, CCY_SCALE);
}
function moneyMulPercentOnly(money, pctDecimal) {
    const pctBi = toScaledBigInt(pctDecimal, 6);
    const baseBi = toScaledBigInt(money, CCY_SCALE);
    const scaled = (baseBi * pctBi) / (10n ** 6n);
    return fromScaledBigInt(scaled, CCY_SCALE);
}

// ─── Markup / rate / price ────────────────────────────────────────
async function getMarkup(service, currency) {
    const svc = String(service || '').toLowerCase();
    const cur = String(currency || '').toUpperCase() === 'NGN' ? 'ngn' : 'usd';
    const dualKey = `${svc}_markup_pct_${cur}`;
    const singleKey = `${svc}_markup_pct`;
    const key = KEY_REGISTRY[dualKey] ? dualKey : (KEY_REGISTRY[singleKey] ? singleKey : null);
    if (!key) {
        throw Object.assign(new Error(`No markup configured for service=${svc} currency=${cur}`),
            { status: 400, code: 'MARKUP_NOT_CONFIGURED' });
    }
    const v = await getRaw(key);
    if (!isValidDecimalString(String(v))) {
        throw notReadyError('CONFIG_NOT_READY', `Markup ${key} has an invalid value`, { key });
    }
    if (cmpDecimal(String(v), '0') < 0 || cmpDecimal(String(v), '1') > 0) {
        throw notReadyError('MARKUP_INVALID', `Markup ${key} is out of range: ${v}`, { key });
    }
    return String(v);   // STRING — never a Number
}

async function getRate(sourceCurrency, targetCurrency) {
    const src = String(sourceCurrency || '').toUpperCase();
    const tgt = String(targetCurrency || '').toUpperCase();
    if (src === tgt) return '1.00000000';
    if (src === 'USD' && tgt === 'NGN') {
        const v = await getRaw('usd_to_ngn');
        if (!isValidDecimalString(String(v)) || cmpDecimal(String(v), '0') <= 0) {
            throw notReadyError('RATE_NOT_CONFIGURED', 'usd_to_ngn is not configured', { key: 'usd_to_ngn' });
        }
        return String(v);
    }
    // Deposit rates: USD per 1 unit local
    const depKey = `deposit_rate_${src}`;
    if (tgt === 'USD' && KEY_REGISTRY[depKey]) {
        const v = await getRaw(depKey);
        if (!isValidDecimalString(String(v)) || cmpDecimal(String(v), '0') <= 0) {
            throw notReadyError('RATE_NOT_CONFIGURED', `${depKey} is not configured`, { key: depKey });
        }
        return String(v);
    }
    throw Object.assign(new Error(`Unsupported rate pair: ${src} -> ${tgt}`),
        { status: 400, code: 'RATE_NOT_CONFIGURED' });
}

async function calculatePrice({ service, currency = 'NGN', wholesaleAmount }) {
    if (!service) throw Object.assign(new Error('service is required'), { status: 400, code: 'INVALID_INPUT' });
    if (wholesaleAmount == null) throw Object.assign(new Error('wholesaleAmount is required'), { status: 400, code: 'INVALID_INPUT' });
    if (!isValidDecimalString(String(wholesaleAmount))) {
        throw Object.assign(new Error('wholesaleAmount must be a decimal string'), { status: 400, code: 'INVALID_INPUT' });
    }
    const cur = String(currency).toUpperCase();
    const markup = await getMarkup(service, cur);
    const customerPrice = moneyMulByPercent(String(wholesaleAmount), markup);
    const profit = moneySub(customerPrice, String(wholesaleAmount));
    const version = await getRaw('config_version');
    return {
        service,
        currency: cur,
        wholesaleAmount: String(wholesaleAmount),
        markup,                         // string '0.1570'
        customerPrice,                  // string '11570.00'
        profit,                         // string '1570.00'
        pricingVersion: version != null ? String(version) : null
    };
}

async function getFee(type) {
    const t = String(type || '').toLowerCase();
    if (t !== 'deposit') {
        throw Object.assign(new Error(`Unknown fee type: ${type}`), { status: 400, code: 'INVALID_FEE_TYPE' });
    }
    return {
        flatNgn: await getRaw('deposit_fee_flat_ngn'),   // string
        pct:     await getRaw('deposit_fee_pct'),        // string '0.0000'
        minNgn:  await getRaw('deposit_fee_min_ngn'),
        maxNgn:  await getRaw('deposit_fee_max_ngn')
    };
}

async function getLimit(service, type) {
    const svc = String(service || '').toLowerCase();
    const t = String(type || '').toLowerCase();
    if (t !== 'min' && t !== 'max') {
        throw Object.assign(new Error(`Limit type must be 'min' or 'max'`), { status: 400, code: 'INVALID_LIMIT_TYPE' });
    }
    const key = `${svc}_${t}_ngn`;
    if (!KEY_REGISTRY[key]) {
        throw Object.assign(new Error(`No limit configured for service=${svc} type=${t}`),
            { status: 400, code: 'LIMIT_NOT_CONFIGURED' });
    }
    const v = await getRaw(key);
    if (!isValidDecimalString(String(v))) {
        throw notReadyError('CONFIG_NOT_READY', `${key} has an invalid value`, { key });
    }
    return String(v);
}

// ─── Preview (F.8) — pure decimal strings, no float, no DB write ──
async function preview({ kind, service, currency = 'NGN', amount, feeType = 'deposit' }) {
    if (kind === 'markup') {
        const markup = await getMarkup(service, currency);
        const wholesale = String(amount);
        if (!isValidDecimalString(wholesale)) throw validationError('INVALID_NUMBER', 'amount must be a decimal string');
        const customerPrice = moneyMulByPercent(wholesale, markup);
        const profit = moneySub(customerPrice, wholesale);
        return {
            kind: 'markup',
            service, currency,
            markup,
            wholesaleAmount: wholesale,
            customerPrice,
            profit,
            display: {
                markupPct: percentToDisplay(markup) + '%',
                formula: `${wholesale} × (1 + ${markup}) = ${customerPrice}`
            }
        };
    }
    if (kind === 'rate') {
        // deposit_rate_X: 0.0077 means 1 KES = 0.0077 USD
        const depKey = `deposit_rate_${String(currency).toUpperCase()}`;
        if (!KEY_REGISTRY[depKey]) throw validationError('INVALID_CURRENCY', `No rate for ${currency}`);
        const rate = await getRaw(depKey);
        const local = String(amount);
        if (!isValidDecimalString(local)) throw validationError('INVALID_NUMBER', 'amount must be a decimal string');
        // usd = local × rate
        const usdScaled = (toScaledBigInt(local, 8) * toScaledBigInt(String(rate), 8)) / (10n ** 8n);
        const usd = fromScaledBigInt(usdScaled, 2);
        // inverse rate = 1 / rate, scaled to 4 decimals
        const oneScaled = 10n ** 8n;
        const rateScaled = toScaledBigInt(String(rate), 8);
        const inverse = rateScaled === 0n ? null : (oneScaled * 10000n) / rateScaled;
        return {
            kind: 'rate',
            currency: String(currency).toUpperCase(),
            rate: String(rate),
            localAmount: local,
            usdAmount: usd,
            inverseRate: inverse != null ? (Number(inverse) / 10000).toFixed(4) : null,
            display: {
                forward: `1 USD = ${inverse != null ? (Number(inverse) / 10000).toFixed(4) : '—'} ${String(currency).toUpperCase()}`,
                reverse: `1 ${String(currency).toUpperCase()} = ${rate} USD`
            }
        };
    }
    if (kind === 'fee') {
        const fee = await getFee(feeType);
        const base = String(amount);
        if (!isValidDecimalString(base)) throw validationError('INVALID_NUMBER', 'amount must be a decimal string');
        const pctAmount = moneyMulPercentOnly(base, String(fee.pct));
        let totalFee = moneyAdd(String(fee.flatNgn), pctAmount);
        if (cmpDecimal(totalFee, String(fee.minNgn)) < 0) totalFee = String(fee.minNgn);
        if (cmpDecimal(totalFee, String(fee.maxNgn)) > 0) totalFee = String(fee.maxNgn);
        const net = moneySub(base, totalFee);
        return {
            kind: 'fee',
            feeType,
            baseAmount: base,
            flatNgn: String(fee.flatNgn),
            pct: String(fee.pct),
            pctAmount,
            totalFee,
            netAmount: net,
            display: {
                pctAsPercent: percentToDisplay(String(fee.pct)) + '%',
                formula: `${base} − ${totalFee} = ${net}`
            }
        };
    }
    throw validationError('INVALID_PREVIEW_KIND', 'kind must be one of: markup, rate, fee');
}

// ─── History (fx_rate_history) — paged, permission-filtered ─────
const HISTORY_COLS = [
    'id','key','previous_value','new_value',
    'changed_by','changed_by_email','reason','changed_at'
];

async function getRateHistory({ key = null, limit = 100, offset = 0 } = {}, ctx = null) {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);

    let q = supabaseAdmin
        .from('fx_rate_history')
        .select(HISTORY_COLS.join(','), { count: 'exact' })
        .order('changed_at', { ascending: false })
        .range(off, off + cap - 1);

    if (key) {
        if (!KEY_REGISTRY[key]) {
            throw validationError('UNKNOWN_SETTING_KEY', `Unknown setting key: ${key}`, { key });
        }
        q = q.eq('key', key);
    }

    const { data, error, count } = await q;
    if (error) throw error;

    const rows = (data || []).filter(r =>
        !KEY_REGISTRY[r.key]?.requiredPermission ||
        ctxHasPermission(ctx, KEY_REGISTRY[r.key].requiredPermission)
    );

    // Enrich with admin usernames
    const ids = [...new Set(rows.map(r => r.changed_by).filter(Boolean))];
    const adminsById = {};
    if (ids.length) {
        const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id, username, email')
            .in('id', ids);
        (profiles || []).forEach(p => { adminsById[p.id] = p; });
    }

    return {
        rows: rows.map(r => ({
            ...r,
            changed_by_username: adminsById[r.changed_by]?.username || null,
            changed_by_display:  adminsById[r.changed_by]?.username
                || adminsById[r.changed_by]?.email
                || r.changed_by_email
                || 'Unknown'
        })),
        total: count || rows.length,
        offset: off,
        limit: cap
    };
}

// ─── Audit (settings_audit) — paged, permission-filtered ────────
const AUDIT_COLS = [
    'id','admin_id','admin_email','action','target_type','target_id',
    'before','after','ip_address','user_agent','created_at'
];

async function getAuditPaged({ key = null, adminId = null, from = null, to = null, limit = 100, offset = 0 } = {}, ctx = null) {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);

    let q = supabaseAdmin
        .from('settings_audit')
        .select(AUDIT_COLS.join(','), { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(off, off + cap - 1);

    if (key) q = q.eq('target_id', key);
    if (adminId) q = q.eq('admin_id', adminId);
    if (from) q = q.gte('created_at', from);
    if (to) q = q.lte('created_at', to);

    const { data, error, count } = await q;
    if (error) throw error;

    const rows = (data || []).filter(r =>
        !KEY_REGISTRY[r.target_id]?.requiredPermission ||
        ctxHasPermission(ctx, KEY_REGISTRY[r.target_id].requiredPermission)
    );

    return { rows, total: count || rows.length, offset: off, limit: cap };
}

// CSV export — capped at 5000, audited by the route.
async function exportAuditCsv(filters = {}, ctx = null) {
    const max = 5000;
    const res = await getAuditPaged({ ...filters, limit: max, offset: 0 }, ctx);
    const header = ['created_at','admin_email','action','key','previous_value','new_value','reason','request_id'];
    const lines = [header.join(',')];
    for (const r of res.rows) {
        const prev = r.before && typeof r.before === 'object' ? (r.before.value ?? '') : '';
        const next = r.after  && typeof r.after  === 'object' ? (r.after.value  ?? '') : '';
        lines.push([
            r.created_at,
            r.admin_email || '',
            r.action,
            r.target_id,
            String(prev),
            String(next),
            String(r.reason || ''),
            String(r.id || '')
        ].map(_csvEscape).join(','));
    }
    return lines.join('\n');
}
function _csvEscape(v) {
    const s = String(v == null ? '' : v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

// ─── Restore a historical value ─────────────────────────────────
async function restoreValue({ key, historyId, reason }, ctx = {}) {
    if (!KEY_REGISTRY[key]) throw validationError('UNKNOWN_SETTING_KEY', `Unknown setting key: ${key}`, { key });
    if (!historyId) throw validationError('HISTORY_ID_REQUIRED', 'historyId is required');
    const { data: row, error } = await supabaseAdmin
        .from('fx_rate_history')
        .select('key, previous_value, new_value')
        .eq('id', historyId)
        .maybeSingle();
    if (error) throw error;
    if (!row) throw Object.assign(new Error('History row not found'), { status: 404, code: 'NOT_FOUND' });
    if (row.key !== key) throw validationError('HISTORY_KEY_MISMATCH', 'History row belongs to a different key');
    if (row.new_value == null) throw validationError('HISTORY_VALUE_MISSING', 'History row has no value to restore');

    // Restore means: write the previous_value (the value that existed
    // BEFORE the historical change) as the new value now. This requires
    // the caller to pass the fresh expectedVersion. Reasons and
    // permissions are enforced by patchSettings.
    const patch = { [key]: row.previous_value };
    return patchSettings(patch, { ...ctx, reason: reason || `Restore ${key} from history` }, {
        expectedVersion: ctx.expectedVersion,
        confirmLargeChange: true,
        idempotencyKey: ctx.idempotencyKey || null
    });
}

// ─── Service / provider / emergency gates ───────────────────────
async function isServiceEnabled(service) {
    const entry = SERVICE_REGISTRY[String(service || '').toLowerCase()];
    if (!entry) return false;
    return getBoolean(entry.enabledKey);
}
async function assertServiceEnabled(service) {
    const svc = String(service || '').toLowerCase();
    const entry = SERVICE_REGISTRY[svc];
    if (!entry) throw Object.assign(new Error(`Unknown service: ${svc}`), { status: 400, code: 'UNKNOWN_SERVICE' });
    if (!(await getBoolean(entry.enabledKey))) {
        throw Object.assign(new Error(`${entry.label} is currently unavailable.`),
            { status: 503, code: 'SERVICE_DISABLED', service: svc });
    }
}
async function getServiceStatusAll() {
    const out = {};
    for (const [k, e] of Object.entries(SERVICE_REGISTRY)) {
        out[k] = { key: k, label: e.label, enabled: await getBoolean(e.enabledKey) };
    }
    return out;
}

function isProviderConfigured(providerKey) {
    const e = PROVIDER_REGISTRY[providerKey];
    if (!e) return false;
    return e.secretEnv.every(v => Boolean(process.env[v]));
}
async function isProviderEnabled(provider) {
    const key = String(provider || '').toLowerCase();
    const e = PROVIDER_REGISTRY[key];
    if (!e || !isProviderConfigured(key)) return false;
    return getBoolean(e.enabledKey);
}
async function assertProviderEnabled(provider) {
    const key = String(provider || '').toLowerCase();
    const e = PROVIDER_REGISTRY[key];
    if (!e) throw Object.assign(new Error(`Unknown provider: ${key}`), { status: 400, code: 'UNKNOWN_PROVIDER' });
    if (!isProviderConfigured(key)) {
        throw Object.assign(new Error(`${e.label} is not configured.`),
            { status: 503, code: 'PROVIDER_NOT_CONFIGURED', provider: key });
    }
    if (await getBoolean(e.maintenanceKey)) {
        throw Object.assign(new Error(`${e.label} is in maintenance.`),
            { status: 503, code: 'PROVIDER_MAINTENANCE', provider: key });
    }
    if (!(await getBoolean(e.enabledKey))) {
        throw Object.assign(new Error(`${e.label} is disabled.`),
            { status: 503, code: 'PROVIDER_DISABLED', provider: key });
    }
}
async function getProviderStatusAll() {
    const out = {};
    for (const [key, e] of Object.entries(PROVIDER_REGISTRY)) {
        out[key] = {
            key,
            label:       e.label,
            configured:  isProviderConfigured(key),
            enabled:     await getBoolean(e.enabledKey),
            maintenance: await getBoolean(e.maintenanceKey),
            timeoutMs:   Number(await getRaw(e.timeoutKey)) || null,
            retryCount:  e.retryKey ? Number(await getRaw(e.retryKey)) || null : null
        };
    }
    return out;
}

// F.8 — public status endpoint (no secrets, no raw env values)
async function getProvidersStatus(ctx = null) {
    const out = [];
    for (const [key, e] of Object.entries(PROVIDER_REGISTRY)) {
        out.push({
            key,
            label:       e.label,
            configured:  isProviderConfigured(key),
            enabled:     await getBoolean(e.enabledKey),
            maintenance: await getBoolean(e.maintenanceKey),
            timeoutMs:   Number(await getRaw(e.timeoutKey)) || null,
            retryCount:  e.retryKey ? Number(await getRaw(e.retryKey)) || null : null
        });
    }
    return out;
}

// ─── Emergency operation gates ──────────────────────────────────
const OPERATION_KEYS = Object.freeze({
    deposit:          'emergency_stop_deposits',
    purchase:         'emergency_stop_purchases',
    provider_request: 'emergency_stop_provider_requests',
    wallet_mutation:  'emergency_stop_wallet_mutations'
});

async function isOperationAllowed(operation) {
    const op = String(operation || '').toLowerCase();
    if (op === 'maintenance') return !(await getBoolean('maintenance_mode'));
    // Read-only paths stay open even during an emergency so recovery
    // is possible.
    if (['reconciliation','refund_lookup','provider_status','read'].includes(op)) return true;
    const key = OPERATION_KEYS[op];
    if (!key) return true;
    if (await getBoolean('maintenance_mode')) return false;
    return !(await getBoolean(key));
}
async function assertOperationAllowed(operation) {
    if (await isOperationAllowed(operation)) return;
    const op = String(operation || '').toLowerCase();
    const e = new Error(
        op === 'maintenance'
            ? 'Platform is in maintenance mode.'
            : `Operation '${op}' is currently blocked by an emergency control.`
    );
    e.status = 503; e.code = 'OPERATION_BLOCKED'; e.operation = op;
    throw e;
}

// ─── Timezone helper (shared with dashboard / users pages) ──────
async function getTimezone() {
    const v = await getString('timezone');
    return v || 'Africa/Lagos';
}

// ─── Health ─────────────────────────────────────────────────────
const STALE_RATE_DAYS = Number(process.env.STALE_RATE_DAYS || 7);

async function getHealth() {
    const out = {
        database: 'unknown',
        rates: 'unknown',
        fees: 'unknown',
        services: 'unknown',
        providers: 'unknown',
        version: null,
        checked_at: new Date().toISOString(),
        stale_rates: [],
        missing_keys: []
    };
    try {
        await readRawFromDb();
        out.database = 'ok';
    } catch {
        out.database = 'unavailable';
        return out;
    }
    try {
        const v = await getRaw('usd_to_ngn');
        if (!isValidDecimalString(String(v))) { out.rates = 'invalid'; out.missing_keys.push('usd_to_ngn'); }
        else if (cmpDecimal(String(v), '0') <= 0) out.rates = 'invalid';
        else out.rates = 'configured';
    } catch {
        out.rates = 'missing';
        out.missing_keys.push('usd_to_ngn');
    }
    // Staleness — most recent fx_rate_history row per rate key
    try {
        const rateKeys = [...RATE_KEYS];
        const { data } = await supabaseAdmin
            .from('fx_rate_history')
            .select('key, changed_at')
            .in('key', rateKeys)
            .order('changed_at', { ascending: false })
            .limit(200);
        const latest = {};
        for (const r of data || []) {
            if (!latest[r.key]) latest[r.key] = r.changed_at;
        }
        const cutoff = Date.now() - STALE_RATE_DAYS * 86400 * 1000;
        for (const k of rateKeys) {
            const when = latest[k];
            if (!when) {
                // Never changed since deploy. Not "stale", but flag it.
                continue;
            }
            if (new Date(when).getTime() < cutoff) {
                out.stale_rates.push({ key: k, last_changed: when });
            }
        }
    } catch { /* staleness is best-effort */ }
    try {
        await getFee('deposit');
        out.fees = 'configured';
    } catch { out.fees = 'missing'; }
    try {
        const svc = await getServiceStatusAll();
        out.services = Object.values(svc).some(s => s.enabled) ? 'ok' : 'all-disabled';
    } catch { out.services = 'unknown'; }
    try {
        const prov = await getProviderStatusAll();
        out.providers = Object.values(prov).some(p => p.configured) ? 'partial' : 'none-configured';
    } catch { out.providers = 'unknown'; }
    try {
        const v = await getRaw('config_version');
        out.version = v != null ? Number(v) : null;
    } catch {}
    return out;
}

// ─── Orphan key detection (F.11) ────────────────────────────────
// Logged ONCE at module load so operators know which keys have no
// consumer. Populate via a `consumer` field on KEY_REGISTRY when a
// service actually reads a key.
function _logOrphanKeys() {
    const orphans = Object.entries(KEY_REGISTRY)
        .filter(([, s]) => s.orphan === true)
        .map(([k]) => k);
    if (orphans.length) {
        console.warn('[adminSettings] %d orphan keys (no known consumer):', orphans.length, orphans);
    }
}
_logOrphanKeys();

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════
module.exports = {
    // Registries
    KEY_REGISTRY,
    SECTION_KEYS,
    SERVICE_REGISTRY,
    PROVIDER_REGISTRY,
    ALL_KEYS,
    FINANCIAL_KEYS,
    DANGEROUS_KEYS,
    EMERGENCY_KEYS,
    RATE_KEYS,
    RESET_FORBIDDEN_SECTIONS,
    ALLOWED_CURRENCIES,

    // Validation & strings
    normalize,
    isValidDecimalString,
    cmpDecimal,
    percentToDisplay,
    displayToPercent,
    moneyAdd,
    moneySub,
    moneyMulByPercent,
    moneyMulPercentOnly,

    // Cache
    invalidateCache,

    // Read
    getAllSettings,
    getSettingsBySectionAll,
    getSection,
    getRaw,
    getNumber,
    getBoolean,
    getString,

    // Write
    patchSettings,
    resetSection,
    resetAll,
    restoreValue,

    // Domain helpers
    getMarkup,
    getRate,
    calculatePrice,
    getFee,
    getLimit,
    preview,

    // Service gates
    isServiceEnabled,
    assertServiceEnabled,
    getServiceStatusAll,

    // Provider gates
    isProviderEnabled,
    assertProviderEnabled,
    getProviderStatusAll,
    getProvidersStatus,
    isProviderConfigured,

    // Emergency gates
    isOperationAllowed,
    assertOperationAllowed,

    // History / audit
    getRateHistory,
    getAuditPaged,
    exportAuditCsv,

    // Health / timezone
    getHealth,
    getTimezone
};