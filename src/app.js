require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const { initDB } = require('./config/database');
const { initFirebase } = require('./config/firebase');
const { Server: SocketServer } = require('socket.io');
const { initSocket } = require('./socket/socket.handler');
const { startCleanupJob, startCodeCleanupJob } = require('./jobs/cleanup.job');
const { errorHandler } = require('./middleware/errorHandler');
const routes = require('./routes');
const logger = require('./config/logger');

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
    cors: {
        origin: function (origin, callback) {
            callback(null, true); // Allow all origins in dev
        },
        credentials: true,
    },
    transports: ['websocket', 'polling'],
});

// ── Security ─────────────────────────────────────────────────
app.use(helmet());

const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : ['http://localhost:8080', 'http://localhost:3000', 'http://localhost:5000'];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
            return callback(null, true);
        }
        callback(null, true); // Dev: allow all for now
    },
    credentials: true,
}));

// ── Rate Limiting ─────────────────────────────────────────────
const limiter = rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau' },
});
app.use('/api/', limiter);

// ── Middleware ───────────────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', {
    stream: { write: (msg) => logger.info(msg.trim()) },
}));

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_, res) => {
    res.json({
        status: 'ok',
        version: '1.0.0',
        time: new Date().toISOString(),
        message: '💕 DreamForLove API is running',
    });
});

// ── API Routes ───────────────────────────────────────────────
app.use('/api', routes);

// ── 404 handler ──────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: 'Route không tồn tại' });
});

// ── Global error handler ─────────────────────────────────────
app.use(errorHandler);

// ── Bootstrap ────────────────────────────────────────────────
async function bootstrap() {
    const isDev = process.env.NODE_ENV !== 'production';

    // ── Firebase ────────────────────────────────────────────
    try {
        initFirebase();
        logger.info('✅ Firebase Admin initialized');
    } catch (err) {
        if (!isDev) { logger.error('Firebase init failed', err); process.exit(1); }
        logger.warn(`⚠️  Firebase init skipped in dev: ${err.message}`);
    }

    // ── Database ─────────────────────────────────────────────
    let dbAvailable = false;
    try {
        await initDB();
        logger.info('✅ PostgreSQL connected');
        dbAvailable = true;
    } catch (err) {
        if (!isDev) { logger.error('DB init failed', err); process.exit(1); }
        logger.warn('⚠️  PostgreSQL unavailable – running in DB-less dev mode.');
        logger.warn('   API calls that hit the DB sẽ trả lỗi 500 cho đến khi DB được kết nối.');
    }

    // ── Socket.io ─────────────────────────────────────────────
    initSocket(io);
    logger.info('✅ Socket.io initialized');

    // ── Cron Jobs (only when DB is reachable) ────────────────────────
    if (dbAvailable) {
        startCleanupJob();
        startCodeCleanupJob();
        logger.info('✅ Cron jobs initialized');
    } else {
        logger.warn('⚠️  Cron jobs skipped (no DB connection).');
    }

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        logger.info(`💕 DreamForLove API running on port ${PORT}`);
        logger.info(`📋 Environment: ${process.env.NODE_ENV}`);
        if (isDev) logger.info(`🔗 Health check: http://localhost:${PORT}/health`);
    });
}


bootstrap();

module.exports = { app, server };
