import assert from "node:assert/strict";

import { loadTelegramAppHandoffProjection } from "./services/telegram-bot-trading.js";

const baseRow = {
  action: "buy" as const,
  amount_usd: "5.00",
  error_code: null,
  error_message: null,
  event_title: "Will the event happen?",
  execution_id: null,
  funding_operation_id: null,
  funding_progress_stage: null,
  funding_status: null,
  id: "00000000-0000-4000-8000-000000000002",
  market_title: "Main market",
  minimum_receive_raw: null,
  order_id: null,
  outcomes: JSON.stringify(["Yes", "No"]),
  result: {},
  side: "YES" as const,
  shares_raw: null,
  status: "filled",
  tx_signature: "0xabc",
  updated_at: new Date("2026-08-19T00:00:00.000Z"),
  venue: "limitless" as const,
  venue_order_id: null,
};

function dbWithStatus(status: string) {
  return {
    query: async () => ({ rows: [{ ...baseRow, status }] }),
  };
}

const identity = {
  telegramUserId: "42",
  tradeIntentId: baseRow.id,
  userId: "00000000-0000-4000-8000-000000000001",
};

let projectionSql = "";
await loadTelegramAppHandoffProjection(
  {
    query: async (sql: string) => {
      projectionSql = sql;
      return { rows: [] };
    },
  } as never,
  identity,
);
assert.match(
  projectionSql,
  /error_code = 'external_handoff_required'[\s\S]*?appHandoffExecution'[\s\S]*?'version' = '2'[\s\S]*?or handoff\.plan_snapshot ->> 'version' = '2'[\s\S]*?then null/u,
  "a v2 handoff must not project its routing marker as a failure before or after commit",
);
assert.doesNotMatch(
  projectionSql,
  /\bfunding\.(?:status|progress_stage)\b/u,
  "the Mini App query must not treat funding cache fields as lifecycle authority",
);

const filled = await loadTelegramAppHandoffProjection(
  dbWithStatus("filled") as never,
  identity,
);
assert.equal(filled?.stage, "success");
assert.equal(filled?.terminal, true);
assert.equal(filled?.canAutoClose, true);
assert.equal(filled?.outcome, "YES");

const submitted = await loadTelegramAppHandoffProjection(
  dbWithStatus("submitted") as never,
  identity,
);
assert.equal(submitted?.stage, "reconciling");
assert.equal(submitted?.terminal, false);
assert.equal(submitted?.canAutoClose, false);
assert.equal(submitted?.continuesInBackground, true);

const failed = await loadTelegramAppHandoffProjection(
  dbWithStatus("failed") as never,
  identity,
);
assert.equal(failed?.stage, "failed");
assert.equal(failed?.terminal, true);
assert.equal(failed?.canAutoClose, false);

const sold = await loadTelegramAppHandoffProjection(
  {
    query: async () => ({
      rows: [
        {
          ...baseRow,
          action: "sell" as const,
          amount_usd: null,
          minimum_receive_raw: "1234500",
          shares_raw: "7000000",
        },
      ],
    }),
  } as never,
  identity,
);
assert.equal(sold?.action, "sell");
assert.equal(sold?.sharesRaw, "7000000");
assert.equal(sold?.minimumReceiveRaw, "1234500");

console.log("[telegram-app-handoff-projection-tests] passed");
