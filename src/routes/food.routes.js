const express = require('express');
const { body, param, query } = require('express-validator');
const foodCtrl = require('../controllers/food.controller');
const { verifyAuth } = require('../middleware/auth.middleware');
const { requireCouple } = require('../middleware/couple.middleware');
const { validateRequest } = require('../middleware/validate.middleware');

const router = express.Router();

router.use(verifyAuth, requireCouple);

// GET /api/food – list all food items with optional category & favorite filters
router.get(
    '/',
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 100 }),
        query('category').optional().isString().trim(),
        query('favorite').optional().isBoolean(),
    ],
    validateRequest,
    foodCtrl.list
);

// GET /api/food/history – list meal history
router.get(
    '/history',
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 50 }),
    ],
    validateRequest,
    foodCtrl.getHistory
);

// GET /api/food/spin – random food picker 🎰 with filter modes
router.get(
    '/spin',
    [
        query('mode').optional().isIn(['all', 'uneaten', 'favorite', 'category']),
        query('category').optional().isString().trim(),
    ],
    validateRequest,
    foodCtrl.spin
);

// POST /api/food – add single new food item
router.post(
    '/',
    [
        body('name').notEmpty().isString().trim().isLength({ max: 100 }),
        body('emoji').optional().isString().isLength({ max: 10 }),
        body('location').optional().isString().trim().isLength({ max: 255 }),
        body('category').optional().isString().trim().isLength({ max: 50 }),
        body('notes').optional().isString().trim().isLength({ max: 500 }),
        body('is_favorite').optional().isBoolean(),
    ],
    validateRequest,
    foodCtrl.create
);

// POST /api/food/pack – batch import mood food pack
router.post(
    '/pack',
    [
        body('items').isArray({ min: 1, max: 20 }),
        body('items.*.name').notEmpty().isString().trim().isLength({ max: 100 }),
        body('items.*.emoji').optional().isString().isLength({ max: 10 }),
        body('items.*.category').optional().isString().trim().isLength({ max: 50 }),
        body('items.*.location').optional().isString().trim().isLength({ max: 255 }),
        body('items.*.notes').optional().isString().trim().isLength({ max: 500 }),
        body('items.*.is_favorite').optional().isBoolean(),
    ],
    validateRequest,
    foodCtrl.importPack
);

// DELETE /api/food/:id – remove food item
router.delete('/:id', [param('id').isUUID()], validateRequest, foodCtrl.remove);

// PATCH /api/food/:id - update food item
router.patch(
    '/:id',
    [
        param('id').isUUID(),
        body('name').optional().isString().trim().isLength({ max: 100 }),
        body('emoji').optional().isString().isLength({ max: 10 }),
        body('location').optional().isString().trim().isLength({ max: 255 }),
        body('category').optional().isString().trim().isLength({ max: 50 }),
        body('notes').optional().isString().trim().isLength({ max: 500 }),
        body('is_favorite').optional().isBoolean(),
    ],
    validateRequest,
    foodCtrl.update
);

// PATCH /api/food/:id/toggle-eaten - toggle eaten/crave again
router.patch('/:id/toggle-eaten', [param('id').isUUID()], validateRequest, foodCtrl.toggleEaten);

// PATCH /api/food/:id/toggle-favorite - toggle favorite star
router.patch('/:id/toggle-favorite', [param('id').isUUID()], validateRequest, foodCtrl.toggleFavorite);

// PATCH /api/food/:id/eaten - backward compatible
router.patch('/:id/eaten', [param('id').isUUID()], validateRequest, foodCtrl.markEaten);

module.exports = router;
