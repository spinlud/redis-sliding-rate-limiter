# redis-sliding-rate-limiter
> Flexible and performant sliding-window rate limiter for Node.js, backed by Redis and
> exact to the microsecond. Works with both popular Redis clients:
> [node-redis](https://www.npmjs.com/package/redis) and [ioredis](https://www.npmjs.com/package/ioredis).

![node-redis](https://img.shields.io/badge/node--redis-5%20%7C%206-D82C20)
![ioredis](https://img.shields.io/badge/ioredis-5%20%7C%206-D82C20)

## Table of Contents

* [Why another rate limiter?](#why-another-rate-limiter)
* [Installation](#installation)
* [Compatibility](#compatibility)
* [Usage](#usage)
* [Client input: `client` vs `sendCommand`](#client-input-client-vs-sendcommand)
* [How the sliding window works](#how-the-sliding-window-works)
* [Response fields](#response-fields)
* [Express middleware](#express-middleware)
* [Running the tests](#running-the-tests)
* [Migration](#migration)
* [License](#license)

## Why another rate limiter?
Naive rate limiter algorithms suffer from a well known problem where a burst of requests at the window boundary
can let through more requests than intended for a particular key. For example, with a limit of 100 requests per
minute, a client could send 100 requests in the last second of the first minute and another 100 requests in the
first second of the second minute, resulting in 200 accepted requests in 2 seconds. This library implements an
exact sliding window on top of Redis that eliminates that boundary burst.

The main features are:

* **Exact sliding window at microsecond precision.** The window slides continuously; there is no subdivision
  unit and no bucketing, so a request counts against exactly the trailing window that precedes it.
* **Redis server clock as the single source of truth.** All timing is derived from the Redis server clock, so
  application clocks and network latency never affect the count.
* **Per-request expiration timestamps.** Every response carries `firstExpireAtMs` (when the oldest member in the
  window expires) and `windowExpireAtMs` (when the window becomes empty), so a client knows precisely when a free
  slot opens up.
* **Express middleware** with customizable status code, messages and response headers.
* Works with both **node-redis** and **ioredis** (majors 5 and 6), via a duck-typed `client` or an explicit
  `sendCommand` callback.
* Ships **dual CJS and ESM** builds with an `exports` map and bundled type declarations.
* **Zero runtime dependencies.**

## Installation
```shell
npm install --save redis-sliding-rate-limiter
```
`redis` and `ioredis` are peer libraries: install whichever client you use yourself. The limiter has no runtime
dependencies of its own.

## Compatibility

| Component      | Supported                     |
| -------------- | ----------------------------- |
| Node.js        | `>=20` (CI tests 22 and 24)   |
| node-redis     | `5`, `6`                      |
| ioredis        | `5`, `6`                      |
| Redis server   | `7` (tested)                  |
| Module formats | CommonJS + ESM                |

## Usage
The primary example uses node-redis, passing the client directly through the `client` option (the client is
duck-typed, so no adapter is required).

```js
const { createClient } = require('redis');
const { RateLimiter, Unit } = require('redis-sliding-rate-limiter');

(async () => {
  const client = createClient({
    url: 'redis://localhost:6379',
  });

  await client.connect();

  // 10 requests every 3 seconds, allowing 10% of the limit (1 request) to exceed it.
  const limiter = new RateLimiter({
    client: client,
    window: {
      unit: Unit.SECOND,
      size: 3,
    },
    limit: 10,
    // Fraction of the limit allowed to exceed it, rounded down (10 * 0.1 = 1 extra request).
    limitOverhead: 0.1,
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
    limiter.get(key), // 11 - allowed thanks to the overhead
    limiter.get(key), // 12 - denied
  ]);

  for (const res of results) {
    const { allowed, remaining, firstExpireAtMs, windowExpireAtMs } = res;
    console.log({ allowed, remaining, firstExpireAtMs, windowExpireAtMs });
  }

  // The first ten requests are allowed and `remaining` counts down to 0; the eleventh is still
  // allowed because of the overhead; the twelfth is denied. `firstExpireAtMs` and `windowExpireAtMs`
  // are epoch-millisecond timestamps derived from the Redis server clock.

  await client.quit();
})();
```

## Client input: `client` vs `sendCommand`
A limiter talks to Redis through exactly one of two mutually exclusive options. The constructor throws if both
are provided, and throws if neither is provided.

* **`client`** — a Redis client instance. The limiter detects the command interface: node-redis exposes
  `sendCommand(args)`, ioredis exposes `call(command, ...args)`.
* **`sendCommand`** — an explicit callback you wire yourself. This is useful for clients, pools or proxies that
  the duck-typing does not recognise:

```ts
type SendCommandFn = (...args: string[]) => Promise<unknown>;
```

Both forms below apply to majors 5 and 6 of each client.

### node-redis

```js
const { createClient } = require('redis');
const { RateLimiter, Unit } = require('redis-sliding-rate-limiter');

const client = createClient({ url: 'redis://localhost:6379' });
await client.connect();

// Passing the client directly.
const a = new RateLimiter({
  client: client,
  window: { unit: Unit.SECOND, size: 1 },
  limit: 5,
});

// The equivalent sendCommand callback.
const b = new RateLimiter({
  sendCommand: (...args) => client.sendCommand(args),
  window: { unit: Unit.SECOND, size: 1 },
  limit: 5,
});
```

### ioredis

```js
const Redis = require('ioredis');
const { RateLimiter, Unit } = require('redis-sliding-rate-limiter');

const client = new Redis({ host: 'localhost', port: 6379 });

// Passing the client directly.
const a = new RateLimiter({
  client: client,
  window: { unit: Unit.SECOND, size: 1 },
  limit: 5,
});

// The equivalent sendCommand callback.
const b = new RateLimiter({
  sendCommand: (...args) => client.call(args[0], ...args.slice(1)),
  window: { unit: Unit.SECOND, size: 1 },
  limit: 5,
});
```

## How the sliding window works
Each `key` maps to a Redis sorted set. Every request is stored as a distinct member scored by the current
microsecond timestamp read from the Redis server clock. On each call the limiter:

1. Evicts members whose score falls outside the trailing window, so the window slides continuously rather than
   being bucketed into fixed intervals.
2. Counts the members still inside the window; the count against `limit` (plus any overhead) decides `allowed`
   and `remaining`.
3. Adds a member and refreshes the key TTL (`PEXPIRE`) **only when the request is allowed**. A denied request
   neither adds a member nor refreshes the TTL.

## Response fields
`limiter.get(key)` resolves with a `RateLimiterResponse`:

| Field              | Type      | Meaning                                                                                                       |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------------ |
| `allowed`          | `boolean` | Whether this request is allowed.                                                                              |
| `remaining`        | `number`  | Requests still allowed after this one, clamped at 0. Computed against the base `limit` (overhead not counted).|
| `firstExpireAtMs`  | `number`  | Epoch milliseconds at which the oldest member in the window expires (`-1` when the window is empty).          |
| `windowExpireAtMs` | `number`  | Epoch milliseconds at which the whole window empties (`-1` when the window is empty).                         |

## Express middleware
The library exposes a middleware factory for [Express](https://www.npmjs.com/package/express). Each middleware
evaluates one or more limiters per request.

```js
const express = require('express');
const Redis = require('ioredis');
const { RateLimiter, Unit, createExpressMiddleware } = require('redis-sliding-rate-limiter');

(async () => {
  const app = express();

  const client = new Redis({
    host: 'localhost',
    port: 6379,
  });

  const middleware = createExpressMiddleware({
    // Limiters evaluated for each request, in order.
    limiters: [
      {
        limiter: new RateLimiter({
          client: client,
          window: {
            unit: Unit.SECOND,
            size: 1,
          },
          limit: 5,
        }),
        overrideKey: true,
        // Compute the Redis key from the request and limiter. Can also be defined at middleware level (below).
        overrideKeyFn: (req, limiter) => {
          return req.path + limiter.name;
        },
        key: 'This key will be overridden',
        errorMessage: '[Peak] Too many requests',
      },
      {
        limiter: new RateLimiter({
          client: client,
          window: {
            unit: Unit.HOUR,
            size: 1,
          },
          limit: 10000, // This will be overridden.
        }),
        overrideLimit: true,
        // Override the limiter limit. Can also be defined at middleware level (below).
        overrideLimitFn: (req, limiter) => {
          return parseInt(req.query.limit, 10); // Make sure this returns a positive integer.
        },
        // Optional per-limiter skip. Return true to skip evaluation of this limiter.
        skipFn: (req, limiter) => {
          return false;
        },
        errorMessage: '[Hourly] Too many requests',
      },
    ],

    // Middleware-level key override.
    // Fallback when a limiter has overrideKey enabled but provides no overrideKeyFn.
    overrideKeyFn: (req, limiter) => {
      return 'some key';
    },

    // Middleware-level limit override.
    // Fallback when a limiter has overrideLimit enabled but provides no overrideLimitFn.
    overrideLimitFn: (req, limiter) => {
      return 666;
    },

    // Status code returned when a request is throttled (default 429).
    errorStatusCode: 429,

    // Enable/disable setting rate-limit headers on the response (default true).
    setHeaders: true,

    // Custom function to set headers on the response. Called only when setHeaders is enabled;
    // when omitted, default X-Rate-Limit-* headers are set instead.
    setHeadersFn: (req, res, limiter, limiterResponse) => {
      const { remaining, firstExpireAtMs, windowExpireAtMs } = limiterResponse;
      res.set(`X-Rate-Limit-Remaining-${limiter.name}`, '' + remaining);
      res.set(`X-Rate-Limit-First-Expire-${limiter.name}`, '' + firstExpireAtMs);
      res.set(`X-Rate-Limit-Reset-${limiter.name}`, '' + windowExpireAtMs);
    },

    // Optional whitelist. Return true to skip rate limiting entirely for the request.
    skipFn: (req) => {
      return false;
    },

    // Called when a request is throttled (not allowed).
    onThrottleRequest: (req, res, key) => {
      return res.status(429).send(`Too many requests for key ${key}`);
    },
  });

  // Plug in the middleware.
  app.use(middleware);

  app.get('/', (req, res) => {
    return res.send('Yo!');
  });

  app.listen(8080, () => console.log('Server listening on port 8080...'));
})();
```

## Running the tests
```bash
# start a local Redis (ephemeral)
docker compose up -d redis
# install deps, build, run the suite against Redis on localhost:6379
npm install
npm run build
npm test
# tear down
docker compose down
```
Tests default to `REDIS_HOST=localhost` / `REDIS_PORT=6379` and exercise both node-redis and ioredis.

## Migration
Upgrading from v6? See [MIGRATION.md](./MIGRATION.md) for the full list of breaking changes and what to do.

## License
[MIT License](http://en.wikipedia.org/wiki/MIT_License)
