'use strict';

// ─────────────────────────────────────────────────────────────────
// middleware/supportUpload.js  —  NEW  2026-11-02
//
// Central multer configuration for support attachments, plus a
// validateBatch() helper kept for backward compatibility with any
// caller that imported it directly.
//
// This middleware performs the FIRST line of defence:
//   • count, per-file size, total request size enforced by multer
//   • mimetype allow-list enforced at the multer `fileFilter` stage
//     so a disallowed file never reaches memory
//
// The AUTHORITATIVE checks (magic bytes, filename sanitization,
// active-content rejection) live in
// services/supportAttachmentService.validateFiles(), which runs
// after multer. Routes call that through uploadForMessage(), so
// there is exactly one place to audit the real validation policy.
//
// If your route already imports `validateBatch` from this module,
// it will keep working — validateBatch now delegates to the same
// shared policy.
// ─────────────────────────────────────────────────────────────────

const multer = require('multer');
const path = require('path');

const supportAttachments = require('../services/supportAttachmentService');

// ─── Constants (mirrored from supportAttachmentService) ────────
// We mirror them rather than reading from the service at import
// time because multer's config must be a plain object. The service
// remains the source of truth — this module reads the same values
// so the two stay in lockstep.
const MAX_FILES       = supportAttachments.MAX_FILES || 5;
const MAX_FILE_BYTES  = supportAttachments.MAX_FILE_BYTES || 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = supportAttachments.MAX_TOTAL_BYTES || 25 * 1024 * 1024;
const ALLOWED_MIMES   = supportAttachments.ALLOWED_MIMES || new Set();

// ─── Multer instance ───────────────────────────────────────────
// Memory storage: the buffer is validated, then streamed to
// Cloudinary. No temp files hit the server's disk.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_BYTES,
        files:    MAX_FILES,
        // A slightly generous field limit prevents a form-field
        // DoS while still covering `message` + `is_internal` +
        // future small metadata fields.
        fields:   10,
        fieldSize: 128 * 1024
    },
    fileFilter: (req, file, cb) => {
        const mime = String(file.mimetype || '').toLowerCase();
        if (!ALLOWED_MIMES.has(mime)) {
            const e = new Error('File type "' + (mime || 'unknown') + '" is not allowed.');
            e.code = 'MIME_NOT_ALLOWED';
            e.status = 400;
            return cb(e);
        }
        // Explicit reject of the most common dangerous types. The
        // service will also sniff the head, but rejecting here
        // saves the buffer allocation for the obvious cases.
        if (
            mime === 'application/x-msdownload' ||
            mime === 'application/x-executable' ||
            mime === 'application/x-sh' ||
            mime === 'application/javascript' ||
            mime === 'text/html' ||
            mime === 'image/svg+xml'
        ) {
            const e = new Error('File type is not allowed.');
            e.code = 'MIME_NOT_ALLOWED';
            e.status = 400;
            return cb(e);
        }
        cb(null, true);
    }
});

// ─── validateBatch ────────────────────────────────────────────
// Backward-compatible synchronous wrapper around the service's
// validateFiles(). Returns { ok, error?, code? } — never throws —
// so existing route handlers that used the old contract keep
// working.
//
// New code SHOULD call supportAttachments.uploadForMessage() and
// let it validate + upload in one shot. This function is here for
// any caller that needs to validate without uploading (e.g. a
// pre-flight endpoint added later).
function validateBatch(files) {
    const list = Array.isArray(files) ? files : [];
    try {
        const result = supportAttachments.validateFiles(list);
        if (!result.ok) {
            return {
                ok: false,
                code: result.code || 'INVALID_FILE',
                error: result.error || 'Invalid file'
            };
        }
        // Return the sanitized files so a caller can forward them
        // directly to Cloudinary if it wants.
        return { ok: true, files: result.files, totalBytes: result.totalBytes };
    } catch (e) {
        return { ok: false, code: 'VALIDATION_FAILED', error: e.message || 'Validation failed' };
    }
}

// ─── Total-size guard middleware ──────────────────────────────
// multer enforces per-file size and count. It does NOT enforce a
// total across the batch — that is our job. Wraps multer.array so
// routes can `router.post(path, uploadBatch('attachments'), handler)`
// and rely on both layers.
function uploadBatch(fieldName = 'attachments') {
    const arrayMw = upload.array(fieldName, MAX_FILES);
    return (req, res, next) => {
        arrayMw(req, res, (err) => {
            if (err) {
                // Normalise multer errors so the route can render a
                // useful body.
                const code = err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE'
                           : err.code === 'LIMIT_FILE_COUNT' ? 'TOO_MANY_FILES'
                           : err.code === 'LIMIT_UNEXPECTED_FILE' ? 'UNEXPECTED_FIELD'
                           : err.code === 'LIMIT_FIELD_SIZE' ? 'FIELD_TOO_LARGE'
                           : err.code || 'UPLOAD_ERROR';
                const status = code === 'FILE_TOO_LARGE' || code === 'TOO_MANY_FILES' ? 413 : 400;
                return res.status(status).json({
                    success: false,
                    code,
                    error: err.message || 'Upload rejected.'
                });
            }
            const files = req.files || [];
            let total = 0;
            for (const f of files) total += Number(f.size) || 0;
            if (total > MAX_TOTAL_BYTES) {
                return res.status(413).json({
                    success: false,
                    code: 'REQUEST_TOO_LARGE',
                    error: 'Total upload must be under ' + Math.round(MAX_TOTAL_BYTES / 1024 / 1024) + ' MB.'
                });
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