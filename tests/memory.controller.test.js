/**
 * Memory Controller – Unit Tests
 */

// Mock storage before loading the controller
jest.mock('../src/config/storage', () => ({
    uploadImage: jest.fn().mockResolvedValue({ url: 'https://r2.example.com/photo.jpg', key: 'memory-photos/abc.jpg' }),
    deleteImage: jest.fn().mockResolvedValue({}),
    parseBase64Image: jest.fn().mockReturnValue({ buffer: Buffer.from('fake'), mimeType: 'image/png' }),
    initStorage: jest.fn(),
}));

const { mockQuery, mockReq, mockRes, mockNext } = require('./setup');
const { uploadImage, deleteImage } = require('../src/config/storage');
const { updateMemoryPhoto } = require('../src/controllers/memory.controller');

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
});

describe('Memory Controller', () => {
    describe('PATCH /couple/memory-photo', () => {
        it('should upload a new photo and return success', async () => {
            // Mock: no old key, then UPDATE
            mockQuery
                .mockResolvedValueOnce({ rows: [{ memory_photo_key: null }] }) // old key check
                .mockResolvedValueOnce({
                    rows: [{ id: 'room-1', memory_photo_url: 'https://r2.example.com/photo.jpg', updated_at: '2026-01-01' }],
                }); // UPDATE

            const req = mockReq({
                body: { image_base64: 'data:image/png;base64,iVBORw0KGgoAAAAN...' },
            });
            const res = mockRes();
            const next = mockNext();

            await updateMemoryPhoto(req, res, next);

            expect(uploadImage).toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ success: true, hasPhoto: true })
            );
        });

        it('should delete old photo before uploading new one', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ memory_photo_key: 'old-key' }] })
                .mockResolvedValueOnce({
                    rows: [{ id: 'room-1', memory_photo_url: 'https://r2.example.com/new.jpg', updated_at: '2026-01-01' }],
                });

            const req = mockReq({
                body: { image_base64: 'data:image/png;base64,abc123' },
            });
            const res = mockRes();
            const next = mockNext();

            await updateMemoryPhoto(req, res, next);

            expect(deleteImage).toHaveBeenCalledWith('old-key');
            expect(uploadImage).toHaveBeenCalled();
        });

        it('should clear photo when image_base64 is null', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ memory_photo_key: 'old-key' }] }) // old key
                .mockResolvedValueOnce({
                    rows: [{ id: 'room-1', memory_photo_url: null, updated_at: '2026-01-01' }],
                });

            const req = mockReq({ body: { image_base64: null } });
            const res = mockRes();
            const next = mockNext();

            await updateMemoryPhoto(req, res, next);

            expect(deleteImage).toHaveBeenCalledWith('old-key');
            expect(uploadImage).not.toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ success: true, hasPhoto: false })
            );
        });

        it('should handle deleteImage failure gracefully', async () => {
            deleteImage.mockRejectedValueOnce(new Error('R2 error'));
            mockQuery
                .mockResolvedValueOnce({ rows: [{ memory_photo_key: 'old-key' }] })
                .mockResolvedValueOnce({
                    rows: [{ id: 'room-1', memory_photo_url: 'https://r2.example.com/new.jpg', updated_at: '2026-01-01' }],
                });

            const req = mockReq({
                body: { image_base64: 'data:image/png;base64,abc' },
            });
            const res = mockRes();
            const next = mockNext();

            await updateMemoryPhoto(req, res, next);

            // Should still succeed even if old image deletion fails
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ success: true })
            );
        });

        it('should call next on database error', async () => {
            const err = new Error('DB error');
            mockQuery
                .mockResolvedValueOnce({ rows: [] })
                .mockRejectedValueOnce(err);

            const req = mockReq({
                body: { image_base64: 'data:image/png;base64,abc' },
            });
            const res = mockRes();
            const next = mockNext();

            await updateMemoryPhoto(req, res, next);

            expect(next).toHaveBeenCalledWith(err);
        });
    });
});
