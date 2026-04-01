/**
 * Auth Controller – Unit Tests
 */
const { mockQuery, mockReq, mockRes, mockNext } = require('./setup');
const { login, getMe, updateFcmToken } = require('../src/controllers/auth.controller');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Auth Controller', () => {
    // ────────────────────────────────────────────────────────
    describe('POST /auth/login', () => {
        it('should upsert user and return user data', async () => {
            const fakeUser = {
                id: 'uuid-001',
                firebase_uid: 'firebase_uid_001',
                email: 'test@test.com',
                display_name: 'Bé Yêu',
            };
            mockQuery.mockResolvedValueOnce({ rows: [fakeUser] });

            const req = mockReq({
                body: { display_name: 'Bé Yêu', photo_url: null },
            });
            const res = mockRes();
            const next = mockNext();

            await login(req, res, next);

            expect(mockQuery).toHaveBeenCalledTimes(1);
            expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO users/);
            expect(res.json).toHaveBeenCalledWith({ user: fakeUser });
            expect(next).not.toHaveBeenCalled();
        });

        it('should use firebase_uid from req.user (not body)', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1' }] });

            const req = mockReq({
                user: { uid: 'secure_uid', email: 'secure@mail.com', firebase: { sign_in_provider: 'google.com' } },
                body: { display_name: 'Name' },
            });
            const res = mockRes();
            const next = mockNext();

            await login(req, res, next);

            // The second argument in the query params should be 'secure_uid'
            const queryParams = mockQuery.mock.calls[0][1];
            expect(queryParams[1]).toBe('secure_uid');
            expect(queryParams[2]).toBe('secure@mail.com');
        });

        it('should call next(err) on database error', async () => {
            const dbError = new Error('DB connection failed');
            mockQuery.mockRejectedValueOnce(dbError);

            const req = mockReq({ body: {} });
            const res = mockRes();
            const next = mockNext();

            await login(req, res, next);

            expect(next).toHaveBeenCalledWith(dbError);
        });
    });

    // ────────────────────────────────────────────────────────
    describe('GET /auth/me', () => {
        it('should return user when found', async () => {
            const user = { id: 'u1', display_name: 'Test' };
            mockQuery.mockResolvedValueOnce({ rows: [user] });

            const req = mockReq();
            const res = mockRes();
            const next = mockNext();

            await getMe(req, res, next);

            expect(res.json).toHaveBeenCalledWith({ user });
        });

        it('should return 404 when user not found', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });

            const req = mockReq();
            const res = mockRes();
            const next = mockNext();

            await getMe(req, res, next);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith({ error: 'User not found' });
        });
    });

    // ────────────────────────────────────────────────────────
    describe('PATCH /auth/fcm-token', () => {
        it('should update FCM token successfully', async () => {
            mockQuery.mockResolvedValueOnce({});

            const req = mockReq({ body: { token: 'fcm_token_xyz' } });
            const res = mockRes();
            const next = mockNext();

            await updateFcmToken(req, res, next);

            expect(mockQuery).toHaveBeenCalledTimes(1);
            expect(mockQuery.mock.calls[0][0]).toMatch(/UPDATE users SET fcm_token/);
            expect(res.json).toHaveBeenCalledWith({ success: true });
        });
    });
});
