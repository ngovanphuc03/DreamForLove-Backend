const { getPool } = require('../config/database');
const logger = require('../config/logger');
const { getIO } = require('../socket/socket.handler');

/**
 * Format raw cheatsheet DB row into clean response object
 */
function formatCheatsheetRow(row) {
    if (!row) return null;
    return {
        userId: row.user_id,
        userName: row.display_name || '',
        userAvatar: row.photo_url || '',
        drink: {
            name: row.drink_name || '',
            sugar: row.drink_sugar || '',
            ice: row.drink_ice || '',
            topping: row.drink_topping || '',
            notes: row.drink_notes || '',
        },
        food: {
            dislikes: row.food_dislikes || '',
            spiceLevel: row.food_spice_level || '',
            allergies: row.food_allergies || '',
            favorites: row.favorite_dishes || '',
        },
        fashion: {
            shoeSize: row.shoe_size || '',
            clothingSize: row.clothing_size || '',
            ringSize: row.ring_size || '',
            styleNotes: row.style_notes || '',
        },
        beauty: {
            lipstickShade: row.lipstick_shade || '',
            favoriteScent: row.favorite_scent || '',
            specialNotes: row.special_notes || '',
        },
        updatedAt: row.updated_at,
    };
}

/**
 * GET /api/couple/cheatsheet
 * Fetch partner's and user's cheatsheets for the current couple room.
 */
async function getCheatsheets(req, res) {
    try {
        const pool = getPool();
        const coupleRoomId = req.user.coupleRoomId;
        const currentUserId = req.user.id;

        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        const result = await pool.query(
            `SELECT pc.*, u.display_name, u.photo_url
             FROM partner_cheatsheets pc
             JOIN users u ON u.id = pc.user_id
             WHERE pc.couple_room_id = $1`,
            [coupleRoomId]
        );

        let myCheatsheet = null;
        let partnerCheatsheet = null;

        for (const row of result.rows) {
            const formatted = formatCheatsheetRow(row);
            if (row.user_id === currentUserId) {
                myCheatsheet = formatted;
            } else {
                partnerCheatsheet = formatted;
            }
        }

        // If not found in DB yet, query user info so names/avatars are still provided
        if (!myCheatsheet) {
            const userRes = await pool.query(`SELECT id, display_name, photo_url FROM users WHERE id = $1`, [currentUserId]);
            if (userRes.rows.length > 0) {
                myCheatsheet = formatCheatsheetRow({ user_id: currentUserId, ...userRes.rows[0] });
            }
        }

        if (!partnerCheatsheet) {
            const partnerRes = await pool.query(
                `SELECT u.id, u.display_name, u.photo_url
                 FROM users u
                 JOIN couple_rooms cr ON (cr.user_a_id = u.id OR cr.user_b_id = u.id)
                 WHERE cr.id = $1 AND u.id != $2`,
                [coupleRoomId, currentUserId]
            );
            if (partnerRes.rows.length > 0) {
                partnerCheatsheet = formatCheatsheetRow({ user_id: partnerRes.rows[0].id, ...partnerRes.rows[0] });
            }
        }

        return res.json({
            mine: myCheatsheet,
            partner: partnerCheatsheet,
        });
    } catch (err) {
        logger.error('Error in getCheatsheets:', err);
        return res.status(500).json({ error: 'Không lấy được sổ tay gu của hai bạn' });
    }
}

/**
 * PUT /api/couple/cheatsheet
 * Update current user's cheatsheet and broadcast to partner.
 */
async function updateMyCheatsheet(req, res) {
    try {
        const pool = getPool();
        const coupleRoomId = req.user.coupleRoomId;
        const currentUserId = req.user.id;

        if (!coupleRoomId) {
            return res.status(400).json({ error: 'Chưa tham gia phòng đôi' });
        }

        const {
            drink = {},
            food = {},
            fashion = {},
            beauty = {},
        } = req.body;

        const drinkName = (drink.name || '').trim();
        const drinkSugar = (drink.sugar || '').trim();
        const drinkIce = (drink.ice || '').trim();
        const drinkTopping = (drink.topping || '').trim();
        const drinkNotes = (drink.notes || '').trim();

        const foodDislikes = (food.dislikes || '').trim();
        const foodSpiceLevel = (food.spiceLevel || '').trim();
        const foodAllergies = (food.allergies || '').trim();
        const favoriteDishes = (food.favorites || '').trim();

        const shoeSize = (fashion.shoeSize || '').trim();
        const clothingSize = (fashion.clothingSize || '').trim();
        const ringSize = (fashion.ringSize || '').trim();
        const styleNotes = (fashion.styleNotes || '').trim();

        const lipstickShade = (beauty.lipstickShade || '').trim();
        const favoriteScent = (beauty.favoriteScent || '').trim();
        const specialNotes = (beauty.specialNotes || '').trim();

        const result = await pool.query(
            `INSERT INTO partner_cheatsheets (
                couple_room_id, user_id,
                drink_name, drink_sugar, drink_ice, drink_topping, drink_notes,
                food_dislikes, food_spice_level, food_allergies, favorite_dishes,
                shoe_size, clothing_size, ring_size, style_notes,
                lipstick_shade, favorite_scent, special_notes,
                updated_at
            ) VALUES (
                $1, $2,
                $3, $4, $5, $6, $7,
                $8, $9, $10, $11,
                $12, $13, $14, $15,
                $16, $17, $18,
                NOW()
            )
            ON CONFLICT (couple_room_id, user_id)
            DO UPDATE SET
                drink_name = EXCLUDED.drink_name,
                drink_sugar = EXCLUDED.drink_sugar,
                drink_ice = EXCLUDED.drink_ice,
                drink_topping = EXCLUDED.drink_topping,
                drink_notes = EXCLUDED.drink_notes,
                food_dislikes = EXCLUDED.food_dislikes,
                food_spice_level = EXCLUDED.food_spice_level,
                food_allergies = EXCLUDED.food_allergies,
                favorite_dishes = EXCLUDED.favorite_dishes,
                shoe_size = EXCLUDED.shoe_size,
                clothing_size = EXCLUDED.clothing_size,
                ring_size = EXCLUDED.ring_size,
                style_notes = EXCLUDED.style_notes,
                lipstick_shade = EXCLUDED.lipstick_shade,
                favorite_scent = EXCLUDED.favorite_scent,
                special_notes = EXCLUDED.special_notes,
                updated_at = NOW()
            RETURNING *`,
            [
                coupleRoomId, currentUserId,
                drinkName, drinkSugar, drinkIce, drinkTopping, drinkNotes,
                foodDislikes, foodSpiceLevel, foodAllergies, favoriteDishes,
                shoeSize, clothingSize, ringSize, styleNotes,
                lipstickShade, favoriteScent, specialNotes,
            ]
        );

        const userRes = await pool.query(`SELECT display_name, photo_url FROM users WHERE id = $1`, [currentUserId]);
        const formatted = formatCheatsheetRow({
            ...result.rows[0],
            display_name: userRes.rows[0]?.display_name,
            photo_url: userRes.rows[0]?.photo_url,
        });

        // Broadcast to couple room
        try {
            const io = getIO();
            if (io) {
                io.to(`room:${coupleRoomId}`).emit('cheatsheet:updated', {
                    updatedBy: currentUserId,
                    cheatsheet: formatted,
                });
            }
        } catch (wsErr) {
            logger.warn('Socket broadcast failed for cheatsheet:updated:', wsErr);
        }

        return res.json(formatted);
    } catch (err) {
        logger.error('Error in updateMyCheatsheet:', err);
        return res.status(500).json({ error: 'Không lưu được sổ tay gu' });
    }
}

module.exports = {
    getCheatsheets,
    updateMyCheatsheet,
};
