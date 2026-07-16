#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  applyClusterExecutionVerification,
  buildClusterExecution,
  type ClusterMarketNativeQuotes,
} from "./services/cluster-execution.js";
import {
  finalizeClusterExecutionVerification,
  quoteLimitlessLevelsForVerification,
  verifyClusterExecutions,
} from "./services/cluster-execution-verifier.js";
import { enrichClusterExecutions } from "./services/cluster-execution-enrichment.js";
import type { ClusterMarketSummary } from "./services/clusters.js";

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function market(input: {
  id: string;
  venue: string;
  marketTitle?: string;
  eventTitle?: string;
}): ClusterMarketSummary {
  return {
    eventId: `${input.id}:event`,
    eventTitle: input.eventTitle ?? "Same event",
    eventDescription: null,
    eventCategory: null,
    eventIcon: null,
    eventImage: null,
    eventSlug: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
    icon: null,
    image: null,
    liquidity: 100,
    marketCategory: null,
    marketDescription: null,
    marketIcon: null,
    marketId: input.id,
    marketImage: null,
    marketSlug: input.id,
    marketTitle: input.marketTitle ?? "Same market",
    marketType: "binary",
    noMid: 0.5,
    openInterest: 0,
    venue: input.venue,
    volume24h: 10,
    volumeTotal: 100,
    yesAsk: 0.51,
    yesBid: 0.49,
    yesMid: 0.5,
  };
}

function quotes(input: {
  marketId: string;
  venue: string;
  yesAsk: number | null;
  noAsk: number | null;
  asOf: string;
  yesBid?: number | null;
  noBid?: number | null;
}): ClusterMarketNativeQuotes {
  return {
    active: true,
    marketId: input.marketId,
    no: {
      ask: input.noAsk,
      bid: input.noBid ?? null,
      asOf: input.asOf,
    },
    orderable: true,
    venue: input.venue,
    yes: {
      ask: input.yesAsk,
      bid: input.yesBid ?? null,
      asOf: input.asOf,
    },
  };
}

function build(input: {
  left: ClusterMarketSummary;
  right: ClusterMarketSummary;
  leftQuotes: ClusterMarketNativeQuotes;
  rightQuotes: ClusterMarketNativeQuotes;
  now?: Date;
}) {
  return buildClusterExecution({
    cluster: {
      id: "cluster",
      markets: [input.left, input.right],
      priceSpread: 0.1,
      seedMarketId: input.left.marketId,
    },
    nativeQuotesByMarketId: new Map([
      [input.left.marketId, input.leftQuotes],
      [input.right.marketId, input.rightQuotes],
    ]),
    now: input.now ?? new Date("2026-01-01T00:02:00.000Z"),
  });
}

await test("builds a strict gross candidate from fresh cross-venue asks", () => {
  const asOf = "2026-01-01T00:01:00.000Z";
  const left = market({ id: "poly", venue: "polymarket" });
  const right = market({ id: "limitless", venue: "limitless" });
  const result = build({
    left,
    right,
    leftQuotes: quotes({
      asOf,
      marketId: left.marketId,
      noAsk: 0.62,
      venue: left.venue,
      yesAsk: 0.41,
    }),
    rightQuotes: quotes({
      asOf,
      marketId: right.marketId,
      noAsk: 0.57,
      venue: right.venue,
      yesAsk: 0.44,
    }),
  });
  assert.equal(result.execution.kind, "comparison");
  assert.equal(result.execution.quotesFresh, true);
  assert.equal(result.execution.bundleCost, 0.98);
  assert.ok(Math.abs((result.execution.grossEdge ?? 0) - 0.02) < 1e-12);
  assert.equal(result.execution.verification.status, "unavailable");
});

await test("maps canonical YES onto the opposite native outcome", () => {
  const asOf = "2026-01-01T00:01:00.000Z";
  const left = market({
    eventTitle: "France vs Senegal",
    id: "france",
    marketTitle: "France",
    venue: "polymarket",
  });
  const right = market({
    eventTitle: "Senegal vs France",
    id: "senegal",
    marketTitle: "Senegal",
    venue: "limitless",
  });
  const result = build({
    left,
    right,
    leftQuotes: quotes({
      asOf,
      marketId: left.marketId,
      noAsk: 0.7,
      venue: left.venue,
      yesAsk: 0.4,
    }),
    rightQuotes: quotes({
      asOf,
      marketId: right.marketId,
      noAsk: 0.55,
      venue: right.venue,
      yesAsk: 0.6,
    }),
  });
  assert.equal(result.markets[1]?.executionOffers?.yes?.nativeOutcome, "NO");
  assert.equal(result.execution.bestNoOffer?.nativeOutcome, "YES");
});

await test("does not synthesize a missing NO ask from YES bid or midpoint", () => {
  const asOf = "2026-01-01T00:01:00.000Z";
  const left = market({ id: "poly", venue: "polymarket" });
  const right = market({ id: "limitless", venue: "limitless" });
  const result = build({
    left,
    right,
    leftQuotes: quotes({
      asOf,
      marketId: left.marketId,
      noAsk: null,
      venue: left.venue,
      yesAsk: 0.4,
      yesBid: 0.39,
    }),
    rightQuotes: quotes({
      asOf,
      marketId: right.marketId,
      noAsk: null,
      venue: right.venue,
      yesAsk: 0.42,
      yesBid: 0.41,
    }),
  });
  assert.equal(result.execution.kind, "quotes_unavailable");
  assert.equal(result.execution.bundleCost, null);
});

await test("rejects crossed tops and same-venue bundles", () => {
  const asOf = "2026-01-01T00:01:00.000Z";
  const left = market({ id: "a", venue: "polymarket" });
  const right = market({ id: "b", venue: "polymarket" });
  const result = build({
    left,
    right,
    leftQuotes: quotes({
      asOf,
      marketId: left.marketId,
      noAsk: 0.55,
      venue: left.venue,
      yesAsk: 0.4,
      yesBid: 0.5,
    }),
    rightQuotes: quotes({
      asOf,
      marketId: right.marketId,
      noAsk: 0.54,
      venue: right.venue,
      yesAsk: 0.41,
    }),
  });
  assert.equal(result.execution.kind, "quotes_unavailable");
});

await test("uses the inclusive 10 minute freshness boundary", () => {
  const left = market({ id: "poly", venue: "polymarket" });
  const right = market({ id: "limitless", venue: "limitless" });
  const now = new Date("2026-01-01T00:10:00.000Z");
  const atBoundary = build({
    left,
    right,
    leftQuotes: quotes({
      asOf: "2026-01-01T00:00:00.000Z",
      marketId: left.marketId,
      noAsk: 0.6,
      venue: left.venue,
      yesAsk: 0.4,
    }),
    now,
    rightQuotes: quotes({
      asOf: "2026-01-01T00:00:01.000Z",
      marketId: right.marketId,
      noAsk: 0.55,
      venue: right.venue,
      yesAsk: 0.45,
    }),
  });
  assert.equal(atBoundary.execution.quotesFresh, true);

  const stale = build({
    left,
    right,
    leftQuotes: quotes({
      asOf: "2025-12-31T23:59:59.000Z",
      marketId: left.marketId,
      noAsk: 0.6,
      venue: left.venue,
      yesAsk: 0.4,
    }),
    now,
    rightQuotes: quotes({
      asOf: "2026-01-01T00:00:01.000Z",
      marketId: right.marketId,
      noAsk: 0.55,
      venue: right.venue,
      yesAsk: 0.45,
    }),
  });
  assert.equal(stale.execution.quotesFresh, false);
});

await test("requires bundle cost to be strictly below one", () => {
  const asOf = "2026-01-01T00:01:00.000Z";
  const left = market({ id: "poly", venue: "polymarket" });
  const right = market({ id: "limitless", venue: "limitless" });
  const exact = build({
    left,
    right,
    leftQuotes: quotes({
      asOf,
      marketId: left.marketId,
      noAsk: 0.65,
      venue: left.venue,
      yesAsk: 0.4,
    }),
    rightQuotes: quotes({
      asOf,
      marketId: right.marketId,
      noAsk: 0.6,
      venue: right.venue,
      yesAsk: 0.45,
    }),
  });
  assert.equal(exact.execution.bundleCost, 1);
  assert.equal(exact.execution.grossEdge, 0);
  assert.equal(exact.execution.verification.status, "not_candidate");
});

await test("applies Limitless 300 bps gross-up and fails closed on depth", () => {
  const quote = quoteLimitlessLevelsForVerification(
    [{ price: 0.5, size: 10 }],
    9.7,
  );
  assert.equal(quote.filledShares, 9.7);
  assert.ok(Math.abs(quote.totalCost - 5) < 1e-12);
  assert.ok(Math.abs(quote.fees - 0.15) < 1e-12);
  assert.throws(
    () =>
      quoteLimitlessLevelsForVerification([{ price: 0.5, size: 9.99 }], 9.7),
    /depth is insufficient/,
  );
});

await test("verifies equal shares at the larger venue minimum and enforces cap", () => {
  const verified = finalizeClusterExecutionVerification({
    noLeg: { fees: 0.05, filledShares: 5, totalCost: 2.8 },
    noMinShares: 5,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    yesLeg: { fees: 0.05, filledShares: 5, totalCost: 2.1 },
    yesMinShares: 2,
  });
  assert.equal(verified.shares, 5);
  assert.equal(verified.status, "verified");
  assert.ok(Math.abs((verified.netEdge ?? 0) - 0.1) < 1e-12);

  const rejected = finalizeClusterExecutionVerification({
    noLeg: { fees: 0.1, filledShares: 5, totalCost: 2.6 },
    noMinShares: 5,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    yesLeg: { fees: 0.1, filledShares: 5, totalCost: 2.5 },
    yesMinShares: 2,
  });
  assert.equal(rejected.status, "rejected");

  const capped = finalizeClusterExecutionVerification({
    noLeg: { fees: 0, filledShares: 50, totalCost: 25.01 },
    noMinShares: 50,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    yesLeg: { fees: 0, filledShares: 50, totalCost: 20 },
    yesMinShares: 50,
  });
  assert.equal(capped.status, "unavailable");
});

await test("unsupported verification venues fail closed", async () => {
  const candidate = {
    execution: {
      bestNoOffer: {
        ask: 0.5,
        asOf: "2026-01-01T00:00:00.000Z",
        marketId: "kalshi:no",
        nativeOutcome: "NO" as const,
        venue: "kalshi",
      },
      bestYesOffer: {
        ask: 0.49,
        asOf: "2026-01-01T00:00:00.000Z",
        marketId: "dflow:yes",
        nativeOutcome: "YES" as const,
        venue: "dflow",
      },
      bundleCost: 0.99,
      grossEdge: 0.01,
      kind: "comparison" as const,
      midpointGap: 0.05,
      quotesFresh: true,
      verification: {
        netEdge: null,
        shares: null,
        status: "unavailable" as const,
        totalCost: null,
        totalFees: null,
        verifiedAt: null,
      },
    },
    id: "unsupported",
  };
  const pool = {
    async query() {
      return {
        rows: [
          {
            clob_token_ids: null,
            id: "kalshi:no",
            metadata: {},
            order_min_size: null,
            slug: "kalshi-no",
            token_no: "no-token",
            token_yes: "yes-token",
            venue: "kalshi",
          },
          {
            clob_token_ids: null,
            id: "dflow:yes",
            metadata: {},
            order_min_size: null,
            slug: "dflow-yes",
            token_no: "no-token",
            token_yes: "yes-token",
            venue: "dflow",
          },
        ],
      };
    },
  };
  const [result] = await verifyClusterExecutions(
    pool as never,
    [candidate],
    new Date("2026-01-01T00:00:01.000Z"),
  );
  assert.equal(result?.execution.kind, "comparison");
  assert.equal(result?.execution.verification.status, "unavailable");
});

await test("promotes only positive verified net edge to live arbitrage", () => {
  const base = {
    bestNoOffer: null,
    bestYesOffer: null,
    bundleCost: 0.98,
    grossEdge: 0.02,
    kind: "comparison" as const,
    midpointGap: 0.04,
    quotesFresh: true,
    verification: {
      netEdge: null,
      shares: null,
      status: "unavailable" as const,
      totalCost: null,
      totalFees: null,
      verifiedAt: null,
    },
  };
  assert.equal(
    applyClusterExecutionVerification(base, {
      netEdge: 0.1,
      shares: 5,
      status: "verified",
      totalCost: 4.9,
      totalFees: 0.02,
      verifiedAt: "2026-01-01T00:00:00.000Z",
    }).kind,
    "live_arbitrage",
  );
  assert.equal(
    applyClusterExecutionVerification(base, {
      netEdge: -0.1,
      shares: 5,
      status: "rejected",
      totalCost: 5.1,
      totalFees: 0.1,
      verifiedAt: "2026-01-01T00:00:00.000Z",
    }).kind,
    "comparison",
  );
});

await test("re-enriches a cached base cluster from current DB tops", async () => {
  let yesAsk = 0.6;
  let quoteTime = "2026-01-01T00:01:00.000Z";
  const left = market({ id: "poly", venue: "polymarket" });
  const right = market({ id: "limitless", venue: "limitless" });
  const db = {
    async query() {
      return {
        rows: [
          {
            active: true,
            market_id: left.marketId,
            no_ask: 0.7,
            no_bid: 0.69,
            no_ts: quoteTime,
            orderable: true,
            venue: left.venue,
            yes_ask: yesAsk,
            yes_bid: yesAsk - 0.01,
            yes_ts: quoteTime,
          },
          {
            active: true,
            market_id: right.marketId,
            no_ask: 0.6,
            no_bid: 0.59,
            no_ts: quoteTime,
            orderable: true,
            venue: right.venue,
            yes_ask: 0.7,
            yes_bid: 0.69,
            yes_ts: quoteTime,
          },
        ],
      };
    },
  };
  const base = {
    id: "cached-cluster",
    markets: [left, right],
    priceSpread: 0.1,
    seedMarketId: left.marketId,
    totalLiquidity: 200,
    volume24h: 20,
  };

  const first = await enrichClusterExecutions(
    db as never,
    [base],
    new Date("2026-01-01T00:02:00.000Z"),
  );
  yesAsk = 0.58;
  quoteTime = "2026-01-01T00:01:30.000Z";
  const second = await enrichClusterExecutions(
    db as never,
    [base],
    new Date("2026-01-01T00:02:00.000Z"),
  );

  assert.equal(first[0]?.execution.bestYesOffer?.ask, 0.6);
  assert.equal(second[0]?.execution.bestYesOffer?.ask, 0.58);
  assert.equal(
    second[0]?.execution.bestYesOffer?.asOf,
    "2026-01-01T00:01:30.000Z",
  );
});
