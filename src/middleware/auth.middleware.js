const { verifyIdToken } = require('../config/firebase');
const { query } = require('../config/database');

/// Verify Firebase ID Token and attach req.user + req.dbUser
async function verifyAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing authentication token' });
    }

    const token = authHeader.substring(7);

    // ── Dev-mode bypass (non-production only) ──────────────────────────────
    if (process.env.NODE_ENV !== 'production' && token === 'dev_user123') {
        req.user = { uid: 'dev_user_001', email: 'dev@dreamforlove.app' };
        try {
            const result = await query(
                'SELECT * FROM users WHERE firebase_uid = $1',
                ['dev_user_001']
            );
            if (result.rows.length) req.dbUser = result.rows[0];
        } catch (err) {
            return next(err);
        }
        return next();
    }

    // ── Step 1: Verify Firebase token (auth errors → 401) ──────────────────
    let decoded;
    try {
        decoded = await verifyIdToken(token);
    } catch (err) {
        if (err.code === 'auth/id-token-expired') {
            return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
        }
        return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = decoded;

    // ── Step 2: Fetch DB user (DB errors → 500 via next(err)) ──────────────
    try {
        const result = await query(
            'SELECT * FROM users WHERE firebase_uid = $1',
            [decoded.uid]
        );
        if (result.rows.length) req.dbUser = result.rows[0];
    } catch (err) {
        return next(err); // DB unavailable → errorHandler returns 500
    }

    next();
}

module.exports = { verifyAuth };
