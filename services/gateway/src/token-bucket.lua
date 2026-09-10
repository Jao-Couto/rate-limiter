local capacity = tonumber(ARGV[1])
local refillPerSec = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

if capacity <= 0 then
  return { 0, 0, -1, 0 }
end

local time = redis.call('TIME')
local nowMs = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = nowMs
end

local elapsedMs = nowMs - ts
if elapsedMs < 0 then elapsedMs = 0 end
tokens = math.min(capacity, tokens + ((elapsedMs / 1000) * refillPerSec))

local allowed = 0
local retryAfterMs = 0

if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
elseif refillPerSec > 0 then
  retryAfterMs = math.ceil(((cost - tokens) / refillPerSec) * 1000)
else
  retryAfterMs = -1
end

local refillMs = 0
if refillPerSec > 0 then
  refillMs = math.ceil((capacity / refillPerSec) * 1000)
end
local ttlMs = refillMs + 60000

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', nowMs)
redis.call('PEXPIRE', KEYS[1], ttlMs)

return { allowed, math.floor(tokens * 1000), retryAfterMs, capacity }
