import assert from "node:assert/strict";

import { loadTelegramAppHandoffProjection } from "./services/telegram-bot-trading.js";

const baseRow = {
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
  order_id: null,
  outcomes: JSON.stringify(["Yes", "No"]),
  result: {},
  side: "YES" as const,
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

console.log("[telegram-app-handoff-projection-tests] passed");
