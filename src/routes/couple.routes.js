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
