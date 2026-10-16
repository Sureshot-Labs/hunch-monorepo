import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mapHip4Market } from "./services/hip4-mapping.js";
import {
  hip4ClusterQuotes,
  loadClusterMarketNativeQuotes,
} from "./services/cluster-execution-quotes.js";
import type { DbQuery } from "./db.js";
import { resolveHolderResearchSignalQuote } from "./services/holder-research-performance.js";
const captured = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
const now = Date.now();
function snapshot() {
  const market = mapHip4Market({
    ...captured.observations[0],
    outcome: 8775,
    settlement: null,
    fetchedAt: new Date(now).toISOString(),
    generation: "quote-native",
  }).market;
  market.status = "observed";
  market.coverage.metadata = "fresh";
  market.expiry = "2099-01-01T00:00:00.000Z";
  market.metadataValidUntil = new Date(now + 60000).toISOString();
  market.sides = market.sides.map((side, index) => ({
    ...side,
    bid: index === 0 ? "0.4" : "0.12",
    ask: index === 0 ? "0.6" : "0.2",
    bookState: "fresh",
    bookAt: new Date(now).toISOString(),
    bookValidUntil: new Date(now + 10000).toISOString(),
  }));
  return market;
}
test("matched native quotes retain actual independent YES/NO observations", () => {
  const market = snapshot();
  const result = hip4ClusterQuotes({
    marketId: market.marketId,
    metadata: { hip4: market },
    active: true,
    now,
  });
  assert.equal(result.orderable, true);
  assert.equal(result.yes.ask, 0.6);
  assert.equal(result.no.ask, 0.2);
  assert.equal(result.no.bid, 0.12);
});
test("research entry and current mark retain exact native NO without legacy complement or last-price fallback", () => {
  const market = snapshot();
  const row = {
    venue: "hyperliquid",
    market_id: market.marketId,
    market_status: "ACTIVE",
    market_metadata: { hip4: market },
    best_bid: "0.99",
    best_ask: "0.99",
    last_price: "0.99",
  };
  const no = resolveHolderResearchSignalQuote(row, "NO", now);
  assert.equal(no.buyPrice, 0.2);
  assert.equal(no.markPrice, 0.12);
  assert.equal(no.buyPriceSource, "native_ask");
  market.sides[1].bookValidUntil = new Date(now).toISOString();
  assert.equal(resolveHolderResearchSignalQuote(row, "NO", now).buyPrice, null);
  assert.equal(
    resolveHolderResearchSignalQuote(row, "NO", now).markPrice,
    null,
  );
});
test("expiry, environment, quote asset, identity and independently stale books recover truthfully", () => {
  for (const change of [
    (m: ReturnType<typeof snapshot>) => {
      m.expiry = new Date(now).toISOString();
    },
    (m: ReturnType<typeof snapshot>) => {
      m.environment = "testnet";
    },
    (m: ReturnType<typeof snapshot>) => {
      m.quoteToken = "USDH";
    },
    (m: ReturnType<typeof snapshot>) => {
      m.sides[0].tokenId = m.sides[1].tokenId;
    },
    (m: ReturnType<typeof snapshot>) => {
      m.metadataValidUntil = new Date(now).toISOString();
    },
  ]) {
    const market = snapshot();
    change(market);
    assert.equal(
      hip4ClusterQuotes({
        marketId: market.marketId,
        metadata: { hip4: market },
        active: true,
        now,
      }).orderable,
      false,
    );
  }
  const market = snapshot();
  market.sides[1].bookValidUntil = new Date(now).toISOString();
  const result = hip4ClusterQuotes({
    marketId: market.marketId,
    metadata: { hip4: market },
    active: true,
    now,
  });
  assert.equal(result.yes.ask, 0.6);
  assert.equal(result.no.ask, null);
  market.sides[1].bookValidUntil = new Date(now + 10000).toISOString();
  assert.equal(
    hip4ClusterQuotes({
      marketId: market.marketId,
      metadata: { hip4: market },
      active: true,
      now,
    }).no.ask,
    0.2,
  );
});
test("one bounded native/legacy batch preserves legacy tops and never prefers a stale native top table", async () => {
  const market = snapshot();
  let calls = 0;
  const db = {
    query: async (_sql: string, values: unknown[]) => {
      calls++;
      assert.deepEqual(values[0], [market.marketId, "poly-test"]);
      return {
        rows: [
          {
            market_id: market.marketId,
            venue: "hyperliquid",
            metadata: { hip4: market },
            active: true,
            orderable: false,
            yes_bid: "0.99",
            yes_ask: "0.99",
            no_bid: "0.99",
            no_ask: "0.99",
            yes_ts: new Date(now),
            no_ts: new Date(now),
          },
          {
            market_id: "poly-test",
            venue: "polymarket",
            metadata: {},
            active: true,
            orderable: true,
            yes_bid: "0.3",
            yes_ask: "0.35",
            no_bid: "0.64",
            no_ask: "0.7",
            yes_ts: new Date(now),
            no_ts: new Date(now),
          },
        ],
      };
    },
  } as unknown as DbQuery;
  const result = await loadClusterMarketNativeQuotes(db, [
    market.marketId,
    "poly-test",
    market.marketId,
  ]);
  assert.equal(calls, 1);
  assert.equal(result.get(market.marketId)?.no.ask, 0.2);
  assert.equal(result.get("poly-test")?.yes.ask, 0.35);
});
