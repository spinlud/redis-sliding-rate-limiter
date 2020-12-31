import { Strategy } from './Strategy';
import { RateLimiterResponse } from '../RateLimiter';
import {
    LuaScript,
    MicrosecondsToWindowResolution,
} from '../lua';

export class IORedisStrategy extends Strategy {
    async loadScript(): Promise<string> {
        const args = [
            'LOAD',
            LuaScript
        ];

        return await this.limiter.client.send_command('SCRIPT', ...args);
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

        const res: any[] = await this.limiter.client.send_command('EVALSHA', ...args);

        return {
            remaining: res[0],
            isAllowed: res[0] > 0,
            firstExpireAtMs: res[1],
            windowExpireAtMs: res[2]
        };
    }
}