import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

const identifier = String.raw`(?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*)`;
const concurrentIndex = new RegExp(
  String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?(${identifier})\s+ON\s+(ONLY\s+)?(${identifier}(?:\s*\.\s*${identifier})?)\s*([\s\S]+)$`,
  "iu",
);

function withoutLeadingComments(statement: string): string {
  return statement
    .replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/u, "")
    .trim();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

type IndexTarget = {
  table_oid: string;
  schema_name: string;
  index_name: string;
  index_oid: string | null;
};

async function resolveTarget(
  client: PoolClient,
  tableName: string,
  indexName: string,
): Promise<IndexTarget | undefined> {
  const result = await client.query<IndexTarget>(
    `SELECT source_relation.oid::text AS table_oid,
            source_namespace.nspname AS schema_name,
            (parse_ident($2, true))[1] AS index_name,
            index_relation.oid::text AS index_oid
       FROM pg_class AS source_relation
       JOIN pg_namespace AS source_namespace ON source_namespace.oid = source_relation.relnamespace
       LEFT JOIN pg_class AS index_relation
         ON index_relation.relnamespace = source_namespace.oid
        AND index_relation.relname = (parse_ident($2, true))[1]
      WHERE source_relation.oid = to_regclass($1)`,
    [tableName, indexName],
  );
  return result.rows[0];
}

type IndexFacts = {
  table_oid: string;
  is_valid: boolean;
  is_live: boolean;
  has_constraint: boolean;
  is_building: boolean;
  signature: unknown;
};

async function indexFacts(
  client: PoolClient,
  indexOid: string,
): Promise<IndexFacts | undefined> {
  const result = await client.query<IndexFacts>(
    `SELECT index_metadata.indrelid::text AS table_oid,
            index_metadata.indisvalid AS is_valid,
            index_metadata.indislive AS is_live,
            EXISTS (SELECT 1 FROM pg_constraint AS index_constraint
                    WHERE index_constraint.conindid = index_relation.oid) AS has_constraint,
            EXISTS (SELECT 1 FROM pg_stat_progress_create_index AS index_progress
                    WHERE index_progress.index_relid = index_relation.oid) AS is_building,
            jsonb_build_object(
              'accessMethod', index_relation.relam::text,
              'unique', index_metadata.indisunique,
              'primary', index_metadata.indisprimary,
              'exclusion', index_metadata.indisexclusion,
              'immediate', index_metadata.indimmediate,
              'nullsNotDistinct', index_metadata.indnullsnotdistinct,
              'keyCount', index_metadata.indnkeyatts,
              'attributeCount', index_metadata.indnatts,
              'keys', ARRAY(SELECT pg_get_indexdef(index_relation.oid, index_column_number, false)
                            FROM generate_series(1, index_metadata.indnatts) AS index_column_number),
              'predicate', pg_get_expr(index_metadata.indpred, index_metadata.indrelid, false),
              'operatorClasses', index_metadata.indclass::text,
              'collations', index_metadata.indcollation::text,
              'keyOptions', index_metadata.indoption::text,
              'storageOptions', ARRAY(SELECT option_value FROM unnest(index_relation.reloptions) AS option_value ORDER BY option_value),
              'tablespace', index_relation.reltablespace::text
            ) AS signature
       FROM pg_index AS index_metadata
       JOIN pg_class AS index_relation ON index_relation.oid = index_metadata.indexrelid
      WHERE index_relation.oid = $1::oid`,
    [indexOid],
  );
  return result.rows[0];
}

/** Resume only an exact, independently owned concurrent-index stage. PostgreSQL
 * compiles the expected definition on an empty clone; no production rows are
 * scanned/copied to compare expressions, predicates, INCLUDE or operator classes.
 * Unrecognized syntax follows the ordinary SQL path and never triggers a drop. */
export async function runConcurrentIndexStage(
  client: PoolClient,
  statement: string,
): Promise<void> {
  const parsed = concurrentIndex.exec(withoutLeadingComments(statement));
  if (!parsed) {
    await client.query(statement);
    return;
  }
  const [, unique, indexName, only, tableName, definition] = parsed;
  const target = await resolveTarget(client, tableName, indexName);
  if (!target?.index_oid) {
    await client.query(statement);
    return;
  }
  const mismatch = () =>
    new Error(
      `Cannot resume concurrent index ${target.schema_name}.${target.index_name}: existing relation is not the expected independent index. Inspect it without dropping unrelated data.`,
    );
  const existing = await indexFacts(client, target.index_oid);
  if (
    !existing ||
    existing.table_oid !== target.table_oid ||
    existing.has_constraint ||
    existing.is_building ||
    !existing.is_live
  )
    throw mismatch();

  const nonce = randomUUID().replaceAll("-", "");
  const cloneName = `migration_index_table_${nonce}`;
  const expectedName = `migration_index_expected_${nonce}`;
  const clone = `pg_temp.${quoteIdentifier(cloneName)}`;
  let expected: IndexFacts | undefined;
  try {
    await client.query(
      `CREATE TEMP TABLE ${quoteIdentifier(cloneName)} (LIKE ${tableName})`,
    );
    await client.query(
      `CREATE ${unique ?? ""}INDEX ${quoteIdentifier(expectedName)} ON ${only ?? ""}${clone} ${definition}`,
    );
    const expectedOid = await client.query<{ index_oid: string }>(
      `SELECT to_regclass($1)::oid::text AS index_oid`,
      [`pg_temp.${expectedName}`],
    );
    expected = await indexFacts(client, expectedOid.rows[0].index_oid);
  } finally {
    await client.query(`DROP TABLE IF EXISTS ${clone}`);
  }
  if (
    !expected ||
    JSON.stringify(existing.signature) !== JSON.stringify(expected.signature)
  )
    throw mismatch();

  // Re-resolve the exact namespace/name/table and catalog facts immediately
  // before either preserving or dropping. The outer migration advisory lock
  // serializes migrators, not unrelated DDL or an in-flight concurrent builder.
  const currentTarget = await resolveTarget(client, tableName, indexName);
  const current = await indexFacts(client, target.index_oid);
  if (
    currentTarget?.index_oid !== target.index_oid ||
    currentTarget.table_oid !== target.table_oid ||
    !current ||
    current.table_oid !== target.table_oid ||
    current.has_constraint ||
    current.is_building ||
    !current.is_live ||
    JSON.stringify(current.signature) !== JSON.stringify(expected.signature)
  )
    throw mismatch();
  if (current.is_valid) return;
  await client.query(
    `DROP INDEX CONCURRENTLY ${quoteIdentifier(target.schema_name)}.${quoteIdentifier(target.index_name)}`,
  );
  await client.query(statement);
}
