-- Atomic token bucket for the Rate-Limit Counter Store (P section 7.5).
--
-- One script call reads, refills, spends and rewrites the allowance and sets its expiry. Valkey runs a
-- script without interleaving another command, so the count and the expiry change together for every
-- backend instance. The server clock (TIME) is the only clock, so backend clocks cannot disagree.
--
-- KEYS[1]  opaque HMAC scope key; it contains no visitor identifier or policy name
-- ARGV[1]  capacity: largest burst, in requests
-- ARGV[2]  refill: requests restored per window
-- ARGV[3]  window length in milliseconds
-- ARGV[4]  expiry in milliseconds, at least the time to refill an empty bucket
--
-- The entry holds two integers and nothing else:
--   t   allowance in units, where one request costs window_ms units and refill adds `refill` units per ms
--   ts  server time of the last update, in milliseconds
-- Integer units keep the arithmetic exact. An expired entry is a full bucket, because expiry is never
-- shorter than a full refill.
--
-- Returns {allowed (1 or 0), retry_after_ms, remaining whole requests}.

local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local window_ms = tonumber(ARGV[3])
local expiry_ms = tonumber(ARGV[4])
if capacity == nil or refill == nil or window_ms == nil or expiry_ms == nil
    or capacity < 1 or refill < 1 or window_ms < 1 or expiry_ms < 1 then
    return redis.error_reply('ESP_RATE_POLICY_INVALID')
end

local cost = window_ms
local full = capacity * cost
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)

local entry = redis.call('HMGET', KEYS[1], 't', 'ts')
local allowance = tonumber(entry[1])
local stamp = tonumber(entry[2])
if allowance == nil or stamp == nil then
    allowance = full
    stamp = now
end
if now > stamp then
    allowance = math.min(full, allowance + (now - stamp) * refill)
    stamp = now
end

local allowed = 0
local retry_after_ms = 0
if allowance >= cost then
    allowance = allowance - cost
    allowed = 1
else
    retry_after_ms = math.ceil((cost - allowance) / refill)
end

redis.call('HSET', KEYS[1], 't', string.format('%d', allowance), 'ts', string.format('%d', stamp))
redis.call('PEXPIRE', KEYS[1], expiry_ms)
return {allowed, retry_after_ms, math.floor(allowance / cost)}
