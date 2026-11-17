// routes/billsRoutes.js
// LOCAL bills: Airtime, Data, Electricity, TV.
// Provider: VTpass. Wallet: NGN only.
//
// Batch 5:
//   • Uses airtimePricing.quoteLocal for airtime fee/total.
//   • Uses buildSnapshotLocal after VTpass responds (writes
//     provider_commission_ngn, margin_ngn, fee_percent).
//   • Idempotency-Key REQUIRED on every purchase route.
//   • New GET /api/bills/airtime/quote.
//   • Reads/writes go through services/billsFulfillment.js.
//   • NEW: every purchase also mirrors into `orders` via recordOrder
//     so Admin → Orders and Revenue analytics can see bills purchases.
'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { supabaseAdmin } = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');
const vtpassService = require('../services/vtpassService');
const airtimePricing = require('../services/airtimePricing');
const fulfillment = require('../services/billsFulfillment');
const adminSettings = require('../services/adminSettingsService');

const MIN_AMOUNT = { airtime: 50, data: 50, electricity: 500, tv: 100 };
const MAX_AMOUNT = { airtime: 50000, data: 100000, electricity: 500000, tv: 100000 };
const VALID_NETWORKS = ['mtn', 'airtel', 'glo', '9mobile'];

const MAX_PIN_ATTEMPTS = 4;
const PIN_LOCK_DURATION = 60 * 60 * 1000;
const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000;

const BILL_TYPES = ['airtime', 'data', 'electricity', 'tv', 'bills'];

// ─── RATE LIMITING ───────────────────────────────────────────────
const rateLimitStore = new Map();
function checkRateLimit(key, windowMs, maxRequests) {
    const now = Date.now();
    const record = rateLimitStore.get(key);
    if (!record || now > record.resetAt) {
        rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    if (record.count >= maxRequests) return false;
    record.count++;
    return true;
}
setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore) {
        if (now > record.resetAt) rateLimitStore.delete(key);
    }
}, 10 * 60 * 1000);

// ─── HELPERS ─────────────────────────────────────────────────────
function generateReference(prefix = 'BILL') {
    const ts = Date.now();
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}-${ts}-${rand}`;
}
function hashString(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
function createFingerprint(data) {
    const normalized = JSON.stringify(data, Object.keys(data).sort());
    return hashString(normalized);
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function getUserProfile(userId) {
    const { data, error } = await supabaseAdmin.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) throw new Error('Failed to fetch user profile');
    if (!data) throw new Error('User not found');
    return data;
}

async function verifyTransactionPin(userId, pin) {
    if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
        return { valid: false, error: 'PIN must be exactly 4 digits', code: 'INVALID_FORMAT' };
    }
    const profile = await getUserProfile(userId);
    if (!profile.transaction_pin_hash) {
        return { valid: false, error: 'PIN not set. Please set a PIN first.', code: 'PIN_NOT_SET', pinNotSet: true };
    }
    if (profile.transaction_pin_locked_until) {
        const lockUntil = new Date(profile.transaction_pin_locked_until);
        if (lockUntil > new Date()) {
            const remaining = Math.ceil((lockUntil - new Date()) / 60000);
            return {
                valid: false,
                error: `PIN is locked. Please wait ${remaining} minute${remaining > 1 ? 's' : ''}.`,
                code: 'PIN_LOCKED',
                remaining_minutes: remaining
            };
        }
    }
    const isValid = await bcrypt.compare(pin, profile.transaction_pin_hash);
    if (!isValid) {
        const attempts = (profile.transaction_pin_attempts || 0) + 1;
        const updates = { transaction_pin_attempts: attempts };
        if (attempts >= MAX_PIN_ATTEMPTS) {
            updates.transaction_pin_locked_until = new Date(Date.now() + PIN_LOCK_DURATION).toISOString();
            updates.transaction_pin_attempts = 0;
        }
        await supabaseAdmin.from('profiles').update(updates).eq('id', userId);
        const remaining = MAX_PIN_ATTEMPTS - attempts;
        return {
            valid: false,
            error: attempts >= MAX_PIN_ATTEMPTS
                ? 'Too many failed attempts. PIN locked for 1 hour.'
                : `Invalid PIN. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`,
            code: attempts >= MAX_PIN_ATTEMPTS ? 'PIN_LOCKED' : 'INVALID_PIN',
            attempts_remaining: remaining,
            remaining_minutes: attempts >= MAX_PIN_ATTEMPTS ? 60 : undefined
        };
    }
    await supabaseAdmin.from('profiles')
        .update({ transaction_pin_attempts: 0, transaction_pin_locked_until: null })
        .eq('id', userId);
    return { valid: true };
}

// ─── DELEGATED HELPERS ───────────────────────────────────────────
const getWalletBalance = (userId, currency = 'NGN') => fulfillment.getWalletBalance(userId, currency);
const createNotification = (userId, title, message, type, link) => fulfillment.createNotification(userId, title, message, type, link);
const createTransaction    = (data) => fulfillment.createTransaction(data);
const updateTransaction    = (id, updates) => fulfillment.updateTransaction(id, updates);
const attemptRefund        = (args) => fulfillment.attemptRefund(args);
const recordOrder          = (data) => fulfillment.recordOrder(data);

// ─── NETWORK RESOLUTION ─────────────────────────────────────────
function resolveNetwork(body, detectedNetwork) {
    const candidates = [body.network_override, body.selected_network, body.serviceId, detectedNetwork];
    for (const c of candidates) {
        if (!c) continue;
        const normalized = String(c).toLowerCase().trim();
        if (VALID_NETWORKS.includes(normalized)) return normalized;
    }
    return null;
}

// ─── IDEMPOTENCY HELPERS ────────────────────────────────────────
async function checkIdempotency(userId, key, endpoint, fingerprint) {
    const { data, error } = await supabaseAdmin
        .from('idempotency_keys').select('*')
        .eq('user_id', userId).eq('idempotency_key', key).eq('endpoint', endpoint).maybeSingle();
    if (error && error.code !== 'PGRST116') { console.error('Idempotency check error:', error); return { found: false }; }
    if (!data) return { found: false };
    if (data.request_fingerprint && fingerprint && data.request_fingerprint !== fingerprint) {
        return { found: true, conflict: true, error: 'This request conflicts with a previous request' };
    }
    return { found: true, status: data.status, response: data.response };
}
async function reserveIdempotencyKey(userId, key, endpoint, fingerprint) {
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL);
    const { data, error } = await supabaseAdmin
        .from('idempotency_keys')
        .insert({
            user_id: userId, idempotency_key: key, endpoint,
            request_fingerprint: fingerprint, status: 'pending',
            expires_at: expiresAt.toISOString(), created_at: new Date().toISOString()
        }).select().single();
    if (error) {
        if (error.code === '23505') return { reserved: false, reason: 'duplicate' };
        console.error('Idempotency reserve error:', error);
        return { reserved: false, reason: error.message };
    }
    return { reserved: true, id: data.id };
}
async function completeIdempotencyKey(userId, key, endpoint, response) {
    await supabaseAdmin.from('idempotency_keys')
        .update({ status: 'completed', response, completed_at: new Date().toISOString() })
        .eq('user_id', userId).eq('idempotency_key', key).eq('endpoint', endpoint);
}

function requireIdempotencyKey(req, res, next) {
    const key = req.headers['idempotency-key'];
    if (!key || typeof key !== 'string' || key.length > 128) {
        return res.status(400).json({
            success: false,
            error: 'Idempotency-Key header is required',
            code: 'IDEMPOTENCY_REQUIRED'
        });
    }
    next();
}

// ═══════════════════════════════════════════════════════════════
//  STATIC CATALOG
// ═══════════════════════════════════════════════════════════════

router.get('/networks', authMiddleware, (req, res) => {
    res.json({ success: true, data: vtpassService.getNetworks() });
});

router.get('/electricity/providers', authMiddleware, (req, res) => {
    res.json({ success: true, data: vtpassService.getElectricityProviders() });
});

router.get('/tv/providers', authMiddleware, (req, res) => {
    res.json({ success: true, data: vtpassService.getTvProviders() });
});

router.post('/phone-lookup', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        const { phone } = req.body || {};
        if (!phone) return res.status(400).json({ success: false, error: 'Phone number is required', code: 'MISSING_PHONE' });
        if (!checkRateLimit(`phone_lookup_${userId}`, 60 * 1000, 20)) {
            return res.status(429).json({ success: false, error: 'Too many lookups.', code: 'RATE_LIMITED' });
        }
        const result = await vtpassService.lookupPhoneNetwork(phone);
        if (!result.success) {
            return res.status(400).json({
                success: false, error: result.error,
                code: 'DETECTION_FAILED',
                data: { phone: result.phone, detection_source: result.detection_source }
            });
        }
        res.json({ success: true, data: {
            phone: result.phone, network: result.network,
            network_name: result.network_name, detection_source: result.detection_source
        }});
    } catch (error) {
        console.error('❌ Phone lookup error:', error);
        res.status(500).json({ success: false, error: 'Phone lookup failed', code: 'SERVER_ERROR' });
    }
});

router.get('/data/variations', authMiddleware, async (req, res) => {
    try {
        const { service_id: network } = req.query;
        if (!network) return res.status(400).json({ success: false, error: 'Network is required', code: 'MISSING_NETWORK' });
        const result = await vtpassService.getDataPlans(network.toLowerCase());
        if (!result.success) return res.status(400).json({ success: false, error: result.error || 'Failed to fetch data plans', code: 'PLANS_UNAVAILABLE' });
        res.json({
            success: true,
            data: result.plans.map(p => ({
                variation_id: p.variation_code, variation_code: p.variation_code,
                name: p.name, data_plan: p.name, price: p.amount,
                variation_amount: p.amount, validity: p.description || '30 days'
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch data plans', code: 'SERVER_ERROR' });
    }
});

router.get('/tv/variations', authMiddleware, async (req, res) => {
    try {
        const { service_id: provider } = req.query;
        if (!provider) return res.status(400).json({ success: false, error: 'Provider is required', code: 'MISSING_PROVIDER' });
        const result = await vtpassService.getTvPackages(provider.toLowerCase());
        if (!result.success) return res.status(400).json({ success: false, error: result.error || 'Failed to fetch TV packages', code: 'PACKAGES_UNAVAILABLE' });
        res.json({
            success: true,
            data: result.packages.map(p => ({
                variation_id: p.variation_code, variation_code: p.variation_code,
                name: p.name, package_bouquet: p.name, price: p.amount,
                variation_amount: p.amount
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch TV packages', code: 'SERVER_ERROR' });
    }
});

router.post('/verify-customer', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        const { customerId, serviceId, variationId } = req.body;
        if (!customerId || !serviceId) {
            return res.status(400).json({ success: false, error: 'Customer ID and Service ID are required', code: 'MISSING_PARAMETERS' });
        }
        if (!checkRateLimit(`verify_${userId}`, 60 * 1000, 10)) {
            return res.status(429).json({ success: false, error: 'Too many verification attempts.', code: 'RATE_LIMITED' });
        }
        const electricityProviders = vtpassService.getElectricityProviders().map(p => p.id);
        const tvProviders = vtpassService.getTvProviders().map(p => p.id);

        let result;
        if (electricityProviders.includes(serviceId)) {
            result = await vtpassService.verifyElectricityMeter({
                provider: serviceId, meterNumber: customerId, meterType: variationId || 'prepaid'
            });
        } else if (tvProviders.includes(serviceId)) {
            result = await vtpassService.verifyTvCustomer({ provider: serviceId, customerId });
        } else {
            return res.status(400).json({ success: false, error: 'Unsupported service for verification', code: 'UNSUPPORTED_SERVICE' });
        }
        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error, code: result.code || 'VERIFICATION_FAILED' });
        }
        res.json({
            success: true,
            data: {
                customer_name: result.customerName, customerName: result.customerName,
                customer_number: result.customerNumber || customerId, customerNumber: result.customerNumber || customerId,
                current_bouquet: result.currentPackage, currentBouquet: result.currentPackage,
                renewal_amount: result.renewalAmount, renewalAmount: result.renewalAmount,
                meter_number: result.meterNumber || customerId, meterNumber: result.meterNumber || customerId,
                meter_type: result.meterType || variationId, meterType: result.meterType || variationId,
                min_purchase_amount: result.minAmount, minPurchaseAmount: result.minAmount,
                max_purchase_amount: result.maxAmount, maxPurchaseAmount: result.maxAmount,
                can_vend: result.canVend, canVend: result.canVend,
                address: result.customerAddress
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Verification failed', code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  AIRTIME QUOTE
// ═══════════════════════════════════════════════════════════════
router.get('/airtime/quote', authMiddleware, async (req, res) => {
    try {
        const cfg = await airtimePricing.getAirtimeConfig();
        if (!cfg.local.enabled) {
            return res.status(503).json({ success: false, error: 'Local airtime is currently disabled.', code: 'SERVICE_DISABLED' });
        }
        const amount = Number(req.query.amount || 0);
        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ success: false, error: 'amount query param required', code: 'MISSING_AMOUNT' });
        }
        if (amount < Number(cfg.local.min) || amount > Number(cfg.local.max)) {
            return res.status(400).json({
                success: false,
                error: `Amount must be between ₦${cfg.local.min} and ₦${cfg.local.max}`,
                code: 'INVALID_AMOUNT'
            });
        }
        const quote = await airtimePricing.quoteLocal({ amountNgn: amount });
        return res.json({
            success: true,
            data: {
                amountNgn: quote.amountNgn,
                feeNgn: quote.feeNgn,
                totalNgn: quote.totalNgn,
                feePercent: quote.feePercent,
                min: cfg.local.min,
                max: cfg.local.max
            }
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Quote failed', code: 'QUOTE_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  AIRTIME PURCHASE
// ═══════════════════════════════════════════════════════════════
router.post('/airtime/purchase', authMiddleware, requireIdempotencyKey, async (req, res) => {
    const userId = req.user?.id;
    const idempotencyKey = req.headers['idempotency-key'];

    try {
        const { phone, amount, transaction_pin } = req.body;

        const cfg = await airtimePricing.getAirtimeConfig();
        if (!cfg.local.enabled) {
            console.log('[AIRTIME DEBUG] cfg =', JSON.stringify(cfg, null, 2));
            return res.status(503).json({ success: false, error: 'Local airtime is currently disabled.', code: 'SERVICE_DISABLED' });
        }

        if (!phone || !amount) {
            return res.status(400).json({ success: false, error: 'Phone and amount are required', code: 'MISSING_PARAMETERS' });
        }

        const numericAmount = parseFloat(amount);
        if (!Number.isFinite(numericAmount) || numericAmount < MIN_AMOUNT.airtime || numericAmount > MAX_AMOUNT.airtime) {
            return res.status(400).json({
                success: false,
                error: `Amount must be between ₦${MIN_AMOUNT.airtime} and ₦${MAX_AMOUNT.airtime}`,
                code: 'INVALID_AMOUNT'
            });
        }
        if (!transaction_pin) {
            return res.status(400).json({ success: false, error: 'Transaction PIN is required', code: 'PIN_REQUIRED', pinRequired: true });
        }

        const pinResult = await verifyTransactionPin(userId, transaction_pin);
        if (!pinResult.valid) {
            return res.status(400).json({
                success: false,
                error: pinResult.error,
                code: pinResult.code,
                attempts_remaining: pinResult.attempts_remaining
            });
        }

        const phoneValidation = vtpassService.validatePhone(phone);
        if (!phoneValidation.valid) {
            return res.status(400).json({ success: false, error: phoneValidation.error, code: 'INVALID_PHONE' });
        }
        const detectedNetwork = phoneValidation.network;
        const finalNetwork = resolveNetwork(req.body, detectedNetwork);
        if (!finalNetwork) {
            return res.status(400).json({ success: false, error: 'Please select a valid network', code: 'INVALID_NETWORK' });
        }
        const manuallyOverridden = !!detectedNetwork && detectedNetwork !== finalNetwork;

        const quoteLocal = await airtimePricing.quoteLocal({ amountNgn: numericAmount });
        const totalAmount = Number(quoteLocal.totalNgn);
        const serviceFee  = Number(quoteLocal.feeNgn);

        const fingerprint = createFingerprint({
            phone: phoneValidation.phone, network: finalNetwork, amount: numericAmount
        });

        const existing = await checkIdempotency(userId, idempotencyKey, '/api/bills/airtime/purchase', fingerprint);
        if (existing.conflict) {
            return res.status(409).json({ success: false, error: 'This request conflicts with a previous request', code: 'IDEMPOTENCY_CONFLICT' });
        }
        if (existing.found && existing.status === 'completed') {
            return res.json({ success: true, already_processed: true, data: existing.response });
        }
        if (existing.found && existing.status === 'pending') {
            return res.status(409).json({ success: false, error: 'This purchase is already being processed', code: 'DUPLICATE_REQUEST' });
        }
        const reserved = await reserveIdempotencyKey(userId, idempotencyKey, '/api/bills/airtime/purchase', fingerprint);
        if (!reserved.reserved && reserved.reason === 'duplicate') {
            return res.status(409).json({ success: false, error: 'This purchase is already being processed', code: 'DUPLICATE_REQUEST' });
        }

        const walletBalance = await getWalletBalance(userId, 'NGN');
        if (walletBalance < totalAmount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient balance. Available: ₦${walletBalance.toFixed(2)}, Required: ₦${totalAmount.toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE',
                data: { balance: walletBalance, required: totalAmount, shortfall: totalAmount - walletBalance }
            });
        }

        const reference = generateReference('AIR');
        const transaction = await createTransaction({
            userId, reference,
            serviceType: 'airtime', serviceId: finalNetwork,
            currency: 'NGN',
            baseAmount: numericAmount,
            providerAmount: numericAmount,
            markupAmount: 0,
            serviceFee,
            customerAmount: totalAmount,
            recipient: phoneValidation.phone,
            network: finalNetwork,
            status: 'pending',
            idempotencyKey,
            requestFingerprint: fingerprint,
            feePercent: quoteLocal.feePercent,
            metadata: {
                network_name: vtpassService.getNetworks().find(n => n.id === finalNetwork)?.name || finalNetwork,
                phone: phoneValidation.phone,
                phone_lookup: {
                    input_phone: phone,
                    normalized_phone: phoneValidation.phone,
                    detected_network: detectedNetwork,
                    selected_network: finalNetwork,
                    detection_source: 'prefix',
                    manually_overridden: manuallyOverridden
                }
            }
        });

        // Mirror as an order so Admin → Orders / Revenue can see it.
        let orderId = await recordOrder({
            billTransactionId: transaction.id,
            reference,
            userId,
            productType: 'airtime',
            serviceId: finalNetwork,
            provider: 'vtpass',
            currency: 'NGN',
            amount: numericAmount,
            serviceFee,
            totalAmount,
            providerCost: 0,
            status: 'pending',
            recipient: phoneValidation.phone,
            metadata: {
                network_name: vtpassService.getNetworks().find(n => n.id === finalNetwork)?.name || finalNetwork
            }
        });

        let debitResult;
        try {
            debitResult = await require('../services/ledgerService').LedgerService.debitWallet({
                userId, amount: totalAmount, currency: 'NGN',
                reference: `${reference}-DEBIT`,
                description: `Airtime - ${finalNetwork.toUpperCase()} (${phoneValidation.phone})`,
                type: 'airtime_purchase',
                sourceType: 'bill_payment',
                sourceId: transaction.id,
                metadata: { transaction_id: transaction.id, service: 'airtime' }
            });
        } catch (debitErr) {
            console.error('❌ Airtime debit failed:', debitErr);
            await updateTransaction(transaction.id, {
                status: 'failed',
                failure_reason: `Wallet debit failed: ${debitErr.message}`,
                failed_at: new Date().toISOString()
            });
            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'airtime', serviceId: finalNetwork, provider: 'vtpass',
                    currency: 'NGN', amount: numericAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'failed',
                    recipient: phoneValidation.phone,
                    metadata: { failure_reason: `Wallet debit failed: ${debitErr.message}` }
                }).catch(e => console.error('[AIRTIME] recordOrder debit-failed failed:', e.message));
            }
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }
        if (!debitResult || debitResult.success !== true) {
            await updateTransaction(transaction.id, {
                status: 'failed',
                failure_reason: 'Wallet debit returned unsuccessful',
                failed_at: new Date().toISOString()
            });
            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'airtime', serviceId: finalNetwork, provider: 'vtpass',
                    currency: 'NGN', amount: numericAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'failed',
                    recipient: phoneValidation.phone,
                    metadata: { failure_reason: 'Wallet debit returned unsuccessful' }
                }).catch(e => console.error('[AIRTIME] recordOrder debit-unsuccessful failed:', e.message));
            }
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }

        await updateTransaction(transaction.id, {
            status: 'processing',
            ledger_transaction_id: debitResult.transaction_id,
            processing_at: new Date().toISOString()
        });

        const vtpassResult = await vtpassService.purchaseAirtime({
            phone: phoneValidation.phone, network: finalNetwork, amount: numericAmount
        });

        try {
            const snapshotLocal = airtimePricing.buildSnapshotLocal(quoteLocal, vtpassResult);
            await updateTransaction(transaction.id, {
                provider_commission_ngn: snapshotLocal.provider_commission_ngn,
                margin_ngn:              snapshotLocal.margin_ngn,
                fee_percent:             snapshotLocal.fee_percent
            });
        } catch (snapErr) {
            console.warn('[BILLS] snapshotLocal failed:', snapErr.message);
        }

        let responseData;

        if (vtpassResult.state === 'completed') {
            await updateTransaction(transaction.id, {
                status: 'completed',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                completed_at: new Date().toISOString()
            });
            await createNotification(userId, 'Airtime Purchase Successful',
                `You have successfully purchased ₦${numericAmount.toFixed(2)} airtime for ${phoneValidation.phone}`,
                'success', '/bills');

            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'airtime', serviceId: finalNetwork, provider: 'vtpass',
                    currency: 'NGN', amount: numericAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'completed',
                    recipient: phoneValidation.phone
                }).catch(e => console.error('[AIRTIME] recordOrder completed failed:', e.message));
            }

            responseData = {
                transactionId: transaction.id, reference, status: 'completed',
                amount: numericAmount, recipient: phoneValidation.phone, network: finalNetwork,
                detected_network: detectedNetwork, network_override: manuallyOverridden,
                fee: serviceFee, total: totalAmount
            };
        } else if (vtpassResult.state === 'processing') {
            await updateTransaction(transaction.id, {
                status: 'processing',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.error || null
            });

            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'airtime', serviceId: finalNetwork, provider: 'vtpass',
                    currency: 'NGN', amount: numericAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'processing',
                    recipient: phoneValidation.phone
                }).catch(e => console.error('[AIRTIME] recordOrder processing failed:', e.message));
            }

            responseData = {
                transactionId: transaction.id, reference, status: 'processing',
                amount: numericAmount, recipient: phoneValidation.phone, network: finalNetwork,
                detected_network: detectedNetwork, network_override: manuallyOverridden,
                fee: serviceFee, total: totalAmount, message: 'Transaction is being processed'
            };
        } else {
            const refundOutcome = await attemptRefund({
                userId,
                ledgerTransactionId: debitResult.transaction_id,
                reason: vtpassResult.friendlyError || vtpassResult.error || 'Provider transaction failed',
                sourceContext: {
                    bill_transaction_id: transaction.id, reference, service: 'airtime',
                    provider_status: vtpassResult.providerStatus, provider_code: vtpassResult.code
                }
            });
            const refundResult = refundOutcome.success ? { success: true } : { success: false, error: refundOutcome.error };
            await updateTransaction(transaction.id, {
                status: 'failed',
                provider_request_id: vtpassResult.requestId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.friendlyError || vtpassResult.error,
                failed_at: new Date().toISOString(),
                refunded: !!refundResult.success,
                refunded_at: refundResult.success ? new Date().toISOString() : null
            });
            await createNotification(userId, 'Airtime Purchase Failed',
                `Your airtime purchase of ₦${numericAmount.toFixed(2)} for ${phoneValidation.phone} failed. ${refundResult.success ? 'Your wallet has been refunded.' : 'A refund is being processed.'}`,
                'error', '/bills');

            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'airtime', serviceId: finalNetwork, provider: 'vtpass',
                    currency: 'NGN', amount: numericAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'failed',
                    recipient: phoneValidation.phone,
                    metadata: { failure_reason: vtpassResult.friendlyError || vtpassResult.error }
                }).catch(e => console.error('[AIRTIME] recordOrder failed status failed:', e.message));
            }

            responseData = {
                transactionId: transaction.id, reference, status: 'failed',
                amount: numericAmount, recipient: phoneValidation.phone, network: finalNetwork,
                detected_network: detectedNetwork, network_override: manuallyOverridden,
                error: vtpassResult.friendlyError || vtpassResult.error,
                refunded: !!refundResult.success, fee: serviceFee, total: totalAmount
            };
        }

        await completeIdempotencyKey(userId, idempotencyKey, '/api/bills/airtime/purchase', responseData);
        const newBalance = await getWalletBalance(userId, 'NGN');
        return res.json({ success: true, data: { ...responseData, new_balance: newBalance } });

    } catch (error) {
        console.error('❌ Airtime purchase error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Purchase failed', code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  DATA PURCHASE
// ═══════════════════════════════════════════════════════════════
router.post('/data/purchase', authMiddleware, requireIdempotencyKey, async (req, res) => {
    const userId = req.user?.id;
    const idempotencyKey = req.headers['idempotency-key'];

    try {
        const { phone, variationId, transaction_pin } = req.body;
        if (!phone || !variationId) return res.status(400).json({ success: false, error: 'Phone and plan are required', code: 'MISSING_PARAMETERS' });
        if (!transaction_pin) return res.status(400).json({ success: false, error: 'Transaction PIN is required', code: 'PIN_REQUIRED', pinRequired: true });

        const pinResult = await verifyTransactionPin(userId, transaction_pin);
        if (!pinResult.valid) {
            return res.status(400).json({ success: false, error: pinResult.error, code: pinResult.code, attempts_remaining: pinResult.attempts_remaining });
        }
        const phoneValidation = vtpassService.validatePhone(phone);
        if (!phoneValidation.valid) return res.status(400).json({ success: false, error: phoneValidation.error, code: 'INVALID_PHONE' });
        const detectedNetwork = phoneValidation.network;
        const finalNetwork = resolveNetwork(req.body, detectedNetwork);
        if (!finalNetwork) return res.status(400).json({ success: false, error: 'Please select a valid network', code: 'INVALID_NETWORK' });
        const manuallyOverridden = !!detectedNetwork && detectedNetwork !== finalNetwork;

        let planData;
        try {
            const plans = await vtpassService.getDataPlans(finalNetwork);
            planData = plans.plans?.find(p => p.variation_code === variationId);
        } catch (e) { console.error('Failed to fetch plan:', e); }
        if (!planData) return res.status(400).json({ success: false, error: 'Selected data plan is not available', code: 'INVALID_PLAN' });
        const planAmount = planData.amount;

        const fingerprint = createFingerprint({ phone: phoneValidation.phone, network: finalNetwork, variationId });
        const existing = await checkIdempotency(userId, idempotencyKey, '/api/bills/data/purchase', fingerprint);
        if (existing.conflict) return res.status(409).json({ success: false, error: 'Conflicts with a previous request', code: 'IDEMPOTENCY_CONFLICT' });
        if (existing.found && existing.status === 'completed') return res.json({ success: true, already_processed: true, data: existing.response });
        if (existing.found && existing.status === 'pending') return res.status(409).json({ success: false, error: 'Already processing', code: 'DUPLICATE_REQUEST' });
        const reserved = await reserveIdempotencyKey(userId, idempotencyKey, '/api/bills/data/purchase', fingerprint);
        if (!reserved.reserved && reserved.reason === 'duplicate') return res.status(409).json({ success: false, error: 'Already processing', code: 'DUPLICATE_REQUEST' });

        const walletBalance = await getWalletBalance(userId, 'NGN');
        const serviceFee = 0;
        const totalAmount = planAmount + serviceFee;
        if (walletBalance < totalAmount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient balance. Available: ₦${walletBalance.toFixed(2)}, Required: ₦${totalAmount.toFixed(2)}`,
                code: 'INSUFFICIENT_BALANCE',
                data: { balance: walletBalance, required: totalAmount, shortfall: totalAmount - walletBalance }
            });
        }

        const reference = generateReference('DAT');
        const transaction = await createTransaction({
            userId, reference,
            serviceType: 'data', serviceId: finalNetwork,
            currency: 'NGN',
            baseAmount: planAmount, providerAmount: planAmount,
            markupAmount: 0, serviceFee, customerAmount: totalAmount,
            recipient: phoneValidation.phone, network: finalNetwork, variationCode: variationId,
            status: 'pending', idempotencyKey, requestFingerprint: fingerprint,
            metadata: {
                network_name: vtpassService.getNetworks().find(n => n.id === finalNetwork)?.name || finalNetwork,
                phone: phoneValidation.phone,
                plan_name: planData.name,
                phone_lookup: {
                    input_phone: phone, normalized_phone: phoneValidation.phone,
                    detected_network: detectedNetwork, selected_network: finalNetwork,
                    detection_source: 'prefix', manually_overridden: manuallyOverridden
                }
            }
        });

        let orderId = await recordOrder({
            billTransactionId: transaction.id,
            reference, userId,
            productType: 'data',
            serviceId: finalNetwork,
            provider: 'vtpass',
            currency: 'NGN',
            amount: planAmount,
            serviceFee, totalAmount,
            providerCost: 0,
            status: 'pending',
            recipient: phoneValidation.phone,
            metadata: { plan_name: planData.name }
        });

        let debitResult;
        try {
            debitResult = await require('../services/ledgerService').LedgerService.debitWallet({
                userId, amount: totalAmount, currency: 'NGN',
                reference: `${reference}-DEBIT`,
                description: `Data - ${finalNetwork.toUpperCase()} ${planData.name} (${phoneValidation.phone})`,
                type: 'data_purchase',
                sourceType: 'bill_payment', sourceId: transaction.id,
                metadata: { transaction_id: transaction.id, service: 'data' }
            });
        } catch (debitErr) {
            await updateTransaction(transaction.id, { status: 'failed', failure_reason: `Debit failed: ${debitErr.message}`, failed_at: new Date().toISOString() });
            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'data', serviceId: finalNetwork, provider: 'vtpass',
                    currency: 'NGN', amount: planAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'failed',
                    recipient: phoneValidation.phone,
                    metadata: { plan_name: planData.name, failure_reason: `Debit failed: ${debitErr.message}` }
                }).catch(e => console.error('[DATA] recordOrder debit-failed failed:', e.message));
            }
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }
        if (!debitResult || debitResult.success !== true) {
            await updateTransaction(transaction.id, { status: 'failed', failure_reason: 'Debit unsuccessful', failed_at: new Date().toISOString() });
            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'data', serviceId: finalNetwork, provider: 'vtpass',
                    currency: 'NGN', amount: planAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'failed',
                    recipient: phoneValidation.phone,
                    metadata: { plan_name: planData.name, failure_reason: 'Debit unsuccessful' }
                }).catch(e => console.error('[DATA] recordOrder debit-unsuccessful failed:', e.message));
            }
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }
        await updateTransaction(transaction.id, {
            status: 'processing',
            ledger_transaction_id: debitResult.transaction_id,
            processing_at: new Date().toISOString()
        });

        const vtpassResult = await vtpassService.purchaseData({
            phone: phoneValidation.phone, network: finalNetwork, variationCode: variationId
        });

        let responseData;
        if (vtpassResult.state === 'completed') {
            await updateTransaction(transaction.id, {
                status: 'completed',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                completed_at: new Date().toISOString()
            });
            await createNotification(userId, 'Data Purchase Successful',
                `You have successfully purchased ${planData.name} for ${phoneValidation.phone}`, 'success', '/bills');

            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'data', serviceId: finalNetwork, provider: 'vtpass',
                    currency: 'NGN', amount: planAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'completed',
                    recipient: phoneValidation.phone,
                    metadata: { plan_name: planData.name }
                }).catch(e => console.error('[DATA] recordOrder completed failed:', e.message));
            }

            responseData = { transactionId: transaction.id, reference, status: 'completed', amount: planAmount, recipient: phoneValidation.phone, network: finalNetwork, detected_network: detectedNetwork, network_override: manuallyOverridden, plan: planData.name };
        } else if (vtpassResult.state === 'processing') {
            await updateTransaction(transaction.id, {
                status: 'processing',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.error || null
            });

            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'data', serviceId: finalNetwork, provider: 'vtpass',
                    currency: 'NGN', amount: planAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'processing',
                    recipient: phoneValidation.phone,
                    metadata: { plan_name: planData.name }
                }).catch(e => console.error('[DATA] recordOrder processing failed:', e.message));
            }

            responseData = { transactionId: transaction.id, reference, status: 'processing', amount: planAmount, recipient: phoneValidation.phone, network: finalNetwork, detected_network: detectedNetwork, network_override: manuallyOverridden, plan: planData.name, message: 'Transaction is being processed' };
        } else {
            const refundOutcome = await attemptRefund({
                userId, ledgerTransactionId: debitResult.transaction_id,
                reason: vtpassResult.friendlyError || vtpassResult.error || 'Provider transaction failed',
                sourceContext: { bill_transaction_id: transaction.id, reference, service: 'data', provider_status: vtpassResult.providerStatus, provider_code: vtpassResult.code }
            });
            const refundResult = refundOutcome.success ? { success: true } : { success: false };
            await updateTransaction(transaction.id, {
                status: 'failed',
                provider_request_id: vtpassResult.requestId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.friendlyError || vtpassResult.error,
                failed_at: new Date().toISOString(),
                refunded: !!refundResult.success,
                refunded_at: refundResult.success ? new Date().toISOString() : null
            });
            await createNotification(userId, 'Data Purchase Failed',
                `Your data purchase of ${planData.name} for ${phoneValidation.phone} failed. ${refundResult.success ? 'Your wallet has been refunded.' : 'A refund is being processed.'}`,
                'error', '/bills');

            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'data', serviceId: finalNetwork, provider: 'vtpass',
                    currency: 'NGN', amount: planAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'failed',
                    recipient: phoneValidation.phone,
                    metadata: { plan_name: planData.name, failure_reason: vtpassResult.friendlyError || vtpassResult.error }
                }).catch(e => console.error('[DATA] recordOrder failed status failed:', e.message));
            }

            responseData = { transactionId: transaction.id, reference, status: 'failed', amount: planAmount, recipient: phoneValidation.phone, network: finalNetwork, detected_network: detectedNetwork, network_override: manuallyOverridden, plan: planData.name, error: vtpassResult.friendlyError || vtpassResult.error, refunded: !!refundResult.success };
        }

        await completeIdempotencyKey(userId, idempotencyKey, '/api/bills/data/purchase', responseData);
        const newBalance = await getWalletBalance(userId, 'NGN');
        return res.json({ success: true, data: { ...responseData, new_balance: newBalance } });

    } catch (error) {
        console.error('❌ Data purchase error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Purchase failed', code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  ELECTRICITY PURCHASE
// ═══════════════════════════════════════════════════════════════
router.post('/electricity/purchase', authMiddleware, requireIdempotencyKey, async (req, res) => {
    const userId = req.user?.id;
    const idempotencyKey = req.headers['idempotency-key'];

    try {
        const { customerId, serviceId, variationId, amount, transaction_pin } = req.body;
        if (!customerId || !serviceId || !amount) return res.status(400).json({ success: false, error: 'Meter, provider, and amount are required', code: 'MISSING_PARAMETERS' });
        const numericAmount = parseFloat(amount);
        if (!Number.isFinite(numericAmount) || numericAmount < MIN_AMOUNT.electricity) return res.status(400).json({ success: false, error: `Minimum is ₦${MIN_AMOUNT.electricity}`, code: 'INVALID_AMOUNT' });
        if (!transaction_pin) return res.status(400).json({ success: false, error: 'Transaction PIN required', code: 'PIN_REQUIRED', pinRequired: true });

        const pinResult = await verifyTransactionPin(userId, transaction_pin);
        if (!pinResult.valid) return res.status(400).json({ success: false, error: pinResult.error, code: pinResult.code, attempts_remaining: pinResult.attempts_remaining });

        const verification = await vtpassService.verifyElectricityMeter({ provider: serviceId, meterNumber: customerId, meterType: variationId || 'prepaid' });
        if (!verification.success) return res.status(400).json({ success: false, error: verification.error || 'Meter verification failed', code: 'VERIFICATION_FAILED' });
        if (!verification.canVend) return res.status(400).json({ success: false, error: 'Cannot vend for this meter', code: 'CANNOT_VEND' });
        if (verification.minAmount && numericAmount < verification.minAmount) return res.status(400).json({ success: false, error: `Minimum is ₦${verification.minAmount}`, code: 'AMOUNT_BELOW_MINIMUM' });
        if (verification.maxAmount && numericAmount > verification.maxAmount) return res.status(400).json({ success: false, error: `Maximum is ₦${verification.maxAmount}`, code: 'AMOUNT_ABOVE_MAXIMUM' });

        const fingerprint = createFingerprint({ customerId, serviceId, variationId, amount: numericAmount });
        const existing = await checkIdempotency(userId, idempotencyKey, '/api/bills/electricity/purchase', fingerprint);
        if (existing.conflict) return res.status(409).json({ success: false, error: 'Conflicts with a previous request', code: 'IDEMPOTENCY_CONFLICT' });
        if (existing.found && existing.status === 'completed') return res.json({ success: true, already_processed: true, data: existing.response });
        if (existing.found && existing.status === 'pending') return res.status(409).json({ success: false, error: 'Already processing', code: 'DUPLICATE_REQUEST' });
        const reserved = await reserveIdempotencyKey(userId, idempotencyKey, '/api/bills/electricity/purchase', fingerprint);
        if (!reserved.reserved && reserved.reason === 'duplicate') return res.status(409).json({ success: false, error: 'Already processing', code: 'DUPLICATE_REQUEST' });

        const walletBalance = await getWalletBalance(userId, 'NGN');
        const serviceFee = 0;
        const totalAmount = numericAmount + serviceFee;
        if (walletBalance < totalAmount) return res.status(400).json({ success: false, error: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE', data: { balance: walletBalance, required: totalAmount } });

        const reference = generateReference('ELC');
        const transaction = await createTransaction({
            userId, reference, serviceType: 'electricity', serviceId,
            currency: 'NGN', baseAmount: numericAmount, providerAmount: numericAmount,
            markupAmount: 0, serviceFee, customerAmount: totalAmount,
            recipient: customerId, variationCode: variationId, status: 'pending',
            idempotencyKey, requestFingerprint: fingerprint,
            metadata: {
                meter_number: customerId, meter_type: variationId,
                customer_name: verification.customerName, customer_address: verification.customerAddress,
                can_vend: verification.canVend
            }
        });

        let orderId = await recordOrder({
            billTransactionId: transaction.id,
            reference, userId,
            productType: 'electricity',
            serviceId: serviceId,
            provider: 'vtpass',
            currency: 'NGN',
            amount: numericAmount,
            serviceFee, totalAmount,
            providerCost: 0,
            status: 'pending',
            recipient: customerId,
            metadata: {
                meter_number: customerId, meter_type: variationId,
                customer_name: verification.customerName
            }
        });

        let debitResult;
        try {
            debitResult = await require('../services/ledgerService').LedgerService.debitWallet({
                userId, amount: totalAmount, currency: 'NGN',
                reference: `${reference}-DEBIT`,
                description: `Electricity - ${serviceId} (${customerId})`,
                type: 'bills_purchase',
                sourceType: 'bill_payment', sourceId: transaction.id,
                metadata: { transaction_id: transaction.id, service: 'electricity' }
            });
        } catch (debitErr) {
            await updateTransaction(transaction.id, { status: 'failed', failure_reason: `Debit failed: ${debitErr.message}`, failed_at: new Date().toISOString() });
            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'electricity', serviceId, provider: 'vtpass',
                    currency: 'NGN', amount: numericAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'failed',
                    recipient: customerId,
                    metadata: { meter_number: customerId, meter_type: variationId, failure_reason: `Debit failed: ${debitErr.message}` }
                }).catch(e => console.error('[ELEC] recordOrder debit-failed failed:', e.message));
            }
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }
        if (!debitResult || debitResult.success !== true) {
            await updateTransaction(transaction.id, { status: 'failed', failure_reason: 'Debit unsuccessful', failed_at: new Date().toISOString() });
            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'electricity', serviceId, provider: 'vtpass',
                    currency: 'NGN', amount: numericAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'failed',
                    recipient: customerId,
                    metadata: { meter_number: customerId, meter_type: variationId, failure_reason: 'Debit unsuccessful' }
                }).catch(e => console.error('[ELEC] recordOrder debit-unsuccessful failed:', e.message));
            }
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }
        await updateTransaction(transaction.id, { status: 'processing', ledger_transaction_id: debitResult.transaction_id, processing_at: new Date().toISOString() });

        const vtpassResult = await vtpassService.purchaseElectricity({
            provider: serviceId, meterNumber: customerId, meterType: variationId || 'prepaid',
            amount: numericAmount, phone: req.user?.phone
        });

        let responseData;
        if (vtpassResult.state === 'completed') {
            await updateTransaction(transaction.id, {
                status: 'completed',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                token: vtpassResult.token, units: vtpassResult.units,
                completed_at: new Date().toISOString()
            });
            await createNotification(userId, 'Electricity Payment Successful',
                `Paid ₦${numericAmount.toFixed(2)} for meter ${customerId}`, 'success', '/bills');

            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'electricity', serviceId, provider: 'vtpass',
                    currency: 'NGN', amount: numericAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'completed',
                    recipient: customerId,
                    metadata: {
                        meter_number: customerId, meter_type: variationId,
                        customer_name: verification.customerName,
                        token: vtpassResult.token, units: vtpassResult.units
                    }
                }).catch(e => console.error('[ELEC] recordOrder completed failed:', e.message));
            }

            responseData = { transactionId: transaction.id, reference, status: 'completed', amount: numericAmount, recipient: customerId, customerName: verification.customerName, token: vtpassResult.token, units: vtpassResult.units };
        } else if (vtpassResult.state === 'processing') {
            await updateTransaction(transaction.id, {
                status: 'processing',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.error || null
            });

            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'electricity', serviceId, provider: 'vtpass',
                    currency: 'NGN', amount: numericAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'processing',
                    recipient: customerId,
                    metadata: { meter_number: customerId, meter_type: variationId, customer_name: verification.customerName }
                }).catch(e => console.error('[ELEC] recordOrder processing failed:', e.message));
            }

            responseData = { transactionId: transaction.id, reference, status: 'processing', amount: numericAmount, recipient: customerId, customerName: verification.customerName, message: 'Transaction is being processed' };
        } else {
            const refundOutcome = await attemptRefund({
                userId, ledgerTransactionId: debitResult.transaction_id,
                reason: vtpassResult.friendlyError || vtpassResult.error || 'Provider transaction failed',
                sourceContext: { bill_transaction_id: transaction.id, reference, service: 'electricity', provider_status: vtpassResult.providerStatus, provider_code: vtpassResult.code }
            });
            const refundResult = refundOutcome.success ? { success: true } : { success: false };
            await updateTransaction(transaction.id, {
                status: 'failed',
                provider_request_id: vtpassResult.requestId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.friendlyError || vtpassResult.error,
                failed_at: new Date().toISOString(),
                refunded: !!refundResult.success,
                refunded_at: refundResult.success ? new Date().toISOString() : null
            });
            await createNotification(userId, 'Electricity Payment Failed',
                `Electricity payment of ₦${numericAmount.toFixed(2)} for meter ${customerId} failed. ${refundResult.success ? 'Your wallet has been refunded.' : 'A refund is being processed.'}`,
                'error', '/bills');

            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'electricity', serviceId, provider: 'vtpass',
                    currency: 'NGN', amount: numericAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'failed',
                    recipient: customerId,
                    metadata: {
                        meter_number: customerId, meter_type: variationId,
                        customer_name: verification.customerName,
                        failure_reason: vtpassResult.friendlyError || vtpassResult.error
                    }
                }).catch(e => console.error('[ELEC] recordOrder failed status failed:', e.message));
            }

            responseData = { transactionId: transaction.id, reference, status: 'failed', amount: numericAmount, recipient: customerId, customerName: verification.customerName, error: vtpassResult.friendlyError || vtpassResult.error, refunded: !!refundResult.success };
        }

        await completeIdempotencyKey(userId, idempotencyKey, '/api/bills/electricity/purchase', responseData);
        const newBalance = await getWalletBalance(userId, 'NGN');
        return res.json({ success: true, data: { ...responseData, new_balance: newBalance } });

    } catch (error) {
        console.error('❌ Electricity purchase error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Purchase failed', code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  TV PURCHASE
// ═══════════════════════════════════════════════════════════════
router.post('/tv/purchase', authMiddleware, requireIdempotencyKey, async (req, res) => {
    const userId = req.user?.id;
    const idempotencyKey = req.headers['idempotency-key'];

    try {
        const { customerId, serviceId, variationId, subscriptionType, transaction_pin } = req.body;
        if (!customerId || !serviceId || !variationId) return res.status(400).json({ success: false, error: 'Smartcard, provider, and package are required', code: 'MISSING_PARAMETERS' });
        if (!transaction_pin) return res.status(400).json({ success: false, error: 'Transaction PIN required', code: 'PIN_REQUIRED', pinRequired: true });

        const pinResult = await verifyTransactionPin(userId, transaction_pin);
        if (!pinResult.valid) return res.status(400).json({ success: false, error: pinResult.error, code: pinResult.code, attempts_remaining: pinResult.attempts_remaining });

        const verification = await vtpassService.verifyTvCustomer({ provider: serviceId, customerId });
        if (!verification.success) return res.status(400).json({ success: false, error: verification.error || 'Customer verification failed', code: 'VERIFICATION_FAILED' });

        let packageData;
        try {
            const packages = await vtpassService.getTvPackages(serviceId);
            packageData = packages.packages?.find(p => p.variation_code === variationId);
        } catch (e) { console.error('Failed to fetch package:', e); }
        if (!packageData) return res.status(400).json({ success: false, error: 'Selected package is no longer available', code: 'INVALID_PACKAGE' });
        const packageAmount = subscriptionType === 'renew' && verification.renewalAmount > 0
            ? verification.renewalAmount : packageData.amount;

        const fingerprint = createFingerprint({ customerId, serviceId, variationId, subscriptionType, amount: packageAmount });
        const existing = await checkIdempotency(userId, idempotencyKey, '/api/bills/tv/purchase', fingerprint);
        if (existing.conflict) return res.status(409).json({ success: false, error: 'Conflicts with a previous request', code: 'IDEMPOTENCY_CONFLICT' });
        if (existing.found && existing.status === 'completed') return res.json({ success: true, already_processed: true, data: existing.response });
        if (existing.found && existing.status === 'pending') return res.status(409).json({ success: false, error: 'Already processing', code: 'DUPLICATE_REQUEST' });
        const reserved = await reserveIdempotencyKey(userId, idempotencyKey, '/api/bills/tv/purchase', fingerprint);
        if (!reserved.reserved && reserved.reason === 'duplicate') return res.status(409).json({ success: false, error: 'Already processing', code: 'DUPLICATE_REQUEST' });

        const walletBalance = await getWalletBalance(userId, 'NGN');
        const serviceFee = 0;
        const totalAmount = packageAmount + serviceFee;
        if (walletBalance < totalAmount) return res.status(400).json({ success: false, error: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE', data: { balance: walletBalance, required: totalAmount } });

        const reference = generateReference('TV');
        const transaction = await createTransaction({
            userId, reference, serviceType: 'tv', serviceId,
            currency: 'NGN', baseAmount: packageAmount, providerAmount: packageAmount,
            markupAmount: 0, serviceFee, customerAmount: totalAmount,
            recipient: customerId, variationCode: variationId, status: 'pending',
            idempotencyKey, requestFingerprint: fingerprint,
            metadata: {
                customer_number: customerId, current_package: verification.currentPackage,
                subscription_type: subscriptionType, package_name: packageData.name
            }
        });

        let orderId = await recordOrder({
            billTransactionId: transaction.id,
            reference, userId,
            productType: 'tv',
            serviceId: serviceId,
            provider: 'vtpass',
            currency: 'NGN',
            amount: packageAmount,
            serviceFee, totalAmount,
            providerCost: 0,
            status: 'pending',
            recipient: customerId,
            metadata: {
                customer_number: customerId, package_name: packageData.name,
                subscription_type: subscriptionType
            }
        });

        let debitResult;
        try {
            debitResult = await require('../services/ledgerService').LedgerService.debitWallet({
                userId, amount: totalAmount, currency: 'NGN',
                reference: `${reference}-DEBIT`,
                description: `TV - ${serviceId} ${packageData.name} (${customerId})`,
                type: 'bills_purchase',
                sourceType: 'bill_payment', sourceId: transaction.id,
                metadata: { transaction_id: transaction.id, service: 'tv' }
            });
        } catch (debitErr) {
            await updateTransaction(transaction.id, { status: 'failed', failure_reason: `Debit failed: ${debitErr.message}`, failed_at: new Date().toISOString() });
            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'tv', serviceId, provider: 'vtpass',
                    currency: 'NGN', amount: packageAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'failed',
                    recipient: customerId,
                    metadata: { customer_number: customerId, package_name: packageData.name, failure_reason: `Debit failed: ${debitErr.message}` }
                }).catch(e => console.error('[TV] recordOrder debit-failed failed:', e.message));
            }
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }
        if (!debitResult || debitResult.success !== true) {
            await updateTransaction(transaction.id, { status: 'failed', failure_reason: 'Debit unsuccessful', failed_at: new Date().toISOString() });
            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'tv', serviceId, provider: 'vtpass',
                    currency: 'NGN', amount: packageAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'failed',
                    recipient: customerId,
                    metadata: { customer_number: customerId, package_name: packageData.name, failure_reason: 'Debit unsuccessful' }
                }).catch(e => console.error('[TV] recordOrder debit-unsuccessful failed:', e.message));
            }
            return res.status(400).json({ success: false, error: 'Failed to debit wallet', code: 'DEBIT_FAILED' });
        }
        await updateTransaction(transaction.id, { status: 'processing', ledger_transaction_id: debitResult.transaction_id, processing_at: new Date().toISOString() });

        const vtpassResult = await vtpassService.purchaseTv({
            provider: serviceId, customerId, variationCode: variationId,
            amount: packageAmount, subscriptionType
        });

        let responseData;
        if (vtpassResult.state === 'completed') {
            await updateTransaction(transaction.id, {
                status: 'completed',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                completed_at: new Date().toISOString()
            });
            await createNotification(userId, 'TV Subscription Successful',
                `Subscribed ${packageData.name} for ${customerId}`, 'success', '/bills');

            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'tv', serviceId, provider: 'vtpass',
                    currency: 'NGN', amount: packageAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'completed',
                    recipient: customerId,
                    metadata: { customer_number: customerId, package_name: packageData.name, subscription_type: subscriptionType }
                }).catch(e => console.error('[TV] recordOrder completed failed:', e.message));
            }

            responseData = { transactionId: transaction.id, reference, status: 'completed', amount: packageAmount, recipient: customerId, customerName: verification.customerName, package: packageData.name };
        } else if (vtpassResult.state === 'processing') {
            await updateTransaction(transaction.id, {
                status: 'processing',
                provider_request_id: vtpassResult.requestId,
                provider_transaction_id: vtpassResult.transactionId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.error || null
            });

            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'tv', serviceId, provider: 'vtpass',
                    currency: 'NGN', amount: packageAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'processing',
                    recipient: customerId,
                    metadata: { customer_number: customerId, package_name: packageData.name, subscription_type: subscriptionType }
                }).catch(e => console.error('[TV] recordOrder processing failed:', e.message));
            }

            responseData = { transactionId: transaction.id, reference, status: 'processing', amount: packageAmount, recipient: customerId, customerName: verification.customerName, package: packageData.name, message: 'Transaction is being processed' };
        } else {
            const refundOutcome = await attemptRefund({
                userId, ledgerTransactionId: debitResult.transaction_id,
                reason: vtpassResult.friendlyError || vtpassResult.error || 'Provider transaction failed',
                sourceContext: { bill_transaction_id: transaction.id, reference, service: 'tv', provider_status: vtpassResult.providerStatus, provider_code: vtpassResult.code }
            });
            const refundResult = refundOutcome.success ? { success: true } : { success: false };
            await updateTransaction(transaction.id, {
                status: 'failed',
                provider_request_id: vtpassResult.requestId,
                provider_status: vtpassResult.providerStatus,
                provider_code: vtpassResult.code,
                provider_response: vtpassResult.data,
                failure_reason: vtpassResult.friendlyError || vtpassResult.error,
                failed_at: new Date().toISOString(),
                refunded: !!refundResult.success,
                refunded_at: refundResult.success ? new Date().toISOString() : null
            });
            await createNotification(userId, 'TV Subscription Failed',
                `TV subscription of ${packageData.name} for ${customerId} failed. ${refundResult.success ? 'Your wallet has been refunded.' : 'A refund is being processed.'}`,
                'error', '/bills');

            if (orderId) {
                await recordOrder({
                    billTransactionId: transaction.id, reference, userId,
                    productType: 'tv', serviceId, provider: 'vtpass',
                    currency: 'NGN', amount: packageAmount, serviceFee, totalAmount,
                    providerCost: 0, status: 'failed',
                    recipient: customerId,
                    metadata: {
                        customer_number: customerId, package_name: packageData.name,
                        subscription_type: subscriptionType,
                        failure_reason: vtpassResult.friendlyError || vtpassResult.error
                    }
                }).catch(e => console.error('[TV] recordOrder failed status failed:', e.message));
            }

            responseData = { transactionId: transaction.id, reference, status: 'failed', amount: packageAmount, recipient: customerId, customerName: verification.customerName, package: packageData.name, error: vtpassResult.friendlyError || vtpassResult.error, refunded: !!refundResult.success };
        }

        await completeIdempotencyKey(userId, idempotencyKey, '/api/bills/tv/purchase', responseData);
        const newBalance = await getWalletBalance(userId, 'NGN');
        return res.json({ success: true, data: { ...responseData, new_balance: newBalance } });

    } catch (error) {
        console.error('❌ TV purchase error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Purchase failed', code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  STATUS
// ═══════════════════════════════════════════════════════════════
router.get('/status/:id', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        const { data: transaction, error } = await supabaseAdmin
            .from('bill_payment_transactions')
            .select('*').eq('id', req.params.id).eq('user_id', userId).maybeSingle();
        if (error) throw error;
        if (!transaction) return res.status(404).json({ success: false, error: 'Transaction not found', code: 'NOT_FOUND' });
        res.json({
            success: true,
            data: {
                transactionId: transaction.id,
                reference: transaction.reference,
                status: transaction.status,
                serviceType: transaction.service_type,
                serviceId: transaction.service_id,
                amount: parseFloat(transaction.customer_amount) || 0,
                fee: parseFloat(transaction.service_fee) || 0,
                total: parseFloat(transaction.customer_amount) || 0,
                recipient: transaction.recipient,
                network: transaction.network,
                providerStatus: transaction.provider_status,
                providerCode: transaction.provider_code,
                failureReason: transaction.failure_reason,
                token: transaction.token || null,
                units: transaction.units || null,
                refunded: transaction.refunded || false,
                createdAt: transaction.created_at,
                completedAt: transaction.completed_at
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch status', code: 'SERVER_ERROR' });
    }
});

router.post('/status/:id/refresh', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        const { id } = req.params;
        if (!checkRateLimit(`refresh_${userId}_${id}`, 60 * 1000, 3)) {
            return res.status(429).json({ success: false, error: 'Too many refresh attempts.', code: 'RATE_LIMITED' });
        }
        const { data: transaction, error } = await supabaseAdmin
            .from('bill_payment_transactions')
            .select('*').eq('id', id).eq('user_id', userId).maybeSingle();
        if (error) throw error;
        if (!transaction) return res.status(404).json({ success: false, error: 'Transaction not found', code: 'NOT_FOUND' });
        if (['completed','failed','refunded','cancelled'].includes(transaction.status)) {
            return res.json({ success: true, data: {
                transactionId: transaction.id, reference: transaction.reference,
                status: transaction.status, message: 'Transaction is already in a terminal state'
            }});
        }
        if (transaction.provider_request_id) {
            const requery = await vtpassService.queryTransaction(transaction.provider_request_id);
            if (requery.state === 'completed') {
                await updateTransaction(transaction.id, {
                    status: 'completed',
                    provider_status: requery.providerStatus,
                    provider_code: requery.code,
                    token: requery.token || transaction.token,
                    units: requery.units || transaction.units,
                    completed_at: new Date().toISOString()
                });
                if (transaction.service_type) {
                    await recordOrder({
                        billTransactionId: transaction.id,
                        reference: transaction.reference,
                        userId: transaction.user_id,
                        productType: transaction.service_type,
                        serviceId: transaction.service_id,
                        provider: 'vtpass',
                        currency: transaction.currency || 'NGN',
                        amount: Number(transaction.base_amount || transaction.customer_amount || 0),
                        serviceFee: Number(transaction.service_fee || 0),
                        totalAmount: Number(transaction.customer_amount || 0),
                        providerCost: 0,
                        status: 'completed',
                        recipient: transaction.recipient,
                        metadata: { via: 'status_refresh' }
                    }).catch(e => console.error('[STATUS-REFRESH] recordOrder completed failed:', e.message));
                }
                return res.json({ success: true, data: {
                    transactionId: transaction.id, reference: transaction.reference,
                    status: 'completed', token: requery.token, units: requery.units
                }});
            }
            if (requery.state === 'failed') {
                let refundedOk = !!transaction.refunded;
                if (transaction.ledger_transaction_id && !refundedOk) {
                    const refundOutcome = await attemptRefund({
                        userId, ledgerTransactionId: transaction.ledger_transaction_id,
                        reason: requery.friendlyError || 'Provider transaction failed',
                        sourceContext: { bill_transaction_id: transaction.id, reference: transaction.reference, service: transaction.service_type, via: 'status_refresh', provider_status: requery.providerStatus, provider_code: requery.code }
                    });
                    refundedOk = !!refundOutcome.success;
                }
                await updateTransaction(transaction.id, {
                    status: 'failed',
                    provider_status: requery.providerStatus,
                    provider_code: requery.code,
                    failure_reason: requery.friendlyError,
                    failed_at: new Date().toISOString(),
                    refunded: refundedOk,
                    refunded_at: refundedOk ? new Date().toISOString() : (transaction.refunded_at || null)
                });
                if (transaction.service_type) {
                    await recordOrder({
                        billTransactionId: transaction.id,
                        reference: transaction.reference,
                        userId: transaction.user_id,
                        productType: transaction.service_type,
                        serviceId: transaction.service_id,
                        provider: 'vtpass',
                        currency: transaction.currency || 'NGN',
                        amount: Number(transaction.base_amount || transaction.customer_amount || 0),
                        serviceFee: Number(transaction.service_fee || 0),
                        totalAmount: Number(transaction.customer_amount || 0),
                        providerCost: 0,
                        status: 'failed',
                        recipient: transaction.recipient,
                        metadata: { via: 'status_refresh', failure_reason: requery.friendlyError }
                    }).catch(e => console.error('[STATUS-REFRESH] recordOrder failed failed:', e.message));
                }
                return res.json({ success: true, data: {
                    transactionId: transaction.id, reference: transaction.reference,
                    status: 'failed', error: requery.friendlyError, refunded: refundedOk
                }});
            }
            await updateTransaction(transaction.id, {
                provider_status: requery.providerStatus,
                provider_code: requery.code
            });
        }
        res.json({ success: true, data: {
            transactionId: transaction.id, reference: transaction.reference,
            status: transaction.status, message: 'Transaction is still being processed'
        }});
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to refresh status', code: 'SERVER_ERROR' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  HISTORY (VTpass only — DT One lives on the Global page)
// ═══════════════════════════════════════════════════════════════
router.get('/history', authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.id;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;
        const serviceType = req.query.service_type ? String(req.query.service_type).toLowerCase() : null;
        const statusFilter = req.query.status ? String(req.query.status).toLowerCase() : null;

        let q = supabaseAdmin
            .from('bill_payment_transactions')
            .select('*', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (serviceType && BILL_TYPES.includes(serviceType)) q = q.eq('service_type', serviceType);
        if (statusFilter) q = q.eq('status', statusFilter);

        const { data, error, count } = await q;
        if (error && error.code !== '42P01') throw error;

        const shaped = (data || []).map(mapBillRow);
        return res.json({
            success: true, data: shaped,
            meta: { page, limit, total: count || 0, hasMore: offset + shaped.length < (count || 0) }
        });
    } catch (error) {
        console.error('❌ History error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch history', code: 'SERVER_ERROR' });
    }
});

function mapBillRow(t) {
    const amt = num(t.customer_amount);
    const status = String(t.status || 'pending').toLowerCase();
    return {
        id: t.id,
        source: 'vtpass',
        reference: t.reference,
        service_type: t.service_type,
        service_id: t.service_id,
        status,
        recipient: t.recipient || '—',
        network: t.network || null,
        customer_amount: amt,
        currency: t.currency || 'NGN',
        provider_status: t.provider_status || null,
        provider_code: t.provider_code || null,
        token: t.token || null,
        units: t.units || null,
        refunded: !!t.refunded,
        created_at: t.created_at,
        updated_at: t.updated_at,
        completed_at: t.completed_at,
        failed_at: t.failed_at,
        failure_reason: t.failure_reason || null,
        metadata: t.metadata || {}
    };
}

// ═══════════════════════════════════════════════════════════════
//  WALLET
// ═══════════════════════════════════════════════════════════════
router.get('/wallet/balance', authMiddleware, async (req, res) => {
    try {
        const balance = await getWalletBalance(req.user?.id, 'NGN');
        res.json({ success: true, data: { currency: 'NGN', balance } });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch balance', code: 'SERVER_ERROR' });
    }
});

router.get('/health', async (req, res) => {
    try {
        const vtpassHealth = await vtpassService.healthCheck();
        res.json({ success: true, vtpass: vtpassHealth, timestamp: new Date().toISOString() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message, code: 'HEALTH_CHECK_FAILED' });
    }
});

module.exports = router;