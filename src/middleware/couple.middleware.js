const { query } = require('../config/database');

/**
 * Middleware: xác minh user đang ở trong một couple room đang hoạt động.
 * Gắn req.coupleRoom với dữ liệu phòng (id, is_premium, user_a_id, user_b_id, ...).
 * Phải dùng SAU verifyAuth.
 */
async function requireCouple(req, res, next) {
    try {
        if (!req.dbUser) {
            return res.status(401).json({ error: 'Chưa xác thực' });
        }

        const userId = req.dbUser.id;

        const result = await query(
            `SELECT cr.*
             FROM couple_rooms cr
             WHERE (cr.user_a_id = $1 OR cr.user_b_id = $1)
               AND cr.status = 'active'
             LIMIT 1`,
            [userId]
        );

        if (!result.rows.length) {
            return res.status(403).json({
                error: 'Bạn chưa ghép đôi. Vui lòng tạo hoặc tham gia phòng đôi trước.',
                code: 'NOT_IN_COUPLE_ROOM',
            });
        }

        req.coupleRoom = result.rows[0];
        next();
    } catch (err) {
        next(err);
    }
}

module.exports = { requireCouple };
