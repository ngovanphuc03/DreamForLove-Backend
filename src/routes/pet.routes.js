const express = require('express');
const { param, body, query: checkQuery } = require('express-validator');
const petCtrl = require('../controllers/pet.controller');
const { verifyAuth } = require('../middleware/auth.middleware');
const { requireCouple } = require('../middleware/couple.middleware');
const { validateRequest } = require('../middleware/validate.middleware');

const router = express.Router();

// All pet routes require authentication + active couple room
router.use(verifyAuth, requireCouple);

// GET /api/couple/pet — Get full pet state (auto-creates if missing)
router.get('/', petCtrl.getPetState);

// POST /api/couple/pet/evolve — Consume evolution stone and level up once
router.post('/evolve', petCtrl.evolvePet);

// POST /api/couple/pet/:action — Perform a care action (feed, pet, bathe, play)
router.post(
    '/:action',
    [
        param('action')
            .isIn(['feed', 'pet', 'bathe', 'play'])
            .withMessage('Hành động phải là: feed, pet, bathe, hoặc play'),
        body('itemId')
            .optional()
            .isString().withMessage('itemId phải là chuỗi')
            .isIn(['basic_food', 'premium_food'])
            .withMessage('itemId chỉ hỗ trợ basic_food hoặc premium_food'),
    ],
    validateRequest,
    petCtrl.performAction
);

// PATCH /api/couple/pet/name — Rename the pet
router.patch(
    '/name',
    [
        body('name')
            .notEmpty().withMessage('Tên không được trống')
            .isString()
            .trim()
            .isLength({ max: 64 }).withMessage('Tên tối đa 64 ký tự'),
    ],
    validateRequest,
    petCtrl.renamePet
);

// POST /api/couple/pet/shop/buy — Buy item from shop
router.post(
    '/shop/buy',
    [
        body('itemId').isString().withMessage('Mã vật phẩm không hợp lệ'),
        body('quantity').isInt({ min: 1 }).withMessage('Số lượng phải >= 1'),
    ],
    validateRequest,
    petCtrl.buyShopItem
);

// GET /api/couple/pet/history — Recent action timeline
router.get(
    '/history',
    [
        checkQuery('limit')
            .optional()
            .isInt({ min: 1, max: 100 })
            .withMessage('Limit phải từ 1-100'),
    ],
    validateRequest,
    petCtrl.getActionHistory
);

// ── Expedition Routes ───────────────────────────────────────
router.post('/expedition/start', [
    body('type').isString().withMessage('Loại viễn chinh không hợp lệ'),
    body('duration').isInt({ min: 4, max: 8 }).withMessage('Thời lượng phải từ 4-8 giờ'),
], validateRequest, petCtrl.startExpedition);

router.get('/expedition/status', petCtrl.getExpeditionStatus);
router.post('/expedition/collect', petCtrl.collectExpeditionLoot);

// ── Achievements Routes ─────────────────────────────────────
router.get('/achievements', petCtrl.getAchievements);

module.exports = router;
