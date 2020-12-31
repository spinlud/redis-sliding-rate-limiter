import { Strategy } from './Strategy';
import { RateLimiterResponse } from '../RateLimiter';
import {
    LuaScript,
    MicrosecondsToWindowResolution,
} from '../lua';

export class IORedisStrategy extends Strategy {
    loadScript(script: string): Promise<string> {
        throw new Error('Not implemented');
    }

    execScript(key: any): Promise<RateLimiterResponse> {
        throw new Error('Not implemented');
    }
}