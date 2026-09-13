# Migrating from v6 to v7

v7 makes the sliding window exact and continuous, adds an explicit `sendCommand` option, and modernizes the
build and runtime targets. This guide lists every breaking change and what you need to do. See the
[README](./README.md) for full details on each topic.

## Checklist

### `window.subdivisionUnit` removed
Delete `subdivisionUnit` from every `window` configuration. The window is now exact and continuous at microsecond
precision, and the constructor throws if the field is present.

Behavior difference: a `size: 1` limiter no longer resets at calendar boundaries. Previously the subdivision unit
bucketed the window; now the window slides continuously, so a request always counts against exactly the trailing
window that precedes it. See [How the sliding window works](./README.md#how-the-sliding-window-works).

```js
// v6
window: { unit: Unit.HOUR, size: 1, subdivisionUnit: Unit.MINUTE }

// v7
window: { unit: Unit.HOUR, size: 1 }
```

### Denied-request timestamps
`firstExpireAtMs` and `windowExpireAtMs` are now computed from the sorted-set contents. Values on denied requests
differ from v6: `windowExpireAtMs` is no longer simply `now + window` on denial — it is derived from the newest
member still in the window. The key TTL is also no longer refreshed on denied requests (only allowed requests add
a member and refresh the TTL). See [Response fields](./README.md#response-fields).

### `remaining`
`remaining` is now clamped at 0 (never negative) and means "requests still allowed after this one". It is computed
against the base `limit`; any `limitOverhead` is not counted, so a request may still be allowed while `remaining`
already reads 0.

### Client input
`client` is now optional and mutually exclusive with the new `sendCommand` callback: provide exactly one. The
constructor throws if both or neither are given. See
[Client input](./README.md#client-input-client-vs-sendcommand).

```js
// node-redis
sendCommand: (...args) => client.sendCommand(args)

// ioredis
sendCommand: (...args) => client.call(args[0], ...args.slice(1))
```

### Node `>=20`
Support for Node.js below 20 is dropped. CI tests Node 22 and 24.

### redis / ioredis majors
node-redis 6 and ioredis 6 are now supported. Majors 5 of both clients still work.

### Build and module format
Build output moved from `build/` to `dist/`. The package is now dual CommonJS + ESM with an `exports` map and
bundled type declarations. Deep imports into internal paths are no longer supported — import everything from the
package root:

```js
const { RateLimiter, Unit, createExpressMiddleware } = require('redis-sliding-rate-limiter');
```

Since 7.1 the framework adapters are also available from dedicated subpaths,
`redis-sliding-rate-limiter/express` and `redis-sliding-rate-limiter/fastify`. The root import remains supported.

### `window` getter
The `window` getter now returns the window length in **microseconds** (previously milliseconds). Read
`windowExpireMs` if you need the millisecond value used for the key TTL.
