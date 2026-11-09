import assert from "node:assert/strict";
import {
  normalizeOpenOrder,
  normalizeTrade,
} from "./services/polymarket-clob-l2.js";
import { readPolymarketFillCandidates } from "./services/verified-buy-polymarket-provider.js";
import { EvidenceBudgetExhausted } from "./services/verified-buy.js";

const owner = `0x${"1".repeat(40)}`,
  orderHash = `0x${"a".repeat(64)}`,
  txHash = `0x${"b".repeat(64)}`;
async function observe(
  options: {
    status?: number;
    raw?: Record<string, unknown>;
    budget?: number;
    failTrade?: boolean;
    foreignTrade?: boolean;
    throwOrder?: boolean;
  } = {},
) {
  const raw = options.raw ?? {
    id: orderHash,
    maker_address: owner,
    asset_id: "123",
    side: "BUY",
    status: "MATCHED",
    size_matched: "2",
    associate_trades: ["trade-a", "trade-a"],
  };
  let consumed = 0;
  const tradeReads: string[] = [];
  const result = await readPolymarketFillCandidates({
    owner,
    orderHash,
    tokenId: "123",
    consume: () => {
      consumed++;
    },
    assertBudget: (needed) => {
      if (needed > (options.budget ?? 10))
        throw new EvidenceBudgetExhausted(needed, options.budget ?? 10);
    },
    readOrder: async () => {
      if (options.throwOrder)
        throw Error("Authenticated URL must stay private");
      return options.status
        ? { ok: false, status: options.status, payload: {} }
        : { ok: true, order: normalizeOpenOrder(raw), payload: raw };
    },
    readTrades: async (id) => {
      tradeReads.push(id);
      const trade = normalizeTrade({
        id,
        taker_order_id: options.foreignTrade ? txHash : orderHash,
        transaction_hash: txHash,
        status: "MINED",
      });
      assert.ok(trade);
      return options.failTrade
        ? { ok: false, status: 503, payload: {} }
        : { ok: true, payload: {}, trades: [trade] };
    },
  });
  return { result, consumed, tradeReads };
}
assert.equal((await observe({ status: 404 })).result.state, "not_found");
for (const status of [401, 429, 500])
  assert.equal((await observe({ status })).result.state, "unavailable");
assert.equal((await observe({ throwOrder: true })).result.state, "unavailable");
assert.equal((await observe({ raw: {} })).result.state, "malformed");
assert.equal(
  (
    await observe({
      raw: {
        id: orderHash,
        maker_address: owner,
        asset_id: "123",
        side: "BUY",
      },
    })
  ).result.state,
  "malformed",
);
assert.equal(
  (
    await observe({
      raw: {
        id: txHash,
        maker_address: owner,
        asset_id: "123",
        side: "BUY",
        associate_trades: [],
      },
    })
  ).result.state,
  "identity_conflict",
);
assert.equal(
  (await observe({ foreignTrade: true })).result.state,
  "identity_conflict",
);
assert.equal((await observe({ failTrade: true })).result.state, "unavailable");
const success = await observe();
assert.deepEqual(success.result, {
  state: "fills",
  fills: [
    {
      venue_trade_id: "trade-a",
      provider_tx_hash: txHash,
      provider_status: "MINED",
    },
  ],
});
assert.equal(success.consumed, 2);
assert.deepEqual(success.tradeReads, ["trade-a"]);
await assert.rejects(observe({ budget: 0 }), EvidenceBudgetExhausted);
const empty = {
  id: orderHash,
  maker_address: owner,
  asset_id: "123",
  side: "BUY",
  associate_trades: [],
};
assert.deepEqual(
  (await observe({ raw: { ...empty, status: "CANCELED", size_matched: "0" } }))
    .result,
  { state: "terminal_zero_fill" },
);
assert.deepEqual(
  (await observe({ raw: { ...empty, status: "CANCELED", size_matched: "1" } }))
    .result,
  { state: "fills", fills: [] },
);
console.log(
  "ok - Polymarket provider outcomes preserve identity, distinguish transport absence and enforce actual request budget",
);
