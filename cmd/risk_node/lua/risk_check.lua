-- KEYS[1]: blacklist_set_key (e.g., "blacklist")
-- KEYS[2]: available_margin_key (e.g., "account:margin:available")
-- KEYS[3]: inflight_margin_key (e.g., "account:margin:inflight")
-- ARGV[1]: symbol (e.g., "AAPL")
-- ARGV[2]: order_val (e.g., 600.0)
-- ARGV[3]: max_order_limit (e.g., 50000.0)

local is_blacklisted = redis.call('SISMEMBER', KEYS[1], ARGV[1])
if is_blacklisted == 1 then
    return "REJECTED_BLACKLISTED"
end

local order_val = tonumber(ARGV[2])
local max_limit = tonumber(ARGV[3])
if not order_val or not max_limit then
    return "REJECTED_INVALID_ARGUMENTS"
end

if order_val > max_limit then
    return "REJECTED_EXCEEDS_MAX_CAP"
end

local avail_str = redis.call('GET', KEYS[2])
local avail = tonumber(avail_str or "0")

if avail < order_val then
    return "REJECTED_INSUFFICIENT_MARGIN"
end

-- Perform margin reallocation atomically
redis.call('INCRBYFLOAT', KEYS[2], -order_val)
redis.call('INCRBYFLOAT', KEYS[3], order_val)

return "APPROVED"
