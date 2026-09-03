const { query, transaction } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { getIO, isUserOnline } = require('../socket/socket.handler');
const { sendPushNotification } = require('../config/firebase');
const logger = require('../config/logger');
const { awardLoveCoins, REWARD_PRESETS } = require('../services/loveCoinReward.service');

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
        const { id: roomId } = req.coupleRoom;
        const userId = req.dbUser.id;
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

        // FCM push khi tạo ước mơ
        try {
            const partnerRes = await query(
                `SELECT u.id, u.fcm_token FROM users u
                 JOIN couple_rooms cr ON (cr.user_a_id = u.id OR cr.user_b_id = u.id)
                 WHERE cr.id = $1 AND u.id != $2 AND cr.status = 'active' LIMIT 1`,
                [roomId, userId]
            );
            if (partnerRes.rows.length) {
                const partner = partnerRes.rows[0];
                if (!isUserOnline(partner.id) && partner.fcm_token) {
                    const senderName = req.dbUser.display_name || 'Người ấy';
                    await sendPushNotification(partner.fcm_token, {
                        title: `✨ ${senderName} thêm ước mơ mới!`,
                        body: `"${name}" — Vào xem & đánh dấu yêu thích nhé 💕`,
                        data: { type: 'WISHLIST_CREATED', wishName: String(name || '') },
                    });
                }
            }
        } catch (fcmErr) {
            logger.error(`[Wishlist] FCM push error: ${fcmErr.message}`);
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
        const userId = req.dbUser.id;
        const desiredBought = req.body?.is_bought === false ? false : true;

        const txResult = await transaction(async (client) => {
            const currentResult = await client.query(
                `SELECT id, is_bought
                 FROM wish_items
                 WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE
                 FOR UPDATE`,
                [id, roomId]
            );

            if (!currentResult.rows.length) {
                return { notFound: true };
            }

            const wasBought = currentResult.rows[0].is_bought === true;
            const updatedResult = await client.query(
                `UPDATE wish_items
                 SET is_bought = $3,
                     bought_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
                     updated_at = NOW()
                 WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE
                 RETURNING *`,
                [id, roomId, desiredBought]
            );

            const item = updatedResult.rows[0];
            let rewardResult = null;
            if (!wasBought && desiredBought) {
                rewardResult = await awardLoveCoins({
                    client,
                    coupleRoomId: roomId,
                    rewardType: REWARD_PRESETS.wishlistBought.type,
                    rewardKey: id,
                    coins: REWARD_PRESETS.wishlistBought.coins,
                    awardedBy: userId,
                    metadata: {
                        source: 'wishlist.markBought',
                    },
                });
            }

            return { item, rewardResult };
        });

        if (txResult.notFound) {
            return res.status(404).json({ error: 'Wish item not found' });
        }

        const resultItem = txResult.item;

        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit('wishlist:sync', {
                action: 'update',
                item: resultItem,
            });

            if (txResult.rewardResult?.awardedCoins > 0) {
                io.to(`room:${roomId}`).emit('pet:inventory_update', {
                    loveCoins: txResult.rewardResult.loveCoins,
                    inventory: txResult.rewardResult.inventory,
                });
            }
        }

        // FCM push khi đánh dấu đã mua
        if (desiredBought && resultItem) {
            try {
                const partnerRes = await query(
                    `SELECT u.id, u.fcm_token FROM users u
                     JOIN couple_rooms cr ON (cr.user_a_id = u.id OR cr.user_b_id = u.id)
                     WHERE cr.id = $1 AND u.id != $2 AND cr.status = 'active' LIMIT 1`,
                    [roomId, userId]
                );
                if (partnerRes.rows.length) {
                    const partner = partnerRes.rows[0];
                    if (!isUserOnline(partner.id) && partner.fcm_token) {
                        const buyerName = req.dbUser.display_name || 'Người ấy';
                        await sendPushNotification(partner.fcm_token, {
                            title: `🎁 ${buyerName} đã thực hiện ước mơ!`,
                            body: `"${resultItem.name}" đã được mua rồi 🎉💕`,
                            data: { type: 'WISHLIST_BOUGHT', wishName: String(resultItem.name || '') },
                        });
                    }
                }
            } catch (fcmErr) {
                logger.error(`[Wishlist] FCM bought push error: ${fcmErr.message}`);
            }
        }

        res.json(resultItem);
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

        const result = await query(
            `UPDATE wish_items
       SET is_deleted = TRUE, updated_at = NOW()
       WHERE id = $1 AND couple_room_id = $2 AND added_by = $3 AND is_deleted = FALSE
       RETURNING *`,
            [id, roomId, userId]
        );

        if (!result.rows.length) {
            const ownershipCheck = await query(
                `SELECT id, added_by
                     FROM wish_items
                     WHERE id = $1 AND couple_room_id = $2 AND is_deleted = FALSE`,
                [id, roomId]
            );

            if (ownershipCheck.rows.length) {
                return res.status(403).json({
                    error: 'Bạn chỉ có thể xóa wishlist của mình / You can only delete your own wishlist item',
                });
            }

            return res.status(404).json({ error: 'Wish item not found' });
        }

        const deletedItem = result.rows[0];
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

// PATCH /api/wishlist/:id
async function update(req, res, next) {
    try {
        const { id } = req.params;
        const { id: roomId } = req.coupleRoom;
        const userId = req.dbUser.id;
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

module.exports = { list, create, markBought, remove, update };
