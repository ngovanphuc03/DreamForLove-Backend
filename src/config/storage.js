const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

let s3Client = null;
let bucketName = null;
let publicUrl = null;
let devMode = false;

/**
 * Initialize the S3-compatible storage client (Cloudflare R2 / Supabase Storage / MinIO).
 * Falls back to local file storage in dev mode if no credentials are configured.
 */
function initStorage() {
    const accountId = process.env.R2_ACCOUNT_ID || '';
    const accessKeyId = process.env.R2_ACCESS_KEY_ID || '';
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || '';
    bucketName = process.env.R2_BUCKET_NAME || 'dreamforlove';
    publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');

    // If no credentials, use local dev mode
    if (!accessKeyId || !secretAccessKey) {
        devMode = true;
        // Ensure local uploads directory exists
        const uploadsDir = path.join(__dirname, '../../uploads');
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        logger.warn('[Storage] No R2/S3 credentials — using local file storage (dev mode)');
        return;
    }

    const endpoint = process.env.R2_ENDPOINT
        || `https://${accountId}.r2.cloudflarestorage.com`;

    s3Client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: {
            accessKeyId,
            secretAccessKey,
        },
    });

    logger.info(`[Storage] S3 client initialized (bucket: ${bucketName})`);
}

/**
 * Upload an image buffer to object storage.
 *
 * @param {Buffer} buffer      - Image data
 * @param {string} [prefix]    - Key prefix (e.g. 'memory-photos')
 * @param {string} [mimeType]  - MIME type (default: 'image/jpeg')
 * @returns {Promise<{ key: string, url: string }>}
 */
async function uploadImage(buffer, prefix = 'memory-photos', mimeType = 'image/jpeg') {
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
    const key = `${prefix}/${uuidv4()}.${ext}`;

    if (devMode) {
        // Local file storage fallback
        const uploadsDir = path.join(__dirname, '../../uploads');
        const filePath = path.join(uploadsDir, `${uuidv4()}.${ext}`);
        fs.writeFileSync(filePath, buffer);
        const localUrl = `/uploads/${path.basename(filePath)}`;
        logger.debug(`[Storage] Local upload: ${localUrl}`);
        return { key: path.basename(filePath), url: localUrl };
    }

    await s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
    }));

    const url = publicUrl ? `${publicUrl}/${key}` : key;
    logger.debug(`[Storage] Uploaded: ${key}`);
    return { key, url };
}

/**
 * Delete an image from object storage.
 *
 * @param {string} key - The object key to delete
 */
async function deleteImage(key) {
    if (!key) return;

    if (devMode) {
        const filePath = path.join(__dirname, '../../uploads', path.basename(key));
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (err) {
            logger.warn(`[Storage] Local delete failed: ${err.message}`);
        }
        return;
    }

    try {
        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key,
        }));
        logger.debug(`[Storage] Deleted: ${key}`);
    } catch (err) {
        logger.error(`[Storage] Delete failed for key=${key}: ${err.message}`);
    }
}

/**
 * Parse a base64 data URI or raw base64 string into a Buffer + mimeType.
 *
 * @param {string} base64String - "data:image/png;base64,..." or raw base64
 * @returns {{ buffer: Buffer, mimeType: string }}
 */
function parseBase64Image(base64String) {
    const dataUriMatch = base64String.match(/^data:(image\/\w+);base64,(.+)$/);
    if (dataUriMatch) {
        return {
            mimeType: dataUriMatch[1],
            buffer: Buffer.from(dataUriMatch[2], 'base64'),
        };
    }
    // Raw base64 — assume JPEG
    return {
        mimeType: 'image/jpeg',
        buffer: Buffer.from(base64String, 'base64'),
    };
}

module.exports = { initStorage, uploadImage, deleteImage, parseBase64Image };
