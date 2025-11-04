import { Pool } from "pg";
import { env } from "./env.js";

export const pool = new Pool({
  connectionString: env.dbUrl,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection could not be established
});

pool.on("error", (e) => console.error("[pg] error", e));
