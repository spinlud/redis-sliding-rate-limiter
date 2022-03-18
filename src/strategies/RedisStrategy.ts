import { Strategy } from './Strategy';
import { RateLimiterResponse } from '../RateLimiter';
import {
    LuaScript,
    MicrosecondsToWindowSubdivision,
} from '../lua';

export class RedisStrategy extends Strategy {
    async sendCommand(cmd: string, ...args: any[]): Promise<any> {
        // return new Promise<any>((resolve, reject) => {
        //     this.limiter.client.sendCommand(cmd, args, (err: Error | null, res: any) => {
        //         if (err) {
        //             return reject(err);
        //         }
        //
        //         return resolve(res);
        //     });
        // });
        return await this.limiter.client.sendCommand([cmd, ...args]);
    }

    async loadScript(): Promise<string> {
        return await this.sendCommand('SCRIPT', 'LOAD', LuaScript);
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
            this.limiter.limit,
            this.limiter.limitOverhead
        ];

        let res: any;

        try {
            res = await this.sendCommand('EVALSHA', ...args);
        }
        catch(err: any) {
            // Script expired in Redis cache, reload and try again
            if (err && err.message && err.message.includes('NOSCRIPT')) {
                this.scriptSha1 = await this.loadScript();
                args[0] = this.scriptSha1;
                res = await this.sendCommand('EVALSHA', ...args);
            }
            else {
                throw err;
            }
        }

        return {
            allowed: !!res[0],
            remaining: Math.max(0, res[1]),
            firstExpireAtMs: res[2],
            windowExpireAtMs: res[3]
        };
    }
}
