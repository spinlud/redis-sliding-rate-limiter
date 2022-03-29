import { RateLimiter, RateLimiterResponse } from '../RateLimiter';
import { createClient } from 'redis';
import Redis from 'ioredis';

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export type ValidateFn = (batchResponse: RateLimiterResponse[]) => void;

export interface BatchRequest {
    size: number; // How many requests in the batch
    delay: number; // Number of milliseconds to wait before sending the requests
    validate: ValidateFn; // Validation routine
}

export interface TestConfig {
    limiter: RateLimiter;
    key: string; // Redis key
    batches: BatchRequest[];
}

export function createRedisClient(): any {
    const host = process.env.REDIS_HOST ?? 'localhost';
    const port = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379;

    return createClient({
        url: `redis://${host}:${port}`,
    });
}

export function createIORedisClient(): any {
    return new Redis({
        host: process.env.REDIS_HOST ?? 'localhost',
        port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379
    });
}

export async function flushRedis(limiter: RateLimiter): Promise<void> {
    // Flush all keys
    // @ts-ignore
    await limiter._strategy.sendCommand('FLUSHALL');

    // Reset slowlog
    // @ts-ignore
    await limiter._strategy.sendCommand('SLOWLOG', 'RESET');
}

export function validateLimiterResponse(received: RateLimiterResponse, expected: Partial<RateLimiterResponse>) {
    expect(received).toBeDefined();
    expect(received).toMatchObject(expected);
    expect(typeof received.firstExpireAtMs).toBe('number');
    expect(received.firstExpireAtMs).toBeGreaterThan(0);
    expect(typeof received.windowExpireAtMs).toBe('number');
    expect(received.windowExpireAtMs).toBeGreaterThan(0);
}

export async function runTestConfig(config: TestConfig): Promise<RateLimiterResponse[][]> {
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
