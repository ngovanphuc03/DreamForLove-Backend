const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth.middleware');
const {
    getPeriodData,
    updatePeriodSettings,
    sendPeriodSOS,
} = require('../controllers/period.controller');

// All routes require authentication
router.use(authenticate);

router.get('/', getPeriodData);
router.put('/', updatePeriodSettings);
router.post('/sos', sendPeriodSOS);

module.exports = router;
