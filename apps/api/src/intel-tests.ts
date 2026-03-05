#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { isRetryableHttpStatus, parseRetryAfterMs } from "@hunch/shared";

import {
  fetchActiveRuntimePolicy,
  listActiveRuntimePolicies,
} from "./repos/runtime-policies.js";
import {
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
} from "./services/wallet-intel-pnl.js";
import { shouldReturnFilterTooBroad } from "./routes/wallet-intel.js";
import { extractProviderCostUsd, resolveAiCost } from "./lib/ai-cost.js";
import {
  getOpenRouterEmbeddingPricingPerM,
  getOpenRouterModelPricingPerM,
} from "./lib/ai-pricing.js";
import {
  DEFAULT_MIN_UNUSUAL_BASELINE_SAMPLES,
  computeRobustUnusualScore,
  resolveUnusualTier,
} from "./services/wallet-activity-summary.js";
import {
  normalizeOutcomeSideForApi,
  normalizeOutcomeSideForStorage,
} from "./services/wallet-intel-helpers.js";
import {
  MM_HEDGE_RATIO_MIN,
  MM_TWO_SIDED_MARKETS_MIN,
  buildWalletMmDiagnostics,
  computeMmSuspected,
} from "./services/wallet-intel-mm.js";

type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

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
      assert.equal(Number((provider.providerCostUsd ?? 0).toFixed(10)), 0.0000264);
    },
  },
  {
    name: "openrouter pricing table exposes verified defaults",
    run: () => {
      const gpt52 = getOpenRouterModelPricingPerM("openai/gpt-5.2");
      const gpt5nano = getOpenRouterModelPricingPerM("openai/gpt-5-nano");
      const embed = getOpenRouterEmbeddingPricingPerM("openai/text-embedding-3-small");
      assert.equal(gpt52?.inputPerM, 1.75);
      assert.equal(gpt52?.outputPerM, 14);
      assert.equal(gpt5nano?.inputPerM, 0.05);
      assert.equal(gpt5nano?.outputPerM, 0.4);
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
        "minAnalysisConfidence" in (resolved.effective as Record<string, unknown>),
        false,
      );
      assert.equal(
        "maxOutlierRatio" in (resolved.effective as Record<string, unknown>),
        false,
      );
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
        resolveSignalWindowHours(24, { windowHoursDefault: 72, windowHoursMax: 24 }),
        24,
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
        "projectionAlgo" in ((resolved.override ?? {}) as Record<string, unknown>),
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
      assert.deepEqual(resolved.effective.sourceDenyDomains, ["polymarket.com"]);
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
          queryControls: { whalesBatchSize: 100, whalesMaxScanCandidates: 3000 },
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
        "reactivated_after_idle",
      ]);
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
      assert.deepEqual(
        mergeWalletIdsForScope("following", ["a", "b"], ["c"]),
        ["a", "b"],
      );
      assert.deepEqual(mergeWalletIdsForScope("active", ["a"], ["b", "c"]), [
        "b",
        "c",
      ]);
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
    name: "mm helper uses hedge ratio, two-sided markets, and whale threshold gate",
    run: () => {
      const refreshPolicy = {
        whaleUsd: 100_000,
        whaleUsdSolana: 50_000,
      };
      assert.equal(
        computeMmSuspected({
          hedgeRatio: MM_HEDGE_RATIO_MIN,
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
          twoSidedMarkets: MM_TWO_SIDED_MARKETS_MIN,
          exposureUsd: 100_000,
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
