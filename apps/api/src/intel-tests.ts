#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { Interface } from "ethers";

import { isRetryableHttpStatus, parseRetryAfterMs } from "@hunch/shared";

import { env } from "./env.js";
import {
  fetchActiveRuntimePolicy,
  listActiveRuntimePolicies,
} from "./repos/runtime-policies.js";
import {
  getIntelPolicyDefaults,
  resolveIntelPolicy,
  resolveSignalWindowHours,
} from "./services/runtime-policies.js";
import {
  evaluateSignalMarketWindow,
  mergeWalletIdsForScope,
} from "./services/wallet-intel-filters.js";
import {
  buildSignalPresentation,
  minPositiveThreshold,
  walletMatchesFilters,
} from "./services/wallet-attribution.js";
import {
  computeApproxLegPnlUsd,
  NET_SHARES_EPSILON,
  resolveApproxYesMarkPrice,
} from "./services/wallet-intel-pnl.js";
import {
  computeWalletLedgerApproxMetricTotals,
  replayWalletPositionLedgerRows,
  resolveApproxOpenEntryFromLedger,
} from "./services/wallet-position-ledger.js";
import { isWalletFinalOutcomeSampleAction } from "./services/wallet-final-outcome-samples.js";
import {
  buildWalletThirtyDayMetricsUpsertRows,
  computeWalletResolvedEdgeMetrics,
} from "./services/wallet-metrics-30d.js";
import {
  applyResolvedTradeStatsToMetrics,
  buildWalletActivitySummaryHeroStats,
  buildWalletAttributionInputMapFromSignalItems,
  buildWalletSignalItemFromSignalRow,
  buildWalletSignalItemFromTopChange,
  buildWalletSummaryItem,
  resolveEntryBracketKey,
  resolveWalletAvgTradeSizeUsd,
  resolveWalletBadges,
  resolveWalletPrimaryLabel,
  resolveWalletSecondaryLabels,
  resolveWalletHeadlineTag,
  resolveWalletTopLabelVariant,
  signalItemToTopChange,
  shouldReturnFilterTooBroad,
} from "./routes/wallet-intel.js";
import { extractProviderCostUsd, resolveAiCost } from "./lib/ai-cost.js";
import {
  getOpenRouterEmbeddingPricingPerM,
  getOpenRouterModelPricingPerM,
} from "./lib/ai-pricing.js";
import {
  DEFAULT_MIN_UNUSUAL_BASELINE_SAMPLES,
  compareWalletActivitySummaryStats,
  computeWalletActivityImportanceScore,
  computeRobustUnusualScore,
  resolveUnusualTier,
  type WalletActivitySummaryStats,
} from "./services/wallet-activity-summary.js";
import { fetchEvmBalance } from "./services/polygon-rpc.js";
import {
  fetchWalletPerformanceSparklines,
  fetchWalletPerformanceSeries,
  resolveSparklineBucketHours,
} from "./services/wallet-intel-series.js";
import {
  fetchMarketHolderData,
  fetchMarketHolderDataBatch,
} from "./services/holders-core.js";
import {
  normalizeOutcomeSideForApi,
  normalizeOutcomeSideForStorage,
  shouldSuppressLegacySideTransitionDelta,
} from "./services/wallet-intel-helpers.js";
import {
  buildInternalHunchFillActivityEvents,
  internalHunchWalletAddressesMatch,
  normalizeInternalHunchWalletAddress,
  selectNewestInternalHunchFillReplayInputs,
  shouldSuppressInternalHunchSnapshotDelta,
} from "./services/wallet-intel-internal-hunch.js";
import {
  MM_HEDGE_RATIO_MIN,
  MM_LARGE_SINGLE_MARKET_HEDGED_USD_MIN,
  MM_MATERIAL_HEDGED_NOTIONAL_USD_MIN,
  MM_MATERIAL_HEDGE_RATIO_MIN,
  MM_TWO_SIDED_MARKETS_MIN,
  buildWalletMmDiagnostics,
  computeMmSuspected,
} from "./services/wallet-intel-mm.js";
import {
  filterPrefetchedPolymarketOwnerBalances,
  prefetchFollowedPolymarketOwnerBalances,
  resolvePolymarketOwnerAddresses,
  resolvePolymarketTrackedTokenUniverse,
} from "./services/positions-sync.js";
import {
  computeProfileSideBias,
  mapWhaleMarketToProfileMarket,
  normalizeWhaleProfile,
  parseProfileJson,
  sortTrackerSurfaceSummaryStats,
  summarizeProfileMarkets,
} from "./services/whale-profiles.js";
import { fetchSolanaBalanceLamports } from "./services/solana-rpc.js";
import {
  walletActivitySignalsQuerySchema,
  walletActivitySummaryQuerySchema,
  walletPositionHistoryQuerySchema,
  walletPositionsQuerySchema,
  walletSeriesQuerySchema,
  walletWhalesQuerySchema,
} from "./schemas/wallet-intel.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const testErc1155Iface = new Interface([
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
]);
const testAttributionPolicy = getIntelPolicyDefaults(
  "wallet_intel_attribution",
);

function createWalletActivitySummaryStats(
  overrides: Partial<WalletActivitySummaryStats> = {},
): WalletActivitySummaryStats {
  return {
    walletId: "00000000-0000-0000-0000-000000000001",
    windowHours: 24,
    lastActivityAt: new Date("2026-06-08T12:00:00.000Z"),
    netChangeUsd: 0,
    netChangeYesUsd: 0,
    netChangeNoUsd: 0,
    countsNew: 0,
    countsExit: 0,
    countsIncrease: 0,
    countsReduce: 0,
    countsFlip: 0,
    unusualScore: null,
    unusualTier: null,
    metricsPnl30d: null,
    metricsRoi30d: null,
    metricsTrades30d: null,
    metricsVolume30d: null,
    metricsWinRate30d: null,
    metricsResolvedEdgeSampleCount30d: null,
    metricsResolvedWinRateEdge30d: null,
    metricsResolvedEdgeZScore30d: null,
    metricsResolvedStakeUsd30d: null,
    ...overrides,
  };
}

function createTestCandidateWalletRow(
  overrides: Partial<Parameters<typeof buildWalletSummaryItem>[0]> = {},
): Parameters<typeof buildWalletSummaryItem>[0] {
  return {
    id: "wallet-1",
    address: "0x0000000000000000000000000000000000000001",
    chain: "polygon",
    label: "Alpha",
    is_system_flagged: false,
    first_seen_at: new Date("2026-01-01T00:00:00.000Z"),
    last_seen_at: new Date("2026-01-02T00:00:00.000Z"),
    profile: null,
    profile_updated_at: null,
    user_name: "alpha",
    user_label: "watch",
    user_label_color: "gold",
    tags: [
      {
        slug: "whale",
        label: "Whale",
        tag_type: "performance",
        is_system: true,
      },
    ],
    metrics: {
      period: "30d",
      as_of: new Date("2026-01-02T00:00:00.000Z"),
      trades_count: 4,
      volume_usd: "1000",
      pnl_usd: "125",
      roi: "0.125",
      win_rate: "0.75",
      avg_hold_hours: "12",
      last_trade_at: new Date("2026-01-02T00:00:00.000Z"),
    },
    ...overrides,
  };
}

function createTestSummaryStats(
  overrides: Partial<Parameters<typeof buildWalletSummaryItem>[1]> = {},
): Parameters<typeof buildWalletSummaryItem>[1] {
  return {
    walletId: "wallet-1",
    windowHours: 24,
    lastActivityAt: new Date("2026-01-02T12:00:00.000Z"),
    netChangeUsd: 150,
    netChangeYesUsd: 120,
    netChangeNoUsd: 30,
    countsNew: 1,
    countsExit: 0,
    countsIncrease: 2,
    countsReduce: 1,
    countsFlip: 0,
    unusualScore: 0.8,
    unusualTier: "very_unusual",
    ...overrides,
  } as Parameters<typeof buildWalletSummaryItem>[1];
}

function createTestSignalRow(
  overrides: Partial<
    Parameters<typeof buildWalletSignalItemFromSignalRow>[0]["signalRow"]
  > = {},
): Parameters<typeof buildWalletSignalItemFromSignalRow>[0]["signalRow"] {
  return {
    walletId: "wallet-1",
    marketId: "market-1",
    marketTitle: "Market",
    outcomes: null,
    marketImage: null,
    marketIcon: null,
    eventId: "event-1",
    eventTitle: "Event",
    eventImage: null,
    eventIcon: null,
    venue: "polymarket",
    marketStatus: "ACTIVE",
    closeTime: new Date("2026-01-03T00:00:00.000Z"),
    expirationTime: null,
    resolvedOutcome: null,
    acceptingOrders: true,
    category: "crypto",
    action: "OPENED",
    positionSide: "YES",
    deltaShares: 25,
    deltaUsd: 15,
    stakeUsd: 15,
    odds: 0.2,
    potentialPayoutUsd: 75,
    idleDays: 12,
    priorDistinctMarkets: 1,
    signalScore: 0.92,
    signalType: "longshot_large_late",
    lateBucket: "late",
    occurredAt: new Date("2026-01-02T12:00:00.000Z"),
    reasonCodes: ["late_entry", "longshot_odds"],
    ...overrides,
  };
}

const tests: TestCase[] = [
  {
    name: "ai cost extractor supports OpenRouter usage.cost",
    run: () => {
      const payload = {
        usage: {
          prompt_tokens: 15,
          completion_tokens: 9,
          cost: 0.00015225,
        },
      };
      const provider = extractProviderCostUsd(payload);
      assert.equal(provider.providerCostUsd, 0.00015225);
      assert.equal(provider.providerCostField, "cost");
      assert.equal(provider.providerCostUsdTicks, null);

      const resolved = resolveAiCost({
        inputTokens: 15,
        outputTokens: 9,
        priceInputPerM: 1.75,
        priceOutputPerM: 14,
        providerCostUsd: provider.providerCostUsd,
        providerCostField: provider.providerCostField,
      });
      assert.equal(resolved.costSource, "provider_reported");
      assert.equal(Number(resolved.chargedCostUsd.toFixed(8)), 0.00015225);
    },
  },
  {
    name: "ai cost extractor supports usage.cost_in_usd_ticks",
    run: () => {
      const payload = {
        usage: {
          prompt_tokens: 16,
          completion_tokens: 64,
          cost_in_usd_ticks: 264000,
        },
      };
      const provider = extractProviderCostUsd(payload);
      assert.equal(provider.providerCostUsdTicks, 264000);
      assert.equal(
        Number((provider.providerCostUsd ?? 0).toFixed(10)),
        0.0000264,
      );
    },
  },
  {
    name: "openrouter pricing table exposes verified defaults",
    run: () => {
      const gpt52 = getOpenRouterModelPricingPerM("openai/gpt-5.2");
      const gpt5nano = getOpenRouterModelPricingPerM("openai/gpt-5-nano");
      const gpt54 = getOpenRouterModelPricingPerM("openai/gpt-5.4");
      const gpt54mini = getOpenRouterModelPricingPerM("openai/gpt-5.4-mini");
      const gpt54nano = getOpenRouterModelPricingPerM("openai/gpt-5.4-nano");
      const gpt55 = getOpenRouterModelPricingPerM("openai/gpt-5.5");
      const embed = getOpenRouterEmbeddingPricingPerM(
        "openai/text-embedding-3-small",
      );
      assert.equal(gpt52?.inputPerM, 1.75);
      assert.equal(gpt52?.outputPerM, 14);
      assert.equal(gpt5nano?.inputPerM, 0.05);
      assert.equal(gpt5nano?.outputPerM, 0.4);
      assert.equal(gpt54?.inputPerM, 2.5);
      assert.equal(gpt54?.outputPerM, 15);
      assert.equal(gpt54mini?.inputPerM, 0.75);
      assert.equal(gpt54mini?.outputPerM, 4.5);
      assert.equal(gpt54nano?.inputPerM, 0.2);
      assert.equal(gpt54nano?.outputPerM, 1.25);
      assert.equal(gpt55?.inputPerM, 5);
      assert.equal(gpt55?.outputPerM, 30);
      assert.equal(embed?.inputPerM, 0.02);
      assert.equal(embed?.outputPerM, 0);
    },
  },
  {
    name: "runtime policy reads fall back when migration table is missing",
    run: async () => {
      const missingTableDb = {
        query: async () => {
          const error = new Error("relation does not exist") as Error & {
            code?: string;
          };
          error.code = "42P01";
          throw error;
        },
      } as import("./db.js").DbQuery;

      const row = await fetchActiveRuntimePolicy(
        missingTableDb,
        "wallet_intel_signals",
      );
      const rows = await listActiveRuntimePolicies(missingTableDb);

      assert.equal(row, null);
      assert.deepEqual(rows, []);
    },
  },
  {
    name: "runtime policy sanitizer ignores deprecated override fields",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000001",
              policy_key: "arbitrage_defaults",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                limit: 30,
                minVenueCount: 3,
                minSpread: 0.07,
                minQualityScore: 0.7,
                minAnalysisConfidence: 0.8, // deprecated key
                maxOutlierRatio: 0.2, // deprecated key
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "arbitrage_defaults");
      assert.equal(resolved.source, "db");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.effective.limit, 30);
      assert.equal(resolved.effective.minVenueCount, 3);
      assert.equal(resolved.effective.minSpread, 0.07);
      assert.equal(resolved.effective.minQualityScore, 0.7);
      assert.equal(
        "minAnalysisConfidence" in
          (resolved.effective as Record<string, unknown>),
        false,
      );
      assert.equal(
        "maxOutlierRatio" in (resolved.effective as Record<string, unknown>),
        false,
      );
    },
  },
  {
    name: "wallet intel refresh policy exposes internal hunch controls",
    run: async () => {
      const defaults = getIntelPolicyDefaults("wallet_intel_refresh");
      assert.equal(defaults.internalHunchEnabled, true);
      assert.equal(defaults.internalHunchWalletLimit, 250);
      assert.equal(defaults.internalHunchFillLookbackDays, 30);
      assert.equal(defaults.internalHunchFillLimit, 5_000);

      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000002",
              policy_key: "wallet_intel_refresh",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                internalHunchEnabled: "false",
                internalHunchWalletLimit: 0,
                internalHunchFillLookbackDays: 7,
                internalHunchFillLimit: 100,
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "wallet_intel_refresh");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.effective.internalHunchEnabled, false);
      assert.equal(resolved.effective.internalHunchWalletLimit, 0);
      assert.equal(resolved.effective.internalHunchFillLookbackDays, 7);
      assert.equal(resolved.effective.internalHunchFillLimit, 100);
    },
  },
  {
    name: "ai whale profile policy defaults tracker sort to importance and supports rollback",
    run: async () => {
      const defaults = getIntelPolicyDefaults("ai_whale_profiles");
      assert.equal(defaults.selectionMode, "hybrid");
      assert.equal(defaults.selectionTrackerSort, "importance");

      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000003",
              policy_key: "ai_whale_profiles",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                selectionTrackerSort: "last_activity",
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "ai_whale_profiles");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.effective.selectionMode, "hybrid");
      assert.equal(resolved.effective.selectionTrackerSort, "last_activity");
    },
  },
  {
    name: "signal window hours resolve uses policy default and max clamp",
    run: () => {
      const policy = {
        windowHoursDefault: 36,
        windowHoursMax: 48,
      };

      assert.equal(resolveSignalWindowHours(undefined, policy), 36);
      assert.equal(resolveSignalWindowHours(12, policy), 12);
      assert.equal(resolveSignalWindowHours(200, policy), 48);
      assert.equal(
        resolveSignalWindowHours(24, {
          windowHoursDefault: 72,
          windowHoursMax: 24,
        }),
        24,
      );
    },
  },
  {
    name: "sparkline bucket resolver keeps point counts bounded with simple buckets",
    run: () => {
      assert.equal(resolveSparklineBucketHours(24), 1);
      assert.equal(resolveSparklineBucketHours(48), 2);
      assert.equal(resolveSparklineBucketHours(96), 4);
      assert.equal(resolveSparklineBucketHours(168), 6);
      assert.equal(resolveSparklineBucketHours(336), 12);
      assert.equal(resolveSparklineBucketHours(720), 24);
      assert.equal(resolveSparklineBucketHours(168, 3), 3);
      assert.equal(resolveSparklineBucketHours(24, 72), 24);
    },
  },
  {
    name: "headline tag prefers specialist labels and stable priority",
    run: () => {
      const specialistHeadline = resolveWalletHeadlineTag({
        primary: "specialist",
        primaryCandidates: [],
        secondary: ["crypto_specialist", "high_conviction"],
        supporting: ["volume_trader"],
        display: {
          listPrimary: [],
          listSecondary: [],
          detailsSecondary: [],
          detailsSupporting: [],
        },
        reasons: [],
        version: "v1",
      });
      assert.deepEqual(specialistHeadline, {
        key: "crypto_specialist",
        label: "Crypto Specialist",
        source: "secondary",
      });

      const priorityHeadline = resolveWalletHeadlineTag({
        primary: null,
        primaryCandidates: [],
        secondary: [],
        supporting: ["market_mover", "high_frequency"],
        display: {
          listPrimary: [],
          listSecondary: [],
          detailsSecondary: [],
          detailsSupporting: [],
        },
        reasons: [],
        version: "v1",
      });
      assert.deepEqual(priorityHeadline, {
        key: "market_mover",
        label: "Market Mover",
        source: "supporting",
      });

      const mentionsHeadline = resolveWalletHeadlineTag({
        primary: "specialist",
        primaryCandidates: [],
        secondary: ["mentions_specialist", "high_frequency"],
        supporting: ["high_conviction"],
        display: {
          listPrimary: [],
          listSecondary: [],
          detailsSecondary: [],
          detailsSupporting: [],
        },
        reasons: [],
        version: "v1",
      });
      assert.deepEqual(mentionsHeadline, {
        key: "mentions_specialist",
        label: "Mentions Specialist",
        source: "secondary",
      });
    },
  },
  {
    name: "presentation labels split primary and secondary semantics cleanly",
    run: () => {
      const specialistPrimary = resolveWalletPrimaryLabel({
        primary: "specialist",
        primaryCandidates: [],
        secondary: ["sports_specialist", "market_mover", "high_conviction"],
        supporting: ["high_win_rate"],
        display: {
          listPrimary: [],
          listSecondary: [],
          detailsSecondary: [],
          detailsSupporting: [],
        },
        reasons: [],
        version: "v1",
      });
      assert.deepEqual(specialistPrimary, {
        key: "sports_specialist",
        label: "Sports Specialist",
      });

      const insiderPrimary = resolveWalletPrimaryLabel({
        primary: "insider",
        primaryCandidates: [],
        secondary: [],
        supporting: [],
        display: {
          listPrimary: [],
          listSecondary: [],
          detailsSecondary: [],
          detailsSupporting: [],
        },
        reasons: [],
        version: "v1",
      });
      assert.deepEqual(insiderPrimary, {
        key: "potential_insider",
        label: "Potential Insider",
      });

      const mentionsPrimary = resolveWalletPrimaryLabel({
        primary: "specialist",
        primaryCandidates: [],
        secondary: ["mentions_specialist", "market_mover"],
        supporting: [],
        display: {
          listPrimary: [],
          listSecondary: [],
          detailsSecondary: [],
          detailsSupporting: [],
        },
        reasons: [],
        version: "v1",
      });
      assert.deepEqual(mentionsPrimary, {
        key: "mentions_specialist",
        label: "Mentions Specialist",
      });

      const whaleSpecialistPrimary = resolveWalletPrimaryLabel({
        primary: "whale",
        primaryCandidates: [
          { key: "specialist", score: 1 },
          { key: "whale", score: 1 },
        ],
        secondary: ["macro_specialist", "high_conviction", "market_mover"],
        supporting: ["unusual_behavior"],
        display: {
          listPrimary: ["whale"],
          listSecondary: ["macro_specialist", "high_conviction"],
          detailsSecondary: [
            "macro_specialist",
            "high_conviction",
            "market_mover",
          ],
          detailsSupporting: ["unusual_behavior"],
        },
        reasons: ["specialist:polymarket:macro", "whale_tag"],
        version: "v1",
      });
      assert.deepEqual(whaleSpecialistPrimary, {
        key: "macro_specialist",
        label: "Macro Specialist",
      });

      const secondary = resolveWalletSecondaryLabels(
        {
          primary: "specialist",
          primaryCandidates: [],
          secondary: [
            "market_mover",
            "high_conviction",
            "high_win_rate",
            "sports_specialist",
          ],
          supporting: ["consistent_performer", "late_entry"],
          display: {
            listPrimary: [],
            listSecondary: [],
            detailsSecondary: [],
            detailsSupporting: [],
          },
          reasons: [],
          version: "v1",
        },
        2,
      );
      assert.deepEqual(secondary, [
        { key: "market_mover", label: "Market Mover" },
        { key: "high_conviction", label: "High Conviction" },
      ]);
    },
  },
  {
    name: "presentation badges and average trade size derive from existing intel signals",
    run: () => {
      const badges = resolveWalletBadges({
        attribution: {
          primary: "specialist",
          primaryCandidates: [],
          secondary: ["high_win_rate"],
          supporting: ["consistent_performer"],
          display: {
            listPrimary: [],
            listSecondary: [],
            detailsSecondary: [],
            detailsSupporting: [],
          },
          reasons: [],
          version: "v1",
        },
        tags: [
          {
            slug: "whale",
            label: "Whale",
            tag_type: "system",
            is_system: true,
          },
        ],
        unusualTier: "very_unusual",
        metrics: { pnl_usd: "2500", roi: "0.18" },
        lastActivityAt: new Date("2026-03-10T00:00:00.000Z"),
      });
      assert.deepEqual(badges, [
        { key: "whale", label: "Whale" },
        { key: "unusual_activity", label: "Unusual" },
        { key: "hot_streak", label: "Hot Streak" },
      ]);

      assert.equal(
        resolveWalletAvgTradeSizeUsd({
          period: "30d",
          as_of: new Date("2026-03-10T00:00:00.000Z"),
          trades_count: 4,
          volume_usd: "1200",
          pnl_usd: "100",
          roi: "0.1",
          win_rate: "0.5",
          avg_hold_hours: null,
          last_trade_at: null,
        }),
        300,
      );
      assert.equal(
        resolveWalletAvgTradeSizeUsd({
          period: "30d",
          as_of: new Date("2026-03-10T00:00:00.000Z"),
          trades_count: 0,
          volume_usd: "1200",
          pnl_usd: "100",
          roi: "0.1",
          win_rate: "0.5",
          avg_hold_hours: null,
          last_trade_at: null,
        }),
        null,
      );
    },
  },
  {
    name: "activity summary hero stats aggregate union counts and 30d deltas",
    run: () => {
      const stats = buildWalletActivitySummaryHeroStats({
        walletIds: ["wallet-1", "wallet-2", "wallet-3", "wallet-1"],
        followedWalletIds: ["wallet-2", "wallet-3", "wallet-3"],
        portfolioPerformanceMap: new Map([
          [
            "wallet-1",
            {
              rangeHours: 720,
              startAsOf: new Date("2026-03-01T00:00:00.000Z"),
              endAsOf: new Date("2026-03-15T12:00:00.000Z"),
              startPnlUsd: 100,
              endPnlUsd: 160,
              pnlUsd: 60,
              baselineApprox: false,
            },
          ],
          [
            "wallet-2",
            {
              rangeHours: 720,
              startAsOf: new Date("2026-03-01T00:00:00.000Z"),
              endAsOf: new Date("2026-03-15T14:00:00.000Z"),
              startPnlUsd: 0,
              endPnlUsd: 50,
              pnlUsd: 50,
              baselineApprox: false,
            },
          ],
          [
            "wallet-3",
            {
              rangeHours: 720,
              startAsOf: null,
              endAsOf: null,
              startPnlUsd: null,
              endPnlUsd: null,
              pnlUsd: null,
              baselineApprox: false,
            },
          ],
        ]),
        asOfFallback: new Date("2026-03-15T18:00:00.000Z"),
      });

      assert.deepEqual(stats, {
        totalWallets: 3,
        trackedWallets: 2,
        totalPnl30d: 110,
        trackedPnl30d: 50,
        asOf: new Date("2026-03-15T14:00:00.000Z"),
      });
    },
  },
  {
    name: "activity summary importance sort balances magnitude, unusual activity, and recency",
    run: () => {
      const now = Date.now();
      const hoursAgo = (hours: number) =>
        new Date(now - hours * 60 * 60 * 1000);
      const sortIds = (rows: WalletActivitySummaryStats[]) =>
        [...rows]
          .sort((left, right) =>
            compareWalletActivitySummaryStats(left, right, "importance"),
          )
          .map((row) => row.walletId);

      assert.deepEqual(
        sortIds([
          createWalletActivitySummaryStats({
            walletId: "tiny-newest",
            lastActivityAt: hoursAgo(0.05),
            netChangeUsd: 100,
            countsNew: 1,
          }),
          createWalletActivitySummaryStats({
            walletId: "large-older",
            lastActivityAt: hoursAgo(8),
            netChangeUsd: 125_000,
            countsNew: 1,
          }),
        ]),
        ["large-older", "tiny-newest"],
      );

      assert.deepEqual(
        sortIds([
          createWalletActivitySummaryStats({
            walletId: "normal-medium",
            lastActivityAt: hoursAgo(2),
            netChangeUsd: 10_000,
            countsNew: 1,
          }),
          createWalletActivitySummaryStats({
            walletId: "unusual-medium",
            lastActivityAt: hoursAgo(2),
            netChangeUsd: 10_000,
            countsNew: 1,
            unusualScore: 2.5,
          }),
        ]),
        ["unusual-medium", "normal-medium"],
      );

      assert.deepEqual(
        sortIds([
          createWalletActivitySummaryStats({
            walletId: "older-close",
            lastActivityAt: hoursAgo(6),
            netChangeUsd: 15_000,
            countsIncrease: 2,
          }),
          createWalletActivitySummaryStats({
            walletId: "newer-close",
            lastActivityAt: hoursAgo(1),
            netChangeUsd: 15_000,
            countsIncrease: 2,
          }),
        ]),
        ["newer-close", "older-close"],
      );

      assert.deepEqual(
        sortIds([
          createWalletActivitySummaryStats({
            walletId: "00000000-0000-0000-0000-000000000002",
            lastActivityAt: hoursAgo(3),
            netChangeUsd: 20_000,
            countsReduce: 1,
          }),
          createWalletActivitySummaryStats({
            walletId: "00000000-0000-0000-0000-000000000001",
            lastActivityAt: hoursAgo(3),
            netChangeUsd: 20_000,
            countsReduce: 1,
          }),
        ]),
        [
          "00000000-0000-0000-0000-000000000001",
          "00000000-0000-0000-0000-000000000002",
        ],
      );

      const fixedNow = new Date("2026-06-08T12:00:00.000Z").getTime();
      const lowScore = computeWalletActivityImportanceScore(
        createWalletActivitySummaryStats({
          lastActivityAt: new Date("2026-06-08T11:00:00.000Z"),
          netChangeUsd: 100,
        }),
        fixedNow,
      );
      const highScore = computeWalletActivityImportanceScore(
        createWalletActivitySummaryStats({
          lastActivityAt: new Date("2026-06-08T11:00:00.000Z"),
          netChangeUsd: 250_000,
          unusualScore: 3,
          countsNew: 4,
          countsIncrease: 4,
        }),
        fixedNow,
      );
      assert.ok(lowScore >= 0 && lowScore <= 1);
      assert.ok(highScore >= 0 && highScore <= 1);
      assert.ok(highScore > lowScore);
    },
  },
  {
    name: "activity summary importance uses proven tracker metrics without tiny sample noise",
    run: () => {
      const fixedNow = new Date("2026-06-08T12:00:00.000Z").getTime();
      const base = createWalletActivitySummaryStats({
        lastActivityAt: new Date("2026-06-08T11:00:00.000Z"),
        netChangeUsd: 10_000,
        countsIncrease: 1,
      });
      const profitable = createWalletActivitySummaryStats({
        ...base,
        walletId: "profitable",
        metricsPnl30d: 250_000,
      });

      assert.ok(
        computeWalletActivityImportanceScore(profitable, fixedNow) >
          computeWalletActivityImportanceScore(base, fixedNow),
      );

      const tinyRoi = createWalletActivitySummaryStats({
        ...base,
        walletId: "tiny-roi",
        metricsRoi30d: 5,
        metricsTrades30d: 1,
        metricsVolume30d: 100,
      });
      assert.equal(
        computeWalletActivityImportanceScore(tinyRoi, fixedNow),
        computeWalletActivityImportanceScore(base, fixedNow),
      );

      const tinyWinRate = createWalletActivitySummaryStats({
        ...base,
        walletId: "tiny-win-rate",
        metricsWinRate30d: 1,
        metricsResolvedEdgeSampleCount30d: 3,
      });
      assert.equal(
        computeWalletActivityImportanceScore(tinyWinRate, fixedNow),
        computeWalletActivityImportanceScore(base, fixedNow),
      );

      const strongEdge = createWalletActivitySummaryStats({
        ...base,
        walletId: "strong-edge",
        metricsWinRate30d: 0.7,
        metricsResolvedEdgeSampleCount30d: 25,
        metricsResolvedWinRateEdge30d: 0.15,
        metricsResolvedEdgeZScore30d: 2,
      });
      assert.ok(
        computeWalletActivityImportanceScore(strongEdge, fixedNow) >
          computeWalletActivityImportanceScore(base, fixedNow),
      );

      const activeWithNegativePnl = createWalletActivitySummaryStats({
        walletId: "active-negative-pnl",
        lastActivityAt: new Date("2026-06-08T11:00:00.000Z"),
        netChangeUsd: 250_000,
        unusualScore: 3,
        countsNew: 4,
        countsIncrease: 4,
        metricsPnl30d: -100_000,
      });
      assert.ok(
        computeWalletActivityImportanceScore(activeWithNegativePnl, fixedNow) >
          computeWalletActivityImportanceScore(base, fixedNow),
      );
    },
  },
  {
    name: "activity summary card item uses summary trade pnl when row metrics are missing",
    run: () => {
      const row = createTestCandidateWalletRow({ metrics: null });
      const item = buildWalletSummaryItem(
        row,
        createWalletActivitySummaryStats({
          metricsPnl30d: 39_780.31,
          metricsRoi30d: 0.0531,
          metricsTrades30d: 25,
          metricsVolume30d: 748_800,
          metricsWinRate30d: 1,
        }),
      );

      assert.equal(item.metrics?.pnl_usd, "39780.31");
      assert.equal(item.metrics?.roi, "0.0531");
      assert.equal(item.metrics?.trades_count, 25);
      assert.equal(item.metrics?.volume_usd, "748800");
      assert.equal(item.metrics?.win_rate, "1");
    },
  },
  {
    name: "ai profile tracker surface uses importance ordering by default",
    run: () => {
      const newestTiny = createWalletActivitySummaryStats({
        walletId: "tiny-newest",
        lastActivityAt: new Date("2026-06-08T11:59:00.000Z"),
        netChangeUsd: 25,
        countsNew: 1,
      });
      const olderImportant = createWalletActivitySummaryStats({
        walletId: "older-important",
        lastActivityAt: new Date("2026-06-08T07:00:00.000Z"),
        netChangeUsd: 150_000,
        unusualScore: 2.5,
        countsIncrease: 4,
      });

      assert.deepEqual(
        sortTrackerSurfaceSummaryStats(
          [newestTiny, olderImportant],
          "importance",
        ).map((row) => row.walletId),
        ["older-important", "tiny-newest"],
      );
    },
  },
  {
    name: "ai profile tracker surface can roll back to last activity ordering",
    run: () => {
      const newestTiny = createWalletActivitySummaryStats({
        walletId: "tiny-newest",
        lastActivityAt: new Date("2026-06-08T11:59:00.000Z"),
        netChangeUsd: 25,
        countsNew: 1,
      });
      const olderImportant = createWalletActivitySummaryStats({
        walletId: "older-important",
        lastActivityAt: new Date("2026-06-08T07:00:00.000Z"),
        netChangeUsd: 150_000,
        unusualScore: 2.5,
        countsIncrease: 4,
      });

      assert.deepEqual(
        sortTrackerSurfaceSummaryStats(
          [newestTiny, olderImportant],
          "last_activity",
        ).map((row) => row.walletId),
        ["tiny-newest", "older-important"],
      );
    },
  },
  {
    name: "internal hunch fills build cumulative trade activity without user metadata",
    run: () => {
      const filledAt = new Date("2026-06-08T12:00:00.000Z");
      const events = buildInternalHunchFillActivityEvents([
        {
          walletId: "wallet-1",
          venue: "polymarket",
          marketId: "market-1",
          outcomeSide: "YES",
          tokenId: "token-1",
          orderId: "order-1",
          orderFillId: "fill-1",
          venueFillId: "venue-fill-1",
          venueTradeId: "trade-1",
          fillSize: 10,
          fillPrice: 0.42,
          fillSide: "BUY",
          filledAt,
        },
        {
          walletId: "wallet-1",
          venue: "polymarket",
          marketId: "market-1",
          outcomeSide: "YES",
          tokenId: "token-1",
          orderId: "order-2",
          orderFillId: "fill-2",
          venueFillId: "venue-fill-2",
          venueTradeId: "trade-2",
          fillSize: 4,
          fillPrice: 0.5,
          fillSide: "SELL",
          filledAt: new Date("2026-06-08T12:00:01.000Z"),
        },
      ]);

      assert.equal(events.length, 2);
      assert.equal(events[0]?.action, "BUY");
      assert.equal(events[0]?.deltaShares, 10);
      assert.equal(events[0]?.sizeUsd, 4.2);
      assert.equal(events[0]?.metadata.prevShares, 0);
      assert.equal(events[0]?.metadata.currShares, 10);
      assert.equal(events[1]?.action, "SELL");
      assert.equal(events[1]?.metadata.prevShares, 10);
      assert.equal(events[1]?.metadata.currShares, 6);
      assert.equal("userId" in (events[0]?.metadata ?? {}), false);
    },
  },
  {
    name: "internal hunch fills offset same-time activity deterministically",
    run: () => {
      const filledAt = new Date("2026-06-08T12:00:00.123Z");
      const events = buildInternalHunchFillActivityEvents([
        {
          walletId: "wallet-1",
          venue: "limitless",
          marketId: "market-1",
          outcomeSide: "NO",
          tokenId: "token-1",
          orderId: "order-2",
          orderFillId: "fill-b",
          venueFillId: null,
          venueTradeId: null,
          fillSize: 2,
          fillPrice: 0.2,
          fillSide: "BUY",
          filledAt,
        },
        {
          walletId: "wallet-1",
          venue: "limitless",
          marketId: "market-1",
          outcomeSide: "NO",
          tokenId: "token-1",
          orderId: "order-1",
          orderFillId: "fill-a",
          venueFillId: null,
          venueTradeId: null,
          fillSize: 1,
          fillPrice: 0.1,
          fillSide: "BUY",
          filledAt,
        },
      ]);

      assert.deepEqual(
        events.map((event) => event.metadata.orderFillId),
        ["fill-a", "fill-b"],
      );
      assert.deepEqual(
        events.map((event) => event.occurredAt),
        ["2026-06-08T12:00:00.123000Z", "2026-06-08T12:00:00.123001Z"],
      );
    },
  },
  {
    name: "internal hunch fills use pre-lookback shares as replay baseline",
    run: () => {
      const events = buildInternalHunchFillActivityEvents(
        [
          {
            walletId: "wallet-1",
            venue: "kalshi",
            marketId: "market-1",
            outcomeSide: "YES",
            tokenId: "token-1",
            orderId: "order-1",
            orderFillId: "fill-1",
            venueFillId: null,
            venueTradeId: null,
            fillSize: 3,
            fillPrice: 0.75,
            fillSide: "SELL",
            filledAt: new Date("2026-06-08T12:00:00.000Z"),
          },
        ],
        {
          initialShares: [
            {
              walletId: "wallet-1",
              venue: "kalshi",
              tokenId: "token-1",
              shares: 9,
            },
          ],
        },
      );

      assert.equal(events.length, 1);
      assert.equal(events[0]?.metadata.prevShares, 9);
      assert.equal(events[0]?.metadata.currShares, 6);
    },
  },
  {
    name: "internal hunch fill cap selects newest fills and replays them ascending",
    run: () => {
      const fill = (
        orderFillId: string,
        filledAt: string,
        fillSize: number,
        fillSide: "BUY" | "SELL" = "BUY",
      ) => ({
        walletId: "wallet-1",
        venue: "polymarket",
        marketId: "market-1",
        outcomeSide: "YES",
        tokenId: "token-1",
        orderId: `order-${orderFillId}`,
        orderFillId,
        venueFillId: null,
        venueTradeId: null,
        fillSize,
        fillPrice: 0.5,
        fillSide,
        filledAt: new Date(filledAt),
      });

      const selected = selectNewestInternalHunchFillReplayInputs(
        [
          fill("fill-old", "2026-06-08T09:00:00.000Z", 10),
          fill("fill-middle", "2026-06-08T10:00:00.000Z", 4, "SELL"),
          fill("fill-new", "2026-06-08T11:00:00.000Z", 2, "SELL"),
        ],
        2,
      );
      assert.deepEqual(
        selected.map((row) => row.orderFillId),
        ["fill-middle", "fill-new"],
      );

      const events = buildInternalHunchFillActivityEvents(selected, {
        initialShares: [
          {
            walletId: "wallet-1",
            venue: "polymarket",
            tokenId: "token-1",
            shares: 10,
          },
        ],
      });

      assert.equal(events[0]?.metadata.prevShares, 10);
      assert.equal(events[0]?.metadata.currShares, 6);
      assert.equal(events[1]?.metadata.prevShares, 6);
      assert.equal(events[1]?.metadata.currShares, 4);
    },
  },
  {
    name: "internal hunch wallet matching normalizes EVM casing but keeps Solana exact",
    run: () => {
      assert.equal(
        normalizeInternalHunchWalletAddress(
          "0x2dFcaa5734CA03B3917eAcCb32f9B75c7675781A",
          "polygon",
        ),
        "0x2dfcaa5734ca03b3917eaccb32f9b75c7675781a",
      );
      assert.equal(
        internalHunchWalletAddressesMatch({
          chain: "polygon",
          left: "0x2dFcaa5734CA03B3917eAcCb32f9B75c7675781A",
          right: "0x2dfcaa5734ca03b3917eaccb32f9b75c7675781a",
        }),
        true,
      );
      assert.equal(
        internalHunchWalletAddressesMatch({
          chain: "solana",
          left: "F7RnPpFGLzY2r17MLTrxgJXDWiHF5etiEaLNn11GebLJ",
          right: "f7rnppfgLzy2r17MLTrxgJXDWiHF5etiEaLNn11GebLJ",
        }),
        false,
      );
    },
  },
  {
    name: "internal hunch first-import open snapshots suppress synthetic deltas",
    run: () => {
      assert.equal(
        shouldSuppressInternalHunchSnapshotDelta({
          snapshotSource: "hunch_own_position_open",
          hasPreviousSameKey: false,
          prevShares: 0,
          currShares: 2,
        }),
        true,
      );
      assert.equal(
        shouldSuppressInternalHunchSnapshotDelta({
          snapshotSource: "hunch_own_position_open",
          hasPreviousSameKey: true,
          prevShares: 1,
          currShares: 2,
        }),
        false,
      );
      assert.equal(
        shouldSuppressInternalHunchSnapshotDelta({
          snapshotSource: "solana",
          hasPreviousSameKey: false,
          prevShares: 0,
          currShares: 2,
        }),
        false,
      );
    },
  },
  {
    name: "activity summary existing sort modes keep their ordering",
    run: () => {
      const olderLarge = createWalletActivitySummaryStats({
        walletId: "older-large",
        lastActivityAt: new Date("2026-06-08T08:00:00.000Z"),
        netChangeUsd: 100_000,
        unusualScore: 1,
      });
      const newerSmall = createWalletActivitySummaryStats({
        walletId: "newer-small",
        lastActivityAt: new Date("2026-06-08T12:00:00.000Z"),
        netChangeUsd: 1_000,
        unusualScore: 0.5,
      });
      const unusual = createWalletActivitySummaryStats({
        walletId: "unusual",
        lastActivityAt: new Date("2026-06-08T09:00:00.000Z"),
        netChangeUsd: 2_000,
        unusualScore: 2,
      });

      assert.deepEqual(
        [olderLarge, newerSmall]
          .sort((left, right) =>
            compareWalletActivitySummaryStats(left, right, "last_activity"),
          )
          .map((row) => row.walletId),
        ["newer-small", "older-large"],
      );
      assert.deepEqual(
        [newerSmall, olderLarge]
          .sort((left, right) =>
            compareWalletActivitySummaryStats(left, right, "net_change_usd"),
          )
          .map((row) => row.walletId),
        ["older-large", "newer-small"],
      );
      assert.deepEqual(
        [newerSmall, unusual]
          .sort((left, right) =>
            compareWalletActivitySummaryStats(left, right, "unusual_score"),
          )
          .map((row) => row.walletId),
        ["unusual", "newer-small"],
      );
    },
  },
  {
    name: "top label variant resolves backend headline badges deterministically",
    run: () => {
      const risingStar = resolveWalletTopLabelVariant({
        attribution: {
          primary: null,
          primaryCandidates: [],
          secondary: ["fresh_wallet", "high_conviction"],
          supporting: [],
          display: {
            listPrimary: [],
            listSecondary: [],
            detailsSecondary: [],
            detailsSupporting: [],
          },
          reasons: [],
          version: "v1",
        },
        metrics: { roi: "0.12", pnl_usd: "1200" },
        lastActivityAt: new Date("2026-03-10T00:00:00.000Z"),
      });
      assert.equal(risingStar, "rising-star");

      const hotStreak = resolveWalletTopLabelVariant({
        attribution: {
          primary: null,
          primaryCandidates: [],
          secondary: ["high_win_rate"],
          supporting: ["consistent_performer"],
          display: {
            listPrimary: [],
            listSecondary: [],
            detailsSecondary: [],
            detailsSupporting: [],
          },
          reasons: [],
          version: "v1",
        },
        metrics: { pnl_usd: "750" },
        lastActivityAt: new Date("2026-03-10T00:00:00.000Z"),
      });
      assert.equal(hotStreak, "hot-streak");

      const trendingTrader = resolveWalletTopLabelVariant({
        attribution: {
          primary: null,
          primaryCandidates: [],
          secondary: ["high_frequency"],
          supporting: [],
          display: {
            listPrimary: [],
            listSecondary: [],
            detailsSecondary: [],
            detailsSupporting: [],
          },
          reasons: [],
          version: "v1",
        },
        metrics: { pnl_usd: "-10" },
        lastActivityAt: null,
      });
      assert.equal(trendingTrader, "trending-trader");

      const marketMover = resolveWalletTopLabelVariant({
        attribution: {
          primary: null,
          primaryCandidates: [],
          secondary: ["market_mover", "fresh_wallet", "high_win_rate"],
          supporting: [],
          display: {
            listPrimary: [],
            listSecondary: [],
            detailsSecondary: [],
            detailsSupporting: [],
          },
          reasons: [],
          version: "v1",
        },
        metrics: { roi: "0.3", pnl_usd: "5000" },
        lastActivityAt: new Date("2026-03-10T00:00:00.000Z"),
      });
      assert.equal(marketMover, "market-mover");
    },
  },
  {
    name: "resolved trade stats backfill missing win rate metrics",
    run: () => {
      const patched = applyResolvedTradeStatsToMetrics(
        {
          period: "30d",
          as_of: new Date("2026-03-10T00:00:00.000Z"),
          trades_count: 6,
          volume_usd: "453273.53",
          pnl_usd: "9050.5",
          roi: "0.3786",
          win_rate: null,
          avg_hold_hours: null,
          last_trade_at: new Date("2026-03-10T00:00:00.000Z"),
        },
        {
          walletId: "7f9c0d1e-cddb-4ff4-9894-ccd9ba88d3db",
          resolvedCount: 6,
          winningCount: 4,
          losingCount: 2,
          winRate: 4 / 6,
        },
      );

      assert.equal(patched?.win_rate, String(4 / 6));
      assert.equal(patched?.winning_count, 4);
      assert.equal(patched?.losing_count, 2);
      assert.equal(patched?.resolved_count, 6);
    },
  },
  {
    name: "entry bracket resolver normalizes fractional and cents-style prices",
    run: () => {
      assert.equal(resolveEntryBracketKey(0.19), "0-20");
      assert.equal(resolveEntryBracketKey(0.2), "20-40");
      assert.equal(resolveEntryBracketKey(0.95), "80-100");
      assert.equal(resolveEntryBracketKey(95), "80-100");
      assert.equal(resolveEntryBracketKey(15), "0-20");
      assert.equal(resolveEntryBracketKey(-1), null);
      assert.equal(resolveEntryBracketKey(120), null);
    },
  },
  {
    name: "wallet intel schemas parse sparkline and series query defaults",
    run: () => {
      const whales = walletWhalesQuerySchema.parse({
        includeSparkline: "true",
        sparklineMetric: "trade_pnl",
      });
      const summary = walletActivitySummaryQuerySchema.parse({
        includeSparkline: "1",
        sparklineMetric: "activity",
        sort: "importance",
        q: "Elon Musk",
        marketId: "polymarket:123",
        eventId: "polymarket:999",
      });
      const series = walletSeriesQuerySchema.parse({});

      assert.equal(whales.includeSparkline, true);
      assert.equal(whales.sparklineMetric, "trade_pnl");
      assert.equal(summary.includeSparkline, true);
      assert.equal(summary.sparklineMetric, "activity");
      assert.equal(summary.sort, "importance");
      assert.equal(summary.q, "Elon Musk");
      assert.equal(summary.marketId, "polymarket:123");
      assert.equal(summary.eventId, "polymarket:999");
      assert.equal(series.windowHours, undefined);
      assert.equal(series.bucketHours, undefined);
      assert.equal(series.period, "30d");
      assert.equal(series.limit, 120);
    },
  },
  {
    name: "wallet performance sparklines use one batch 30d metrics query",
    run: async () => {
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      const client = {
        query: async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          return { rows: [] };
        },
      } as unknown as import("pg").PoolClient;
      const walletIds = [
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
      ];

      const result = await fetchWalletPerformanceSparklines(client, walletIds, {
        asOf: new Date("2026-01-02T00:00:00.000Z"),
        windowHours: 168,
      });

      assert.equal(calls.length, 1);
      assert.match(calls[0]?.sql ?? "", /wallet_metrics_snapshots/);
      assert.match(calls[0]?.sql ?? "", /s\.period = '30d'/);
      assert.deepEqual(calls[0]?.params[0], walletIds);
      assert.equal(result.get(walletIds[0])?.metric, "trade_pnl");
      assert.equal(result.get(walletIds[1])?.metric, "trade_pnl");
    },
  },
  {
    name: "wallet performance series default query stays unwindowed",
    run: async () => {
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      const client = {
        query: async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          return { rows: [] };
        },
      } as unknown as import("pg").PoolClient;

      await fetchWalletPerformanceSeries(
        client,
        "00000000-0000-0000-0000-000000000001",
        {
          period: "30d",
          limit: 24,
        },
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.params.length, 3);
      assert.ok(!calls[0]?.sql.includes("bucket_index"));
    },
  },
  {
    name: "wallet performance series windows only when explicitly requested",
    run: async () => {
      const calls: Array<{ sql: string; params: unknown[] }> = [];
      const client = {
        query: async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          return { rows: [] };
        },
      } as unknown as import("pg").PoolClient;
      const asOf = new Date("2026-03-13T12:00:00.000Z");

      await fetchWalletPerformanceSeries(
        client,
        "00000000-0000-0000-0000-000000000001",
        {
          period: "7d",
          windowHours: 168,
          bucketHours: 1,
          limit: 24,
          asOf,
        },
      );

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.params.length, 6);
      assert.ok(calls[0]?.sql.includes("bucket_index"));
      assert.equal(
        (calls[0]?.params[2] as Date).toISOString(),
        new Date(asOf.getTime() - 168 * 60 * 60 * 1000).toISOString(),
      );
      assert.equal(calls[0]?.params[3], 1);
      assert.equal(
        (calls[0]?.params[4] as Date).toISOString(),
        asOf.toISOString(),
      );
    },
  },
  {
    name: "runtime policy boolean parsing honors explicit true/false strings",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000002",
              policy_key: "ai_clusters",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                analysisEnabled: "false",
                useWebContext: "true",
                debugLogs: false,
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "ai_clusters");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.source, "db");
      assert.equal(resolved.effective.analysisEnabled, false);
      assert.equal(resolved.effective.useWebContext, true);
      assert.equal(resolved.effective.debugLogs, false);
    },
  },
  {
    name: "runtime policy boolean parsing rejects non-boolean strings",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000003",
              policy_key: "ai_whale_profiles",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                autoRun: "nope",
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "ai_whale_profiles");
      assert.equal(resolved.invalidOverride, true);
      assert.equal(resolved.source, "env");
    },
  },
  {
    name: "auth access policy resolves valid db override",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000030",
              policy_key: "auth_access",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                state: "required",
                embeddedSolanaSponsorship: false,
                solanaPrefundEnabled: false,
                solanaLossCloseSponsorshipEnabled: false,
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "auth_access");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.source, "db");
      assert.equal(resolved.effective.state, "required");
      assert.equal(resolved.effective.embeddedSolanaSponsorship, false);
      assert.equal(resolved.effective.solanaPrefundEnabled, false);
      assert.equal(resolved.effective.solanaLossCloseSponsorshipEnabled, false);
    },
  },
  {
    name: "auth access policy accepts embedded solana sponsorship override",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000032",
              policy_key: "auth_access",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                state: "required",
                embeddedSolanaSponsorship: true,
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "auth_access");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.source, "db");
      assert.equal(resolved.effective.state, "required");
      assert.equal(resolved.effective.embeddedSolanaSponsorship, true);
    },
  },
  {
    name: "auth access policy accepts solana prefund override",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000033",
              policy_key: "auth_access",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                state: "required",
                solanaPrefundEnabled: true,
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "auth_access");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.source, "db");
      assert.equal(resolved.effective.state, "required");
      assert.equal(resolved.effective.solanaPrefundEnabled, true);
      assert.equal(
        resolved.effective.solanaLossCloseSponsorshipEnabled,
        env.solanaLossCloseSponsorshipEnabled,
      );
    },
  },
  {
    name: "auth access policy accepts solana loss close sponsorship override",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000034",
              policy_key: "auth_access",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                state: "required",
                solanaLossCloseSponsorshipEnabled: true,
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "auth_access");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.source, "db");
      assert.equal(resolved.effective.state, "required");
      assert.equal(
        resolved.effective.solanaPrefundEnabled,
        env.solanaPrefundEnabled,
      );
      assert.equal(resolved.effective.solanaLossCloseSponsorshipEnabled, true);
    },
  },
  {
    name: "auth access policy defaults embedded solana sponsorship off",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({ rows: [] }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "auth_access");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.effective.embeddedSolanaSponsorship, false);
      assert.equal(
        resolved.effective.solanaPrefundEnabled,
        env.solanaPrefundEnabled,
      );
      assert.equal(
        resolved.effective.solanaLossCloseSponsorshipEnabled,
        env.solanaLossCloseSponsorshipEnabled,
      );
    },
  },
  {
    name: "auth access policy rejects invalid state and falls back to env",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000031",
              policy_key: "auth_access",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                state: "not_a_state",
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "auth_access");
      assert.equal(resolved.invalidOverride, true);
      assert.equal(resolved.source, "env");
    },
  },
  {
    name: "market map policy sanitizer ignores deprecated projection override keys",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000004",
              policy_key: "market_map",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                enabled: true,
                projectionAlgo: "pca2",
                layoutMode: "grid",
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "market_map");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.source, "db");
      assert.equal(resolved.effective.enabled, true);
      assert.equal(
        "projectionAlgo" in
          ((resolved.override ?? {}) as Record<string, unknown>),
        false,
      );
      assert.equal(
        "layoutMode" in ((resolved.override ?? {}) as Record<string, unknown>),
        false,
      );
    },
  },
  {
    name: "market map policy normalizes scheduler and projection bounds",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000005",
              policy_key: "market_map",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                enabled: true,
                triggerMode: "interval",
                pollIntervalSec: 1,
                runWindowMinutes: 1,
                maxRunsPerWindow: 1,
                maxRunsPerDay: 1,
                budgetWindowMinutes: 1,
                budgetWindowUsd: 0,
                dayBudgetUsd: 0,
                estimatedRunCostUsd: 0,
                lockTtlSec: 1,
                depth: 1,
                k1: 1,
                k2: 1,
                k3: 1,
                labelLevels: [],
                venuesEnabled: ["!invalid"],
                projectionPcaDims: 1,
                projectionUmapNeighbors: 1,
                projectionUmapMinDist: 0,
                projectionBudgetMs: 1,
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "market_map");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.source, "db");
      assert.equal(resolved.effective.pollIntervalSec, 60);
      assert.equal(resolved.effective.lockTtlSec, 60);
      assert.equal(resolved.effective.depth, 2);
      assert.equal(resolved.effective.k1, 2);
      assert.equal(resolved.effective.k2, 2);
      assert.equal(resolved.effective.k3, 2);
      assert.deepEqual(resolved.effective.labelLevels, [1, 2, 3]);
      assert.deepEqual(resolved.effective.venuesEnabled, [
        "polymarket",
        "kalshi",
        "limitless",
      ]);
      assert.equal(resolved.effective.projectionPcaDims, 8);
      assert.equal(resolved.effective.projectionUmapNeighbors, 5);
      assert.equal(resolved.effective.projectionUmapMinDist, 0.01);
      assert.equal(resolved.effective.projectionBudgetMs, 1000);
    },
  },
  {
    name: "map search policy normalizes scheduler bounds and domains",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000006",
              policy_key: "map_search",
              effective_at: new Date("2026-01-01T00:00:00.000Z"),
              payload: {
                pollIntervalSec: 1,
                lockTtlSec: 30,
                lockHeartbeatSec: 1,
                maxCalls: 1,
                enforceFreshness: "false",
                sourceAllowDomains: [
                  "HTTPS://WWW.Example.com",
                  "example.com",
                  "  api.X.com ",
                ],
                sourceDenyDomains: [
                  "https://www.Polymarket.com",
                  "polymarket.com",
                ],
              },
              created_by: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "map_search");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.source, "db");
      assert.equal(resolved.effective.pollIntervalSec, 60);
      assert.equal(resolved.effective.lockTtlSec, 30);
      assert.equal(resolved.effective.lockHeartbeatSec, 10);
      assert.equal(resolved.effective.maxCalls, 1);
      assert.equal(resolved.effective.enforceFreshness, false);
      assert.deepEqual(resolved.effective.sourceAllowDomains, [
        "example.com",
        "api.x.com",
      ]);
      assert.deepEqual(resolved.effective.sourceDenyDomains, [
        "polymarket.com",
      ]);
    },
  },
  {
    name: "map signals policy normalizes scheduler bounds and publish gates",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000036",
              policy_key: "map_signals",
              effective_at: new Date("2026-01-02T00:00:00.000Z"),
              payload: {
                pollIntervalSec: 1,
                lockTtlSec: 15,
                lockHeartbeatSec: 1,
                minEvidence: 1,
                minConfirmed: 0,
                minDistinctDomains: 1,
                minEvidenceIdsForPublish: 1,
                minAffinityForPublish: 1,
                concurrency: 16,
                maxOutputTokens: 5,
                persistNotes: "true",
              },
              created_by: null,
              created_at: new Date("2026-01-02T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "map_signals");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.source, "db");
      assert.equal(resolved.effective.pollIntervalSec, 60);
      assert.equal(resolved.effective.lockTtlSec, 30);
      assert.equal(resolved.effective.lockHeartbeatSec, 10);
      assert.equal(resolved.effective.minEvidence, 1);
      assert.equal(resolved.effective.minConfirmed, 0);
      assert.equal(resolved.effective.minDistinctDomains, 1);
      assert.equal(resolved.effective.minEvidenceIdsForPublish, 1);
      assert.equal(resolved.effective.minAffinityForPublish, 1);
      assert.equal(resolved.effective.concurrency, 16);
      assert.equal(resolved.effective.maxOutputTokens, 100);
      assert.equal(resolved.effective.persistNotes, true);
    },
  },
  {
    name: "wallet attribution policy override merges partial nested blocks",
    run: async () => {
      const db = {
        query: async (_sql: string) => ({
          rows: [
            {
              id: "00000000-0000-0000-0000-000000000021",
              policy_key: "wallet_intel_attribution",
              effective_at: new Date("2026-01-02T00:00:00.000Z"),
              payload: {
                enabled: true,
                queryControls: {
                  whalesBatchSize: 50,
                  whalesMaxScanCandidates: 1500,
                },
                venueThresholds: {
                  polymarket: {
                    whaleExposureUsd: 75000,
                  },
                },
              },
              created_by: null,
              created_at: new Date("2026-01-02T00:00:00.000Z"),
            },
          ],
        }),
      } as import("./db.js").DbQuery;

      const resolved = await resolveIntelPolicy(db, "wallet_intel_attribution");
      assert.equal(resolved.source, "db");
      assert.equal(resolved.invalidOverride, false);
      assert.equal(resolved.effective.enabled, true);
      assert.equal(resolved.effective.queryControls.whalesBatchSize, 50);
      assert.equal(
        resolved.effective.queryControls.whalesMaxScanCandidates,
        1500,
      );
      assert.equal(
        resolved.effective.venueThresholds.polymarket.whaleExposureUsd,
        75000,
      );
      assert.equal(
        resolved.effective.venueThresholds.kalshi.whaleExposureUsd > 0,
        true,
      );
    },
  },
  {
    name: "wallet attribution signal presentation hides redundant gate reasons",
    run: () => {
      const presentation = buildSignalPresentation({
        signalLabels: [
          "longshot_odds",
          "high_notional",
          "reactivated_after_idle",
          "high_risk_longshot",
        ],
        labels: [],
        signalScore: 0.91,
        venue: "polymarket",
        policy: {
          enabled: true,
          display: {
            listPrimaryCount: 1,
            listSecondaryCount: 2,
            detailsSecondaryMax: 8,
            detailsSupportingMax: 12,
          },
          venueThresholds: {
            polymarket: {
              whaleExposureUsd: 50000,
              whaleVolume30dUsd: 150000,
              highConvictionStakeUsd: 5000,
              marketMoverStakeUsd: 10000,
              marketMoverStakeToMarketVolRatio: 0.05,
              highFrequencyTrades30d: 120,
              botMinActiveDays30d: 12,
              botMinActiveUtcHourSlots30d: 16,
              botMaxMedianStakeUsd: 750,
              volumeTraderVolume30dUsd: 250000,
              specialistCategoryShareMin: 0.6,
              insiderCriticalSignals30dMin: 3,
              insiderAvgSignalScoreMin: 0.75,
              insiderMinResolvedBets: 12,
              insiderWinRateMin: 0.62,
            },
            kalshi: {
              whaleExposureUsd: 50000,
              whaleVolume30dUsd: 150000,
              highConvictionStakeUsd: 5000,
              marketMoverStakeUsd: 10000,
              marketMoverStakeToMarketVolRatio: 0.05,
              highFrequencyTrades30d: 120,
              botMinActiveDays30d: 12,
              botMinActiveUtcHourSlots30d: 16,
              botMaxMedianStakeUsd: 750,
              volumeTraderVolume30dUsd: 250000,
              specialistCategoryShareMin: 0.6,
              insiderCriticalSignals30dMin: 3,
              insiderAvgSignalScoreMin: 0.75,
              insiderMinResolvedBets: 12,
              insiderWinRateMin: 0.62,
            },
            limitless: {
              whaleExposureUsd: 50000,
              whaleVolume30dUsd: 150000,
              highConvictionStakeUsd: 5000,
              marketMoverStakeUsd: 10000,
              marketMoverStakeToMarketVolRatio: 0.05,
              highFrequencyTrades30d: 120,
              botMinActiveDays30d: 12,
              botMinActiveUtcHourSlots30d: 16,
              botMaxMedianStakeUsd: 750,
              volumeTraderVolume30dUsd: 250000,
              specialistCategoryShareMin: 0.6,
              insiderCriticalSignals30dMin: 3,
              insiderAvgSignalScoreMin: 0.75,
              insiderMinResolvedBets: 12,
              insiderWinRateMin: 0.62,
            },
          },
          ruleWeights: {
            whale: 1,
            specialist: 1,
            bot: 1,
            insider: 1,
            primaryTieBreakOrder: ["whale", "specialist", "bot", "insider"],
          },
          signalsDisplay: {
            maxDisplayReasons: 2,
            hideRedundantReasonsWhenGateImplies: true,
            severityThresholds: {
              default: { medium: 0.5, high: 0.75, critical: 0.9 },
              polymarket: { medium: 0.5, high: 0.75, critical: 0.9 },
              kalshi: { medium: 0.5, high: 0.75, critical: 0.9 },
              limitless: { medium: 0.5, high: 0.75, critical: 0.9 },
            },
          },
          sensitiveLabels: { insiderEnabled: false, botEnabled: true },
          queryControls: {
            whalesBatchSize: 100,
            whalesMaxScanCandidates: 3000,
          },
          venueCapabilities: {
            polymarket: { specialistEnabled: true },
            kalshi: { specialistEnabled: true },
            limitless: { specialistEnabled: true },
          },
          multiVenueMerge: {
            strategy: "max_candidate_score",
            venueTieBreak: "volume30d_desc_then_fixed_order",
            fixedVenueOrder: ["polymarket", "kalshi", "limitless"],
          },
        },
      });
      assert.equal(presentation.severity, "critical");
      assert.deepEqual(presentation.displayReasons, [
        "high_risk_longshot",
        "longshot_odds",
      ]);
    },
  },
  {
    name: "wallet attribution signal presentation keeps a trigger reason visible",
    run: () => {
      const presentation = buildSignalPresentation({
        signalLabels: ["low_odds", "high_notional"],
        labels: ["fresh_wallet", "on_pattern"],
        signalScore: 0.7,
        venue: "polymarket",
        policy: {
          enabled: true,
          display: {
            listPrimaryCount: 1,
            listSecondaryCount: 2,
            detailsSecondaryMax: 8,
            detailsSupportingMax: 12,
          },
          venueThresholds: {
            polymarket: {
              whaleExposureUsd: 50000,
              whaleVolume30dUsd: 150000,
              highConvictionStakeUsd: 5000,
              marketMoverStakeUsd: 10000,
              marketMoverStakeToMarketVolRatio: 0.05,
              highFrequencyTrades30d: 120,
              botMinActiveDays30d: 12,
              botMinActiveUtcHourSlots30d: 16,
              botMaxMedianStakeUsd: 750,
              volumeTraderVolume30dUsd: 250000,
              specialistCategoryShareMin: 0.6,
              insiderCriticalSignals30dMin: 3,
              insiderAvgSignalScoreMin: 0.75,
              insiderMinResolvedBets: 12,
              insiderWinRateMin: 0.62,
            },
            kalshi: {
              whaleExposureUsd: 50000,
              whaleVolume30dUsd: 150000,
              highConvictionStakeUsd: 5000,
              marketMoverStakeUsd: 10000,
              marketMoverStakeToMarketVolRatio: 0.05,
              highFrequencyTrades30d: 120,
              botMinActiveDays30d: 12,
              botMinActiveUtcHourSlots30d: 16,
              botMaxMedianStakeUsd: 750,
              volumeTraderVolume30dUsd: 250000,
              specialistCategoryShareMin: 0.6,
              insiderCriticalSignals30dMin: 3,
              insiderAvgSignalScoreMin: 0.75,
              insiderMinResolvedBets: 12,
              insiderWinRateMin: 0.62,
            },
            limitless: {
              whaleExposureUsd: 50000,
              whaleVolume30dUsd: 150000,
              highConvictionStakeUsd: 5000,
              marketMoverStakeUsd: 10000,
              marketMoverStakeToMarketVolRatio: 0.05,
              highFrequencyTrades30d: 120,
              botMinActiveDays30d: 12,
              botMinActiveUtcHourSlots30d: 16,
              botMaxMedianStakeUsd: 750,
              volumeTraderVolume30dUsd: 250000,
              specialistCategoryShareMin: 0.6,
              insiderCriticalSignals30dMin: 3,
              insiderAvgSignalScoreMin: 0.75,
              insiderMinResolvedBets: 12,
              insiderWinRateMin: 0.62,
            },
          },
          ruleWeights: {
            whale: 1,
            specialist: 1,
            bot: 1,
            insider: 1,
            primaryTieBreakOrder: ["whale", "specialist", "bot", "insider"],
          },
          signalsDisplay: {
            maxDisplayReasons: 2,
            hideRedundantReasonsWhenGateImplies: true,
            severityThresholds: {
              default: { medium: 0.5, high: 0.75, critical: 0.9 },
              polymarket: { medium: 0.5, high: 0.75, critical: 0.9 },
              kalshi: { medium: 0.5, high: 0.75, critical: 0.9 },
              limitless: { medium: 0.5, high: 0.75, critical: 0.9 },
            },
          },
          sensitiveLabels: { insiderEnabled: false, botEnabled: true },
          queryControls: {
            whalesBatchSize: 100,
            whalesMaxScanCandidates: 3000,
          },
          venueCapabilities: {
            polymarket: { specialistEnabled: true },
            kalshi: { specialistEnabled: true },
            limitless: { specialistEnabled: true },
          },
          multiVenueMerge: {
            strategy: "max_candidate_score",
            venueTieBreak: "volume30d_desc_then_fixed_order",
            fixedVenueOrder: ["polymarket", "kalshi", "limitless"],
          },
        },
      });
      assert.deepEqual(presentation.displayReasons, ["on_pattern", "low_odds"]);
    },
  },
  {
    name: "wallet attribution filter matcher supports any/all modes",
    run: () => {
      const matchedAll = walletMatchesFilters(
        [{ slug: "whale" }, { slug: "fresh" }],
        {
          primary: "whale",
          primaryCandidates: [{ key: "whale", score: 1 }],
          secondary: ["high_conviction", "high_frequency"],
          supporting: ["late_entry"],
          display: {
            listPrimary: ["whale"],
            listSecondary: ["high_conviction", "high_frequency"],
            detailsSecondary: ["high_conviction", "high_frequency"],
            detailsSupporting: ["late_entry"],
          },
          reasons: [],
          version: "v1",
        },
        {
          tags: ["whale", "fresh"],
          tagMode: "all",
          primary: ["whale"],
          labels: ["high_conviction", "high_frequency"],
          labelMode: "all",
        },
      );
      assert.equal(matchedAll, true);

      const matchedAny = walletMatchesFilters(
        [{ slug: "dormant" }],
        {
          primary: "specialist",
          primaryCandidates: [{ key: "specialist", score: 0.8 }],
          secondary: ["crypto_specialist"],
          supporting: ["unusual_behavior"],
          display: {
            listPrimary: ["specialist"],
            listSecondary: ["crypto_specialist"],
            detailsSecondary: ["crypto_specialist"],
            detailsSupporting: ["unusual_behavior"],
          },
          reasons: [],
          version: "v1",
        },
        {
          tags: ["dormant", "fresh"],
          tagMode: "any",
          primary: ["whale", "specialist"],
          labels: ["crypto_specialist", "high_win_rate"],
          labelMode: "any",
        },
      );
      assert.equal(matchedAny, true);
    },
  },
  {
    name: "minPositiveThreshold ignores zero/negative values",
    run: () => {
      assert.equal(minPositiveThreshold([]), null);
      assert.equal(minPositiveThreshold([0, -1, -100]), null);
      assert.equal(minPositiveThreshold([0, 50_000, 10_000]), 10_000);
      assert.equal(minPositiveThreshold([1, 2, 3]), 1);
    },
  },
  {
    name: "filter_too_broad only when scan cap hit and page cannot be satisfied",
    run: () => {
      assert.equal(
        shouldReturnFilterTooBroad({
          filteredCount: 30,
          requestedOffset: 0,
          requestedLimit: 25,
          hitScanCap: true,
          hasMoreCandidates: true,
        }),
        false,
      );
      assert.equal(
        shouldReturnFilterTooBroad({
          filteredCount: 30,
          requestedOffset: 25,
          requestedLimit: 25,
          hitScanCap: true,
          hasMoreCandidates: true,
        }),
        true,
      );
      assert.equal(
        shouldReturnFilterTooBroad({
          filteredCount: 30,
          requestedOffset: 25,
          requestedLimit: 25,
          hitScanCap: false,
          hasMoreCandidates: true,
        }),
        false,
      );
      assert.equal(
        shouldReturnFilterTooBroad({
          filteredCount: 30,
          requestedOffset: 25,
          requestedLimit: 25,
          hitScanCap: true,
          hasMoreCandidates: false,
        }),
        false,
      );
    },
  },
  {
    name: "scope=all wallet candidates use following+active union with dedupe",
    run: () => {
      const merged = mergeWalletIdsForScope(
        "all",
        ["follow-a", "shared", "follow-b"],
        ["active-a", "shared", "active-b"],
      );
      assert.deepEqual(merged, [
        "follow-a",
        "shared",
        "follow-b",
        "active-a",
        "active-b",
      ]);
      assert.deepEqual(mergeWalletIdsForScope("following", ["a", "b"], ["c"]), [
        "a",
        "b",
      ]);
      assert.deepEqual(mergeWalletIdsForScope("active", ["a"], ["b", "c"]), [
        "b",
        "c",
      ]);
    },
  },
  {
    name: "polymarket prefetch helpers keep owner priority and numeric token union",
    run: () => {
      const signer = "0x0000000000000000000000000000000000000001";
      const funder = "0x0000000000000000000000000000000000000002";

      assert.deepEqual(resolvePolymarketOwnerAddresses(signer, null), [signer]);
      assert.deepEqual(resolvePolymarketOwnerAddresses(signer, signer), [
        signer,
      ]);
      assert.deepEqual(resolvePolymarketOwnerAddresses(signer, funder), [
        funder,
        signer,
      ]);
      assert.deepEqual(
        resolvePolymarketTrackedTokenUniverse(
          ["1", "2", "bad", "", "2"],
          ["2", "3", "abc", "4"],
        ),
        ["1", "2", "3", "4"],
      );
    },
  },
  {
    name: "followed polymarket prefetch includes tracked ids and signer-funder balances",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const signer = "0x0000000000000000000000000000000000000001";
      const funder = "0x0000000000000000000000000000000000000002";

      const pool = {
        query: async (sql: string) => {
          if (sql.includes("from user_venue_credentials")) {
            return {
              rows: [{ funder_address: funder }],
            };
          }
          if (sql.includes("with watchlist_tokens")) {
            return {
              rows: [{ token_id: "1" }, { token_id: "10" }],
            };
          }
          throw new Error(`Unexpected query in test: ${sql.slice(0, 60)}`);
        },
      } as unknown as import("@hunch/infra").Pool;

      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          params?: Array<{ data?: string } | string>;
        };
        const call = body.params?.[0];
        if (
          !call ||
          typeof call === "string" ||
          typeof call.data !== "string"
        ) {
          throw new Error("Expected ERC1155 eth_call payload");
        }
        const [owners, ids] = testErc1155Iface.decodeFunctionData(
          "balanceOfBatch",
          call.data,
        ) as unknown as [string[], bigint[]];
        const owner = owners[0]?.toLowerCase() ?? "";
        const balances = ids.map((id) => {
          const tokenId = id.toString();
          if (owner === funder.toLowerCase()) {
            return tokenId === "9" ? 4_000_000n : 0n;
          }
          if (tokenId === "1") return 5_000_000n;
          if (tokenId === "10") return 2_000_000n;
          return 0n;
        });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: testErc1155Iface.encodeFunctionResult("balanceOfBatch", [
              balances,
            ]),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      };

      try {
        const prefetched = await prefetchFollowedPolymarketOwnerBalances(pool, {
          userId: "user-1",
          walletAddress: signer,
          trackedTokenIds: ["9", "10", "bad"],
        });

        assert.deepEqual(prefetched.owners, [funder, signer]);
        assert.deepEqual(prefetched.candidateTokenIds, ["1", "10"]);
        assert.deepEqual(prefetched.trackedTokenIds, ["9", "10"]);
        assert.deepEqual(prefetched.unionTokenIds, ["1", "10", "9"]);
        assert.equal(prefetched.rpcCallEstimate, 2);
        assert.equal(prefetched.rpcCallCount, 2);
        assert.deepEqual(
          prefetched.balancesByOwner
            .get(funder.toLowerCase())
            ?.map((row) => row.tokenId),
          ["9"],
        );
        assert.deepEqual(
          prefetched.balancesByOwner
            .get(signer.toLowerCase())
            ?.map((row) => row.tokenId),
          ["1", "10"],
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
  {
    name: "prefetched polymarket balances filter to sync candidate token ids",
    run: () => {
      const signer = "0x0000000000000000000000000000000000000001";
      const funder = "0x0000000000000000000000000000000000000002";
      const filtered = filterPrefetchedPolymarketOwnerBalances({
        prefetched: {
          owners: [funder, signer],
          funderAddress: funder,
          candidateTokenIds: ["1"],
          trackedTokenIds: ["9"],
          unionTokenIds: ["1", "9"],
          rpcCallEstimate: 2,
          rpcCallCount: 2,
          balancesByOwner: new Map([
            [funder.toLowerCase(), [{ tokenId: "9", size: "4.0" }]],
            [
              signer.toLowerCase(),
              [
                { tokenId: "1", size: "5.0" },
                { tokenId: "9", size: "1.0" },
              ],
            ],
          ]),
        },
        owners: [funder, signer],
        tokenIds: ["1"],
      });

      assert.deepEqual(filtered, [
        { owner: funder, held: [] },
        { owner: signer, held: [{ tokenId: "1", size: "5.0" }] },
      ]);
    },
  },
  {
    name: "wallet summary helper keeps summary stats and open-position overlay aligned",
    run: () => {
      const signalItem = buildWalletSignalItemFromSignalRow({
        candidate: createTestCandidateWalletRow(),
        signalRow: createTestSignalRow(),
        mmDiagnostics: null,
        pageLabels: null,
        attributionPolicy: testAttributionPolicy,
      });
      const item = buildWalletSummaryItem(
        createTestCandidateWalletRow(),
        createTestSummaryStats(),
        {
          followersCount: 7,
          topChanges: [signalItemToTopChange(signalItem)],
          openPositionStats: {
            trackedExposureUsd: 320,
            openPositionsCount: 4,
            openMarketsCount: 3,
            avgOpenPositionSizeUsd: 80,
            avgOpenEntryPrice: 0.42,
            avgOpenEntryApprox: true,
          },
        },
      );

      assert.equal(item.walletId, "wallet-1");
      assert.equal(item.followersCount, 7);
      assert.equal(item.netChangeUsd, 150);
      assert.equal(item.trackedExposureUsd, 320);
      assert.equal(item.openPositionsCount, 4);
      assert.equal(item.openMarketsCount, 3);
      assert.equal(item.avgOpenEntryPrice, 0.42);
      assert.equal(item.avgOpenEntryApprox, true);
      assert.deepEqual(
        item.topChanges.map((change) => change.marketId),
        ["market-1"],
      );
    },
  },
  {
    name: "wallet signal helper paths stay aligned and attribution inputs aggregate signal summaries",
    run: () => {
      const candidate = createTestCandidateWalletRow();
      const fastPathItem = buildWalletSignalItemFromSignalRow({
        candidate,
        signalRow: createTestSignalRow(),
        mmDiagnostics: null,
        pageLabels: {
          unusualSize: true,
          onPattern: false,
          hasProfileCategories: true,
          category: "crypto",
        },
        attributionPolicy: testAttributionPolicy,
      });
      const fallbackItem = buildWalletSignalItemFromTopChange({
        candidate,
        change: signalItemToTopChange(fastPathItem),
        mmDiagnostics: null,
        attributionPolicy: testAttributionPolicy,
      });
      const attributionInputs = buildWalletAttributionInputMapFromSignalItems([
        fastPathItem,
        {
          ...fallbackItem,
          marketId: "market-2",
          occurredAt: new Date("2026-01-02T13:00:00.000Z"),
        },
      ]);

      assert.equal(fallbackItem.marketId, fastPathItem.marketId);
      assert.deepEqual(fallbackItem.reasonCodes, fastPathItem.reasonCodes);
      assert.deepEqual(
        fallbackItem.displayReasons,
        fastPathItem.displayReasons,
      );
      assert.equal(fallbackItem.severity, fastPathItem.severity);
      const walletInput = attributionInputs.get("wallet-1");
      assert.deepEqual(walletInput?.topChanges, []);
      assert.equal(walletInput?.signalSummary?.criticalSignals30d, 2);
      assert.equal(walletInput?.signalSummary?.avgSignalScore30d, 0.92);
      assert.equal(walletInput?.signalSummary?.hasLateEntry, true);
      assert.equal(walletInput?.mmSuspected, false);
    },
  },
  {
    name: "signal market open-now gate requires ACTIVE unresolved with future close",
    run: () => {
      const nowMs = Date.UTC(2026, 1, 19, 12, 0, 0);
      const future = new Date(nowMs + 60_000);
      const past = new Date(nowMs - 60_000);

      const open = evaluateSignalMarketWindow(
        {
          marketStatus: "ACTIVE",
          resolvedOutcome: null,
          closeTime: future,
          expirationTime: null,
        },
        nowMs,
      );
      assert.equal(open.isOpenNow, true);
      assert.equal(open.isActiveWithInvalidClose, false);

      const missingClose = evaluateSignalMarketWindow(
        {
          marketStatus: "ACTIVE",
          resolvedOutcome: null,
          closeTime: null,
          expirationTime: null,
        },
        nowMs,
      );
      assert.equal(missingClose.isOpenNow, false);
      assert.equal(missingClose.isActiveWithInvalidClose, true);

      const pastClose = evaluateSignalMarketWindow(
        {
          marketStatus: "ACTIVE",
          resolvedOutcome: null,
          closeTime: past,
          expirationTime: null,
        },
        nowMs,
      );
      assert.equal(pastClose.isOpenNow, false);
      assert.equal(pastClose.isActiveWithInvalidClose, true);

      const resolved = evaluateSignalMarketWindow(
        {
          marketStatus: "ACTIVE",
          resolvedOutcome: "YES",
          closeTime: future,
          expirationTime: null,
        },
        nowMs,
      );
      assert.equal(resolved.isOpenNow, false);
      assert.equal(resolved.isResolved, true);
    },
  },
  {
    name: "approx pnl scenario matrix stays aligned with refresh formula semantics",
    run: () => {
      const buyHold = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: 10,
        netCost: 5,
        markPrice: 0.6,
      });
      assert.ok(Math.abs((buyHold ?? 0) - 1) < 1e-9);

      const buySell = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: 6,
        netCost: 2.8,
        markPrice: 0.6,
      });
      assert.ok(Math.abs((buySell ?? 0) - 0.8) < 1e-9);

      const resolvedWin = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: 4,
        netCost: 1.2,
        resolvedOutcome: "YES",
      });
      assert.ok(Math.abs((resolvedWin ?? 0) - 2.8) < 1e-9);

      const resolvedLoss = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: 4,
        netCost: 1.2,
        resolvedOutcome: "NO",
      });
      assert.ok(Math.abs((resolvedLoss ?? 0) + 1.2) < 1e-9);

      const clampedHigh = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: 2,
        netCost: 0.5,
        markPrice: 1.8,
      });
      assert.ok(Math.abs((clampedHigh ?? 0) - 1.5) < 1e-9);

      const clampedLow = computeApproxLegPnlUsd({
        outcomeSide: "NO",
        netShares: 3,
        netCost: 1.2,
        markPrice: -4,
      });
      assert.ok(Math.abs((clampedLow ?? 0) - 1.8) < 1e-9);

      const nearZeroNetShares = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: NET_SHARES_EPSILON / 2,
        netCost: 1,
        markPrice: 0.9,
      });
      assert.equal(nearZeroNetShares, null);
    },
  },
  {
    name: "wallet final-outcome sample actions exclude exits",
    run: () => {
      assert.equal(isWalletFinalOutcomeSampleAction("OPENED"), true);
      assert.equal(isWalletFinalOutcomeSampleAction("INCREASED"), true);
      assert.equal(isWalletFinalOutcomeSampleAction("BUY"), true);
      assert.equal(isWalletFinalOutcomeSampleAction("SELL"), false);
      assert.equal(isWalletFinalOutcomeSampleAction("REDUCED"), false);
      assert.equal(isWalletFinalOutcomeSampleAction("CLOSED"), false);
    },
  },
  {
    name: "wallet position ledger preserves remaining basis across partial sells",
    run: () => {
      const ledger = replayWalletPositionLedgerRows([
        {
          walletId: "wallet-1",
          marketId: "market-1",
          outcomeSide: "YES",
          action: "BUY",
          deltaShares: "10",
          sizeUsd: "4",
          price: "0.4",
          occurredAt: new Date("2026-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:01.000Z"),
          id: "buy-1",
        },
        {
          walletId: "wallet-1",
          marketId: "market-1",
          outcomeSide: "YES",
          action: "SELL",
          deltaShares: "5",
          sizeUsd: "3",
          price: "0.6",
          occurredAt: new Date("2026-01-02T00:00:00.000Z"),
          createdAt: new Date("2026-01-02T00:00:01.000Z"),
          id: "sell-1",
        },
      ]);

      assert.ok(Math.abs(ledger.remainingShares - 5) < 1e-9);
      assert.ok(Math.abs(ledger.remainingBasisUsd - 2) < 1e-9);
      assert.ok(Math.abs(ledger.realizedPnlUsd - 1) < 1e-9);
      assert.ok(Math.abs(ledger.realizedBasisUsd - 2) < 1e-9);

      const openEntry = resolveApproxOpenEntryFromLedger({
        ledger,
        observedPrice: 0.55,
        snapshotShares: 5,
      });
      assert.equal(openEntry.source, "activity");
      assert.equal(openEntry.approximate, false);
      assert.ok(Math.abs((openEntry.entryPrice ?? 0) - 0.4) < 1e-9);

      const openLegPnl = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: ledger.remainingShares,
        netCost: ledger.remainingBasisUsd,
        markPrice: 0.5,
      });
      assert.ok(
        Math.abs(ledger.realizedPnlUsd + (openLegPnl ?? 0) - 1.5) < 1e-9,
      );
    },
  },
  {
    name: "wallet ledger can realize profit even when final outcome loses",
    run: () => {
      const ledger = replayWalletPositionLedgerRows([
        {
          walletId: "wallet-1",
          marketId: "market-1",
          outcomeSide: "YES",
          action: "BUY",
          deltaShares: "10",
          sizeUsd: "4",
          price: "0.4",
          occurredAt: new Date("2026-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:01.000Z"),
          id: "buy-1",
        },
        {
          walletId: "wallet-1",
          marketId: "market-1",
          outcomeSide: "YES",
          action: "SELL",
          deltaShares: "10",
          sizeUsd: "6",
          price: "0.6",
          occurredAt: new Date("2026-01-02T00:00:00.000Z"),
          createdAt: new Date("2026-01-02T00:00:01.000Z"),
          id: "sell-1",
        },
      ]);

      const totals = computeWalletLedgerApproxMetricTotals([
        {
          outcomeSide: "YES",
          ledger,
          resolvedOutcome: "NO",
          yesMarkPrice: null,
        },
      ]);

      assert.ok(Math.abs(ledger.realizedPnlUsd - 2) < 1e-9);
      assert.equal(isWalletFinalOutcomeSampleAction("SELL"), false);
      assert.equal(totals.pnlUsd, 2);
    },
  },
  {
    name: "wallet ledger totals combine realized and open pnl using remaining basis",
    run: () => {
      const ledger = replayWalletPositionLedgerRows([
        {
          walletId: "wallet-1",
          marketId: "market-1",
          outcomeSide: "YES",
          action: "BUY",
          deltaShares: "10",
          sizeUsd: "4",
          price: "0.4",
          occurredAt: new Date("2026-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:01.000Z"),
          id: "buy-1",
        },
        {
          walletId: "wallet-1",
          marketId: "market-1",
          outcomeSide: "YES",
          action: "SELL",
          deltaShares: "5",
          sizeUsd: "3",
          price: "0.6",
          occurredAt: new Date("2026-01-02T00:00:00.000Z"),
          createdAt: new Date("2026-01-02T00:00:01.000Z"),
          id: "sell-1",
        },
      ]);

      const totals = computeWalletLedgerApproxMetricTotals([
        {
          outcomeSide: "YES",
          ledger,
          yesMarkPrice: 0.5,
        },
      ]);

      assert.equal(totals.approximate, false);
      assert.equal(totals.unmarkedOpenLegCount, 0);
      assert.ok(Math.abs((totals.costBasisUsd ?? 0) - 4) < 1e-9);
      assert.ok(Math.abs((totals.pnlUsd ?? 0) - 1.5) < 1e-9);
    },
  },
  {
    name: "wallet ledger totals flag missing open marks but keep realized pnl",
    run: () => {
      const ledger = replayWalletPositionLedgerRows([
        {
          walletId: "wallet-1",
          marketId: "market-1",
          outcomeSide: "NO",
          action: "BUY",
          deltaShares: "4",
          sizeUsd: "2.4",
          price: "0.6",
          occurredAt: new Date("2026-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:01.000Z"),
          id: "buy-1",
        },
        {
          walletId: "wallet-1",
          marketId: "market-1",
          outcomeSide: "NO",
          action: "SELL",
          deltaShares: "1",
          sizeUsd: "0.8",
          price: "0.8",
          occurredAt: new Date("2026-01-02T00:00:00.000Z"),
          createdAt: new Date("2026-01-02T00:00:01.000Z"),
          id: "sell-1",
        },
      ]);

      const totals = computeWalletLedgerApproxMetricTotals([
        {
          outcomeSide: "NO",
          ledger,
          yesMarkPrice: null,
        },
      ]);

      assert.equal(totals.approximate, true);
      assert.equal(totals.unmarkedOpenLegCount, 1);
      assert.ok(Math.abs((totals.costBasisUsd ?? 0) - 0.6) < 1e-9);
      assert.ok(Math.abs((totals.pnlUsd ?? 0) - 0.2) < 1e-9);
    },
  },
  {
    name: "resolved outcome pct mark parity prefers scalar payout over live mark",
    run: () => {
      const yesPrice = resolveApproxYesMarkPrice({
        resolvedOutcome: null,
        resolvedOutcomePct: 2500,
        markPrice: 0.91,
      });

      assert.ok(Math.abs((yesPrice ?? 0) - 0.25) < 1e-9);

      const yesPnl = computeApproxLegPnlUsd({
        outcomeSide: "YES",
        netShares: 10,
        netCost: 4,
        markPrice: yesPrice,
      });
      const noPnl = computeApproxLegPnlUsd({
        outcomeSide: "NO",
        netShares: 10,
        netCost: 4,
        markPrice: yesPrice,
      });

      assert.ok(Math.abs((yesPnl ?? 0) - -1.5) < 1e-9);
      assert.ok(Math.abs((noPnl ?? 0) - 3.5) < 1e-9);
    },
  },
  {
    name: "30d metric builder emits fresh zero-activity rows for dormant wallets",
    run: () => {
      const metrics = buildWalletThirtyDayMetricsUpsertRows({
        walletIds: ["wallet-active", "wallet-dormant"],
        aggregates: [
          {
            walletId: "wallet-active",
            tradesCount: 3,
            volumeUsd: 125,
            lastTradeAt: new Date("2026-03-01T00:00:00.000Z"),
            resolvedCount: 2,
            winningCount: 1,
          },
        ],
        ledgersByWallet: new Map(),
        marketMarksById: new Map(),
      });

      assert.equal(metrics.rows.length, 2);

      const active = metrics.rows.find(
        (row) => row.walletId === "wallet-active",
      );
      const dormant = metrics.rows.find(
        (row) => row.walletId === "wallet-dormant",
      );

      assert.ok(active);
      assert.equal(active?.tradesCount, 3);
      assert.equal(active?.volumeUsd, 125);
      assert.ok(active?.lastTradeAt instanceof Date);

      assert.ok(dormant);
      assert.equal(dormant?.tradesCount, 0);
      assert.equal(dormant?.volumeUsd, 0);
      assert.equal(dormant?.pnlUsd, null);
      assert.equal(dormant?.roi, null);
      assert.equal(dormant?.winRate, null);
      assert.equal(dormant?.lastTradeAt, null);
    },
  },
  {
    name: "30d metric builder computes resolved edge metrics from entry odds",
    run: () => {
      const yesLedger = replayWalletPositionLedgerRows([
        {
          walletId: "wallet-edge",
          marketId: "market-yes",
          outcomeSide: "YES",
          action: "BUY",
          deltaShares: "100",
          sizeUsd: "40",
          price: "0.4",
          occurredAt: new Date("2026-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:01.000Z"),
          id: "edge-buy-yes",
        },
      ]);
      const noLedger = replayWalletPositionLedgerRows([
        {
          walletId: "wallet-edge",
          marketId: "market-no",
          outcomeSide: "NO",
          action: "BUY",
          deltaShares: "100",
          sizeUsd: "70",
          price: "0.7",
          occurredAt: new Date("2026-01-02T00:00:00.000Z"),
          createdAt: new Date("2026-01-02T00:00:01.000Z"),
          id: "edge-buy-no",
        },
      ]);
      const marketMarksById = new Map([
        [
          "market-yes",
          {
            resolvedOutcome: "YES",
            yesMarkPrice: 1,
            resolvedYesPayout: 1,
          },
        ],
        [
          "market-no",
          {
            resolvedOutcome: "YES",
            yesMarkPrice: 1,
            resolvedYesPayout: 1,
          },
        ],
      ]);

      const edge = computeWalletResolvedEdgeMetrics(
        [
          {
            marketId: "market-yes",
            outcomeSide: "YES",
            ledger: yesLedger,
          },
          {
            marketId: "market-no",
            outcomeSide: "NO",
            ledger: noLedger,
          },
        ],
        marketMarksById,
      );

      assert.equal(edge.sampleCount, 2);
      assert.ok(Math.abs((edge.actualWinRate ?? 0) - 0.5) < 1e-9);
      assert.ok(Math.abs((edge.expectedWinRate ?? 0) - 0.55) < 1e-9);
      assert.ok(Math.abs((edge.winRateEdge ?? 0) - -0.05) < 1e-9);
      assert.ok(Math.abs((edge.brierScore ?? 0) - 0.425) < 1e-9);
      assert.ok(Math.abs((edge.resolvedStakeUsd ?? 0) - 110) < 1e-9);

      const metrics = buildWalletThirtyDayMetricsUpsertRows({
        walletIds: ["wallet-edge"],
        aggregates: [
          {
            walletId: "wallet-edge",
            tradesCount: 2,
            volumeUsd: 110,
            lastTradeAt: new Date("2026-01-02T00:00:00.000Z"),
            resolvedCount: 2,
            winningCount: 1,
          },
        ],
        ledgersByWallet: new Map([
          [
            "wallet-edge",
            [
              {
                marketId: "market-yes",
                outcomeSide: "YES",
                ledger: yesLedger,
              },
              {
                marketId: "market-no",
                outcomeSide: "NO",
                ledger: noLedger,
              },
            ],
          ],
        ]),
        marketMarksById,
      });

      assert.equal(metrics.rows[0]?.resolvedEdgeSampleCount, 2);
      assert.ok(
        Math.abs((metrics.rows[0]?.resolvedExpectedWinRate ?? 0) - 0.55) < 1e-9,
      );
      assert.ok(
        Math.abs(
          (metrics.rows[0]?.resolvedStakeWeightedEdge ?? 0) - -25 / 110,
        ) < 1e-9,
      );
    },
  },
  {
    name: "30d metric builder preserves null volume for unresolved aggregates",
    run: () => {
      const metrics = buildWalletThirtyDayMetricsUpsertRows({
        walletIds: ["wallet-unknown-volume"],
        aggregates: [
          {
            walletId: "wallet-unknown-volume",
            tradesCount: 2,
            volumeUsd: null,
            lastTradeAt: new Date("2026-03-01T00:00:00.000Z"),
            resolvedCount: 0,
            winningCount: 0,
          },
        ],
        ledgersByWallet: new Map(),
        marketMarksById: new Map(),
      });

      assert.equal(metrics.rows.length, 1);
      assert.equal(metrics.rows[0]?.tradesCount, 2);
      assert.equal(metrics.rows[0]?.volumeUsd, null);
      assert.ok(metrics.rows[0]?.lastTradeAt instanceof Date);
    },
  },
  {
    name: "wallet open entry falls back to snapshot when ledger no longer reconciles to current shares",
    run: () => {
      const ledger = replayWalletPositionLedgerRows([
        {
          walletId: "wallet-1",
          marketId: "market-1",
          outcomeSide: "YES",
          action: "BUY",
          deltaShares: "10",
          sizeUsd: "4",
          price: "0.4",
          occurredAt: new Date("2026-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:01.000Z"),
          id: "buy-1",
        },
      ]);

      const fallback = resolveApproxOpenEntryFromLedger({
        ledger,
        observedPrice: 0.63,
        snapshotShares: 7,
      });

      assert.equal(fallback.source, "snapshot");
      assert.equal(fallback.approximate, true);
      assert.ok(Math.abs((fallback.entryPrice ?? 0) - 0.63) < 1e-9);
    },
  },
  {
    name: "robust unusual score requires baseline sample gate and p90 denominator",
    run: () => {
      const blockedBySamples = computeRobustUnusualScore({
        maxAbsDeltaUsd: 5000,
        baselineP90Usd: 250,
        baselineSampleCount: DEFAULT_MIN_UNUSUAL_BASELINE_SAMPLES - 1,
      });
      assert.equal(blockedBySamples, null);

      const missingBaseline = computeRobustUnusualScore({
        maxAbsDeltaUsd: 5000,
        baselineP90Usd: null,
        baselineSampleCount: DEFAULT_MIN_UNUSUAL_BASELINE_SAMPLES + 10,
      });
      assert.equal(missingBaseline, null);

      const score = computeRobustUnusualScore({
        maxAbsDeltaUsd: 5000,
        baselineP90Usd: 250,
        baselineSampleCount: DEFAULT_MIN_UNUSUAL_BASELINE_SAMPLES,
      });
      assert.equal(score, 20);
    },
  },
  {
    name: "unusual tiers map to stable label boundaries",
    run: () => {
      assert.equal(resolveUnusualTier(null), null);
      assert.equal(resolveUnusualTier(1.99), null);
      assert.equal(resolveUnusualTier(2), "unusual");
      assert.equal(resolveUnusualTier(4.99), "unusual");
      assert.equal(resolveUnusualTier(5), "very_unusual");
      assert.equal(resolveUnusualTier(9.99), "very_unusual");
      assert.equal(resolveUnusualTier(10), "extreme");
    },
  },
  {
    name: "outcome side normalization preserves YES/NO and maps empty to null contract",
    run: () => {
      assert.equal(normalizeOutcomeSideForStorage("YES"), "YES");
      assert.equal(normalizeOutcomeSideForStorage("no"), "NO");
      assert.equal(normalizeOutcomeSideForStorage(""), "");
      assert.equal(normalizeOutcomeSideForStorage(null), "");
      assert.equal(normalizeOutcomeSideForApi(""), null);
      assert.equal(normalizeOutcomeSideForApi("YES"), "YES");
      assert.equal(normalizeOutcomeSideForApi("NO"), "NO");
    },
  },
  {
    name: "legacy blank-side transition suppresses first side-safe delta generation",
    run: () => {
      assert.equal(
        shouldSuppressLegacySideTransitionDelta({
          currentRows: [{ outcome_side: "YES" }, { outcome_side: "NO" }],
          previousRows: [{ outcome_side: "" }],
        }),
        true,
      );
      assert.equal(
        shouldSuppressLegacySideTransitionDelta({
          currentRows: [{ outcome_side: "YES" }],
          previousRows: [{ outcome_side: "YES" }],
        }),
        false,
      );
      assert.equal(
        shouldSuppressLegacySideTransitionDelta({
          currentRows: [{ outcome_side: "YES" }],
          previousRows: [{ outcome_side: "" }, { outcome_side: "YES" }],
        }),
        false,
      );
    },
  },
  {
    name: "mm helper uses hedge ratio, two-sided markets, and whale threshold gate",
    run: () => {
      const refreshPolicy = {
        whaleUsd: 100_000,
        whaleUsdSolana: 50_000,
      };
      assert.equal(
        computeMmSuspected({
          hedgeRatio: MM_HEDGE_RATIO_MIN,
          hedgedNotionalUsd: 0,
          twoSidedMarkets: MM_TWO_SIDED_MARKETS_MIN,
          exposureUsd: 100_000,
          chain: "polygon",
          refreshPolicy,
        }),
        true,
      );
      assert.equal(
        computeMmSuspected({
          hedgeRatio: MM_HEDGE_RATIO_MIN - 0.01,
          hedgedNotionalUsd: 0,
          twoSidedMarkets: MM_TWO_SIDED_MARKETS_MIN,
          exposureUsd: 100_000,
          chain: "polygon",
          refreshPolicy,
        }),
        false,
      );
      assert.equal(
        computeMmSuspected({
          hedgeRatio: MM_MATERIAL_HEDGE_RATIO_MIN,
          hedgedNotionalUsd: MM_MATERIAL_HEDGED_NOTIONAL_USD_MIN,
          twoSidedMarkets: 2,
          exposureUsd: 100_000,
          chain: "polygon",
          refreshPolicy,
        }),
        true,
      );
      assert.equal(
        computeMmSuspected({
          hedgeRatio: MM_MATERIAL_HEDGE_RATIO_MIN,
          hedgedNotionalUsd: MM_LARGE_SINGLE_MARKET_HEDGED_USD_MIN,
          twoSidedMarkets: 1,
          exposureUsd: 100_000,
          chain: "polygon",
          refreshPolicy,
        }),
        true,
      );
      assert.equal(
        computeMmSuspected({
          hedgeRatio: 0.99,
          hedgedNotionalUsd: 100,
          twoSidedMarkets: 10,
          exposureUsd: 100,
          chain: "polygon",
          refreshPolicy,
        }),
        false,
      );
      const diagnostics = buildWalletMmDiagnostics({
        exposureUsd: 120_000,
        hedgedNotionalUsd: 90_000,
        netImbalanceUsd: 30_000,
        hedgeRatio: 0.75,
        twoSidedMarkets: 4,
        chain: "polygon",
        refreshPolicy,
      });
      assert.equal(diagnostics.mmSuspected, true);
      assert.equal(diagnostics.thresholds.exposureUsdMin, 100_000);
      assert.equal(
        diagnostics.thresholds.materialHedgedNotionalUsdMin,
        MM_MATERIAL_HEDGED_NOTIONAL_USD_MIN,
      );
    },
  },
  {
    name: "retry helpers parse Retry-After and retryable statuses safely",
    run: () => {
      assert.equal(parseRetryAfterMs("2", 0), 2000);
      assert.equal(
        parseRetryAfterMs("Thu, 01 Jan 1970 00:00:03 GMT", 1000),
        2000,
      );
      assert.equal(isRetryableHttpStatus(429), true);
      assert.equal(isRetryableHttpStatus(503), true);
      assert.equal(isRetryableHttpStatus(404), false);
    },
  },
  {
    name: "polygon rpc retries HTTP 429 before succeeding",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const originalMaxAttempts = env.walletIntelRetryMaxAttempts;
      const originalBaseBackoff = env.walletIntelRetryBaseBackoffMs;
      const originalMaxBackoff = env.walletIntelRetryMaxBackoffMs;

      env.walletIntelRetryMaxAttempts = 2;
      env.walletIntelRetryBaseBackoffMs = 1;
      env.walletIntelRetryMaxBackoffMs = 1;

      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("rate limited", {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "retry-after": "0" },
          });
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2a" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      };

      try {
        const balance = await fetchEvmBalance({
          rpcUrl: "https://polygon.example",
          timeoutMs: 100,
          address: "0x0000000000000000000000000000000000000001",
        });

        assert.equal(balance, 42n);
        assert.equal(calls, 2);
      } finally {
        globalThis.fetch = originalFetch;
        env.walletIntelRetryMaxAttempts = originalMaxAttempts;
        env.walletIntelRetryBaseBackoffMs = originalBaseBackoff;
        env.walletIntelRetryMaxBackoffMs = originalMaxBackoff;
      }
    },
  },
  {
    name: "polygon rpc retries rate-limit JSON-RPC errors before succeeding",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const originalMaxAttempts = env.walletIntelRetryMaxAttempts;
      const originalBaseBackoff = env.walletIntelRetryBaseBackoffMs;
      const originalMaxBackoff = env.walletIntelRetryMaxBackoffMs;

      env.walletIntelRetryMaxAttempts = 2;
      env.walletIntelRetryBaseBackoffMs = 1;
      env.walletIntelRetryMaxBackoffMs = 1;

      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { message: "too many requests" },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2b" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      };

      try {
        const balance = await fetchEvmBalance({
          rpcUrl: "https://polygon.example",
          timeoutMs: 100,
          address: "0x0000000000000000000000000000000000000001",
        });

        assert.equal(balance, 43n);
        assert.equal(calls, 2);
      } finally {
        globalThis.fetch = originalFetch;
        env.walletIntelRetryMaxAttempts = originalMaxAttempts;
        env.walletIntelRetryBaseBackoffMs = originalBaseBackoff;
        env.walletIntelRetryMaxBackoffMs = originalMaxBackoff;
      }
    },
  },
  {
    name: "wallet activity signals query parses false boolean strings safely",
    run: () => {
      const defaults = walletActivitySignalsQuerySchema.parse({});
      assert.equal(defaults.excludeMmLike, false);
      assert.equal(defaults.includeAttribution, false);

      const parsedFalse = walletActivitySignalsQuerySchema.parse({
        excludeMmLike: "false",
        includeAttribution: "false",
      });
      assert.equal(parsedFalse.excludeMmLike, false);
      assert.equal(parsedFalse.includeAttribution, false);

      const parsedTrue = walletActivitySignalsQuerySchema.parse({
        excludeMmLike: "true",
        includeAttribution: "1",
      });
      assert.equal(parsedTrue.excludeMmLike, true);
      assert.equal(parsedTrue.includeAttribution, true);
    },
  },
  {
    name: "wallet positions query parses includeSmall and display cutoffs safely",
    run: () => {
      const defaults = walletPositionsQuerySchema.parse({});
      assert.equal(defaults.includeSmall, false);
      assert.equal(defaults.minPositionUsd, undefined);
      assert.equal(defaults.minPositionShares, undefined);

      const parsedTrue = walletPositionsQuerySchema.parse({
        includeSmall: "true",
        minPositionShares: "0.001",
        minPositionUsd: "0.10",
      });
      assert.equal(parsedTrue.includeSmall, true);
      assert.equal(parsedTrue.minPositionShares, 0.001);
      assert.equal(parsedTrue.minPositionUsd, 0.1);

      const parsedFalse = walletPositionsQuerySchema.parse({
        includeSmall: "0",
      });
      assert.equal(parsedFalse.includeSmall, false);

      assert.throws(() =>
        walletPositionsQuerySchema.parse({
          minPositionUsd: "-0.01",
        }),
      );

      const parsedHistory = walletPositionHistoryQuerySchema.parse({
        walletId: "11111111-1111-4111-8111-111111111111",
        includeSmall: "false",
        minPositionShares: "2",
        minPositionUsd: "0.10",
      });
      assert.equal(parsedHistory.includeSmall, false);
      assert.equal(parsedHistory.minPositionShares, 2);
      assert.equal(parsedHistory.minPositionUsd, 0.1);
    },
  },
  {
    name: "market holder fetch degrades alchemy failures without losing token metadata",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const originalAlchemyBaseUrl = env.alchemyBaseNftBaseUrl;
      const originalLimitlessContract = env.limitlessConditionalTokensAddress;

      env.alchemyBaseNftBaseUrl = "https://alchemy.example";
      env.limitlessConditionalTokensAddress = "0xlimitless";

      let fetchCalls = 0;
      globalThis.fetch = async (input: string | URL | Request) => {
        fetchCalls += 1;
        const url = String(input);
        if (!url.includes("getOwnersForNFT")) {
          throw new Error(`unexpected fetch url: ${url}`);
        }
        throw new Error("transient alchemy failure");
      };

      let queryCount = 0;
      const client = {
        query: async () => {
          queryCount += 1;
          if (queryCount === 1) {
            return {
              rows: [
                {
                  id: "limitless:market-1",
                  venue: "limitless",
                  title: "Test market",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  condition_id: null,
                  token_yes: "limitless:yes-token",
                  token_no: "limitless:no-token",
                  clob_token_ids: null,
                  best_bid: "0.60",
                  best_ask: "0.70",
                  last_price: "0.65",
                },
              ],
            };
          }
          if (queryCount === 2) {
            return {
              rows: [
                { token_id: "limitless:yes-token", side: "YES" },
                { token_id: "limitless:no-token", side: "NO" },
              ],
            };
          }
          if (queryCount === 3) {
            return { rows: [] };
          }
          if (queryCount === 4) {
            return { rows: [] };
          }
          throw new Error(`unexpected query count: ${queryCount}`);
        },
      };

      try {
        const result = await fetchMarketHolderData({
          marketId: "limitless:market-1",
          limit: 10,
          client: client as never,
        });

        assert.equal(fetchCalls, 2);
        assert.deepEqual(result.tokenIdsBySide, {
          YES: "limitless:yes-token",
          NO: "limitless:no-token",
        });
        assert.equal(result.source, "unavailable");
        assert.deepEqual(result.holders, []);
        assert.ok(Math.abs((result.priceBySide.YES ?? 0) - 0.65) < 1e-9);
        assert.ok(Math.abs((result.priceBySide.NO ?? 0) - 0.35) < 1e-9);
      } finally {
        globalThis.fetch = originalFetch;
        env.alchemyBaseNftBaseUrl = originalAlchemyBaseUrl;
        env.limitlessConditionalTokensAddress = originalLimitlessContract;
      }
    },
  },
  {
    name: "market holder fetch rejects partial alchemy side coverage",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const originalAlchemyBaseUrl = env.alchemyBaseNftBaseUrl;
      const originalLimitlessContract = env.limitlessConditionalTokensAddress;

      env.alchemyBaseNftBaseUrl = "https://alchemy.example";
      env.limitlessConditionalTokensAddress = "0xlimitless";

      globalThis.fetch = async (input: string | URL | Request) => {
        const url = String(input);
        if (!url.includes("getOwnersForNFT")) {
          throw new Error(`unexpected fetch url: ${url}`);
        }
        if (url.includes("tokenId=yes-token")) {
          throw new Error("transient alchemy failure");
        }
        return new Response(
          JSON.stringify({
            owners: [
              {
                ownerAddress: "0xabc",
                tokenBalances: [{ balance: "2" }],
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      };

      let queryCount = 0;
      const client = {
        query: async () => {
          queryCount += 1;
          if (queryCount === 1) {
            return {
              rows: [
                {
                  id: "limitless:market-1",
                  venue: "limitless",
                  title: "Test market",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  condition_id: null,
                  token_yes: "limitless:yes-token",
                  token_no: "limitless:no-token",
                  clob_token_ids: null,
                  best_bid: "0.60",
                  best_ask: "0.70",
                  last_price: "0.65",
                },
              ],
            };
          }
          if (queryCount === 2) {
            return {
              rows: [
                { token_id: "limitless:yes-token", side: "YES" },
                { token_id: "limitless:no-token", side: "NO" },
              ],
            };
          }
          if (queryCount === 3 || queryCount === 4) {
            return { rows: [] };
          }
          throw new Error(`unexpected query count: ${queryCount}`);
        },
      };

      try {
        const result = await fetchMarketHolderData({
          marketId: "limitless:market-1",
          limit: 10,
          client: client as never,
        });

        assert.equal(result.source, "unavailable");
        assert.deepEqual(result.holders, []);
        assert.deepEqual(result.tokenIdsBySide, {
          YES: "limitless:yes-token",
          NO: "limitless:no-token",
        });
      } finally {
        globalThis.fetch = originalFetch;
        env.alchemyBaseNftBaseUrl = originalAlchemyBaseUrl;
        env.limitlessConditionalTokensAddress = originalLimitlessContract;
      }
    },
  },
  {
    name: "market holder fetch verifies Limitless Alchemy owners with Base balances",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const originalAlchemyBaseUrl = env.alchemyBaseNftBaseUrl;
      const originalLimitlessContract = env.limitlessConditionalTokensAddress;
      const originalBaseRpcUrl = env.baseRpcUrl;
      const originalBaseRpcTimeoutMs = env.baseRpcTimeoutMs;

      const ownerA = "0x1111111111111111111111111111111111111111";
      const ownerB = "0x2222222222222222222222222222222222222222";
      const ownerC = "0x3333333333333333333333333333333333333333";
      const balanceIface = new Interface([
        "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
      ]);

      env.alchemyBaseNftBaseUrl = "https://alchemy.example";
      env.limitlessConditionalTokensAddress =
        "0xc9c98965297bc527861c898329ee280632b76e18";
      env.baseRpcUrl = "https://base-rpc.example";
      env.baseRpcTimeoutMs = 1_000;

      let alchemyCalls = 0;
      let baseRpcCalls = 0;
      globalThis.fetch = async (input: string | URL | Request, init) => {
        const url = String(input);
        if (url.includes("getOwnersForNFT")) {
          alchemyCalls += 1;
          const tokenId = new URL(url).searchParams.get("tokenId");
          const owners =
            tokenId === "111"
              ? [
                  { ownerAddress: ownerA },
                  { ownerAddress: ownerB },
                  { ownerAddress: ownerA },
                ]
              : [{ ownerAddress: ownerA }, { ownerAddress: ownerC }];
          return new Response(JSON.stringify({ owners }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (url === "https://base-rpc.example") {
          baseRpcCalls += 1;
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            id?: number;
            params?: Array<{ data?: string }>;
          };
          const data = body.params?.[0]?.data;
          assert.ok(data);
          const decoded = balanceIface.decodeFunctionData(
            "balanceOfBatch",
            data,
          );
          const accounts = decoded[0] as string[];
          const ids = decoded[1] as bigint[];
          const balances = accounts.map((account, index) => {
            const key = `${account.toLowerCase()}:${ids[index]?.toString()}`;
            if (key === `${ownerA.toLowerCase()}:111`) return 2_500_000n;
            if (key === `${ownerA.toLowerCase()}:222`) return 1_750_000n;
            if (key === `${ownerC.toLowerCase()}:222`) return 500_000n;
            return 0n;
          });
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: balanceIface.encodeFunctionResult("balanceOfBatch", [
                balances,
              ]),
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        throw new Error(`unexpected fetch url: ${url}`);
      };

      let queryCount = 0;
      const client = {
        query: async () => {
          queryCount += 1;
          if (queryCount === 1) {
            return {
              rows: [
                {
                  id: "limitless:market-1",
                  venue: "limitless",
                  title: "Test market",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  condition_id: null,
                  token_yes: "limitless:111",
                  token_no: "limitless:222",
                  clob_token_ids: null,
                  best_bid: "0.60",
                  best_ask: "0.70",
                  last_price: "0.65",
                },
              ],
            };
          }
          if (queryCount === 2) {
            return {
              rows: [
                { token_id: "limitless:111", side: "YES" },
                { token_id: "limitless:222", side: "NO" },
              ],
            };
          }
          if (queryCount === 3) {
            return {
              rows: [
                {
                  token_id: "limitless:111",
                  best_bid: "0.50",
                  best_ask: "0.70",
                },
                {
                  token_id: "limitless:222",
                  best_bid: "0.25",
                  best_ask: "0.35",
                },
              ],
            };
          }
          throw new Error(`unexpected query count: ${queryCount}`);
        },
      };

      try {
        const result = await fetchMarketHolderData({
          marketId: "limitless:market-1",
          limit: 10,
          client: client as never,
        });

        assert.equal(alchemyCalls, 2);
        assert.equal(baseRpcCalls, 1);
        assert.equal(result.source, "alchemy");
        assert.deepEqual(result.holders, [
          { wallet: ownerA, side: "YES", shares: 2.5 },
          { wallet: ownerA, side: "NO", shares: 1.75 },
          { wallet: ownerC, side: "NO", shares: 0.5 },
        ]);
      } finally {
        globalThis.fetch = originalFetch;
        env.alchemyBaseNftBaseUrl = originalAlchemyBaseUrl;
        env.limitlessConditionalTokensAddress = originalLimitlessContract;
        env.baseRpcUrl = originalBaseRpcUrl;
        env.baseRpcTimeoutMs = originalBaseRpcTimeoutMs;
      }
    },
  },
  {
    name: "market holder batch verifies Limitless holders in one sparse Base balance pass",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const originalAlchemyBaseUrl = env.alchemyBaseNftBaseUrl;
      const originalLimitlessContract = env.limitlessConditionalTokensAddress;
      const originalBaseRpcUrl = env.baseRpcUrl;
      const originalBaseRpcTimeoutMs = env.baseRpcTimeoutMs;

      const ownerA = "0x1111111111111111111111111111111111111111";
      const ownerB = "0x2222222222222222222222222222222222222222";
      const ownerC = "0x3333333333333333333333333333333333333333";
      const ownerD = "0x4444444444444444444444444444444444444444";
      const zeroOwner = "0x0000000000000000000000000000000000000000";
      const balanceIface = new Interface([
        "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
      ]);

      env.alchemyBaseNftBaseUrl = "https://alchemy.example";
      env.limitlessConditionalTokensAddress =
        "0xc9c98965297bc527861c898329ee280632b76e18";
      env.baseRpcUrl = "https://base-rpc.example";
      env.baseRpcTimeoutMs = 1_000;

      let alchemyCalls = 0;
      let baseRpcCalls = 0;
      globalThis.fetch = async (input: string | URL | Request, init) => {
        const url = String(input);
        if (url.includes("getOwnersForNFT")) {
          alchemyCalls += 1;
          const tokenId = new URL(url).searchParams.get("tokenId");
          const ownersByToken: Record<string, unknown[]> = {
            "111": [
              { ownerAddress: ownerA },
              { ownerAddress: zeroOwner },
              { ownerAddress: ownerB },
            ],
            "222": [{ ownerAddress: ownerA }, { ownerAddress: ownerC }],
            "333": [{ ownerAddress: ownerB }],
            "444": [{ ownerAddress: zeroOwner }, { ownerAddress: ownerD }],
          };
          return new Response(
            JSON.stringify({ owners: ownersByToken[tokenId ?? ""] ?? [] }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        if (url === "https://base-rpc.example") {
          baseRpcCalls += 1;
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            id?: number;
            params?: Array<{ data?: string }>;
          };
          const data = body.params?.[0]?.data;
          assert.ok(data);
          const decoded = balanceIface.decodeFunctionData(
            "balanceOfBatch",
            data,
          );
          const accounts = decoded[0] as string[];
          const ids = decoded[1] as bigint[];
          assert.equal(
            accounts.some(
              (account) => account.toLowerCase() === zeroOwner.toLowerCase(),
            ),
            false,
          );
          const balances = accounts.map((account, index) => {
            const key = `${account.toLowerCase()}:${ids[index]?.toString()}`;
            if (key === `${ownerA.toLowerCase()}:111`) return 2_500_000n;
            if (key === `${ownerA.toLowerCase()}:222`) return 1_750_000n;
            if (key === `${ownerB.toLowerCase()}:333`) return 3_000_000n;
            if (key === `${ownerD.toLowerCase()}:444`) return 250_000n;
            return 0n;
          });
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: balanceIface.encodeFunctionResult("balanceOfBatch", [
                balances,
              ]),
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        throw new Error(`unexpected fetch url: ${url}`);
      };

      let queryCount = 0;
      const client = {
        query: async () => {
          queryCount += 1;
          if (queryCount === 1) {
            return {
              rows: [
                {
                  id: "limitless:market-1",
                  venue: "limitless",
                  title: "Test market 1",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  condition_id: null,
                  token_yes: "limitless:111",
                  token_no: "limitless:222",
                  clob_token_ids: null,
                  best_bid: "0.60",
                  best_ask: "0.70",
                  last_price: "0.65",
                },
                {
                  id: "limitless:market-2",
                  venue: "limitless",
                  title: "Test market 2",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  condition_id: null,
                  token_yes: "limitless:333",
                  token_no: "limitless:444",
                  clob_token_ids: null,
                  best_bid: "0.40",
                  best_ask: "0.50",
                  last_price: "0.45",
                },
              ],
            };
          }
          if (queryCount === 2) {
            return {
              rows: [
                {
                  market_id: "limitless:market-1",
                  token_id: "limitless:111",
                  side: "YES",
                },
                {
                  market_id: "limitless:market-1",
                  token_id: "limitless:222",
                  side: "NO",
                },
                {
                  market_id: "limitless:market-2",
                  token_id: "limitless:333",
                  side: "YES",
                },
                {
                  market_id: "limitless:market-2",
                  token_id: "limitless:444",
                  side: "NO",
                },
              ],
            };
          }
          if (queryCount === 3) {
            return {
              rows: [
                {
                  token_id: "limitless:111",
                  best_bid: "0.50",
                  best_ask: "0.70",
                },
                {
                  token_id: "limitless:222",
                  best_bid: "0.25",
                  best_ask: "0.35",
                },
                {
                  token_id: "limitless:333",
                  best_bid: "0.30",
                  best_ask: "0.40",
                },
                {
                  token_id: "limitless:444",
                  best_bid: "0.55",
                  best_ask: "0.65",
                },
              ],
            };
          }
          throw new Error(`unexpected query count: ${queryCount}`);
        },
      };

      try {
        const results = await fetchMarketHolderDataBatch({
          markets: [
            { id: "limitless:market-1", venue: "limitless" },
            { id: "limitless:market-2", venue: "limitless" },
          ],
          limit: 10,
          client: client as never,
          marketFetchConcurrency: 2,
        });

        assert.equal(alchemyCalls, 4);
        assert.equal(baseRpcCalls, 1);
        assert.equal(results[0]?.data?.source, "alchemy");
        assert.equal(results[1]?.data?.source, "alchemy");
        assert.deepEqual(results[0]?.data?.holders, [
          { wallet: ownerA, side: "YES", shares: 2.5 },
          { wallet: ownerA, side: "NO", shares: 1.75 },
        ]);
        assert.deepEqual(results[1]?.data?.holders, [
          { wallet: ownerB, side: "YES", shares: 3 },
          { wallet: ownerD, side: "NO", shares: 0.25 },
        ]);
      } finally {
        globalThis.fetch = originalFetch;
        env.alchemyBaseNftBaseUrl = originalAlchemyBaseUrl;
        env.limitlessConditionalTokensAddress = originalLimitlessContract;
        env.baseRpcUrl = originalBaseRpcUrl;
        env.baseRpcTimeoutMs = originalBaseRpcTimeoutMs;
      }
    },
  },
  {
    name: "market holder fetch rejects partial solana side coverage",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const originalSolanaRpcUrls = env.solanaRpcUrls;
      const originalSolanaRpcTimeoutMs = env.solanaRpcTimeoutMs;

      env.solanaRpcUrls = ["https://solana.example"];
      env.solanaRpcTimeoutMs = 1_000;

      globalThis.fetch = async (_input, init) => {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const method = body?.method;
        const params = body?.params;
        if (
          method === "getTokenLargestAccounts" &&
          params?.[0] === "mint-yes"
        ) {
          return new Response("rpc failure", {
            status: 500,
            statusText: "Internal Server Error",
          });
        }
        if (method === "getTokenLargestAccounts" && params?.[0] === "mint-no") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                value: [
                  {
                    address: "acct-no",
                    amount: "1000",
                    decimals: 3,
                    uiAmountString: "1",
                  },
                ],
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (method === "getMultipleAccounts") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                value: [
                  {
                    data: {
                      parsed: {
                        info: {
                          owner: "owner-no",
                        },
                      },
                    },
                  },
                ],
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        throw new Error(`unexpected solana rpc method: ${String(method)}`);
      };

      let queryCount = 0;
      const client = {
        query: async () => {
          queryCount += 1;
          if (queryCount === 1) {
            return {
              rows: [
                {
                  id: "kalshi:market-1",
                  venue: "kalshi",
                  title: "Test market",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  condition_id: null,
                  token_yes: "mint-yes",
                  token_no: "mint-no",
                  clob_token_ids: null,
                  best_bid: "0.45",
                  best_ask: "0.55",
                  last_price: "0.5",
                },
              ],
            };
          }
          if (queryCount === 2) {
            return {
              rows: [
                { token_id: "mint-yes", side: "YES" },
                { token_id: "mint-no", side: "NO" },
              ],
            };
          }
          if (queryCount === 3 || queryCount === 4) {
            return { rows: [] };
          }
          throw new Error(`unexpected query count: ${queryCount}`);
        },
      };

      try {
        const result = await fetchMarketHolderData({
          marketId: "kalshi:market-1",
          limit: 10,
          client: client as never,
        });

        assert.equal(result.source, "unavailable");
        assert.deepEqual(result.holders, []);
        assert.deepEqual(result.tokenIdsBySide, {
          YES: "mint-yes",
          NO: "mint-no",
        });
      } finally {
        globalThis.fetch = originalFetch;
        env.solanaRpcUrls = originalSolanaRpcUrls;
        env.solanaRpcTimeoutMs = originalSolanaRpcTimeoutMs;
      }
    },
  },
  {
    name: "market holder batch resolves Kalshi largest accounts with one owner lookup",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const originalSolanaRpcUrls = env.solanaRpcUrls;
      const originalSolanaRpcTimeoutMs = env.solanaRpcTimeoutMs;

      env.solanaRpcUrls = ["https://solana.example"];
      env.solanaRpcTimeoutMs = 1_000;

      let largestCalls = 0;
      let ownerLookupCalls = 0;
      globalThis.fetch = async (_input, init) => {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const method = body?.method;
        const params = body?.params;

        if (method === "getTokenLargestAccounts") {
          largestCalls += 1;
          const mint = String(params?.[0] ?? "");
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                value: [
                  {
                    address: `acct-${mint}`,
                    amount: "2000",
                    decimals: 3,
                    uiAmountString: "2",
                  },
                ],
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        if (method === "getMultipleAccounts") {
          ownerLookupCalls += 1;
          const accounts = Array.isArray(params?.[0]) ? params[0] : [];
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                value: accounts.map((account: string) => ({
                  data: {
                    parsed: {
                      info: {
                        owner: `owner-${account}`,
                      },
                    },
                  },
                })),
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        throw new Error(`unexpected solana rpc method: ${String(method)}`);
      };

      let queryCount = 0;
      const client = {
        query: async () => {
          queryCount += 1;
          if (queryCount === 1) {
            return {
              rows: [
                {
                  id: "kalshi:market-1",
                  venue: "kalshi",
                  title: "Test market 1",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  condition_id: null,
                  token_yes: "sol:mint-yes-1",
                  token_no: "sol:mint-no-1",
                  clob_token_ids: null,
                  best_bid: "0.45",
                  best_ask: "0.55",
                  last_price: "0.5",
                },
                {
                  id: "kalshi:market-2",
                  venue: "kalshi",
                  title: "Test market 2",
                  outcomes: JSON.stringify(["YES", "NO"]),
                  condition_id: null,
                  token_yes: "sol:mint-yes-2",
                  token_no: "sol:mint-no-2",
                  clob_token_ids: null,
                  best_bid: "0.35",
                  best_ask: "0.45",
                  last_price: "0.4",
                },
              ],
            };
          }
          if (queryCount === 2) {
            return {
              rows: [
                {
                  market_id: "kalshi:market-1",
                  token_id: "sol:mint-yes-1",
                  side: "YES",
                },
                {
                  market_id: "kalshi:market-1",
                  token_id: "sol:mint-no-1",
                  side: "NO",
                },
                {
                  market_id: "kalshi:market-2",
                  token_id: "sol:mint-yes-2",
                  side: "YES",
                },
                {
                  market_id: "kalshi:market-2",
                  token_id: "sol:mint-no-2",
                  side: "NO",
                },
              ],
            };
          }
          if (queryCount === 3) {
            return { rows: [] };
          }
          if (queryCount === 4) {
            return { rows: [] };
          }
          throw new Error(`unexpected query count: ${queryCount}`);
        },
      };

      try {
        const results = await fetchMarketHolderDataBatch({
          markets: [
            { id: "kalshi:market-1", venue: "kalshi" },
            { id: "kalshi:market-2", venue: "kalshi" },
          ],
          limit: 10,
          client: client as never,
          marketFetchConcurrency: 2,
        });

        assert.equal(largestCalls, 4);
        assert.equal(ownerLookupCalls, 1);
        assert.equal(results[0]?.data?.holders.length, 2);
        assert.equal(results[1]?.data?.holders.length, 2);
        assert.equal(
          results[0]?.data?.holders[0]?.wallet,
          "owner-acct-mint-yes-1",
        );
      } finally {
        globalThis.fetch = originalFetch;
        env.solanaRpcUrls = originalSolanaRpcUrls;
        env.solanaRpcTimeoutMs = originalSolanaRpcTimeoutMs;
      }
    },
  },
  {
    name: "single-rpc solana requests retry 429 responses across attempts",
    run: async () => {
      const originalFetch = globalThis.fetch;
      const originalMaxAttempts = env.walletIntelRetryMaxAttempts;
      const originalBaseBackoffMs = env.walletIntelRetryBaseBackoffMs;
      const originalMaxBackoffMs = env.walletIntelRetryMaxBackoffMs;

      env.walletIntelRetryMaxAttempts = 2;
      env.walletIntelRetryBaseBackoffMs = 0;
      env.walletIntelRetryMaxBackoffMs = 0;

      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return new Response("rate limited", {
            status: 429,
            statusText: "Too Many Requests",
          });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { value: 123 },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      };

      try {
        const balance = await fetchSolanaBalanceLamports({
          rpcUrls: ["https://solana.example"],
          owner: "wallet",
          timeoutMs: 1_000,
        });
        assert.equal(balance, 123n);
        assert.equal(fetchCalls, 2);
      } finally {
        globalThis.fetch = originalFetch;
        env.walletIntelRetryMaxAttempts = originalMaxAttempts;
        env.walletIntelRetryBaseBackoffMs = originalBaseBackoffMs;
        env.walletIntelRetryMaxBackoffMs = originalMaxBackoffMs;
      }
    },
  },
  {
    name: "whale profile market mapping preserves two-sided positions",
    run: () => {
      const market = mapWhaleMarketToProfileMarket(
        {
          wallet_id: "wallet-1",
          market_id: "market-1",
          event_id: "event-1",
          market_title: "ETH above threshold?",
          event_title: "ETH above threshold?",
          venue: "limitless",
          category: "crypto",
          status: "ACTIVE",
          close_time: new Date("2026-01-12T13:00:00.000Z"),
          expiration_time: new Date("2026-01-12T13:00:00.000Z"),
          resolved_outcome: null,
          snapshot_at: new Date("2026-03-05T21:00:00.000Z"),
          recent_volume_usd: "1.484",
          recent_activity_count: 2,
          recent_last_activity_at: new Date("2026-03-05T21:00:00.000Z"),
          recent_avg_price: "0.742",
          best_bid: "0.742",
          best_ask: "0.742",
          last_price: "0.742",
          position_side: "BOTH",
          has_yes_position: true,
          has_no_position: true,
          position_shares: "2",
          position_value_usd: "1",
          position_price: null,
          yes_position_shares: "1",
          yes_position_value_usd: "0.742",
          yes_position_price: "0.742",
          no_position_shares: "1",
          no_position_value_usd: "0.258",
          no_position_price: "0.258",
        } as never,
        new Date("2026-03-05T21:00:00.000Z").getTime(),
      );

      assert.equal(market.position_side, "BOTH");
      assert.equal(market.is_two_sided, true);
      assert.equal(market.held_odds, null);
      assert.equal(market.position_value_usd, 1);
      assert.equal(market.yes_position_value_usd, 0.742);
      assert.equal(market.no_position_value_usd, 0.258);
    },
  },
  {
    name: "whale profile side bias counts both sides from a two-sided market",
    run: () => {
      const market = mapWhaleMarketToProfileMarket(
        {
          wallet_id: "wallet-1",
          market_id: "market-1",
          event_id: "event-1",
          market_title: "ETH above threshold?",
          event_title: "ETH above threshold?",
          venue: "limitless",
          category: "crypto",
          status: "ACTIVE",
          close_time: new Date("2026-01-12T13:00:00.000Z"),
          expiration_time: new Date("2026-01-12T13:00:00.000Z"),
          resolved_outcome: null,
          snapshot_at: new Date("2026-03-05T21:00:00.000Z"),
          recent_volume_usd: "1.484",
          recent_activity_count: 2,
          recent_last_activity_at: new Date("2026-03-05T21:00:00.000Z"),
          recent_avg_price: "0.742",
          best_bid: "0.742",
          best_ask: "0.742",
          last_price: "0.742",
          position_side: "BOTH",
          has_yes_position: true,
          has_no_position: true,
          position_shares: "2",
          position_value_usd: "1",
          position_price: null,
          yes_position_shares: "1",
          yes_position_value_usd: "0.742",
          yes_position_price: "0.742",
          no_position_shares: "1",
          no_position_value_usd: "0.258",
          no_position_price: "0.258",
        } as never,
        new Date("2026-03-05T21:00:00.000Z").getTime(),
      );

      const summary = computeProfileSideBias([market]);
      assert.equal(summary.yesValue, 0.742);
      assert.equal(summary.noValue, 0.258);
      assert.ok(Math.abs((summary.sideRatio ?? 0) - 0.742) < 1e-9);
      assert.equal(summary.sideBiasLabel, "mostly_yes");
    },
  },
  {
    name: "whale profile current portfolio summary tracks omitted tail from current holdings",
    run: () => {
      const now = new Date("2026-03-05T21:00:00.000Z").getTime();
      const large = mapWhaleMarketToProfileMarket(
        {
          wallet_id: "wallet-1",
          market_id: "market-large",
          event_id: "event-1",
          market_title: "Iran regime fall by March 31?",
          event_title: "Iran regime fall by March 31?",
          venue: "polymarket",
          category: "politics",
          status: "ACTIVE",
          close_time: new Date("2026-03-31T23:59:59.000Z"),
          expiration_time: new Date("2026-03-31T23:59:59.000Z"),
          resolved_outcome: null,
          snapshot_at: new Date("2026-03-05T21:00:00.000Z"),
          recent_volume_usd: "10",
          recent_activity_count: 1,
          recent_last_activity_at: new Date("2026-03-05T19:00:00.000Z"),
          recent_avg_price: "0.84",
          best_bid: "0.15",
          best_ask: "0.16",
          last_price: "0.16",
          position_side: "NO",
          has_yes_position: false,
          has_no_position: true,
          position_shares: "1000",
          position_value_usd: "840",
          position_price: "0.84",
          yes_position_shares: "0",
          yes_position_value_usd: "0",
          yes_position_price: null,
          no_position_shares: "1000",
          no_position_value_usd: "840",
          no_position_price: "0.84",
        } as never,
        now,
      );
      const small = mapWhaleMarketToProfileMarket(
        {
          wallet_id: "wallet-1",
          market_id: "market-small",
          event_id: "event-2",
          market_title: "Fed decision in March?",
          event_title: "Fed decision in March?",
          venue: "polymarket",
          category: "macro",
          status: "ACTIVE",
          close_time: new Date("2026-03-19T18:00:00.000Z"),
          expiration_time: new Date("2026-03-19T18:00:00.000Z"),
          resolved_outcome: null,
          snapshot_at: new Date("2026-03-05T21:00:00.000Z"),
          recent_volume_usd: "50",
          recent_activity_count: 4,
          recent_last_activity_at: new Date("2026-03-05T20:00:00.000Z"),
          recent_avg_price: "0.63",
          best_bid: "0.62",
          best_ask: "0.63",
          last_price: "0.63",
          position_side: "YES",
          has_yes_position: true,
          has_no_position: false,
          position_shares: "100",
          position_value_usd: "63",
          position_price: "0.63",
          yes_position_shares: "100",
          yes_position_value_usd: "63",
          yes_position_price: "0.63",
          no_position_shares: "0",
          no_position_value_usd: "0",
          no_position_price: null,
        } as never,
        now,
      );

      const summary = summarizeProfileMarkets([small, large], 1);
      assert.equal(summary.topMarkets.length, 1);
      assert.equal(summary.topMarkets[0]?.market_id, "market-large");
      assert.equal(summary.currentPortfolio.market_count_total, 2);
      assert.equal(summary.currentPortfolio.event_count_total, 2);
      assert.equal(summary.currentPortfolio.gross_usd_total, 903);
      assert.equal(summary.currentPortfolio.top_markets_gross_usd, 840);
      assert.equal(summary.currentPortfolio.omitted_market_count, 1);
      assert.equal(summary.currentPortfolio.omitted_gross_usd, 63);
      assert.ok(
        Math.abs(
          (summary.currentPortfolio.largest_position_share ?? 0) - 840 / 903,
        ) < 1e-9,
      );
      assert.equal(summary.summary.side_bias_label, "mostly_no");
      assert.equal(
        summary.topEvents[0]?.event_title,
        "Iran regime fall by March 31?",
      );
      assert.equal(summary.topEvents[0]?.gross_usd, 840);
    },
  },
  {
    name: "whale profile parser accepts wrapped strict json and normalizes output",
    run: () => {
      const raw = `Profile follows.\n{\n  "label_short": " Two-sided ETH hourly dabbler ",\n  "label_long": "Minimal, one-off activity in a single ETH hourly threshold market, holding both YES and NO.",\n  "archetype": "two-sided dabbler",\n  "categories": ["crypto", "blockchain"],\n  "theme_focus": [" ETH ", "hourly", "eth"],\n  "risk_style": "Small, mixed hourly exposure",\n  "confidence": "0.42",\n  "evidence": ["ETH above threshold?", "ETH above threshold?"],\n  "notes": " Short-lived, two-sided activity. ",\n  "extra": "ignored"\n}`;
      const parsed = parseProfileJson(raw);
      const normalized = normalizeWhaleProfile(parsed);
      assert.ok(normalized);
      assert.equal(normalized?.label_short, "Two-sided ETH hourly dabbler");
      assert.equal(normalized?.archetype, "two_sided_dabbler");
      assert.deepEqual(normalized?.categories, ["crypto"]);
      assert.deepEqual(normalized?.theme_focus, ["eth", "hourly"]);
      assert.deepEqual(normalized?.evidence, ["ETH above threshold?"]);
      assert.equal(normalized?.confidence, 0.42);
      assert.equal(normalized?.notes, "- Short-lived, two-sided activity.");
    },
  },
  {
    name: "whale profile parser preserves long label_long text without ellipsis truncation",
    run: () => {
      const labelLong =
        "High-volume, diversified NO-side trader concentrating in 80-100% implied odds across sports, politics, and Fed-rate markets, with a recent burst of adds and limited hedging across many active positions rather than one concentrated directional bet.";
      const parsed = parseProfileJson(
        JSON.stringify({
          label_short: "Diversified NO-side trader",
          label_long: labelLong,
          archetype: "no_side_spread_trader",
          categories: ["sports", "politics"],
          theme_focus: ["fed", "elections"],
          risk_style: "Broad NO-side exposure",
          confidence: 0.72,
          evidence: [
            "Fed decision in March?",
            "Republican Presidential Nominee 2028",
          ],
          notes: "- Current exposure is broad and mostly NO-side.",
        }),
      );
      const normalized = normalizeWhaleProfile(parsed);
      assert.ok(normalized);
      assert.equal(normalized?.label_long, labelLong);
    },
  },
  {
    name: "whale profile parser rejects schema-invalid json",
    run: () => {
      const parsed = parseProfileJson(
        JSON.stringify({
          label_short: "Bad profile",
          label_long: "Has an unexpected extra key.",
          archetype: "bad_profile",
          categories: ["crypto"],
          theme_focus: ["eth"],
          risk_style: "Mixed",
          confidence: 1.5,
          evidence: ["ETH above threshold?"],
        }),
      );
      assert.equal(normalizeWhaleProfile(parsed), null);
    },
  },
];

let passed = 0;
for (const test of tests) {
  try {
    await test.run();
    passed += 1;
  } catch (error) {
    console.error(`[intel-tests] failed: ${test.name}`);
    throw error;
  }
}

console.log(`[intel-tests] passed ${passed}/${tests.length}`);
