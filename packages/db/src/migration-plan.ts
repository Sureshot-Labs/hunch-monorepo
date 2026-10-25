import type { PoolClient } from "pg";
import path from "node:path";

// Preserve the original checksums of already shipped migrations. These two
// files predate the explicit marker; only their terminal validations move to a
// separate transaction. The DDL phase is recorded atomically so restart never
// repeats ADD CONSTRAINT after a committed first phase.
const onlineLegacyFiles = new Set([
  "0288_account_age_confirmation.sql",
  "0290_avatar_moderation_action.sql",
]);

export function onlineMigrationPlan(filename: string, sql: string) {
  if (
    !onlineLegacyFiles.has(path.basename(filename)) &&
    !sql.includes("/* online-validation */")
  )
    return null;
  const validation =
    /(?:ALTER TABLE\s+[\w.]+\s+VALIDATE CONSTRAINT\s+\w+;\s*)+$/i.exec(sql);
  if (!validation)
    throw new Error(`Missing terminal online validation in ${filename}`);
  return { ddl: sql.slice(0, validation.index), validation: validation[0] };
}

export async function applyOnlineMigration(
  client: Pick<PoolClient, "query">,
  filename: string,
  checksum: string,
  plan: { ddl: string; validation: string },
) {
  const phaseName = `${filename}#ddl`;
  const phase = await client.query<{ checksum: string }>(
    `SELECT checksum FROM public.schema_migrations WHERE filename = $1`,
    [phaseName],
  );
  if (phase.rows[0] && phase.rows[0].checksum !== checksum)
    throw new Error(`Checksum mismatch for committed DDL phase of ${filename}`);
  if (!phase.rows[0]) {
    try {
      await client.query("BEGIN");
      await client.query(plan.ddl);
      await client.query(
        `INSERT INTO public.schema_migrations(filename, checksum) VALUES ($1,$2)`,
        [phaseName, checksum],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  // AccessExclusive from ADD/DROP is released before the table scan. This
  // statement's weaker validation lock permits concurrent ordinary writes.
  await client.query(plan.validation);
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.schema_migrations(filename, checksum) VALUES ($1,$2)`,
      [filename, checksum],
    );
    await client.query(
      `DELETE FROM public.schema_migrations WHERE filename = $1`,
      [phaseName],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
