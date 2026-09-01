const { query, transaction } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { randomInt } = require('crypto');
const { getIO } = require('../socket/socket.handler');

// GET /api/food?page=1&limit=50&category=...&favorite=...
async function list(req, res, next) {
    try {
        const { id: roomId } = req.coupleRoom;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
        const offset = (page - 1) * limit;
        const { category, favorite } = req.query;

        let whereClause = 'WHERE fi.couple_room_id = $1 AND fi.is_deleted = FALSE';
        const params = [roomId];

        if (category && category !== 'Tất cả') {
            params.push(category);
            whereClause += ` AND fi.category = $${params.length}`;
        }

        if (favorite === 'true') {
            whereClause += ' AND fi.is_favorite = TRUE';
        }

        const countResult = await query(
            `SELECT COUNT(*)::int AS total FROM food_items fi ${whereClause}`,
            params
        );
        const total = countResult.rows[0]?.total || 0;

        const listParams = [...params, limit, offset];
        const result = await query(
            `SELECT fi.*, u.display_name AS added_by_name
             FROM food_items fi
             JOIN users u ON fi.added_by = u.id
             ${whereClause}
             ORDER BY fi.is_favorite DESC, fi.created_at DESC
             LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
            listParams
        );

        res.json({
            items: result.rows,
            is_premium: true,
            count: result.rows.length,
            total,
            page,
            limit,
            total_pages: Math.ceil(total / limit) || 1,
            free_limit: null,
        });
    } catch (err) {
        next(err);
    }
}

// POST /api/food
async function create(req, res, next) {
    try {
        const { id: roomId } = req.coupleRoom;
        const userId = req.dbUser.id;
        const { name, emoji, location, category, notes, is_favorite } = req.body;

        const result = await query(
            `INSERT INTO food_items (id, couple_room_id, added_by, name, emoji, location, category, notes, is_favorite, eat_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [
                uuidv4(),
                roomId,
                userId,
                name.trim(),
                emoji || '🍜',
                location?.trim() || null,
                category?.trim() || 'Món chính',
                notes?.trim() || null,
                Boolean(is_favorite),
                0,
            ]
        );

        const item = result.rows[0];
        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit('food:sync', {
                action: 'create',
                item,
            });
        }

        res.status(201).json(item);
    } catch (err) {
        next(err);
    }
}

// POST /api/food/pack - Batch import mood food pack
async function importPack(req, res, next) {
    try {
        const { id: roomId } = req.coupleRoom;
        const userId = req.dbUser.id;
        const { items } = req.body;

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Danh sách món ăn không hợp lệ' });
        }

        const createdItems = [];
        await transaction(async (client) => {
            for (const item of items) {
                const id = uuidv4();
                const res = await client.query(
                    `INSERT INTO food_items (id, couple_room_id, added_by, name, emoji, location, category, notes, is_favorite, eat_count)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0)
                     RETURNING *`,
                    [
                        id,
                        roomId,
                        userId,
                        item.name?.trim() || 'Món ngon',
                        item.emoji || '🍜',
                        item.location?.trim() || null,
                        item.category?.trim() || 'Món chính',
                        item.notes?.trim() || null,
                        Boolean(item.is_favorite),
                    ]
                );
                createdItems.push(res.rows[0]);
            }
        });

        const io = getIO();
        if (io) {
            for (const item of createdItems) {
                io.to(`room:${roomId}`).except(`user:${userId}`).emit('food:sync', {
                    action: 'create',
                    item,
                });
            }
        }

        res.status(201).json({ success: true, count: createdItems.length, items: createdItems });
    } catch (err) {
        next(err);
    }
}

// DELETE /api/food/:id
async function remove(req, res, next) {
    try {
        const { id } = req.params;
        const { id: roomId } = req.coupleRoom;
        const userId = req.dbUser.id;

        const result = await query(
            `UPDATE food_items
             SET is_deleted = TRUE
             WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE
             RETURNING *`,
            [id, roomId]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Food item not found' });
        }

        const deletedItem = result.rows[0];
        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit('food:sync', {
                action: 'delete',
                item: deletedItem,
            });
        }

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}

// PATCH /api/food/:id
async function update(req, res, next) {
    try {
        const { id } = req.params;
        const { id: roomId } = req.coupleRoom;
        const userId = req.dbUser.id;
        const { name, emoji, location, category, notes, is_favorite } = req.body;

        const result = await query(
            `UPDATE food_items
             SET name = COALESCE($3, name),
                 emoji = COALESCE($4, emoji),
                 location = COALESCE($5, location),
                 category = COALESCE($6, category),
                 notes = COALESCE($7, notes),
                 is_favorite = COALESCE($8, is_favorite)
             WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE
             RETURNING *`,
            [id, roomId, name, emoji, location, category, notes, is_favorite]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Food item not found' });
        }

        const updated = result.rows[0];
        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit('food:sync', {
                action: 'update',
                item: updated,
            });
        }

        res.json(updated);
    } catch (err) {
        next(err);
    }
}

// PATCH /api/food/:id/toggle-eaten
async function toggleEaten(req, res, next) {
    try {
        const { id } = req.params;
        const { id: roomId } = req.coupleRoom;
        const userId = req.dbUser.id;

        // Fetch current status
        const curRes = await query(
            'SELECT * FROM food_items WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE',
            [id, roomId]
        );
        if (!curRes.rows.length) {
            return res.status(404).json({ error: 'Food item not found' });
        }

        const current = curRes.rows[0];
        const nextIsEaten = !current.is_eaten;

        let updatedItem;
        if (nextIsEaten) {
            // Marked as eaten: increment eat_count, update last_eaten_at, insert history
            const result = await query(
                `UPDATE food_items
                 SET is_eaten = TRUE,
                     last_eaten_at = NOW(),
                     eat_count = COALESCE(eat_count, 0) + 1
                 WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE
                 RETURNING *`,
                [id, roomId]
            );
            updatedItem = result.rows[0];

            // Log into food_history
            await query(
                `INSERT INTO food_history (id, couple_room_id, food_id, food_name, food_emoji, eaten_by, eaten_at, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)`,
                [uuidv4(), roomId, id, updatedItem.name, updatedItem.emoji, userId, updatedItem.notes]
            );
        } else {
            // Reset to un-eaten (Crave again / Thèm ăn lại)
            const result = await query(
                `UPDATE food_items
                 SET is_eaten = FALSE
                 WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE
                 RETURNING *`,
                [id, roomId]
            );
            updatedItem = result.rows[0];
        }

        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit('food:sync', {
                action: 'update',
                item: updatedItem,
            });
        }

        res.json(updatedItem);
    } catch (err) {
        next(err);
    }
}

// PATCH /api/food/:id/toggle-favorite
async function toggleFavorite(req, res, next) {
    try {
        const { id } = req.params;
        const { id: roomId } = req.coupleRoom;
        const userId = req.dbUser.id;

        const result = await query(
            `UPDATE food_items
             SET is_favorite = NOT COALESCE(is_favorite, FALSE)
             WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE
             RETURNING *`,
            [id, roomId]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Food item not found' });
        }

        const updated = result.rows[0];
        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit('food:sync', {
                action: 'update',
                item: updated,
            });
        }

        res.json(updated);
    } catch (err) {
        next(err);
    }
}

// GET /api/food/history - Meal history log
async function getHistory(req, res, next) {
    try {
        const { id: roomId } = req.coupleRoom;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        const countRes = await query(
            'SELECT COUNT(*)::int AS total FROM food_history WHERE couple_room_id = $1 AND is_deleted = FALSE',
            [roomId]
        );
        const total = countRes.rows[0]?.total || 0;

        const result = await query(
            `SELECT fh.*, u.display_name AS eaten_by_name
             FROM food_history fh
             LEFT JOIN users u ON fh.eaten_by = u.id
             WHERE fh.couple_room_id = $1 AND fh.is_deleted = FALSE
             ORDER BY fh.eaten_at DESC
             LIMIT $2 OFFSET $3`,
            [roomId, limit, offset]
        );

        res.json({
            items: result.rows,
            total,
            page,
            limit,
            total_pages: Math.ceil(total / limit) || 1,
        });
    } catch (err) {
        next(err);
    }
}

// GET /api/food/spin – random food picker with mode & category filter
async function spin(req, res, next) {
    try {
        const { id: roomId } = req.coupleRoom;
        const { mode, category } = req.query; // mode: 'all' | 'uneaten' | 'favorite' | 'category'

        let whereClause = 'WHERE fi.couple_room_id = $1 AND fi.is_deleted = FALSE';
        const params = [roomId];

        if (mode === 'uneaten') {
            whereClause += " AND (fi.is_eaten = FALSE OR fi.last_eaten_at < NOW() - INTERVAL '3 days')";
        } else if (mode === 'favorite') {
            whereClause += ' AND fi.is_favorite = TRUE';
        } else if (category && category !== 'Tất cả') {
            params.push(category);
            whereClause += ` AND fi.category = $${params.length}`;
        }

        const eligibleCountResult = await query(
            `SELECT COUNT(*)::int AS total FROM food_items fi ${whereClause}`,
            params
        );

        const totalEligible = eligibleCountResult.rows[0]?.total || 0;
        if (totalEligible <= 0) {
            // Fallback: pick any non-deleted food item in room
            const fallbackCount = await query(
                'SELECT COUNT(*)::int AS total FROM food_items WHERE couple_room_id = $1 AND is_deleted = FALSE',
                [roomId]
            );
            const totalFallback = fallbackCount.rows[0]?.total || 0;
            if (totalFallback <= 0) {
                return res.status(404).json({ error: 'Chưa có món ăn nào. Hãy thêm vào nhé!' });
            }

            const fbOffset = randomInt(totalFallback);
            const fbResult = await query(
                `SELECT fi.*, u.display_name AS added_by_name
                 FROM food_items fi
                 JOIN users u ON fi.added_by = u.id
                 WHERE fi.couple_room_id = $1 AND fi.is_deleted = FALSE
                 ORDER BY fi.created_at DESC, fi.id DESC
                 LIMIT 1 OFFSET $2`,
                [roomId, fbOffset]
            );
            return res.json({ item: fbResult.rows[0] });
        }

        const offset = randomInt(totalEligible);
        const listParams = [...params, offset];
        const result = await query(
            `SELECT fi.*, u.display_name AS added_by_name
             FROM food_items fi
             JOIN users u ON fi.added_by = u.id
             ${whereClause}
             ORDER BY fi.created_at DESC, fi.id DESC
             LIMIT 1 OFFSET $${listParams.length}`,
            listParams
        );

        res.json({ item: result.rows[0] });
    } catch (err) {
        next(err);
    }
}

// Backward-compatible markEaten
async function markEaten(req, res, next) {
    return toggleEaten(req, res, next);
}

module.exports = {
    list,
    create,
    importPack,
    remove,
    spin,
    update,
    markEaten,
    toggleEaten,
    toggleFavorite,
    getHistory,
};
