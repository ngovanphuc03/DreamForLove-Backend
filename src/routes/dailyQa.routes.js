const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { requireCouple } = require('../middleware/couple.middleware');
const validateRequest = require('../middleware/validateRequest');
const dailyQaCtrl = require('../controllers/dailyQa.controller');

// GET /api/couple/daily-qa – get today's question & dual unlock status
router.get('/', requireCouple, dailyQaCtrl.getTodayQa);

// POST /api/couple/daily-qa/answer – submit current user's answer
router.post(
    '/answer',
    requireCouple,
    [
        body('answer').isString().trim().notEmpty().withMessage('Câu trả lời không được để trống'),
    ],
    validateRequest,
    dailyQaCtrl.submitAnswer
);

module.exports = router;
