const { getPool } = require('../config/database');
const logger = require('../config/logger');
const { getIO } = require('../socket/socket.handler');
const { sendNotificationToUser } = require('../services/firebase.service');

/**
 * Calculates current period status and predictions based on cycle data.
 */
function calculatePeriodStatus(lastPeriodDateStr, cycleLength = 28, periodDuration = 5) {
    const lastDate = new Date(lastPeriodDateStr);
    lastDate.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const diffMs = today.getTime() - lastDate.getTime();
    const daysSinceLast = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    // Cycle day normalized (1-indexed: day 1 to cycleLength)
    const normalizedDay = (((daysSinceLast % cycleLength) + cycleLength) % cycleLength) + 1;
    const daysUntilNext = cycleLength - normalizedDay + 1;

    // Calculate next period start date
    const cyclesElapsed = Math.floor(daysSinceLast / cycleLength);
    const nextPeriodDate = new Date(lastDate.getTime() + (cyclesElapsed + 1) * cycleLength * 86400000);

    let status = 'normal';
    let title = 'Giai đoạn bình thường 🌸';
    let advice = 'Nàng đang ở trạng thái thoải mái. Cùng nhau lên lịch hẹn hò vui vẻ nhé!';
    let isPeriodToday = false;
    let isPmsToday = false;

    if (normalizedDay <= periodDuration) {
        status = 'period';
        isPeriodToday = true;
        title = `Đang Trong Kỳ Dâu (Ngày ${normalizedDay}/${periodDuration}) 🍓`;
        advice = 'Nàng có thể bị đau bụng, mỏi lưng và mệt. Nhớ chuẩn bị túi chườm ấm, đồ ngọt và chiều chuộng nàng hết mực nhé!';
    } else if (daysUntilNext <= 3) {
        status = 'pms';
        isPmsToday = true;
        title = `Sắp Đến Kỳ (Còn ${daysUntilNext} ngày) ⚠️`;
        advice = 'Giai đoạn tiền kinh nguyệt (PMS). Nàng rất dễ nhạy cảm và xúc động, hãy chủ động nhường nhịn và lắng nghe nàng nhé!';
    }

    return {
        configured: true,
        lastPeriodDate: lastDate.toISOString().split('T')[0],
        nextPeriodDate: nextPeriodDate.toISOString().split('T')[0],
        cycleLength,
        periodDuration,
        currentCycleDay: normalizedDay,
        daysUntilNext,
        status,
        isPeriodToday,
        isPmsToday,
        title,
        advice,
    };
}

/**
 * GET /api/couple/period
 * Fetch current cycle data and calculated status.
 */
async function getPeriodData(req, res) {
    try {
        const pool = getPool();
        const coupleRoomId = req.user.coupleRoomId;

        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        const result = await pool.query(
            `SELECT last_period_date, cycle_length, period_duration, notes, updated_at
             FROM couple_period_settings
             WHERE couple_room_id = $1`,
            [coupleRoomId]
        );

        if (result.rows.length === 0) {
            return res.json({
                configured: false,
                message: 'Chưa thiết lập ngày chu kỳ',
            });
        }

        const row = result.rows[0];
        const statusData = calculatePeriodStatus(
            row.last_period_date,
            row.cycle_length,
            row.period_duration
        );

        return res.json({
            ...statusData,
            notes: row.notes || '',
            updatedAt: row.updated_at,
        });
    } catch (err) {
        logger.error('Error in getPeriodData:', err);
        return res.status(500).json({ error: 'Không lấy được thông tin chu kỳ' });
    }
}

/**
 * PUT /api/couple/period
 * Update period settings and broadcast to couple room.
 */
async function updatePeriodSettings(req, res) {
    try {
        const pool = getPool();
        const coupleRoomId = req.user.coupleRoomId;
        const userId = req.user.id;

        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        const { lastPeriodDate, cycleLength = 28, periodDuration = 5, notes } = req.body;

        if (!lastPeriodDate || isNaN(Date.parse(lastPeriodDate))) {
            return res.status(400).json({ error: 'Ngày bắt đầu chu kỳ không hợp lệ' });
        }

        const cLen = Math.min(Math.max(parseInt(cycleLength, 10) || 28, 20), 45);
        const pDur = Math.min(Math.max(parseInt(periodDuration, 10) || 5, 2), 10);

        const result = await pool.query(
            `INSERT INTO couple_period_settings (couple_room_id, last_period_date, cycle_length, period_duration, notes, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (couple_room_id)
             DO UPDATE SET
                last_period_date = EXCLUDED.last_period_date,
                cycle_length = EXCLUDED.cycle_length,
                period_duration = EXCLUDED.period_duration,
                notes = EXCLUDED.notes,
                updated_at = NOW()
             RETURNING last_period_date, cycle_length, period_duration, notes, updated_at`,
            [coupleRoomId, lastPeriodDate, cLen, pDur, notes || null]
        );

        const row = result.rows[0];
        const statusData = calculatePeriodStatus(
            row.last_period_date,
            row.cycle_length,
            row.period_duration
        );

        const payload = {
            ...statusData,
            notes: row.notes || '',
            updatedAt: row.updated_at,
            updatedBy: userId,
        };

        // Broadcast to couple room via WebSocket
        try {
            const io = getIO();
            if (io) {
                io.to(`room:${coupleRoomId}`).emit('period:updated', payload);
            }
        } catch (wsErr) {
            logger.warn('Socket broadcast failed for period:updated:', wsErr);
        }

        return res.json(payload);
    } catch (err) {
        logger.error('Error in updatePeriodSettings:', err);
        return res.status(500).json({ error: 'Không lưu được cài đặt chu kỳ' });
    }
}

/**
 * POST /api/couple/period/sos
 * Girlfriend sends SOS ("Em đau bụng / cần dỗ dành") to partner.
 */
async function sendPeriodSOS(req, res) {
    try {
        const pool = getPool();
        const coupleRoomId = req.user.coupleRoomId;
        const senderId = req.user.id;

        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        const { note = 'Em đau bụng và mệt quá, cần được ôm...', symptom = 'cramps' } = req.body;

        // Fetch partner details
        const partnerRes = await pool.query(
            `SELECT u.id, u.display_name, u.fcm_token
             FROM users u
             JOIN couple_rooms cr ON (cr.user_a_id = u.id OR cr.user_b_id = u.id)
             WHERE cr.id = $1 AND u.id != $2`,
            [coupleRoomId, senderId]
        );

        const partner = partnerRes.rows[0];
        const senderRes = await pool.query(`SELECT display_name FROM users WHERE id = $1`, [senderId]);
        const senderName = senderRes.rows[0]?.display_name || 'Bé cưng';

        const sosPayload = {
            senderId,
            senderName,
            symptom,
            note,
            sentAt: new Date().toISOString(),
        };

        // Realtime socket emit
        try {
            const io = getIO();
            if (io) {
                io.to(`room:${coupleRoomId}`).emit('period:sos', sosPayload);
            }
        } catch (wsErr) {
            logger.warn('Socket emit failed for period:sos:', wsErr);
        }

        // Push notification fallback
        if (partner && partner.fcm_token) {
            try {
                await sendNotificationToUser(partner.id, {
                    title: `🍓 ${senderName} cần bạn dỗ dành nè!`,
                    body: note,
                    data: {
                        type: 'period_sos',
                        symptom,
                    },
                });
            } catch (fcmErr) {
                logger.warn('FCM send failed for period SOS:', fcmErr);
            }
        }

        return res.json({ success: true, message: 'Đã gửi tín hiệu tới người ấy 💕' });
    } catch (err) {
        logger.error('Error in sendPeriodSOS:', err);
        return res.status(500).json({ error: 'Không gửi được tín hiệu SOS' });
    }
}

module.exports = {
    getPeriodData,
    updatePeriodSettings,
    sendPeriodSOS,
};
