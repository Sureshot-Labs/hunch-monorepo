import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectHip4HolderKnownWalletMarkets,
  loadHip4HolderResearchKnownWalletPage,
  HIP4_HOLDER_RESEARCH_SOURCE_SQL,
  HIP4_HOLDER_RESEARCH_POSITIONS_SQL,
  HIP4_HOLDER_RESEARCH_ACTIVITY_SQL,
  HIP4_HOLDER_RESEARCH_MARKETS_SQL,
  type Hip4HolderSourceRow,
} from "./services/holder-research-hip4-known-wallets.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import {
  hip4WalletIntelIdentity,
  normalizeHip4KnownWalletFill,
  hip4TrackedFillFingerprint,
  projectHip4KnownWalletIntel,
} from "./services/hip4-wallet-intel.js";
import {
  applyHolderResearchPublishQualityGate,
  buildDeterministicHolderResearchDecision,
  buildHolderResearchCandidatesFromMarket,
  buildHolderResearchCandidatePromptJson,
  buildHolderResearchCandidatePromptJsonV2,
  buildHolderResearchTriageCandidatePromptJson,
  buildHolderResearchTriageCandidatePromptJsonV2,
  buildHolderResearchInputDigest,
  listHolderResearchPromptEvidenceIdsV2,
  adaptHolderResearchFinalOutputV2,
  selectHolderResearchCandidates,
  enrichHolderResearchLivePositions,
  enrichHolderResearchMarketTypeMetrics,
} from "./services/holder-research.js";
import { getIntelPolicyDefaults } from "./services/runtime-policies.js";
import type { PoolClient } from "pg";

const asOf = new Date("2026-10-16T12:00:00.000Z");
const snapshotAt = new Date(asOf.getTime() - 60_000).toISOString();
const identity = hip4WalletIntelIdentity(
  "mainnet",
  "0x0000000000000000000000000000000000001234",
);
const walletId = "00000000-0000-4000-8000-000000000001";
const { market } = mapHip4Market({
  environment: "mainnet",
  outcome: 41,
  metadata: {
    outcomes: [
      {
        outcome: 41,
        name: "template:binaryPrice",
        description:
          "perp:HYPE|priceDescription:HYPE-USDC perp mark|seconds:60|threshold:85.469|time:20261016-1300",
        sideSpecs: [{ name: "template:Yes" }, { name: "template:No" }],
        quoteToken: "USDC",
      },
    ],
  },
  spotMetadata: {
    tokens: [
      {
        name: "USDC",
        index: 0,
        tokenId: "fixture-usdc",
        weiDecimals: 8,
        szDecimals: 8,
      },
    ],
  },
  fetchedAt: snapshotAt,
  generation: "synthetic-read",
});
const rawFill = (tid = 200) => ({
  coin: "#410",
  px: "0.25",
  sz: "100",
  side: "B",
  time: asOf.getTime() - 1000,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "0",
  hash: `0x${"1".repeat(64)}`,
  oid: 100,
  crossed: true,
  fee: "0",
  tid,
  feeToken: "USDC",
});
const observed = (value: unknown) => ({
  available: true as const,
  observedAt: snapshotAt,
  value,
});
const coverage = projectHip4KnownWalletIntel({
  identity,
  role: { role: "user" },
  abstraction: "disabled",
  quote: { tokenId: "fixture-usdc", index: 0, weiDecimals: 8 },
  positions: observed({
    balances: [{ coin: "+410", total: "123.00001", hold: "0", entryNtl: "1" }],
  }),
  openOrders: observed([]),
  fills: observed([]),
}).coverage;
const subject = {
  wallet_id: walletId,
  address: identity.address,
  chain: identity.chain,
  followed: true,
  tracked: false,
  metadata: { hip4Intel: { coverage, lastCompletePositionsAt: snapshotAt } },
};
const position = {
  wallet_id: walletId,
  market_id: market.marketId,
  outcome_side: "YES",
  shares: "123.00001",
  size_usd: null,
  price: null,
  metadata: {
    source: "hip4_known_wallet",
    tokenId: market.sides[0].tokenId,
    coverage,
    costBasis: "unknown",
  },
  snapshot_at: snapshotAt,
};
const catalog = {
  venue: "hyperliquid",
  id: market.marketId,
  event_id: market.eventId,
  title: market.title,
  slug: null,
  description: market.description,
  metadata: { hip4: market },
  outcomes: ["Yes", "No"],
  status: "ACTIVE",
  resolved_outcome: null,
  close_time: market.expiry,
  expiration_time: market.expiry,
  category: "crypto",
  volume_24h: null,
  liquidity: null,
  event_title: market.eventTitle,
  event_status: "ACTIVE",
  event_end_date: market.expiry,
};
function activity(tid = 200, valued = true) {
  const fill = normalizeHip4KnownWalletFill({
    identity,
    observedAt: asOf.toISOString(),
    value: rawFill(tid),
    ...(valued
      ? { quoteTokensByMarket: new Map([[market.marketId, "USDC"]]) }
      : {}),
  });
  assert.equal(fill.kind, "trade");
  if (fill.kind !== "trade") throw new Error("fixture");
  const native = fill.activity;
  return {
    wallet_id: walletId,
    market_id: native.marketId,
    venue: native.venue,
    outcome_side: native.outcomeSide,
    action: native.action,
    delta_shares: native.deltaShares,
    size_usd: native.sizeUsd,
    price: native.price,
    activity_type: "trade",
    source: "hyperliquid_user_fills",
    source_event_key: native.sourceEventKey,
    metadata: {
      source: "hyperliquid_user_fills",
      scope: "known_wallet_only",
      completeHistory: false,
      costBasis: "unknown",
      nativeFill: native,
      nativeFingerprint: hip4TrackedFillFingerprint(native),
      nativeRecheck: {
        version: 1,
        provenance: "fresh_official_user_fills",
        state: "verified",
        sourceEventKey: native.sourceEventKey,
        retainedFingerprint: hip4TrackedFillFingerprint(native),
        lastObservedFingerprint: hip4TrackedFillFingerprint(native),
        observationId: "synthetic-fresh-provider-observation",
        observationStartedAtMs: asOf.getTime() - 100,
        checkedAtMs: asOf.getTime(),
        conflictObservationId: null,
        conflictAtMs: null,
      },
    },
    occurred_at: native.occurredAt,
  };
}
const input = () => ({
  environment: "mainnet" as const,
  asOf,
  subjects: [subject],
  positions: [position],
  activities: [activity(), activity(201)],
  markets: [catalog],
});
const policy = {
  ...getIntelPolicyDefaults("holder_research"),
  minScore: 0,
  minRecentActivityUsd: 10,
  maxPublishHorizonHours: 24 * 365,
  minPublishEntryPrice: 0,
  maxPublishHorizonHoursByCategory: {},
};
const external = {
  status: "not_requested" as const,
  query: "",
  summary: "",
  citations: [],
  verdict: "unknown" as const,
  timing: "unknown" as const,
  freshFact: null,
};

test("native factual positions retain exact shares and null USD without credentials", () => {
  const [result] = projectHip4HolderKnownWalletMarkets(input());
  const native = result.nativeKnownWalletEvidence;
  assert.ok(native);
  assert.equal(native.positions[0].shares, "123.00001");
  assert.equal(native.positions[0].positionUsd, null);
  assert.equal(native.positions[0].snapshotAt, snapshotAt);
  assert.equal(native.unknownUsdPositions, 1);
  assert.equal(native.globalHolders, "unavailable");
  assert.equal(native.historicalPerformance, "unavailable");
  assert.equal(native.costBasis, "unknown");
  assert.equal(native.fills.length, 2);
  assert.equal(native.pricedFlowUsd, "50");
  assert.deepEqual(result.holders, []);
  const [candidate] = buildHolderResearchCandidatesFromMarket(result, policy);
  assert.equal(candidate.bucket, "recent_flow");
  assert.equal(candidate.side, null);
  assert.equal(
    candidate.evidence.filter((row) => row.kind === "activity").length,
    2,
  );
  assert.equal(
    selectHolderResearchCandidates([candidate], policy).selected.length,
    0,
    "existing support-only authority is unchanged",
  );
});

test("snapshots, unvalued fills, and unrelated or disputed activity cannot fake flow materiality", () => {
  for (const activities of [
    [],
    [activity(200, false)],
    [{ ...activity(), source: "snapshot_delta" }],
    [{ ...activity(), activity_type: "delta" }],
    [{ ...activity(), action: "DEPOSIT" }],
    [{ ...activity(), source_event_key: "another-fill" }],
  ]) {
    const [result] = projectHip4HolderKnownWalletMarkets({
      ...input(),
      activities,
    });
    assert.equal(
      result.nativeKnownWalletEvidence?.positions[0].positionUsd,
      null,
    );
    assert.equal(
      buildHolderResearchCandidatesFromMarket(result, policy).length,
      0,
    );
  }
  for (const modify of [
    (value: ReturnType<typeof activity>) => ({ ...value, price: "0.5" }),
    (value: ReturnType<typeof activity>) => ({
      ...value,
      metadata: { ...value.metadata, nativeFingerprint: "wrong" },
    }),
    (value: ReturnType<typeof activity>) => ({
      ...value,
      market_id: "hyperliquid:testnet:outcome:41",
    }),
  ]) {
    const [result] = projectHip4HolderKnownWalletMarkets({
      ...input(),
      activities: [modify(activity())],
    });
    assert.equal(result.nativeKnownWalletEvidence?.fills.length, 0);
  }
});

test("wrong recurring instance/environment/token/expiry or parent status does not enter research", () => {
  for (const changed of [
    { ...catalog, id: "hyperliquid:testnet:outcome:41" },
    { ...catalog, event_id: "different-parent" },
    { ...catalog, expiration_time: "2026-10-17T13:00:00Z" },
    { ...catalog, event_status: "RESOLVED" },
  ])
    assert.equal(
      projectHip4HolderKnownWalletMarkets({ ...input(), markets: [changed] })
        .length,
      0,
    );
  const [result] = projectHip4HolderKnownWalletMarkets({
    ...input(),
    positions: [
      {
        ...position,
        metadata: { ...position.metadata, tokenId: "hyperliquid:mainnet:411" },
      },
    ],
    activities: [],
  });
  assert.equal(result, undefined);
});

test("exact native replay deduplicates and contradictory same-identity facts never choose a winner", () => {
  const [replay] = projectHip4HolderKnownWalletMarkets({
    ...input(),
    activities: [activity(), activity()],
  });
  assert.equal(replay.nativeKnownWalletEvidence?.fills.length, 1);
  const changed = activity();
  const normalized = normalizeHip4KnownWalletFill({
    identity,
    observedAt: asOf.toISOString(),
    value: { ...rawFill(), px: "0.3" },
    quoteTokensByMarket: new Map([[market.marketId, "USDC"]]),
  });
  assert.equal(normalized.kind, "trade");
  if (normalized.kind !== "trade") throw new Error("fixture");
  const contradiction = {
    ...changed,
    price: normalized.activity.price,
    size_usd: normalized.activity.sizeUsd,
    metadata: {
      ...changed.metadata,
      nativeFill: normalized.activity,
      nativeFingerprint: hip4TrackedFillFingerprint(normalized.activity),
      nativeRecheck: {
        ...changed.metadata.nativeRecheck,
        retainedFingerprint: hip4TrackedFillFingerprint(normalized.activity),
        lastObservedFingerprint: hip4TrackedFillFingerprint(
          normalized.activity,
        ),
      },
    },
  };
  const [result] = projectHip4HolderKnownWalletMarkets({
    ...input(),
    activities: [activity(), contradiction, activity(201)],
  });
  assert.deepEqual(
    result.nativeKnownWalletEvidence?.fills.map((fill) => fill.tradeId),
    ["201"],
  );
  assert(
    result.nativeKnownWalletEvidence?.diagnostics.includes(
      "conflicting_native_activity_source_identity",
    ),
  );
});

test("row-local disputes and ambiguous legacy fills never borrow unrelated clear proof; snapshots stay usable", () => {
  const disputed = activity();
  disputed.metadata.nativeRecheck.state = "disputed";
  const legacy = activity(202);
  const { nativeRecheck: _unproven, ...legacyMetadata } = legacy.metadata;
  const [result] = projectHip4HolderKnownWalletMarkets({
    ...input(),
    activities: [
      disputed,
      activity(201),
      { ...legacy, metadata: legacyMetadata },
    ],
  });
  assert.equal(result.nativeKnownWalletEvidence?.positions.length, 1);
  assert.deepEqual(
    result.nativeKnownWalletEvidence?.fills.map((fill) => fill.tradeId),
    ["201"],
  );
  assert(
    result.nativeKnownWalletEvidence?.diagnostics.includes(
      "disputed_native_activity_source_identity",
    ),
  );
  assert(
    result.nativeKnownWalletEvidence?.diagnostics.includes(
      "legacy_native_activity_requires_exact_recheck",
    ),
  );
});

test("all prompt generations carry factual coverage and exact native IDs, never calibrated native metrics", () => {
  const [result] = projectHip4HolderKnownWalletMarkets(input());
  const [candidate] = buildHolderResearchCandidatesFromMarket(result, policy);
  const prompts = [
    buildHolderResearchCandidatePromptJson(candidate, policy),
    buildHolderResearchTriageCandidatePromptJson(candidate, policy),
    buildHolderResearchTriageCandidatePromptJsonV2(candidate, policy),
    buildHolderResearchCandidatePromptJsonV2(candidate, policy, external),
  ];
  for (const prompt of prompts) {
    const text = JSON.stringify(prompt);
    assert.match(text, /known_wallet_only/);
    assert.match(text, /123\.00001/);
    assert.match(text, /positionUsd":null/);
    assert.match(text, /tradeId":"200/);
    assert.match(text, /costBasis":"unknown/);
    assert.doesNotMatch(
      text,
      /Internal position and calibrated 30-day holder metrics/,
    );
  }
  for (const prompt of prompts.slice(2)) {
    assert.doesNotMatch(JSON.stringify(prompt), new RegExp(identity.address));
    assert.doesNotMatch(JSON.stringify(prompt), new RegExp(walletId));
  }
  const ids = listHolderResearchPromptEvidenceIdsV2(candidate, policy);
  assert(ids.length >= 3);
  assert(ids.every((id) => /^evidence_\d+$/.test(id)));
  const digest = candidate.inputDigest;
  const native = candidate.market.nativeKnownWalletEvidence;
  assert.ok(native);
  const changed = {
    ...candidate,
    market: {
      ...candidate.market,
      nativeKnownWalletEvidence: {
        ...native,
        positions: [
          {
            ...native.positions[0],
            shares: "124",
          },
        ],
      },
    },
  };
  assert.notEqual(buildHolderResearchInputDigest(changed), digest);
});

test("attempted native publish is CONTEXT through existing mixed/bucket/credential gates", () => {
  const [result] = projectHip4HolderKnownWalletMarkets(input());
  const [candidate] = buildHolderResearchCandidatesFromMarket(result, policy);
  const deterministic = buildDeterministicHolderResearchDecision(
    candidate,
    policy,
  );
  const output = applyHolderResearchPublishQualityGate({
    candidate,
    policy,
    output: { ...deterministic, status: "PUBLISH" },
  });
  assert.equal(output.status, "CONTEXT");
  assert.match(
    output.rationale,
    /Mixed holder reads|context-only|publish signal/,
  );
  assert.doesNotMatch(deterministic.summary, /\$0 tracked/);
  const context = adaptHolderResearchFinalOutputV2({
    candidate,
    policy,
    externalResearch: external,
    output: {
      version: "holder_research_v2",
      verdict: "context",
      reason_codes: [],
      rationale: "Observed positioning is factual but uncalibrated.",
      evidence_assessment: "adequate",
      evidence_ids: ["evidence_2"],
      copy: null,
      public_context: {
        headline: "A known wallet holds the native outcome",
        summary:
          "A current source snapshot records an outcome position, without proving a recent purchase or trading skill.",
        caveats: ["Known-wallet coverage only."],
        reason: "positioning",
        evidence_ids: ["evidence_2"],
        source_urls: [],
      },
    },
  });
  assert.equal(context.status, "CONTEXT");
  assert.equal(
    context.public_context?.evidence_ids[0],
    candidate.evidence[1].id,
  );
});

test("generic enrichment cannot synthesize cost basis or credentials from native fragments", async () => {
  const [result] = projectHip4HolderKnownWalletMarkets(input());
  const [candidate] = buildHolderResearchCandidatesFromMarket(result, policy);
  const db = {
    query: async () => {
      throw new Error(
        "native factual DTO must not enter generic ledger/taxonomy reads",
      );
    },
  } as unknown as Pick<PoolClient, "query">;
  const enriched = await enrichHolderResearchLivePositions(
    db,
    [candidate],
    policy,
  );
  const final = await enrichHolderResearchMarketTypeMetrics(db, enriched);
  assert.deepEqual(final[0].market.holders, []);
  assert.equal(
    final[0].market.nativeKnownWalletEvidence?.positions[0].positionUsd,
    null,
  );
  assert.equal(final[0].market.nativeKnownWalletEvidence?.costBasis, "unknown");
});

test("bounded source advances skipped/empty pages and preserves positions on activity schema gap", async () => {
  const options = {
    environment: "mainnet" as const,
    afterAddress: "",
    asOf,
    sourceLimit: 2,
    positionsPerWallet: 1,
    fillsPerWallet: 1,
    candidateLookbackHours: 24,
    activityLookbackHours: 24,
    trackedSubjectTtlDays: 30,
    includeAutoTracked: false,
  };
  const reads: string[] = [];
  const fake = (
    sourceRows: Hip4HolderSourceRow[] = [subject],
    fillRows?: Record<string, unknown>[],
  ) =>
    ({
      query: async (sql: string) => {
        reads.push(sql);
        if (sql === HIP4_HOLDER_RESEARCH_SOURCE_SQL)
          return { rows: sourceRows };
        if (sql === HIP4_HOLDER_RESEARCH_POSITIONS_SQL)
          return { rows: [position] };
        if (sql === HIP4_HOLDER_RESEARCH_ACTIVITY_SQL) {
          if (fillRows) return { rows: fillRows };
          throw Object.assign(new Error("missing column"), { code: "42703" });
        }
        if (sql === HIP4_HOLDER_RESEARCH_MARKETS_SQL)
          return { rows: [catalog] };
        throw new Error("unexpected SQL");
      },
    }) as unknown as Pick<PoolClient, "query">;
  const page = await loadHip4HolderResearchKnownWalletPage(fake(), options);
  assert.equal(page.markets.length, 1);
  assert.equal(page.nextAddress, identity.address);
  assert(page.diagnostics.includes("native_activity_schema_unavailable"));
  assert.equal(
    page.markets[0].nativeKnownWalletEvidence?.positions[0].shares,
    "123.00001",
  );
  const skipped = await loadHip4HolderResearchKnownWalletPage(
    fake([{ ...subject, followed: false }]),
    options,
  );
  assert.equal(skipped.markets.length, 0);
  assert.equal(skipped.nextAddress, identity.address);
  const tail = await loadHip4HolderResearchKnownWalletPage(fake([]), {
    ...options,
    afterAddress: identity.address,
  });
  assert.equal(tail.nextAddress, "");
  assert.equal(tail.sourceRowsRead, 0);
  const conflicted = await loadHip4HolderResearchKnownWalletPage(
    fake(
      [
        {
          ...subject,
          metadata: {
            hip4Intel: {
              ...subject.metadata.hip4Intel,
              activityPersistence: "conflicting_fill_identity",
            },
          },
        },
      ],
      [
        {
          ...activity(),
          metadata: { ...activity().metadata, nativeRecheck: undefined },
        },
      ],
    ),
    options,
  );
  assert.equal(
    conflicted.markets[0].nativeKnownWalletEvidence?.positions.length,
    1,
  );
  assert.equal(
    conflicted.markets[0].nativeKnownWalletEvidence?.fills.length,
    0,
  );
  assert(
    conflicted.diagnostics.includes(
      "legacy_native_activity_requires_exact_recheck",
    ),
  );
  const repaired = await loadHip4HolderResearchKnownWalletPage(
    fake([subject], [activity()]),
    options,
  );
  assert.equal(repaired.markets[0].nativeKnownWalletEvidence?.fills.length, 1);
  assert(
    !repaired.diagnostics.includes(
      "legacy_native_activity_requires_exact_recheck",
    ),
  );
  assert(reads.every((sql) => /^(with|select)/.test(sql)));
});
