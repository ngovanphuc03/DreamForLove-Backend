const express = require('express');
const router = express.Router();
const { verifyAuth } = require('../middleware/auth.middleware');
const { requireCouple } = require('../middleware/couple.middleware');
const {
    getPeriodData,
    updatePeriodSettings,
    sendPeriodSOS,
    setPeriodRole,
} = require('../controllers/period.controller');

// All routes require authentication and active couple room
router.use(verifyAuth, requireCouple);

router.get('/', getPeriodData);
router.put('/', updatePeriodSettings);
router.post('/sos', sendPeriodSOS);
router.post('/role', setPeriodRole);

module.exports = router;
