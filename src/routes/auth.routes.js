const express = require('express');
const { body } = require('express-validator');
const authCtrl = require('../controllers/auth.controller');
const { verifyAuth } = require('../middleware/auth.middleware');
const { validateRequest } = require('../middleware/validate.middleware');
const { authLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// POST /api/auth/login – sync Firebase user with DB
// ⚠️ Now requires a valid Firebase token → firebase_uid is extracted server-side
router.post(
    '/login',
    authLimiter,
    verifyAuth,
    [
        body('display_name').optional().isString().trim(),
        body('photo_url').optional().isString(),
    ],
    validateRequest,
    authCtrl.login
);

// GET /api/auth/me – get current user profile
router.get('/me', verifyAuth, authCtrl.getMe);

// PATCH /api/auth/fcm-token – update FCM push token
router.patch(
    '/fcm-token',
    verifyAuth,
    [
        body().custom((value) => {
            const token = value?.token || value?.fcm_token;
            if (typeof token !== 'string' || token.trim().length === 0) {
                throw new Error('token is required');
            }
            return true;
        }),
    ],
    validateRequest,
    authCtrl.updateFcmToken
);

// DELETE /api/auth/account - permanently delete account
router.delete('/account', verifyAuth, authCtrl.deleteAccount);

module.exports = router;
