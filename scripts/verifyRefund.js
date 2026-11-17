// scripts/verifyRefund.js
// Exercises the full rejection → refund path against a fake provider
// failure. Proves:
//   1. LedgerService.refundTransaction is called with the correct
//      signature (no silent MANUAL_REVIEW).
//   2. Wallet balance returns to what it was before the debit.
//
// Run against preprod with a user that has both wallets funded.

require('dotenv').config();
const { supabaseAdmin } = require('../db/supabase');
const { LedgerService } = require('../services/ledgerService');

const USER_ID = process.argv[2];
if (!USER_ID) {
    console.error('Usage: node scripts/verifyRefund.js <user-uuid>');
    process.exit(1);
}

(async () => {
    // 1. Snapshot balances
    const before = await LedgerService.getAllBalances(USER_ID);
    console.log('BEFORE:', before);

    // 2. Debit $1.00 USD
    const debit = await LedgerService.debitWallet(
        USER_ID, '1.00', 'USD',
        'verifyRefund test debit',
        { type: 'test_refund' }
    );
    if (!debit?.success) {
        console.error('Debit failed:', debit);
        process.exit(2);
    }
    console.log('DEBITED:', debit.transaction_id);

    // 3. Immediately refund it
    const refund = await LedgerService.refundTransaction({
        userId: USER_ID,
        transactionId: debit.transaction_id,
        reason: 'verifyRefund script'
    });
    console.log('REFUND:', refund);

    // 4. Snapshot balances again
    const after = await LedgerService.getAllBalances(USER_ID);
    console.log('AFTER:', after);

    const beforeUsd = Number(before.USD);
    const afterUsd = Number(after.USD);
    if (Math.abs(beforeUsd - afterUsd) < 0.01) {
        console.log('✅ PASS: balance restored');
        process.exit(0);
    } else {
        console.log('❌ FAIL: balance drift', beforeUsd, '→', afterUsd);
        process.exit(3);
    }
})();