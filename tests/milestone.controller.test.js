/**
 * Milestone Controller – Unit Tests
 */
const { mockQuery, mockReq, mockRes, mockNext } = require('./setup');
const { getMilestones, createMilestone, updateMilestone, deleteMilestone } = require('../src/controllers/milestone.controller');

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
});

describe('Milestone Controller', () => {
    describe('GET /milestones', () => {
        it('should return milestones for the couple room', async () => {
            const milestones = [
                { id: 'm1', label: '100 Ngày', target_days: 100, emoji: '🌸' },
                { id: 'm2', label: '1 Năm', target_days: 365, emoji: '💍' },
            ];
            mockQuery.mockResolvedValueOnce({ rows: milestones });

            const req = mockReq();
            const res = mockRes();
            const next = mockNext();

            await getMilestones(req, res, next);

            expect(res.json).toHaveBeenCalledWith({ milestones });
        });

        it('should call next on error', async () => {
            const err = new Error('DB error');
            mockQuery.mockRejectedValueOnce(err);

            const req = mockReq();
            const res = mockRes();
            const next = mockNext();

            await getMilestones(req, res, next);

            expect(next).toHaveBeenCalledWith(err);
        });
    });

    describe('POST /milestones', () => {
        it('should create a custom milestone', async () => {
            const milestone = { id: 'm1', label: 'Kỉ niệm đặc biệt', target_days: 200 };
            mockQuery.mockResolvedValueOnce({ rows: [milestone] });

            const req = mockReq({
                body: { label: 'Kỉ niệm đặc biệt', target_days: 200, emoji: '✨' },
            });
            const res = mockRes();
            const next = mockNext();

            await createMilestone(req, res, next);

            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ label: 'Kỉ niệm đặc biệt' }));
        });
    });

    describe('PATCH /milestones/:id', () => {
        it('should update milestone', async () => {
            const updated = { id: 'm1', label: 'Updated Label', target_days: 250 };
            mockQuery.mockResolvedValueOnce({ rows: [updated] });

            const req = mockReq({
                params: { id: 'm1' },
                body: { label: 'Updated Label' },
            });
            const res = mockRes();
            const next = mockNext();

            await updateMilestone(req, res, next);

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ label: 'Updated Label' }));
        });

        it('should return 404 when milestone not found', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });

            const req = mockReq({ params: { id: 'xxx' }, body: {} });
            const res = mockRes();
            const next = mockNext();

            await updateMilestone(req, res, next);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    describe('DELETE /milestones/:id', () => {
        it('should delete milestone', async () => {
            mockQuery.mockResolvedValueOnce({ rowCount: 1 });

            const req = mockReq({ params: { id: 'm1' } });
            const res = mockRes();
            const next = mockNext();

            await deleteMilestone(req, res, next);

            expect(res.json).toHaveBeenCalledWith({ success: true });
        });
    });
});
