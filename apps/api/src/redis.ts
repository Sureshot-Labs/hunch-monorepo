import { checkRedisReady, createRedisClient, ensureRedis } from "@hunch/infra";
import { env } from "./env.js";
import {
  registerRuntimeResourceCleanup,
  unregisterRuntimeResourceCleanup,
} from "./runtime-resource-cleanup.js";
import type { RedisClientType as RedisClient } from "redis";

type RedisStatus = "disabled" | "ready" | "loading" | "error";
type RedisStatusResult = {
  redis: RedisClient | null;
  status: RedisStatus;
  error?: string;
};

const STATUS_TTL_MS = 1000;

let client: RedisClient | null = null;
const dedicatedClients = new Map<string, RedisClient>();
type PendingDedicatedClient = {
  client: RedisClient;
  promise: Promise<RedisClient | null>;
};
type DedicatedRedisOptions = Readonly<{
  connectDeadlineMs: number;
}>;
const pendingDedicatedClients = new Map<string, PendingDedicatedClient>();
let dedicatedClientEpoch = 0;
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
    registerRuntimeResourceCleanup("api-redis", closeRedis);
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

export async function getDedicatedRedis(
  resourceName: string,
  options: DedicatedRedisOptions,
): Promise<RedisClient | null> {
  if (
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(resourceName) ||
    !Number.isSafeInteger(options.connectDeadlineMs) ||
    options.connectDeadlineMs <= 0 ||
    !env.redisUrl
  ) {
    return null;
  }
  const existing = dedicatedClients.get(resourceName);
  if (existing) return existing;
  const pending = pendingDedicatedClients.get(resourceName);
  if (pending) return pending.promise;

  const creationEpoch = dedicatedClientEpoch;
  const dedicated = createRedisClient({ url: env.redisUrl });
  if (!dedicated) return null;
  dedicated.on("error", (error: unknown) =>
    console.warn(`[redis:${resourceName}] err`, String(error)),
  );
  const connected = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connection = ensureRedis(dedicated).then(
      () => ({ status: "ready" as const }),
      (error: unknown) => ({ status: "error" as const, error }),
    );
    const deadline = new Promise<Readonly<{ status: "timeout" }>>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: "timeout" }),
        options.connectDeadlineMs,
      );
    });
    const result = await Promise.race([connection, deadline]);
    if (timer) clearTimeout(timer);
    if (result.status !== "ready") {
      destroyRedisClient(dedicated);
      console.warn(
        `[redis:${resourceName}] connect failed`,
        result.status === "timeout"
          ? `deadline exceeded (${options.connectDeadlineMs}ms)`
          : String(result.error),
      );
      return null;
    }
    if (
      creationEpoch !== dedicatedClientEpoch ||
      pendingDedicatedClients.get(resourceName)?.client !== dedicated
    ) {
      destroyRedisClient(dedicated);
      return null;
    }
    dedicatedClients.set(resourceName, dedicated);
    registerRuntimeResourceCleanup(`api-redis:${resourceName}`, () =>
      closeDedicatedRedis(resourceName, dedicated),
    );
    return dedicated;
  })();
  const creation = connected
    .finally(() => {
      if (pendingDedicatedClients.get(resourceName)?.client === dedicated) {
        pendingDedicatedClients.delete(resourceName);
      }
    })
    .then((connectedClient) => {
      if (
        !connectedClient ||
        creationEpoch !== dedicatedClientEpoch ||
        dedicatedClients.get(resourceName) !== connectedClient
      ) {
        return null;
      }
      return connectedClient;
    });
  const pendingEntry = { client: dedicated, promise: creation };
  pendingDedicatedClients.set(resourceName, pendingEntry);
  return creation;
}

function destroyRedisClient(redisClient: RedisClient): void {
  try {
    // Dedicated cache clients are disposable. destroy() rejects queued work
    // immediately; quit()/close() can wait forever behind a stalled command.
    redisClient.destroy();
  } catch {
    // Runtime shutdown is already best-effort for Redis connections.
  }
}

export function discardDedicatedRedis(
  resourceName: string,
  expectedClient: RedisClient,
): void {
  const established = dedicatedClients.get(resourceName);
  if (established === expectedClient) {
    dedicatedClients.delete(resourceName);
    unregisterRuntimeResourceCleanup(`api-redis:${resourceName}`);
  }
  const pending = pendingDedicatedClients.get(resourceName);
  if (pending?.client === expectedClient) {
    pendingDedicatedClients.delete(resourceName);
  }
  if (established === expectedClient || pending?.client === expectedClient) {
    destroyRedisClient(expectedClient);
  }
}

function closeDedicatedRedis(
  resourceName: string,
  expectedClient?: RedisClient,
): Promise<void> {
  const dedicated = dedicatedClients.get(resourceName);
  if (!dedicated || (expectedClient && dedicated !== expectedClient)) {
    return Promise.resolve();
  }
  discardDedicatedRedis(resourceName, dedicated);
  return Promise.resolve();
}

export async function closeRedis(): Promise<void> {
  unregisterRuntimeResourceCleanup("api-redis");
  dedicatedClientEpoch += 1;
  const dedicatedToDestroy = new Set([
    ...dedicatedClients.values(),
    ...[...pendingDedicatedClients.values()].map((pending) => pending.client),
  ]);
  for (const resourceName of dedicatedClients.keys()) {
    unregisterRuntimeResourceCleanup(`api-redis:${resourceName}`);
  }
  dedicatedClients.clear();
  pendingDedicatedClients.clear();
  for (const dedicated of dedicatedToDestroy) {
    destroyRedisClient(dedicated);
  }
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
