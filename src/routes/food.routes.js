const express = require('express');
const { body, param, query } = require('express-validator');
const foodCtrl = require('../controllers/food.controller');
const { verifyAuth } = require('../middleware/auth.middleware');
const { requireCouple } = require('../middleware/couple.middleware');
const { validateRequest } = require('../middleware/validate.middleware');

const router = express.Router();

router.use(verifyAuth, requireCouple);

// GET  /api/food – list all food items
router.get(
    '/',
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 50 }),
    ],
    validateRequest,
    foodCtrl.list
);

// POST /api/food – add new food item
router.post(
    '/',
    [
        body('name').notEmpty().isString().trim().isLength({ max: 100 }),
        body('emoji').optional().isString().isLength({ max: 10 }),
        body('location').optional().isString().trim().isLength({ max: 255 }),
    ],
    validateRequest,
    foodCtrl.create
);

// GET  /api/food/spin – random food picker 🎰
router.get('/spin', foodCtrl.spin);

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
    ],
    validateRequest,
    foodCtrl.update
);

// PATCH /api/food/:id/eaten - mark food as eaten
router.patch('/:id/eaten', [param('id').isUUID()], validateRequest, foodCtrl.markEaten);

module.exports = router;
