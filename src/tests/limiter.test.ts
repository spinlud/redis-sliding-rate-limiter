import { RedisClient } from 'redis';
import Redis from 'ioredis';
import { RateLimiter, RateLimiterOptions, RateLimiterResponse, Unit } from '..';
import { sleep } from './utils';

type ValidateFn = (batchResponse: RateLimiterResponse[]) => void;

interface BatchRequest {
    size: number; // How many requests in the batch
    delay: number; // Number of milliseconds to wait before sending the requests
    validate: ValidateFn; // Validation routine
}

interface TestConfig {
    limiter: RateLimiter;
    key: string; // Redis key
    batches: BatchRequest[];
}

function createRedisClient(): any {
    return new RedisClient({
        host: process.env.REDIS_HOST ?? 'localhost',
        port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379
    });
}

function createIORedisClient(): any {
    return new Redis({
        host: process.env.REDIS_HOST ?? 'localhost',
        port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379
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

function validateLimiterResponse(received: RateLimiterResponse, expected: Partial<RateLimiterResponse>) {
    expect(received).toBeDefined();
    expect(received).toMatchObject(expected);
    expect(typeof received.firstExpireAtMs).toBe('number');
    expect(received.firstExpireAtMs).toBeGreaterThan(0);
    expect(typeof received.windowExpireAtMs).toBe('number');
    expect(received.windowExpireAtMs).toBeGreaterThan(0);
}

async function runTestConfig(config: TestConfig): Promise<RateLimiterResponse[][]> {
    const { limiter, key, batches } = config;

    const _buildBatchPromise = async (batch: BatchRequest): Promise<RateLimiterResponse[]> => {
        const { delay, size } = batch;
        await sleep(delay);

        const promises: Promise<RateLimiterResponse>[] = [];

        for (let i = 0; i < size; ++i) {
            promises.push(limiter.get(key));
        }

        return Promise.all(promises);
    }

    const batchPromises = batches.map(batch => _buildBatchPromise(batch));

    const batchResults = await Promise.all(batchPromises);

    for (let i = 0; i < batches.length; ++i) {
        batches[i].validate(batchResults[i]);
    }

    return batchResults;
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

            const firstBatch: BatchRequest = {
                delay: 0,
                size: 1,
                validate: (res) => {
                    const received = res[0];

                    const expected: Partial<RateLimiterResponse> = {
                        allowed: true,
                        remaining: limiter.limit - 1
                    };

                    validateLimiterResponse(received, expected);
                }
            };

            const secondBatch: BatchRequest = {
                delay: 900,
                size: 10,
                validate: (res) => {
                    for (let i = 0; i < 10; ++i) {
                        const received = res[i];

                        const expected: Partial<RateLimiterResponse> = {
                            allowed: true,
                            remaining: Math.max(0, limiter.limit - i - 2)
                        };

                        // Last request expected to fail
                        if (i === 9) {
                            expected.allowed = false;
                        }

                        validateLimiterResponse(received, expected);
                    }
                }
            };

            const thirdBatch: BatchRequest = {
                delay: 1100,
                size: 2,
                validate: (res) => {
                    for (let i = 0; i < 2; ++i) {
                        const received = res[i];

                        const expected: Partial<RateLimiterResponse> = {
                            allowed: true,
                            remaining: 0
                        };

                        // Last request expected to fail
                        if (i === 1) {
                            expected.allowed = false;
                        }

                        validateLimiterResponse(received, expected);
                    }
                }
            };

            const config: TestConfig = {
                limiter,
                key,
                batches: [firstBatch, secondBatch, thirdBatch]
            };

            await runTestConfig(config);
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

            const firstBatch: BatchRequest = {
                delay: 0,
                size: 1,
                validate: (res) => {
                    const received = res[0];

                    const expected: Partial<RateLimiterResponse> = {
                        allowed: true,
                        remaining: limiter.limit - 1
                    };

                    validateLimiterResponse(received, expected);
                }
            };

            const secondBatch: BatchRequest = {
                delay: 2000,
                size: 3,
                validate: (res) => {
                    for (let i = 0; i < 3; ++i) {
                        const received = res[i];

                        const expected: Partial<RateLimiterResponse> = {
                            allowed: true,
                            remaining: Math.max(0, limiter.limit - i - 2)
                        };

                        // Last request expected to fail
                        if (i === 2) {
                            expected.allowed = false;
                        }

                        validateLimiterResponse(received, expected);
                    }
                }
            };

            const thirdBatch: BatchRequest = {
                delay: 3100,
                size: 2,
                validate: (res) => {
                    for (let i = 0; i < 2; ++i) {
                        const received = res[i];

                        const expected: Partial<RateLimiterResponse> = {
                            allowed: true,
                            remaining: 0
                        };

                        // Last request expected to fail
                        if (i === 1) {
                            expected.allowed = false;
                        }

                        validateLimiterResponse(received, expected);
                    }
                }
            };

            const config: TestConfig = {
                limiter,
                key,
                batches: [firstBatch, secondBatch, thirdBatch]
            };

            await runTestConfig(config);
        });

        /**
         * 10 requests per 1 decisecond with subdivision at decisecond.
         *
         * 10 requests every decisecond: expected succeded=10 failed=0.
         */
        it(`${tag} 10req/1decisec, subdivision=decisecond`, async () => {
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
            const numBatches = 50;
            const batchSize = 10;
            const batches: BatchRequest[] = [];
            const delayTimeIncrMs = 100; // Increase delay of 1 decisecond for each batch
            let delay = 0;

            const _validateBatch: ValidateFn = (res) => {
                for (let i = 0; i < batchSize; ++i) {
                    const received = res[i];

                    const expected: Partial<RateLimiterResponse> = {
                        allowed: true,
                        remaining: Math.max(0, limiter.limit - i - 1),
                    };

                    validateLimiterResponse(received, expected);
                }
            }

            for (let i = 0; i < numBatches; ++i) {
                batches.push({
                    size: batchSize,
                    delay: delay,
                    validate: _validateBatch
                });

                delay += delayTimeIncrMs;
            }

            const config: TestConfig = {
                limiter,
                key,
                batches
            };

            await runTestConfig(config);
        });

        /**
         * 1000 requests per 1 second with subdivision at second.
         *
         * 1003 requests every second: expected succeded=1000 failed=3.
         */
        it(`${tag} 1000req/1sec, subdivision=second`, async () => {
            const limiter = new RateLimiter({
                client: client,
                windowUnit: Unit.SECOND,
                windowSize: 1,
                windowSubdivisionUnit: Unit.SECOND,
                limit: 1000
            });

            // Flush Redis
            await flushRedis(limiter);

            const key = `${tag} 1000req/1sec, subdivision=second`;
            const numBatches = 3;
            const batchSize = 1003;
            const batches: BatchRequest[] = [];
            const delayTimeIncrMs = 1000; // Increase delay of 1 second for each batch
            let delay = 0;

            const _validateBatch: ValidateFn = (res) => {
                for (let i = 0; i < batchSize; ++i) {
                    const received = res[i];

                    const expected: Partial<RateLimiterResponse> = {
                        allowed: true,
                        remaining: Math.max(0, limiter.limit - i - 1),
                    };

                    // Expect last 3 requests to fail
                    if (i >= limiter.limit) {
                        expected.allowed = false;
                    }

                    validateLimiterResponse(received, expected);
                }
            }

            for (let i = 0; i < numBatches; ++i) {
                batches.push({
                    size: batchSize,
                    delay: delay,
                    validate: _validateBatch
                });

                delay += delayTimeIncrMs;
            }

            const config: TestConfig = {
                limiter,
                key,
                batches
            };

            await runTestConfig(config);
        });

        /**
         * Test first member and window expiration timestamps - 3req/2sec, subdivision=second.
         *
         * 1 request in the first second: expected succeded=1 failed=0.
         * 3 requests in the second second: expected succeded=2 failed=1.
         * 2 requests at the first member timestamp: expected succeded=1 failed=1.
         */
        it(`${tag} First member and window expiration timestamps - 3req/2sec, subdivision=second`, async () => {
            const limiter = new RateLimiter({
                client: client,
                windowUnit: Unit.SECOND,
                windowSize: 2,
                windowSubdivisionUnit: Unit.SECOND,
                limit: 3
            });

            // Flush Redis
            await flushRedis(limiter);

            const key = `${tag} First member and window expiration timestamps - 3req/2sec, subdivision=second`;

            const firstBatch: BatchRequest = {
                delay: 0,
                size: 1,
                validate: (res) => {
                    const received = res[0];

                    const expected: Partial<RateLimiterResponse> = {
                        allowed: true,
                        remaining: limiter.limit - 1
                    };

                    validateLimiterResponse(received, expected);
                }
            };

            const secondBatch: BatchRequest = {
                delay: 1000,
                size: 3,
                validate: (res) => {
                    for (let i = 0; i < 3; ++i) {
                        const received = res[i];

                        const expected: Partial<RateLimiterResponse> = {
                            allowed: true,
                            remaining: Math.max(0, limiter.limit - i - 2),
                        };

                        // Expect last request to fail
                        if (i === 2) {
                            expected.allowed = false;
                        }

                        validateLimiterResponse(received, expected);
                    }
                }
            };

            let batches = [firstBatch, secondBatch];

            let config: TestConfig = {
                limiter,
                key,
                batches
            };

            let batchResults = await runTestConfig(config);

            // Test first member expiration timestamp (from last request)
            let lastBatchResult = batchResults[batchResults.length - 1];
            let { firstExpireAtMs } = lastBatchResult[lastBatchResult.length - 1];
            let firstExpireAtMsDelta = firstExpireAtMs - Date.now();

            const thirdBatch: BatchRequest = {
                delay: firstExpireAtMsDelta,
                size: 2,
                validate: (res) => {
                    for (let i = 0; i < 2; ++i) {
                        const received = res[i];

                        const expected: Partial<RateLimiterResponse> = {
                            allowed: true,
                            remaining: 0,
                        };

                        // Expect last request to fail
                        if (i === 1) {
                            expected.allowed = false;
                        }

                        validateLimiterResponse(received, expected);
                    }
                }
            };

            batches = [thirdBatch];

            config = {
                limiter,
                key,
                batches
            };

            batchResults = await runTestConfig(config);

            // Test window expiration timestamp (from last request)
            lastBatchResult = batchResults[batchResults.length - 1];
            firstExpireAtMs = lastBatchResult[lastBatchResult.length - 1].firstExpireAtMs;
            let windowExpireAtMs = lastBatchResult[lastBatchResult.length - 1].windowExpireAtMs;
            firstExpireAtMsDelta = firstExpireAtMs - Date.now();
            const windowExpireAtMsDelta = windowExpireAtMs - Date.now();

            const fourthBatch: BatchRequest = {
                delay: windowExpireAtMsDelta,
                size: limiter.limit,
                validate: (res) => {
                    for (let i = 0; i < limiter.limit; ++i) {
                        const received = res[i];

                        const expected: Partial<RateLimiterResponse> = {
                            allowed: true,
                            remaining: Math.max(0, limiter.limit - i - 1),
                        };

                        validateLimiterResponse(received, expected);
                    }
                }
            };

            batches = [fourthBatch];

            config = {
                limiter,
                key,
                batches
            };

            await runTestConfig(config);

            expect(firstExpireAtMsDelta).toBeGreaterThan(0);
            expect(windowExpireAtMsDelta).toBeGreaterThan(0);
            expect(windowExpireAtMsDelta).toBeGreaterThan(firstExpireAtMsDelta);
        });
    }
});
