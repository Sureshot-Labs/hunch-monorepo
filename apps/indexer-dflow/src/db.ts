import type { PoolClient } from "pg";
import { createPgPool, tx as runTx } from "@hunch/infra";

import { env } from "./env.js";
import { log } from "./log.js";

export const pool = createPgPool({ connectionString: env.dbUrl });
pool.on("error", (err: unknown) => {
  log.err("pg pool error", err);
});
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return runTx(pool, fn);
}
