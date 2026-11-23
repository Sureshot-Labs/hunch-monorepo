import "./bootstrap.js";
import { createPgPool, createRedisClient } from "@hunch/infra";
import { EmbeddingEngine, initializeEmbeddingWorker } from "./engine.js";
import { exitAfterEmbeddingFailure, runEmbeddingWorker } from "./lifecycle.js";
import { EmbeddingStore } from "./store.js";

// Secret bootstrap is provided by the existing service entrypoint. No API env import.
async function main() {
  const { DATABASE_URL, REDIS_URL, OPENROUTER_API_KEY } = process.env;
  if (!DATABASE_URL || !REDIS_URL || !OPENROUTER_API_KEY)
    throw new Error("embedding_runtime_configuration_missing");
  const db = createPgPool({
    connectionString: DATABASE_URL,
    max: 2,
    statement_timeout: 15000,
    application_name: "ai-embeddings",
  });
  const redis = createRedisClient({ url: REDIS_URL });
  redis.on("error", () => console.warn("[ai-worker] Redis unavailable"));
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const store = new EmbeddingStore(redis);
  try {
    await runEmbeddingWorker(
      {
        redis,
        acquireLease: () => store.acquire(),
        renewLease: () => store.renew(),
        releaseLease: () => store.release(),
        closeDatabase: () => db.end(),
        initialize: async () => {
          await initializeEmbeddingWorker(store);
          const engine = new EmbeddingEngine({
            store,
            db,
            apiKey: OPENROUTER_API_KEY,
          });
          return () => engine.tick();
        },
        log: (message) => console.log(`[ai-worker] ${message}`),
      },
      shutdown.signal,
    );
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
void main().catch(exitAfterEmbeddingFailure);
