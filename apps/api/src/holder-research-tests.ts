import assert from "node:assert/strict";

import {
  buildHolderResearchSystemPrompt,
  buildHolderResearchTriageSystemPrompt,
  buildHolderResearchTriageUserPrompt,
  buildHolderResearchUserPrompt,
  holderResearchAgentOutputV1Schema,
  parseHolderResearchAgentOutputV1,
  parseHolderResearchTriageOutputV1,
  type HolderResearchAgentOutputV1,
} from "./schemas/holder-research.js";
import {
  parseHolderResearchRunArgs,
  parseHolderResearchTriageModelContent,
  selectHolderResearchTriageFallbackCandidates,
} from "./ai-holder-research-run.js";
import {
  holderResearchWalletNotesBodySchema,
  signalsQuerySchema,
} from "./schemas/signals.js";
import {
  applyHolderResearchPublishQualityGate,
  buildHolderResearchActorSummary,
  buildDeterministicHolderResearchDecision,
  buildHolderResearchDecisionCacheRecord,
  buildHolderResearchDecisionSnapshot,
  buildHolderResearchCandidatePromptJson,
  buildHolderResearchCandidatesFromMarket,
  buildHolderResearchExternalSearchInput,
  buildHolderResearchCandidateActionability,
  buildHolderResearchSelectionDiagnostics,
  buildHolderResearchTriageCandidatePromptJson,
  buildHolderResearchQualityAssessment,
  buildHolderResearchWalletTargets,
  diffHolderResearchDecisionSnapshots,
  evaluateResolvedHolderResearchNotes,
  evaluateHolderResearchDecisionCache,
  isSharpHolder,
  loadHolderResearchCandidateMarkets,
  selectHolderResearchCandidates,
  type HolderResearchHolder,
  type HolderResearchMarketInput,
  type HolderResearchSide,
} from "./services/holder-research.js";
import {
  getIntelPolicyDefaults,
  resolveIntelPolicy,
  type HolderResearchPolicy,
} from "./services/runtime-policies.js";
import {
  auditHolderResearchSignalPerformance,
  loadHolderResearchPerformanceCalibrationMemo,
  resolveHolderResearchFinalYesProbability,
  resolveHolderResearchSignalQuote,
} from "./services/holder-research-performance.js";
import { classifyMarketTaxonomy } from "./services/market-type-classifier.js";

function policy(overrides: Partial<HolderResearchPolicy> = {}) {
  return {
    ...getIntelPolicyDefaults("holder_research"),
    ...overrides,
  };
}

function calibrationRow(
  overrides: Partial<{
    note_id: string;
    created_at: Date;
    outcome: string;
    market_segment: string | null;
    market_type: string;
    actor_mode: string;
    bucket: string;
    market_id: string;
    signal_side: string;
    entry_quality: string;
    entry_approx_distance_minutes: number | null;
    pnl_per_dollar: number | null;
    state: string;
    primary_holder_wallet_id: string | null;
    primary_holder_label: string | null;
    primary_holder_pnl_30d_usd: number | null;
    primary_holder_position_usd: number | null;
  }> = {},
) {
  return {
    note_id: "00000000-0000-4000-8000-000000000100",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    outcome: "wrong",
    market_segment: "sports_soccer_game",
    market_type: "single_game_sports",
    actor_mode: "single_holder",
    bucket: "sharp_side",
    market_id: "polymarket:sports",
    signal_side: "YES",
    entry_quality: "exact_snapshot",
    entry_approx_distance_minutes: null,
    pnl_per_dollar: -1,
    state: "resolved",
    primary_holder_wallet_id: "wallet-sports",
    primary_holder_label: null,
    primary_holder_pnl_30d_usd: -1_000,
    primary_holder_position_usd: 12_000,
    ...overrides,
  };
}

function side(
  sideName: "YES" | "NO",
  overrides: Partial<HolderResearchSide> = {},
): HolderResearchSide {
  return {
    side: sideName,
    usd: 0,
    wallets: 0,
    openPnlUsd: null,
    sharpHolders: 0,
    sharpUsd: 0,
    bestEdge: null,
    bestZScore: null,
    bestSampleCount: null,
    bestResolvedStakeUsd: null,
    bestTrades30d: null,
    ...overrides,
  };
}

function holder(
  sideName: "YES" | "NO",
  overrides: Partial<HolderResearchHolder> = {},
): HolderResearchHolder {
  return {
    walletId: `00000000-0000-0000-0000-0000000000${sideName === "YES" ? "01" : "02"}`,
    address: sideName === "YES" ? "0xyes" : "0xno",
    chain: "polygon",
    label: null,
    identityDisplayName: null,
    identityDisplayNameSource: null,
    identityProfileUrl: null,
    side: sideName,
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
    resolvedWinRateEdge30d: 0.16,
    resolvedEdgeZScore30d: 2.1,
    resolvedEdgeSampleCount30d: 24,
    resolvedStakeUsd30d: 6_000,
    trades30d: 18,
    winRate30d: 0.65,
    volume30dUsd: 90_000,
    walletKind: "safe",
    ownerAddress: "0xowner",
    walletUsdLikeBalance: 500,
    ownerUsdLikeBalance: 10_000,
    mmSuspected: false,
    relatedOpenPositions: [],
    ...overrides,
  };
}

function market(
  overrides: Partial<HolderResearchMarketInput> = {},
): HolderResearchMarketInput {
  return {
    marketId: "polymarket:test-market",
    eventId: "polymarket:test-event",
    venue: "polymarket",
    marketTitle: "Will the test market resolve Yes?",
    marketSlug: "will-the-test-market-resolve-yes",
    marketDescription: null,
    outcomes: null,
    eventTitle: "Test event",
    eventSlug: "test-event",
    eventDescription: null,
    seriesKey: null,
    seriesTitle: null,
    resolutionSource: null,
    category: "Politics",
    closeTime: new Date(Date.now() + 86_400_000).toISOString(),
    expirationTime: null,
    yesProbability: 0.55,
    volume24h: 100_000,
    liquidity: 25_000,
    marketMovementContext: {
      yesProbabilityNow: 0.55,
      yesChange24h: null,
      volume24h: 100_000,
      volumeChange24h: null,
      volumeChangePct24h: null,
      liquidity: 25_000,
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
    sides: {
      YES: side("YES", { usd: 120_000, wallets: 5 }),
      NO: side("NO", {
        usd: 32_000,
        wallets: 2,
        sharpHolders: 1,
        sharpUsd: 10_000,
        bestEdge: 0.16,
        bestZScore: 2.1,
        bestSampleCount: 24,
        bestResolvedStakeUsd: 6_000,
        bestTrades30d: 18,
      }),
    },
    holders: [holder("NO")],
    recentActivityUsd: 0,
    recentActivityAt: null,
    crossMarketWalletCount: 0,
    previousNote: null,
    ...overrides,
  };
}

function publishOutput(
  candidate: ReturnType<typeof buildHolderResearchCandidatesFromMarket>[number],
  overrides: Partial<HolderResearchAgentOutputV1> = {},
): HolderResearchAgentOutputV1 {
  return {
    version: "holder_research_v1",
    status: "PUBLISH",
    bucket: candidate.bucket,
    confidence: 0.82,
    signal_type: candidate.signalType,
    direction: candidate.direction,
    headline: "Sharp holder signal",
    summary:
      "A capable holder side adds a concise directional read for this market.",
    rationale: "Holder evidence clears the publish quality gate.",
    evidence_ids: candidate.evidence.map((evidence) => evidence.id).slice(0, 3),
    caveats: [],
    ...overrides,
  };
}

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [
  {
    name: "holder research performance quote math handles YES and NO prices",
    run: () => {
      const yes = resolveHolderResearchSignalQuote(
        { best_bid: 0.3, best_ask: 0.34, last_price: 0.32 },
        "YES",
      );
      assert.equal(yes.buyPrice, 0.34);
      assert.equal(yes.buyPriceSource, "yes_ask");
      assert.equal(yes.markPrice, 0.3);
      assert.equal(yes.markPriceSource, "yes_bid");

      const no = resolveHolderResearchSignalQuote(
        { best_bid: 0.3, best_ask: 0.34, last_price: 0.32 },
        "NO",
      );
      assert.equal(no.buyPrice, 0.7);
      assert.equal(no.buyPriceSource, "no_from_yes_bid");
      assert.equal(no.markPrice, 0.6599999999999999);
      assert.equal(no.markPriceSource, "no_from_yes_ask");
    },
  },
  {
    name: "holder research performance outcome uses explicit resolution before terminal price",
    run: () => {
      assert.deepEqual(
        resolveHolderResearchFinalYesProbability({
          resolved_outcome: "NO",
          resolved_outcome_pct: null,
          best_bid: 0.999,
          best_ask: 1,
          last_price: 1,
        }),
        { finalYesProbability: 0, source: "resolved_outcome" },
      );
      assert.deepEqual(
        resolveHolderResearchFinalYesProbability({
          resolved_outcome: null,
          resolved_outcome_pct: 2500,
          best_bid: 0.999,
          best_ask: 1,
          last_price: 1,
        }),
        { finalYesProbability: 0.25, source: "resolved_outcome_pct" },
      );
      assert.deepEqual(
        resolveHolderResearchFinalYesProbability({
          resolved_outcome: null,
          resolved_outcome_pct: null,
          best_bid: 0.58,
          best_ask: 0.62,
          last_price: 0.6,
        }),
        { finalYesProbability: null, source: "missing" },
      );
    },
  },
  {
    name: "holder research performance audit applies minimum confidence filter",
    run: async () => {
      const queries: Array<{ params: unknown[]; sql: string }> = [];
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ params: params ?? [], sql });
          return { rows: [] };
        },
      } as unknown as import("./db.js").DbQuery;

      const result = await auditHolderResearchSignalPerformance(db, {
        includeOpen: true,
        includeResolved: true,
        limit: 10,
        lookbackHours: 168,
        minConfidence: 0.7,
        persist: false,
      });

      assert.equal(result.considered, 0);
      assert.match(queries[0]?.sql ?? "", /n\.confidence >=/);
      assert.equal(queries[0]?.params.includes(0.7), true);
    },
  },
  {
    name: "holder research performance audit eligibility filters are opt-in",
    run: async () => {
      const queries: Array<{ params: unknown[]; sql: string }> = [];
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ params: params ?? [], sql });
          return { rows: [] };
        },
      } as unknown as import("./db.js").DbQuery;

      await auditHolderResearchSignalPerformance(db, {
        includeOpen: true,
        includeResolved: true,
        limit: 10,
        lookbackHours: 168,
        persist: false,
      });
      assert.doesNotMatch(queries[0]?.sql ?? "", /n\.status = 'active'/);
      assert.doesNotMatch(
        queries[0]?.sql ?? "",
        /n\.direction in \('up', 'down'\)/,
      );

      queries.length = 0;
      await auditHolderResearchSignalPerformance(db, {
        activeOnly: true,
        directionalOnly: true,
        includeOpen: true,
        includeResolved: true,
        limit: 10,
        lookbackHours: 168,
        persist: false,
      });
      assert.match(queries[0]?.sql ?? "", /n\.status = 'active'/);
      assert.match(queries[0]?.sql ?? "", /n\.direction in \('up', 'down'\)/);
    },
  },
  {
    name: "holder research performance audit uses exact signal snapshot before trade fallback",
    run: async () => {
      const updates: Array<Record<string, unknown>> = [];
      let tradeFallbackQueried = false;
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          if (/from\s+ai_notes\s+n/i.test(sql)) {
            return {
              rows: [
                {
                  note_id: "00000000-0000-4000-8000-000000000091",
                  direction: "up",
                  confidence: 0.82,
                  created_at: new Date("2026-01-01T00:00:00.000Z"),
                  metrics: {
                    bucket: "sharp_side",
                    market: { yesProbability: 0.32 },
                    signalSnapshot: {
                      version: 1,
                      recordedAt: "2026-01-01T00:00:00.000Z",
                      marketId: "polymarket:perf",
                      eventId: "polymarket:event",
                      venue: "polymarket",
                      side: "YES",
                      direction: "up",
                      marketStatus: "ACTIVE",
                      acceptingOrders: true,
                      tokens: { yes: "yes-token", no: "no-token" },
                      quote: {
                        buyPrice: 0.35,
                        buyPriceSource: "yes_ask",
                      },
                    },
                  },
                  model_meta: {
                    primary_holder_credentials: { mode: "single_holder" },
                  },
                  target_meta: { side: "YES", bucket: "sharp_side" },
                  market_id: "polymarket:perf",
                  event_id: "polymarket:event",
                  venue: "polymarket",
                  market_status: "CLOSED",
                  market_title: "Test winner",
                  event_title: "Test event",
                  category: "Politics",
                  close_time: new Date("2026-01-01T03:00:00.000Z"),
                  expiration_time: null,
                  best_bid: 0.999,
                  best_ask: 1,
                  last_price: 1,
                  resolved_outcome: "YES",
                  resolved_outcome_pct: null,
                  accepting_orders: false,
                  yes_token_id: "yes-token",
                  no_token_id: "no-token",
                },
              ],
            };
          }
          if (/from\s+jsonb_to_recordset/i.test(sql)) {
            tradeFallbackQueried = true;
            return { rows: [] };
          }
          if (/update\s+ai_notes/i.test(sql)) {
            updates.push(
              JSON.parse(String(params?.[1])) as Record<string, unknown>,
            );
            return { rows: [], rowCount: 1 };
          }
          return { rows: [] };
        },
      } as unknown as import("./db.js").DbQuery;

      const result = await auditHolderResearchSignalPerformance(db, {
        lookbackHours: 168,
        limit: 10,
        persist: true,
        includeOpen: true,
        includeResolved: true,
      });
      assert.equal(tradeFallbackQueried, false);
      assert.equal(result.evaluated, 1);
      assert.equal(result.written, 1);
      assert.equal(result.correct, 1);
      assert.equal(updates[0]?.entryPrice, 0.35);
      assert.equal(updates[0]?.entryPriceSource, "signal_snapshot");
      assert.equal(updates[0]?.pnlPerDollar, (1 - 0.35) / 0.35);
    },
  },
  {
    name: "holder research performance audit falls back to Polymarket clob side token trade",
    run: async () => {
      let fallbackPayload: unknown = null;
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          if (/from\s+ai_notes\s+n/i.test(sql)) {
            return {
              rows: [
                {
                  note_id: "00000000-0000-4000-8000-000000000092",
                  direction: "down",
                  confidence: 0.72,
                  created_at: new Date("2026-01-01T00:00:00.000Z"),
                  metrics: {
                    bucket: "sharp_minority",
                    market: { yesProbability: 0.52 },
                  },
                  model_meta: {
                    primary_holder_credentials: { mode: "single_holder" },
                  },
                  target_meta: { side: "NO", bucket: "sharp_minority" },
                  market_id: "polymarket:perf-no",
                  event_id: "polymarket:event",
                  venue: "polymarket",
                  market_status: "CLOSED",
                  market_title: "Mexico",
                  event_title: "World Cup: Czechia vs. Mexico",
                  category: "Sports",
                  close_time: new Date("2026-01-01T03:00:00.000Z"),
                  expiration_time: null,
                  best_bid: 1,
                  best_ask: 1,
                  last_price: 1,
                  resolved_outcome: "YES",
                  resolved_outcome_pct: null,
                  accepting_orders: false,
                  yes_token_id: null,
                  no_token_id: null,
                  market_token_yes: null,
                  market_token_no: null,
                  clob_token_ids: JSON.stringify([
                    "clob-yes-token",
                    "clob-no-token",
                  ]),
                },
              ],
            };
          }
          if (/from\s+jsonb_to_recordset/i.test(sql)) {
            fallbackPayload = params?.[0];
            return {
              rows: [
                {
                  note_id: "00000000-0000-4000-8000-000000000092",
                  price: 0.48,
                  ts: new Date("2026-01-01T00:10:00.000Z"),
                  distance_minutes: 10,
                },
              ],
            };
          }
          return { rows: [], rowCount: 0 };
        },
      } as unknown as import("./db.js").DbQuery;

      const result = await auditHolderResearchSignalPerformance(db, {
        lookbackHours: 168,
        limit: 10,
        persist: false,
        includeOpen: true,
        includeResolved: true,
      });
      assert.match(String(fallbackPayload), /clob-no-token/);
      assert.match(String(fallbackPayload), /note_id/);
      assert.match(String(fallbackPayload), /token_id/);
      assert.doesNotMatch(String(fallbackPayload), /noteId/);
      assert.equal(result.items[0]?.entryPrice, 0.48);
      assert.equal(result.items[0]?.entryPriceSource, "nearest_trade");
      assert.equal(result.items[0]?.entryApproxDistanceMinutes, 10);
      assert.equal(result.items[0]?.outcome, "wrong");
    },
  },
  {
    name: "holder research performance calibration skips tiny resolved samples",
    run: async () => {
      const db = {
        query: async () => ({
          rows: [
            calibrationRow({
              note_id: "00000000-0000-4000-8000-000000000101",
              outcome: "wrong",
              market_id: "polymarket:sports-1",
            }),
            calibrationRow({
              note_id: "00000000-0000-4000-8000-000000000102",
              outcome: "wrong",
              market_id: "polymarket:sports-2",
            }),
          ],
        }),
      } as unknown as import("./db.js").DbQuery;

      const memo = await loadHolderResearchPerformanceCalibrationMemo(
        db,
        policy({
          calibrationMemoEnabled: true,
          performanceCalibrationMinSamples: 3,
          performanceCalibrationMinResolvedSamples: 3,
          performanceCalibrationMinPatternSamples: 2,
        }),
      );
      assert.deepEqual(memo, []);
    },
  },
  {
    name: "holder research performance calibration emits concrete wallet caution",
    run: async () => {
      const db = {
        query: async () => ({
          rows: [
            calibrationRow({
              note_id: "00000000-0000-4000-8000-000000000111",
              market_id: "polymarket:sports-1",
              primary_holder_wallet_id: "wallet-sports-same",
              primary_holder_label: "SportsWallet",
              primary_holder_pnl_30d_usd: -1_000,
              primary_holder_position_usd: 12_000,
            }),
            calibrationRow({
              note_id: "00000000-0000-4000-8000-000000000112",
              market_id: "polymarket:sports-2",
              primary_holder_wallet_id: "wallet-sports-same",
              primary_holder_label: "SportsWallet",
              primary_holder_pnl_30d_usd: 0,
              primary_holder_position_usd: 18_000,
            }),
            calibrationRow({
              note_id: "00000000-0000-4000-8000-000000000113",
              outcome: "correct",
              market_type: "politics_geo",
              actor_mode: "single_holder",
              market_id: "polymarket:geo-1",
              primary_holder_wallet_id: "wallet-geo",
              primary_holder_pnl_30d_usd: 40_000,
              primary_holder_position_usd: 60_000,
            }),
          ],
        }),
      } as unknown as import("./db.js").DbQuery;

      const memo = await loadHolderResearchPerformanceCalibrationMemo(
        db,
        policy({
          calibrationMemoEnabled: true,
          performanceCalibrationMinSamples: 3,
          performanceCalibrationMinResolvedSamples: 3,
          performanceCalibrationMinPatternSamples: 2,
          singleGameSportsMinHolderUsd: 25_000,
        }),
      );
      assert.equal(memo.length, 1);
      assert.match(memo[0] ?? "", /SportsWallet in 2\/2/);
      assert.match(memo[0] ?? "", /2\/2 lacked positive 30d holder PnL/);
      assert.match(memo[0] ?? "", /2\/2 were below the sports holder-size bar/);
    },
  },
  {
    name: "holder research performance calibration dedupes same market side",
    run: async () => {
      const db = {
        query: async () => ({
          rows: [
            calibrationRow({
              note_id: "00000000-0000-4000-8000-000000000121",
              market_id: "polymarket:sports-duplicate",
              signal_side: "YES",
              entry_quality: "distant_trade",
            }),
            calibrationRow({
              note_id: "00000000-0000-4000-8000-000000000122",
              market_id: "polymarket:sports-duplicate",
              signal_side: "YES",
              entry_quality: "exact_snapshot",
            }),
            calibrationRow({
              note_id: "00000000-0000-4000-8000-000000000123",
              outcome: "correct",
              market_type: "politics_geo",
              actor_mode: "single_holder",
              market_id: "polymarket:geo-2",
            }),
          ],
        }),
      } as unknown as import("./db.js").DbQuery;

      const memo = await loadHolderResearchPerformanceCalibrationMemo(
        db,
        policy({
          calibrationMemoEnabled: true,
          performanceCalibrationMinSamples: 2,
          performanceCalibrationMinResolvedSamples: 2,
          performanceCalibrationMinPatternSamples: 2,
          performanceCalibrationDedupMarketSide: true,
        }),
      );
      assert.deepEqual(memo, []);
    },
  },
  {
    name: "holder research CLI parses triage overrides separately from synthesis budget",
    run: () => {
      const args = parseHolderResearchRunArgs([
        "--max-agent-calls=2",
        "--triage-batch-size=6",
        "--triage-max-batches=2",
        "--triage-model=openai/gpt-5.4-mini",
        "--include-performance-report",
      ]);
      assert.equal(args.maxAgentCalls, 2);
      assert.equal(args.triageBatchSize, 6);
      assert.equal(args.triageMaxBatches, 2);
      assert.equal(args.triageModel, "openai/gpt-5.4-mini");
      assert.equal(args.includePerformanceReport, true);
    },
  },
  {
    name: "market taxonomy keeps coarse type and adds granular segment",
    run: () => {
      assert.deepEqual(
        classifyMarketTaxonomy({
          category: "Sports",
          eventTitle: "World Cup Winner",
          marketTitle: "Brazil",
        }),
        {
          marketSegment: "sports_outright",
          marketType: "sports_outright",
        },
      );
      assert.deepEqual(
        classifyMarketTaxonomy({
          category: "Esports",
          eventTitle: "Dota 2: Liquid vs Falcons BO3",
          marketTitle: "Game 1 Winner",
        }),
        {
          marketSegment: "sports_esports_game",
          marketType: "single_game_sports",
        },
      );
      assert.equal(
        classifyMarketTaxonomy({
          category: "Sports",
          eventTitle: "Lexus Eastbourne Open: Maria vs Valentova",
        }).marketSegment,
        "sports_tennis_game",
      );
      assert.equal(
        classifyMarketTaxonomy({
          eventTitle: "Bitcoin above $100K by Friday?",
        }).marketSegment,
        "crypto_btc",
      );
      assert.equal(
        classifyMarketTaxonomy({
          eventTitle: "Fed cuts rates in July?",
        }).marketSegment,
        "macro_rates",
      );
      assert.equal(
        classifyMarketTaxonomy({
          eventTitle: "Gold above $2500?",
        }).marketSegment,
        "macro_commodities",
      );
      assert.equal(
        classifyMarketTaxonomy({
          eventTitle: "MSFT above $500?",
        }).marketSegment,
        "macro_equities",
      );
      assert.equal(
        classifyMarketTaxonomy({
          eventTitle: "OpenAI releases GPT-6 this year?",
        }).marketSegment,
        "tech_ai",
      );
      assert.equal(
        classifyMarketTaxonomy({
          eventTitle: "Biden mentions Taylor Swift in an X post?",
        }).marketSegment,
        "mentions",
      );
    },
  },
  {
    name: "sharp holder requires exposure, edge, z-score, samples, stake, and trades",
    run: () => {
      const p = policy();
      assert.equal(isSharpHolder(holder("YES"), p), true);
      assert.equal(
        isSharpHolder(
          holder("YES", {
            resolvedEdgeSampleCount30d: p.minResolvedEdgeSampleCount30d - 1,
          }),
          p,
        ),
        false,
      );
      assert.equal(
        isSharpHolder(
          holder("YES", { positionUsd: p.minHolderPositionUsd - 1 }),
          p,
        ),
        false,
      );
      assert.equal(
        isSharpHolder(holder("YES", { mmSuspected: true }), p),
        false,
      );
    },
  },
  {
    name: "sharp minority candidate clears conservative publish threshold",
    run: () => {
      const p = policy();
      const candidates = buildHolderResearchCandidatesFromMarket(market(), p);
      const sharpMinority = candidates.find(
        (candidate) => candidate.bucket === "sharp_minority",
      );
      assert.ok(sharpMinority);
      assert.equal(sharpMinority.side, "NO");
      assert.equal(sharpMinority.score >= p.publishMinScore, true);
      assert.equal(
        sharpMinority.evidence.some((ev) => ev.kind === "holder"),
        true,
      );
    },
  },
  {
    name: "near-certain odds suppress non-timing holder research candidates",
    run: () => {
      const candidates = buildHolderResearchCandidatesFromMarket(
        market({ yesProbability: 0.995 }),
        policy(),
      );
      assert.equal(candidates.length, 0);
    },
  },
  {
    name: "holder research loader keeps holder 30d pnl",
    run: async () => {
      const p = policy();
      let querySql = "";
      let queryParams: unknown[] = [];
      const client = {
        query: async (sql: unknown, params?: unknown[]) => {
          querySql = String(sql ?? "");
          queryParams = Array.isArray(params) ? params : [];
          return {
            command: "SELECT",
            fields: [],
            oid: 0,
            rowCount: 1,
            rows: [
              {
                market_id: "polymarket:pnl-market",
                event_id: "polymarket:pnl-event",
                venue: "polymarket",
                market_title: "Pnl market",
                market_slug: null,
                market_description: null,
                event_title: "Pnl event",
                event_slug: null,
                event_description: null,
                series_key: null,
                series_title: null,
                resolution_source: null,
                category: null,
                close_time: null,
                expiration_time: null,
                best_bid: "0.30",
                best_ask: "0.32",
                last_price: null,
                volume_24h: null,
                liquidity: null,
                yes_usd: "0",
                no_usd: "25000",
                yes_wallets: "0",
                no_wallets: "1",
                yes_sharp_holders: "0",
                no_sharp_holders: "1",
                yes_sharp_usd: "0",
                no_sharp_usd: "25000",
                yes_best_edge: null,
                no_best_edge: "0.16",
                yes_best_z_score: null,
                no_best_z_score: "2.1",
                yes_best_sample_count: null,
                no_best_sample_count: "24",
                yes_best_resolved_stake_usd: null,
                no_best_resolved_stake_usd: "6000",
                yes_best_trades_30d: null,
                no_best_trades_30d: "18",
                largest_holder_usd: "25000",
                recent_activity_usd: "0",
                recent_activity_at: null,
                cross_market_wallet_count: "0",
                top_holders: [
                  {
                    address: "0xabc",
                    chain: "polygon",
                    label: null,
                    ownerAddress: null,
                    ownerUsdLikeBalance: null,
                    pnl30dUsd: 12_345,
                    positionUsd: 25_000,
                    resolvedEdgeSampleCount30d: 24,
                    resolvedEdgeZScore30d: 2.1,
                    resolvedStakeUsd30d: 6_000,
                    resolvedWinRateEdge30d: 0.16,
                    side: "NO",
                    trades30d: 18,
                    volume30dUsd: 90_000,
                    walletId: "00000000-0000-4000-8000-000000000061",
                    walletKind: "safe",
                    walletUsdLikeBalance: null,
                    winRate30d: 0.65,
                  },
                ],
              },
            ],
          };
        },
      };

      const markets = await loadHolderResearchCandidateMarkets(
        client as unknown as Parameters<
          typeof loadHolderResearchCandidateMarkets
        >[0],
        p,
        { whaleUsd: 100_000, whaleUsdSolana: 50_000 },
      );
      assert.equal(markets[0]?.holders[0]?.pnl30dUsd, 12_345);
      assert.match(querySql, /candidate_wallets as materialized/);
      assert.match(querySql, /from wallet_intel_selector_snapshot sel/);
      assert.match(querySql, /join lateral/);
      assert.match(querySql, /when w\.chain = 'solana' then \$13::numeric/);
      assert.match(querySql, /else \$12::numeric/);
      assert.doesNotMatch(
        querySql,
        /from wallet_position_snapshots ws\s+where ws\.snapshot_at/s,
      );
      assert.equal(
        queryParams[10],
        Math.min(5_000, Math.max(1_000, p.maxCandidatePool * 25)),
      );
      assert.equal(queryParams[11], 100_000);
      assert.equal(queryParams[12], 50_000);
    },
  },
  {
    name: "selection honors quotas, cooldowns, and one candidate per market",
    run: () => {
      const p = policy({
        maxAgentCallsPerRun: 2,
        maxCandidatesPerRun: 2,
        quotaSharpMinority: 1,
        quotaSharpSide: 1,
        quotaCleanDisagreement: 0,
      });
      const first = buildHolderResearchCandidatesFromMarket(market(), p);
      const second = buildHolderResearchCandidatesFromMarket(
        market({
          marketId: "polymarket:second",
          sides: {
            YES: side("YES", { usd: 80_000, wallets: 4 }),
            NO: side("NO", {
              usd: 30_000,
              wallets: 2,
              sharpHolders: 1,
              sharpUsd: 12_000,
              bestEdge: 0.17,
              bestZScore: 2.3,
              bestSampleCount: 30,
              bestResolvedStakeUsd: 8_000,
              bestTrades30d: 21,
            }),
          },
          holders: [
            holder("NO", { walletId: "00000000-0000-0000-0000-000000000003" }),
          ],
        }),
        p,
      );
      const cooled = first.map((candidate) => ({
        ...candidate,
        cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      }));
      const result = selectHolderResearchCandidates([...cooled, ...second], p);
      assert.equal(result.selected.length, 1);
      assert.equal(result.selected[0]?.market.marketId, "polymarket:second");
      assert.equal(
        result.skipped.some((entry) => entry.reason === "cooldown"),
        true,
      );
    },
  },
  {
    name: "zero-quota weak concentration candidate is not selected by refill",
    run: () => {
      const p = policy({
        quotaConcentrationRisk: 0,
        publishMinScore: 0.9,
        maxAgentCallsPerRun: 1,
        maxCandidatesPerRun: 1,
      });
      const concentrationOnly = buildHolderResearchCandidatesFromMarket(
        market({
          sides: {
            YES: side("YES", { usd: 90_000, wallets: 1 }),
            NO: side("NO", { usd: 0, wallets: 0 }),
          },
          holders: [holder("YES", { positionUsd: 85_000 })],
          yesProbability: 0.7,
        }),
        p,
      ).filter((candidate) => candidate.bucket === "concentration_risk");
      assert.equal(concentrationOnly.length, 1);
      const selected = selectHolderResearchCandidates(concentrationOnly, p);
      assert.equal(selected.selected.length, 0);
    },
  },
  {
    name: "candidate ranking prefers sharp-side evidence over weaker sports minority singles",
    run: () => {
      const p = policy({
        maxAgentCallsPerRun: 1,
        maxCandidatesPerRun: 1,
        quotaSharpMinority: 1,
        quotaSharpSide: 1,
      });
      const sharpSide = buildHolderResearchCandidatesFromMarket(
        market({
          marketId: "polymarket:sharp-side",
          sides: {
            YES: side("YES", {
              usd: 90_000,
              wallets: 3,
              sharpHolders: 2,
              sharpUsd: 45_000,
              bestEdge: 0.18,
              bestZScore: 2.4,
              bestSampleCount: 30,
              bestResolvedStakeUsd: 10_000,
              bestTrades30d: 24,
            }),
            NO: side("NO", { usd: 35_000, wallets: 2 }),
          },
          holders: [
            holder("YES", {
              positionUsd: 28_000,
              walletId: "00000000-0000-0000-0000-000000000021",
            }),
            holder("YES", {
              positionUsd: 24_000,
              walletId: "00000000-0000-0000-0000-000000000022",
            }),
          ],
        }),
        p,
      ).find((candidate) => candidate.bucket === "sharp_side");
      assert.ok(sharpSide);

      const weakSportsMinority = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          closeTime: new Date(Date.now() + 2 * 3_600_000).toISOString(),
          eventTitle: "Mexico vs. Czechia",
          marketId: "polymarket:weak-sports-minority",
          marketTitle: "Mexico",
          sides: {
            YES: side("YES", { usd: 95_000, wallets: 4 }),
            NO: side("NO", {
              usd: 30_000,
              wallets: 1,
              sharpHolders: 1,
              sharpUsd: 10_000,
              bestEdge: 0.11,
              bestZScore: 1.7,
              bestSampleCount: 12,
              bestResolvedStakeUsd: 2_000,
              bestTrades30d: 12,
            }),
          },
          holders: [
            holder("NO", {
              positionUsd: 10_000,
              pnl30dUsd: -1_000,
              walletId: "00000000-0000-0000-0000-000000000023",
            }),
          ],
        }),
        p,
      ).find((candidate) => candidate.bucket === "sharp_minority");
      assert.ok(weakSportsMinority);

      const selected = selectHolderResearchCandidates(
        [{ ...weakSportsMinority, score: sharpSide.score + 0.05 }, sharpSide],
        p,
      );
      assert.equal(selected.selected[0]?.key, sharpSide.key);
    },
  },
  {
    name: "pre-triage actionability blocks support-only and high-price candidates",
    run: () => {
      const p = policy({
        maxAgentCallsPerRun: 1,
        maxCandidatesPerRun: 1,
        quotaRecentFlow: 10,
      });
      const recentFlow = buildHolderResearchCandidatesFromMarket(
        market({
          recentActivityUsd: p.minRecentActivityUsd * 2,
          recentActivityAt: new Date().toISOString(),
        }),
        p,
      ).find((candidate) => candidate.bucket === "recent_flow");
      assert.ok(recentFlow);
      const recentFlowActionability = buildHolderResearchCandidateActionability(
        recentFlow,
        p,
      );
      assert.equal(recentFlowActionability.supportOnly, true);
      assert.equal(recentFlowActionability.isPrimaryResearchCandidate, false);
      assert.deepEqual(
        recentFlowActionability.likelyFinalGateBlockers.includes(
          "support_only_bucket",
        ),
        true,
      );
      const selectedSupport = selectHolderResearchCandidates([recentFlow], p);
      assert.equal(selectedSupport.selected.length, 0);

      const highPrice = buildHolderResearchCandidatesFromMarket(
        market({ yesProbability: 0.04 }),
        p,
      ).find((candidate) => candidate.bucket === "sharp_minority");
      assert.ok(highPrice);
      assert.equal(highPrice.side, "NO");
      const highPriceActionability = buildHolderResearchCandidateActionability(
        highPrice,
        p,
      );
      assert.equal(highPriceActionability.estimatedActionPrice, 0.96);
      assert.equal(
        highPriceActionability.likelyFinalGateBlockers.includes(
          "action_price_too_high",
        ),
        true,
      );
      assert.equal(highPriceActionability.isPrimaryResearchCandidate, false);

      const liveBlocked = buildHolderResearchCandidatesFromMarket(
        market({
          livePriceCheck: {
            blockersBySide: {
              YES: [],
              NO: ["terminal_price"],
            },
            checkedAt: new Date().toISOString(),
            fresh: true,
            sideBuyPrices: {
              YES: 0.01,
              NO: 0.99,
            },
            tokenIds: ["yes-token", "no-token"],
            yesProbability: 0.01,
          },
        }),
        p,
      ).find((candidate) => candidate.bucket === "sharp_minority");
      assert.ok(liveBlocked);
      assert.equal(liveBlocked.side, "NO");
      const liveBlockedActionability =
        buildHolderResearchCandidateActionability(liveBlocked, p);
      assert.equal(
        liveBlockedActionability.likelyFinalGateBlockers.includes(
          "live_price_terminal",
        ),
        true,
      );
      assert.equal(liveBlockedActionability.isPrimaryResearchCandidate, false);

      const staleLiveBlocked = buildHolderResearchCandidatesFromMarket(
        market({
          livePriceCheck: {
            blockersBySide: {
              YES: ["live_price_stale"],
              NO: ["live_price_stale"],
            },
            checkedAt: new Date().toISOString(),
            fresh: false,
            sideBuyPrices: {
              YES: 0.4,
              NO: 0.6,
            },
            tokenIds: ["yes-token", "no-token"],
            yesProbability: 0.4,
          },
        }),
        p,
      ).find((candidate) => candidate.bucket === "sharp_minority");
      assert.ok(staleLiveBlocked);
      const staleLiveBlockedActionability =
        buildHolderResearchCandidateActionability(staleLiveBlocked, p);
      assert.equal(
        staleLiveBlockedActionability.likelyFinalGateBlockers.includes(
          "live_price_stale",
        ),
        true,
      );
      assert.equal(
        staleLiveBlockedActionability.isPrimaryResearchCandidate,
        false,
      );
    },
  },
  {
    name: "single-game sports strict mode blocks weak singles but allows clusters",
    run: () => {
      const p = policy();
      const weakSports = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "Alpha vs Beta",
          marketTitle: "Alpha wins",
          sides: {
            YES: side("YES", { usd: 90_000, wallets: 4 }),
            NO: side("NO", {
              usd: 32_000,
              wallets: 1,
              sharpHolders: 1,
              sharpUsd: 11_000,
              bestEdge: 0.12,
              bestZScore: 1.7,
              bestSampleCount: 12,
              bestResolvedStakeUsd: 2_000,
              bestTrades30d: 12,
            }),
          },
          holders: [
            holder("NO", {
              pnl30dUsd: 0,
              positionUsd: 11_000,
              resolvedWinRateEdge30d: 0.1,
              resolvedEdgeSampleCount30d: 12,
            }),
          ],
        }),
        p,
      ).find((candidate) => candidate.bucket === "sharp_minority");
      assert.ok(weakSports);
      const weakActionability = buildHolderResearchCandidateActionability(
        weakSports,
        p,
      );
      assert.equal(
        weakActionability.likelyFinalGateBlockers.includes(
          "single_game_sports_weak_single",
        ),
        true,
      );

      const clusterSports = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "Gamma vs Delta",
          marketId: "polymarket:sports-cluster",
          marketTitle: "Gamma wins",
          sides: {
            YES: side("YES", {
              usd: 95_000,
              wallets: 3,
              sharpHolders: 2,
              sharpUsd: 55_000,
              bestEdge: 0.19,
              bestZScore: 2.5,
              bestSampleCount: 28,
              bestResolvedStakeUsd: 8_000,
              bestTrades30d: 22,
            }),
            NO: side("NO", { usd: 20_000, wallets: 2 }),
          },
          holders: [
            holder("YES", {
              walletId: "00000000-0000-0000-0000-000000000031",
              positionUsd: 30_000,
            }),
            holder("YES", {
              walletId: "00000000-0000-0000-0000-000000000032",
              positionUsd: 25_000,
            }),
          ],
        }),
        p,
      ).find((candidate) => candidate.bucket === "sharp_side");
      assert.ok(clusterSports);
      const clusterActionability = buildHolderResearchCandidateActionability(
        clusterSports,
        p,
      );
      assert.equal(clusterActionability.isPrimaryResearchCandidate, true);
      assert.deepEqual(clusterActionability.likelyFinalGateBlockers, []);
    },
  },
  {
    name: "expiry boost ranks only otherwise primary candidates",
    run: () => {
      const p = policy({
        maxAgentCallsPerRun: 1,
        maxCandidatesPerRun: 1,
        quotaSharpMinority: 1,
      });
      const near = buildHolderResearchCandidatesFromMarket(
        market({
          marketId: "polymarket:near",
          closeTime: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        }),
        p,
      ).find((candidate) => candidate.bucket === "sharp_minority");
      const far = buildHolderResearchCandidatesFromMarket(
        market({
          marketId: "polymarket:far",
          closeTime: new Date(Date.now() + 60 * 24 * 3_600_000).toISOString(),
        }),
        p,
      ).find((candidate) => candidate.bucket === "sharp_minority");
      assert.ok(near);
      assert.ok(far);
      const selected = selectHolderResearchCandidates(
        [
          { ...far, score: 0.8 },
          { ...near, score: 0.8 },
        ],
        p,
      );
      assert.equal(selected.selected[0]?.market.marketId, "polymarket:near");
      assert.ok(
        buildHolderResearchCandidateActionability(near, p).expiryBoost > 0,
      );

      const longDatedPolitics = { ...far, score: 0.8 };
      const actionability = buildHolderResearchCandidateActionability(
        longDatedPolitics,
        p,
      );
      assert.equal(actionability.isPrimaryResearchCandidate, true);
      assert.equal(actionability.expiryBoost, 0);
    },
  },
  {
    name: "support facts attach to selected directional candidates",
    run: () => {
      const p = policy({
        maxAgentCallsPerRun: 1,
        maxCandidatesPerRun: 1,
        quotaRecentFlow: 0,
      });
      const candidates = buildHolderResearchCandidatesFromMarket(
        market({
          recentActivityUsd: p.minRecentActivityUsd * 2,
          recentActivityAt: new Date().toISOString(),
        }),
        p,
      );
      assert.ok(
        candidates.some((candidate) => candidate.bucket === "recent_flow"),
      );
      const selected = selectHolderResearchCandidates(candidates, p);
      assert.equal(selected.selected.length, 1);
      assert.ok(
        selected.selected[0]?.evidence.some((evidence) =>
          evidence.id.startsWith("support:recent_flow:"),
        ),
      );
      const diagnostics = buildHolderResearchSelectionDiagnostics(
        candidates,
        selected.selected,
        p,
      );
      assert.equal(diagnostics.supportOnly >= 1, true);
      assert.equal(diagnostics.selectedForTriage, 1);
      assert.equal(diagnostics.expiryBoosted >= 0, true);
    },
  },
  {
    name: "event diversity soft cap prefers other events but still refills when needed",
    run: () => {
      const p = policy({
        maxAgentCallsPerRun: 3,
        maxCandidatesPerRun: 3,
        quotaSharpSide: 10,
        selectionEventSoftCapPerEvent: 2,
      });
      const sameEventCandidates = [1, 2, 3].map((index) => {
        const candidate = buildHolderResearchCandidatesFromMarket(
          market({
            eventId: "polymarket:event-a",
            marketId: `polymarket:event-a-${index}`,
            marketTitle: `Team ${index}`,
            sides: {
              YES: side("YES", {
                usd: 95_000,
                wallets: 3,
                sharpHolders: 2,
                sharpUsd: 50_000,
                bestEdge: 0.19,
                bestZScore: 2.5,
                bestSampleCount: 28,
                bestResolvedStakeUsd: 8_000,
                bestTrades30d: 22,
              }),
              NO: side("NO", { usd: 20_000, wallets: 2 }),
            },
            holders: [
              holder("YES", {
                walletId: `00000000-0000-0000-0000-00000000004${index}`,
                positionUsd: 30_000,
              }),
              holder("YES", {
                walletId: `00000000-0000-0000-0000-00000000005${index}`,
                positionUsd: 25_000,
              }),
            ],
          }),
          p,
        ).find((candidate) => candidate.bucket === "sharp_side");
        assert.ok(candidate);
        return { ...candidate, score: 0.99 - index * 0.01 };
      });
      const otherEvent = buildHolderResearchCandidatesFromMarket(
        market({
          eventId: "polymarket:event-b",
          marketId: "polymarket:event-b-1",
          marketTitle: "Other team",
          sides: {
            YES: side("YES", {
              usd: 80_000,
              wallets: 3,
              sharpHolders: 2,
              sharpUsd: 45_000,
              bestEdge: 0.18,
              bestZScore: 2.4,
              bestSampleCount: 25,
              bestResolvedStakeUsd: 7_000,
              bestTrades30d: 20,
            }),
            NO: side("NO", { usd: 25_000, wallets: 2 }),
          },
          holders: [
            holder("YES", {
              walletId: "00000000-0000-0000-0000-000000000061",
              positionUsd: 28_000,
            }),
            holder("YES", {
              walletId: "00000000-0000-0000-0000-000000000062",
              positionUsd: 22_000,
            }),
          ],
        }),
        p,
      ).find((candidate) => candidate.bucket === "sharp_side");
      assert.ok(otherEvent);

      const selected = selectHolderResearchCandidates(
        [...sameEventCandidates, { ...otherEvent, score: 0.7 }],
        p,
      );
      assert.deepEqual(
        selected.selected.map((candidate) => candidate.market.eventId),
        ["polymarket:event-a", "polymarket:event-a", "polymarket:event-b"],
      );

      const onlySameEvent = selectHolderResearchCandidates(
        sameEventCandidates,
        p,
      );
      assert.deepEqual(
        onlySameEvent.selected.map((candidate) => candidate.market.eventId),
        ["polymarket:event-a", "polymarket:event-a", "polymarket:event-a"],
      );
    },
  },
  {
    name: "external search input is redacted but keeps public market context",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          marketDescription:
            "This market resolves Yes if the official public dataset reaches the threshold before the deadline.",
          resolutionSource: "Official public dataset",
          sides: {
            YES: side("YES", {
              usd: 32_000,
              wallets: 2,
              sharpHolders: 1,
              sharpUsd: 10_000,
              bestEdge: 0.16,
              bestZScore: 2.1,
              bestSampleCount: 24,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
            NO: side("NO", { usd: 120_000, wallets: 5 }),
          },
          holders: [
            holder("YES", {
              address: "0xabc",
              ownerAddress: "0xowner",
              walletUsdLikeBalance: 50_000,
              ownerUsdLikeBalance: 75_000,
              relatedOpenPositions: [
                {
                  marketId: "polymarket:other",
                  marketTitle: "Other hidden bet",
                  eventTitle: "Other event",
                  side: "NO",
                  positionUsd: 12_000,
                  yesProbability: 0.4,
                  snapshotAt: new Date(
                    "2026-01-01T00:00:00.000Z",
                  ).toISOString(),
                },
              ],
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);

      const externalInput = buildHolderResearchExternalSearchInput(candidate);
      const serializedExternal = JSON.stringify(externalInput);
      assert.match(
        serializedExternal,
        /official public dataset reaches the threshold/i,
      );
      assert.match(serializedExternal, /Official public dataset/);
      assert.doesNotMatch(serializedExternal, /0xabc/i);
      assert.doesNotMatch(serializedExternal, /0xowner/i);
      assert.doesNotMatch(serializedExternal, /walletId/i);
      assert.doesNotMatch(serializedExternal, /walletUsdLikeBalance/i);
      assert.doesNotMatch(serializedExternal, /ownerUsdLikeBalance/i);
      assert.doesNotMatch(serializedExternal, /Other hidden bet/i);
      assert.match(serializedExternal, /one short sentence/i);
      assert.doesNotMatch(serializedExternal, /public context/i);
      assert.doesNotMatch(serializedExternal, /public news/i);

      const internalInput = buildHolderResearchCandidatePromptJson(
        candidate,
        p,
      );
      const serializedInternal = JSON.stringify(internalInput);
      assert.match(serializedInternal, /0xabc/i);
      assert.doesNotMatch(serializedInternal, /0xowner/i);
      assert.doesNotMatch(serializedInternal, /ownerAddress/i);
      assert.doesNotMatch(serializedInternal, /walletUsdLikeBalance/i);
      assert.doesNotMatch(serializedInternal, /ownerUsdLikeBalance/i);
      assert.doesNotMatch(serializedInternal, /relatedOpenPositions/i);
      assert.match(serializedInternal, /Other hidden bet/i);
    },
  },
  {
    name: "decision snapshot ignores balance-only noise",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);
      const previous = buildHolderResearchDecisionSnapshot(candidate);
      const balanceOnly = {
        ...candidate,
        market: {
          ...candidate.market,
          holders: candidate.market.holders.map((entry) => ({
            ...entry,
            walletUsdLikeBalance: (entry.walletUsdLikeBalance ?? 0) + 1_000_000,
            ownerUsdLikeBalance: (entry.ownerUsdLikeBalance ?? 0) + 1_000_000,
          })),
        },
      };
      const current = buildHolderResearchDecisionSnapshot(balanceOnly);
      assert.deepEqual(
        diffHolderResearchDecisionSnapshots(previous, current, p),
        [],
      );
    },
  },
  {
    name: "meaningful delta rules detect odds, exposure, holder, flow, and related-position changes",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);
      const previous = buildHolderResearchDecisionSnapshot(candidate);

      const oddsMoved = buildHolderResearchDecisionSnapshot({
        ...candidate,
        market: { ...candidate.market, yesProbability: 0.6 },
      });
      assert.deepEqual(
        diffHolderResearchDecisionSnapshots(previous, oddsMoved, p),
        ["odds_move"],
      );

      const sideMoved = buildHolderResearchDecisionSnapshot({
        ...candidate,
        market: {
          ...candidate.market,
          sides: {
            ...candidate.market.sides,
            NO: { ...candidate.market.sides.NO, usd: 57_000 },
          },
        },
      });
      assert.ok(
        diffHolderResearchDecisionSnapshots(previous, sideMoved, p).includes(
          "side_exposure_move:NO",
        ),
      );

      const holderMoved = buildHolderResearchDecisionSnapshot({
        ...candidate,
        market: {
          ...candidate.market,
          holders: candidate.market.holders.map((entry) => ({
            ...entry,
            positionUsd: entry.positionUsd + 5_000,
          })),
        },
      });
      assert.ok(
        diffHolderResearchDecisionSnapshots(previous, holderMoved, p).includes(
          "holder_position_move:NO",
        ),
      );

      const freshFlow = buildHolderResearchDecisionSnapshot({
        ...candidate,
        market: {
          ...candidate.market,
          recentActivityUsd: p.minRecentActivityUsd,
          recentActivityAt: "2026-01-01T01:00:00.000Z",
        },
      });
      assert.ok(
        diffHolderResearchDecisionSnapshots(
          previous,
          freshFlow,
          p,
          "2026-01-01T00:00:00.000Z",
        ).includes("fresh_flow"),
      );

      const relatedMoved = buildHolderResearchDecisionSnapshot({
        ...candidate,
        market: {
          ...candidate.market,
          holders: candidate.market.holders.map((entry) => ({
            ...entry,
            relatedOpenPositions: [
              {
                marketId: "polymarket:related",
                marketTitle: "Related market",
                eventTitle: "Related event",
                side: "YES",
                positionUsd: p.minHolderPositionUsd,
                yesProbability: 0.4,
                snapshotAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          })),
        },
      });
      assert.ok(
        diffHolderResearchDecisionSnapshots(previous, relatedMoved, p).includes(
          "related_position_changed",
        ),
      );
    },
  },
  {
    name: "decision cache suppresses skip/context before cooldown and bypasses on delta or force",
    run: () => {
      const p = policy({
        skipCooldownHours: 12,
        contextCooldownHours: 6,
        forceRecheckAfterHours: 48,
      });
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);
      const checkedAt = new Date("2026-01-01T00:00:00.000Z");
      const cachedSkip = buildHolderResearchDecisionCacheRecord({
        candidate,
        output: { status: "SKIP", rationale: "Weak evidence." },
        model: p.model,
        policy: p,
        now: checkedAt,
      });
      const beforeCooldown = evaluateHolderResearchDecisionCache({
        candidate,
        cachedDecision: cachedSkip,
        policy: p,
        now: new Date("2026-01-01T01:00:00.000Z"),
      });
      assert.equal(beforeCooldown.action, "skip");
      assert.equal(beforeCooldown.reason, "decision_cache");

      const movedCandidate = {
        ...candidate,
        market: { ...candidate.market, yesProbability: 0.61 },
      };
      const delta = evaluateHolderResearchDecisionCache({
        candidate: movedCandidate,
        cachedDecision: cachedSkip,
        policy: p,
        now: new Date("2026-01-01T01:00:00.000Z"),
      });
      assert.equal(delta.action, "analyze");
      assert.equal(delta.reason, "meaningful_delta");
      assert.deepEqual(delta.meaningfulDeltaReasons, ["odds_move"]);

      const forced = evaluateHolderResearchDecisionCache({
        candidate,
        cachedDecision: cachedSkip,
        policy: p,
        now: new Date("2026-01-03T01:00:00.000Z"),
      });
      assert.equal(forced.action, "analyze");
      assert.equal(forced.reason, "force_recheck");

      const cachedContext = buildHolderResearchDecisionCacheRecord({
        candidate,
        output: { status: "CONTEXT", rationale: "Useful context only." },
        model: p.model,
        policy: p,
        now: checkedAt,
      });
      const contextBeforeCooldown = evaluateHolderResearchDecisionCache({
        candidate,
        cachedDecision: cachedContext,
        policy: p,
        now: new Date("2026-01-01T01:00:00.000Z"),
      });
      assert.equal(contextBeforeCooldown.action, "skip");
      assert.equal(contextBeforeCooldown.cachedStatus, "CONTEXT");
    },
  },
  {
    name: "decision cache does not recheck non-actionable candidates from generic flow alone",
    run: () => {
      const p = policy({
        skipCooldownHours: 12,
        forceRecheckAfterHours: 48,
      });
      const previous = buildHolderResearchCandidatesFromMarket(
        market({
          recentActivityUsd: p.minRecentActivityUsd,
          recentActivityAt: "2026-01-01T00:00:00.000Z",
        }),
        p,
      ).find((item) => item.bucket === "recent_flow");
      assert.ok(previous);
      const cachedSkip = buildHolderResearchDecisionCacheRecord({
        candidate: previous,
        output: { status: "SKIP", rationale: "Support context only." },
        model: p.model,
        policy: p,
        now: new Date("2026-01-01T00:30:00.000Z"),
      });
      const current = {
        ...previous,
        market: {
          ...previous.market,
          recentActivityUsd: p.minRecentActivityUsd * 2,
          recentActivityAt: "2026-01-01T02:00:00.000Z",
        },
      };
      const evaluation = evaluateHolderResearchDecisionCache({
        candidate: current,
        cachedDecision: cachedSkip,
        policy: p,
        now: new Date("2026-01-01T02:10:00.000Z"),
      });
      assert.equal(evaluation.action, "skip");
      assert.equal(evaluation.reason, "decision_cache");
      assert.deepEqual(evaluation.meaningfulDeltaReasons, []);
    },
  },
  {
    name: "holder research wallet targets come from selected holder evidence",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          sides: {
            YES: side("YES", {
              usd: 32_000,
              wallets: 2,
              sharpHolders: 1,
              sharpUsd: 10_000,
              bestEdge: 0.16,
              bestZScore: 2.1,
              bestSampleCount: 24,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
            NO: side("NO", { usd: 120_000, wallets: 5 }),
          },
          holders: [
            holder("YES", {
              walletId: "00000000-0000-4000-8000-000000000011",
              positionUsd: 12_345,
              openPnlUsd: -123,
            }),
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000012",
              positionUsd: 54_321,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);

      const targets = buildHolderResearchWalletTargets(candidate, [
        "market:polymarket:test-market",
        "holder:00000000-0000-4000-8000-000000000011:YES",
      ]);
      assert.equal(targets.length, 1);
      assert.equal(
        targets[0]?.walletId,
        "00000000-0000-4000-8000-000000000011",
      );
      assert.equal(targets[0]?.rank, 10);
      assert.equal(targets[0]?.meta.side, "YES");
      assert.equal(targets[0]?.meta.positionUsd, 12_345);
      assert.equal(targets[0]?.meta.openPnlUsd, -123);
    },
  },
  {
    name: "holder research wallet targets fall back to strongest candidate holder",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          sides: {
            YES: side("YES", {
              usd: 32_000,
              wallets: 2,
              sharpHolders: 1,
              sharpUsd: 12_000,
              bestEdge: 0.18,
              bestZScore: 2.2,
              bestSampleCount: 24,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
            NO: side("NO", { usd: 120_000, wallets: 5 }),
          },
          holders: [
            holder("YES", {
              walletId: "00000000-0000-4000-8000-000000000021",
              positionUsd: 12_000,
            }),
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000022",
              positionUsd: 60_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);

      const targets = buildHolderResearchWalletTargets(candidate, [
        "market:polymarket:test-market",
      ]);
      assert.equal(targets.length, 1);
      assert.equal(
        targets[0]?.walletId,
        "00000000-0000-4000-8000-000000000021",
      );
      assert.equal(targets[0]?.meta.side, "YES");
    },
  },
  {
    name: "holder research follow-up reuses previous note holder target",
    run: () => {
      const p = policy();
      const yesWalletId = "00000000-0000-4000-8000-000000000031";
      const noWalletId = "00000000-0000-4000-8000-000000000032";
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          holders: [
            holder("YES", {
              walletId: yesWalletId,
              positionUsd: 13_000,
            }),
            holder("NO", {
              walletId: noWalletId,
              positionUsd: 35_000_000,
            }),
          ],
          previousNote: {
            cooldownUntil: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputDigest: "previous",
            noteId: "00000000-0000-4000-8000-000000000099",
            title: "Previous YES holder note",
            walletTargets: [{ side: "YES", walletId: yesWalletId }],
          },
        }),
        p,
      ).find((item) => item.bucket === "followup_existing");
      assert.ok(candidate);

      const targets = buildHolderResearchWalletTargets(candidate, [
        "note:00000000-0000-4000-8000-000000000099",
      ]);
      assert.equal(targets.length, 1);
      assert.equal(targets[0]?.walletId, yesWalletId);
      assert.equal(targets[0]?.meta.side, "YES");
    },
  },
  {
    name: "holder research follow-up does not fall back to unrelated largest holder",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          holders: [
            holder("YES", {
              walletId: "00000000-0000-4000-8000-000000000041",
              positionUsd: 13_000,
            }),
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000042",
              positionUsd: 35_000_000,
            }),
          ],
          previousNote: {
            cooldownUntil: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            inputDigest: "previous",
            noteId: "00000000-0000-4000-8000-000000000098",
            title: "Previous note without holder target",
            walletTargets: [],
          },
        }),
        p,
      ).find((item) => item.bucket === "followup_existing");
      assert.ok(candidate);

      const targets = buildHolderResearchWalletTargets(candidate, [
        "note:00000000-0000-4000-8000-000000000098",
      ]);
      assert.equal(targets.length, 0);
    },
  },
  {
    name: "holder research quality gate keeps directional sharp signals publishable",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const output = publishOutput(candidate);
      const gated = applyHolderResearchPublishQualityGate({
        candidate,
        output,
        policy: p,
      });
      assert.equal(gated.status, "PUBLISH");
    },
  },
  {
    name: "holder research quality assessment classifies sports singles and contradicted credentials",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "Czechia vs. Mexico",
          marketTitle: "Mexico",
          closeTime: new Date(Date.now() + 3 * 3_600_000).toISOString(),
          holders: [
            holder("NO", {
              positionUsd: 32_000,
              pnl30dUsd: -25_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const quality = buildHolderResearchQualityAssessment(candidate, p);
      assert.equal(quality.marketType, "single_game_sports");
      assert.equal(quality.credentialStrength, "contradicted");
      assert.equal(quality.actorStrength, "weak_single");
      assert.equal(quality.reasons.includes("negative_30d_pnl"), true);
    },
  },
  {
    name: "holder research quality assessment prioritizes explicit sports context",
    run: () => {
      const p = policy();
      const sportsSingle = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "Iran vs. Russia",
          marketTitle: "Iran",
          closeTime: new Date(Date.now() + 3 * 3_600_000).toISOString(),
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(sportsSingle);
      assert.equal(
        buildHolderResearchQualityAssessment(sportsSingle, p).marketType,
        "single_game_sports",
      );

      const sportsOutright = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "World Cup Winner",
          marketTitle: "Ukraine",
          closeTime: new Date(Date.now() + 120 * 24 * 3_600_000).toISOString(),
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(sportsOutright);
      assert.equal(
        buildHolderResearchQualityAssessment(sportsOutright, p).marketType,
        "sports_outright",
      );

      const geo = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Politics",
          eventTitle: "Strait of Hormuz traffic returns to normal",
          marketTitle: "By July 31?",
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(geo);
      assert.equal(
        buildHolderResearchQualityAssessment(geo, p).marketType,
        "politics_geo",
      );
    },
  },
  {
    name: "holder research quality gate downgrades weak sports singles",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "Morocco vs. Haiti",
          marketTitle: "Morocco",
          closeTime: new Date(Date.now() + 2 * 3_600_000).toISOString(),
          sides: {
            YES: side("YES", { usd: 80_000, wallets: 4 }),
            NO: side("NO", {
              usd: 35_000,
              wallets: 1,
              sharpHolders: 1,
              sharpUsd: 10_000,
              bestEdge: 0.1,
              bestZScore: 1.8,
              bestSampleCount: 12,
              bestResolvedStakeUsd: 2_000,
              bestTrades30d: 18,
            }),
          },
          holders: [
            holder("NO", {
              positionUsd: 10_000,
              pnl30dUsd: -500,
              winRate30d: 0.6,
              resolvedWinRateEdge30d: 0.1,
              resolvedEdgeSampleCount30d: 12,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const gated = applyHolderResearchPublishQualityGate({
        candidate,
        output: publishOutput(candidate),
        policy: p,
      });
      assert.equal(gated.status, "CONTEXT");
      assert.match(gated.rationale, /Single-game sports/);
    },
  },
  {
    name: "holder research quality gate allows exceptional sports singles and clusters",
    run: () => {
      const p = policy();
      const exceptional = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "South Africa vs. Korea Republic",
          marketTitle: "Korea Republic",
          closeTime: new Date(Date.now() + 4 * 3_600_000).toISOString(),
          sides: {
            YES: side("YES", { usd: 350_000, wallets: 5 }),
            NO: side("NO", {
              usd: 230_000,
              wallets: 2,
              sharpHolders: 1,
              sharpUsd: 30_000,
              bestEdge: 0.19,
              bestZScore: 2.2,
              bestSampleCount: 22,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
          },
          holders: [
            holder("NO", {
              positionUsd: 30_000,
              pnl30dUsd: 310_000,
              winRate30d: 0.7,
              resolvedWinRateEdge30d: 0.19,
              resolvedEdgeSampleCount30d: 22,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(exceptional);
      assert.equal(
        applyHolderResearchPublishQualityGate({
          candidate: exceptional,
          output: publishOutput(exceptional),
          policy: p,
        }).status,
        "PUBLISH",
      );

      const cluster = buildHolderResearchCandidatesFromMarket(
        market({
          category: "Sports",
          eventTitle: "Apogee Esports vs OG",
          marketTitle: "Match Winner",
          closeTime: new Date(Date.now() + 1 * 3_600_000).toISOString(),
          sides: {
            YES: side("YES", {
              usd: 50_000,
              wallets: 3,
              sharpHolders: 2,
              sharpUsd: 35_000,
              bestEdge: 0.18,
              bestZScore: 2.3,
              bestSampleCount: 40,
              bestResolvedStakeUsd: 8_000,
              bestTrades30d: 20,
            }),
            NO: side("NO", { usd: 48_000, wallets: 3 }),
          },
          holders: [
            holder("YES", {
              walletId: "00000000-0000-4000-8000-000000000071",
              positionUsd: 20_000,
              pnl30dUsd: 250_000,
            }),
            holder("YES", {
              walletId: "00000000-0000-4000-8000-000000000072",
              positionUsd: 15_000,
              pnl30dUsd: 150_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(cluster);
      assert.equal(
        applyHolderResearchPublishQualityGate({
          candidate: cluster,
          output: publishOutput(cluster),
          policy: p,
        }).status,
        "PUBLISH",
      );
    },
  },
  {
    name: "holder research quality gate downgrades same-event sports conflicts",
    run: () => {
      const p = policy();
      const first = buildHolderResearchCandidatesFromMarket(
        market({
          marketId: "polymarket:germany",
          eventId: "polymarket:ecuador-germany",
          category: "Sports",
          eventTitle: "Ecuador vs. Germany",
          marketTitle: "Germany",
          closeTime: new Date(Date.now() + 8 * 3_600_000).toISOString(),
          holders: [
            holder("NO", {
              positionUsd: 30_000,
              pnl30dUsd: 250_000,
              winRate30d: 0.7,
              resolvedWinRateEdge30d: 0.18,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      const second = buildHolderResearchCandidatesFromMarket(
        market({
          marketId: "polymarket:ecuador",
          eventId: "polymarket:ecuador-germany",
          category: "Sports",
          eventTitle: "Ecuador vs. Germany",
          marketTitle: "Ecuador",
          closeTime: new Date(Date.now() + 8 * 3_600_000).toISOString(),
          holders: [
            holder("NO", {
              positionUsd: 30_000,
              pnl30dUsd: 250_000,
              winRate30d: 0.7,
              resolvedWinRateEdge30d: 0.18,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(first);
      assert.ok(second);

      const gated = applyHolderResearchPublishQualityGate({
        candidate: first,
        output: publishOutput(first),
        policy: p,
        publishedRunDecisions: [
          {
            candidate: second,
            output: publishOutput(second),
          },
        ],
      });
      assert.equal(gated.status, "CONTEXT");
      assert.match(gated.rationale, /Same-event sports/);
    },
  },
  {
    name: "holder research quality gate does not downgrade non-conflicting same-event sports",
    run: () => {
      const p = policy();
      const first = buildHolderResearchCandidatesFromMarket(
        market({
          marketId: "polymarket:germany",
          eventId: "polymarket:ecuador-germany",
          category: "Sports",
          eventTitle: "Ecuador vs. Germany",
          marketTitle: "Germany",
          closeTime: new Date(Date.now() + 8 * 3_600_000).toISOString(),
          holders: [
            holder("NO", {
              positionUsd: 30_000,
              pnl30dUsd: 250_000,
              winRate30d: 0.7,
              resolvedWinRateEdge30d: 0.18,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      const second = buildHolderResearchCandidatesFromMarket(
        market({
          marketId: "polymarket:ecuador",
          eventId: "polymarket:ecuador-germany",
          category: "Sports",
          eventTitle: "Ecuador vs. Germany",
          marketTitle: "Ecuador",
          closeTime: new Date(Date.now() + 8 * 3_600_000).toISOString(),
          sides: {
            YES: side("YES", {
              usd: 70_000,
              wallets: 3,
              sharpHolders: 1,
              sharpUsd: 30_000,
              bestEdge: 0.18,
              bestZScore: 2.2,
              bestSampleCount: 24,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
            NO: side("NO", { usd: 40_000, wallets: 2 }),
          },
          holders: [
            holder("YES", {
              positionUsd: 30_000,
              pnl30dUsd: 250_000,
              winRate30d: 0.7,
              resolvedWinRateEdge30d: 0.18,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(first);
      assert.ok(second);

      const gated = applyHolderResearchPublishQualityGate({
        candidate: first,
        output: publishOutput(first),
        policy: p,
        publishedRunDecisions: [
          {
            candidate: second,
            output: publishOutput(second),
          },
        ],
      });
      assert.equal(gated.status, "PUBLISH");
    },
  },
  {
    name: "holder research quality gate downgrades mixed publishes",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          recentActivityUsd: 50_000,
          recentActivityAt: "2026-01-01T00:00:00.000Z",
        }),
        p,
      ).find((item) => item.bucket === "recent_flow");
      assert.ok(candidate);

      const gated = applyHolderResearchPublishQualityGate({
        candidate,
        output: publishOutput(candidate, { direction: "mixed" }),
        policy: p,
      });
      assert.equal(gated.status, "CONTEXT");
      assert.match(gated.rationale, /Mixed holder reads/);
    },
  },
  {
    name: "holder research quality gate downgrades non-actionable buckets",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "clean_disagreement");
      assert.ok(candidate);

      const gated = applyHolderResearchPublishQualityGate({
        candidate,
        output: publishOutput(candidate, { direction: "down" }),
        policy: p,
      });
      assert.equal(gated.status, "CONTEXT");
      assert.match(gated.rationale, /not a directional publish signal/);
    },
  },
  {
    name: "holder research quality gate downgrades side conflicts",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const gated = applyHolderResearchPublishQualityGate({
        candidate,
        output: publishOutput(candidate, { direction: "up" }),
        policy: p,
      });
      assert.equal(gated.status, "CONTEXT");
      assert.match(gated.rationale, /did not match/);
    },
  },
  {
    name: "holder research actor summary uses plain-language credentials",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const actor = buildHolderResearchActorSummary({
        candidate,
        evidenceIds: candidate.evidence.map((evidence) => evidence.id),
        policy: p,
      });
      assert.equal(actor.mode, "single_holder");
      assert.deepEqual(actor.credentialBullets.slice(0, 3), [
        "Up $2.5K over the last 30 days",
        "Beat market prices by 16 points across 24 resolved bets",
        "Traded $90.0K over the last 30 days",
      ]);
      assert.equal(
        actor.credentialBullets.some((bullet) =>
          /won .*recent trades|sample|n=|resolved edge/i.test(bullet),
        ),
        false,
      );
    },
  },
  {
    name: "holder research actor summary ignores non-positive pnl as profit",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          holders: [
            holder("NO", {
              pnl30dUsd: -500,
              winRate30d: 0.5,
              resolvedWinRateEdge30d: 0.01,
              resolvedEdgeSampleCount30d: 24,
              volume30dUsd: 1_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const actor = buildHolderResearchActorSummary({
        candidate,
        evidenceIds: candidate.evidence.map((evidence) => evidence.id),
        policy: p,
      });
      assert.equal(actor.mode, "none");
      assert.equal(
        actor.credentialBullets.some((bullet) => /Up /i.test(bullet)),
        false,
      );
    },
  },
  {
    name: "holder research actor summary detects sharp clusters",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          sides: {
            YES: side("YES", { usd: 120_000, wallets: 5 }),
            NO: side("NO", {
              usd: 45_000,
              wallets: 2,
              sharpHolders: 2,
              sharpUsd: 45_000,
              bestEdge: 0.16,
              bestZScore: 2.1,
              bestSampleCount: 24,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
          },
          holders: [
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000051",
              positionUsd: 25_000,
              pnl30dUsd: 10_000,
            }),
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000052",
              positionUsd: 20_000,
              pnl30dUsd: 4_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const actor = buildHolderResearchActorSummary({
        candidate,
        evidenceIds: candidate.evidence.map((evidence) => evidence.id),
        policy: p,
      });
      assert.equal(actor.mode, "sharp_cluster");
      assert.equal(actor.cluster?.sharpHolders, 2);
      assert.equal(actor.cluster?.pnl30dUsd, 14_000);
      assert.deepEqual(actor.credentialBullets.slice(0, 2), [
        "Up $14.0K combined over the last 30 days",
        "2 strong wallets on the same side",
      ]);
    },
  },
  {
    name: "holder research actor summary omits incomplete cluster pnl",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          sides: {
            YES: side("YES", { usd: 120_000, wallets: 5 }),
            NO: side("NO", {
              usd: 45_000,
              wallets: 3,
              sharpHolders: 3,
              sharpUsd: 45_000,
              bestEdge: 0.16,
              bestZScore: 2.1,
              bestSampleCount: 24,
              bestResolvedStakeUsd: 6_000,
              bestTrades30d: 18,
            }),
          },
          holders: [
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000061",
              positionUsd: 20_000,
              pnl30dUsd: 10_000,
            }),
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000062",
              positionUsd: 15_000,
              pnl30dUsd: null,
            }),
            holder("NO", {
              walletId: "00000000-0000-4000-8000-000000000063",
              positionUsd: 10_000,
              pnl30dUsd: 4_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const actor = buildHolderResearchActorSummary({
        candidate,
        evidenceIds: candidate.evidence.map((evidence) => evidence.id),
        policy: p,
      });
      assert.equal(actor.mode, "sharp_cluster");
      assert.equal(actor.cluster?.sharpHolders, 3);
      assert.equal(actor.cluster?.pnl30dUsd, null);
      assert.deepEqual(actor.credentialBullets.slice(0, 2), [
        "3 strong wallets on the same side",
        "$45.0K tracked by strong wallets",
      ]);
      assert.equal(
        actor.credentialBullets.some((bullet) => /combined/i.test(bullet)),
        false,
      );
    },
  },
  {
    name: "holder research quality gate downgrades sharp signals without credentials",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          holders: [
            holder("NO", {
              pnl30dUsd: 0,
              winRate30d: 0.5,
              resolvedWinRateEdge30d: 0.01,
              volume30dUsd: 90_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_side");
      assert.ok(candidate);

      const gated = applyHolderResearchPublishQualityGate({
        candidate,
        output: publishOutput(candidate),
        policy: p,
      });
      assert.equal(gated.status, "CONTEXT");
      assert.match(gated.rationale, /No strong holder credential/);
    },
  },
  {
    name: "holder research prompt keeps credential facts out of summary copy",
    run: () => {
      const prompt = buildHolderResearchSystemPrompt();
      assert.match(prompt, /do not repeat the bullets verbatim/i);
      assert.match(prompt, /do not invent credentials/i);
      assert.match(prompt, /candidate\.move/i);
      assert.match(prompt, /candidate\.holderEntry/i);
      assert.match(prompt, /sameType/i);
      assert.match(prompt, /private trading group/i);
      assert.match(prompt, /understand the setup in 2 seconds/i);
      assert.match(prompt, /which side the wallet\(s\) are on/i);
      assert.match(prompt, /compressed signal thesis/i);
      assert.match(prompt, /Lead with what strong wallets are doing/i);
      assert.match(prompt, /Use 'smart wallets' only when credentials are strong/i);
      assert.match(prompt, /flexible checklist, not a fixed template/i);
      assert.match(prompt, /Avoid overusing 'serious buyer\(s\)'/i);
      assert.match(prompt, /Do not reuse the same sentence shape/i);
      assert.match(prompt, /Avoid in headline\/summary/i);
      assert.match(prompt, /Strong wallets are fading Norway/i);
      assert.match(prompt, /Market signal detected/i);
      assert.doesNotMatch(prompt, /@/);
      assert.match(prompt, /Bad headline examples/i);
      assert.doesNotMatch(
        prompt,
        /Prefer simple phrases like 'informed wallets'/i,
      );
    },
  },
  {
    name: "candidate prompt includes movement, entry, and market-type context",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          yesProbability: 0.6,
          marketMovementContext: {
            ...market().marketMovementContext,
            yesProbabilityNow: 0.6,
            yesChange24h: 0.08,
            volumeChange24h: 50_000,
            liquidityChange24h: -2_000,
            openInterestChange24h: 15_000,
          },
          holders: [
            holder("NO", {
              avgEntryPrice: 0.3,
              currentPrice: 0.4,
              entryToCurrentDelta: 0.1,
              totalPnlUsd: 1_200,
              approxReliable: true,
              approxPnlSource: "activity",
              positionSnapshotAt: "2026-01-01T00:00:00.000Z",
              marketTypeMetrics30d: {
                walletId: "00000000-0000-0000-0000-000000000002",
                marketType: "politics_geo",
                period: "30d",
                asOf: "2026-01-02T00:00:00.000Z",
                tradesCount: 8,
                volumeUsd: 40_000,
                pnlUsd: 4_000,
                roi: 0.1,
                winRate: 0.75,
                resolvedEdgeSampleCount: 6,
                resolvedActualWinRate: 0.75,
                resolvedExpectedWinRate: 0.55,
                resolvedWinRateEdge: 0.2,
                resolvedEdgeZScore: 1.4,
                resolvedBrierScore: 0.08,
                resolvedStakeWeightedEdge: 0.16,
                resolvedStakeUsd: 15_000,
                lastTradeAt: "2026-01-01T12:00:00.000Z",
                approximate: false,
                unmarkedOpenLegCount: 0,
              },
              marketSegmentMetrics30d: {
                walletId: "00000000-0000-0000-0000-000000000002",
                marketType: "politics_geo",
                marketSegment: "politics_geo",
                period: "30d",
                asOf: "2026-01-02T00:00:00.000Z",
                tradesCount: 5,
                volumeUsd: 25_000,
                pnlUsd: 2_500,
                roi: 0.1,
                winRate: 0.8,
                resolvedEdgeSampleCount: 4,
                resolvedActualWinRate: 0.8,
                resolvedExpectedWinRate: 0.6,
                resolvedWinRateEdge: 0.2,
                resolvedEdgeZScore: 1.2,
                resolvedBrierScore: 0.1,
                resolvedStakeWeightedEdge: 0.14,
                resolvedStakeUsd: 9_000,
                lastTradeAt: "2026-01-01T13:00:00.000Z",
                approximate: false,
                unmarkedOpenLegCount: 0,
              },
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);

      const promptJson = buildHolderResearchCandidatePromptJson(candidate, p);
      const record = promptJson as Record<string, unknown>;
      assert.equal(
        (record.quality as Record<string, unknown>).marketType,
        "politics_geo",
      );
      assert.equal(
        (record.quality as Record<string, unknown>).marketSegment,
        "politics_geo",
      );
      assert.deepEqual((record.move as Record<string, unknown>).dYes24h, 0.08);
      const entry = (record.holderEntry as Array<Record<string, unknown>>)[0];
      assert.equal(entry?.entry, 0.3);
      assert.equal(entry?.cur, 0.4);
      assert.equal(entry?.dEntry, 0.1);
      assert.equal(entry?.pnlReliable, true);
      assert.deepEqual(
        (entry?.sameType as Record<string, unknown>).type,
        "politics_geo",
      );
      assert.equal((entry?.sameType as Record<string, unknown>).pnlUsd, 4_000);
      assert.equal(
        (entry?.sameSegment as Record<string, unknown>).segment,
        "politics_geo",
      );
      assert.equal(
        (entry?.sameSegment as Record<string, unknown>).pnlUsd,
        2_500,
      );
      const serialized = JSON.stringify(record);
      assert.match(serialized, /"mkt"/);
      assert.match(serialized, /"addr"/);
      assert.doesNotMatch(serialized, /identityProfileUrl/);
      assert.doesNotMatch(serialized, /ownerAddress/);
      assert.doesNotMatch(serialized, /walletUsdLikeBalance/);
      assert.doesNotMatch(serialized, /resolvedEdgeZScore30d/);
    },
  },
  {
    name: "candidate prompt uses compact holders with limit and address",
    run: () => {
      const p = policy({ promptHoldersLimit: 2 });
      const candidate = buildHolderResearchCandidatesFromMarket(
        market({
          outcomes: ["Alpha Team", "Beta Team"],
          holders: [
            holder("NO", {
              walletId: "00000000-0000-0000-0000-000000000011",
              address: "0xprimary",
              positionUsd: 30_000,
            }),
            holder("NO", {
              walletId: "00000000-0000-0000-0000-000000000012",
              address: "0xsecondary",
              positionUsd: 20_000,
            }),
            holder("YES", {
              walletId: "00000000-0000-0000-0000-000000000013",
              address: "0xopposing",
              positionUsd: 200_000,
            }),
          ],
        }),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);

      const promptJson = buildHolderResearchCandidatePromptJson(candidate, p);
      const holders = (promptJson as Record<string, unknown>).holders as Array<
        Record<string, unknown>
      >;
      assert.equal(holders.length, 2);
      assert.equal(holders[0]?.addr, "0xprimary");
      assert.equal(holders[1]?.addr, "0xsecondary");
      const serialized = JSON.stringify(promptJson);
      assert.match(serialized, /"addr"/);
      assert.match(
        serialized,
        /"labels":\{"YES":"Alpha Team","NO":"Beta Team"\}/,
      );
      assert.doesNotMatch(serialized, /0xowner/);
      assert.doesNotMatch(serialized, /walletUsdLikeBalance/);
      assert.doesNotMatch(serialized, /identityProfileUrl/);
      assert.doesNotMatch(serialized, /positionShares/);

      const finalPrompt = buildHolderResearchUserPrompt({
        candidateJson: promptJson,
        allowedEvidenceIds: candidate.evidence.map((entry) => entry.id),
      });
      assert.doesNotMatch(finalPrompt, /\n\s+"/);
    },
  },
  {
    name: "triage prompt uses thin candidate context and parser rejects unknown keys",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);

      const triageCandidate = buildHolderResearchTriageCandidatePromptJson(
        candidate,
        p,
      );
      const serialized = JSON.stringify(triageCandidate);
      assert.match(serialized, /"mkt"/);
      assert.match(serialized, /"move"/);
      assert.match(serialized, /"holderEntry"/);
      assert.match(serialized, /quality/);
      assert.match(serialized, /marketSegment/);
      assert.match(serialized, /triageGate/);
      assert.equal(
        (triageCandidate.triageGate as Record<string, unknown>)
          .canLikelyPublish,
        true,
      );
      assert.match(serialized, /"addr"/);
      const prompt = buildHolderResearchTriageUserPrompt({
        candidates: [triageCandidate],
        maxInvestigate: 1,
        calibrationMemo: ["Recent failed pattern: weak sports singles."],
      });
      assert.match(prompt, /holder_research_triage_v1/);
      assert.match(prompt, /Recent failed pattern/);
      assert.doesNotMatch(prompt, /\n\s+"/);
      assert.match(buildHolderResearchTriageSystemPrompt(), /investigate/);

      const parsed = parseHolderResearchTriageOutputV1(
        {
          version: "holder_research_triage_v1",
          decisions: [
            {
              key: candidate.key,
              action: "investigate",
              priority: 0.8,
              needs_external_search: true,
              reason: "Clear sharp holder read with movement context.",
            },
          ],
        },
        [candidate.key],
      );
      assert.equal(parsed.decisions[0]?.action, "investigate");
      const fenced = parseHolderResearchTriageModelContent(
        [
          "```json",
          JSON.stringify({
            version: "holder_research_triage_v1",
            decisions: [
              {
                key: candidate.key,
                action: "watch",
                priority: 0.4,
                needs_external_search: false,
                reason: "Interesting but not strong enough.",
              },
            ],
          }).replace(/}]}$/, "},]}"),
          "```",
        ].join("\n"),
        [candidate.key],
      );
      assert.equal(fenced.decisions[0]?.action, "watch");
      const truncated = parseHolderResearchTriageModelContent(
        `Here is JSON: {"version":"holder_research_triage_v1","decisions":[{"key":"${candidate.key}","action":"investigate","priority":0.91,"needs_external_search":true,"reason":"Clear sharp holder read."},{"key":"${candidate.key}","action":"watch"`,
        [candidate.key],
      );
      assert.equal(truncated.decisions.length, 1);
      assert.equal(truncated.decisions[0]?.action, "investigate");
      const ignoredIncomplete = parseHolderResearchTriageOutputV1(
        {
          version: "holder_research_triage_v1",
          decisions: [
            {
              key: candidate.key,
              action: "skip",
              reason: "Missing priority should be ignored.",
            },
            {
              key: candidate.key,
              action: "investigate",
              priority: 0.8,
              needs_external_search: true,
              reason: "Complete entry is kept.",
            },
          ],
        },
        [candidate.key],
      );
      assert.equal(ignoredIncomplete.decisions.length, 1);
      assert.equal(ignoredIncomplete.decisions[0]?.action, "investigate");
      assert.throws(() =>
        parseHolderResearchTriageOutputV1(
          {
            version: "holder_research_triage_v1",
            decisions: [
              {
                key: "unknown",
                action: "watch",
                priority: 0.5,
                needs_external_search: false,
                reason: "Unknown key.",
              },
            ],
          },
          [candidate.key],
        ),
      );
      assert.throws(() =>
        parseHolderResearchTriageModelContent(
          '{"version":"holder_research_triage_v1","decisions":[{"key":"unknown","action":"watch","priority":0.5,"needs_external_search":false,"reason":"Unknown key."}]}',
          [candidate.key],
        ),
      );
    },
  },
  {
    name: "triage fallback selects clear-side deterministic candidates",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);

      const followup = {
        ...candidate,
        key: "holder_research:v1:followup:test:YES",
        bucket: "followup_existing" as const,
        score: candidate.score + 100,
        side: "YES" as const,
        direction: "up" as const,
      };
      const recentFlow = {
        ...candidate,
        key: "holder_research:v1:recent_flow:test:YES",
        bucket: "recent_flow" as const,
        score: candidate.score + 200,
        side: "YES" as const,
        direction: "up" as const,
      };
      const mixed = {
        ...candidate,
        key: "holder_research:v1:sharp_side:test:mixed",
        bucket: "sharp_side" as const,
        side: null,
        direction: "mixed" as const,
      };

      const selected = selectHolderResearchTriageFallbackCandidates(
        [recentFlow, followup, mixed, candidate],
        2,
      );
      assert.deepEqual(
        selected.map((item) => item.bucket),
        ["sharp_minority", "followup_existing"],
      );

      const excludedOnly = selectHolderResearchTriageFallbackCandidates(
        [recentFlow],
        1,
      );
      assert.equal(excludedOnly[0]?.bucket, "recent_flow");
      assert.equal(
        selectHolderResearchTriageFallbackCandidates([mixed], 1).length,
        0,
      );
    },
  },
  {
    name: "holder research signal schemas accept wallet scope and batch wallet notes",
    run: () => {
      const query = signalsQuerySchema.parse({
        scope: "wallet",
        targetId: "00000000-0000-4000-8000-000000000001",
        includeTraders: "true",
        traderLimit: "2",
      });
      assert.equal(query.scope, "wallet");
      assert.equal(query.includeTraders, true);
      assert.equal(query.traderLimit, 2);

      const body = holderResearchWalletNotesBodySchema.parse({
        walletIds: ["00000000-0000-4000-8000-000000000001"],
        limitPerWallet: 0,
        compact: "true",
      });
      assert.deepEqual(body.walletIds, [
        "00000000-0000-4000-8000-000000000001",
      ]);
      assert.equal(body.limitPerWallet, 0);
      assert.equal(body.compact, true);
    },
  },
  {
    name: "deterministic decision emits strict holder research json",
    run: () => {
      const p = policy();
      const candidate = buildHolderResearchCandidatesFromMarket(
        market(),
        p,
      ).find((item) => item.bucket === "sharp_minority");
      assert.ok(candidate);
      const decision = buildDeterministicHolderResearchDecision(candidate, p);
      const parsed = holderResearchAgentOutputV1Schema.parse(decision);
      assert.equal(parsed.version, "holder_research_v1");
      assert.equal(parsed.status, "PUBLISH");
      assert.equal(parsed.evidence_ids.length > 0, true);
    },
  },
  {
    name: "model output parser repairs minor strict-json drift",
    run: () => {
      const parsed = parseHolderResearchAgentOutputV1({
        version: "holder_research_v1",
        status: "CONTEXT",
        bucket: "sharp_side",
        confidence: 0.7,
        signal_type: "update",
        direction: "mixed",
        headline: "Sharp holder context",
        summary:
          "A sharp holder signal exists, but this test intentionally keeps the body compact.",
        rationale: "x".repeat(600),
        evidence_ids: ["market:1"],
        caveats:
          "No public context found; this may be private information or noise.",
        extra: "ignored",
      });
      assert.equal(parsed.rationale.length <= 260, true);
      assert.deepEqual(parsed.caveats, [
        "No public context found; this may be private information or noise.",
      ]);
    },
  },
  {
    name: "resolved evaluator writes outcome metadata for closed holder notes",
    run: async () => {
      const p = policy();
      const updates: Array<Record<string, unknown>> = [];
      let selectSql = "";
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          if (/select\s+n\.id\s+as\s+note_id/i.test(sql)) {
            selectSql = sql;
            return {
              rows: [
                {
                  note_id: "00000000-0000-4000-8000-000000000081",
                  direction: "down",
                  confidence: 0.74,
                  created_at: new Date("2026-01-01T00:00:00.000Z"),
                  metrics: {
                    market: { yesProbability: 0.52 },
                  },
                  model_meta: {
                    primary_holder_credentials: {
                      mode: "single_holder",
                      primaryHolder: {
                        positionUsd: 32_000,
                        pnl30dUsd: 120_000,
                        openPnlUsd: 1_000,
                      },
                    },
                  },
                  market_id: "polymarket:resolved",
                  market_title: "Mexico",
                  event_title: "World Cup: Czechia vs. Mexico",
                  category: "Sports",
                  close_time: new Date("2026-01-01T03:00:00.000Z"),
                  expiration_time: null,
                  best_bid: 0.999,
                  best_ask: 1,
                  last_price: 1,
                  resolved_outcome: "YES",
                  resolved_outcome_pct: null,
                  accepting_orders: false,
                },
              ],
            };
          }
          if (/update\s+ai_notes/i.test(sql)) {
            updates.push(
              JSON.parse(String(params?.[1])) as Record<string, unknown>,
            );
            return { rows: [] };
          }
          return { rows: [] };
        },
      } as unknown as import("pg").PoolClient;

      const stats = await evaluateResolvedHolderResearchNotes(db, p);
      assert.equal(stats.considered, 1);
      assert.equal(stats.evaluated, 1);
      assert.equal(stats.wrong, 1);
      assert.match(selectSql, /not \(coalesce\(n\.metrics/i);
      assert.match(selectSql, /resolvedEvaluation,outcome/i);
      assert.equal(updates[0]?.outcome, "wrong");
      assert.equal(updates[0]?.marketType, "single_game_sports");
      assert.equal(updates[0]?.marketSegment, "sports_soccer_game");
      assert.equal(updates[0]?.sideAdjustedPriceDelta, -0.48);
    },
  },
  {
    name: "resolved evaluator skips unchanged evaluation writes",
    run: async () => {
      const p = policy();
      let updateCount = 0;
      const db = {
        query: async (sql: string) => {
          if (/select\s+n\.id\s+as\s+note_id/i.test(sql)) {
            return {
              rows: [
                {
                  note_id: "00000000-0000-4000-8000-000000000082",
                  direction: "down",
                  confidence: 0.74,
                  created_at: new Date("2026-01-01T00:00:00.000Z"),
                  metrics: {
                    market: { yesProbability: 0.52 },
                    resolvedEvaluation: {
                      version: 1,
                      evaluatedAt: "2026-01-02T00:00:00.000Z",
                      outcome: "wrong",
                      signalSide: "NO",
                      direction: "down",
                      confidence: 0.74,
                      marketId: "polymarket:resolved",
                      marketSegment: "sports_soccer_game",
                      marketType: "single_game_sports",
                      hoursToCloseAtNote: 3,
                      noteYesProbability: 0.52,
                      finalYesProbability: 1,
                      priceDelta: 0.48,
                      sideAdjustedPriceDelta: -0.48,
                      resolvedOutcome: "YES",
                      resolvedOutcomePct: null,
                      acceptingOrders: false,
                      actorMode: "single_holder",
                      primaryHolderPositionUsd: 32_000,
                      primaryHolderPnl30dUsd: 120_000,
                      primaryHolderOpenPnlUsd: 1_000,
                    },
                  },
                  model_meta: {
                    primary_holder_credentials: {
                      mode: "single_holder",
                      primaryHolder: {
                        positionUsd: 32_000,
                        pnl30dUsd: 120_000,
                        openPnlUsd: 1_000,
                      },
                    },
                  },
                  market_id: "polymarket:resolved",
                  market_title: "Mexico",
                  event_title: "World Cup: Czechia vs. Mexico",
                  category: "Sports",
                  close_time: new Date("2026-01-01T03:00:00.000Z"),
                  expiration_time: null,
                  best_bid: 0.999,
                  best_ask: 1,
                  last_price: 1,
                  resolved_outcome: "YES",
                  resolved_outcome_pct: null,
                  accepting_orders: false,
                },
              ],
            };
          }
          if (/update\s+ai_notes/i.test(sql)) {
            updateCount += 1;
            return { rows: [], rowCount: 1 };
          }
          return { rows: [] };
        },
      } as unknown as import("pg").PoolClient;

      const stats = await evaluateResolvedHolderResearchNotes(db, p);
      assert.equal(stats.considered, 1);
      assert.equal(stats.evaluated, 0);
      assert.equal(stats.wrong, 1);
      assert.equal(updateCount, 0);
    },
  },
  {
    name: "resolved evaluator does not infer outcome from non-terminal closed price",
    run: async () => {
      const p = policy();
      const updates: Array<Record<string, unknown>> = [];
      const db = {
        query: async (sql: string, params?: unknown[]) => {
          if (/select\s+n\.id\s+as\s+note_id/i.test(sql)) {
            return {
              rows: [
                {
                  note_id: "00000000-0000-4000-8000-000000000083",
                  direction: "up",
                  confidence: 0.74,
                  created_at: new Date("2026-01-01T00:00:00.000Z"),
                  metrics: {
                    market: { yesProbability: 0.48 },
                  },
                  model_meta: {
                    primary_holder_credentials: {
                      mode: "single_holder",
                      primaryHolder: {
                        positionUsd: 32_000,
                        pnl30dUsd: 120_000,
                        openPnlUsd: 1_000,
                      },
                    },
                  },
                  market_id: "polymarket:closed-without-resolution",
                  market_title: "Closed without resolution",
                  event_title: "Closed event",
                  category: "Sports",
                  close_time: new Date("2026-01-01T03:00:00.000Z"),
                  expiration_time: null,
                  best_bid: 0.58,
                  best_ask: 0.62,
                  last_price: 0.6,
                  resolved_outcome: null,
                  resolved_outcome_pct: null,
                  accepting_orders: false,
                },
              ],
            };
          }
          if (/update\s+ai_notes/i.test(sql)) {
            updates.push(
              JSON.parse(String(params?.[1])) as Record<string, unknown>,
            );
            return { rows: [], rowCount: 1 };
          }
          return { rows: [] };
        },
      } as unknown as import("pg").PoolClient;

      const stats = await evaluateResolvedHolderResearchNotes(db, p);
      assert.equal(stats.considered, 1);
      assert.equal(stats.evaluated, 1);
      assert.equal(stats.unknown, 1);
      assert.equal(updates[0]?.outcome, "unknown");
      assert.equal(updates[0]?.finalYesProbability, null);
      assert.equal(updates[0]?.sideAdjustedPriceDelta, null);
    },
  },
  {
    name: "holder research policy is a separate runtime policy with external search budget",
    run: async () => {
      assert.equal(
        getIntelPolicyDefaults("holder_research").model,
        "openai/gpt-5.5",
      );

      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000099",
              policy_key: "holder_research",
              effective_at: new Date("2026-01-02T00:00:00.000Z"),
              payload: {
                enabled: true,
                dryRun: "false",
                externalSearchEnabled: "true",
                maxExternalSearchCallsPerRun: 5,
                forceExternalSearchForInvestigations: "false",
                externalSearchMinScore: 0.8,
                triageEnabled: "true",
                triageModel: "openai/gpt-5.4",
                triageBatchSize: 12,
                triageMaxBatchesPerRun: 3,
                triageMaxOutputTokens: 900,
                movementContextEnabled: "false",
                holderEntryContextEnabled: "false",
                promptHoldersLimit: 3,
                promptFormat: "compact_json",
                minTriageInvestigatePriority: 0.7,
                qualityGateEnabled: "true",
                resolvedEvaluationEnabled: "true",
                resolvedEvaluationLookbackHours: 72,
                performanceAuditEnabled: "true",
                performanceAuditLookbackHours: 96,
                performanceAuditMaxNotesPerRun: 250,
                performanceAuditIncludeOpen: "true",
                performanceAuditApproxEntryBeforeHours: 12,
                performanceAuditApproxEntryAfterHours: 1,
                performanceCalibrationMinSamples: 10,
                performanceCalibrationMinResolvedSamples: 12,
                performanceCalibrationMinPatternSamples: 4,
                performanceCalibrationMaxNearTradeMinutes: 90,
                performanceCalibrationUseOpenNotes: "true",
                performanceCalibrationMinOpenAgeHours: 36,
                performanceCalibrationMinOpenMovePp: 0.08,
                performanceCalibrationDedupMarketSide: "false",
                calibrationMemoEnabled: "false",
                preTriageActionabilityEnabled: "false",
                supportOnlyBuckets: ["recent_flow", "event_bridge"],
                selectionEventDiversityEnabled: "false",
                selectionEventSoftCapPerEvent: 4,
                selectionExpiryBoostEnabled: "false",
                selectionExpirySoonHours: 24,
                selectionExpiryNearHours: 96,
                selectionExpiryFarHours: 240,
                selectionExpiryBoostMax: 0.04,
                singleGameSportsStrictMode: "true",
                singleGameSportsMinHolderUsd: 30_000,
                singleGameSportsMinEdge: 0.2,
                singleGameSportsMinSamples: 30,
                singleGameSportsMinWinRate: 0.7,
                singleGameSportsRequirePositivePnl: "false",
                priceAgainstSignalBlockPp: 0.08,
                maxAgentCallsPerRun: 100,
                estimatedTriageCallCostUsd: 0.02,
                maxOutputTokens: 1,
              },
              created_by: null,
              created_at: new Date("2026-01-02T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "holder_research");
      assert.equal(resolved.source, "db");
      assert.equal(resolved.effective.enabled, true);
      assert.equal(resolved.effective.dryRun, false);
      assert.equal(resolved.defaults.maxOutputTokens, 2_000);
      assert.equal(resolved.defaults.estimatedCallCostUsd, 0.08);
      assert.equal(resolved.defaults.estimatedTriageCallCostUsd, 0.01);
      assert.equal(resolved.defaults.model, "openai/gpt-5.5");
      assert.equal(resolved.defaults.triageModel, "openai/gpt-5.4-mini");
      assert.equal(resolved.effective.externalSearchEnabled, true);
      assert.equal(resolved.effective.maxExternalSearchCallsPerRun, 5);
      assert.equal(
        resolved.defaults.forceExternalSearchForInvestigations,
        true,
      );
      assert.equal(
        resolved.effective.forceExternalSearchForInvestigations,
        false,
      );
      assert.equal(resolved.effective.externalSearchMinScore, 0.8);
      assert.equal(resolved.defaults.triageEnabled, true);
      assert.equal(resolved.defaults.triageBatchSize, 8);
      assert.equal(resolved.defaults.triageMaxOutputTokens, 2_000);
      assert.equal(resolved.effective.triageEnabled, true);
      assert.equal(resolved.effective.triageModel, "openai/gpt-5.4");
      assert.equal(resolved.effective.triageBatchSize, 12);
      assert.equal(resolved.effective.triageMaxBatchesPerRun, 3);
      assert.equal(resolved.effective.triageMaxOutputTokens, 900);
      assert.equal(resolved.effective.movementContextEnabled, false);
      assert.equal(resolved.effective.holderEntryContextEnabled, false);
      assert.equal(resolved.effective.promptHoldersLimit, 3);
      assert.equal(resolved.effective.promptFormat, "compact_json");
      assert.equal(resolved.effective.minTriageInvestigatePriority, 0.7);
      assert.equal(resolved.defaults.qualityGateEnabled, true);
      assert.equal(resolved.defaults.resolvedEvaluationEnabled, true);
      assert.equal(resolved.effective.resolvedEvaluationLookbackHours, 72);
      assert.equal(resolved.effective.performanceAuditEnabled, true);
      assert.equal(resolved.effective.performanceAuditLookbackHours, 96);
      assert.equal(resolved.effective.performanceAuditMaxNotesPerRun, 250);
      assert.equal(resolved.effective.performanceAuditIncludeOpen, true);
      assert.equal(
        resolved.effective.performanceAuditApproxEntryBeforeHours,
        12,
      );
      assert.equal(resolved.effective.performanceAuditApproxEntryAfterHours, 1);
      assert.equal(resolved.effective.performanceCalibrationMinSamples, 10);
      assert.equal(
        resolved.effective.performanceCalibrationMinResolvedSamples,
        12,
      );
      assert.equal(
        resolved.effective.performanceCalibrationMinPatternSamples,
        4,
      );
      assert.equal(
        resolved.effective.performanceCalibrationMaxNearTradeMinutes,
        90,
      );
      assert.equal(
        "performanceCalibrationUseOpenNotes" in resolved.effective,
        false,
      );
      assert.equal(
        "performanceCalibrationMinOpenAgeHours" in resolved.effective,
        false,
      );
      assert.equal(
        "performanceCalibrationMinOpenMovePp" in resolved.effective,
        false,
      );
      assert.equal(
        resolved.effective.performanceCalibrationDedupMarketSide,
        false,
      );
      assert.equal(resolved.effective.calibrationMemoEnabled, false);
      assert.equal(resolved.defaults.preTriageActionabilityEnabled, true);
      assert.deepEqual(resolved.defaults.supportOnlyBuckets, [
        "recent_flow",
        "event_bridge",
        "concentration_risk",
        "clean_disagreement",
      ]);
      assert.equal(resolved.defaults.selectionEventDiversityEnabled, true);
      assert.equal(resolved.defaults.selectionEventSoftCapPerEvent, 2);
      assert.equal(resolved.defaults.selectionExpiryBoostEnabled, true);
      assert.equal(resolved.defaults.selectionExpirySoonHours, 72);
      assert.equal(resolved.defaults.selectionExpiryNearHours, 168);
      assert.equal(resolved.defaults.selectionExpiryFarHours, 720);
      assert.equal(resolved.defaults.selectionExpiryBoostMax, 0.08);
      assert.equal(resolved.defaults.quotaSharpSide, 2);
      assert.equal(resolved.defaults.quotaSharpMinority, 1);
      assert.equal(resolved.defaults.quotaRecentFlow, 0);
      assert.equal(resolved.defaults.quotaEventBridge, 0);
      assert.equal(resolved.effective.preTriageActionabilityEnabled, false);
      assert.deepEqual(resolved.effective.supportOnlyBuckets, [
        "recent_flow",
        "event_bridge",
      ]);
      assert.equal(resolved.effective.selectionEventDiversityEnabled, false);
      assert.equal(resolved.effective.selectionEventSoftCapPerEvent, 4);
      assert.equal(resolved.effective.selectionExpiryBoostEnabled, false);
      assert.equal(resolved.effective.selectionExpirySoonHours, 24);
      assert.equal(resolved.effective.selectionExpiryNearHours, 96);
      assert.equal(resolved.effective.selectionExpiryFarHours, 240);
      assert.equal(resolved.effective.selectionExpiryBoostMax, 0.04);
      assert.equal(resolved.effective.singleGameSportsMinHolderUsd, 30_000);
      assert.equal(resolved.effective.singleGameSportsMinEdge, 0.2);
      assert.equal(resolved.effective.singleGameSportsMinSamples, 30);
      assert.equal(resolved.effective.singleGameSportsMinWinRate, 0.7);
      assert.equal(
        resolved.effective.singleGameSportsRequirePositivePnl,
        false,
      );
      assert.equal(resolved.effective.estimatedTriageCallCostUsd, 0.02);
      assert.equal(resolved.effective.priceAgainstSignalBlockPp, 0.08);
      assert.equal(resolved.effective.maxAgentCallsPerRun, 100);
      assert.equal(resolved.effective.maxOutputTokens, 100);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[holder-research-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[holder-research-tests] passed ${passed}/${tests.length}`);
