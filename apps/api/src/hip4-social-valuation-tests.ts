import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Hip4ReadMarket } from "@hunch/shared";
import { mapHip4Market } from "./services/hip4-mapping.js";
import { hip4OfficialPayoutBasisPoints } from "./services/hip4-catalog-projection.js";
import {
  hip4SocialMarketOpen,
  hip4SocialMark,
} from "./services/hip4-social-valuation.js";
import { socialPositionMetrics } from "./services/social-primitives.js";

const origin = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
const now = Date.parse("2026-10-16T10:00:00Z");
function snapshot(): Hip4ReadMarket {
  const market = mapHip4Market({
    ...origin.observations[0],
    outcome: 8775,
    settlement: null,
    fetchedAt: origin.collectedAt,
    generation: "replaceable",
  }).market;
  market.status = "observed";
  market.expiry = "2099-01-01T00:00:00Z";
  market.fetchedAt = new Date(now - 1000).toISOString();
  market.metadataValidUntil = new Date(now + 60_000).toISOString();
  market.coverage.metadata = "fresh";
  market.sides[0] = {
    ...market.sides[0],
    bid: "0.4",
    ask: "0.6",
    bookAt: new Date(now - 1000).toISOString(),
    bookValidUntil: new Date(now + 5000).toISOString(),
    bookState: "fresh",
  };
  market.sides[1] = {
    ...market.sides[1],
    bid: "0.12",
    ask: "0.20",
    bookAt: new Date(now - 1000).toISOString(),
    bookValidUntil: new Date(now + 5000).toISOString(),
    bookState: "fresh",
  };
  return market;
}

test("native social marks use exact selected-side books rather than complements", () => {
  const market = snapshot();
  const mark = (index: number) =>
    hip4SocialMark({
      metadata: { hip4: market },
      tokenId: market.sides[index].tokenId,
      maxAgeSeconds: 30,
      now,
    });
  assert.equal(hip4SocialMarketOpen({ hip4: market }, now), true);
  assert.equal(mark(0), "0.5");
  assert.equal(mark(1), "0.16");
});

test("expired independent observation validity never keeps an idle UI mark fresh", () => {
  const market = snapshot();
  const read = (tick: number, maxAgeSeconds: number | null = 30) =>
    hip4SocialMark({
      metadata: { hip4: market },
      tokenId: market.sides[0].tokenId,
      maxAgeSeconds,
      now: tick,
    });
  assert.equal(read(now), "0.5");
  assert.equal(read(now + 5000), null);
  assert.equal(read(now, null), null);
  market.sides[0].bookAt = new Date(now - 30_000).toISOString();
  assert.equal(read(now), null);
  market.sides[0].bookAt = new Date(now + 1).toISOString();
  assert.equal(read(now), null);
  market.sides[0].bookAt = new Date(now - 100).toISOString();
  assert.equal(
    read(now),
    "0.5",
    "ordinary fresh observation recovers without clearing state",
  );
});

test("missing metadata, testnet, closed, stale, empty and crossed books stay unavailable", () => {
  const changes: Array<(market: Hip4ReadMarket) => void> = [
    (m) => {
      m.environment = "testnet";
    },
    (m) => {
      m.status = "expired";
    },
    (m) => {
      m.coverage.metadata = "stale";
    },
    (m) => {
      m.metadataValidUntil = new Date(now).toISOString();
    },
    (m) => {
      m.expiry = new Date(now).toISOString();
    },
    (m) => {
      m.sides[0].bookState = "empty";
    },
    (m) => {
      m.sides[0].bid = "0.7";
    },
    (m) => {
      m.sides[0].ask = null;
    },
  ];
  for (const change of changes) {
    const market = snapshot();
    change(market);
    assert.equal(
      hip4SocialMark({
        metadata: { hip4: market },
        tokenId: market.sides[0].tokenId,
        maxAgeSeconds: 30,
        now,
      }),
      null,
    );
  }
  assert.equal(hip4SocialMarketOpen({}, now), false);
});

test("only official complementary settlement becomes exact scalar payout basis points", () => {
  const market = snapshot();
  market.sides[0].payout = "0.123456789012345678";
  market.sides[1].payout = "0.876543210987654322";
  assert.equal(
    hip4OfficialPayoutBasisPoints(market),
    null,
    "indicative extremes or proposed results are not settlement",
  );
  market.status = "settled";
  market.settlement = {
    source: "settledOutcome",
    observedAt: new Date(now).toISOString(),
    details: "synthetic official scalar fixture",
  };
  assert.equal(hip4OfficialPayoutBasisPoints(market), "1234.56789012345678");
  const position = socialPositionMetrics({
    notional: "0.2",
    grossShares: "1",
    netShares: "1",
    outcome: "YES",
    resolvedOutcome: null,
    resolvedOutcomePct: hip4OfficialPayoutBasisPoints(market),
    active: false,
    mark: "1",
  });
  assert.equal(position.state, "fractional");
  assert.equal(position.markPrice, "0.123456789012345678");
  assert.equal(position.pnlUsd, "-0.076543210987654322");
  market.sides[1].payout = "0.9";
  assert.equal(hip4OfficialPayoutBasisPoints(market), null);
});

test("official zero and one stay exact, while neither fractional side becomes a binary win", () => {
  const market = snapshot();
  market.status = "settled";
  market.settlement = {
    source: "settledOutcome",
    observedAt: new Date(now).toISOString(),
    details: "synthetic binary fixture",
  };
  for (const [yes, no, expected] of [
    ["0", "1", "0"],
    ["1.000", "0.000", "10000"],
    ["0.5", "0.5", "5000"],
  ]) {
    market.sides[0].payout = yes;
    market.sides[1].payout = no;
    assert.equal(hip4OfficialPayoutBasisPoints(market), expected);
    for (const outcome of ["YES", "NO"]) {
      const result = socialPositionMetrics({
        notional: "1",
        grossShares: "2",
        netShares: "2",
        outcome,
        resolvedOutcome: null,
        resolvedOutcomePct: expected,
        active: false,
        mark: null,
      });
      if (expected === "5000") assert.equal(result.state, "fractional");
    }
  }
});
