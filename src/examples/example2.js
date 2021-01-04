const express = require('express');
const Redis = require('ioredis');
const { RateLimiter, Unit, createExpressMiddleware } = require('../../build/index');

(async () => {
    const app = express();

    const client = new Redis({
        host: 'localhost',
        port: 6379
    });

    const middleware = createExpressMiddleware({
        // Define limiters that will be evaluated from this middleware for each request
        limiters: [
            {
                limiter: new RateLimiter({
                    client: client,
                    windowUnit: Unit.SECOND,
                    windowSize: 1,
                    limit: 5,
                }),
                overrideKey: true,
                key: 'This key will be overridden',
                errorMessage: '[Peak] Too many requests',
            },
            {
                limiter: new RateLimiter({
                    client: client,
                    windowUnit: Unit.HOUR,
                    windowSize: 1,
                    limit: 10000,
                    windowSubdivisionUnit: Unit.MINUTE,
                }),
                errorMessage: '[Hourly] Too many requests',
            },
        ],

        // Compute Redis key from request and limiter objects
        overrideKeyFn: (req, limiter) => {
            return req.path + limiter.name;
        },

        // Error status code
        errorStatusCode: 429,

        // Enable/disable setting headers on response
        setHeaders: true,

        // Override default response headers
        headers: (req, limiter) => {
            return {
                remaining: `X-Rate-Limit-Remaining-${limiter.name}`,
                firstExpireAt: `X-Rate-Limit-First-Expire-${limiter.name}`,
                windowExpireAt: `X-Rate-Limit-Window-Expire-${limiter.name}`,
            };
        },
    });

    // Plug-in the middleware
    app.use(middleware);

    app.get('/', (req, res) => {
        return res.send('Yo!');
    });

    app.listen(8080, () => console.log('Server listening on port 8080...'));
})();
