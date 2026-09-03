require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

async function check() {
  const srcPool = new Pool({ connectionString: process.env.MIGRATION_SOURCE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const tgtPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
      const srcExp = await srcPool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'pet_expeditions'");
      console.log('=== SOURCE pet_expeditions schema ===');
      srcExp.rows.forEach(r => console.log(JSON.stringify(r)));

      // Also let's try to insert ONE row into target manually to see what the exact error is
      const row = {
        "id":"166d7355-9fe6-4cee-bbd9-49a51f3a09e6",
        "couple_room_id":"16353944-e09b-4f72-8e1b-96d8455d3003",
        "expedition_type":"forest",
        "duration_hours":8,
        "status":"collected",
        "loot_data":JSON.stringify([{"tier":"uncommon","type":"coins","amount":26},{"tier":"common","type":"coins","amount":16},{"tier":"common","type":"coins","amount":16}]),
        "started_at":"2026-04-13T09:28:23.784Z",
        "ends_at":"2026-04-13T17:28:23.798Z",
        "collected_at":"2026-04-13T18:36:34.789Z",
        "started_by":"ff8ae1c5-f563-42f9-8579-e6ed6cc3194a",
        "created_at":"2026-04-13T09:28:23.784Z"
      };

      const columns = Object.keys(row);
      const params = Object.values(row);
      const sql = `INSERT INTO pet_expeditions (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${columns.map((_, i) => '$' + (i+1)).join(', ')})`;
      
      try {
        await tgtPool.query("ALTER TABLE pet_expeditions DROP CONSTRAINT IF EXISTS pet_expeditions_couple_room_id_fkey");
        await tgtPool.query("DELETE FROM pet_expeditions WHERE id = $1", [row.id]);
        await tgtPool.query(sql, params);
        console.log("Insert successful!");
      } catch (err) {
        console.log("INSERT ERROR:", err.message);
      }
      
  } finally {
      await srcPool.end();
      await tgtPool.end();
  }
}
check().catch(e => { console.error(e.message); process.exit(1); });
