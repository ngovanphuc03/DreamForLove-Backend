/**
 * Wishlist Controller – Unit Tests
 */
const { mockQuery, mockReq, mockRes, mockNext } = require('./setup');
const { list, create, markBought, remove } = require('../src/controllers/wishlist.controller');

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
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
        it('should create wish item', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [{ id: 'w2', name: 'Sách mới' }] });

            const req = mockReq({
                body: { name: 'Sách mới', category: 'Sách', price: 50000, priority: 'mid' },
            });
            const res = mockRes();
            const next = mockNext();

            await create(req, res, next);

            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith({ id: 'w2', name: 'Sách mới' });
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

            expect(mockQuery.mock.calls[0][0]).toMatch(/is_bought = \$3/);
            expect(mockQuery.mock.calls[0][1][2]).toBe(true);
            expect(res.json).toHaveBeenCalledWith({ id: 'w1', is_bought: true });
        });

        it('should unmark item when is_bought=false', async () => {
            mockQuery.mockResolvedValueOnce({
                rows: [{ id: 'w1', is_bought: false, bought_at: null }],
            });

            const req = mockReq({
                params: { id: 'w1' },
                body: { is_bought: false },
            });
            const res = mockRes();
            const next = mockNext();

            await markBought(req, res, next);

            const sql = mockQuery.mock.calls[0][0];
            const params = mockQuery.mock.calls[0][1];
            expect(sql).toMatch(/bought_at = CASE WHEN \$3 THEN NOW\(\) ELSE NULL END/);
            expect(params[2]).toBe(false);
            expect(res.json).toHaveBeenCalledWith({ id: 'w1', is_bought: false, bought_at: null });
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
            mockQuery
                .mockResolvedValueOnce({ rows: [{ id: 'w1', name: 'Gấu bông' }] })
                .mockResolvedValueOnce({});

            const req = mockReq({ params: { id: 'w1' } });
            const res = mockRes();
            const next = mockNext();

            await remove(req, res, next);

            expect(mockQuery.mock.calls[1][0]).toMatch(/is_deleted = TRUE/);
            expect(res.json).toHaveBeenCalledWith({ success: true });
        });
    });
});
