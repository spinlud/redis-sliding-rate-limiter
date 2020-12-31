import { RedisClient } from 'redis';
import Redis from 'ioredis';
import { RateLimiter, WindowUnit } from '..';
import { sleep } from './utils';

(async () => {
    const client1 = new RedisClient({
        host: 'localhost',
        port: 6379
    });

    const client2 = new Redis({
        host: 'localhost',
        port: 6379
    });

    const limiter1 = new RateLimiter({
        client: client1,
        windowUnit: WindowUnit.MINUTE,
        windowSize: 1,
        windowResolution: WindowUnit.SECOND,
        limit: 10
    });

    const limiter2 = new RateLimiter({
        client: client1,
        windowUnit: WindowUnit.MINUTE,
        windowSize: 1,
        windowResolution: WindowUnit.SECOND,
        limit: 10
    });

    try {
        const key = 'ID_1';

        for (let i = 0; i < 3; ++i) {
            console.log(await limiter1.get('ID_1'));
            await sleep(1000);
        }

        for (let i = 0; i < 3; ++i) {
            console.log(await limiter2.get('ID_1'));
            await sleep(1000);
        }

        client1.quit();
        client2.quit();
    }
    catch(err) {
        console.error(err);
        process.exit(1);
    }
})();