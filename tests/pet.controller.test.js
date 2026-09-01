/**
 * Pet Controller - Unit Tests
 */
const { mockQuery, mockTransaction, mockReq, mockRes, mockNext } = require('./setup');
const {
    evolvePet,
    performAction,
    getDailyQuests,
    claimDailyQuestReward,
    getPetPersonality,
} = require('../src/controllers/pet.controller');

function makePetState(overrides = {}) {
    return {
        id: 'pet-1',
        couple_room_id: 'room-1',
        pet_name: 'Mochi',
        health: 70,
        mood: 72,
        hunger: 40,
        cleanliness: 60,
        evolution_level: 2,
        total_love_xp: 100,
        requires_evolution_stone: false,
        user1_interactions: 10,
        user2_interactions: 9,
        last_fed_at: null,
        last_played_at: null,
        last_bathed_at: null,
        last_petted_at: null,
        last_decay_at: new Date().toISOString(),
        ...overrides,
    };
}

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
                .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }) // partner actions today
                .mockResolvedValueOnce({
                    rows: [{
                        total_care: 12,
                        feed_count: 4,
                        pet_count: 3,
                        bathe_count: 2,
                        play_count: 3,
                        shop_count: 1,
                    }]
                }) // personality action summary
                .mockResolvedValueOnce({
                    rows: [
                        { day: '2026-04-11', user_id: 'uuid-user-a', cnt: 2 },
                        { day: '2026-04-11', user_id: 'uuid-user-b', cnt: 1 },
                    ]
                }) // personality daily contributions
                .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }); // expeditions in lookback

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

    describe('POST /couple/pet/:action (feed item selection)', () => {
        function setupFeedActionMocks({ petBefore, petAfter, inventoryCheckRows, inventoryAfterRows }) {
            mockQuery.mockImplementation((sql, params) => {
                const text = String(sql).replace(/\s+/g, ' ').trim();

                if (text.includes('SELECT * FROM couple_pet WHERE couple_room_id = $1')) {
                    return Promise.resolve({ rows: [petBefore] });
                }

                if (text.includes('SELECT id FROM couple_rooms WHERE id = $1 FOR UPDATE')) {
                    return Promise.resolve({ rows: [{ id: 'room-1' }] });
                }

                if (text.includes('FROM pet_inventory') && text.includes('item_id = ANY($2::varchar[])')) {
                    return Promise.resolve({ rows: inventoryCheckRows });
                }

                if (text.includes('UPDATE pet_inventory') && text.includes('quantity = quantity - 1')) {
                    return Promise.resolve({ rows: [] });
                }

                if (text.includes('SELECT COUNT(*)::int AS cnt FROM pet_care_actions') && text.includes('AND user_id = $2')) {
                    const uid = params?.[1];
                    return Promise.resolve({ rows: [{ cnt: uid === 'uuid-user-a' ? 1 : 0 }] });
                }

                if (text.includes('SELECT user_a_id FROM couple_rooms WHERE id = $1')) {
                    return Promise.resolve({ rows: [{ user_a_id: 'uuid-user-a' }] });
                }

                if (text.includes('UPDATE couple_pet') && text.includes('RETURNING *')) {
                    return Promise.resolve({ rows: [petAfter] });
                }

                if (text.includes('INSERT INTO pet_care_actions')) {
                    return Promise.resolve({ rows: [] });
                }

                if (text.includes('COUNT(DISTINCT user_id)::int AS contributors')) {
                    return Promise.resolve({ rows: [{ contributors: 1 }] });
                }

                if (text.includes('INSERT INTO coin_reward_logs')) {
                    return Promise.resolve({ rows: [] });
                }

                if (text.includes('UPDATE couple_rooms SET love_coins = love_coins + $2 WHERE id = $1')) {
                    return Promise.resolve({ rows: [] });
                }

                if (text.includes('SELECT CASE') && text.includes('AS partner_id')) {
                    return Promise.resolve({ rows: [] });
                }

                if (text.includes('SELECT love_coins FROM couple_rooms WHERE id = $1')) {
                    return Promise.resolve({ rows: [{ love_coins: 150 }] });
                }

                if (text.includes('SELECT item_id, quantity FROM pet_inventory WHERE couple_room_id = $1')) {
                    return Promise.resolve({ rows: inventoryAfterRows });
                }

                if (text.includes('SELECT (created_at AT TIME ZONE') || text.includes('FROM pet_expeditions')) {
                    return Promise.resolve({ rows: [] });
                }

                if (text.includes('INSERT INTO pet_achievements') || text.includes('UPDATE pet_achievements')) {
                    return Promise.resolve({ rows: [] });
                }

                return Promise.resolve({ rows: [] });
            });
        }

        it('should consume basic_food when itemId is explicitly basic_food', async () => {
            const petBefore = makePetState();
            const petAfter = makePetState({ hunger: 70, health: 80, total_love_xp: 125 });

            setupFeedActionMocks({
                petBefore,
                petAfter,
                inventoryCheckRows: [{ item_id: 'basic_food', quantity: 2 }],
                inventoryAfterRows: [{ item_id: 'basic_food', quantity: 1 }],
            });

            const req = mockReq({
                params: { action: 'feed' },
                body: { itemId: 'basic_food' },
                dbUser: { id: 'uuid-user-a', display_name: 'Alice' },
                coupleRoom: { id: 'room-1' },
            });
            const res = mockRes();
            const next = mockNext();

            await performAction(req, res, next);

            expect(res.json).toHaveBeenCalled();
            const response = res.json.mock.calls[0][0];
            expect(response.meta).toEqual(expect.objectContaining({
                action: 'feed',
                consumedItemId: 'basic_food',
            }));

            const inventoryCheckCall = mockQuery.mock.calls.find((call) =>
                String(call[0]).includes('item_id = ANY($2::varchar[])')
            );
            const preferredItems = inventoryCheckCall?.[1]?.[1];
            expect(preferredItems).toEqual(['basic_food']);
            expect(next).not.toHaveBeenCalled();
        });

        it('should consume premium_food when itemId is explicitly premium_food', async () => {
            const petBefore = makePetState();
            const petAfter = makePetState({ hunger: 70, health: 80, total_love_xp: 125 });

            setupFeedActionMocks({
                petBefore,
                petAfter,
                inventoryCheckRows: [{ item_id: 'premium_food', quantity: 1 }],
                inventoryAfterRows: [{ item_id: 'premium_food', quantity: 0 }],
            });

            const req = mockReq({
                params: { action: 'feed' },
                body: { itemId: 'premium_food' },
                dbUser: { id: 'uuid-user-a', display_name: 'Alice' },
                coupleRoom: { id: 'room-1' },
            });
            const res = mockRes();
            const next = mockNext();

            await performAction(req, res, next);

            expect(res.json).toHaveBeenCalled();
            const response = res.json.mock.calls[0][0];
            expect(response.meta).toEqual(expect.objectContaining({
                action: 'feed',
                consumedItemId: 'premium_food',
            }));

            const inventoryCheckCall = mockQuery.mock.calls.find((call) =>
                String(call[0]).includes('item_id = ANY($2::varchar[])')
            );
            const preferredItems = inventoryCheckCall?.[1]?.[1];
            expect(preferredItems).toEqual(['premium_food']);
            expect(next).not.toHaveBeenCalled();
        });

        it('should fallback to premium_food when basic_food is unavailable and itemId is omitted', async () => {
            const petBefore = makePetState();
            const petAfter = makePetState({ hunger: 70, health: 80, total_love_xp: 125 });

            setupFeedActionMocks({
                petBefore,
                petAfter,
                inventoryCheckRows: [{ item_id: 'premium_food', quantity: 2 }],
                inventoryAfterRows: [{ item_id: 'premium_food', quantity: 1 }],
            });

            const req = mockReq({
                params: { action: 'feed' },
                body: {},
                dbUser: { id: 'uuid-user-a', display_name: 'Alice' },
                coupleRoom: { id: 'room-1' },
            });
            const res = mockRes();
            const next = mockNext();

            await performAction(req, res, next);

            expect(res.json).toHaveBeenCalled();
            const response = res.json.mock.calls[0][0];
            expect(response.meta).toEqual(expect.objectContaining({
                action: 'feed',
                consumedItemId: 'premium_food',
            }));

            const inventoryCheckCall = mockQuery.mock.calls.find((call) =>
                String(call[0]).includes('item_id = ANY($2::varchar[])')
            );
            const preferredItems = inventoryCheckCall?.[1]?.[1];
            expect(preferredItems).toEqual(['basic_food', 'premium_food']);
            expect(next).not.toHaveBeenCalled();
        });
    });

    describe('Daily Quests', () => {
        it('GET /couple/pet/daily-quests should return snapshot with canClaim=true when all quests complete', async () => {
            const petState = makePetState({
                health: 80,
                mood: 80,
                hunger: 80,
                cleanliness: 80,
            });

            mockQuery
                .mockResolvedValueOnce({ rows: [petState] }) // ensurePet
                .mockResolvedValueOnce({ rows: [{ partner_id: 'uuid-user-b' }] }) // getPartnerId
                .mockResolvedValueOnce({ rows: [{ cnt: 4 }] }) // myActionsToday
                .mockResolvedValueOnce({ rows: [{ cnt: 2 }] }) // partnerActionsToday
                .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }) // expeditions collected today
                .mockResolvedValueOnce({ rows: [] }); // not yet claimed

            const req = mockReq({
                dbUser: { id: 'uuid-user-a', display_name: 'Alice' },
                coupleRoom: { id: 'room-1' },
            });
            const res = mockRes();
            const next = mockNext();

            await getDailyQuests(req, res, next);

            expect(res.status).not.toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        claimed: false,
                        canClaim: true,
                        completedCount: 4,
                        totalCount: 4,
                    }),
                })
            );
            expect(next).not.toHaveBeenCalled();
        });

        it('POST /couple/pet/daily-quests/claim should award coins once when eligible', async () => {
            const petState = makePetState({
                health: 82,
                mood: 84,
                hunger: 80,
                cleanliness: 78,
            });

            mockQuery
                .mockResolvedValueOnce({ rows: [petState] }) // ensurePet
                .mockResolvedValueOnce({ rows: [{ partner_id: 'uuid-user-b' }] }) // getPartnerId
                .mockResolvedValueOnce({ rows: [{ cnt: 4 }] }) // myActionsToday
                .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }) // partnerActionsToday
                .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }) // expeditions collected today
                .mockResolvedValueOnce({ rows: [] }) // claim check: not claimed
                .mockResolvedValueOnce({ rows: [{ id: 'reward-log-1' }] }) // insert reward log
                .mockResolvedValueOnce({ rows: [] }) // update love coins
                .mockResolvedValueOnce({ rows: [{ love_coins: 236 }] }); // select updated love coins

            const req = mockReq({
                dbUser: { id: 'uuid-user-a', display_name: 'Alice' },
                coupleRoom: { id: 'room-1' },
            });
            const res = mockRes();
            const next = mockNext();

            await claimDailyQuestReward(req, res, next);

            expect(res.status).not.toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        coinsAwarded: 36,
                        loveCoins: 236,
                    }),
                })
            );
            expect(next).not.toHaveBeenCalled();
        });

        it('POST /couple/pet/daily-quests/claim should return 409 when already claimed', async () => {
            const petState = makePetState({
                health: 82,
                mood: 84,
                hunger: 80,
                cleanliness: 78,
            });

            mockQuery
                .mockResolvedValueOnce({ rows: [petState] }) // ensurePet
                .mockResolvedValueOnce({ rows: [{ partner_id: 'uuid-user-b' }] }) // getPartnerId
                .mockResolvedValueOnce({ rows: [{ cnt: 4 }] }) // myActionsToday
                .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }) // partnerActionsToday
                .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }) // expeditions collected today
                .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // already claimed

            const req = mockReq({
                dbUser: { id: 'uuid-user-a', display_name: 'Alice' },
                coupleRoom: { id: 'room-1' },
            });
            const res = mockRes();
            const next = mockNext();

            await claimDailyQuestReward(req, res, next);

            expect(res.status).toHaveBeenCalledWith(409);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: expect.stringContaining('đã nhận thưởng') })
            );
            expect(next).not.toHaveBeenCalled();
        });
    });

    describe('Pet Personality', () => {
        it('GET /couple/pet/personality should return active personality and large catalog', async () => {
            const petState = makePetState({
                health: 86,
                mood: 88,
                hunger: 79,
                cleanliness: 83,
                personality_skill_last_triggered_at: null,
                personality_signature_seed: 'roomseed123',
            });

            mockQuery
                .mockResolvedValueOnce({ rows: [{ partner_id: 'uuid-user-b' }] }) // getPartnerId
                .mockResolvedValueOnce({ rows: [petState] }) // ensurePet select
                .mockResolvedValueOnce({ rows: [{ cnt: 3 }] }) // my actions today
                .mockResolvedValueOnce({ rows: [{ cnt: 2 }] }) // partner actions today
                .mockResolvedValueOnce({
                    rows: [{
                        total_care: 22,
                        feed_count: 7,
                        pet_count: 6,
                        bathe_count: 4,
                        play_count: 5,
                        shop_count: 3,
                    }]
                }) // personality action summary
                .mockResolvedValueOnce({
                    rows: [
                        { day: '2026-04-10', user_id: 'uuid-user-a', cnt: 2 },
                        { day: '2026-04-10', user_id: 'uuid-user-b', cnt: 2 },
                        { day: '2026-04-11', user_id: 'uuid-user-a', cnt: 1 },
                        { day: '2026-04-11', user_id: 'uuid-user-b', cnt: 1 },
                    ]
                }) // personality daily contributions
                .mockResolvedValueOnce({ rows: [{ cnt: 2 }] }); // expedition count

            const req = mockReq({
                dbUser: { id: 'uuid-user-a', display_name: 'Alice' },
                coupleRoom: { id: 'room-1' },
            });
            const res = mockRes();
            const next = mockNext();

            await getPetPersonality(req, res, next);

            expect(res.status).not.toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        lookbackDays: 14,
                        active: expect.objectContaining({
                            id: expect.any(String),
                            name: expect.any(String),
                        }),
                        personalities: expect.any(Array),
                    }),
                })
            );

            const response = res.json.mock.calls[0][0];
            expect(response.data.personalities.length).toBeGreaterThanOrEqual(20);
            expect(next).not.toHaveBeenCalled();
        });
    });
});
