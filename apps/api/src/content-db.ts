import { createPgPool, type Pool } from "@hunch/infra";

export const CONTENT_SCHEMA_MIGRATION =
  "0222_content_service_actor.sql" as const;

export type ContentPoolOptions = {
  connectionString: string;
  name: "public" | "admin" | "worker";
  max: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleTransactionTimeoutMs: number;
};

export function createContentPool(options: ContentPoolOptions): Pool {
  const pool = createPgPool({
    connectionString: options.connectionString,
    options:
      `-c application_name=hunch-content-${options.name} ` +
      "-c jit=off " +
      `-c statement_timeout=${Math.trunc(options.statementTimeoutMs)} ` +
      `-c lock_timeout=${Math.trunc(options.lockTimeoutMs)} ` +
      `-c idle_in_transaction_session_timeout=${Math.trunc(options.idleTransactionTimeoutMs)}`,
    max: options.max,
    idleTimeoutMillis: 15_000,
    connectionTimeoutMillis: 2_000,
  });
  pool.on("error", (error: unknown) => {
    console.error(`[content-pg:${options.name}] error`, error);
  });
  return pool;
}

export async function checkContentDatabaseReady(
  pool: Pool,
): Promise<{ migration: string; databaseTime: string }> {
  const { rows } = await pool.query<{
    database_time: Date | string;
    migration_ready: boolean;
    schema_objects_ready: boolean;
    constraints_ready: boolean;
  }>(
    `
      select
        now() as database_time,
        exists (
          select 1
          from public.schema_migrations
          where filename = $1
        ) as migration_ready,
        (
          select count(*) = 12
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = 'public'
            and relation.relkind = 'r'
            and relation.relname = any ($2::text[])
        ) as schema_objects_ready,
        (
          select count(*) = 25
          from pg_constraint constraint_record
          join pg_namespace namespace
            on namespace.oid = constraint_record.connamespace
          where namespace.nspname = 'public'
            and constraint_record.conname = any ($3::text[])
        ) as constraints_ready
    `,
    [
      CONTENT_SCHEMA_MIGRATION,
      [
        "content_assets",
        "content_articles",
        "content_article_drafts",
        "content_article_versions",
        "content_routes",
        "content_asset_usages",
        "content_publication_jobs",
        "content_outbox",
        "content_storage_deletion_jobs",
        "content_audit_events",
        "admin_service_principals",
        "admin_service_credentials",
      ],
      [
        "uq_content_article_versions_id_article",
        "fk_content_articles_published_version_owner",
        "fk_content_articles_scheduled_version_owner",
        "fk_content_asset_usages_version_owner",
        "fk_content_publication_jobs_version_owner",
        "fk_content_outbox_version_owner",
        "content_outbox_version_id_fkey",
        "content_assets_payload_size_check",
        "content_assets_checksum_required_check",
        "content_assets_nonpublic_quarantine_check",
        "content_article_drafts_document_size_check",
        "content_article_drafts_plain_text_size_check",
        "content_article_versions_document_size_check",
        "content_article_versions_plain_text_size_check",
        "content_outbox_payload_size_check",
        "content_audit_metadata_size_check",
        "content_article_drafts_content_kind_check",
        "content_article_versions_content_kind_check",
        "content_article_drafts_editorial_graph_check",
        "content_article_versions_editorial_graph_check",
        "admin_service_principals_status_check",
        "admin_service_credentials_permissions_check",
        "content_audit_events_actor_kind_check",
        "content_audit_events_actor_label_check",
        "content_audit_events_actor_contract_check",
      ],
    ],
  );
  const row = rows[0];
  if (
    !row?.migration_ready ||
    !row.schema_objects_ready ||
    !row.constraints_ready
  ) {
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
