import { Pool } from "pg";
import { env } from "./env.js";

export const pool = new Pool({ connectionString: env.dbUrl });
pool.on("error", (e) => console.error("[pg] error", e));
