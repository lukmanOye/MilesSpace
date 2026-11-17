// scripts/verifyProduct.js <productId>
// Prints env, HTTP status, and (redacted) body for GET /products/{id}.

require('dotenv').config();
const dtoneService = require('../services/dtoneService');
const { redactForLog } = dtoneService;

const id = process.argv[2];
if (!id || !/^\d+$/.test(id)) {
    console.error('Usage: node scripts/verifyProduct.js <numeric productId>');
    process.exit(1);
}

(async () => {
    const env = process.env.DTONE_ENV || '(unset)';
    console.log(`env=${env} productId=${id}`);
    try {
        const product = await dtoneService.getProductById(id);
        console.log('HTTP 200');
        console.log(JSON.stringify(redactForLog(product), null, 2));
        process.exit(0);
    } catch (e) {
        console.log('HTTP', e.response?.status || '(none)');
        console.log(JSON.stringify(redactForLog(e.response?.data || { message: e.message }), null, 2));
        process.exit(2);
    }
})();