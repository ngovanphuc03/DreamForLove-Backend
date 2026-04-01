const { query } = require('../config/database');
const logger = require('../config/logger');

/**
 * Persist an audit log entry to the database.
 * Non-blocking: errors are caught and logged, never crash the request.
 *
 * @param {Object} entry
 * @param {string} entry.event          - Event name (e.g. 'api_mutation', 'account_deleted')
 * @param {string} [entry.method]       - HTTP method
 * @param {string} [entry.path]         - Request path
 * @param {number} [entry.statusCode]   - HTTP status code
 * @param {number} [entry.durationMs]   - Request duration in ms
 * @param {string} [entry.firebaseUid]  - Firebase UID
 * @param {string} [entry.userId]       - DB user UUID
 * @param {string} [entry.coupleRoomId] - Couple room UUID
 * @param {string} [entry.ip]           - Client IP
 * @param {string} [entry.requestId]    - X-Request-ID
 * @param {Object} [entry.metadata]     - Extra JSONB context
 */
async function logAudit(entry) {
    try {
        await query(
            `INSERT INTO audit_logs
                (event, method, path, status_code, duration_ms,
                 firebase_uid, user_id, couple_room_id, ip, request_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
                entry.event,
                entry.method || null,
                entry.path || null,
                entry.statusCode || null,
                entry.durationMs || null,
                entry.firebaseUid || null,
                entry.userId || null,
                entry.coupleRoomId || null,
                entry.ip || null,
                entry.requestId || null,
                JSON.stringify(entry.metadata || {}),
            ]
        );
    } catch (err) {
        // Never crash the request — just log the failure
        logger.error(`[Audit] Failed to persist audit log: ${err.message}`);
    }
}

/**
 * Log a critical user action with structured metadata.
 * Use this for important actions like account deletion, couple disconnect, pairing.
 *
 * @param {string} event      - Event name (e.g. 'account_deleted')
 * @param {Object} context    - { userId, firebaseUid, coupleRoomId, ip, requestId }
 * @param {Object} [metadata] - Extra context to store in JSONB
 */
async function logCriticalAction(event, context = {}, metadata = {}) {
    await logAudit({
        event,
        method: context.method || null,
        path: context.path || null,
        firebaseUid: context.firebaseUid || null,
        userId: context.userId || null,
        coupleRoomId: context.coupleRoomId || null,
        ip: context.ip || null,
        requestId: context.requestId || null,
        metadata,
    });
}

module.exports = { logAudit, logCriticalAction };
