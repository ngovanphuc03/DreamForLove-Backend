require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const { initDB, getPool } = require('./config/database');
const { initFirebase } = require('./config/firebase');
const { Server: SocketServer } = require('socket.io');
const { initSocket } = require('./socket/socket.handler');
const { startCleanupJob, startCodeCleanupJob } = require('./jobs/cleanup.job');
const { errorHandler } = require('./middleware/errorHandler');
const routes = require('./routes');
const logger = require('./config/logger');

const app = express();
const server = http.createServer(app);

const isDevEnv = process.env.NODE_ENV !== 'production';
const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : ['http://localhost:8080', 'http://localhost:3000', 'http://localhost:5000'];

function isOriginAllowed(origin) {
    // Allow requests with no origin (mobile apps, curl, health checks)
    if (!origin) return true;

    // In dev, allow wildcard if explicitly configured
    if (isDevEnv && allowedOrigins.includes('*')) return true;

    return allowedOrigins.includes(origin);
}

const io = new SocketServer(server, {
    cors: {
        origin: function (origin, callback) {
            if (isOriginAllowed(origin)) return callback(null, true);
            return callback(new Error('Socket CORS not allowed for this origin'));
        },
        credentials: true,
    },
    transports: ['websocket', 'polling'],
});

// ── Security ─────────────────────────────────────────────────
app.use(helmet());

app.use(cors({
    origin: function (origin, callback) {
        if (isOriginAllowed(origin)) return callback(null, true);
        return callback(new Error('CORS not allowed for this origin'));
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
app.get('/health', async (_, res) => {
    let dbStatus = 'unknown';
    let tables = [];
    try {
        const pool = getPool();
        if (pool) {
            const result = await pool.query(
                `SELECT table_name FROM information_schema.tables 
                 WHERE table_schema = 'public' ORDER BY table_name`
            );
            tables = result.rows.map(r => r.table_name);
            dbStatus = 'connected';
        } else {
            dbStatus = 'no pool';
        }
    } catch (err) {
        dbStatus = `error: ${err.message}`;
    }

    res.json({
        status: 'ok',
        version: '1.0.1',
        time: new Date().toISOString(),
        message: '💕 DreamForLove API is running',
        env: process.env.NODE_ENV || 'not set',
        db: dbStatus,
        tables,
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

// ── Auto-migrate on startup ──────────────────────────────────
const SKIP_CODES = new Set(['42P07', '42710', '42P16', '42P17', '42723']);

/**
 * Split SQL handling dollar-quoted bodies ($$...$$) so semicolons inside
 * PL/pgSQL blocks are NOT treated as statement separators.
 */
function splitStatements(sql) {
    const stmts = [];
    let buf = '';
    let dollarTag = null;
    let i = 0;
    while (i < sql.length) {
        if (sql[i] === '$') {
            const m = sql.slice(i).match(/^\$([A-Za-z_]*)\$/);
            if (m) {
                const tag = m[0];
                buf += tag;
                i += tag.length;
                if (dollarTag === null) dollarTag = tag;
                else if (tag === dollarTag) dollarTag = null;
                continue;
            }
        }
        if (dollarTag === null && sql[i] === ';') {
            const stmt = buf.trim();
            const hasSQL = stmt.split('\n').some(
                l => l.trim().length > 0 && !l.trim().startsWith('--'));
            if (hasSQL) stmts.push(stmt);
            buf = '';
            i++;
            continue;
        }
        buf += sql[i++];
    }
    const trailing = buf.trim();
    const trailSQL = trailing.split('\n').some(
        l => l.trim().length > 0 && !l.trim().startsWith('--'));
    if (trailSQL) stmts.push(trailing);
    return stmts;
}

async function runMigrationsOnStartup() {
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    if (!files.length) return;

    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        for (const file of files) {
            logger.info(`📄 Migration: ${file}`);
            const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
            const statements = splitStatements(sql);

            let ok = 0, skipped = 0;
            for (let idx = 0; idx < statements.length; idx++) {
                const stmt = statements[idx];
                const sp = `sp_auto_${idx}`;
                try {
                    await client.query(`SAVEPOINT ${sp}`);
                    await client.query(stmt);
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                    ok++;
                } catch (err) {
                    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                    if (SKIP_CODES.has(err.code)) {
                        skipped++;
                    } else {
                        logger.warn(`  ⚠️  [${err.code}] ${err.message}`);
                    }
                }
            }
            logger.info(`  ✅ ${ok} applied  ⏭️  ${skipped} skipped`);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

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

        // ── Auto-run migrations ─────────────────────────────
        try {
            await runMigrationsOnStartup();
            logger.info('✅ Database migrations applied');
        } catch (migErr) {
            logger.warn(`⚠️  Migration warning: ${migErr.message}`);
        }
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
