const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth.middleware');
const {
    getCheatsheets,
    updateMyCheatsheet,
} = require('../controllers/cheatsheet.controller');

// All routes require authentication
router.use(authenticate);

router.get('/', getCheatsheets);
router.put('/', updateMyCheatsheet);

module.exports = router;
