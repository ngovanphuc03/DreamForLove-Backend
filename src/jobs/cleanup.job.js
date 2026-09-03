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
                    'DELETE FROM pet_inventory WHERE couple_room_id = ANY($1::uuid[])',
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
module.exports = { startCleanupJob, startCodeCleanupJob };
