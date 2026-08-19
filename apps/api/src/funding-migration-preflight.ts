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
const MIGRATION_0206 = "0206_telegram_funding_wallet_retention.sql";
const MIGRATION_0207 = "0207_telegram_funding_owner_delivery.sql";
const MIGRATION_0208 = "0208_relay_evm_delegated_funding.sql";
const MIGRATION_0211 = "0211_funding_receive_receipt_rearm.sql";
const MIGRATION_0214 = "0214_funding_receive_observation_wake.sql";
const MIGRATION_0215 = "0215_telegram_buy_delivery_modes.sql";
const MIGRATION_0216 = "0216_telegram_trade_shortfall_funding.sql";
const MIGRATION_0217 = "0217_telegram_app_handoff_funding_confirmation.sql";
const MIGRATION_0221 = "0221_telegram_app_handoff_intents.sql";
const MIGRATION_0225 = "0225_telegram_app_handoff_execution.sql";
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
  MIGRATION_0206,
  MIGRATION_0207,
  MIGRATION_0208,
  MIGRATION_0211,
  MIGRATION_0214,
  MIGRATION_0215,
  MIGRATION_0216,
  MIGRATION_0217,
  MIGRATION_0221,
  MIGRATION_0225,
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
  malformedReceiveReviewEvidence: number | null;
  unresolvedAddressDisclosureWithoutEditTarget: number | null;
  partialObjects: readonly string[];
  recoveryIdentity: Readonly<{
    observations: number | null;
    recoveryRequiredOperations: number | null;
    tradeAttempts: number | null;
  }>;
  telegramBuyContinuationObjects: boolean;
  delegatedFundingExecutionObjects: boolean;
  delegatedFundingWalletRetentionObjects: boolean;
  telegramFundingOwnerDeliveryObjects: boolean;
  telegramAppHandoffObjects: boolean;
  telegramAppHandoffExecutionObjects: boolean;
  relayEvmDelegatedFundingObjects: boolean;
  telegramOpenMutationConstraints: boolean;
  telegramTradeShortfallFundingObjects: boolean;
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

async function columnAllowsNull(
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
          and is_nullable = 'YES'
      ) as exists
    `,
    [table, column],
  );
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

function normalizeDefinition(
  definition: string | null | undefined,
): string | null {
  return (
    definition?.replaceAll('"', "").replaceAll(/\s+/g, " ").toLowerCase() ??
    null
  );
}

function normalizedDefinitionIncludes(
  definition: string | null | undefined,
  fragments: readonly string[],
): boolean {
  const normalized = normalizeDefinition(definition);
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

async function loadFunctionDefinition(
  db: DbQuery,
  functionName: string,
): Promise<string | null> {
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
    return null;
  }
  return rows[0]?.definition ?? null;
}

async function functionDefinitionIncludes(
  db: DbQuery,
  functionName: string,
  fragments: readonly string[],
): Promise<boolean> {
  return normalizedDefinitionIncludes(
    await loadFunctionDefinition(db, functionName),
    fragments,
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

async function uniqueIndexPredicateIncludes(
  db: DbQuery,
  indexName: string,
  fragments: readonly string[],
): Promise<boolean> {
  const { rows } = await db.query<{
    is_unique: boolean;
    predicate: string | null;
  }>(
    `
      select
        pg_get_expr(idx.indpred, idx.indrelid) as predicate,
        idx.indisunique as is_unique
      from pg_index idx
      join pg_class relation on relation.oid = idx.indexrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' and relation.relname = $1
    `,
    [indexName],
  );
  const row = rows[0];
  const predicate = row?.predicate?.replaceAll(/\s+/g, " ").toLowerCase();
  return Boolean(
    row?.is_unique &&
    predicate &&
    fragments.every((fragment) => predicate.includes(fragment)),
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
  const hasRelayEvmAuthorizationCap =
    hasTelegramFundingAuthorizations &&
    (await columnExists(
      db,
      "telegram_funding_authorizations",
      "max_source_raw",
    )) &&
    (await triggerExists(
      db,
      "public.telegram_funding_authorizations",
      "telegram_funding_authorizations_cap_guard",
    ));
  const hasRelayEvmReservations = await relationExists(
    db,
    "public.telegram_funding_authorization_reservations",
  );
  const hasRelayEvmReservationGuard =
    hasRelayEvmReservations &&
    (await triggerExists(
      db,
      "public.telegram_funding_authorization_reservations",
      "telegram_funding_authorization_reservations_guard",
    ));
  const hasRelayEvmRefundObservationGuard =
    hasRelayEvmReservations &&
    (await functionDefinitionIncludes(db, "funding_guard_observation_update", [
      "refund_recanonicalization",
      "kind = 'refund_credit'",
      "network_id = 'evm:8453'",
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "observerid",
      "relay_owned_refund_observation_v1",
      "relayrefundcanonicalityhistory",
      "old.finality_status = 'reorged'",
      "new.finality_status = 'finalized'",
    ]));
  const hasRelayEvmConsentV3 =
    hasRelayEvmReservations &&
    hasTelegramFundingConsents &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_consents",
      "telegram_funding_consents_automation_check",
      [
        "polymarket_base_usdc_relay",
        "maxsourceraw",
        "max_auto_execute_source_raw",
      ],
    ));
  const hasRelayEvmDelegatedFundingObjects =
    hasRelayEvmAuthorizationCap &&
    hasRelayEvmReservations &&
    hasRelayEvmReservationGuard &&
    hasRelayEvmRefundObservationGuard &&
    hasRelayEvmConsentV3;
  const hasRelayReceiptRearmIndex =
    hasRelayEvmReservations &&
    (await relationExists(
      db,
      "public.telegram_funding_authorization_reservations_receipt_idx",
    ));
  const hasRelayReceiptSingleGenerationConstraint =
    hasRelayEvmReservations &&
    (await queryExists(
      db,
      `select exists (
         select 1
         from pg_constraint constraint_row
         where constraint_row.conrelid = $1::regclass
           and constraint_row.conname = $2
       ) as exists`,
      [
        "public.telegram_funding_authorization_reservations",
        "telegram_funding_authorization_reservations_receipt_unique",
      ],
    ));
  const hasRelayReceiptReallocationGuard =
    hasRelayEvmReservations &&
    (await functionDefinitionIncludes(db, "funding_guard_observation_update", [
      "receipt_reallocation",
      "receivereceiptallocationhistory",
      "previousoperationid",
      "nextoperationid",
      "prior_operation.status in ('failed', 'cancelled')",
      "prior_reservation.status = 'released'",
      "prior_reservation.status = 'cleaned'",
      "'approval_exhausted', 'pre_deposit_failure'",
      "prior_attempt.broadcast_may_have_occurred",
    ]));
  const hasRelayReceiptRearmObjects =
    hasRelayReceiptRearmIndex &&
    !hasRelayReceiptSingleGenerationConstraint &&
    hasRelayReceiptReallocationGuard;
  const hasFundingAccountIdentifierEquality = await functionDefinitionIncludes(
    db,
    "funding_account_identifier_equal",
    [
      "identity_scope = 'ethereum'",
      "identity_scope ~ '^evm:[1-9][0-9]*$'",
      "left_identifier ~ '^0x[0-9a-fa-f]{40}$'",
      "right_identifier ~ '^0x[0-9a-fa-f]{40}$'",
      "lower(left_identifier) = lower(right_identifier)",
      "left_identifier = right_identifier",
    ],
  );
  const hasFundingReceiveReviewEvidenceValidator =
    (await functionDefinitionIncludes(db, "funding_receive_money_is_valid", [
      "jsonb_typeof(candidate -> 'asset') = 'object'",
      "between 0 and 255",
      "candidate ->> 'raw' ~ '^(0|[1-9][0-9]*)$'",
    ])) &&
    (await functionDefinitionIncludes(
      db,
      "funding_receive_review_evidence_is_valid",
      [
        "reviewcontinuation",
        "reviewquoteplan",
        "fresh_quote",
        "funding_receive_money_is_valid",
      ],
    ));
  const hasReceiveReviewQuoteScope =
    (await columnExists(db, "funding_quotes", "commit_scope")) &&
    (await constraintDefinitionIncludes(
      db,
      "public.funding_quotes",
      "funding_quotes_commit_scope_check",
      [
        "receive_receipt_review_v1",
        "ownerchannel",
        "receivesessionid",
        "receiptid",
      ],
    ));
  const hasFundingOperationActionDeadline =
    (await columnExists(db, "funding_operation_steps", "action_expires_at")) &&
    (await constraintDefinitionIncludes(
      db,
      "public.funding_operation_steps",
      "funding_operation_steps_action_expiry_check",
      ["action_expires_at is null", "action_expires_at > created_at"],
    )) &&
    (await indexPredicateIncludes(
      db,
      "funding_operation_steps_action_claim_idx",
      ["state = 'action_required'"],
    ));
  const hasDelegatedFundingWalletRetentionBase =
    hasTelegramFundingAuthorizations &&
    hasFundingAccountIdentifierEquality &&
    hasFundingReceiveReviewEvidenceValidator &&
    hasReceiveReviewQuoteScope &&
    hasFundingOperationActionDeadline &&
    (await columnExists(
      db,
      "telegram_bot_trading_preferences",
      "funding_operator_revoked_at",
    )) &&
    (await columnAllowsNull(
      db,
      "telegram_funding_authorizations",
      "user_wallet_id",
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_authorizations",
      "telegram_funding_authorizations_user_wallet_id_fkey",
      [
        "foreign key (user_wallet_id)",
        "references user_wallets(id)",
        "on delete set null",
      ],
    )) &&
    (await functionDefinitionIncludes(
      db,
      "guard_telegram_funding_authorization_update",
      [
        "old.user_wallet_id is not null",
        "new.user_wallet_id is null",
        "new.revoked_at := greatest",
        "new.wallet_chain = 'ethereum'",
        "new.wallet_address ~",
        "old.wallet_chain = 'ethereum'",
        "old.wallet_address ~",
        "new.source_network_id ~",
        "new.source_asset_id ~",
        "new.destination_network_id ~",
        "new.destination_asset_id ~",
      ],
    ));
  const hasTelegramFundingAddressDeliveryProof =
    hasTelegramFundingSessions &&
    (await columnExists(
      db,
      "telegram_funding_sessions",
      "address_disclosure_attempt_revision",
    )) &&
    (await columnExists(
      db,
      "telegram_funding_sessions",
      "address_disclosure_message_id",
    )) &&
    (await columnExists(
      db,
      "telegram_funding_sessions",
      "address_delivered_revision",
    )) &&
    (await columnExists(
      db,
      "telegram_funding_sessions",
      "address_redacted_revision",
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_sessions",
      "telegram_funding_sessions_address_delivery_check",
      [
        "address_disclosure_attempt_revision >= 0",
        "address_disclosure_attempt_revision <= progress_revision",
        "address_delivered_revision >= 0",
        "address_delivered_revision <= progress_revision",
        "address_delivered_revision <= address_disclosure_attempt_revision",
        "address_redacted_revision >= 0",
        "address_redacted_revision <= progress_revision",
        "(address_delivered_revision = 0) or (address_disclosure_message_id is not null)",
        "address_redacted_revision > address_disclosure_attempt_revision",
      ],
    ));
  const hasTelegramFundingQrOutboxShape =
    hasTelegramFundingAddressDeliveryProof &&
    (await relationExists(db, "public.telegram_bot_action_outbox")) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_bot_action_outbox",
      "telegram_bot_action_outbox_action_check",
      ["funding_qr"],
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_bot_action_outbox",
      "telegram_bot_action_outbox_shape_check",
      ["funding_qr", "funding_session_id is not null", "state_revision > 0"],
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_bot_action_outbox",
      "telegram_bot_action_outbox_delivery_attempt_check",
      ["funding_qr", "delivery_attempt_id is not null"],
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_bot_action_outbox",
      "telegram_bot_action_outbox_address_egress_check",
      ["funding_send", "funding_replacement", "receiveaddress"],
    )) &&
    (await uniqueIndexPredicateIncludes(
      db,
      "telegram_bot_action_outbox_funding_qr_unique",
      ["funding_qr"],
    ));
  const telegramFundingRearmDefinition = await loadFunctionDefinition(
    db,
    "rearm_telegram_funding_delivery",
  );
  const normalizedTelegramFundingRearmDefinition = normalizeDefinition(
    telegramFundingRearmDefinition,
  );
  const hasTelegramFunding0206RelinkRearm =
    hasTelegramFundingAddressDeliveryProof &&
    normalizedDefinitionIncludes(telegramFundingRearmDefinition, [
      "address_disclosure_attempt_revision >",
      "address_redacted_revision",
      "then 'funding_edit'",
      "else 'funding_replacement'",
      "redaction.state_revision",
      "address_disclosure_message_id is not null",
    ]);
  const hasTelegramFundingOwnerEditOnlyRearm =
    hasTelegramFundingAddressDeliveryProof &&
    normalizedDefinitionIncludes(telegramFundingRearmDefinition, [
      "address_disclosure_attempt_revision >",
      "address_redacted_revision",
      "insert into telegram_bot_action_outbox",
      "'funding_edit'",
      "redaction.state_revision",
      "recovery.delivery_revision",
      "address_disclosure_message_id is not null",
      "context.telegram_message_id is not null",
    ]) &&
    Boolean(
      normalizedTelegramFundingRearmDefinition &&
      !normalizedTelegramFundingRearmDefinition.includes(
        "recovery.delivery_action",
      ) &&
      !normalizedTelegramFundingRearmDefinition.includes(
        "set telegram_message_id = null",
      ),
    );
  const hasTelegramFundingQrDeliveryUnknown =
    hasTelegramFundingAddressDeliveryProof &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_bot_action_outbox",
      "telegram_bot_action_outbox_delivery_unknown_check",
      ["delivery_unknown", "funding_qr"],
    ));
  const hasTelegramFundingOwnerDeliveryObjects =
    hasTelegramFundingOwnerEditOnlyRearm && hasTelegramFundingQrDeliveryUnknown;
  const hasTelegramFundingReviewMutationEvidence =
    hasTelegramFundingMutations &&
    (await columnsExist(db, "telegram_funding_mutations", [
      "review_receipt_id",
      "review_quote_id",
    ])) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_mutations",
      "telegram_funding_mutations_action_check",
      ["review_conversion"],
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_mutations",
      "telegram_funding_mutations_action_shape_check",
      [
        "review_conversion",
        "review_receipt_id is not null",
        "review_quote_id is not null",
      ],
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_mutations",
      "telegram_funding_mutations_review_receipt_fk",
      [
        "foreign key (review_receipt_id)",
        "references funding_receive_receipts(id)",
      ],
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_mutations",
      "telegram_funding_mutations_review_quote_fk",
      ["foreign key (review_quote_id)", "references funding_quotes(id)"],
    ));
  const hasDelegatedFundingWalletRetentionObjects =
    hasDelegatedFundingWalletRetentionBase &&
    hasTelegramFundingAddressDeliveryProof &&
    hasTelegramFundingQrOutboxShape &&
    (hasTelegramFunding0206RelinkRearm ||
      hasTelegramFundingOwnerEditOnlyRearm) &&
    hasTelegramFundingReviewMutationEvidence;
  const hasTelegramFundingActiveBuyReturn =
    hasTelegramFundingSessions &&
    (await columnExists(
      db,
      "telegram_funding_sessions",
      "active_buy_return_revision",
    ));
  const hasTelegramFundingMinimumAmount =
    hasTelegramFundingSessions &&
    (await columnExists(
      db,
      "telegram_funding_sessions",
      "minimum_funding_usd",
    )) &&
    ((await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_sessions",
      "telegram_funding_sessions_minimum_funding_check",
      ["minimum_funding_usd", "buy_return_context", "minimum_funding_usd > 0"],
    )) ||
      (await constraintDefinitionIncludes(
        db,
        "public.telegram_funding_sessions",
        "telegram_funding_sessions_minimum_funding_check",
        [
          "minimum_funding_usd",
          "buy_return_context",
          "minimum_funding_usd > (0)::numeric",
        ],
      ))) &&
    (await functionDefinitionIncludes(
      db,
      "guard_telegram_funding_session_identity",
      ["new.minimum_funding_usd", "old.minimum_funding_usd"],
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
    ((await functionDefinitionIncludes(
      db,
      "funding_receive_receipt_matches_frozen_variant",
      [
        "receive_session_id",
        "user_id",
        "variant_id",
        "funding_account_identifier_equal",
        "candidate.network_id",
        "candidate.asset_id",
        "candidate.destination_address",
      ],
    )) ||
      (await functionDefinitionIncludes(
        db,
        "funding_receive_receipt_matches_frozen_variant",
        [
          "receive_session_id",
          "user_id",
          "variant_id",
          "candidate.network_id ~",
          "candidate.asset_id ~",
          "candidate.destination_address ~",
        ],
      )));
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
    normalizedDefinitionIncludes(telegramFundingRearmDefinition, [
      "delivered.state_revision = context.latest_terminal_revision",
      "delivered.telegram_account_id = target_telegram_account_id",
      "delivered.status = 'sent'",
    ]);
  const hasTelegramBuyContinuationObjects =
    hasTelegramFundingBuyReturns &&
    hasTelegramFundingBuyContinuations &&
    hasTelegramFundingBuyGenerations &&
    hasTelegramFundingActiveBuyReturn &&
    hasTelegramFundingMinimumAmount &&
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
  const hasReceiveObservationWake =
    (await relationExists(db, "public.funding_receive_sessions")) &&
    (await columnExists(
      db,
      "funding_receive_sessions",
      "observation_requested_at",
    ));
  const hasTelegramBuyDeliveryModes =
    (await columnExists(db, "telegram_trade_intents", "delivery_mode")) &&
    (await columnExists(
      db,
      "telegram_funding_buy_return_revisions",
      "continuation_mode",
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_trade_intents",
      "telegram_trade_intents_delivery_mode_check",
      ["bot_submit", "app_handoff"],
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_trade_intents",
      "telegram_trade_intents_delivery_authority_check",
      ["delivery_mode = 'bot_submit'", "submit_started_at is null"],
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_buy_return_revisions",
      "telegram_funding_buy_return_continuation_mode_check",
      ["bot_submit", "app_handoff"],
    )) &&
    (await functionDefinitionIncludes(db, "funding_guard_observation_update", [
      "network_id = 'evm:137'",
      "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
      "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
      "receipt_reallocation",
    ]));
  const hasTelegramTradeShortfallFundingObjects =
    (await columnAllowsNull(
      db,
      "telegram_funding_authorization_reservations",
      "receive_receipt_id",
    )) &&
    (await columnExists(
      db,
      "telegram_funding_authorization_reservations",
      "source_trade_intent_id",
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_funding_authorization_reservations",
      "telegram_funding_authorization_reservations_origin_check",
      ["num_nonnulls(receive_receipt_id, source_trade_intent_id) = 1"],
    )) &&
    (await indexPredicateIncludes(
      db,
      "telegram_funding_authorization_reservations_trade_intent_unique",
      ["source_trade_intent_id", "is not null"],
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_trade_intents",
      "telegram_trade_intents_status_check",
      ["funding"],
    )) &&
    (await functionDefinitionIncludes(
      db,
      "guard_telegram_funding_authorization_reservation_update",
      [
        "new.source_trade_intent_id",
        "old.source_trade_intent_id",
        "old.status = 'cleanup_required'",
        "new.status in ('cleaned', 'released')",
      ],
    ));
  const hasTelegramAppHandoffFundingConfirmation =
    await constraintDefinitionIncludes(
      db,
      "public.telegram_trade_intents",
      "telegram_trade_intents_delivery_authority_check",
      ["fundingstate", "fundingproposal", "funding_operation_id is not null"],
    );
  const hasTelegramAppHandoffObjects =
    (await relationExists(db, "public.telegram_app_handoffs")) &&
    (await columnExists(db, "telegram_app_handoffs", "token_hash")) &&
    (await columnExists(db, "telegram_app_handoffs", "plan_fingerprint")) &&
    (await columnExists(db, "telegram_app_handoffs", "policy_revision")) &&
    (await triggerExists(
      db,
      "public.telegram_app_handoffs",
      "telegram_app_handoffs_guard",
    )) &&
    (await constraintDefinitionIncludes(
      db,
      "public.user_telegram_accounts",
      "user_telegram_accounts_user_telegram_unique",
      ["unique (user_id, telegram_user_id)"],
    )) &&
    (await functionDefinitionIncludes(db, "guard_telegram_app_handoff_update", [
      "new.token_hash <> old.token_hash",
      "old.state = 'issued'",
      "new.state = 'claimed'",
      "new.claimed_by_user_id = new.user_id",
      "old.state = 'claimed'",
      "new.state = 'committed'",
    ]));
  const hasTelegramAppHandoffExecutionObjects =
    hasTelegramAppHandoffObjects &&
    (await constraintDefinitionIncludes(
      db,
      "public.telegram_trade_intents",
      "telegram_trade_intents_delivery_authority_check",
      [
        "apphandoffexecution",
        "committedat",
        "'executing'",
        "'filled'",
        "'reconcile_required'",
      ],
    ));
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
    [
      MIGRATION_0206,
      hasDelegatedFundingWalletRetentionObjects,
      "0206 is recorded but delegated funding wallet retention objects are incomplete",
      hasDelegatedFundingWalletRetentionObjects,
      "Delegated funding wallet retention objects exist before 0206 is recorded",
    ],
    [
      MIGRATION_0207,
      hasTelegramFundingOwnerDeliveryObjects,
      "0207 is recorded but Telegram funding owner delivery objects are incomplete",
      hasTelegramFundingOwnerEditOnlyRearm ||
        hasTelegramFundingQrDeliveryUnknown,
      "Telegram funding owner delivery objects exist before 0207 is recorded",
    ],
    [
      MIGRATION_0208,
      hasRelayEvmDelegatedFundingObjects,
      "0208 is recorded but Relay EVM delegated funding objects are incomplete",
      hasRelayEvmDelegatedFundingObjects,
      "Relay EVM delegated funding objects exist before 0208 is recorded",
    ],
    [
      MIGRATION_0211,
      hasRelayReceiptRearmObjects,
      "0211 is recorded but funding receipt rearm objects are incomplete",
      hasRelayReceiptRearmIndex,
      "Funding receipt rearm objects exist before 0211 is recorded",
    ],
    [
      MIGRATION_0214,
      hasReceiveObservationWake,
      "0214 is recorded but the funding receive observation wake column is absent",
      hasReceiveObservationWake,
      "Funding receive observation wake column exists before 0214 is recorded",
    ],
    [
      MIGRATION_0215,
      hasTelegramBuyDeliveryModes,
      "0215 is recorded but Telegram Buy delivery-mode objects are incomplete",
      hasTelegramBuyDeliveryModes,
      "Telegram Buy delivery-mode objects exist before 0215 is recorded",
    ],
    [
      MIGRATION_0216,
      hasTelegramTradeShortfallFundingObjects,
      "0216 is recorded but Telegram trade-shortfall funding objects are incomplete",
      hasTelegramTradeShortfallFundingObjects,
      "Telegram trade-shortfall funding objects exist before 0216 is recorded",
    ],
    [
      MIGRATION_0217,
      hasTelegramAppHandoffFundingConfirmation,
      "0217 is recorded but app-handoff funding confirmation is not safely enabled",
      hasTelegramAppHandoffFundingConfirmation,
      "app-handoff funding confirmation exists before 0217 is recorded",
    ],
    [
      MIGRATION_0221,
      hasTelegramAppHandoffObjects,
      "0221 is recorded but sealed Telegram app-handoff objects are incomplete",
      hasTelegramAppHandoffObjects,
      "sealed Telegram app-handoff objects exist before 0221 is recorded",
    ],
    [
      MIGRATION_0225,
      hasTelegramAppHandoffExecutionObjects,
      "0225 is recorded but committed app-handoff execution is not safely enabled",
      hasTelegramAppHandoffExecutionObjects,
      "committed app-handoff execution exists before 0225 is recorded",
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
  const unresolvedAddressDisclosureWithoutEditTarget =
    hasTelegramFundingAddressDeliveryProof
      ? await optionalCount(
          db,
          `
            select count(*)::text as count
            from telegram_funding_sessions
            where address_disclosure_attempt_revision >
                  address_redacted_revision
              and address_disclosure_message_id is null
          `,
        )
      : null;
  const malformedReceiveReviewEvidence =
    appliedSet.has(MIGRATION_0206) && hasFundingReceiveReviewEvidenceValidator
      ? await optionalCount(
          db,
          `
            select count(*)::text as count
            from funding_receive_receipts
            where status = 'review_required'
              and child_funding_operation_id is null
              and evidence ? 'reviewContinuation'
              and evidence ? 'reviewQuotePlan'
              and not funding_receive_review_evidence_is_valid(evidence)
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
    !appliedSet.has(MIGRATION_0206)
      ? "0206 delegated funding wallet retention migration is not recorded"
      : null,
    !appliedSet.has(MIGRATION_0207)
      ? "0207 Telegram funding owner delivery migration is not recorded"
      : null,
    !appliedSet.has(MIGRATION_0208)
      ? "0208 Relay EVM delegated funding migration is not recorded"
      : null,
    !appliedSet.has(MIGRATION_0211)
      ? "0211 funding receipt rearm migration is not recorded"
      : null,
    !appliedSet.has(MIGRATION_0214)
      ? "0214 funding receive observation wake migration is not recorded"
      : null,
    !appliedSet.has(MIGRATION_0215)
      ? "0215 Telegram Buy delivery-mode migration is not recorded"
      : null,
    !appliedSet.has(MIGRATION_0216)
      ? "0216 Telegram trade-shortfall funding migration is not recorded"
      : null,
    !appliedSet.has(MIGRATION_0217)
      ? "0217 Telegram app-handoff funding confirmation migration is not recorded"
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
    unresolvedAddressDisclosureWithoutEditTarget != null &&
    unresolvedAddressDisclosureWithoutEditTarget > 0
      ? `${unresolvedAddressDisclosureWithoutEditTarget} Telegram funding address disclosures lack a redaction edit target`
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
    malformedReceiveReviewEvidence,
    unresolvedAddressDisclosureWithoutEditTarget,
    partialObjects,
    recoveryIdentity: {
      observations: observationsBefore0194,
      recoveryRequiredOperations,
      tradeAttempts: tradeAttemptsBefore0194,
    },
    telegramBuyContinuationObjects: hasTelegramBuyContinuationObjects,
    delegatedFundingExecutionObjects: hasDelegatedFundingExecutionObjects,
    delegatedFundingWalletRetentionObjects:
      hasDelegatedFundingWalletRetentionObjects,
    telegramFundingOwnerDeliveryObjects: hasTelegramFundingOwnerDeliveryObjects,
    telegramAppHandoffObjects: hasTelegramAppHandoffObjects,
    telegramAppHandoffExecutionObjects: hasTelegramAppHandoffExecutionObjects,
    relayEvmDelegatedFundingObjects: hasRelayEvmDelegatedFundingObjects,
    telegramOpenMutationConstraints: hasTelegramOpenMutationConstraints,
    telegramTradeShortfallFundingObjects:
      hasTelegramTradeShortfallFundingObjects,
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
    `0206 delegated funding wallet retention objects: ${report.delegatedFundingWalletRetentionObjects ? "ready" : "missing"}`,
    `0207 Telegram funding owner delivery objects: ${report.telegramFundingOwnerDeliveryObjects ? "ready" : "missing"}`,
    `0221 sealed Telegram app-handoff objects: ${report.telegramAppHandoffObjects ? "ready" : "missing"}`,
    `0225 committed Telegram app-handoff execution: ${report.telegramAppHandoffExecutionObjects ? "ready" : "missing"}`,
    `0208 Relay EVM delegated funding objects: ${report.relayEvmDelegatedFundingObjects ? "ready" : "missing"}`,
    `Malformed receive review evidence: ${report.malformedReceiveReviewEvidence ?? "n/a"}`,
    `Unresolved address disclosures without edit target: ${report.unresolvedAddressDisclosureWithoutEditTarget ?? "n/a"}`,
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
