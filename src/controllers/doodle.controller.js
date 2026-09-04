const { query } = require('../config/database');
const { getIO } = require('../socket/socket.handler');
const logger = require('../config/logger');
const { getPartner } = require('../services/partner.service');
const { sendPushNotification } = require('../config/firebase');

/**
 * GET /api/doodles/latest
 * Get the most recent doodle for the couple room
 */
async function getLatestDoodle(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const result = await query(
            `SELECT * FROM love_doodles 
             WHERE couple_room_id = $1 
             ORDER BY created_at DESC 
             LIMIT 1`,
            [roomId]
        );

        res.json({ doodle: result.rows[0] || null });
    } catch (err) {
        next(err);
    }
}

/**
 * GET /api/doodles/history
 * Get paginated list of doodles for the couple room
 */
async function getDoodleHistory(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        const countResult = await query(
            'SELECT COUNT(*) FROM love_doodles WHERE couple_room_id = $1',
            [roomId]
        );
        const total = parseInt(countResult.rows[0].count) || 0;

        const result = await query(
            `SELECT id, couple_room_id, sender_id, sender_name, image_base64, is_chain, parent_doodle_id, created_at 
             FROM love_doodles 
             WHERE couple_room_id = $1 
             ORDER BY created_at DESC 
             LIMIT $2 OFFSET $3`,
            [roomId, limit, offset]
        );

        res.json({
            doodles: result.rows,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (err) {
        next(err);
    }
}

/**
 * GET /api/doodles/:id
 * Get full doodle data including detailed strokes for timelapse playback
 */
async function getDoodleById(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const { id } = req.params;

        const result = await query(
            'SELECT * FROM love_doodles WHERE id = $1 AND couple_room_id = $2',
            [id, roomId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Doodle not found' });
        }

        res.json({ doodle: result.rows[0] });
    } catch (err) {
        next(err);
    }
}

/**
 * POST /api/doodles
 * Create a new doodle or chain doodle
 */
async function createDoodle(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const senderId = req.dbUser.id;
        const senderName = req.dbUser.display_name || 'Người ấy';
        const { strokes_data, image_base64, is_chain, parent_doodle_id } = req.body;

        if (!strokes_data && !image_base64) {
            return res.status(400).json({ error: 'strokes_data or image_base64 is required' });
        }

        const strokesJson = typeof strokes_data === 'string'
            ? strokes_data
            : JSON.stringify(strokes_data || []);

        const result = await query(
            `INSERT INTO love_doodles 
             (couple_room_id, sender_id, sender_name, strokes_data, image_base64, is_chain, parent_doodle_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NOW(), NOW())
             RETURNING *`,
            [
                roomId,
                senderId,
                senderName,
                strokesJson,
                image_base64 || null,
                Boolean(is_chain),
                parent_doodle_id || null,
            ]
        );

        const newDoodle = result.rows[0];

        // 1. Broadcast real-time Socket event to couple room
        const io = getIO();
        if (io) {
            const eventName = is_chain ? 'doodle:chain_update' : 'doodle:new';
            io.to(`room:${roomId}`).emit(eventName, {
                doodle: newDoodle,
                senderId,
                senderName,
            });
            logger.info(`[Socket] Emitted ${eventName} to room:${roomId}`);
        }

        // 2. Send push notification to partner in background
        (async () => {
            try {
                const partner = await getPartner(roomId, senderId);
                if (partner && partner.fcm_token) {
                    const title = is_chain
                        ? `🎨 ${senderName} vừa vẽ tiếp vào bức tranh!`
                        : `🎨 Mảnh giấy vẽ mới từ ${senderName}!`;
                    const body = is_chain
                        ? 'Hai bạn vừa hoàn thành một bức tranh đồng sáng tác! Vào xem nhé 💕'
                        : 'Mở app để xem nét vẽ tay ngọt ngào ngay nào ✨';

                    await sendPushNotification(
                        partner.fcm_token,
                        { title, body },
                        {
                            type: 'doodle',
                            doodleId: newDoodle.id,
                            roomId,
                        }
                    );
                }
            } catch (notifyErr) {
                logger.warn(`[Doodle] Push notification error: ${notifyErr.message}`);
            }
        })();

        res.status(201).json({
            success: true,
            doodle: newDoodle,
        });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    getLatestDoodle,
    getDoodleHistory,
    getDoodleById,
    createDoodle,
};
