// Resolve .env from backend root (one level above src/)
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const { getPool, initDB } = require('../config/database');

// Error codes safe to skip (object already exists)
const SKIP_CODES = new Set(['42P07', '42710', '42P16', '42P17', '42723']);

/**
 * Split SQL into individual statements.
 * Handles dollar-quoted bodies ($$...$$) so semicolons inside
 * PL/pgSQL blocks are NOT treated as statement separators.
 */
function splitStatements(sql) {
    const stmts = [];
    let buf = '';
    let dollarTag = null; // null = outside dollar-quote
    let i = 0;

    while (i < sql.length) {
        if (sql[i] === '$') {
            const m = sql.slice(i).match(/^\$([A-Za-z_]*)\$/);
            if (m) {
                const tag = m[0];
                buf += tag;
                i += tag.length;
                if (dollarTag === null) dollarTag = tag;  // open
                else if (tag === dollarTag) dollarTag = null; // close
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

async function runMigrations() {
    const target = process.env.DATABASE_URL
        ? `DATABASE_URL → ${process.env.DATABASE_URL.replace(/:\/\/.*@/, '://<hidden>@')}`
        : `${process.env.DB_USER}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;
    logger.info(`🗄️  Target: ${target}`);

    await initDB();

    const migrationsDir = __dirname;
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    const client = await getPool().connect();
    try {
        await client.query('BEGIN');

        for (const file of files) {
            logger.info(`📄 Running: ${file}`);
            const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
            const statements = splitStatements(sql);
            logger.info(`   Found ${statements.length} statements`);

            let ok = 0, skipped = 0, failed = 0;
            for (let idx = 0; idx < statements.length; idx++) {
                const stmt = statements[idx];
                const sp = `sp_stmt_${idx}`;
                try {
                    await client.query(`SAVEPOINT ${sp}`);
                    await client.query(stmt);
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                    ok++;
                } catch (err) {
                    // Always rollback to savepoint to un-abort the transaction
                    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                    if (SKIP_CODES.has(err.code)) {
                        skipped++;
                    } else {
                        logger.error(`  ❌ [${err.code}] ${err.message}`);
                        logger.error(`     SQL: ${stmt.replace(/\s+/g, ' ').substring(0, 150)}…`);
                        failed++;
                    }
                }
            }
            logger.info(`  ✅ ${ok} applied  ⏭️  ${skipped} skipped  ❌ ${failed} failed`);
        }

        await client.query('COMMIT');
        logger.info('🎉 All migrations complete!');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    process.exit(0);
}

runMigrations().catch(err => {
    logger.error('Migration runner fatal error:', err);
    process.exit(1);
});

