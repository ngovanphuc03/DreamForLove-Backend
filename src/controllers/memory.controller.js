const { query } = require('../config/database');
const { getIO } = require('../socket/socket.handler');
const { uploadImage, deleteImage, parseBase64Image } = require('../config/storage');
const { sendPushNotification } = require('../config/firebase');
const logger = require('../config/logger');

async function deleteOldMemoryPhoto(roomId) {
    try {
        const oldRoom = await query(
            'SELECT memory_photo_key FROM couple_rooms WHERE id = $1',
            [roomId]
        );
        const oldKey = oldRoom.rows[0]?.memory_photo_key;
        if (oldKey) {
            try {
                await deleteImage(oldKey);
            } catch (e) {
                logger.warn(`[MemoryPhoto] Failed to delete old image key=${oldKey}: ${e.message}`);
            }
        }
    } catch (err) {
        logger.warn(`[MemoryPhoto] Error looking up old image key: ${err.message}`);
    }
}

// PATCH /api/couple/memory-photo
async function updateMemoryPhoto(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const raw = req.body?.image_base64;
        const normalized = typeof raw === 'string' && raw.trim().length
            ? raw.trim()
            : null;

        let photoUrl = null;
        let photoKey = null;

        await deleteOldMemoryPhoto(roomId);

        if (normalized) {
            // Upload new photo to object storage
            const { buffer, mimeType } = parseBase64Image(normalized);
            const uploaded = await uploadImage(buffer, 'memory-photos', mimeType);
            photoUrl = uploaded.url;
            photoKey = uploaded.key;
        }

        const result = await query(
            `UPDATE couple_rooms
             SET memory_photo_url = $2,
                 memory_photo_key = $3,
                 memory_photo_base64 = NULL,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING id, memory_photo_url, updated_at`,
            [roomId, photoUrl, photoKey]
        );

        const updated = result.rows[0];
        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).emit('couple:memory-photo-updated', {
                roomId,
                byUserId: userId,
                hasPhoto: !!updated?.memory_photo_url,
                photoUrl: updated?.memory_photo_url || null,
                updatedAt: updated?.updated_at || new Date().toISOString(),
            });
        }

        // Send real-time FCM push notification to partner in background
        (async () => {
            try {
                const partnerRes = await query(
                    `SELECT u.fcm_token, u.display_name
                     FROM users u
                     JOIN couple_rooms cr ON (cr.user_a_id = u.id OR cr.user_b_id = u.id)
                     WHERE cr.id = $1 AND u.id != $2 AND cr.status = 'active'
                     LIMIT 1`,
                    [roomId, userId]
                );
                const partner = partnerRes.rows[0];
                if (partner && partner.fcm_token) {
                    const senderName = req.dbUser.display_name || 'Người ấy';
                    await sendPushNotification(
                        partner.fcm_token,
                        {
                            title: `📸 ${senderName} vừa gửi một ảnh kỷ niệm mới!`,
                            body: 'Mở widget hoặc app để xem khoảnh khắc ngọt ngào ngay nhé 💕',
                        },
                        {
                            type: 'memory_photo_update',
                            photoUrl: photoUrl || '',
                            roomId,
                        }
                    );
                }
            } catch (pushErr) {
                logger.warn(`[MemoryPhoto] Push notification error: ${pushErr.message}`);
            }
        })();

        return res.json({
            success: true,
            roomId,
            hasPhoto: !!updated?.memory_photo_url,
            memory_photo_url: updated?.memory_photo_url || null,
            updated_at: updated?.updated_at || new Date().toISOString(),
        });
    } catch (err) {
        next(err);
    }
}

module.exports = { updateMemoryPhoto };
