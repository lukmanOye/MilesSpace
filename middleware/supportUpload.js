'use strict';

const multer = require('multer');
const path = require('path');
const supportAttachments = require('../services/supportAttachmentService');

const MAX_FILES       = supportAttachments.MAX_FILES || 5;
const MAX_FILE_BYTES  = supportAttachments.MAX_FILE_BYTES || 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = supportAttachments.MAX_TOTAL_BYTES || 25 * 1024 * 1024;
const ALLOWED_MIMES   = supportAttachments.ALLOWED_MIMES || new Set();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 10, fieldSize: 128 * 1024 },
    fileFilter: (req, file, cb) => {
        const mime = String(file.mimetype || '').toLowerCase();
        if (!ALLOWED_MIMES.has(mime)) {
            const e = new Error('File type "' + (mime || 'unknown') + '" is not allowed.');
            e.code = 'MIME_NOT_ALLOWED'; e.status = 400;
            return cb(e);
        }
        if (mime === 'application/x-msdownload' || mime === 'application/x-executable' || mime === 'application/x-sh' || mime === 'application/javascript' || mime === 'text/html' || mime === 'image/svg+xml') {
            const e = new Error('File type is not allowed.');
            e.code = 'MIME_NOT_ALLOWED'; e.status = 400;
            return cb(e);
        }
        cb(null, true);
    }
});

// Fix: Await the async validateFiles
async function validateBatch(files) {
    const list = Array.isArray(files) ? files : [];
    try {
        const result = await supportAttachments.validateFiles(list);
        if (!result.ok) return { ok: false, code: result.code || 'INVALID_FILE', error: result.error || 'Invalid file' };
        return { ok: true, files: result.files, totalBytes: result.totalBytes };
    } catch (e) {
        return { ok: false, code: 'VALIDATION_FAILED', error: e.message || 'Validation failed' };
    }
}

function uploadBatch(fieldName = 'attachments') {
    const arrayMw = upload.array(fieldName, MAX_FILES);
    return (req, res, next) => {
        arrayMw(req, res, (err) => {
            if (err) {
                const code = err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE'
                           : err.code === 'LIMIT_FILE_COUNT' ? 'TOO_MANY_FILES'
                           : err.code === 'LIMIT_UNEXPECTED_FILE' ? 'UNEXPECTED_FIELD'
                           : err.code === 'LIMIT_FIELD_SIZE' ? 'FIELD_TOO_LARGE'
                           : err.code || 'UPLOAD_ERROR';
                const status = code === 'FILE_TOO_LARGE' || code === 'TOO_MANY_FILES' ? 413 : 400;
                return res.status(status).json({ success: false, code, error: err.message || 'Upload rejected.' });
            }
            const files = req.files || [];
            let total = 0;
            for (const f of files) total += Number(f.size) || 0;
            if (total > MAX_TOTAL_BYTES) {
                return res.status(413).json({ success: false, code: 'REQUEST_TOO_LARGE', error: 'Total upload must be under ' + Math.round(MAX_TOTAL_BYTES / 1024 / 1024) + ' MB.' });
            }
            next();
        });
    };
}

module.exports = upload;
module.exports.upload = upload;
module.exports.uploadBatch = uploadBatch;
module.exports.validateBatch = validateBatch;
module.exports.MAX_FILES = MAX_FILES;
module.exports.MAX_FILE_BYTES = MAX_FILE_BYTES;
module.exports.MAX_TOTAL_BYTES = MAX_TOTAL_BYTES;
module.exports.ALLOWED_MIMES = ALLOWED_MIMES;