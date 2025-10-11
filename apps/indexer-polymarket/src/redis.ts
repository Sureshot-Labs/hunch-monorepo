import { createClient, RedisClientType } from "redis";
import { env } from "./env";

export const redis: RedisClientType = createClient({ url: env.redisUrl });
export async function ensureRedis() {
  if (!redis.isOpen) await redis.connect();
}
