#!/usr/bin/env bash
#
# Throwaway-but-kept benchmark runner (ticket #11).
# Starts an ephemeral Redis via docker compose, then runs the harness.
# Any extra args are forwarded to the harness (env vars still apply too).
#
# Example:
#   BENCH_CONCURRENCY=100 BENCH_DURATION_MS=20000 bench/run.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "Starting ephemeral Redis (docker compose service: redis)..."
docker compose up -d redis

echo "Waiting for Redis to be reachable..."
for _ in $(seq 1 30); do
    if docker compose exec -T redis redis-cli ping >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

echo "Running benchmark harness..."
npx ts-node bench/limiter-bench.ts "$@"
