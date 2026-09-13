import {
    RateLimiter,
    Unit,
} from '..';

import { RedisClientWrapper } from '../RateLimiter';

import {
    createRedisClient,
    createIORedisClient,
    flushRedis,
    validateLimiterResponse,
    sendRawCommand,
} from './shared';

describe('RateLimiter integration', () => {
    jest.setTimeout(60000);

    const testClients: any[] = [
        ['redis', createRedisClient()],
        ['ioredis', createIORedisClient()],
    ];

    beforeAll(async () => {
        for (const [name, client] of testClients) {
            if (name === 'redis' && typeof client.connect === 'function') {
                try {
                    await client.connect();
                }
                catch (err) { console.log(err) } // Ignore 'already connected' or 'connecting' errors
            }
        }
    });

    afterAll(async () => {
        for (const [, client] of testClients) {
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

    for (const [name, client] of testClients) {
        const tag = `[${name}]`;

        /**
         * A large parallel burst on a single key must never admit more than the
         * configured limit: every concurrent request is a distinct member, so the
         * atomic script decides them independently and the allow count is capped.
         */
        it(`${tag} a 100-way parallel burst never admits more than the limit`, async () => {
            const limit = 10;

            const limiter = new RateLimiter({
                client,
                window: { unit: Unit.SECOND, size: 1 },
                limit,
            });

            await flushRedis(limiter);

            const key = `${tag} concurrency-burst`;
            const burstSize = 100;

            const requests = Array.from({ length: burstSize }, () => limiter.get(key));
            const results = await Promise.all(requests);

            const allowedCount = results.filter(r => r.allowed).length;

            expect(allowedCount).toBeGreaterThan(0);
            expect(allowedCount).toBeLessThanOrEqual(limit);
        });

        /**
         * If the cached script is evicted from Redis (SCRIPT FLUSH), the next call
         * hits NOSCRIPT and the limiter must transparently reload the script and
         * still return a correct decision.
         */
        it(`${tag} reloads the script transparently after SCRIPT FLUSH`, async () => {
            const limiter = new RateLimiter({
                client,
                window: { unit: Unit.SECOND, size: 1 },
                limit: 2,
            });

            await flushRedis(limiter);

            const key = `${tag} noscript-reload`;

            // Prime the limiter so the script sha1 is cached in memory and in Redis
            const first = await limiter.get(key);
            validateLimiterResponse(first, { allowed: true, remaining: 1 });

            // Evict every cached script from Redis so the next EVALSHA raises NOSCRIPT
            await sendRawCommand(client, 'SCRIPT', 'FLUSH');

            // The limiter should reload the script and keep counting from the stored state
            const second = await limiter.get(key);
            validateLimiterResponse(second, { allowed: true, remaining: 0 });

            const third = await limiter.get(key);
            expect(third.allowed).toBe(false);
        });
    }

    /**
     * A client object exposing neither `call` (ioredis) nor `sendCommand`
     * (node-redis) cannot be detected and must be rejected at construction.
     */
    it('throws when the client exposes no known command interface', () => {
        const unknownClient: RedisClientWrapper = {};

        const create = () => new RateLimiter({
            client: unknownClient,
            window: { unit: Unit.SECOND, size: 1 },
            limit: 3,
        });

        expect(create).toThrow('Could not detect the Redis client');
    });
});
