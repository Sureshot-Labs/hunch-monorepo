/** Run against an isolated RESTORED database before opening traffic/workers. */
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { loadRuntimeSecrets } from "@hunch/config/secrets";

const { values } = parseArgs({
  options: {
    "database-url": { type: "string" },
    "expect-database": { type: "string" },
    "env-file": { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
const databaseUrl = values["database-url"]?.trim();
const expectedDatabase = values["expect-database"]?.trim();
if (!databaseUrl || !expectedDatabase)
  throw new Error("Replay requires --database-url and --expect-database");
let target: URL;
try {
  target = new URL(databaseUrl);
} catch {
  throw new Error("Replay requires a valid PostgreSQL database URL");
}
if (
  !["postgres:", "postgresql:"].includes(target.protocol) ||
  decodeURIComponent(target.pathname.slice(1)) !== expectedDatabase
)
  throw new Error("Replay database URL does not match --expect-database");
const apply = values.apply;
if (apply && process.env.ACCOUNT_ERASURE_RESTORE_ISOLATED !== "true")
  throw new Error(
    "Keep restored database isolated and set ACCOUNT_ERASURE_RESTORE_ISOLATED=true before --apply",
  );
// Load credentials/content settings before importing env.ts/db.ts, then pin the
// explicit target. A repository/production .env must never redirect this CLI.
if (values["env-file"] || process.env.HUNCH_RUNTIME_SECRETS_LOADED !== "1") {
  const loaded = config({
    path:
      values["env-file"] ??
      fileURLToPath(new URL("../../../.env", import.meta.url)),
    override: true,
  });
  if (values["env-file"] && loaded.error)
    throw new Error("Could not load the requested replay environment file");
  await loadRuntimeSecrets({
    envPath:
      values["env-file"] ??
      fileURLToPath(new URL("../../../.env", import.meta.url)),
  });
}
process.env.DATABASE_URL = databaseUrl;
process.env.HUNCH_RUNTIME_SECRETS_LOADED = "1";
const { pool } = await import("./db.js");
try {
  const { rows } = await pool.query<{ current_database: string }>(
    "select current_database() as current_database",
  );
  if (rows[0]?.current_database !== expectedDatabase)
    throw new Error(
      "Connected replay database does not match --expect-database",
    );
  // Verify the actual connection before any journal access or erasure. Restored
  // staging uploads need the same TTL/runtime as the normal account-delete path.
  const { env } = await import("./env.js");
  const { configureContentServiceRuntime } =
    await import("./content-service-runtime.js");
  configureContentServiceRuntime(env.content);
  const { AuthService } = await import("./auth.js");
  const { GetObjectCommand, ListObjectsV2Command, S3Client } =
    await import("@aws-sdk/client-s3");
  const {
    erasureJournalConfig,
    erasureRecordSchema,
    ERASURE_JOURNAL_PREFIX,
    erasureJournalKey,
  } = await import("./services/account-erasure-journal.js");
  const { bucket, region } = erasureJournalConfig();
  const s3 = new S3Client({ region });
  let cursor: string | undefined;
  let checked = 0;
  let replayed = 0;
  try {
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: ERASURE_JOURNAL_PREFIX,
          MaxKeys: 100,
          ContinuationToken: cursor,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key || Number(object.Size) > 1024)
          throw new Error("Invalid journal object");
        const result = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: object.Key }),
        );
        if (!result.Body) throw new Error("Missing journal body");
        const record = erasureRecordSchema.parse(
          JSON.parse(await result.Body.transformToString()),
        );
        if (object.Key !== erasureJournalKey(record))
          throw new Error("Journal identity mismatch");
        checked += 1;
        if (record.schemaVersion === 2) {
          const transferred = await pool.query(
            `select id from account_merge_transfers where id=$1`,
            [record.mergeTransferId],
          );
          if (transferred.rows[0]) continue;
        }
        if (apply) {
          // Reuses financial safety locks, social erasure and provider reconciliation outbox.
          // No new trade, transfer, payout or withdrawal is created.
          await AuthService.deleteUser(record.userId);
          replayed += 1;
        }
      }
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !cursor)
        throw new Error("Journal pagination did not advance");
    } while (cursor);
    console.log(
      JSON.stringify({
        database: expectedDatabase,
        mode: apply ? "applied" : "dry_run",
        checked,
        replayed,
      }),
    );
  } finally {
    s3.destroy();
  }
} finally {
  await pool.end();
}
