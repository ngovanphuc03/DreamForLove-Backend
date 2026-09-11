const { getPool } = require('../config/database');
const logger = require('../config/logger');
const { getIO } = require('../socket/socket.handler');
const { sendPushNotification } = require('../config/firebase');

let tablesEnsured = false;
async function ensurePeriodTables(pool) {
    if (tablesEnsured) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS couple_period_cycles (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                couple_room_id UUID NOT NULL REFERENCES couple_rooms(id) ON DELETE CASCADE,
                cycle_number INT NOT NULL DEFAULT 1,
                start_date DATE NOT NULL,
                end_date DATE,
                cycle_length INT,
                period_duration INT DEFAULT 5,
                is_predicted BOOLEAN DEFAULT false,
                notes TEXT,
                created_by UUID REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                CONSTRAINT uq_room_cycle_start UNIQUE (couple_room_id, start_date)
            );
            CREATE INDEX IF NOT EXISTS idx_couple_period_cycles_room ON couple_period_cycles(couple_room_id, start_date DESC);

            ALTER TABLE couple_period_daily_logs
                ADD COLUMN IF NOT EXISTS lh_test VARCHAR(20),
                ADD COLUMN IF NOT EXISTS intimacy VARCHAR(20),
                ADD COLUMN IF NOT EXISTS contraceptive VARCHAR(50);
        `);
        tablesEnsured = true;
    } catch (err) {
        logger.warn('[Period] ensurePeriodTables warning:', err.message);
    }
}

/**
 * Flo-Style Intelligent Biorhythm Analytics:
 * Computes adaptive moving averages (recency weighted), cycle variance (regularity),
 * outlier filtering, shortest/longest cycles, and database cycle-length persistence.
 */
async function computeCycleStats(pool, coupleRoomId, baseCycleLength = 28, basePeriodDuration = 5) {
    await ensurePeriodTables(pool);

    const res = await pool.query(
        `SELECT id, cycle_number, start_date::text as start_date, end_date::text as end_date,
                cycle_length, period_duration, is_predicted, notes, created_at
         FROM couple_period_cycles
         WHERE couple_room_id = $1
         ORDER BY start_date DESC
         LIMIT 24`,
        [coupleRoomId]
    );

    const cycles = res.rows;
    if (!cycles.length) {
        return {
            hasHistory: false,
            avgCycleLength: baseCycleLength,
            avgPeriodDuration: basePeriodDuration,
            regularity: 'regular',
            regularityLabel: 'Chưa có đủ chu kỳ để đo lường',
            shortestCycle: baseCycleLength,
            longestCycle: baseCycleLength,
            totalCyclesRecorded: 0,
            cycles: [],
        };
    }

    const validLengths = [];
    const validDurations = [];

    // Loop through cycles and calculate cycle lengths from consecutive start dates
    for (let i = 0; i < cycles.length; i++) {
        const c = cycles[i];
        let len = c.cycle_length;
        if (!len && i > 0) {
            const nextStart = new Date(cycles[i - 1].start_date);
            const thisStart = new Date(c.start_date);
            len = Math.round((nextStart - thisStart) / 86400000);
            if (len >= 18 && len <= 60) {
                c.cycle_length = len;
                // Asynchronously persist computed length into DB
                pool.query(
                    `UPDATE couple_period_cycles SET cycle_length = $1, updated_at = NOW() WHERE id = $2`,
                    [len, c.id]
                ).catch(err => logger.warn('[Period] Failed to persist cycle_length:', err.message));
            }
        }
        if (len && len >= 18 && len <= 60) {
            validLengths.push(len);
        }

        let dur = c.period_duration;
        if (c.end_date && c.start_date) {
            dur = Math.round((new Date(c.end_date) - new Date(c.start_date)) / 86400000) + 1;
            c.period_duration = dur;
        }
        if (dur && dur >= 2 && dur <= 14) {
            validDurations.push(dur);
        }
    }

    // Flo Adaptive Prediction: Filter extreme outliers (e.g. missed cycle > 50 days or < 20 days)
    const normalLengths = validLengths.filter(l => l >= 21 && l <= 45);
    const candidateLengths = normalLengths.length > 0 ? normalLengths : validLengths;

    let avgCycleLength = baseCycleLength;
    if (candidateLengths.length > 0) {
        if (candidateLengths.length === 1) {
            avgCycleLength = candidateLengths[0];
        } else if (candidateLengths.length === 2) {
            // Recency weights: 60% latest, 40% previous
            avgCycleLength = Math.round(candidateLengths[0] * 0.60 + candidateLengths[1] * 0.40);
        } else if (candidateLengths.length === 3) {
            // Recency weights: 50% latest, 30% second, 20% third
            avgCycleLength = Math.round(candidateLengths[0] * 0.50 + candidateLengths[1] * 0.30 + candidateLengths[2] * 0.20);
        } else {
            // 4+ cycles: Weighted moving average over last 4
            avgCycleLength = Math.round(
                candidateLengths[0] * 0.40 +
                candidateLengths[1] * 0.30 +
                candidateLengths[2] * 0.20 +
                candidateLengths[3] * 0.10
            );
        }
    }

    // Adaptive Duration Average
    let avgPeriodDuration = basePeriodDuration;
    if (validDurations.length > 0) {
        if (validDurations.length === 1) {
            avgPeriodDuration = validDurations[0];
        } else {
            const sum = validDurations.reduce((a, b) => a + b, 0);
            avgPeriodDuration = Math.round(sum / validDurations.length);
        }
    }

    // Regularity measurement (Standard deviation of non-outlier cycle lengths)
    let regularity = 'regular';
    let regularityLabel = 'Chu kỳ rất đều đặn ✅';
    if (candidateLengths.length >= 2) {
        const mean = candidateLengths.reduce((a, b) => a + b, 0) / candidateLengths.length;
        const variance = candidateLengths.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / candidateLengths.length;
        const stdDev = Math.sqrt(variance);

        if (stdDev <= 2.0) {
            regularity = 'regular';
            regularityLabel = `Chu kỳ cực đều (±${stdDev.toFixed(1)} ngày) ✅`;
        } else if (stdDev <= 4.5) {
            regularity = 'slightly_irregular';
            regularityLabel = `Chu kỳ tương đối đều (±${stdDev.toFixed(1)} ngày) ⚖️`;
        } else {
            regularity = 'irregular';
            regularityLabel = `Chu kỳ có biến động (±${stdDev.toFixed(1)} ngày) ⚠️`;
        }
    }

    const shortestCycle = candidateLengths.length ? Math.min(...candidateLengths) : baseCycleLength;
    const longestCycle = candidateLengths.length ? Math.max(...candidateLengths) : baseCycleLength;
    const finalAvgCycle = Math.min(Math.max(avgCycleLength, 20), 45);
    const finalAvgDuration = Math.min(Math.max(avgPeriodDuration, 2), 10);

    const medicalAssessment = evaluateFIGOHealth(finalAvgCycle, finalAvgDuration, regularity, cycles);

    return {
        hasHistory: validLengths.length > 0 || cycles.length > 0,
        avgCycleLength: finalAvgCycle,
        avgPeriodDuration: finalAvgDuration,
        regularity,
        regularityLabel,
        shortestCycle,
        longestCycle,
        totalCyclesRecorded: cycles.length,
        cycles,
        medicalAssessment,
    };
}

/**
 * Clinical assessment according to FIGO (2018) & ACOG Menstrual Disorders Guidelines.
 */
function evaluateFIGOHealth(avgCycleLength, avgPeriodDuration, regularity, cycles = []) {
    const riskFlags = [];
    let status = 'healthy';
    let title = 'Sức khỏe kinh nguyệt bình thường (Chuẩn FIGO 2018) ✅';
    let details = 'Các chỉ số chu kỳ và thời gian hành kinh của bạn hoàn toàn nằm trong ngưỡng sinh lý bình thường theo tiêu chuẩn của Liên đoàn Phụ Sản Quốc tế (FIGO).';
    const recommendations = [];

    // 1. Cycle length assessment (FIGO Normal: 24-38 days)
    if (avgCycleLength < 24) {
        riskFlags.push({
            type: 'polymenorrhea',
            severity: 'warning',
            label: 'Chu kỳ ngắn (< 24 ngày)',
            description: 'Chu kỳ dưới 24 ngày có thể là dấu hiệu của suy hoàng thể sớm hoặc không rụng trứng (Anovulation).',
            advice: 'Nên thăm khám phụ khoa nếu tình trạng này kéo dài trên 3 chu kỳ liên tiếp.'
        });
        status = 'needs_attention';
        title = 'Chu kỳ kinh ngắn hơn mức bình thường ⚠️';
    } else if (avgCycleLength > 38) {
        riskFlags.push({
            type: 'oligomenorrhea',
            severity: 'warning',
            label: 'Chu kỳ dài (> 38 ngày)',
            description: 'Chu kỳ thưa trên 38 ngày thường liên quan đến Hội chứng Buồng trứng Đa nang (PCOS), stress kéo dài hoặc rối loạn tuyến giáp.',
            advice: 'Khuyên bạn nữ nên siêu âm đầu dò phụ khoa và kiểm tra bộ hormone nội tiết (FSH, LH, AMH).'
        });
        status = 'needs_attention';
        title = 'Chu kỳ kinh thưa / Kéo dài (> 38 ngày) ⚠️';
    }

    // 2. Period flow duration assessment (FIGO Normal: 3-8 days)
    if (avgPeriodDuration > 8) {
        riskFlags.push({
            type: 'menorrhagia',
            severity: 'alert',
            label: 'Dấu hiệu rong kinh (> 8 ngày)',
            description: 'Thời gian ra máu kéo dài trên 8 ngày có nguy cơ dẫn đến thiếu máu thiếu sắt, u xơ tử cung hoặc polyp nội mạc tử cung.',
            advice: 'Cần bổ sung viên sắt, vitamin B12 và gặp bác sĩ chuyên khoa phụ sản để nội soi kiểm tra.'
        });
        status = 'alert';
        title = 'Cảnh báo nguy cơ Rong kinh (> 8 ngày) 🚨';
    } else if (avgPeriodDuration <= 2 && cycles.length >= 2) {
        riskFlags.push({
            type: 'hypomenorrhea',
            severity: 'info',
            label: 'Thời gian ra kinh ngắn (≤ 2 ngày)',
            description: 'Lượng kinh ít có thể do niêm mạc tử cung mỏng, tác dụng phụ của thuốc tránh thai hoặc dinh dưỡng thiếu chất.',
            advice: 'Giữ ấm bụng, ăn uống đủ chất và theo dõi thêm.'
        });
    }

    // 3. Regularity assessment
    if (regularity === 'irregular') {
        riskFlags.push({
            type: 'irregular_variation',
            severity: 'warning',
            label: 'Chu kỳ biến thiên không đều',
            description: 'Độ dài các chu kỳ chênh lệch quá nhiều khiến việc dự đoán rụng trứng theo lịch tự nhiên có thể không chính xác.',
            advice: 'Khuyên bạn nên kết hợp dùng Que thử rụng trứng LH và đo thân nhiệt BBT để xác định ngày rụng trứng chuẩn xác nhất!'
        });
    }

    if (riskFlags.length === 0) {
        recommendations.push('Duy trì chế độ ăn giàu rau xanh, uống đủ 2 lít nước ấm mỗi ngày.');
        recommendations.push('Tập thể dục nhẹ nhàng (yoga, đi bộ) giúp giảm căng thẳng và điều hòa kinh nguyệt.');
        recommendations.push('Khám phụ khoa định kỳ 6 tháng - 1 năm/lần.');
    }

    return {
        status,
        title,
        details,
        normalCycleRange: '24 - 38 ngày (FIGO 2018)',
        normalFlowRange: '3 - 8 ngày',
        riskFlags,
        recommendations,
        disclaimer: 'Hồ sơ đánh giá y khoa FIGO dựa trên dữ liệu nhật ký thực tế của bạn, mang tính tham khảo và sàng lọc sức khỏe, không thay thế chẩn đoán y tế trực tiếp của bác sĩ chuyên khoa.',
    };
}

/**
 * Calculates current period status and medical 4-phase biorhythm predictions based on cycle data.
 * Medical standard (Flo / ACOG / WHO standard):
 * 1. Menstrual Phase: Days 1 to periodDuration
 * 2. Follicular Phase: Days (periodDuration + 1) to (ovulationDay - 5)
 * 3. Ovulation Window: Days (ovulationDay - 5) to (ovulationDay + 1) (Sperm 5-day survival window)
 * 4. Luteal Phase: After fertile window until end of cycle (last 4 days are PMS).
 *    Luteal phase is physiologically constant (~14 days).
 */
function formatDateYMD(d) {
    if (!d) return null;
    const dateObj = typeof d === 'string' ? new Date(d) : d;
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Calculates current period status and medical 4-phase biorhythm predictions based on cycle data.
 * Medical standard (Flo / ACOG / WHO standard):
 * 1. Menstrual Phase: Days 1 to periodDuration
 * 2. Follicular Phase: Days (periodDuration + 1) to (ovulationDay - 5)
 * 3. Ovulation Window: Days (ovulationDay - 5) to (ovulationDay + 1) (Sperm 5-day survival window)
 * 4. Luteal Phase: After fertile window until end of cycle (last 4 days are PMS).
 *    Luteal phase is physiologically constant (~14 days).
 */
function calculatePeriodStatus(lastPeriodDateStr, cycleLength = 28, periodDuration = 5) {
    const rawDatePart = String(lastPeriodDateStr).split('T')[0];
    const [y, m, d] = rawDatePart.split('-').map(Number);
    const lastDate = new Date(y, m - 1, d, 0, 0, 0, 0);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

    const diffMs = today.getTime() - lastDate.getTime();
    const daysSinceLast = Math.round(diffMs / (1000 * 60 * 60 * 24));
    const lastPeriodDateFormatted = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    // Handle future date edge-case
    if (daysSinceLast < 0) {
        return {
            configured: true,
            lastPeriodDate: lastPeriodDateFormatted,
            nextPeriodDate: lastPeriodDateFormatted,
            ovulationDate: null,
            cycleLength,
            periodDuration,
            currentCycleDay: 1,
            daysUntilNext: cycleLength,
            ovulationDay: Math.max(periodDuration + 2, cycleLength - 14),
            fertileWindowStart: Math.max(periodDuration + 1, cycleLength - 19),
            fertileWindowEnd: Math.min(cycleLength - 1, cycleLength - 13),
            phase: 'menstrual',
            phaseName: 'Pha Hành Kinh',
            phaseEmoji: '🍓',
            fertility: 'very_low',
            fertilityLabel: 'Rất Thấp (< 1%)',
            fertilityChancePercent: 1,
            estrogenLevel: 'Mức đáy',
            progesteroneLevel: 'Mức đáy',
            energyScore: 30,
            status: 'period',
            isPeriodToday: true,
            isPmsToday: false,
            isOvulationToday: false,
            title: 'Kỳ Kinh Mới 🍓',
            advice: 'Nàng vừa cập nhật ngày bắt đầu kỳ mới. Hãy giữ ấm bụng và nghỉ ngơi nhé 💕',
        };
    }

    // Physiological constant: Luteal phase is 14 days
    const ovulationDay = Math.max(periodDuration + 2, cycleLength - 14);
    const fertileWindowStart = Math.max(periodDuration + 1, ovulationDay - 5);
    const fertileWindowEnd = Math.min(cycleLength - 1, ovulationDay + 1);

    const baseNextPeriodDate = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate() + cycleLength);
    const baseOvulationDate = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate() + (ovulationDay - 1));

    const nextPeriodDateStr = formatDateYMD(baseNextPeriodDate);
    const ovulationDateStr = formatDateYMD(baseOvulationDate);

    // CHECK FOR LATE PERIOD: If daysSinceLast >= cycleLength, the period is expected today or overdue!
    if (daysSinceLast >= cycleLength) {
        const daysLate = daysSinceLast - cycleLength;
        const normalizedDay = daysSinceLast + 1;
        return {
            configured: true,
            lastPeriodDate: lastPeriodDateFormatted,
            nextPeriodDate: nextPeriodDateStr,
            ovulationDate: ovulationDateStr,
            cycleLength,
            periodDuration,
            currentCycleDay: normalizedDay,
            daysUntilNext: 0,
            ovulationDay,
            fertileWindowStart,
            fertileWindowEnd,
            phase: 'late',
            phaseName: daysLate === 0 ? 'Dự Kiến Đến Kỳ' : 'Chậm Kinh',
            phaseEmoji: '⚠️',
            fertility: 'low',
            fertilityLabel: 'Thấp (Biến động)',
            fertilityChancePercent: 4,
            estrogenLevel: 'Biến động',
            progesteroneLevel: 'Biến động',
            energyScore: 50,
            status: 'late',
            isPeriodToday: false,
            isPmsToday: false,
            isOvulationToday: false,
            daysLate,
            title: daysLate === 0
                ? 'Dự Kiến Có Kinh Hôm Nay 🍓'
                : `Chậm Kinh ${daysLate} Ngày ⚠️`,
            advice: daysLate === 0
                ? 'Hôm nay là ngày dự kiến bắt đầu kỳ dâu mới. Nàng hãy giữ ấm bụng, uống nước ấm và chuẩn bị đồ ấm nhé 💕'
                : `Kỳ dâu đã quá dự kiến ${daysLate} ngày. Nàng hãy nghỉ ngơi nhiều hơn, giữ tinh thần thư giãn, tránh thức khuya và dùng que kiểm tra nếu hai bạn có sinh hoạt thân mật trước đó nhé 💕`,
        };
    }

    const normalizedDay = daysSinceLast + 1;
    const daysUntilNext = cycleLength - normalizedDay + 1;
    const nextPeriodDate = baseNextPeriodDate;
    const ovulationDate = baseOvulationDate;

    let phase = 'luteal';
    let phaseName = 'Pha Hoàng Thể';
    let phaseEmoji = '🌙';
    let status = 'normal';
    let fertility = 'low';
    let fertilityLabel = 'Thấp (Vùng an toàn)';
    let fertilityChancePercent = 3;
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
        fertilityLabel = 'Rất Thấp (< 1% xác suất)';
        fertilityChancePercent = 1;
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
        fertility = 'low';
        fertilityLabel = 'Thấp (~4% xác suất)';
        fertilityChancePercent = 4;
        estrogenLevel = 'Tăng mạnh';
        progesteroneLevel = 'Thấp';
        energyScore = 85;
        title = `Pha Nang Trứng (Tái Tạo Năng Lượng) 🌱`;
        advice = 'Estrogen tăng mạnh giúp da dẻ nàng sáng mịn, tinh thần phấn chấn và tràn đầy sức sống. Đây là thời điểm lý tưởng nhất để hẹn hò, khám phá địa điểm mới hoặc tập thể dục cùng nhau!';
    } else if (normalizedDay >= fertileWindowStart && normalizedDay <= fertileWindowEnd) {
        // 3. Ovulation Window - Flo Clinical standard tiers
        phase = 'ovulation';
        phaseName = 'Cửa Sổ Rụng Trứng';
        phaseEmoji = '🌟';
        status = 'ovulation';
        isOvulationToday = (normalizedDay === ovulationDay);

        if (isOvulationToday) {
            fertility = 'peak';
            fertilityLabel = 'ĐỈNH ĐIỂM ⭐ (Xác suất ~30%)';
            fertilityChancePercent = 30;
            title = 'Ngày Rụng Trứng Đỉnh Điểm 🌟';
        } else if (normalizedDay === ovulationDay - 1) {
            fertility = 'peak';
            fertilityLabel = 'RẤT CAO ⭐ (Xác suất ~28%)';
            fertilityChancePercent = 28;
            title = 'Khả Năng Thụ Thai Rất Cao 🌟';
        } else if (normalizedDay >= ovulationDay - 3 && normalizedDay <= ovulationDay - 2) {
            fertility = 'high';
            fertilityLabel = 'CAO (Xác suất ~20-25%)';
            fertilityChancePercent = 22;
            title = 'Cửa Sổ Thụ Thai Cao 🌟';
        } else {
            fertility = 'medium';
            fertilityLabel = 'TRUNG BÌNH (Xác suất ~10-15%)';
            fertilityChancePercent = 12;
            title = 'Cửa Sổ Rụng Trứng 🌟';
        }

        estrogenLevel = 'Cực đại (Peak)';
        progesteroneLevel = 'Bắt đầu tăng';
        energyScore = 95;
        advice = 'Nàng đang ở đỉnh cao quyến rũ, nữ tính và muốn được gần gũi nhất chu kỳ. LƯU Ý Y KHOA: Khả năng thụ thai ở mức ĐỈNH ĐIỂM, hãy lưu ý biện pháp bảo vệ an toàn nếu chưa sẵn sàng đón em bé!';
    } else {
        // 4. Luteal Phase (with PMS in the last 4 days)
        if (daysUntilNext <= 4) {
            phase = 'luteal';
            phaseName = 'Pha Hoàng Thể (PMS)';
            phaseEmoji = '⚠️';
            status = 'pms';
            fertility = 'very_low';
            fertilityLabel = 'Rất Thấp (< 1% an toàn)';
            fertilityChancePercent = 1;
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
            fertilityLabel = 'Thấp (Vùng an toàn)';
            fertilityChancePercent = 3;
            estrogenLevel = 'Trung bình';
            progesteroneLevel = 'Đỉnh cao';
            energyScore = 65;
            title = `Pha Hoàng Thể (Thư Giãn & Ấm Áp) 🌙`;
            advice = 'Progesterone tăng giúp cơ thể nàng ấm áp, thích không gian yên tĩnh và bình an. Thích hợp cho buổi hẹn hò xem phim nhẹ nhàng tại gia!';
        }
    }

    return {
        configured: true,
        lastPeriodDate: lastPeriodDateFormatted,
        nextPeriodDate: nextPeriodDateStr,
        ovulationDate: ovulationDateStr,
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
        fertilityChancePercent,
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

        // Auto-resolve femaleUserId if not yet set in settings
        let femaleUserId = result.rows[0]?.female_user_id || null;
        if (!femaleUserId) {
            const femaleUserRes = await pool.query(
                `SELECT u.id FROM users u
                 JOIN couple_rooms cr ON (u.id = cr.user_a_id OR u.id = cr.user_b_id)
                 WHERE cr.id = $1 AND u.gender = 'female'
                 LIMIT 1`,
                [coupleRoomId]
            );
            if (femaleUserRes.rows.length > 0) {
                femaleUserId = femaleUserRes.rows[0].id;
                await pool.query(
                    `INSERT INTO couple_period_settings (couple_room_id, female_user_id, updated_at)
                     VALUES ($1, $2, NOW())
                     ON CONFLICT (couple_room_id)
                     DO UPDATE SET female_user_id = $2, updated_at = NOW()`,
                    [coupleRoomId, femaleUserId]
                );
            }
        }

        // Determine isCurrentUserFemale based on femaleUserId or user's declared gender
        let isCurrentUserFemale = null;
        if (femaleUserId) {
            isCurrentUserFemale = (femaleUserId === currentUserId);
        } else {
            const userGenderRes = await pool.query('SELECT gender FROM users WHERE id = $1', [currentUserId]);
            if (userGenderRes.rows.length && userGenderRes.rows[0].gender) {
                isCurrentUserFemale = (userGenderRes.rows[0].gender === 'female');
            }
        }

        if (result.rows.length === 0 || !result.rows[0].last_period_date) {
            const stats = await computeCycleStats(pool, coupleRoomId, 28, 5);
            return res.json({
                configured: false,
                message: 'Chưa thiết lập ngày chu kỳ',
                femaleUserId,
                isCurrentUserFemale,
                cycleStats: stats,
            });
        }

        const row = result.rows[0];
        const cycleStats = await computeCycleStats(pool, coupleRoomId, row.cycle_length, row.period_duration);
        const effectiveCycleLength = cycleStats.hasHistory ? cycleStats.avgCycleLength : row.cycle_length;
        const effectiveDuration = cycleStats.hasHistory ? cycleStats.avgPeriodDuration : row.period_duration;

        const statusData = calculatePeriodStatus(
            row.last_period_date,
            effectiveCycleLength,
            effectiveDuration
        );

        // Clinical Biomarker Fusion (ACOG/FIGO/Flo Standard):
        // Query recent biomarker logs (last 30 days) to detect thermal shift, LH surge, intimacy risks
        const recentLogsRes = await pool.query(
            `SELECT log_date::text as log_date, flow_level, pain_level, cervical_mucus, temperature, lh_test, intimacy, contraceptive
             FROM couple_period_daily_logs
             WHERE couple_room_id = $1 AND log_date >= (CURRENT_DATE - INTERVAL '30 days')
             ORDER BY log_date DESC`,
            [coupleRoomId]
        );
        const recentLogs = recentLogsRes.rows;

        // 1. Emergency Contraceptive 72h Golden Window Check
        let emergencyAlert = null;
        let emergencyPillNotice = null;
        const now = new Date();
        for (const l of recentLogs) {
            if (l.contraceptive === 'emergency_pill_72h') {
                emergencyPillNotice = 'Lưu ý y khoa: Bạn đã dùng viên tránh thai khẩn cấp trong chu kỳ này. Thuốc chứa Progestin liều cao có thể gây hiện tượng chảy máu ngắt quãng hoặc khiến kỳ dâu tiếp theo đến sớm/muộn 3-7 ngày.';
            }

            if (l.intimacy === 'unprotected' && l.contraceptive !== 'emergency_pill_72h' && !emergencyAlert) {
                const logD = new Date(l.log_date);
                const diffHours = (now.getTime() - logD.getTime()) / (1000 * 60 * 60);
                if (diffHours >= 0 && diffHours <= 72) {
                    const hoursLeft = Math.max(1, Math.round(72 - diffHours));
                    emergencyAlert = {
                        active: true,
                        intimacyDate: l.log_date,
                        hoursLeft,
                        level: 'urgent',
                        title: `Cảnh Báo Khẩn Cấp: Còn ${hoursLeft}h Khung Giờ Vàng! ⚠️`,
                        message: `Hai bạn đã ghi nhận quan hệ không bảo vệ ngày ${l.log_date} trong cửa sổ thụ thai. Nếu chưa có kế hoạch sinh con, hãy cân nhắc sử dụng viên tránh thai khẩn cấp (Levonorgestrel) trước mốc 72 giờ nhé! 💕`,
                    };
                }
            }
        }

        // 2. BBT Biphasic Thermal Shift Analysis (Flo Standard)
        // Detects if Basal Body Temperature rose by >= 0.2°C sustained for 3+ consecutive days
        let bbtShiftDetected = false;
        let bbtOvulationDate = null;
        const tempLogs = recentLogs
            .filter(l => l.temperature && l.temperature >= 35.8 && l.temperature <= 38.5)
            .sort((a, b) => new Date(a.log_date) - new Date(b.log_date));

        if (tempLogs.length >= 6) {
            // Compute rolling baseline of lower temperatures
            for (let i = 5; i < tempLogs.length; i++) {
                const baseline = tempLogs.slice(i - 5, i).reduce((sum, item) => sum + item.temperature, 0) / 5;
                const nextThree = tempLogs.slice(i, i + 3);
                if (nextThree.length === 3 && nextThree.every(item => item.temperature >= baseline + 0.18)) {
                    bbtShiftDetected = true;
                    bbtOvulationDate = tempLogs[i - 1]?.log_date || tempLogs[i].log_date;
                    break;
                }
            }
        }

        // 3. Biomarker Fusion: Realtime Ovulation & Fertility Override
        let fusedStatus = { ...statusData };
        let biomarkerNote = null;
        let ovulationConfirmedByBiomarker = false;

        // Check LH surge in last 48 hours
        const recentLH = recentLogs.find(l => {
            const diffDays = Math.round((now.getTime() - new Date(l.log_date).getTime()) / 86400000);
            return (l.lh_test === 'positive' || l.lh_test === 'peak') && diffDays >= 0 && diffDays <= 2;
        });

        if (recentLH) {
            fusedStatus.phase = 'ovulation';
            fusedStatus.phaseName = 'Cửa Sổ Rụng Trứng (Que LH Xác Nhận)';
            fusedStatus.phaseEmoji = '⭐';
            fusedStatus.fertility = 'peak';
            fusedStatus.fertilityLabel = 'ĐỈNH ĐIỂM ⭐ (Que LH Dương Tính)';
            fusedStatus.fertilityChancePercent = 32;
            fusedStatus.isOvulationToday = true;
            ovulationConfirmedByBiomarker = true;
            biomarkerNote = `Que thử rụng trứng LH ngày ${recentLH.log_date} đạt đỉnh surge. Trứng đang phóng noãn trong 24-36h tới!`;
        } else if (bbtShiftDetected) {
            ovulationConfirmedByBiomarker = true;
            biomarkerNote = `Biến thiên thân nhiệt BBT xác nhận rụng trứng đã diễn ra quanh ngày ${bbtOvulationDate}! Progesterone đang ở mức cao giúp giữ ấm cơ thể.`;
        } else {
            // Check today's cervical mucus
            const todayStr = formatDateYMD(now);
            const todayLog = recentLogs.find(l => l.log_date === todayStr);
            if (todayLog?.cervical_mucus === 'eggwhite') {
                fusedStatus.fertility = 'peak';
                fusedStatus.fertilityLabel = 'ĐỈNH ĐIỂM ⭐ (Dịch nhầy màu mỡ)';
                fusedStatus.fertilityChancePercent = 30;
                biomarkerNote = 'Dịch nhầy cổ tử cung dạng lòng trắng trứng trơn và co giãn cho thấy Estrogen đạt đỉnh, khả năng thụ thai tối đa!';
            }
        }

        // 4. Delayed Period & Pregnancy Risk Alert (Flo Clinical Standard)
        let pregnancyRiskAlert = null;
        if (statusData.status === 'late' && statusData.daysLate >= 3) {
            // Check if there was unprotected sex in the fertile window
            const hadUnprotectedInCycle = recentLogs.some(l => l.intimacy === 'unprotected' && l.contraceptive !== 'emergency_pill_72h');
            if (hadUnprotectedInCycle) {
                pregnancyRiskAlert = {
                    active: true,
                    daysLate: statusData.daysLate,
                    level: 'attention',
                    title: 'Khuyến Nghị Thử Que Thai (HCG) 🩺',
                    message: `Kỳ kinh đang chậm ${statusData.daysLate} ngày và bạn từng ghi nhận sinh hoạt thân mật không bảo vệ trong chu kỳ này. Bạn nên dùng que thử thai buổi sáng (nước tiểu đầu tiên) để có kết quả chính xác và an tâm nhất nhé 💕`,
                };
            }
        }

        return res.json({
            ...fusedStatus,
            cycleStats,
            emergencyAlert,
            emergencyPillNotice,
            pregnancyRiskAlert,
            bbtShiftDetected,
            biomarkerNote,
            ovulationConfirmedByBiomarker,
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

        // Security check: Only the female user can update period settings
        const currentSetting = await pool.query(
            `SELECT female_user_id FROM couple_period_settings WHERE couple_room_id = $1`,
            [coupleRoomId]
        );
        let assignedFemaleId = currentSetting.rows[0]?.female_user_id;
        if (!assignedFemaleId) {
            const userRes = await pool.query('SELECT gender FROM users WHERE id = $1', [userId]);
            if (userRes.rows[0]?.gender === 'female') {
                assignedFemaleId = userId;
            } else if (userRes.rows[0]?.gender === 'male') {
                return res.status(403).json({ error: 'Chỉ bạn nữ mới có quyền cài đặt chu kỳ' });
            }
        } else if (assignedFemaleId !== userId) {
            return res.status(403).json({ error: 'Chỉ bạn nữ mới có quyền cập nhật chu kỳ' });
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
                `INSERT INTO couple_period_settings (couple_room_id, female_user_id, updated_at)
                 VALUES ($1, $2, NOW())
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

/**
 * GET /api/couple/period/logs?month=2026-09
 * Fetch daily symptom logs for a specific month or range.
 */
async function getDailyLogs(req, res) {
    try {
        const pool = getPool();
        const coupleRoomId = req.coupleRoom?.id || req.user?.coupleRoomId;
        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        const { month, startDate, endDate } = req.query;
        let query = `
            SELECT id, log_date::text as log_date, flow_level, pain_level, moods, symptoms,
                   cervical_mucus, temperature, lh_test, intimacy, contraceptive, notes, created_by, updated_at
            FROM couple_period_daily_logs
            WHERE couple_room_id = $1
        `;
        const params = [coupleRoomId];

        if (month && /^\d{4}-\d{2}$/.test(month)) {
            params.push(`${month}-01`);
            query += ` AND log_date >= $2 AND log_date < ($2::date + INTERVAL '1 month')`;
        } else if (startDate && endDate) {
            params.push(startDate, endDate);
            query += ` AND log_date >= $2 AND log_date <= $3`;
        } else {
            query += ` AND log_date >= CURRENT_DATE - INTERVAL '60 days' AND log_date <= CURRENT_DATE + INTERVAL '30 days'`;
        }

        query += ` ORDER BY log_date ASC`;

        const result = await pool.query(query, params);
        return res.json({
            success: true,
            logs: result.rows,
        });
    } catch (err) {
        logger.error('Error in getDailyLogs:', err);
        return res.status(500).json({ error: 'Không lấy được nhật ký triệu chứng' });
    }
}

/**
 * POST /api/couple/period/log
 * Upsert daily symptom log for a date.
 */
async function upsertDailyLog(req, res) {
    try {
        const pool = getPool();
        const coupleRoomId = req.coupleRoom?.id || req.user?.coupleRoomId;
        const userId = req.dbUser?.id || req.user?.id;
        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        const {
            logDate,
            flowLevel = 0,
            painLevel = 0,
            moods = [],
            symptoms = [],
            cervicalMucus = null,
            temperature = null,
            lhTest = null,
            intimacy = null,
            contraceptive = null,
            notes = '',
        } = req.body;

        if (!logDate || isNaN(Date.parse(logDate))) {
            return res.status(400).json({ error: 'Ngày ghi nhận không hợp lệ' });
        }

        const parsedDate = new Date(logDate).toISOString().split('T')[0];
        const flow = Math.min(Math.max(parseInt(flowLevel, 10) || 0, 0), 4);
        const pain = Math.min(Math.max(parseInt(painLevel, 10) || 0, 0), 4);
        const temp = temperature ? parseFloat(temperature) : null;

        await ensurePeriodTables(pool);

        const result = await pool.query(
            `INSERT INTO couple_period_daily_logs
             (couple_room_id, log_date, flow_level, pain_level, moods, symptoms, cervical_mucus, temperature, lh_test, intimacy, contraceptive, notes, created_by, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, NOW())
             ON CONFLICT (couple_room_id, log_date)
             DO UPDATE SET
                flow_level = EXCLUDED.flow_level,
                pain_level = EXCLUDED.pain_level,
                moods = EXCLUDED.moods,
                symptoms = EXCLUDED.symptoms,
                cervical_mucus = EXCLUDED.cervical_mucus,
                temperature = EXCLUDED.temperature,
                lh_test = EXCLUDED.lh_test,
                intimacy = EXCLUDED.intimacy,
                contraceptive = EXCLUDED.contraceptive,
                notes = EXCLUDED.notes,
                created_by = EXCLUDED.created_by,
                updated_at = NOW()
             RETURNING id, log_date::text as log_date, flow_level, pain_level, moods, symptoms, cervical_mucus, temperature, lh_test, intimacy, contraceptive, notes, updated_at`,
            [
                coupleRoomId,
                parsedDate,
                flow,
                pain,
                JSON.stringify(Array.isArray(moods) ? moods : []),
                JSON.stringify(Array.isArray(symptoms) ? symptoms : []),
                cervicalMucus || null,
                temp,
                lhTest || null,
                intimacy || null,
                contraceptive || null,
                notes || '',
                userId,
            ]
        );

        const savedLog = result.rows[0];

        // Intelligent Flo-style auto-sync: When bleeding (flow_level > 0) is logged, link to cycle history
        if (flow > 0) {
            try {
                await ensurePeriodTables(pool);
                // Check if there is already an active cycle starting within 10 days before this date
                const nearCycle = await pool.query(
                    `SELECT id, start_date::text as start_date, end_date::text as end_date, period_duration
                     FROM couple_period_cycles
                     WHERE couple_room_id = $1
                       AND start_date <= $2 AND start_date >= ($2::date - INTERVAL '10 days')
                     ORDER BY start_date DESC LIMIT 1`,
                    [coupleRoomId, parsedDate]
                );

                if (nearCycle.rows.length > 0) {
                    // Update end_date and recalculate duration
                    const existingCycle = nearCycle.rows[0];
                    const currentEnd = existingCycle.end_date;
                    const newEnd = (!currentEnd || parsedDate > currentEnd) ? parsedDate : currentEnd;
                    const startDateObj = new Date(existingCycle.start_date);
                    const endDateObj = new Date(newEnd);
                    const calculatedDuration = Math.max(Math.round((endDateObj - startDateObj) / 86400000) + 1, 1);
                    const finalDuration = Math.max(existingCycle.period_duration || 5, calculatedDuration);

                    await pool.query(
                        `UPDATE couple_period_cycles
                         SET end_date = $1, period_duration = $2, updated_at = NOW()
                         WHERE id = $3`,
                        [newEnd, finalDuration, existingCycle.id]
                    );
                } else {
                    // Check if this is a brand new cycle (no cycle within 14 days)
                    const recentCycle = await pool.query(
                        `SELECT id FROM couple_period_cycles
                         WHERE couple_room_id = $1 AND start_date >= ($2::date - INTERVAL '14 days')
                         LIMIT 1`,
                        [coupleRoomId, parsedDate]
                    );

                    if (!recentCycle.rows.length) {
                        await pool.query(
                            `INSERT INTO couple_period_cycles (couple_room_id, start_date, end_date, period_duration, created_by, updated_at)
                             VALUES ($1, $2, $2, 1, $3, NOW())
                             ON CONFLICT (couple_room_id, start_date) DO NOTHING`,
                            [coupleRoomId, parsedDate, userId]
                        );

                        await pool.query(
                            `UPDATE couple_period_settings
                             SET last_period_date = $2, updated_at = NOW()
                             WHERE couple_room_id = $1 AND (last_period_date IS NULL OR last_period_date < $2)`,
                            [coupleRoomId, parsedDate]
                        );

                        // Auto-calculate previous cycle length if exists
                        const prevCycle = await pool.query(
                            `SELECT id, start_date::text as start_date FROM couple_period_cycles
                             WHERE couple_room_id = $1 AND start_date < $2
                             ORDER BY start_date DESC LIMIT 1`,
                            [coupleRoomId, parsedDate]
                        );
                        if (prevCycle.rows.length > 0) {
                            const prevLen = Math.round((new Date(parsedDate) - new Date(prevCycle.rows[0].start_date)) / 86400000);
                            if (prevLen >= 18 && prevLen <= 60) {
                                await pool.query(
                                    `UPDATE couple_period_cycles SET cycle_length = $1, updated_at = NOW() WHERE id = $2`,
                                    [prevLen, prevCycle.rows[0].id]
                                );
                            }
                        }

                        // Broadcast cycle update
                        try {
                            const io = getIO();
                            if (io) {
                                io.to(`room:${coupleRoomId}`).emit('period:cycles_updated', {
                                    action: 'added',
                                    date: parsedDate,
                                });
                            }
                        } catch (_) {}
                    }
                }
            } catch (cycleSyncErr) {
                logger.warn('[Period] Auto-sync cycle on bleeding log warning:', cycleSyncErr.message);
            }
        }

        // Realtime broadcast to partner
        try {
            const io = getIO();
            if (io) {
                io.to(`room:${coupleRoomId}`).emit('period:log_updated', savedLog);
            }
        } catch (wsErr) {
            logger.warn('Socket broadcast failed for period:log_updated:', wsErr);
        }

        return res.json({
            success: true,
            log: savedLog,
        });
    } catch (err) {
        logger.error('Error in upsertDailyLog:', err);
        return res.status(500).json({ error: 'Không lưu được nhật ký triệu chứng' });
    }
}

/**
 * DELETE /api/couple/period/log/:date
 */
async function deleteDailyLog(req, res) {
    try {
        const pool = getPool();
        const coupleRoomId = req.coupleRoom?.id || req.user?.coupleRoomId;
        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        const { date } = req.params;
        if (!date || isNaN(Date.parse(date))) {
            return res.status(400).json({ error: 'Ngày không hợp lệ' });
        }

        const parsedDate = new Date(date).toISOString().split('T')[0];
        await pool.query(
            `DELETE FROM couple_period_daily_logs WHERE couple_room_id = $1 AND log_date = $2`,
            [coupleRoomId, parsedDate]
        );

        try {
            const io = getIO();
            if (io) {
                io.to(`room:${coupleRoomId}`).emit('period:log_deleted', { logDate: parsedDate });
            }
        } catch (_) {}

        return res.json({ success: true, logDate: parsedDate });
    } catch (err) {
        logger.error('Error in deleteDailyLog:', err);
        return res.status(500).json({ error: 'Không xóa được nhật ký' });
    }
}

/**
 * GET /api/couple/period/cycles
 * Fetch cycle history and intelligent statistics (Flo style).
 */
async function getCycleHistory(req, res) {
    try {
        const pool = getPool();
        const coupleRoomId = req.coupleRoom?.id || req.user?.coupleRoomId;
        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        const settingsRes = await pool.query(
            `SELECT cycle_length, period_duration FROM couple_period_settings WHERE couple_room_id = $1`,
            [coupleRoomId]
        );
        const baseCycle = settingsRes.rows[0]?.cycle_length || 28;
        const baseDur = settingsRes.rows[0]?.period_duration || 5;

        const stats = await computeCycleStats(pool, coupleRoomId, baseCycle, baseDur);

        return res.json({
            success: true,
            stats,
        });
    } catch (err) {
        logger.error('Error in getCycleHistory:', err);
        return res.status(500).json({ error: 'Không lấy được lịch sử chu kỳ' });
    }
}

/**
 * POST /api/couple/period/cycle/start
 * Mark a date as the start of a period cycle (or toggle off if already start).
 */
async function toggleCycleStart(req, res) {
    try {
        const pool = getPool();
        const coupleRoomId = req.coupleRoom?.id || req.user?.coupleRoomId;
        const userId = req.dbUser?.id || req.user?.id;
        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        await ensurePeriodTables(pool);

        const { startDate } = req.body;
        if (!startDate || isNaN(Date.parse(startDate))) {
            return res.status(400).json({ error: 'Ngày bắt đầu không hợp lệ' });
        }

        const dateStr = new Date(startDate).toISOString().split('T')[0];

        const existing = await pool.query(
            `SELECT id FROM couple_period_cycles WHERE couple_room_id = $1 AND start_date = $2`,
            [coupleRoomId, dateStr]
        );

        let isActive = false;
        if (existing.rows.length > 0) {
            await pool.query(
                `DELETE FROM couple_period_cycles WHERE id = $1`,
                [existing.rows[0].id]
            );
            isActive = false;
        } else {
            await pool.query(
                `INSERT INTO couple_period_cycles (couple_room_id, start_date, period_duration, created_by, updated_at)
                 VALUES ($1, $2, 5, $3, NOW())
                 ON CONFLICT (couple_room_id, start_date) DO NOTHING`,
                [coupleRoomId, dateStr, userId]
            );

            // Auto-log flow level 2 in daily logs
            await pool.query(
                `INSERT INTO couple_period_daily_logs (couple_room_id, log_date, flow_level, pain_level, created_by, updated_at)
                 VALUES ($1, $2, 2, 1, $3, NOW())
                 ON CONFLICT (couple_room_id, log_date)
                 DO UPDATE SET flow_level = GREATEST(couple_period_daily_logs.flow_level, 2), updated_at = NOW()`,
                [coupleRoomId, dateStr, userId]
            );
            isActive = true;

            // Recalculate previous cycle length if exists
            const prevCycle = await pool.query(
                `SELECT id, start_date::text as start_date FROM couple_period_cycles
                 WHERE couple_room_id = $1 AND start_date < $2
                 ORDER BY start_date DESC LIMIT 1`,
                [coupleRoomId, dateStr]
            );
            if (prevCycle.rows.length > 0) {
                const prevLen = Math.round((new Date(dateStr) - new Date(prevCycle.rows[0].start_date)) / 86400000);
                if (prevLen >= 18 && prevLen <= 60) {
                    await pool.query(
                        `UPDATE couple_period_cycles SET cycle_length = $1, updated_at = NOW() WHERE id = $2`,
                        [prevLen, prevCycle.rows[0].id]
                    );
                }
            }

            // If a next cycle exists after this date, calculate this cycle's length
            const nextCycle = await pool.query(
                `SELECT id, start_date::text as start_date FROM couple_period_cycles
                 WHERE couple_room_id = $1 AND start_date > $2
                 ORDER BY start_date ASC LIMIT 1`,
                [coupleRoomId, dateStr]
            );
            if (nextCycle.rows.length > 0) {
                const thisLen = Math.round((new Date(nextCycle.rows[0].start_date) - new Date(dateStr)) / 86400000);
                if (thisLen >= 18 && thisLen <= 60) {
                    await pool.query(
                        `UPDATE couple_period_cycles SET cycle_length = $1, updated_at = NOW() WHERE couple_room_id = $2 AND start_date = $3`,
                        [thisLen, coupleRoomId, dateStr]
                    );
                }
            }
        }

        // Sync latest start_date with couple_period_settings
        const latestRes = await pool.query(
            `SELECT start_date::text as start_date FROM couple_period_cycles
             WHERE couple_room_id = $1
             ORDER BY start_date DESC LIMIT 1`,
            [coupleRoomId]
        );

        if (latestRes.rows.length > 0) {
            await pool.query(
                `UPDATE couple_period_settings
                 SET last_period_date = $2, updated_at = NOW()
                 WHERE couple_room_id = $1`,
                [coupleRoomId, latestRes.rows[0].start_date]
            );
        }

        const stats = await computeCycleStats(pool, coupleRoomId);

        try {
            const io = getIO();
            if (io) {
                io.to(`room:${coupleRoomId}`).emit('period:cycles_updated', {
                    action: isActive ? 'added' : 'removed',
                    date: dateStr,
                    stats,
                });
            }
        } catch (_) {}

        return res.json({
            success: true,
            active: isActive,
            date: dateStr,
            stats,
        });
    } catch (err) {
        logger.error('Error in toggleCycleStart:', err);
        return res.status(500).json({ error: 'Không thể cập nhật ngày bắt đầu chu kỳ' });
    }
}

/**
 * POST /api/couple/period/cycle/end
 * Mark a date as the end of bleeding for a period cycle.
 */
async function toggleCycleEnd(req, res) {
    try {
        const pool = getPool();
        const coupleRoomId = req.coupleRoom?.id || req.user?.coupleRoomId;
        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        await ensurePeriodTables(pool);

        const { endDate, cycleId } = req.body;
        if (!endDate || isNaN(Date.parse(endDate))) {
            return res.status(400).json({ error: 'Ngày kết thúc không hợp lệ' });
        }

        const dateStr = new Date(endDate).toISOString().split('T')[0];

        let targetCycleId = cycleId;
        if (!targetCycleId) {
            const cRes = await pool.query(
                `SELECT id, start_date::text as start_date FROM couple_period_cycles
                 WHERE couple_room_id = $1 AND start_date <= $2
                 ORDER BY start_date DESC LIMIT 1`,
                [coupleRoomId, dateStr]
            );
            if (cRes.rows.length > 0) {
                targetCycleId = cRes.rows[0].id;
            }
        }

        if (!targetCycleId) {
            return res.status(404).json({ error: 'Không tìm thấy chu kỳ tương ứng' });
        }

        const cycleRes = await pool.query(
            `SELECT start_date::text as start_date, end_date::text as end_date FROM couple_period_cycles WHERE id = $1`,
            [targetCycleId]
        );
        const cycle = cycleRes.rows[0];
        const startDate = new Date(cycle.start_date);
        const endD = new Date(dateStr);
        const duration = Math.max(Math.round((endD - startDate) / 86400000) + 1, 1);

        const isAlreadyEnd = (cycle.end_date === dateStr);
        const newEndDate = isAlreadyEnd ? null : dateStr;
        const newDuration = isAlreadyEnd ? 5 : duration;

        await pool.query(
            `UPDATE couple_period_cycles
             SET end_date = $2, period_duration = $3, updated_at = NOW()
             WHERE id = $1`,
            [targetCycleId, newEndDate, newDuration]
        );

        const stats = await computeCycleStats(pool, coupleRoomId);

        try {
            const io = getIO();
            if (io) {
                io.to(`room:${coupleRoomId}`).emit('period:cycles_updated', {
                    action: 'updated',
                    cycleId: targetCycleId,
                    endDate: newEndDate,
                    stats,
                });
            }
        } catch (_) {}

        return res.json({
            success: true,
            active: !isAlreadyEnd,
            endDate: newEndDate,
            periodDuration: newDuration,
            stats,
        });
    } catch (err) {
        logger.error('Error in toggleCycleEnd:', err);
        return res.status(500).json({ error: 'Không thể cập nhật ngày kết thúc kỳ' });
    }
}

/**
 * DELETE /api/couple/period/cycle/:id
 */
async function deleteCycle(req, res) {
    try {
        const pool = getPool();
        const coupleRoomId = req.coupleRoom?.id || req.user?.coupleRoomId;
        const { id } = req.params;

        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        await pool.query(
            `DELETE FROM couple_period_cycles WHERE id = $1 AND couple_room_id = $2`,
            [id, coupleRoomId]
        );

        // Sync latest start_date with couple_period_settings
        const latestRes = await pool.query(
            `SELECT start_date::text as start_date FROM couple_period_cycles
             WHERE couple_room_id = $1
             ORDER BY start_date DESC LIMIT 1`,
            [coupleRoomId]
        );

        if (latestRes.rows.length > 0) {
            await pool.query(
                `UPDATE couple_period_settings
                 SET last_period_date = $2, updated_at = NOW()
                 WHERE couple_room_id = $1`,
                [coupleRoomId, latestRes.rows[0].start_date]
            );
        }

        const stats = await computeCycleStats(pool, coupleRoomId);

        try {
            const io = getIO();
            if (io) {
                io.to(`room:${coupleRoomId}`).emit('period:cycles_updated', {
                    action: 'deleted',
                    cycleId: id,
                    stats,
                });
            }
        } catch (_) {}

        return res.json({ success: true, stats });
    } catch (err) {
        logger.error('Error in deleteCycle:', err);
        return res.status(500).json({ error: 'Không thể xóa chu kỳ' });
    }
}

module.exports = {
    getPeriodData,
    updatePeriodSettings,
    sendPeriodSOS,
    setPeriodRole,
    getDailyLogs,
    upsertDailyLog,
    deleteDailyLog,
    getCycleHistory,
    toggleCycleStart,
    toggleCycleEnd,
    deleteCycle,
    calculatePeriodStatus,
    computeCycleStats,
    evaluateFIGOHealth,
};

