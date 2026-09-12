# Benchmark harness (throwaway-but-kept)

A development benchmark for `redis-sliding-rate-limiter` (ticket #11) that measures the
**current, unmodified** sliding-window algorithm end-to-end against a local Redis. It drives the
limiter through both `ioredis` and `redis` (node-redis) at their installed majors, forces RESP2 on
each for an apples-to-apples baseline, sweeps profiles `limit=100/1000/10000` (60s window), and
reports throughput (req/s), latency (p50/p95/p99), whole-server Redis CPU during the measured
window (µs/op), and memory-per-key. It uses an isolated logical DB (15) and a `bench:rl:` key
prefix, cleaning only its own keys (never `FLUSH`). It is **not** part of the published package and
nothing in `src/` imports it. Run everything with one command: `bash bench/run.sh` (starts an
ephemeral Redis via docker compose, then runs the harness). The Markdown report is printed to stdout
and saved to `bench/results/baseline-<ISO-timestamp>.md`. Override params via env vars, e.g.
`BENCH_CONCURRENCY=100 BENCH_DURATION_MS=20000 bash bench/run.sh`; if Docker is unavailable, point
`REDIS_URL` at any reachable Redis and run `npx ts-node bench/limiter-bench.ts` directly.

## Parameters (env-overridable)

| Variable | Default | Meaning |
| --- | --- | --- |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection URL (harness uses db 15). |
| `BENCH_CONCURRENCY` | `50` | Number of concurrent async workers. |
| `BENCH_DURATION_MS` | `10000` | Measured window duration. |
| `BENCH_WARMUP_MS` | `2000` | Warmup duration (results discarded). |
| `BENCH_KEYS` | `1000` | Size of the round-robin key pool. |
