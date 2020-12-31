import { RedisClient } from 'redis';
import { RateLimiter, WindowUnit } from '..';
import { sleep } from './utils';

(async () => {
    const limiter = new RateLimiter({
        client: new RedisClient({
            host: 'localhost',
            port: 6379
        }),
        windowUnit: WindowUnit.MINUTE,
        windowSize: 1,
        windowResolution: WindowUnit.SECOND,
        limit: 10
    });

    try {
        const key = 'ID_1';

        for (let i = 0; i < 11; ++i) {
            console.log(await limiter.get('ID_1'));
            await sleep(1000);
        }
    }
    catch(err) {
        console.error(err);
        process.exit(1);
    }
})();