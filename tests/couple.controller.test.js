/**
 * Couple Controller – Unit Tests
 */
const { mockQuery, mockTransaction, mockReq, mockRes, mockNext } = require('./setup');
const {
    getMyRoom,
    generateCode,
    disconnect,
    getProgress,
} = require('../src/controllers/couple.controller');

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockTransaction.mockReset();
});

// ────────────────────────────────────────────────────────────
describe('getMyRoom', () => {
    it('should return room data when user is in a couple', async () => {
        const room = {
            id: 'room-1',
            user_a_id: 'u1',
            user_b_id: 'u2',
            status: 'active',
            start_date: '2024-01-01',
            my_name: 'Alice',
            partner_name: 'Bob',
            days_together: 100,
        };
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 'u1', display_name: 'Alice', photo_url: null }] })  // user lookup
            .mockResolvedValueOnce({ rows: [room] })           // room lookup
            .mockResolvedValueOnce({ rows: [{ display_name: 'Bob', photo_url: null }] }); // partner lookup

        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        await getMyRoom(req, res, next);

        expect(res.json).toHaveBeenCalledWith({
            room: expect.objectContaining({
                id: 'room-1',
                user_display_name: 'Alice',
                partner_name: 'Bob',
                is_active: true,
            })
        });
    });

    it('should return room:null when user has no couple room', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
            .mockResolvedValueOnce({ rows: [] });

        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        await getMyRoom(req, res, next);

        expect(res.json).toHaveBeenCalledWith({ room: null });
    });

    it('should return 404 when user not found in DB', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        await getMyRoom(req, res, next);

        expect(res.status).toHaveBeenCalledWith(404);
    });
});

// ────────────────────────────────────────────────────────────
describe('generateCode', () => {
    it('should generate a 6-digit code and return it', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })   // user lookup
            .mockResolvedValueOnce({ rows: [] })                 // active room check
            .mockResolvedValueOnce({ rows: [] })                 // invalidate old codes
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'pc-1' }] }); // insert pairing_code

        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        await generateCode(req, res, next);

        expect(res.json).toHaveBeenCalled();
        const call = res.json.mock.calls[0][0];
        expect(call.code).toMatch(/^\d{6}$/);
        expect(call.expires_in_seconds).toBe(900);
    });

    it('should return 409 when user already has an active room', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })
            .mockResolvedValueOnce({ rows: [{ id: 'room-1' }] });

        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        await generateCode(req, res, next);

        expect(res.status).toHaveBeenCalledWith(409);
    });

    it('should return 404 when user not found', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        await generateCode(req, res, next);

        expect(res.status).toHaveBeenCalledWith(404);
    });
});

// ────────────────────────────────────────────────────────────
describe('disconnect', () => {
    it('should soft-deactivate the couple room', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const req = mockReq({ coupleRoom: { id: 'room-1' } });
        const res = mockRes();
        const next = mockNext();

        await disconnect(req, res, next);

        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ success: true })
        );
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining("status         = 'inactive'"),
            ['room-1', 30]
        );
    });

    it('should handle DB errors gracefully', async () => {
        const err = new Error('DB timeout');
        mockQuery.mockRejectedValueOnce(err);

        const req = mockReq({ coupleRoom: { id: 'room-1' } });
        const res = mockRes();
        const next = mockNext();

        await disconnect(req, res, next);

        expect(next).toHaveBeenCalledWith(err);
    });
});

// ────────────────────────────────────────────────────────────
describe('getProgress', () => {
    it('should return computed streak and level payload', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ me_done: true, partner_done: false }] })
            .mockResolvedValueOnce({ rows: [{ current_streak: 3 }] })
            .mockResolvedValueOnce({ rows: [{ best_streak: 8 }] })
            .mockResolvedValueOnce({ rows: [{ total_qualified_days: 10 }] });

        const req = mockReq({
            dbUser: { id: 'uuid-user-a', display_name: 'A' },
            coupleRoom: {
                id: 'uuid-room-1',
                user_a_id: 'uuid-user-a',
                user_b_id: 'uuid-user-b',
            },
        });
        const res = mockRes();
        const next = mockNext();

        await getProgress(req, res, next);

        expect(res.json).toHaveBeenCalledWith({
            data: {
                currentStreak: 3,
                bestStreak: 8,
                totalXp: 250,
                currentLevel: 3,
                xpToNextLevel: 200,
                freezeCount: 0,
                today: {
                    meDone: true,
                    partnerDone: false,
                    qualified: false,
                },
            },
        });
    });

    it('should forward DB errors to next()', async () => {
        const err = new Error('progress query failed');
        mockQuery.mockRejectedValueOnce(err);

        const req = mockReq({
            coupleRoom: {
                id: 'uuid-room-1',
                user_a_id: 'uuid-user-a',
                user_b_id: 'uuid-user-b',
            },
        });
        const res = mockRes();
        const next = mockNext();

        await getProgress(req, res, next);

        expect(next).toHaveBeenCalledWith(err);
    });
});
