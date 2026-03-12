/**
 * DreamForLove – End-to-End API Test Script
 * Run: node test-api.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const http = require('http');

const BASE = 'http://localhost:3000';
let passed = 0, failed = 0;

// ── helpers ──────────────────────────────────────────────────
function req(method, path, body, token) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: 'localhost', port: 3000, path, method,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        };
        const r = http.request(opts, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        r.on('error', reject);
        if (payload) r.write(payload);
        r.end();
    });
}

function ok(label, cond, extra = '') {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else { console.log(`  ❌ ${label} ${extra}`); failed++; }
}

async function run() {
    console.log('\n══════════════════════════════════════════');
    console.log('  DreamForLove API – E2E Test');
    console.log('══════════════════════════════════════════\n');

    // ── 1. Health ──────────────────────────────────────────────
    console.log('📋 1. Health Check');
    const health = await req('GET', '/health');
    ok('GET /health → 200', health.status === 200);
    ok('status: ok', health.body.status === 'ok');

    // ── 2. Auth – Register ────────────────────────────────────
    console.log('\n📋 2. Auth – Register');
    const regA = await req('POST', '/api/auth/login', {
        firebase_uid: 'testA', email: 'testA@e2e.test',
        display_name: 'Be Gai', provider: 'google'
    });
    ok('POST /auth/login User A → 200', regA.status === 200);
    ok('returns user object', !!regA.body.user?.id);
    const uidA = regA.body.user?.id;

    const regB = await req('POST', '/api/auth/login', {
        firebase_uid: 'testB', email: 'testB@e2e.test',
        display_name: 'Anh Trai', provider: 'google'
    });
    ok('POST /auth/login User B → 200', regB.status === 200);
    const uidB = regB.body.user?.id;

    // ── 3. Auth – GET /me ────────────────────────────────────
    console.log('\n📋 3. Auth – GET /me');
    const meA = await req('GET', '/api/auth/me', null, 'dev_testA');
    ok('GET /auth/me with dev token → 200', meA.status === 200, JSON.stringify(meA.body));
    ok('returns correct user', meA.body.user?.firebase_uid === 'testA');

    const meUnauth = await req('GET', '/api/auth/me');
    ok('GET /auth/me without token → 401', meUnauth.status === 401);

    // ── 4. Couple – Generate code ────────────────────────────
    console.log('\n📋 4. Couple – Pairing Flow');
    const genCode = await req('POST', '/api/couple/generate-code', null, 'dev_testA');
    ok('POST /couple/generate-code → 200', genCode.status === 200, JSON.stringify(genCode.body));
    ok('returns 6-digit code', /^\d{6}$/.test(genCode.body.code));
    const pairCode = genCode.body.code;
    console.log(`     Code: ${pairCode}`);

    // ── 5. Couple – Join ─────────────────────────────────────
    const joinResp = await req('POST', '/api/couple/join',
        { code: pairCode, start_date: '2024-01-15' }, 'dev_testB');
    ok('POST /couple/join → 200', joinResp.status === 200, JSON.stringify(joinResp.body));
    ok('room has id', !!joinResp.body.id);
    ok('days_together ≥ 0', typeof joinResp.body.days_together === 'number' && joinResp.body.days_together >= 0);
    const roomId = joinResp.body.id;
    console.log(`     Room: ${roomId}, days: ${joinResp.body.days_together}`);

    // ── 6. Couple – GET /me ───────────────────────
    const coupleMe = await req('GET', '/api/couple/me', null, 'dev_testA');
    ok('GET /couple/me (User A) → 200', coupleMe.status === 200, JSON.stringify(coupleMe.body));
    ok('couple/me has room', !!coupleMe.body.room?.id);

    // ── 7. Wishlist ───────────────────────────────────────────
    console.log('\n📋 5. Wishlist');
    const addWish = await req('POST', '/api/wishlist',
        { name: 'MacBook Pro', category: 'Tech', price: 50000000, priority: 'high' },
        'dev_testA');
    ok('POST /wishlist → 201', addWish.status === 201, JSON.stringify(addWish.body));
    ok('wish has id', !!addWish.body.id);
    const wishId = addWish.body.item?.id;

    const getWishes = await req('GET', '/api/wishlist', null, 'dev_testA');
    ok('GET /wishlist → 200', getWishes.status === 200);
    ok('list has items', getWishes.body.items?.length > 0);

    // ── 8. Mood ───────────────────────────────────────────────
    console.log('\n📋 6. Mood Log');
    const addMood = await req('POST', '/api/mood',
        { type: 'happy', note: 'Test mood 😊' }, 'dev_testA');
    ok('POST /mood → 201', addMood.status === 201, JSON.stringify(addMood.body));
    ok('mood has id', !!addMood.body.id);

    const getMood = await req('GET', '/api/mood/current', null, 'dev_testA');
    ok('GET /mood/current → 200', getMood.status === 200, JSON.stringify(getMood.body));

    // ── 9. Food ───────────────────────────────────────────────
    console.log('\n📋 7. Food Roulette');
    const addFood = await req('POST', '/api/food',
        { name: 'Pho Bo', emoji: '🍜', location: 'Ha Noi' }, 'dev_testA');
    ok('POST /food → 201', addFood.status === 201, JSON.stringify(addFood.body));
    ok('food has id', !!addFood.body.id);

    const spinFood = await req('GET', '/api/food/spin', null, 'dev_testA');
    ok('GET /food/spin → 200', spinFood.status === 200, JSON.stringify(spinFood.body));
    ok('spin returns food item', !!spinFood.body.item?.name);

    // ── 10. 404 / Validation ──────────────────────────────────
    console.log('\n📋 8. Error Handling');
    const notFound = await req('GET', '/api/nonexistent');
    ok('Unknown route → 404', notFound.status === 404);

    const badWish = await req('POST', '/api/wishlist', { price: 'not-a-number' }, 'dev_testA');
    ok('Bad wishlist body → 422', badWish.status === 422);

    // ── Summary ───────────────────────────────────────────────
    console.log('\n══════════════════════════════════════════');
    console.log(`  Results: ✅ ${passed} passed  ❌ ${failed} failed`);
    console.log('══════════════════════════════════════════\n');

    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
