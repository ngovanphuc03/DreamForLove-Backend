const logger = require('../config/logger');

/**
 * Lightweight audit middleware for mutating API requests.
 * Logs actor + route + status without sensitive payloads.
 */
function auditRequest(req, res, next) {
    // Only track state-changing operations
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        return next();
    }

    const startedAt = Date.now();

    res.on('finish', () => {
        // req.user / req.dbUser may be attached later by auth middleware.
        const firebaseUid = req.user?.uid || null;
        const dbUserId = req.dbUser?.id || null;
        const coupleRoomId = req.coupleRoom?.id || null;

        logger.info({
            event: 'audit.api',
            requestId: req.requestId || null,
            method: req.method,
            path: req.originalUrl,
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
            firebaseUid,
            dbUserId,
            coupleRoomId,
            ip: req.ip,
        });
    });

    return next();
}

module.exports = { auditRequest };
