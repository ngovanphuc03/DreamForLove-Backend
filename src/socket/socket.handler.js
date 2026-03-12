const { verifyIdToken } = require('../config/firebase');
const { query } = require('../config/database');
const logger = require('../config/logger');

/// Map of userId → Set of socket IDs (a user can have multiple sockets)
const onlineUsers = new Map();

/// Singleton io instance for use by controllers (e.g. mood.controller.js)
let ioInstance = null;

/// Returns the active Socket.io server instance (or null before init)
function getIO() {
    return ioInstance;
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

        // ── Event: typing / heartbeat ping ──────────────────────────────────────
        socket.on('ping:partner', () => {
            if (!socket.coupleRoomId) return;
            socket.to(`room:${socket.coupleRoomId}`).emit('partner:ping', { userId });
        });

        // ── Disconnect ───────────────────────────────────────────────────────────
        socket.on('disconnect', () => {
            logger.info(`[Socket] User disconnected: ${userId} (${socket.id})`);
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

module.exports = { initSocket, isUserOnline, getIO };
