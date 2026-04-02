const { Pool } = require('pg');
const logger = require('./logger');

let pool;

function normalizeConnectionString(connectionString) {
    if (!connectionString) return connectionString;
    try {
        const parsed = new URL(connectionString);
        const sslMode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
        if (sslMode === 'require' && !parsed.searchParams.has('uselibpqcompat')) {
            parsed.searchParams.set('uselibpqcompat', 'true');
        }
        return parsed.toString();
    } catch {
        return connectionString;
    }
}

function getPool() {
    if (!pool) {
        // Support both DATABASE_URL (Aiven/Supabase/Railway) and individual vars
        const normalizedDatabaseUrl = normalizeConnectionString(process.env.DATABASE_URL);
        const connectionConfig = process.env.DATABASE_URL
            ? {
                connectionString: normalizedDatabaseUrl,
                ssl: { rejectUnauthorized: false },  // required by managed cloud Postgres
            }
            : {
                host: process.env.DB_HOST || 'localhost',
                port: Number(process.env.DB_PORT) || 5432,
                database: process.env.DB_NAME || 'dreamforlove',
                user: process.env.DB_USER || 'postgres',
                password: process.env.DB_PASSWORD,
                ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
            };

        pool = new Pool({
            ...connectionConfig,
            max: 20,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 5_000,
            statement_timeout: 10_000, // 10s query timeout to prevent pool exhaustion 
        });

        pool.on('error', (err) => {
            logger.error('PostgreSQL pool error:', err);
        });
    }
    return pool;
}

async function initDB() {
    const client = await getPool().connect();
    try {
        await client.query('SELECT 1');
        logger.info(`Connected to PostgreSQL: ${process.env.DB_NAME}`);
    } finally {
        client.release();
    }
}

async function query(text, params) {
    const start = Date.now();
    try {
        const result = await getPool().query(text, params);
        const duration = Date.now() - start;
        if (duration > 1000) {
            logger.warn(`Slow query (${duration}ms): ${text}`);
        }
        return result;
    } catch (err) {
        // Suppress noisy ECONNREFUSED in dev when DB is intentionally not running
        if (err.code === 'ECONNREFUSED' && process.env.NODE_ENV !== 'production') {
            logger.debug(`Query skipped (DB unavailable): ${text}`);
        } else {
            logger.error(`Query error: ${text}`, err);
        }
        throw err;
    }
}

async function transaction(callback) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { initDB, query, transaction, getPool };
