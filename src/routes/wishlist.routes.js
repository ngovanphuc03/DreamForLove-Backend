const express = require('express');
const { body, param, query } = require('express-validator');
const wishCtrl = require('../controllers/wishlist.controller');
const { verifyAuth } = require('../middleware/auth.middleware');
const { requireCouple } = require('../middleware/couple.middleware');
const { validateRequest } = require('../middleware/validate.middleware');

const router = express.Router();

router.use(verifyAuth, requireCouple);

// GET  /api/wishlist – list all wish items
router.get(
    '/',
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 50 }),
    ],
    validateRequest,
    wishCtrl.list
);

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
        param('id').isUUID(),
        body('is_bought').optional().isBoolean(),
    ],
    validateRequest,
    wishCtrl.markBought
);

// DELETE /api/wishlist/:id – soft delete
router.delete('/:id', [param('id').isUUID()], validateRequest, wishCtrl.remove);

// PATCH /api/wishlist/:id - update wish item
router.patch(
    '/:id',
    [
        param('id').isUUID(),
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
