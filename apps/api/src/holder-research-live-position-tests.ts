import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  applyHolderResearchPublishQualityGate,
  buildHolderResearchActorSummary,
  buildHolderResearchCandidatesFromMarket,
  buildHolderResearchDecisionFeaturesV2,
  buildHolderResearchWalletTargets,
  enrichHolderResearchLivePositions,
  type HolderResearchCandidate,
  type HolderResearchHolder,
  type HolderResearchMarketInput,
  type HolderResearchSide,
} from "./services/holder-research.js";
import { getIntelPolicyDefaults } from "./services/runtime-policies.js";

const policy = {
  ...getIntelPolicyDefaults("holder_research"),
  minScore: 0,
  minSidePositionUsd: 10_000,
  minPublishEntryPrice: 0,
  maxPublishHorizonHours: 24 * 365,
};
const snapshotAt = new Date();

function holder(index: number): HolderResearchHolder {
  return {
    walletId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    address: `0xholder${index}`,
    chain: "polygon",
    label: null,
    identityDisplayName: null,
    identityDisplayNameSource: null,
    identityProfileUrl: null,
    side: "YES",
    positionUsd: 10_000,
    positionShares: null,
    openPnlUsd: null,
    realizedPnlUsd: null,
    totalPnlUsd: null,
    avgEntryPrice: null,
    currentPrice: null,
    entryToCurrentDelta: null,
    approxReliable: null,
    approxPnlSource: null,
    positionSnapshotAt: null,
    pnl30dUsd: 2_500,
    resolvedWinRateEdge30d: 0.2,
    resolvedEdgeZScore30d: 3,
    resolvedEdgeSampleCount30d: 30,
    resolvedStakeUsd30d: 10_000,
    trades30d: 30,
    winRate30d: 0.7,
    volume30dUsd: 40_000,
    walletKind: null,
    ownerAddress: null,
    walletUsdLikeBalance: null,
    ownerUsdLikeBalance: null,
    mmSuspected: false,
    relatedOpenPositions: [],
  };
}

function side(sideName: "YES" | "NO", count: number): HolderResearchSide {
  return {
    side: sideName,
    usd: count * 10_000,
    wallets: count,
    openPnlUsd: null,
    sharpHolders: count,
    sharpUsd: count * 10_000,
    bestEdge: count ? 0.2 : null,
    bestZScore: count ? 3 : null,
    bestSampleCount: count ? 30 : null,
    bestResolvedStakeUsd: count ? 10_000 : null,
    bestTrades30d: count ? 30 : null,
  };
}

function candidate(count = 2, retained = count): HolderResearchCandidate {
  const market: HolderResearchMarketInput = {
    marketId: "polymarket:live-position-test",
    eventId: null,
    venue: "polymarket",
    marketTitle: "Will the treaty be ratified?",
    marketSlug: null,
    marketDescription: null,
    outcomes: null,
    eventTitle: null,
    eventSlug: null,
    eventDescription: null,
    seriesKey: null,
    seriesTitle: null,
    resolutionSource: null,
    category: "Politics",
    closeTime: new Date(Date.now() + 86_400_000).toISOString(),
    expirationTime: null,
    yesProbability: 0.5,
    volume24h: null,
    liquidity: null,
    marketMovementContext: {
      yesProbabilityNow: 0.5,
      yesDeltaProbability24h: null,
      volume24h: null,
      volumeChange24h: null,
      volumeChangePct24h: null,
      liquidity: null,
      liquidityChange24h: null,
      liquidityChangePct24h: null,
      openInterestChange24h: null,
      openInterestChangePct24h: null,
      updatedAt: null,
      previousDecisionYesProbability: null,
      yesChangeSincePreviousDecision: null,
      previousDecisionCheckedAt: null,
    },
    livePriceCheck: null,
    sides: { YES: side("YES", count), NO: side("NO", 0) },
    holders: Array.from({ length: retained }, (_, index) => holder(index + 1)),
    recentActivityUsd: 0,
    recentActivityAt: null,
    crossMarketWalletCount: 0,
    previousNote: null,
  };
  const result = buildHolderResearchCandidatesFromMarket(market, policy).find(
    (item) => item.bucket === "sharp_side" && item.side === "YES",
  );
  assert.ok(result);
  return result;
}

type SnapshotValue = { shares: number | null; usd: number | null };

async function refresh(
  input: HolderResearchCandidate,
  values: Array<SnapshotValue | undefined>,
  maxLiveChecksPerRun = 16,
): Promise<HolderResearchCandidate> {
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (!sql.includes("from wallet_position_snapshots ws")) {
        return { rows: [] };
      }
      const requested = JSON.parse(String(params?.[0])) as Array<{
        wallet_id: string;
      }>;
      return {
        rows: requested.flatMap((request) => {
          const index = input.market.holders.findIndex(
            (item) => item.walletId === request.wallet_id,
          );
          const value = values[index];
          if (!value) return [];
          return [
            {
              wallet_id: request.wallet_id,
              venue: input.market.venue,
              market_id: input.market.marketId,
              outcome_side: "YES",
              shares: value.shares == null ? null : String(value.shares),
              size_usd: value.usd == null ? null : String(value.usd),
              price: "0.5",
              snapshot_at: snapshotAt,
              metadata: null,
              best_bid: "0.49",
              best_ask: "0.51",
              last_price: "0.5",
              resolved_outcome: null,
              resolved_outcome_pct: null,
            },
          ];
        }),
      };
    },
  } as unknown as PoolClient;
  const [result] = await enrichHolderResearchLivePositions(client, [input], {
    ...policy,
    maxLiveChecksPerRun,
  });
  assert.ok(result);
  return result;
}

function actor(input: HolderResearchCandidate) {
  return buildHolderResearchActorSummary({
    candidate: input,
    evidenceIds: input.evidence.map((item) => item.id),
    policy,
  });
}

const original = candidate();
const initialHolder = original.market.holders[0];
assert.ok(initialHolder);
initialHolder.latestSupportingActivityAt = snapshotAt.toISOString();
original.market.latestSharpSideActivityAt = snapshotAt.toISOString();
const closed = await refresh(original, [
  { shares: 0, usd: null },
  { shares: 0, usd: 10_000 },
]);
assert.equal(closed.market.sides.YES.usd, 0);
assert.equal(closed.market.sides.YES.wallets, 0);
assert.equal(closed.market.sides.YES.sharpUsd, 0);
assert.equal(closed.market.sides.YES.sharpHolders, 0);
assert.equal(closed.market.sides.YES.bestEdge, null);
assert.equal(closed.market.holders.length, 0);
assert.equal(closed.market.latestSharpSideActivityAt, null);
assert.equal(
  closed.evidence.filter((item) => item.kind === "holder").length,
  0,
);
assert.equal(actor(closed).mode, "none");
assert.deepEqual(buildHolderResearchWalletTargets(closed, [], policy), []);
assert.match(
  closed.evidence.find((item) => item.kind === "side")?.summary ?? "",
  /\$0, 0 wallets, 0 sharp holders/,
);
const gated = applyHolderResearchPublishQualityGate({
  candidate: closed,
  policy,
  output: {
    version: "holder_research_v1",
    status: "PUBLISH",
    bucket: closed.bucket,
    confidence: 0.8,
    signal_type: "update",
    direction: "up",
    headline: "Treaty ratification backed",
    summary: "Strong traders hold the ratification side.",
    rationale: "Current holder evidence supports this side.",
    public_context_risk: "unknown",
    execution_priority: "normal",
    execution_priority_reason: "",
    evidence_ids: closed.evidence.map((item) => item.id),
    caveats: [],
  },
});
assert.equal(gated.status, "CONTEXT");
assert.equal(original.market.sides.YES.usd, 20_000);
assert.equal(original.market.holders.length, 2);

const reduced = await refresh(original, [{ shares: 12_000, usd: 6_000 }]);
assert.equal(reduced.market.sides.YES.usd, 16_000);
assert.equal(reduced.market.sides.YES.sharpUsd, 16_000);
assert.equal(reduced.market.sides.YES.sharpHolders, 2);
assert.equal(actor(reduced).cluster?.sharpUsd, 16_000);
assert.equal(
  buildHolderResearchDecisionFeaturesV2(reduced, policy).selectedSide?.sharpUsd,
  16_000,
);
assert.match(
  reduced.evidence.find((item) => item.kind === "holder")?.summary ?? "",
  /^\$6\.0K open/,
);

const noLongerSharp = await refresh(original, [{ shares: 2_000, usd: 1_000 }]);
assert.equal(noLongerSharp.market.sides.YES.usd, 11_000);
assert.equal(noLongerSharp.market.sides.YES.wallets, 2);
assert.equal(noLongerSharp.market.sides.YES.sharpHolders, 1);
assert.equal(noLongerSharp.market.sides.YES.sharpUsd, 10_000);
assert.notEqual(actor(noLongerSharp).mode, "sharp_cluster");

const timed = candidate();
const [earlierHolder, laterHolder] = timed.market.holders;
assert.ok(earlierHolder && laterHolder);
earlierHolder.firstObservedActivityAt = "2026-09-01T00:00:00Z";
laterHolder.firstObservedActivityAt = "2026-09-24T00:00:00Z";
timed.market.firstObservedActivityAt = "2026-09-01T00:00:00Z";
for (const changed of [
  { shares: 0, usd: 0 },
  { shares: 2_000, usd: 1_000 },
]) {
  const refreshed = await refresh(timed, [changed]);
  assert.equal(
    refreshed.market.firstObservedActivityAt,
    "2026-09-24T00:00:00Z",
  );
  assert.equal(
    buildHolderResearchDecisionFeaturesV2(refreshed, policy).timing
      .firstActivityAt,
    "2026-09-24T00:00:00Z",
  );
}
const noTimedHolders = await refresh(timed, [
  { shares: 0, usd: 0 },
  { shares: 0, usd: 0 },
]);
assert.equal(noTimedHolders.market.firstObservedActivityAt, undefined);
assert.equal(
  buildHolderResearchDecisionFeaturesV2(noTimedHolders, policy).timing
    .firstActivityAt,
  null,
);

const distinctBest = candidate();
const secondHolder = distinctBest.market.holders[1];
assert.ok(secondHolder);
secondHolder.resolvedWinRateEdge30d = 0.12;
const bestRemoved = await refresh(distinctBest, [{ shares: 0, usd: 0 }]);
assert.equal(bestRemoved.market.sides.YES.bestEdge, 0.12);

const supported = candidate();
supported.market.recentActivityUsd = 20_000;
const supportId = `support:recent_flow:holder_research:v1:recent_flow:${supported.market.marketId}:mixed`;
const foreignSupportId =
  "support:recent_flow:holder_research:v1:recent_flow:other-market:mixed";
supported.evidence.push(
  {
    id: supportId,
    kind: "market",
    title: "Recent flow context",
    summary: "$20K, 2 sharp holders.",
    relevance: 0.45,
  },
  {
    id: foreignSupportId,
    kind: "market",
    title: "Other market context",
    summary: "Other market evidence.",
    relevance: 0.45,
  },
);
const refreshedSupport = await refresh(supported, [
  { shares: 12_000, usd: 6_000 },
]);
assert.match(
  refreshedSupport.evidence.find((item) => item.id === supportId)?.summary ??
    "",
  /\$16\.0K/,
);
assert.equal(
  refreshedSupport.evidence.find((item) => item.id === foreignSupportId)
    ?.summary,
  "Other market evidence.",
);
const closedSupport = await refresh(supported, [
  { shares: 0, usd: 0 },
  { shares: 0, usd: 0 },
]);
assert.ok(!closedSupport.evidence.some((item) => item.id === supportId));

const missing = await refresh(original, []);
assert.deepEqual(missing.market.sides, original.market.sides);
assert.equal(missing.market.holders.length, 2);
assert.ok(
  missing.market.holders.every((item) => item.livePositionConfirmedAt == null),
);
const nullValue = await refresh(original, [{ shares: null, usd: null }]);
assert.equal(nullValue.market.sides.YES.usd, 20_000);
assert.equal(nullValue.market.holders[0]?.positionUsd, 10_000);
assert.equal(nullValue.market.holders[0]?.livePositionConfirmedAt, null);

const withTail = candidate(10, 8);
const tailPreserved = await refresh(withTail, [
  { shares: 0, usd: 0 },
  { shares: 12_000, usd: 6_000 },
]);
assert.equal(tailPreserved.market.sides.YES.usd, 86_000);
assert.equal(tailPreserved.market.sides.YES.wallets, 9);
assert.equal(tailPreserved.market.sides.YES.sharpUsd, 86_000);
assert.equal(tailPreserved.market.sides.YES.sharpHolders, 9);
assert.equal(tailPreserved.market.sides.YES.openPnlUsd, null);
const allRetainedClosed = await refresh(
  withTail,
  Array.from({ length: 8 }, () => ({ shares: 0, usd: 0 })),
);
assert.equal(allRetainedClosed.market.sides.YES.usd, 20_000);
assert.equal(allRetainedClosed.market.sides.YES.sharpHolders, 2);
assert.equal(allRetainedClosed.market.sides.YES.bestEdge, null);

const limited = await refresh(
  original,
  [
    { shares: 0, usd: 0 },
    { shares: 0, usd: 0 },
  ],
  1,
);
assert.equal(limited.market.sides.YES.usd, 10_000);
assert.equal(limited.market.holders.length, 1);
assert.equal(limited.market.holders[0]?.livePositionConfirmedAt, null);

const otherCandidate = candidate(1);
otherCandidate.market.marketId = "polymarket:other-live-position-test";
let selectedPairs: Array<{ market_id: string; wallet_id: string }> = [];
let queryCount = 0;
const countClient = {
  query: async (_sql: string, params?: unknown[]) => {
    selectedPairs = JSON.parse(String(params?.[0]));
    queryCount += 1;
    return { rows: [] };
  },
} as unknown as PoolClient;
await enrichHolderResearchLivePositions(
  countClient,
  [original, original, otherCandidate],
  { ...policy, maxLiveChecksPerRun: 3 },
);
assert.equal(queryCount, 1);
assert.equal(selectedPairs.length, 3);
assert.equal(selectedPairs[2]?.market_id, otherCandidate.market.marketId);

console.log(
  "[holder-research-live-position-tests] passed closure, reduction, sharp eligibility, unavailable data, aggregate tail, and bounded-refresh regressions",
);
