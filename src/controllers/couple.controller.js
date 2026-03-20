const { query, transaction } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { randomInt } = require('crypto');
const { getIO } = require('../socket/socket.handler');
const { isUserOnline } = require('../socket/socket.handler');
const { sendPushNotification } = require('../config/firebase');

// ── Helper: generate 6-digit code ──────────────────────────────
function generateCode6() {
    return randomInt(100000, 1000000).toString();
}

// ── Default milestones per couple room ────────────────────────
const DEFAULT_MILESTONES = [
    { days: 100, label: '100 Ngày', emoji: '🌸' },
    { days: 200, label: '200 Ngày', emoji: '🌺' },
    { days: 365, label: '1 Năm', emoji: '💍' },
    { days: 500, label: '500 Ngày', emoji: '⭐' },
    { days: 730, label: '2 Năm', emoji: '💎' },
    { days: 1000, label: '1000 Ngày', emoji: '🏆' },
    { days: 1825, label: '5 Năm', emoji: '👑' },
];

// GET /api/couple/me
async function getMyRoom(req, res, next) {
    try {
        const userResult = await query(
            'SELECT id, display_name, photo_url FROM users WHERE firebase_uid = $1',
            [req.user.uid]
        );
        if (!userResult.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userId = userResult.rows[0].id;
        const userDisplayName = userResult.rows[0].display_name;
        const userPhotoUrl = userResult.rows[0].photo_url;

        // Get the couple room
        const roomResult = await query(
            `SELECT cr.*,
              CURRENT_DATE - cr.start_date AS days_together
       FROM couple_rooms cr
       WHERE (cr.user_a_id = $1 OR cr.user_b_id = $1)
         AND cr.status = 'active'
       LIMIT 1`,
            [userId]
        );

        if (!roomResult.rows.length) {
            return res.json({ room: null });
        }

        const room = roomResult.rows[0];

        // Determine partner id (the OTHER user in the room)
        const partnerId = room.user_a_id === userId ? room.user_b_id : room.user_a_id;

        // Get partner info
        let partnerName = 'Người ấy 💕';
        let partnerAvatar = null;
        if (partnerId) {
            const partnerResult = await query(
                'SELECT display_name, photo_url FROM users WHERE id = $1',
                [partnerId]
            );
            if (partnerResult.rows.length) {
                partnerName = partnerResult.rows[0].display_name || partnerName;
                partnerAvatar = partnerResult.rows[0].photo_url;
            }
        }

        res.json({
            room: {
                id: room.id,
                user_display_name: userDisplayName || 'Bạn',
                user_avatar: userPhotoUrl,
                start_date: room.start_date,
                days_together: room.days_together,
                partner_name: partnerName,
                partner_avatar: partnerAvatar,
                is_active: room.status === 'active',
                is_premium: room.is_premium || false,
            }
        });
    } catch (err) {
        next(err);
    }
}

// POST /api/couple/generate-code
async function generateCode(req, res, next) {
    try {
        const userResult = await query(
            'SELECT id FROM users WHERE firebase_uid = $1',
            [req.user.uid]
        );
        const userId = userResult.rows[0]?.id;
        if (!userId) return res.status(404).json({ error: 'User not found' });

        // Invalidate existing codes
        await query(
            'UPDATE pairing_codes SET used = TRUE WHERE user_id = $1 AND NOT used',
            [userId]
        );

        // Generate unique code and insert securely to avoid race conditions
        let code;
        let inserted = false;
        let retries = 0;
        const maxRetries = 5;

        while (!inserted && retries < maxRetries) {
            code = generateCode6();
            const insertResult = await query(
                `INSERT INTO pairing_codes (id, code, user_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (code) DO NOTHING
                 RETURNING id`,
                [uuidv4(), code, userId]
            );
            if (insertResult.rowCount > 0) {
                inserted = true;
            }
            retries++;
        }

        if (!inserted) {
            throw new Error('Could not generate a unique pairing code. Please try again.');
        }

        res.json({ code, expires_in_seconds: 900 });
    } catch (err) {
        next(err);
    }
}

// POST /api/couple/join
async function joinWithCode(req, res, next) {
    try {
        const { code, start_date } = req.body;

        // Fetch user B (the one joining)
        const userBResult = await query(
            'SELECT id FROM users WHERE firebase_uid = $1',
            [req.user.uid]
        );
        const userBId = userBResult.rows[0]?.id;
        if (!userBId) return res.status(404).json({ error: 'User not found' });

        await transaction(async (client) => {
            // Validate code
            const codeResult = await client.query(
                `SELECT * FROM pairing_codes
         WHERE code = $1 AND NOT used AND expires_at > NOW()`,
                [code]
            );

            if (!codeResult.rows.length) {
                const err = new Error('Mã không hợp lệ hoặc đã hết hạn');
                err.statusCode = 400;
                throw err;
            }

            const pairingCode = codeResult.rows[0];
            let userAId = pairingCode.user_id;

            // Prevent self-pairing (in dev mode: auto-create a second user)
            if (userAId === userBId) {
                if (process.env.NODE_ENV !== 'production') {
                    // Dev mode: create a fake partner so pairing works
                    const devPartner = await client.query(
                        `INSERT INTO users (id, firebase_uid, email, display_name, photo_url, provider)
                         VALUES ($1, $2, $3, $4, $5, $6)
                         ON CONFLICT (firebase_uid) DO UPDATE SET display_name = $4
                         RETURNING id`,
                        [uuidv4(), 'dev_partner_002', 'partner@dreamforlove.app', 'Người Ấy 💕', null, 'dev']
                    );
                    // Re-assign code ownership to the partner
                    await client.query(
                        'UPDATE pairing_codes SET user_id = $1 WHERE id = $2',
                        [devPartner.rows[0].id, pairingCode.id]
                    );
                    // Now userA becomes the partner
                    // eslint-disable-next-line no-param-reassign
                    userAId = devPartner.rows[0].id;
                } else {
                    const err = new Error('Không thể ghép đôi với chính mình!');
                    err.statusCode = 400;
                    throw err;
                }
            }

            // Mark code as used
            await client.query(
                'UPDATE pairing_codes SET used = TRUE WHERE id = $1',
                [pairingCode.id]
            );

            // Create couple room
            const roomId = uuidv4();
            const roomResult = await client.query(
                `INSERT INTO couple_rooms (id, user_a_id, user_b_id, start_date)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
                [roomId, userAId, userBId, start_date]
            );
            const room = roomResult.rows[0];

            // Insert default milestones
            for (const m of DEFAULT_MILESTONES) {
                await client.query(
                    `INSERT INTO milestones (id, couple_room_id, label, target_days, emoji)
           VALUES ($1, $2, $3, $4, $5)`,
                    [uuidv4(), roomId, m.label, m.days, m.emoji]
                );
            }

            // Get partner info (user A - the one who generated the code)
            const partnerResult = await client.query(
                'SELECT display_name, photo_url FROM users WHERE id = $1',
                [userAId]
            );
            const partner = partnerResult.rows[0];

            // Get user B info (current user joining) to send back
            const userBInfoResult = await client.query(
                'SELECT display_name, photo_url FROM users WHERE id = $1',
                [userBId]
            );
            const userBInfo = userBInfoResult.rows[0];

            // Notify user A (code generator) via socket that pairing completed
            const io = getIO();
            if (io) {
                io.to(`user:${userAId}`).emit('pairing:completed', {
                    roomId: room.id,
                    partnerId: userBId,
                    partnerName: userBInfo?.display_name || 'Người ấy 💕',
                    partnerAvatar: userBInfo?.photo_url,
                    startDate: room.start_date,
                });
            }

            return res.json({
                id: room.id,
                user_display_name: userBInfo?.display_name || 'Bạn',
                user_avatar: userBInfo?.photo_url,
                partner_name: partner?.display_name || 'Người ấy 💕',
                partner_avatar: partner?.photo_url,
                start_date: room.start_date,
                days_together: Math.floor((Date.now() - new Date(room.start_date).getTime()) / 86400000),
                is_active: true,
                is_premium: false,
            });
        });
    } catch (err) {
        next(err);
    }
}

// DELETE /api/couple/me  (Soft delete)
async function disconnect(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const retentionDays = Number(process.env.DATA_RETENTION_DAYS) || 30;

        await query(
            `UPDATE couple_rooms SET
         status         = 'inactive',
         deactivated_at = NOW(),
         delete_after   = NOW() + INTERVAL '1 day' * $2,
         updated_at     = NOW()
       WHERE id = $1`,
            [roomId, retentionDays]
        );

        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).emit('couple:disconnected', {
                roomId,
                byUserId: userId,
                at: new Date().toISOString(),
            });
        }

        res.json({ success: true, message: 'Đã ngắt kết nối. Dữ liệu sẽ được xóa sau 30 ngày.' });
    } catch (err) {
        next(err);
    }
}

// POST /api/couple/heartbeat (HTTP fallback for ping:partner socket event)
async function sendHeartbeat(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;

        const partnerResult = await query(
            `SELECT u.id, u.fcm_token, u.display_name
             FROM couple_rooms cr
             JOIN users u ON (
               (cr.user_a_id = $1 AND cr.user_b_id = u.id) OR
               (cr.user_b_id = $1 AND cr.user_a_id = u.id)
             )
             WHERE cr.id = $2 AND cr.status = 'active'
             LIMIT 1`,
            [userId, roomId]
        );

        const partner = partnerResult.rows[0];
        if (!partner?.id) {
            return res.status(404).json({
                delivered: false,
                reason: 'partner_not_found',
                message: 'Không tìm thấy đối phương trong phòng đôi.',
            });
        }

        const partnerOnline = isUserOnline(partner.id);

        // Realtime delivery to partner sockets (if connected)
        const io = getIO();
        if (io) {
            io.to(`user:${partner.id}`).emit('partner:ping', {
                userId,
                displayName: req.dbUser.display_name,
            });
        }

        // Push fallback for offline/background partner
        let pushSent = false;
        let pushReason = partner.fcm_token ? 'queued' : 'missing_fcm_token';

        if (partner.fcm_token) {
            try {
                pushSent = await sendPushNotification({
                    token: partner.fcm_token,
                    title: `${req.dbUser.display_name} nhớ bạn 💕`,
                    body: 'Chạm vào để xem rung tim!',
                    data: { type: 'HEARTBEAT_PING' },
                });
                pushReason = pushSent ? 'sent' : 'push_send_failed';
            } catch (_) {
                pushSent = false;
                pushReason = 'push_error';
            }
        }

        return res.json({
            delivered: true,
            partnerOnline,
            partnerId: partner.id,
            pushSent,
            pushReason,
            via: 'http_fallback',
        });
    } catch (err) {
        next(err);
    }
}

// ── Milestones CRUD ──────────────────────────────────────────────
async function getMilestones(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const result = await query(
            'SELECT * FROM milestones WHERE couple_room_id = $1 ORDER BY target_days ASC',
            [roomId]
        );
        res.json({ milestones: result.rows });
    } catch (err) {
        next(err);
    }
}

async function createMilestone(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const { label, target_days, emoji } = req.body;

        const result = await query(
            `INSERT INTO milestones (id, couple_room_id, label, target_days, emoji, is_custom)
             VALUES ($1, $2, $3, $4, $5, TRUE)
             RETURNING *`,
            [uuidv4(), roomId, label, target_days, emoji || '🎯']
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        next(err);
    }
}

async function updateMilestone(req, res, next) {
    try {
        const { id } = req.params;
        const roomId = req.coupleRoom.id;
        const { label, target_days, emoji } = req.body;

        const result = await query(
            `UPDATE milestones
             SET label = COALESCE($3, label),
                 target_days = COALESCE($4, target_days),
                 emoji = COALESCE($5, emoji)
             WHERE id = $1 AND couple_room_id = $2
             RETURNING *`,
            [id, roomId, label, target_days, emoji]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Milestone not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
}

async function deleteMilestone(req, res, next) {
    try {
        const { id } = req.params;
        const roomId = req.coupleRoom.id;
        await query('DELETE FROM milestones WHERE id = $1 AND couple_room_id = $2', [id, roomId]);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    getMyRoom, generateCode, joinWithCode, disconnect,
    getMilestones, createMilestone, updateMilestone, deleteMilestone,
    sendHeartbeat,
};
