const { query } = require('../config/database');

/**
 * Find the partner user for a given userId within a couple room.
 *
 * @param {string} userId      - The current user's DB UUID
 * @param {string} coupleRoomId - The couple room UUID
 * @returns {Promise<{id: string, fcm_token: string|null, display_name: string|null}|null>}
 */
async function getPartner(userId, coupleRoomId) {
    const result = await query(
        `SELECT u.id, u.fcm_token, u.display_name
         FROM couple_rooms cr
         JOIN users u ON (
           (cr.user_a_id = $1 AND cr.user_b_id = u.id) OR
           (cr.user_b_id = $1 AND cr.user_a_id = u.id)
         )
         WHERE cr.id = $2 AND cr.status = 'active'
         LIMIT 1`,
        [userId, coupleRoomId]
    );
    return result.rows[0] || null;
}

module.exports = { getPartner };
