import { createRedisClient, ensureRedis } from "@hunch/infra";
import { env } from "./env.js";

type RedisClient = ReturnType<typeof createRedisClient>;
let client: RedisClient | null = null;

export async function getRedis() {
  if (!env.redisUrl) return null;
  if (client) return client;
  client = createRedisClient({ url: env.redisUrl });
  client.on("error", (e: unknown) => console.warn("[redis] err", String(e)));
  await ensureRedis(client);
  return client;
}
