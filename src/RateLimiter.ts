import { Unit, convertWindowUnitToSubdivision, WindowUnitToMilliseconds } from './lua';
import { Strategy, RedisStrategy, IORedisStrategy } from './strategies';

export type SendCommand = (...args: any[]) => any;

export interface RedisClientWrapper {
    send_command: SendCommand;
}

export interface RateLimiterOptions {
    /**
     * Client object from any of the following libraries:
     * - https://www.npmjs.com/package/redis
     * - https://www.npmjs.com/package/ioredis
     */
    client: RedisClientWrapper;

    /**
     * Window unit (second, minute, hour, etc)
     */
    windowUnit: Unit;

    /**
     * Window size in number of units (eg 1 second, 10 minutes, 2 hour, etc)
     */
    windowSize: number;

    /**
     * Specify the granularity of the window. This will impact on the number of elements stored per key.
     * For example a window of 1 minute with seconds subdivision will store a maximum of 60 elements per key,
     * while a window of 1 second with decisecond subdivision will store a maximum of 10 elements per key.
     * Must be less or equal than window unit.
     */
    windowSubdivisionUnit?: Unit;

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

    private _client: RedisClientWrapper;
    private _windowUnit: Unit;
    private _windowSize: number;
    private _windowSubdivisionUnit: Unit;
    private _limit: number;
    private _window: number;
    private _windowExpireMs: number;

    constructor(options: RateLimiterOptions) {
        if (options.windowSubdivisionUnit && options.windowSubdivisionUnit > options.windowUnit) {
            throw new Error(`Window subdivision must be lower or equal to the window unit`);
        }

        this._client = options.client;
        this._windowUnit = options.windowUnit;
        this._windowSize = options.windowSize;
        this._windowSubdivisionUnit = options.windowSubdivisionUnit ?? options.windowUnit;
        this._limit = options.limit;
        this._window = convertWindowUnitToSubdivision(this._windowUnit, this._windowSubdivisionUnit) * this._windowSize;
        this._windowExpireMs = WindowUnitToMilliseconds[this._windowUnit] * this._windowSize;

        // Switch strategy based on send_command signature
        switch (this._client.send_command.length) {
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

    private _updateWindow(): void {
        this._window = convertWindowUnitToSubdivision(this._windowUnit, this._windowSubdivisionUnit) * this._windowSize;
    }

    private _updateWindowExpiration(): void {
        this._windowExpireMs = WindowUnitToMilliseconds[this._windowUnit] * this._windowSize;
    }

    public get client() {
        return this._client;
    }

    public set client(v) {
        this._client = v;
    }

    public get windowUnit() {
        return this._windowUnit;
    }

    public set windowUnit(v) {
        this._windowUnit = v;
        this._updateWindow();
        this._updateWindowExpiration();
    }

    public get windowSize() {
        return this._windowSize;
    }

    public set windowSize(v) {
        this._windowSize = v;
        this._updateWindow();
        this._updateWindowExpiration();
    }

    public get windowSubdivisionUnit() {
        return this._windowSubdivisionUnit;
    }

    public set windowSubdivisionUnit(v) {
        if (v > this.windowUnit) {
            throw new Error(`Window subdivision must be lower or equal than window unit`);
        }

        this._windowSubdivisionUnit = v;
        this._updateWindow();
    }

    public get limit() {
        return this._limit;
    }

    public set limit(v) {
        this._limit = v;
    }

    public get window() {
        return this._window;
    }

    public get windowExpireMs() {
        return this._windowExpireMs;
    }

    public toString(): string {
        return JSON.stringify({
            windowUnit: this.windowUnit,
            windowSize: this.windowSize,
            windowSubdivisionUnit: this.windowSubdivisionUnit,
            window: this.window,
            windowExpireMs: this.windowExpireMs,
            limit: this.limit,
        }, null, 4);
    }

    get = async (key: any): Promise<RateLimiterResponse> => {
        return await this._strategy.execScript(key);
    }
}