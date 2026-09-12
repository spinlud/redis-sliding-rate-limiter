/*
 * THROWAWAY-BUT-KEPT BENCHMARK HARNESS (ticket #11).
 *
 * This file is a development benchmark, NOT part of the published package.
 * It exercises the CURRENT, UNMODIFIED sliding-window algorithm in src/ to
 * capture baseline throughput, latency, Redis CPU and memory-per-key numbers.
 * It is intentionally excluded from the build; nothing in src/ imports it.
 *
 * Run it with bench/run.sh (starts Redis via docker compose, then ts-node).
 */

import { createClient } from 'redis';
import { Redis } from 'ioredis';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { RateLimiter, RateLimiterOptions, Unit } from '../src';

// The limiter accepts a thin client wrapper; derive its type from the library API.
type LimiterClient = RateLimiterOptions['client'];

// A uniform way to send raw Redis commands for measurement/bookkeeping.
type RawCommand = (args: string[]) => Promise<unknown>;

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const BENCH_DB = 15; // Isolated logical DB, never a shared one.
const PREFIX = 'bench:rl:';

const BENCH_CONCURRENCY = readIntEnv('BENCH_CONCURRENCY', 50);
const BENCH_DURATION_MS = readIntEnv('BENCH_DURATION_MS', 10000);
const BENCH_WARMUP_MS = readIntEnv('BENCH_WARMUP_MS', 2000);
const BENCH_KEYS = readIntEnv('BENCH_KEYS', 1000);

// 60-second window per profile; subdivisionUnit left at its current default (= window unit).
const WINDOW_UNIT = Unit.SECOND;
const WINDOW_SIZE = 60;

const PROFILES: ReadonlyArray<{ limit: number }> = [
    { limit: 100 },
    { limit: 1000 },
    { limit: 10000 },
];

interface BenchClient {
    name: string;
    libName: string;
    libVer: string;
    resp: string;
    limiterClient: LimiterClient;
    raw: RawCommand;
    close: () => Promise<void>;
}

interface ProfileResult {
    clientName: string;
    limit: number;
    reqPerSec: number;
    p50: number;
    p95: number;
    p99: number;
    cpuSeconds: number;
    microsecondsPerOp: number;
    memoryBytes: number;
    zcard: number;
    bytesPerMember: number;
    ops: number;
}

function readIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid value for ${name}: ${raw}`);
    }
    return Math.floor(parsed);
}

// --- Reply narrowing helpers (Redis replies arrive as unknown here) ---

function toText(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (value instanceof Buffer) {
        return value.toString('utf8');
    }
    throw new Error(`Expected string reply, got ${typeof value}`);
}

function toNumber(value: unknown): number {
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string' || value instanceof Buffer) {
        const parsed = Number(value.toString());
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    throw new Error(`Expected numeric reply, got ${typeof value}`);
}

function parseInfoField(info: string, field: string): string {
    const prefix = `${field}:`;
    const line = info.split('\n').find((l) => l.startsWith(prefix));
    if (line === undefined) {
        throw new Error(`Field '${field}' not found in INFO output`);
    }
    return line.slice(prefix.length).trim();
}

// CLIENT INFO is a single line of space-separated key=value tokens.
function parseClientInfo(info: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const token of info.trim().split(/\s+/)) {
        const idx = token.indexOf('=');
        if (idx > 0) {
            map.set(token.slice(0, idx), token.slice(idx + 1));
        }
    }
    return map;
}

function percentile(sortedAscending: number[], p: number): number {
    if (sortedAscending.length === 0) {
        return Number.NaN;
    }
    const rank = Math.ceil((p / 100) * sortedAscending.length) - 1;
    const idx = Math.min(sortedAscending.length - 1, Math.max(0, rank));
    return sortedAscending[idx];
}

// --- Client construction: both drivers forced to RESP2 for an apples-to-apples baseline ---

async function createNodeRedisClient(): Promise<BenchClient> {
    const client = createClient({ url: REDIS_URL, database: BENCH_DB, RESP: 2 });
    await client.connect();

    const raw: RawCommand = (args) => client.sendCommand(args);
    const info = parseClientInfo(toText(await raw(['CLIENT', 'INFO'])));

    const limiterClient: LimiterClient = {
        sendCommand: (command: (string | Buffer | number)[]) =>
            client.sendCommand(command.map((part) => (part instanceof Buffer ? part : String(part)))),
    };

    return {
        name: 'node-redis',
        libName: info.get('lib-name') ?? 'node-redis',
        libVer: info.get('lib-ver') ?? 'unknown',
        resp: info.get('resp') ?? 'unknown',
        limiterClient,
        raw,
        close: async () => {
            await client.close();
        },
    };
}

async function createIoRedisClient(): Promise<BenchClient> {
    const client = new Redis(REDIS_URL, { db: BENCH_DB, protocol: 2 });

    const raw: RawCommand = (args) => client.call(args[0], args.slice(1));
    const info = parseClientInfo(toText(await raw(['CLIENT', 'INFO'])));

    const limiterClient: LimiterClient = {
        call: (command: string, cargs: (string | Buffer | number)[]) =>
            client.call(command, cargs.map((part) => (part instanceof Buffer ? part : String(part)))),
    };

    return {
        name: 'ioredis',
        libName: info.get('lib-name') ?? 'ioredis',
        libVer: info.get('lib-ver') ?? 'unknown',
        resp: info.get('resp') ?? 'unknown',
        limiterClient,
        raw,
        close: async () => {
            client.disconnect();
        },
    };
}

// Remove only this harness's keys from the isolated DB (never FLUSH).
async function cleanKeys(raw: RawCommand): Promise<void> {
    let cursor = '0';
    do {
        const reply = await raw(['SCAN', cursor, 'MATCH', `${PREFIX}*`, 'COUNT', '1000']);
        if (!Array.isArray(reply) || reply.length < 2) {
            throw new Error('Unexpected SCAN reply shape');
        }
        cursor = toText(reply[0]);
        const batch = reply[1];
        if (!Array.isArray(batch)) {
            throw new Error('Unexpected SCAN keys shape');
        }
        const keys = batch.map(toText);
        if (keys.length > 0) {
            await raw(['DEL', ...keys]);
        }
    } while (cursor !== '0');
}

async function readCpuSeconds(raw: RawCommand): Promise<number> {
    const info = toText(await raw(['INFO', 'cpu']));
    const user = Number(parseInfoField(info, 'used_cpu_user'));
    const sys = Number(parseInfoField(info, 'used_cpu_sys'));
    return user + sys;
}

async function readRedisVersion(raw: RawCommand): Promise<string> {
    const info = toText(await raw(['INFO', 'server']));
    return parseInfoField(info, 'redis_version');
}

interface LoadState {
    deadline: number;
    counter: number;
    recording: boolean;
    ops: number;
    latencies: number[];
}

async function runWorker(limiter: RateLimiter, keys: string[], state: LoadState): Promise<void> {
    while (Date.now() < state.deadline) {
        const key = keys[state.counter % keys.length];
        state.counter += 1;
        const start = performance.now();
        await limiter.get(key);
        const elapsed = performance.now() - start;
        if (state.recording) {
            state.latencies.push(elapsed);
            state.ops += 1;
        }
    }
}

async function runLoadPhase(
    limiter: RateLimiter,
    keys: string[],
    durationMs: number,
    recording: boolean,
): Promise<LoadState> {
    const state: LoadState = {
        deadline: Date.now() + durationMs,
        counter: 0,
        recording,
        ops: 0,
        latencies: [],
    };
    const workers: Promise<void>[] = [];
    for (let i = 0; i < BENCH_CONCURRENCY; i += 1) {
        workers.push(runWorker(limiter, keys, state));
    }
    await Promise.all(workers);
    return state;
}

async function benchmarkProfile(client: BenchClient, limit: number): Promise<ProfileResult> {
    await cleanKeys(client.raw);

    const limiter = new RateLimiter({
        client: client.limiterClient,
        window: { unit: WINDOW_UNIT, size: WINDOW_SIZE },
        limit,
        name: `${client.name}-${limit}`,
    });

    const keys: string[] = [];
    for (let i = 0; i < BENCH_KEYS; i += 1) {
        keys.push(`${PREFIX}k:${i}`);
    }

    // Warmup: results discarded.
    await runLoadPhase(limiter, keys, BENCH_WARMUP_MS, false);

    // Measured window: bracket it with whole-server CPU readings.
    const cpuStart = await readCpuSeconds(client.raw);
    const wallStart = Date.now();
    const measured = await runLoadPhase(limiter, keys, BENCH_DURATION_MS, true);
    const measuredSeconds = (Date.now() - wallStart) / 1000;
    const cpuEnd = await readCpuSeconds(client.raw);

    const cpuSeconds = cpuEnd - cpuStart;
    const reqPerSec = measured.ops / measuredSeconds;
    const microsecondsPerOp = measured.ops > 0 ? (cpuSeconds * 1e6) / measured.ops : Number.NaN;

    const sorted = measured.latencies.slice().sort((a, b) => a - b);

    // Memory-per-key: fill a fresh key with ~limit members within the window.
    const memKey = `${PREFIX}mem:${limit}`;
    await client.raw(['DEL', memKey]);
    const memLimiter = new RateLimiter({
        client: client.limiterClient,
        window: { unit: WINDOW_UNIT, size: WINDOW_SIZE },
        limit,
        name: `${client.name}-mem-${limit}`,
    });
    for (let i = 0; i < limit; i += 1) {
        await memLimiter.get(memKey);
    }
    const zcard = toNumber(await client.raw(['ZCARD', memKey]));
    const memoryBytes = toNumber(await client.raw(['MEMORY', 'USAGE', memKey]));
    await client.raw(['DEL', memKey]);

    await cleanKeys(client.raw);

    return {
        clientName: client.name,
        limit,
        reqPerSec,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        cpuSeconds,
        microsecondsPerOp,
        memoryBytes,
        zcard,
        bytesPerMember: zcard > 0 ? memoryBytes / zcard : Number.NaN,
        ops: measured.ops,
    };
}

function formatNumber(value: number, digits: number): string {
    if (!Number.isFinite(value)) {
        return 'n/a';
    }
    return value.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
}

function buildReport(params: {
    redisVersion: string;
    clients: BenchClient[];
    results: ProfileResult[];
    generatedAt: string;
}): string {
    const { redisVersion, clients, results, generatedAt } = params;
    const lines: string[] = [];

    lines.push('# redis-sliding-rate-limiter baseline benchmark');
    lines.push('');
    lines.push(`Generated: ${generatedAt}`);
    lines.push('');
    lines.push('Throwaway-but-kept harness (ticket #11). Benchmarks the current, unmodified');
    lines.push('sliding-window algorithm. Redis CPU is whole-server CPU during the measured window.');
    lines.push('');
    lines.push('## Environment');
    lines.push('');
    lines.push(`- redis_version: ${redisVersion}`);
    lines.push(`- REDIS_URL: ${REDIS_URL} (db ${BENCH_DB}, key prefix \`${PREFIX}\`)`);
    lines.push(`- BENCH_CONCURRENCY: ${BENCH_CONCURRENCY}`);
    lines.push(`- BENCH_DURATION_MS (measured): ${BENCH_DURATION_MS}`);
    lines.push(`- BENCH_WARMUP_MS: ${BENCH_WARMUP_MS}`);
    lines.push(`- BENCH_KEYS (key-pool size): ${BENCH_KEYS}`);
    lines.push(`- Window per profile: ${WINDOW_SIZE} x unit(${Unit[WINDOW_UNIT]}), subdivisionUnit at default`);
    lines.push('');
    lines.push('### Clients');
    lines.push('');
    lines.push('| client | package version | RESP protocol |');
    lines.push('| --- | --- | --- |');
    for (const c of clients) {
        lines.push(`| ${c.name} | ${c.libVer} | RESP${c.resp} |`);
    }
    lines.push('');
    lines.push('## Results');
    lines.push('');
    lines.push(
        '| client | limit | window | req/s | p50 ms | p95 ms | p99 ms | redis CPU s (window) | µs/op | MEMORY USAGE bytes/key | bytes/member | ZCARD |',
    );
    lines.push('| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    const windowLabel = `${WINDOW_SIZE}${Unit[WINDOW_UNIT].toLowerCase().charAt(0)} (${WINDOW_SIZE}s)`;
    for (const r of results) {
        lines.push(
            `| ${r.clientName} | ${r.limit} | ${windowLabel} | ${formatNumber(r.reqPerSec, 0)} | ` +
                `${formatNumber(r.p50, 3)} | ${formatNumber(r.p95, 3)} | ${formatNumber(r.p99, 3)} | ` +
                `${formatNumber(r.cpuSeconds, 3)} | ${formatNumber(r.microsecondsPerOp, 2)} | ` +
                `${formatNumber(r.memoryBytes, 0)} | ${formatNumber(r.bytesPerMember, 2)} | ${r.zcard} |`,
        );
    }
    lines.push('');
    return lines.join('\n');
}

async function main(): Promise<void> {
    const clients: BenchClient[] = [];
    const results: ProfileResult[] = [];

    const nodeRedis = await createNodeRedisClient();
    clients.push(nodeRedis);
    const ioRedis = await createIoRedisClient();
    clients.push(ioRedis);

    try {
        const redisVersion = await readRedisVersion(nodeRedis.raw);

        for (const client of clients) {
            console.error(`Running ${client.name} (RESP${client.resp}, v${client.libVer})...`);
            for (const profile of PROFILES) {
                console.error(`  profile limit=${profile.limit}`);
                results.push(await benchmarkProfile(client, profile.limit));
            }
        }

        const generatedAt = new Date().toISOString();
        const report = buildReport({ redisVersion, clients, results, generatedAt });

        console.log(report);

        const resultsDir = join(__dirname, 'results');
        mkdirSync(resultsDir, { recursive: true });
        const safeStamp = generatedAt.replace(/[:.]/g, '-');
        const outPath = join(resultsDir, `baseline-${safeStamp}.md`);
        writeFileSync(outPath, report, 'utf8');
        console.error(`\nSaved report to ${outPath}`);
    } finally {
        // Best-effort cleanup, then close both clients cleanly.
        for (const client of clients) {
            try {
                await cleanKeys(client.raw);
            } catch (err) {
                console.error(`Cleanup failed for ${client.name}:`, err);
            }
        }
        for (const client of clients) {
            await client.close();
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
