import type { PoolClient } from "pg";
import { createPgPool, tx as runTx } from "@hunch/infra";

import { env } from "./env";

export const pool = createPgPool({ connectionString: env.dbUrl });
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return runTx(pool, fn);
}
