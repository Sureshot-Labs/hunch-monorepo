import assert from "node:assert/strict";
import {
  buildBookTopFromBbo,
  buildBookTopFromL2Book,
  hunchTokenIdFromHyperliquidCoin,
  hyperliquidCoinFromHunchTokenId,
  selectTopBookTokenIds,
} from "./market-data.js";
import type { HyperliquidMappedSnapshot } from "./types.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("Hyperliquid coin and Hunch token id conversion is reversible", () => {
  assert.equal(hunchTokenIdFromHyperliquidCoin("#50"), "hyperliquid:100000050");
  assert.equal(hyperliquidCoinFromHunchTokenId("hyperliquid:100000050"), "#50");
  assert.equal(hunchTokenIdFromHyperliquidCoin("+50"), null);
  assert.equal(hyperliquidCoinFromHunchTokenId("polymarket:100000050"), null);
});

test("buildBookTopFromL2Book maps top and Redis snapshot shape", () => {
  const top = buildBookTopFromL2Book("hyperliquid:100000050", {
    coin: "#50",
    time: 1778171037785,
    levels: [
      [
        { px: "0.269", sz: "1424.0", n: 2 },
        { px: "0.2681", sz: "120.0", n: 1 },
      ],
      [
        { px: "0.27", sz: "8702.0", n: 2 },
        { px: "0.2708", sz: "269.0", n: 1 },
      ],
    ],
  });

  assert.ok(top);
  assert.equal(top.bestBid, 0.269);
  assert.equal(top.bestAsk, 0.27);
  assert.equal(top.snapshot.token_id, "hyperliquid:100000050");
  assert.deepEqual(top.snapshot.bids[0], { price: "0.269", size: "1424.0" });
});

test("buildBookTopFromL2Book returns null for empty books", () => {
  const top = buildBookTopFromL2Book("hyperliquid:100000060", {
    coin: "#60",
    time: 1778171038828,
    levels: [[], []],
  });
  assert.equal(top, null);
});

test("buildBookTopFromBbo maps websocket top without full book depth", () => {
  const top = buildBookTopFromBbo("hyperliquid:100000050", {
    coin: "#50",
    time: 1778171044088,
    bbo: [
      { px: "0.2692", sz: "56.0", n: 1 },
      { px: "0.27", sz: "3202.0", n: 2 },
    ],
  });

  assert.ok(top);
  assert.equal(top.bestBid, 0.2692);
  assert.equal(top.bestAsk, 0.27);
  assert.deepEqual(top.snapshot.bids, [{ price: "0.2692", size: "56.0" }]);
  assert.deepEqual(top.snapshot.asks, [{ price: "0.27", size: "3202.0" }]);
});

test("selectTopBookTokenIds prefers hot tokens then rolling-notional assets", () => {
  const snapshot = {
    assets: [
      { hunch_token_id: "hyperliquid:100000050", day_ntl_vlm: 10 },
      { hunch_token_id: "hyperliquid:100000051", day_ntl_vlm: 30 },
      { hunch_token_id: "hyperliquid:100000070", day_ntl_vlm: 20 },
    ],
  } as HyperliquidMappedSnapshot;

  assert.deepEqual(
    selectTopBookTokenIds({
      snapshot,
      hotTokenIds: ["hyperliquid:100000070", "bad-token"],
      maxTokens: 3,
    }),
    ["hyperliquid:100000070", "hyperliquid:100000051", "hyperliquid:100000050"],
  );
});
