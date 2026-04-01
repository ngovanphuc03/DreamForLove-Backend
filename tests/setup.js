/**
 * DreamForLove – Test Setup
 * Mocks for database, firebase, and shared test utilities.
 */

// ── Mock database ────────────────────────────────────────────
const mockQuery = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../src/config/database', () => ({
    query: (...args) => mockQuery(...args),
    transaction: (cb) => mockTransaction(cb),
    initDB: jest.fn(),
    getPool: jest.fn(),
}));

// ── Mock firebase ────────────────────────────────────────────
jest.mock('../src/config/firebase', () => ({
    verifyIdToken: jest.fn(),
    initFirebase: jest.fn(),
    sendPushNotification: jest.fn().mockResolvedValue({}),
}));

// ── Mock logger (suppress console noise) ─────────────────────
jest.mock('../src/config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
}));

// ── Mock socket handler ──────────────────────────────────────
jest.mock('../src/socket/socket.handler', () => ({
    getIO: jest.fn(() => ({
        to: jest.fn(() => ({
            except: jest.fn(() => ({
                emit: jest.fn(),
            })),
            emit: jest.fn(),
        })),
    })),
    initSocket: jest.fn(),
    isUserOnline: jest.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────
function mockReq(overrides = {}) {
    return {
        user: { uid: 'firebase_uid_001', email: 'test@test.com' },
        dbUser: { id: 'uuid-user-a', display_name: 'Test User' },
        coupleRoom: { id: 'uuid-room-1', is_premium: false },
        body: {},
        params: {},
        query: {},
        headers: {},
        ...overrides,
    };
}

function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

function mockNext() {
    return jest.fn();
}

module.exports = { mockQuery, mockTransaction, mockReq, mockRes, mockNext };
