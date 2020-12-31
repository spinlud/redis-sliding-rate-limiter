const LuaScript = `
    local key = KEYS[1]
    local window = tonumber(ARGV[1])
    local secFactor = tonumber(ARGV[2])
    local microsecFactor = tonumber(ARGV[3])
    local expire_ms = tonumber(ARGV[4])
    local limit = tonumber(ARGV[5])
    
    local now = redis.call('TIME') -- Array with seconds and microseconds for the current time
    local now_ms = math.floor(now[1] * 1000 + now[2] * 0.001)
    local member = now_ms.." "..now[2] -- Concatenate current milliseconds and microsends to obtain a unique set member for this request (to avoid collisions in the set)
    local member_score = math.floor(now[1] * secFactor + now[2] * microsecFactor) -- Compute member score at given resolution unit
    local window_expire_at = now_ms + expire_ms -- To return to the client in the headers (X-Rate-Limit...)
    
    redis.debug("now", now)
    redis.debug("member", member)
    redis.debug("member_score", string.format("%.0f", member_score))
    
    -- Remove elements older than (now - window) at the given resolution unit
    redis.call('ZREMRANGEBYSCORE', key, 0, member_score - window)
    
    -- Get number of requests in the current window
    local current_requests_count = redis.call('ZCARD', key)
    
    -- Compute the number of remaining requests allowed in the current window
    local remaining_allowed_requests = math.max(0, limit - current_requests_count)
    
    -- If greater than zero, add (allow) request
    if remaining_allowed_requests > 0 then
        redis.call('ZADD', key, member_score, member)
    end
    
    -- Compute epoch (in milliseconds) the first element will expire in the current window (to return to the client in the headers X-Rate-Limit...)
    local first_expire_at = -1
    
    if current_requests_count > 0 then
        local first_member = redis.call('ZRANGE', key, 0, 0)[1] -- Return the first element member (format "{milliseconds} {microseconds}")
        first_expire_at = string.gmatch(first_member, "(%d+).*")() + expire_ms -- Extract milliseconds from member and add expiration time
    end
    
    -- Expire the whole key for cleanup (ms)
    redis.call('PEXPIRE', key, expire_ms)
    
    return {remaining_allowed_requests, first_expire_at, window_expire_at}
`;

export { LuaScript };
