#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  computeClusterMetrics,
  type ClusterMarketSummary,
} from "./services/clusters.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function buildMarket(overrides: Partial<ClusterMarketSummary>): ClusterMarketSummary {
  return {
    marketId: overrides.marketId ?? "market-1",
    eventId: overrides.eventId ?? "event-1",
    venue: overrides.venue ?? "polymarket",
    marketSlug: overrides.marketSlug ?? null,
    eventSlug: overrides.eventSlug ?? null,
    marketImage: overrides.marketImage ?? null,
    marketIcon: overrides.marketIcon ?? null,
    eventImage: overrides.eventImage ?? null,
    eventIcon: overrides.eventIcon ?? null,
    image: overrides.image ?? null,
    icon: overrides.icon ?? null,
    marketTitle: overrides.marketTitle ?? null,
    marketDescription: overrides.marketDescription ?? null,
    eventTitle: overrides.eventTitle ?? null,
    eventDescription: overrides.eventDescription ?? null,
    marketType: overrides.marketType ?? "binary",
    yesBid: overrides.yesBid ?? null,
    yesAsk: overrides.yesAsk ?? null,
    yesMid: overrides.yesMid ?? null,
    noMid: overrides.noMid ?? null,
    liquidity: overrides.liquidity ?? null,
    volume24h: overrides.volume24h ?? null,
    volumeTotal: overrides.volumeTotal ?? null,
    openInterest: overrides.openInterest ?? null,
    expiresAt: overrides.expiresAt ?? null,
  };
}

test("normalizes opposite-side match winner markets before computing spread", () => {
  const kalshi = buildMarket({
    marketId: "kalshi-sinner",
    venue: "kalshi",
    eventTitle: "Tiafoe vs Sinner",
    marketTitle: "Jannik Sinner",
    yesMid: 0.995,
    noMid: 0.005,
    openInterest: 428394,
  });
  const polymarket = buildMarket({
    marketId: "poly-tiafoe",
    venue: "polymarket",
    eventTitle: "Miami Open: Frances Tiafoe vs Jannik Sinner",
    marketTitle: "Miami Open: Frances Tiafoe vs Jannik Sinner",
    yesMid: 0.0045,
    noMid: 0.9955,
    liquidity: 24590.21264,
  });

  const metrics = computeClusterMetrics([kalshi, polymarket]);
  assert.ok(metrics.priceSpread != null);
  assert.ok(Math.abs(metrics.priceSpread - 0.0005) < 1e-9);
});

test("keeps same-side winner markets on raw yes probability scale", () => {
  const kalshi = buildMarket({
    marketId: "kalshi-ark",
    venue: "kalshi",
    eventTitle: "Men's College Basketball Champion",
    marketTitle: "Arkansas",
    yesMid: 0.015,
    noMid: 0.985,
    openInterest: 8132482,
  });
  const polymarket = buildMarket({
    marketId: "poly-ark",
    venue: "polymarket",
    eventTitle: "2026 NCAA Tournament Winner",
    marketTitle: "Arkansas",
    yesMid: 0.0175,
    noMid: 0.9825,
    liquidity: 130080.242,
  });

  const metrics = computeClusterMetrics([kalshi, polymarket]);
  assert.ok(metrics.priceSpread != null);
  assert.ok(Math.abs(metrics.priceSpread - 0.0025) < 1e-9);
});
