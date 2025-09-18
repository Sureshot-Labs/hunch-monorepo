import { createClient } from "redis";
import { env } from "./env.js";

let client: ReturnType<typeof createClient> | null = null;

export async function getRedis() {
  if (!env.redisUrl) return null;
  if (client) return client;
  client = createClient({ url: env.redisUrl });
  client.on("error", (e: any) => console.warn("[redis] err", String(e)));
  await client.connect();
  return client;
}
