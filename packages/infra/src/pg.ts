import { Pool } from "pg";
import type { PoolClient, PoolConfig } from "pg";

export function createPgPool(config: PoolConfig): Pool {
  return new Pool(config);
}

export async function tx<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
