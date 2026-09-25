import assert from "node:assert/strict";

import {
  buildHolderResearchCandidatePromptJson,
  buildHolderResearchCandidatePromptJsonV2,
  buildHolderResearchCandidatesFromMarket,
  buildHolderResearchDecisionFeaturesV2,
  buildHolderResearchExternalSearchInput,
  buildHolderResearchExternalSearchInputV2,
  buildHolderResearchTriageCandidatePromptJsonV2,
  buildHolderResearchTriageCandidatePromptJson,
  type HolderResearchCandidate,
  type HolderResearchHolder,
  type HolderResearchMarketInput,
  type HolderResearchSide,
} from "./services/holder-research.js";
import { getIntelPolicyDefaults } from "./services/runtime-policies.js";

const policy = getIntelPolicyDefaults("holder_research");
const side = (internalSide: "YES" | "NO"): HolderResearchSide => ({
  side: internalSide,
  usd: 10_000,
  wallets: 1,
  openPnlUsd: null,
  sharpHolders: 0,
  sharpUsd: 0,
  bestEdge: null,
  bestZScore: null,
  bestSampleCount: null,
  bestResolvedStakeUsd: null,
  bestTrades30d: null,
});

function candidate(
  marketOverrides: Partial<HolderResearchMarketInput>,
): HolderResearchCandidate {
  return {
    key: "prompt-contract-test",
    thesisKey: "holder_research:v2:test:NO",
    inputDigest: "test-digest",
    bucket: "sharp_side",
    score: 0.8,
    side: "NO",
    direction: "down",
    signalType: "catalyst",
    reasons: [],
    evidence: [],
    cooldownUntil: null,
    meaningfulDeltaReasons: [],
    market: {
      marketId: "test",
      eventId: null,
      venue: "polymarket",
      marketTitle: "Test condition",
      marketSlug: null,
      marketDescription: "The exact contract threshold and resolution stage.",
      outcomes: ["Yes", "No"],
      eventTitle: "Test event",
      eventSlug: null,
      eventDescription: "Separate event-level context.",
      seriesKey: null,
      seriesTitle: null,
      resolutionSource: "The named official source determines settlement.",
      category: "Politics",
      closeTime: "2026-10-02T16:00:00.000Z",
      expirationTime: "2026-10-03T16:00:00.000Z",
      yesProbability: 0.6,
      volume24h: null,
      liquidity: null,
      marketMovementContext: {
        yesProbabilityNow: 0.6,
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
      sides: { YES: side("YES"), NO: side("NO") },
      holders: [],
      recentActivityUsd: 0,
      recentActivityAt: null,
      crossMarketWalletCount: 0,
      previousNote: null,
      ...marketOverrides,
    },
  };
}

function promptVariants(input: HolderResearchCandidate) {
  return [
    buildHolderResearchTriageCandidatePromptJsonV2(input, policy),
    buildHolderResearchCandidatePromptJsonV2(input, policy, {
      status: "not_requested",
      verdict: "unknown",
      timing: "unknown",
      summary: "External research was not requested.",
      citations: [],
      comparableOdds: null,
    }),
    buildHolderResearchExternalSearchInputV2(input, policy, "market_context"),
  ];
}

const cases = [
  {
    title: "NFL matchup",
    outcomes: ["New York Giants", "Philadelphia Eagles"],
    selected: "Philadelphia Eagles",
    opposite: "New York Giants",
    winCondition: null,
  },
  {
    title: "Bitcoin Up or Down",
    outcomes: ["Down", "Up"],
    selected: "Up",
    opposite: "Down",
    winCondition: null,
  },
  {
    title: "France",
    outcomes: null,
    selected: "betting against France",
    opposite: "backing France",
    winCondition: null,
  },
  {
    title: "O/U 2.5 total goals",
    outcomes: ["Over", "Under"],
    selected: "Under 2.5 total goals",
    opposite: "Over 2.5 total goals",
    winCondition: "0-2 total goals",
  },
] as const;

for (const test of cases) {
  const input = candidate({
    marketTitle: test.title,
    outcomes: test.outcomes ? [...test.outcomes] : null,
  });
  assert.equal(
    buildHolderResearchDecisionFeaturesV2(input, policy).market.sideLabel,
    test.selected,
  );
  for (const prompt of promptVariants(input)) {
    const contract = prompt.contract as {
      description: string;
      eventDescription: string;
      resolutionSource: string;
      closesAt: string;
      expiresAt: string;
      selectedSide: string;
      oppositeSide: string;
      outcomeMapping: Record<
        "YES" | "NO",
        {
          internalSide: string;
          outcomeLabel: string;
          plainPosition: string;
          winCondition: string | null;
        }
      >;
      sideKeyMeaning: string;
    };
    assert.equal(contract.selectedSide, "NO");
    assert.equal(contract.oppositeSide, "YES");
    assert.equal(contract.outcomeMapping.NO.internalSide, "NO");
    assert.equal(contract.outcomeMapping.NO.outcomeLabel, test.selected);
    assert.equal(contract.outcomeMapping.NO.plainPosition, test.selected);
    assert.equal(contract.outcomeMapping.NO.winCondition, test.winCondition);
    assert.equal(contract.outcomeMapping.YES.outcomeLabel, test.opposite);
    assert.equal(contract.description, input.market.marketDescription);
    assert.equal(contract.eventDescription, input.market.eventDescription);
    assert.equal(contract.resolutionSource, input.market.resolutionSource);
    assert.equal(contract.closesAt, input.market.closeTime);
    assert.equal(contract.expiresAt, input.market.expirationTime);
    assert.match(
      contract.sideKeyMeaning,
      /internal outcome keys, not public labels/,
    );
  }
  for (const prompt of [
    buildHolderResearchCandidatePromptJson(input, policy),
    buildHolderResearchTriageCandidatePromptJson(input, policy),
    buildHolderResearchExternalSearchInput(input),
  ]) {
    const market = prompt.mkt as {
      labels: { YES: string; NO: string };
      sideCopy: {
        label: string;
        plainPosition: string;
        winCondition: string | null;
      };
    };
    assert.deepEqual(market.labels, { YES: test.opposite, NO: test.selected });
    assert.equal(market.sideCopy.label, test.selected);
    assert.equal(market.sideCopy.plainPosition, test.selected);
    assert.equal(market.sideCopy.winCondition, test.winCondition);
  }
}

const updateCandidate = candidate({
  previousNote: {
    noteId: "previous-published-note",
    createdAt: "2026-09-24T14:00:00.000Z",
    title: "Prior published thesis",
    summary: "The prior thesis and the uncertainty the reader already saw.",
    inputDigest: "previous-digest",
    cooldownUntil: null,
    walletTargets: [],
    externalResearch: {
      status: "ok",
      verdict: "supports_holder_side",
      timing: "unknown",
      summary: "An older verified outside fact.",
      citations: [
        {
          title: "Prior report",
          url: "https://example.com/prior-report",
          publishedAt: "2026-09-24T12:00:00.000Z",
        },
      ],
      comparableOdds: null,
      freshFact: {
        fact: "The prior exact-contract outside fact.",
        sourceUrl: "https://example.com/prior-report",
        eventAt: "2026-09-24T11:00:00.000Z",
        matchesExactContract: true,
        supportsSelectedSide: true,
        trackerUpdateOnly: false,
      },
    },
  },
});
updateCandidate.meaningfulDeltaReasons = ["holder_position_move:NO"];
for (const prompt of promptVariants(updateCandidate)) {
  const contract = prompt.contract as Record<string, unknown>;
  assert.deepEqual(contract.meaningfulDeltaReasons, [
    "holder_position_move:NO",
  ]);
  assert.match(
    JSON.stringify(contract.priorNote),
    /prior exact-contract outside fact/,
  );
  assert.match(JSON.stringify(contract.priorNote), /2026-09-24T11:00:00.000Z/);
  assert.match(
    JSON.stringify(contract.priorNote),
    /not new or independent evidence/,
  );
}
const v1Update = buildHolderResearchCandidatePromptJson(
  updateCandidate,
  policy,
);
const priorV1 = (v1Update.mkt as Record<string, unknown>).prevNote;
assert.match(JSON.stringify(priorV1), /prior thesis and the uncertainty/);
assert.match(JSON.stringify(priorV1), /https:\/\/example.com\/prior-report/);

const observedHolder: HolderResearchHolder = {
  walletId: "test-holder",
  address: "test-address",
  chain: "polygon",
  label: null,
  identityDisplayName: null,
  identityDisplayNameSource: null,
  identityProfileUrl: null,
  side: "NO",
  positionUsd: 100_000,
  positionShares: null,
  openPnlUsd: null,
  realizedPnlUsd: null,
  totalPnlUsd: null,
  avgEntryPrice: null,
  currentPrice: 0.4,
  entryToCurrentDelta: null,
  approxReliable: null,
  approxPnlSource: null,
  positionSnapshotAt: "2026-09-25T12:00:00.000Z",
  firstObservedActivityAt: "2026-09-01T12:00:00.000Z",
  latestSupportingActivityAt: "2026-09-24T12:00:00.000Z",
  livePositionConfirmedAt: "2026-09-25T12:00:00.000Z",
  pnl30dUsd: null,
  resolvedWinRateEdge30d: 0.5,
  resolvedEdgeZScore30d: 10,
  resolvedEdgeSampleCount30d: 1000,
  resolvedStakeUsd30d: 100_000,
  trades30d: 90,
  winRate30d: null,
  volume30dUsd: null,
  walletKind: null,
  ownerAddress: null,
  walletUsdLikeBalance: null,
  ownerUsdLikeBalance: null,
  mmSuspected: false,
  relatedOpenPositions: [],
  marketSegmentMetrics30d: {
    walletId: "test-holder",
    marketType: "politics_geo",
    marketSegment: "politics_geo",
    period: "30d",
    asOf: "2026-09-25T12:00:00.000Z",
    tradesCount: 90,
    volumeUsd: 100_000,
    pnlUsd: 5_000,
    roi: 0.05,
    winRate: null,
    resolvedEdgeSampleCount: 1000,
    resolvedActualWinRate: null,
    resolvedExpectedWinRate: null,
    resolvedWinRateEdge: 0.2,
    resolvedEdgeZScore: 4,
    resolvedBrierScore: null,
    resolvedStakeWeightedEdge: null,
    resolvedStakeUsd: 50_000,
    lastTradeAt: "2026-09-24T12:00:00.000Z",
    approximate: true,
    unmarkedOpenLegCount: 0,
  },
};
const activityCandidate = candidate({ holders: [observedHolder] });
const activityV1 = buildHolderResearchCandidatePromptJson(
  activityCandidate,
  policy,
);
const activityV2 = buildHolderResearchCandidatePromptJsonV2(
  activityCandidate,
  policy,
  {
    status: "not_requested",
    verdict: "unknown",
    timing: "unknown",
    summary: "External research was not requested.",
    citations: [],
    comparableOdds: null,
  },
);
for (const prompt of [activityV1, activityV2]) {
  const entries = prompt.holders as Array<Record<string, unknown>>;
  const activity = entries[0]?.activityContext as Record<string, unknown>;
  assert.equal(activity.averageObservedActivityEventsPerDay30d, 3);
  assert.equal(
    activity.firstObservedExactSideActivityAt,
    observedHolder.firstObservedActivityAt,
  );
  assert.equal(
    activity.latestSupportingActivityAt,
    observedHolder.latestSupportingActivityAt,
  );
  assert.equal(
    activity.livePositionConfirmedAt,
    observedHolder.livePositionConfirmedAt,
  );
  assert.match(String(activity.scope), /not exact filled orders/);
  assert.match(
    String(activity.scope),
    /holding duration and trading style are unknown/,
  );
}
const triageContext = buildHolderResearchTriageCandidatePromptJsonV2(
  activityCandidate,
  policy,
).holderContext as Array<Record<string, unknown>>;
assert.equal(triageContext.length, 1);
assert.match(JSON.stringify(triageContext[0]?.specialization), /politics_geo/);
assert.match(
  JSON.stringify(triageContext[0]?.specialization),
  /"samples30d":1000/,
);

const evidenceMarket = candidate({
  marketTitle: "NFL matchup",
  outcomes: ["New York Giants", "Philadelphia Eagles"],
  holders: [observedHolder],
}).market;
evidenceMarket.sides.NO = {
  ...evidenceMarket.sides.NO,
  usd: 100_000,
  sharpHolders: 1,
  sharpUsd: 100_000,
  bestEdge: 0.5,
  bestZScore: 10,
  bestSampleCount: 1000,
  bestResolvedStakeUsd: 100_000,
  bestTrades30d: 90,
};
const evidence = buildHolderResearchCandidatesFromMarket(
  evidenceMarket,
  policy,
).flatMap((entry) => entry.evidence);
assert.ok(evidence.length > 0);
assert.ok(
  evidence.some(
    (entry) =>
      entry.kind === "holder" && entry.title.endsWith("Philadelphia Eagles"),
  ),
);
assert.ok(
  evidence.some(
    (entry) =>
      entry.kind === "market" && entry.summary.includes("New York Giants"),
  ),
);
assert.ok(
  evidence.some(
    (entry) =>
      entry.kind === "side" && entry.title === "Philadelphia Eagles side",
  ),
);
assert.ok(evidence.every((entry) => entry.title !== "NO side"));

console.log(
  `[holder-research-prompt-contract-tests] passed ${cases.length} outcome mappings across triage, final and external research`,
);
