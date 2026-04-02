/**
 * Pet Controller - Unit Tests
 */
const { mockQuery, mockTransaction, mockReq, mockRes, mockNext } = require('./setup');
const { evolvePet } = require('../src/controllers/pet.controller');

beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockTransaction.mockReset();
    mockTransaction.mockImplementation(async (cb) => cb({ query: mockQuery }));
});

describe('Pet Controller', () => {
    describe('POST /couple/pet/evolve', () => {
        it('should return 400 when pet is already max level', async () => {
            mockQuery.mockResolvedValueOnce({
                rows: [{
                    id: 'pet-1',
                    couple_room_id: 'room-1',
                    pet_name: 'Mochi',
                    evolution_level: 8,
                    total_love_xp: 100000,
                    requires_evolution_stone: false,
                    health: 100,
                    mood: 100,
                    hunger: 100,
                    cleanliness: 100,
                }],
            });

            const req = mockReq({
                dbUser: { id: 'uuid-user-a', display_name: 'Alice' },
                coupleRoom: { id: 'room-1' },
            });
            const res = mockRes();
            const next = mockNext();

            await evolvePet(req, res, next);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: expect.stringContaining('cấp tối đa') })
            );
            expect(next).not.toHaveBeenCalled();
        });

        it('should return 400 when evolution stone is missing', async () => {
            mockQuery
                .mockResolvedValueOnce({
                    rows: [{
                        id: 'pet-1',
                        couple_room_id: 'room-1',
                        pet_name: 'Mochi',
                        evolution_level: 2,
                        total_love_xp: 2000,
                        requires_evolution_stone: true,
                        health: 80,
                        mood: 80,
                        hunger: 80,
                        cleanliness: 80,
                    }],
                })
                .mockResolvedValueOnce({ rows: [{ quantity: 0 }] });

            const req = mockReq({
                dbUser: { id: 'uuid-user-a', display_name: 'Alice' },
                coupleRoom: { id: 'room-1' },
            });
            const res = mockRes();
            const next = mockNext();

            await evolvePet(req, res, next);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: expect.stringContaining('Đá Tiến Hóa') })
            );
            expect(next).not.toHaveBeenCalled();
        });

        it('should evolve pet successfully and return updated state', async () => {
            const petBefore = {
                id: 'pet-1',
                couple_room_id: 'room-1',
                pet_name: 'Mochi',
                evolution_level: 2,
                total_love_xp: 1800,
                requires_evolution_stone: true,
                health: 70,
                mood: 72,
                hunger: 65,
                cleanliness: 60,
                user1_interactions: 10,
                user2_interactions: 9,
                last_fed_at: null,
                last_played_at: null,
                last_bathed_at: null,
                last_petted_at: null,
                last_decay_at: new Date().toISOString(),
            };

            const petAfter = {
                ...petBefore,
                evolution_level: 3,
                requires_evolution_stone: false,
                health: 80,
                mood: 82,
                hunger: 75,
                cleanliness: 70,
            };

            mockQuery
                // transaction callback queries
                .mockResolvedValueOnce({ rows: [petBefore] }) // ensurePet
                .mockResolvedValueOnce({ rows: [{ quantity: 1 }] }) // evolution stone check
                .mockResolvedValueOnce({ rows: [] }) // consume stone
                .mockResolvedValueOnce({ rows: [petAfter] }) // update pet
                .mockResolvedValueOnce({ rows: [] }) // action log
                .mockResolvedValueOnce({ rows: [{ item_id: 'evolution_stone', quantity: 0 }] }) // inventory after
                .mockResolvedValueOnce({ rows: [{ love_coins: 120 }] }) // coins
                // post-transaction queries
                .mockResolvedValueOnce({ rows: [{ partner_id: 'uuid-user-b' }] }) // getPartnerId
                .mockResolvedValueOnce({ rows: [{ cnt: 2 }] }) // my actions today
                .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }); // partner actions today

            const req = mockReq({
                dbUser: { id: 'uuid-user-a', display_name: 'Alice' },
                coupleRoom: { id: 'room-1' },
            });
            const res = mockRes();
            const next = mockNext();

            await evolvePet(req, res, next);

            expect(res.status).not.toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        evolutionLevel: 3,
                        requiresEvolutionStone: false,
                        loveCoins: 120,
                    }),
                    meta: expect.objectContaining({
                        evolved: true,
                        oldLevel: 2,
                        newLevel: 3,
                    }),
                })
            );
            expect(next).not.toHaveBeenCalled();
        });
    });
});
