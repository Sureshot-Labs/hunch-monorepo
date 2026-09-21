import "./bootstrap.js";
import { createPgPool, createRedisClient, ensureRedis } from "@hunch/infra";
import { EmbeddingEngine, initializeEmbeddingWorker } from "./engine.js";
import { EmbeddingStore } from "./store.js";

// Secret bootstrap is provided by the existing service entrypoint. No API env import.
async function main() {
  const { DATABASE_URL, REDIS_URL, OPENROUTER_API_KEY } = process.env;
  if (!DATABASE_URL || !REDIS_URL || !OPENROUTER_API_KEY)
    throw new Error("embedding_runtime_configuration_missing");
  const db = createPgPool({
    connectionString: DATABASE_URL,
    max: 2,
    statement_timeout: 5000,
    application_name: "ai-embeddings",
  });
  const redis = createRedisClient({ url: REDIS_URL });
  redis.on("error", () => console.warn("[ai-worker] Redis unavailable"));
  let stopped = false;
  process.on("SIGTERM", () => {
    stopped = true;
  });
  process.on("SIGINT", () => {
    stopped = true;
  });
  await ensureRedis(redis, { waitForReady: true, logLabel: "ai-worker" });
  const store = new EmbeddingStore(redis);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    while (!stopped && !(await store.acquire()))
      await new Promise((resolve) => setTimeout(resolve, 1000));
    if (stopped) return;
    heartbeat = setInterval(() => {
      void store.renew().catch(() => {
        stopped = true;
      });
    }, 10000);
    await initializeEmbeddingWorker(store);
    const engine = new EmbeddingEngine({
      store,
      db,
      apiKey: OPENROUTER_API_KEY,
    });
    console.log("[ai-worker] generation-aware worker ready");
    while (!stopped) {
      await engine.tick();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await store.release().catch(() => {});
    await redis.quit();
    await db.end();
  }
}
main().catch(() => {
  console.error("[ai-worker] stopped; check embedding status diagnostics");
  process.exitCode = 1;
});
