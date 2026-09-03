const express = require('express');
const router = express.Router();
const { verifyAuth } = require('../middleware/auth.middleware');
const { requireCouple } = require('../middleware/couple.middleware');
const {
    getPeriodData,
    updatePeriodSettings,
    sendPeriodSOS,
    setPeriodRole,
    getDailyLogs,
    upsertDailyLog,
    deleteDailyLog,
    getCycleHistory,
    toggleCycleStart,
    toggleCycleEnd,
    deleteCycle,
} = require('../controllers/period.controller');

// All routes require authentication and active couple room
router.use(verifyAuth, requireCouple);

router.get('/', getPeriodData);
router.put('/', updatePeriodSettings);
router.post('/sos', sendPeriodSOS);
router.post('/role', setPeriodRole);
router.get('/logs', getDailyLogs);
router.post('/log', upsertDailyLog);
router.delete('/log/:date', deleteDailyLog);
router.get('/cycles', getCycleHistory);
router.post('/cycle/start', toggleCycleStart);
router.post('/cycle/end', toggleCycleEnd);
router.delete('/cycle/:id', deleteCycle);

module.exports = router;
