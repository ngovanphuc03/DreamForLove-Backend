/**
 * DreamForLove - Full database migration from current PostgreSQL to Aiven.
 *
 * Source DB resolution order:
 * 1) MIGRATION_SOURCE_DATABASE_URL
 * 2) SOURCE_DATABASE_URL
 * 3) OLD_DATABASE_URL
 * 4) DB_* parts (DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD)
 *
 * Target DB resolution order:
 * 1) MIGRATION_TARGET_DATABASE_URL
 * 2) AIVEN_DATABASE_URL
 * 3) DATABASE_URL
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const SKIP_CODES = new Set(['42P07', '42710', '42P16', '42P17', '42723']);
const VERIFY_OUTPUT_FILE = path.join(__dirname, 'migrate_to_aiven_result.json');

function formatError(error) {
    if (!error) return 'Unknown error';
    if (typeof error === 'string') return error;
    if (error.message && error.message.trim().length > 0) return error.message;

    if (Array.isArray(error.errors) && error.errors.length > 0) {
        return error.errors
            .map((child) => child?.message || String(child))
            .filter(Boolean)
            .join(' | ');
    }

    const code = error.code ? `code=${error.code}` : '';
    const name = error.name ? `name=${error.name}` : '';
    return [name, code].filter(Boolean).join(', ') || String(error);
}

function quoteIdent(identifier) {
    return `"${String(identifier).replace(/"/g, '""')}"`;
}

function hideCredentials(url) {
    return String(url).replace(/:\/\/[^@]+@/, '://<hidden>@');
}

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

function isLikelyLocalHost(host) {
    const normalized = (host || '').toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function buildUrlFromDbParts() {
    const host = process.env.DB_HOST || 'localhost';
    const port = process.env.DB_PORT || '5432';
    const database = process.env.DB_NAME || 'dreamforlove';
    const user = process.env.DB_USER || 'postgres';
    const password = process.env.DB_PASSWORD;

    const auth = password
        ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
        : encodeURIComponent(user);

    const url = new URL(`postgres://${auth}@${host}:${port}/${database}`);
    if (process.env.DB_SSL === 'true') {
        url.searchParams.set('sslmode', 'require');
    }
    return url.toString();
}

function resolveConnectionUrls() {
    const sourceRaw =
        process.env.MIGRATION_SOURCE_DATABASE_URL
        || process.env.SOURCE_DATABASE_URL
        || process.env.OLD_DATABASE_URL
        || buildUrlFromDbParts();

    const targetRaw =
        process.env.MIGRATION_TARGET_DATABASE_URL
        || process.env.AIVEN_DATABASE_URL
        || process.env.DATABASE_URL;

    if (!targetRaw) {
        throw new Error(
            'Missing target database URL. Set DATABASE_URL or MIGRATION_TARGET_DATABASE_URL to your Aiven connection string.'
        );
    }

    const sourceUrl = normalizeConnectionString(sourceRaw);
    const targetUrl = normalizeConnectionString(targetRaw);

    if (sourceUrl === targetUrl) {
        throw new Error('Source and target database URLs are identical. Refusing to run migration.');
    }

    return { sourceUrl, targetUrl };
}

function shouldUseSsl(connectionString) {
    try {
        const parsed = new URL(connectionString);
        const sslMode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
        if (sslMode === 'disable') return false;
        if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full') return true;
        return !isLikelyLocalHost(parsed.hostname);
    } catch {
        return true;
    }
}

function createPool(connectionString, label) {
    const sslEnabled = shouldUseSsl(connectionString);
    console.log(`\n🔌 ${label}: ${hideCredentials(connectionString)}`);

    return new Pool({
        connectionString,
        ssl: sslEnabled ? { rejectUnauthorized: false } : false,
        max: 8,
        connectionTimeoutMillis: 20000,
        statement_timeout: 120000,
    });
}

async function testConnection(pool, label) {
    const client = await pool.connect();
    try {
        const res = await client.query('SELECT current_database() AS db, current_user AS db_user, NOW() AS now');
        console.log(`   ✅ ${label} connected -> db=${res.rows[0].db}, user=${res.rows[0].db_user}`);
    } finally {
        client.release();
    }
}

function splitStatements(sql) {
    const statements = [];
    let buf = '';
    let dollarTag = null;
    let idx = 0;

    while (idx < sql.length) {
        if (sql[idx] === '$') {
            const m = sql.slice(idx).match(/^\$([A-Za-z_]*)\$/);
            if (m) {
                const tag = m[0];
                buf += tag;
                idx += tag.length;
                if (dollarTag === null) dollarTag = tag;
                else if (tag === dollarTag) dollarTag = null;
                continue;
            }
        }

        if (dollarTag === null && sql[idx] === ';') {
            const stmt = buf.trim();
            const hasSql = stmt.split('\n').some((line) => {
                const trimmed = line.trim();
                return trimmed.length > 0 && !trimmed.startsWith('--');
            });
            if (hasSql) statements.push(stmt);
            buf = '';
            idx += 1;
            continue;
        }

        buf += sql[idx];
        idx += 1;
    }

    const trailing = buf.trim();
    const hasTrailingSql = trailing.split('\n').some((line) => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith('--');
    });
    if (hasTrailingSql) statements.push(trailing);

    return statements;
}

async function runSchemaMigrations(targetPool) {
    console.log('\n═══════════════════════════════════════════');
    console.log('  PHASE 1: Ensure schema exists on Aiven');
    console.log('═══════════════════════════════════════════');

    const migrationFiles = fs.readdirSync(__dirname)
        .filter((fileName) => fileName.endsWith('.sql'))
        .sort();

    const client = await targetPool.connect();
    try {
        await client.query('BEGIN');

        for (const fileName of migrationFiles) {
            const filePath = path.join(__dirname, fileName);
            const sql = fs.readFileSync(filePath, 'utf8');
            const statements = splitStatements(sql);
            let applied = 0;
            let skipped = 0;
            let failed = 0;

            for (let index = 0; index < statements.length; index += 1) {
                const stmt = statements[index];
                const savepoint = `sp_mig_${index}`;
                try {
                    await client.query(`SAVEPOINT ${savepoint}`);
                    await client.query(stmt);
                    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
                    applied += 1;
                } catch (error) {
                    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
                    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
                    if (SKIP_CODES.has(error.code)) {
                        skipped += 1;
                    } else {
                        failed += 1;
                        console.log(`  ❌ ${fileName}: [${error.code}] ${error.message}`);
                    }
                }
            }

            console.log(`  📄 ${fileName}: ✅ ${applied} | ⏭️ ${skipped} | ❌ ${failed}`);
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function getPublicTables(pool) {
    const res = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
    `);
    return res.rows.map((row) => row.table_name);
}

async function getTableColumns(pool, tableName) {
    const res = await pool.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
        `,
        [tableName]
    );
    return res.rows.map((row) => row.column_name);
}

async function getForeignKeyEdges(pool) {
    const res = await pool.query(`
        SELECT
            child.relname AS child_table,
            parent.relname AS parent_table
        FROM pg_constraint fk
        JOIN pg_class child ON child.oid = fk.conrelid
        JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
        JOIN pg_class parent ON parent.oid = fk.confrelid
        JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
        WHERE fk.contype = 'f'
          AND child_ns.nspname = 'public'
          AND parent_ns.nspname = 'public'
    `);
    return res.rows.map((row) => ({ child: row.child_table, parent: row.parent_table }));
}

function sortTablesByDependencies(tables, edges) {
    const tableSet = new Set(tables);
    const inDegree = new Map();
    const graph = new Map();

    for (const table of tables) {
        inDegree.set(table, 0);
        graph.set(table, []);
    }

    for (const edge of edges) {
        if (!tableSet.has(edge.child) || !tableSet.has(edge.parent)) continue;
        graph.get(edge.parent).push(edge.child);
        inDegree.set(edge.child, (inDegree.get(edge.child) || 0) + 1);
    }

    const queue = tables.filter((table) => inDegree.get(table) === 0).sort();
    const ordered = [];

    while (queue.length > 0) {
        const current = queue.shift();
        ordered.push(current);

        const children = graph.get(current) || [];
        for (const child of children) {
            const nextInDegree = (inDegree.get(child) || 0) - 1;
            inDegree.set(child, nextInDegree);
            if (nextInDegree === 0) queue.push(child);
        }
        queue.sort();
    }

    if (ordered.length === tables.length) {
        return ordered;
    }

    const remaining = tables.filter((table) => !ordered.includes(table)).sort();
    return [...ordered, ...remaining];
}

async function truncateTables(targetClient, tableNames) {
    if (tableNames.length === 0) return;
    const list = tableNames.map((tableName) => quoteIdent(tableName)).join(', ');
    await targetClient.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

function buildInsertStatement(tableName, columns, rowCount) {
    const columnList = columns.map((column) => quoteIdent(column)).join(', ');
    const valuesSql = [];
    let paramIndex = 1;

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const placeholders = [];
        for (let colIndex = 0; colIndex < columns.length; colIndex += 1) {
            placeholders.push(`$${paramIndex}`);
            paramIndex += 1;
        }
        valuesSql.push(`(${placeholders.join(', ')})`);
    }

    return `INSERT INTO ${quoteIdent(tableName)} (${columnList}) VALUES ${valuesSql.join(', ')}`;
}

async function importTableData(sourcePool, targetClient, tableName, columns) {
    const quotedColumns = columns.map((column) => quoteIdent(column)).join(', ');
    const sourceRowsRes = await sourcePool.query(`SELECT ${quotedColumns} FROM ${quoteIdent(tableName)}`);
    const rows = sourceRowsRes.rows;

    if (rows.length === 0) {
        return { sourceCount: 0, inserted: 0, skipped: 0 };
    }

    let inserted = 0;
    let skipped = 0;

    const maxParams = 60000;
    const batchSize = Math.max(1, Math.floor(maxParams / columns.length));

    for (let start = 0; start < rows.length; start += batchSize) {
        const batch = rows.slice(start, start + batchSize);
        const params = [];
        for (const row of batch) {
            for (const col of columns) {
                let val = row[col];
                if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
                    val = JSON.stringify(val);
                }
                params.push(val);
            }
        }

        const sql = buildInsertStatement(tableName, columns, batch.length);
        const batchSp = `sp_batch_${start}`;
        try {
            await targetClient.query(`SAVEPOINT ${batchSp}`);
            const result = await targetClient.query(sql, params);
            await targetClient.query(`RELEASE SAVEPOINT ${batchSp}`);
            inserted += Number(result.rowCount || 0);
        } catch (batchErr) {
            console.log(`  [DEBUG] Batch insert error on ${tableName}: ${batchErr.message}`);
            await targetClient.query(`ROLLBACK TO SAVEPOINT ${batchSp}`);
            await targetClient.query(`RELEASE SAVEPOINT ${batchSp}`);
            for (const row of batch) {
                const rowParams = columns.map((col) => {
                    let val = row[col];
                    if (val !== null && typeof val === 'object' && !(val instanceof Date)) {
                        return JSON.stringify(val);
                    }
                    return val;
                });
                const rowSql = `
                    INSERT INTO ${quoteIdent(tableName)}
                    (${columns.map((col) => quoteIdent(col)).join(', ')})
                    VALUES (${columns.map((_, idx) => `$${idx + 1}`).join(', ')})
                    ON CONFLICT DO NOTHING
                `;
                const rowSp = `sp_row_${start}_${columns.length}`;
                try {
                    await targetClient.query(`SAVEPOINT ${rowSp}`);
                    const rowResult = await targetClient.query(rowSql, rowParams);
                    await targetClient.query(`RELEASE SAVEPOINT ${rowSp}`);
                    inserted += Number(rowResult.rowCount || 0);
                    if (Number(rowResult.rowCount || 0) === 0) skipped += 1;
                } catch (rowErr) {
                    console.log(`  [DEBUG] Row insert error on ${tableName}: ${rowErr.message}`);
                    await targetClient.query(`ROLLBACK TO SAVEPOINT ${rowSp}`);
                    await targetClient.query(`RELEASE SAVEPOINT ${rowSp}`);
                    skipped += 1;
                }
            }
        }
    }

    return { sourceCount: rows.length, inserted, skipped };
}

async function syncSequences(targetClient, importedTables) {
    const importedSet = new Set(importedTables);
    const res = await targetClient.query(`
        SELECT
            seq_n.nspname AS seq_schema,
            seq.relname AS seq_name,
            tab.relname AS table_name,
            col.attname AS column_name
        FROM pg_class seq
        JOIN pg_namespace seq_n ON seq_n.oid = seq.relnamespace
        JOIN pg_depend dep ON dep.objid = seq.oid AND dep.deptype = 'a'
        JOIN pg_class tab ON tab.oid = dep.refobjid
        JOIN pg_namespace tab_n ON tab_n.oid = tab.relnamespace
        JOIN pg_attribute col ON col.attrelid = tab.oid AND col.attnum = dep.refobjsubid
        WHERE seq.relkind = 'S'
          AND seq_n.nspname = 'public'
          AND tab_n.nspname = 'public'
        ORDER BY tab.relname, col.attname
    `);

    for (const row of res.rows) {
        if (!importedSet.has(row.table_name)) continue;

        const qualifiedSeq = `${quoteIdent(row.seq_schema)}.${quoteIdent(row.seq_name)}`;
        const qualifiedTable = `${quoteIdent('public')}.${quoteIdent(row.table_name)}`;
        const qualifiedCol = quoteIdent(row.column_name);

        const sp = `sp_seq_${row.seq_name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        try {
            await targetClient.query(`SAVEPOINT ${sp}`);
            await targetClient.query(`
                SELECT setval(
                    ${qualifiedSeq}::regclass,
                    COALESCE((SELECT MAX(${qualifiedCol}) FROM ${qualifiedTable}), 0) + 1,
                    false
                )
            `);
            await targetClient.query(`RELEASE SAVEPOINT ${sp}`);
        } catch (seqErr) {
            await targetClient.query(`ROLLBACK TO SAVEPOINT ${sp}`);
            await targetClient.query(`RELEASE SAVEPOINT ${sp}`);
            console.log(`  ⚠️  Cannot sync sequence ${row.seq_name}: ${formatError(seqErr)}`);
        }
    }
}

async function countRows(pool, tableName) {
    const res = await pool.query(`SELECT COUNT(*)::bigint AS count FROM ${quoteIdent(tableName)}`);
    return Number(res.rows[0].count);
}

async function verifyRowCounts(sourcePool, targetPool, tables) {
    console.log('\n═══════════════════════════════════════════');
    console.log('  PHASE 4: Verify row counts');
    console.log('═══════════════════════════════════════════');

    const rows = [];
    let allMatched = true;

    for (const tableName of tables) {
        const sourceCount = await countRows(sourcePool, tableName);
        const targetCount = await countRows(targetPool, tableName);
        const matched = sourceCount === targetCount;
        if (!matched) allMatched = false;
        rows.push({ tableName, sourceCount, targetCount, matched });
    }

    for (const row of rows) {
        const status = row.matched ? '✅' : '❌';
        console.log(`  ${status} ${row.tableName}: source=${row.sourceCount}, target=${row.targetCount}`);
    }

    return { allMatched, rows };
}

async function getAllForeignKeyConstraints(pool) {
    const res = await pool.query(`
        SELECT
            conname AS constraint_name,
            conrelid::regclass::text AS table_name,
            pg_get_constraintdef(oid) AS constraint_def
        FROM pg_constraint
        WHERE contype = 'f'
          AND connamespace = 'public'::regnamespace
        ORDER BY conrelid::regclass::text, conname
    `);
    return res.rows;
}

async function migrateAllData(sourcePool, targetPool) {
    console.log('\n═══════════════════════════════════════════');
    console.log('  PHASE 2: Copy all data from source to Aiven');
    console.log('═══════════════════════════════════════════');

    const sourceTables = await getPublicTables(sourcePool);
    const targetTables = new Set(await getPublicTables(targetPool));
    const missingOnTarget = sourceTables.filter((tableName) => !targetTables.has(tableName));
    const transferableTables = sourceTables.filter((tableName) => targetTables.has(tableName));

    if (missingOnTarget.length > 0) {
        console.log(`  ⚠️  Missing on target (${missingOnTarget.length}): ${missingOnTarget.join(', ')}`);
    }

    const fkEdges = await getForeignKeyEdges(sourcePool);
    const importOrder = sortTablesByDependencies(transferableTables, fkEdges);

    // Save FK constraints before dropping them
    console.log('\n  📋 Saving FK constraints...');
    const fkConstraints = await getAllForeignKeyConstraints(targetPool);
    console.log(`  📋 Found ${fkConstraints.length} FK constraints to handle`);

    const client = await targetPool.connect();
    const importStats = [];

    try {
        await client.query('BEGIN');

        // Drop all FK constraints (works on Aiven without special permissions)
        if (fkConstraints.length > 0) {
            console.log('  🔓 Dropping FK constraints for clean import...');
            for (const fk of fkConstraints) {
                const sp = `sp_drop_fk_${fk.constraint_name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                try {
                    await client.query(`SAVEPOINT ${sp}`);
                    await client.query(`ALTER TABLE ${quoteIdent(fk.table_name)} DROP CONSTRAINT ${quoteIdent(fk.constraint_name)}`);
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                } catch (dropErr) {
                    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                    console.log(`  ⚠️  Cannot drop FK ${fk.constraint_name}: ${formatError(dropErr)}`);
                }
            }
            console.log(`  ✅ FK constraints dropped`);
        }

        // Drop unique indexes that might prevent importing legacy duplicate active rooms
        try {
            await client.query('DROP INDEX IF EXISTS ux_couple_rooms_active_user_a');
            await client.query('DROP INDEX IF EXISTS ux_couple_rooms_active_user_b');
            console.log('  🔓 Dropped uniqueness constraints on couple_rooms to allow legacy data import');
        } catch (idxErr) {
            console.log(`  ⚠️  Cannot drop unique indexes: ${formatError(idxErr)}`);
        }

        await truncateTables(client, transferableTables);

        for (const tableName of importOrder) {
            const sourceColumns = await getTableColumns(sourcePool, tableName);
            const targetColumns = new Set(await getTableColumns(targetPool, tableName));
            const commonColumns = sourceColumns.filter((column) => targetColumns.has(column));

            if (commonColumns.length === 0) {
                console.log(`  ⏭️  ${tableName}: no common columns, skipped`);
                importStats.push({ tableName, sourceCount: 0, inserted: 0, skipped: 0, skippedEntireTable: true });
                continue;
            }

            const stats = await importTableData(sourcePool, client, tableName, commonColumns);
            importStats.push({ tableName, ...stats, skippedEntireTable: false });

            if (stats.skipped > 0) {
                console.log(`  ✅ ${tableName}: inserted=${stats.inserted}, skipped=${stats.skipped}`);
            } else {
                console.log(`  ✅ ${tableName}: inserted=${stats.inserted}`);
            }
        }

        await syncSequences(client, transferableTables);

        // Recreate FK constraints
        if (fkConstraints.length > 0) {
            console.log('\n  🔒 Restoring FK constraints...');
            let restored = 0;
            let failedFks = 0;
            for (const fk of fkConstraints) {
                const sp = `sp_add_fk_${fk.constraint_name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                try {
                    await client.query(`SAVEPOINT ${sp}`);
                    await client.query(`ALTER TABLE ${quoteIdent(fk.table_name)} ADD CONSTRAINT ${quoteIdent(fk.constraint_name)} ${fk.constraint_def}`);
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                    restored++;
                } catch (addErr) {
                    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                    failedFks++;
                    console.log(`  ❌ Cannot restore FK ${fk.constraint_name} on ${fk.table_name}: ${formatError(addErr)}`);
                }
            }
            console.log(`  ✅ FK constraints restored: ${restored} ok, ${failedFks} failed`);
        }

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }


    return { missingOnTarget, transferableTables, importStats };
}

async function main() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  DreamForLove - Full DB Migration to Aiven');
    console.log('═══════════════════════════════════════════════════════');

    const { sourceUrl, targetUrl } = resolveConnectionUrls();
    const sourcePool = createPool(sourceUrl, 'SOURCE DB');
    const targetPool = createPool(targetUrl, 'TARGET AIVEN DB');

    const result = {
        startedAt: new Date().toISOString(),
        source: hideCredentials(sourceUrl),
        target: hideCredentials(targetUrl),
        ok: false,
        missingOnTarget: [],
        verification: [],
        notes: [],
    };

    try {
        await testConnection(sourcePool, 'SOURCE');
        await testConnection(targetPool, 'TARGET');

        await runSchemaMigrations(targetPool);
        const importResult = await migrateAllData(sourcePool, targetPool);

        result.missingOnTarget = importResult.missingOnTarget;
        if (importResult.missingOnTarget.length > 0) {
            result.notes.push('Some source tables do not exist on target schema.');
        }

        const verification = await verifyRowCounts(sourcePool, targetPool, importResult.transferableTables);
        result.verification = verification.rows;

        result.ok = verification.allMatched && importResult.missingOnTarget.length === 0;

        if (result.ok) {
            console.log('\n🎉 Migration succeeded: all transferable tables matched.');
        } else {
            console.log('\n⚠️  Migration completed with warnings. Check migrate_to_aiven_result.json.');
        }
    } catch (error) {
        const errorText = formatError(error);
        result.notes.push(errorText);
        console.error('\n💀 Migration failed:', errorText);
    } finally {
        result.finishedAt = new Date().toISOString();
        fs.writeFileSync(VERIFY_OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf8');
        await sourcePool.end();
        await targetPool.end();
    }

    process.exit(result.ok ? 0 : 1);
}

main();
