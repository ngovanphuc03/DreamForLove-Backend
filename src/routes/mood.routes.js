const express = require('express');
const { body } = require('express-validator');
const moodCtrl = require('../controllers/mood.controller');
const { verifyAuth } = require('../middleware/auth.middleware');
const { requireCouple } = require('../middleware/couple.middleware');
const { validateRequest } = require('../middleware/validate.middleware');

const router = express.Router();

router.use(verifyAuth, requireCouple);

// GET /api/mood/current – get my & partner's current mood
router.get('/current', moodCtrl.getCurrent);

// GET /api/mood/history – get mood history (last 30 entries per person)
router.get('/history', moodCtrl.getHistory);

// POST /api/mood – log a new mood
router.post(
    '/',
    [
        body('type').isIn(['happy', 'sad', 'miss', 'angry', 'love']),
        body('note').optional().isString().trim().isLength({ max: 500 }),
    ],
    validateRequest,
    moodCtrl.create
);

module.exports = router;
