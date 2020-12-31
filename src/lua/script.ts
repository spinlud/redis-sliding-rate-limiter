const LuaScript = `
    local key = KEYS[1]
    local window = tonumber(ARGV[1])
    local microsecFactor = tonumber(ARGV[2])
    local expire_ms = tonumber(ARGV[3])
    local limit = tonumber(ARGV[4])
    
    local now = redis.call('TIME') -- Array with seconds and microseconds for the current time
    local now_microsec = now[1] * 1000000 + now[2] -- Timestamp in microseconds
    local now_ms = math.floor(now_microsec * 0.001) -- Timestamp in milliseconds
    local member_score = math.floor(now_microsec * microsecFactor) -- Compute member score (timestamp) at the right resolution using the conversion factor
    local window_expire_at = now_ms + expire_ms -- Window expiration epoch in milliseconds
    
    -- Remove elements older than (now - window) at the given resolution
    redis.call('ZREMRANGEBYSCORE', key, 0, member_score - window)
    
    -- Get number of requests in the current window
    local current_requests_count = redis.call('ZCARD', key)
    
    -- Compute the number of remaining requests allowed in the current window
    local remaining_allowed_requests = math.max(0, limit - current_requests_count)
    
    -- If greater than zero, add (allow) request
    if remaining_allowed_requests > 0 then
        redis.call('ZADD', key, member_score, now_microsec)
    end
    
    -- Compute epoch (in milliseconds) at which the first element will expire in the current window
    local first_expire_at = -1
    
    if current_requests_count > 0 then
        local first_member = redis.call('ZRANGE', key, 0, 0)[1] -- Return the first element member (microseconds)
        first_expire_at = math.floor(first_member * 0.001) + expire_ms -- Extract milliseconds from member and add expiration time
    end
    
    -- Expire the whole key for cleanup (ms)
    redis.call('PEXPIRE', key, expire_ms)
    
    return {remaining_allowed_requests, first_expire_at, window_expire_at}
`;

export { LuaScript };
