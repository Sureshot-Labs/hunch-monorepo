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
          params[0].includes("0201_telegram_funding_open_idempotency.sql"),
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
assert.deepEqual(ready.blockers, []);
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
]);

const recordedWithoutConstraint = await inspectFundingMigrationPreflight(
  buildTelegram0201Db({
    applied: true,
    actionConstraintAllowsOpen: false,
    shapeConstraintAllowsOpen: false,
  }) as never,
);
assert.deepEqual(recordedWithoutConstraint.blockers, [
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
  "Telegram funding open mutation constraints exist before 0201 is recorded",
]);
console.log("[funding-migration-preflight-tests] passed");
