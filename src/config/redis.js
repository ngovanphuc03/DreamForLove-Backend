const Redis = require('ioredis');
const logger = require('./logger');

let connection = null;

/**
 * Get or create a shared IORedis connection for BullMQ.
 * Returns null if Redis is unavailable (graceful degradation).
 */
function getRedisConnection() {
    if (connection) return connection;

    const url = process.env.REDIS_URL || 'redis://localhost:6379';

    try {
        connection = new Redis(url, {
            maxRetriesPerRequest: null, // Required by BullMQ
            enableReadyCheck: false,
            retryStrategy(times) {
                if (times > 5) {
                    logger.warn('[Redis] Max retries reached — giving up reconnection.');
                    return null; // Stop retrying
                }
                return Math.min(times * 500, 3000);
            },
        });

        connection.on('connect', () => {
            logger.info('✅ Redis connected');
        });

        connection.on('error', (err) => {
            logger.error(`[Redis] Connection error: ${err.message}`);
        });

        connection.on('close', () => {
            logger.warn('[Redis] Connection closed');
        });

        return connection;
    } catch (err) {
        logger.warn(`[Redis] Failed to create connection: ${err.message}`);
        return null;
    }
}

/**
 * Check if Redis is available and connected.
 */
function isRedisAvailable() {
    return connection && connection.status === 'ready';
}

/**
 * Gracefully close Redis connection.
 */
async function closeRedis() {
    if (connection) {
        try {
            await connection.quit();
            logger.info('[Redis] Connection closed gracefully');
        } catch (err) {
            logger.error(`[Redis] Error closing connection: ${err.message}`);
        }
        connection = null;
    }
}

module.exports = { getRedisConnection, isRedisAvailable, closeRedis };
