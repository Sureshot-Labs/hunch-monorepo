import { globby } from "globby";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "../../config"; // Adjusted import path to fix module resolution
import crypto from "node:crypto";
import { Pool, PoolClient } from "pg";

const pool = new Pool({ connectionString: env.DATABASE_URL });

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      id            bigserial PRIMARY KEY,
      filename      text UNIQUE NOT NULL,
      checksum      text NOT NULL,
      applied_at    timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/**
 * Grab a global advisory lock so two devs/CI jobs don’t stampede.
 * 42 is arbitrary.
 */
async function acquireLock(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ pg_try_advisory_lock: boolean }>(
    `SELECT pg_try_advisory_lock(42);`
  );
  if (!rows[0]?.pg_try_advisory_lock) {
    throw new Error(
      "Could not acquire advisory lock. Another migration is running."
    );
  }
}

async function releaseLock(client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_unlock(42);`);
}

async function getAppliedMap(client: PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query<{ filename: string; checksum: string }>(
    `SELECT filename, checksum FROM public.schema_migrations;`
  );
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

async function runSingleMigration(
  client: PoolClient,
  filePath: string
): Promise<void> {
  const sql = await fs.readFile(filePath, "utf8");
  const checksum = sha256(sql);
  const filename = path.basename(filePath);

  // detect if previously applied with same checksum
  const { rows } = await client.query<{ checksum: string }>(
    `SELECT checksum FROM public.schema_migrations WHERE filename = $1`,
    [filename]
  );
  if (rows.length) {
    if (rows[0].checksum !== checksum) {
      throw new Error(
        `Checksum mismatch for ${filename}. A past migration was edited. ` +
          `Never edit old migrations; create a new one.`
      );
    }
    console.log(`↷ skip ${filename}`);
    return;
  }

  const noTx = sql.includes("/* no-transaction */");

  try {
    if (!noTx) await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      `INSERT INTO public.schema_migrations(filename, checksum) VALUES ($1,$2)`,
      [filename, checksum]
    );
    if (!noTx) await client.query("COMMIT");
    console.log(`✅ applied ${filename}`);
  } catch (err) {
    if (!noTx) await client.query("ROLLBACK");
    throw err;
  }
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// absolute path to your migrations folder
const migrationsDir = path.join(__dirname, "../migrations");
(async () => {
  const client = await pool.connect();
  try {
    await acquireLock(client);
    await ensureMigrationsTable(client);

    const files = (
      await globby("*.sql", { cwd: migrationsDir, absolute: true })
    ).sort();
    if (!files.length) {
      console.log("No migrations found.");
      return;
    }

    // verify previously applied checksums
    const applied = await getAppliedMap(client);
    for (const f of files) {
      const name = path.basename(f);
      if (applied.has(name)) {
        const sql = await fs.readFile(f, "utf8");
        const sum = sha256(sql);
        if (applied.get(name) !== sum) {
          throw new Error(
            `Checksum mismatch for ${name}. Someone changed a past migration.`
          );
        }
      }
    }

    // apply new ones
    for (const f of files) {
      const name = path.basename(f);
      if (!applied.has(name)) {
        await runSingleMigration(client, f);
      }
    }

    console.log("Migrations up to date.");
  } catch (e: any) {
    console.error("❌ migration failed:", e.message);
    process.exitCode = 1;
  } finally {
    try {
      await releaseLock(client);
    } catch {}
    client.release();
    await pool.end();
  }
})();
