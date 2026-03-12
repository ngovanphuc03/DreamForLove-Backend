/**
 * Wishlist Controller – Unit Tests
 */
const { mockQuery, mockReq, mockRes, mockNext } = require('./setup');
const { list, create, markBought, remove } = require('../src/controllers/wishlist.controller');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Wishlist Controller', () => {
    // ────────────────────────────────────────────────────────
    describe('GET /wishlist (list)', () => {
        it('should return paginated wish items', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ total: 25 }] })  // COUNT
                .mockResolvedValueOnce({ rows: [{ id: 'w1', name: 'Gấu bông' }] });  // SELECT

            const req = mockReq({ query: { page: '1', limit: '20' } });
            const res = mockRes();
            const next = mockNext();

            await list(req, res, next);

            expect(mockQuery).toHaveBeenCalledTimes(2);
            // Verify pagination params
            const selectParams = mockQuery.mock.calls[1][1];
            expect(selectParams).toEqual(['uuid-room-1', 20, 0]);

            const response = res.json.mock.calls[0][0];
            expect(response.total).toBe(25);
            expect(response.page).toBe(1);
            expect(response.limit).toBe(20);
            expect(response.total_pages).toBe(2);
            expect(response.items).toHaveLength(1);
        });

        it('should clamp limit to max 50', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ total: 5 }] })
                .mockResolvedValueOnce({ rows: [] });

            const req = mockReq({ query: { page: '1', limit: '999' } });
            const res = mockRes();
            const next = mockNext();

            await list(req, res, next);

            const selectParams = mockQuery.mock.calls[1][1];
            expect(selectParams[1]).toBe(50); // clamped to max
        });

        it('should default to page 1 with limit 20', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ total: 0 }] })
                .mockResolvedValueOnce({ rows: [] });

            const req = mockReq({ query: {} });
            const res = mockRes();
            const next = mockNext();

            await list(req, res, next);

            const selectParams = mockQuery.mock.calls[1][1];
            expect(selectParams[1]).toBe(20);
            expect(selectParams[2]).toBe(0);
        });
    });

    // ────────────────────────────────────────────────────────
    describe('POST /wishlist (create)', () => {
        it('should create wish item when under free limit', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ count: '3' }] })  // count check
                .mockResolvedValueOnce({ rows: [{ id: 'w2', name: 'Sách mới' }] });

            const req = mockReq({
                body: { name: 'Sách mới', category: 'Sách', price: 50000, priority: 'mid' },
            });
            const res = mockRes();
            const next = mockNext();

            await create(req, res, next);

            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith({ id: 'w2', name: 'Sách mới' });
        });

        it('should return 403 when free tier limit exceeded', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [{ count: '10' }] });

            const req = mockReq({
                coupleRoom: { id: 'uuid-room-1', is_premium: false },
                body: { name: 'Vượt giới hạn' },
            });
            const res = mockRes();
            const next = mockNext();

            await create(req, res, next);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json.mock.calls[0][0].code).toBe('UPGRADE_REQUIRED');
        });

        it('should skip limit check for premium users', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [{ id: 'w3', name: 'Premium item' }] });

            const req = mockReq({
                coupleRoom: { id: 'uuid-room-1', is_premium: true },
                body: { name: 'Premium item' },
            });
            const res = mockRes();
            const next = mockNext();

            await create(req, res, next);

            // Only 1 query (INSERT), no count check
            expect(mockQuery).toHaveBeenCalledTimes(1);
            expect(res.status).toHaveBeenCalledWith(201);
        });
    });

    // ────────────────────────────────────────────────────────
    describe('PATCH /wishlist/:id/bought', () => {
        it('should mark item as bought', async () => {
            mockQuery.mockResolvedValueOnce({
                rows: [{ id: 'w1', is_bought: true }],
            });

            const req = mockReq({ params: { id: 'w1' } });
            const res = mockRes();
            const next = mockNext();

            await markBought(req, res, next);

            expect(mockQuery.mock.calls[0][0]).toMatch(/is_bought = TRUE/);
            expect(res.json).toHaveBeenCalledWith({ id: 'w1', is_bought: true });
        });

        it('should return 404 for non-existent item', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });

            const req = mockReq({ params: { id: 'invalid' } });
            const res = mockRes();
            const next = mockNext();

            await markBought(req, res, next);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    // ────────────────────────────────────────────────────────
    describe('DELETE /wishlist/:id', () => {
        it('should soft-delete item', async () => {
            mockQuery.mockResolvedValueOnce({});

            const req = mockReq({ params: { id: 'w1' } });
            const res = mockRes();
            const next = mockNext();

            await remove(req, res, next);

            expect(mockQuery.mock.calls[0][0]).toMatch(/is_deleted = TRUE/);
            expect(res.json).toHaveBeenCalledWith({ success: true });
        });
    });
});
