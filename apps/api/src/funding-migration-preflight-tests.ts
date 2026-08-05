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
          params[0].includes("0199_telegram_funding_receive.sql"),
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
assert.deepEqual(report.blockers, []);
assert.equal(report.latestMigration, "0182_telegram_bot_action_outbox.sql");
assert.equal(report.bridgeOrders.total, 256);
assert.equal(report.bridgeOrders.unknown, 0);
assert.equal(report.bridgeOrders.mismatch, null);
assert.equal(report.observationDuplicatePhysicalKeys, null);
assert.equal(
  statements.some((sql) =>
    /^(insert|update|delete|alter|create|drop)\b/.test(sql),
  ),
  false,
);
console.log("[funding-migration-preflight-tests] passed");
