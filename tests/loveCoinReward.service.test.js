const { awardLoveCoins } = require('../src/services/loveCoinReward.service');

describe('Love Coin Reward Service', () => {
    const originalDailyCap = process.env.LOVE_COIN_DAILY_CAP;

    afterEach(() => {
        process.env.LOVE_COIN_DAILY_CAP = originalDailyCap;
    });

    it('should award coins when reward key is new and daily cap allows', async () => {
        process.env.LOVE_COIN_DAILY_CAP = '40';

        const client = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [{ love_coins: 50 }] })
                .mockResolvedValueOnce({ rows: [{ total: 0 }] })
                .mockResolvedValueOnce({ rows: [{ id: 'reward-1', coins_awarded: 8 }] })
                .mockResolvedValueOnce({ rows: [{ love_coins: 58 }] })
                .mockResolvedValueOnce({ rows: [{ item_id: 'basic_food', quantity: 2 }] }),
        };

        const result = await awardLoveCoins({
            client,
            coupleRoomId: 'room-1',
            rewardType: 'mood_daily_pair',
            rewardKey: '2026-04-03',
            coins: 8,
            awardedBy: 'user-1',
            metadata: { source: 'test' },
        });

        expect(result).toEqual({
            awardedCoins: 8,
            reason: 'awarded',
            loveCoins: 58,
            inventory: [{ id: 'basic_food', qty: 2 }],
        });
    });

    it('should skip reward when key already exists', async () => {
        process.env.LOVE_COIN_DAILY_CAP = '40';

        const client = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [{ love_coins: 50 }] })
                .mockResolvedValueOnce({ rows: [{ total: 0 }] })
                .mockResolvedValueOnce({ rows: [] }),
        };

        const result = await awardLoveCoins({
            client,
            coupleRoomId: 'room-1',
            rewardType: 'mood_daily_pair',
            rewardKey: '2026-04-03',
            coins: 8,
        });

        expect(result).toEqual({
            awardedCoins: 0,
            reason: 'duplicate',
            loveCoins: 50,
            inventory: [],
        });
        expect(client.query).toHaveBeenCalledTimes(3);
    });

    it('should apply partial reward when remaining cap is lower than requested coins', async () => {
        process.env.LOVE_COIN_DAILY_CAP = '10';

        const client = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [{ love_coins: 20 }] })
                .mockResolvedValueOnce({ rows: [{ total: 7 }] })
                .mockResolvedValueOnce({ rows: [{ id: 'reward-1', coins_awarded: 3 }] })
                .mockResolvedValueOnce({ rows: [{ love_coins: 23 }] })
                .mockResolvedValueOnce({ rows: [] }),
        };

        const result = await awardLoveCoins({
            client,
            coupleRoomId: 'room-1',
            rewardType: 'trip_done',
            rewardKey: 'trip-1',
            coins: 10,
        });

        expect(result.awardedCoins).toBe(3);
        expect(result.reason).toBe('capped_partial');
        expect(result.loveCoins).toBe(23);
    });

    it('should stop awarding when daily cap is exhausted', async () => {
        process.env.LOVE_COIN_DAILY_CAP = '10';

        const client = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [{ love_coins: 20 }] })
                .mockResolvedValueOnce({ rows: [{ total: 10 }] }),
        };

        const result = await awardLoveCoins({
            client,
            coupleRoomId: 'room-1',
            rewardType: 'wishlist_bought',
            rewardKey: 'wish-1',
            coins: 5,
        });

        expect(result).toEqual({
            awardedCoins: 0,
            reason: 'daily_cap_reached',
            loveCoins: 20,
            inventory: [],
        });
        expect(client.query).toHaveBeenCalledTimes(2);
    });
});