import { EventEmitter } from 'events';
import { Unit, convertWindowUnitToSubdivision, WindowUnitToMilliseconds } from './lua';
import { Strategy, RedisStrategy, IORedisStrategy } from './strategies';

export type SendCommand = (...args: any[]) => any;

export interface RedisClientWrapper {
    sendCommand: SendCommand;
    send_command?: SendCommand;
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
     * Specify the granularity of the window, i.e. with which precision elements would expire in the current window.
     * Must be less or equal than window unit.
     */
    windowSubdivisionUnit?: Unit;

    /**
     * Number of requests allowed in the window (eg 10 requests per 1 second)
     */
    limit: number;

    /**
     * How many requests are allowed to exceed the limit expressed as a fraction of the limit, rounded down.
     * Example: with limit=10 and limitOverheadFraction=0.1, 10% of the requests (1) will be allowed to exceed the limit.
     * Default is zero.
     */
    limitOverheadFraction?: number;

    /**
     * Optional name for this limiter
     */
    name?: string;
}

export interface RateLimiterResponse {
    /**
     * Number of remaining requests that can be performed in the current window
     */
    remaining: number;

    /**
     * Whether the request is allowed or not
     */
    allowed: boolean;

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
    private _limitOverheadFraction: number;
    private _limitOverhead: number;
    private _window: number;
    private _windowExpireMs: number;
    private _name: string;

    constructor(options: RateLimiterOptions) {
        if (!options.client) {
            throw new Error(`Missing required property 'client'`);
        }

        if (!options.hasOwnProperty('windowUnit')) {
            throw new Error(`Missing required property 'windowUnit'`);
        }

        if (!options.hasOwnProperty('windowSize')) {
            throw new Error(`Missing required property 'windowSize'`);
        }

        if (!options.limit || options.limit <= 0) {
            throw new Error(`Invalid or missing required property 'limit'`);
        }

        if (options.limitOverheadFraction && options.limitOverheadFraction < 0) {
            throw new Error(`Property 'limitOverheadFraction' must be greater or equal than zero`);
        }

        if (options.hasOwnProperty('windowSubdivisionUnit') && options.windowSubdivisionUnit! > options.windowUnit) {
            throw new Error(`Window subdivision must be lower or equal to the window unit`);
        }

        this._client = options.client;
        this._windowUnit = options.windowUnit;
        this._windowSize = options.windowSize;
        this._windowSubdivisionUnit = options.windowSubdivisionUnit ?? options.windowUnit;
        this._limit = options.limit;
        this._limitOverheadFraction = options.limitOverheadFraction ?? 0;
        this._limitOverhead = Math.floor(this._limit * this._limitOverheadFraction);
        this._window = convertWindowUnitToSubdivision(this._windowUnit, this._windowSubdivisionUnit) * this._windowSize;
        this._windowExpireMs = WindowUnitToMilliseconds[this._windowUnit] * this._windowSize;
        this._name = options.name ?? `${this.windowUnit}_${this.windowSize}_${this.windowSubdivisionUnit}`;

        // TODO: Switch strategy based on sendCommand function name (empty string for IORedis library).
        // TODO: This is very likely to be broken in the future, a better way should be found ;-)
        switch (this._client.sendCommand.name) {
            case 'sendCommand':
                this._strategy = new RedisStrategy(this);
                break;
            case '':
                this._strategy = new IORedisStrategy(this);
                break;
            default:
                throw new Error(`Unknown sendCommand function name (${this._client.sendCommand.name})`);
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
        this._limitOverhead = Math.floor(this._limit * this._limitOverheadFraction);
    }

    public get limitOverheadFraction() {
        return this._limitOverheadFraction;
    }

    public set limitOverheadFraction(v) {
        this._limitOverheadFraction = v;
        this._limitOverhead = Math.floor(this._limit * this._limitOverheadFraction);
    }

    public get limitOverhead() {
        return this._limitOverhead;
    }

    public get window() {
        return this._window;
    }

    public get windowExpireMs() {
        return this._windowExpireMs;
    }

    public get name() {
        return this._name;
    }

    public set name(v) {
        this._name = v;
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
