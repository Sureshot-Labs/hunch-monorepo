#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";

import { pool, type DbQuery } from "./db.js";

const MIGRATION_0184 = "0184_funding_operations_core.sql";
const MIGRATION_0193 = "0193_funding_preparation_runs.sql";
const MIGRATION_0194 = "0194_funding_recovery_identity_and_trade_intent.sql";
const MIGRATION_0195 = "0195_funding_observation_physical_identity.sql";
const MIGRATION_0196 = "0196_funding_operation_expiry.sql";
const MIGRATION_0197 = "0197_funding_operation_expiry_immutability.sql";
const MIGRATION_0199 = "0199_telegram_funding_receive.sql";
const MIGRATION_0200 = "0200_runtime_policy_admin_actor.sql";
const FUNDING_MIGRATIONS = [
  MIGRATION_0184,
  MIGRATION_0193,
  MIGRATION_0194,
  MIGRATION_0195,
  MIGRATION_0196,
  MIGRATION_0197,
  MIGRATION_0199,
  MIGRATION_0200,
] as const;

const LEGACY_CLASSIFIER_SQL = `
  case
    when provider = 'across'
      and (metadata #> '{across,providerPayload,swapTx}') is not null
      then 'across_swap_api_v1'
    when provider = 'across'
      and (metadata #> '{across,providerPayload,capitalFeePct}') is not null
      then 'across_suggested_fees_v1'
    when provider = 'debridge'
      and swap_type = 'cross_chain'
      and order_id is not null
      and jsonb_typeof(metadata->'estimation') = 'object'
      then 'debridge_dln_create_tx_v1'
    when provider = 'debridge'
      and swap_type = 'same_chain'
      and jsonb_typeof(metadata->'tokenIn') = 'object'
      and jsonb_typeof(metadata->'tokenOut') = 'object'
      then 'debridge_same_chain_v1'
    when provider = 'debridge'
      and swap_type = 'same_chain'
      and jsonb_typeof(metadata->'tx') = 'object'
      then 'debridge_same_chain_tx_v0'
    when provider = 'bungee'
      then 'bungee_legacy_v1'
    else null
  end
`;

export type FundingMigrationPreflightReport = Readonly<{
  appliedFundingMigrations: readonly string[];
  blockers: readonly string[];
  bridgeOrders: Readonly<{
    distribution: Readonly<Record<string, number>>;
    mismatch: number | null;
    total: number;
    unknown: number;
  }>;
  latestMigration: string | null;
  observationDuplicatePhysicalKeys: number | null;
  observationIdentityConstraint: string | null;
  operational: Readonly<{
    invalidIndexes: number | null;
    longTransactions: number | null;
    waitingLocks: number | null;
  }>;
  partialObjects: readonly string[];
  recoveryIdentity: Readonly<{
    observations: number | null;
    recoveryRequiredOperations: number | null;
    tradeAttempts: number | null;
  }>;
}>;

async function relationExists(db: DbQuery, relation: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    "select to_regclass($1)::text is not null as exists",
    [relation],
  );
  return rows[0]?.exists === true;
}

async function columnExists(
  db: DbQuery,
  table: string,
  column: string,
): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = $1
          and column_name = $2
      ) as exists
    `,
    [table, column],
  );
  return rows[0]?.exists === true;
}

async function triggerExists(
  db: DbQuery,
  table: string,
  trigger: string,
): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from pg_trigger
        where tgrelid = $1::regclass
          and tgname = $2
          and not tgisinternal
      ) as exists
    `,
    [table, trigger],
  );
  return rows[0]?.exists === true;
}

async function constraintDefinitionIncludes(
  db: DbQuery,
  table: string,
  constraint: string,
  fragments: readonly string[],
): Promise<boolean> {
  const { rows } = await db.query<{ definition: string | null }>(
    `
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = $1::regclass and conname = $2
    `,
    [table, constraint],
  );
  const definition = rows[0]?.definition
    ?.replaceAll('"', "")
    .replaceAll(/\s+/g, " ")
    .toLowerCase();
  return Boolean(
    definition && fragments.every((fragment) => definition.includes(fragment)),
  );
}

async function indexPredicateIncludes(
  db: DbQuery,
  indexName: string,
  fragments: readonly string[],
): Promise<boolean> {
  const { rows } = await db.query<{ predicate: string | null }>(
    `
      select pg_get_expr(idx.indpred, idx.indrelid) as predicate
      from pg_index idx
      join pg_class relation on relation.oid = idx.indexrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' and relation.relname = $1
    `,
    [indexName],
  );
  const predicate = rows[0]?.predicate?.replaceAll(/\s+/g, " ").toLowerCase();
  return Boolean(
    predicate && fragments.every((fragment) => predicate.includes(fragment)),
  );
}

async function optionalCount(db: DbQuery, sql: string): Promise<number | null> {
  try {
    const { rows } = await db.query<{ count: string }>(sql);
    return Number(rows[0]?.count ?? 0);
  } catch {
    return null;
  }
}

export async function inspectFundingMigrationPreflight(
  db: DbQuery,
): Promise<FundingMigrationPreflightReport> {
  const hasMigrations = await relationExists(db, "public.schema_migrations");
  const appliedRows = hasMigrations
    ? await db.query<{ filename: string }>(
        `
          select filename
          from public.schema_migrations
          where filename = any($1::text[])
          order by filename
        `,
        [Array.from(FUNDING_MIGRATIONS)],
      )
    : { rows: [] };
  const latestRows = hasMigrations
    ? await db.query<{ filename: string }>(
        `
          select filename
          from public.schema_migrations
          order by applied_at desc, id desc
          limit 1
        `,
      )
    : { rows: [] };
  const applied = appliedRows.rows.map((row) => row.filename);
  const appliedSet = new Set(applied);

  const hasBridgeOrders = await relationExists(db, "public.bridge_orders");
  let bridgeTotal = 0;
  let bridgeUnknown = 0;
  let bridgeMismatch: number | null = null;
  const distribution: Record<string, number> = {};
  if (hasBridgeOrders) {
    const { rows } = await db.query<{
      adapter_class: string | null;
      count: string;
    }>(
      `
        select adapter_class, count(*)::text as count
        from (
          select ${LEGACY_CLASSIFIER_SQL} as adapter_class
          from bridge_orders
        ) classified
        group by adapter_class
        order by adapter_class nulls first
      `,
    );
    for (const row of rows) {
      const count = Number(row.count);
      bridgeTotal += count;
      if (row.adapter_class == null) bridgeUnknown += count;
      else distribution[row.adapter_class] = count;
    }
    if (await columnExists(db, "bridge_orders", "adapter_version")) {
      const mismatch = await db.query<{ count: string }>(
        `
          select count(*)::text as count
          from bridge_orders
          where adapter_version is distinct from (${LEGACY_CLASSIFIER_SQL})
        `,
      );
      bridgeMismatch = Number(mismatch.rows[0]?.count ?? 0);
    }
  }

  const hasFundingOperations = await relationExists(
    db,
    "public.funding_operations",
  );
  const hasObservations = await relationExists(
    db,
    "public.funding_observations",
  );
  const hasTradeAttempts = await relationExists(
    db,
    "public.funding_trade_attempts",
  );
  const hasPreparationRuns = await relationExists(
    db,
    "public.funding_preparation_runs",
  );
  const hasTelegramFundingSessions = await relationExists(
    db,
    "public.telegram_funding_sessions",
  );
  const hasTelegramFundingConsents = await relationExists(
    db,
    "public.telegram_funding_consents",
  );
  const hasTelegramFundingMutations = await relationExists(
    db,
    "public.telegram_funding_mutations",
  );
  const hasRuntimePolicies = await relationExists(
    db,
    "public.runtime_policies",
  );
  const hasRuntimePolicyAdminActorColumn =
    hasRuntimePolicies &&
    (await columnExists(db, "runtime_policies", "created_by_admin_id"));
  const hasRuntimePolicyAdminActorFk =
    hasRuntimePolicyAdminActorColumn &&
    (await constraintDefinitionIncludes(
      db,
      "public.runtime_policies",
      "runtime_policies_created_by_admin_id_fkey",
      ["foreign key (created_by_admin_id)", "references admin_accounts(id)"],
    ));
  const hasRuntimePolicySingleCreator =
    hasRuntimePolicyAdminActorColumn &&
    (await constraintDefinitionIncludes(
      db,
      "public.runtime_policies",
      "runtime_policies_single_creator",
      ["num_nonnulls(created_by, created_by_admin_id)", "<= 1"],
    ));
  const hasRuntimePolicyAdminActorIndex = hasRuntimePolicyAdminActorColumn
    ? await indexPredicateIncludes(
        db,
        "idx_runtime_policies_created_by_admin_id",
        ["created_by_admin_id", "is not null"],
      )
    : false;
  const hasRuntimePolicyAdminActor =
    hasRuntimePolicyAdminActorColumn &&
    hasRuntimePolicyAdminActorFk &&
    hasRuntimePolicySingleCreator &&
    hasRuntimePolicyAdminActorIndex;
  const hasReceiveOwnerChannel =
    (await relationExists(db, "public.funding_receive_sessions")) &&
    (await columnExists(db, "funding_receive_sessions", "owner_channel"));
  const hasTelegramProjectionWatermark =
    hasTelegramFundingSessions &&
    (await columnExists(
      db,
      "telegram_funding_sessions",
      "projected_receive_version",
    ));
  const hasFundingOutboxPayload =
    (await relationExists(db, "public.telegram_bot_action_outbox")) &&
    (await columnExists(db, "telegram_bot_action_outbox", "payload"));
  const hasFundingOutboxDeliveryAttempt =
    (await relationExists(db, "public.telegram_bot_action_outbox")) &&
    (await columnExists(
      db,
      "telegram_bot_action_outbox",
      "delivery_attempt_id",
    ));
  const hasSafeWelcomePendingIndex = hasFundingOutboxPayload
    ? await indexPredicateIncludes(
        db,
        "idx_telegram_bot_action_outbox_pending",
        ["welcome_menu", "pending", "retry"],
      )
    : false;
  const hasNotificationOutbox = await relationExists(
    db,
    "public.telegram_notification_outbox",
  );
  const hasSafeNotificationPendingIndex = hasNotificationOutbox
    ? await indexPredicateIncludes(
        db,
        "idx_telegram_notification_outbox_pending",
        ["pending", "retry"],
      )
    : false;
  const hasObservationDecimals =
    hasObservations &&
    (await columnExists(db, "funding_observations", "asset_decimals"));
  const hasOperationExpiry =
    hasFundingOperations &&
    (await columnExists(db, "funding_operations", "expires_at"));
  const hasImmutableOperationExpiry =
    hasFundingOperations &&
    (await triggerExists(
      db,
      "public.funding_operations",
      "funding_operations_immutable_expiry",
    ));
  const observationIdentityConstraint = hasObservations
    ? ((
        await db.query<{ definition: string }>(
          `
            select pg_get_constraintdef(oid) as definition
            from pg_constraint
            where conrelid = 'funding_observations'::regclass
              and conname = 'funding_observations_transfer_unique'
          `,
        )
      ).rows[0]?.definition ?? null)
    : null;
  const hasPhysicalObservationIdentity =
    observationIdentityConstraint
      ?.replaceAll('"', "")
      .replaceAll(/\s+/g, " ")
      .trim()
      .toLowerCase() === "unique (network_id, tx_hash, event_index)";
  const partialObjects = [
    !appliedSet.has(MIGRATION_0184) && hasFundingOperations
      ? "funding_operations exists before 0184 is recorded"
      : null,
    appliedSet.has(MIGRATION_0184) && !hasFundingOperations
      ? "0184 is recorded but funding_operations is absent"
      : null,
    !appliedSet.has(MIGRATION_0194) && hasObservationDecimals
      ? "asset_decimals exists before 0194 is recorded"
      : null,
    appliedSet.has(MIGRATION_0194) && !hasObservationDecimals
      ? "0194 is recorded but asset_decimals is absent"
      : null,
    !appliedSet.has(MIGRATION_0193) && hasPreparationRuns
      ? "funding_preparation_runs exists before 0193 is recorded"
      : null,
    !appliedSet.has(MIGRATION_0195) && hasPhysicalObservationIdentity
      ? "physical observation identity exists before 0195 is recorded"
      : null,
    appliedSet.has(MIGRATION_0195) && !hasPhysicalObservationIdentity
      ? "0195 is recorded but physical observation identity is absent"
      : null,
    !appliedSet.has(MIGRATION_0196) && hasOperationExpiry
      ? "funding operation expiry exists before 0196 is recorded"
      : null,
    appliedSet.has(MIGRATION_0196) && !hasOperationExpiry
      ? "0196 is recorded but funding operation expiry is absent"
      : null,
    !appliedSet.has(MIGRATION_0197) && hasImmutableOperationExpiry
      ? "funding operation expiry immutability exists before 0197 is recorded"
      : null,
    appliedSet.has(MIGRATION_0197) && !hasImmutableOperationExpiry
      ? "0197 is recorded but funding operation expiry immutability is absent"
      : null,
    !appliedSet.has(MIGRATION_0199) &&
    (hasTelegramFundingSessions ||
      hasTelegramFundingConsents ||
      hasTelegramFundingMutations ||
      hasReceiveOwnerChannel ||
      hasFundingOutboxPayload ||
      hasFundingOutboxDeliveryAttempt)
      ? "Telegram funding receive objects exist before 0199 is recorded"
      : null,
    appliedSet.has(MIGRATION_0199) &&
    (!hasTelegramFundingSessions ||
      !hasTelegramFundingConsents ||
      !hasTelegramFundingMutations ||
      !hasReceiveOwnerChannel ||
      !hasTelegramProjectionWatermark ||
      !hasFundingOutboxPayload ||
      !hasFundingOutboxDeliveryAttempt ||
      !hasSafeWelcomePendingIndex ||
      !hasSafeNotificationPendingIndex)
      ? "0199 is recorded but Telegram funding receive objects are incomplete"
      : null,
    !appliedSet.has(MIGRATION_0200) && hasRuntimePolicyAdminActorColumn
      ? "runtime policy admin actor exists before 0200 is recorded"
      : null,
    appliedSet.has(MIGRATION_0200) && !hasRuntimePolicyAdminActor
      ? "0200 is recorded but runtime policy admin actor objects are incomplete"
      : null,
  ].filter((value): value is string => value !== null);

  const recoveryRequiredOperations =
    hasFundingOperations &&
    !appliedSet.has(MIGRATION_0194) &&
    (await columnExists(db, "funding_operations", "status"))
      ? await optionalCount(
          db,
          `
            select count(*)::text as count
            from funding_operations
            where status = 'recovery_required'
          `,
        )
      : null;
  const observationsBefore0194 =
    hasObservations && !appliedSet.has(MIGRATION_0194)
      ? await optionalCount(
          db,
          "select count(*)::text as count from funding_observations",
        )
      : null;
  const tradeAttemptsBefore0194 =
    hasTradeAttempts && !appliedSet.has(MIGRATION_0194)
      ? await optionalCount(
          db,
          "select count(*)::text as count from funding_trade_attempts",
        )
      : null;
  const duplicatePhysicalKeys = hasObservations
    ? await optionalCount(
        db,
        `
          select count(*)::text as count
          from (
            select network_id, tx_hash, event_index
            from funding_observations
            group by network_id, tx_hash, event_index
            having count(*) > 1
          ) duplicate
        `,
      )
    : null;

  const operational = {
    invalidIndexes: await optionalCount(
      db,
      `
        select count(*)::text as count
        from pg_index
        where not indisvalid
      `,
    ),
    waitingLocks: await optionalCount(
      db,
      `
        select count(*)::text as count
        from pg_stat_activity
        where wait_event_type = 'Lock'
          and pid <> pg_backend_pid()
      `,
    ),
    longTransactions: await optionalCount(
      db,
      `
        select count(*)::text as count
        from pg_stat_activity
        where xact_start < now() - interval '5 minutes'
          and pid <> pg_backend_pid()
      `,
    ),
  };

  const blockers = [
    !hasBridgeOrders ? "bridge_orders table is absent" : null,
    bridgeUnknown > 0
      ? `${bridgeUnknown} legacy bridge orders have unknown adapter class`
      : null,
    bridgeMismatch != null && bridgeMismatch > 0
      ? `${bridgeMismatch} bridge orders disagree with the 0184 classifier`
      : null,
    ...partialObjects,
    recoveryRequiredOperations != null && recoveryRequiredOperations > 0
      ? `${recoveryRequiredOperations} recovery_required operations block 0194`
      : null,
    observationsBefore0194 != null && observationsBefore0194 > 0
      ? `${observationsBefore0194} observations block 0194`
      : null,
    tradeAttemptsBefore0194 != null && tradeAttemptsBefore0194 > 0
      ? `${tradeAttemptsBefore0194} trade attempts block 0194`
      : null,
    duplicatePhysicalKeys != null && duplicatePhysicalKeys > 0
      ? `${duplicatePhysicalKeys} duplicate physical observation keys block 0195`
      : null,
    operational.invalidIndexes != null && operational.invalidIndexes > 0
      ? `${operational.invalidIndexes} invalid indexes`
      : null,
  ].filter((value): value is string => value !== null);

  return {
    appliedFundingMigrations: applied,
    blockers,
    bridgeOrders: {
      distribution,
      mismatch: bridgeMismatch,
      total: bridgeTotal,
      unknown: bridgeUnknown,
    },
    latestMigration: latestRows.rows[0]?.filename ?? null,
    observationDuplicatePhysicalKeys: duplicatePhysicalKeys,
    observationIdentityConstraint,
    operational,
    partialObjects,
    recoveryIdentity: {
      observations: observationsBefore0194,
      recoveryRequiredOperations,
      tradeAttempts: tradeAttemptsBefore0194,
    },
  };
}

function formatHuman(report: FundingMigrationPreflightReport): string {
  return [
    `Funding migration preflight: ${report.blockers.length === 0 ? "OK" : "BLOCKED"}`,
    `Latest migration: ${report.latestMigration ?? "none"}`,
    `Bridge orders: total=${report.bridgeOrders.total} unknown=${report.bridgeOrders.unknown} mismatch=${report.bridgeOrders.mismatch ?? "n/a"}`,
    `Class distribution: ${JSON.stringify(report.bridgeOrders.distribution)}`,
    `0194 blockers: ${JSON.stringify(report.recoveryIdentity)}`,
    `0195 duplicate physical keys: ${report.observationDuplicatePhysicalKeys ?? "n/a"}`,
    `0195 physical identity: ${report.observationIdentityConstraint ?? "n/a"}`,
    `Operational: ${JSON.stringify(report.operational)}`,
    ...(report.blockers.length > 0
      ? ["Blockers:", ...report.blockers.map((blocker) => `- ${blocker}`)]
      : []),
  ].join("\n");
}

async function main(): Promise<void> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("begin read only");
    transactionOpen = true;
    const report = await inspectFundingMigrationPreflight(client);
    console.log(
      process.argv.includes("--json")
        ? JSON.stringify(report, null, 2)
        : formatHuman(report),
    );
    if (report.blockers.length > 0) process.exitCode = 1;
    await client.query("rollback");
    transactionOpen = false;
  } finally {
    if (transactionOpen) {
      await client.query("rollback").catch(() => undefined);
    }
    client.release();
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  main().catch((error) => {
    console.error("[funding-migration-preflight]", error);
    process.exitCode = 1;
  });
}
