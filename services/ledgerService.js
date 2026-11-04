'use strict';

// services/ledgerService.js
// ─────────────────────────────────────────────────────────────────
// REVISION 2026-11-03 (Batch 2)
//
// Changes from the previous revision:
//   • TYPE_DIRECTION now includes 'reversal': 'debit'. Without it,
//     LedgerService.debitWallet({ type: 'reversal' }) throws
//     "unknown or retired transaction type" — which is what every
//     deposit reversal was doing. Reversals now work.
//   • getTransactionById now also selects metadata, provider and
//     provider_reference so the legacy debit-direction logic in
//     refundTransaction can read metadata.direction. Previously it
//     never could because those columns were not selected.
//   • Added findTransactionByReference() — a small helper used by
//     refundService's timeout recovery to look up whether the
//     ledger call succeeded before the caller threw.
//   • refundTransaction and the admin refund path share ONE rule:
//     dedup on the DETERMINISTIC ledger reference.
//     Admin reference: `REFUND-{originalId}-{refundId}`.
//     Auto reference:  `REFUND-{original.reference}`.
//     Both are checked, so an admin cannot double-refund an
//     auto-refunded row (and vice-versa).
//     `_checkExistingRefundByLedgerRef()` encapsulates the check.
//   • No behavior change for any other caller. All existing methods
//     keep their signatures and return shapes.
// ─────────────────────────────────────────────────────────────────

const { supabaseAdmin } = require('../db/supabase');
const crypto = require('crypto');
const IdempotencyService = require('./idempotencyService');

const DEFAULT_CURRENCY = 'NGN';
const SUPPORTED_CURRENCIES = new Set(['NGN', 'USD']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── TYPE_DIRECTION — authoritative ─────────────────────────────
// Every type that createTransaction may write must appear here.
// 'reversal' is NEW in this batch. It is a debit — reversing a
// deposit debits the customer's wallet.
const TYPE_DIRECTION = {
    // Credits
    deposit:                 'credit',
    wallet_credit:           'credit',
    refund:                  'credit',
    fee_revenue:             'credit',

    // Debits
    wallet_debit:            'debit',
    withdrawal:              'debit',
    reversal:                'debit',           // ← NEW
    marketplace_purchase:    'debit',

    // Service purchases (all debit)
    airtime_purchase:        'debit',
    data_purchase:           'debit',
    giftcard_purchase:       'debit',
    gift_card_purchase:      'debit',           // legacy alias
    esim_purchase:           'debit',
    boost_purchase:          'debit',
    virtual_number_purchase: 'debit',
    virtual_sms_purchase:    'debit',           // alias
    sms_purchase:            'debit',           // alias
    bills_purchase:          'debit',           // alias
    bill_purchase:           'debit',           // alias

    // Adjustment is bidirectional — caller decides sign
    adjustment:              'both',
    admin_adjustment:        'both'
};

// Retired types. Never writable. Exist so a legacy row with one of
// these types can still be read without createTransaction
// misclassifying it.
const HISTORICAL_TYPES = new Set(['cashback_redeem', 'cashback']);

const ACCOUNT_COLUMNS = 'id, user_id, currency, available_balance, held_balance, created_at, updated_at';
const ENTRY_COLUMNS = 'id, account_id, transaction_id, entry_type, amount_minor, currency, balance_before, balance_after, description, created_at';
const TX_COLUMNS_MIN = 'id, user_id, type, status, currency, amount, reference, source_type, source_id, created_at, completed_at';
const TX_COLUMNS_VERIFY = 'id, user_id, type, status, currency, amount, reference, source_type, source_id, provider, provider_reference, created_at, completed_at, metadata';

function round2(n) {
    return Math.round(Number(n) * 100) / 100;
}

function assertPrecision(amount, currency) {
    const rounded = round2(amount);
    if (Math.abs(rounded - Number(amount)) > 1e-6) {
        throw new Error(`createTransaction: amount ${amount} has more precision than ${currency} supports`);
    }
    return rounded;
}

class LedgerService {

    // ─── Account ────────────────────────────────────────────────
    static async getOrCreateAccount(userId, currency = DEFAULT_CURRENCY) {
        if (!UUID_RE.test(String(userId || ''))) {
            throw new Error('getOrCreateAccount: userId must be a UUID');
        }
        const ccy = String(currency).toUpperCase();
        if (!SUPPORTED_CURRENCIES.has(ccy)) {
            throw new Error(`getOrCreateAccount: unsupported currency ${ccy}`);
        }

        const { data: account, error: readErr } = await supabaseAdmin
            .from('ledger_accounts')
            .select(ACCOUNT_COLUMNS)
            .eq('user_id', userId)
            .eq('currency', ccy)
            .maybeSingle();

        if (readErr) throw new Error(`Failed to read ledger account: ${readErr.message}`);
        if (account) return account;

        const { data: newAccount, error: insertErr } = await supabaseAdmin
            .from('ledger_accounts')
            .insert({ user_id: userId, currency: ccy, available_balance: 0, held_balance: 0 })
            .select(ACCOUNT_COLUMNS)
            .single();

        if (insertErr) {
            if (insertErr.code === '23505') {
                const { data: reread, error: reErr } = await supabaseAdmin
                    .from('ledger_accounts')
                    .select(ACCOUNT_COLUMNS)
                    .eq('user_id', userId)
                    .eq('currency', ccy)
                    .maybeSingle();
                if (reErr) throw new Error(`Failed to reread ledger account: ${reErr.message}`);
                if (reread) return reread;
            }
            throw new Error(`Failed to create ledger account: ${insertErr.message}`);
        }
        return newAccount;
    }

    static async getBalance(userId, currency = DEFAULT_CURRENCY) {
        const account = await this.getOrCreateAccount(userId, currency);
        return parseFloat(account.available_balance) || 0;
    }

    static async getAllBalances(userId) {
        if (!UUID_RE.test(String(userId || ''))) {
            throw new Error('getAllBalances: userId must be a UUID');
        }
        const { data, error } = await supabaseAdmin
            .from('ledger_accounts')
            .select('currency, available_balance, held_balance')
            .eq('user_id', userId);
        if (error) throw new Error(`Failed to load balances: ${error.message}`);

        const balances = { NGN: 0, USD: 0 };
        (data || []).forEach(a => {
            const ccy = String(a.currency || '').toUpperCase();
            if (ccy === 'NGN' || ccy === 'USD') {
                balances[ccy] = parseFloat(a.available_balance) || 0;
            }
        });
        return balances;
    }

    // ─── Core transaction writer ────────────────────────────────
    static async createTransaction({
        userId, type, amount, currency = DEFAULT_CURRENCY, description = '',
        reference = null, sourceType = null, sourceId = null,
        provider = null, providerReference = null,
        metadata = {}, idempotencyKey = null
    }) {
        if (!UUID_RE.test(String(userId || ''))) {
            throw new Error('createTransaction: userId must be a UUID');
        }
        const ccy = String(currency).toUpperCase();
        if (!SUPPORTED_CURRENCIES.has(ccy)) {
            throw new Error(`createTransaction: unsupported currency ${ccy}`);
        }

        if (HISTORICAL_TYPES.has(String(type))) {
            throw new Error(`createTransaction: "${type}" is retired and cannot be created`);
        }

        const rawAmount = parseFloat(amount);
        if (!Number.isFinite(rawAmount) || rawAmount === 0) {
            throw new Error('createTransaction: amount must be a non-zero finite number');
        }
        const amountNum = assertPrecision(Math.abs(rawAmount), ccy);

        const direction = rawAmount > 0 ? 'credit' : 'debit';
        const expectedDirection = TYPE_DIRECTION[type];
        if (!expectedDirection) {
            throw new Error(`createTransaction: unknown or retired transaction type "${type}"`);
        }
        if (expectedDirection !== 'both' && expectedDirection !== direction) {
            throw new Error(`createTransaction: type "${type}" must be ${expectedDirection}, got ${direction}`);
        }

        if (!reference) {
            const prefix = (type || 'TXN').substring(0, 3).toUpperCase();
            const ts = Date.now().toString(36).toUpperCase();
            const rnd = crypto.randomBytes(4).toString('hex').toUpperCase();
            reference = `${prefix}-${ts}-${rnd}`;
        }

        // ── Idempotency claim ───────────────────────────────────
        if (idempotencyKey) {
            const existing = await IdempotencyService.check(userId, idempotencyKey, 'transaction');
            if (existing && !existing.__in_flight) return existing;

            const claimed = await IdempotencyService.claim(
                userId, idempotencyKey, 'transaction',
                { type, amount: amountNum, currency: ccy, reference }
            );
            if (!claimed) {
                const inFlight = await IdempotencyService.check(userId, idempotencyKey, 'transaction');
                if (inFlight && !inFlight.__in_flight) return inFlight;
                throw new Error('Duplicate transaction in progress for this idempotency key');
            }
        }

        // ── Account ─────────────────────────────────────────────
        let account;
        try {
            account = await this.getOrCreateAccount(userId, ccy);
        } catch (acctErr) {
            if (idempotencyKey) {
                await IdempotencyService.release(userId, idempotencyKey, 'transaction').catch(() => {});
            }
            throw acctErr;
        }

        const nowIso = new Date().toISOString();

        const transactionData = {
            user_id: userId,
            reference,
            type,
            status: 'completed',
            currency: ccy,
            amount: rawAmount > 0 ? amountNum : -amountNum,
            description: description || type,
            source_type: sourceType,
            source_id: sourceId,
            provider,
            provider_reference: providerReference,
            metadata: { ...metadata, direction, currency_type: ccy },
            created_at: nowIso,
            updated_at: nowIso,
            completed_at: nowIso
        };

        // ── RPC ─────────────────────────────────────────────────
        const { data: result, error } = await supabaseAdmin.rpc('process_transaction_v2', {
            p_user_id:          userId,
            p_account_id:       account.id,
            p_transaction_data: transactionData,
            p_entry_type:       direction === 'credit' ? 'CREDIT' : 'DEBIT',
            p_amount:           amountNum,
            p_currency:         ccy
        });

        if (error) {
            if (idempotencyKey) {
                await IdempotencyService.release(userId, idempotencyKey, 'transaction').catch(() => {});
            }

            if (error.code === '23505') {
                const existingTx = await this.getTransactionByReferenceForVerification(reference);
                if (!existingTx) {
                    throw new Error(`Transaction failed: 23505 but no row found for reference ${reference}`);
                }
                const sameUser        = String(existingTx.user_id) === String(userId);
                const sameType        = String(existingTx.type) === String(type);
                const sameCurrency    = String(existingTx.currency).toUpperCase() === ccy;
                const sameAmount      = Math.abs(parseFloat(existingTx.amount) - amountNum) < 0.005;
                const sameSourceType  = String(existingTx.source_type || '') === String(sourceType || '');
                const sameSourceId    = String(existingTx.source_id || '') === String(sourceId || '');
                const sameProviderRef = String(existingTx.provider_reference || '') === String(providerReference || '');

                if (!sameUser || !sameType || !sameCurrency || !sameAmount ||
                    !sameSourceType || !sameSourceId || !sameProviderRef) {
                    throw new Error(
                        `Transaction failed: reference ${reference} exists but does not match the intended operation.`
                    );
                }
                return {
                    success: true,
                    already_exists: true,
                    transaction_id: existingTx.id,
                    reference,
                    amount: amountNum,
                    currency: ccy
                };
            }

            throw new Error(`Transaction failed: ${error.message}`);
        }

        // ── Success ─────────────────────────────────────────────
        const payload = Array.isArray(result) ? result[0] : result;
        let transactionId = payload?.transaction_id || payload?.id || null;

        if (!transactionId) {
            const recovered = await this.getTransactionByReferenceForVerification(reference);
            transactionId = recovered?.id || null;
            if (!transactionId) {
                if (idempotencyKey) {
                    await IdempotencyService.release(userId, idempotencyKey, 'transaction').catch(() => {});
                }
                throw new Error(`Transaction failed: RPC returned no transaction_id for ${reference}`);
            }
        }

        const finalResponse = {
            success: true,
            transaction_id: transactionId,
            reference,
            amount: amountNum,
            currency: ccy,
            balance_before: payload?.balance_before ?? null,
            balance_after:  payload?.balance_after  ?? null,
            entry_type: direction === 'credit' ? 'CREDIT' : 'DEBIT'
        };

        if (idempotencyKey) {
            try {
                await IdempotencyService.save(userId, idempotencyKey, 'transaction', finalResponse);
            } catch (saveErr) {
                console.error('[LEDGER] idempotency save failed after ledger write', {
                    userId, idempotencyKey, reference, transactionId,
                    error: saveErr.message
                });
            }
        }

        return finalResponse;
    }

    // ─── Wallet credit / debit helpers ──────────────────────────
    static async creditWallet(...args) {
        const o = this._normalizeWalletArgs(args, 'credit');
        return await this.createTransaction({
            userId: o.userId, type: o.type || 'wallet_credit', amount: Math.abs(o.amount),
            currency: o.currency, description: o.description, reference: o.reference,
            sourceType: o.sourceType, sourceId: o.sourceId, provider: o.provider || null,
            providerReference: o.providerReference || null, metadata: o.metadata,
            idempotencyKey: o.idempotencyKey || null
        });
    }

    static async debitWallet(...args) {
        const o = this._normalizeWalletArgs(args, 'debit');
        return await this.createTransaction({
            userId: o.userId, type: o.type || 'wallet_debit', amount: -Math.abs(o.amount),
            currency: o.currency, description: o.description, reference: o.reference,
            sourceType: o.sourceType, sourceId: o.sourceId, provider: o.provider || null,
            providerReference: o.providerReference || null, metadata: o.metadata,
            idempotencyKey: o.idempotencyKey || null
        });
    }

    static _normalizeWalletArgs(args, action) {
        const first = args[0];
        if (first && typeof first === 'object' && 'userId' in first) {
            const o = first;
            const amount = parseFloat(o.amount);
            if (!o.userId || typeof o.userId !== 'string') {
                throw new Error(`${action}Wallet: missing or invalid userId`);
            }
            if (!Number.isFinite(amount) || amount <= 0) {
                throw new Error(`${action}Wallet: invalid amount (${o.amount})`);
            }
            return {
                userId: o.userId, amount, currency: o.currency || DEFAULT_CURRENCY,
                description: o.description || (action === 'credit' ? 'Wallet credit' : 'Wallet debit'),
                reference: o.reference || null,
                sourceType: o.sourceType || null, sourceId: o.sourceId || null,
                provider: o.provider || null, providerReference: o.providerReference || null,
                metadata: o.metadata || {},
                type: o.type || (action === 'credit' ? 'wallet_credit' : 'wallet_debit'),
                idempotencyKey: o.idempotencyKey || null
            };
        }
        const [userId, amount, currency, description, metadata] = args;
        if (!userId || typeof userId !== 'string') throw new Error(`${action}Wallet: missing or invalid userId`);
        const n = parseFloat(amount);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`${action}Wallet: invalid amount (${amount})`);
        return {
            userId, amount: n, currency: currency || DEFAULT_CURRENCY,
            description: description || (action === 'credit' ? 'Wallet credit' : 'Wallet debit'),
            reference: null, sourceType: null, sourceId: null,
            provider: null, providerReference: null,
            metadata: metadata || {},
            type: action === 'credit' ? 'wallet_credit' : 'wallet_debit',
            idempotencyKey: null
        };
    }

    // ─── Reads ──────────────────────────────────────────────────
    static async getTransactionHistory(userId, limit = 50, offset = 0, filters = {}) {
        const safeLimit  = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

        let q = supabaseAdmin
            .from('transactions')
            .select(TX_COLUMNS_MIN, { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        if (filters.type) q = q.eq('type', filters.type);
        if (filters.status) q = q.eq('status', filters.status);
        if (filters.currency) q = q.eq('currency', filters.currency);
        const { data, error, count } = await q.range(safeOffset, safeOffset + safeLimit - 1);
        if (error) throw error;
        return { transactions: data || [], total: count || 0 };
    }

    static async getTransactionByReference(reference) {
        const { data, error } = await supabaseAdmin
            .from('transactions').select(TX_COLUMNS_MIN).eq('reference', reference).maybeSingle();
        if (error) throw new Error(`getTransactionByReference failed: ${error.message}`);
        return data || null;
    }

    static async getTransactionByReferenceForVerification(reference) {
        const { data, error } = await supabaseAdmin
            .from('transactions').select(TX_COLUMNS_VERIFY).eq('reference', reference).maybeSingle();
        if (error) throw new Error(`getTransactionByReferenceForVerification failed: ${error.message}`);
        return data || null;
    }

    /**
     * NEW (Batch 2): Look up a transaction by its reference. Returns
     * null on miss — never throws. Used by the refund-timeout
     * recovery to check whether the ledger call actually committed
     * before the caller's promise rejected.
     */
    static async findTransactionByReference(reference) {
        if (!reference) return null;
        try {
            const { data, error } = await supabaseAdmin
                .from('transactions')
                .select(TX_COLUMNS_VERIFY)
                .eq('reference', reference)
                .limit(1)
                .maybeSingle();
            if (error) return null;
            return data || null;
        } catch (_) {
            return null;
        }
    }

    static async getTransactionById(id) {
        // Batch 2: also select metadata, provider, provider_reference.
        // refundTransaction's legacy-debit detection reads
        // metadata.direction — which was null before this fix.
        const { data, error } = await supabaseAdmin
            .from('transactions')
            .select(TX_COLUMNS_VERIFY)
            .eq('id', id)
            .maybeSingle();
        if (error) throw new Error(`getTransactionById failed: ${error.message}`);
        return data || null;
    }

    static async getLedgerEntriesByTransaction(transactionId) {
        if (!UUID_RE.test(String(transactionId || ''))) return [];
        const { data, error } = await supabaseAdmin
            .from('ledger_entries').select(ENTRY_COLUMNS)
            .eq('transaction_id', transactionId).order('created_at', { ascending: true });
        if (error) throw new Error(error.message);
        return data || [];
    }

    // ─── Auto refund (bills and other services) ────────────────
    // Guarantees:
    //   • Only debits may be refunded.
    //   • Deterministic reference `REFUND-{original.reference}`
    //     means a retry short-circuits on the unique index.
    //   • Before creating a new ledger refund, checks the refunds
    //     table for a match by original_transaction_id — this is the
    //     SAME rule the admin path uses, so no double refunds.
    static async refundTransaction({
        userId,
        transactionId,
        reason = 'Refund',
        reference = null,
        idempotencyKey = null
    }) {
        if (!UUID_RE.test(String(userId || ''))) {
            throw new Error('refundTransaction: userId must be a UUID');
        }
        if (!UUID_RE.test(String(transactionId || ''))) {
            throw new Error('refundTransaction: transactionId must be a UUID');
        }

        const original = await this.getTransactionById(transactionId);
        if (!original) {
            throw new Error(`refundTransaction: transaction ${transactionId} not found`);
        }
        if (String(original.user_id) !== String(userId)) {
            throw new Error('refundTransaction: transaction does not belong to this user');
        }

        // Determine debit-ness. `amount` is signed in newer rows.
        // Legacy rows may be unsigned but have metadata.direction.
        const rawAmount = parseFloat(original.amount) || 0;
        const metaDirection = String(original.metadata?.direction || '').toLowerCase();
        const isDebit =
            rawAmount < 0 ||
            metaDirection === 'debit' ||
            String(original.type || '').endsWith('_purchase') ||
            String(original.type || '') === 'wallet_debit' ||
            String(original.type || '') === 'withdrawal' ||
            String(original.type || '') === 'reversal';

        if (!isDebit) {
            throw new Error(
                `refundTransaction: transaction ${transactionId} is not a debit ` +
                `(amount=${original.amount}, direction=${metaDirection || 'unknown'}, type=${original.type})`
            );
        }

        // ── Shared dedupe rule (Batch 2) ────────────────────────
        // 1. If the refunds table already has an active row for this
        //    original, bail with a clear error. Admin-created
        //    refunds write there; auto refunds do too (new behavior
        //    in this batch — the previous auto path did not).
        const existingFromAdmin = await this._findActiveRefundRow(transactionId);
        if (existingFromAdmin) {
            return {
                success: true,
                already_exists: true,
                transaction_id: existingFromAdmin.refund_transaction_id || null,
                reference: existingFromAdmin.provider_reference || null,
                amount: Math.abs(parseFloat(existingFromAdmin.amount) || 0),
                currency: existingFromAdmin.currency
            };
        }

        // 2. Deterministic ledger reference — same on every retry.
        const refundRef = reference || `REFUND-${original.reference}`;

        // 3. Ledger row already exists?
        const existingLedgerRow = await this.findTransactionByReference(refundRef);
        if (existingLedgerRow) {
            // Ensure it is recorded in the refunds table too (forward
            // fix — backfill missing admin-path rows lazily). If the
            // insert fails for a non-23505 reason, log but do not
            // fail: the money moved, the row is discoverable by
            // reference.
            try {
                await supabaseAdmin.from('refunds').insert({
                    original_transaction_id: transactionId,
                    refund_transaction_id: existingLedgerRow.id,
                    user_id: userId,
                    refund_type: 'wallet',
                    refund_method: 'wallet',
                    amount: Math.abs(parseFloat(original.amount) || 0),
                    currency: original.currency || DEFAULT_CURRENCY,
                    reason,
                    status: 'COMPLETED',
                    completed_at: existingLedgerRow.completed_at || new Date().toISOString(),
                    idempotency_key: `auto:${existingLedgerRow.id}`,
                    metadata: { source: 'auto_refund_recovered', reference: refundRef }
                }).onConflict ? null : null;
            } catch (_) {
                // Duplicate key or missing table — harmless either way.
            }
            return {
                success: true,
                already_exists: true,
                transaction_id: existingLedgerRow.id,
                reference: refundRef,
                amount: Math.abs(parseFloat(original.amount) || 0),
                currency: original.currency || DEFAULT_CURRENCY
            };
        }

        const refundAmount = Math.abs(rawAmount);

        // 4. Create the credit.
        const created = await this.createTransaction({
            userId,
            type: 'refund',
            amount: +refundAmount,
            currency: original.currency || DEFAULT_CURRENCY,
            description: reason,
            reference: refundRef,
            sourceType: original.source_type || 'refund',
            sourceId: original.source_id || original.id,
            provider: original.provider || null,
            providerReference: original.provider_reference || null,
            metadata: {
                refunded_transaction_id: original.id,
                refunded_reference: original.reference,
                refunded_type: original.type,
                reason
            },
            idempotencyKey: idempotencyKey || null
        });

        // 5. Write the refunds row (new in Batch 2). Failure here is
        // logged but does NOT undo the credit — the reference is
        // deterministic so a retry finds it via step 3.
        try {
            await supabaseAdmin.from('refunds').insert({
                original_transaction_id: transactionId,
                refund_transaction_id: created.transaction_id,
                user_id: userId,
                refund_type: 'wallet',
                refund_method: 'wallet',
                amount: refundAmount,
                currency: original.currency || DEFAULT_CURRENCY,
                reason,
                status: 'COMPLETED',
                completed_at: new Date().toISOString(),
                idempotency_key: `auto:${created.transaction_id}`,
                metadata: { source: 'auto_refund', reference: refundRef }
            });
        } catch (rowErr) {
            console.error('[LEDGER] auto refund row insert failed after ledger credit', {
                transactionId,
                refund_tx_id: created.transaction_id,
                error: rowErr.message
            });
        }

        return created;
    }

    /**
     * Look for an existing refunds row for a given original
     * transaction that is still active. This is the single dedupe
     * rule shared by the auto refund path (here) and the admin
     * path (refundService).
     */
    static async _findActiveRefundRow(originalTransactionId) {
        if (!UUID_RE.test(String(originalTransactionId || ''))) return null;
        try {
            const { data, error } = await supabaseAdmin
                .from('refunds')
                .select('id, status, refund_type, amount, currency, refund_transaction_id, provider_reference')
                .eq('original_transaction_id', originalTransactionId)
                .in('status', ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'COMPLETED'])
                .limit(1)
                .maybeSingle();
            if (error) return null;
            return data || null;
        } catch (_) {
            return null;
        }
    }
}

class AdminConfigService {
    static ALLOWED_KEYS = new Set([
        'usd_to_ngn', 'boost_markup', 'gift_card_markup',
        'virtual_sms_markup', 'marketplace_markup', 'airtime_markup'
    ]);

    static async getSettingsOrNull() {
        const { data, error } = await supabaseAdmin.from('app_config').select('key, value');
        if (error) return null;
        const settings = {};
        (data || []).forEach(item => { settings[item.key] = item.value; });
        return settings;
    }

    static async getSettings() {
        const s = await this.getSettingsOrNull();
        if (s === null) {
            console.error('[ADMIN CONFIG] database read failed');
            throw new Error('Configuration unavailable');
        }
        return s;
    }

    static getDefaultSettings() {
        return {
            usd_to_ngn: '1620', boost_markup: '18', gift_card_markup: '10',
            virtual_sms_markup: '15', marketplace_markup: '20', airtime_markup: '18'
        };
    }

    static async updateSetting(key, value) {
        if (!this.ALLOWED_KEYS.has(key)) {
            throw new Error(`updateSetting: "${key}" is not an editable setting`);
        }
        const n = parseFloat(value);
        if (!Number.isFinite(n) || n <= 0 || n > 1000000) {
            throw new Error(`updateSetting: "${key}" must be a positive finite number`);
        }
        const { error } = await supabaseAdmin
            .from('app_config')
            .upsert({ key, value: String(n), updated_at: new Date().toISOString() }, { onConflict: 'key' });
        if (error) throw new Error(`Failed to update ${key}: ${error.message}`);
        return { success: true, key, value: n };
    }

    static async getExchangeRate() {
        const s = await this.getSettings();
        const n = parseFloat(s.usd_to_ngn);
        if (!Number.isFinite(n) || n <= 0) throw new Error('getExchangeRate: usd_to_ngn is not configured');
        return n;
    }

    static async getMarkup(service) {
        const s = await this.getSettings();
        const raw = s[`${service}_markup`];
        const n = parseFloat(raw);
        if (!Number.isFinite(n) || n < 0) throw new Error(`getMarkup: "${service}_markup" is not configured`);
        return n;
    }
}

module.exports = { LedgerService, AdminConfigService, TYPE_DIRECTION };