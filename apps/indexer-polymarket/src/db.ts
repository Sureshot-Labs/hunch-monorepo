import { Pool } from "pg";
import { env } from "./env";

export const pool = new Pool({ connectionString: env.dbUrl });
export async function tx<T>(fn: (c: any) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
