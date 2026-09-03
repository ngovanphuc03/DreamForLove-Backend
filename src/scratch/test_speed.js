require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const https = require('https');

async function testDatabaseLatency() {
  console.log('--- Kiểm tra tốc độ Database (Aiven) ---');
  const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
  });

  try {
    const startConnect = Date.now();
    const client = await pool.connect();
    const connectTime = Date.now() - startConnect;
    console.log(`⏱️ Thời gian tạo kết nối (TCP + SSL + Auth): ${connectTime}ms`);

    const startQuery = Date.now();
    await client.query('SELECT 1');
    const queryTime = Date.now() - startQuery;
    console.log(`⏱️ Thời gian truy vấn cơ bản (SELECT 1): ${queryTime}ms`);

    const startComplex = Date.now();
    const res = await client.query('SELECT count(*) FROM users');
    const complexTime = Date.now() - startComplex;
    console.log(`⏱️ Thời gian truy vấn bảng users: ${complexTime}ms (Count: ${res.rows[0].count})`);

    client.release();
  } catch (err) {
    console.error('Lỗi kết nối DB:', err.message);
  } finally {
    await pool.end();
  }
}

function testApiLatency(url) {
  return new Promise((resolve) => {
    console.log(`\n--- Kiểm tra tốc độ API (Render) ---`);
    console.log(`Đang gửi request tới: ${url}`);
    
    const start = Date.now();
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const time = Date.now() - start;
        console.log(`⏱️ Thời gian phản hồi API: ${time}ms (Status: ${res.statusCode})`);
        resolve();
      });
    }).on('error', (err) => {
      console.error('Lỗi gọi API:', err.message);
      resolve();
    });
  });
}

async function run() {
  await testDatabaseLatency();
  await testApiLatency('https://dreamforlove-api.onrender.com/health');
}

run();
