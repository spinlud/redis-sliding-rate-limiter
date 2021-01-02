import { Strategy } from './Strategy';
import { RateLimiterResponse } from '../RateLimiter';
import {
    LuaScript,
    MicrosecondsToWindowSubdivision,
} from '../lua';

export class RedisStrategy extends Strategy {
    sendCommand(cmd: string, ...args: any[]): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            this.limiter.client.send_command(cmd, args, (err: Error | null, res: any) => {
                if (err) {
                    return reject(err);
                }

                return resolve(res);
            });
        });
    }

    async loadScript(): Promise<string> {
        const args = [
            'LOAD',
            LuaScript
        ];

        return await this.sendCommand('SCRIPT', args);
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
            MicrosecondsToWindowSubdivision[this.limiter.windowSubdivisionUnit],
            this.limiter.windowExpireMs,
            this.limiter.limit
        ];

        const res = await this.sendCommand('EVALSHA', args);

        return {
            remaining: Math.max(0, res[0]),
            isAllowed: res[0] >= 0,
            firstExpireAtMs: res[1],
            windowExpireAtMs: res[2]
        };
    }
}