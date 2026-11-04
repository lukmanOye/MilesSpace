// reconciliation/scheduler.js
// ─────────────────────────────────────────────────────────────────
// Single self-rescheduling loop for:
//   • Sweeps (every 5 min, one per service, sequential)
//   • SLA check (every 15 min)
//   • Daily audit (once per day at ~02:00 UTC)
//   • Daily summary alert (once per day at ~07:00 UTC)
//
// Each job is a setTimeout that, on completion, calls setTimeout
// again. Never setInterval — a slow audit must not overlap the next
// one.
//
// Failure isolation:
//   A failing job logs, sends alertRunFailed, and reschedules itself.
//   One broken adapter cannot stop the others.
// ─────────────────────────────────────────────────────────────────
'use strict';

const { supabaseAdmin } = require('../db/supabase');
const engine = require('./engine');
const { getAdapter, listAdapters } = require('./adapters');
const auditJob = require('./auditJob');
const alerts = require('./alerts');

const SWEEP_INTERVAL_MS        = 5 * 60 * 1000;    // 5 min
const SLA_CHECK_INTERVAL_MS    = 15 * 60 * 1000;   // 15 min
const AUDIT_CHECK_INTERVAL_MS  = 60 * 60 * 1000;   // hourly "is it 2am yet?"
const SUMMARY_CHECK_INTERVAL_MS= 60 * 60 * 1000;   // hourly "is it 7am yet?"
const AUDIT_HOUR_UTC           = 2;
const SUMMARY_HOUR_UTC         = 7;

function log(...a)    { console.log('[RECON SCHED]', ...a); }
function logErr(...a) { console.error('[RECON SCHED]', ...a); }

let started = false;
let sweepTimer = null;
let slaTimer = null;
let auditTimer = null;
let summaryTimer = null;
let shuttingDown = false;

// ─── Sweeps ──────────────────────────────────────────────────────
async function runSweepsOnce() {
    const services = listAdapters().map(a => a.key);
    for (const key of services) {
        if (shuttingDown) return;
        try {
            const adapter = getAdapter(key);
            await engine.runService(adapter, { adminEmail: 'system:scheduler' });
        } catch (e) {
            logErr(`sweep ${key} failed:`, e.message);
        }
    }
}

function scheduleSweep() {
    if (shuttingDown) return;
    sweepTimer = setTimeout(async () => {
        try {
            await runSweepsOnce();
        } catch (e) {
            logErr('sweep cycle failed:', e.message);
        } finally {
            scheduleSweep();
        }
    }, SWEEP_INTERVAL_MS);
    if (sweepTimer.unref) sweepTimer.unref();
}

// ─── SLA breach check ────────────────────────────────────────────
async function runSlaCheckOnce() {
    const nowIso = new Date().toISOString();
    const { data: breached, error } = await supabaseAdmin
        .from('reconciliation_issues')
        .select('id, service, issue_type, internal_ref, sla_due_at, severity')
        .in('status', ['open','assigned','investigating'])
        .lt('sla_due_at', nowIso)
        .order('sla_due_at', { ascending: true })
        .limit(50);
    if (error) throw error;
    if (!breached || !breached.length) return;
    await alerts.alertSlaBreaches(breached);
}

function scheduleSlaCheck() {
    if (shuttingDown) return;
    slaTimer = setTimeout(async () => {
        try { await runSlaCheckOnce(); }
        catch (e) { logErr('sla check failed:', e.message); }
        finally { scheduleSlaCheck(); }
    }, SLA_CHECK_INTERVAL_MS);
    if (slaTimer.unref) slaTimer.unref();
}

// ─── Daily audit ─────────────────────────────────────────────────
async function runDailyAuditOnce() {
    const forDate = (() => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
    })();
    // Skip if already run for that date.
    const { data: existing } = await supabaseAdmin
        .from('reconciliation_runs')
        .select('id')
        .eq('type', 'audit')
        .gte('started_at', `${forDate}T00:00:00Z`)
        .lt('started_at', `${forDate}T23:59:59Z`)
        .limit(1);
    if (existing && existing.length) {
        log(`audit for ${forDate} already ran — skipping`);
        return;
    }
    const summary = await auditJob.runDailyAudit({ forDate });
    log('audit done:', JSON.stringify(summary).slice(0, 200));
}

function scheduleDailyAudit() {
    if (shuttingDown) return;
    auditTimer = setTimeout(async () => {
        try {
            const now = new Date();
            if (now.getUTCHours() === AUDIT_HOUR_UTC && now.getUTCMinutes() < 30) {
                await runDailyAuditOnce();
            }
        } catch (e) {
            logErr('audit failed:', e.message);
        } finally {
            scheduleDailyAudit();
        }
    }, AUDIT_CHECK_INTERVAL_MS);
    if (auditTimer.unref) auditTimer.unref();
}

// ─── Daily summary alert ─────────────────────────────────────────
async function runDailySummaryOnce() {
    const today = new Date().toISOString().slice(0, 10);
    // Aggregate yesterday's sweep + audit runs.
    const yesterdayStart = (() => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - 1);
        d.setUTCHours(0, 0, 0, 0);
        return d.toISOString();
    })();
    const yesterdayEnd = (() => {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        return d.toISOString();
    })();

    const { data: runs } = await supabaseAdmin
        .from('reconciliation_runs')
        .select('service, status, scanned, settled, failed, manual_review, type')
        .gte('started_at', yesterdayStart)
        .lt('started_at', yesterdayEnd);

    const by_service = {};
    let auto_resolved = 0, manual = 0;
    for (const r of runs || []) {
        const s = r.service || 'unknown';
        if (!by_service[s]) by_service[s] = { scanned: 0, settled: 0, failed: 0, manual_review: 0 };
        by_service[s].scanned += r.scanned || 0;
        by_service[s].settled += r.settled || 0;
        by_service[s].failed += r.failed || 0;
        by_service[s].manual_review += r.manual_review || 0;
        auto_resolved += r.settled || 0;
        manual += r.manual_review || 0;
    }

    // Money at risk = sum of `amount` for critical open issues.
    const { data: criticals } = await supabaseAdmin
        .from('reconciliation_issues')
        .select('amount, currency')
        .eq('severity', 'critical')
        .in('status', ['open','assigned','investigating'])
        .limit(500);
    const riskByCcy = {};
    for (const c of criticals || []) {
        const ccy = (c.currency || 'NGN').toUpperCase();
        riskByCcy[ccy] = (riskByCcy[ccy] || 0) + Number(c.amount || 0);
    }
    const money_at_risk = Object.entries(riskByCcy)
        .map(([ccy, amt]) => `${amt.toFixed(2)} ${ccy}`)
        .join(', ') || '0';

    await alerts.alertDailySummary({
        date: today,
        by_service,
        money_at_risk,
        auto_resolved,
        manual
    });
}

function scheduleDailySummary() {
    if (shuttingDown) return;
    summaryTimer = setTimeout(async () => {
        try {
            const now = new Date();
            if (now.getUTCHours() === SUMMARY_HOUR_UTC && now.getUTCMinutes() < 30) {
                await runDailySummaryOnce();
            }
        } catch (e) {
            logErr('daily summary failed:', e.message);
        } finally {
            scheduleDailySummary();
        }
    }, SUMMARY_CHECK_INTERVAL_MS);
    if (summaryTimer.unref) summaryTimer.unref();
}

// ─── Start / stop ────────────────────────────────────────────────
function start() {
    if (started) return;
    started = true;
    shuttingDown = false;
    log('scheduler starting');
    // First sweep after 10s so the app is up.
    setTimeout(() => {
        runSweepsOnce().catch(e => logErr('initial sweep failed:', e.message));
    }, 10_000);
    scheduleSweep();
    scheduleSlaCheck();
    scheduleDailyAudit();
    scheduleDailySummary();
}

function stop() {
    shuttingDown = true;
    if (sweepTimer)   { clearTimeout(sweepTimer);   sweepTimer = null; }
    if (slaTimer)     { clearTimeout(slaTimer);     slaTimer = null; }
    if (auditTimer)   { clearTimeout(auditTimer);   auditTimer = null; }
    if (summaryTimer) { clearTimeout(summaryTimer); summaryTimer = null; }
    started = false;
    log('scheduler stopped');
}

module.exports = { start, stop, runSweepsOnce, runSlaCheckOnce, runDailyAuditOnce, runDailySummaryOnce };