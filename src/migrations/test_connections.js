process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const OLD_URL =
    process.env.MIGRATION_SOURCE_DATABASE_URL
    || process.env.SOURCE_DATABASE_URL
    || process.env.OLD_DATABASE_URL;

const NEW_URL =
    process.env.MIGRATION_TARGET_DATABASE_URL
    || process.env.AIVEN_DATABASE_URL
    || process.env.DATABASE_URL;

if (!OLD_URL || !NEW_URL) {
    throw new Error('Missing OLD_URL/NEW_URL. Set MIGRATION_SOURCE_DATABASE_URL and DATABASE_URL (or MIGRATION_TARGET_DATABASE_URL).');
}

const outFile = path.join(__dirname, 'test_result.json');

async function main() {
    const result = { old: {}, new: {} };

    // Test OLD (Neon)
    const oldPool = new Pool({ connectionString: OLD_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try {
        const r1 = await oldPool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
        const tables = r1.rows.map(x => x.table_name);
        result.old.tables = {};
        result.old.connected = true;

        for (const t of tables) {
            try {
                const cnt = await oldPool.query(`SELECT COUNT(*) as c FROM "${t}"`);
                result.old.tables[t] = parseInt(cnt.rows[0].c);
            } catch (e) {
                result.old.tables[t] = 'ERROR: ' + e.message;
            }
        }
    } catch (e) {
        result.old.connected = false;
        result.old.error = e.message;
    }
    await oldPool.end();

    // Test NEW (Aiven)
    const newPool = new Pool({ connectionString: NEW_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    try {
        const r2 = await newPool.query('SELECT NOW() as t, current_database() as db');
        result.new.connected = true;
        result.new.db = r2.rows[0].db;
        result.new.time = r2.rows[0].t;

        // Check if any tables exist
        const r3 = await newPool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
        result.new.tables = {};
        for (const row of r3.rows) {
            try {
                const cnt = await newPool.query(`SELECT COUNT(*) as c FROM "${row.table_name}"`);
                result.new.tables[row.table_name] = parseInt(cnt.rows[0].c);
            } catch (e) {
                result.new.tables[row.table_name] = 'ERROR';
            }
        }
    } catch (e) {
        result.new.connected = false;
        result.new.error = e.message;
    }
    await newPool.end();

    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    console.log('DONE - result saved to test_result.json');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
