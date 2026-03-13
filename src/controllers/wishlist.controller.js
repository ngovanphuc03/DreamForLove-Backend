const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const FREE_LIMIT = Number(process.env.FREE_WISHLIST_LIMIT) || 10;

// GET /api/wishlist?page=1&limit=20
async function list(req, res, next) {
    try {
        const { id: roomId, is_premium } = req.coupleRoom;
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

// POST /api/wishlist
async function create(req, res, next) {
    try {
        const { id: roomId, is_premium } = req.coupleRoom;
        const { name, category, price, priority, image_url, product_url } = req.body;

        // Enforce free tier limit
        if (!is_premium) {
            const countResult = await query(
                'SELECT COUNT(*) FROM wish_items WHERE couple_room_id = $1 AND is_deleted = FALSE',
                [roomId]
            );
            if (Number(countResult.rows[0].count) >= FREE_LIMIT) {
                return res.status(403).json({
                    error: `Free plan chỉ cho ${FREE_LIMIT} món quà. Nâng cấp Premium!`,
                    code: 'UPGRADE_REQUIRED',
                });
            }
        }

        const result = await query(
            `INSERT INTO wish_items
         (id, couple_room_id, added_by, name, category, price, priority, image_url, product_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
            [
                uuidv4(),
                roomId,
                req.dbUser.id,
                name,
                category || 'Khác',
                price || 0,
                priority || 'low',
                image_url || null,
                product_url || null,
            ]
        );

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
       SET is_bought = TRUE, bought_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE
       RETURNING *`,
            [id, roomId]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Wish item not found' });
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

        await query(
            `UPDATE wish_items
       SET is_deleted = TRUE, updated_at = NOW()
       WHERE id = $1 AND couple_room_id = $2`,
            [id, roomId]
        );

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}

// PATCH /api/wishlist/:id
async function update(req, res, next) {
    try {
        const { id } = req.params;
        const { id: roomId } = req.coupleRoom;
        const { name, category, price, priority, image_url, product_url } = req.body;

        const result = await query(
            `UPDATE wish_items
             SET name = COALESCE($3, name),
                 category = COALESCE($4, category),
                 price = COALESCE($5, price),
                 priority = COALESCE($6, priority),
                 image_url = COALESCE($7, image_url),
                 product_url = COALESCE($8, product_url),
                 updated_at = NOW()
             WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE
             RETURNING *`,
            [id, roomId, name, category, price, priority, image_url, product_url]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Wish item not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
}

module.exports = { list, create, markBought, remove, update };
