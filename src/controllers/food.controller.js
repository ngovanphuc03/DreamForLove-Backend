const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const FREE_LIMIT = Number(process.env.FREE_FOOD_LIMIT) || 5;

// GET /api/food?page=1&limit=20
async function list(req, res, next) {
    try {
        const { id: roomId, is_premium } = req.coupleRoom;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        const countResult = await query(
            'SELECT COUNT(*)::int AS total FROM food_items WHERE couple_room_id = $1 AND is_deleted = FALSE',
            [roomId]
        );
        const total = countResult.rows[0].total;

        const result = await query(
            `SELECT fi.*, u.display_name AS added_by_name
       FROM food_items fi
       JOIN users u ON fi.added_by = u.id
       WHERE fi.couple_room_id = $1 AND fi.is_deleted = FALSE
       ORDER BY fi.created_at DESC
       LIMIT $2 OFFSET $3`,
            [roomId, limit, offset]
        );

        res.json({
            items: result.rows,
            is_premium: is_premium,
            count: result.rows.length,
            total,
            page,
            limit,
            total_pages: Math.ceil(total / limit),
            free_limit: is_premium ? null : FREE_LIMIT,
        });
    } catch (err) {
        next(err);
    }
}

// POST /api/food
async function create(req, res, next) {
    try {
        const { id: roomId, is_premium } = req.coupleRoom;
        const { name, emoji, location } = req.body;

        if (!is_premium) {
            const countResult = await query(
                'SELECT COUNT(*) FROM food_items WHERE couple_room_id = $1 AND is_deleted = FALSE',
                [roomId]
            );
            if (Number(countResult.rows[0].count) >= FREE_LIMIT) {
                return res.status(403).json({
                    error: `Free plan giới hạn ${FREE_LIMIT} món. Nâng cấp Premium!`,
                    code: 'UPGRADE_REQUIRED',
                });
            }
        }

        const result = await query(
            `INSERT INTO food_items (id, couple_room_id, added_by, name, emoji, location)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
            [uuidv4(), roomId, req.dbUser.id, name, emoji || '🍜', location || null]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        next(err);
    }
}

// DELETE /api/food/:id
async function remove(req, res, next) {
    try {
        const { id } = req.params;
        const { id: roomId } = req.coupleRoom;

        await query(
            'UPDATE food_items SET is_deleted = TRUE WHERE id = $1 AND couple_room_id = $2',
            [id, roomId]
        );

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}

// GET /api/food/spin – random food picker
async function spin(req, res, next) {
    try {
        const { id: roomId } = req.coupleRoom;

        const result = await query(
            `SELECT fi.*, u.display_name AS added_by_name
       FROM food_items fi
       JOIN users u ON fi.added_by = u.id
       WHERE fi.couple_room_id = $1 
         AND fi.is_deleted = FALSE
         AND (fi.is_eaten = FALSE OR fi.last_eaten_at < NOW() - INTERVAL '7 days')
       ORDER BY RANDOM()
       LIMIT 1`,
            [roomId]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Chưa có món ăn nào. Hãy thêm vào nhé!' });
        }

        res.json({ item: result.rows[0] });
    } catch (err) {
        next(err);
    }
}

// PATCH /api/food/:id
async function update(req, res, next) {
    try {
        const { id } = req.params;
        const { id: roomId } = req.coupleRoom;
        const { name, emoji, location } = req.body;

        const result = await query(
            `UPDATE food_items
             SET name = COALESCE($3, name),
                 emoji = COALESCE($4, emoji),
                 location = COALESCE($5, location)
             WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE
             RETURNING *`,
            [id, roomId, name, emoji, location]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Food item not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
}

// PATCH /api/food/:id/eaten
async function markEaten(req, res, next) {
    try {
        const { id } = req.params;
        const { id: roomId } = req.coupleRoom;
        
        const result = await query(
            `UPDATE food_items
             SET is_eaten = TRUE, last_eaten_at = NOW()
             WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE
             RETURNING *`,
            [id, roomId]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Food item not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
}

module.exports = { list, create, remove, spin, update, markEaten };
