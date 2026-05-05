import { checkRedisReady, createRedisClient, ensureRedis } from "@hunch/infra";
import { env } from "./env.js";
import type { RedisClientType as RedisClient } from "redis";

type RedisStatus = "disabled" | "ready" | "loading" | "error";
type RedisStatusResult = {
  redis: RedisClient | null;
  status: RedisStatus;
  error?: string;
};

const STATUS_TTL_MS = 1000;

let client: RedisClient | null = null;
let statusCache: { status: RedisStatus; checkedAt: number; error?: string } = {
  status: "disabled",
  checkedAt: 0,
};

function cacheStatus(status: RedisStatus, error?: string) {
  statusCache = { status, checkedAt: Date.now(), error };
}

export async function getRedisStatus(
  options: { force?: boolean } = {},
): Promise<RedisStatusResult> {
  if (!env.redisUrl) {
    cacheStatus("disabled");
    return { redis: null, status: "disabled" };
  }

  if (!client) {
    client = createRedisClient({ url: env.redisUrl });
    if (!client) {
      cacheStatus("error", "Redis client unavailable");
      return {
        redis: null,
        status: "error",
        error: "Redis client unavailable",
      };
    }
    client.on("error", (e: unknown) => console.warn("[redis] err", String(e)));
  }

  try {
    await ensureRedis(client);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Redis connect failed";
    cacheStatus("error", message);
    return { redis: null, status: "error", error: message };
  }

  const now = Date.now();
  if (!options.force && now - statusCache.checkedAt < STATUS_TTL_MS) {
    return {
      redis: statusCache.status === "ready" ? client : null,
      status: statusCache.status,
      error: statusCache.error,
    };
  }

  try {
    const ready = await checkRedisReady(client);
    const status: RedisStatus = ready ? "ready" : "loading";
    cacheStatus(status);
    return { redis: ready ? client : null, status };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Redis readiness check failed";
    cacheStatus("error", message);
    return { redis: null, status: "error", error: message };
  }
}

export async function getRedis(): Promise<RedisClient | null> {
  const { redis } = await getRedisStatus();
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (!client) {
    cacheStatus(env.redisUrl ? "loading" : "disabled");
    return;
  }

  const redisClient = client;
  client = null;

  try {
    await redisClient.quit();
  } catch (error) {
    console.warn("[redis] quit failed", String(error));
    try {
      await redisClient.disconnect();
    } catch (disconnectError) {
      console.warn("[redis] disconnect failed", String(disconnectError));
    }
  } finally {
    cacheStatus(env.redisUrl ? "loading" : "disabled");
  }
}
