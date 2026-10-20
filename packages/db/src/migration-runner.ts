import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { runConcurrentIndexStage } from "./migration-index-recovery.js";

/** Shared by the CLI and disposable-database retry tests. Applied migrations
 * retain their exact source checksum, even after a partially completed retry. */
export async function runMigration(
  client: PoolClient,
  input: { filename: string; sql: string },
): Promise<void> {
  const { filename, sql } = input;
  const checksum = createHash("sha256").update(sql).digest("hex");
  const { rows } = await client.query<{ checksum: string }>(
    `SELECT checksum FROM public.schema_migrations WHERE filename = $1`,
    [filename],
  );
  if (rows.length) {
    if (rows[0].checksum !== checksum)
      throw new Error(
        `Checksum mismatch for ${filename}. A past migration was edited. Never edit old migrations; create a new one.`,
      );
    console.log(`↷ skip ${filename}`);
    return;
  }
  const noTx = sql.includes("/* no-transaction */");
  try {
    if (!noTx) {
      await client.query("BEGIN");
      await client.query(sql);
    } else {
      const statements = sql
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements)
        await runConcurrentIndexStage(client, statement);
    }
    await client.query(
      `INSERT INTO public.schema_migrations(filename, checksum) VALUES ($1,$2)`,
      [filename, checksum],
    );
    if (!noTx) await client.query("COMMIT");
    console.log(`✅ applied ${filename}`);
  } catch (error) {
    if (!noTx) await client.query("ROLLBACK");
    throw error;
  }
}
