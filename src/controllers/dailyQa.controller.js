const { query, transaction } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { getIO } = require('../socket/socket.handler');
const { sendPushNotification } = require('../config/firebase');
const logger = require('../utils/logger');

// ── Kho 100 câu hỏi tình yêu đôi lứa chọn lọc ──────────────────
const ROMANTIC_QUESTIONS = [
    'Điều gì hôm nay ở đối phương khiến bạn cảm thấy bình yên và ấm áp nhất?',
    'Khoảnh khắc nào trong quá khứ khiến bạn nhận ra mình đã yêu người ấy thật lòng?',
    'Nếu chỉ được chọn một điều, bạn thích nhất điểm gì trên khuôn mặt của người ấy?',
    'Bài hát nào mỗi lần nghe đều khiến bạn nhớ đến đối phương ngay lập tức?',
    'Một thói quen nhỏ cực kỳ đáng yêu của người ấy mà bạn không bao giờ muốn họ thay đổi?',
    'Một chuyến đi mà bạn nhất định muốn cùng người ấy thực hiện trong đời?',
    'Lần gần đây nhất đối phương làm bạn bật cười hạnh phúc là khi nào?',
    'Nếu có một siêu năng lực dành riêng cho tình yêu, bạn muốn có khả năng gì?',
    'Món ăn nào bạn muốn tự tay nấu cho người ấy thưởng thức nhất?',
    'Lời nhắn nhủ ngọt ngào nhất bạn muốn gửi tới người ấy trước khi đi ngủ hôm nay?',
    'Điều đầu tiên bạn nghĩ về đối phương khi vừa thức dậy sáng nay là gì?',
    'Kỷ niệm hẹn hò nào giữa hai người khiến tim bạn rung động nhất?',
    'Trang phục hoặc phong cách nào của người ấy khiến bạn thấy cuốn hút nhất?',
    'Khi bạn mệt mỏi, hành động nào của người ấy làm bạn thấy được dỗ dành nhất?',
    'Một điều bí mật nhỏ mà bạn chưa từng kể nhưng hôm nay muốn chia sẻ với người ấy?',
    'Bạn muốn hai đứa mình cùng nhau già đi ở một nơi như thế nào?',
    'Mùi hương hoặc cái ôm nào của người ấy làm bạn nhớ mãi không quên?',
    'Nếu được tặng người ấy một món quà bất ngờ ngay lúc này, bạn sẽ chọn gì?',
    'Một câu nói của người ấy từng làm bạn xúc động đến rưng rưng?',
    'Điều gì ở hai bạn mà bạn cảm thấy hòa hợp và thấu hiểu nhau nhất?',
    'Một trò đùa ngốc nghếch mà chỉ hai đứa mình mới hiểu và cười với nhau?',
    'Nếu ngày mai là ngày tận thế, bạn muốn cùng người ấy làm điều gì cuối cùng?',
    'Biệt danh đáng yêu nhất mà bạn muốn gọi người ấy trong không gian riêng?',
    'Khi nhìn vào mắt người ấy, cảm xúc rõ ràng nhất trong bạn là gì?',
    'Bạn mong ước tình yêu của chúng mình sẽ đạt được cột mốc nào tiếp theo?',
    'Một góc quán quen hoặc địa điểm mà bạn chỉ muốn đi cùng người ấy?',
    'Điều ngốc nghếch ngọt ngào nhất mà bạn từng làm vì người ấy?',
    'Một lời hứa chân thành mà bạn muốn giữ trọn vẹn với đối phương?',
    'Người ấy đã giúp bạn thay đổi và trở nên tốt hơn ở điểm nào?',
    'Cái nắm tay nào giữa hai người làm bạn thấy an tâm và vững chãi nhất?',
    'Nếu quay ngược thời gian về ngày đầu gặp gỡ, bạn sẽ nói gì với người ấy?',
    'Hành động bất ngờ nào của người ấy từng khiến tim bạn lỡ nhịp?',
    'Một ước mơ tương lai mà trong đó chắc chắn phải có hình bóng của người ấy?',
    'Khi người ấy giận dỗi, cách làm hòa nào bạn thấy dễ thương và hiệu quả nhất?',
    'Ba từ hoàn hảo nhất để miêu tả vị trí của người ấy trong trái tim bạn?',
    'Một bộ phim mà bạn muốn hai đứa cùng cuộn tròn trong chăn xem lại lần nữa?',
    'Cảm giác khi được tựa đầu vào vai người ấy giống như điều gì?',
    'Bạn trân trọng điều gì nhất ở cách người ấy đối xử với bạn mỗi ngày?',
    'Nếu được viết một bức thư gửi cho hai đứa ở 10 năm sau, bạn muốn viết gì?',
    'Bao nhiêu cái ôm và nụ hôn mỗi ngày là đủ với bạn? Hay là không bao giờ đủ?'
];

function getVietnamDateString() {
    const now = new Date();
    const vnTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    const y = vnTime.getFullYear();
    const m = String(vnTime.getMonth() + 1).padStart(2, '0');
    const d = String(vnTime.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getQuestionForDate(dateStr) {
    const parts = dateStr.split('-');
    const day = parseInt(parts[2], 10) || 1;
    const month = parseInt(parts[1], 10) || 1;
    const dayOfYear = (month - 1) * 31 + day;
    const index = Math.abs(dayOfYear) % ROMANTIC_QUESTIONS.length;
    return ROMANTIC_QUESTIONS[index];
}

// ── GET /api/couple/daily-qa ──────────────────────────────────
async function getTodayQa(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const userAId = req.coupleRoom.userAId;
        const userBId = req.coupleRoom.userBId;
        const todayStr = getVietnamDateString();
        const defaultQuestion = getQuestionForDate(todayStr);

        let result = await query(
            `SELECT * FROM daily_couple_qa 
             WHERE couple_room_id = $1 AND qa_date = $2`,
            [roomId, todayStr]
        );

        let row;
        if (!result.rows.length) {
            const insertResult = await query(
                `INSERT INTO daily_couple_qa 
                 (id, couple_room_id, qa_date, question_text, user_a_id, user_b_id, is_unlocked)
                 VALUES ($1, $2, $3, $4, $5, $6, FALSE)
                 ON CONFLICT (couple_room_id, qa_date) 
                 DO UPDATE SET question_text = EXCLUDED.question_text
                 RETURNING *`,
                [uuidv4(), roomId, todayStr, defaultQuestion, userAId, userBId]
            );
            row = insertResult.rows[0];
        } else {
            row = result.rows[0];
        }

        const isUserA = (userId === row.user_a_id);
        const myAnswer = isUserA ? row.user_a_answer : row.user_b_answer;
        const myAnsweredAt = isUserA ? row.user_a_answered_at : row.user_b_answered_at;
        const partnerAnswerRaw = isUserA ? row.user_b_answer : row.user_a_answer;
        const partnerAnsweredAtRaw = isUserA ? row.user_b_answered_at : row.user_a_answered_at;

        const partnerAnswered = partnerAnswerRaw != null && partnerAnswerRaw.trim().length > 0;
        const myAnswered = myAnswer != null && myAnswer.trim().length > 0;
        const isUnlocked = row.is_unlocked === true || (myAnswered && partnerAnswered);

        // BẢO MẬT DUAL UNLOCK: Chỉ gửi partner_answer khi isUnlocked = true
        res.json({
            id: row.id,
            qa_date: row.qa_date,
            question_text: row.question_text,
            is_unlocked: isUnlocked,
            my_answered: myAnswered,
            my_answer: myAnswer || null,
            my_answered_at: myAnsweredAt || null,
            partner_answered: partnerAnswered,
            partner_answer: isUnlocked ? (partnerAnswerRaw || null) : null,
            partner_answered_at: isUnlocked ? (partnerAnsweredAtRaw || null) : null,
        });
    } catch (err) {
        next(err);
    }
}

// ── POST /api/couple/daily-qa/answer ──────────────────────────
async function submitAnswer(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const userAId = req.coupleRoom.userAId;
        const userBId = req.coupleRoom.userBId;
        const { answer } = req.body;

        const sanitized = (typeof answer === 'string') ? answer.trim() : '';
        if (!sanitized) {
            return res.status(400).json({ error: 'Câu trả lời không được để trống' });
        }

        const todayStr = getVietnamDateString();
        const defaultQuestion = getQuestionForDate(todayStr);
        const partnerId = (userId === userAId) ? userBId : userAId;

        // Upsert row first
        await query(
            `INSERT INTO daily_couple_qa 
             (id, couple_room_id, qa_date, question_text, user_a_id, user_b_id, is_unlocked)
             VALUES ($1, $2, $3, $4, $5, $6, FALSE)
             ON CONFLICT (couple_room_id, qa_date) DO NOTHING`,
            [uuidv4(), roomId, todayStr, defaultQuestion, userAId, userBId]
        );

        // Update answer
        const isUserA = (userId === userAId);
        const answerColumn = isUserA ? 'user_a_answer' : 'user_b_answer';
        const answeredAtColumn = isUserA ? 'user_a_answered_at' : 'user_b_answered_at';
        const partnerAnswerColumn = isUserA ? 'user_b_answer' : 'user_a_answer';

        const updateResult = await query(
            `UPDATE daily_couple_qa
             SET ${answerColumn} = $1,
                 ${answeredAtColumn} = NOW(),
                 updated_at = NOW()
             WHERE couple_room_id = $2 AND qa_date = $3
             RETURNING *`,
            [sanitized, roomId, todayStr]
        );

        let row = updateResult.rows[0];
        const partnerAnswerRaw = row[partnerAnswerColumn];
        const partnerAnswered = partnerAnswerRaw != null && partnerAnswerRaw.trim().length > 0;
        const bothAnswered = partnerAnswered && sanitized.length > 0;

        const io = getIO();

        if (bothAnswered && !row.is_unlocked) {
            // Cả hai đã hoàn thành -> MỞ KHÓA SONG HÀNH
            const unlockRes = await query(
                `UPDATE daily_couple_qa
                 SET is_unlocked = TRUE, updated_at = NOW()
                 WHERE couple_room_id = $1 AND qa_date = $2
                 RETURNING *`,
                [roomId, todayStr]
            );
            row = unlockRes.rows[0];

            if (io) {
                io.to(`room:${roomId}`).emit('daily_qa:unlocked', {
                    qa_date: todayStr,
                    question_text: row.question_text,
                    user_a_answer: row.user_a_answer,
                    user_b_answer: row.user_b_answer,
                    user_a_answered_at: row.user_a_answered_at,
                    user_b_answered_at: row.user_b_answered_at,
                    is_unlocked: true,
                });
            }

            // Gửi FCM chúc mừng tới đối phương
            (async () => {
                try {
                    const partnerUserRes = await query(
                        `SELECT fcm_token, display_name FROM users WHERE id = $1`,
                        [partnerId]
                    );
                    if (partnerUserRes.rows.length && partnerUserRes.rows[0].fcm_token) {
                        await sendPushNotification({
                            token: partnerUserRes.rows[0].fcm_token,
                            title: '✨ Bí mật câu hỏi hôm nay đã mở khóa!',
                            body: 'Cả hai bạn đã cùng trả lời! Chạm vào để cùng xem bí mật của nhau 💕',
                            data: { type: 'DAILY_QA_UNLOCKED' },
                        });
                    }
                } catch (pushErr) {
                    logger.warn(`[DailyQA] Push unlock failed: ${pushErr.message}`);
                }
            })();
        } else if (!bothAnswered) {
            // Đối phương chưa trả lời -> Thông báo kích thích tò mò
            if (io) {
                io.to(`user:${partnerId}`).emit('daily_qa:partner_answered', {
                    qa_date: todayStr,
                    partner_name: req.dbUser.display_name,
                });
            }

            (async () => {
                try {
                    const partnerUserRes = await query(
                        `SELECT fcm_token, display_name FROM users WHERE id = $1`,
                        [partnerId]
                    );
                    if (partnerUserRes.rows.length && partnerUserRes.rows[0].fcm_token) {
                        await sendPushNotification({
                            token: partnerUserRes.rows[0].fcm_token,
                            title: '💌 Người ấy đã trả lời câu hỏi đôi!',
                            body: `${req.dbUser.display_name} đang chờ bạn trả lời để cùng mở khóa bí mật nhé 🔒`,
                            data: { type: 'DAILY_QA_PARTNER_ANSWERED' },
                        });
                    }
                } catch (pushErr) {
                    logger.warn(`[DailyQA] Push waiting failed: ${pushErr.message}`);
                }
            })();
        }

        const isUnlocked = row.is_unlocked === true;
        res.json({
            success: true,
            id: row.id,
            qa_date: row.qa_date,
            question_text: row.question_text,
            is_unlocked: isUnlocked,
            my_answered: true,
            my_answer: sanitized,
            my_answered_at: row[answeredAtColumn],
            partner_answered: partnerAnswered,
            partner_answer: isUnlocked ? partnerAnswerRaw : null,
            partner_answered_at: isUnlocked ? row[isUserA ? 'user_b_answered_at' : 'user_a_answered_at'] : null,
        });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    getTodayQa,
    submitAnswer,
};
