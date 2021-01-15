import express from 'express';
import supertest from 'supertest';
import { MiddlewareLimiter } from '../middleware/express-middleware';

import {
    RateLimiter,
    RateLimiterResponse,
    Unit,
    createExpressMiddleware
} from '..';

import {
    createRedisClient,
    createIORedisClient,
    flushRedis,
    validateLimiterResponse,
    runTestConfig,
    TestConfig,
    BatchRequest,
    ValidateFn,
    sleep
} from './shared';

describe('Express middleware', () => {
    jest.setTimeout(240000);

    const client = createRedisClient();

    afterAll(async () => {
        console.log(`Closing client`);

        try {
            await client.quit();
        }
        catch(err) {
            try {
                client.quit();
            }
            catch(err) { }
        }
    });

    /**
     * 1 limiter - 3req/1sec subdivision=second
     */
    it('1 limiter - 3req/1sec subdivision=second', async () => {
        const app = express();
        const request = supertest(app);
        const okText = 'Pollos Hermanos!';

        const limiters: MiddlewareLimiter[] = [
            {
                limiter: new RateLimiter({
                    client,
                    limit: 3,
                    windowUnit: Unit.SECOND,
                    windowSize: 1
                }),
                key: 'pollos',
                overrideKey: true,
            },
        ];

        // Flush Redis
        for (const { limiter } of limiters) {
            await flushRedis(limiter);
        }

        const middleware = createExpressMiddleware({
            limiters: limiters,
            overrideKeyFn: (req, limiter) => {
                return limiter.name;
            }
        });

        app.use(middleware);

        app.get('/', (req, res) => {
            return res.send(okText);
        });

        const res = await Promise.all([
            request.get('/'),
            request.get('/'),
            request.get('/'),
            request.get('/'),
        ]);

        const baseHeaderKey = `X-Rate-Limit`;
        const limiterName = limiters[0].limiter.name;

        for (let i = 0; i < res.length; ++i) {
            const { text, status, headers } = res[i];
            const remainingHeaderKey = `${baseHeaderKey}-Remaining-${limiterName}`.toLowerCase();
            const firstExpireHeaderKey = `${baseHeaderKey}-First-Expire-${limiterName}`.toLowerCase();
            const windowExpireHeaderKey = `${baseHeaderKey}-Reset-${limiterName}`.toLowerCase();

            if (i < res.length - 1) {
                expect(text).toBe(okText);
                expect(status).toBe(200);
            }
            else {
                expect(status).toBe(429);
            }

            expect(headers).toHaveProperty(remainingHeaderKey);
            expect(headers).toHaveProperty(firstExpireHeaderKey);
            expect(headers).toHaveProperty(windowExpireHeaderKey);
        }
    });

    /**
     * 2 limiters
     *  - 2req/1sec subdivision=second
     *  - 3req/1min subdivision=second
     */
    it('2 limiters - 2req/1sec subdivision=second - 3req/1min subdivision=second', async () => {
        const app = express();
        const request = supertest(app);
        const okText = 'Chewbacca';
        const errorMessage = { message: 'Too many requests' };

        const limiters: MiddlewareLimiter[] = [
            {
                limiter: new RateLimiter({
                    client,
                    limit: 2,
                    windowUnit: Unit.SECOND,
                    windowSize: 1
                }),
                key: 'pollos',
                overrideKey: true,
            },
            {
                limiter: new RateLimiter({
                    client,
                    limit: 1, // This will be overridden
                    windowUnit: Unit.MINUTE,
                    windowSize: 1
                }),
                key: 'xpollos',
                overrideKey: false,
                overrideLimit: true,
                overrideLimitFn: (req, limiter) => {
                    return 3; // This should win over middleware-specific overrideLimitFn
                },
                errorMessage: errorMessage
            },
        ];

        // Flush Redis
        for (const { limiter } of limiters) {
            await flushRedis(limiter);
        }

        const middleware = createExpressMiddleware({
            limiters: limiters,
            overrideKeyFn: (req, limiter) => {
                return limiter.name;
            },
            overrideLimitFn: (req, limiter) => {
                return 7; // This should lose respect to limiter-specific overrideLimitFn
            }
        });

        app.use(middleware);

        app.get('/', (req, res) => {
            return res.send(okText);
        });

        const res1 = await Promise.all([
            request.get('/'),
            request.get('/'),
        ]);

        await sleep(1000);

        const res2 = await Promise.all([
            request.get('/'),
            request.get('/'), // Expected to fail with the second limiter
        ]);

        const baseHeaderKey = `X-Rate-Limit`;

        let limiterName = limiters[0].limiter.name;

        for (let i = 0; i < res1.length; ++i) {
            const { text, status, headers } = res1[i];
            const remainingHeaderKey = `${baseHeaderKey}-Remaining-${limiterName}`.toLowerCase();
            const firstExpireHeaderKey = `${baseHeaderKey}-First-Expire-${limiterName}`.toLowerCase();
            const windowExpireHeaderKey = `${baseHeaderKey}-Reset-${limiterName}`.toLowerCase();

            expect(text).toBe(okText);
            expect(status).toBe(200);
            expect(headers).toHaveProperty(remainingHeaderKey);
            expect(headers).toHaveProperty(firstExpireHeaderKey);
            expect(headers).toHaveProperty(windowExpireHeaderKey);
        }

        limiterName = limiters[1].limiter.name;

        for (let i = 0; i < res2.length; ++i) {
            const { text, status, headers } = res2[i];
            const remainingHeaderKey = `${baseHeaderKey}-Remaining-${limiterName}`.toLowerCase();
            const firstExpireHeaderKey = `${baseHeaderKey}-First-Expire-${limiterName}`.toLowerCase();
            const windowExpireHeaderKey = `${baseHeaderKey}-Reset-${limiterName}`.toLowerCase();

            if (i < res2.length - 1) {
                expect(text).toBe(okText);
                expect(status).toBe(200);
            }
            else {
                expect(status).toBe(429);
                expect(JSON.parse(text)).toMatchObject(errorMessage);
            }

            expect(headers).toHaveProperty(remainingHeaderKey);
            expect(headers).toHaveProperty(firstExpireHeaderKey);
            expect(headers).toHaveProperty(windowExpireHeaderKey);
        }
    });

    /**
     * Override headers
     */
    it('Override headers', async () => {
        const app = express();
        const request = supertest(app);

        const limiters: MiddlewareLimiter[] = [
            {
                limiter: new RateLimiter({
                    client,
                    limit: 10,
                    windowUnit: Unit.MINUTE,
                    windowSize: 1
                }),
                key: 'override_headers',
            }
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

        const middleware = createExpressMiddleware({
            limiters: limiters,
            setHeadersFn: (req, res, limiter, limiterResponse) => {
                const { remaining, firstExpireAtMs, windowExpireAtMs } = limiterResponse;
                res.set(remainingH, '' + (remaining * 100));
                res.set(firstExpireH, '' + firstExpireAtMs);
                res.set(resetH, '' + windowExpireAtMs);
            }
        });

        app.use(middleware);

        app.get('/', (req, res) => {
            return res.send();
        });

        const res = await request.get('/');
        const { text, status, headers } = res;

        expect(text).toBe('');
        expect(status).toBe(200);
        expect(headers).toHaveProperty(remainingH.toLowerCase());
        expect(headers).toHaveProperty(firstExpireH.toLowerCase());
        expect(headers).toHaveProperty(resetH.toLowerCase());
    });

    /**
     * Skip request evaluation for a specific limiter
     */
    it('Skip request evaluation for a specific limiter', async () => {
        const app = express();
        const request = supertest(app);
        const key = 'skipLimiter';

        const limiters: MiddlewareLimiter[] = [
            {
                limiter: new RateLimiter({
                    client,
                    windowUnit: Unit.MINUTE,
                    windowSize: 1,
                    limit: 10,
                }),
                key,
            },
            {
                limiter: new RateLimiter({
                    client,
                    windowUnit: Unit.MINUTE,
                    windowSize: 1,
                    limit: 1,
                }),
                key,
                skipFn: (req, limiter) => {
                    return limiter.limit === 1;
                }
            },
        ];

        // Flush Redis
        for (const { limiter } of limiters) {
            await flushRedis(limiter);
        }

        const middleware = createExpressMiddleware({
            limiters,
        });

        app.use(middleware);

        app.get('/', (req, res) => {
            return res.send();
        });

        const res = await Promise.all([
            request.get('/'),
            request.get('/'),
            request.get('/'),
        ]);

        for (let i = 0; i < res.length; ++i) {
            const { text, status } = res[i];
            expect(text).toBe('');
            expect(status).toBe(200);
        }
    });

    /**
     * Skip (whitelist) requests
     */
    it('Skip (whitelist) requests', async () => {
        const app = express();
        const request = supertest(app);
        const prayer = 'SkipMePlease';

        const limiters: MiddlewareLimiter[] = [
            {
                limiter: new RateLimiter({
                    client,
                    limit: 1,
                    windowUnit: Unit.MINUTE,
                    windowSize: 1
                }),
                key: 'whitelist',
            }
        ];

        // Flush Redis
        for (const { limiter } of limiters) {
            await flushRedis(limiter);
        }

        const middleware = createExpressMiddleware({
            limiters: limiters,
            skipFn: (req) => {
                return !!(req.query && req.query.prayer && req.query.prayer === prayer);
            }
        });

        app.use(middleware);

        app.get('/', (req, res) => {
            return res.send();
        });

        const res = await Promise.all([
            request.get('/').query({ prayer }),
            request.get('/').query({ prayer }),
            request.get('/').query({ prayer }),
        ]);

        for (let i = 0; i < res.length; ++i) {
            const { text, status } = res[i];
            expect(text).toBe('');
            expect(status).toBe(200);
        }
    });
});

