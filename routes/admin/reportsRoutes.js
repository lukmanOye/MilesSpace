// routes/admin/reportsRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const { requirePermission, PERMISSIONS, recordAdminAction } = require('../../middleware/adminAuth');
const reports = require('../../services/reportsService');

function ok(res, data) { if (!res.headersSent) res.json({ success: true, ...data }); }
function err(res, e) {
    if (res.headersSent) return;
    const status = e.status || 500;
    if (status >= 500) console.error('[REPORTS]', e);
    res.status(status).json({ success: false, code: e.code || 'REPORTS_ERROR', error: e.message || 'Request failed.' });
}

router.get('/meta', requirePermission(PERMISSIONS.REPORTS_READ), async (req, res) => {
    try { ok(res, await reports.getMeta(req.adminContext)); } catch (e) { err(res, e); }
});

router.get('/overview', requirePermission(PERMISSIONS.REPORTS_READ), async (req, res) => {
    try { ok(res, await reports.getOverview(req.query, req.adminContext)); } catch (e) { err(res, e); }
});

router.get('/timeseries', requirePermission(PERMISSIONS.REPORTS_READ), async (req, res) => {
    try { ok(res, await reports.getTimeseries(req.query)); } catch (e) { err(res, e); }
});

router.get('/transactions', requirePermission(PERMISSIONS.REPORTS_READ), async (req, res) => {
    try { ok(res, await reports.getTransactions(req.query, req.adminContext)); } catch (e) { err(res, e); }
});

router.get('/export', requirePermission(PERMISSIONS.REPORTS_EXPORT), async (req, res) => {
    try {
        const report = String(req.query.report || '').toLowerCase();
        if (!['transactions'].includes(report)) {
            const e = new Error('Unknown export kind'); e.status = 422; throw e;
        }
        const result = await reports.exportReport({ report, query: req.query });
        
        await recordAdminAction({
            adminId: req.adminContext.id,
            action: 'reports.export',
            targetId: report,
            req
        }).catch(() => {});

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${report}.csv"`);
        res.send('\uFEFF' + result.csv);
    } catch (e) { err(res, e); }
});

module.exports = router;