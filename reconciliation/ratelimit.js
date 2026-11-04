// reconciliation/ratelimit.js
// ─────────────────────────────────────────────────────────────────
// Per-provider token bucket. Same shape as the previous
// reconciliationService.js implementation, but with two additions:
//
//   • A provider-wide cooldown after a 429. When the bucket is told
//     "the provider just rate-limited us", it stops serving tokens
//     for cooldownMs. Every candidate in that window sees
//     { rateLimited: true } instead of consuming a token and
//     burning a provider call that would also 429.
//   • In-process only. Two instances of the app each have their own
//     bucket; the provider's own limit is per-account, not per-IP,
//     so this is acceptable for the current single-instance deploy.
//     If you scale to N instances, divide `tokensPerSec` by N.
// ─────────────────────────────────────────────────────────────────
'use strict';

const CONFIG = {
    korapay:     { tokensPerSec: 4, burst: 5,  cooldownMs: 60_000 },
    nowpayments: { tokensPerSec: 8, burst: 10, cooldownMs: 30_000 },
    dtone:       { tokensPerSec: 3, burst: 4,  cooldownMs: 60_000 },
    vtpass:      { tokensPerSec: 4, burst: 5,  cooldownMs: 60_000 }
};

const DEFAULT_CFG = { tokensPerSec: 5, burst: 5, cooldownMs: 60_000 };

class Bucket {
    constructor({ tokensPerSec, burst, cooldownMs }) {
        this.capacity     = burst;
        this.tokens       = burst;
        this.refillPerMs  = tokensPerSec / 1000;
        this.cooldownMs   = cooldownMs;
        this.last         = Date.now();
        this.cooldownUntil = 0;
    }

    _refill() {
        const now = Date.now();
        if (now >= this.cooldownUntil) {
            this.tokens = Math.min(
                this.capacity,
                this.tokens + (now - this.last) * this.refillPerMs
            );
        }
        this.last = now;
    }

    /**
     * Consume one token, or wait until one is available.
     * Returns { ok: true } on success.
     * Returns { ok: false, retryAfterMs } if the provider is in
     * cooldown — the engine records a `rate_limited` count and
     * moves on without calling the provider.
     */
    async acquire() {
        const now = Date.now();
        if (now < this.cooldownUntil) {
            return { ok: false, retryAfterMs: this.cooldownUntil - now };
        }
        this._refill();
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return { ok: true };
        }
        const wait = Math.max((1 - this.tokens) / this.refillPerMs, 50);
        // Yield to the event loop instead of busy-waiting. The engine
        // awaits this so a burst of candidates doesn't all call the
        // provider at once.
        await new Promise(r => setTimeout(r, wait));
        return this.acquire();
    }

    /**
     * Triggered by the engine when the provider returns 429.
     * Every subsequent acquire() in the cooldown window returns
     * { ok: false, retryAfterMs }.
     */
    trigger429() {
        this.cooldownUntil = Date.now() + this.cooldownMs;
        this.tokens = 0;
    }
}

const buckets = new Map();

function getBucket(provider) {
    const cfg = CONFIG[provider] || DEFAULT_CFG;
    if (!buckets.has(provider)) buckets.set(provider, new Bucket(cfg));
    return buckets.get(provider);
}

/**
 * Is the given provider currently in cooldown?
 * The engine uses this to skip the whole provider for the rest of
 * the sweep after a 429, rather than calling acquire() N times.
 */
function isCoolingDown(provider) {
    const b = buckets.get(provider);
    if (!b) return false;
    return Date.now() < b.cooldownUntil;
}

module.exports = { getBucket, isCoolingDown, Bucket };