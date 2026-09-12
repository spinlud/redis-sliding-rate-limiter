# Supporting more than one Redis client library in `redis-sliding-rate-limiter`

Research date: 2026-09-12. Primary sources only (library READMEs, official docs, and source on GitHub/npm at current majors). Every external claim carries a URL; local claims cite `path:line`.

Companion note: the reply-decoding facts here are grounded in the sibling report [`resp3-client-apis.md`](./resp3-client-apis.md) (RESP2/RESP3 behaviour of node-redis 5/6 and ioredis 5/6 for this project's EVALSHA path).

Versions surveyed (npm `latest`, verified 2026-09-12): `rate-limit-redis` 6.0.1, `express-rate-limit` 8.7.0, `rate-limiter-flexible` 11.2.0, `connect-redis` 10.0.0, `@keyv/redis` 5.1.6, `bullmq` 6.3.4, `redis` (node-redis) 6.2.1, `ioredis` 6.0.0.

## Question

How do comparable libraries support more than one Redis client (node-redis vs ioredis, and beyond)? This library is a zero-runtime-dependency sliding-window limiter whose Lua script runs over a sorted set. Today it accepts a live Redis client instance and picks a strategy by duck-typing. Should we keep "explicit `clientType` option + hardened duck-type fallback", switch to a user-supplied `sendCommand` callback, move to adapter/driver classes, or do something else?

## What this library actually needs from a client (the deciding constraint)

The entire client surface this library touches is **two commands and one reply shape**:

- `SCRIPT LOAD <lua>` -> sha1 string.
- `EVALSHA <sha1> 1 <key> <args...>` -> a flat 4-element array of integers `[allowed, remaining, firstExpireAtMs, windowExpireAtMs]`, read positionally.
- On `NOSCRIPT`, reload the script and retry.

Evidence in-repo: `src/strategies/RedisStrategy.ts` and `src/strategies/IORedisStrategy.ts` differ only in *how they invoke the client* (`client.sendCommand([cmd, ...args])` vs `client.call(cmd, args)`) and in whether args are strings or numbers; both then do `res[0..3]`. The strategy is chosen in `src/RateLimiter.ts:139-144` by `typeof this._client.call === 'function'`, above a self-aware comment: `// TODO: This is very likely to be broken in the future, a better way should be found`. `redis`/`ioredis` are **devDependencies only** (`package.json`) — the library imports neither; the client type is a local structural interface `RedisClientWrapper { sendCommand?; call? }`.

This is the opposite of BullMQ's situation (below): we need **no** `multi()`/`pipeline()`, `duplicate()`, `defineCommand()`, blocking commands, keyspace events, or cluster slot access. The needed abstraction is tiny — "run one command, hand me back the array" — which is exactly the shape the callback pattern models.

Crucially for the reply dimension: a Lua script that returns a flat table of integers decodes to a **JS array of numbers on every client and protocol in scope** (RESP2 and RESP3, node-redis and ioredis). See `resp3-client-apis.md`: integers arrive as `number`, the Lua array as `Array`, and this script never calls `redis.setresp(3)` so booleans are not in play. The nested `[err, value]` tuple divergence between clients applies to `multi().exec()` **only** — which this library does not use — so it does not affect us.

---

## Pattern 1 — User-supplied command callback (`sendCommand`)

**Named example: `rate-limit-redis`** (the official store for `express-rate-limit`). The store never touches a client object; the user hands it a function.

Exact interface, from `source/types.ts` (https://github.com/express-rate-limit/rate-limit-redis/blob/main/source/types.ts):

```ts
type Data = boolean | number | string
export type RedisReply = Data | Data[]
export type SendCommandFn = (...args: string[]) => Promise<RedisReply>
// SingleOptions = CommonOptions & { readonly sendCommand: SendCommandFn }
```

Client-agnostic by construction: `rate-limit-redis` **has no `dependencies` block at all** (zero runtime deps) and imports neither `redis` nor `ioredis`; its only `peerDependency` is `express-rate-limit` (https://github.com/express-rate-limit/rate-limit-redis/blob/main/package.json). `express-rate-limit` core defines a `Store` interface and delegates all Redis specifics to stores like this one; its own deps are just `debug` + `ip-address` (https://github.com/express-rate-limit/express-rate-limit/blob/main/source/types.ts).

The user wires their own client in two lines (README, https://github.com/express-rate-limit/rate-limit-redis/blob/main/readme.md):

```ts
// node-redis: single array arg
sendCommand: (...args: string[]) => client.sendCommand(args)
// ioredis: variadic command + args
sendCommand: (command: string, ...args: string[]) => client.call(command, ...args) as Promise<RedisReply>
```

Reply differences are absorbed, not branched: `source/lib.ts` accepts `string | number | boolean` and coerces with `Number.parseInt`; it asserts the array shape and length but performs **no RESP2/RESP3 branch** (https://github.com/express-rate-limit/rate-limit-redis/blob/main/source/lib.ts). The docs do not mention RESP3 at all — because the callback boundary makes it the user's concern.

Underlying primitives this leans on:
- node-redis `sendCommand<T>(args: ReadonlyArray<RedisArgument>, options?): Promise<T>` where `RedisArgument = string | Buffer` — takes **one array**, and rejects non-string/Buffer args at the type level (https://github.com/redis/node-redis/blob/master/packages/client/lib/client/index.ts). RESP3 is opt-in via `createClient({ RESP: 3 })`.
- ioredis `call(command, ...args)` is the public arbitrary-command API (`sendCommand` is internal); args accept `string | Buffer | number` (https://github.com/redis/ioredis/blob/main/lib/Redis.ts). ioredis v6 defaults to RESP3 with `replyMapping: "legacy"`, preserving RESP2 reply shapes (README §RESP3).

Assessment for us:

| Dimension | Effect |
|---|---|
| Zero-dep guarantee | **Preserved perfectly** — the proven model; the library never imports or references any client. |
| Type-safety / DX | Clean: type the boundary as `(args: (string \| Buffer)[]) => Promise<unknown>` and narrow the reply with a guard. Lets us delete both strategy classes, the `RedisClientWrapper` union, the duck-type branch, and today's `any`/non-null-assertion code (`client.sendCommand!`, `client.call!`), which violate this repo's own standards. Cost: two-line wiring the user must write. |
| RESP3 / reply shape | **Off-loaded to the user's lambda + client config.** We only require the flat integer array, which is protocol-stable. Lowest ongoing maintenance. |
| Breaking change for v6 | **Breaking if done purely** (users pass `client:` today, not `sendCommand:`). Mitigation below makes it non-breaking. |

---

## Pattern 2 — Explicit driver / store / adapter selection

**`rate-limiter-flexible` (11.2.0).** One class per backend family, chosen by the user; you pass your already-created client as `storeClient`. There is a single `RateLimiterRedis` (no separate `RateLimiterIORedis`) that serves **both** node-redis and ioredis, plus distinct `RateLimiterValkey` / `RateLimiterValkeyGlide` classes (https://github.com/animir/node-rate-limiter-flexible/tree/master/lib, README). `redis`/`ioredis` are **devDependencies only** — bring-your-own-client, no forced import (package.json). Notably, choosing the class does **not** remove sniffing: internally `RateLimiterRedis` still duck-types (see Pattern 3). So "adapter classes" here is a *packaging* choice layered over runtime detection, not an alternative to it.

**`connect-redis`.** `new RedisStore({ client })`, zero runtime `dependencies` in all recent majors. But backend support **narrowed by version**: v7/v8 are client-agnostic (peerDep is only `express-session`, so any passed client works); v9/v10 (current `latest` = 10.0.0) are **node-redis-only** — peerDeps became `{ "redis": ">=5", "express-session": ">=1" }` and `index.ts` imports node-redis types and uses node-redis-specific APIs (`scanIterator`, structured `set` options, cluster `masters`) (https://github.com/tj/connect-redis/blob/master/index.ts, README, package.json). Lesson: naming a client as a peerDep is how they made the backend explicit — at the cost of dropping the other client.

**`keyv` + `@keyv/redis`.** Keyv takes an **adapter instance**, not a bare URI: `new Keyv(new KeyvRedis(uri|options|client))` (https://github.com/jaredwray/keyv/blob/main/core/keyv/README.md). `@keyv/redis` is "built on top of `@redis/client`" (node-redis) and hard-depends on it (`dependencies: @redis/client`), and does not support ioredis (https://github.com/jaredwray/keyv/blob/main/storage/redis/README.md, package.json). Adopting it **forces** node-redis.

**BullMQ (6.x).** Now exposes an `IRedisClient` adapter interface with named built-in adapters for ioredis, node-redis, Bun Redis, and Valkey Glide (https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/connections.md) — the fullest "explicit adapter" model, but justified by a large required command surface (see Pattern 4).

Assessment for us:

| Dimension | Effect |
|---|---|
| Zero-dep guarantee | Preservable (rate-limiter-flexible keeps clients as devDeps) — **but** connect-redis v9+ and @keyv/redis show the common drift toward pinning one client as a peerDep and importing its types. |
| Type-safety / DX | Good if we import each client's types — but that either couples us to those packages (against the no-forced-import goal) or re-declares them by hand. More classes/surface than a 2-command library warrants. |
| RESP3 / reply shape | Still owned by us inside each class; no better than duck-typing on this axis. |
| Breaking change for v6 | Medium: `new RateLimiter(...)` -> `new RateLimiterRedis(...)`/`new RateLimiterIORedis(...)` is a call-site rename for every user. |

---

## Pattern 3 — Runtime duck-type detection

**Named example: `rate-limiter-flexible`** sniffs the client rather than being told (`lib/RateLimiterRedis.js`, https://github.com/animir/node-rate-limiter-flexible/blob/master/lib/RateLimiterRedis.js):

- `this.useRedisPackage = opts.useRedisPackage || this.client.constructor.name === 'Commander' || false;` — detects ioredis by its internal base-class name `Commander`, with a manual `useRedisPackage` override.
- `typeof this.client.defineCommand === 'function'` to register Lua (ioredis-only method).
- `_isRedisReady()` branches on `client.status` (ioredis), `client.isReady` as function/boolean (node-redis v3 / v4+), and `client._slots.getClient` (node-redis v4 cluster); unknown clients fall through to "assume ready".

Robustness (grounded in that code): the constructor-name sniff breaks under **minification/mangling**, when the client is **wrapped or proxied** (e.g. BullMQ v6 wraps a raw ioredis instance in a proxy that is *not* named `Commander`), for **subclasses**, and if ioredis renames its base. Reliance on **private internals** (`_slots`) is brittle across versions. The library ships explicit `useRedisPackage` overrides precisely because the sniff is fragile. Our own detection (`typeof client.call === 'function'`) has the same class of failure and a narrower basis (a single method name).

Assessment for us:

| Dimension | Effect |
|---|---|
| Zero-dep guarantee | Preserved (pure structural checks). |
| Type-safety / DX | Weakest: `any`/optional-method unions and non-null assertions as today; misclassification is a silent runtime failure, not a type error. |
| RESP3 / reply shape | Owned by us; must be re-verified on each client major. |
| Breaking change for v6 | **Zero** — this is the status quo. Hardening (add explicit `clientType`, tighten the sniff) is fully back-compatible. |

---

## Pattern 4 — Single-client support (why some libraries pick one)

**BullMQ.** Historically ioredis-only; v6 added the `IRedisClient` adapter but ioredis stays the default and the only raw instance you can pass (https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/connections.md). The stated reasons are a **deep required feature set**: an adapter must expose `duplicate()` (blocking workers create duplicated connections), Lua registration via `defineCommand()`, `multi()`/`pipeline()`, connection lifecycle + events, and — ioredis-specific — `maxRetriesPerRequest: null` (BullMQ throws if a manually-created ioredis client for a Worker lacks it). BullMQ is coupled to client *behaviour*, so it standardized on one client and only later abstracted it.

The contrast is the whole argument: BullMQ needs a rich, behaviour-coupled client, so a single client (or a heavyweight adapter) is rational. We need two stateless commands and a positional array — the least client-coupled case there is — so the lightest possible boundary (a callback) fits best, and locking to one client would be a pure downgrade with no upside.

---

## Comparison matrix

| Approach | Real examples | Forces importing a client? | Type-safety / DX | RESP3 ownership | v6 breaking surface |
|---|---|---|---|---|---|
| **A. clientType option + hardened duck-type** | rate-limiter-flexible (`constructor.name`, `useRedisPackage` override) | No | Weak (unions, assertions, silent misclassification) | Ours, per client major | **None** (status quo) |
| **B. User-supplied `sendCommand` callback** | rate-limit-redis (zero-dep), express-rate-limit `Store` | **No** (proven) | Clean boundary; deletes strategies + sniff + `any` | **User's** (we need only the stable int array) | Breaking if pure; **none** if offered alongside `client` |
| **C. Adapter / driver classes** | rate-limiter-flexible classes, connect-redis, @keyv/redis, BullMQ `IRedisClient` | Tendency to yes (connect-redis v9+, @keyv/redis pin node-redis) | Good only if we import client types (coupling) | Ours | Medium (call-site rename) |
| **D. Single client** | BullMQ (ioredis default) | Yes | Simplest internally | Ours, one client | Large (drops a client) |

---

## Recommendation (ranked): **B**, delivered as a non-breaking hybrid with A

**Ranking: B > A > C > D.**

Adopt a user-supplied `sendCommand` callback as the **primary, documented** integration path, and keep accepting a live `client` instance (today's duck-typed behaviour, optionally hardened with an explicit `clientType`) as a **back-compat convenience** to be soft-deprecated. Concretely:

```ts
// primary path — client-agnostic, no sniffing, zero-dep:
new RateLimiter({ sendCommand: (...args) => client.sendCommand(args), window, limit })   // node-redis
new RateLimiter({ sendCommand: (cmd, ...args) => client.call(cmd, ...args), window, limit }) // ioredis
// legacy path — still accepted, still duck-typed internally:
new RateLimiter({ client, window, limit })
```

Internally this collapses `RedisStrategy` + `IORedisStrategy` + the `typeof client.call` branch into **one** command path that stringifies args (safe for both node-redis, which rejects non-strings, and ioredis) and reads the array positionally. The `client` path becomes a thin shim that manufactures the appropriate `sendCommand` lambda — so duck-typing survives only as an opt-in legacy adapter, not as the core mechanism.

- **Single strongest reason:** it is the only option that keeps the zero-runtime-dependency guarantee *and* removes fragile client-sniffing from the primary path, matching the proven zero-dep design of `rate-limit-redis`; because our client need is just "run one command, read a flat integer array," the callback fully covers it and pushes all RESP2/RESP3 and future-client (Valkey, valkey-glide, Bun) concerns to the user's two-line lambda, where they already belong.
- **Biggest risk of B:** the boundary shifts reply-shape and argument-stringification responsibility onto the user's lambda. A naive wiring can break subtly — e.g. node-redis `sendCommand` needs a single array of string/Buffer args (numbers rejected), ioredis `call` returns a broad type and, under a non-legacy RESP3 `replyMapping`, could reshape replies. Mitigation: keep the internal contract strict (we always pass **string** args and require back a flat array/integers), document the exact node-redis and ioredis wirings verbatim (as rate-limit-redis does), and validate the reply with a guard that throws a clear error on the wrong shape.

**Why not the others:**
- **A** (keep + harden) is the safe zero-breaking-change fallback and is worth retaining *as the legacy path*, but as the *primary* mechanism it entrenches a sniff that this repo's own `TODO` distrusts and that real libraries only keep behind manual overrides; it does not scale to Valkey/Bun without more special-casing.
- **C** (adapter classes) adds surface a two-command library doesn't need, and the field shows it drifts toward pinning/importing one client (connect-redis v9+, @keyv/redis) — eroding the zero-dep guarantee — while *still* duck-typing inside (rate-limiter-flexible). No net win over B here.
- **D** (single client) is right only for behaviour-coupled libraries like BullMQ; for us it would drop a currently-supported client for no benefit.

## Sources

- rate-limit-redis: types https://github.com/express-rate-limit/rate-limit-redis/blob/main/source/types.ts · lib https://github.com/express-rate-limit/rate-limit-redis/blob/main/source/lib.ts · readme https://github.com/express-rate-limit/rate-limit-redis/blob/main/readme.md · package.json https://github.com/express-rate-limit/rate-limit-redis/blob/main/package.json
- express-rate-limit `Store`: https://github.com/express-rate-limit/express-rate-limit/blob/main/source/types.ts
- rate-limiter-flexible: RateLimiterRedis.js https://github.com/animir/node-rate-limiter-flexible/blob/master/lib/RateLimiterRedis.js · lib/ https://github.com/animir/node-rate-limiter-flexible/tree/master/lib · README https://github.com/animir/node-rate-limiter-flexible/blob/master/README.md
- connect-redis: v10 readme https://github.com/tj/connect-redis/blob/master/readme.md · index.ts https://github.com/tj/connect-redis/blob/master/index.ts · v8 readme https://github.com/tj/connect-redis/blob/v8.0.0/readme.md
- keyv / @keyv/redis: https://github.com/jaredwray/keyv/blob/main/core/keyv/README.md · https://github.com/jaredwray/keyv/blob/main/storage/redis/README.md · https://github.com/jaredwray/keyv/blob/main/storage/redis/package.json
- bullmq: https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/connections.md
- node-redis: client https://github.com/redis/node-redis/blob/master/packages/client/lib/client/index.ts · RESP https://github.com/redis/node-redis/blob/master/docs/RESP.md · v4->v5 https://github.com/redis/node-redis/blob/master/docs/v4-to-v5.md · transactions https://github.com/redis/node-redis/blob/master/docs/transactions.md
- ioredis: Redis.ts https://github.com/redis/ioredis/blob/main/lib/Redis.ts · README https://github.com/redis/ioredis/blob/main/README.md · v5->v6 wiki https://github.com/redis/ioredis/wiki/Upgrading-from-v5-to-v6
- In-repo: `src/RateLimiter.ts:139-144` (duck-type), `src/strategies/RedisStrategy.ts`, `src/strategies/IORedisStrategy.ts`, sibling report `docs/research/resp3-client-apis.md`.
