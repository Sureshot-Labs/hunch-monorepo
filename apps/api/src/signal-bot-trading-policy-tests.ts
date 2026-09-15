import assert from "node:assert/strict";
import type { DbQuery } from "./db.js";
import {
  getDefaultSignalBotPolicy,
  resolveSignalBotTradingPolicyFromDb,
  resolveSignalBotTradingPolicyStateFromDb,
} from "./services/signal-bot-trading-policy.js";

assert.equal(getDefaultSignalBotPolicy().maxSlippageBps, 100);
for (const override of [
  null,
  {},
  { maxSlippageBps: 100 },
  { maxSlippageBps: 500 },
]) {
  const db = {
    query: async () => ({
      rows: override == null ? [] : [{ id: "policy-test", payload: override }],
    }),
  } as unknown as DbQuery;
  const expected = override?.maxSlippageBps ?? 100;
  assert.equal(
    (await resolveSignalBotTradingPolicyFromDb(db)).maxSlippageBps,
    expected,
  );
  assert.equal(
    (await resolveSignalBotTradingPolicyStateFromDb(db)).policy.maxSlippageBps,
    expected,
  );
}
console.log("signal bot trading policy tests passed");
