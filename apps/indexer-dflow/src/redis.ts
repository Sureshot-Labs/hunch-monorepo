import { createRedisClient, ensureRedis as ensure } from "@hunch/infra";

import { env } from "./env.js";

export const redis = createRedisClient({ url: env.redisUrl });
export async function ensureRedis(): Promise<void> {
  await ensure(redis);
}
