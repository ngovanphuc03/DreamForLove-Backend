const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { deleteFirebaseUser } = require('../config/firebase');
const logger = require('../config/logger');

// POST /api/auth/login
// ⚠️ verifyAuth runs BEFORE this → req.user is guaranteed to have uid/email
async function login(req, res, next) {
    try {
        // Extract trusted identity from the verified Firebase token
        const firebase_uid = req.user.uid;
        const email = req.user.email || null;
        const provider = req.user.firebase?.sign_in_provider || 'google';

        // Allow client to supply display name, photo, gender, birth_date (non-sensitive)
        const body = req.body || {};
        const hasDisplayName = Object.prototype.hasOwnProperty.call(body, 'display_name');
        const hasPhotoUrl = Object.prototype.hasOwnProperty.call(body, 'photo_url');
        const hasGender = Object.prototype.hasOwnProperty.call(body, 'gender');
        const hasBirthDate = Object.prototype.hasOwnProperty.call(body, 'birth_date');

        const display_name = hasDisplayName ? body.display_name : null;
        const photo_url = hasPhotoUrl ? body.photo_url : null;
        const gender = hasGender ? (body.gender || null) : null;
        const birth_date = hasBirthDate && body.birth_date ? body.birth_date : null;

        // Upsert user (create or update)
        const result = await query(
            `INSERT INTO users (id, firebase_uid, email, display_name, photo_url, provider, gender, birth_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (firebase_uid) DO UPDATE SET
               email        = COALESCE(EXCLUDED.email, users.email),
               display_name = CASE WHEN $9 THEN EXCLUDED.display_name ELSE users.display_name END,
               photo_url    = CASE WHEN $10 THEN EXCLUDED.photo_url ELSE users.photo_url END,
               gender       = CASE WHEN $11 THEN EXCLUDED.gender ELSE users.gender END,
               birth_date   = CASE WHEN $12 THEN EXCLUDED.birth_date ELSE users.birth_date END,
               updated_at   = NOW()
             RETURNING *,
               CASE 
                 WHEN birth_date IS NOT NULL 
                 THEN DATE_PART('year', AGE((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, birth_date))::int 
                 ELSE NULL 
               END AS age`,
            [
                uuidv4(),
                firebase_uid,
                email,
                display_name,
                photo_url,
                provider,
                gender,
                birth_date,
                hasDisplayName,
                hasPhotoUrl,
                hasGender,
                hasBirthDate,
            ]
        );

        const user = result.rows[0];

        // Auto-assign female_user_id in couple_period_settings if user marks gender as female
        if (gender === 'female' && user?.id) {
            try {
                const roomRes = await query(
                    `SELECT id FROM couple_rooms 
                     WHERE (user_a_id = $1 OR user_b_id = $1) AND status = 'active' LIMIT 1`,
                    [user.id]
                );
                if (roomRes.rows.length) {
                    await query(
                        `INSERT INTO couple_period_settings (couple_room_id, female_user_id, updated_at)
                         VALUES ($1, $2, NOW())
                         ON CONFLICT (couple_room_id)
                         DO UPDATE SET female_user_id = $2, updated_at = NOW()`,
                        [roomRes.rows[0].id, user.id]
                    );
                }
            } catch (assignErr) {
                logger.warn(`[Auth] Auto-assign female_user_id warning: ${assignErr.message}`);
            }
        }

        res.json({ user });
    } catch (err) {
        next(err);
    }
}

// GET /api/auth/me
async function getMe(req, res, next) {
    try {
        const result = await query(
            `SELECT *,
               CASE 
                 WHEN birth_date IS NOT NULL 
                 THEN DATE_PART('year', AGE((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, birth_date))::int 
                 ELSE NULL 
               END AS age
             FROM users WHERE firebase_uid = $1`,
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
        const rawToken = req.body.token ?? req.body.fcm_token;
        const token = typeof rawToken === 'string' ? rawToken.trim() : null;

        await query(
            'UPDATE users SET fcm_token = $1, updated_at = NOW() WHERE firebase_uid = $2',
            [token, req.user.uid]
        );

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}

// DELETE /api/auth/account
async function deleteAccount(req, res, next) {
    try {
        const userId = req.dbUser.id;
        const firebaseUid = req.user.uid;

        // Step 1: Delete Firebase user (prevents re-login with same Google account)
        try {
            await deleteFirebaseUser(firebaseUid);
        } catch (fbErr) {
            // In dev mode or if Firebase is unavailable, log warn but continue
            logger.warn(`[deleteAccount] Firebase user delete skipped for uid=${firebaseUid}: ${fbErr.message}`);
        }

        // Step 2: Delete DB record (CASCADE removes couple room, wishlist, etc.)
        await query('DELETE FROM users WHERE id = $1', [userId]);
        res.json({ success: true, message: 'Account deleted successfully' });
    } catch (err) {
        next(err);
    }
}


module.exports = { login, getMe, updateFcmToken, deleteAccount };
