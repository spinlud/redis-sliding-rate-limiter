import { RedisClient } from 'redis';
import Redis from 'ioredis';
import { RateLimiter, RateLimiterOptions, RateLimiterResponse, Unit } from '..';
import { sleep } from './utils';

function createRedisClient(): any {
    return new RedisClient({
        host: 'localhost',
        port: 6379
    });
}

function createIORedisClient(): any {
    return new Redis({
        host: 'localhost',
        port: 6379
    });
}

async function flushRedis(limiter: RateLimiter): Promise<void> {
    // Flush all keys
    // @ts-ignore
    await limiter._strategy.sendCommand('FLUSHALL');

    // Reset slowlog
    // @ts-ignore
    await limiter._strategy.sendCommand('SLOWLOG', 'RESET');
}

function checkLimiterResponse(toCheck: RateLimiterResponse, expected: Partial<RateLimiterResponse>) {
    expect(toCheck).toBeDefined();
    expect(toCheck).toMatchObject(expected);
    expect(typeof toCheck.firstExpireAtMs).toBe('number');
    expect(typeof toCheck.windowExpireAtMs).toBe('number');
    expect(toCheck.windowExpireAtMs).toBeGreaterThan(0);
}

describe('RateLimiter', () => {
    jest.setTimeout(240000);

    const clients = [
        {
            name: 'redis',
            client: createRedisClient(),
        },
        {
            name: 'ioredis',
            client: createIORedisClient(),
        },
    ];

    afterAll(async () => {
        for (const { client, name } of clients) {
            console.log(`Closing client ${name}`);

            try {
                await client.quit();
            }
            catch(err) {
                try {
                    client.quit();
                }
                catch(err) { }
            }
        }
    });

    for (const { client, name } of clients) {
        const tag = `[${name}]`;

        /**
         * 10 requests per second with subdivision at decisecond.
         *
         * 1 request in the first decisecond (first second): expected succeded=1 failed=0.
         * 10 requests in the last decisecond (first second): expected succeded=9 failed=1.
         * 2 requests in the third decisecond (second second): expected succeded=1 failed=1.
         */
        it(`${tag} 10req/1sec, subdivision=decisecond`, async () => {
            const limiter = new RateLimiter({
                client: client,
                windowUnit: Unit.SECOND,
                windowSize: 1,
                windowSubdivisionUnit: Unit.DECISECOND,
                limit: 10
            });

            // Flush Redis
            await flushRedis(limiter);

            const key = `${tag} 10req/1sec, subdivision=decisecond`;

            // 1 initial request in first decisecond of first second
            const first = await limiter.get(key);

            // 10 requests in last decisecond of first second
            await sleep(900);

            let promises: Promise<RateLimiterResponse>[] = [];

            for (let i = 0; i < 10; ++i) {
                promises.push(limiter.get(key));
            }

            const middle = await Promise.all(promises);

            // 2 requests in third decisecond of next second (initial request should be expired)
            await sleep(300);

            const last = await Promise.all([
                limiter.get(key),
                limiter.get(key),
            ]);

            // First check
            checkLimiterResponse(first, {
                isAllowed: true,
                remaining: limiter.limit - 1,
                firstExpireAtMs: -1
            });

            // Middle check
            for (let i = 0; i < promises.length; ++i) {
                const e = middle[i];

                // Last request should be rejected
                if (i === promises.length - 1) {
                    checkLimiterResponse(e, {
                        isAllowed: false,
                        remaining: 0,
                    });
                }
                else {
                    checkLimiterResponse(e, {
                        isAllowed: true,
                        remaining: limiter.limit - i - 2,
                    });
                }
            }

            // Last check
            checkLimiterResponse(last[0], {
                isAllowed: true,
                remaining: 0,
            });

            checkLimiterResponse(last[1], {
                isAllowed: false,
                remaining: 0,
            });
        });

        /**
         * 3 requests per 3 second with subdivision at second.
         *
         * 1 request in the first second: expected succeded=1 failed=0.
         * 3 requests in the third second: expected succeded=2 failed=1.
         * 2 requests in the fourth second: expected succeded=1 failed=1.
         */
        it(`${tag} 3req/3sec, subdivision=second`, async () => {
            const limiter = new RateLimiter({
                client: client,
                windowUnit: Unit.SECOND,
                windowSize: 3,
                windowSubdivisionUnit: Unit.DECISECOND,
                limit: 3
            });

            // Flush Redis
            await flushRedis(limiter);

            const key = `${tag} 3req/3sec, subdivision=second`;

            const first = await limiter.get(key);

            await sleep(2000);

            const promises: Promise<RateLimiterResponse>[] = [
                limiter.get(key),
                limiter.get(key),
                limiter.get(key),
            ];

            const middle = await Promise.all(promises);

            await sleep(1100);

            const last = await Promise.all([
               limiter.get(key),
               limiter.get(key),
            ]);

            // First check
            checkLimiterResponse(first, {
                isAllowed: true,
                remaining: limiter.limit - 1,
                firstExpireAtMs: -1
            });

            // Middle check
            for (let i = 0; i < promises.length; ++i) {
                const e = middle[i];

                // Last request should be rejected
                if (i === promises.length - 1) {
                    checkLimiterResponse(e, {
                        isAllowed: false,
                        remaining: 0,
                    });
                }
                else {
                    checkLimiterResponse(e, {
                        isAllowed: true,
                        remaining: limiter.limit - i - 2,
                    });
                }
            }

            // Last check
            checkLimiterResponse(last[0], {
                isAllowed: true,
                remaining: 0,
            });

            checkLimiterResponse(last[1], {
                isAllowed: false,
                remaining: 0,
            });
        });

        /**
         * 10 requests per 1 decisecond with subdivision at decisecond.
         *
         * 10 requests every decisecond: expected succeded=10 failed=0.
         */
        it.only(`${tag} 10req/1decisec, subdivision=decisecond`, async () => {
            const limiter = new RateLimiter({
                client: client,
                windowUnit: Unit.DECISECOND,
                windowSize: 1,
                windowSubdivisionUnit: Unit.DECISECOND,
                limit: 10
            });

            // Flush Redis
            await flushRedis(limiter);

            const key = `${tag} 10req/1decisec, subdivision=decisecond`;
            const subdivisionsToTest = 50;
            const requestsPerSubdivision = 10;

            // let res: RateLimiterResponse[] = [];

            const _buildSubdivisionRequests = async (key: string, delay: number): Promise<RateLimiterResponse[]> => {
                await sleep(delay);

                const promises: Promise<RateLimiterResponse>[] = [];

                for (let i = 0; i < requestsPerSubdivision; ++i) {
                    promises.push(limiter.get(key));
                }

                return Promise.all(promises);
            }

            const promises: Promise<RateLimiterResponse[]>[] = [];
            const delayTimeIncrMs = 100;
            let delay = 0;

            for (let i = 0; i < subdivisionsToTest; ++i) {
                promises.push(_buildSubdivisionRequests(key, delay));
                delay += delayTimeIncrMs;
            }

            const all = await Promise.all(promises);

            all.forEach(batch => {
                for (let i = 0; i < batch.length; ++i) {
                    const e = batch[i];

                    const expected: Partial<RateLimiterResponse> = {
                        isAllowed: true,
                        remaining: limiter.limit - i - 1,
                    };

                    // First request
                    if (i === 0) {
                        expected.firstExpireAtMs = -1;
                    }

                    checkLimiterResponse(e, expected);
                }
            });
        });
    }
});
