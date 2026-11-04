// reconciliation/adapters/index.js
'use strict';

const adapters = {
    kora:         require('./kora'),
    nowpayments:  require('./nowpayments'),
    airtime:      require('./airtime'),
    bills:        require('./bills'),
    esim:         require('./esim'),
    giftcard:     require('./giftcard')
};

function getAdapter(key) {
    const a = adapters[key];
    if (!a) {
        const e = new Error(`Unknown reconciliation service: ${key}`);
        e.status = 400;
        e.code = 'UNKNOWN_SERVICE';
        throw e;
    }
    return a;
}

function listAdapters() {
    return Object.values(adapters).map(a => ({
        key: a.key,
        provider: a.provider,
        table: a.table
    }));
}

module.exports = { adapters, getAdapter, listAdapters };