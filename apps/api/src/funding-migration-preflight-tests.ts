import assert from "node:assert/strict";

import { inspectFundingMigrationPreflight } from "./funding-migration-preflight.js";

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
          params[0].includes("0204_delegated_funding_execution.sql"),
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
  "Telegram funding open mutation constraints exist before 0201 is recorded",
]);

function buildTelegram0203Db(
  input: Readonly<{
    applied: boolean;
    completeObjects: boolean;
    rearmDefinition?: boolean;
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
                     $$`
                  : input.completeObjects && input.rearmDefinition !== false
                    ? `create function rearm_telegram_funding_delivery(
                     target_telegram_user_id text,
                     target_telegram_account_id uuid
                   ) returns integer language plpgsql as $$
                   begin
                     if delivered.state_revision = context.latest_terminal_revision
                        and delivered.telegram_account_id = target_telegram_account_id
                        and delivered.status = 'sent' then
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
]);
assert.equal(telegram0203Ready.telegramBuyContinuationObjects, true);

const telegram0203RecordedIncomplete = await inspectFundingMigrationPreflight(
  buildTelegram0203Db({ applied: true, completeObjects: false }) as never,
);
assert.deepEqual(telegram0203RecordedIncomplete.blockers, [
  "0204 delegated funding execution migration is not recorded",
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
  "Telegram funding Buy continuation objects exist before 0203 is recorded",
]);
console.log("[funding-migration-preflight-tests] passed");
