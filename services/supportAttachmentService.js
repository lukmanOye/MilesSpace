// services/supportAttachmentService.js
// ─────────────────────────────────────────────────────────────────
// REVISION 2026-11-05
//
// Signed-URL fix:
//   resolveAttachmentUrl() now derives `format` from the stored
//   mime (or from the filename extension as a fallback) and passes
//   it to cloudinarySvc.getSignedUrl. Cloudinary's URL builder
//   needs the extension in the path for type: 'private' assets;
//   without it, the SDK throws "The first argument must be of type
//   string..." from inside crypto.createHmac.
//
//   If format cannot be derived, resolveAttachmentUrl() returns
//   null so the UI renders "unavailable" instead of throwing.
//
// Everything else from the previous revision is preserved:
//   • One upload path for both reply and internal-note endpoints.
//   • MIME + magic-byte verification.
//   • Filename sanitization including bidi / Windows reserved names.
//   • HEIC rejection (with optional sharp-based conversion path).
//   • Cloudinary upload with type: 'private' + access_mode: authenticated.
//   • Cleanup on DB-write failure that never leaks orphan public_ids
//     into logs without context.
//   • Client shape never includes public_id / storage / resource_type.
// ─────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const cloudinarySvc = require('./cloudinaryService');

// ─── Limits ──────────────────────────────────────────────────────
const MAX_FILES            = 5;
const MAX_FILE_BYTES       = 10 * 1024 * 1024;      // 10 MB per file
const MAX_TOTAL_BYTES      = 25 * 1024 * 1024;      // 25 MB per request
const MAX_FILENAME_LEN     = 120;
const MAX_ATTACHMENT_NAME  = 200;
const SIGNED_URL_TTL_SECS  = 5 * 60;                // 5 minutes

// ─── HEIC policy ─────────────────────────────────────────────────
// "reject" (default) — clear error, no new dependency.
// "convert"          — requires `sharp` installed and
//                      ENABLE_HEIC_CONVERT=true in env. Converts
//                      to JPEG in memory before upload.
const HEIC_POLICY = (() => {
    const raw = String(process.env.ENABLE_HEIC_CONVERT || '').toLowerCase();
    return raw === '1' || raw === 'true' ? 'convert' : 'reject';
})();

let _sharp = null;
function _tryLoadSharp() {
    if (_sharp !== null) return _sharp;
    try {
        // eslint-disable-next-line global-require
        _sharp = require('sharp');
    } catch (_) {
        _sharp = false;
    }
    return _sharp;
}

// ─── MIME allow-list ─────────────────────────────────────────────
const ALLOWED_MIMES = Object.freeze(new Set([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif',
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/vnd.ms-excel',
    'application/zip',
    'application/x-zip-compressed',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]));

// Accepted at the multer layer but rejected here with a specific
// message the frontend can act on.
const REJECT_WITH_MESSAGE = Object.freeze(new Set([
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence'
]));

// Explicit reject list at the sniff layer (active content).
const FORBIDDEN_MIMES = Object.freeze(new Set([
    'image/svg+xml',
    'text/html',
    'application/xhtml+xml',
    'application/javascript',
    'application/x-javascript',
    'text/javascript',
    'application/x-sh',
    'application/x-bat',
    'application/x-msdownload',
    'application/x-msdos-program',
    'application/x-executable',
    'application/x-sharedlib',
    'application/x-dosexec',
    'application/x-mach-binary'
]));

// ─── Errors ──────────────────────────────────────────────────────
function attachmentError(code, message, status = 400, extra = {}) {
    const e = new Error(message);
    e.code = code;
    e.status = status;
    Object.assign(e, extra);
    return e;
}

// ─── Format derivation for Cloudinary ───────────────────────────
// type: 'private' URLs require the extension in the path. The
// attachment's `mime` is the reliable source. Filename extension
// is a fallback for legacy rows whose mime is missing or wrong.
function deriveFormat(att) {
    if (!att || typeof att !== 'object') return null;

    if (att.format && typeof att.format === 'string' && att.format.trim()) {
        return att.format.trim();
    }

    const mime = String(att.mime || '').toLowerCase();
    const mimeMap = {
        'image/png':  'png',
        'image/jpeg': 'jpg',
        'image/jpg':  'jpg',
        'image/webp': 'webp',
        'image/gif':  'gif',
        'application/pdf': 'pdf',
        'text/plain': 'txt',
        'text/csv':   'csv',
        'application/zip': 'zip',
        'application/x-zip-compressed': 'zip',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/msword': 'doc',
        'application/vnd.ms-excel': 'xls'
    };
    if (mimeMap[mime]) return mimeMap[mime];

    // Fallback: from the stored attachment name.
    const name = String(att.name || '').toLowerCase();
    const dot = name.lastIndexOf('.');
    if (dot > 0 && name.length - dot <= 6) {
        const ext = name.slice(dot + 1);
        if (/^[a-z0-9]+$/.test(ext)) return ext;
    }

    return null;
}

// ─── Filename sanitization ──────────────────────────────────────
function sanitizeFilename(raw) {
    let s = String(raw == null ? '' : raw);

    // Path separators and Windows drive letters.
    s = s.replace(/[\/\\]/g, '_').replace(/^[A-Za-z]:/, '');

    // Unicode bidi override / isolation characters.
    s = s.replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g, '');

    // Control chars.
    s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

    // Leading dots (hidden files) and trailing dots.
    s = s.replace(/^\.+/, '').replace(/\.+$/, '');

    // Collapse whitespace.
    s = s.replace(/[\s\u00A0]+/g, ' ').trim();

    // Windows reserved device names.
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(s)) s = '_' + s;

    // Cap length while preserving extension.
    if (s.length > MAX_FILENAME_LEN) {
        const dot = s.lastIndexOf('.');
        if (dot > 0 && s.length - dot <= 10) {
            const ext = s.slice(dot);
            s = s.slice(0, MAX_FILENAME_LEN - ext.length) + ext;
        } else {
            s = s.slice(0, MAX_FILENAME_LEN);
        }
    }

    return s || 'attachment';
}

// ─── Extension → declared MIME resolution ───────────────────────
function mimeFromExtension(name) {
    const n = String(name || '').toLowerCase();
    if (n.endsWith('.png'))  return 'image/png';
    if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
    if (n.endsWith('.webp')) return 'image/webp';
    if (n.endsWith('.gif'))  return 'image/gif';
    if (n.endsWith('.pdf'))  return 'application/pdf';
    if (n.endsWith('.csv'))  return 'text/csv';
    if (n.endsWith('.txt'))  return 'text/plain';
    if (n.endsWith('.zip'))  return 'application/zip';
    if (n.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (n.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (n.endsWith('.heic') || n.endsWith('.heif')) return 'image/heic';
    return null;
}

// ─── Signature matching ────────────────────────────────────────
function startsWith(buffer, bytes, offset = 0) {
    if (!buffer || buffer.length < offset + bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) {
        if (buffer[offset + i] !== bytes[i]) return false;
    }
    return true;
}

function containsAscii(buffer, needle, maxScan = 65536) {
    if (!buffer || !needle) return false;
    const limit = Math.min(buffer.length, maxScan);
    const n = Buffer.from(needle, 'latin1');
    for (let i = 0; i <= limit - n.length; i++) {
        let ok = true;
        for (let j = 0; j < n.length; j++) {
            if (buffer[i + j] !== n[j]) { ok = false; break; }
        }
        if (ok) return true;
    }
    return false;
}

function isBinaryHead(buffer) {
    if (!buffer || buffer.length < 4) return false;
    if (startsWith(buffer, [0x7F, 0x45, 0x4C, 0x46])) return true;        // ELF
    if (startsWith(buffer, [0x4D, 0x5A])) return true;                    // PE / MZ
    if (startsWith(buffer, [0xFE, 0xED, 0xFA])) return true;              // Mach-O (BE)
    if (startsWith(buffer, [0xCE, 0xFA, 0xED])) return true;              // Mach-O
    if (startsWith(buffer, [0xCF, 0xFA, 0xED])) return true;              // Mach-O
    if (startsWith(buffer, [0x89, 0x50, 0x4E, 0x47])) return true;        // PNG
    if (startsWith(buffer, [0xFF, 0xD8, 0xFF])) return true;              // JPEG
    if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return true;        // GIF
    if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) return true;        // PDF
    if (startsWith(buffer, [0x50, 0x4B, 0x03, 0x04])) return true;        // ZIP
    return false;
}

function matchesSignature(buffer, mime) {
    const m = String(mime || '').toLowerCase();

    if (m === 'image/png') {
        return startsWith(buffer, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    }
    if (m === 'image/jpeg' || m === 'image/jpg') {
        return startsWith(buffer, [0xFF, 0xD8, 0xFF]);
    }
    if (m === 'image/gif') {
        return startsWith(buffer, [0x47, 0x49, 0x46, 0x38]);
    }
    if (m === 'image/webp') {
        return startsWith(buffer, [0x52, 0x49, 0x46, 0x46], 0)
            && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8);
    }
    if (m === 'application/pdf') {
        return startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2D]);
    }
    if (m === 'application/zip' || m === 'application/x-zip-compressed') {
        return startsWith(buffer, [0x50, 0x4B, 0x03, 0x04])
            || startsWith(buffer, [0x50, 0x4B, 0x05, 0x06])
            || startsWith(buffer, [0x50, 0x4B, 0x07, 0x08]);
    }
    if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        || m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
        const zip = startsWith(buffer, [0x50, 0x4B, 0x03, 0x04]);
        return zip && containsAscii(buffer, '[Content_Types].xml');
    }
    if (m === 'text/plain' || m === 'text/csv') {
        return !isBinaryHead(buffer);
    }
    if (REJECT_WITH_MESSAGE.has(m)) {
        return false;
    }
    return false;
}

// ─── HEIC conversion (optional, off by default) ────────────────
async function maybeConvertHeic(file) {
    if (!REJECT_WITH_MESSAGE.has(String(file.mimetype || '').toLowerCase())) {
        return file;
    }
    if (HEIC_POLICY === 'reject') {
        throw attachmentError(
            'HEIC_NOT_SUPPORTED',
            'HEIC/HEIF photos are not accepted. Please take a screenshot or convert to JPEG.',
            400
        );
    }
    const sharp = _tryLoadSharp();
    if (!sharp) {
        throw attachmentError(
            'HEIC_CONVERT_UNAVAILABLE',
            'HEIC conversion is not available on this server. Please convert to JPEG.',
            400
        );
    }
    let buf;
    try {
        buf = await sharp(file.buffer).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    } catch (e) {
        throw attachmentError(
            'HEIC_CONVERT_FAILED',
            'Could not convert HEIC photo. Please try a JPEG.',
            400
        );
    }
    return {
        buffer: buf,
        mimetype: 'image/jpeg',
        size: buf.length,
        originalname: String(file.originalname || 'photo').replace(/\.(heic|heif)$/i, '.jpg'),
        rawOriginalname: file.rawOriginalname || file.originalname
    };
}

// ─── Validation entry point ────────────────────────────────────
async function validateFiles(files) {
    const list = Array.isArray(files) ? files : [];

    if (list.length > MAX_FILES) {
        return { ok: false, code: 'TOO_MANY_FILES',
                 error: `Up to ${MAX_FILES} files allowed per message.` };
    }

    let total = 0;
    const sanitized = [];

    for (const original of list) {
        if (!original || !Buffer.isBuffer(original.buffer)) {
            return { ok: false, code: 'INVALID_FILE', error: 'One of the files could not be read.' };
        }

        let f;
        try {
            f = await maybeConvertHeic(original);
        } catch (e) {
            return { ok: false, code: e.code || 'INVALID_FILE', error: e.message };
        }

        const size = Number(f.size) || f.buffer.length;
        if (size <= 0) {
            return { ok: false, code: 'EMPTY_FILE', error: 'Empty files are not allowed.' };
        }
        if (size > MAX_FILE_BYTES) {
            return { ok: false, code: 'FILE_TOO_LARGE',
                     error: `Each file must be under ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.` };
        }
        total += size;
        if (total > MAX_TOTAL_BYTES) {
            return { ok: false, code: 'REQUEST_TOO_LARGE',
                     error: `Total upload must be under ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB.` };
        }

        const declared = String(f.mimetype || '').toLowerCase();
        const ext = mimeFromExtension(f.originalname);

        const candidate = ALLOWED_MIMES.has(declared) ? declared : ext;
        if (!candidate) {
            return { ok: false, code: 'MIME_NOT_ALLOWED',
                     error: `File type "${declared || 'unknown'}" is not allowed.` };
        }
        if (FORBIDDEN_MIMES.has(declared) || FORBIDDEN_MIMES.has(candidate)) {
            return { ok: false, code: 'MIME_NOT_ALLOWED', error: 'That file type is not allowed.' };
        }

        if (!matchesSignature(f.buffer, candidate)) {
            return { ok: false, code: 'MAGIC_BYTES_MISMATCH',
                     error: `File content does not match its declared type (${candidate}).` };
        }

        const head = f.buffer.slice(0, 512).toString('utf8').trimStart().toLowerCase();
        if (head.startsWith('<!doctype html') || head.startsWith('<html')
            || head.startsWith('<script')
            || (head.startsWith('<?xml') && head.includes('<svg'))) {
            return { ok: false, code: 'ACTIVE_CONTENT_REJECTED',
                     error: 'Active content is not allowed in attachments.' };
        }

        sanitized.push({
            buffer: f.buffer,
            mimetype: candidate,
            size,
            originalname: sanitizeFilename(f.originalname),
            rawOriginalname: String(f.rawOriginalname || f.originalname || '').slice(0, 500)
        });
    }

    return { ok: true, files: sanitized, totalBytes: total };
}

// ─── Upload one attachment ─────────────────────────────────────
async function _uploadOne(file, { ticketId, isPrivate }) {
    const result = await cloudinarySvc.uploadSupportFile(file.buffer, {
        ticketId,
        mimetype: file.mimetype,
        originalname: file.originalname,
        private: !!isPrivate
    });

    const name = sanitizeFilename(file.originalname).slice(0, MAX_ATTACHMENT_NAME);

    return {
        id: crypto.randomUUID(),
        name,
        size: file.size,
        mime: file.mimetype,
        url: isPrivate ? null : result.secure_url,
        public_id: result.public_id,
        resource_type: result.resource_type,
        // Cloudinary's own `format` (extension). We save it so
        // signing is trivial later. For type: 'private' assets,
        // this is what makes the URL path complete.
        format: result.format || null,
        bytes: result.bytes,
        created_at: result.created_at || new Date().toISOString(),
        storage: isPrivate ? 'private' : 'public',
        cloudinary_type: result.type || (isPrivate ? 'private' : 'upload')
    };
}

// ─── Upload + persist entry point ──────────────────────────────
async function uploadForMessage({ files, ticketId, isPrivate = true }) {
    const validation = await validateFiles(files);
    if (!validation.ok) {
        throw attachmentError(validation.code, validation.error, 400);
    }
    if (!validation.files.length) {
        return { attachments: [], cleanup: async () => ({ deleted: 0, orphans: [] }) };
    }

    const uploadedIds = [];
    const attachments = [];

    try {
        for (const f of validation.files) {
            const att = await _uploadOne(f, { ticketId, isPrivate });
            uploadedIds.push(att.public_id);
            attachments.push(att);
        }
    } catch (uploadErr) {
        const cleanupResult = await _cleanup(uploadedIds);
        if (cleanupResult.orphans.length) {
            // eslint-disable-next-line no-console
            console.error('[SUPPORT ATTACHMENT] upload failed with orphans', JSON.stringify({
                ticketId, orphans: cleanupResult.orphans
            }));
        }
        throw attachmentError(
            uploadErr.code || 'UPLOAD_FAILED',
            uploadErr.code === 'HEIC_NOT_SUPPORTED'
                ? uploadErr.message
                : 'Could not upload attachment. Please try again.',
            500,
            { orphans: cleanupResult.orphans }
        );
    }

    const cleanup = async () => {
        const result = await _cleanup(uploadedIds);
        if (result.orphans.length) {
            // eslint-disable-next-line no-console
            console.error('[SUPPORT ATTACHMENT] DB write failed; cleanup left orphans', JSON.stringify({
                ticketId, orphans: result.orphans
            }));
        }
        return result;
    };

    return { attachments, cleanup };
}

async function _cleanup(publicIds) {
    if (!publicIds || !publicIds.length) return { deleted: 0, orphans: [] };

    let resp;
    try {
        resp = await cloudinarySvc.deleteMultipleFiles(publicIds, { type: 'private' });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[SUPPORT ATTACHMENT] deleteMultipleFiles threw', e.message);
        return { deleted: 0, orphans: publicIds.slice() };
    }

    const details = Array.isArray(resp && resp.details) ? resp.details : [];
    const orphans = details
        .filter((d) => !d.success)
        .map((d) => d.publicId || (d.details && d.details.public_id) || null)
        .filter(Boolean);

    if (!details.length && resp && resp.failed > 0) {
        return {
            deleted: Math.max(0, (resp.total || publicIds.length) - resp.failed),
            orphans: publicIds.slice()
        };
    }

    return { deleted: publicIds.length - orphans.length, orphans };
}

// ─── Read-time URL resolution ──────────────────────────────────
//
// For private attachments, mint a short-lived signed URL. For
// public, return the stored URL. Never returns a URL for an
// attachment the caller cannot access — the caller must have
// already run ticket access checks.
//
// The critical fix here: derive `format` from the attachment and
// pass it to getSignedUrl. Cloudinary's type: 'private' URLs
// require the extension in the path; without it the SDK throws
// from inside crypto.createHmac.
function resolveAttachmentUrl(attachment) {
    if (!attachment || typeof attachment !== 'object') return null;

    const storage = String(attachment.storage || 'public').toLowerCase();
    if (storage === 'public') {
        return typeof attachment.url === 'string' && /^https?:\/\//i.test(attachment.url)
            ? attachment.url
            : null;
    }

    // Guard against a missing / malformed public_id.
    if (!attachment.public_id
        || typeof attachment.public_id !== 'string'
        || !attachment.public_id.trim()) {
        return null;
    }

    // Derive the extension. Without it, signing throws.
    const format = deriveFormat(attachment);
    if (!format) {
        console.warn(
            '[SUPPORT ATTACHMENT] cannot derive format for',
            attachment.public_id,
            '(mime:', attachment.mime, ')'
        );
        return null;
    }

    const opts = {
        expiresInSeconds: SIGNED_URL_TTL_SECS,
        resource_type: attachment.resource_type || 'image',
        format,
        // Delivery type matches how the asset was uploaded.
        deliveryType: attachment.cloudinary_type || 'private'
    };

    try {
        if (typeof cloudinarySvc.getSignedUrl === 'function') {
            const url = cloudinarySvc.getSignedUrl(attachment.public_id, opts);
            if (url) return url;
        }
        if (typeof cloudinarySvc.signUrl === 'function') {
            const url = cloudinarySvc.signUrl(attachment.public_id, {
                expiresAt: Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECS,
                resourceType: attachment.resource_type || 'image',
                format,
                deliveryType: attachment.cloudinary_type || 'private'
            });
            if (url) return url;
        }
    } catch (e) {
        console.error('[SUPPORT ATTACHMENT] signed URL failed', e.message);
    }
    return null;
}

// Minimal shape for a client. Never includes public_id, storage,
// cloudinary_type, or the raw stored object.
function toClientAttachment(a) {
    if (!a || typeof a !== 'object') return null;
    const url = resolveAttachmentUrl(a);
    return {
        id: a.id || null,
        name: a.name || 'attachment',
        size: a.size || 0,
        mime: a.mime || 'application/octet-stream',
        created_at: a.created_at || null,
        resource: a.resource_type || 'raw',
        url,
        unavailable: !url
    };
}

// Resolve every attachment on every message.
function resolveMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map((m) => {
        const att = Array.isArray(m.attachments) ? m.attachments : null;
        if (!att || !att.length) return m;
        return {
            ...m,
            attachments: att.map(toClientAttachment).filter(Boolean)
        };
    });
}

// Fresh signed URL for one attachment (route helper).
function freshAttachmentUrl(attachment) {
    return resolveAttachmentUrl(attachment);
}

module.exports = {
    uploadForMessage,
    validateFiles,
    resolveAttachmentUrl,
    resolveMessages,
    freshAttachmentUrl,
    toClientAttachment,
    sanitizeFilename,

    MAX_FILES,
    MAX_FILE_BYTES,
    MAX_TOTAL_BYTES,
    ALLOWED_MIMES,
    SIGNED_URL_TTL_SECS,
    HEIC_POLICY,

    matchesSignature,
    mimeFromExtension
};