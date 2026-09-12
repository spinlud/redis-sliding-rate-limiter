import {
    Unit,
    WindowUnitToMilliseconds,
    LuaScript,
} from './lua';

/**
 * Canonical callback used to send a command to Redis. Command name and every
 * argument are passed as strings; the reply shape is left untyped and narrowed
 * at the point of use.
 */
export type SendCommandFn = (...args: string[]) => Promise<unknown>;

export interface RedisClientWrapper {
    sendCommand?: (args: string[]) => Promise<unknown>; // used by node-redis
    call?: (command: string, ...args: string[]) => Promise<unknown>; // used by ioredis
}

export interface RateLimiterOptionsWindow {
    /**
     * Window unit (second, minute, hour, etc)
     */
    unit: Unit;

    /**
     * Window size in number of units (eg 1 second, 10 minutes, 2 hour, etc)
     */
    size: number;
}

export interface RateLimiterOptions {
    /**
     * Client object from any of the following libraries:
     * - https://www.npmjs.com/package/redis
     * - https://www.npmjs.com/package/ioredis
     *
     * Mutually exclusive with `sendCommand`: provide exactly one of the two.
     */
    client?: RedisClientWrapper;

    /**
     * Callback used to send a command to Redis. Receives the command name and
     * its arguments as strings and resolves with the raw Redis reply.
     *
     * Mutually exclusive with `client`: provide exactly one of the two.
     */
    sendCommand?: SendCommandFn;

    /**
     * Rate limiter window properties
     */
    window: RateLimiterOptionsWindow;

    /**
     * Number of requests allowed in the window (eg 10 requests per 1 second)
     */
    limit: number;

    /**
     * How many requests are allowed to exceed the limit expressed as a fraction of the limit, rounded down.
     * Example: with limit=10 and limitOverheadFraction=0.1, 10% of the requests (1) will be allowed to exceed the limit.
     * Default is zero.
     */
    limitOverhead?: number;

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
    private _tag: string = '[RateLimiter]';

    private _client?: RedisClientWrapper;
    private _sendCommand: SendCommandFn;
    private _scriptSha1?: string;
    private _windowUnit: Unit;
    private _windowSize: number;
    private _limit: number;
    private _limitOverheadFraction: number;
    private _limitOverhead: number;
    private _window: number;
    private _windowExpireMs: number;
    private _name: string;

    constructor(options: RateLimiterOptions) {
        if (options.client && options.sendCommand) {
            throw new Error('Provide either `client` or `sendCommand`, not both');
        }

        if (!options.window || !options.window.hasOwnProperty('unit')) {
            throw new Error(`Missing required property 'window.unit'`);
        }

        if (!options.window || !options.window.hasOwnProperty('size')) {
            throw new Error(`Missing required property 'window.size'`);
        }

        if (!options.limit || options.limit <= 0) {
            throw new Error(`Invalid or missing required property 'limit'`);
        }

        if (options.limitOverhead && options.limitOverhead < 0) {
            throw new Error(`Property 'limitOverheadFraction' must be greater or equal than zero`);
        }

        if (Object.prototype.hasOwnProperty.call(options.window, 'subdivisionUnit')) {
            throw new Error(`'window.subdivisionUnit' was removed in v7: the sliding window is now exact and no longer subdivided. See the v6 to v7 migration guide.`);
        }

        if (options.sendCommand) {
            this._sendCommand = options.sendCommand;
            this._client = undefined;
        }
        else if (options.client) {
            this._client = options.client;
            this._sendCommand = this._resolveSendCommand(options.client);
        }
        else {
            throw new Error('Provide either `client` or `sendCommand`');
        }

        this._windowUnit = options.window.unit;
        this._windowSize = options.window.size;
        this._limit = options.limit;
        this._limitOverheadFraction = options.limitOverhead ?? 0;
        this._limitOverhead = Math.floor(this._limit * this._limitOverheadFraction);
        // Sliding window length in microseconds
        this._window = WindowUnitToMilliseconds[this._windowUnit] * this._windowSize * 1000;
        this._windowExpireMs = WindowUnitToMilliseconds[this._windowUnit] * this._windowSize;
        this._name = options.name ?? `${this.windowUnit}_${this.windowSize}`;
    }

    /**
     * Build the canonical send-command callback from a Redis client instance by
     * detecting its command interface.
     */
    private _resolveSendCommand(client: RedisClientWrapper): SendCommandFn {
        if (typeof client.call === 'function') {
            const call = client.call.bind(client);
            return (...args: string[]) => call(args[0], ...args.slice(1));
        }

        if (typeof client.sendCommand === 'function') {
            const sendCommand = client.sendCommand.bind(client);
            return (...args: string[]) => sendCommand(args);
        }

        throw new Error('Could not detect the Redis client; pass a `sendCommand` callback instead');
    }

    private async _loadScript(): Promise<string> {
        const reply = await this._sendCommand('SCRIPT', 'LOAD', LuaScript);
        return String(reply);
    }

    private _isNoScriptError(err: unknown): boolean {
        return err instanceof Error && err.message.includes('NOSCRIPT');
    }

    private _parseReply(reply: unknown): RateLimiterResponse {
        if (!Array.isArray(reply) || reply.length < 4) {
            throw new Error('Unexpected reply from Redis: expected a flat array of four integers');
        }

        const allowedFlag = Number(reply[0]);
        const remaining = Number(reply[1]);
        const firstExpireAtMs = Number(reply[2]);
        const windowExpireAtMs = Number(reply[3]);

        return {
            allowed: allowedFlag !== 0,
            remaining,
            firstExpireAtMs,
            windowExpireAtMs,
        };
    }

    private async _execScript(key: string): Promise<RateLimiterResponse> {
        if (!this._scriptSha1) {
            this._scriptSha1 = await this._loadScript();
        }

        // Redis command arguments are always passed as strings.
        const args = [
            this._scriptSha1,
            '1', // number of keys
            `${key}`,
            `${this._window}`,
            `${this._windowExpireMs}`,
            `${this._limit}`,
            `${this._limitOverhead}`,
        ];

        let reply: unknown;

        try {
            reply = await this._sendCommand('EVALSHA', ...args);
        }
        catch (err: unknown) {
            // Script expired in Redis cache, reload and try again
            if (this._isNoScriptError(err)) {
                this._scriptSha1 = await this._loadScript();
                args[0] = this._scriptSha1;
                reply = await this._sendCommand('EVALSHA', ...args);
            }
            else {
                throw err;
            }
        }

        return this._parseReply(reply);
    }

    private _updateWindow(): void {
        this._window = WindowUnitToMilliseconds[this._windowUnit] * this._windowSize * 1000;
    }

    private _updateWindowExpiration(): void {
        this._windowExpireMs = WindowUnitToMilliseconds[this._windowUnit] * this._windowSize;
    }

    public get client() {
        return this._client;
    }

    public set client(v: RedisClientWrapper | undefined) {
        this._client = v;

        if (v) {
            this._sendCommand = this._resolveSendCommand(v);
        }
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

    // Sliding window length in microseconds
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
            window: this.window,
            windowExpireMs: this.windowExpireMs,
            limit: this.limit,
        }, null, 4);
    }

    public get = async (key: string): Promise<RateLimiterResponse> => {
        return this._execScript(key);
    }
}
