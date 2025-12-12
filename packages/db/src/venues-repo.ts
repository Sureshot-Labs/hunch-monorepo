import type { Pool } from "pg";

export async function getVenueId(pool: Pool, name: string): Promise<number> {
  const { rows } = await pool.query("select id from venues where name=$1", [
    name,
  ]);
  if (!rows[0]) throw new Error("venue not seeded");
  return rows[0].id as number;
}
