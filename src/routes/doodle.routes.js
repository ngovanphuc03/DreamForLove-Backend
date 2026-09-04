const express = require('express');
const { body, param, query: queryValidator } = require('express-validator');
const doodleCtrl = require('../controllers/doodle.controller');
const { verifyAuth } = require('../middleware/auth.middleware');
const { requireCouple } = require('../middleware/couple.middleware');
const { validateRequest } = require('../middleware/validate.middleware');

const router = express.Router();

router.use(verifyAuth);
router.use(requireCouple);

// GET /api/doodles/latest – Get the most recent doodle
router.get('/latest', doodleCtrl.getLatestDoodle);

// GET /api/doodles/history – Get paginated doodle history
router.get(
    '/history',
    [
        queryValidator('page').optional().isInt({ min: 1 }),
        queryValidator('limit').optional().isInt({ min: 1, max: 50 }),
    ],
    validateRequest,
    doodleCtrl.getDoodleHistory
);

// GET /api/doodles/:id – Get single doodle with complete stroke points
router.get(
    '/:id',
    [param('id').isUUID()],
    validateRequest,
    doodleCtrl.getDoodleById
);

// POST /api/doodles – Create a new doodle or chain doodle
router.post(
    '/',
    [
        body('strokes_data').optional(),
        body('image_base64').optional().isString(),
        body('is_chain').optional().isBoolean(),
        body('parent_doodle_id').optional({ nullable: true }).isUUID(),
    ],
    validateRequest,
    doodleCtrl.createDoodle
);

module.exports = router;
