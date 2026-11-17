// services/airtimeProviders/vtpassAdapter.js
// Thin wrapper over vtpassService. No own axios, no module-load env.
'use strict';

const vtpassService = require('../vtpassService');
const { AirTimeProviderError } = require('./airtimeProviderInterface');

const NAME = 'vtpass';

// VTpass network code map — MUST be `mtn|airtel|glo|etisalat`, NOT
// `mtn-airtime`, when sent to /pay. The service ID map inside
// vtpassService handles that internally.
const NETWORK_MAP = {
    mtn: 'mtn',
    airtel: 'airtel',
    glo: 'glo',
    '9mobile': 'etisalat',
    etisalat: 'etisalat'
};

function normalizeNetwork(code) {
    const c = String(code || '').toLowerCase().replace(/-airtime$/, '');
    return NETWORK_MAP[c] || c;
}

async function purchase({ order, attempt }) {
    if (!order.phone_number) {
        throw new AirTimeProviderError('Missing phone_number.', { code: 'MISSING_PHONE' });
    }
    const network = normalizeNetwork(order.network_code || order.network);
    if (!network) {
        throw new AirTimeProviderError('Missing network_code.', { code: 'MISSING_NETWORK' });
    }
    const amount = Number(order.wholesale_amount || order.base_amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new AirTimeProviderError('Invalid amount.', { code: 'INVALID_AMOUNT' });
    }

    // MUST use a valid VTpass request_id. 'VTP-<ref>' is rejected.
    const requestId = attempt?.provider_reference || vtpassService.generateRequestId();

    const result = await vtpassService.purchaseAirtime({
        phone: order.phone_number,
        network,
        amount
    });

    if (result.state === 'failed') {
        throw new AirTimeProviderError(
            result.error || 'VTpass rejected the purchase',
            {
                code: `VTPASS_${result.code || 'REJECTED'}`,
                definitiveRejection: true,
                providerData: result.data || null
            }
        );
    }

    return {
        providerTransactionId: String(result.transactionId || ''),
        providerReference:     String(result.requestId || requestId),
        providerStatus:        String(result.providerStatus || 'PENDING').toUpperCase(),
        statusClassId:         null,
        statusId:              null,
        rawResponse:           result.data || null
    };
}

async function getStatus({ providerTransactionId, providerReference }) {
    const requestId = providerReference || providerTransactionId;
    if (!requestId) {
        return {
            classification: 'UNKNOWN',
            providerStatus: 'NO_REFERENCE',
            statusClassId: null,
            statusId: null,
            providerTransactionId: null,
            rawResponse: null
        };
    }

    const result = await vtpassService.queryTransaction(requestId);
    const state = result.state || 'processing';
    const statusUpper = String(result.providerStatus || '').toUpperCase();

    if (state === 'completed') {
        return {
            classification: 'CONFIRMED_FULFILLED',
            providerStatus: statusUpper || 'DELIVERED',
            statusClassId: null,
            statusId: null,
            providerTransactionId: String(result.transactionId || requestId),
            rawResponse: result.data || null
        };
    }
    if (state === 'failed') {
        return {
            classification: 'CONFIRMED_NOT_FULFILLED',
            providerStatus: statusUpper || 'FAILED',
            statusClassId: null,
            statusId: null,
            providerTransactionId: String(result.transactionId || requestId),
            rawResponse: result.data || null
        };
    }
    return {
        classification: 'UNKNOWN',
        providerStatus: statusUpper || 'UNKNOWN',
        statusClassId: null,
        statusId: null,
        providerTransactionId: String(result.transactionId || requestId),
        rawResponse: result.data || null
    };
}

async function getProducts({ countryIso3 }) {
    const country = String(countryIso3 || '').toUpperCase();
    if (country !== 'NGA') {
        throw new AirTimeProviderError(`VTpass only serves Nigeria (got ${countryIso3}).`, {
            code: 'UNSUPPORTED_COUNTRY'
        });
    }
    return [
        { providerProductId: 'mtn',     brand: 'MTN',      networkCode: 'mtn',      countryIso3: country, faceValue: null, faceCurrency: 'NGN', wholesaleAmount: null, wholesaleCurrency: 'NGN', description: 'MTN Airtime', productMode: 'RANGED_SOURCE', operatorId: null },
        { providerProductId: 'airtel',  brand: 'Airtel',   networkCode: 'airtel',   countryIso3: country, faceValue: null, faceCurrency: 'NGN', wholesaleAmount: null, wholesaleCurrency: 'NGN', description: 'Airtel Airtime', productMode: 'RANGED_SOURCE', operatorId: null },
        { providerProductId: 'glo',     brand: 'Glo',      networkCode: 'glo',      countryIso3: country, faceValue: null, faceCurrency: 'NGN', wholesaleAmount: null, wholesaleCurrency: 'NGN', description: 'Glo Airtime', productMode: 'RANGED_SOURCE', operatorId: null },
        { providerProductId: 'etisalat', brand: '9mobile', networkCode: 'etisalat', countryIso3: country, faceValue: null, faceCurrency: 'NGN', wholesaleAmount: null, wholesaleCurrency: 'NGN', description: '9mobile Airtime', productMode: 'RANGED_SOURCE', operatorId: null }
    ];
}

async function healthCheck() {
    if (!vtpassService.isConfigured()) {
        return { configured: false, reachable: false, balance: null, lastError: 'Missing credentials' };
    }
    const bal = await vtpassService.getBalance();
    return {
        configured: true,
        reachable: bal.success,
        balance: bal.balance ?? null,
        lastError: bal.success ? null : (bal.error || 'Unknown')
    };
}

module.exports = { name: NAME, purchase, getStatus, getProducts, healthCheck };