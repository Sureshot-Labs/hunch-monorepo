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
const MIGRATION_0201 = "0201_telegram_funding_open_idempotency.sql";
const MIGRATION_0203 = "0203_telegram_funding_buy_continuation.sql";
const MIGRATION_0204 = "0204_delegated_funding_execution.sql";
const FUNDING_MIGRATIONS = [
  MIGRATION_0184,
  MIGRATION_0193,
  MIGRATION_0194,
  MIGRATION_0195,
  MIGRATION_0196,
  MIGRATION_0197,
  MIGRATION_0199,
  MIGRATION_0200,
  MIGRATION_0201,
  MIGRATION_0203,
  MIGRATION_0204,
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
  telegramBuyContinuationObjects: boolean;
  delegatedFundingExecutionObjects: boolean;
  telegramOpenMutationConstraints: boolean;
}>;

function migrationObjectDrift(
  input: Readonly<{
    applied: boolean;
    complete: boolean;
    incompleteMessage: string;
    present: boolean;
    presentBeforeMigrationMessage: string;
  }>,
): string[] {
  const blockers: string[] = [];
  if (!input.applied && input.present) {
    blockers.push(input.presentBeforeMigrationMessage);
  }
  if (input.applied && !input.complete) {
    blockers.push(input.incompleteMessage);
  }
  return blockers;
}

async function queryExists(
  db: DbQuery,
  sql: string,
  params: readonly unknown[],
): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(sql, [...params]);
  return rows[0]?.exists === true;
}

async function relationExists(db: DbQuery, relation: string): Promise<boolean> {
  return queryExists(db, "select to_regclass($1)::text is not null as exists", [
    relation,
  ]);
}

async function columnExists(
  db: DbQuery,
  table: string,
  column: string,
): Promise<boolean> {
  return queryExists(
    db,
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
}

async function columnsExist(
  db: DbQuery,
  table: string,
  columns: readonly string[],
): Promise<boolean> {
  for (const column of columns) {
    if (!(await columnExists(db, table, column))) return false;
  }
  return true;
}

async function triggerExists(
  db: DbQuery,
  table: string,
  trigger: string,
): Promise<boolean> {
  return queryExists(
    db,
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
}

function normalizedDefinitionIncludes(
  definition: string | null | undefined,
  fragments: readonly string[],
): boolean {
  const normalized = definition
    ?.replaceAll('"', "")
    .replaceAll(/\s+/g, " ")
    .toLowerCase();
  return Boolean(
    normalized && fragments.every((fragment) => normalized.includes(fragment)),
  );
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
  return normalizedDefinitionIncludes(rows[0]?.definition, fragments);
}

async function functionDefinitionIncludes(
  db: DbQuery,
  functionName: string,
  fragments: readonly string[],
): Promise<boolean> {
  let rows: Array<{ definition: string | null }>;
  try {
    ({ rows } = await db.query<{ definition: string | null }>(
      `
        select pg_get_functiondef(procedure.oid) as definition
        from pg_proc procedure
        join pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'public' and procedure.proname = $1
        order by procedure.oid desc
        limit 1
      `,
      [functionName],
    ));
  } catch {
    return false;
  }
  return normalizedDefinitionIncludes(rows[0]?.definition, fragments);
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
  const hasTelegramFundingBuyReturns = await relationExists(
    db,
    "public.telegram_funding_buy_return_revisions",
  );
  const hasTelegramFundingBuyContinuations = await relationExists(
    db,
    "public.telegram_funding_buy_continuations",
  );
  const hasTelegramFundingBuyGenerations = await relationExists(
    db,
    "public.telegram_funding_buy_resume_generations",
  );
  const hasTelegramFundingAuthorizations = await relationExists(
    db,
    "public.telegram_funding_authorizations",
  );
  const hasDelegatedFundingAuthorizationShape =
    hasTelegramFundingAuthorizations &&
    (await columnsExist(db, "telegram_funding_authorizations", [
      "user_id",
      "telegram_account_id",
      "user_wallet_id",
      "privy_wallet_id",
      "profile_id",
      "security_class",
      "signer_fingerprint",
      "policy_fingerprint",
      "venue_binding_option_id",
      "source_asset_id",
      "destination_asset_id",
      "revoked_at",
    ]));
  const hasDelegatedFundingAuthorizationGuard =
    hasTelegramFundingAuthorizations &&
    (await triggerExists(
      db,
      "public.telegram_funding_authorizations",
      "telegram_funding_authorizations_guard",
    ));
  const hasDelegatedFundingActiveIndex =
    hasTelegramFundingAuthorizations &&
    (await indexPredicateIncludes(
      db,
      "telegram_funding_authorizations_active_profile_idx",
      ["revoked_at", "is null"],
    ));
  const hasUnlimitedAutomationConsent =
    hasTelegramFundingAuthorizations &&
    hasTelegramFundingConsents &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_consents",
      "telegram_funding_consents_automation_check",
      [
        "automation_enabled",
        "max_auto_execute_source_raw is null",
        "max_auto_execute_source_raw >",
        "polymarket_usdce_full_receipt_wrap",
        "fullreceipt",
      ],
    ));
  const hasDelegatedAttemptProviderResolution =
    hasTelegramFundingAuthorizations &&
    (await functionDefinitionIncludes(db, "funding_guard_attempt_update", [
      "provider_reference_resolved",
      "provider_failure_resolved",
      "provider_receipt",
    ]));
  const hasDelegatedFundingExecutionObjects =
    hasDelegatedFundingAuthorizationShape &&
    hasDelegatedFundingAuthorizationGuard &&
    hasDelegatedFundingActiveIndex &&
    hasUnlimitedAutomationConsent &&
    hasDelegatedAttemptProviderResolution;
  const hasTelegramFundingActiveBuyReturn =
    hasTelegramFundingSessions &&
    (await columnExists(
      db,
      "telegram_funding_sessions",
      "active_buy_return_revision",
    ));
  const hasTelegramFundingBuyProjectionWatermarks =
    hasTelegramFundingSessions &&
    (await columnsExist(db, "telegram_funding_sessions", [
      "projected_buy_return_revision",
      "projected_buy_policy_revision",
    ]));
  const hasTelegramFundingBuyProjectionConstraint =
    hasTelegramFundingBuyProjectionWatermarks &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_sessions",
      "telegram_funding_sessions_buy_projection_check",
      [
        "projected_buy_return_revision",
        "projected_buy_policy_revision",
        "active_buy_return_revision",
      ],
    ));
  const hasTelegramFundingBuyReturnEvidence =
    hasTelegramFundingBuyReturns &&
    (await columnsExist(db, "telegram_funding_buy_return_revisions", [
      "telegram_account_id_snapshot",
      "source_shortfall_intent_id",
      "source_authority_fingerprint",
    ]));
  const hasTelegramFundingBuyContinuationBinding =
    hasTelegramFundingBuyContinuations &&
    (await columnsExist(db, "telegram_funding_buy_continuations", [
      "policy_revision",
    ]));
  const hasTelegramFundingBuyGenerationIdentity =
    hasTelegramFundingBuyGenerations &&
    (await columnExists(
      db,
      "telegram_funding_buy_resume_generations",
      "telegram_account_id_snapshot",
    ));
  const hasTelegramResumeMutationAction =
    hasTelegramFundingMutations &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_mutations",
      "telegram_funding_mutations_action_check",
      ["set_buy_return", "resume_buy"],
    ));
  const hasTelegramResumeMutationShape =
    hasTelegramFundingMutations &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_mutations",
      "telegram_funding_mutations_action_shape_check",
      [
        "set_buy_return",
        "resume_buy",
        "buy_return_revision is not null",
        "resume_generation is not null",
        "resume_intent_id is not null",
        "continuation_id is not null",
      ],
    ));
  const hasTelegramFundingActiveBuyReturnFk =
    hasTelegramFundingActiveBuyReturn &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_sessions",
      "telegram_funding_sessions_active_buy_return_fk",
      [
        "id",
        "active_buy_return_revision",
        "telegram_funding_session_id",
        "revision",
      ],
    ));
  const hasTelegramBuyContinuationReturnBinding =
    hasTelegramFundingBuyContinuations &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_buy_continuations",
      "telegram_funding_buy_continuations_return_fk",
      ["telegram_funding_session_id", "buy_return_revision"],
    ));
  const hasTelegramBuyGenerationTokenBinding =
    hasTelegramFundingBuyGenerations &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_buy_resume_generations",
      "telegram_funding_buy_generations_continuation_fk",
      [
        "continuation_id",
        "telegram_funding_session_id",
        "buy_return_revision",
        "ready_progress_revision",
      ],
    ));
  const hasTelegramResumeMutationParentBinding =
    hasTelegramFundingMutations &&
    hasTelegramFundingBuyGenerations &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_mutations",
      "telegram_funding_mutations_resume_generation_fk",
      [
        "funding_context_id",
        "resume_generation",
        "buy_return_revision",
        "resume_intent_id",
      ],
    ));
  const hasTelegramResumeMutationContinuationBinding =
    hasTelegramFundingMutations &&
    hasTelegramFundingBuyContinuations &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_mutations",
      "telegram_funding_mutations_resume_continuation_fk",
      ["continuation_id", "funding_context_id", "buy_return_revision"],
    ));
  const hasTelegramBuyEvidenceTriggers =
    hasTelegramFundingBuyReturns &&
    hasTelegramFundingBuyContinuations &&
    hasTelegramFundingBuyGenerations &&
    (await triggerExists(
      db,
      "public.telegram_funding_buy_return_revisions",
      "telegram_funding_buy_returns_binding_guard",
    )) &&
    (await triggerExists(
      db,
      "public.telegram_funding_buy_return_revisions",
      "telegram_funding_buy_returns_evidence_guard",
    )) &&
    (await triggerExists(
      db,
      "public.telegram_funding_buy_continuations",
      "telegram_funding_buy_continuations_evidence_guard",
    )) &&
    (await triggerExists(
      db,
      "public.telegram_funding_buy_resume_generations",
      "telegram_funding_buy_generations_evidence_guard",
    ));
  const hasFundingReceiptVariantMatcher =
    hasTelegramFundingBuyReturns &&
    (await functionDefinitionIncludes(
      db,
      "funding_receive_receipt_matches_frozen_variant",
      ["receive_session_id", "user_id", "variant_id", "destination_address"],
    ));
  const hasTelegramBuyIndexes =
    (await relationExists(
      db,
      "public.telegram_funding_buy_returns_market_idx",
    )) &&
    (await relationExists(
      db,
      "public.telegram_funding_buy_continuations_expiry_idx",
    )) &&
    (await relationExists(
      db,
      "public.telegram_funding_buy_generations_session_desc_idx",
    ));
  const hasTelegramBuyRelinkRearm =
    hasTelegramFundingSessions &&
    (await functionDefinitionIncludes(db, "rearm_telegram_funding_delivery", [
      "delivered.state_revision = context.latest_terminal_revision",
      "delivered.telegram_account_id = target_telegram_account_id",
      "delivered.status = 'sent'",
    ]));
  const hasTelegramBuyContinuationObjects =
    hasTelegramFundingBuyReturns &&
    hasTelegramFundingBuyContinuations &&
    hasTelegramFundingBuyGenerations &&
    hasTelegramFundingActiveBuyReturn &&
    hasTelegramFundingBuyProjectionWatermarks &&
    hasTelegramFundingBuyProjectionConstraint &&
    hasTelegramFundingBuyReturnEvidence &&
    hasTelegramFundingBuyContinuationBinding &&
    hasTelegramFundingBuyGenerationIdentity &&
    hasTelegramResumeMutationAction &&
    hasTelegramResumeMutationShape &&
    hasTelegramFundingActiveBuyReturnFk &&
    hasTelegramBuyContinuationReturnBinding &&
    hasTelegramBuyGenerationTokenBinding &&
    hasTelegramResumeMutationParentBinding &&
    hasTelegramResumeMutationContinuationBinding &&
    hasTelegramBuyEvidenceTriggers &&
    hasFundingReceiptVariantMatcher &&
    hasTelegramBuyIndexes &&
    hasTelegramBuyRelinkRearm;
  const hasTelegramOpenMutationActionConstraint =
    hasTelegramFundingMutations &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_mutations",
      "telegram_funding_mutations_action_check",
      ["open", "select_target", "cancel"],
    ));
  const hasTelegramOpenMutationShapeConstraint =
    hasTelegramFundingMutations &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_mutations",
      "telegram_funding_mutations_action_shape_check",
      [
        "open",
        "cancel",
        "select_target",
        "consent_revision is null",
        "consent_revision is not null",
      ],
    ));
  const hasTelegramOpenMutationConstraints =
    hasTelegramOpenMutationActionConstraint &&
    hasTelegramOpenMutationShapeConstraint;
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
  const hasAnyTelegramReceiveObject =
    hasTelegramFundingSessions ||
    hasTelegramFundingConsents ||
    hasTelegramFundingMutations ||
    hasReceiveOwnerChannel ||
    hasFundingOutboxPayload ||
    hasFundingOutboxDeliveryAttempt;
  const hasCompleteTelegramReceiveObjects =
    hasTelegramFundingSessions &&
    hasTelegramFundingConsents &&
    hasTelegramFundingMutations &&
    hasReceiveOwnerChannel &&
    hasTelegramProjectionWatermark &&
    hasFundingOutboxPayload &&
    hasFundingOutboxDeliveryAttempt &&
    hasSafeWelcomePendingIndex &&
    hasSafeNotificationPendingIndex;
  const migrationDriftChecks = [
    [
      MIGRATION_0184,
      hasFundingOperations,
      "0184 is recorded but funding_operations is absent",
      hasFundingOperations,
      "funding_operations exists before 0184 is recorded",
    ],
    [
      MIGRATION_0194,
      hasObservationDecimals,
      "0194 is recorded but asset_decimals is absent",
      hasObservationDecimals,
      "asset_decimals exists before 0194 is recorded",
    ],
    [
      MIGRATION_0193,
      true,
      "",
      hasPreparationRuns,
      "funding_preparation_runs exists before 0193 is recorded",
    ],
    [
      MIGRATION_0195,
      hasPhysicalObservationIdentity,
      "0195 is recorded but physical observation identity is absent",
      hasPhysicalObservationIdentity,
      "physical observation identity exists before 0195 is recorded",
    ],
    [
      MIGRATION_0196,
      hasOperationExpiry,
      "0196 is recorded but funding operation expiry is absent",
      hasOperationExpiry,
      "funding operation expiry exists before 0196 is recorded",
    ],
    [
      MIGRATION_0197,
      hasImmutableOperationExpiry,
      "0197 is recorded but funding operation expiry immutability is absent",
      hasImmutableOperationExpiry,
      "funding operation expiry immutability exists before 0197 is recorded",
    ],
    [
      MIGRATION_0199,
      hasCompleteTelegramReceiveObjects,
      "0199 is recorded but Telegram funding receive objects are incomplete",
      hasAnyTelegramReceiveObject,
      "Telegram funding receive objects exist before 0199 is recorded",
    ],
    [
      MIGRATION_0200,
      hasRuntimePolicyAdminActor,
      "0200 is recorded but runtime policy admin actor objects are incomplete",
      hasRuntimePolicyAdminActorColumn,
      "runtime policy admin actor exists before 0200 is recorded",
    ],
    [
      MIGRATION_0201,
      hasTelegramOpenMutationConstraints,
      "0201 is recorded but telegram_funding_mutations open constraints are incomplete",
      hasTelegramOpenMutationConstraints,
      "Telegram funding open mutation constraints exist before 0201 is recorded",
    ],
    [
      MIGRATION_0203,
      hasTelegramBuyContinuationObjects,
      "0203 is recorded but Telegram funding Buy continuation objects are incomplete",
      hasTelegramBuyContinuationObjects,
      "Telegram funding Buy continuation objects exist before 0203 is recorded",
    ],
    [
      MIGRATION_0204,
      hasDelegatedFundingExecutionObjects,
      "0204 is recorded but delegated funding execution objects are incomplete",
      hasDelegatedFundingExecutionObjects,
      "Delegated funding execution objects exist before 0204 is recorded",
    ],
  ] as const;
  const partialObjects = migrationDriftChecks.flatMap(
    ([migration, complete, incompleteMessage, present, presentMessage]) =>
      migrationObjectDrift({
        applied: appliedSet.has(migration),
        complete,
        incompleteMessage,
        present,
        presentBeforeMigrationMessage: presentMessage,
      }),
  );

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
    !appliedSet.has(MIGRATION_0201)
      ? "0201 Telegram funding open idempotency migration is not recorded"
      : null,
    !appliedSet.has(MIGRATION_0203)
      ? "0203 Telegram funding Buy continuation migration is not recorded"
      : null,
    !appliedSet.has(MIGRATION_0204)
      ? "0204 delegated funding execution migration is not recorded"
      : null,
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
    telegramBuyContinuationObjects: hasTelegramBuyContinuationObjects,
    delegatedFundingExecutionObjects: hasDelegatedFundingExecutionObjects,
    telegramOpenMutationConstraints: hasTelegramOpenMutationConstraints,
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
    `0201 Telegram open mutation constraints: ${report.telegramOpenMutationConstraints ? "ready" : "missing"}`,
    `0203 Telegram Buy continuation objects: ${report.telegramBuyContinuationObjects ? "ready" : "missing"}`,
    `0204 delegated funding execution objects: ${report.delegatedFundingExecutionObjects ? "ready" : "missing"}`,
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
