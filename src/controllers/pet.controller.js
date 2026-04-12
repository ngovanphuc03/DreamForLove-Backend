const { query, transaction } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { getIO } = require('../socket/socket.handler');
const { sendPushNotification } = require('../config/firebase');
const logger = require('../config/logger');

// ═══════════════════════════════════════════════════════════════
//  Game Balance Configuration
// ═══════════════════════════════════════════════════════════════

const ACTION_CONFIG = {
    feed: { statDeltas: { hunger: 30, health: 10 }, xp: 25, cooldownMinutes: 30, reqItem: 'basic_food' },
    pet: { statDeltas: { mood: 10, health: 2 }, xp: 10, cooldownMinutes: 60, reqItem: null }, // Free but weak
    bathe: { statDeltas: { cleanliness: 40, health: 15 }, xp: 30, cooldownMinutes: 120, reqItem: 'basic_soap' },
    play: { statDeltas: { health: 20, mood: 25 }, xp: 35, cooldownMinutes: 90, reqItem: 'basic_toy' },
};

// Premium food gives significantly better stats (worth 3x the price)
const PREMIUM_FEED_CONFIG = {
    statDeltas: { hunger: 50, health: 20, mood: 10 },
    xp: 40,
};

// Love Coin rewards for pet care actions
const PET_CARE_COIN_REWARD = 3;        // coins per care action
const PET_FIRST_CARE_COIN_BONUS = 4;   // bonus for first action of the day
const PET_COOP_COIN_BONUS = 6;         // bonus when both partners contribute same day

const SHOP_PRICES = {
    basic_food: 4,
    basic_soap: 6,
    basic_toy: 6,
    premium_food: 12,
    evolution_stone: 220,
};

const FEED_ITEM_IDS = ['basic_food', 'premium_food'];

const VALID_ACTIONS = Object.keys(ACTION_CONFIG);
const COOPERATIVE_BONUS_XP = 25;

// Decay: −3 per stat for every 4 hours of inactivity
const DECAY_INTERVAL_HOURS = 4;
const DECAY_PER_INTERVAL = 3;

// Hardcore Evolution thresholds (index = level − 1)
const LEVEL_THRESHOLDS = [0, 500, 1500, 3500, 8000, 18000, 38000, 80000];

// Pet death penalty: if ALL stats reach 0
const DEATH_XP_PENALTY = 50;

// ═══════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════

function computeLevel(totalXp) {
    let level = 1;
    for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
        if (totalXp >= LEVEL_THRESHOLDS[i]) level = i + 1;
    }
    return Math.min(level, 8);
}

function computeXpToNextLevel(totalXp) {
    const level = computeLevel(totalXp);
    if (level >= 8) return 0;
    return Math.max(LEVEL_THRESHOLDS[level] - totalXp, 0);
}

function toUTCDateKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function computeBalancedStreakFromRows(rows, maxDays = 30) {
    const dayMap = new Map();

    for (const row of rows || []) {
        const rawDay = row.day;
        const dayKey = rawDay instanceof Date
            ? toUTCDateKey(rawDay)
            : String(rawDay).slice(0, 10);
        const count = Number(row.cnt) || 0;

        const stats = dayMap.get(dayKey) || { total: 0, maxByUser: 0 };
        stats.total += count;
        stats.maxByUser = Math.max(stats.maxByUser, count);
        dayMap.set(dayKey, stats);
    }

    let streak = 0;
    const now = new Date();

    for (let i = 0; i < maxDays; i++) {
        const checkDate = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() - i
        ));
        const dayKey = toUTCDateKey(checkDate);
        const stats = dayMap.get(dayKey);

        // Need both partners to contribute in the same day to count as balanced.
        if (!stats || stats.total <= 1) break;

        const ratio = stats.maxByUser / stats.total;
        if (ratio > 0.65) break;

        streak += 1;
    }

    return streak;
}

/**
 * Apply stat decay based on time elapsed since last_decay_at.
 * Returns the decayed stats + new last_decay_at.
 */
function computeDecay(pet) {
    const now = new Date();
    const lastDecay = new Date(pet.last_decay_at || now);
    const hoursElapsed = (now - lastDecay) / (1000 * 60 * 60);
    const intervals = Math.floor(hoursElapsed / DECAY_INTERVAL_HOURS);

    if (intervals <= 0) {
        return {
            health: pet.health,
            mood: pet.mood,
            hunger: pet.hunger,
            cleanliness: pet.cleanliness,
            decayApplied: false,
        };
    }

    const totalDecay = intervals * DECAY_PER_INTERVAL;
    return {
        health: Math.max(pet.health - totalDecay, 0),
        mood: Math.max(pet.mood - totalDecay, 0),
        hunger: Math.max(pet.hunger - totalDecay, 0),
        cleanliness: Math.max(pet.cleanliness - totalDecay, 0),
        decayApplied: true,
        intervalsDecayed: intervals,
    };
}

/**
 * Build the cooldown map for the frontend.
 */
function buildCooldowns(pet) {
    const now = new Date();
    const cooldowns = {};

    const actionLastMap = {
        feed: pet.last_fed_at,
        play: pet.last_played_at,
        bathe: pet.last_bathed_at,
        pet: pet.last_petted_at,
    };

    for (const [action, lastAt] of Object.entries(actionLastMap)) {
        const config = ACTION_CONFIG[action];
        if (!lastAt) {
            cooldowns[action] = { ready: true, readyAt: null };
            continue;
        }
        const readyAt = new Date(new Date(lastAt).getTime() + config.cooldownMinutes * 60 * 1000);
        cooldowns[action] = {
            ready: now >= readyAt,
            readyAt: readyAt.toISOString(),
        };
    }

    return cooldowns;
}

/**
 * Format pet row into the response shape expected by Flutter.
 */
function formatPetResponse(pet, myActionsToday, partnerActionsToday, loveCoins = 0, inventory = [], expedition = null) {
    const cooldowns = buildCooldowns(pet);

    // Calculate Yin-Yang imbalance
    const totalCare = pet.user1_interactions + pet.user2_interactions;
    let imbalancePenalty = false;
    if (totalCare > 20) {
        const ratio = Math.max(pet.user1_interactions, pet.user2_interactions) / totalCare;
        if (ratio > 0.75) imbalancePenalty = true;
    }

    return {
        petName: pet.pet_name,
        health: pet.health,
        mood: pet.mood,
        hunger: pet.hunger,
        cleanliness: pet.cleanliness,
        evolutionLevel: pet.evolution_level,
        totalLoveXp: pet.total_love_xp,
        xpToNextLevel: computeXpToNextLevel(pet.total_love_xp),
        requiresEvolutionStone: pet.requires_evolution_stone,
        imbalancePenalty,
        loveCoins,
        inventory,
        expedition,
        cooldowns,
        partnerContribution: {
            myActions: myActionsToday,
            partnerActions: partnerActionsToday,
        },
        lastActions: {
            lastFedAt: pet.last_fed_at ? new Date(pet.last_fed_at).toISOString() : null,
            lastPlayedAt: pet.last_played_at ? new Date(pet.last_played_at).toISOString() : null,
            lastBathedAt: pet.last_bathed_at ? new Date(pet.last_bathed_at).toISOString() : null,
            lastPettedAt: pet.last_petted_at ? new Date(pet.last_petted_at).toISOString() : null,
        },
    };
}

/**
 * Get current expedition snapshot for UI state.
 * Returns either the active exploring expedition or a returned one waiting for collection.
 */
async function getCurrentExpedition(coupleRoomId, client) {
    const qFn = client ? client.query.bind(client) : query;

    try {
        await qFn(
            `UPDATE pet_expeditions
             SET status = 'returned'
             WHERE couple_room_id = $1 AND status = 'exploring' AND ends_at <= NOW()`,
            [coupleRoomId]
        );

        const result = await qFn(
            `SELECT id, status, expedition_type, duration_hours, started_at, ends_at, loot_data
             FROM pet_expeditions
             WHERE couple_room_id = $1 AND status IN ('exploring', 'returned')
             ORDER BY created_at DESC LIMIT 1`,
            [coupleRoomId]
        );

        if (!result.rows.length) {
            return null;
        }

        const exp = result.rows[0];
        const typeConfig = EXPEDITION_TYPES[exp.expedition_type] || EXPEDITION_TYPES.forest;

        return {
            id: exp.id,
            status: exp.status,
            type: exp.expedition_type,
            typeLabel: typeConfig.label,
            typeEmoji: typeConfig.emoji,
            duration: exp.duration_hours,
            startedAt: exp.started_at,
            endsAt: exp.ends_at,
            loot: exp.status === 'returned' ? exp.loot_data : null,
        };
    } catch (err) {
        // Backward compatibility when migration 016 has not been applied yet.
        if (err.code === '42P01') {
            return null;
        }
        throw err;
    }
}

/**
 * Ensure a pet exists for the given couple room. Auto-create if missing.
 */
async function ensurePet(coupleRoomId, client) {
    const qFn = client ? client.query.bind(client) : query;
    const existing = await qFn(
        'SELECT * FROM couple_pet WHERE couple_room_id = $1',
        [coupleRoomId]
    );
    if (existing.rows.length) return existing.rows[0];

    // Auto-create with defaults
    const newPet = await qFn(
        `INSERT INTO couple_pet (id, couple_room_id)
         VALUES ($1, $2)
         ON CONFLICT (couple_room_id) DO NOTHING
         RETURNING *`,
        [uuidv4(), coupleRoomId]
    );

    if (newPet.rows.length) {
        logger.info(`[Pet] Auto-created pet for room ${coupleRoomId}`);
        return newPet.rows[0];
    }

    // Race condition: another request created it
    const retry = await qFn(
        'SELECT * FROM couple_pet WHERE couple_room_id = $1',
        [coupleRoomId]
    );
    return retry.rows[0];
}

/**
 * Count today's actions for a user in a room.
 */
async function countTodayActions(coupleRoomId, userId, client) {
    const qFn = client ? client.query.bind(client) : query;
    const result = await qFn(
        `SELECT COUNT(*)::int AS cnt FROM pet_care_actions
         WHERE couple_room_id = $1 AND user_id = $2
         AND action_type IN ('feed', 'pet', 'bathe', 'play')
         AND (created_at AT TIME ZONE 'UTC')::date = CURRENT_DATE`,
        [coupleRoomId, userId]
    );
    return result.rows[0]?.cnt || 0;
}

/**
 * Get partner's userId for a couple room.
 */
async function getPartnerId(coupleRoomId, userId, client) {
    const qFn = client ? client.query.bind(client) : query;
    const result = await qFn(
        `SELECT CASE
            WHEN user_a_id = $2 THEN user_b_id
            ELSE user_a_id
         END AS partner_id
         FROM couple_rooms
         WHERE id = $1 AND status = 'active'`,
        [coupleRoomId, userId]
    );
    return result.rows[0]?.partner_id || null;
}

/**
 * Check if all stats are zero (pet death condition).
 */
function isPetDead(pet) {
    return pet.health <= 0 && pet.mood <= 0 && pet.hunger <= 0 && pet.cleanliness <= 0;
}

/**
 * Send critical alert push notifications to both partners.
 */
async function sendCriticalAlerts(coupleRoomId, pet) {
    try {
        const users = await query(
            `SELECT u.id, u.fcm_token, u.display_name
             FROM users u
             JOIN couple_rooms cr ON (cr.user_a_id = u.id OR cr.user_b_id = u.id)
             WHERE cr.id = $1 AND cr.status = 'active'`,
            [coupleRoomId]
        );

        const criticalStats = [];
        if (pet.health < 20) criticalStats.push('sức khỏe');
        if (pet.mood < 20) criticalStats.push('tâm trạng');
        if (pet.hunger < 20) criticalStats.push('no bụng');
        if (pet.cleanliness < 20) criticalStats.push('sạch sẽ');

        if (criticalStats.length === 0) return;

        const petName = pet.pet_name || 'Bé Yêu';
        const body = `${petName} đang yếu! ${criticalStats.join(', ')} rất thấp 😢`;

        for (const user of users.rows) {
            if (!user.fcm_token) continue;
            try {
                await sendPushNotification({
                    token: user.fcm_token,
                    title: `${petName} cần được chăm sóc! 🆘`,
                    body,
                    data: { type: 'PET_CRITICAL_ALERT' },
                });
            } catch (pushErr) {
                logger.warn(`[Pet] Push failed for user ${user.id}: ${pushErr.message}`);
            }
        }
    } catch (err) {
        logger.error(`[Pet] sendCriticalAlerts error: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════
//  Controllers
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/couple/pet — Get full pet state
 */
async function getPetState(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const partnerId = await getPartnerId(roomId, userId);

        let pet = await ensurePet(roomId);

        // Apply pending decay
        const decay = computeDecay(pet);
        if (decay.decayApplied) {
            const updated = await query(
                `UPDATE couple_pet
                 SET health = $2, mood = $3, hunger = $4, cleanliness = $5,
                     last_decay_at = NOW()
                 WHERE couple_room_id = $1
                 RETURNING *`,
                [roomId, decay.health, decay.mood, decay.hunger, decay.cleanliness]
            );
            pet = updated.rows[0] || pet;

            // Check for critical alerts
            if (decay.health < 20 || decay.mood < 20 || decay.hunger < 20 || decay.cleanliness < 20) {
                const io = getIO();
                if (io) {
                    io.to(`room:${roomId}`).emit('pet:alert', {
                        petName: pet.pet_name,
                        health: pet.health,
                        mood: pet.mood,
                        hunger: pet.hunger,
                        cleanliness: pet.cleanliness,
                    });
                }
            }

            // Check pet death
            if (isPetDead(pet)) {
                await applyDeathPenalty(roomId, pet);
                // Re-fetch after penalty
                const refreshed = await query('SELECT * FROM couple_pet WHERE couple_room_id = $1', [roomId]);
                pet = refreshed.rows[0] || pet;
            }
        }

        // Count today's actions
        const myActionsToday = await countTodayActions(roomId, userId);
        const partnerActionsToday = partnerId ? await countTodayActions(roomId, partnerId) : 0;

        // Check daily reward
        const dailyReward = await checkDailyReward(roomId, userId);

        // Fetch currency and inventory
        const roomData = await query('SELECT love_coins FROM couple_rooms WHERE id = $1', [roomId]);
        const loveCoins = roomData.rows[0]?.love_coins || 0;

        const invData = await query('SELECT item_id, quantity FROM pet_inventory WHERE couple_room_id = $1', [roomId]);
        const inventory = invData.rows.map(r => ({ id: r.item_id, qty: r.quantity }));
        const expedition = await getCurrentExpedition(roomId);

        const responseData = formatPetResponse(
            pet,
            myActionsToday,
            partnerActionsToday,
            loveCoins,
            inventory,
            expedition
        );

        return res.json({
            data: responseData,
            meta: {
                dailyReward,
            }
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Apply death penalty: reset stats to 30, lose 1 evolution level, lose XP.
 */
async function applyDeathPenalty(coupleRoomId, pet) {
    const newXp = Math.max(pet.total_love_xp - DEATH_XP_PENALTY, 0);
    const newLevel = Math.max(computeLevel(newXp), 1);

    await query(
        `UPDATE couple_pet
         SET health = 30, mood = 30, hunger = 30, cleanliness = 30,
             total_love_xp = $2, evolution_level = $3,
             requires_evolution_stone = false,
             last_decay_at = NOW()
         WHERE couple_room_id = $1`,
        [coupleRoomId, newXp, newLevel]
    );

    logger.warn(`[Pet] Pet death in room ${coupleRoomId}! XP: ${pet.total_love_xp} → ${newXp}, Level: ${pet.evolution_level} → ${newLevel}`);

    const io = getIO();
    if (io) {
        io.to(`room:${coupleRoomId}`).emit('pet:alert', {
            type: 'death',
            message: `${pet.pet_name} đã kiệt sức! Mất ${DEATH_XP_PENALTY} XP 😢`,
            petName: pet.pet_name,
            oldLevel: pet.evolution_level,
            newLevel,
            xpLost: DEATH_XP_PENALTY,
        });
    }

    // Send push to both partners
    await sendCriticalAlerts(coupleRoomId, { ...pet, health: 0, mood: 0, hunger: 0, cleanliness: 0 });
}

/**
 * POST /api/couple/pet/:action — Perform a care action
 */
async function performAction(req, res, next) {
    try {
        const { action } = req.params;
        if (!VALID_ACTIONS.includes(action)) {
            return res.status(400).json({ error: `Hành động không hợp lệ. Chọn: ${VALID_ACTIONS.join(', ')}` });
        }

        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const config = ACTION_CONFIG[action];
        const requestedItemId = typeof req.body?.itemId === 'string'
            ? req.body.itemId.trim().toLowerCase()
            : null;

        const result = await transaction(async (client) => {
            // 1. Get or create pet
            let pet = await ensurePet(roomId, client);

            // Serialize room actions to avoid duplicate bonus/race issues.
            await client.query('SELECT id FROM couple_rooms WHERE id = $1 FOR UPDATE', [roomId]);

            // 2. Apply pending decay first
            const decay = computeDecay(pet);
            if (decay.decayApplied) {
                const decayed = await client.query(
                    `UPDATE couple_pet
                     SET health = $2, mood = $3, hunger = $4, cleanliness = $5,
                         last_decay_at = NOW()
                     WHERE couple_room_id = $1
                     RETURNING *`,
                    [roomId, decay.health, decay.mood, decay.hunger, decay.cleanliness]
                );
                pet = decayed.rows[0] || pet;
            }

            // Prevent care actions while the pet is actively exploring.
            const expedition = await getCurrentExpedition(roomId, client);
            if (expedition?.status === 'exploring') {
                const err = new Error('Pet đang đi viễn chinh, hãy chờ pet trở về nhé!');
                err.statusCode = 400;
                throw err;
            }

            // 3. Check cooldown
            const cooldowns = buildCooldowns(pet);
            if (!cooldowns[action].ready) {
                const err = new Error(`${pet.pet_name} cần nghỉ ngơi! Thử lại sau.`);
                err.statusCode = 429;
                throw err;
            }

            // 4. Check items
            let consumedItemId = null;
            const reqItem = config.reqItem;
            if (action === 'feed') {
                if (requestedItemId && !FEED_ITEM_IDS.includes(requestedItemId)) {
                    const err = new Error('Loại thức ăn không hợp lệ. Chỉ hỗ trợ basic_food hoặc premium_food.');
                    err.statusCode = 400;
                    throw err;
                }

                const preferredItems = requestedItemId ? [requestedItemId] : FEED_ITEM_IDS;
                const invCheck = await client.query(
                    `SELECT item_id, quantity
                     FROM pet_inventory
                     WHERE couple_room_id = $1 AND item_id = ANY($2::varchar[])`,
                    [roomId, preferredItems]
                );

                const quantities = Object.fromEntries(
                    invCheck.rows.map((row) => [row.item_id, row.quantity])
                );

                consumedItemId = preferredItems.find((itemId) => (quantities[itemId] || 0) > 0) || null;
                if (!consumedItemId) {
                    const err = new Error(
                        requestedItemId
                            ? 'Vật phẩm này đã hết. Hãy mua thêm ở Shop.'
                            : 'Cặp đôi đã hết thức ăn! Hãy mua thêm ở Shop.'
                    );
                    err.statusCode = 400;
                    throw err;
                }

                await client.query(
                    `UPDATE pet_inventory
                     SET quantity = quantity - 1
                     WHERE couple_room_id = $1 AND item_id = $2`,
                    [roomId, consumedItemId]
                );
            } else if (reqItem) {
                const invCheck = await client.query(
                    `SELECT quantity FROM pet_inventory WHERE couple_room_id = $1 AND item_id = $2`,
                    [roomId, reqItem]
                );
                const qty = invCheck.rows[0]?.quantity || 0;
                if (qty <= 0) {
                    const err = new Error(`Cặp đôi đã hết vật phẩm hỗ trợ! Hãy mua thêm ở Shop.`);
                    err.statusCode = 400;
                    throw err;
                }
                // Consume item
                await client.query(
                    `UPDATE pet_inventory SET quantity = quantity - 1 WHERE couple_room_id = $1 AND item_id = $2`,
                    [roomId, reqItem]
                );
                consumedItemId = reqItem;
            }

            // 5. Check daily action cap (now reduced to 6 per person for RPG tightness)
            const RPG_ACTION_CAP = 6;
            const myToday = await countTodayActions(roomId, userId, client);
            if (myToday >= RPG_ACTION_CAP) {
                const err = new Error(`Bạn đã chăm sóc quá ${RPG_ACTION_CAP} lần hôm nay! Thú cưng cũng cần ngủ để phát triển.`);
                err.statusCode = 429;
                throw err;
            }

            // 6. Calculate Yin-yang penalty
            const totalCare = pet.user1_interactions + pet.user2_interactions;
            let xpMultiplier = 1;
            if (totalCare > 20) {
                const ratio = Math.max(pet.user1_interactions, pet.user2_interactions) / totalCare;
                if (ratio > 0.75) {
                    xpMultiplier = 0.5; // Imbalance penalty
                }
            }

            // 5. Calculate new stats — use premium config when applicable
            const effectiveConfig = (action === 'feed' && consumedItemId === 'premium_food')
                ? { ...config, statDeltas: PREMIUM_FEED_CONFIG.statDeltas, xp: PREMIUM_FEED_CONFIG.xp }
                : config;

            const newStats = {
                health: Math.min((pet.health || 0) + (effectiveConfig.statDeltas.health || 0), 100),
                mood: Math.min((pet.mood || 0) + (effectiveConfig.statDeltas.mood || 0), 100),
                hunger: Math.min((pet.hunger || 0) + (effectiveConfig.statDeltas.hunger || 0), 100),
                cleanliness: Math.min((pet.cleanliness || 0) + (effectiveConfig.statDeltas.cleanliness || 0), 100),
            };

            // Calculate XP and apply evolution gate.
            // XP is capped at the current level threshold until the couple evolves.
            const oldLevel = pet.evolution_level;
            let newLevel = oldLevel;
            let requiresEvolutionStone = pet.requires_evolution_stone;
            let evolved = false;

            let xpAwarded = Math.floor(effectiveConfig.xp * xpMultiplier);
            const nextThreshold = oldLevel < LEVEL_THRESHOLDS.length
                ? LEVEL_THRESHOLDS[oldLevel]
                : null;

            if (nextThreshold !== null) {
                // Already locked at the threshold until users consume an evolution stone.
                if (requiresEvolutionStone || pet.total_love_xp >= nextThreshold) {
                    requiresEvolutionStone = true;
                    xpAwarded = 0;
                } else {
                    // Clamp XP gain to threshold so users don't lose all progress in one action.
                    const cappedXp = Math.min(
                        pet.total_love_xp + xpAwarded,
                        nextThreshold
                    ) - pet.total_love_xp;

                    xpAwarded = Math.max(cappedXp, 0);

                    if (pet.total_love_xp + xpAwarded >= nextThreshold) {
                        requiresEvolutionStone = true;
                    }
                }
            }

            const finalTotalXp = pet.total_love_xp + xpAwarded;

            // 7. Determine which timestamp to update
            const lastAtColumn = {
                feed: 'last_fed_at',
                pet: 'last_petted_at',
                bathe: 'last_bathed_at',
                play: 'last_played_at',
            }[action];

            // Update user interactions logically
            // We assume user1 is the one who created room or who is user_a in couple_rooms.
            // Simplified: we just blindly increment since we just need the ratio of user1/user2.
            // We'll query if userId == user_a_id.
            const isUserA = (await client.query('SELECT user_a_id FROM couple_rooms WHERE id = $1', [roomId])).rows[0].user_a_id === userId;
            const incA = isUserA ? 1 : 0;
            const incB = !isUserA ? 1 : 0;

            // 8. Update pet in DB
            const updated = await client.query(
                `UPDATE couple_pet
                 SET health = $2, mood = $3, hunger = $4, cleanliness = $5,
                     total_love_xp = $6, evolution_level = $7,
                     requires_evolution_stone = $8,
                     user1_interactions = user1_interactions + $9,
                     user2_interactions = user2_interactions + $10,
                     ${lastAtColumn} = NOW(),
                     last_decay_at = NOW()
                 WHERE couple_room_id = $1
                 RETURNING *`,
                [roomId, newStats.health, newStats.mood, newStats.hunger, newStats.cleanliness,
                    finalTotalXp, newLevel, requiresEvolutionStone, incA, incB]
            );
            pet = updated.rows[0];

            // 9. Log the action
            const statChanges = {};
            for (const [stat, delta] of Object.entries(effectiveConfig.statDeltas)) {
                statChanges[stat] = `+${delta}`;
            }

            await client.query(
                `INSERT INTO pet_care_actions (id, couple_room_id, user_id, action_type, xp_awarded, stat_changes)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [uuidv4(), roomId, userId, action, xpAwarded, JSON.stringify(statChanges)]
            );

            const myTodayAfter = myToday + 1;
            const todayKey = toUTCDateKey();

            let cooperativeBonus = false;
            let firstCareBonusAwarded = false;

            // First-care bonus: idempotent per user/day.
            if (myTodayAfter === 1) {
                const firstCareLog = await client.query(
                    `INSERT INTO coin_reward_logs (couple_room_id, reward_type, reward_key, coins_awarded, awarded_by, metadata)
                     VALUES ($1, 'pet_first_care', $2, $3, $4, $5::jsonb)
                     ON CONFLICT (couple_room_id, reward_type, reward_key) DO NOTHING
                     RETURNING id`,
                    [
                        roomId,
                        `pet_first_care_${todayKey}_${userId}`,
                        PET_FIRST_CARE_COIN_BONUS,
                        userId,
                        JSON.stringify({ source: 'pet_action', action }),
                    ]
                );
                firstCareBonusAwarded = firstCareLog.rows.length > 0;

                if (firstCareBonusAwarded) {
                    logger.info(`[Pet] First care of day bonus +${PET_FIRST_CARE_COIN_BONUS} coins for user ${userId}`);
                }
            }

            // Cooperative bonus: idempotent per room/day once both partners have acted.
            const contributorsRes = await client.query(
                `SELECT COUNT(DISTINCT user_id)::int AS contributors
                 FROM pet_care_actions
                 WHERE couple_room_id = $1
                   AND action_type IN ('feed', 'pet', 'bathe', 'play')
                   AND (created_at AT TIME ZONE 'UTC')::date = CURRENT_DATE`,
                [roomId]
            );

            const contributorsToday = contributorsRes.rows[0]?.contributors || 0;
            if (contributorsToday >= 2) {
                const cooperativeLog = await client.query(
                    `INSERT INTO coin_reward_logs (couple_room_id, reward_type, reward_key, coins_awarded, awarded_by, metadata)
                     VALUES ($1, 'pet_coop', $2, $3, $4, $5::jsonb)
                     ON CONFLICT (couple_room_id, reward_type, reward_key) DO NOTHING
                     RETURNING id`,
                    [
                        roomId,
                        `pet_coop_${todayKey}`,
                        PET_COOP_COIN_BONUS,
                        userId,
                        JSON.stringify({ source: 'pet_action', action }),
                    ]
                );

                if (cooperativeLog.rows.length > 0) {
                    cooperativeBonus = true;
                    let bonusXp = COOPERATIVE_BONUS_XP;
                    const coopThreshold = pet.evolution_level < LEVEL_THRESHOLDS.length
                        ? LEVEL_THRESHOLDS[pet.evolution_level]
                        : null;

                    let requiresStoneAfterBonus = pet.requires_evolution_stone;
                    if (coopThreshold !== null) {
                        if (requiresStoneAfterBonus || pet.total_love_xp >= coopThreshold) {
                            requiresStoneAfterBonus = true;
                            bonusXp = 0;
                        } else {
                            const remainingToThreshold = coopThreshold - pet.total_love_xp;
                            bonusXp = Math.min(bonusXp, remainingToThreshold);
                            if (pet.total_love_xp + bonusXp >= coopThreshold) {
                                requiresStoneAfterBonus = true;
                            }
                        }
                    }

                    const bonusUpdate = await client.query(
                        `UPDATE couple_pet
                         SET total_love_xp = total_love_xp + $2,
                             requires_evolution_stone = $3
                         WHERE couple_room_id = $1
                         RETURNING total_love_xp, requires_evolution_stone`,
                        [roomId, bonusXp, requiresStoneAfterBonus]
                    );

                    await client.query(
                        `INSERT INTO pet_care_actions (id, couple_room_id, user_id, action_type, xp_awarded, stat_changes)
                         VALUES ($1, $2, $3, 'cooperative_bonus', $4, '{"bonus": "both_contributed"}'::jsonb)`,
                        [uuidv4(), roomId, userId, bonusXp]
                    );
                    pet.total_love_xp = bonusUpdate.rows[0]?.total_love_xp ?? ((pet.total_love_xp || 0) + bonusXp);
                    pet.requires_evolution_stone = bonusUpdate.rows[0]?.requires_evolution_stone ?? requiresStoneAfterBonus;
                    logger.info(`[Pet] Cooperative bonus +${bonusXp} XP for room ${roomId}`);
                }
            }

            const partnerId = await getPartnerId(roomId, userId, client);
            const partnerToday = partnerId ? await countTodayActions(roomId, partnerId, client) : 0;

            // 11. Award Love Coins for pet care
            let coinsEarned = PET_CARE_COIN_REWARD;

            // First-care-of-the-day bonus
            if (firstCareBonusAwarded) {
                coinsEarned += PET_FIRST_CARE_COIN_BONUS;
            }

            // Cooperative coin bonus
            if (cooperativeBonus) {
                coinsEarned += PET_COOP_COIN_BONUS;
                logger.info(`[Pet] Cooperative coin bonus +${PET_COOP_COIN_BONUS} coins for room ${roomId}`);
            }

            await client.query(
                `UPDATE couple_rooms SET love_coins = love_coins + $2 WHERE id = $1`,
                [roomId, coinsEarned]
            );
            logger.info(`[Pet] Awarded +${coinsEarned} Love Coins to room ${roomId}`);

            return {
                pet,
                xpAwarded,
                evolved,
                oldLevel,
                newLevel,
                myActionsToday: myTodayAfter,
                partnerActionsToday: partnerToday,
                cooperativeBonus,
                consumedItemId,
                coinsEarned,
            };
        });

        const { pet, xpAwarded, evolved, oldLevel, newLevel,
            myActionsToday, partnerActionsToday, cooperativeBonus, consumedItemId } = result;

        // Fetch currency and inventory again to reflect consumption
        const roomData = await query('SELECT love_coins FROM couple_rooms WHERE id = $1', [roomId]);
        const loveCoins = roomData.rows[0]?.love_coins || 0;

        const invData = await query('SELECT item_id, quantity FROM pet_inventory WHERE couple_room_id = $1', [roomId]);
        const inventory = invData.rows.map(r => ({ id: r.item_id, qty: r.quantity }));

        const responseData = formatPetResponse(pet, myActionsToday, partnerActionsToday, loveCoins, inventory);

        // Emit socket events
        const io = getIO();
        if (io) {
            // Full state update to the whole room
            io.to(`room:${roomId}`).emit('pet:updated', {
                ...responseData,
                action,
                xpDelta: xpAwarded,
                byUserId: userId,
                consumedItemId,
            });

            // Notify partner specifically
            const partnerId = await getPartnerId(roomId, userId);
            if (partnerId) {
                io.to(`user:${partnerId}`).emit('pet:partner_care', {
                    partnerName: req.dbUser.display_name,
                    action,
                    xpDelta: xpAwarded,
                    cooperativeBonus,
                });
            }

            // Evolution event
            if (evolved) {
                io.to(`room:${roomId}`).emit('pet:evolution', {
                    petName: pet.pet_name,
                    oldLevel,
                    newLevel,
                    totalXp: pet.total_love_xp,
                });
                logger.info(`[Pet] Evolution! Room ${roomId}: Level ${oldLevel} → ${newLevel}`);
            }
        }

        // Check achievements after action
        await checkAndUpdateAchievements(roomId);

        return res.json({
            data: responseData,
            meta: {
                action,
                xpAwarded,
                evolved,
                cooperativeBonus,
                consumedItemId,
                coinsEarned: result.coinsEarned || 0,
            },
        });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ error: err.message });
        }
        next(err);
    }
}

/**
 * POST /api/couple/pet/evolve — Consume an evolution stone to level up once.
 */
async function evolvePet(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;

        const result = await transaction(async (client) => {
            let pet = await ensurePet(roomId, client);
            const oldLevel = pet.evolution_level;

            if (oldLevel >= 8) {
                const err = new Error('Pet đã đạt cấp tối đa rồi!');
                err.statusCode = 400;
                throw err;
            }

            const nextThreshold = LEVEL_THRESHOLDS[oldLevel];
            if (pet.total_love_xp < nextThreshold) {
                const need = nextThreshold - pet.total_love_xp;
                const err = new Error(`Chưa đủ XP để tiến hóa. Cần thêm ${need} XP.`);
                err.statusCode = 400;
                throw err;
            }

            const stoneRes = await client.query(
                `SELECT quantity
                 FROM pet_inventory
                 WHERE couple_room_id = $1 AND item_id = 'evolution_stone'`,
                [roomId]
            );

            const stoneQty = stoneRes.rows[0]?.quantity || 0;
            if (stoneQty <= 0) {
                const err = new Error('Chưa có Đá Tiến Hóa. Hãy mua ở Cửa Hàng nhé!');
                err.statusCode = 400;
                throw err;
            }

            await client.query(
                `UPDATE pet_inventory
                 SET quantity = quantity - 1
                 WHERE couple_room_id = $1 AND item_id = 'evolution_stone'`,
                [roomId]
            );

            const newLevel = Math.min(oldLevel + 1, 8);

            // Small stat boost after evolving as a celebration reward.
            const boostedStats = {
                health: Math.min((pet.health || 0) + 10, 100),
                mood: Math.min((pet.mood || 0) + 10, 100),
                hunger: Math.min((pet.hunger || 0) + 10, 100),
                cleanliness: Math.min((pet.cleanliness || 0) + 10, 100),
            };

            const updated = await client.query(
                `UPDATE couple_pet
                 SET evolution_level = $2,
                     requires_evolution_stone = false,
                     health = $3,
                     mood = $4,
                     hunger = $5,
                     cleanliness = $6,
                     last_decay_at = NOW()
                 WHERE couple_room_id = $1
                 RETURNING *`,
                [
                    roomId,
                    newLevel,
                    boostedStats.health,
                    boostedStats.mood,
                    boostedStats.hunger,
                    boostedStats.cleanliness,
                ]
            );
            pet = updated.rows[0];

            await client.query(
                `INSERT INTO pet_care_actions (id, couple_room_id, user_id, action_type, xp_awarded, stat_changes)
                 VALUES ($1, $2, $3, 'evolve', 0, $4::jsonb)`,
                [
                    uuidv4(),
                    roomId,
                    userId,
                    JSON.stringify({ evolution: '+1', consumed: 'evolution_stone' }),
                ]
            );

            const invRes = await client.query(
                'SELECT item_id, quantity FROM pet_inventory WHERE couple_room_id = $1',
                [roomId]
            );
            const coinsRes = await client.query(
                'SELECT love_coins FROM couple_rooms WHERE id = $1',
                [roomId]
            );

            return {
                pet,
                oldLevel,
                newLevel,
                inventory: invRes.rows.map((r) => ({ id: r.item_id, qty: r.quantity })),
                loveCoins: coinsRes.rows[0]?.love_coins || 0,
            };
        });

        const partnerId = await getPartnerId(roomId, userId);
        const myActionsToday = await countTodayActions(roomId, userId);
        const partnerActionsToday = partnerId ? await countTodayActions(roomId, partnerId) : 0;

        const responseData = formatPetResponse(
            result.pet,
            myActionsToday,
            partnerActionsToday,
            result.loveCoins,
            result.inventory
        );

        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).emit('pet:updated', {
                ...responseData,
                action: 'evolve',
                xpDelta: 0,
                byUserId: userId,
            });

            io.to(`room:${roomId}`).emit('pet:evolution', {
                petName: result.pet.pet_name,
                oldLevel: result.oldLevel,
                newLevel: result.newLevel,
                totalXp: result.pet.total_love_xp,
            });

            io.to(`room:${roomId}`).emit('pet:inventory_update', {
                loveCoins: result.loveCoins,
                inventory: result.inventory,
            });

            if (partnerId) {
                io.to(`user:${partnerId}`).emit('pet:partner_care', {
                    partnerName: req.dbUser.display_name,
                    action: 'evolve',
                    xpDelta: 0,
                    cooperativeBonus: false,
                });
            }
        }

        // Check achievements after evolution
        await checkAndUpdateAchievements(roomId);

        return res.json({
            data: responseData,
            meta: {
                evolved: true,
                oldLevel: result.oldLevel,
                newLevel: result.newLevel,
            },
            message: `${result.pet.pet_name} đã tiến hóa lên Lv.${result.newLevel}!`,
        });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ error: err.message });
        }
        next(err);
    }
}

/**
 * PATCH /api/couple/pet/name — Rename the pet
 */
async function renamePet(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const { name } = req.body;

        if (!name || typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 64) {
            return res.status(400).json({ error: 'Tên pet phải từ 1−64 ký tự' });
        }

        const trimmed = name.trim();
        const result = await query(
            `UPDATE couple_pet SET pet_name = $2 WHERE couple_room_id = $1 RETURNING *`,
            [roomId, trimmed]
        );

        if (!result.rows.length) {
            return res.status(404).json({ error: 'Pet chưa tồn tại' });
        }

        const pet = result.rows[0];

        // Broadcast name change
        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).emit('pet:updated', {
                petName: pet.pet_name,
                action: 'rename',
                byUserId: userId,
            });
        }

        return res.json({
            data: { petName: pet.pet_name },
            message: `Đã đổi tên pet thành "${pet.pet_name}" 💕`,
        });
    } catch (err) {
        next(err);
    }
}

/**
 * GET /api/couple/pet/history — Recent care action log
 */
async function getActionHistory(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);

        const result = await query(
            `SELECT pca.id, pca.action_type, pca.xp_awarded, pca.stat_changes,
                    pca.created_at, pca.user_id,
                    u.display_name, u.photo_url
             FROM pet_care_actions pca
             JOIN users u ON u.id = pca.user_id
             WHERE pca.couple_room_id = $1
             ORDER BY pca.created_at DESC
             LIMIT $2`,
            [roomId, limit]
        );

        const actions = result.rows.map(row => ({
            id: row.id,
            actionType: row.action_type,
            xpAwarded: row.xp_awarded,
            statChanges: row.stat_changes,
            createdAt: row.created_at,
            user: {
                id: row.user_id,
                displayName: row.display_name,
                photoUrl: row.photo_url,
            },
        }));

        return res.json({ data: actions });
    } catch (err) {
        next(err);
    }
}

/**
 * POST /api/couple/pet/shop/buy — Buy item from shop
 */
async function buyShopItem(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const { itemId, quantity } = req.body;
        const qty = parseInt(quantity) || 1;

        const pricePerUnit = SHOP_PRICES[itemId];
        if (!pricePerUnit) {
            return res.status(400).json({ error: 'Mặt hàng không tồn tại trong Cửa Hàng' });
        }

        const totalPrice = pricePerUnit * qty;

        const result = await transaction(async (client) => {
            // Atomic deduction prevents race conditions when two purchases happen concurrently.
            const deductRes = await client.query(
                `UPDATE couple_rooms
                 SET love_coins = love_coins - $2
                 WHERE id = $1 AND love_coins >= $2
                 RETURNING love_coins`,
                [roomId, totalPrice]
            );

            if (!deductRes.rows.length) {
                const err = new Error(`Không đủ Love Coins! Cần ${totalPrice} 🪙`);
                err.statusCode = 400;
                throw err;
            }

            // Add item to inventory
            await client.query(
                `INSERT INTO pet_inventory (id, couple_room_id, item_id, quantity)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (couple_room_id, item_id) DO UPDATE SET quantity = pet_inventory.quantity + EXCLUDED.quantity`,
                [uuidv4(), roomId, itemId, qty]
            );

            // Track purchase progress for shopper achievements.
            await client.query(
                `INSERT INTO pet_care_actions (id, couple_room_id, user_id, action_type, xp_awarded, stat_changes)
                 VALUES ($1, $2, $3, 'shop_purchase', 0, $4::jsonb)`,
                [
                    uuidv4(),
                    roomId,
                    userId,
                    JSON.stringify({ itemId, quantity: qty, totalPrice }),
                ]
            );

            // Fetch inventory after purchase.
            const newInventoryRes = await client.query('SELECT item_id, quantity FROM pet_inventory WHERE couple_room_id = $1', [roomId]);

            return {
                loveCoins: deductRes.rows[0].love_coins,
                inventory: newInventoryRes.rows.map(r => ({ id: r.item_id, qty: r.quantity })),
            };
        });

        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).emit('pet:inventory_update', result);
        }

        // Check achievements after purchase
        await checkAndUpdateAchievements(roomId);

        return res.json({
            data: result,
            message: `Mua thành công ${qty} ${itemId}`
        });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ error: err.message });
        }
        next(err);
    }
}

// ═══════════════════════════════════════════════════════════════
//  Expedition (Viễn Chinh) System
// ═══════════════════════════════════════════════════════════════

const EXPEDITION_TYPES = {
    forest: { label: 'Rừng Thần Tiên', emoji: '🌲', minLevel: 1 },
    beach: { label: 'Bãi Biển Tình Yêu', emoji: '🏖️', minLevel: 2 },
    mountain: { label: 'Đỉnh Núi Mây', emoji: '⛰️', minLevel: 4 },
    cave: { label: 'Hang Đá Bí Ẩn', emoji: '🕳️', minLevel: 6 },
};

const EXPEDITION_DURATIONS = [4, 6, 8]; // hours

// Loot tables per expedition type + duration tier
const EXPEDITION_LOOT_TABLE = {
    forest: {
        common: [{ type: 'coins', amount: 12 }, { type: 'coins', amount: 16 }, { type: 'item', itemId: 'basic_food', qty: 1 }],
        uncommon: [{ type: 'coins', amount: 26 }, { type: 'item', itemId: 'basic_food', qty: 2 }, { type: 'item', itemId: 'basic_toy', qty: 1 }],
        rare: [{ type: 'coins', amount: 42 }, { type: 'item', itemId: 'premium_food', qty: 1 }, { type: 'item', itemId: 'basic_soap', qty: 2 }],
    },
    beach: {
        common: [{ type: 'coins', amount: 16 }, { type: 'item', itemId: 'basic_soap', qty: 1 }],
        uncommon: [{ type: 'coins', amount: 32 }, { type: 'item', itemId: 'premium_food', qty: 1 }, { type: 'item', itemId: 'basic_food', qty: 2 }],
        rare: [{ type: 'coins', amount: 60 }, { type: 'item', itemId: 'premium_food', qty: 2 }, { type: 'item', itemId: 'basic_toy', qty: 2 }],
    },
    mountain: {
        common: [{ type: 'coins', amount: 24 }, { type: 'item', itemId: 'basic_toy', qty: 1 }],
        uncommon: [{ type: 'coins', amount: 44 }, { type: 'item', itemId: 'premium_food', qty: 1 }, { type: 'item', itemId: 'basic_soap', qty: 2 }],
        rare: [{ type: 'coins', amount: 85 }, { type: 'item', itemId: 'evolution_stone', qty: 1 }],
    },
    cave: {
        common: [{ type: 'coins', amount: 34 }, { type: 'item', itemId: 'premium_food', qty: 1 }],
        uncommon: [{ type: 'coins', amount: 64 }, { type: 'item', itemId: 'premium_food', qty: 2 }, { type: 'item', itemId: 'basic_toy', qty: 2 }],
        rare: [{ type: 'coins', amount: 120 }, { type: 'item', itemId: 'evolution_stone', qty: 1 }, { type: 'item', itemId: 'premium_food', qty: 3 }],
    },
};

function rollLoot(expeditionType, durationHours, petLevel) {
    const table = EXPEDITION_LOOT_TABLE[expeditionType] || EXPEDITION_LOOT_TABLE.forest;
    const loot = [];

    // Duration determines number of loot rolls and rarity chances
    const rolls = durationHours === 4 ? 1 : durationHours === 6 ? 2 : 3;
    const rareChance = Math.min(0.05 + (petLevel * 0.02) + (durationHours === 8 ? 0.15 : durationHours === 6 ? 0.05 : 0), 0.4);
    const uncommonChance = rareChance + 0.35;

    for (let i = 0; i < rolls; i++) {
        const roll = Math.random();
        let tier;
        if (roll < rareChance) {
            tier = 'rare';
        } else if (roll < uncommonChance) {
            tier = 'uncommon';
        } else {
            tier = 'common';
        }
        const pool = table[tier];
        const item = pool[Math.floor(Math.random() * pool.length)];
        loot.push({ ...item, tier });
    }

    return loot;
}

/**
 * POST /api/couple/pet/expedition/start — Start a new expedition
 */
async function startExpedition(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;
        const userId = req.dbUser.id;
        const { type, duration } = req.body;

        const expType = EXPEDITION_TYPES[type] ? type : 'forest';
        const expDuration = EXPEDITION_DURATIONS.includes(parseInt(duration)) ? parseInt(duration) : 4;

        // Check if already on expedition
        const active = await query(
            `SELECT id FROM pet_expeditions WHERE couple_room_id = $1 AND status = 'exploring'`,
            [roomId]
        );
        if (active.rows.length > 0) {
            return res.status(400).json({ error: 'Pet đang đi viễn chinh rồi! Đợi pet về nhé.' });
        }

        // Check for uncollected expedition
        const uncollected = await query(
            `SELECT id FROM pet_expeditions WHERE couple_room_id = $1 AND status = 'returned'`,
            [roomId]
        );
        if (uncollected.rows.length > 0) {
            return res.status(400).json({ error: 'Pet đã về nhưng chưa nhận thưởng! Hãy thu thập loot trước.' });
        }

        // Check pet health requirements
        const pet = await ensurePet(roomId);
        if (pet.health < 30) {
            return res.status(400).json({ error: 'Pet quá yếu để đi viễn chinh. Cần sức khỏe ≥ 30.' });
        }
        if (pet.hunger < 20) {
            return res.status(400).json({ error: 'Pet quá đói để đi viễn chinh. Cần no bụng ≥ 20.' });
        }

        // Check level requirement for expedition type
        const typeConfig = EXPEDITION_TYPES[expType];
        if (pet.evolution_level < typeConfig.minLevel) {
            return res.status(400).json({
                error: `${typeConfig.label} yêu cầu pet Lv.${typeConfig.minLevel}+. Pet hiện tại Lv.${pet.evolution_level}.`
            });
        }

        // Roll loot ahead of time (stored encrypted, revealed on collect)
        const loot = rollLoot(expType, expDuration, pet.evolution_level);
        const endsAt = new Date(Date.now() + expDuration * 60 * 60 * 1000);

        const result = await query(
            `INSERT INTO pet_expeditions (couple_room_id, expedition_type, duration_hours, loot_data, ends_at, started_by)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6)
             RETURNING *`,
            [roomId, expType, expDuration, JSON.stringify(loot), endsAt.toISOString(), userId]
        );

        const expedition = result.rows[0];

        // Emit socket event
        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).emit('pet:expedition_update', {
                status: 'exploring',
                type: expType,
                typeLabel: typeConfig.label,
                typeEmoji: typeConfig.emoji,
                duration: expDuration,
                endsAt: endsAt.toISOString(),
                startedBy: req.dbUser.display_name,
            });
        }

        logger.info(`[Pet] Expedition started: room=${roomId}, type=${expType}, duration=${expDuration}h`);

        return res.json({
            data: {
                id: expedition.id,
                status: 'exploring',
                type: expType,
                typeLabel: typeConfig.label,
                typeEmoji: typeConfig.emoji,
                duration: expDuration,
                startedAt: expedition.started_at,
                endsAt: endsAt.toISOString(),
            },
            message: `${pet.pet_name} đã lên đường viễn chinh ${typeConfig.emoji} ${typeConfig.label}!`,
        });
    } catch (err) {
        next(err);
    }
}

/**
 * GET /api/couple/pet/expedition/status — Check current expedition
 */
async function getExpeditionStatus(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;

        // Auto-update expired expeditions to 'returned'
        await query(
            `UPDATE pet_expeditions SET status = 'returned'
             WHERE couple_room_id = $1 AND status = 'exploring' AND ends_at <= NOW()`,
            [roomId]
        );

        // Find active or returned
        const result = await query(
            `SELECT * FROM pet_expeditions
             WHERE couple_room_id = $1 AND status IN ('exploring', 'returned')
             ORDER BY created_at DESC LIMIT 1`,
            [roomId]
        );

        if (!result.rows.length) {
            return res.json({ data: { status: 'idle', expedition: null } });
        }

        const exp = result.rows[0];
        const typeConfig = EXPEDITION_TYPES[exp.expedition_type] || EXPEDITION_TYPES.forest;

        return res.json({
            data: {
                status: exp.status,
                expedition: {
                    id: exp.id,
                    type: exp.expedition_type,
                    typeLabel: typeConfig.label,
                    typeEmoji: typeConfig.emoji,
                    duration: exp.duration_hours,
                    startedAt: exp.started_at,
                    endsAt: exp.ends_at,
                    // Only reveal loot when status is 'returned'
                    loot: exp.status === 'returned' ? exp.loot_data : null,
                },
            },
        });
    } catch (err) {
        next(err);
    }
}

/**
 * POST /api/couple/pet/expedition/collect — Collect loot from returned expedition
 */
async function collectExpeditionLoot(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;

        const result = await transaction(async (client) => {
            // Auto-upgrade exploring → returned
            await client.query(
                `UPDATE pet_expeditions SET status = 'returned'
                 WHERE couple_room_id = $1 AND status = 'exploring' AND ends_at <= NOW()`,
                [roomId]
            );

            const expRes = await client.query(
                `SELECT * FROM pet_expeditions
                 WHERE couple_room_id = $1 AND status = 'returned'
                 ORDER BY created_at DESC LIMIT 1`,
                [roomId]
            );

            if (!expRes.rows.length) {
                const err = new Error('Không có viễn chinh nào cần thu thập!');
                err.statusCode = 400;
                throw err;
            }

            const exp = expRes.rows[0];
            const loot = exp.loot_data || [];

            // Apply loot rewards
            let totalCoins = 0;
            const itemRewards = {};

            for (const reward of loot) {
                if (reward.type === 'coins') {
                    totalCoins += reward.amount;
                } else if (reward.type === 'item') {
                    const key = reward.itemId;
                    itemRewards[key] = (itemRewards[key] || 0) + (reward.qty || 1);
                }
            }

            // Award coins
            if (totalCoins > 0) {
                await client.query(
                    `UPDATE couple_rooms SET love_coins = love_coins + $2 WHERE id = $1`,
                    [roomId, totalCoins]
                );
            }

            // Award items
            for (const [itemId, qty] of Object.entries(itemRewards)) {
                await client.query(
                    `INSERT INTO pet_inventory (id, couple_room_id, item_id, quantity)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (couple_room_id, item_id) DO UPDATE SET quantity = pet_inventory.quantity + EXCLUDED.quantity`,
                    [uuidv4(), roomId, itemId, qty]
                );
            }

            // Mark expedition as collected
            await client.query(
                `UPDATE pet_expeditions SET status = 'collected', collected_at = NOW() WHERE id = $1`,
                [exp.id]
            );

            // Fetch updated data
            const coinsRes = await client.query('SELECT love_coins FROM couple_rooms WHERE id = $1', [roomId]);
            const invRes = await client.query('SELECT item_id, quantity FROM pet_inventory WHERE couple_room_id = $1', [roomId]);

            return {
                loot,
                totalCoins,
                itemRewards,
                loveCoins: coinsRes.rows[0]?.love_coins || 0,
                inventory: invRes.rows.map(r => ({ id: r.item_id, qty: r.quantity })),
                expeditionType: exp.expedition_type,
            };
        });

        // Emit socket events
        const io = getIO();
        if (io) {
            io.to(`room:${roomId}`).emit('pet:expedition_update', {
                status: 'collected',
                loot: result.loot,
                totalCoins: result.totalCoins,
            });
            io.to(`room:${roomId}`).emit('pet:inventory_update', {
                loveCoins: result.loveCoins,
                inventory: result.inventory,
            });
        }

        // Check achievements after expedition
        await checkAndUpdateAchievements(roomId);

        logger.info(`[Pet] Expedition loot collected: room=${roomId}, coins=${result.totalCoins}`);

        return res.json({
            data: {
                loot: result.loot,
                totalCoins: result.totalCoins,
                itemRewards: result.itemRewards,
                loveCoins: result.loveCoins,
                inventory: result.inventory,
            },
            message: 'Pet đã mang quà về! 🎁',
        });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ error: err.message });
        }
        next(err);
    }
}

// ═══════════════════════════════════════════════════════════════
//  Achievement System
// ═══════════════════════════════════════════════════════════════

const ACHIEVEMENT_DEFINITIONS = [
    { id: 'first_care', label: '🥚 Người Mới', description: 'Chăm sóc pet lần đầu tiên', target: 1, coins: 10 },
    { id: 'caretaker_50', label: '🍼 Bảo Mẫu Siêng Năng', description: 'Chăm sóc pet 50 lần', target: 50, coins: 50 },
    { id: 'caretaker_200', label: '👨‍⚕️ Bác Sĩ Thú Y', description: 'Chăm sóc pet 200 lần', target: 200, coins: 150 },
    { id: 'first_evolution', label: '💎 Tiến Hóa Lần Đầu', description: 'Tiến hóa pet lần đầu tiên', target: 1, coins: 30 },
    { id: 'max_evolution', label: '🌟 Hình Thái Cuối Cùng', description: 'Pet đạt cấp tiến hóa tối đa (Lv.8)', target: 8, coins: 500 },
    { id: 'explorer_10', label: '🏔️ Nhà Thám Hiểm', description: 'Hoàn thành 10 cuộc viễn chinh', target: 10, coins: 80 },
    { id: 'explorer_50', label: '🗺️ Phượt Thủ Chuyên Nghiệp', description: 'Hoàn thành 50 cuộc viễn chinh', target: 50, coins: 300 },
    { id: 'rich_1000', label: '💰 Đại Gia', description: 'Sở hữu 1000 Love Coins cùng lúc', target: 1000, coins: 100 },
    { id: 'balance_7', label: '⚖️ Cân Bằng Hoàn Hảo', description: 'Giữ Yin-Yang balance 7 ngày liên tiếp', target: 7, coins: 120 },
    { id: 'pet_age_30', label: '🎂 1 Tháng Bên Nhau', description: 'Nuôi pet đạt 30 ngày tuổi', target: 30, coins: 60 },
    { id: 'pet_age_100', label: '💝 100 Ngày Yêu Thương', description: 'Nuôi pet đạt 100 ngày tuổi', target: 100, coins: 200 },
    { id: 'shopper_20', label: '🛍️ Tín Đồ Mua Sắm', description: 'Mua 20 vật phẩm từ cửa hàng', target: 20, coins: 40 },
];

/**
 * Check and update achievements for a couple room.
 * Called after significant actions (care, evolve, expedition collect, buy).
 */
async function checkAndUpdateAchievements(coupleRoomId) {
    try {
        // Fetch current stats
        const [petRes, actionsRes, expeditionsRes, purchasesRes, coinsRes, balanceRes] = await Promise.all([
            query('SELECT * FROM couple_pet WHERE couple_room_id = $1', [coupleRoomId]),
            query(`SELECT COUNT(*)::int AS cnt FROM pet_care_actions WHERE couple_room_id = $1 AND action_type IN ('feed', 'pet', 'bathe', 'play')`, [coupleRoomId]),
            query(`SELECT COUNT(*)::int AS cnt FROM pet_expeditions WHERE couple_room_id = $1 AND status = 'collected'`, [coupleRoomId]),
            query(`SELECT COUNT(*)::int AS cnt FROM pet_care_actions WHERE couple_room_id = $1 AND action_type = 'shop_purchase'`, [coupleRoomId]),
            query('SELECT love_coins FROM couple_rooms WHERE id = $1', [coupleRoomId]),
            query(
                `SELECT (created_at AT TIME ZONE 'UTC')::date AS day, user_id, COUNT(*)::int AS cnt
                 FROM pet_care_actions
                 WHERE couple_room_id = $1
                   AND action_type IN ('feed', 'pet', 'bathe', 'play')
                   AND (created_at AT TIME ZONE 'UTC')::date >= (CURRENT_DATE - INTERVAL '30 days')
                 GROUP BY (created_at AT TIME ZONE 'UTC')::date, user_id
                 ORDER BY day DESC`,
                [coupleRoomId]
            ),
        ]);

        const pet = petRes.rows[0];
        if (!pet) return;

        const totalCareActions = actionsRes.rows[0]?.cnt || 0;
        const totalExpeditions = expeditionsRes.rows[0]?.cnt || 0;
        const totalPurchases = purchasesRes.rows[0]?.cnt || 0;
        const currentCoins = coinsRes.rows[0]?.love_coins || 0;
        const petAge = Math.floor((Date.now() - new Date(pet.created_at).getTime()) / (1000 * 60 * 60 * 24));
        const balancedStreak = computeBalancedStreakFromRows(balanceRes.rows);

        // Calculate progress for each achievement
        const progressMap = {
            first_care: totalCareActions,
            caretaker_50: totalCareActions,
            caretaker_200: totalCareActions,
            first_evolution: Math.max(pet.evolution_level - 1, 0),
            max_evolution: pet.evolution_level,
            explorer_10: totalExpeditions,
            explorer_50: totalExpeditions,
            rich_1000: currentCoins,
            balance_7: balancedStreak,
            pet_age_30: petAge,
            pet_age_100: petAge,
            shopper_20: totalPurchases,
        };

        const newlyUnlocked = [];

        for (const def of ACHIEVEMENT_DEFINITIONS) {
            const progress = Math.min(progressMap[def.id] || 0, def.target);

            // Upsert achievement row
            const upsertRes = await query(
                `INSERT INTO pet_achievements (couple_room_id, achievement_id, progress, target, unlocked, unlocked_at, coins_rewarded)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (couple_room_id, achievement_id) DO UPDATE
                 SET progress = GREATEST(pet_achievements.progress, EXCLUDED.progress),
                     unlocked = (GREATEST(pet_achievements.progress, EXCLUDED.progress) >= pet_achievements.target),
                     unlocked_at = CASE
                        WHEN pet_achievements.unlocked_at IS NULL
                         AND GREATEST(pet_achievements.progress, EXCLUDED.progress) >= pet_achievements.target
                        THEN NOW()
                        ELSE pet_achievements.unlocked_at
                     END,
                     updated_at = NOW()
                 RETURNING *`,
                [
                    coupleRoomId,
                    def.id,
                    progress,
                    def.target,
                    progress >= def.target,
                    progress >= def.target ? new Date().toISOString() : null,
                    0, // coins not yet rewarded
                ]
            );

            const row = upsertRes.rows[0];

            // Award coins exactly once even under concurrent checks.
            const rewardRes = await query(
                `UPDATE pet_achievements
                 SET coins_rewarded = $3,
                     updated_at = NOW()
                 WHERE couple_room_id = $1
                   AND achievement_id = $2
                   AND unlocked = TRUE
                   AND coins_rewarded = 0
                 RETURNING achievement_id`,
                [coupleRoomId, def.id, def.coins]
            );

            if (row && rewardRes.rows.length > 0) {
                // Award coins
                await query(
                    `UPDATE couple_rooms SET love_coins = love_coins + $2 WHERE id = $1`,
                    [coupleRoomId, def.coins]
                );
                newlyUnlocked.push({ ...def, progress });
                logger.info(`[Pet] Achievement unlocked: ${def.id} for room ${coupleRoomId}, +${def.coins} coins`);
            }
        }

        // Emit socket event for newly unlocked achievements
        if (newlyUnlocked.length > 0) {
            const io = getIO();
            if (io) {
                io.to(`room:${coupleRoomId}`).emit('pet:achievement_unlocked', {
                    achievements: newlyUnlocked,
                });
            }
        }

        return newlyUnlocked;
    } catch (err) {
        logger.error(`[Pet] Achievement check error: ${err.message}`);
        return [];
    }
}

/**
 * GET /api/couple/pet/achievements — List all achievements with progress
 */
async function getAchievements(req, res, next) {
    try {
        const roomId = req.coupleRoom.id;

        // Run achievement check first to ensure they're up-to-date
        await checkAndUpdateAchievements(roomId);

        const result = await query(
            'SELECT * FROM pet_achievements WHERE couple_room_id = $1 ORDER BY unlocked DESC, achievement_id',
            [roomId]
        );

        const achievementsMap = {};
        for (const row of result.rows) {
            achievementsMap[row.achievement_id] = row;
        }

        const achievements = ACHIEVEMENT_DEFINITIONS.map(def => {
            const row = achievementsMap[def.id];
            return {
                id: def.id,
                label: def.label,
                description: def.description,
                target: def.target,
                coinReward: def.coins,
                progress: row?.progress || 0,
                unlocked: row?.unlocked || false,
                unlockedAt: row?.unlocked_at || null,
            };
        });

        return res.json({ data: achievements });
    } catch (err) {
        next(err);
    }
}

// ═══════════════════════════════════════════════════════════════
//  Daily Login Reward
// ═══════════════════════════════════════════════════════════════

const DAILY_REWARD_SCHEDULE = [8, 10, 12, 15, 18, 22, 28]; // Day 1-7 coin rewards
const DAILY_REWARD_WEEKLY_BONUS = 25; // Bonus on each 7-day milestone

/**
 * Check and award daily login reward. Called from getPetState.
 * Returns reward info if awarded, null otherwise.
 */
async function checkDailyReward(coupleRoomId, userId) {
    try {
        const todayKey = toUTCDateKey();
        const rewardKey = `daily_${todayKey}`;

        return await transaction(async (client) => {
            // Calculate streak from previous daily claim logs.
            const recentRewards = await client.query(
                `SELECT reward_key FROM coin_reward_logs
                 WHERE couple_room_id = $1 AND reward_type = 'daily_login'
                 ORDER BY created_at DESC LIMIT 30`,
                [coupleRoomId]
            );

            let streak = 0;
            const today = new Date();
            for (let i = 1; i <= 30; i++) {
                const checkDate = new Date(today);
                checkDate.setUTCDate(checkDate.getUTCDate() - i);
                const checkKey = `daily_${toUTCDateKey(checkDate)}`;
                if (recentRewards.rows.some((r) => r.reward_key === checkKey)) {
                    streak++;
                } else {
                    break;
                }
            }

            const nextStreak = streak + 1;
            const dayIndex = Math.min(streak, DAILY_REWARD_SCHEDULE.length - 1);
            let coinsAwarded = DAILY_REWARD_SCHEDULE[dayIndex];

            // Weekly bonus on each 7-day streak milestone.
            const isWeeklyBonus = nextStreak % 7 === 0;
            if (isWeeklyBonus) {
                coinsAwarded += DAILY_REWARD_WEEKLY_BONUS;
            }

            // Atomic claim gate. If another request already claimed today, skip awarding.
            const insertRes = await client.query(
                `INSERT INTO coin_reward_logs (couple_room_id, reward_type, reward_key, coins_awarded, awarded_by)
                 VALUES ($1, 'daily_login', $2, $3, $4)
                 ON CONFLICT (couple_room_id, reward_type, reward_key) DO NOTHING
                 RETURNING id`,
                [coupleRoomId, rewardKey, coinsAwarded, userId]
            );

            if (!insertRes.rows.length) {
                return null;
            }

            await client.query(
                `UPDATE couple_rooms SET love_coins = love_coins + $2 WHERE id = $1`,
                [coupleRoomId, coinsAwarded]
            );

            logger.info(`[Pet] Daily reward: room=${coupleRoomId}, streak=${nextStreak}, coins=${coinsAwarded}`);

            return {
                coinsAwarded,
                streak: nextStreak,
                isWeeklyBonus,
            };
        });
    } catch (err) {
        logger.error(`[Pet] Daily reward error: ${err.message}`);
        return null;
    }
}

module.exports = {
    getPetState,
    performAction,
    evolvePet,
    renamePet,
    getActionHistory,
    buyShopItem,
    // Expedition
    startExpedition,
    getExpeditionStatus,
    collectExpeditionLoot,
    // Achievements
    getAchievements,
    checkAndUpdateAchievements,
    // Daily reward
    checkDailyReward,
    // Exported for use by other modules (decay job, couple controller)
    ensurePet,
    computeDecay,
    buildCooldowns,
    formatPetResponse,
    computeLevel,
    sendCriticalAlerts,
    isPetDead,
    applyDeathPenalty,
    LEVEL_THRESHOLDS,
    DECAY_INTERVAL_HOURS,
    DECAY_PER_INTERVAL,
    EXPEDITION_TYPES,
    ACHIEVEMENT_DEFINITIONS,
};
