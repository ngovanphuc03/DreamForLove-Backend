/**
 * Middleware – Unit Tests
 * Tests for auth middleware, couple middleware, errorHandler, rate limiter, validate
 */
const { mockQuery, mockReq, mockRes, mockNext } = require('./setup');

// Re-import after mocks are set up
const { requireCouple } = require('../src/middleware/couple.middleware');
const { validateRequest } = require('../src/middleware/validate.middleware');
const { errorHandler } = require('../src/middleware/errorHandler');
const { attachRequestId } = require('../src/middleware/request-id.middleware');

beforeEach(() => {
    jest.clearAllMocks();
});

// ────────────────────────────────────────────────────────────
describe('Couple Middleware (requireCouple)', () => {
    it('should attach coupleRoom when user is in an active room', async () => {
        const room = { id: 'room-1', user_a_id: 'u1', status: 'active' };
        mockQuery.mockResolvedValueOnce({ rows: [room] });

        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        await requireCouple(req, res, next);

        expect(req.coupleRoom).toEqual(room);
        expect(next).toHaveBeenCalledWith();
    });

    it('should return 403 when user has no couple room', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        await requireCouple(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json.mock.calls[0][0].code).toBe('NOT_IN_COUPLE_ROOM');
    });

    it('should return 401 when dbUser is missing', async () => {
        const req = mockReq({ dbUser: undefined });
        const res = mockRes();
        const next = mockNext();

        await requireCouple(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
    });
});

// ────────────────────────────────────────────────────────────
describe('Error Handler', () => {
    it('should handle validation errors with 422', () => {
        const err = { type: 'validation', errors: [{ msg: 'invalid' }] };
        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(422);
    });

    it('should handle Postgres unique violation (23505) with 409', () => {
        const err = { code: '23505', message: 'duplicate key' };
        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(409);
    });

    it('should handle Postgres FK violation (23503) with 400', () => {
        const err = { code: '23503', message: 'fk violated' };
        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should handle Postgres check violation (23514) with 400', () => {
        const err = { code: '23514', message: 'check violated' };
        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 500 for unknown errors', () => {
        const err = new Error('kaboom');
        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should return generic message in production', () => {
        const oldEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';

        const err = new Error('secret error');
        const req = mockReq();
        const res = mockRes();
        const next = mockNext();

        errorHandler(err, req, res, next);

        expect(res.json.mock.calls[0][0].error).toBe('Internal server error');
        process.env.NODE_ENV = oldEnv;
    });
});

// ────────────────────────────────────────────────────────────
describe('Rate Limiter exports', () => {
    it('should export apiLimiter, authLimiter, codeLimiter, generateCodeLimiter', () => {
        const rateLimiters = require('../src/middleware/rateLimiter');
        expect(rateLimiters.apiLimiter).toBeDefined();
        expect(rateLimiters.authLimiter).toBeDefined();
        expect(rateLimiters.codeLimiter).toBeDefined();
        expect(rateLimiters.generateCodeLimiter).toBeDefined();
    });
});

// ────────────────────────────────────────────────────────────
describe('Request ID middleware', () => {
    it('should generate request id when header is missing', () => {
        const req = { headers: {} };
        const res = { setHeader: jest.fn() };
        const next = mockNext();

        attachRequestId(req, res, next);

        expect(req.requestId).toBeDefined();
        expect(typeof req.requestId).toBe('string');
        expect(res.setHeader).toHaveBeenCalledWith('x-request-id', req.requestId);
        expect(next).toHaveBeenCalled();
    });

    it('should reuse incoming x-request-id header', () => {
        const req = { headers: { 'x-request-id': 'req-abc-123' } };
        const res = { setHeader: jest.fn() };
        const next = mockNext();

        attachRequestId(req, res, next);

        expect(req.requestId).toBe('req-abc-123');
        expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'req-abc-123');
        expect(next).toHaveBeenCalled();
    });
});
