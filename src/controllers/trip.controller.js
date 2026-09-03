const { query, transaction } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { getIO, isUserOnline } = require('../socket/socket.handler');
const { sendPushNotification } = require('../config/firebase');
const logger = require('../config/logger');
const { awardLoveCoins, REWARD_PRESETS } = require('../services/loveCoinReward.service');

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

        // FCM push cho đối phương nếu offline
        try {
            const partnerRes = await query(
                `SELECT u.id, u.fcm_token, u.display_name
                 FROM users u
                 JOIN couple_rooms cr ON (cr.user_a_id = u.id OR cr.user_b_id = u.id)
                 WHERE cr.id = $1 AND u.id != $2 AND cr.status = 'active'
                 LIMIT 1`,
                [roomId, userId]
            );
            if (partnerRes.rows.length) {
                const partner = partnerRes.rows[0];
                if (!isUserOnline(partner.id) && partner.fcm_token) {
                    const senderName = req.dbUser.display_name || 'Người ấy';
                    await sendPushNotification(partner.fcm_token, {
                        title: `🗺️ ${senderName} lên kèo đi chơi!`,
                        body: `"${title}" — Vào xem lịch trình nhé 💕`,
                        data: { type: 'TRIP_CREATED', tripTitle: String(title || '') },
                    });
                }
            }
        } catch (fcmErr) {
            logger.error(`[Trip] FCM push error: ${fcmErr.message}`);
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

        const txResult = await transaction(async (client) => {
            const currentResult = await client.query(
                `SELECT id, is_done
                 FROM trip_plans
                 WHERE id = $1
                   AND couple_room_id = $2
                   AND is_deleted = FALSE
                 FOR UPDATE`,
                [id, roomId]
            );

            if (!currentResult.rows.length) {
                return { notFound: true };
            }

            const wasDone = currentResult.rows[0].is_done === true;
            const updatedResult = await client.query(
                `UPDATE trip_plans
                 SET is_done = $3
                 WHERE id = $1
                   AND couple_room_id = $2
                   AND is_deleted = FALSE
                 RETURNING *`,
                [id, roomId, done]
            );

            const item = updatedResult.rows[0];
            let rewardResult = null;
            if (!wasDone && done) {
                rewardResult = await awardLoveCoins({
                    client,
                    coupleRoomId: roomId,
                    rewardType: REWARD_PRESETS.tripDone.type,
                    rewardKey: id,
                    coins: REWARD_PRESETS.tripDone.coins,
                    awardedBy: userId,
                    metadata: {
                        source: 'trip.markDone',
                    },
                });
            }

            return { item, rewardResult };
        });

        if (txResult.notFound) {
            return res.status(404).json({ error: 'Trip plan not found' });
        }

        const tripItem = txResult.item;

        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit('trip:sync', {
                action: 'update',
                item: tripItem,
            });

            if (txResult.rewardResult?.awardedCoins > 0) {
                io.to(`room:${roomId}`).emit('pet:inventory_update', {
                    loveCoins: txResult.rewardResult.loveCoins,
                    inventory: txResult.rewardResult.inventory,
                });
            }
        }

        res.json(tripItem);
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
