import { Strategy } from './Strategy';
import { RateLimiterResponse } from '../RateLimiter';
import {
    LuaScript,
    MicrosecondsToWindowResolution,
} from '../lua';

export class IORedisStrategy extends Strategy {
    async sendCommand(cmd: string, ...args: any[]): Promise<any> {
        return await this.limiter.client.send_command(cmd, ...args);
    }

    async loadScript(): Promise<string> {
        const args = [
            'LOAD',
            LuaScript
        ];

        return await this.sendCommand('SCRIPT', ...args);
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

        const res: any[] = await this.sendCommand('EVALSHA', ...args);

        return {
            remaining: Math.max(0, res[0]),
            isAllowed: res[0] >= 0,
            firstExpireAtMs: res[1],
            windowExpireAtMs: res[2]
        };
    }
}