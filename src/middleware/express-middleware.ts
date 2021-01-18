import { Request, Response, NextFunction } from 'express';
import {RateLimiter, RateLimiterResponse} from '..';

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

    /**
     * Optional function to skip request evaluation for the current limiter.
     * Should return true if evaluation must be skipped, false otherwise.
     */
    skipFn?: (req: Request, limiter: RateLimiter) => boolean;
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
     * Optional function to set headers on response object. If not provided, default headers will be set on the response.
     * Called only if setHeaders is enabled.
     */
    setHeadersFn?: (req: Request, res: Response, limiter: RateLimiter, limiterResponse: RateLimiterResponse) => void;

    /**
     * Optional function for deciding to skip rate limiting for the request. Useful for white-listing requests.
     * Return true if the request should be skipped, false otherwise.
     */
    skipFn?: (req: Request) => boolean;

    /**
     * Optional function to be called when a request is throttled (not allowed).
     */
    onThrottleRequest?: (req: Request, res: Response, key: any) => void;
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
        // Check if request should be skipped
        if (options.skipFn && options.skipFn!(req)) {
            return next();
        }

        for (const middlewareLimiter of options.limiters) {
            const {
                limiter,
                key,
                overrideKey,
                overrideKeyFn,
                overrideLimit,
                overrideLimitFn,
                errorMessage,
                skipFn,
            } = middlewareLimiter;

            // Check if evaluation should be skipped for the current limiter
            if (skipFn && skipFn(req, limiter)) {
                continue;
            }

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

            const limiterResponse = await limiter.get(redisKey);
            const { allowed, remaining, firstExpireAtMs, windowExpireAtMs } = limiterResponse;

            // Set response headers if enabled
            if (options.setHeaders) {
                // If provided, use custom function
                if (options.setHeadersFn) {
                    options.setHeadersFn(req, res, limiter, limiterResponse);
                }
                // Otherwise set default headers
                else {
                    const baseKey = 'X-Rate-Limit';
                    res.set(`${baseKey}-Remaining-${limiter.name}`, '' + remaining);
                    res.set(`${baseKey}-First-Expire-${limiter.name}`, '' + firstExpireAtMs);
                    res.set(`${baseKey}-Reset-${limiter.name}`, '' + windowExpireAtMs);
                }
            }

            // Throttle request
            if (!allowed) {
                if (options.onThrottleRequest) {
                    return options.onThrottleRequest(req, res, redisKey);
                }
                else {
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
        }

        // Allow request
        return next();
    };
}
