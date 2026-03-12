/**
 * Food Controller – Unit Tests
 */
const { mockQuery, mockReq, mockRes, mockNext } = require('./setup');
const { list, create, remove, spin } = require('../src/controllers/food.controller');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Food Controller', () => {
    // ────────────────────────────────────────────────────────
    describe('GET /food (list)', () => {
        it('should return paginated food items', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ total: 8 }] })
                .mockResolvedValueOnce({
                    rows: [
                        { id: 'f1', name: 'Phở', emoji: '🍜' },
                        { id: 'f2', name: 'Bún chả', emoji: '🍖' },
                    ],
                });

            const req = mockReq({ query: { page: '1', limit: '10' } });
            const res = mockRes();
            const next = mockNext();

            await list(req, res, next);

            const response = res.json.mock.calls[0][0];
            expect(response.total).toBe(8);
            expect(response.items).toHaveLength(2);
            expect(response.page).toBe(1);
            expect(response.total_pages).toBe(1);
        });

        it('should handle empty food list', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ total: 0 }] })
                .mockResolvedValueOnce({ rows: [] });

            const req = mockReq({ query: {} });
            const res = mockRes();
            const next = mockNext();

            await list(req, res, next);

            const response = res.json.mock.calls[0][0];
            expect(response.items).toHaveLength(0);
            expect(response.total).toBe(0);
        });
    });

    // ────────────────────────────────────────────────────────
    describe('POST /food (create)', () => {
        it('should create food item when under free limit', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ count: '3' }] })
                .mockResolvedValueOnce({ rows: [{ id: 'f3', name: 'Bún bò' }] });

            const req = mockReq({
                body: { name: 'Bún bò', emoji: '🍜', location: 'Đà Nẵng' },
            });
            const res = mockRes();
            const next = mockNext();

            await create(req, res, next);

            expect(res.status).toHaveBeenCalledWith(201);
        });

        it('should enforce free tier limit', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [{ count: '5' }] });

            const req = mockReq({ body: { name: 'Too many' } });
            const res = mockRes();
            const next = mockNext();

            await create(req, res, next);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json.mock.calls[0][0].code).toBe('UPGRADE_REQUIRED');
        });

        it('should skip limit for premium', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [{ id: 'f4' }] });

            const req = mockReq({
                coupleRoom: { id: 'uuid-room-1', is_premium: true },
                body: { name: 'Premium food' },
            });
            const res = mockRes();
            const next = mockNext();

            await create(req, res, next);

            expect(mockQuery).toHaveBeenCalledTimes(1);
            expect(res.status).toHaveBeenCalledWith(201);
        });
    });

    // ────────────────────────────────────────────────────────
    describe('DELETE /food/:id', () => {
        it('should soft-delete food item', async () => {
            mockQuery.mockResolvedValueOnce({});

            const req = mockReq({ params: { id: 'f1' } });
            const res = mockRes();
            const next = mockNext();

            await remove(req, res, next);

            expect(mockQuery.mock.calls[0][0]).toMatch(/is_deleted = TRUE/);
            expect(res.json).toHaveBeenCalledWith({ success: true });
        });
    });

    // ────────────────────────────────────────────────────────
    describe('GET /food/spin', () => {
        it('should return a random food item', async () => {
            mockQuery.mockResolvedValueOnce({
                rows: [{ id: 'f1', name: 'Phở', emoji: '🍜' }],
            });

            const req = mockReq();
            const res = mockRes();
            const next = mockNext();

            await spin(req, res, next);

            expect(mockQuery.mock.calls[0][0]).toMatch(/ORDER BY RANDOM/);
            expect(res.json).toHaveBeenCalledWith({
                item: { id: 'f1', name: 'Phở', emoji: '🍜' },
            });
        });

        it('should return 404 when no food items', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });

            const req = mockReq();
            const res = mockRes();
            const next = mockNext();

            await spin(req, res, next);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });
});
