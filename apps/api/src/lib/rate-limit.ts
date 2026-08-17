import { createHash } from "node:crypto";
import { getRedisStatus } from "../redis.js";

export type RateLimitErrorMode = "fail_open" | "fail_closed";

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
  return resolveOnErrorMode(options) === "fail_open";
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
