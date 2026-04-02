const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

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

// GET /api/couple/milestones
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

// POST /api/couple/milestones
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

// PATCH /api/couple/milestones/:id
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

// DELETE /api/couple/milestones/:id
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
    DEFAULT_MILESTONES,
    getMilestones,
    createMilestone,
    updateMilestone,
    deleteMilestone,
};
