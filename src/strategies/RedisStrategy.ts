import { Strategy } from './Strategy';
import { RateLimiterResponse } from '../RateLimiter';
import {
    LuaScript,
    MicrosecondsToWindowResolution,
} from '../lua';

export class RedisStrategy extends Strategy {
    async loadScript(): Promise<string> {
        const args = [
            'LOAD',
            LuaScript
        ];

        return new Promise<string>((resolve, reject) => {
            this.limiter.client.send_command('SCRIPT', args, (err: Error | null, sha1: string) => {
                if (err) {
                    return reject(err);
                }

                return resolve(sha1);
            });
        });
    }

    async execScript(key: any): Promise<RateLimiterResponse> {
        if (!this.scriptSha1) {
            this.scriptSha1 = await this.loadScript();
        }

        const args = [
            this.scriptSha1,
            1, // number of keys
            key,
            this.limiter.window,
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