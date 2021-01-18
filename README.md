# redis-sliding-rate-limiter
> Flexible and performant rate limiter, supporting a sliding window algorithm 
> with arbitrary precision. Compatible with two popular Redis clients: 
> [redis](https://www.npmjs.com/package/redis), [ioredis](https://www.npmjs.com/package/ioredis).  

## Table of Contents

<!-- toc -->
* [Why another rate limiter?](#why-another-rate-limiter)
* [Installation](#installation)
* [Usage](#usage)
* [Express middleware](#express-middleware)
* [License](#license)
<!-- toc stop -->

## Why another rate limiter?
Naive rate limiter algorithms suffer from a well known problem where a burst of requests at the window boundary will
cause the limiter allowing more requests than what is expected for a particular key. For example, with a limit
of 100 requests per minute, a client could send 100 requests in the last second of the first minute and another 100 
requests in the first second of the second minute, resulting in 200 accepted requests in 2 seconds.
This library supports a flexible sliding window algorithm based on Redis backend which solves this problem efficiently.
The main features are the following:

* Limiter window can be defined with arbitrary size and precision, from years down to milliseconds 
  (e.g. a window of 3 seconds with decisecond precision or a window of 5 minutes with second precision).
* Fast (average of 0.08 ms).
* Each request is added to the current window with microsecond precision, avoiding losing count of concurrent requests
  for a particular key.
* Redis server clock is used as the single source of truth for any time calculation.  
* For each request, expiration timestamps of the current window and the first element in that window are
  returned to the client. This means that the client can know precisely when a free slot will be available or when 
  the window will be empty.
* [Express](https://www.npmjs.com/package/express) compatible middleware with customizable status code, messages 
  and response headers.
* Compatible with two popular Redis clients: [redis](https://www.npmjs.com/package/redis), [ioredis](https://www.npmjs.com/package/ioredis).


## Installation
Install package:
```shell
npm install --save redis-sliding-rate-limiter
```


## Usage
```js
const redis = require('redis');
const { RateLimiter, Unit } = require('redis-sliding-rate-limiter');

(async () => {
  const client = redis.createClient({
    host: 'localhost',
    port: 6379
  });

  // 10 requests every 3 seconds, with decisecond precision. Allow 10% of requests to exceed the limit.
  const limiter = new RateLimiter({
    client: client,
    windowUnit: Unit.SECOND,
    windowSize: 3,
    windowSubdivisionUnit: Unit.DECISECOND, // Defines with which precision elements would expire in the current window
    limit: 10,
    limitOverheadFraction: 0.1, // Fraction of requests that can exceed the limit, rounded down (10 * 0.1 = 1 in this example)
  });

  const key = 'OneRing';

  const results = await Promise.all([
    limiter.get(key), // 1
    limiter.get(key), // 2
    limiter.get(key), // 3
    limiter.get(key), // 4
    limiter.get(key), // 5
    limiter.get(key), // 6
    limiter.get(key), // 7
    limiter.get(key), // 8
    limiter.get(key), // 9
    limiter.get(key), // 10
    limiter.get(key), // 11 - Expect to succeed thanks to overhead
    limiter.get(key), // 12 - Expect to fail
  ]);

  for (const res of results) {
    const { allowed, remaining, firstExpireAtMs, windowExpireAtMs } = res;
    console.log(allowed, remaining, firstExpireAtMs, windowExpireAtMs);
  }

  // Output:
  //
  // true 9 1610466521278 1610466521278
  // true 8 1610466521278 1610466521278
  // true 7 1610466521278 1610466521279
  // true 6 1610466521278 1610466521279
  // true 5 1610466521278 1610466521279
  // true 4 1610466521278 1610466521279
  // true 3 1610466521278 1610466521279
  // true 2 1610466521278 1610466521279
  // true 1 1610466521278 1610466521279
  // true 0 1610466521278 1610466521279
  // true 0 1610466521278 1610466521279
  // false 0 1610466521278 1610466521279

  client.quit();
})();
```


## Express middleware
The library exposes a configurable middleware factory that you can use directly in your 
[Express](https://www.npmjs.com/package/express) application. <br>
See the following example:

```js
const express = require('express');
const Redis = require('ioredis');
const { RateLimiter, Unit, createExpressMiddleware } = require('redis-sliding-rate-limiter');

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
                // Compute Redis key from request and limiter objects. Can also be defined at middleware level (see below).
                overrideKeyFn: (req, limiter) => {
                  return req.path + limiter.name;
                },
                key: 'This key will be overridden',
                errorMessage: '[Peak] Too many requests',
            },
            {
                limiter: new RateLimiter({
                    client: client,
                    windowUnit: Unit.HOUR,
                    windowSize: 1,
                    limit: 10000, // This will be overridden
                    windowSubdivisionUnit: Unit.MINUTE,
                }),
                overrideLimit: true,
                // Override limit if enabled. Can also be defined at middleware level (see below).
                overrideLimitFn: (req, limiter) => {
                  return parseInt(req.query.limit); // Make sure this function returns a positive integer...    
                },
                // Optional function to skip request evaluation for a specific limiter. Should return true if the evaluation must be skipped, false otherwise.
                skipFn: (req, limiter) => {
                    return false;    
                },
                errorMessage: '[Hourly] Too many requests',
            },
        ],

        // Middleware level key override. 
        // Fallback in case a limiter does not provide a overrideKeyFn function and has overrideKey enabled.
        overrideKeyFn: (req, limiter) => {
            return 'some key';
        },
      
        // Middleware level limit override.
        // Fallback in case a limiter does not provide a overrideLimitFn function and has overrideLimit enabled.
        overrideLimitFn: (req, limiter) => {
            return 666;    
        },

        // Error status code
        errorStatusCode: 429,

        // Enable/disable setting headers on response
        setHeaders: true,

        // Custom function to set headers on response object (otherwise default headers will be used)
        setHeadersFn: (req, res, limiter, limiterResponse) => {
            const {remaining, firstExpireAtMs, windowExpireAtMs} = limiterResponse;
            res.set(remainingH, '' + remaining);
            res.set(firstExpireH, '' + firstExpireAtMs);
            res.set(resetH, '' + windowExpireAtMs);
        },

        // Skip (whitelist) requests. Should return true if the request must be skipped, false otherwise
        skip: (req) => {
            return req.pleaseSkipMe;      
        },

        // Function called when a request is throttled (not allowed)
        onThrottleRequest: (req, res, limiter) => {
            return res.status(429).send('Too many requests my lord');
        }
    });

    // Plug-in the middleware
    app.use(middleware);

    app.get('/', (req, res) => {
        return res.send('Yo!');
    });

    app.listen(8080, () => console.log('Server listening on port 8080...'));
})();
```


## License
[MIT License](http://en.wikipedia.org/wiki/MIT_License)
