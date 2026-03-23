const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { getIO } = require('../socket/socket.handler');

// GET /api/trips?page=1&limit=20
async function list(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;

        const countResult = await query(
            'SELECT COUNT(*)::int AS total FROM trip_plans WHERE couple_room_id = $1 AND is_deleted = FALSE',
            [roomId]
        );
        const total = countResult.rows[0].total;

        const result = await query(
            `SELECT tp.*, u.display_name AS added_by_name
             FROM trip_plans tp
             JOIN users u ON tp.added_by = u.id
             WHERE tp.couple_room_id = $1
               AND tp.is_deleted = FALSE
             ORDER BY tp.is_done ASC,
                      tp.planned_date ASC NULLS LAST,
                      tp.created_at DESC
             LIMIT $2 OFFSET $3`,
            [roomId, limit, offset]
        );

        res.json({
            items: result.rows,
            count: result.rows.length,
            total,
            page,
            limit,
            total_pages: Math.ceil(total / limit),
        });
    } catch (err) {
        next(err);
    }
}

// POST /api/trips
async function create(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const { title, location, note, planned_date } = req.body;

        const result = await query(
            `INSERT INTO trip_plans (id, couple_room_id, added_by, title, location, note, planned_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
                uuidv4(),
                roomId,
                userId,
                title,
                location,
                note || null,
                planned_date || null,
            ]
        );

        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit('trip:sync', {
                action: 'create',
                item: result.rows[0],
            });
        }

        res.status(201).json(result.rows[0]);
    } catch (err) {
        next(err);
    }
}

// PATCH /api/trips/:id
async function update(req, res, next) {
    try {
        const { id } = req.params;
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const { title, location, note, planned_date, is_done } = req.body;

        const result = await query(
            `UPDATE trip_plans
             SET title = COALESCE($3, title),
                 location = COALESCE($4, location),
                 note = COALESCE($5, note),
                 planned_date = COALESCE($6, planned_date),
                 is_done = COALESCE($7, is_done)
             WHERE id = $1
               AND couple_room_id = $2
               AND is_deleted = FALSE
             RETURNING *`,
            [id, roomId, title, location, note, planned_date, is_done]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Trip plan not found' });
        }

        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit('trip:sync', {
                action: 'update',
                item: result.rows[0],
            });
        }

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
}

// PATCH /api/trips/:id/done
async function markDone(req, res, next) {
    try {
        const { id } = req.params;
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const done = req.body?.is_done === false ? false : true;

        const result = await query(
            `UPDATE trip_plans
             SET is_done = $3
             WHERE id = $1
               AND couple_room_id = $2
               AND is_deleted = FALSE
             RETURNING *`,
            [id, roomId, done]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Trip plan not found' });
        }

        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit('trip:sync', {
                action: 'update',
                item: result.rows[0],
            });
        }

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
}

// DELETE /api/trips/:id
async function remove(req, res, next) {
    try {
        const { id } = req.params;
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;

        const result = await query(
            `UPDATE trip_plans
             SET is_deleted = TRUE
             WHERE id = $1
               AND couple_room_id = $2
               AND is_deleted = FALSE
             RETURNING *`,
            [id, roomId]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Trip plan not found' });
        }

        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit('trip:sync', {
                action: 'delete',
                item: result.rows[0],
            });
        }

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    list,
    create,
    update,
    markDone,
    remove,
};
