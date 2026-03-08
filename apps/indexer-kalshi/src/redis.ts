import {
  createRedisClient,
  ensureRedis as ensure,
  type RedisClientType,
} from "@hunch/infra";
import { env } from "./env.js";

export const redis: RedisClientType = createRedisClient({ url: env.redisUrl });

export async function ensureRedis(): Promise<void> {
  await ensure(redis, { waitForReady: true, logLabel: "indexer-kalshi" });
}
