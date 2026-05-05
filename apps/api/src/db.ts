import { createPgPool, type Pool } from "@hunch/infra";

export type DbQuery = Pick<Pool, "query">;
import { env } from "./env.js";

export const pool: Pool = createPgPool({
  connectionString: env.dbUrl,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
});

pool.on("connect", (client) => {
  // Wallet-intel endpoints hit expensive plans where JIT compile time dominates execution.
  void client.query("set jit = off").catch((e: unknown) => {
    console.error("[pg] failed to set jit=off", e);
  });
});

pool.on("error", (e: unknown) => console.error("[pg] error", e));
