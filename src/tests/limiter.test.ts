import {
    RateLimiter,
    Unit
} from '..';

import {
    createRedisClient,
    createIORedisClient,
    flushRedis,
    validateLimiterResponse,
    sleep,
} from './shared';

describe('RateLimiter', () => {
    jest.setTimeout(60000);

    const testClients: any[] = [
        [ 'redis', createRedisClient() ],
        [ 'ioredis', createIORedisClient() ],
    ];

    beforeAll(async () => {
        // Connect redis client if needed
        for (const [ name, client ] of testClients) {
            if (name === 'redis' && typeof client.connect === 'function') {
                try {
                    await client.connect();
                }
                catch(err) { console.log(err) } // Ignore 'already connected' or 'connecting' errors
            }
        }
    });

    afterAll(async () => {
        for (const [ name, client ] of testClients) {
            console.log(`Closing client ${name}`);

            try {
                await client.quit();
            }
            catch(err) {
                try {
                    client.quit();
                }
                catch(err) { console.log(err) }
            }
        }
    });

    for (const [ name, client ] of testClients) {
        const tag = `[${name}]`;

        /**
         * Exact sliding edge: once the limit is filled the next request is denied,
         * and after real time advances past the window a slot frees again.
         */
        it(`${tag} exact sliding window frees a slot after the window elapses`, async () => {
            const limiter = new RateLimiter({
                client,
                window: { unit: Unit.SECOND, size: 1 },
                limit: 3,
            });

            await flushRedis(limiter);

            const key = `${tag} sliding-edge`;

            const first = await limiter.get(key);
            const second = await limiter.get(key);
            const third = await limiter.get(key);
            const fourth = await limiter.get(key);

            validateLimiterResponse(first, { allowed: true, remaining: 2 });
            validateLimiterResponse(second, { allowed: true, remaining: 1 });
            validateLimiterResponse(third, { allowed: true, remaining: 0 });
            expect(fourth.allowed).toBe(false);

            // Advance real time past the window so every member is evicted
            await sleep(limiter.windowExpireMs + 100);

            const afterWindow = await limiter.get(key);
            validateLimiterResponse(afterWindow, { allowed: true, remaining: 2 });
        });

        /**
         * Same-microsecond collision (D6): concurrent calls may share a microsecond
         * timestamp, but the unique member keeps every request distinct so none is lost.
         */
        it(`${tag} concurrent burst counts every request (no same-microsecond loss)`, async () => {
            const limiter = new RateLimiter({
                client,
                window: { unit: Unit.SECOND, size: 1 },
                limit: 2,
            });

            await flushRedis(limiter);

            const key = `${tag} collision`;

            const results = await Promise.all([
                limiter.get(key),
                limiter.get(key),
                limiter.get(key),
            ]);

            const allowedCount = results.filter(r => r.allowed).length;
            const deniedCount = results.filter(r => !r.allowed).length;

            expect(allowedCount).toBe(2);
            expect(deniedCount).toBe(1);
        });

        /**
         * Denied-request semantics (D3/D4/D8): a denied request reports remaining=0,
         * firstExpireAtMs as the retry-success time (oldest score + window) and
         * windowExpireAtMs as newest score + window (not now + window).
         */
        it(`${tag} denied request reports retry and window timestamps from stored scores`, async () => {
            const limiter = new RateLimiter({
                client,
                window: { unit: Unit.SECOND, size: 2 },
                limit: 2,
            });

            await flushRedis(limiter);

            const key = `${tag} denied-semantics`;

            const first = await limiter.get(key);
            const second = await limiter.get(key);

            // Let real time advance so 'now + window' would differ from the stored anchors
            await sleep(300);

            const denied = await limiter.get(key);
            const deniedAtMs = Date.now();

            expect(denied.allowed).toBe(false);
            expect(denied.remaining).toBe(0);

            // firstExpireAtMs is when the oldest member (the first request) leaves the window
            expect(denied.firstExpireAtMs).toBe(first.firstExpireAtMs);

            // windowExpireAtMs reflects the newest member (the second request), not now + window
            expect(denied.windowExpireAtMs).toBe(second.windowExpireAtMs);
            expect(denied.windowExpireAtMs).toBeLessThan(deniedAtMs + limiter.windowExpireMs);

            // The retry-success time is still in the future and precedes the window expiry
            expect(denied.firstExpireAtMs).toBeGreaterThan(deniedAtMs);
            expect(denied.firstExpireAtMs).toBeLessThan(denied.windowExpireAtMs);
        });

        /**
         * remaining clamp: an allowed request into an empty set reports limit-1,
         * the last allowed call reports 0, and a denied call reports 0.
         */
        it(`${tag} remaining is clamped at zero on the last allowed and denied calls`, async () => {
            const limiter = new RateLimiter({
                client,
                window: { unit: Unit.SECOND, size: 1 },
                limit: 2,
            });

            await flushRedis(limiter);

            const key = `${tag} remaining-clamp`;

            const first = await limiter.get(key);
            const second = await limiter.get(key);
            const third = await limiter.get(key);

            validateLimiterResponse(first, { allowed: true, remaining: 1 });
            validateLimiterResponse(second, { allowed: true, remaining: 0 });
            expect(third.allowed).toBe(false);
            expect(third.remaining).toBe(0);
        });

        /**
         * On an allowed request into an empty set firstExpireAtMs equals windowExpireAtMs,
         * and both equal now + window (rounded up to the next millisecond).
         */
        it(`${tag} first allowed request anchors both expiry timestamps to now + window`, async () => {
            const limiter = new RateLimiter({
                client,
                window: { unit: Unit.SECOND, size: 1 },
                limit: 5,
            });

            await flushRedis(limiter);

            const key = `${tag} allowed-anchors`;

            const before = Date.now();
            const first = await limiter.get(key);
            const after = Date.now();

            expect(first.firstExpireAtMs).toBe(first.windowExpireAtMs);
            expect(first.windowExpireAtMs).toBeGreaterThanOrEqual(before + limiter.windowExpireMs);
            expect(first.windowExpireAtMs).toBeLessThanOrEqual(after + limiter.windowExpireMs + 1);
        });

        /**
         * On an allowed request into a non-empty window windowExpireAtMs anchors to
         * now + window: the newest member is the one just added by this very call, so
         * its expiry is now + window regardless of the older members already stored.
         * firstExpireAtMs keeps tracking the oldest member and stays earlier.
         */
        it(`${tag} allowed request into a non-empty window anchors windowExpireAtMs to now + window`, async () => {
            const limiter = new RateLimiter({
                client,
                window: { unit: Unit.SECOND, size: 2 },
                limit: 5,
            });

            await flushRedis(limiter);

            const key = `${tag} allowed-nonempty-anchor`;

            const first = await limiter.get(key);

            // Advance real time so the newest member is well separated from the oldest
            await sleep(300);

            const before = Date.now();
            const second = await limiter.get(key);
            const after = Date.now();

            expect(second.allowed).toBe(true);

            // windowExpireAtMs tracks the just-added newest member (now + window), not the oldest
            expect(second.windowExpireAtMs).toBeGreaterThanOrEqual(before + limiter.windowExpireMs);
            expect(second.windowExpireAtMs).toBeLessThanOrEqual(after + limiter.windowExpireMs + 1);

            // The oldest member still governs firstExpireAtMs, which precedes the window expiry
            expect(second.firstExpireAtMs).toBe(first.firstExpireAtMs);
            expect(second.firstExpireAtMs).toBeLessThan(second.windowExpireAtMs);
        });

        /**
         * Limit overhead widens only the allow decision, never the reported remaining.
         * With limit=10 and overhead fraction 0.1, one extra request is admitted.
         */
        it(`${tag} limit overhead admits extra requests without changing remaining`, async () => {
            const limiter = new RateLimiter({
                client,
                window: { unit: Unit.SECOND, size: 1 },
                limit: 10,
                limitOverhead: 0.1,
            });

            await flushRedis(limiter);

            const key = `${tag} overhead`;
            const batchSize = limiter.limit + limiter.limitOverhead + 1;

            const results = [];
            for (let i = 0; i < batchSize; ++i) {
                results.push(await limiter.get(key));
            }

            for (let i = 0; i < batchSize; ++i) {
                const expectedRemaining = Math.max(0, limiter.limit - i - 1);
                expect(results[i].remaining).toBe(expectedRemaining);

                if (i === batchSize - 1) {
                    expect(results[i].allowed).toBe(false);
                }
                else {
                    expect(results[i].allowed).toBe(true);
                }
            }
        });

        /**
         * Window conversions: window is exposed in microseconds and windowExpireMs
         * in milliseconds, derived from the single duration source.
         */
        it(`${tag} exposes window in microseconds and expiration in milliseconds`, () => {
            const limit = 3;

            let limiter = new RateLimiter({
                client,
                limit,
                window: { unit: Unit.SECOND, size: 1 },
            });

            expect(limiter.window).toBe(1_000_000);
            expect(limiter.windowExpireMs).toBe(1000);

            limiter = new RateLimiter({
                client,
                limit,
                window: { unit: Unit.MINUTE, size: 2 },
            });

            expect(limiter.window).toBe(1000 * 60 * 2 * 1000);
            expect(limiter.windowExpireMs).toBe(1000 * 60 * 2);

            limiter = new RateLimiter({
                client,
                limit,
                window: { unit: Unit.HOUR, size: 3 },
            });

            expect(limiter.window).toBe(1000 * 60 * 60 * 3 * 1000);
            expect(limiter.windowExpireMs).toBe(1000 * 60 * 60 * 3);
        });
    }

    /**
     * D9: the removed subdivisionUnit option throws at construction and points to
     * the migration guide.
     */
    it('throws when the removed window.subdivisionUnit option is passed', () => {
        // The option was removed in v7; carry it through a variable so the call site
        // exercises the runtime guard without tripping excess-property checks
        const windowWithSubdivision = {
            unit: Unit.SECOND,
            size: 1,
            subdivisionUnit: Unit.DECISECOND,
        };

        const create = () => new RateLimiter({
            client: testClients[0][1],
            window: windowWithSubdivision,
            limit: 3,
        });

        expect(create).toThrow('migration guide');
    });
});
