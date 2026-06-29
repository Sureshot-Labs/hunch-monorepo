import { createPgPool, type Pool } from "@hunch/infra";

export type DbQuery = Pick<Pool, "query">;
import { env } from "./env.js";

export const pool: Pool = createPgPool({
  connectionString: env.dbUrl,
  options: "-c jit=off",
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
});

pool.on("error", (e: unknown) => console.error("[pg] error", e));

const DEFAULT_STARTUP_WAIT_MS = 180_000;
const DEFAULT_STARTUP_RETRY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function checkDatabaseReady(): Promise<void> {
  const { rows } = await pool.query<{ in_recovery: boolean }>(
    "select pg_is_in_recovery() as in_recovery",
  );
  if (rows[0]?.in_recovery) {
    throw new Error("Postgres is still in recovery");
  }
}

export async function waitForDatabaseReady(): Promise<void> {
  const timeoutMs = readPositiveIntEnv(
    "API_DB_STARTUP_WAIT_MS",
    DEFAULT_STARTUP_WAIT_MS,
  );
  const retryMs = readPositiveIntEnv(
    "API_DB_STARTUP_RETRY_MS",
    DEFAULT_STARTUP_RETRY_MS,
  );
  const startedAt = Date.now();
  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await checkDatabaseReady();
      return;
    } catch (error) {
      lastError = error;
      await sleep(retryMs);
    }
  }

  throw new Error(`Database did not become ready within ${timeoutMs}ms`, {
    cause: lastError,
  });
}
