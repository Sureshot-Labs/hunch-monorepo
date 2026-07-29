import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { globby } from "globby";
import { Pool, type PoolClient } from "pg";

const connectionString =
  process.env.CONTENT_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();

if (!connectionString) {
  throw new Error("CONTENT_DATABASE_URL or DATABASE_URL is required");
}

const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5_000,
  options:
    "-c application_name=hunch-content-migrate " +
    "-c lock_timeout=5000 " +
    "-c statement_timeout=300000 " +
    "-c idle_in_transaction_session_timeout=310000",
});
const migrationsDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../content-migrations",
);

function checksum(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists public.content_schema_migrations (
      id bigserial primary key,
      filename text unique not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function acquireLock(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ locked: boolean }>(
    "select pg_try_advisory_lock(434667710) as locked",
  );
  if (!rows[0]?.locked) {
    throw new Error("Another content migration is already running");
  }
}

async function appliedMigrations(
  client: PoolClient,
): Promise<Map<string, string>> {
  const { rows } = await client.query<{ filename: string; checksum: string }>(
    "select filename, checksum from public.content_schema_migrations",
  );
  return new Map(rows.map((row) => [row.filename, row.checksum]));
}

async function applyMigration(
  client: PoolClient,
  filename: string,
  source: string,
): Promise<void> {
  const sourceChecksum = checksum(source);
  await client.query("begin");
  try {
    await client.query(source);
    await client.query(
      `
        insert into public.content_schema_migrations (filename, checksum)
        values ($1, $2)
      `,
      [filename, sourceChecksum],
    );
    await client.query("commit");
    console.log(`✅ applied content migration ${filename}`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

const client = await pool.connect();
try {
  await acquireLock(client);
  await ensureMigrationsTable(client);
  const applied = await appliedMigrations(client);
  const files = (
    await globby("*.sql", { cwd: migrationsDirectory, absolute: true })
  ).sort();
  if (files.length === 0) {
    throw new Error(`No content migrations found in ${migrationsDirectory}`);
  }
  for (const file of files) {
    const filename = path.basename(file);
    const source = await fs.readFile(file, "utf8");
    const previousChecksum = applied.get(filename);
    if (previousChecksum) {
      if (previousChecksum !== checksum(source)) {
        throw new Error(
          `Checksum mismatch for applied content migration ${filename}`,
        );
      }
      console.log(`↷ skip content migration ${filename}`);
      continue;
    }
    await applyMigration(client, filename, source);
  }
  console.log("Content migrations up to date.");
} finally {
  try {
    await client.query("select pg_advisory_unlock(434667710)");
  } catch {
    // Releasing the session lock is best effort during shutdown.
  }
  client.release();
  await pool.end();
}
