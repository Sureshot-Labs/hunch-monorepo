import { createPgPool, type Pool } from "@hunch/infra";
import { env } from "./env";
import { log } from "./log";

export const pool: Pool = createPgPool({ connectionString: env.dbUrl });
pool.on("error", (err: unknown) => {
  log.err("pg pool error", err);
});
