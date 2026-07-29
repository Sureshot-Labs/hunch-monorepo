import { createPgPool, type Pool } from "@hunch/infra";

import { env } from "./env.js";

export const CONTENT_SCHEMA_MIGRATION =
  "0007_content_foreign_key_indexes.sql" as const;

function createContentPool(inputs: {
  name: string;
  max: number;
  statementTimeoutMs: number;
  idleTransactionTimeoutMs: number;
}): Pool {
  const pool = createPgPool({
    connectionString: env.contentDatabaseUrl,
    options:
      `-c application_name=hunch-content-${inputs.name} ` +
      "-c jit=off " +
      `-c statement_timeout=${Math.trunc(inputs.statementTimeoutMs)} ` +
      `-c lock_timeout=${Math.trunc(env.contentDbLockTimeoutMs)} ` +
      `-c idle_in_transaction_session_timeout=${Math.trunc(inputs.idleTransactionTimeoutMs)}`,
    max: inputs.max,
    idleTimeoutMillis: 15_000,
    connectionTimeoutMillis: 2_000,
  });
  pool.on("error", (error: unknown) => {
    console.error(`[content-pg:${inputs.name}] error`, error);
  });
  return pool;
}

export const contentPool: Pool = createContentPool({
  name: "public",
  max: env.contentDbPublicPoolMax,
  statementTimeoutMs: env.contentDbPublicStatementTimeoutMs,
  idleTransactionTimeoutMs: 5_000,
});

export const contentAdminPool: Pool = createContentPool({
  name: "admin",
  max: env.contentDbAdminPoolMax,
  statementTimeoutMs: env.contentDbAdminStatementTimeoutMs,
  idleTransactionTimeoutMs: 5_000,
});

export const contentWorkerPool: Pool = createContentPool({
  name: "worker",
  max: env.contentDbWorkerPoolMax,
  statementTimeoutMs: env.contentDbWorkerStatementTimeoutMs,
  idleTransactionTimeoutMs: 10_000,
});

export async function checkContentDatabaseReady(): Promise<{
  migration: string;
  databaseTime: string;
}> {
  const { rows } = await contentPool.query<{
    database_time: Date | string;
    migration_ready: boolean;
    articles_table: string | null;
    audit_table: string | null;
  }>(
    `
      select
        now() as database_time,
        exists (
          select 1
          from content_schema_migrations
          where filename = $1
        ) as migration_ready,
        to_regclass('public.content_articles')::text as articles_table,
        to_regclass('public.content_audit_events')::text as audit_table
    `,
    [CONTENT_SCHEMA_MIGRATION],
  );
  const row = rows[0];
  if (!row?.migration_ready || !row.articles_table || !row.audit_table) {
    throw new Error(
      `Content schema is not migrated through ${CONTENT_SCHEMA_MIGRATION}`,
    );
  }
  return {
    migration: CONTENT_SCHEMA_MIGRATION,
    databaseTime:
      row.database_time instanceof Date
        ? row.database_time.toISOString()
        : new Date(row.database_time).toISOString(),
  };
}

export async function closeContentPools(): Promise<void> {
  await Promise.all([
    contentPool.end(),
    contentAdminPool.end(),
    contentWorkerPool.end(),
  ]);
}
