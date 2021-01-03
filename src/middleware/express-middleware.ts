import { Request, Response, NextFunction } from 'express';
import { RateLimiter } from '..';

interface HeaderKeys {
    /**
     * Header key name for remaining requests in the current window.
     */
    remaining: string;

    /**
     * Header key name for first member expiration timestamp (ms) in the current window.
     */
    firstExpireAt: string;

    /**
     * Header key name for current window expiration timestamp (ms).
     */
    windowExpireAt: string
}

export interface MiddlewareLimiter {
    /**
     * Rate limiter.
     */
    limiter: RateLimiter;

    /**
     * A unique Redis key for this limiter. Can be overridden.
     */
    key?: any;

    /**
     * Enable/disable key override. Default is false.
     */
    overrideKey?: boolean;

    /**
     * Custom error message for this limiter. Default is 'Too many requests'.
     */
    errorMessage?: string | object;
}

interface ExpressMiddlewareOptions {
    /**
     * Limiters that will be evaluated from the middleware.
     */
    limiters: MiddlewareLimiter[];

    /**
     * Compute Redis key from request object and limiter.
     * If keyOverride is enabled in the limiter, this will override any key defined for that limiter.
     * Must be defined if any of the limiters key is unspecified.
     */
    overrideKeyFn?: (req: Request, limiter: RateLimiter) => any;

    /**
     * Status code to be returned if request is throttled (default is 429).
     */
    errorStatusCode?: number;

    /**
     * Enable/disable setting rate limit headers on response object. Default is true.
     */
    setHeaders?: boolean;

    /**
     * If setHeaders is enabled, these headers will be set on the response object.
     * Default will use the string 'X-Rate-Limit-[Remaining|First-Expire|Window-Expire]-' concatenated with the limiter name.
     */
    headers?: HeaderKeys | ((req: Request, limiter: RateLimiter) => HeaderKeys);
}

const normalize = (options: ExpressMiddlewareOptions): ExpressMiddlewareOptions => {
    for (const e of options.limiters) {
        if (!e.hasOwnProperty('overrideKey')) {
            e.overrideKey = false;
        }

        if (!e.hasOwnProperty('errorMessage') || !e.errorMessage) {
            e.errorMessage = 'Too many requests';
        }
    }

    if (!options.hasOwnProperty('errorStatusCode')) {
        options.errorStatusCode = 429;
    }

    if (!options.hasOwnProperty('setHeaders')) {
        options.setHeaders = true;
    }

    return options;
}

export const createExpressMiddleware = (options: ExpressMiddlewareOptions) => {
    // Normalize options
    options = normalize(options);

    // Validation
    if (options.limiters.some(e => (!e.hasOwnProperty('key') || !e.key || e.overrideKey) && !options.overrideKeyFn)) {
        throw new Error(`Property overrideKeyFn must be defined if a limiter has an unspecified key or overrideKey is enabled`);
    }

    return async (req: Request, res: Response, next: NextFunction) => {
        for (const { limiter, key, overrideKey, errorMessage } of options.limiters) {
            const redisKey = overrideKey ? options.overrideKeyFn!(req, limiter) : key;
            const { allowed, remaining, firstExpireAtMs, windowExpireAtMs } = await limiter.get(redisKey);

            // Set response headers if enabled
            if (options.setHeaders) {
                let headers: HeaderKeys;

                if (options.headers) {
                    headers = typeof options.headers === 'function' ? options.headers(req, limiter) : options.headers;
                }
                else {
                    const baseKey = 'X-Rate-Limit';

                    headers = {
                        remaining: `${baseKey}-Remaining-${limiter.name}`,
                        firstExpireAt: `${baseKey}-First-Expire-${limiter.name}`,
                        windowExpireAt: `${baseKey}-Window-Expire-${limiter.name}`,
                    };
                }

                res.set(headers.remaining, '' + remaining);
                res.set(headers.firstExpireAt, '' + firstExpireAtMs);
                res.set(headers.windowExpireAt, '' + windowExpireAtMs);
            }

            // Throttle request
            if (!allowed) {
                let message = '';

                if (errorMessage) {
                    if (typeof errorMessage === 'string') {
                        message = errorMessage;
                    }
                    else {
                        message = JSON.stringify(errorMessage);
                    }
                }

                return res.status(options.errorStatusCode!).send(message);
            }
        }

        // Allow request
        return next();
    };
}