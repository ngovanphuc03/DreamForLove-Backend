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

// POST /api/couple/pet/:action — Perform a care action (feed, pet, bathe, play)
router.post(
    '/:action',
    [
        param('action')
            .isIn(['feed', 'pet', 'bathe', 'play'])
            .withMessage('Hành động phải là: feed, pet, bathe, hoặc play'),
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

module.exports = router;
