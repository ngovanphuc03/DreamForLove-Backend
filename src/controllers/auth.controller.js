const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

// POST /api/auth/login
// ⚠️ verifyAuth runs BEFORE this → req.user is guaranteed to have uid/email
async function login(req, res, next) {
    try {
        // Extract trusted identity from the verified Firebase token
        const firebase_uid = req.user.uid;
        const email = req.user.email || null;
        const provider = req.user.firebase?.sign_in_provider || 'google';

        // Allow client to supply display name and photo (non-sensitive)
        const { display_name, photo_url } = req.body;

        // Upsert user (create or update)
        const result = await query(
            `INSERT INTO users (id, firebase_uid, email, display_name, photo_url, provider)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (firebase_uid) DO UPDATE SET
         email        = COALESCE(EXCLUDED.email, users.email),
         display_name = COALESCE(EXCLUDED.display_name, users.display_name),
         photo_url    = COALESCE(EXCLUDED.photo_url, users.photo_url),
         updated_at   = NOW()
       RETURNING *`,
            [uuidv4(), firebase_uid, email, display_name || null, photo_url || null, provider]
        );

        res.json({ user: result.rows[0] });
    } catch (err) {
        next(err);
    }
}

// GET /api/auth/me
async function getMe(req, res, next) {
    try {
        const result = await query(
            'SELECT * FROM users WHERE firebase_uid = $1',
            [req.user.uid]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ user: result.rows[0] });
    } catch (err) {
        next(err);
    }
}

// PATCH /api/auth/fcm-token
async function updateFcmToken(req, res, next) {
    try {
        const { token } = req.body;

        await query(
            'UPDATE users SET fcm_token = $1, updated_at = NOW() WHERE firebase_uid = $2',
            [token, req.user.uid]
        );

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}

module.exports = { login, getMe, updateFcmToken };
