import { createClient } from "redis";
import type { RedisClientType } from "redis";

const DEFAULT_READY_MAX_WAIT_MS = 120000;
const DEFAULT_READY_MIN_DELAY_MS = 250;
const DEFAULT_READY_MAX_DELAY_MS = 2000;
const DEFAULT_READY_LOG_EVERY_MS = 5000;

export type RedisReadyOptions = {
  waitForReady?: boolean;
  maxWaitMs?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  logEveryMs?: number;
  logLabel?: string;
};

export function createRedisClient(options: { url: string }): RedisClientType {
  return createClient({ url: options.url });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRedisLoadingError(err: unknown): boolean {
  if (!err) return false;
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return message.includes("LOADING");
}

export function isRedisRetryableError(err: unknown): boolean {
  if (!err) return false;
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return (
    message.includes("LOADING") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Socket closed") ||
    message.includes("The socket is closed") ||
    message.includes("Connection is closed")
  );
}

export async function checkRedisReady(
  redis: RedisClientType,
): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch (err) {
    if (isRedisLoadingError(err)) return false;
    throw err;
  }
}

export async function waitForRedisReady(
  redis: RedisClientType,
  options: RedisReadyOptions = {},
): Promise<void> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_READY_MAX_WAIT_MS;
  const minDelayMs = options.minDelayMs ?? DEFAULT_READY_MIN_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_READY_MAX_DELAY_MS;
  const logEveryMs = options.logEveryMs ?? DEFAULT_READY_LOG_EVERY_MS;
  const label = options.logLabel ? ` ${options.logLabel}` : "";

  const start = Date.now();
  let delayMs = minDelayMs;
  let lastLogAt = 0;

  while (true) {
    let ready = false;
    try {
      ready = await checkRedisReady(redis);
    } catch (err) {
      if (!isRedisRetryableError(err)) throw err;
      ready = false;
    }
    if (ready) return;

    const now = Date.now();
    const elapsed = now - start;
    if (elapsed >= maxWaitMs) {
      throw new Error(
        `Redis not ready after ${maxWaitMs}ms${label ? ` (${label.trim()})` : ""}`,
      );
    }

    if (now - lastLogAt >= logEveryMs) {
      const seconds = Math.round(elapsed / 1000);
      console.warn(`[redis] waiting for ready${label} (${seconds}s)`);
      lastLogAt = now;
    }

    await delay(delayMs);
    delayMs = Math.min(Math.round(delayMs * 1.5), maxDelayMs);
  }
}

export async function ensureRedis(
  redis: RedisClientType,
  options: RedisReadyOptions = {},
): Promise<void> {
  if (!redis.isOpen) await redis.connect();
  if (options.waitForReady) {
    await waitForRedisReady(redis, options);
  }
}

export type { RedisClientType };
