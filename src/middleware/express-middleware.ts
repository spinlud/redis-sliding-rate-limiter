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
     * Compute Redis key from request object and limiter.
     * If keyOverride is enabled in the limiter, this will override any key defined for that limiter.
     * This takes priority over middleware option overrideKeyFn.
     * Must be defined if overrideKey is enabled and middleware option overrideKeyFn is undefined.
     */
    overrideKeyFn?: (req: Request, limiter: RateLimiter) => any;

    /**
     * Enable/disable limit override. Default is false.
     */
    overrideLimit?: boolean;

    /**
     * If enabled, this will override limiter limit value.
     * This takes priority over middleware option overrideLimitFn.
     * Must be defined if overrideLimit is enabled and middleware option overrideLimitFn is undefined.
     */
    overrideLimitFn?: (req: Request, limiter: RateLimiter) => number;

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
     * Must be defined if there is a limiter with overrideKey enabled and overrideKeyFn undefined.
     */
    overrideKeyFn?: (req: Request, limiter: RateLimiter) => any;

    /**
     * If enabled, this will override limiter limit value.
     * Must be defined if there is a limiter with overrideLimit enabled and overrideLimitFn undefined.
     */
    overrideLimitFn?: (req: Request, limiter: RateLimiter) => number;

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

const normalizeOptions = (options: ExpressMiddlewareOptions): ExpressMiddlewareOptions => {
    for (const e of options.limiters) {
        if (!e.hasOwnProperty('overrideKey')) {
            e.overrideKey = false;
        }

        if (!e.hasOwnProperty('overrideLimit')) {
            e.overrideLimit = false;
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

const validateOptions = (options: ExpressMiddlewareOptions) => {
    if (options.limiters.some(e => !e.key && !e.overrideKey)) {
        throw new Error(`Limiter requires a key or overrideKey enabled`);
    }

    if (options.limiters.some(e => e.overrideKey && !e.overrideKeyFn && !options.overrideKeyFn)) {
        throw new Error('Limiter with overrideKey enabled requires at least one of limiter-specific or middleware-specific overrideKeyFn function to be defined');
    }

    if (options.limiters.some(e => e.overrideLimit && !e.overrideLimitFn && !options.overrideLimitFn)) {
        throw new Error('Limiter with overrideLimit enabled requires at least one of limiter-specific or middleware-specific overrideLimitFn function to be defined');
    }
}

export const createExpressMiddleware = (options: ExpressMiddlewareOptions) => {
    // Normalize options
    options = normalizeOptions(options);

    // Validate options
    validateOptions(options);

    return async (req: Request, res: Response, next: NextFunction) => {
        for (const { limiter, key, overrideKey, overrideKeyFn, overrideLimit, overrideLimitFn, errorMessage } of options.limiters) {
            // Get Redis key
            let redisKey: any;

            if (overrideKey) {
                redisKey = overrideKeyFn ? overrideKeyFn(req, limiter) : options.overrideKeyFn!(req, limiter);
            }
            else {
                redisKey = key;
            }

            // Override limit if enabled
            if (overrideLimit) {
                limiter.limit = overrideLimitFn ? overrideLimitFn(req, limiter) : options.overrideLimitFn!(req, limiter);
            }

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