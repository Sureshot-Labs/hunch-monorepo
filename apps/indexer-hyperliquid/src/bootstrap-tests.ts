import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  enrichHyperliquidCandleTotals,
  selectHyperliquidBookTargetsFromDb,
} from "./bootstrap.js";
import type { HyperliquidClient } from "./hyperliquid-client.js";
import type { HyperliquidCandle, HyperliquidMappedSnapshot } from "./types.js";

type TestFn = () => void | Promise<void>;

const tests: Array<{ name: string; fn: TestFn }> = [];

function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

test("selectHyperliquidBookTargetsFromDb preserves hot-token priority before volume fallback", async () => {
  const calls: unknown[][] = [];
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      calls.push(params);
      return {
        rows: [
          { token_id: "hyperliquid:100000070", coin: "#70" },
          { token_id: "hyperliquid:100000051", coin: "#51" },
          { token_id: "hyperliquid:100000050", coin: "#50" },
        ],
      };
    },
  } as unknown as Pool;

  const targets = await selectHyperliquidBookTargetsFromDb({
    pool,
    hotTokenIds: [
      "bad-token",
      "hyperliquid:100000070",
      "hyperliquid:100000070",
    ],
    maxTokens: 3,
  });

  assert.deepEqual(calls[0], [["hyperliquid:100000070"], 3, 900]);
  assert.deepEqual(targets, [
    { tokenId: "hyperliquid:100000070", coin: "#70" },
    { tokenId: "hyperliquid:100000051", coin: "#51" },
    { tokenId: "hyperliquid:100000050", coin: "#50" },
  ]);
});

test("selectHyperliquidBookTargetsFromDb returns no targets when disabled by maxTokens", async () => {
  let called = false;
  const pool = {
    query: async () => {
      called = true;
      return { rows: [] };
    },
  } as unknown as Pool;

  const targets = await selectHyperliquidBookTargetsFromDb({
    pool,
    hotTokenIds: ["hyperliquid:100000070"],
    maxTokens: 0,
  });

  assert.deepEqual(targets, []);
  assert.equal(called, false);
});

test("enrichHyperliquidCandleTotals fills best-effort total volume and open time", async () => {
  const calls: string[] = [];
  const candles: HyperliquidCandle[] = [
    {
      t: Date.UTC(2026, 5, 1),
      T: Date.UTC(2026, 5, 1, 23, 59, 59),
      s: "#50",
      i: "1d",
      o: "0.5",
      c: "0.5",
      h: "0.5",
      l: "0.5",
      v: "0.0",
      n: 0,
    },
    {
      t: Date.UTC(2026, 5, 2),
      T: Date.UTC(2026, 5, 2, 23, 59, 59),
      s: "#50",
      i: "1d",
      o: "0.5",
      c: "0.6",
      h: "0.6",
      l: "0.5",
      v: "12.5",
      n: 2,
    },
    {
      t: Date.UTC(2026, 5, 3),
      T: Date.UTC(2026, 5, 3, 23, 59, 59),
      s: "#50",
      i: "1d",
      o: "0.6",
      c: "0.7",
      h: "0.7",
      l: "0.6",
      v: "7.5",
      n: 1,
    },
  ];
  const client = {
    fetchCandleSnapshot: async (params: { coin: string }) => {
      calls.push(params.coin);
      return candles;
    },
  } as unknown as HyperliquidClient;
  const snapshot: HyperliquidMappedSnapshot = {
    network: "mainnet",
    questions: [],
    outcomes: [],
    assets: [],
    tokens: [],
    diagnostics: {
      outcomeCount: 0,
      questionCount: 0,
      eventCount: 1,
      marketCount: 1,
      tokenCount: 2,
      standaloneOutcomeCount: 1,
    },
    events: [
      {
        id: "hyperliquid:outcome:5",
        venue: "hyperliquid",
        venue_event_id: "outcome:5",
        title: "Test event",
        status: "ACTIVE",
      },
    ],
    markets: [
      {
        id: "hyperliquid:outcome:5",
        venue: "hyperliquid",
        venue_market_id: "outcome:5",
        event_id: "hyperliquid:outcome:5",
        title: "Test market",
        status: "ACTIVE",
        market_type: "binary",
        volume_24h: 100,
        token_yes: "hyperliquid:100000050",
        token_no: "hyperliquid:100000051",
        metadata: { hyperliquid: { volumeTotalAvailable: false } },
      },
    ],
  };

  const stats = await enrichHyperliquidCandleTotals({
    client,
    snapshot,
    maxMarkets: 1,
    concurrency: 1,
    nowMs: Date.UTC(2026, 5, 4),
  });

  assert.deepEqual(stats, { selected: 1, enriched: 1, empty: 0, failed: 0 });
  assert.deepEqual(calls, ["#50"]);
  assert.equal(snapshot.markets[0]?.volume_total, 20);
  assert.equal(
    snapshot.markets[0]?.open_time?.toISOString(),
    "2026-06-02T00:00:00.000Z",
  );
  assert.equal(snapshot.events[0]?.volume_total, 20);
  assert.equal(
    snapshot.events[0]?.start_date?.toISOString(),
    "2026-06-02T00:00:00.000Z",
  );
  const metadata = snapshot.markets[0]?.metadata as {
    hyperliquid: {
      volumeTotalSource: string;
      volumeTotalConfidence: string;
      candleVolumeCoin: string;
      openTimeSource: string;
    };
  };
  assert.equal(
    metadata.hyperliquid.volumeTotalSource,
    "candle_1d_sum_base_volume",
  );
  assert.equal(metadata.hyperliquid.volumeTotalConfidence, "best_effort");
  assert.equal(metadata.hyperliquid.candleVolumeCoin, "#50");
  assert.equal(
    metadata.hyperliquid.openTimeSource,
    "first_available_1d_candle",
  );
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
