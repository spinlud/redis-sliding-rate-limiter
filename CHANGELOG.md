## 7.0.1

### Internal

* Removed `any` types and non-null assertions from the express middleware (`src/middleware/express-middleware.ts`);
  types-only cleanup, no runtime or API changes.

## 7.0.0

### Breaking changes

* Removed `window.subdivisionUnit`. The sliding window is now exact and continuous at microsecond precision; the
  constructor throws if the field is present. A `size: 1` limiter no longer resets on calendar boundaries.
* Unified the duration table so every unit resolves from a single source of truth (a `MONTH` is 30 days and a
  `YEAR` is 365 days), fixing the previous incorrect `YEAR` duration.
* `remaining` is now clamped at 0 and means "requests still allowed after this one" (computed against the base
  `limit`, overhead excluded).
* `firstExpireAtMs` and `windowExpireAtMs` are now computed from the sorted-set contents. On a denied request the
  values differ from v6: `windowExpireAtMs` is no longer simply `now + window` and is instead derived from the
  newest member still in the window.
* The key TTL (`PEXPIRE`) is refreshed only when a member is added, i.e. only on allowed requests.
* `client` is now optional and mutually exclusive with the new `sendCommand` option; the constructor throws if
  both or neither are provided.
* `engines.node` is now `>=20`; support for older Node.js versions is dropped.
* Build output moved from `build/` to `dist/`. The package is dual CJS + ESM with an `exports` map, so deep
  imports into internals are no longer supported — import from the package root.

### Features

* New `sendCommand` callback option (`(...args: string[]) => Promise<unknown>`) for wiring Redis clients, pools
  or proxies that the built-in `client` duck-typing does not recognise.
* Support for node-redis 6 and ioredis 6 (majors 5 still work).

### Internal

* Collapsed the per-client strategy classes into a single execution path.
* Hot-path optimization that skips a redundant score read on the allowed request path.

Closes community issue #3.

## 6.0.0

* Support for the redis 6 and ioredis 6 client families.
* Toolchain and dev-dependency modernization.

## 5.0.0

* Fix `redis@4` `sendCommand` arguments type (required string or Buffer).
* Added minimum `Node.js` version in `package.json`.
* Added changelog.
* Run tests serially (`jest --runInBand`) to minimize timing issues.

## 4.0.0

* Changed `RateLimiterOptions` interface.
* Support for `redis@4` and `ioredis@5`.

## 3.0.0

NA

## 2.0.0

NA

## 1.0.0

NA