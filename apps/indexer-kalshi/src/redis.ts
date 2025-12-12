import {
  createRedisClient,
  ensureRedis as ensure,
  type RedisClientType,
} from "@hunch/infra";
import { env } from "./env";

export const redis: RedisClientType = createRedisClient({ url: env.redisUrl });

export async function ensureRedis(): Promise<void> {
  await ensure(redis);
}
