#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  buildCanonicalMarketTop,
  buildMarketPriceState,
  buildObservedCanonicalMarketTop,
} from "@hunch/shared";

function test(name: string, run: () => void): void {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const now = new Date("2026-07-17T12:10:00.000Z");

function top(
  ageSeconds: number,
  bestBid: number | null,
  bestAsk: number | null,
) {
  return {
    bestAsk,
    bestBid,
    ts: new Date(now.getTime() - ageSeconds * 1000),
  };
}

test("canonical top accepts 599 and 600 seconds, rejects 601", () => {
  for (const ageSeconds of [599, 600]) {
    const result = buildCanonicalMarketTop({
      now,
      yesTop: top(ageSeconds, 0.4, 0.42),
    });
    assert.equal(result.yesBid, 0.4);
    assert.equal(result.yesAsk, 0.42);
    assert.ok(Math.abs((result.probability ?? 0) - 0.41) < 1e-9);
  }
  const stale = buildCanonicalMarketTop({
    now,
    yesTop: top(601, 0.4, 0.42),
  });
  assert.equal(stale.yesBid, null);
  assert.equal(stale.yesAsk, null);
  assert.equal(stale.probability, null);
  assert.ok(stale.blockers.includes("stale"));
});

test("observed top keeps an old coherent book for presentation only", () => {
  const observed = buildObservedCanonicalMarketTop({
    yesTop: top(22 * 60 * 60, 0.39, 0.41),
    noTop: top(22 * 60 * 60, 0.59, 0.61),
  });
  const strict = buildCanonicalMarketTop({
    now,
    yesTop: top(22 * 60 * 60, 0.39, 0.41),
    noTop: top(22 * 60 * 60, 0.59, 0.61),
  });

  assert.equal(observed.probability, 0.4);
  assert.equal(observed.yesAsk, 0.41);
  assert.equal(strict.probability, null);
  assert.equal(strict.yesAsk, null);
});

test("incident one-sided books do not create 100/0 or executable asks", () => {
  const result = buildCanonicalMarketTop({
    now,
    yesTop: top(0, null, 0.998),
    noTop: top(0, 0.002, null),
  });
  assert.equal(result.yesAsk, 0.998);
  assert.equal(result.noBid, 0.002);
  assert.equal(result.noAsk, null);
  assert.equal(result.probability, null);
});

test("canonical top rejects future quote timestamps", () => {
  const result = buildCanonicalMarketTop({
    now,
    yesTop: {
      bestBid: 0.4,
      bestAsk: 0.42,
      ts: new Date(now.getTime() + 1),
    },
  });
  assert.equal(result.yesBid, null);
  assert.equal(result.yesAsk, null);
  assert.ok(result.blockers.includes("stale"));
});

test("market, last-price, and opposite-side values never replace an ask", () => {
  const state = buildMarketPriceState({
    marketBestAsk: 0.7,
    marketBestBid: 0.3,
    lastPrice: 0.8,
    noTop: top(0, 0.25, null),
    now,
    yesTop: top(0, 0.75, null),
  });
  assert.equal(state.yes.buyPrice, null);
  assert.equal(state.no.buyPrice, null);
  assert.equal(state.yesProbability, null);
});

test("contradictory two-sided books suppress probability", () => {
  const result = buildCanonicalMarketTop({
    now,
    yesTop: top(0, 0.39, 0.41),
    noTop: top(0, 0.19, 0.21),
  });
  assert.equal(result.probability, null);
  assert.ok(result.blockers.includes("inconsistent_probability"));
});
