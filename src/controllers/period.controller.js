const { getPool } = require('../config/database');
const logger = require('../config/logger');
const { getIO } = require('../socket/socket.handler');
const { sendPushNotification } = require('../config/firebase');

/**
 * Calculates current period status and medical 4-phase biorhythm predictions based on cycle data.
 * Medical standard:
 * 1. Menstrual Phase: Days 1 to periodDuration
 * 2. Follicular Phase: Days (periodDuration + 1) to (ovulationDay - 4)
 * 3. Ovulation Window: Days (ovulationDay - 3) to (ovulationDay + 1)
 * 4. Luteal Phase: After fertile window until end of cycle (last 4 days are PMS)
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

    // Cycles elapsed and next dates
    const cyclesElapsed = Math.floor(daysSinceLast / cycleLength);
    const nextPeriodDate = new Date(lastDate.getTime() + (cyclesElapsed + 1) * cycleLength * 86400000);

    // Ovulation is approximately 14 days before the next period starts
    const ovulationDay = Math.max(periodDuration + 2, cycleLength - 14);
    const fertileWindowStart = Math.max(periodDuration + 1, ovulationDay - 3);
    const fertileWindowEnd = Math.min(cycleLength - 3, ovulationDay + 1);

    // Current cycle's ovulation calendar date
    const currentCycleStart = new Date(lastDate.getTime() + cyclesElapsed * cycleLength * 86400000);
    const ovulationDate = new Date(currentCycleStart.getTime() + (ovulationDay - 1) * 86400000);

    // 4 Medical Phases Determination
    let phase = 'luteal';
    let phaseName = 'Pha Hoàng Thể';
    let phaseEmoji = '🌙';
    let status = 'normal';
    let fertility = 'low';
    let fertilityLabel = 'Thấp';
    let estrogenLevel = 'Trung bình';
    let progesteroneLevel = 'Cao';
    let energyScore = 65;
    let title = 'Pha Hoàng Thể (Thư Giãn & Ấm Áp) 🌙';
    let advice = 'Progesterone tăng giúp cơ thể nàng ấm áp, thích không gian yên tĩnh và bình an. Thích hợp cho buổi hẹn hò xem phim nhẹ nhàng tại gia!';
    let isPeriodToday = false;
    let isPmsToday = false;
    let isOvulationToday = false;

    if (normalizedDay <= periodDuration) {
        // 1. Menstrual Phase
        phase = 'menstrual';
        phaseName = 'Pha Hành Kinh';
        phaseEmoji = '🍓';
        status = 'period';
        fertility = 'very_low';
        fertilityLabel = 'Rất Thấp (An toàn)';
        estrogenLevel = 'Mức đáy';
        progesteroneLevel = 'Mức đáy';
        energyScore = 30;
        isPeriodToday = true;
        title = `Pha Hành Kinh (Ngày ${normalizedDay}/${periodDuration}) 🍓`;
        advice = 'Estrogen & Progesterone ở mức thấp nhất. Nàng dễ đau bụng dưới, chuột rút, đau lưng và mệt mỏi. Nhớ chuẩn bị túi chườm ấm 40°C, pha trà gừng ấm và bồi bổ chất sắt cho nàng nhé!';
    } else if (normalizedDay < fertileWindowStart) {
        // 2. Follicular Phase
        phase = 'follicular';
        phaseName = 'Pha Nang Trứng';
        phaseEmoji = '🌱';
        status = 'follicular';
        fertility = 'medium';
        fertilityLabel = 'Trung Bình (Chuẩn bị rụng trứng)';
        estrogenLevel = 'Tăng mạnh';
        progesteroneLevel = 'Thấp';
        energyScore = 85;
        title = `Pha Nang Trứng (Tái Tạo Năng Lượng) 🌱`;
        advice = 'Estrogen tăng mạnh giúp da dẻ nàng sáng mịn, tinh thần phấn chấn và tràn đầy sức sống. Đây là thời điểm lý tưởng nhất để hẹn hò, khám phá địa điểm mới hoặc tập thể dục cùng nhau!';
    } else if (normalizedDay >= fertileWindowStart && normalizedDay <= fertileWindowEnd) {
        // 3. Ovulation Window
        phase = 'ovulation';
        phaseName = 'Cửa Sổ Rụng Trứng';
        phaseEmoji = '🌟';
        status = 'ovulation';
        fertility = 'peak';
        fertilityLabel = 'ĐỈNH ĐIỂM (Rất Dễ Thụ Thai)';
        estrogenLevel = 'Cực đại (Peak)';
        progesteroneLevel = 'Bắt đầu tăng';
        energyScore = 95;
        isOvulationToday = normalizedDay === ovulationDay;
        title = isOvulationToday
            ? `Ngày Rụng Trứng Đỉnh Điểm 🌟`
            : `Cửa Sổ Rụng Trứng (Khả Năng Thụ Thai Cao) 🌟`;
        advice = 'Nàng đang ở đỉnh cao quyến rũ, nữ tính và muốn được gần gũi nhất chu kỳ. LƯU Ý Y KHOA: Khả năng thụ thai ở mức ĐỈNH ĐIỂM, hãy lưu ý biện pháp bảo vệ an toàn nếu chưa sẵn sàng đón em bé!';
    } else {
        // 4. Luteal Phase (with PMS in the last 4 days)
        if (daysUntilNext <= 4) {
            phase = 'luteal';
            phaseName = 'Pha Hoàng Thể (PMS)';
            phaseEmoji = '⚠️';
            status = 'pms';
            fertility = 'low';
            fertilityLabel = 'Thấp';
            estrogenLevel = 'Tụt dốc';
            progesteroneLevel = 'Tụt dốc';
            energyScore = 45;
            isPmsToday = true;
            title = `Giai Đoạn PMS (Còn ${daysUntilNext} ngày đến kỳ) ⚠️`;
            advice = 'Giai đoạn tiền kinh nguyệt (PMS): Hormone sụt giảm nhanh khiến nàng dễ nhạy cảm, cáu gắt vô cớ, mỏi mệt và thèm đồ ngọt. Hãy kiên nhẫn nhường nhịn, chuẩn bị trà sữa ấm và ôm dỗ nàng nhiều hơn!';
        } else {
            phase = 'luteal';
            phaseName = 'Pha Hoàng Thể';
            phaseEmoji = '🌙';
            status = 'normal';
            fertility = 'low';
            fertilityLabel = 'Thấp';
            estrogenLevel = 'Trung bình';
            progesteroneLevel = 'Đỉnh cao';
            energyScore = 65;
            title = `Pha Hoàng Thể (Thư Giãn & Ấm Áp) 🌙`;
            advice = 'Progesterone tăng giúp cơ thể nàng ấm áp, thích không gian yên tĩnh và bình an. Thích hợp cho buổi hẹn hò xem phim nhẹ nhàng tại gia!';
        }
    }

    return {
        configured: true,
        lastPeriodDate: lastDate.toISOString().split('T')[0],
        nextPeriodDate: nextPeriodDate.toISOString().split('T')[0],
        ovulationDate: ovulationDate.toISOString().split('T')[0],
        cycleLength,
        periodDuration,
        currentCycleDay: normalizedDay,
        daysUntilNext,
        ovulationDay,
        fertileWindowStart,
        fertileWindowEnd,
        phase,
        phaseName,
        phaseEmoji,
        fertility,
        fertilityLabel,
        estrogenLevel,
        progesteroneLevel,
        energyScore,
        status,
        isPeriodToday,
        isPmsToday,
        isOvulationToday,
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
        const coupleRoomId = req.coupleRoom?.id || req.user?.coupleRoomId;

        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        const result = await pool.query(
            `SELECT last_period_date, cycle_length, period_duration, notes, female_user_id, updated_at
             FROM couple_period_settings
             WHERE couple_room_id = $1`,
            [coupleRoomId]
        );

        const currentUserId = req.dbUser?.id || req.user?.id;

        if (result.rows.length === 0) {
            return res.json({
                configured: false,
                message: 'Chưa thiết lập ngày chu kỳ',
                femaleUserId: null,
                isCurrentUserFemale: null,
            });
        }

        const row = result.rows[0];
        const statusData = calculatePeriodStatus(
            row.last_period_date,
            row.cycle_length,
            row.period_duration
        );

        const femaleUserId = row.female_user_id;
        const isCurrentUserFemale = femaleUserId ? (femaleUserId === currentUserId) : null;

        return res.json({
            ...statusData,
            notes: row.notes || '',
            femaleUserId,
            isCurrentUserFemale,
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
        const coupleRoomId = req.coupleRoom?.id || req.user?.coupleRoomId;
        const userId = req.dbUser?.id || req.user?.id;

        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        const { lastPeriodDate, cycleLength = 28, periodDuration = 5, notes, asFemale } = req.body;

        if (!lastPeriodDate || isNaN(Date.parse(lastPeriodDate))) {
            return res.status(400).json({ error: 'Ngày bắt đầu chu kỳ không hợp lệ' });
        }

        const cLen = Math.min(Math.max(parseInt(cycleLength, 10) || 28, 20), 45);
        const pDur = Math.min(Math.max(parseInt(periodDuration, 10) || 5, 2), 10);
        const targetFemaleId = (asFemale === true || asFemale === 'true') ? userId : null;

        const result = await pool.query(
            `INSERT INTO couple_period_settings (couple_room_id, last_period_date, cycle_length, period_duration, notes, female_user_id, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (couple_room_id)
             DO UPDATE SET
                last_period_date = EXCLUDED.last_period_date,
                cycle_length = EXCLUDED.cycle_length,
                period_duration = EXCLUDED.period_duration,
                notes = EXCLUDED.notes,
                female_user_id = COALESCE(EXCLUDED.female_user_id, couple_period_settings.female_user_id),
                updated_at = NOW()
             RETURNING last_period_date, cycle_length, period_duration, notes, female_user_id, updated_at`,
            [coupleRoomId, lastPeriodDate, cLen, pDur, notes || null, targetFemaleId]
        );

        const row = result.rows[0];
        const statusData = calculatePeriodStatus(
            row.last_period_date,
            row.cycle_length,
            row.period_duration
        );

        const femaleUserId = row.female_user_id;
        const isCurrentUserFemale = femaleUserId ? (femaleUserId === userId) : true;

        const payload = {
            ...statusData,
            notes: row.notes || '',
            femaleUserId,
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
        const coupleRoomId = req.coupleRoom?.id || req.user?.coupleRoomId;
        const senderId = req.dbUser?.id || req.user?.id;

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
                await sendPushNotification({
                    token: partner.fcm_token,
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

/**
 * POST /api/couple/period/role
 * Set user role (female/male) and sync across couple devices.
 */
async function setPeriodRole(req, res) {
    try {
        const pool = getPool();
        const coupleRoomId = req.coupleRoom?.id || req.user?.coupleRoomId;
        const userId = req.dbUser?.id || req.user?.id;
        const { role } = req.body; // 'female' or 'male'

        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        let femaleUserId = null;
        if (role === 'female') {
            femaleUserId = userId;
        } else if (role === 'male') {
            const roomRes = await pool.query(
                `SELECT user_a_id, user_b_id FROM couple_rooms WHERE id = $1`,
                [coupleRoomId]
            );
            if (roomRes.rows.length) {
                const r = roomRes.rows[0];
                femaleUserId = (r.user_a_id === userId) ? r.user_b_id : r.user_a_id;
            }
        }

        if (femaleUserId) {
            await pool.query(
                `INSERT INTO couple_period_settings (couple_room_id, last_period_date, female_user_id, updated_at)
                 VALUES ($1, CURRENT_DATE, $2, NOW())
                 ON CONFLICT (couple_room_id)
                 DO UPDATE SET female_user_id = $2, updated_at = NOW()`,
                [coupleRoomId, femaleUserId]
            );

            try {
                const io = getIO();
                if (io) {
                    io.to(`room:${coupleRoomId}`).emit('period:role_synced', {
                        femaleUserId,
                    });
                }
            } catch (_) {}
        }

        return res.json({
            success: true,
            femaleUserId,
            isCurrentUserFemale: femaleUserId === userId,
        });
    } catch (err) {
        logger.error('Error in setPeriodRole:', err);
        return res.status(500).json({ error: 'Không lưu được vai trò' });
    }
}

module.exports = {
    getPeriodData,
    updatePeriodSettings,
    sendPeriodSOS,
    setPeriodRole,
};
