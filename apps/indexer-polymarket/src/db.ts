import type { PoolClient } from "pg";
import { env } from "./env";
import { createPgPool, tx as runTx } from "@hunch/infra";

export const pool = createPgPool({ connectionString: env.dbUrl });
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return runTx(pool, fn);
}
