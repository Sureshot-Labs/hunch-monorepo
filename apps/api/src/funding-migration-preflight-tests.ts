import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { inspectFundingMigrationPreflight } from "./funding-migration-preflight.js";

const migration0206 = await readFile(
  new URL(
    "../../../packages/db/migrations/0206_telegram_funding_wallet_retention.sql",
    import.meta.url,
  ),
  "utf8",
);
assert.match(
  migration0206,
  /disable trigger telegram_funding_consents_evidence_guard/u,
);
assert.match(
  migration0206,
  /enable trigger telegram_funding_consents_evidence_guard/u,
);
assert.match(
  migration0206,
  /jsonb_set\([\s\S]*?'\{presentation\}'[\s\S]*?true\s*\)/u,
  "0206 must create the missing frozen presentation key",
);
assert.match(
  migration0206,
  /latest_progress_projection[\s\S]*?latest_terminal_projection[\s\S]*?outbox\.payload/u,
  "0206 must atomically upgrade retained current/terminal/outbox projections",
);
assert.match(
  migration0206,
  /latest_progress_projection\s*=\s*context\.latest_terminal_projection[\s\S]*?migration-0206-terminal-absorbed/u,
  "0206 must synchronously absorb historical current/terminal split state",
);
assert.match(
  migration0206,
  /funding_terminal_absorbed[\s\S]*?outbox\.status in \('pending', 'retry'\)[\s\S]*?receiveAddress/u,
  "0206 must suppress queued address output for an absorbed terminal context",
);
assert.match(
  migration0206,
  /telegram_bot_action_outbox_address_egress_check[\s\S]*?funding_replacement[\s\S]*?receiveAddress/u,
);
assert.match(
  migration0206,
  /address_disclosure_attempt_revision[\s\S]*?attempt_count > 0/u,
  "0206 must backfill pessimistic redaction obligations from started address delivery",
);
assert.match(
  migration0206,
  /count\(distinct telegram_message_id\)[\s\S]*?address_disclosure_message_id\s*=\s*attempted\.telegram_message_id[\s\S]*?outbox\.telegram_message_id = context\.address_disclosure_message_id/u,
  "0206 must bind redaction proof to one unambiguous immutable message target",
);
assert.match(
  migration0206,
  /from unresolved\s+where telegram_message_id is not null\s+group by funding_session_id\s+having count\(distinct telegram_message_id\) = 1/u,
  "0206 must skip unprovable historical targets instead of blocking deploy",
);
assert.doesNotMatch(
  migration0206,
  /cannot preserve historical Telegram address redaction targets/u,
  "0206 must not contain a data-dependent availability hard fail",
);
assert.match(
  migration0206,
  /review_conversion[\s\S]*?review_receipt_id[\s\S]*?review_quote_id/u,
  "0206 must persist exact Telegram conversion-review replay evidence",
);
assert.match(
  migration0206,
  /create or replace function funding_account_identifier_equal[\s\S]*?identity_scope ~ '\^evm:\[1-9\]\[0-9\]\*\$'[\s\S]*?left_identifier ~ '\^0x\[0-9a-fA-F\]\{40\}\$'[\s\S]*?right_identifier ~ '\^0x\[0-9a-fA-F\]\{40\}\$'[\s\S]*?else left_identifier = right_identifier[\s\S]*?create or replace function funding_receive_receipt_matches_frozen_variant[\s\S]*?funding_account_identifier_equal/u,
  "0206 must case-fold only valid EVM asset and account identities",
);
assert.match(
  migration0206,
  /create or replace function funding_receive_money_is_valid[\s\S]*?create or replace function funding_receive_review_evidence_is_valid[\s\S]*?funding_receive_money_is_valid/u,
  "0206 must validate persisted receive-review evidence structurally",
);
assert.match(
  migration0206,
  /funding_operation_steps[\s\S]*?action_expires_at[\s\S]*?polymarket_deposit_usdce_wrap_v1[\s\S]*?then null/u,
  "0206 must separate provider action validity from operation lifetime",
);
const actionExpiryConstraintIndex = migration0206.indexOf(
  "add constraint funding_operation_steps_action_expiry_check",
);
const actionExpiryBackfillIndex = migration0206.indexOf(
  "update funding_operation_steps step",
);
assert.ok(
  actionExpiryConstraintIndex >= 0 &&
    actionExpiryConstraintIndex < actionExpiryBackfillIndex,
  "0206 must install step DDL before queuing deferred shape-trigger events",
);
assert.match(
  migration0206,
  /new\.wallet_chain = 'ethereum'[\s\S]*?new\.wallet_address ~ '\^0x\[0-9a-fA-F\]\{40\}\$'[\s\S]*?new\.source_network_id ~ '\^evm:\[1-9\]\[0-9\]\*\$'[\s\S]*?else new\.source_asset_id[\s\S]*?new\.destination_network_id ~ '\^evm:\[1-9\]\[0-9\]\*\$'[\s\S]*?else new\.destination_asset_id/u,
  "0206 authorization immutability must preserve case-sensitive identities",
);

const migration0208 = await readFile(
  new URL(
    "../../../packages/db/migrations/0208_relay_evm_delegated_funding.sql",
    import.meta.url,
  ),
  "utf8",
);
assert.match(
  migration0208,
  /refund_recanonicalization[\s\S]*?old\.kind = 'refund_credit'[\s\S]*?old\.network_id = 'evm:8453'[\s\S]*?0x833589fcd6edb6e08f4c7c32d4f71b54bda02913[\s\S]*?relay_owned_refund_observation_v1[\s\S]*?relayRefundCanonicalityHistory/u,
  "0208 must scope refund re-canonicalization to Relay-owned Base USDC observations",
);

const statements: string[] = [];
const db = {
  query: async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    statements.push(normalized);
    if (normalized === "select to_regclass($1)::text is not null as exists") {
      const relation = params[0];
      return {
        rows: [
          {
            exists:
              relation === "public.schema_migrations" ||
              relation === "public.bridge_orders",
          },
        ],
      };
    }
    if (
      normalized.includes("from public.schema_migrations") &&
      normalized.includes("filename = any")
    ) {
      assert.ok(
        Array.isArray(params[0]) &&
          params[0].includes("0199_telegram_funding_receive.sql") &&
          params[0].includes("0200_runtime_policy_admin_actor.sql") &&
          params[0].includes("0201_telegram_funding_open_idempotency.sql") &&
          params[0].includes("0203_telegram_funding_buy_continuation.sql") &&
          params[0].includes("0204_delegated_funding_execution.sql") &&
          params[0].includes("0206_telegram_funding_wallet_retention.sql") &&
          params[0].includes("0207_telegram_funding_owner_delivery.sql") &&
          params[0].includes("0208_relay_evm_delegated_funding.sql") &&
          params[0].includes("0211_funding_receive_receipt_rearm.sql") &&
          params[0].includes("0214_funding_receive_observation_wake.sql"),
      );
      return { rows: [] };
    }
    if (
      normalized.includes("from public.schema_migrations") &&
      normalized.includes("order by applied_at")
    ) {
      return {
        rows: [{ filename: "0182_telegram_bot_action_outbox.sql" }],
      };
    }
    if (
      normalized.includes("from bridge_orders") &&
      normalized.includes("group by adapter_class")
    ) {
      return {
        rows: [
          { adapter_class: "across_swap_api_v1", count: "56" },
          { adapter_class: "across_suggested_fees_v1", count: "87" },
          { adapter_class: "debridge_dln_create_tx_v1", count: "84" },
          { adapter_class: "debridge_same_chain_v1", count: "29" },
        ],
      };
    }
    if (normalized.includes("information_schema.columns")) {
      return { rows: [{ exists: false }] };
    }
    if (
      normalized.includes("from pg_index") ||
      normalized.includes("from pg_stat_activity")
    ) {
      return { rows: [{ count: "0" }] };
    }
    throw new Error(`Unexpected preflight query: ${normalized}`);
  },
};

const report = await inspectFundingMigrationPreflight(db as never);
assert.deepEqual(report.blockers, [
  "0201 Telegram funding open idempotency migration is not recorded",
  "0203 Telegram funding Buy continuation migration is not recorded",
  "0204 delegated funding execution migration is not recorded",
  "0206 delegated funding wallet retention migration is not recorded",
  "0207 Telegram funding owner delivery migration is not recorded",
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
]);
assert.equal(report.latestMigration, "0182_telegram_bot_action_outbox.sql");
assert.equal(report.bridgeOrders.total, 256);
assert.equal(report.bridgeOrders.unknown, 0);
assert.equal(report.bridgeOrders.mismatch, null);
assert.equal(report.observationDuplicatePhysicalKeys, null);
assert.equal(report.telegramOpenMutationConstraints, false);
assert.equal(
  statements.some((sql) =>
    /^(insert|update|delete|alter|create|drop)\b/.test(sql),
  ),
  false,
);

function buildTelegram0201Db(
  input: Readonly<{
    applied: boolean;
    actionConstraintAllowsOpen: boolean;
    shapeConstraintAllowsOpen: boolean;
  }>,
) {
  const schemaRelations = new Set([
    "public.schema_migrations",
    "public.bridge_orders",
    "public.funding_receive_sessions",
    "public.telegram_funding_sessions",
    "public.telegram_funding_consents",
    "public.telegram_funding_mutations",
    "public.telegram_bot_action_outbox",
    "public.telegram_notification_outbox",
  ]);
  const columns = new Set([
    "funding_receive_sessions.owner_channel",
    "telegram_funding_sessions.projected_receive_version",
    "telegram_bot_action_outbox.payload",
    "telegram_bot_action_outbox.delivery_attempt_id",
  ]);
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized === "select to_regclass($1)::text is not null as exists") {
        return { rows: [{ exists: schemaRelations.has(String(params[0])) }] };
      }
      if (
        normalized.includes("from public.schema_migrations") &&
        normalized.includes("filename = any")
      ) {
        return {
          rows: [
            { filename: "0199_telegram_funding_receive.sql" },
            ...(input.applied
              ? [
                  {
                    filename: "0201_telegram_funding_open_idempotency.sql",
                  },
                ]
              : []),
          ],
        };
      }
      if (
        normalized.includes("from public.schema_migrations") &&
        normalized.includes("order by applied_at")
      ) {
        return {
          rows: [
            {
              filename: input.applied
                ? "0201_telegram_funding_open_idempotency.sql"
                : "0199_telegram_funding_receive.sql",
            },
          ],
        };
      }
      if (
        normalized.includes("from bridge_orders") &&
        normalized.includes("group by adapter_class")
      ) {
        return {
          rows: [{ adapter_class: "across_swap_api_v1", count: "1" }],
        };
      }
      if (normalized.includes("information_schema.columns")) {
        return {
          rows: [{ exists: columns.has(`${params[0]}.${params[1]}`) }],
        };
      }
      if (normalized.includes("from pg_constraint")) {
        assert.equal(params[0], "public.telegram_funding_mutations");
        const constraint = params[1];
        assert.ok(
          constraint === "telegram_funding_mutations_action_check" ||
            constraint === "telegram_funding_mutations_action_shape_check",
        );
        return {
          rows: [
            {
              definition:
                constraint === "telegram_funding_mutations_action_check"
                  ? input.actionConstraintAllowsOpen
                    ? "CHECK ((action = ANY (ARRAY['open'::text, 'select_target'::text, 'cancel'::text])))"
                    : "CHECK ((action = ANY (ARRAY['select_target'::text, 'cancel'::text])))"
                  : input.shapeConstraintAllowsOpen
                    ? "CHECK (((action = 'select_target' AND consent_revision IS NOT NULL) OR (action = ANY (ARRAY['open', 'cancel'])) AND consent_revision IS NULL))"
                    : "CHECK (((action = 'select_target' AND consent_revision IS NOT NULL) OR (action = 'cancel' AND consent_revision IS NULL)))",
            },
          ],
        };
      }
      if (normalized.includes("from pg_index idx")) {
        return {
          rows: [
            {
              predicate:
                params[0] === "idx_telegram_bot_action_outbox_pending"
                  ? "action = 'welcome_menu' and status in ('pending', 'retry')"
                  : "status in ('pending', 'retry')",
            },
          ],
        };
      }
      if (
        normalized.includes("from pg_index") ||
        normalized.includes("from pg_stat_activity")
      ) {
        return { rows: [{ count: "0" }] };
      }
      throw new Error(`Unexpected 0201 preflight query: ${normalized}`);
    },
  };
}

const ready = await inspectFundingMigrationPreflight(
  buildTelegram0201Db({
    applied: true,
    actionConstraintAllowsOpen: true,
    shapeConstraintAllowsOpen: true,
  }) as never,
);
assert.deepEqual(ready.blockers, [
  "0203 Telegram funding Buy continuation migration is not recorded",
  "0204 delegated funding execution migration is not recorded",
  "0206 delegated funding wallet retention migration is not recorded",
  "0207 Telegram funding owner delivery migration is not recorded",
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
]);
assert.equal(ready.telegramOpenMutationConstraints, true);

const missingMigration = await inspectFundingMigrationPreflight(
  buildTelegram0201Db({
    applied: false,
    actionConstraintAllowsOpen: false,
    shapeConstraintAllowsOpen: false,
  }) as never,
);
assert.deepEqual(missingMigration.blockers, [
  "0201 Telegram funding open idempotency migration is not recorded",
  "0203 Telegram funding Buy continuation migration is not recorded",
  "0204 delegated funding execution migration is not recorded",
  "0206 delegated funding wallet retention migration is not recorded",
  "0207 Telegram funding owner delivery migration is not recorded",
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
]);

const recordedWithoutConstraint = await inspectFundingMigrationPreflight(
  buildTelegram0201Db({
    applied: true,
    actionConstraintAllowsOpen: false,
    shapeConstraintAllowsOpen: false,
  }) as never,
);
assert.deepEqual(recordedWithoutConstraint.blockers, [
  "0203 Telegram funding Buy continuation migration is not recorded",
  "0204 delegated funding execution migration is not recorded",
  "0206 delegated funding wallet retention migration is not recorded",
  "0207 Telegram funding owner delivery migration is not recorded",
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
  "0201 is recorded but telegram_funding_mutations open constraints are incomplete",
]);

const recordedWithOldShapeConstraint = await inspectFundingMigrationPreflight(
  buildTelegram0201Db({
    applied: true,
    actionConstraintAllowsOpen: true,
    shapeConstraintAllowsOpen: false,
  }) as never,
);
assert.deepEqual(recordedWithOldShapeConstraint.blockers, [
  "0203 Telegram funding Buy continuation migration is not recorded",
  "0204 delegated funding execution migration is not recorded",
  "0206 delegated funding wallet retention migration is not recorded",
  "0207 Telegram funding owner delivery migration is not recorded",
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
  "0201 is recorded but telegram_funding_mutations open constraints are incomplete",
]);

const constraintWithoutLedger = await inspectFundingMigrationPreflight(
  buildTelegram0201Db({
    applied: false,
    actionConstraintAllowsOpen: true,
    shapeConstraintAllowsOpen: true,
  }) as never,
);
assert.deepEqual(constraintWithoutLedger.blockers, [
  "0201 Telegram funding open idempotency migration is not recorded",
  "0203 Telegram funding Buy continuation migration is not recorded",
  "0204 delegated funding execution migration is not recorded",
  "0206 delegated funding wallet retention migration is not recorded",
  "0207 Telegram funding owner delivery migration is not recorded",
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
  "Telegram funding open mutation constraints exist before 0201 is recorded",
]);

function buildTelegram0203Db(
  input: Readonly<{
    applied: boolean;
    completeObjects: boolean;
    postgresNumericConstraint?: boolean;
    rearmDefinition?: boolean;
    strictMatcher?: boolean;
  }>,
) {
  const relations = new Set([
    "public.schema_migrations",
    "public.bridge_orders",
    "public.funding_receive_sessions",
    "public.telegram_funding_sessions",
    "public.telegram_funding_consents",
    "public.telegram_funding_mutations",
    "public.telegram_bot_action_outbox",
    "public.telegram_notification_outbox",
    ...(input.completeObjects
      ? [
          "public.telegram_funding_buy_return_revisions",
          "public.telegram_funding_buy_continuations",
          "public.telegram_funding_buy_resume_generations",
          "public.telegram_funding_buy_returns_market_idx",
          "public.telegram_funding_buy_continuations_expiry_idx",
          "public.telegram_funding_buy_generations_session_desc_idx",
        ]
      : []),
  ]);
  const columns = new Set([
    "funding_receive_sessions.owner_channel",
    "telegram_funding_sessions.projected_receive_version",
    "telegram_bot_action_outbox.payload",
    "telegram_bot_action_outbox.delivery_attempt_id",
    ...(input.completeObjects
      ? [
          "telegram_funding_sessions.active_buy_return_revision",
          "telegram_funding_sessions.minimum_funding_usd",
          "telegram_funding_sessions.projected_buy_return_revision",
          "telegram_funding_sessions.projected_buy_policy_revision",
          "telegram_funding_buy_return_revisions.telegram_account_id_snapshot",
          "telegram_funding_buy_return_revisions.source_shortfall_intent_id",
          "telegram_funding_buy_return_revisions.source_authority_fingerprint",
          "telegram_funding_buy_continuations.policy_revision",
          "telegram_funding_buy_resume_generations.telegram_account_id_snapshot",
        ]
      : []),
  ]);
  const triggers = new Set(
    input.completeObjects
      ? [
          "public.telegram_funding_buy_return_revisions.telegram_funding_buy_returns_binding_guard",
          "public.telegram_funding_buy_return_revisions.telegram_funding_buy_returns_evidence_guard",
          "public.telegram_funding_buy_continuations.telegram_funding_buy_continuations_evidence_guard",
          "public.telegram_funding_buy_resume_generations.telegram_funding_buy_generations_evidence_guard",
        ]
      : [],
  );
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized === "select to_regclass($1)::text is not null as exists") {
        return { rows: [{ exists: relations.has(String(params[0])) }] };
      }
      if (
        normalized.includes("from public.schema_migrations") &&
        normalized.includes("filename = any")
      ) {
        return {
          rows: [
            { filename: "0199_telegram_funding_receive.sql" },
            { filename: "0201_telegram_funding_open_idempotency.sql" },
            ...(input.applied
              ? [
                  {
                    filename: "0203_telegram_funding_buy_continuation.sql",
                  },
                ]
              : []),
          ],
        };
      }
      if (
        normalized.includes("from public.schema_migrations") &&
        normalized.includes("order by applied_at")
      ) {
        return {
          rows: [
            {
              filename: input.applied
                ? "0203_telegram_funding_buy_continuation.sql"
                : "0201_telegram_funding_open_idempotency.sql",
            },
          ],
        };
      }
      if (
        normalized.includes("from bridge_orders") &&
        normalized.includes("group by adapter_class")
      ) {
        return {
          rows: [{ adapter_class: "across_swap_api_v1", count: "1" }],
        };
      }
      if (normalized.includes("information_schema.columns")) {
        return {
          rows: [{ exists: columns.has(`${params[0]}.${params[1]}`) }],
        };
      }
      if (normalized.includes("from pg_constraint")) {
        const constraint = String(params[1]);
        const definitions: Record<string, string> = {
          telegram_funding_mutations_action_check:
            "CHECK (action IN ('open', 'select_target', 'cancel', 'set_buy_return', 'resume_buy'))",
          telegram_funding_mutations_action_shape_check:
            "CHECK ((action = 'select_target' AND consent_revision IS NOT NULL) OR (action = 'set_buy_return' AND buy_return_revision IS NOT NULL) OR (action = 'resume_buy' AND buy_return_revision IS NOT NULL AND resume_generation IS NOT NULL AND resume_intent_id IS NOT NULL AND continuation_id IS NOT NULL) OR (action IN ('open', 'cancel') AND consent_revision IS NULL))",
          telegram_funding_sessions_active_buy_return_fk:
            "FOREIGN KEY (id, active_buy_return_revision) REFERENCES telegram_funding_buy_return_revisions(telegram_funding_session_id, revision)",
          telegram_funding_sessions_buy_projection_check:
            "CHECK ((projected_buy_return_revision = 0 AND projected_buy_policy_revision IS NULL) OR (projected_buy_return_revision > 0 AND projected_buy_policy_revision IS NOT NULL AND active_buy_return_revision IS NOT NULL))",
          telegram_funding_sessions_minimum_funding_check:
            input.postgresNumericConstraint === true
              ? "CHECK ((minimum_funding_usd IS NULL) OR ((origin = 'buy_return_context'::text) AND (minimum_funding_usd > (0)::numeric)))"
              : "CHECK (minimum_funding_usd IS NULL OR (origin = 'buy_return_context' AND minimum_funding_usd > 0))",
          telegram_funding_buy_continuations_return_fk:
            "FOREIGN KEY (telegram_funding_session_id, buy_return_revision) REFERENCES telegram_funding_buy_return_revisions(telegram_funding_session_id, revision)",
          telegram_funding_buy_generations_continuation_fk:
            "FOREIGN KEY (continuation_id, telegram_funding_session_id, buy_return_revision, ready_progress_revision) REFERENCES telegram_funding_buy_continuations(id, telegram_funding_session_id, buy_return_revision, ready_progress_revision)",
          telegram_funding_mutations_resume_generation_fk:
            "FOREIGN KEY (funding_context_id, resume_generation, buy_return_revision, resume_intent_id) REFERENCES telegram_funding_buy_resume_generations(telegram_funding_session_id, generation, buy_return_revision, trade_intent_id)",
          telegram_funding_mutations_resume_continuation_fk:
            "FOREIGN KEY (continuation_id, funding_context_id, buy_return_revision) REFERENCES telegram_funding_buy_continuations(id, telegram_funding_session_id, buy_return_revision)",
        };
        return {
          rows: [
            {
              definition:
                constraint.startsWith("telegram_funding_") &&
                constraint !== "telegram_funding_mutations_action_check" &&
                constraint !==
                  "telegram_funding_mutations_action_shape_check" &&
                !input.completeObjects
                  ? null
                  : (definitions[constraint] ?? null),
            },
          ],
        };
      }
      if (normalized.includes("from pg_trigger")) {
        return {
          rows: [
            {
              exists: triggers.has(`${params[0]}.${params[1]}`),
            },
          ],
        };
      }
      if (normalized.includes("from pg_proc procedure")) {
        const functionName = String(params[0]);
        return {
          rows: [
            {
              definition:
                input.completeObjects &&
                functionName ===
                  "funding_receive_receipt_matches_frozen_variant"
                  ? `create function funding_receive_receipt_matches_frozen_variant(
                       candidate funding_receive_receipts
                     ) returns boolean language sql as $$
                       select candidate.receive_session_id is not null
                         and candidate.user_id is not null
                         and candidate.variant_id is not null
                         and candidate.destination_address is not null
                         ${
                           input.strictMatcher === false
                             ? ""
                             : `and candidate.network_id ~ '^evm:'
                                and candidate.asset_id ~ '^0x'
                                and candidate.destination_address ~ '^0x'`
                         }
                     $$`
                  : input.completeObjects &&
                      functionName === "guard_telegram_funding_session_identity"
                    ? `create function guard_telegram_funding_session_identity()
                       returns trigger language plpgsql as $$
                       begin
                         if new.minimum_funding_usd is distinct from old.minimum_funding_usd then
                           raise exception 'telegram funding session identity is immutable';
                         end if;
                         return new;
                       end $$`
                    : input.completeObjects && input.rearmDefinition !== false
                      ? `create function rearm_telegram_funding_delivery(
                     target_telegram_user_id text,
                     target_telegram_account_id uuid
                   ) returns integer language plpgsql as $$
                   begin
                     if delivered.state_revision = context.latest_terminal_revision
                        and delivered.telegram_account_id = target_telegram_account_id
                        and delivered.status = 'sent' then
                       if address_disclosure_attempt_revision > address_redacted_revision
                          and redaction.state_revision is not null
                          and address_disclosure_message_id is not null
                          and context.telegram_message_id is not null then
                         insert into outbox values ( 'funding_edit' );
                       end if;
                       return 0;
                     end if;
                   end $$`
                      : null,
            },
          ],
        };
      }
      if (normalized.includes("from pg_index idx")) {
        return {
          rows: [
            {
              predicate:
                params[0] === "idx_telegram_bot_action_outbox_pending"
                  ? "action = 'welcome_menu' and status in ('pending', 'retry')"
                  : "status in ('pending', 'retry')",
            },
          ],
        };
      }
      if (
        normalized.includes("from pg_index") ||
        normalized.includes("from pg_stat_activity")
      ) {
        return { rows: [{ count: "0" }] };
      }
      throw new Error(`Unexpected 0203 preflight query: ${normalized}`);
    },
  };
}

const telegram0203Ready = await inspectFundingMigrationPreflight(
  buildTelegram0203Db({ applied: true, completeObjects: true }) as never,
);
assert.deepEqual(telegram0203Ready.blockers, [
  "0204 delegated funding execution migration is not recorded",
  "0206 delegated funding wallet retention migration is not recorded",
  "0207 Telegram funding owner delivery migration is not recorded",
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
]);
assert.equal(telegram0203Ready.telegramBuyContinuationObjects, true);

const telegram0203PostgresNumericConstraint =
  await inspectFundingMigrationPreflight(
    buildTelegram0203Db({
      applied: true,
      completeObjects: true,
      postgresNumericConstraint: true,
    }) as never,
  );
assert.equal(
  telegram0203PostgresNumericConstraint.telegramBuyContinuationObjects,
  true,
  "PostgreSQL numeric casts in pg_get_constraintdef must not produce a false blocker",
);

const telegram0203BroadIdentityMatcher = await inspectFundingMigrationPreflight(
  buildTelegram0203Db({
    applied: true,
    completeObjects: true,
    strictMatcher: false,
  }) as never,
);
assert.equal(
  telegram0203BroadIdentityMatcher.telegramBuyContinuationObjects,
  false,
  "case-folding malformed EVM identities must fail migration preflight",
);

const telegram0203RecordedIncomplete = await inspectFundingMigrationPreflight(
  buildTelegram0203Db({ applied: true, completeObjects: false }) as never,
);
assert.deepEqual(telegram0203RecordedIncomplete.blockers, [
  "0204 delegated funding execution migration is not recorded",
  "0206 delegated funding wallet retention migration is not recorded",
  "0207 Telegram funding owner delivery migration is not recorded",
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
  "0203 is recorded but Telegram funding Buy continuation objects are incomplete",
]);
assert.equal(
  telegram0203RecordedIncomplete.telegramBuyContinuationObjects,
  false,
);

const telegram0203OldRearmFunction = await inspectFundingMigrationPreflight(
  buildTelegram0203Db({
    applied: true,
    completeObjects: true,
    rearmDefinition: false,
  }) as never,
);
assert.deepEqual(telegram0203OldRearmFunction.blockers, [
  "0204 delegated funding execution migration is not recorded",
  "0206 delegated funding wallet retention migration is not recorded",
  "0207 Telegram funding owner delivery migration is not recorded",
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
  "0203 is recorded but Telegram funding Buy continuation objects are incomplete",
]);
assert.equal(
  telegram0203OldRearmFunction.telegramBuyContinuationObjects,
  false,
);

const telegram0203ObjectsBeforeRecord = await inspectFundingMigrationPreflight(
  buildTelegram0203Db({ applied: false, completeObjects: true }) as never,
);
assert.deepEqual(telegram0203ObjectsBeforeRecord.blockers, [
  "0203 Telegram funding Buy continuation migration is not recorded",
  "0204 delegated funding execution migration is not recorded",
  "0206 delegated funding wallet retention migration is not recorded",
  "0207 Telegram funding owner delivery migration is not recorded",
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
  "Telegram funding Buy continuation objects exist before 0203 is recorded",
]);

function buildTelegram0206Db(
  input: Readonly<{
    qrIndexReady: boolean;
    ownerDeliveryReady?: boolean;
    ownerDeliveryRecorded?: boolean;
    malformedReviewEvidence?: number;
    strictAuthorizationIdentity?: boolean;
    strictIdentifierEquality?: boolean;
    unresolvedAddressDisclosures?: number;
  }>,
) {
  const base = buildTelegram0203Db({
    applied: true,
    completeObjects: true,
  });
  const authorizationColumns = new Set([
    "telegram_funding_authorizations.user_id",
    "telegram_funding_authorizations.telegram_account_id",
    "telegram_funding_authorizations.user_wallet_id",
    "telegram_funding_authorizations.privy_wallet_id",
    "telegram_funding_authorizations.profile_id",
    "telegram_funding_authorizations.security_class",
    "telegram_funding_authorizations.signer_fingerprint",
    "telegram_funding_authorizations.policy_fingerprint",
    "telegram_funding_authorizations.venue_binding_option_id",
    "telegram_funding_authorizations.source_asset_id",
    "telegram_funding_authorizations.destination_asset_id",
    "telegram_funding_authorizations.revoked_at",
    "telegram_bot_trading_preferences.funding_operator_revoked_at",
    "telegram_funding_sessions.address_disclosure_attempt_revision",
    "telegram_funding_sessions.address_disclosure_message_id",
    "telegram_funding_sessions.address_delivered_revision",
    "telegram_funding_sessions.address_redacted_revision",
    "telegram_funding_mutations.review_receipt_id",
    "telegram_funding_mutations.review_quote_id",
    "funding_quotes.commit_scope",
    "funding_operation_steps.action_expires_at",
  ]);
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (
        normalized.includes("from public.schema_migrations") &&
        normalized.includes("filename = any")
      ) {
        const ownerDeliveryReady = input.ownerDeliveryReady !== false;
        const ownerDeliveryRecorded =
          input.ownerDeliveryRecorded ?? ownerDeliveryReady;
        return {
          rows: [
            { filename: "0199_telegram_funding_receive.sql" },
            { filename: "0201_telegram_funding_open_idempotency.sql" },
            { filename: "0203_telegram_funding_buy_continuation.sql" },
            { filename: "0204_delegated_funding_execution.sql" },
            { filename: "0206_telegram_funding_wallet_retention.sql" },
            ...(ownerDeliveryRecorded
              ? [{ filename: "0207_telegram_funding_owner_delivery.sql" }]
              : []),
          ],
        };
      }
      if (
        normalized.includes("from public.schema_migrations") &&
        normalized.includes("order by applied_at")
      ) {
        return {
          rows: [
            {
              filename:
                (input.ownerDeliveryRecorded ??
                input.ownerDeliveryReady !== false)
                  ? "0207_telegram_funding_owner_delivery.sql"
                  : "0206_telegram_funding_wallet_retention.sql",
            },
          ],
        };
      }
      if (
        normalized === "select to_regclass($1)::text is not null as exists" &&
        params[0] === "public.telegram_funding_authorizations"
      ) {
        return { rows: [{ exists: true }] };
      }
      if (normalized.includes("information_schema.columns")) {
        const key = `${params[0]}.${params[1]}`;
        if (authorizationColumns.has(key)) {
          return { rows: [{ exists: true }] };
        }
      }
      if (
        normalized.includes("from pg_trigger") &&
        params[1] === "telegram_funding_authorizations_guard"
      ) {
        return { rows: [{ exists: true }] };
      }
      if (normalized.includes("from pg_constraint")) {
        const constraint = String(params[1]);
        const definitions: Record<string, string> = {
          telegram_funding_authorizations_user_wallet_id_fkey:
            "FOREIGN KEY (user_wallet_id) REFERENCES user_wallets(id) ON DELETE SET NULL",
          telegram_funding_consents_automation_check:
            "CHECK (automation_enabled AND max_auto_execute_source_raw IS NULL AND max_auto_execute_source_raw > 0 AND kind = 'polymarket_usdce_full_receipt_wrap' AND fullReceipt = true)",
          telegram_funding_sessions_address_delivery_check:
            "CHECK (((address_disclosure_attempt_revision >= 0) AND (address_disclosure_attempt_revision <= progress_revision) AND (address_delivered_revision >= 0) AND (address_delivered_revision <= progress_revision) AND (address_delivered_revision <= address_disclosure_attempt_revision) AND (address_redacted_revision >= 0) AND (address_redacted_revision <= progress_revision) AND ((address_delivered_revision = 0) OR (address_disclosure_message_id IS NOT NULL)) AND ((address_redacted_revision = 0) OR ((address_disclosure_message_id IS NOT NULL) AND (address_redacted_revision > address_disclosure_attempt_revision)))))",
          telegram_bot_action_outbox_action_check:
            "CHECK (action IN ('welcome_menu', 'funding_send', 'funding_edit', 'funding_replacement', 'funding_qr'))",
          telegram_bot_action_outbox_shape_check:
            "CHECK (action = 'funding_qr' AND funding_session_id IS NOT NULL AND state_revision > 0)",
          telegram_bot_action_outbox_delivery_attempt_check:
            "CHECK (action = 'funding_qr' AND delivery_attempt_id IS NOT NULL AND delivery_started_at IS NOT NULL)",
          telegram_bot_action_outbox_delivery_unknown_check:
            input.ownerDeliveryReady === false
              ? "CHECK (status <> 'delivery_unknown' OR action IN ('welcome_menu', 'funding_send', 'funding_replacement'))"
              : "CHECK (status <> 'delivery_unknown' OR action IN ('welcome_menu', 'funding_send', 'funding_replacement', 'funding_qr'))",
          telegram_bot_action_outbox_address_egress_check:
            "CHECK (action NOT IN ('funding_send', 'funding_replacement') OR payload -> 'receiveAddress' = 'null')",
          telegram_funding_mutations_action_check:
            "CHECK (action IN ('open', 'select_target', 'cancel', 'set_buy_return', 'resume_buy', 'review_conversion'))",
          telegram_funding_mutations_action_shape_check:
            "CHECK (action = 'open' AND consent_revision IS NULL OR action = 'cancel' AND consent_revision IS NULL OR action = 'select_target' AND consent_revision IS NOT NULL OR action = 'set_buy_return' AND buy_return_revision IS NOT NULL OR action = 'resume_buy' AND buy_return_revision IS NOT NULL AND resume_generation IS NOT NULL AND resume_intent_id IS NOT NULL AND continuation_id IS NOT NULL OR action = 'review_conversion' AND review_receipt_id IS NOT NULL AND review_quote_id IS NOT NULL)",
          telegram_funding_mutations_review_receipt_fk:
            "FOREIGN KEY (review_receipt_id) REFERENCES funding_receive_receipts(id) ON DELETE RESTRICT",
          telegram_funding_mutations_review_quote_fk:
            "FOREIGN KEY (review_quote_id) REFERENCES funding_quotes(id) ON DELETE RESTRICT",
          funding_quotes_commit_scope_check:
            "CHECK (commit_scope IS NULL OR commit_scope ->> 'kind' = 'receive_receipt_review_v1' AND commit_scope ? 'ownerChannel' AND commit_scope ? 'receiveSessionId' AND commit_scope ? 'receiptId')",
          funding_operation_steps_action_expiry_check:
            "CHECK (action_expires_at IS NULL OR action_expires_at > created_at)",
        };
        if (constraint in definitions) {
          return { rows: [{ definition: definitions[constraint] }] };
        }
      }
      if (normalized.includes("from pg_proc procedure")) {
        const functionName = String(params[0]);
        if (functionName === "funding_account_identifier_equal") {
          return {
            rows: [
              {
                definition:
                  input.strictIdentifierEquality === false
                    ? "select lower(left_identifier) = lower(right_identifier)"
                    : `identity_scope = 'ethereum'
                       identity_scope ~ '^evm:[1-9][0-9]*$'
                       left_identifier ~ '^0x[0-9a-fA-F]{40}$'
                       right_identifier ~ '^0x[0-9a-fA-F]{40}$'
                       lower(left_identifier) = lower(right_identifier)
                       else left_identifier = right_identifier`,
              },
            ],
          };
        }
        if (functionName === "funding_receive_money_is_valid") {
          return {
            rows: [
              {
                definition:
                  "jsonb_typeof(candidate -> 'asset') = 'object' between 0 and 255 candidate ->> 'raw' ~ '^(0|[1-9][0-9]*)$'",
              },
            ],
          };
        }
        if (functionName === "funding_receive_review_evidence_is_valid") {
          return {
            rows: [
              {
                definition:
                  "reviewContinuation reviewQuotePlan fresh_quote funding_receive_money_is_valid",
              },
            ],
          };
        }
        if (functionName === "funding_guard_attempt_update") {
          return {
            rows: [
              {
                definition:
                  "provider_reference_resolved provider_failure_resolved provider_receipt",
              },
            ],
          };
        }
        if (functionName === "guard_telegram_funding_authorization_update") {
          return {
            rows: [
              {
                definition: `old.user_wallet_id is not null new.user_wallet_id is null new.revoked_at := greatest ${
                  input.strictAuthorizationIdentity === false
                    ? ""
                    : "new.wallet_chain = 'ethereum' new.wallet_address ~ old.wallet_chain = 'ethereum' old.wallet_address ~ new.source_network_id ~ new.source_asset_id ~ new.destination_network_id ~ new.destination_asset_id ~"
                }`,
              },
            ],
          };
        }
        if (functionName === "rearm_telegram_funding_delivery") {
          return {
            rows: [
              {
                definition:
                  input.ownerDeliveryReady === false
                    ? "delivered.state_revision = context.latest_terminal_revision delivered.telegram_account_id = target_telegram_account_id delivered.status = 'sent' address_disclosure_attempt_revision > address_redacted_revision then 'funding_edit' else 'funding_replacement' recovery.delivery_action redaction.state_revision address_disclosure_message_id is not null"
                    : "delivered.state_revision = context.latest_terminal_revision delivered.telegram_account_id = target_telegram_account_id delivered.status = 'sent' address_disclosure_attempt_revision > address_redacted_revision insert into telegram_bot_action_outbox 'funding_edit' redaction.state_revision recovery.delivery_revision address_disclosure_message_id is not null context.telegram_message_id is not null",
              },
            ],
          };
        }
      }
      if (
        normalized.includes("from pg_index idx") &&
        params[0] === "telegram_funding_authorizations_active_profile_idx"
      ) {
        return { rows: [{ predicate: "revoked_at is null" }] };
      }
      if (
        normalized.includes("from pg_index idx") &&
        params[0] === "telegram_bot_action_outbox_funding_qr_unique"
      ) {
        return {
          rows: [
            {
              is_unique: input.qrIndexReady,
              predicate: "action = 'funding_qr'",
            },
          ],
        };
      }
      if (
        normalized.includes("from pg_index idx") &&
        params[0] === "funding_operation_steps_action_claim_idx"
      ) {
        return { rows: [{ predicate: "state = 'action_required'" }] };
      }
      if (
        normalized.includes("from telegram_funding_sessions") &&
        normalized.includes("address_redacted_revision")
      ) {
        return {
          rows: [{ count: String(input.unresolvedAddressDisclosures ?? 0) }],
        };
      }
      if (
        normalized.includes("from funding_receive_receipts") &&
        normalized.includes("funding_receive_review_evidence_is_valid")
      ) {
        return {
          rows: [{ count: String(input.malformedReviewEvidence ?? 0) }],
        };
      }
      return base.query(sql, params);
    },
  };
}

const telegram0206Ready = await inspectFundingMigrationPreflight(
  buildTelegram0206Db({ qrIndexReady: true }) as never,
);
assert.equal(telegram0206Ready.delegatedFundingExecutionObjects, true);
assert.equal(telegram0206Ready.delegatedFundingWalletRetentionObjects, true);
assert.equal(telegram0206Ready.telegramFundingOwnerDeliveryObjects, true);
assert.deepEqual(telegram0206Ready.blockers, [
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
]);
assert.equal(telegram0206Ready.malformedReceiveReviewEvidence, 0);

const telegram0206Only = await inspectFundingMigrationPreflight(
  buildTelegram0206Db({
    qrIndexReady: true,
    ownerDeliveryReady: false,
  }) as never,
);
assert.equal(telegram0206Only.delegatedFundingWalletRetentionObjects, true);
assert.equal(telegram0206Only.telegramFundingOwnerDeliveryObjects, false);
assert.deepEqual(telegram0206Only.blockers, [
  "0207 Telegram funding owner delivery migration is not recorded",
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
]);

const telegram0207ObjectsBeforeRecord = await inspectFundingMigrationPreflight(
  buildTelegram0206Db({
    qrIndexReady: true,
    ownerDeliveryReady: true,
    ownerDeliveryRecorded: false,
  }) as never,
);
assert.equal(
  telegram0207ObjectsBeforeRecord.telegramFundingOwnerDeliveryObjects,
  true,
);
assert.deepEqual(telegram0207ObjectsBeforeRecord.blockers, [
  "0207 Telegram funding owner delivery migration is not recorded",
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
  "Telegram funding owner delivery objects exist before 0207 is recorded",
]);

const telegram0207RecordedIncomplete = await inspectFundingMigrationPreflight(
  buildTelegram0206Db({
    qrIndexReady: true,
    ownerDeliveryReady: false,
    ownerDeliveryRecorded: true,
  }) as never,
);
assert.equal(
  telegram0207RecordedIncomplete.telegramFundingOwnerDeliveryObjects,
  false,
);
assert.deepEqual(telegram0207RecordedIncomplete.blockers, [
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
  "0207 is recorded but Telegram funding owner delivery objects are incomplete",
]);

const telegram0206MalformedReviewEvidence =
  await inspectFundingMigrationPreflight(
    buildTelegram0206Db({
      qrIndexReady: true,
      malformedReviewEvidence: 2,
    }) as never,
  );
assert.equal(
  telegram0206MalformedReviewEvidence.malformedReceiveReviewEvidence,
  2,
  "preflight must expose malformed persisted review evidence for repair",
);

const telegram0206BroadAuthorizationIdentity =
  await inspectFundingMigrationPreflight(
    buildTelegram0206Db({
      qrIndexReady: true,
      strictAuthorizationIdentity: false,
    }) as never,
  );
assert.equal(
  telegram0206BroadAuthorizationIdentity.delegatedFundingWalletRetentionObjects,
  false,
  "case-folding malformed authorization assets must fail migration preflight",
);

const telegram0206BroadIdentifierEquality =
  await inspectFundingMigrationPreflight(
    buildTelegram0206Db({
      qrIndexReady: true,
      strictIdentifierEquality: false,
    }) as never,
  );
assert.equal(
  telegram0206BroadIdentifierEquality.delegatedFundingWalletRetentionObjects,
  false,
  "case-folding malformed or non-EVM identifiers must fail migration preflight",
);

const telegram0206MissingQrIndex = await inspectFundingMigrationPreflight(
  buildTelegram0206Db({ qrIndexReady: false }) as never,
);
assert.equal(
  telegram0206MissingQrIndex.delegatedFundingWalletRetentionObjects,
  false,
);
assert.deepEqual(telegram0206MissingQrIndex.blockers, [
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
  "0206 is recorded but delegated funding wallet retention objects are incomplete",
]);

const telegram0206UnredactableDisclosure =
  await inspectFundingMigrationPreflight(
    buildTelegram0206Db({
      qrIndexReady: true,
      unresolvedAddressDisclosures: 2,
    }) as never,
  );
assert.equal(
  telegram0206UnredactableDisclosure.unresolvedAddressDisclosureWithoutEditTarget,
  2,
);
assert.deepEqual(telegram0206UnredactableDisclosure.blockers, [
  "0208 Relay EVM delegated funding migration is not recorded",
  "0211 funding receipt rearm migration is not recorded",
  "0214 funding receive observation wake migration is not recorded",
  "2 Telegram funding address disclosures lack a redaction edit target",
]);
console.log("[funding-migration-preflight-tests] passed");
