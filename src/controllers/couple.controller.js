const { query, transaction } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { randomInt } = require('crypto');
const { getIO } = require('../socket/socket.handler');
const { isUserOnline } = require('../socket/socket.handler');
const { sendPushNotification } = require('../config/firebase');

const PAIRING_CODE_EXPIRY_SECONDS = 15 * 60;
const PAIRING_CODE_MAX_RETRIES = 5;

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

const LEVEL_THRESHOLDS = [0, 100, 250, 450, 700, 1000, 1350, 1750];
const XP_PER_QUALIFIED_DAY = 25;

function computeLevelProgress(totalXp) {
    let currentLevel = 1;
    for (let i = 0; i < LEVEL_THRESHOLDS.length; i += 1) {
        if (totalXp >= LEVEL_THRESHOLDS[i]) {
            currentLevel = i + 1;
        }
    }

    const currentLevelStartXp = LEVEL_THRESHOLDS[currentLevel - 1] || 0;
    const nextLevelThresholdXp = LEVEL_THRESHOLDS[currentLevel] || (currentLevelStartXp + 450);
    const xpToNextLevel = Math.max(nextLevelThresholdXp - totalXp, 0);

    return { currentLevel, xpToNextLevel };
}

// GET /api/couple/me
async function getMyRoom(req, res, next) {
    try {
        const userResult = await query(
            `SELECT id, display_name, photo_url, gender, birth_date,
               CASE 
                 WHEN birth_date IS NOT NULL 
                 THEN DATE_PART('year', AGE((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, birth_date))::int 
                 ELSE NULL 
               END AS age
             FROM users WHERE firebase_uid = $1`,
            [req.user.uid]
        );
        if (!userResult.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }

        const uRow = userResult.rows[0];
        const userId = uRow.id;

        // Get the couple room
        const roomResult = await query(
            `SELECT cr.*,
              ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - cr.start_date) AS days_together
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
        let partnerGender = null;
        let partnerBirthDate = null;
        let partnerAge = null;
        if (partnerId) {
            const partnerResult = await query(
                `SELECT display_name, photo_url, gender, birth_date,
                   CASE 
                     WHEN birth_date IS NOT NULL 
                     THEN DATE_PART('year', AGE((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, birth_date))::int 
                     ELSE NULL 
                   END AS age
                 FROM users WHERE id = $1`,
                [partnerId]
            );
            if (partnerResult.rows.length) {
                const pr = partnerResult.rows[0];
                partnerName = pr.display_name || partnerName;
                partnerAvatar = pr.photo_url;
                partnerGender = pr.gender;
                partnerBirthDate = pr.birth_date;
                partnerAge = pr.age;
            }
        }

        res.json({
            room: {
                id: room.id,
                user_display_name: uRow.display_name || 'Bạn',
                user_avatar: uRow.photo_url,
                user_gender: uRow.gender,
                user_birth_date: uRow.birth_date,
                user_age: uRow.age,
                start_date: room.start_date,
                days_together: room.days_together,
                partner_name: partnerName,
                partner_avatar: partnerAvatar,
                partner_gender: partnerGender,
                partner_birth_date: partnerBirthDate,
                partner_age: partnerAge,
                memory_photo_base64: room.memory_photo_url || room.memory_photo_base64 || null,
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

        const activeRoomResult = await query(
            `SELECT id
             FROM couple_rooms
             WHERE status = 'active'
               AND (user_a_id = $1 OR user_b_id = $1)
             LIMIT 1`,
            [userId]
        );
        if (activeRoomResult.rows.length) {
            return res.status(409).json({
                error: 'Bạn đang trong một phòng đôi hoạt động, không thể tạo mã mới.',
            });
        }

        // Invalidate existing codes
        await query(
            'UPDATE pairing_codes SET used = TRUE WHERE user_id = $1 AND NOT used',
            [userId]
        );

        // Generate unique code and insert securely to avoid race conditions
        let code;
        let inserted = false;
        let retries = 0;

        while (!inserted && retries < PAIRING_CODE_MAX_RETRIES) {
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

        res.json({ code, expires_in_seconds: PAIRING_CODE_EXPIRY_SECONDS });
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

            const userBActiveRoom = await client.query(
                `SELECT id
                                 FROM couple_rooms
                                 WHERE status = 'active'
                                     AND (user_a_id = $1 OR user_b_id = $1)
                                 LIMIT 1`,
                [userBId]
            );
            if (userBActiveRoom.rows.length) {
                const err = new Error('Bạn đã có phòng đôi đang hoạt động');
                err.statusCode = 409;
                throw err;
            }

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

            const userAActiveRoom = await client.query(
                `SELECT id
                 FROM couple_rooms
                 WHERE status = 'active'
                   AND (user_a_id = $1 OR user_b_id = $1)
                 LIMIT 1`,
                [userAId]
            );
            if (userAActiveRoom.rows.length) {
                const err = new Error('Người tạo mã đã có phòng đôi đang hoạt động');
                err.statusCode = 409;
                throw err;
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

            // Auto-create couple pet for the new room
            await client.query(
                `INSERT INTO couple_pet (id, couple_room_id)
                 VALUES ($1, $2)
                 ON CONFLICT (couple_room_id) DO NOTHING`,
                [uuidv4(), roomId]
            );

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

// GET /api/couple/progress
async function getProgress(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const partnerId = req.coupleRoom.user_a_id === userId
            ? req.coupleRoom.user_b_id
            : req.coupleRoom.user_a_id;

        const todayStatusResult = await query(
            `SELECT
                COALESCE(BOOL_OR(user_id = $2), FALSE) AS me_done,
                COALESCE(BOOL_OR($3::uuid IS NOT NULL AND user_id = $3::uuid), FALSE) AS partner_done
             FROM mood_logs
             WHERE couple_room_id = $1
               AND (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`,
            [roomId, userId, partnerId || null]
        );

        const currentStreakResult = await query(
            `WITH qualified_days AS (
                SELECT (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day
                FROM mood_logs
                WHERE couple_room_id = $1
                GROUP BY 1
                HAVING BOOL_OR(user_id = $2)
                   AND BOOL_OR($3::uuid IS NOT NULL AND user_id = $3::uuid)
            ),
            today_status AS (
                SELECT
                    COALESCE(BOOL_OR(day = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date), FALSE) AS today_done,
                    COALESCE(BOOL_OR(day = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1), FALSE) AS yesterday_done
                FROM qualified_days
            ),
            ranked AS (
                SELECT
                    q.day,
                    ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - (CASE WHEN ts.today_done THEN 0 ELSE 1 END) - q.day) AS day_offset,
                    ROW_NUMBER() OVER (ORDER BY q.day DESC) - 1 AS rn
                FROM qualified_days q
                CROSS JOIN today_status ts
                WHERE (ts.today_done OR ts.yesterday_done)
                  AND q.day <= (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            )
            SELECT COALESCE(COUNT(*), 0)::int AS current_streak
            FROM ranked
            WHERE day_offset = rn`,
            [roomId, userId, partnerId || null]
        );

        const bestStreakResult = await query(
            `WITH qualified_days AS (
                SELECT (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day
                FROM mood_logs
                WHERE couple_room_id = $1
                GROUP BY 1
                HAVING BOOL_OR(user_id = $2)
                   AND BOOL_OR($3::uuid IS NOT NULL AND user_id = $3::uuid)
            ),
            grouped AS (
                SELECT
                    day,
                    day - (ROW_NUMBER() OVER (ORDER BY day))::int AS grp
                FROM qualified_days
            ),
            streaks AS (
                SELECT COUNT(*)::int AS len
                FROM grouped
                GROUP BY grp
            )
            SELECT COALESCE(MAX(len), 0)::int AS best_streak
            FROM streaks`,
            [roomId, userId, partnerId || null]
        );

        const qualifiedDaysResult = await query(
            `SELECT COALESCE(COUNT(*), 0)::int AS total_qualified_days
             FROM (
                SELECT (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day
                FROM mood_logs
                WHERE couple_room_id = $1
                GROUP BY 1
                HAVING BOOL_OR(user_id = $2)
                   AND BOOL_OR($3::uuid IS NOT NULL AND user_id = $3::uuid)
             ) q`,
            [roomId, userId, partnerId || null]
        );

        const meDone = todayStatusResult.rows[0]?.me_done === true;
        const partnerDone = todayStatusResult.rows[0]?.partner_done === true;
        const qualifiedToday = meDone && partnerDone;

        const currentStreak = currentStreakResult.rows[0]?.current_streak || 0;
        const bestStreak = bestStreakResult.rows[0]?.best_streak || 0;
        const totalQualifiedDays = qualifiedDaysResult.rows[0]?.total_qualified_days || 0;

        const totalXp = totalQualifiedDays * XP_PER_QUALIFIED_DAY;
        const { currentLevel, xpToNextLevel } = computeLevelProgress(totalXp);

        return res.json({
            data: {
                currentStreak,
                bestStreak,
                totalXp,
                currentLevel,
                xpToNextLevel,
                freezeCount: 0,
                today: {
                    meDone,
                    partnerDone,
                    qualified: qualifiedToday,
                },
            },
        });
    } catch (err) {
        return next(err);
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

// PATCH /api/couple/memory-photo
async function updateMemoryPhoto(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const raw = req.body?.image_base64;
        const normalized = typeof raw === 'string' && raw.trim().length
            ? raw.trim()
            : null;

        const result = await query(
            `UPDATE couple_rooms
             SET memory_photo_base64 = $2,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING id, memory_photo_base64, updated_at`,
            [roomId, normalized]
        );

        const updated = result.rows[0];
        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).emit('couple:memory-photo-updated', {
                roomId,
                byUserId: userId,
                hasPhoto: !!updated?.memory_photo_base64,
                updatedAt: updated?.updated_at || new Date().toISOString(),
            });
        }

        return res.json({
            success: true,
            roomId,
            hasPhoto: !!updated?.memory_photo_base64,
            memory_photo_base64: updated?.memory_photo_base64 || null,
            updated_at: updated?.updated_at || new Date().toISOString(),
        });
    } catch (err) {
        next(err);
    }
}

// ── Update Start Date ────────────────────────────────────────────
async function updateStartDate(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const { start_date } = req.body;

        const result = await query(
            `UPDATE couple_rooms
             SET start_date = $2,
                 updated_at = NOW()
             WHERE id = $1 AND status = 'active'
             RETURNING id, start_date, ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - start_date) AS days_together`,
            [roomId, start_date]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Couple room not found' });
        }

        const updated = result.rows[0];

        // Notify partner via socket if connected
        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).emit('couple:start-date-updated', {
                roomId,
                startDate: updated.start_date,
                daysTogether: updated.days_together,
            });
        }

        res.json({
            success: true,
            start_date: updated.start_date,
            days_together: updated.days_together,
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
    getProgress,
    getMilestones, createMilestone, updateMilestone, deleteMilestone,
    sendHeartbeat, updateMemoryPhoto, updateStartDate,
};
