import { Request, Response, NextFunction } from 'express';
import {
    DEFAULT_ERROR_STATUS_CODE,
    RateLimitMiddlewareLimiter,
    RateLimitMiddlewareOptions,
    evaluateRequest,
    normalizeOptions,
    validateOptions,
} from './core';

export type MiddlewareLimiter = RateLimitMiddlewareLimiter<Request>;

export type ExpressMiddlewareOptions = RateLimitMiddlewareOptions<Request, Response>;

export const createExpressMiddleware = (options: ExpressMiddlewareOptions) => {
    // Normalize options
    options = normalizeOptions(options);

    // Validate options
    validateOptions(options);

    return async (req: Request, res: Response, next: NextFunction) => {
        const result = await evaluateRequest(options, req, res, (name, value) => {
            res.set(name, value);
        });

        if (result.outcome === 'throttled') {
            if (options.onThrottleRequest) {
                return options.onThrottleRequest(req, res, result.key);
            }

            return res.status(options.errorStatusCode ?? DEFAULT_ERROR_STATUS_CODE).send(result.errorMessage);
        }

        // Allow request
        return next();
    };
}
