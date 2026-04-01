/**
 * Mood Controller – Unit Tests
 */
const { mockQuery, mockReq, mockRes, mockNext } = require('./setup');
const { getCurrent, getHistory, create } = require('../src/controllers/mood.controller');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Mood Controller', () => {
    // ────────────────────────────────────────────────────────
    describe('GET /mood/current', () => {
        it('should return both my mood and partner mood', async () => {
            mockQuery.mockResolvedValueOnce({
                rows: [
                    { id: 'm1', type: 'happy', user_id: 'uuid-user-a' },
                    { id: 'm2', type: 'love', user_id: 'uuid-user-b' },
                ],
            });

            const req = mockReq();
            const res = mockRes();
            const next = mockNext();

            await getCurrent(req, res, next);

            const response = res.json.mock.calls[0][0];
            expect(response.my_mood.type).toBe('happy');
            expect(response.partner_mood.type).toBe('love');
        });

        it('should return null when no mood logged today', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });

            const req = mockReq();
            const res = mockRes();
            const next = mockNext();

            await getCurrent(req, res, next);

            const response = res.json.mock.calls[0][0];
            expect(response.my_mood).toBeNull();
            expect(response.partner_mood).toBeNull();
        });
    });

    // ────────────────────────────────────────────────────────
    describe('GET /mood/history', () => {
        it('should return paginated mood history', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ total: 45 }] })
                .mockResolvedValueOnce({
                    rows: [
                        { id: 'm1', type: 'happy' },
                        { id: 'm2', type: 'love' },
                    ],
                });

            const req = mockReq({ query: { page: '2', limit: '10' } });
            const res = mockRes();
            const next = mockNext();

            await getHistory(req, res, next);

            const response = res.json.mock.calls[0][0];
            expect(response.total).toBe(45);
            expect(response.page).toBe(2);
            expect(response.limit).toBe(10);
            expect(response.total_pages).toBe(5);
            expect(response.entries).toHaveLength(2);

            // Verify offset calculation: (page 2 - 1) * 10 = 10
            const selectParams = mockQuery.mock.calls[1][1];
            expect(selectParams[2]).toBe(10);
        });

        it('should clamp limit to max 100', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ total: 0 }] })
                .mockResolvedValueOnce({ rows: [] });

            const req = mockReq({ query: { limit: '999' } });
            const res = mockRes();
            const next = mockNext();

            await getHistory(req, res, next);

            const selectParams = mockQuery.mock.calls[1][1];
            expect(selectParams[1]).toBe(100);
        });
    });

    // ────────────────────────────────────────────────────────
    describe('POST /mood', () => {
        it('should create mood entry and emit socket event', async () => {
            const entry = { id: 'mood-1', type: 'love', user_id: 'uuid-user-a' };
            mockQuery
                .mockResolvedValueOnce({ rows: [entry] })  // INSERT
                .mockResolvedValueOnce({ rows: [{ fcm_token: 'token123', display_name: 'Partner' }] }); // partner query

            const req = mockReq({ body: { type: 'love', note: 'Yêu em ❤️' } });
            const res = mockRes();
            const next = mockNext();

            await create(req, res, next);

            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith(entry);
        });

        it('should propagate database errors', async () => {
            const error = new Error('connection_refused');
            mockQuery.mockRejectedValueOnce(error);

            const req = mockReq({ body: { type: 'happy' } });
            const res = mockRes();
            const next = mockNext();

            await create(req, res, next);

            expect(next).toHaveBeenCalledWith(error);
        });
    });
});
