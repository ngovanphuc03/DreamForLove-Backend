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
function formatPetResponse(pet, myActionsToday, partnerActionsToday, loveCoins = 0, inventory = []) {
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
async function getPartnerId(coupleRoomId, userId) {
    const result = await query(
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

        // Fetch currency and inventory
        const roomData = await query('SELECT love_coins FROM couple_rooms WHERE id = $1', [roomId]);
        const loveCoins = roomData.rows[0]?.love_coins || 0;

        const invData = await query('SELECT item_id, quantity FROM pet_inventory WHERE couple_room_id = $1', [roomId]);
        const inventory = invData.rows.map(r => ({ id: r.item_id, qty: r.quantity }));

        return res.json({
            data: formatPetResponse(pet, myActionsToday, partnerActionsToday, loveCoins, inventory),
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

            // 5. Calculate new stats
            const newStats = {
                health: Math.min((pet.health || 0) + (config.statDeltas.health || 0), 100),
                mood: Math.min((pet.mood || 0) + (config.statDeltas.mood || 0), 100),
                hunger: Math.min((pet.hunger || 0) + (config.statDeltas.hunger || 0), 100),
                cleanliness: Math.min((pet.cleanliness || 0) + (config.statDeltas.cleanliness || 0), 100),
            };

            // Calculate XP and apply evolution gate.
            // XP is capped at the current level threshold until the couple evolves.
            const oldLevel = pet.evolution_level;
            let newLevel = oldLevel;
            let requiresEvolutionStone = pet.requires_evolution_stone;
            let evolved = false;

            let xpAwarded = Math.floor(config.xp * xpMultiplier);
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
            for (const [stat, delta] of Object.entries(config.statDeltas)) {
                statChanges[stat] = `+${delta}`;
            }

            await client.query(
                `INSERT INTO pet_care_actions (id, couple_room_id, user_id, action_type, xp_awarded, stat_changes)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [uuidv4(), roomId, userId, action, xpAwarded, JSON.stringify(statChanges)]
            );

            // 10. Check cooperative bonus
            const partnerId = await getPartnerId(roomId, userId);
            const partnerToday = partnerId ? await countTodayActions(roomId, partnerId, client) : 0;
            const myTodayAfter = myToday + 1;

            let cooperativeBonus = false;
            // Award bonus if: this is the first action from either side that completes the "both contributed" condition
            if (partnerId && partnerToday > 0 && myTodayAfter === 1) {
                cooperativeBonus = true;
                const bonusXp = COOPERATIVE_BONUS_XP;
                await client.query(
                    `UPDATE couple_pet SET total_love_xp = total_love_xp + $2 WHERE couple_room_id = $1`,
                    [roomId, bonusXp]
                );
                await client.query(
                    `INSERT INTO pet_care_actions (id, couple_room_id, user_id, action_type, xp_awarded, stat_changes)
                     VALUES ($1, $2, $3, 'cooperative_bonus', $4, '{"bonus": "both_contributed"}'::jsonb)`,
                    [uuidv4(), roomId, userId, bonusXp]
                );
                logger.info(`[Pet] Cooperative bonus +${bonusXp} XP for room ${roomId}`);
            }

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

        return res.json({
            data: responseData,
            meta: {
                action,
                xpAwarded,
                evolved,
                cooperativeBonus,
                consumedItemId,
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
        const { itemId, quantity } = req.body;
        const qty = parseInt(quantity) || 1;

        const SHOP_PRICES = {
            basic_food: 10,
            basic_soap: 15,
            basic_toy: 15,
            premium_food: 30,
            evolution_stone: 500, // Very expensive
        };

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

module.exports = {
    getPetState,
    performAction,
    evolvePet,
    renamePet,
    getActionHistory,
    buyShopItem,
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
};
