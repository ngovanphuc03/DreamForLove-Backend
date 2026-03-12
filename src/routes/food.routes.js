const express = require('express');
const { body } = require('express-validator');
const foodCtrl = require('../controllers/food.controller');
const { verifyAuth } = require('../middleware/auth.middleware');
const { requireCouple } = require('../middleware/couple.middleware');
const { validateRequest } = require('../middleware/validate.middleware');

const router = express.Router();

router.use(verifyAuth, requireCouple);

// GET  /api/food – list all food items
router.get('/', foodCtrl.list);

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
router.delete('/:id', foodCtrl.remove);

module.exports = router;
