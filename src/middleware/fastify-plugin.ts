import { FastifyPluginAsync, FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import {
    DEFAULT_ERROR_STATUS_CODE,
    RateLimitMiddlewareLimiter,
    RateLimitMiddlewareOptions,
    evaluateRequest,
    normalizeOptions,
    validateOptions,
} from './core';

declare module 'fastify' {
    interface FastifyContextConfig {
        /**
         * Set to false to skip rate limiting for the route. Default is true.
         */
        rateLimit?: boolean;
    }
}

export type FastifyRateLimitHookName = 'onRequest' | 'preHandler';

export type FastifyMiddlewareLimiter = RateLimitMiddlewareLimiter<FastifyRequest>;

export type FastifyHookOptions = RateLimitMiddlewareOptions<FastifyRequest, FastifyReply>;

export interface FastifyRateLimitPluginOptions extends FastifyHookOptions {
    /**
     * Lifecycle hook the plugin attaches the rate limiter to. Default is 'onRequest'.
     */
    hook?: FastifyRateLimitHookName;
}

// onRequestAsyncHookHandler and preHandlerAsyncHookHandler share the same call signature.
export type FastifyRateLimitHook = onRequestAsyncHookHandler;

const DEFAULT_PLUGIN_HOOK: FastifyRateLimitHookName = 'onRequest';
const PLUGIN_NAME = 'redis-sliding-rate-limiter';
const SUPPORTED_FASTIFY_VERSION_RANGE = '5.x';
const SKIP_OVERRIDE_SYMBOL = Symbol.for('skip-override');
const PLUGIN_META_SYMBOL = Symbol.for('plugin-meta');

/**
 * Build an async hook that evaluates the configured limiters. Usable with
 * addHook or as a route-level onRequest/preHandler handler. Options are
 * normalized and validated once, when the hook is created.
 */
export const createFastifyHook = (options: FastifyHookOptions): FastifyRateLimitHook => {
    // Normalize options
    options = normalizeOptions(options);

    // Validate options
    validateOptions(options);

    return async (request, reply) => {
        // Route-level opt-out via config: { rateLimit: false }
        if (request.routeOptions.config.rateLimit === false) {
            return;
        }

        const result = await evaluateRequest(options, request, reply, (name, value) => {
            reply.header(name, value);
        });

        if (result.outcome === 'throttled') {
            if (options.onThrottleRequest) {
                await options.onThrottleRequest(request, reply, result.key);
                return reply;
            }

            reply.code(options.errorStatusCode ?? DEFAULT_ERROR_STATUS_CODE).send(result.errorMessage);
            return reply;
        }

        // Allow request
        return undefined;
    };
}

/**
 * Build a Fastify plugin that registers the rate limiter on the calling scope.
 * The plugin attaches the hook chosen through the hook option and opts out of
 * Fastify's default encapsulation via Symbol.for('skip-override').
 */
export const createFastifyPlugin = (options: FastifyRateLimitPluginOptions): FastifyPluginAsync => {
    const { hook = DEFAULT_PLUGIN_HOOK, ...hookOptions } = options;
    const rateLimitHook = createFastifyHook(hookOptions);

    const plugin: FastifyPluginAsync = async (instance) => {
        // The addHook overloads reject a union literal, so branch explicitly.
        if (hook === 'onRequest') {
            instance.addHook('onRequest', rateLimitHook);
        }
        else {
            instance.addHook('preHandler', rateLimitHook);
        }
    };

    // plugin-meta is verified against fastify source rather than documented; skip-override is documented.
    return Object.assign(plugin, {
        [SKIP_OVERRIDE_SYMBOL]: true,
        [PLUGIN_META_SYMBOL]: { name: PLUGIN_NAME, fastify: SUPPORTED_FASTIFY_VERSION_RANGE },
    });
}
