const express = require('express');
const { body, param } = require('express-validator');
const coupleCtrl = require('../controllers/couple.controller');
const { verifyAuth } = require('../middleware/auth.middleware');
const { requireCouple } = require('../middleware/couple.middleware');
const { validateRequest } = require('../middleware/validate.middleware');
const {
    codeLimiter,
    generateCodeLimiter,
    heartbeatLimiter,
} = require('../middleware/rateLimiter');

const router = express.Router();

// All couple routes require authentication
router.use(verifyAuth);

// GET  /api/couple/me – get current user's couple room info
router.get('/me', coupleCtrl.getMyRoom);

// GET /api/couple/progress – streak/level progress for current couple room
router.get('/progress', requireCouple, coupleCtrl.getProgress);

// POST /api/couple/generate-code – generate 6-digit pairing code
router.post('/generate-code', generateCodeLimiter, coupleCtrl.generateCode);

// POST /api/couple/join – join via pairing code (rate-limited to prevent brute-force)
router.post(
    '/join',
    codeLimiter,
    [
        body('code').isLength({ min: 6, max: 6 }).isNumeric(),
        body('start_date')
            .isISO8601()
            .custom((value) => {
                const input = new Date(value);
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                if (Number.isNaN(input.getTime())) {
                    throw new Error('start_date is invalid');
                }
                if (input > today) {
                    throw new Error('start_date cannot be in the future');
                }
                return true;
            }),
    ],
    validateRequest,
    coupleCtrl.joinWithCode
);

// DELETE /api/couple/me – soft-delete (disconnect)
router.delete('/me', requireCouple, coupleCtrl.disconnect);

// POST /api/couple/heartbeat – HTTP fallback when socket ack is delayed
router.post('/heartbeat', requireCouple, heartbeatLimiter, coupleCtrl.sendHeartbeat);

// PATCH /api/couple/memory-photo – shared memory photo (base64) for both partners
router.patch(
    '/memory-photo',
    requireCouple,
    [
        body('image_base64')
            .optional({ nullable: true })
            .isString()
            .isLength({ max: 9000000 })
            .custom((value) => {
                if (!value || !value.trim()) return true;
                const trimmed = value.trim();
                const isDataImageUri = trimmed.startsWith('data:image/');
                const isRawBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed);
                if (!isDataImageUri && !isRawBase64) {
                    throw new Error('image_base64 must be base64 or data:image URI');
                }
                return true;
            }),
    ],
    validateRequest,
    coupleCtrl.updateMemoryPhoto
);

// PATCH /api/couple/start-date – update anniversary start date
router.patch(
    '/start-date',
    requireCouple,
    [
        body('start_date')
            .notEmpty()
            .isISO8601()
            .custom((value) => {
                const input = new Date(value);
                const today = new Date();
                today.setHours(23, 59, 59, 999);
                if (Number.isNaN(input.getTime())) {
                    throw new Error('start_date is invalid');
                }
                if (input > today) {
                    throw new Error('start_date cannot be in the future');
                }
                return true;
            }),
    ],
    validateRequest,
    coupleCtrl.updateStartDate
);

// ── Milestones ──────────────────────────────────────────────────
router.get('/milestones', requireCouple, coupleCtrl.getMilestones);
router.post(
    '/milestones',
    requireCouple,
    [
        body('label').notEmpty().isString().trim(),
        body('target_days').isInt({ min: 1 }),
        body('emoji').optional().isString().trim().isLength({ max: 10 })
    ],
    validateRequest,
    coupleCtrl.createMilestone
);
router.patch(
    '/milestones/:id',
    requireCouple,
    [
        param('id').isUUID(),
        body('label').optional().isString().trim(),
        body('target_days').optional().isInt({ min: 1 }),
        body('emoji').optional().isString().trim().isLength({ max: 10 })
    ],
    validateRequest,
    coupleCtrl.updateMilestone
);
router.delete('/milestones/:id', requireCouple, [param('id').isUUID()], validateRequest, coupleCtrl.deleteMilestone);

module.exports = router;
