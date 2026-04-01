/**
 * Setup Aiven: Run all schema migrations on the new Aiven database
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

// Override DATABASE_URL to point to Aiven
process.env.DATABASE_URL = 'postgres://avnadmin:AVNS_Uc0K16wXudeHmyj_hcs@dreamforlove-db-st-1331.b.aivencloud.com:18110/defaultdb?sslmode=require&uselibpqcompat=true';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SKIP_CODES = new Set(['42P07', '42710', '42P16', '42P17', '42723']);

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
            const hasSQL = stmt.split('\n').some(l => l.trim().length > 0 && !l.trim().startsWith('--'));
            if (hasSQL) stmts.push(stmt);
            buf = '';
            i++;
            continue;
        }
        buf += sql[i++];
    }
    const trailing = buf.trim();
    if (trailing.split('\n').some(l => l.trim().length > 0 && !l.trim().startsWith('--'))) stmts.push(trailing);
    return stmts;
}

async function main() {
    const resultFile = path.join(__dirname, 'setup_result.json');
    const result = { phases: [], success: false };

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 5,
        connectionTimeoutMillis: 15000,
        statement_timeout: 60000,
    });

    try {
        // Test connection
        const r = await pool.query('SELECT NOW() as t, current_database() as db');
        result.phases.push({ phase: 'connect', status: 'ok', db: r.rows[0].db });

        // Run migrations
        const migrationsDir = __dirname;
        const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            for (const file of files) {
                const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
                const statements = splitStatements(sql);
                let ok = 0, skipped = 0, failed = 0, errors = [];

                for (let idx = 0; idx < statements.length; idx++) {
                    const stmt = statements[idx];
                    const sp = `sp_${idx}`;
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
                            failed++;
                            errors.push(`[${err.code}] ${err.message}`);
                        }
                    }
                }
                result.phases.push({ phase: 'migrate', file, ok, skipped, failed, errors: errors.length > 0 ? errors : undefined });
            }

            await client.query('COMMIT');
        } finally {
            client.release();
        }

        // Verify tables
        const tablesRes = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
        const tables = {};
        for (const row of tablesRes.rows) {
            const cnt = await pool.query(`SELECT COUNT(*) as c FROM "${row.table_name}"`);
            tables[row.table_name] = parseInt(cnt.rows[0].c);
        }
        result.phases.push({ phase: 'verify', tables });
        result.success = true;

    } catch (err) {
        result.phases.push({ phase: 'error', message: err.message });
    } finally {
        await pool.end();
    }

    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf8');
    console.log('DONE');
    process.exit(result.success ? 0 : 1);
}

main();
