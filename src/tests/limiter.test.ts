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
         * 1 request in the first decisecond (first second): expected succeded=1 failed=0.
         * 10 requests in the last decisecond (first second): expected succeded=9 failed=1.
         * 2 requests in the third decisecond (second second): expected succeded=1 failed=1.
         */
        it(`${tag} 10/sec, resolution=decisecond`, async () => {
            const limiter = new RateLimiter({
                client: client,
                windowUnit: Unit.SECOND,
                windowSize: 1,
                windowSubdivisionUnit: Unit.DECISECOND,
                limit: 10
            });

            console.log('' + limiter);

            // Flush all keys
            // @ts-ignore
            await limiter._strategy.sendCommand('FLUSHALL');

            // Reset slowlog
            // @ts-ignore
            await limiter._strategy.sendCommand('SLOWLOG', 'RESET');

            const key = `${tag} 10/sec, resolution=decisecond`;

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
                remaining: 9,
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
                        remaining: 9 - i - 1,
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
    }
});

