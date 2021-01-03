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
            const windowExpireHeaderKey = `${baseHeaderKey}-Window-Expire-${limiterName}`.toLowerCase();

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
                    limit: 3,
                    windowUnit: Unit.MINUTE,
                    windowSize: 1
                }),
                key: 'xpollos',
                overrideKey: true,
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
            const windowExpireHeaderKey = `${baseHeaderKey}-Window-Expire-${limiterName}`.toLowerCase();

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
            const windowExpireHeaderKey = `${baseHeaderKey}-Window-Expire-${limiterName}`.toLowerCase();

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
});

