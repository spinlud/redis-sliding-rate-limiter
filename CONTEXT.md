# Redis Sliding Rate Limiter

Domain glossary for `redis-sliding-rate-limiter`: a library that decides whether each incoming request is allowed by counting how many requests fall inside a continuously sliding time window backed by Redis. This file defines the project's vocabulary only; it holds no implementation detail.

## Language

### Window and configuration

**Window**:
The trailing interval of time, ending at the present instant, over which requests are counted. It slides continuously and is evaluated exactly, to microsecond precision, so there is no bucketing or rounding of the interval itself. Its length is a size expressed in a window unit.
_Avoid_: bucket, fixed window, time slot

**Window unit**:
The unit of time in which a window's length is expressed: one of millisecond, centisecond, decisecond, second, minute, hour, day, week, month, or year. A month is a fixed 30 days and a year a fixed 365 days; neither is calendar-aware.
_Avoid_: granularity, resolution

**Limit**:
The maximum number of requests allowed within a single window.
_Avoid_: quota, max, threshold, cap

**Limit overhead**:
An optional allowance of extra requests tolerated beyond the limit before requests are denied; it defaults to zero. The effective ceiling is the limit plus the limit overhead.
_Avoid_: burst, buffer, slack, grace

### Request outcome

**Allowed request** / **Denied request**:
The verdict for a single request evaluated against its window. A request is **allowed** when the number of requests already inside the window is below the effective ceiling (the limit plus the limit overhead), and **denied** otherwise.
_Avoid_: accepted / rejected, passed / blocked, throttled

**First expire**:
The instant, in epoch milliseconds, at which the oldest request currently in the window leaves it — the moment the window will next free capacity if no further requests arrive.
_Avoid_: reset time, retry-after

**Window expire**:
The instant, in epoch milliseconds, at which the window becomes empty, i.e. when the most recent request will have aged out.
_Avoid_: expiry, TTL, reset

### Redis access

**Client-input model**:
How a caller gives the limiter access to Redis. Exactly one of two mutually exclusive forms is supplied: a **client instance** — a node-redis or ioredis object that the limiter detects and drives directly — or a **send-command callback**, a caller-provided function of the shape `(...args: string[]) => Promise<unknown>` that runs a single Redis command. Providing both, or neither, is an error.
_Avoid_: client strategy, adapter, driver, connection strategy

---
