import { Strategy } from './Strategy';
import { RateLimiterResponse } from '../RateLimiter';
import {
    LuaScript,
    MicrosecondsToWindowResolution,
    SecondsToWindowResolution
} from '../lua';

export class RedisStrategy extends Strategy {
    /**
     * Load script on Redis cache and returns sha1 of the script
     * @returns {Promise<string>}
     */
    async loadScript(): Promise<string> {
        const args = [
            'LOAD',
            LuaScript
        ];

        return new Promise<string>((resolve, reject) => {
            this.limiter.client.send_command('SCRIPT', args, (err, sha1) => {
                if (err) {
                    return reject(err);
                }

                return resolve(sha1);
            });
        });
    }

    /**
     * Call script execution on Redis using EVALSHA. Loads script on Redis cache if needed.
     * @param {any} key
     * @returns {Promise<RateLimiterResponse>}
     */
    async execScript(key: any): Promise<RateLimiterResponse> {
        if (!this.scriptSha1) {
            this.scriptSha1 = await this.loadScript();
        }

        const args = [
            this.scriptSha1,
            1, // number of keys
            key,
            this.limiter.window,
            SecondsToWindowResolution[this.limiter.windowResolution],
            MicrosecondsToWindowResolution[this.limiter.windowResolution],
            this.limiter.windowExpireMs,
            this.limiter.limit
        ];

        return new Promise<RateLimiterResponse>((resolve, reject) => {
            this.limiter.client.send_command('EVALSHA', args, (err: Error | null, res: any | any[]) => {
                if (err) {
                    return reject(err);
                }

                return resolve({
                    remaining: res[0],
                    isAllowed: res[0] > 0,
                    firstExpireAtMs: res[1],
                    windowExpireAtMs: res[2]
                });
            })
        });
    }
}