import { createPgPool, type Pool } from "@hunch/infra";
import { env } from "./env.js";
import { log } from "./log.js";

export const pool: Pool = createPgPool({ connectionString: env.dbUrl });
pool.on("error", (err: unknown) => {
  log.err("pg pool error", err);
});
