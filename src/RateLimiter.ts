import { WindowUnit, convertUnitToResolution, WindowUnitToMilliseconds } from './lua';
import { Strategy, RedisStrategy, IORedisStrategy } from './strategies';

export type SendCommand = (...args: any[]) => any;

export interface RedisClientWrapper {
    send_command: SendCommand;
}

interface RateLimiterOptions {
    /**
     * Client object from any of the following libraries:
     * - https://www.npmjs.com/package/redis
     * - https://www.npmjs.com/package/ioredis
     */
    client: RedisClientWrapper;

    /**
     * Window unit (second, minute, hour, etc)
     */
    windowUnit: WindowUnit;

    /**
     * Window size in number of units (eg 1 second, 10 minutes, 2 hour, etc)
     */
    windowSize: number;

    /**
     * Specify the granularity of the window. This will impact on the number of elements stored per key.
     * For example a window of 1 minute with second resolution will store a maximum of 60 elements per key,
     * while a window of 1 second with decisecond resolution will store a maximum of 10 elements per key.
     */
    windowResolution?: WindowUnit;

    /**
     * Number of requests allowed in the window (eg 10 requests per 1 second)
     */
    limit: number;
}

export interface RateLimiterResponse {
    /**
     * Number of remaining requests that can be performed in the current window
     */
    remaining: number;

    /**
     * Whether the request is allowed or not
     */
    isAllowed: boolean;

    /**
     * Epoch (milliseconds) at which the first element will expire in the current window
     */
    firstExpireAtMs: number;

    /**
     * Epoch (milliseconds) at which the current window will expire
     */
    windowExpireAtMs: number
}

export class RateLimiter {
    private _strategy: Strategy;
    private _tag: string = '[RateLimiter]';

    client: RedisClientWrapper;
    windowUnit: WindowUnit;
    windowSize: number;
    windowResolution: WindowUnit;
    limit: number;
    window: number;
    windowExpireMs: number;

    constructor(options: RateLimiterOptions) {
        if (options.windowResolution && options.windowResolution > options.windowUnit) {
            throw new Error(`Window resolution must be lower or equal to the window unit`);
        }

        this.client = options.client;
        this.windowUnit = options.windowUnit;
        this.windowSize = options.windowSize;
        this.windowResolution = options.windowResolution ?? options.windowUnit;
        this.limit = options.limit;
        this.window = convertUnitToResolution(this.windowUnit, this.windowResolution) * this.windowSize;
        this.windowExpireMs = WindowUnitToMilliseconds[this.windowUnit] * this.windowSize;

        // Switch strategy based on send_command signature
        switch (this.client.send_command.length) {
            case 0:
            case 1:
                this._strategy = new IORedisStrategy(this);
                console.log(this._tag, `Switching to ${IORedisStrategy.name}`);
                break;
            case 3:
                this._strategy = new RedisStrategy(this);
                console.log(this._tag, `Switching to ${RedisStrategy.name}`);
                break;
            default:
                throw new Error('Unknown send_command signature');
        }
    }

    get = async (key: any): Promise<RateLimiterResponse> => {
        return await this._strategy.execScript(key);
    }
}