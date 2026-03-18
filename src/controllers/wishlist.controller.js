const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { getIO } = require('../socket/socket.handler');

// Premium limits removed — all features free for everyone

// GET /api/wishlist?page=1&limit=20
async function list(req, res, next) {
    try {
        const { id: roomId } = req.coupleRoom;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        // Total count (for pagination meta)
        const countResult = await query(
            'SELECT COUNT(*)::int AS total FROM wish_items WHERE couple_room_id = $1 AND is_deleted = FALSE',
            [roomId]
        );
        const total = countResult.rows[0].total;

        const result = await query(
            `SELECT wi.*,
              u.display_name AS added_by_name
       FROM wish_items wi
       JOIN users u ON wi.added_by = u.id
       WHERE wi.couple_room_id = $1
         AND wi.is_deleted = FALSE
       ORDER BY
         CASE wi.priority WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END,
         wi.created_at DESC
       LIMIT $2 OFFSET $3`,
            [roomId, limit, offset]
        );

        res.json({
            items: result.rows,
            is_premium: true,
            count: result.rows.length,
            total,
            page,
            limit,
            total_pages: Math.ceil(total / limit),
            free_limit: null,
        });
    } catch (err) {
        next(err);
    }
}

// POST /api/wishlist
async function create(req, res, next) {
    try {
        const { id: roomId, is_premium } = req.coupleRoom;
        const { name, category, price, priority, image_url, product_url } = req.body;

        const result = await query(
            `INSERT INTO wish_items
         (id, couple_room_id, added_by, name, category, price, priority, image_url, product_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
            [
                uuidv4(),
                roomId,
                userId,
                name,
                category || 'Khác',
                price || 0,
                priority || 'low',
                image_url || null,
                product_url || null,
            ]
        );

        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit('wishlist:sync', {
                action: 'create',
                item: result.rows[0],
            });
        }

        res.status(201).json(result.rows[0]);
    } catch (err) {
        next(err);
    }
}

// PATCH /api/wishlist/:id/bought
async function markBought(req, res, next) {
    try {
        const { id } = req.params;
        const { id: roomId } = req.coupleRoom;

        const result = await query(
            `UPDATE wish_items
       SET is_bought = $3,
           bought_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE
       RETURNING *`,
            [id, roomId, desiredBought]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Wish item not found' });
        }

        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit('wishlist:sync', {
                action: 'update',
                item: result.rows[0],
            });
        }

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
}

// DELETE /api/wishlist/:id
async function remove(req, res, next) {
    try {
        const { id } = req.params;
        const { id: roomId } = req.coupleRoom;
        const userId = req.dbUser.id;

        const beforeDelete = await query(
            `SELECT * FROM wish_items
             WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE
             LIMIT 1`,
            [id, roomId]
        );

        await query(
            `UPDATE wish_items
       SET is_deleted = TRUE, updated_at = NOW()
       WHERE id = $1 AND couple_room_id = $2`,
            [id, roomId]
        );

        const deletedItem = beforeDelete.rows[0];
        if (deletedItem) {
            const io = getIO();
            if (io) {
                io.to(`room:${roomId}`).except(`user:${userId}`).emit('wishlist:sync', {
                    action: 'delete',
                    item: deletedItem,
                });
            }
        }

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}

module.exports = { list, create, markBought, remove };
