import { createRedisClient, ensureRedis } from "@hunch/infra";
import { env } from "./env.js";
import type { RedisClientType as RedisClient } from "redis";
let client: RedisClient | null = null;

export async function getRedis(): Promise<RedisClient | null> {
  if (!env.redisUrl) return null;
  if (client) return client;
  client = createRedisClient({ url: env.redisUrl });
  if (!client) return null;
  client.on("error", (e: unknown) => console.warn("[redis] err", String(e)));
  await ensureRedis(client);
  return client;
}
