/**
 * Couple Controller – Unit Tests
 */
const { mockQuery, mockTransaction, mockReq, mockRes, mockNext } = require('./setup');
const { getMyRoom, generateCode, joinWithCode, disconnect } = require('../src/controllers/couple.controller');

beforeEach(() => {
    jest.clearAllMocks();
});

// ────────────────────────────────────────────────────────────
describe('getMyRoom', () => {
    it('should return room data when user is in a couple', async () => {
        const room = {
            id: 'room-1',
            user_a_id: 'u1',
            user_b_id: 'u2',
            start_date: '2024-01-01',
            my_name: 'Alice',
            partner_name: 'Bob',
            days_together: 100,
        };
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 'u1' }] })  // user lookup
            .mockResolvedValueOnce({ rows: [room] });           // room lookup

        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        await getMyRoom(req, res, next);

        expect(res.json).toHaveBeenCalledWith({ room });
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
            .mockResolvedValueOnce({ rows: [] })                 // invalidate old codes
            .mockResolvedValueOnce({ rows: [] })                 // check uniqueness (no collision)
            .mockResolvedValueOnce({ rows: [] });                // INSERT pairing_code

        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        await generateCode(req, res, next);

        expect(res.json).toHaveBeenCalled();
        const call = res.json.mock.calls[0][0];
        expect(call.code).toMatch(/^\d{6}$/);
        expect(call.expires_in_seconds).toBe(900);
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
            ['room-1']
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
