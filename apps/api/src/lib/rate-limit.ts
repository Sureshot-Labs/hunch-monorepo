import { createHash } from "node:crypto";
import { getRedisStatus } from "../redis.js";

export type RateLimitErrorMode = "fail_open" | "fail_closed" | "throw";

type CheckRateLimitOptions = {
  onError?: RateLimitErrorMode;
};

const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local window_ms = tonumber(ARGV[3])

if (not now_ms) or (not capacity) or (not window_ms) or capacity <= 0 or window_ms <= 0 then
  return -1
end

local refill_rate = capacity / window_ms
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])

if (not tokens) or (not ts) then
  tokens = capacity
  ts = now_ms
else
  local elapsed = now_ms - ts
  if elapsed < 0 then
    elapsed = 0
  end
  tokens = math.min(capacity, tokens + (elapsed * refill_rate))
  ts = now_ms
end

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', ts)
redis.call('PEXPIRE', key, math.floor(window_ms * 2))

return allowed
`;

const COUNTER_ACQUIRE_SCRIPT = `
local key = KEYS[1]
local max_slots = tonumber(ARGV[1])
local ttl_ms = tonumber(ARGV[2])

if (not max_slots) or (not ttl_ms) or max_slots <= 0 or ttl_ms <= 0 then
  return -1
end

local current = tonumber(redis.call('GET', key) or '0')
if current >= max_slots then
  return 0
end

current = redis.call('INCR', key)
redis.call('PEXPIRE', key, ttl_ms)
return current
`;

const COUNTER_RELEASE_SCRIPT = `
local key = KEYS[1]
local ttl_ms = tonumber(ARGV[1])
if (not ttl_ms) or ttl_ms <= 0 then
  return -1
end

local current = tonumber(redis.call('GET', key) or '0')
if current <= 1 then
  redis.call('DEL', key)
  return 0
end

current = redis.call('DECR', key)
redis.call('PEXPIRE', key, ttl_ms)
return current
`;

// Share creation needs ownership-aware leases rather than an anonymous
// counter. A timed-out Redis command may still complete later; storing the
// owner token makes a delayed cleanup incapable of releasing somebody else's
// slot. The command also rejects work that only reaches Redis after the
// caller's acquisition deadline.
const LEASE_ACQUIRE_SCRIPT = `
local key = KEYS[1]
local owner_token = ARGV[1]
local max_slots = tonumber(ARGV[2])
local ttl_ms = tonumber(ARGV[3])
local request_deadline_ms = tonumber(ARGV[4])

if (not owner_token) or owner_token == '' or (not max_slots) or
   (not ttl_ms) or (not request_deadline_ms) or
   max_slots <= 0 or ttl_ms <= 0 then
  return -1
end

local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) +
  math.floor(tonumber(redis_time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now_ms)

if now_ms > request_deadline_ms then
  return -2
end

if redis.call('ZSCORE', key, owner_token) then
  redis.call('ZADD', key, now_ms + ttl_ms, owner_token)
  redis.call('PEXPIRE', key, ttl_ms)
  return 1
end

if tonumber(redis.call('ZCARD', key)) >= max_slots then
  return 0
end

redis.call('ZADD', key, now_ms + ttl_ms, owner_token)
redis.call('PEXPIRE', key, ttl_ms)
return 1
`;

const LEASE_RELEASE_SCRIPT = `
local key = KEYS[1]
local owner_token = ARGV[1]
if (not owner_token) or owner_token == '' then
  return -1
end

local removed = redis.call('ZREM', key, owner_token)
if tonumber(redis.call('ZCARD', key)) == 0 then
  redis.call('DEL', key)
end
return removed
`;

function normalizeKey(input: string): string {
  const trimmed = input.trim();
  return trimmed.length ? trimmed : "unknown";
}

function compactKey(input: string): string {
  if (input.length <= 96) return input;
  return createHash("sha256").update(input).digest("hex");
}

function resolveOnErrorMode(
  options?: CheckRateLimitOptions,
): RateLimitErrorMode {
  return options?.onError ?? "fail_open";
}

function allowOnError(options?: CheckRateLimitOptions): boolean {
  const mode = resolveOnErrorMode(options);
  if (mode === "throw") {
    throw new Error("rate_limit_backend_unavailable");
  }
  return mode === "fail_open";
}

async function evalLuaNumber(
  script: string,
  key: string,
  args: string[],
): Promise<number | null> {
  const { redis } = await getRedisStatus();
  if (!redis) return null;
  try {
    const reply = await redis.sendCommand(["EVAL", script, "1", key, ...args]);
    const parsed = Number(reply);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function checkRateLimitRedis(args: {
  key: string;
  maxRequests: number;
  windowMs: number;
}): Promise<boolean | null> {
  const nowMs = Date.now();
  const key = `rate:v3:${args.windowMs}:${args.maxRequests}:${compactKey(normalizeKey(args.key))}`;
  const reply = await evalLuaNumber(TOKEN_BUCKET_SCRIPT, key, [
    String(nowMs),
    String(args.maxRequests),
    String(args.windowMs),
  ]);
  if (reply == null || reply < 0) return null;
  return reply === 1;
}

export async function checkRateLimit(
  key: string,
  maxRequests: number = 10,
  windowMs: number = 60_000,
  options: CheckRateLimitOptions = {},
): Promise<boolean> {
  const normalizedKey = normalizeKey(key);
  const allowed = await checkRateLimitRedis({
    key: normalizedKey,
    maxRequests,
    windowMs,
  });
  if (allowed != null) return allowed;

  return allowOnError(options);
}

export async function acquireDistributedSlot(
  key: string,
  maxSlots: number,
  ttlMs: number,
  options: CheckRateLimitOptions = {},
): Promise<boolean> {
  const normalizedKey = normalizeKey(key);
  const redisKey = `slot:v1:${compactKey(normalizedKey)}`;
  const reply = await evalLuaNumber(COUNTER_ACQUIRE_SCRIPT, redisKey, [
    String(maxSlots),
    String(ttlMs),
  ]);
  if (reply == null || reply < 0) {
    return allowOnError(options);
  }
  return reply > 0;
}

export async function releaseDistributedSlot(
  key: string,
  ttlMs: number,
): Promise<void> {
  const normalizedKey = normalizeKey(key);
  const redisKey = `slot:v1:${compactKey(normalizedKey)}`;
  await evalLuaNumber(COUNTER_RELEASE_SCRIPT, redisKey, [String(ttlMs)]);
}

export async function acquireDistributedLease(
  key: string,
  inputs: Readonly<{
    maxSlots: number;
    ownerToken: string;
    requestDeadlineMs: number;
    ttlMs: number;
  }>,
  options: CheckRateLimitOptions = {},
): Promise<boolean> {
  const normalizedKey = normalizeKey(key);
  const ownerToken = inputs.ownerToken.trim();
  if (!ownerToken) throw new Error("distributed lease owner is required");
  const redisKey = `slot:v2:${compactKey(normalizedKey)}`;
  const reply = await evalLuaNumber(LEASE_ACQUIRE_SCRIPT, redisKey, [
    ownerToken,
    String(inputs.maxSlots),
    String(inputs.ttlMs),
    String(inputs.requestDeadlineMs),
  ]);
  // -2 means the command reached Redis after the caller stopped waiting. It
  // did not acquire anything and is a normal negative result, not an outage.
  if (reply === -2) return false;
  if (reply == null || reply < 0) return allowOnError(options);
  return reply === 1;
}

export async function releaseDistributedLease(
  key: string,
  ownerToken: string,
): Promise<void> {
  const normalizedKey = normalizeKey(key);
  const normalizedOwner = ownerToken.trim();
  if (!normalizedOwner) return;
  const redisKey = `slot:v2:${compactKey(normalizedKey)}`;
  await evalLuaNumber(LEASE_RELEASE_SCRIPT, redisKey, [normalizedOwner]);
}
