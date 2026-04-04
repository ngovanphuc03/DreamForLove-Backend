const logger = require('../config/logger');

const DEFAULT_DAILY_CAP = 60;

const REWARD_PRESETS = Object.freeze({
    moodDailyPair: {
        type: 'mood_daily_pair',
        coins: 8,
    },
    wishlistBought: {
        type: 'wishlist_bought',
        coins: 5,
    },
    tripDone: {
        type: 'trip_done',
        coins: 10,
    },
    // Pet care rewards (awarded directly in pet.controller.js, documented here)
    petCareAction: {
        type: 'pet_care',
        coins: 2,
    },
    petFirstCareBonus: {
        type: 'pet_first_care',
        coins: 3,
    },
    petCooperativeBonus: {
        type: 'pet_coop',
        coins: 5,
    },
});

function getDailyCoinCap() {
    const raw = Number(process.env.LOVE_COIN_DAILY_CAP);
    if (!Number.isFinite(raw) || raw <= 0) {
        return DEFAULT_DAILY_CAP;
    }
    return Math.floor(raw);
}

/**
 * Idempotent love coin awarding with per-room daily cap.
 * Must be called inside a DB transaction and receives the same transaction client.
 */
async function awardLoveCoins({
    client,
    coupleRoomId,
    rewardType,
    rewardKey,
    coins,
    awardedBy = null,
    metadata = {},
}) {
    if (!client || typeof client.query !== 'function') {
        throw new Error('awardLoveCoins requires a transaction client');
    }

    const parsedCoins = Math.max(0, Math.floor(Number(coins) || 0));
    if (!parsedCoins) {
        return {
            awardedCoins: 0,
            reason: 'invalid_amount',
            loveCoins: null,
            inventory: [],
        };
    }

    const roomRes = await client.query(
        'SELECT love_coins FROM couple_rooms WHERE id = $1 FOR UPDATE',
        [coupleRoomId]
    );
    if (!roomRes.rows.length) {
        const err = new Error('Couple room not found');
        err.statusCode = 404;
        throw err;
    }

    const loveCoinsBefore = roomRes.rows[0].love_coins;
    const dailyCap = getDailyCoinCap();

    const todayRes = await client.query(
        `SELECT COALESCE(SUM(coins_awarded), 0)::int AS total
         FROM coin_reward_logs
         WHERE couple_room_id = $1
           AND (created_at AT TIME ZONE 'UTC')::date = CURRENT_DATE`,
        [coupleRoomId]
    );

    const awardedToday = todayRes.rows[0]?.total || 0;
    const remaining = Math.max(dailyCap - awardedToday, 0);
    if (!remaining) {
        return {
            awardedCoins: 0,
            reason: 'daily_cap_reached',
            loveCoins: loveCoinsBefore,
            inventory: [],
        };
    }

    const coinsToAward = Math.min(parsedCoins, remaining);
    const insertRes = await client.query(
        `INSERT INTO coin_reward_logs
            (couple_room_id, reward_type, reward_key, coins_awarded, awarded_by, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (couple_room_id, reward_type, reward_key) DO NOTHING
         RETURNING id, coins_awarded`,
        [
            coupleRoomId,
            rewardType,
            rewardKey,
            coinsToAward,
            awardedBy,
            JSON.stringify(metadata || {}),
        ]
    );

    if (!insertRes.rows.length) {
        return {
            awardedCoins: 0,
            reason: 'duplicate',
            loveCoins: loveCoinsBefore,
            inventory: [],
        };
    }

    const updatedRoomRes = await client.query(
        'UPDATE couple_rooms SET love_coins = love_coins + $2 WHERE id = $1 RETURNING love_coins',
        [coupleRoomId, coinsToAward]
    );
    const updatedLoveCoins = updatedRoomRes.rows[0]?.love_coins ?? loveCoinsBefore;

    const invRes = await client.query(
        'SELECT item_id, quantity FROM pet_inventory WHERE couple_room_id = $1',
        [coupleRoomId]
    );
    const inventory = invRes.rows.map((row) => ({
        id: row.item_id,
        qty: row.quantity,
    }));

    logger.info(
        `[LoveCoins] Awarded +${coinsToAward} for room ${coupleRoomId} (${rewardType}:${rewardKey})`
    );

    return {
        awardedCoins: coinsToAward,
        reason: coinsToAward < parsedCoins ? 'capped_partial' : 'awarded',
        loveCoins: updatedLoveCoins,
        inventory,
    };
}

module.exports = {
    REWARD_PRESETS,
    getDailyCoinCap,
    awardLoveCoins,
};