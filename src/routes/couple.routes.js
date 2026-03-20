const express = require('express');
const { body } = require('express-validator');
const coupleCtrl = require('../controllers/couple.controller');
const { verifyAuth } = require('../middleware/auth.middleware');
const { requireCouple } = require('../middleware/couple.middleware');
const { validateRequest } = require('../middleware/validate.middleware');
const { codeLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// All couple routes require authentication
router.use(verifyAuth);

// GET  /api/couple/me – get current user's couple room info
router.get('/me', coupleCtrl.getMyRoom);

// POST /api/couple/generate-code – generate 6-digit pairing code
router.post('/generate-code', coupleCtrl.generateCode);

// POST /api/couple/join – join via pairing code (rate-limited to prevent brute-force)
router.post(
    '/join',
    codeLimiter,
    [
        body('code').isLength({ min: 6, max: 6 }).isNumeric(),
        body('start_date').isISO8601(),
    ],
    validateRequest,
    coupleCtrl.joinWithCode
);

// DELETE /api/couple/me – soft-delete (disconnect)
router.delete('/me', requireCouple, coupleCtrl.disconnect);

// POST /api/couple/heartbeat – HTTP fallback when socket ack is delayed
router.post('/heartbeat', requireCouple, coupleCtrl.sendHeartbeat);

// ── Milestones ──────────────────────────────────────────────────
router.get('/milestones', requireCouple, coupleCtrl.getMilestones);
router.post(
    '/milestones',
    requireCouple,
    [
        body('label').notEmpty().isString().trim(),
        body('target_days').isInt({ min: 1 }),
        body('emoji').optional().isString().trim()
    ],
    validateRequest,
    coupleCtrl.createMilestone
);
router.patch(
    '/milestones/:id',
    requireCouple,
    [
        body('label').optional().isString().trim(),
        body('target_days').optional().isInt({ min: 1 }),
        body('emoji').optional().isString().trim()
    ],
    validateRequest,
    coupleCtrl.updateMilestone
);
router.delete('/milestones/:id', requireCouple, coupleCtrl.deleteMilestone);

module.exports = router;
