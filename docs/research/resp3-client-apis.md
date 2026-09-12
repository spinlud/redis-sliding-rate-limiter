# RESP2/RESP3 behaviour of node-redis 5.x/6.x and ioredis 5.x/6.x for an EVALSHA-based Lua rate limiter

Research date: 2026-09-12. Primary sources only (redis.io docs, redis/redis, redis/node-redis and redis/ioredis source at pinned commits, npm registry). Source-code claims cite `file:line @ commit`, where the commit is the npm `gitHead` of the published version.

Pinned commits used:

| Package / version | npm `gitHead` |
|---|---|
| `redis@5.12.1` (last 5.x) | `6a447261fc77c4577aa5127fb269f8b69cfe6732` |
| `redis@6.0.0` | `56f9a49364397535bd1cae202e478be1bf1ab09d` |
| `redis@6.2.1` (latest) | `9d522569db428322b10afeb7757c95bdb4d13a9b` |
| `ioredis@5.11.1` (last 5.x) | `fb224a7609b6d25959e06e31fdab2460d1f75691` |
| `ioredis@6.0.0` (latest) | `8ed2946504a36ae9b1e186b9dccc56afcd046d78` |

## Question

For `redis-sliding-rate-limiter`, which runs one Lua script via `EVALSHA` and reads `{allow_request (Lua boolean), remaining (integer, may be negative), first_expire_at (integer ms), window_expire_at (integer ms)}`: how do node-redis 5.x/6.x and ioredis 5.x/6.x (a) decode that array under RESP2 vs RESP3, (b) type `sendCommand`/`call` arguments, (c) surface `SCRIPT LOAD` and `NOSCRIPT`, (d) allow runtime client detection, and (e) default the protocol version?

## Summary

**Do the 6.x majors exist?** Yes, both.
- `redis` dist-tags on 2026-09-12: `latest: 6.2.1`, `beta: 6.2.0-beta.0`, `next: 5.0.0-next.7`, `maintenance-v4: 4.7.1`. 6.0.0 was published 2026-05-28; the 5.x line ends at 5.12.1 (`npm view redis dist-tags --json`, `npm view redis versions --json`; GitHub release https://github.com/redis/node-redis/releases/tag/redis%406.0.0).
- `ioredis` dist-tags: `latest: 6.0.0`, `beta: 6.0.0-beta.1`, `next: 5.0.4`, `release-v4: 4.31.0`. 6.0.0 was published 2026-07-31; the 5.x line ends at 5.11.1 (https://github.com/redis/ioredis/releases/tag/v6.0.0).

**(a) Reply decoding.** The Redis server decides the wire encoding of the script's return value; the client only maps wire types to JS.
- Server side (verified in `src/script_lua.c` `luaReplyToRedisReply` at tags 7.0.0, 7.2.0, 8.0.0, 8.2.0 and `unstable`; same logic in 6.2.0 `scripting.c`):
  - Lua number -> `addReplyLongLong` -> RESP integer `:` (decimal part truncated; negative values fine) under both RESP2 and RESP3.
  - Lua table (array) -> RESP array `*` under both protocols.
  - Lua boolean: **depends on whether the script called `redis.setresp(3)`**, not only on the client's protocol. If the script did not call it (script client `resp == 2`, the default), `true` -> `:1` and `false` -> null (`$-1` on a RESP2 connection, `_` on a RESP3 connection). Only if the script called `redis.setresp(3)` does the server use `addReplyBool`, which gives `:1`/`:0` to a RESP2 connection and `#t`/`#f` to a RESP3 connection. The redis.io "Lua to RESP3 type conversion" table says "Lua Boolean -> RESP3 Boolean reply" without this qualification; the source is the authority. This project's script (`src/lua/script.ts`) does not call `redis.setresp`, so **on every client and protocol in scope `allow_request` arrives as `1` (number) for true and `null` for false**, and `remaining`/`first_expire_at`/`window_expire_at` arrive as integers.
- node-redis 5.x and 6.x use one `Decoder` for RESP2 and RESP3: `:` -> JS `number` (or `string` if `typeMapping[RESP_TYPES.NUMBER] === String`), `#` -> JS `boolean` (not mappable), `_` and `$-1` -> `null`, `*` -> `Array`. No BigInt for `:`; BigInt only for RESP3 big-number `(`. `sendCommand` returns the raw decoded value (`Promise<ReplyUnion>` by default).
- ioredis 5.x is RESP2-only (`redis-parser` 3.0.0): `:` -> JS `number`, or `string` with `stringNumbers: true`; `$-1` -> `null`; `*` -> `Array`. `call()` returns the raw value.
- ioredis 6.x ships its own RESP2/RESP3 decoder (adapted from node-redis). Default `replyMapping: "legacy"` maps RESP3-only types back to RESP2 shapes: `#t/#f` -> `1/0` (numbers), maps -> flat arrays, doubles -> strings. `replyMapping: "resp3"` keeps `#t/#f` as JS booleans and maps as objects. `:` -> JS `number` (or `string` with `stringNumbers`) in both mappings. `_` -> `null`.

**(b) Argument typing.**
- node-redis 5.x and 6.x: `sendCommand<T = ReplyUnion>(args: ReadonlyArray<RedisArgument>, options?: CommandOptions): Promise<T>` with `type RedisArgument = string | Buffer`. Numbers are a TypeScript error; the parser pushes values verbatim (no stringification), so callers must stringify numbers themselves (node-redis's own commands do `val.toString()`).
- ioredis 5.x and 6.x: `call(command: string, ...args: (string | Buffer | number)[]): Promise<unknown>` (plus array/callback overloads); `RedisValue = string | Buffer | number`, `RedisKey = string | Buffer`. Numbers are converted with `String(arg)` (6.x additionally converts unsafe integers via `BigInt(arg).toString()`). `call` is a required (non-optional) method on the `RedisCommander` interface. Low-level `sendCommand(command: Command, stream?): unknown` takes a `Command` instance, not an array.

**(c) SCRIPT LOAD / NOSCRIPT.**
- `SCRIPT LOAD` returns a bulk string (sha1 hex) -> JS `string` in all four clients by default (node-redis: `transformReply: () => BlobStringReply`; ioredis: utf8 `replyEncoding`).
- Server error text: `-NOSCRIPT No matching script. Please use EVAL.\r\n` (`src/server.c:2241`, unstable). Clients strip only the leading `-`, so `err.message === 'NOSCRIPT No matching script. Please use EVAL.'`.
- node-redis: error class `SimpleError extends ErrorReply extends Error` (RESP3 blob errors: `BlobError extends ErrorReply`), exported from `redis`/`@redis/client`. Built-in fallback: `defineScript` + `scripts` option; `_executeScript` catches `err.message.startsWith('NOSCRIPT')` and re-sends as `EVAL`. Raw `sendCommand(['EVALSHA', ...])` gets no fallback.
- ioredis: error class `ReplyError` from `redis-errors` (`name === 'ReplyError'`), re-exported as `ReplyError` from `ioredis` (untyped `require`); ioredis attaches `err.command = { name, args }`. In 6.x the decoder creates `SimpleError`/`BlobError` subclasses of `ReplyError` whose `name` getter still returns `'ReplyError'`. Built-in fallback: `defineCommand()` -> `Script` sends `EVAL` first per socket, then `EVALSHA`, and on `NOSCRIPT` (`err.message.indexOf('NOSCRIPT') !== -1`) resends. Raw `call('EVALSHA', ...)` gets no fallback.

**(d) Runtime detection.**
- ioredis (5 and 6): default export and named export `Redis` are the same class -> `instanceof Redis` works; instances have `status: RedisStatus` (`"wait" | "connecting" | ... | "ready" | "end"`), `options: RedisOptions` (defaults merged in), `call`, `sendCommand(command: Command)`, `duplicate`. 6.x also exposes `options.protocol` (`2 | 3`, always populated after defaults) and `options.replyMapping`; the *negotiated* protocol (after a HELLO downgrade) lives in `redis.condition.protocol` (marked `@ignore`). In 5.x `options.protocol` is `undefined`.
- node-redis (5 and 6): created via `createClient()`; instances have `sendCommand`, `isOpen`, `isReady`, `options` getter (returns the options object as passed, so `options.RESP` is `undefined` when defaulted), `withTypeMapping`. The `RedisClient` class is publicly exported only from 6.x (`redis@6.0.0`, PR #3251); in 5.x only `createClient`, `RedisClientType`, `RedisClientOptions` are exported, so `instanceof` is not available there. Practical duck-typing: ioredis = `typeof c.call === 'function' && typeof c.status === 'string'`; node-redis = `typeof c.sendCommand === 'function' && typeof c.isOpen === 'boolean'` (ioredis has no `isOpen`; node-redis has no `call`/`status`).

**(e) Defaults.**
- node-redis 4: RESP2 only. node-redis 5: RESP2 by default, `RESP: 3` opt-in (`this.#options.RESP ?? 2`; HELLO sent only when `RESP` set). node-redis 6: RESP3 by default (`DEFAULT_RESP = 3`), `RESP: 2` to opt out; also Node >= 20, default `commandOptions.timeout` 5000 ms, `keepAliveInitialDelay` 30 s, `unstableResp3` option removed.
- ioredis 5: RESP2 only, no `protocol` option, no HELLO. ioredis 6: RESP3 by default (`protocol: 3`, sends `HELLO 3`, silently downgrades to RESP2 on Redis < 6 / `NOPROTO`), `protocol: 2` to opt out; `replyMapping: "legacy"` default keeps RESP2 reply shapes; Node >= 20.

## Per-client detail

### node-redis 5.x (`redis@5.12.1`, `@redis/client@5.12.1`, commit `6a44726`)

- Argument type: `export type RedisArgument = string | Buffer;` and `export type CommandArguments = Array<RedisArgument> & { preserve?: unknown };` -- `packages/client/lib/RESP/types.ts:231-233`. `RespVersions = 2 | 3` at `:365`; there is no `DEFAULT_RESP` constant in 5.x.
- `sendCommand` -- `packages/client/lib/client/index.ts:1169-1172`:
  ```ts
  sendCommand<T = ReplyUnion>(
    args: ReadonlyArray<RedisArgument>,
    options?: CommandOptions
  ): Promise<T>
  ```
  It rejects with `ClientClosedError` if the socket is not open and `ClientOfflineError` if not ready and `disableOfflineQueue` is set.
- Command parser pushes arguments verbatim: `push(...arg: Array<RedisArgument>) { this.#redisArgs.push(...arg); }` -- `packages/client/lib/client/parser.ts` (same in 6.2.1 at `:111-113`); numeric helpers call `.toString()` (`pushVariadicNumber`, `:134-142`). Runtime behaviour when a JS `number` is smuggled past the types was not verified; always pass strings.
- Protocol default: `this.#options.RESP ?? 2` (`client/index.ts:684`); `HELLO` is only sent `if (this.#options.RESP)` (`:747-777`). RESP3 requires explicit `createClient({ RESP: 3 })` (docs/v5.md "RESP3 Support").
- Decoder (`packages/client/lib/RESP/decoder.ts`, shared by RESP2 and RESP3): `RESP_TYPES.NUMBER` -> `#decodeNumber(typeMapping[NUMBER], chunk)`; `if (type === String) return this.#decodeSimpleString(String, chunk)` else parses to a JS `number`. `RESP_TYPES.BOOLEAN` -> `#decodeBoolean` -> JS boolean (`chunk[cursor] === 't'`), no mapping hook. `RESP_TYPES.NULL` -> `null`. Bulk string with `-1` length -> `null` (`#decodeBlobString`: "RESP 2 bulk string null", 6.2.1 `:473-478`; same code in 5.x). Big numbers `(` -> `BigInt` by default or `String`. Errors: `new SimpleError(string)` / `new BlobError(string)` where `string` is the error line without the leading `-`.
- Type mapping documented in `docs/RESP.md`: RESP2 Integer -> `number`; RESP3 Number -> `number | string`, Boolean -> `boolean`, Null -> `null`, Array -> `Array`, Big Number -> `BigInt | string`, Double -> `number | string`, Map -> `object | Map | Array`. Configure via `client.withTypeMapping({...})` or `createClient({ commandOptions: { typeMapping } })` (`docs/command-options.md`, `client/index.ts:1058`).
- Errors: `export class ErrorReply extends Error {}`, `SimpleError extends ErrorReply`, `BlobError extends ErrorReply` -- `packages/client/lib/errors.ts`; all re-exported (`export * from './lib/errors'` in `packages/client/index.ts`).
- Scripts: `defineScript(script)` adds `SHA1` (`packages/client/lib/lua-script.ts`). `_executeScript` (`client/index.ts:1155-1162`): sends `EVALSHA`, on `err.message.startsWith('NOSCRIPT')` rewrites `args[0] = 'EVAL'; args[1] = script.SCRIPT` and resends. `SCRIPT_LOAD.ts`: `parser.push('SCRIPT', 'LOAD', script)`, reply typed `BlobStringReply`.
- Exports (`packages/client/index.ts`): `createClient = RedisClient.create`, `RedisClientType`, `RedisClientOptions`, `RedisArgument`, `RespVersions`, `TypeMapping`, `RESP_TYPES`, `defineScript`, errors. **No `RedisClient` class export.** `packages/redis/index.ts` re-exports `@redis/client` and defaults the `RESP` generic to `2`.
- Instance surface: `get options()` returns `this._self.#options` (`client/index.ts:469`), `get isOpen()`, `get isReady()`.

### node-redis 6.x (`redis@6.0.0` commit `56f9a49`; `redis@6.2.1` commit `9d52256`)

- Release notes (https://github.com/redis/node-redis/releases/tag/redis%406.0.0): "RESP3 is the default protocol -- opt back into RESP2 explicitly", "Node.js 20 is the new minimum", "New default values for `keepAliveInitialDelay` (30s) and `commandTimeout` (5s)", "Expose `RedisClient`, `RedisCluster`, `RedisSentinel` and pool classes (#3251)".
- Migration guide `docs/v5-to-v6.md`: "In v5, Node-Redis defaulted to `RESP: 2` unless you explicitly configured `RESP: 3`. In v6, the default is now `RESP: 3`." `unstableResp3`/`unstableResp3Modules` removed. `commandOptions.timeout` default `5000` ms (v5: none) -- note this now applies to every `sendCommand` including `EVALSHA`. `maintNotifications` defaults to `"auto"` under RESP3. Object-like replies are plain objects instead of null-prototype. To preserve v5 behaviour: `createClient({ RESP: 2 })`.
- `export const DEFAULT_RESP = 3 as const satisfies RespVersions;` -- `packages/client/lib/RESP/types.ts:370` (6.0.0), exported from `packages/client/index.ts`. Client uses `options?.RESP ?? DEFAULT_RESP` (`client/index.ts:792, 844, 906` in 6.2.1) and always sends `HELLO <resp>`.
- `RedisArgument = string | Buffer` and `CommandArguments` unchanged (`types.ts:240-242` in 6.0.0). `sendCommand<T = ReplyUnion>(args: ReadonlyArray<RedisArgument>, options?: CommandOptions): Promise<T>` unchanged (`client/index.ts:1619-1622` in 6.2.1).
- Decoder, `ErrorReply`/`SimpleError`/`BlobError`, `defineScript`, `_executeScript` NOSCRIPT fallback (`client/index.ts:1607-1611` in 6.2.1), `SCRIPT_LOAD`, `EVALSHA`: functionally identical to 5.x (diffs are lint comments, JSDoc and a faster double parser).
- Exports (`packages/client/index.ts` @ 6.2.1): additionally `RedisClient`, `RedisClientPool`, `RedisCluster`, `RedisSentinel`, `RedisSentinelClient`, `AnyRedisClientOptions`, `DEFAULT_RESP` -> `instanceof RedisClient` is possible in 6.x. `packages/redis/index.ts` defaults the `RESP` generic to `3`.
- `get options()` still returns the raw options object (`client/index.ts:619`), so `options.RESP` is `undefined` when the caller relied on the default (which now means RESP3).

### ioredis 5.x (`ioredis@5.11.1`, commit `fb224a7`)

- Protocol: RESP2 only. `lib/DataHandler.ts:6,45-57` constructs `new RedisParser({ stringNumbers, returnBuffers: true, returnError, returnFatalError, returnReply })` from `redis-parser@3.0.0` (`package.json` dependencies). `redis-parser`'s `parseType` handles only bytes 36 `$`, 43 `+`, 42 `*`, 58 `:`, 45 `-` (`lib/parser.js:291-301` @ `7016554`). No `protocol`/`HELLO`/`resp3` occurrences in `lib/redis/RedisOptions.ts`, `lib/Redis.ts`, `lib/DataHandler.ts`, `lib/utils/Commander.ts`.
- Integers: JS `number`, or `string` when `stringNumbers: true` (`RedisOptions.stringNumbers`). Null bulk -> `null`. Arrays -> `Array`.
- Types (`lib/utils/RedisCommander.ts:9-10`): `export type RedisKey = string | Buffer; export type RedisValue = string | Buffer | number;`. `call` overloads (`:45-59`):
  ```ts
  call(command: string, callback?: Callback<unknown>): Result<unknown, Context>;
  call(command: string, args: (string | Buffer | number)[], callback?: Callback<unknown>): Result<unknown, Context>;
  call(...args: [command: string, ...args: (string | Buffer | number)[], callback: Callback<unknown>]): Result<unknown, Context>;
  call(...args: [command: string, ...args: (string | Buffer | number)[]]): Result<unknown, Context>;
  ```
  `Result<T, Context>` resolves to `Promise<T>` for a plain client. `call` is a required interface member (not optional). `evalsha(sha1: string | Buffer, numkeys: number | string, ...args: (string | Buffer | number)[])` also exists (`:1466-1474`).
- Number handling: `Command` converts non-string, non-Buffer args with `toArg(arg)` = `String(arg)` (`null`/`undefined` -> `""`) -- `lib/utils/index.ts:168-173`, `lib/Command.ts` argument loop.
- `sendCommand(command: Command, stream?: WriteableStream): unknown` -- `lib/Redis.ts:445`.
- Class: `class Redis extends Commander implements DataHandledable` with `options: RedisOptions` (`lib/Redis.ts:87`) and `status: RedisStatus = "wait"` (`:88`); `export default Redis` (`:1051`); `lib/index.ts` exports `default`, `Redis`, `Cluster`, `Command`, and `export const ReplyError = require("redis-errors").ReplyError` (`:78`, no typings).
- Errors: `redis-errors` `lib/modern.js`: `class RedisError extends Error`, `class ReplyError extends RedisError { constructor(message) { ...super(message) } get name() { return this.constructor.name } }`. `redis-parser` builds `new ReplyError(string)` from the error line (`lib/parser.js:173-179`). ioredis `DataHandler.returnError` sets `err.command = { name, args }` (`lib/DataHandler.ts:72-80`).
- Script fallback: `defineCommand(name, { lua, numberOfKeys, readOnly })` (`lib/utils/Commander.ts:63`) -> `lib/Script.ts`: per-socket `WeakSet` decides `EVAL` (first use) vs `EVALSHA`; on rejection containing `NOSCRIPT` the command is resent (`err.message.indexOf("NOSCRIPT")`).

### ioredis 6.x (`ioredis@6.0.0`, commit `8ed2946`, released 2026-07-31)

- CHANGELOG / release notes: "Add RESP3 (#2127)"; BREAKING: "ioredis now requires Node.js 20 or newer and uses RESP3 by default. Set `protocol: 2` to retain the v5 wire protocol." `engines.node >= 20.0.0`; `redis-parser` dropped from dependencies.
- Options (`lib/redis/RedisOptions.ts:152-170, 335-336`): `protocol?: ProtocolVersion` (`2 | 3`, `@default 3`); `replyMapping?: "legacy" | "resp3"` (`@default "legacy"`, only valid with `protocol: 3`, otherwise constructor throws `The "resp3" replyMapping is only supported with protocol 3` -- `lib/Redis.ts:968-971`). `stringNumbers` still supported. Defaults merged into `this.options` via `defaults(options, Redis.defaultOptions)` (`lib/Redis.ts:959`).
- Handshake (`lib/redis/event_handler.ts:24-41`): when `condition.protocol === 3` sends `HELLO 3 [AUTH user pass]`; if HELLO fails with `NOPROTO` or `unknown command ... HELLO` it logs "server rejected RESP3, downgrading connection to RESP2", sets `self.condition.protocol = 2; self.condition.replyMapping = "legacy"` and redoes the handshake (`:213-221`, `:292-300`). README "RESP3 Protocol" section documents this and warns replies fall back to legacy shapes.
- Decoder (`lib/resp/decoder.ts`, "Portions adapted from node-redis"): `#decodeBoolean(type, chunk)` returns `type === Number ? (boolean ? 1 : 0) : boolean` (`:237-244`); `#decodeNumber(type, chunk)` returns a string if `type === String`, else a JS `number` (`:246-256`). `lib/DataHandler.ts:404-439`: `legacyTypeMapping = { SIMPLE_STRING: Buffer, BLOB_STRING: Buffer, VERBATIM_STRING: Buffer, BIG_NUMBER: String, DOUBLE: Buffer, BOOLEAN: Number, MAP: Array, SET: Array }`; `resp3TypeMapping` leaves BOOLEAN/MAP/DOUBLE unmapped (JS boolean / plain object / number); `stringNumbers` overrides `NUMBER` and `DOUBLE` to `String`. Buffers are converted to utf8 strings per command by `replyEncoding` (`call` -> utf8, `callBuffer` -> Buffer).
- `call`, `RedisKey`, `RedisValue`, `evalsha` typings identical to 5.x (`lib/utils/RedisCommander.ts:9-10, 95-110, 1466-1474`). `lib/types.ts` adds `ProtocolVersion = 2 | 3`, `ReplyMappingMode`, `CommandParameter = string | Buffer | number | any[]`.
- `toArg` (`lib/utils/index.ts:204-216`): integers outside the safe range are serialised via `BigInt(arg).toString()` (fix #2136); otherwise `String(arg)`.
- `sendCommand(command: Command, stream?: WriteableStream): unknown` (`lib/Redis.ts:501`); `command.setReplyContext(this.condition ?? this.options)` (`:502`) attaches the negotiated protocol/mapping to each command.
- Errors (`lib/resp/errors.ts`): `import { ReplyError } from "redis-errors"; export class SimpleError extends ReplyError { get name() { return "ReplyError"; } } export class BlobError extends ReplyError { get name() { return "ReplyError"; } }`; `DataHandler.returnError` still attaches `err.command` (`lib/DataHandler.ts:111-120`). `lib/index.ts` still exports `ReplyError`, `Redis` (default and named), `Cluster`, and new types `RedisStatus`, `ClusterStatus`, `ScanStreamOptions`.
- `lib/Script.ts` (defineCommand fallback) unchanged from 5.x.
- Detection: `options.protocol` is always `2 | 3` after defaults; `condition.protocol` (declared `condition: Condition | null` with `@ignore`, `lib/Redis.ts:120`) reflects a HELLO downgrade; `status` unchanged.

### Redis server: Lua return-value conversion (authoritative for what the clients receive)

- Docs, https://redis.io/docs/latest/develop/programmability/lua-api/ "Data type conversion":
  - Lua -> RESP2: "Lua number -> RESP2 integer reply (the number is converted into an integer)"; "Lua table (indexed, non-associative array) -> RESP2 array reply (truncated at the first Lua `nil`)"; "Lua boolean false -> RESP2 null bulk reply"; "Lua Boolean `true` -> RESP2 integer reply with value of 1."
  - Lua -> RESP3: "Lua Boolean -> RESP3 Boolean reply (note that this is a change compared to the RESP2, in which returning a Boolean Lua `true` returned the number 1 to the Redis client, and returning a `false` used to return a `null`."; "Lua nil -> RESP3 null". "Type conversion from a script's returned Lua data type depends on the user's choice of protocol (see the `HELLO` command)." `redis.setresp(x)` "allows the executing script to switch between RESP versions for the replies returned by `redis.call()` and `redis.pcall()`."
- Source, `src/script_lua.c` `luaReplyToRedisReply(client *c, client* script_client, lua_State *lua)` (identical at 7.0.0:612-618, 7.2.0:614-620, 8.0.0:595-601, 8.2.0:600-606, unstable:599-605; 6.2.0 `scripting.c:348-354` uses `server.lua_client->resp`):
  ```c
  case LUA_TBOOLEAN:
      if (script_client->resp == 2)
          addReply(c,lua_toboolean(lua,-1) ? shared.cone :
                                             shared.null[c->resp]);
      else
          addReplyBool(c,lua_toboolean(lua,-1));
      break;
  case LUA_TNUMBER:
      addReplyLongLong(c,(long long)lua_tonumber(lua,-1));
      break;
  ```
  `script_client->resp` is initialised to 2 ("Default is RESP2, scripts can change it", `src/script.c:286`) and changed only by `redis.setresp` (`scriptSetResp`, `src/script.c:588-593`). `addReplyBool` (`src/networking.c:1300-1306`, unstable): RESP2 -> `:1`/`:0`; RESP3 -> `#t`/`#f`. `shared.null[3]` is `_\r\n`, `shared.null[2]` is `$-1\r\n`.
  Consequence matrix for a Lua boolean return:

  | Script called `redis.setresp(3)`? | Client RESP2 | Client RESP3 |
  |---|---|---|
  | No (default; this project) | `true` -> `:1`, `false` -> `$-1` (null) | `true` -> `:1`, `false` -> `_` (null) |
  | Yes | `true` -> `:1`, `false` -> `:0` | `true` -> `#t`, `false` -> `#f` |

- `NOSCRIPT` text: `"-NOSCRIPT No matching script. Please use EVAL.\r\n"` (`src/server.c:2241`, unstable), returned by `evalGenericCommand`/`evalShaCommand` (`src/eval.c:587, 656`).


### Live verification (Redis 8.6.2, local `redis-server`, 2026-09-12)

Run with `redis-cli` (RESP2) and `redis-cli -3` (RESP3) against a throwaway server; output confirms the source reading above and contradicts the unqualified wording of the docs table:

| Script | `redis-cli` (RESP2) | `redis-cli -3` (RESP3) |
|---|---|---|
| `EVAL "return {true,false,-3,7}" 0` | `1`, `(nil)`, `-3`, `7` | `1`, `(nil)`, `-3`, `7` |
| `EVAL "redis.setresp(3); return {true,false,-3,7}" 0` | `1`, `0`, `-3`, `7` | `(true)`, `(false)`, `-3`, `7` |
| `EVALSHA 0000000000000000000000000000000000000000 0` | `NOSCRIPT No matching script. Please use EVAL.` | same |

## Comparison table

| Topic | node-redis 5.x | node-redis 6.x | ioredis 5.x | ioredis 6.x |
|---|---|---|---|---|
| Latest version | 5.12.1 | 6.2.1 | 5.11.1 | 6.0.0 |
| Default protocol | RESP2 (`RESP ?? 2`) | RESP3 (`DEFAULT_RESP = 3`) | RESP2 only | RESP3 (`protocol: 3`, auto-downgrade to 2) |
| Opt-in/out | `createClient({ RESP: 3 })` | `createClient({ RESP: 2 })` | n/a | `new Redis({ protocol: 2 })` |
| Min Node | 18.19 | 20 | (unchanged from 5.x) | 20 |
| Raw command API | `sendCommand(args: ReadonlyArray<string \| Buffer>, options?) : Promise<T = ReplyUnion>` | same | `call(cmd: string, ...args: (string \| Buffer \| number)[]) : Promise<unknown>` | same |
| Numbers as args | type error; not auto-stringified | same | `String(n)` | `String(n)`; unsafe ints via `BigInt` |
| RESP integer `:` | `number` (or `string` via `typeMapping[NUMBER] = String`) | same | `number` (or `string` via `stringNumbers`) | same (`stringNumbers` also honoured) |
| RESP3 boolean `#` | `boolean` | `boolean` | n/a | `1/0` (`replyMapping: "legacy"`, default) or `boolean` (`"resp3"`) |
| RESP2 `$-1` / RESP3 `_` | `null` | `null` | `null` | `null` |
| Nested arrays | `Array` | `Array` | `Array` | `Array` |
| This script's `allow_request` (no `setresp`) | `1` / `null` under both protocols | same | `1` / `null` | `1` / `null` under both protocols |
| `SCRIPT LOAD` reply | `string` | `string` | `string` | `string` |
| Error class | `SimpleError extends ErrorReply extends Error` | same | `ReplyError` (redis-errors), `name: 'ReplyError'`, `.command` attached | `SimpleError/BlobError extends ReplyError`, `name: 'ReplyError'`, `.command` attached |
| `NOSCRIPT` message | `'NOSCRIPT No matching script. Please use EVAL.'` | same | same | same |
| Built-in NOSCRIPT fallback | `scripts` option / `defineScript` (`_executeScript` re-sends `EVAL`) | same | `defineCommand` (`Script` re-sends) | same |
| Class exported for `instanceof` | no (`createClient`, types only) | yes: `RedisClient` | yes: `Redis` (default + named) | yes: `Redis` (default + named) |
| Protocol exposed at runtime | `client.options.RESP` (`undefined` when defaulted -> 2) | `client.options.RESP` (`undefined` when defaulted -> 3) | none (`options.protocol` is `undefined`) | `options.protocol` (`2 \| 3`), negotiated `condition.protocol` (`@ignore`) |
| Other identifying members | `isOpen`, `isReady`, `withTypeMapping` | same | `status`, `options`, `call`, `sendCommand(Command)` | same |
| Notable default changes | -- | `commandOptions.timeout` 5000 ms, `keepAliveInitialDelay` 30 s, `maintNotifications: "auto"` under RESP3 | -- | connection-resilience defaults changed (#2160; details not reviewed) |


## Implications for this repository

- **No protocol-specific decoding is needed** for the current script as long as it does not call `redis.setresp(3)`: `res[0]` is `1` or `null`, `res[1..3]` are JS numbers, on all four clients under both RESP2 and RESP3. The existing `!!res[0]` coercion keeps working. Decision for the map's open point "whether RESP3 requires version-specific handling in either strategy": no, for reply decoding.
- If the script is ever changed to call `redis.setresp(3)` (for example to read `HGETALL` maps inside Lua), the first element becomes `#t/#f`: node-redis and ioredis 6 with `replyMapping: "resp3"` return a JS `boolean`, ioredis 6 `legacy` returns `1/0`, RESP2 clients return `1/0`. `!!res[0]` still covers every case; `res[0] === 1` would not.
- Callers may enable `stringNumbers` (ioredis) or `typeMapping[RESP_TYPES.NUMBER] = String` (node-redis); then `res[1..3]` are strings. Parsing with `Number(...)` in the strategies makes the result robust to that option at negligible cost.
- **Argument typing**: `RedisStrategy` must keep stringifying every argument (node-redis `RedisArgument = string | Buffer`); `IORedisStrategy` may pass numbers. A single shared `string[]` argument list satisfies both APIs and lets both strategies share one code path.
- **NOSCRIPT**: keep the `err.message.includes('NOSCRIPT')` check; it matches the exact server text on every client. node-redis `SimpleError`/ioredis `ReplyError` are both `Error` subclasses, so narrowing with `err instanceof Error` before reading `message` is type-safe without assertions.
- **node-redis 6 command timeout**: `commandOptions.timeout` defaults to 5000 ms and applies to `sendCommand(['EVALSHA', ...])`; timeouts surface as a rejection distinct from `NOSCRIPT` and must be propagated, not retried.
- **Client detection**: the current `typeof client.call === 'function'` heuristic still separates the clients (node-redis 5/6 have no `call`). A stricter duck-type for the fallback is `call` + `status` (ioredis) vs `sendCommand` + `isOpen` (node-redis). `instanceof` is not viable as a primary mechanism because node-redis 5 does not export `RedisClient` and the library has no runtime dependency on either client; the explicit `clientType` option decided in the map remains the primary mechanism.
- **Test matrix**: RESP3 coverage is only meaningful for node-redis 5 (`RESP: 3` opt-in), node-redis 6 (default), ioredis 6 (default, plus `replyMapping: "resp3"`); ioredis 5 is RESP2-only. node-redis 6 and ioredis 6 both require Node >= 20, consistent with the `engines.node >= 20` decision.
- The current `src/RateLimiter.ts` `RedisClientWrapper` type declares `call?: (command: string, args: (string | Buffer | number)[])` (array form); ioredis's documented primary overload is variadic, and `IORedisStrategy.sendCommand` currently passes the array form, which ioredis also accepts.

## Open questions / unverified items

- node-redis runtime behaviour when a JS `number` is passed to `sendCommand` despite the `string | Buffer` type was not traced through the RESP encoder; treat numbers as unsupported and stringify.
- The redis.io Lua-to-RESP3 table states "Lua Boolean -> RESP3 Boolean reply" unconditionally; the server source (all checked tags) makes this conditional on the script having called `redis.setresp(3)`. Confirmed live against Redis 8.6.2 (see "Live verification"); older 7.x servers were not tested live but share the same source.
- Whether Valkey or Redis Enterprise/Cloud differ from redis/redis in this conversion was not checked.
- ioredis 6 "improve default connection resilience (#2160)" changes were not reviewed in detail.
- ioredis 6 `Cluster` behaviour under RESP3 and node-redis cluster `sendCommand(firstKey, isReadonly, args)` were out of scope.
- No 7.x plans for either library were found in the default branches' changelogs/release notes as of today.

## Sources

Registry
- `npm view redis dist-tags --json`, `npm view redis versions --json`, `npm view redis@6.0.0 gitHead`, `npm view redis@5.12.1 gitHead`, `npm view redis@6.2.1 gitHead` (run 2026-09-12)
- `npm view ioredis dist-tags --json`, `npm view ioredis versions --json`, `npm view ioredis@6.0.0 gitHead engines dependencies`, `npm view ioredis@5.11.1 gitHead`
- `npm view redis-parser@3.0.0 gitHead`, `npm view redis-errors@1.2.0 repository.url`

Redis docs and server source
- https://redis.io/docs/latest/develop/programmability/lua-api/ (sections "redis.setresp", "Data type conversion", "Lua to RESP2 type conversion", "Lua to RESP3 type conversion")
- https://raw.githubusercontent.com/redis/redis/unstable/src/script_lua.c (`luaReplyToRedisReply`), and the same file at tags 7.0.0, 7.2.0, 8.0.0, 8.2.0; https://raw.githubusercontent.com/redis/redis/6.2.0/src/scripting.c
- https://raw.githubusercontent.com/redis/redis/unstable/src/script.c (`:286`, `scriptSetResp` `:588-593`)
- https://raw.githubusercontent.com/redis/redis/unstable/src/networking.c (`addReplyBool` `:1300-1306`)
- https://raw.githubusercontent.com/redis/redis/unstable/src/server.c (`:2241` NOSCRIPT text); https://raw.githubusercontent.com/redis/redis/unstable/src/eval.c (`:587`, `:656`)

node-redis
- https://github.com/redis/node-redis/releases/tag/redis%406.0.0 and https://github.com/redis/node-redis/releases (release list)
- https://github.com/redis/node-redis/blob/redis@6.0.0/docs/v5-to-v6.md (read at commit `9d52256`)
- https://github.com/redis/node-redis/blob/master/docs/v4-to-v5.md, `docs/v5.md` ("RESP3 Support"), `docs/RESP.md`, `docs/command-options.md` (read at commit `9d52256`)
- `packages/client/lib/RESP/types.ts` @ `6a44726` (`:231-233, :365`) and @ `56f9a49` (`:240-242, :368-370`)
- `packages/client/lib/client/index.ts` @ `6a44726` (`:469, :600-605, :631-640, :684, :696, :747-777, :1155-1172`) and @ `9d52256` (`:619, :792, :844, :906-938, :1058, :1605-1622`)
- `packages/client/lib/RESP/decoder.ts` @ `9d52256` (`:105-200, :228-256, :473-478, :605-630`) and @ `6a44726` (diffed)
- `packages/client/lib/client/parser.ts` @ `9d52256` (`:38-57, :111-142`)
- `packages/client/lib/errors.ts`, `packages/client/lib/lua-script.ts`, `packages/client/lib/commands/SCRIPT_LOAD.ts`, `packages/client/lib/commands/EVALSHA.ts` @ `56f9a49` (diffed against `6a44726` and `9d52256`)
- `packages/client/index.ts` and `packages/redis/index.ts` @ `6a44726` and @ `9d52256`

ioredis
- https://github.com/redis/ioredis/releases/tag/v6.0.0, https://github.com/redis/ioredis/releases/tag/v6.0.0-beta.1, https://github.com/redis/ioredis/releases/tag/v5.11.1
- `CHANGELOG.md`, `README.md` ("RESP3 Protocol"), `package.json` @ `8ed2946`; `package.json` @ `fb224a7`
- `lib/redis/RedisOptions.ts` @ `8ed2946` (`:150-170, :332-343`) and @ `fb224a7` (no protocol option)
- `lib/Redis.ts` @ `8ed2946` (`:104-105, :120, :255-275, :501-502, :935-975, :1092-1139`) and @ `fb224a7` (`:71, :87-88, :445, :1051`)
- `lib/redis/event_handler.ts` @ `8ed2946` (`:15-64, :127-151, :205-225, :292-300`)
- `lib/DataHandler.ts` @ `8ed2946` (`:18-31, :57-85, :111-120, :395-439`) and @ `fb224a7` (`:6, :11, :39-57, :72-80`)
- `lib/resp/decoder.ts` (`:14-26, :120-130, :237-256, :679-704`), `lib/resp/errors.ts`, `lib/resp/types.ts` @ `8ed2946`
- `lib/utils/RedisCommander.ts` @ `8ed2946` (`:9-10, :95-127, :1434-1490`) and @ `fb224a7` (`:9-10, :45-59, :1466-1474`)
- `lib/utils/index.ts` `toArg` @ `8ed2946` (`:204-216`) and @ `fb224a7` (`:168-173`)
- `lib/Command.ts` @ `8ed2946` (`:321-324, :380-412`) diffed against `fb224a7`
- `lib/utils/Commander.ts` @ `8ed2946` (`:63-92`), `lib/Script.ts` @ `8ed2946`, `lib/index.ts` @ `8ed2946` and @ `fb224a7`, `lib/types.ts` @ `8ed2946`

Dependencies
- redis-errors: https://raw.githubusercontent.com/NodeRedis/redis-errors/master/index.js and `lib/modern.js`
- redis-parser 3.0.0: https://raw.githubusercontent.com/NodeRedis/node-redis-parser/master/lib/parser.js (`:173-179`, `:291-301`)

Project
- `/Users/ludovicofabbri/Documents/Projects/Node/redis-sliding-rate-limiter/src/lua/script.ts:44` (`return {allow_request, remaining_allowed_requests - 1, first_expire_at, window_expire_at}`; no `redis.setresp` call in `src/lua/`)
