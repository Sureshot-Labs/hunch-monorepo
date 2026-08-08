import assert from "node:assert/strict";

import { inspectTelegramTradingMigrationPreflight } from "./telegram-trading-migration-preflight.js";

function fakeDb(input: { applied: boolean; definition: string | null }) {
  return {
    query: async (sql: string) => {
      const normalized = sql.replaceAll(/\s+/g, " ").toLowerCase();
      if (normalized.includes("from public.schema_migrations")) {
        return { rows: [{ applied: input.applied }] };
      }
      if (normalized.includes("from pg_constraint")) {
        return {
          rows:
            input.definition == null ? [] : [{ definition: input.definition }],
        };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
  };
}

const definition = `CHECK (
  (action = 'buy' AND amount_usd IS NOT NULL AND amount_usd > 0
    AND sell_percent IS NULL AND shares_raw IS NULL)
  OR (action = 'sell' AND amount_usd IS NULL
    AND (sell_percent IS NULL OR (sell_percent > 0 AND sell_percent <= 100))
    AND shares_raw IS NOT NULL AND shares_raw ~ '^[0-9]+$'
    AND shares_raw::numeric > 0)
  OR (action = 'redeem' AND amount_usd IS NULL AND sell_percent IS NULL
    AND shares_raw IS NULL AND side IS NULL)
)`;

assert.deepEqual(
  (
    await inspectTelegramTradingMigrationPreflight(
      fakeDb({ applied: true, definition }) as never,
    )
  ).blockers,
  [],
);
assert.deepEqual(
  (
    await inspectTelegramTradingMigrationPreflight(
      fakeDb({ applied: false, definition: null }) as never,
    )
  ).blockers,
  ["0202_telegram_custom_sell_amount.sql is not recorded"],
);
assert.deepEqual(
  (
    await inspectTelegramTradingMigrationPreflight(
      fakeDb({ applied: true, definition: "CHECK (action = 'sell')" }) as never,
    )
  ).blockers,
  ["0202 is recorded but the Telegram sell payload constraint is incomplete"],
);
assert.deepEqual(
  (
    await inspectTelegramTradingMigrationPreflight(
      fakeDb({ applied: false, definition }) as never,
    )
  ).blockers,
  [
    "0202_telegram_custom_sell_amount.sql is not recorded",
    "Telegram custom sell constraint exists before 0202 is recorded",
  ],
);

console.log("[telegram-trading-migration-preflight-tests] passed");
