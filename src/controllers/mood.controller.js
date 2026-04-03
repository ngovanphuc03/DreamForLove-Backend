const { query, transaction } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { sendPushNotification } = require('../config/firebase');
const { getIO } = require('../socket/socket.handler');
const { awardLoveCoins, REWARD_PRESETS } = require('../services/loveCoinReward.service');

// GET /api/mood/current
async function getCurrent(req, res, next) {
    try {
        const { id: roomId } = req.coupleRoom;
        const userId = req.dbUser.id;

        const result = await query(
            `SELECT DISTINCT ON (user_id)
              id, type, note, user_id, couple_room_id, created_at
       FROM mood_logs
       WHERE couple_room_id = $1
         AND created_at >= CURRENT_DATE
       ORDER BY user_id, created_at DESC`,
            [roomId]
        );

        const myMood = result.rows.find(r => r.user_id === userId) ?? null;
        const partnerMood = result.rows.find(r => r.user_id !== userId) ?? null;

        res.json({ my_mood: myMood, partner_mood: partnerMood });
    } catch (err) {
        next(err);
    }
}

// GET /api/mood/history?page=1&limit=30
async function getHistory(req, res, next) {
    try {
        const { id: roomId } = req.coupleRoom;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
        const offset = (page - 1) * limit;

        const countResult = await query(
            'SELECT COUNT(*)::int AS total FROM mood_logs WHERE couple_room_id = $1',
            [roomId]
        );
        const total = countResult.rows[0].total;

        const result = await query(
            `SELECT ml.*, u.display_name AS user_name
       FROM mood_logs ml
       JOIN users u ON ml.user_id = u.id
       WHERE ml.couple_room_id = $1
       ORDER BY ml.created_at DESC
       LIMIT $2 OFFSET $3`,
            [roomId, limit, offset]
        );

        res.json({
            entries: result.rows,
            total,
            page,
            limit,
            total_pages: Math.ceil(total / limit),
        });
    } catch (err) {
        next(err);
    }
}

// POST /api/mood
async function create(req, res, next) {
    try {
        const { type, note } = req.body;
        const { id: roomId } = req.coupleRoom;
        const userId = req.dbUser.id;

        const { entry, partner, rewardResult } = await transaction(async (client) => {
            const inserted = await client.query(
                `INSERT INTO mood_logs (id, couple_room_id, user_id, type, note)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING *`,
                [uuidv4(), roomId, userId, type, note || null]
            );

            const moodEntry = inserted.rows[0];

            const partnerResult = await client.query(
                `SELECT u.id, u.fcm_token, u.display_name
                 FROM couple_rooms cr
                 JOIN users u ON (
                   CASE WHEN cr.user_a_id = $1 THEN cr.user_b_id ELSE cr.user_a_id END = u.id
                 )
                 WHERE cr.id = $2`,
                [userId, roomId]
            );

            const partnerData = partnerResult.rows[0] || null;

            let reward = null;
            if (partnerData?.id) {
                const qualifiedResult = await client.query(
                    `SELECT
                        COALESCE(BOOL_OR(user_id = $2), FALSE) AS me_done,
                        COALESCE(BOOL_OR($3::uuid IS NOT NULL AND user_id = $3::uuid), FALSE) AS partner_done,
                        CURRENT_DATE::text AS day_key
                     FROM mood_logs
                     WHERE couple_room_id = $1
                       AND (created_at AT TIME ZONE 'UTC')::date = CURRENT_DATE`,
                    [roomId, userId, partnerData.id]
                );

                const row = qualifiedResult.rows[0] || {};
                const qualifiedToday = row.me_done === true && row.partner_done === true;
                if (qualifiedToday) {
                    reward = await awardLoveCoins({
                        client,
                        coupleRoomId: roomId,
                        rewardType: REWARD_PRESETS.moodDailyPair.type,
                        rewardKey: row.day_key,
                        coins: REWARD_PRESETS.moodDailyPair.coins,
                        awardedBy: userId,
                        metadata: {
                            source: 'mood.create',
                            type,
                        },
                    });
                }
            }

            return {
                entry: moodEntry,
                partner: partnerData,
                rewardResult: reward,
            };
        });

        // ── Emit real-time to partner ─────────────────────────
        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).except(`user:${userId}`).emit(
                'partner_mood_update',
                entry
            );

            if (rewardResult?.awardedCoins > 0) {
                io.to(`room:${roomId}`).emit('pet:inventory_update', {
                    loveCoins: rewardResult.loveCoins,
                    inventory: rewardResult.inventory,
                });
            }
        }

        // ── Push notification if partner offline ──────────────
        if (partner?.fcm_token) {
            const senderName = req.dbUser?.display_name || 'Bạn ơi';
            const moodEmoji = { happy: '😊', sad: '😢', miss: '🥺', angry: '😤', love: '🥰' };
            await sendPushNotification({
                token: partner.fcm_token,
                title: `${senderName} ${moodEmoji[type] || '💕'}`,
                body: `Đang cảm thấy ${type === 'happy' ? 'vui' : type === 'sad' ? 'buồn' : type === 'miss' ? 'nhớ' : type === 'angry' ? 'giận' : 'yêu thương'}`,
                data: { type: 'MOOD_UPDATE', mood: type },
            });
        }

        res.status(201).json(entry);
    } catch (err) {
        next(err);
    }
}

module.exports = { getCurrent, getHistory, create };
