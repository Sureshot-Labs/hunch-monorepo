import { env } from "./env";
import { createRedisClient, ensureRedis as ensure } from "@hunch/infra";

export const redis = createRedisClient({ url: env.redisUrl });
export async function ensureRedis(): Promise<void> {
  await ensure(redis);
}
