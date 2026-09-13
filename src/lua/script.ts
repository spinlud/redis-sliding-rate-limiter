const LuaScript = `
    local key = KEYS[1]
    local window_us = tonumber(ARGV[1]) -- Sliding window length in microseconds
    local expire_ms = tonumber(ARGV[2]) -- Window length in milliseconds, used for the key TTL
    local limit = tonumber(ARGV[3])
    local limit_overhead = tonumber(ARGV[4])

    -- Rounds a microsecond epoch up to the next whole millisecond using integer math
    local function ceil_to_ms(microsec)
        local remainder = microsec % 1000
        if remainder == 0 then
            return (microsec - remainder) / 1000
        end
        return (microsec - remainder) / 1000 + 1
    end

    local now = redis.call('TIME') -- Array of seconds and microseconds
    local now_us = now[1] * 1000000 + now[2] -- Current time in microseconds

    -- Evict members whose score falls outside the sliding window
    redis.call('ZREMRANGEBYSCORE', key, '-inf', now_us - window_us)

    local current_requests_count = redis.call('ZCARD', key)

    -- A request is allowed while the count is below the limit plus its overhead
    local allow_request = (limit + limit_overhead - current_requests_count) > 0

    -- Requests still allowed after this one, clamped at zero
    local remaining = limit - current_requests_count - 1
    if remaining < 0 then
        remaining = 0
    end

    if allow_request then
        -- Unique member keeps two calls in the same microsecond distinct.
        -- Format the timestamp with %d so large microsecond values are not
        -- coerced to lossy scientific notation during string concatenation.
        local now_us_member = string.format('%d', now_us)
        redis.call('ZADD', key, now_us, now_us_member .. ':' .. current_requests_count)
        redis.call('PEXPIRE', key, expire_ms)
    end

    -- windowExpireAtMs is the newest member's expiry. On an allowed request that
    -- member is the one just added at now_us, so its expiry is now_us + window_us and
    -- needs no read. On a denied request nothing was added, so the newest existing
    -- member is older than now_us and its score must be read.
    local window_expire_at = -1
    if allow_request then
        window_expire_at = ceil_to_ms(now_us + window_us)
    else
        local newest = redis.call('ZRANGE', key, -1, -1, 'WITHSCORES')
        if newest[2] then
            window_expire_at = ceil_to_ms(tonumber(newest[2]) + window_us)
        end
    end

    -- firstExpireAtMs tracks the oldest member; its score is read on both paths
    local first_expire_at = -1
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    if oldest[2] then
        first_expire_at = ceil_to_ms(tonumber(oldest[2]) + window_us)
    end

    return {allow_request, remaining, first_expire_at, window_expire_at}
`;

export { LuaScript };
