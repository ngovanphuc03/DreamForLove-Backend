/**
 * Trip Controller – Unit Tests
 */
const { mockQuery, mockTransaction, mockReq, mockRes, mockNext } = require('./setup');
const { list, create, update, markDone, remove } = require('../src/controllers/trip.controller');

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockTransaction.mockReset();
    mockTransaction.mockImplementation(async (cb) => cb({ query: mockQuery }));
});

describe('Trip Controller', () => {
    describe('GET /trips (list)', () => {
        it('should return paginated trips', async () => {
            const trips = [
                { id: 't1', title: 'Đà Lạt', location: 'Vietnam', is_done: false },
                { id: 't2', title: 'Tokyo', location: 'Japan', is_done: true },
            ];
            mockQuery
                .mockResolvedValueOnce({ rows: [{ total: 2 }] })
                .mockResolvedValueOnce({ rows: trips });

            const req = mockReq({ query: { page: '1', limit: '10' } });
            const res = mockRes();
            const next = mockNext();

            await list(req, res, next);

            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    items: expect.arrayContaining([expect.objectContaining({ id: 't1' })]),
                })
            );
        });

        it('should use default pagination values', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ total: 0 }] })
                .mockResolvedValueOnce({ rows: [] });

            const req = mockReq({ query: {} });
            const res = mockRes();
            const next = mockNext();

            await list(req, res, next);

            expect(res.json).toHaveBeenCalled();
        });

        it('should call next on error', async () => {
            const err = new Error('DB error');
            mockQuery.mockRejectedValueOnce(err);

            const req = mockReq();
            const res = mockRes();
            const next = mockNext();

            await list(req, res, next);

            expect(next).toHaveBeenCalledWith(err);
        });
    });

    describe('POST /trips (create)', () => {
        it('should create a trip and return 201', async () => {
            const trip = { id: 't1', title: 'Đà Lạt', location: 'Vietnam' };
            mockQuery.mockResolvedValueOnce({ rows: [trip] });

            const req = mockReq({
                body: { title: 'Đà Lạt', location: 'Vietnam', note: 'Fun trip' },
            });
            const res = mockRes();
            const next = mockNext();

            await create(req, res, next);

            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
        });
    });

    describe('PATCH /trips/:id (update)', () => {
        it('should update and return the trip', async () => {
            const updated = { id: 't1', title: 'Updated', location: 'Hanoi' };
            mockQuery.mockResolvedValueOnce({ rows: [updated] });

            const req = mockReq({
                params: { id: 't1' },
                body: { title: 'Updated' },
            });
            const res = mockRes();
            const next = mockNext();

            await update(req, res, next);

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ title: 'Updated' }));
        });

        it('should return 404 when trip not found', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });

            const req = mockReq({ params: { id: 'xxx' }, body: {} });
            const res = mockRes();
            const next = mockNext();

            await update(req, res, next);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    describe('DELETE /trips/:id (remove)', () => {
        it('should soft-delete the trip', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [{ id: 't1', is_deleted: true }], rowCount: 1 });

            const req = mockReq({ params: { id: 't1' } });
            const res = mockRes();
            const next = mockNext();

            await remove(req, res, next);

            expect(res.json).toHaveBeenCalledWith({ success: true });
        });
    });

    describe('PATCH /trips/:id/done (markDone)', () => {
        it('should toggle done status', async () => {
            const trip = { id: 't1', is_done: true };
            mockQuery
                .mockResolvedValueOnce({ rows: [{ id: 't1', is_done: false }] }) // SELECT current
                .mockResolvedValueOnce({ rows: [trip] }) // UPDATE trip
                .mockResolvedValueOnce({ rows: [{ love_coins: 30 }] }) // lock room
                .mockResolvedValueOnce({ rows: [{ total: 0 }] }) // sum today
                .mockResolvedValueOnce({ rows: [{ id: 'reward-1', coins_awarded: 10 }] }) // insert reward
                .mockResolvedValueOnce({ rows: [{ love_coins: 40 }] }) // update coins
                .mockResolvedValueOnce({ rows: [] }); // inventory

            const req = mockReq({
                params: { id: 't1' },
                body: { is_done: true },
            });
            const res = mockRes();
            const next = mockNext();

            await markDone(req, res, next);

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ is_done: true }));
        });
    });
});
