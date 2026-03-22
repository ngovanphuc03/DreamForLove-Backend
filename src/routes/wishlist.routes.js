const express = require('express');
const { body } = require('express-validator');
const wishCtrl = require('../controllers/wishlist.controller');
const { verifyAuth } = require('../middleware/auth.middleware');
const { requireCouple } = require('../middleware/couple.middleware');
const { validateRequest } = require('../middleware/validate.middleware');

const router = express.Router();

router.use(verifyAuth, requireCouple);

// GET  /api/wishlist – list all wish items
router.get('/', wishCtrl.list);

// POST /api/wishlist – create new wish item
router.post(
    '/',
    [
        body('name').notEmpty().isString().trim().isLength({ max: 255 }),
        body('category').optional().isString().trim().isLength({ max: 100 }),
        body('price').optional().isFloat({ min: 0 }),
        body('priority').optional().isIn(['low', 'mid', 'high']),
        body('image_url').optional().isURL(),
        body('product_url').optional().isURL(),
    ],
    validateRequest,
    wishCtrl.create
);

// PATCH /api/wishlist/:id/bought – mark as bought
router.patch(
    '/:id/bought',
    [
        body('is_bought').optional().isBoolean(),
    ],
    validateRequest,
    wishCtrl.markBought
);

// DELETE /api/wishlist/:id – soft delete
router.delete('/:id', wishCtrl.remove);

// PATCH /api/wishlist/:id - update wish item
router.patch(
    '/:id',
    [
        body('name').optional().isString().trim().isLength({ max: 255 }),
        body('category').optional().isString().trim().isLength({ max: 100 }),
        body('price').optional().isFloat({ min: 0 }),
        body('priority').optional().isIn(['low', 'mid', 'high']),
        body('image_url').optional().isURL(),
        body('product_url').optional().isURL(),
    ],
    validateRequest,
    wishCtrl.update
);

module.exports = router;
