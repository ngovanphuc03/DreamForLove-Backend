/**
 * ═══════════════════════════════════════════════════════════════
 *  DreamForLove – Database Migration: Neon → Aiven
 *  
 *  This script:
 *  1. Connects to the OLD Neon database
 *  2. Exports all data from every table
 *  3. Connects to the NEW Aiven database
 *  4. Runs all schema migrations on Aiven
 *  5. Imports all data into Aiven
 *  6. Verifies row counts match
 * ═══════════════════════════════════════════════════════════════
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ── Connection strings ──────────────────────────────────────────
const OLD_DB_URL = 'postgresql://neondb_owner:npg_LetP70xIgCFN@ep-proud-math-a1enzlv5-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const NEW_DB_URL = 'postgres://avnadmin:AVNS_Uc0K16wXudeHmyj_hcs@dreamforlove-db-st-1331.b.aivencloud.com:18110/defaultdb?sslmode=require&uselibpqcompat=true';

// ── Tables in dependency order (parents first) ──────────────────
const TABLES = [
    'users',
    'couple_rooms',
    'pairing_codes',
    'wish_items',
    'mood_logs',
    'food_items',
    'milestones',
    'trip_plans',
    'audit_logs',
    'schema_migrations',
];

// Error codes safe to skip (object already exists)
const SKIP_CODES = new Set(['42P07', '42710', '42P16', '42P17', '42723']);

/**
 * Split SQL into individual statements (handles dollar-quoted bodies).
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

function createPool(url, label) {
    console.log(`\n🔌 Creating pool for ${label}...`);
    console.log(`   URL: ${url.replace(/:\/\/.*@/, '://<hidden>@')}`);
    return new Pool({
        connectionString: url,
        ssl: { rejectUnauthorized: false },
        max: 5,
        connectionTimeoutMillis: 15000,
        statement_timeout: 60000,
    });
}

async function testConnection(pool, label) {
    const client = await pool.connect();
    try {
        const res = await client.query('SELECT NOW() AS now, current_database() AS db');
        console.log(`   ✅ ${label} connected: ${res.rows[0].db} at ${res.rows[0].now}`);
    } finally {
        client.release();
    }
}

async function runSchemaMigrations(pool) {
    console.log('\n═══════════════════════════════════════════');
    console.log('  PHASE 1: Running schema migrations on Aiven');
    console.log('═══════════════════════════════════════════');

    const migrationsDir = __dirname;
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Clear existing data first (rerunnable import) in reverse dependency order
        for (const table of [...TABLES].reverse()) {
            const clearRes = await client.query(
                `SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = $1
                ) AS exists`,
                [table]
            );
            if (clearRes.rows[0].exists) {
                await client.query(`DELETE FROM "${table}"`);
            }
        }

        for (const file of files) {
            console.log(`\n📄 Running: ${file}`);
            const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
            const statements = splitStatements(sql);
            console.log(`   Found ${statements.length} statements`);

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
                    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                    if (SKIP_CODES.has(err.code)) {
                        skipped++;
                    } else {
                        console.error(`  ❌ [${err.code}] ${err.message}`);
                        console.error(`     SQL: ${stmt.replace(/\s+/g, ' ').substring(0, 150)}…`);
                        failed++;
                    }
                }
            }
            console.log(`  ✅ ${ok} applied  ⏭️  ${skipped} skipped  ❌ ${failed} failed`);
        }

        await client.query('COMMIT');
        console.log('\n🎉 Schema migrations complete!');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function getTableExists(pool, tableName) {
    const res = await pool.query(
        `SELECT EXISTS (
            SELECT 1 FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_name = $1
        ) AS exists`,
        [tableName]
    );
    return res.rows[0].exists;
}

async function getRowCount(pool, tableName) {
    try {
        const res = await pool.query(`SELECT COUNT(*) AS count FROM "${tableName}"`);
        return parseInt(res.rows[0].count, 10);
    } catch {
        return -1; // table doesn't exist
    }
}

async function exportData(oldPool) {
    console.log('\n═══════════════════════════════════════════');
    console.log('  PHASE 2: Exporting data from Neon');
    console.log('═══════════════════════════════════════════');

    const data = {};
    for (const table of TABLES) {
        const exists = await getTableExists(oldPool, table);
        if (!exists) {
            console.log(`  ⏭️  ${table} — does not exist, skipping`);
            continue;
        }

        const count = await getRowCount(oldPool, table);
        if (count === 0) {
            console.log(`  📭 ${table} — 0 rows, skipping`);
            data[table] = [];
            continue;
        }

        const res = await oldPool.query(`SELECT * FROM "${table}"`);
        data[table] = res.rows;
        console.log(`  📦 ${table} — ${res.rows.length} rows exported`);
    }

    return data;
}

async function importData(newPool, data) {
    console.log('\n═══════════════════════════════════════════');
    console.log('  PHASE 3: Importing data into Aiven');
    console.log('═══════════════════════════════════════════');

    const client = await newPool.connect();
    let replicationRoleChanged = false;
    let savepointCounter = 0;

    async function queryWithSavepoint(sql, params = []) {
        const sp = `sp_imp_${savepointCounter++}`;
        await client.query(`SAVEPOINT ${sp}`);
        try {
            const result = await client.query(sql, params);
            await client.query(`RELEASE SAVEPOINT ${sp}`);
            return { ok: true, result };
        } catch (err) {
            await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
            await client.query(`RELEASE SAVEPOINT ${sp}`);
            return { ok: false, err };
        }
    }

    try {
        // Disable triggers during import to avoid conflicts (not allowed on many managed DBs)
        try {
            await client.query('SET session_replication_role = replica');
            replicationRoleChanged = true;
        } catch (err) {
            console.log(`  ⚠️  Skip trigger bypass: ${err.message}`);
        }

        await client.query('BEGIN');

        for (const table of TABLES) {
            const rows = data[table];
            if (!rows || rows.length === 0) {
                console.log(`  ⏭️  ${table} — no data to import`);
                continue;
            }

            // Check if table exists on target
            const existsRes = await client.query(
                `SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables 
                    WHERE table_schema = 'public' AND table_name = $1
                ) AS exists`,
                [table]
            );
            if (!existsRes.rows[0].exists) {
                console.log(`  ⚠️  ${table} — does not exist on target, skipping`);
                continue;
            }

            const columns = Object.keys(rows[0]);
            const colList = columns.map(c => `"${c}"`).join(', ');

            let imported = 0;
            let skipped = 0;
            // Insert in batches of 100 (couple_rooms needs row-level handling for active uniqueness conflicts)
            const batchSize = table === 'couple_rooms' ? 1 : 100;
            for (let i = 0; i < rows.length; i += batchSize) {
                const batch = rows.slice(i, i + batchSize);
                const valueSets = [];
                const params = [];
                let paramIdx = 1;

                for (const row of batch) {
                    const placeholders = columns.map(() => `$${paramIdx++}`);
                    valueSets.push(`(${placeholders.join(', ')})`);
                    for (const col of columns) {
                        params.push(row[col]);
                    }
                }

                const insertSQL = `INSERT INTO "${table}" (${colList}) VALUES ${valueSets.join(', ')} ON CONFLICT DO NOTHING`;
                const batchRes = await queryWithSavepoint(insertSQL, params);
                if (batchRes.ok && (table !== 'couple_rooms' || Number(batchRes.result.rowCount || 0) === batch.length)) {
                    imported += Number(batchRes.result.rowCount || 0);
                    continue;
                }

                // Fallback to row-by-row insert for problematic batches (e.g., legacy FK-orphan rows)
                for (const row of batch) {
                    let rowData = row;
                    let rowParams = columns.map(col => rowData[col]);
                    const rowPlaceholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');
                    const rowSQL = `INSERT INTO "${table}" (${colList}) VALUES (${rowPlaceholders}) ON CONFLICT DO NOTHING`;
                    let rowRes = await queryWithSavepoint(rowSQL, rowParams);

                    // Legacy data can violate new active-room uniqueness constraints.
                    // Keep the room by converting conflicting active rows to inactive.
                    if (!rowRes.ok && table === 'couple_rooms' && rowRes.err?.code === '23505') {
                        rowData = { ...rowData, status: 'inactive' };
                        rowParams = columns.map(col => rowData[col]);
                        rowRes = await queryWithSavepoint(rowSQL, rowParams);
                    }

                    if (rowRes.ok && Number(rowRes.result.rowCount || 0) === 0 && table === 'couple_rooms' && rowData.status === 'active') {
                        const inactiveData = { ...rowData, status: 'inactive' };
                        const inactiveParams = columns.map(col => inactiveData[col]);
                        rowRes = await queryWithSavepoint(rowSQL, inactiveParams);
                    }

                    if (rowRes.ok) {
                        imported += Number(rowRes.result.rowCount || 0);
                    } else {
                        skipped++;
                    }
                }
            }

            if (skipped > 0) {
                console.log(`  ✅ ${table} — ${imported} rows imported, ⏭️  ${skipped} rows skipped`);
            } else {
                console.log(`  ✅ ${table} — ${imported} rows imported`);
            }
        }

        await client.query('COMMIT');

        // Re-enable triggers only if changed above
        if (replicationRoleChanged) {
            await client.query('SET session_replication_role = DEFAULT');
        }

        console.log('\n🎉 Data import complete!');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Import failed:', err.message);
        throw err;
    } finally {
        client.release();
    }
}

async function verifyMigration(oldPool, newPool) {
    console.log('\n═══════════════════════════════════════════');
    console.log('  PHASE 4: Verification');
    console.log('═══════════════════════════════════════════');

    let allMatch = true;
    const results = [];

    for (const table of TABLES) {
        const oldExists = await getTableExists(oldPool, table);
        const newExists = await getTableExists(newPool, table);

        if (!oldExists && !newExists) {
            results.push({ table, old: 'N/A', new: 'N/A', status: '⏭️' });
            continue;
        }
        if (!oldExists) {
            results.push({ table, old: 'N/A', new: '✅', status: '🆕' });
            continue;
        }

        const oldCount = await getRowCount(oldPool, table);
        const newCount = await getRowCount(newPool, table);
        const match = oldCount === newCount;
        if (!match) allMatch = false;

        results.push({
            table,
            old: oldCount,
            new: newCount,
            status: match ? '✅' : '❌',
        });
    }

    console.log('\n┌────────────────────┬──────────┬──────────┬────────┐');
    console.log('│ Table              │ Old (Neon)│ New(Aiven)│ Status │');
    console.log('├────────────────────┼──────────┼──────────┼────────┤');
    for (const r of results) {
        const t = r.table.padEnd(18);
        const o = String(r.old).padStart(8);
        const n = String(r.new).padStart(8);
        console.log(`│ ${t} │ ${o} │  ${n} │  ${r.status}   │`);
    }
    console.log('└────────────────────┴──────────┴──────────┴────────┘');

    if (allMatch) {
        console.log('\n✅ All tables match! Migration verified successfully.');
    } else {
        console.log('\n⚠️  Some tables have mismatched counts. Please review.');
    }

    return allMatch;
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  DreamForLove — Database Migration: Neon → Aiven');
    console.log('═══════════════════════════════════════════════════════');

    const oldPool = createPool(OLD_DB_URL, 'OLD (Neon)');
    const newPool = createPool(NEW_DB_URL, 'NEW (Aiven)');

    try {
        // Test connections
        await testConnection(oldPool, 'OLD (Neon)');
        await testConnection(newPool, 'NEW (Aiven)');

        // Phase 1: Run schema migrations on new DB
        await runSchemaMigrations(newPool);

        // Phase 2: Export data from old DB
        const data = await exportData(oldPool);

        // Phase 3: Import data into new DB
        await importData(newPool, data);

        // Phase 4: Verify
        await verifyMigration(oldPool, newPool);

        console.log('\n═══════════════════════════════════════════════════════');
        console.log('  🎉 Migration complete! Update .env and restart the server.');
        console.log('═══════════════════════════════════════════════════════');

    } catch (err) {
        console.error('\n💀 Migration failed:', err);
        process.exit(1);
    } finally {
        await oldPool.end();
        await newPool.end();
    }

    process.exit(0);
}

main();
