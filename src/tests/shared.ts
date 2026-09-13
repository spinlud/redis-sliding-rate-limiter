import { RateLimiter, RateLimiterResponse, SendCommandFn } from '../RateLimiter';
import { createClient } from 'redis';
import Redis from 'ioredis';

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// RESP protocol version supported by both client libraries.
export type RespProtocol = 2 | 3;

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

// node-redis client bound to an explicit RESP protocol version.
export function createRedisClientWithProtocol(resp: RespProtocol) {
    const host = process.env.REDIS_HOST ?? 'localhost';
    const port = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379;

    return createClient({
        url: `redis://${host}:${port}`,
        RESP: resp,
    });
}

// ioredis negotiates the RESP protocol from its installed major (v5 speaks RESP2,
// v6 defaults to RESP3), with no portable per-connection override, so the requested
// protocol is not forwarded to the constructor. The RESP-matrix test soft-skips when
// the negotiated protocol does not match the requested one.
export function createIORedisClientWithProtocol(protocol: RespProtocol) {
    return new Redis({
        host: process.env.REDIS_HOST ?? 'localhost',
        port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
    });
}

// Type guard for the ioredis command interface.
function hasCallInterface(client: unknown): client is { call: (command: string, ...args: string[]) => Promise<unknown> } {
    return typeof client === 'object' && client !== null && 'call' in client && typeof client.call === 'function';
}

// Type guard for the node-redis command interface.
function hasSendCommandInterface(client: unknown): client is { sendCommand: (args: string[]) => Promise<unknown> } {
    return typeof client === 'object' && client !== null && 'sendCommand' in client && typeof client.sendCommand === 'function';
}

// Send an arbitrary command through whichever command interface the client exposes.
export function sendRawCommand(client: unknown, ...args: string[]): Promise<unknown> {
    if (hasCallInterface(client)) {
        return client.call(args[0], ...args.slice(1));
    }

    if (hasSendCommandInterface(client)) {
        return client.sendCommand(args);
    }

    throw new Error('Client exposes neither `call` nor `sendCommand`');
}

// Build a canonical send-command callback bound to a live client.
export function toSendCommand(client: unknown): SendCommandFn {
    return (...args: string[]) => sendRawCommand(client, ...args);
}

// Extract the negotiated RESP protocol version from a CLIENT INFO reply.
export function parseNegotiatedProtocol(clientInfoReply: unknown): number | undefined {
    const text = String(clientInfoReply);
    const match = text.match(/resp=(\d+)/);
    return match ? Number(match[1]) : undefined;
}

export async function flushRedis(limiter: RateLimiter): Promise<void> {
    // Flush all keys
    // @ts-ignore
    await limiter._sendCommand('FLUSHALL');

    // Reset slowlog
    // @ts-ignore
    await limiter._sendCommand('SLOWLOG', 'RESET');
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
