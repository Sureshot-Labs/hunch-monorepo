import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_HIP4_READ_POLICY, type Hip4ReadMarket } from "@hunch/shared";
import type { FeedMarket } from "./server-types.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import { applyFeedReadPresentation } from "./services/feed-read-presentation.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
const now = Date.parse(fixture.collectedAt);
const policy = { ...DEFAULT_HIP4_READ_POLICY, enabled: true };
function snapshot(): Hip4ReadMarket {
  const { market } = mapHip4Market({
    ...fixture.observations[0],
    outcome: 8775,
    settlement: null,
    fetchedAt: fixture.collectedAt,
    generation: "feed-test",
  });
  return {
    ...market,
    expiry: "2099-01-01T00:00:00.000Z",
    volume24h: {
      usd: "123.45",
      basis: "primary_outcome",
      source: "spotMetaAndAssetCtxs",
      coin: market.sides[0].coin,
      observedAt: fixture.collectedAt,
      validUntil: new Date(now + policy.volumeMaxAgeMs).toISOString(),
    },
    sides: market.sides.map((side) => ({
      ...side,
      bid: "0.4",
      ask: "0.6",
      bookAt: fixture.collectedAt,
      bookState: "fresh",
    })),
  };
}
function row(market = snapshot()): FeedMarket {
  return {
    venue: "hyperliquid",
    marketId: market.marketId,
    marketTitle: market.title,
    marketSlug: null,
    status: "ACTIVE",
    volume24h: 999,
    volumeTotal: 999,
    volumeDisplay: 999,
    openInterest: 999,
    liquidity: 999,
    liquidityDisplay: 999,
    acceptingOrders: true,
    tokens: { yes: market.sides[0].tokenId, no: market.sides[1].tokenId },
    conditionId: null,
    category: null,
    image: null,
    icon: null,
    lastPrice: 1,
    resolvedOutcome: "YES",
    resolvedOutcomePct: 100,
    top: { yesBid: 1, yesAsk: 1, noBid: 0, noAsk: 0 },
    topAsOf: { YES: fixture.collectedAt, NO: fixture.collectedAt },
    lastUpdate: fixture.collectedAt,
  };
}
function present(market = snapshot(), time = now, input = row(market)) {
  return applyFeedReadPresentation(
    input,
    market.eventId,
    { hip4: market },
    { hip4Policy: policy, now: time },
  );
}

test("common feed uses one primary-side 24h volume, never lifetime or unknown zero metrics", () => {
  const market = snapshot(),
    original = structuredClone(market);
  const output = present(market);
  assert.equal(output.volume24h, 123.45);
  assert.equal(output.volumeDisplay, 123.45);
  assert.equal(output.volumeDisplayPeriod, "24h");
  assert.equal(output.volumeTotal, null);
  assert.equal(output.liquidity, null);
  assert.equal(output.liquidityDisplay, null);
  assert.equal(output.openInterest, null);
  assert.equal(output.acceptingOrders, false);
  assert.equal(output.lastPrice, null);
  assert.equal(output.resolvedOutcome, null);
  assert.equal(output.resolvedOutcomePct, null);
  assert.deepEqual(market, original);
  assert.ok(market.volume24h);
  market.volume24h.usd = "0";
  assert.equal(present(market).volumeDisplay, 0);
});
test("each native book expires independently, without borrowing a complement", () => {
  const market = snapshot();
  market.sides[1].bookAt = new Date(now - policy.bookMaxAgeMs).toISOString();
  const output = present(market);
  assert.deepEqual(output.top, {
    yesBid: 0.4,
    yesAsk: 0.6,
    noBid: null,
    noAsk: null,
  });
  assert.equal(output.topAsOf.NO, null);
  assert.equal(output.topValidUntil?.NO, fixture.collectedAt);
  assert.equal(
    output.topValidUntil?.YES,
    new Date(now + policy.bookMaxAgeMs).toISOString(),
  );
  market.sides[1].bookAt = fixture.collectedAt;
  assert.equal(present(market).top.noAsk, 0.6);
});
test("cached public snapshots re-age without refreshing observation times", () => {
  const market = snapshot();
  const cached = present(market);
  assert.equal(
    JSON.stringify(
      applyFeedReadPresentation(cached, market.eventId, cached.marketMetadata, {
        hip4Policy: policy,
        now,
      }),
    ),
    JSON.stringify(cached),
  );
  const expired = applyFeedReadPresentation(
    cached,
    market.eventId,
    cached.marketMetadata,
    {
      hip4Policy: policy,
      now: now + Math.max(policy.volumeMaxAgeMs, policy.bookMaxAgeMs),
    },
  );
  assert.equal(expired.top.yesAsk, null);
  assert.equal(expired.volumeDisplay, null);
  assert.equal(
    (expired.marketMetadata?.hip4 as Hip4ReadMarket).fetchedAt,
    market.fetchedAt,
  );
  assert.equal(
    (expired.marketMetadata?.hip4 as Hip4ReadMarket).volume24h?.observedAt,
    fixture.collectedAt,
  );
});
test("shorter effective freshness applies immediately to stored facts", () => {
  const market = snapshot();
  const result = applyFeedReadPresentation(
    row(market),
    market.eventId,
    { hip4: market },
    {
      hip4Policy: { ...policy, bookMaxAgeMs: 1000, volumeMaxAgeMs: 1000 },
      now: now + 1000,
    },
  );
  assert.equal(result.top.yesAsk, null);
  assert.equal(result.volumeDisplay, null);
});
test("non-USD, wrong-side, future and unrepresentable volumes are unavailable", () => {
  for (const mutate of [
    (market: Hip4ReadMarket) => {
      market.quoteToken = "OTHER";
    },
    (market: Hip4ReadMarket) => {
      assert.ok(market.volume24h);
      market.volume24h.coin = market.sides[1].coin;
    },
    (market: Hip4ReadMarket) => {
      assert.ok(market.volume24h);
      market.volume24h.usd = "9".repeat(400);
    },
    (market: Hip4ReadMarket) => {
      assert.ok(market.volume24h);
      market.volume24h.observedAt = new Date(now + 10000).toISOString();
    },
  ]) {
    const market = snapshot();
    mutate(market);
    assert.equal(present(market).volumeDisplay, null);
  }
});
test("reordered sides preserve YES/NO by identity, not array order", () => {
  const market = snapshot(),
    input = row(market);
  market.sides[1].bid = "0.2";
  market.sides.reverse();
  assert.equal(present(market, now, input).top.noBid, 0.2);
});
test("missing, malformed and mismatched snapshots do not leak fallback quotes", () => {
  for (const mutate of [
    (market: Hip4ReadMarket) => {
      market.marketId += "0";
    },
    (market: Hip4ReadMarket) => {
      market.eventId += "0";
    },
    (market: Hip4ReadMarket) => {
      market.environment = "testnet";
    },
    (market: Hip4ReadMarket) => {
      market.sides[0].coin = market.sides[1].coin;
    },
    (market: Hip4ReadMarket) => {
      market.sides[0].sideIndex = 1;
    },
    (market: Hip4ReadMarket) => {
      market.sides[0].bookAt = "invalid";
    },
    (market: Hip4ReadMarket) => {
      market.fetchedAt = "invalid";
    },
  ]) {
    const market = snapshot(),
      input = row(market);
    mutate(market);
    const output = present(market, now, input);
    assert.equal(output.top.yesAsk, null);
    assert.equal(output.volumeDisplay, null);
    assert.equal(output.marketMetadata, null);
  }
  const market = snapshot();
  assert.equal(
    applyFeedReadPresentation(
      row(market),
      market.eventId,
      {},
      { hip4Policy: policy, now },
    ).volumeDisplay,
    null,
  );
  const wrongToken = row(market);
  wrongToken.tokens.no = "foreign";
  assert.equal(present(market, now, wrongToken).marketMetadata, null);
});
test("official binary settlement is distinct from fractional payout and extreme prices", () => {
  for (const [yes, no, expected] of [
    ["1", "0", "YES"],
    ["0", "1", "NO"],
    ["0.5", "0.5", null],
    ["0.99999999999999999999", "0.00000000000000000001", null],
    ["1", "1", null],
  ] as const) {
    const market = snapshot();
    market.sides[0].payout = yes;
    market.sides[1].payout = no;
    assert.equal(present(market).resolvedOutcome, null);
    market.settlement = {
      source: "settledOutcome",
      observedAt: fixture.collectedAt,
      details: "official",
    };
    const output = present(market);
    assert.equal(output.resolvedOutcome, expected);
    assert.equal(output.top.yesAsk, null);
    assert.equal(output.status, "RESOLVED");
    assert.equal(
      (output.marketMetadata?.hip4 as Hip4ReadMarket).sides[0].payout,
      yes,
    );
  }
});
test("disabled or missing protocol context does not serve stale facts; recovery needs no cleanup", () => {
  const market = snapshot();
  for (const hip4Policy of [null, { ...policy, enabled: false }])
    assert.equal(
      applyFeedReadPresentation(
        row(market),
        market.eventId,
        { hip4: market },
        { hip4Policy, now },
      ).volumeDisplay,
      null,
    );
  assert.equal(present(market).volumeDisplay, 123.45);
});
test("other venues retain the exact existing DTO and object", () => {
  for (const venue of ["polymarket", "limitless", "kalshi"]) {
    const input = { ...row(), venue };
    assert.equal(
      applyFeedReadPresentation(input, "event", {}, { hip4Policy: null, now }),
      input,
    );
  }
});
