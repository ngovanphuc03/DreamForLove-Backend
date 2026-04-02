const { verifyIdToken, sendPushNotification } = require('../config/firebase');
const { query } = require('../config/database');
const logger = require('../config/logger');

/// Map of userId → Set of socket IDs (a user can have multiple sockets)
const onlineUsers = new Map();
const socketMeta = new Map(); // socketId -> { userId, coupleRoomId, displayName }
const pingRateTracker = new Map();

const PING_RATE_WINDOW_MS = 60 * 1000;
const PING_RATE_MAX_PER_WINDOW = 10;

/// Singleton io instance for use by controllers (e.g. mood.controller.js)
let ioInstance = null;

/// Returns the active Socket.io server instance (or null before init)
function getIO() {
    return ioInstance;
}

function registerPingAndCheckLimit(userId) {
    const now = Date.now();
    const existing = pingRateTracker.get(userId);

    if (!existing || now - existing.windowStart >= PING_RATE_WINDOW_MS) {
        pingRateTracker.set(userId, { windowStart: now, count: 1 });
        return true;
    }

    existing.count += 1;
    return existing.count <= PING_RATE_MAX_PER_WINDOW;
}

/**
 * Register and configure Socket.io on the given `io` instance.
 * Called once from app.js after the HTTP server is created.
 */
function initSocket(io) {
    ioInstance = io;
    // ── Authentication middleware ─────────────────────────────────────────────
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token;
            if (!token) return next(new Error('AUTH_MISSING'));

            const decoded = await verifyIdToken(token);
            socket.firebaseUid = decoded.uid;

            // Fetch DB user + active couple room (users has no couple_room_id)
            const result = await query(
                `SELECT u.id, u.display_name, cr.id AS couple_room_id
                 FROM users u
                 LEFT JOIN couple_rooms cr
                   ON (cr.user_a_id = u.id OR cr.user_b_id = u.id)
                   AND cr.status = 'active'
                 WHERE u.firebase_uid = $1
                 LIMIT 1`,
                [decoded.uid]
            );
            if (!result.rows.length) return next(new Error('USER_NOT_FOUND'));

            socket.dbUser = result.rows[0];
            socket.coupleRoomId = result.rows[0].couple_room_id ?? null;
            next();
        } catch {
            next(new Error('AUTH_INVALID'));
        }
    });

    // ── Connection handler ────────────────────────────────────────────────────
    io.on('connection', (socket) => {
        const userId = socket.dbUser.id;
        logger.info(`[Socket] User connected: ${userId} (${socket.id})`);

        socketMeta.set(socket.id, {
            userId,
            coupleRoomId: socket.coupleRoomId || null,
            displayName: socket.dbUser.display_name,
        });

        // Track online presence
        if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
        onlineUsers.get(userId).add(socket.id);

        // Personal room so controllers can target / exclude this user
        socket.join(`user:${userId}`);

        // Join couple room channel if user is already paired
        if (socket.coupleRoomId) {
            socket.join(`room:${socket.coupleRoomId}`);
            logger.info(`[Socket] User ${userId} joined room ${socket.coupleRoomId}`);
            // Notify partner that this user just came online
            socket.to(`room:${socket.coupleRoomId}`).emit('partner:online', {
                userId,
                displayName: socket.dbUser.display_name,
            });
        }

        // ── Event: client requests to join a room (after pairing completes) ─────
        socket.on('room:join', async ({ coupleRoomId }) => {
            try {
                // Verify this user belongs to that room
                const result = await query(
                    `SELECT 1 FROM couple_rooms
           WHERE id = $1
             AND (user_a_id = $2 OR user_b_id = $2)
             AND status = 'active'`,
                    [coupleRoomId, userId]
                );
                if (!result.rows.length) {
                    return socket.emit('error', { message: 'Not authorised for this room' });
                }
                socket.coupleRoomId = coupleRoomId;
                socket.join(`room:${coupleRoomId}`);
                socketMeta.set(socket.id, {
                    userId,
                    coupleRoomId,
                    displayName: socket.dbUser.display_name,
                });
                logger.info(`[Socket] User ${userId} dynamically joined room ${coupleRoomId}`);
                socket.to(`room:${coupleRoomId}`).emit('partner:online', {
                    userId,
                    displayName: socket.dbUser.display_name,
                });
            } catch (err) {
                logger.error(`[Socket] room:join error: ${err.message}`);
            }
        });

        // ── Event: mood update (broadcast to partner) ────────────────────────────
        // The REST controller already persists the mood; the socket event is for
        // real-time delivery. The REST call also emits this for offline-safe FCM,
        // but if the client is online it can emit directly too.
        socket.on('mood:update', async ({ moodType }) => {
            if (!socket.coupleRoomId) {
                return socket.emit('error', { message: 'Not in a couple room' });
            }
            const VALID_MOODS = ['happy', 'sad', 'miss', 'angry', 'love'];
            if (!VALID_MOODS.includes(moodType)) {
                return socket.emit('error', { message: 'Invalid mood type' });
            }
            // Broadcast to the room (partner picks this up)
            socket.to(`room:${socket.coupleRoomId}`).emit('mood:updated', {
                userId,
                displayName: socket.dbUser.display_name,
                moodType,
                updatedAt: new Date().toISOString(),
            });
        });

        // ── Event: wishlist item added/updated/deleted (live sync) ───────────────
        socket.on('wishlist:changed', ({ action, item }) => {
            if (!socket.coupleRoomId) return;
            socket.to(`room:${socket.coupleRoomId}`).emit('wishlist:sync', { action, item });
        });

        // ── Event: food list changed ─────────────────────────────────────────────
        socket.on('food:changed', ({ action, item }) => {
            if (!socket.coupleRoomId) return;
            socket.to(`room:${socket.coupleRoomId}`).emit('food:sync', { action, item });
        });

        // ── Event: pet care action (socket alternative to REST) ──────────────────
        socket.on('pet:action', async ({ action }) => {
            if (!socket.coupleRoomId) {
                return socket.emit('error', { message: 'Not in a couple room' });
            }
            const validActions = ['feed', 'pet', 'bathe', 'play'];
            if (!validActions.includes(action)) {
                return socket.emit('error', { message: `Invalid action: ${action}` });
            }
            try {
                // Delegate to the REST controller logic via a lightweight wrapper
                const petCtrl = require('../controllers/pet.controller');
                const { transaction } = require('../config/database');
                const { v4: uuidv4 } = require('uuid');

                const roomId = socket.coupleRoomId;

                const result = await transaction(async (client) => {
                    let pet = await petCtrl.ensurePet(roomId, client);
                    const decay = petCtrl.computeDecay(pet);
                    if (decay.decayApplied) {
                        const decayed = await client.query(
                            `UPDATE couple_pet
                             SET health = $2, mood = $3, hunger = $4, cleanliness = $5,
                                 last_decay_at = NOW()
                             WHERE couple_room_id = $1 RETURNING *`,
                            [roomId, decay.health, decay.mood, decay.hunger, decay.cleanliness]
                        );
                        pet = decayed.rows[0] || pet;
                    }

                    const cooldowns = petCtrl.buildCooldowns(pet);
                    if (!cooldowns[action].ready) {
                        return { error: 'cooldown', message: 'Pet cần nghỉ ngơi!' };
                    }

                    const ACTION_CONFIG = {
                        feed:  { statDeltas: { hunger: 25, health: 5 }, xp: 10, cooldownMinutes: 30 },
                        pet:   { statDeltas: { mood: 20, health: 5 },   xp: 10, cooldownMinutes: 30 },
                        bathe: { statDeltas: { cleanliness: 30, health: 5 }, xp: 10, cooldownMinutes: 60 },
                        play:  { statDeltas: { health: 15, mood: 10 },  xp: 15, cooldownMinutes: 45 },
                    };
                    const config = ACTION_CONFIG[action];

                    const newStats = {
                        health: Math.min((pet.health || 0) + (config.statDeltas.health || 0), 100),
                        mood: Math.min((pet.mood || 0) + (config.statDeltas.mood || 0), 100),
                        hunger: Math.min((pet.hunger || 0) + (config.statDeltas.hunger || 0), 100),
                        cleanliness: Math.min((pet.cleanliness || 0) + (config.statDeltas.cleanliness || 0), 100),
                    };

                    const newTotalXp = pet.total_love_xp + config.xp;
                    const newLevel = petCtrl.computeLevel(newTotalXp);
                    const evolved = newLevel > pet.evolution_level;

                    const lastAtColumn = { feed: 'last_fed_at', pet: 'last_petted_at', bathe: 'last_bathed_at', play: 'last_played_at' }[action];

                    const updated = await client.query(
                        `UPDATE couple_pet
                         SET health=$2, mood=$3, hunger=$4, cleanliness=$5,
                             total_love_xp=$6, evolution_level=$7,
                             ${lastAtColumn}=NOW(), last_decay_at=NOW()
                         WHERE couple_room_id=$1 RETURNING *`,
                        [roomId, newStats.health, newStats.mood, newStats.hunger, newStats.cleanliness, newTotalXp, newLevel]
                    );
                    pet = updated.rows[0];

                    await client.query(
                        `INSERT INTO pet_care_actions (id, couple_room_id, user_id, action_type, xp_awarded, stat_changes)
                         VALUES ($1,$2,$3,$4,$5,$6)`,
                        [uuidv4(), roomId, userId, action, config.xp, JSON.stringify(config.statDeltas)]
                    );

                    return { pet, xpAwarded: config.xp, evolved, newLevel };
                });

                if (result.error) {
                    return socket.emit('pet:action:error', { action, message: result.message });
                }

                const responseData = petCtrl.formatPetResponse(result.pet, 0, 0);
                io.to(`room:${roomId}`).emit('pet:updated', { ...responseData, action, xpDelta: result.xpAwarded, byUserId: userId });

                if (result.evolved) {
                    io.to(`room:${roomId}`).emit('pet:evolution', {
                        petName: result.pet.pet_name, oldLevel: result.pet.evolution_level, newLevel: result.newLevel,
                    });
                }

                socket.to(`room:${roomId}`).emit('pet:partner_care', {
                    partnerName: socket.dbUser.display_name, action, xpDelta: result.xpAwarded,
                });
            } catch (err) {
                logger.error(`[Socket] pet:action error: ${err.message}`);
                socket.emit('pet:action:error', { action, message: 'Lỗi khi chăm sóc pet' });
            }
        });

        // ── Event: request partner presence snapshot ───────────────────────────
        socket.on('partner:presence:request', async () => {
            try {
                if (!socket.coupleRoomId) {
                    return socket.emit('partner:presence', {
                        online: false,
                        reason: 'no_room',
                    });
                }

                const partnerResult = await query(
                    `SELECT u.id, u.display_name
                     FROM couple_rooms cr
                     JOIN users u ON (
                       (cr.user_a_id = $1 AND cr.user_b_id = u.id) OR
                       (cr.user_b_id = $1 AND cr.user_a_id = u.id)
                     )
                     WHERE cr.id = $2 AND cr.status = 'active'
                     LIMIT 1`,
                    [userId, socket.coupleRoomId]
                );

                const partner = partnerResult.rows[0];
                if (!partner) {
                    return socket.emit('partner:presence', {
                        online: false,
                        reason: 'partner_not_found',
                    });
                }

                socket.emit('partner:presence', {
                    online: isUserOnline(partner.id),
                    userId: partner.id,
                    displayName: partner.display_name,
                });
            } catch (err) {
                logger.error(`[Socket] partner:presence:request error: ${err.message}`);
            }
        });

        // ── Event: typing / heartbeat ping ──────────────────────────────────────
        socket.on('ping:partner', async () => {
            if (!socket.coupleRoomId) {
                logger.warn(`[Socket] ping:partner from ${userId} ignored – no coupleRoomId`);
                socket.emit('ping:sent', { delivered: false, reason: 'no_room' });
                return;
            }

            if (!registerPingAndCheckLimit(userId)) {
                socket.emit('ping:sent', {
                    delivered: false,
                    reason: 'rate_limited',
                    message: 'Bạn gửi rung tim quá nhanh, thử lại sau 1 phút nhé 💕',
                });
                return;
            }

            // Validate room is still active and this user is still a member.
            try {
                const activeRoom = await query(
                    `SELECT 1 FROM couple_rooms
                     WHERE id = $1
                       AND status = 'active'
                       AND (user_a_id = $2 OR user_b_id = $2)
                     LIMIT 1`,
                    [socket.coupleRoomId, userId]
                );
                if (!activeRoom.rows.length) {
                    logger.warn(`[Socket] ping:partner from ${userId} ignored – inactive/unauthorized room ${socket.coupleRoomId}`);
                    socket.leave(`room:${socket.coupleRoomId}`);
                    socket.coupleRoomId = null;
                    socket.emit('ping:sent', { delivered: false, reason: 'inactive_room' });
                    return;
                }
            } catch (err) {
                logger.error(`[Socket] ping:partner room validation error: ${err.message}`);
                socket.emit('ping:sent', { delivered: false, reason: 'room_validation_failed' });
                return;
            }

            logger.info(`[Socket] ping:partner from ${userId} in room ${socket.coupleRoomId}`);

            let partnerId = null;
            let partnerFcmToken = null;
            let partnerDisplayName = null;

            try {
                // Find the OTHER user in this couple room.
                const partnerResult = await query(
                    `SELECT u.id, u.fcm_token, u.display_name
                     FROM couple_rooms cr
                     JOIN users u ON (
                       (cr.user_a_id = $1 AND cr.user_b_id = u.id) OR
                       (cr.user_b_id = $1 AND cr.user_a_id = u.id)
                     )
                     WHERE cr.id = $2 AND cr.status = 'active'
                     LIMIT 1`,
                    [userId, socket.coupleRoomId]
                );

                const partner = partnerResult.rows[0];
                if (!partner?.id) {
                    socket.emit('ping:sent', { delivered: false, reason: 'partner_not_found' });
                    return;
                }

                partnerId = partner.id;
                partnerFcmToken = partner.fcm_token || null;
                partnerDisplayName = partner.display_name || null;
            } catch (err) {
                logger.error(`[Socket] ping:partner partner lookup error: ${err.message}`);
                socket.emit('ping:sent', { delivered: false, reason: 'partner_lookup_failed' });
                return;
            }

            const partnerOnline = isUserOnline(partnerId);

            // 1. Emit directly to partner user room (robust even if partner has not joined room:<id>)
            io.to(`user:${partnerId}`).emit('partner:ping', {
                userId,
                displayName: socket.dbUser.display_name,
            });

            // 2. Acknowledge back to sender immediately (do not wait for FCM)
            const initialPushReason = partnerFcmToken ? 'queued' : 'missing_fcm_token';
            socket.emit('ping:sent', {
                delivered: true,
                pushSent: false,
                pushReason: initialPushReason,
                partnerOnline,
                partnerId,
            });

            // 3. Push notification for when partner app is backgrounded / killed
            // Run in background to avoid delaying socket ack.
            if (partnerFcmToken) {
                (async () => {
                    try {
                        logger.info(`[Socket] Partner (${partnerDisplayName || partnerId}) FCM token: found`);
                        const sent = await sendPushNotification({
                            token: partnerFcmToken,
                            title: `${socket.dbUser.display_name} nhớ bạn 💕`,
                            body: 'Chạm vào để xem rung tim!',
                            data: { type: 'HEARTBEAT_PING' },
                        });

                        socket.emit('ping:sent:update', {
                            delivered: true,
                            pushSent: sent,
                            pushReason: sent ? 'sent' : 'push_send_failed',
                            partnerOnline,
                            partnerId,
                        });

                        if (sent) {
                            logger.info(`[Socket] Push sent to partner of user ${userId}`);
                        } else {
                            logger.warn(`[Socket] Push failed to partner of user ${userId}`);
                        }
                    } catch (err) {
                        logger.error(`[Socket] ping:partner push error: ${err.message}`);
                        socket.emit('ping:sent:update', {
                            delivered: true,
                            pushSent: false,
                            pushReason: 'push_error',
                            partnerOnline,
                            partnerId,
                        });
                    }
                })();
            } else {
                logger.info(`[Socket] Partner (${partnerDisplayName || partnerId}) FCM token: NOT FOUND`);
            }
        });

        // ── Disconnect ───────────────────────────────────────────────────────────
        socket.on('disconnect', () => {
            logger.info(`[Socket] User disconnected: ${userId} (${socket.id})`);
            socketMeta.delete(socket.id);
            const sockets = onlineUsers.get(userId);
            if (sockets) {
                sockets.delete(socket.id);
                if (sockets.size === 0) {
                    onlineUsers.delete(userId);
                    // Notify partner this user went offline
                    if (socket.coupleRoomId) {
                        io.to(`room:${socket.coupleRoomId}`).emit('partner:offline', {
                            userId,
                            displayName: socket.dbUser.display_name,
                        });
                    }
                }
            }
        });
    });
}

/// Check if a userId is currently online
function isUserOnline(userId) {
    return onlineUsers.has(userId) && onlineUsers.get(userId).size > 0;
}

// ── Zombie Connection Cleanup ─────────────────────────────────────────────
setInterval(() => {
    if (!ioInstance) return;
    let cleaned = 0;
    const now = Date.now();
    for (const [userId, sockets] of onlineUsers.entries()) {
        let removedMeta = null;
        for (const socketId of sockets) {
            // Check if socket actually exists in the IO instance
            if (!ioInstance.sockets.sockets.has(socketId)) {
                removedMeta = socketMeta.get(socketId) || removedMeta;
                socketMeta.delete(socketId);
                sockets.delete(socketId);
                cleaned++;
            }
        }
        if (sockets.size === 0) {
            onlineUsers.delete(userId);
            if (removedMeta?.coupleRoomId) {
                ioInstance.to(`room:${removedMeta.coupleRoomId}`).emit('partner:offline', {
                    userId,
                    displayName: removedMeta.displayName,
                });
            }
        }
    }

    for (const [userId, stat] of pingRateTracker.entries()) {
        if (now - stat.windowStart >= PING_RATE_WINDOW_MS * 2) {
            pingRateTracker.delete(userId);
        }
    }

    if (cleaned > 0) {
        logger.debug(`[Socket] Periodic Cleanup: Removed ${cleaned} zombie connections.`);
    }
}, 15000); // 15 seconds

module.exports = { initSocket, isUserOnline, getIO };
