import { createClient } from "redis";
import type { RedisClientType } from "redis";

export function createRedisClient(options: { url: string }): RedisClientType {
  return createClient({ url: options.url });
}

export async function ensureRedis(redis: RedisClientType): Promise<void> {
  if (!redis.isOpen) await redis.connect();
}

export type { RedisClientType };