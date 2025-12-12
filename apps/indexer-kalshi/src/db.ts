import { createPgPool, type Pool } from "@hunch/infra";
import { env } from "./env";

export const pool: Pool = createPgPool({ connectionString: env.dbUrl });
