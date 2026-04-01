/**
 * Partner Service – Unit Tests
 */
const { mockQuery } = require('./setup');
const { getPartner } = require('../src/services/partner.service');

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
});

describe('Partner Service', () => {
    describe('getPartner()', () => {
        it('should return partner when found', async () => {
            const partner = { id: 'partner-1', fcm_token: 'token-xyz', display_name: 'Bé Yêu' };
            mockQuery.mockResolvedValueOnce({ rows: [partner] });

            const result = await getPartner('user-1', 'room-1');

            expect(result).toEqual(partner);
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('couple_rooms'),
                ['user-1', 'room-1']
            );
        });

        it('should return null when no partner found', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });

            const result = await getPartner('user-1', 'room-1');

            expect(result).toBeNull();
        });

        it('should throw on database error', async () => {
            const err = new Error('DB down');
            mockQuery.mockRejectedValueOnce(err);

            await expect(getPartner('user-1', 'room-1')).rejects.toThrow('DB down');
        });
    });
});
