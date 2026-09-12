const express = require('express');
const { body, param, query } = require('express-validator');
const tripCtrl = require('../controllers/trip.controller');
const { verifyAuth } = require('../middleware/auth.middleware');
const { requireCouple } = require('../middleware/couple.middleware');
const { validateRequest } = require('../middleware/validate.middleware');

const router = express.Router();

router.use(verifyAuth, requireCouple);

router.get(
    '/',
    [
        query('page').optional().isInt({ min: 1 }),
        query('limit').optional().isInt({ min: 1, max: 50 }),
    ],
    validateRequest,
    tripCtrl.list
);

router.post(
    '/',
    [
        body('title').notEmpty().isString().trim().isLength({ max: 120 }),
        body('location').notEmpty().isString().trim().isLength({ max: 255 }),
        body('note').optional().isString().trim().isLength({ max: 1500 }),
        body('planned_date').optional({ nullable: true }).isISO8601(),
    ],
    validateRequest,
    tripCtrl.create
);

router.patch(
    '/:id',
    [
        param('id').isUUID(),
        body('title').optional().isString().trim().isLength({ max: 120 }),
        body('location').optional().isString().trim().isLength({ max: 255 }),
        body('note').optional({ nullable: true }).isString().trim().isLength({ max: 1500 }),
        body('planned_date').optional({ nullable: true }).isISO8601(),
        body('is_done').optional().isBoolean(),
    ],
    validateRequest,
    tripCtrl.update
);

router.patch(
    '/:id/done',
    [
        param('id').isUUID(),
        body('is_done').optional().isBoolean(),
    ],
    validateRequest,
    tripCtrl.markDone
router.patch(
    '/:id/packing',
    [
        param('id').isUUID(),
        body('packing_list').isArray(),
    ],
    validateRequest,
    tripCtrl.updatePackingList
);

router.delete('/:id', [param('id').isUUID()], validateRequest, tripCtrl.remove);

module.exports = router;

