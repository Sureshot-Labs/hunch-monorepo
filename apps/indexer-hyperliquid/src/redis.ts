import { createRedisClient, ensureRedis as ensure } from "@hunch/infra";
import { env } from "./env.js";

if (!env.redisUrl) {
  throw new Error(
    "REDIS_URL is required when Hyperliquid Redis publishing is enabled",
  );
}

export const redis = createRedisClient({ url: env.redisUrl });
export async function ensureRedis(): Promise<void> {
  await ensure(redis, { waitForReady: true, logLabel: "indexer-hyperliquid" });
}
