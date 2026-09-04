/**
 * Doodle Controller – Unit Tests
 */
const { mockQuery, mockReq, mockRes, mockNext } = require('./setup');
const {
    getLatestDoodle,
    getDoodleHistory,
    getDoodleById,
    createDoodle,
} = require('../src/controllers/doodle.controller');

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
});

describe('Doodle Controller', () => {
    describe('GET /api/doodles/latest', () => {
        it('should return the latest doodle for the couple room', async () => {
            const mockDoodle = {
                id: 'd-1',
                couple_room_id: 'room-1',
                sender_id: 'user-1',
                sender_name: 'Anh yêu',
                strokes_data: [{ points: [{ x: 10, y: 10, t: 0 }] }],
                image_base64: 'base64data',
                is_chain: false,
            };

            mockQuery.mockResolvedValueOnce({ rows: [mockDoodle] });

            const req = mockReq();
            const res = mockRes();
            const next = mockNext();

            await getLatestDoodle(req, res, next);

            expect(res.json).toHaveBeenCalledWith({ doodle: mockDoodle });
        });

        it('should return null when no doodle exists', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });

            const req = mockReq();
            const res = mockRes();
            const next = mockNext();

            await getLatestDoodle(req, res, next);

            expect(res.json).toHaveBeenCalledWith({ doodle: null });
        });
    });

    describe('GET /api/doodles/history', () => {
        it('should return paginated doodle history', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ count: '2' }] })
                .mockResolvedValueOnce({
                    rows: [
                        { id: 'd-1', sender_name: 'Anh' },
                        { id: 'd-2', sender_name: 'Em' },
                    ],
                });

            const req = mockReq({ query: { page: '1', limit: '10' } });
            const res = mockRes();
            const next = mockNext();

            await getDoodleHistory(req, res, next);

            const data = res.json.mock.calls[0][0];
            expect(data.doodles.length).toBe(2);
            expect(data.pagination.total).toBe(2);
        });
    });

    describe('GET /api/doodles/:id', () => {
        it('should return single doodle when found', async () => {
            const mockDoodle = { id: 'd-1', couple_room_id: 'room-1' };
            mockQuery.mockResolvedValueOnce({ rows: [mockDoodle] });

            const req = mockReq({ params: { id: 'd-1' } });
            const res = mockRes();
            const next = mockNext();

            await getDoodleById(req, res, next);

            expect(res.json).toHaveBeenCalledWith({ doodle: mockDoodle });
        });

        it('should return 404 when doodle not found', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });

            const req = mockReq({ params: { id: 'not-found' } });
            const res = mockRes();
            const next = mockNext();

            await getDoodleById(req, res, next);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    describe('POST /api/doodles', () => {
        it('should create doodle and return 201', async () => {
            const created = {
                id: 'd-new',
                couple_room_id: 'room-1',
                sender_id: 'user-1',
                is_chain: false,
            };
            mockQuery.mockResolvedValueOnce({ rows: [created] });

            const req = mockReq({
                body: {
                    strokes_data: [{ points: [] }],
                    image_base64: 'abc',
                },
            });
            const res = mockRes();
            const next = mockNext();

            await createDoodle(req, res, next);

            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith({
                success: true,
                doodle: created,
            });
        });

        it('should create co-op chain doodle when is_chain is true', async () => {
            const created = {
                id: 'd-chain',
                couple_room_id: 'room-1',
                sender_id: 'user-1',
                is_chain: true,
                parent_doodle_id: 'd-prev',
            };
            mockQuery.mockResolvedValueOnce({ rows: [created] });

            const req = mockReq({
                body: {
                    strokes_data: [{ points: [] }],
                    image_base64: 'abc',
                    is_chain: true,
                    parent_doodle_id: 'd-prev',
                },
            });
            const res = mockRes();
            const next = mockNext();

            await createDoodle(req, res, next);

            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json.mock.calls[0][0].doodle.is_chain).toBe(true);
        });
    });
});
