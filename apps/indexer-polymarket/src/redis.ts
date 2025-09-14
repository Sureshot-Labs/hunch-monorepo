import { createClient } from "redis";
import { env } from "./env";

export const redis = createClient({ url: env.redisUrl });
export async function ensureRedis() {
  if (!redis.isOpen) await redis.connect();
}
