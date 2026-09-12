import {
    RateLimiter,
    Unit,
    SendCommandFn,
} from '..';

import {
    createRedisClient,
    createIORedisClient,
    flushRedis,
    validateLimiterResponse,
} from './shared';

describe('RateLimiter input modes', () => {
    jest.setTimeout(60000);

    const redisClient = createRedisClient();
    const ioredisClient = createIORedisClient();

    beforeAll(async () => {
        if (typeof redisClient.connect === 'function') {
            try {
                await redisClient.connect();
            }
            catch (err) { console.log(err) } // Ignore 'already connected' or 'connecting' errors
        }
    });

    afterAll(async () => {
        for (const client of [redisClient, ioredisClient]) {
            try {
                await client.quit();
            }
            catch (err) {
                try {
                    client.quit();
                }
                catch (err) { console.log(err) }
            }
        }
    });

    it('throws when both client and sendCommand are provided', () => {
        const create = () => new RateLimiter({
            client: ioredisClient,
            sendCommand: (...args: string[]) => ioredisClient.call(args[0], ...args.slice(1)),
            window: { unit: Unit.SECOND, size: 1 },
            limit: 5,
        });

        expect(create).toThrow('Provide either `client` or `sendCommand`, not both');
    });

    it('throws when neither client nor sendCommand is provided', () => {
        const create = () => new RateLimiter({
            window: { unit: Unit.SECOND, size: 1 },
            limit: 5,
        });

        expect(create).toThrow('Provide either `client` or `sendCommand`');
    });

    const clientModeCases = [
        { name: 'redis', client: redisClient },
        { name: 'ioredis', client: ioredisClient },
    ];

    for (const { name, client } of clientModeCases) {
        it(`client mode admits then denies for ${name}`, async () => {
            const limiter = new RateLimiter({
                client,
                window: { unit: Unit.SECOND, size: 1 },
                limit: 2,
            });

            await flushRedis(limiter);

            const key = `mode-client-${name}`;

            const first = await limiter.get(key);
            const second = await limiter.get(key);
            const third = await limiter.get(key);

            validateLimiterResponse(first, { allowed: true, remaining: 1 });
            validateLimiterResponse(second, { allowed: true, remaining: 0 });
            expect(third.allowed).toBe(false);
        });
    }

    it('callback mode works with a lambda wrapping a real client', async () => {
        const sendCommand: SendCommandFn = (...args) => ioredisClient.call(args[0], ...args.slice(1));

        const limiter = new RateLimiter({
            sendCommand,
            window: { unit: Unit.SECOND, size: 1 },
            limit: 1,
        });

        await flushRedis(limiter);

        const key = 'mode-callback';

        const first = await limiter.get(key);
        const second = await limiter.get(key);

        expect(first.allowed).toBe(true);
        expect(second.allowed).toBe(false);
    });
});
