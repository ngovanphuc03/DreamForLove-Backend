const cron = require('node-cron');
const { query, transaction } = require('../config/database');
const logger = require('../config/logger');

/**
 * Hard-delete couple_rooms (and their child data) that were soft-deleted
 * more than 30 days ago.
 *
 * Schedule: runs every day at 02:00 UTC.
 */
function startCleanupJob() {
    cron.schedule('0 2 * * *', async () => {
        logger.info('[Cron] Running couple_room hard-delete cleanup…');
        try {
            await transaction(async (client) => {
                // 1. Identify rooms to purge (delete_after has passed)
                const expired = await client.query(
                    `SELECT id FROM couple_rooms
                     WHERE status = 'inactive'
                       AND delete_after IS NOT NULL
                       AND delete_after < NOW()`
                );

                if (!expired.rows.length) {
                    logger.info('[Cron] No rooms to purge.');
                    return;
                }

                const roomIds = expired.rows.map((r) => r.id);
                logger.info(`[Cron] Purging ${roomIds.length} room(s): ${roomIds.join(', ')}`);

                // 2. Delete child data in dependency order
                await client.query(
                    'DELETE FROM mood_logs     WHERE couple_room_id = ANY($1::uuid[])',
                    [roomIds]
                );
                await client.query(
                    'DELETE FROM wish_items    WHERE couple_room_id = ANY($1::uuid[])',
                    [roomIds]
                );
                await client.query(
                    'DELETE FROM food_items    WHERE couple_room_id = ANY($1::uuid[])',
                    [roomIds]
                );
                await client.query(
                    'DELETE FROM pet_care_actions WHERE couple_room_id = ANY($1::uuid[])',
                    [roomIds]
                );
                await client.query(
                    'DELETE FROM couple_pet    WHERE couple_room_id = ANY($1::uuid[])',
                    [roomIds]
                );

                // 3. Delete the rooms themselves
                const del = await client.query(
                    'DELETE FROM couple_rooms WHERE id = ANY($1::uuid[]) RETURNING id',
                    [roomIds]
                );

                logger.info(`[Cron] Purged ${del.rowCount} couple_room(s) and all child data.`);
            });
        } catch (err) {
            if (process.env.NODE_ENV !== 'production' && err.code === 'ECONNREFUSED') {
                return; // DB not available in dev
            }
            logger.error(`[Cron] Cleanup job failed: ${err.message}`, { stack: err.stack });
        }
    }, {
        scheduled: true,
        timezone: 'UTC',
    });

    logger.info('[Cron] Couple-room cleanup job scheduled (daily 02:00 UTC).');
}

/**
 * Purge expired connection_codes (older than 15 minutes).
 * Runs every 5 minutes.
 */
function startCodeCleanupJob() {
    cron.schedule('*/5 * * * *', async () => {
        try {
            const result = await query(
                "DELETE FROM pairing_codes WHERE expires_at < NOW() RETURNING code"
            );
            if (result.rowCount > 0) {
                logger.info(`[Cron] Purged ${result.rowCount} expired connection code(s).`);
            }
        } catch (err) {
            if (process.env.NODE_ENV !== 'production' && err.code === 'ECONNREFUSED') {
                // DB not available in dev — skip silently
                return;
            }
            logger.error(`[Cron] Code cleanup failed: ${err.message}`);
        }
    });
}

/**
 * Decay pet stats every 4 hours.
 * For each pet, reduce health/mood/hunger/cleanliness by DECAY_PER_INTERVAL
 * for each 4-hour interval since last_decay_at.
 * Sends socket alerts for critical stats and handles pet death.
 */
function startPetDecayJob() {
    const DECAY_INTERVAL_HOURS = 4;
    const DECAY_PER_INTERVAL = 3;

    cron.schedule('0 */4 * * *', async () => {
        logger.info('[Cron] Running pet stat decay job…');
        try {
            // Find all pets that need decay (last_decay_at older than DECAY_INTERVAL_HOURS)
            const pets = await query(
                `SELECT cp.*, cr.id AS room_id
                 FROM couple_pet cp
                 JOIN couple_rooms cr ON cr.id = cp.couple_room_id
                 WHERE cr.status = 'active'
                   AND cp.last_decay_at < NOW() - INTERVAL '${DECAY_INTERVAL_HOURS} hours'`
            );

            if (!pets.rows.length) {
                logger.info('[Cron] No pets need decay.');
                return;
            }

            let decayed = 0;
            let criticalAlerts = 0;
            let deaths = 0;

            for (const pet of pets.rows) {
                const now = new Date();
                const lastDecay = new Date(pet.last_decay_at);
                const hoursElapsed = (now - lastDecay) / (1000 * 60 * 60);
                const intervals = Math.floor(hoursElapsed / DECAY_INTERVAL_HOURS);

                if (intervals <= 0) continue;

                const totalDecay = intervals * DECAY_PER_INTERVAL;
                const newHealth = Math.max(pet.health - totalDecay, 0);
                const newMood = Math.max(pet.mood - totalDecay, 0);
                const newHunger = Math.max(pet.hunger - totalDecay, 0);
                const newCleanliness = Math.max(pet.cleanliness - totalDecay, 0);

                await query(
                    `UPDATE couple_pet
                     SET health = $2, mood = $3, hunger = $4, cleanliness = $5,
                         last_decay_at = NOW()
                     WHERE id = $1`,
                    [pet.id, newHealth, newMood, newHunger, newCleanliness]
                );
                decayed++;

                // Check for critical stats
                const isCritical = newHealth < 20 || newMood < 20 || newHunger < 20 || newCleanliness < 20;
                const isDead = newHealth <= 0 && newMood <= 0 && newHunger <= 0 && newCleanliness <= 0;

                const { getIO } = require('../socket/socket.handler');
                const io = getIO();

                if (isDead) {
                    deaths++;
                    // Apply death penalty
                    const DEATH_XP_PENALTY = 50;
                    const newXp = Math.max(pet.total_love_xp - DEATH_XP_PENALTY, 0);
                    let newLevel = 1;
                    const LEVEL_THRESHOLDS = [0, 100, 250, 450, 700, 1000, 1350, 1750];
                    for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
                        if (newXp >= LEVEL_THRESHOLDS[i]) newLevel = i + 1;
                    }
                    newLevel = Math.min(newLevel, 8);

                    await query(
                        `UPDATE couple_pet
                         SET health = 30, mood = 30, hunger = 30, cleanliness = 30,
                             total_love_xp = $2, evolution_level = $3,
                             last_decay_at = NOW()
                         WHERE id = $1`,
                        [pet.id, newXp, newLevel]
                    );

                    if (io) {
                        io.to(`room:${pet.couple_room_id}`).emit('pet:alert', {
                            type: 'death',
                            message: `${pet.pet_name} đã kiệt sức! Mất ${DEATH_XP_PENALTY} XP 😢`,
                            petName: pet.pet_name,
                            oldLevel: pet.evolution_level,
                            newLevel,
                            xpLost: DEATH_XP_PENALTY,
                        });
                    }

                    logger.warn(`[Cron] Pet death in room ${pet.couple_room_id}! Level ${pet.evolution_level} → ${newLevel}`);

                    // Send push to both partners
                    try {
                        const petCtrl = require('../controllers/pet.controller');
                        await petCtrl.sendCriticalAlerts(pet.couple_room_id, {
                            ...pet, health: 0, mood: 0, hunger: 0, cleanliness: 0,
                        });
                    } catch (_) { /* push is best-effort */ }
                } else if (isCritical) {
                    criticalAlerts++;
                    if (io) {
                        io.to(`room:${pet.couple_room_id}`).emit('pet:alert', {
                            type: 'critical',
                            petName: pet.pet_name,
                            health: newHealth,
                            mood: newMood,
                            hunger: newHunger,
                            cleanliness: newCleanliness,
                        });
                    }
                    // Send push notifications for critical stats
                    try {
                        const petCtrl = require('../controllers/pet.controller');
                        await petCtrl.sendCriticalAlerts(pet.couple_room_id, {
                            ...pet, health: newHealth, mood: newMood,
                            hunger: newHunger, cleanliness: newCleanliness,
                        });
                    } catch (_) { /* push is best-effort */ }
                }
            }

            logger.info(`[Cron] Pet decay done: ${decayed} decayed, ${criticalAlerts} critical alerts, ${deaths} deaths.`);
        } catch (err) {
            if (process.env.NODE_ENV !== 'production' && err.code === 'ECONNREFUSED') {
                return;
            }
            logger.error(`[Cron] Pet decay job failed: ${err.message}`, { stack: err.stack });
        }
    }, {
        scheduled: true,
        timezone: 'UTC',
    });

    logger.info('[Cron] Pet stat decay job scheduled (every 4 hours).');
}

module.exports = { startCleanupJob, startCodeCleanupJob, startPetDecayJob };
