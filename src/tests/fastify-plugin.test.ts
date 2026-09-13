import fastify from 'fastify';
import {
    RateLimiter,
    Unit,
    createExpressMiddleware,
    createFastifyHook,
    createFastifyPlugin,
    FastifyMiddlewareLimiter,
} from '..';

import {
    createRedisClient,
    createIORedisClient,
    flushRedis,
    sleep,
} from './shared';

// True if the query object carries the given prayer value. Narrows the unknown
// request query without assertions before reading the property.
const matchesPrayerQuery = (query: unknown, expected: string): boolean => {
    return typeof query === 'object' && query !== null && 'prayer' in query && query.prayer === expected;
};

describe('Fastify plugin', () => {
    jest.setTimeout(240000);

    const client = createRedisClient();
    const ioredisClient = createIORedisClient();

    beforeAll(async () => {
        // Connect redis client if needed
        try {
            await client.connect();
        }
        catch(err) {} // Ignore 'already connected' or 'connecting' errors
    });

    afterAll(async () => {
        console.log(`Closing client`);

        for (const c of [client, ioredisClient]) {
            try {
                await c.quit();
            }
            catch(err) {
                try {
                    c.quit();
                }
                catch(err) { }
            }
        }
    });

    /**
     * 1 limiter - 3req/1sec subdivision=second
     */
    it('1 limiter - 3req/1sec subdivision=second', async () => {
        const app = fastify();
        const okText = 'Pollos Hermanos!';

        const limiters: FastifyMiddlewareLimiter[] = [
            {
                limiter: new RateLimiter({
                    client,
                    limit: 3,
                    window: {
                        unit: Unit.SECOND,
                        size: 1,
                    },
                }),
                key: 'pollos-fastify',
                overrideKey: true,
            },
        ];

        // Flush Redis
        for (const { limiter } of limiters) {
            await flushRedis(limiter);
        }

        app.register(createFastifyPlugin({
            limiters,
            overrideKeyFn: (req, limiter) => {
                return limiter.name;
            },
        }));

        app.get('/', async () => okText);

        const res = await Promise.all([
            app.inject({ method: 'GET', url: '/' }),
            app.inject({ method: 'GET', url: '/' }),
            app.inject({ method: 'GET', url: '/' }),
            app.inject({ method: 'GET', url: '/' }),
        ]);

        const baseHeaderKey = 'X-Rate-Limit';
        const limiterName = limiters[0].limiter.name;
        const remainingHeaderKey = `${baseHeaderKey}-Remaining-${limiterName}`.toLowerCase();
        const firstExpireHeaderKey = `${baseHeaderKey}-First-Expire-${limiterName}`.toLowerCase();
        const windowExpireHeaderKey = `${baseHeaderKey}-Reset-${limiterName}`.toLowerCase();

        // The four requests race, so assert on the counts rather than positions
        const allowed = res.filter(r => r.statusCode === 200);
        const throttled = res.filter(r => r.statusCode === 429);

        expect(allowed).toHaveLength(3);
        expect(throttled).toHaveLength(1);

        for (const r of allowed) {
            expect(r.body).toBe(okText);
        }

        for (const r of res) {
            expect(r.headers).toHaveProperty(remainingHeaderKey);
            expect(r.headers).toHaveProperty(firstExpireHeaderKey);
            expect(r.headers).toHaveProperty(windowExpireHeaderKey);
        }

        await app.close();
    });

    /**
     * 2 limiters
     *  - 2req/1sec subdivision=second
     *  - 3req/1min subdivision=second (limit overridden by limiter-specific fn)
     */
    it('2 limiters - 2req/1sec subdivision=second - 3req/1min subdivision=second', async () => {
        const app = fastify();
        const okText = 'Chewbacca';
        const errorMessage = { message: 'Too many requests' };

        const limiters: FastifyMiddlewareLimiter[] = [
            {
                limiter: new RateLimiter({
                    client,
                    limit: 2,
                    window: {
                        unit: Unit.SECOND,
                        size: 1,
                    },
                }),
                key: 'pollos',
                overrideKey: true,
            },
            {
                limiter: new RateLimiter({
                    client,
                    limit: 1, // This will be overridden
                    window: {
                        unit: Unit.MINUTE,
                        size: 1,
                    },
                }),
                key: 'xpollos',
                overrideKey: false,
                overrideLimit: true,
                overrideLimitFn: (req, limiter) => {
                    return 3; // This should win over plugin-specific overrideLimitFn
                },
                errorMessage: errorMessage,
            },
        ];

        // Flush Redis
        for (const { limiter } of limiters) {
            await flushRedis(limiter);
        }

        app.register(createFastifyPlugin({
            limiters,
            overrideKeyFn: (req, limiter) => {
                return limiter.name;
            },
            overrideLimitFn: (req, limiter) => {
                return 7; // This should lose respect to limiter-specific overrideLimitFn
            },
        }));

        app.get('/', async () => okText);

        const res1 = await Promise.all([
            app.inject({ method: 'GET', url: '/' }),
            app.inject({ method: 'GET', url: '/' }),
        ]);

        await sleep(1000);

        const res2 = await Promise.all([
            app.inject({ method: 'GET', url: '/' }),
            app.inject({ method: 'GET', url: '/' }), // Expected to fail with the second limiter
        ]);

        const baseHeaderKey = 'X-Rate-Limit';

        let limiterName = limiters[0].limiter.name;

        for (const r of res1) {
            const remainingHeaderKey = `${baseHeaderKey}-Remaining-${limiterName}`.toLowerCase();
            const firstExpireHeaderKey = `${baseHeaderKey}-First-Expire-${limiterName}`.toLowerCase();
            const windowExpireHeaderKey = `${baseHeaderKey}-Reset-${limiterName}`.toLowerCase();

            expect(r.body).toBe(okText);
            expect(r.statusCode).toBe(200);
            expect(r.headers).toHaveProperty(remainingHeaderKey);
            expect(r.headers).toHaveProperty(firstExpireHeaderKey);
            expect(r.headers).toHaveProperty(windowExpireHeaderKey);
        }

        limiterName = limiters[1].limiter.name;

        // After the reset the first limiter allows both, so throttling comes only
        // from the second limiter, which has already consumed 2 of its 3 slots.
        const allowed = res2.filter(r => r.statusCode === 200);
        const throttled = res2.filter(r => r.statusCode === 429);

        expect(allowed).toHaveLength(1);
        expect(throttled).toHaveLength(1);

        for (const r of allowed) {
            expect(r.body).toBe(okText);
        }

        for (const r of throttled) {
            expect(JSON.parse(r.body)).toMatchObject(errorMessage);
        }

        for (const r of res2) {
            const remainingHeaderKey = `${baseHeaderKey}-Remaining-${limiterName}`.toLowerCase();
            const firstExpireHeaderKey = `${baseHeaderKey}-First-Expire-${limiterName}`.toLowerCase();
            const windowExpireHeaderKey = `${baseHeaderKey}-Reset-${limiterName}`.toLowerCase();

            expect(r.headers).toHaveProperty(remainingHeaderKey);
            expect(r.headers).toHaveProperty(firstExpireHeaderKey);
            expect(r.headers).toHaveProperty(windowExpireHeaderKey);
        }

        await app.close();
    });

    /**
     * Override headers via setHeadersFn and reply.header
     */
    it('Override headers', async () => {
        const app = fastify();

        const limiters: FastifyMiddlewareLimiter[] = [
            {
                limiter: new RateLimiter({
                    client,
                    limit: 10,
                    window: {
                        unit: Unit.MINUTE,
                        size: 1,
                    },
                }),
                key: 'override_headers_fastify',
            },
        ];

        // Flush Redis
        for (const { limiter } of limiters) {
            await flushRedis(limiter);
        }

        // Headers for test
        const baseKey = 'X-Rate-Limit';
        const remainingH = `${baseKey}-Remaining`;
        const firstExpireH = `${baseKey}-First-Expire`;
        const resetH = `${baseKey}-Reset`;

        app.register(createFastifyPlugin({
            limiters,
            setHeadersFn: (req, reply, limiter, limiterResponse) => {
                const { remaining, firstExpireAtMs, windowExpireAtMs } = limiterResponse;
                reply.header(remainingH, '' + (remaining * 100));
                reply.header(firstExpireH, '' + firstExpireAtMs);
                reply.header(resetH, '' + windowExpireAtMs);
            },
        }));

        app.get('/', async () => '');

        const res = await app.inject({ method: 'GET', url: '/' });

        expect(res.body).toBe('');
        expect(res.statusCode).toBe(200);
        expect(res.headers).toHaveProperty(remainingH.toLowerCase());
        expect(res.headers).toHaveProperty(firstExpireH.toLowerCase());
        expect(res.headers).toHaveProperty(resetH.toLowerCase());

        await app.close();
    });

    /**
     * Skip request evaluation for a specific limiter
     */
    it('Skip request evaluation for a specific limiter', async () => {
        const app = fastify();
        const key = 'skipLimiterFastify';

        const limiters: FastifyMiddlewareLimiter[] = [
            {
                limiter: new RateLimiter({
                    client,
                    limit: 10,
                    window: {
                        unit: Unit.MINUTE,
                        size: 1,
                    },
                }),
                key,
            },
            {
                limiter: new RateLimiter({
                    client,
                    limit: 1,
                    window: {
                        unit: Unit.MINUTE,
                        size: 1,
                    },
                }),
                key,
                skipFn: (req, limiter) => {
                    return limiter.limit === 1;
                },
            },
        ];

        // Flush Redis
        for (const { limiter } of limiters) {
            await flushRedis(limiter);
        }

        app.register(createFastifyPlugin({ limiters }));

        app.get('/', async () => '');

        const res = await Promise.all([
            app.inject({ method: 'GET', url: '/' }),
            app.inject({ method: 'GET', url: '/' }),
            app.inject({ method: 'GET', url: '/' }),
        ]);

        for (const r of res) {
            expect(r.body).toBe('');
            expect(r.statusCode).toBe(200);
        }

        await app.close();
    });

    /**
     * Skip (whitelist) requests via global skipFn reading request.query
     */
    it('Skip (whitelist) requests', async () => {
        const app = fastify();
        const prayer = 'SkipMePlease';

        const limiters: FastifyMiddlewareLimiter[] = [
            {
                limiter: new RateLimiter({
                    client,
                    limit: 1,
                    window: {
                        unit: Unit.MINUTE,
                        size: 1,
                    },
                }),
                key: 'whitelist-fastify',
            },
        ];

        // Flush Redis
        for (const { limiter } of limiters) {
            await flushRedis(limiter);
        }

        app.register(createFastifyPlugin({
            limiters,
            skipFn: (req) => {
                return matchesPrayerQuery(req.query, prayer);
            },
        }));

        app.get('/', async () => '');

        const res = await Promise.all([
            app.inject({ method: 'GET', url: '/', query: { prayer } }),
            app.inject({ method: 'GET', url: '/', query: { prayer } }),
            app.inject({ method: 'GET', url: '/', query: { prayer } }),
        ]);

        for (const r of res) {
            expect(r.body).toBe('');
            expect(r.statusCode).toBe(200);
        }

        await app.close();
    });

    /**
     * On throttle request: custom 428 response and the route handler must not run
     */
    it('On throttle request', async () => {
        const app = fastify();
        const message = 'Sorry mate, your request has been throttled';
        const status = 428;
        let handlerInvocations = 0;

        const limiter: FastifyMiddlewareLimiter = {
            limiter: new RateLimiter({
                client,
                limit: 1,
                window: {
                    unit: Unit.MINUTE,
                    size: 1,
                },
            }),
            key: 'onThrottleRequest-fastify',
        };

        // Flush Redis
        await flushRedis(limiter.limiter);

        app.register(createFastifyPlugin({
            limiters: [limiter],
            onThrottleRequest: async (req, reply, key) => {
                reply.code(status).send(message + key);
            },
        }));

        app.get('/', async () => {
            handlerInvocations += 1;
            return '';
        });

        // Sequential requests so the single allowed slot is deterministic.
        const first = await app.inject({ method: 'GET', url: '/' });
        const second = await app.inject({ method: 'GET', url: '/' });

        expect(first.body).toBe('');
        expect(first.statusCode).toBe(200);

        expect(second.body).toBe(message + limiter.key);
        expect(second.statusCode).toBe(status);

        // The throttled request must never reach the route handler.
        expect(handlerInvocations).toBe(1);

        await app.close();
    });

    /**
     * Custom errorStatusCode on the default throttle response
     */
    it('Custom errorStatusCode', async () => {
        const app = fastify();
        const errorStatusCode = 420;

        const limiter: FastifyMiddlewareLimiter = {
            limiter: new RateLimiter({
                client,
                limit: 1,
                window: {
                    unit: Unit.MINUTE,
                    size: 1,
                },
            }),
            key: 'errorStatusCode-fastify',
        };

        // Flush Redis
        await flushRedis(limiter.limiter);

        app.register(createFastifyPlugin({
            limiters: [limiter],
            errorStatusCode,
        }));

        app.get('/', async () => '');

        const first = await app.inject({ method: 'GET', url: '/' });
        const second = await app.inject({ method: 'GET', url: '/' });

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(errorStatusCode);
        expect(second.body).toBe('Too many requests');

        await app.close();
    });

    /**
     * Plugin parity: the same basic overflow behaviour must hold when the
     * limiter is backed by ioredis instead of node-redis.
     */
    it('ioredis - 3req/1sec returns 429 on overflow', async () => {
        const app = fastify();
        const okText = 'Los Pollos ioredis';

        const limiters: FastifyMiddlewareLimiter[] = [
            {
                limiter: new RateLimiter({
                    client: ioredisClient,
                    limit: 3,
                    window: {
                        unit: Unit.SECOND,
                        size: 1,
                    },
                }),
                key: 'pollos-ioredis-fastify',
            },
        ];

        // Flush Redis
        for (const { limiter } of limiters) {
            await flushRedis(limiter);
        }

        app.register(createFastifyPlugin({ limiters }));

        app.get('/', async () => okText);

        const res = await Promise.all([
            app.inject({ method: 'GET', url: '/' }),
            app.inject({ method: 'GET', url: '/' }),
            app.inject({ method: 'GET', url: '/' }),
            app.inject({ method: 'GET', url: '/' }),
        ]);

        const baseHeaderKey = 'X-Rate-Limit';
        const limiterName = limiters[0].limiter.name;
        const remainingHeaderKey = `${baseHeaderKey}-Remaining-${limiterName}`.toLowerCase();

        // The four requests race, so assert on the counts rather than positions
        const allowed = res.filter(r => r.statusCode === 200);
        const throttled = res.filter(r => r.statusCode === 429);

        expect(allowed).toHaveLength(3);
        expect(throttled).toHaveLength(1);

        for (const r of allowed) {
            expect(r.body).toBe(okText);
        }

        for (const r of res) {
            expect(r.headers).toHaveProperty(remainingHeaderKey);
        }

        await app.close();
    });

    /**
     * Root registration applies to every route declared afterwards. A shared key
     * means usage on one route throttles the sibling route.
     */
    it('Root plugin applies to routes declared after registration (shared key)', async () => {
        const app = fastify();
        const key = 'shared-routes-fastify';

        const limiter = new RateLimiter({
            client,
            limit: 2,
            window: {
                unit: Unit.MINUTE,
                size: 1,
            },
        });

        // Flush Redis
        await flushRedis(limiter);

        app.register(createFastifyPlugin({ limiters: [{ limiter, key }] }));

        app.get('/a', async () => 'a');
        app.get('/b', async () => 'b');

        // /a consumes both slots of the shared key, so /b is throttled.
        const a1 = await app.inject({ method: 'GET', url: '/a' });
        const a2 = await app.inject({ method: 'GET', url: '/a' });
        const b1 = await app.inject({ method: 'GET', url: '/b' });

        const baseHeaderKey = 'X-Rate-Limit';
        const remainingHeaderKey = `${baseHeaderKey}-Remaining-${limiter.name}`.toLowerCase();

        expect(a1.statusCode).toBe(200);
        expect(a1.body).toBe('a');
        expect(a2.statusCode).toBe(200);
        expect(b1.statusCode).toBe(429);

        expect(a1.headers).toHaveProperty(remainingHeaderKey);
        expect(b1.headers).toHaveProperty(remainingHeaderKey);

        await app.close();
    });

    /**
     * A route opting out with config: { rateLimit: false } is never throttled and
     * carries no rate limit headers, while a sibling route stays limited.
     */
    it('Route opt-out via config rateLimit false', async () => {
        const app = fastify();
        const key = 'opt-out-fastify';

        const limiter = new RateLimiter({
            client,
            limit: 1,
            window: {
                unit: Unit.MINUTE,
                size: 1,
            },
        });

        // Flush Redis
        await flushRedis(limiter);

        app.register(createFastifyPlugin({ limiters: [{ limiter, key }] }));

        app.get('/limited', async () => 'limited');
        app.get('/open', { config: { rateLimit: false } }, async () => 'open');

        const baseHeaderKey = 'X-Rate-Limit';
        const remainingHeaderKey = `${baseHeaderKey}-Remaining-${limiter.name}`.toLowerCase();
        const firstExpireHeaderKey = `${baseHeaderKey}-First-Expire-${limiter.name}`.toLowerCase();
        const windowExpireHeaderKey = `${baseHeaderKey}-Reset-${limiter.name}`.toLowerCase();

        // The opted-out route never throttles and never consumes the key.
        const open1 = await app.inject({ method: 'GET', url: '/open' });
        const open2 = await app.inject({ method: 'GET', url: '/open' });
        const open3 = await app.inject({ method: 'GET', url: '/open' });

        for (const r of [open1, open2, open3]) {
            expect(r.statusCode).toBe(200);
            expect(r.body).toBe('open');
            expect(r.headers).not.toHaveProperty(remainingHeaderKey);
            expect(r.headers).not.toHaveProperty(firstExpireHeaderKey);
            expect(r.headers).not.toHaveProperty(windowExpireHeaderKey);
        }

        // The sibling route stays limited.
        const limited1 = await app.inject({ method: 'GET', url: '/limited' });
        const limited2 = await app.inject({ method: 'GET', url: '/limited' });

        expect(limited1.statusCode).toBe(200);
        expect(limited1.headers).toHaveProperty(remainingHeaderKey);
        expect(limited2.statusCode).toBe(429);

        await app.close();
    });

    /**
     * The preHandler hook runs after an app-level onRequest hook and before the
     * route handler. Markers pushed in order prove the placement.
     */
    it('hook preHandler ordering against an app-level onRequest', async () => {
        const app = fastify();
        const markers: string[] = [];

        const limiter = new RateLimiter({
            client,
            limit: 10,
            window: {
                unit: Unit.MINUTE,
                size: 1,
            },
        });

        // Flush Redis
        await flushRedis(limiter);

        app.addHook('onRequest', async () => {
            markers.push('onRequest');
        });

        app.register(createFastifyPlugin({
            hook: 'preHandler',
            limiters: [{ limiter, key: 'prehandler-ordering' }],
            // The global skipFn runs inside the rate limit hook, marking its turn.
            skipFn: () => {
                markers.push('rateLimit');
                return false;
            },
        }));

        app.get('/', async () => {
            markers.push('handler');
            return 'ok';
        });

        const res = await app.inject({ method: 'GET', url: '/' });

        expect(res.statusCode).toBe(200);
        expect(markers).toEqual(['onRequest', 'rateLimit', 'handler']);

        await app.close();
    });

    /**
     * Encapsulation: a plugin registered inside a child plugin limits only the
     * child's routes; a root route is unaffected and carries no headers.
     */
    it('Encapsulation limits only the child scope', async () => {
        const app = fastify();
        const key = 'child-scope-fastify';

        const limiter = new RateLimiter({
            client,
            limit: 1,
            window: {
                unit: Unit.MINUTE,
                size: 1,
            },
        });

        // Flush Redis
        await flushRedis(limiter);

        app.register(async (child) => {
            child.register(createFastifyPlugin({ limiters: [{ limiter, key }] }));
            child.get('/child', async () => 'child');
        });

        app.get('/root', async () => 'root');

        const baseHeaderKey = 'X-Rate-Limit';
        const remainingHeaderKey = `${baseHeaderKey}-Remaining-${limiter.name}`.toLowerCase();

        // The root route is outside the child scope: never throttled, no headers.
        const root1 = await app.inject({ method: 'GET', url: '/root' });
        const root2 = await app.inject({ method: 'GET', url: '/root' });

        expect(root1.statusCode).toBe(200);
        expect(root1.body).toBe('root');
        expect(root2.statusCode).toBe(200);
        expect(root1.headers).not.toHaveProperty(remainingHeaderKey);
        expect(root2.headers).not.toHaveProperty(remainingHeaderKey);

        // The child route is limited.
        const child1 = await app.inject({ method: 'GET', url: '/child' });
        const child2 = await app.inject({ method: 'GET', url: '/child' });

        expect(child1.statusCode).toBe(200);
        expect(child1.headers).toHaveProperty(remainingHeaderKey);
        expect(child2.statusCode).toBe(429);

        await app.close();
    });

    /**
     * The hook factory can be attached directly at route level, both as onRequest
     * and as preHandler. A shared limiter proves both attachment points enforce.
     */
    it('createFastifyHook used as route-level onRequest and preHandler', async () => {
        const app = fastify();

        const limiter = new RateLimiter({
            client,
            limit: 2,
            window: {
                unit: Unit.MINUTE,
                size: 1,
            },
        });

        // Flush Redis
        await flushRedis(limiter);

        const hook = createFastifyHook({ limiters: [{ limiter, key: 'route-level-hook' }] });

        app.get('/onrequest', { onRequest: hook }, async () => 'onrequest');
        app.get('/prehandler', { preHandler: hook }, async () => 'prehandler');

        const baseHeaderKey = 'X-Rate-Limit';
        const remainingHeaderKey = `${baseHeaderKey}-Remaining-${limiter.name}`.toLowerCase();

        // The shared key allows 2 requests across both routes, then throttles both.
        const r1 = await app.inject({ method: 'GET', url: '/onrequest' });
        const r2 = await app.inject({ method: 'GET', url: '/prehandler' });
        const r3 = await app.inject({ method: 'GET', url: '/onrequest' });
        const r4 = await app.inject({ method: 'GET', url: '/prehandler' });

        expect(r1.statusCode).toBe(200);
        expect(r1.body).toBe('onrequest');
        expect(r1.headers).toHaveProperty(remainingHeaderKey);

        expect(r2.statusCode).toBe(200);
        expect(r2.body).toBe('prehandler');
        expect(r2.headers).toHaveProperty(remainingHeaderKey);

        expect(r3.statusCode).toBe(429);
        expect(r4.statusCode).toBe(429);

        await app.close();
    });

    /**
     * createFastifyHook validation must throw the same messages as
     * createExpressMiddleware, since both share the core validation.
     */
    it('createFastifyHook validation matches createExpressMiddleware', () => {
        const buildLimiter = () => new RateLimiter({
            client,
            limit: 1,
            window: {
                unit: Unit.MINUTE,
                size: 1,
            },
        });

        const noKeyMessage = 'Limiter requires a key or overrideKey enabled';
        expect(() => createFastifyHook({ limiters: [{ limiter: buildLimiter() }] })).toThrow(noKeyMessage);
        expect(() => createExpressMiddleware({ limiters: [{ limiter: buildLimiter() }] })).toThrow(noKeyMessage);

        const overrideKeyMessage = 'Limiter with overrideKey enabled requires at least one of limiter-specific or middleware-specific overrideKeyFn function to be defined';
        expect(() => createFastifyHook({ limiters: [{ limiter: buildLimiter(), overrideKey: true }] })).toThrow(overrideKeyMessage);
        expect(() => createExpressMiddleware({ limiters: [{ limiter: buildLimiter(), overrideKey: true }] })).toThrow(overrideKeyMessage);

        const overrideLimitMessage = 'Limiter with overrideLimit enabled requires at least one of limiter-specific or middleware-specific overrideLimitFn function to be defined';
        expect(() => createFastifyHook({ limiters: [{ limiter: buildLimiter(), key: 'validation', overrideLimit: true }] })).toThrow(overrideLimitMessage);
        expect(() => createExpressMiddleware({ limiters: [{ limiter: buildLimiter(), key: 'validation', overrideLimit: true }] })).toThrow(overrideLimitMessage);
    });
});
