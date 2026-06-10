#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { tradesRouteTestExports } from "./routes/trades.js";

const {
  fetchHyperliquidRecentTradesForTokenRefs,
  hyperliquidCoinFromHunchTokenId,
  hyperliquidTradesCacheKey,
  selectHyperliquidTokenRefs,
  toTradesResponse,
} = tradesRouteTestExports;

assert.equal(hyperliquidCoinFromHunchTokenId("hyperliquid:100002360"), "#2360");
assert.equal(hyperliquidCoinFromHunchTokenId("polymarket:123"), null);
assert.equal(hyperliquidCoinFromHunchTokenId("hyperliquid:not-a-number"), null);

assert.deepEqual(
  selectHyperliquidTokenRefs(
    [
      "hyperliquid:100002360",
      "hyperliquid:100002360",
      "hyperliquid:100002361",
      "kalshi:ignored",
    ],
    1,
  ),
  [{ tokenId: "hyperliquid:100002360", coin: "#2360" }],
);

assert.equal(
  hyperliquidTradesCacheKey(
    [
      { tokenId: "hyperliquid:100002361", coin: "#2361" },
      { tokenId: "hyperliquid:100002360", coin: "#2360" },
    ],
    50,
    10,
  ),
  "trades:hyperliquid:v1:#2360,#2361:limit:50:offset:10",
);

const fetchedBodies: unknown[] = [];
const fetchResult = await fetchHyperliquidRecentTradesForTokenRefs({
  refs: [
    { tokenId: "hyperliquid:100002360", coin: "#2360" },
    { tokenId: "hyperliquid:100002361", coin: "#2361" },
  ],
  infoUrl: "https://example.test/info",
  timeoutMs: 100,
  fetchFn: async (_input, init) => {
    fetchedBodies.push(JSON.parse(String(init?.body ?? "{}")) as unknown);
    const body = JSON.parse(String(init?.body ?? "{}")) as { coin?: string };
    return {
      ok: true,
      json: async () => [
        {
          coin: body.coin,
          side: body.coin === "#2360" ? "B" : "A",
          px: body.coin === "#2360" ? "0.74529" : "0.25471",
          sz: "20.0",
          time: body.coin === "#2360" ? 1_781_045_950_292 : 1_781_045_944_277,
          hash: `hash-${body.coin}`,
        },
        {
          coin: body.coin,
          side: "bad",
          px: "0.5",
          sz: "1",
          time: 1_781_045_950_292,
        },
      ],
    };
  },
});

assert.deepEqual(fetchedBodies, [
  { type: "recentTrades", coin: "#2360" },
  { type: "recentTrades", coin: "#2361" },
]);
assert.equal(fetchResult.attempted, 2);
assert.equal(fetchResult.failed, 0);
assert.equal(fetchResult.trades.length, 2);

const response = toTradesResponse(fetchResult.trades, 1, 0);
assert.equal(response.trades.length, 1);
assert.equal(response.trades[0]?.tokenId, "hyperliquid:100002360");
assert.equal(response.trades[0]?.venue, "hyperliquid");
assert.equal(response.trades[0]?.price, 0.74529);
assert.equal(response.trades[0]?.size, 20);
assert.equal(response.trades[0]?.side, "BUY");
assert.equal(response.trades[0]?.txHash, "hash-#2360");
assert.equal(response.pagination.total, 2);
assert.equal(response.pagination.hasMore, true);

const offsetResponse = toTradesResponse(fetchResult.trades, 1, 1);
assert.equal(offsetResponse.trades[0]?.tokenId, "hyperliquid:100002361");
assert.equal(offsetResponse.trades[0]?.side, "SELL");
assert.equal(offsetResponse.pagination.hasMore, false);

const partialFailure = await fetchHyperliquidRecentTradesForTokenRefs({
  refs: [
    { tokenId: "hyperliquid:100002360", coin: "#2360" },
    { tokenId: "hyperliquid:100002361", coin: "#2361" },
  ],
  infoUrl: "https://example.test/info",
  timeoutMs: 100,
  fetchFn: async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { coin?: string };
    if (body.coin === "#2361") throw new Error("upstream failed");
    return {
      ok: true,
      json: async () => [
        {
          coin: "#2360",
          side: "B",
          px: "0.5",
          sz: "1",
          time: 1_781_045_950_292,
        },
      ],
    };
  },
});

assert.equal(partialFailure.attempted, 2);
assert.equal(partialFailure.failed, 1);
assert.equal(partialFailure.trades.length, 1);

console.log("[trades-routes-tests] ok");
