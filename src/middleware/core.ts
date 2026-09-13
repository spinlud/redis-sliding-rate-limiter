import { RateLimiter, RateLimiterResponse } from '../RateLimiter';

/**
 * Default message returned in the body when a request is throttled.
 */
export const DEFAULT_ERROR_MESSAGE = 'Too many requests';

/**
 * Default HTTP status code returned when a request is throttled.
 */
export const DEFAULT_ERROR_STATUS_CODE = 429;

/**
 * Prefix shared by all default rate limit response headers.
 */
export const RATE_LIMIT_HEADER_PREFIX = 'X-Rate-Limit';

export interface RateLimitMiddlewareLimiter<Req> {
    /**
     * Rate limiter.
     */
    limiter: RateLimiter;

    /**
     * A unique Redis key for this limiter. Can be overridden.
     */
    key?: string;

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
    overrideKeyFn?: (req: Req, limiter: RateLimiter) => string;

    /**
     * Enable/disable limit override. Default is false.
     */
    overrideLimit?: boolean;

    /**
     * If enabled, this will override limiter limit value.
     * This takes priority over middleware option overrideLimitFn.
     * Must be defined if overrideLimit is enabled and middleware option overrideLimitFn is undefined.
     */
    overrideLimitFn?: (req: Req, limiter: RateLimiter) => number;

    /**
     * Custom error message for this limiter. Default is 'Too many requests'.
     */
    errorMessage?: string | object;

    /**
     * Optional function to skip request evaluation for the current limiter.
     * Should return true if evaluation must be skipped, false otherwise.
     */
    skipFn?: (req: Req, limiter: RateLimiter) => boolean;
}

export interface RateLimitMiddlewareOptions<Req, Res> {
    /**
     * Limiters that will be evaluated from the middleware.
     */
    limiters: RateLimitMiddlewareLimiter<Req>[];

    /**
     * Compute Redis key from request object and limiter.
     * If keyOverride is enabled in the limiter, this will override any key defined for that limiter.
     * Must be defined if there is a limiter with overrideKey enabled and overrideKeyFn undefined.
     */
    overrideKeyFn?: (req: Req, limiter: RateLimiter) => string;

    /**
     * If enabled, this will override limiter limit value.
     * Must be defined if there is a limiter with overrideLimit enabled and overrideLimitFn undefined.
     */
    overrideLimitFn?: (req: Req, limiter: RateLimiter) => number;

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
    setHeadersFn?: (req: Req, res: Res, limiter: RateLimiter, limiterResponse: RateLimiterResponse) => void;

    /**
     * Optional function for deciding to skip rate limiting for the request. Useful for white-listing requests.
     * Return true if the request should be skipped, false otherwise.
     */
    skipFn?: (req: Req) => boolean;

    /**
     * Optional function to be called when a request is throttled (not allowed).
     */
    onThrottleRequest?: (req: Req, res: Res, key: string) => unknown;
}

/**
 * Callback used by the core to set a single response header. Each adapter maps
 * this to its framework-specific header API.
 */
export type HeaderSink = (name: string, value: string) => void;

/**
 * Outcome of evaluating a request against all configured limiters. A throttled
 * result carries everything an adapter needs to build the throttle response.
 */
export type EvaluationResult =
    | { outcome: 'allowed' }
    | { outcome: 'throttled'; key: string; limiter: RateLimiter; errorMessage: string };

export const normalizeOptions = <Req, Res>(options: RateLimitMiddlewareOptions<Req, Res>): RateLimitMiddlewareOptions<Req, Res> => {
    for (const e of options.limiters) {
        if (!e.hasOwnProperty('overrideKey')) {
            e.overrideKey = false;
        }

        if (!e.hasOwnProperty('overrideLimit')) {
            e.overrideLimit = false;
        }

        if (!e.hasOwnProperty('errorMessage') || !e.errorMessage) {
            e.errorMessage = DEFAULT_ERROR_MESSAGE;
        }
    }

    if (!options.hasOwnProperty('errorStatusCode')) {
        options.errorStatusCode = DEFAULT_ERROR_STATUS_CODE;
    }

    if (!options.hasOwnProperty('setHeaders')) {
        options.setHeaders = true;
    }

    return options;
}

export const validateOptions = <Req, Res>(options: RateLimitMiddlewareOptions<Req, Res>): void => {
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

/**
 * Convert a limiter error message into the string sent in the response body.
 * Strings pass through, objects are JSON-stringified, undefined becomes an empty string.
 */
export const formatErrorMessage = (errorMessage?: string | object): string => {
    if (!errorMessage) {
        return '';
    }

    if (typeof errorMessage === 'string') {
        return errorMessage;
    }

    return JSON.stringify(errorMessage);
}

/**
 * Evaluate a request against every configured limiter, setting response headers
 * through the provided sink. Returns as soon as a limiter denies the request,
 * leaving headers already set by earlier limiters in place.
 */
export const evaluateRequest = async <Req, Res>(
    options: RateLimitMiddlewareOptions<Req, Res>,
    req: Req,
    res: Res,
    setHeader: HeaderSink,
): Promise<EvaluationResult> => {
    // Check if request should be skipped
    if (options.skipFn && options.skipFn(req)) {
        return { outcome: 'allowed' };
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
        let redisKey: string;

        if (overrideKey) {
            const resolvedOverrideKeyFn = overrideKeyFn ?? options.overrideKeyFn;

            if (!resolvedOverrideKeyFn) {
                throw new Error('Limiter with overrideKey enabled requires at least one of limiter-specific or middleware-specific overrideKeyFn function to be defined');
            }

            redisKey = resolvedOverrideKeyFn(req, limiter);
        }
        else {
            if (key === undefined) {
                throw new Error(`Limiter requires a key or overrideKey enabled`);
            }

            redisKey = key;
        }

        // Override limit if enabled
        if (overrideLimit) {
            const resolvedOverrideLimitFn = overrideLimitFn ?? options.overrideLimitFn;

            if (!resolvedOverrideLimitFn) {
                throw new Error('Limiter with overrideLimit enabled requires at least one of limiter-specific or middleware-specific overrideLimitFn function to be defined');
            }

            limiter.limit = resolvedOverrideLimitFn(req, limiter);
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
                setHeader(`${RATE_LIMIT_HEADER_PREFIX}-Remaining-${limiter.name}`, '' + remaining);
                setHeader(`${RATE_LIMIT_HEADER_PREFIX}-First-Expire-${limiter.name}`, '' + firstExpireAtMs);
                setHeader(`${RATE_LIMIT_HEADER_PREFIX}-Reset-${limiter.name}`, '' + windowExpireAtMs);
            }
        }

        // Throttle request
        if (!allowed) {
            return {
                outcome: 'throttled',
                key: redisKey,
                limiter,
                errorMessage: formatErrorMessage(errorMessage),
            };
        }
    }

    // Allow request
    return { outcome: 'allowed' };
}
