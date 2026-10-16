import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PoolClient } from "pg";
import type { Pool } from "@hunch/infra";
import { mapHip4Market } from "./services/hip4-mapping.js";
import {
  marketsByTokenQuerySchema,
  marketSimilarQuerySchema,
} from "./schemas/market.js";
import { eventSimilarQuerySchema } from "./schemas/event.js";
import {
  signalsQuerySchema,
  scopedSignalsQuerySchema,
} from "./schemas/signals.js";
import {
  walletActivityQuerySchema,
  walletPositionsQuerySchema,
  walletPositionHistoryQuerySchema,
  walletPositioningQuerySchema,
} from "./schemas/wallet-intel.js";
import { zVenue } from "./schemas/common.js";
import { fetchMarketsByTokenIds } from "./repos/unified-read.js";
import {
  fetchHip4MarketsByTokenIds,
  nativePublicReadIdAllowed,
} from "./repos/hip4-token-read.js";
import { mapMarketsByTokenRows } from "./services/markets-by-token-response.js";
import {
  calculateWalletPositionApproxMetrics,
  loadWalletPositionApproxMetrics,
} from "./services/wallet-position-approx.js";

const captured = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
const now = Date.now();
function native() {
  const market = mapHip4Market({
    ...captured.observations[0],
    outcome: 8775,
    settlement: null,
    fetchedAt: new Date(now).toISOString(),
    generation: "synthetic-public-read",
  }).market;
  market.status = "observed";
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

test("only scoped public read filters accept HIP; legacy/global selectors stay unchanged", () => {
  const schemas = [
    marketsByTokenQuerySchema,
    marketSimilarQuerySchema,
    eventSimilarQuerySchema,
    signalsQuerySchema,
    scopedSignalsQuerySchema,
    walletActivityQuerySchema,
    walletPositionsQuerySchema,
    walletPositionHistoryQuerySchema,
  ];
  for (const schema of schemas) {
    for (const venue of ["hyperliquid", "polymarket", "limitless", "kalshi"])
      assert(
        schema.safeParse({
          venue,
          tokenIds: "fixture",
          walletId: "00000000-0000-4000-8000-000000000001",
        }).success,
      );
    assert(
      !schema.safeParse({
        venue: "unsupported",
        tokenIds: "fixture",
        walletId: "00000000-0000-4000-8000-000000000001",
      }).success,
    );
  }
  assert(
    !walletPositioningQuerySchema.safeParse({ venue: "hyperliquid" }).success,
  );
  assert(!zVenue.safeParse("hyperliquid").success);
});

test("by-token native read is opt-in, environment/instance exact and absent from financial legacy hydration", async () => {
  const market = native();
  let queries = 0;
  const db = {
    query: async (_sql: string, params: unknown[]) => {
      queries++;
      assert.equal(params[0], "mainnet");
      assert.deepEqual(params[1], [8775]);
      return { rows: [{ read_model: market }] };
    },
  } as unknown as Pool;
  const tokenIds = market.sides.map((side) => side.tokenId);
  assert.deepEqual(await fetchMarketsByTokenIds(db, { tokenIds }), []);
  assert.equal(queries, 0);
  const rows = await fetchMarketsByTokenIds(db, {
    tokenIds,
    venue: "hyperliquid",
    hip4ReadEnvironment: "mainnet",
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].side, "NO");
  assert.deepEqual(
    await fetchMarketsByTokenIds(db, {
      tokenIds,
      venue: "polymarket",
      hip4ReadEnvironment: "mainnet",
    }),
    [],
  );
  assert.deepEqual(
    await fetchHip4MarketsByTokenIds(db, {
      tokenIds: [
        "hyperliquid:testnet:87750",
        "hyperliquid:mainnet:087750",
        "hyperliquid:mainnet:87752",
      ],
      environment: "mainnet",
    }),
    [],
  );
  const mismatch = {
    query: async () => ({
      rows: [
        {
          read_model: {
            ...market,
            marketId: "hyperliquid:mainnet:outcome:8776",
          },
        },
      ],
    }),
  } as unknown as Pool;
  assert.deepEqual(
    await fetchHip4MarketsByTokenIds(mismatch, {
      tokenIds,
      environment: "mainnet",
    }),
    [],
  );
});

test("native DTO has independent side books, exact payouts and unknown rather than zero metrics", async () => {
  const market = native();
  const db = {
    query: async () => ({ rows: [{ read_model: market }] }),
  } as unknown as Pool;
  const rows = await fetchHip4MarketsByTokenIds(db, {
    tokenIds: [market.sides[1].tokenId],
    environment: "mainnet",
  });
  const [item] = mapMarketsByTokenRows(rows, { now: new Date(now) });
  assert.equal(item.market.tokens.no, market.sides[1].tokenId);
  assert.equal(item.market.bestAskNo, 0.2);
  assert.equal(item.market.bestBidNo, 0.12);
  assert.equal(item.market.volumeTotal, null);
  assert.equal(item.market.openInterest, null);
  assert.equal(item.market.liquidity, null);
  assert.equal(item.market.event.eventVolume, null);
  market.sides[1].bookValidUntil = new Date(now).toISOString();
  const [stale] = mapMarketsByTokenRows(
    await fetchHip4MarketsByTokenIds(db, {
      tokenIds: [market.sides[1].tokenId],
      environment: "mainnet",
    }),
    { now: new Date(now) },
  );
  assert.equal(stale.market.bestAskNo, null);
  assert.equal(stale.market.bestAskYes, 0.6);
  market.status = "settled";
  market.settlement = {
    source: "settledOutcome",
    observedAt: new Date(now).toISOString(),
    details: "Synthetic official fractional settlement",
  };
  market.sides[0].payout = "0.375";
  market.sides[1].payout = "0.625";
  const [settled] = mapMarketsByTokenRows(
    await fetchHip4MarketsByTokenIds(db, {
      tokenIds: [market.sides[1].tokenId],
      environment: "mainnet",
    }),
    { now: new Date(now) },
  );
  assert.equal(settled.market.resolvedOutcomePct, 3750);
  assert.equal(settled.market.resolvedOutcome, null);
  assert.equal(settled.market.bestAskYes, null);
  assert.equal(settled.market.redemption.status, "resolved_not_redeemable");
});

test("native payouts need official settled provenance and complementary exact side values", async () => {
  const market = native();
  market.sides[0].payout = "1";
  market.sides[1].payout = "0";
  const read = () =>
    fetchHip4MarketsByTokenIds(
      {
        query: async () => ({ rows: [{ read_model: market }] }),
      } as unknown as Pool,
      { tokenIds: [market.sides[0].tokenId], environment: "mainnet" },
    );
  assert.equal((await read())[0].resolved_outcome_pct, null);
  market.status = "settled";
  assert.equal((await read())[0].resolved_outcome_pct, null);
  market.settlement = {
    source: "settledOutcome",
    observedAt: new Date(now).toISOString(),
    details: "Synthetic official settlement",
  };
  assert.equal((await read())[0].resolved_outcome_pct, "10000");
  assert.equal((await read())[0].resolved_outcome, "YES");
  market.sides[1].payout = "0.1";
  assert.equal((await read())[0].resolved_outcome_pct, null);
  assert.equal((await read())[0].resolved_outcome, null);
  market.sides[0].payout = "0.123456789012345678";
  market.sides[1].payout = "0.876543210987654322";
  assert.equal((await read())[0].resolved_outcome_pct, "1234.56789012345678");
});

test("native books require current open metadata while rolling volume preserves exact native provenance", async () => {
  const market = native();
  market.volume24h = {
    usd: "1234.5",
    source: "spotMetaAndAssetCtxs",
    basis: "primary_outcome",
    coin: market.sides[0].coin,
    observedAt: new Date(now).toISOString(),
    validUntil: new Date(now + 60000).toISOString(),
  };
  const read = async () => {
    const rows = await fetchHip4MarketsByTokenIds(
      {
        query: async () => ({ rows: [{ read_model: market }] }),
      } as unknown as Pool,
      { tokenIds: [market.sides[0].tokenId], environment: "mainnet" },
    );
    return mapMarketsByTokenRows(rows, { now: new Date(now) })[0];
  };
  const current = await read();
  assert.equal(current.market.volume24h, 1234.5);
  assert.equal(current.market.bestAskNo, 0.2);
  assert.deepEqual(
    (current.market.marketMetadata?.hip4 as { volume24h: unknown }).volume24h,
    market.volume24h,
  );
  market.metadataValidUntil = new Date(now).toISOString();
  const stale = await read();
  assert.equal(stale.market.acceptingOrders, false);
  assert.equal(stale.market.bestAskYes, null);
  assert.equal(stale.market.bestAskNo, null);
  market.metadataValidUntil = new Date(now + 60000).toISOString();
  market.fetchedAt = new Date(now + 1).toISOString();
  assert.equal((await read()).market.bestAskYes, null);
  market.fetchedAt = new Date(now).toISOString();
  market.volume24h.coin = market.sides[1].coin;
  assert.equal((await read()).market.volume24h, null);
  market.volume24h.coin = market.sides[0].coin;
  market.volume24h.validUntil = new Date(now).toISOString();
  assert.equal((await read()).market.volume24h, null);
});

test("native public similarity IDs cannot leak across active environments", () => {
  assert(nativePublicReadIdAllowed("polymarket:1", null));
  assert(
    nativePublicReadIdAllowed("hyperliquid:mainnet:question:1", "mainnet"),
  );
  assert(
    !nativePublicReadIdAllowed("hyperliquid:testnet:outcome:1", "mainnet"),
  );
  assert(!nativePublicReadIdAllowed("hyperliquid:mainnet:outcome:1", null));
});

test("native public position enrichment never reconstructs basis/PnL or NO from partial history", async () => {
  const input = {
    walletId: "fixture",
    marketId: "hyperliquid:mainnet:outcome:41",
    outcomeSide: "NO",
    shares: 10,
    price: null,
    bestBid: 0.9,
    bestAsk: 0.99,
    lastPrice: 0.95,
    resolvedOutcome: null,
    metadata: {
      costBasis: "unknown",
      coverage: { scope: "known_wallet_only" },
    },
  };
  const metrics = calculateWalletPositionApproxMetrics(input);
  assert.equal(metrics.approxEntryPrice, null);
  assert.equal(metrics.currentPrice, null);
  assert.equal(metrics.openPnlUsd, null);
  assert.equal(metrics.totalPnlUsd, null);
  assert.equal(metrics.approxReliable, false);
  const db = {
    query: async () => {
      throw new Error(
        "native fragments must not enter legacy ledger reconstruction",
      );
    },
  } as unknown as Pick<PoolClient, "query">;
  const result = await loadWalletPositionApproxMetrics(db, [input]);
  assert.equal(result.size, 1);
  assert.equal([...result.values()][0].realizedPnlUsd, null);
});
