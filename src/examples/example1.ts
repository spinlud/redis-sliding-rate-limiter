import { RedisClient } from 'redis';
import { RateLimiter, Unit } from '..';

(async () => {
    const client = new RedisClient({
        host: 'localhost',
        port: 6379
    });

    // Allows 2 requests every 3 seconds, with decisecond precision
    const limiter = new RateLimiter({
        client: client,
        windowUnit: Unit.SECOND,
        windowSize: 3,
        windowSubdivisionUnit: Unit.DECISECOND,
        limit: 2,
    });

    const key = 'OneRing';

    const results = await Promise.all([
        limiter.get(key),
        limiter.get(key),
        limiter.get(key), // Expect to fail
    ]);

    for (const res of results) {
        const { allowed, remaining, firstExpireAtMs, windowExpireAtMs } = res;
        console.log(allowed, remaining, firstExpireAtMs, windowExpireAtMs);
    }
    // Output:
    // true 1 1609716538519 1609716538519
    // true 0 1609716538519 1609716538520
    // false 0 1609716538519 1609716538520

    client.quit();
})();