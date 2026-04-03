process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const OLD_URL = 'postgresql://neondb_owner:npg_LetP70xIgCFN@ep-proud-math-a1enzlv5-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';
const NEW_URL = 'postgres://avnadmin:AVNS_Uc0K16wXudeHmyj_hcs@dreamforlove-db-st-1331.b.aivencloud.com:18110/defaultdb?sslmode=require&uselibpqcompat=true';

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
