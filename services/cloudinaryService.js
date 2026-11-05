// services/cloudinaryService.js
// ─────────────────────────────────────────────────────────────────
// REVISION 2026-11-05
//
// Signed-URL fix:
//   The previous revision mixed `sign_url: true` with `auth_token`.
//   Those are two DIFFERENT signing mechanisms in Cloudinary:
//
//     • sign_url: true        — signs the delivery URL with the API
//                               secret. This is the correct mechanism
//                               for assets uploaded with
//                               type: 'private' + access_mode:
//                               'authenticated' (as we do).
//
//     • auth_token: { ... }   — Cloudinary's separate token-gated
//                               delivery for CDN strict
//                               transformations. It requires
//                               { key, duration }, and passing it
//                               without `key` caused the SDK to
//                               call crypto.createHmac with an
//                               undefined secret — which crashed
//                               with "The first argument must be of
//                               type string...".
//
//   Additionally, `type: 'private'` assets require the file
//   extension in the URL path. Our public_ids don't carry an
//   extension, so the caller must pass `format`. If `format` is
//   missing, getSignedUrl now returns null (fails closed) instead
//   of throwing inside the SDK.
//
// Additive changes preserved from the previous revision:
//   • uploadSupportFile() accepts `private: true`.
//   • deleteMultipleFiles() shape unchanged.
//   • getOptimizedImageUrl / getThumbnailUrl unchanged.
// ─────────────────────────────────────────────────────────────────

const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');
const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const CLOUDINARY_READY = !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

if (CLOUDINARY_READY) {
    console.log('✅ Cloudinary configured');
} else {
    console.warn('⚠️ Cloudinary credentials missing — uploads will fail closed');
}

// ─── UPLOAD FILE ──────────────────────────────────────────────────

async function uploadSupportFile(fileBuffer, options = {}) {
    if (!CLOUDINARY_READY) {
        const e = new Error('Cloudinary is not configured');
        e.code = 'CLOUDINARY_NOT_CONFIGURED';
        throw e;
    }
    if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
        const e = new Error('Empty or invalid file buffer');
        e.code = 'INVALID_FILE';
        throw e;
    }

    return new Promise((resolve, reject) => {
        const {
            ticketId = 'general',
            messageId = null,
            folder = 'milesspace/support',
            resource_type = 'auto',
            use_filename = true,
            unique_filename = true,
            private: isPrivate = false
        } = options;

        const publicId = messageId
            ? `${folder}/tickets/${ticketId}/messages/${messageId}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
            : `${folder}/tickets/${ticketId}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        // For private uploads use Cloudinary's `private` delivery
        // type. The asset still has a public_id but is not
        // retrievable without a signed URL.
        const uploadParams = {
            resource_type,
            public_id: publicId,
            use_filename,
            unique_filename,
            folder,
            timeout: 60000
        };
        if (isPrivate) {
            uploadParams.type = 'private';
            uploadParams.access_mode = 'authenticated';
        }

        const uploadStream = cloudinary.uploader.upload_stream(
            uploadParams,
            (error, result) => {
                if (error) {
                    console.error('❌ Cloudinary upload error:', error.message);
                    return reject(error);
                }
                resolve({
                    public_id: result.public_id,
                    secure_url: result.secure_url || null,
                    format: result.format,
                    bytes: result.bytes,
                    width: result.width || null,
                    height: result.height || null,
                    duration: result.duration || null,
                    resource_type: result.resource_type,
                    type: result.type || (isPrivate ? 'private' : 'upload'),
                    created_at: result.created_at,
                });
            }
        );

        const readableStream = new Readable();
        readableStream.push(fileBuffer);
        readableStream.push(null);
        readableStream.pipe(uploadStream);
    });
}

// ─── DELETE FILE ──────────────────────────────────────────────────

async function deleteSupportFile(publicId, options = {}) {
    try {
        if (!publicId) return { success: true, message: 'No public ID provided' };
        if (!CLOUDINARY_READY) return { success: false, error: 'CLOUDINARY_NOT_CONFIGURED', publicId };

        const result = await cloudinary.uploader.destroy(publicId, {
            invalidate: true,
            type: options.type || 'upload',
            resource_type: options.resource_type || 'image'
        });

        if (result.result === 'ok' || result.result === 'not found') {
            return { success: true, publicId, result: result.result };
        }
        console.warn(`⚠️ Cloudinary delete returned: ${result.result}`);
        return { success: false, publicId, result };
    } catch (error) {
        console.error('❌ Cloudinary delete error:', error.message);
        return { success: false, publicId, error: error.message };
    }
}

// ─── DELETE MULTIPLE FILES ────────────────────────────────────────

async function deleteMultipleFiles(publicIds, options = {}) {
    if (!publicIds || publicIds.length === 0) {
        return { success: true, total: 0, failed: 0, details: [] };
    }

    const results = await Promise.all(
        publicIds.map((pid) => deleteSupportFile(pid, options))
    );

    const failed = results.filter((r) => !r.success);
    return {
        success: failed.length === 0,
        total: results.length,
        failed: failed.length,
        details: results,
    };
}

// ─── GET OPTIMIZED URL ────────────────────────────────────────────

function getOptimizedImageUrl(publicId, options = {}) {
    if (!publicId || !process.env.CLOUDINARY_CLOUD_NAME) return null;
    const {
        width = 800,
        height = null,
        quality = 'auto',
        format = 'auto',
        crop = 'limit',
    } = options;

    let url = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/`;

    const transformations = [];
    if (width) transformations.push(`w_${width}`);
    if (height) transformations.push(`h_${height}`);
    if (crop) transformations.push(`c_${crop}`);
    if (quality) transformations.push(`q_${quality}`);
    if (format) transformations.push(`f_${format}`);

    if (transformations.length > 0) {
        url += transformations.join(',') + '/';
    }

    url += publicId;
    return url;
}

// ─── GET THUMBNAIL URL ────────────────────────────────────────────

function getThumbnailUrl(publicId, size = 150) {
    return getOptimizedImageUrl(publicId, {
        width: size,
        height: size,
        crop: 'thumb',
        quality: 'auto',
        format: 'auto',
    });
}

// ─── SIGNED URL ───────────────────────────────────────────────────
//
// For assets uploaded with type: 'private' + access_mode:
// 'authenticated', the correct signature mechanism is
// `sign_url: true`. This uses cloudinary.config().api_secret
// internally — do NOT also pass `auth_token` (that is a different
// token-gated delivery path for CDN strict transformations and
// requires { key, duration }, not just { duration }).
//
// The URL path for a `type: 'private'` asset must end with the
// file extension. Our public_ids do not carry one, so the caller
// must pass opts.format (derived from mime). If format is missing
// this returns null — never throws inside the SDK.
//
// Time-bounded delivery: Cloudinary's signed URLs for `private`
// assets are valid as long as the signature matches. The
// `expiresInSeconds` parameter controls how long the URL is
// semantically valid on Cloudinary's side (round-tripped as
// `__e=` expiry token). Anything between 30s and 3600s is
// accepted; the default is 300s.
function getSignedUrl(publicId, opts = {}) {
    if (!publicId || typeof publicId !== 'string' || !publicId.trim()) {
        return null;
    }
    if (!CLOUDINARY_READY) {
        return null;
    }

    // Format is required for the URL path. Derive from caller
    // input if not provided.
    const format = (opts.format && String(opts.format).trim()) || null;
    if (!format) {
        console.warn(
            '[CLOUDINARY] getSignedUrl: missing format for',
            publicId,
            '— caller must pass opts.format'
        );
        return null;
    }

    const expiresInSeconds = Number.isFinite(opts.expiresInSeconds)
        ? Math.max(30, Math.min(3600, opts.expiresInSeconds))
        : 300;
    const resourceType = opts.resource_type || opts.resourceType || 'image';
    const deliveryType = opts.deliveryType || 'private';

    try {
        // Two things make `type: 'private'` URLs signable:
        //   1. `sign_url: true`           — sign with api_secret
        //   2. the extension in the path  — tells Cloudinary which
        //                                    transformation to apply
        //
        // Passing `auth_token` in addition causes the SDK to try
        // to mint a JWT, which crashes when the token key is not
        // configured. We deliberately do NOT set auth_token here.
        const url = cloudinary.url(`${publicId}.${format}`, {
            resource_type: resourceType,
            type: deliveryType,
            sign_url: true,
            secure: true,
            // `__e` is Cloudinary's expiry-token suffix. When
            // expiresInSeconds is set, the SDK includes it so the
            // URL fails after that window.
            ...(expiresInSeconds
                ? { expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds }
                : {})
        });

        if (!url) return null;
        return url;
    } catch (e) {
        console.error('[CLOUDINARY] signed URL failed:', e.message);
        return null;
    }
}

// Alias used by supportAttachmentService when getSignedUrl is absent.
// Same behaviour, differently named inputs. Forwards `format`.
function signUrl(publicId, opts = {}) {
    const expiresAt = Number.isFinite(opts.expiresAt) ? opts.expiresAt : null;
    let expiresInSeconds = 300;
    if (expiresAt) {
        expiresInSeconds = Math.max(
            30,
            Math.min(3600, expiresAt - Math.floor(Date.now() / 1000))
        );
    }
    return getSignedUrl(publicId, {
        expiresInSeconds,
        resource_type: opts.resourceType,
        format: opts.format,
        deliveryType: opts.deliveryType
    });
}

// ─── CHECK FILE TYPE ──────────────────────────────────────────────

function isImage(mimeType) {
    return mimeType && mimeType.startsWith('image/');
}
function isPDF(mimeType) {
    return mimeType === 'application/pdf';
}
function isText(mimeType) {
    return mimeType === 'text/plain' || mimeType === 'text/csv';
}
function isVideo(mimeType) {
    return mimeType && mimeType.startsWith('video/');
}
function isAudio(mimeType) {
    return mimeType && mimeType.startsWith('audio/');
}
function getResourceType(mimeType) {
    if (isImage(mimeType)) return 'image';
    if (isVideo(mimeType)) return 'video';
    if (isAudio(mimeType)) return 'raw';
    return 'raw';
}

// ─── EXPORT ──────────────────────────────────────────────────────

module.exports = {
    uploadSupportFile,
    deleteSupportFile,
    deleteMultipleFiles,
    getOptimizedImageUrl,
    getThumbnailUrl,
    getSignedUrl,
    signUrl,
    isImage,
    isPDF,
    isText,
    isVideo,
    isAudio,
    getResourceType,
    CLOUDINARY_READY,
};