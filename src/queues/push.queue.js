const { Queue, Worker } = require('bullmq');
const { getRedisConnection, isRedisAvailable } = require('../config/redis');
const { sendPushNotification } = require('../config/firebase');
const logger = require('../config/logger');

const QUEUE_NAME = 'push-notifications';

let pushQueue = null;
let pushWorker = null;

/**
 * Initialize the BullMQ push notification queue and worker.
 * Call this after Redis is connected in bootstrap.
 * Returns false if Redis is not available (graceful degradation).
 */
function initPushQueue() {
    const connection = getRedisConnection();
    if (!connection) {
        logger.warn('[PushQueue] Redis unavailable — push notifications will be sent directly (no queue).');
        return false;
    }

    try {
        // ── Queue ──────────────────────────────────────────────────
        pushQueue = new Queue(QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 1000, // 1s → 2s → 4s
                },
                removeOnComplete: { count: 100 },  // Keep last 100 completed jobs
                removeOnFail: { count: 500 },       // Keep last 500 failed for debugging
            },
        });

        // ── Worker ─────────────────────────────────────────────────
        pushWorker = new Worker(QUEUE_NAME, async (job) => {
            const { token, title, body, data } = job.data;

            logger.info(`[PushQueue] Processing job ${job.id}: "${title}" → token=${token.slice(0, 20)}...`);

            const sent = await sendPushNotification({ token, title, body, data });

            if (!sent) {
                throw new Error(`FCM delivery failed for job ${job.id}`);
            }

            return { sent: true, processedAt: new Date().toISOString() };
        }, {
            connection,
            concurrency: 5,
            limiter: {
                max: 50,
                duration: 1000, // Max 50 pushes per second to avoid FCM throttling
            },
        });

        pushWorker.on('completed', (job) => {
            logger.debug(`[PushQueue] ✅ Job ${job.id} completed`);
        });

        pushWorker.on('failed', (job, err) => {
            logger.error(`[PushQueue] ❌ Job ${job?.id} failed after ${job?.attemptsMade} attempts: ${err.message}`);
        });

        pushWorker.on('error', (err) => {
            logger.error(`[PushQueue] Worker error: ${err.message}`);
        });

        logger.info(`✅ Push notification queue initialized (${QUEUE_NAME})`);
        return true;
    } catch (err) {
        logger.error(`[PushQueue] Failed to initialize: ${err.message}`);
        return false;
    }
}

/**
 * Enqueue a push notification. Falls back to direct send if queue is unavailable.
 *
 * @param {Object} payload
 * @param {string} payload.token - FCM token
 * @param {string} payload.title - Notification title
 * @param {string} payload.body  - Notification body
 * @param {Object} [payload.data] - Custom data payload
 * @returns {Promise<boolean>} - true if enqueued or sent
 */
async function enqueuePush({ token, title, body, data }) {
    // If queue is available, enqueue the job
    if (pushQueue && isRedisAvailable()) {
        try {
            await pushQueue.add('send-push', { token, title, body, data });
            logger.debug(`[PushQueue] Enqueued: "${title}" → ${token.slice(0, 20)}...`);
            return true;
        } catch (err) {
            logger.warn(`[PushQueue] Enqueue failed, falling back to direct send: ${err.message}`);
        }
    }

    // Fallback: direct send (same behavior as before BullMQ)
    try {
        const sent = await sendPushNotification({ token, title, body, data });
        return sent;
    } catch (err) {
        logger.error(`[PushQueue] Direct send fallback failed: ${err.message}`);
        return false;
    }
}

/**
 * Gracefully shutdown queue and worker.
 */
async function closePushQueue() {
    try {
        if (pushWorker) {
            await pushWorker.close();
            logger.info('[PushQueue] Worker closed');
        }
        if (pushQueue) {
            await pushQueue.close();
            logger.info('[PushQueue] Queue closed');
        }
    } catch (err) {
        logger.error(`[PushQueue] Error during shutdown: ${err.message}`);
    }
}

module.exports = { initPushQueue, enqueuePush, closePushQueue };
