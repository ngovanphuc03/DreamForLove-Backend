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
            const token = value?.token ?? value?.fcm_token;

            // allow clearing token on logout/device revoke
            if (token === null) {
                return true;
            }

            if (typeof token !== 'string') {
                throw new Error('token must be a string or null');
            }

            const trimmed = token.trim();
            if (!trimmed.length) {
                throw new Error('token must not be empty');
            }

            // FCM registration token is typically URL-safe base64-ish + punctuation.
            // Keep format strict enough to block obvious invalid payloads.
            if (trimmed.length < 100 || trimmed.length > 4096) {
                throw new Error('FCM token length is invalid');
            }

            if (!/^[A-Za-z0-9:_.-]+$/.test(trimmed)) {
                throw new Error('FCM token format is invalid');
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
