const { query } = require('../config/database');
const { getIO } = require('../socket/socket.handler');
const { uploadImage, deleteImage, parseBase64Image } = require('../config/storage');

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

        if (normalized) {
            // Delete old photo from storage if exists
            const oldRoom = await query(
                'SELECT memory_photo_key FROM couple_rooms WHERE id = $1',
                [roomId]
            );
            const oldKey = oldRoom.rows[0]?.memory_photo_key;
            if (oldKey) {
                try { await deleteImage(oldKey); } catch (e) {
                    const logger = require('../config/logger');
                    logger.warn(`[MemoryPhoto] Failed to delete old image key=${oldKey}: ${e.message}`);
                }
            }

            // Upload new photo to object storage
            const { buffer, mimeType } = parseBase64Image(normalized);
            const uploaded = await uploadImage(buffer, 'memory-photos', mimeType);
            photoUrl = uploaded.url;
            photoKey = uploaded.key;
        } else {
            // Clearing photo — delete from storage
            const oldRoom = await query(
                'SELECT memory_photo_key FROM couple_rooms WHERE id = $1',
                [roomId]
            );
            const oldKey = oldRoom.rows[0]?.memory_photo_key;
            if (oldKey) {
                try { await deleteImage(oldKey); } catch (e) {
                    const logger = require('../config/logger');
                    logger.warn(`[MemoryPhoto] Failed to delete image key=${oldKey}: ${e.message}`);
                }
            }
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
