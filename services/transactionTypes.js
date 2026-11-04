'use strict';

// services/transactionTypes.js
// ─────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for transaction types.
//
// Every layer that names a transaction type — the ledger, refund
// service, admin service, route layer, and the UI's type filter —
// must import from here. Adding a new service that debits or credits
// a wallet means adding it HERE, once.
//
// The list matches what ledgerService.TYPE_DIRECTION writes. If you
// add a type to TYPE_DIRECTION, add it here too; Batch 3 asserts
// consistency at boot.
// ─────────────────────────────────────────────────────────────────

const TYPES = Object.freeze([
    // Credits
    { key: 'deposit',                  label: 'Deposit',            direction: 'credit', group: 'funding',       refundable: 'provider_or_reversal' },
    { key: 'wallet_credit',            label: 'Wallet credit',       direction: 'credit', group: 'funding',       refundable: false },
    { key: 'refund',                   label: 'Refund',              direction: 'credit', group: 'funding',       refundable: false },
    { key: 'fee_revenue',              label: 'Fee revenue',         direction: 'credit', group: 'system',        refundable: false },

    // Debits — wallet
    { key: 'wallet_debit',             label: 'Wallet debit',        direction: 'debit',  group: 'wallet',        refundable: 'wallet' },
    { key: 'withdrawal',               label: 'Withdrawal',          direction: 'debit',  group: 'wallet',        refundable: false },
    { key: 'reversal',                 label: 'Reversal',            direction: 'debit',  group: 'system',        refundable: false },

    // Debits — services
    { key: 'airtime_purchase',         label: 'Airtime',             direction: 'debit',  group: 'airtime',       refundable: 'wallet' },
    { key: 'data_purchase',            label: 'Data',                direction: 'debit',  group: 'data',          refundable: 'wallet' },
    { key: 'giftcard_purchase',        label: 'Gift Card',           direction: 'debit',  group: 'gift_cards',    refundable: 'wallet' },
    { key: 'gift_card_purchase',       label: 'Gift Card',           direction: 'debit',  group: 'gift_cards',    refundable: 'wallet' },
    { key: 'esim_purchase',            label: 'eSIM',                direction: 'debit',  group: 'esim',          refundable: 'wallet' },
    { key: 'boost_purchase',           label: 'Boost',               direction: 'debit',  group: 'boost',         refundable: 'wallet' },
    { key: 'virtual_number_purchase',  label: 'Virtual SMS',         direction: 'debit',  group: 'virtual_sms',   refundable: 'wallet' },
    { key: 'virtual_sms_purchase',     label: 'Virtual SMS',         direction: 'debit',  group: 'virtual_sms',   refundable: 'wallet' },
    { key: 'sms_purchase',             label: 'Virtual SMS',         direction: 'debit',  group: 'virtual_sms',   refundable: 'wallet' },
    { key: 'bills_purchase',           label: 'Bills & Utilities',   direction: 'debit',  group: 'bills',         refundable: 'wallet' },
    { key: 'bill_purchase',            label: 'Bills & Utilities',   direction: 'debit',  group: 'bills',         refundable: 'wallet' },
    { key: 'marketplace_purchase',     label: 'Marketplace',         direction: 'debit',  group: 'marketplace',   refundable: 'wallet' },

    // Bidirectional (adjustment sign is caller's decision)
    { key: 'adjustment',               label: 'Adjustment',          direction: 'both',   group: 'system',        refundable: false },
    { key: 'admin_adjustment',         label: 'Adjustment',          direction: 'both',   group: 'system',        refundable: false }
]);

const TYPES_BY_KEY = new Map(TYPES.map(t => [t.key, t]));

// Categories the UI can group by.
const GROUPS = Object.freeze([
    { key: 'funding',      label: 'Funding' },
    { key: 'wallet',       label: 'Wallet' },
    { key: 'airtime',      label: 'Airtime' },
    { key: 'data',         label: 'Data' },
    { key: 'gift_cards',   label: 'Gift Cards' },
    { key: 'esim',         label: 'eSIM' },
    { key: 'boost',        label: 'Boost' },
    { key: 'virtual_sms',  label: 'Virtual SMS' },
    { key: 'bills',        label: 'Bills & Utilities' },
    { key: 'marketplace',  label: 'Marketplace' },
    { key: 'system',       label: 'System' }
]);

const ALL_KEYS = new Set(TYPES.map(t => t.key));

function isValidType(key) {
    return ALL_KEYS.has(String(key || '').toLowerCase());
}

function getType(key) {
    return TYPES_BY_KEY.get(String(key || '').toLowerCase()) || null;
}

function getRefundableTypes(method) {
    // method: 'wallet' | 'provider' | 'reversal'
    if (method === 'wallet') {
        return TYPES.filter(t => t.refundable === 'wallet').map(t => t.key);
    }
    if (method === 'provider') {
        return TYPES.filter(t => t.refundable === 'provider_or_reversal').map(t => t.key);
    }
    if (method === 'reversal') {
        return TYPES.filter(t => t.refundable === 'provider_or_reversal').map(t => t.key);
    }
    return [];
}

function isRefundable(key, method) {
    const t = getType(key);
    if (!t) return false;
    if (method === 'wallet')   return t.refundable === 'wallet';
    if (method === 'provider') return t.refundable === 'provider_or_reversal';
    if (method === 'reversal') return t.refundable === 'provider_or_reversal';
    return false;
}

function prettyLabel(key) {
    const t = getType(key);
    return t ? t.label : (key ? String(key).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '—');
}

function directionOf(key) {
    const t = getType(key);
    return t ? t.direction : 'debit';
}

// Public API for the /transactions/types endpoint.
function publicList() {
    return {
        groups: GROUPS.map(g => ({ ...g })),
        types: TYPES.map(t => ({
            key: t.key,
            label: t.label,
            direction: t.direction,
            group: t.group,
            refundable: t.refundable
        }))
    };
}

module.exports = {
    TYPES,
    TYPES_BY_KEY,
    GROUPS,
    ALL_KEYS,
    isValidType,
    getType,
    getRefundableTypes,
    isRefundable,
    prettyLabel,
    directionOf,
    publicList
};