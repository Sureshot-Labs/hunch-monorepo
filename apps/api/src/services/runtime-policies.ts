import { z } from "zod";

import type { DbQuery } from "../db.js";
import { env } from "../env.js";
import {
  fetchActiveRuntimePolicy,
  listActiveRuntimePolicies,
  type RuntimePolicyRow,
} from "../repos/runtime-policies.js";
import { normalizeMarketMapVenues } from "./market-map.js";

export const INTEL_POLICY_KEYS = [
  "wallet_intel_signals",
  "wallet_intel_refresh",
  "wallet_intel_attribution",
  "ai_whale_profiles",
  "ai_clusters",
  "market_map",
  "arbitrage_defaults",
] as const;

export type IntelPolicyKey = (typeof INTEL_POLICY_KEYS)[number];

type PolicySource = "env" | "db";

export type WalletIntelSignalsPolicy = {
  maxOdds: number;
  minStakeUsd: number;
  minIdleDays: number;
  maxPriorMarkets: number;
  minPayoutUsd: number;
  lateHours: number;
  veryLateHours: number;
  weightStake: number;
  weightOdds: number;
  weightIdle: number;
  weightNovelty: number;
  minScore: number;
  windowHoursDefault: number;
  windowHoursMax: number;
  minDeltaUsd: number;
  activeInvalidCloseSampleCap: number;
};

export type WalletIntelRefreshPolicy = {
  marketLimit: number;
  marketLimitPerVenue: number;
  marketLimitKalshi: number;
  selectionModePoly:
    | "trade_24h"
    | "trade_1h"
    | "volume_24h"
    | "liquidity"
    | "hybrid";
  selectionModeKalshi:
    | "trade_24h"
    | "trade_1h"
    | "open_interest"
    | "updated"
    | "hybrid";
  selectionModeLimitless: "liquidity" | "book" | "updated" | "hybrid";
  whaleMarketLimit: number;
  watchlistMarketLimit: number;
  followedWalletLimit: number;
  tokenLimitPoly: number;
  tokenLimitLimitless: number;
  tokenLimitKalshi: number;
  holderLimit: number;
  snapshotHours: number;
  backfillSnapshots: number;
  backfillMaxSteps: number;
  retentionDaysSnapshots: number;
  retentionDaysActivity: number;
  retentionDaysMetrics: number;
  minVolume24h: number;
  minActivityUsd: number;
  minActivityShares: number;
  minPositionUsd: number;
  minPositionShares: number;
  freshDays: number;
  dormantDays: number;
  whaleUsd: number;
  whaleUsdSolana: number;
};

export type AiWhaleProfilesPolicy = {
  autoRun: boolean;
  limit: number;
  marketLimit: number;
  windowDays: number;
  selectionMode: "recent" | "pnl" | "hybrid";
  selectionRecentLimit: number;
  selectionPnlLimit: number;
  selectionSignalsLimit: number;
  selectionSignalsWindowHours: number;
  model: string;
  styleGuide: string;
  maxTokens: number;
  maxTokensFallback: number;
  promptVersion: string;
};

export type AiClustersPolicy = {
  analysisEnabled: boolean;
  modelFast: string;
  modelFinal: string;
  modelFallback: string;
  maxStageB: number;
  reanalyzeHours: number;
  useWebContext: boolean;
  webMaxResults: number;
  minConfidence: number;
  maxOutlierRatio: number;
  analysisMinSpread: number;
  analysisMinQuality: number;
  analysisMinVenueCount: number;
  analysisConcurrency: number;
  debugLogs: boolean;
  maxClustersPerRun: number;
};

export type ArbitrageDefaultsPolicy = {
  limit: number;
  minVenueCount: number;
  minSpread: number;
  minQualityScore: number;
};

export type MarketMapPolicy = {
  enabled: boolean;
  depth: number;
  k1: number;
  k2: number;
  k3: number;
  maxAiLabelsPerRun: number;
  maxEventsPerVenue: number;
  ttlSec: number;
  minEventVolume24h: number;
  minEventLiquidity: number;
  mergeLimitDefault: number;
  mergePerVenueMinDefault: number;
  sizeByDefault: "count" | "volume24h" | "liquidity" | "openInterest";
  labelAiEnabled: boolean;
  labelLevels: number[];
  labelModel: string;
  labelMaxTokens: number;
  labelChildSamplesMax: number;
  labelSiblingSamplesMax: number;
  labelSampleMaxChars: number;
  debugLogs: boolean;
  venuesEnabled: string[];
  projectionMethod: "umap";
  projectionPcaDims: number;
  projectionUmapNeighbors: number;
  projectionUmapMinDist: number;
  projectionSeed: number;
  projectionBudgetMs: number;
};

type WalletIntelAttributionVenueKey = "polymarket" | "kalshi" | "limitless";

export type WalletIntelAttributionDisplayPolicy = {
  listPrimaryCount: number;
  listSecondaryCount: number;
  detailsSecondaryMax: number;
  detailsSupportingMax: number;
};

export type WalletIntelAttributionVenueThresholdPolicy = {
  whaleExposureUsd: number;
  whaleVolume30dUsd: number;
  highConvictionStakeUsd: number;
  marketMoverStakeUsd: number;
  marketMoverStakeToMarketVolRatio: number;
  highFrequencyTrades30d: number;
  botMinActiveDays30d: number;
  botMaxMedianStakeUsd: number;
  volumeTraderVolume30dUsd: number;
  specialistCategoryShareMin: number;
  insiderCriticalSignals30dMin: number;
  insiderAvgSignalScoreMin: number;
  insiderMinResolvedBets: number;
  insiderWinRateMin: number;
};

export type WalletIntelAttributionRuleWeightsPolicy = {
  whale: number;
  specialist: number;
  bot: number;
  insider: number;
  primaryTieBreakOrder: Array<"whale" | "specialist" | "bot" | "insider">;
};

export type WalletIntelAttributionSignalsDisplaySeverityThresholdPolicy = {
  medium: number;
  high: number;
  critical: number;
};

export type WalletIntelAttributionSignalsDisplayPolicy = {
  maxDisplayReasons: number;
  hideRedundantReasonsWhenGateImplies: boolean;
  severityThresholds: {
    default: WalletIntelAttributionSignalsDisplaySeverityThresholdPolicy;
    polymarket: WalletIntelAttributionSignalsDisplaySeverityThresholdPolicy;
    kalshi: WalletIntelAttributionSignalsDisplaySeverityThresholdPolicy;
    limitless: WalletIntelAttributionSignalsDisplaySeverityThresholdPolicy;
  };
};

export type WalletIntelAttributionSensitiveLabelsPolicy = {
  insiderEnabled: boolean;
  botEnabled: boolean;
};

export type WalletIntelAttributionQueryControlsPolicy = {
  whalesBatchSize: number;
  whalesMaxScanCandidates: number;
};

export type WalletIntelAttributionVenueCapabilitiesPolicy = {
  polymarket: { specialistEnabled: boolean };
  kalshi: { specialistEnabled: boolean };
  limitless: { specialistEnabled: boolean };
};

export type WalletIntelAttributionMultiVenueMergePolicy = {
  strategy: "max_candidate_score";
  venueTieBreak: "volume30d_desc_then_fixed_order";
  fixedVenueOrder: WalletIntelAttributionVenueKey[];
};

export type WalletIntelAttributionPolicy = {
  enabled: boolean;
  display: WalletIntelAttributionDisplayPolicy;
  venueThresholds: Record<
    WalletIntelAttributionVenueKey,
    WalletIntelAttributionVenueThresholdPolicy
  >;
  ruleWeights: WalletIntelAttributionRuleWeightsPolicy;
  signalsDisplay: WalletIntelAttributionSignalsDisplayPolicy;
  sensitiveLabels: WalletIntelAttributionSensitiveLabelsPolicy;
  queryControls: WalletIntelAttributionQueryControlsPolicy;
  venueCapabilities: WalletIntelAttributionVenueCapabilitiesPolicy;
  multiVenueMerge: WalletIntelAttributionMultiVenueMergePolicy;
};

type IntelPolicyMap = {
  wallet_intel_signals: WalletIntelSignalsPolicy;
  wallet_intel_refresh: WalletIntelRefreshPolicy;
  wallet_intel_attribution: WalletIntelAttributionPolicy;
  ai_whale_profiles: AiWhaleProfilesPolicy;
  ai_clusters: AiClustersPolicy;
  market_map: MarketMapPolicy;
  arbitrage_defaults: ArbitrageDefaultsPolicy;
};

type IntelPolicyResult<K extends IntelPolicyKey> = {
  key: K;
  source: PolicySource;
  effectiveAt: Date | null;
  createdAt: Date | null;
  defaults: IntelPolicyMap[K];
  override: Partial<IntelPolicyMap[K]> | null;
  effective: IntelPolicyMap[K];
  invalidOverride: boolean;
};

const positiveInt = z.coerce.number().int().min(1);
const nonNegativeInt = z.coerce.number().int().min(0);
const nonNegativeNumber = z.coerce.number().min(0);
const ratio = z.coerce.number().min(0).max(1);
const strictBoolean = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return value;
}, z.boolean());

const walletIntelSignalsSchema = z
  .object({
    maxOdds: ratio,
    minStakeUsd: nonNegativeNumber,
    minIdleDays: nonNegativeInt,
    maxPriorMarkets: nonNegativeInt,
    minPayoutUsd: nonNegativeNumber,
    lateHours: positiveInt,
    veryLateHours: positiveInt,
    weightStake: nonNegativeNumber,
    weightOdds: nonNegativeNumber,
    weightIdle: nonNegativeNumber,
    weightNovelty: nonNegativeNumber,
    minScore: ratio,
    windowHoursDefault: positiveInt,
    windowHoursMax: positiveInt,
    minDeltaUsd: nonNegativeNumber,
    activeInvalidCloseSampleCap: nonNegativeInt.max(100),
  })
  .strict()
  .partial();

const walletIntelRefreshSchema = z
  .object({
    marketLimit: nonNegativeInt,
    marketLimitPerVenue: nonNegativeInt,
    marketLimitKalshi: nonNegativeInt,
    selectionModePoly: z.enum([
      "trade_24h",
      "trade_1h",
      "volume_24h",
      "liquidity",
      "hybrid",
    ]),
    selectionModeKalshi: z.enum([
      "trade_24h",
      "trade_1h",
      "open_interest",
      "updated",
      "hybrid",
    ]),
    selectionModeLimitless: z.enum(["liquidity", "book", "updated", "hybrid"]),
    whaleMarketLimit: nonNegativeInt,
    watchlistMarketLimit: positiveInt,
    followedWalletLimit: positiveInt,
    tokenLimitPoly: positiveInt,
    tokenLimitLimitless: positiveInt,
    tokenLimitKalshi: positiveInt,
    holderLimit: positiveInt,
    snapshotHours: positiveInt,
    backfillSnapshots: nonNegativeInt,
    backfillMaxSteps: positiveInt,
    retentionDaysSnapshots: nonNegativeInt,
    retentionDaysActivity: nonNegativeInt,
    retentionDaysMetrics: nonNegativeInt,
    minVolume24h: nonNegativeNumber,
    minActivityUsd: nonNegativeNumber,
    minActivityShares: nonNegativeNumber,
    minPositionUsd: nonNegativeNumber,
    minPositionShares: nonNegativeNumber,
    freshDays: positiveInt,
    dormantDays: positiveInt,
    whaleUsd: nonNegativeNumber,
    whaleUsdSolana: nonNegativeNumber,
  })
  .strict()
  .partial();

const aiWhaleProfilesSchema = z
  .object({
    autoRun: strictBoolean,
    limit: positiveInt,
    marketLimit: positiveInt,
    windowDays: positiveInt,
    selectionMode: z.enum(["recent", "pnl", "hybrid"]),
    selectionRecentLimit: nonNegativeInt,
    selectionPnlLimit: nonNegativeInt,
    selectionSignalsLimit: nonNegativeInt,
    selectionSignalsWindowHours: positiveInt,
    model: z.string().trim().min(1).max(200),
    styleGuide: z.string().trim().min(1).max(5_000),
    maxTokens: positiveInt.max(32_000),
    maxTokensFallback: positiveInt.max(32_000),
    promptVersion: z.string().trim().min(1).max(64),
  })
  .strict()
  .partial();

const aiClustersSchema = z
  .object({
    analysisEnabled: strictBoolean,
    modelFast: z.string().trim().min(1).max(200),
    modelFinal: z.string().trim().min(1).max(200),
    modelFallback: z.string().trim().min(1).max(200),
    maxStageB: nonNegativeInt,
    reanalyzeHours: nonNegativeInt,
    useWebContext: strictBoolean,
    webMaxResults: nonNegativeInt.max(25),
    minConfidence: ratio,
    maxOutlierRatio: ratio,
    analysisMinSpread: ratio,
    analysisMinQuality: ratio,
    analysisMinVenueCount: positiveInt.max(20),
    analysisConcurrency: positiveInt.max(20),
    debugLogs: strictBoolean,
    maxClustersPerRun: positiveInt.max(2_000),
  })
  .strict()
  .partial();

const marketMapSizeBySchema = z.enum([
  "count",
  "volume24h",
  "liquidity",
  "openInterest",
]);

const marketMapSchema = z
  .object({
    enabled: strictBoolean,
    depth: positiveInt.max(4),
    k1: positiveInt.max(100),
    k2: positiveInt.max(100),
    k3: positiveInt.max(100),
    maxAiLabelsPerRun: positiveInt.max(2_000),
    maxEventsPerVenue: positiveInt.max(100_000),
    ttlSec: positiveInt.max(60 * 60 * 24 * 30),
    minEventVolume24h: nonNegativeNumber,
    minEventLiquidity: nonNegativeNumber,
    mergeLimitDefault: positiveInt.max(200),
    mergePerVenueMinDefault: nonNegativeInt.max(50),
    sizeByDefault: marketMapSizeBySchema,
    labelAiEnabled: strictBoolean,
    labelLevels: z.array(z.coerce.number().int().min(1).max(3)).max(3),
    labelModel: z.string().trim().min(1).max(200),
    labelMaxTokens: positiveInt.max(2_000),
    labelChildSamplesMax: positiveInt.max(20),
    labelSiblingSamplesMax: nonNegativeInt.max(20),
    labelSampleMaxChars: positiveInt.max(200),
    debugLogs: strictBoolean,
    venuesEnabled: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
    projectionMethod: z.enum(["umap"]),
    projectionPcaDims: positiveInt.max(1024),
    projectionUmapNeighbors: positiveInt.max(500),
    projectionUmapMinDist: nonNegativeNumber.max(1),
    projectionSeed: nonNegativeInt.max(2_147_483_647),
    projectionBudgetMs: positiveInt.max(60 * 60 * 1_000),
  })
  .strict()
  .partial();

const arbitrageDefaultsSchema = z
  .object({
    limit: positiveInt.max(200),
    minVenueCount: positiveInt.max(10),
    minSpread: ratio,
    minQualityScore: ratio,
  })
  .strict()
  .partial();

const attributionPrimaryKeySchema = z.enum([
  "whale",
  "specialist",
  "bot",
  "insider",
]);
const attributionVenueKeySchema = z.enum(["polymarket", "kalshi", "limitless"]);

const attributionDisplaySchema = z
  .object({
    listPrimaryCount: positiveInt.max(5),
    listSecondaryCount: positiveInt.max(10),
    detailsSecondaryMax: positiveInt.max(30),
    detailsSupportingMax: positiveInt.max(30),
  })
  .strict()
  .partial();

const attributionVenueThresholdSchema = z
  .object({
    whaleExposureUsd: nonNegativeNumber,
    whaleVolume30dUsd: nonNegativeNumber,
    highConvictionStakeUsd: nonNegativeNumber,
    marketMoverStakeUsd: nonNegativeNumber,
    marketMoverStakeToMarketVolRatio: ratio,
    highFrequencyTrades30d: nonNegativeInt,
    botMinActiveDays30d: nonNegativeInt.max(31),
    botMaxMedianStakeUsd: nonNegativeNumber,
    volumeTraderVolume30dUsd: nonNegativeNumber,
    specialistCategoryShareMin: ratio,
    insiderCriticalSignals30dMin: nonNegativeInt.max(200),
    insiderAvgSignalScoreMin: ratio,
    insiderMinResolvedBets: nonNegativeInt.max(10_000),
    insiderWinRateMin: ratio,
  })
  .strict()
  .partial();

const attributionRuleWeightsSchema = z
  .object({
    whale: nonNegativeNumber,
    specialist: nonNegativeNumber,
    bot: nonNegativeNumber,
    insider: nonNegativeNumber,
    primaryTieBreakOrder: z.array(attributionPrimaryKeySchema).min(1).max(4),
  })
  .strict()
  .partial();

const attributionSeverityThresholdSchema = z
  .object({
    medium: ratio,
    high: ratio,
    critical: ratio,
  })
  .strict()
  .partial();

const attributionSignalsDisplaySchema = z
  .object({
    maxDisplayReasons: positiveInt.max(10),
    hideRedundantReasonsWhenGateImplies: strictBoolean,
    severityThresholds: z
      .object({
        default: attributionSeverityThresholdSchema.optional(),
        polymarket: attributionSeverityThresholdSchema.optional(),
        kalshi: attributionSeverityThresholdSchema.optional(),
        limitless: attributionSeverityThresholdSchema.optional(),
      })
      .strict()
      .partial(),
  })
  .strict()
  .partial();

const attributionSensitiveLabelsSchema = z
  .object({
    insiderEnabled: strictBoolean,
    botEnabled: strictBoolean,
  })
  .strict()
  .partial();

const attributionQueryControlsSchema = z
  .object({
    whalesBatchSize: positiveInt.max(1_000),
    whalesMaxScanCandidates: positiveInt.max(20_000),
  })
  .strict()
  .partial();

const attributionVenueCapabilitiesSchema = z
  .object({
    polymarket: z
      .object({ specialistEnabled: strictBoolean })
      .strict()
      .partial(),
    kalshi: z
      .object({ specialistEnabled: strictBoolean })
      .strict()
      .partial(),
    limitless: z
      .object({ specialistEnabled: strictBoolean })
      .strict()
      .partial(),
  })
  .strict()
  .partial();

const attributionMultiVenueMergeSchema = z
  .object({
    strategy: z.enum(["max_candidate_score"]),
    venueTieBreak: z.enum(["volume30d_desc_then_fixed_order"]),
    fixedVenueOrder: z.array(attributionVenueKeySchema).min(1).max(3),
  })
  .strict()
  .partial();

const walletIntelAttributionSchema = z
  .object({
    enabled: strictBoolean,
    display: attributionDisplaySchema,
    venueThresholds: z
      .object({
        polymarket: attributionVenueThresholdSchema.optional(),
        kalshi: attributionVenueThresholdSchema.optional(),
        limitless: attributionVenueThresholdSchema.optional(),
      })
      .strict()
      .partial(),
    ruleWeights: attributionRuleWeightsSchema,
    signalsDisplay: attributionSignalsDisplaySchema,
    sensitiveLabels: attributionSensitiveLabelsSchema,
    queryControls: attributionQueryControlsSchema,
    venueCapabilities: attributionVenueCapabilitiesSchema,
    multiVenueMerge: attributionMultiVenueMergeSchema,
  })
  .strict()
  .partial();

const policySchemas = {
  wallet_intel_signals: walletIntelSignalsSchema,
  wallet_intel_refresh: walletIntelRefreshSchema,
  wallet_intel_attribution: walletIntelAttributionSchema,
  ai_whale_profiles: aiWhaleProfilesSchema,
  ai_clusters: aiClustersSchema,
  market_map: marketMapSchema,
  arbitrage_defaults: arbitrageDefaultsSchema,
} as const;

const warnedInvalidOverrides = new Set<string>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return base;
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = next[key];
    if (Array.isArray(value)) {
      next[key] = value;
      continue;
    }
    if (isPlainObject(current) && isPlainObject(value)) {
      next[key] = deepMerge(current, value);
      continue;
    }
    next[key] = value;
  }
  return next as T;
}

const attributionVenueDefault: WalletIntelAttributionVenueThresholdPolicy = {
  whaleExposureUsd: 50_000,
  whaleVolume30dUsd: 150_000,
  highConvictionStakeUsd: 5_000,
  marketMoverStakeUsd: 10_000,
  marketMoverStakeToMarketVolRatio: 0.05,
  highFrequencyTrades30d: 120,
  botMinActiveDays30d: 12,
  botMaxMedianStakeUsd: 750,
  volumeTraderVolume30dUsd: 250_000,
  specialistCategoryShareMin: 0.6,
  insiderCriticalSignals30dMin: 3,
  insiderAvgSignalScoreMin: 0.75,
  insiderMinResolvedBets: 12,
  insiderWinRateMin: 0.62,
};

function parseAttributionDefaultsEnvOverride(): Partial<WalletIntelAttributionPolicy> {
  const raw = env.walletIntelAttributionDefaultsJson?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      console.warn(
        "[runtime-policies] Invalid HUNCH_WALLET_INTEL_ATTRIBUTION_DEFAULTS_JSON: expected object",
      );
      return {};
    }
    return parsed as Partial<WalletIntelAttributionPolicy>;
  } catch (error) {
    console.warn(
      "[runtime-policies] Failed to parse HUNCH_WALLET_INTEL_ATTRIBUTION_DEFAULTS_JSON",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return {};
  }
}

function getWalletIntelAttributionDefaults(): WalletIntelAttributionPolicy {
  const defaults: WalletIntelAttributionPolicy = {
    enabled: false,
    display: {
      listPrimaryCount: 1,
      listSecondaryCount: 2,
      detailsSecondaryMax: 8,
      detailsSupportingMax: 12,
    },
    venueThresholds: {
      polymarket: { ...attributionVenueDefault },
      kalshi: { ...attributionVenueDefault },
      limitless: { ...attributionVenueDefault },
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
    sensitiveLabels: {
      botEnabled: true,
      insiderEnabled: false,
    },
    queryControls: {
      whalesBatchSize: 100,
      whalesMaxScanCandidates: 3_000,
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
  };
  return deepMerge(defaults, parseAttributionDefaultsEnvOverride());
}

export function resolveSignalWindowHours(
  queryWindowHours: number | undefined,
  policy: Pick<WalletIntelSignalsPolicy, "windowHoursDefault" | "windowHoursMax">,
): number {
  const windowMax = Math.max(1, Math.trunc(policy.windowHoursMax));
  const windowDefault = clamp(Math.trunc(policy.windowHoursDefault), 1, windowMax);
  if (queryWindowHours == null) return windowDefault;
  const requested = Math.trunc(queryWindowHours);
  if (!Number.isFinite(requested)) return windowDefault;
  return clamp(requested, 1, windowMax);
}

function getDefaults(): IntelPolicyMap {
  return {
    wallet_intel_signals: {
      maxOdds: env.walletIntelSignalMaxOdds,
      minStakeUsd: env.walletIntelSignalMinStakeUsd,
      minIdleDays: env.walletIntelSignalMinIdleDays,
      maxPriorMarkets: env.walletIntelSignalMaxPriorMarkets,
      minPayoutUsd: env.walletIntelSignalMinPayoutUsd,
      lateHours: env.walletIntelSignalLateHours,
      veryLateHours: env.walletIntelSignalVeryLateHours,
      weightStake: env.walletIntelSignalWeightStake,
      weightOdds: env.walletIntelSignalWeightOdds,
      weightIdle: env.walletIntelSignalWeightIdle,
      weightNovelty: env.walletIntelSignalWeightNovelty,
      minScore: env.walletIntelSignalMinScore,
      windowHoursDefault: env.walletIntelSignalWindowHoursDefault,
      windowHoursMax: env.walletIntelSignalWindowHoursMax,
      minDeltaUsd: 0,
      activeInvalidCloseSampleCap: 5,
    },
    wallet_intel_refresh: {
      marketLimit: env.walletIntelMarketLimit,
      marketLimitPerVenue: env.walletIntelMarketLimitPerVenue,
      marketLimitKalshi: env.walletIntelMarketLimitKalshi,
      selectionModePoly: env.walletIntelSelectionModePoly,
      selectionModeKalshi: env.walletIntelSelectionModeKalshi,
      selectionModeLimitless: env.walletIntelSelectionModeLimitless,
      whaleMarketLimit: env.walletIntelWhaleMarketLimit,
      watchlistMarketLimit: env.walletIntelWatchlistMarketLimit,
      followedWalletLimit: env.walletIntelFollowedWalletLimit,
      tokenLimitPoly: env.walletIntelTokenLimitPoly,
      tokenLimitLimitless: env.walletIntelTokenLimitLimitless,
      tokenLimitKalshi: env.walletIntelTokenLimitKalshi,
      holderLimit: env.walletIntelHolderLimit,
      snapshotHours: env.walletIntelSnapshotHours,
      backfillSnapshots: env.walletIntelBackfillSnapshots,
      backfillMaxSteps: env.walletIntelBackfillMaxSteps,
      retentionDaysSnapshots: env.walletIntelRetentionDaysSnapshots,
      retentionDaysActivity: env.walletIntelRetentionDaysActivity,
      retentionDaysMetrics: env.walletIntelRetentionDaysMetrics,
      minVolume24h: env.walletIntelMinVolume24h,
      minActivityUsd: env.walletIntelMinActivityUsd,
      minActivityShares: env.walletIntelMinActivityShares,
      minPositionUsd: env.walletIntelMinPositionUsd,
      minPositionShares: env.walletIntelMinPositionShares,
      freshDays: env.walletIntelFreshDays,
      dormantDays: env.walletIntelDormantDays,
      whaleUsd: env.walletIntelWhaleUsd,
      whaleUsdSolana: env.walletIntelWhaleUsdSolana,
    },
    wallet_intel_attribution: getWalletIntelAttributionDefaults(),
    ai_whale_profiles: {
      autoRun: env.aiWhaleProfileAutoRun,
      limit: env.aiWhaleProfileLimit,
      marketLimit: env.aiWhaleProfileMarketLimit,
      windowDays: env.aiWhaleProfileWindowDays,
      selectionMode: env.aiWhaleProfileSelectionMode,
      selectionRecentLimit: env.aiWhaleProfileSelectionRecentLimit,
      selectionPnlLimit: env.aiWhaleProfileSelectionPnlLimit,
      selectionSignalsLimit: env.aiWhaleProfileSelectionSignalsLimit,
      selectionSignalsWindowHours: env.aiWhaleProfileSelectionSignalsWindowHours,
      model: env.aiWhaleProfileModel,
      styleGuide: env.aiWhaleProfileStyleGuide,
      maxTokens: env.aiWhaleProfileMaxTokens,
      maxTokensFallback: env.aiWhaleProfileMaxTokensFallback,
      promptVersion: "v1",
    },
    ai_clusters: {
      analysisEnabled: env.aiClusterAnalysisEnabled,
      modelFast: env.aiClusterModelFast,
      modelFinal: env.aiClusterModelFinal,
      modelFallback: env.aiClusterModelFallback,
      maxStageB: env.aiClusterMaxStageB,
      reanalyzeHours: env.aiClusterReanalyzeHours,
      useWebContext: env.aiClusterUseWebContext,
      webMaxResults: env.aiClusterWebMaxResults,
      minConfidence: env.aiClusterMinConfidence,
      maxOutlierRatio: env.aiClusterMaxOutlierRatio,
      analysisMinSpread: env.aiClusterAnalysisMinSpread,
      analysisMinQuality: env.aiClusterAnalysisMinQuality,
      analysisMinVenueCount: env.aiClusterAnalysisMinVenueCount,
      analysisConcurrency: env.aiClusterAnalysisConcurrency,
      debugLogs: env.aiClusterDebugLogs,
      maxClustersPerRun: 400,
    },
    market_map: {
      enabled: env.aiMarketMapEnabled,
      depth: env.aiMarketMapDepth,
      k1: env.aiMarketMapK1,
      k2: env.aiMarketMapK2,
      k3: env.aiMarketMapK3,
      maxAiLabelsPerRun: env.aiMarketMapMaxAiLabelsPerRun,
      maxEventsPerVenue: env.aiMarketMapMaxEventsPerVenue,
      ttlSec: env.aiMarketMapTtlSec,
      minEventVolume24h: env.aiMarketMapMinEventVolume24h,
      minEventLiquidity: env.aiMarketMapMinEventLiquidity,
      mergeLimitDefault: env.aiMarketMapMergeLimitDefault,
      mergePerVenueMinDefault: env.aiMarketMapMergePerVenueMinDefault,
      sizeByDefault: env.aiMarketMapSizeByDefault,
      labelAiEnabled: env.aiMarketMapLabelAiEnabled,
      labelLevels: env.aiMarketMapLabelLevels,
      labelModel: env.aiMarketMapLabelModel,
      labelMaxTokens: env.aiMarketMapLabelMaxTokens,
      labelChildSamplesMax: env.aiMarketMapLabelChildSamplesMax,
      labelSiblingSamplesMax: env.aiMarketMapLabelSiblingSamplesMax,
      labelSampleMaxChars: env.aiMarketMapLabelSampleMaxChars,
      debugLogs: env.aiMarketMapDebugLogs,
      venuesEnabled: env.aiMarketMapVenuesEnabled,
      projectionMethod: env.aiMarketMapProjectionMethod,
      projectionPcaDims: env.aiMarketMapProjectionPcaDims,
      projectionUmapNeighbors: env.aiMarketMapProjectionUmapNeighbors,
      projectionUmapMinDist: env.aiMarketMapProjectionUmapMinDist,
      projectionSeed: env.aiMarketMapProjectionSeed,
      projectionBudgetMs: env.aiMarketMapProjectionBudgetMs,
    },
    arbitrage_defaults: {
      limit: 24,
      minVenueCount: 2,
      minSpread: 0.05,
      minQualityScore: 0.6,
    },
  };
}

function normalizeSignalsPolicy(
  policy: WalletIntelSignalsPolicy,
): WalletIntelSignalsPolicy {
  const windowHoursMax = Math.max(1, Math.trunc(policy.windowHoursMax));
  const windowHoursDefault = clamp(
    Math.trunc(policy.windowHoursDefault),
    1,
    windowHoursMax,
  );
  const veryLateHours = Math.max(1, Math.trunc(policy.veryLateHours));
  const lateHours = Math.max(veryLateHours, Math.trunc(policy.lateHours));
  return {
    ...policy,
    maxOdds: clamp(policy.maxOdds, 0, 1),
    minStakeUsd: Math.max(0, policy.minStakeUsd),
    minIdleDays: Math.max(0, Math.trunc(policy.minIdleDays)),
    maxPriorMarkets: Math.max(0, Math.trunc(policy.maxPriorMarkets)),
    minPayoutUsd: Math.max(0, policy.minPayoutUsd),
    lateHours,
    veryLateHours,
    weightStake: Math.max(0, policy.weightStake),
    weightOdds: Math.max(0, policy.weightOdds),
    weightIdle: Math.max(0, policy.weightIdle),
    weightNovelty: Math.max(0, policy.weightNovelty),
    minScore: clamp(policy.minScore, 0, 1),
    windowHoursDefault,
    windowHoursMax,
    minDeltaUsd: Math.max(0, policy.minDeltaUsd),
    activeInvalidCloseSampleCap: clamp(
      Math.trunc(policy.activeInvalidCloseSampleCap),
      0,
      100,
    ),
  };
}

function normalizeRefreshPolicy(
  policy: WalletIntelRefreshPolicy,
): WalletIntelRefreshPolicy {
  const marketLimitPerVenue = Math.max(0, Math.trunc(policy.marketLimitPerVenue));
  const marketLimitKalshi = Math.max(
    0,
    Math.trunc(policy.marketLimitKalshi || marketLimitPerVenue),
  );
  const whaleUsd = Math.max(0, policy.whaleUsd);
  return {
    ...policy,
    marketLimit: Math.max(0, Math.trunc(policy.marketLimit)),
    marketLimitPerVenue,
    marketLimitKalshi,
    whaleMarketLimit: Math.max(0, Math.trunc(policy.whaleMarketLimit)),
    watchlistMarketLimit: Math.max(1, Math.trunc(policy.watchlistMarketLimit)),
    followedWalletLimit: Math.max(1, Math.trunc(policy.followedWalletLimit)),
    tokenLimitPoly: Math.max(1, Math.trunc(policy.tokenLimitPoly)),
    tokenLimitLimitless: Math.max(1, Math.trunc(policy.tokenLimitLimitless)),
    tokenLimitKalshi: Math.max(1, Math.trunc(policy.tokenLimitKalshi)),
    holderLimit: Math.max(1, Math.trunc(policy.holderLimit)),
    snapshotHours: Math.max(1, Math.trunc(policy.snapshotHours)),
    backfillSnapshots: Math.max(0, Math.trunc(policy.backfillSnapshots)),
    backfillMaxSteps: Math.max(1, Math.trunc(policy.backfillMaxSteps)),
    retentionDaysSnapshots: Math.max(0, Math.trunc(policy.retentionDaysSnapshots)),
    retentionDaysActivity: Math.max(0, Math.trunc(policy.retentionDaysActivity)),
    retentionDaysMetrics: Math.max(0, Math.trunc(policy.retentionDaysMetrics)),
    minVolume24h: Math.max(0, policy.minVolume24h),
    minActivityUsd: Math.max(0, policy.minActivityUsd),
    minActivityShares: Math.max(0, policy.minActivityShares),
    minPositionUsd: Math.max(0, policy.minPositionUsd),
    minPositionShares: Math.max(0, policy.minPositionShares),
    freshDays: Math.max(1, Math.trunc(policy.freshDays)),
    dormantDays: Math.max(1, Math.trunc(policy.dormantDays)),
    whaleUsd,
    whaleUsdSolana: Math.max(0, policy.whaleUsdSolana || whaleUsd),
  };
}

function normalizeAttributionSeverityThresholds(
  value: WalletIntelAttributionSignalsDisplaySeverityThresholdPolicy,
): WalletIntelAttributionSignalsDisplaySeverityThresholdPolicy {
  const medium = clamp(value.medium, 0, 1);
  const high = clamp(value.high, medium, 1);
  const critical = clamp(value.critical, high, 1);
  return { medium, high, critical };
}

function normalizeAttributionVenueThresholds(
  value: WalletIntelAttributionVenueThresholdPolicy,
): WalletIntelAttributionVenueThresholdPolicy {
  return {
    whaleExposureUsd: Math.max(0, value.whaleExposureUsd),
    whaleVolume30dUsd: Math.max(0, value.whaleVolume30dUsd),
    highConvictionStakeUsd: Math.max(0, value.highConvictionStakeUsd),
    marketMoverStakeUsd: Math.max(0, value.marketMoverStakeUsd),
    marketMoverStakeToMarketVolRatio: clamp(
      value.marketMoverStakeToMarketVolRatio,
      0,
      1,
    ),
    highFrequencyTrades30d: Math.max(0, Math.trunc(value.highFrequencyTrades30d)),
    botMinActiveDays30d: clamp(Math.trunc(value.botMinActiveDays30d), 0, 31),
    botMaxMedianStakeUsd: Math.max(0, value.botMaxMedianStakeUsd),
    volumeTraderVolume30dUsd: Math.max(0, value.volumeTraderVolume30dUsd),
    specialistCategoryShareMin: clamp(value.specialistCategoryShareMin, 0, 1),
    insiderCriticalSignals30dMin: Math.max(
      0,
      Math.trunc(value.insiderCriticalSignals30dMin),
    ),
    insiderAvgSignalScoreMin: clamp(value.insiderAvgSignalScoreMin, 0, 1),
    insiderMinResolvedBets: Math.max(0, Math.trunc(value.insiderMinResolvedBets)),
    insiderWinRateMin: clamp(value.insiderWinRateMin, 0, 1),
  };
}

function normalizeAttributionPolicy(
  policy: WalletIntelAttributionPolicy,
): WalletIntelAttributionPolicy {
  const tieBreakOrder = Array.from(
    new Set(
      policy.ruleWeights.primaryTieBreakOrder.filter((key) =>
        ["whale", "specialist", "bot", "insider"].includes(key),
      ),
    ),
  ) as WalletIntelAttributionRuleWeightsPolicy["primaryTieBreakOrder"];
  for (const key of ["whale", "specialist", "bot", "insider"] as const) {
    if (!tieBreakOrder.includes(key)) tieBreakOrder.push(key);
  }
  const fixedVenueOrder = Array.from(
    new Set(
      policy.multiVenueMerge.fixedVenueOrder.filter((venue) =>
        ["polymarket", "kalshi", "limitless"].includes(venue),
      ),
    ),
  ) as WalletIntelAttributionMultiVenueMergePolicy["fixedVenueOrder"];
  for (const venue of ["polymarket", "kalshi", "limitless"] as const) {
    if (!fixedVenueOrder.includes(venue)) fixedVenueOrder.push(venue);
  }

  return {
    enabled: Boolean(policy.enabled),
    display: {
      listPrimaryCount: clamp(Math.trunc(policy.display.listPrimaryCount), 1, 5),
      listSecondaryCount: clamp(Math.trunc(policy.display.listSecondaryCount), 0, 10),
      detailsSecondaryMax: clamp(
        Math.trunc(policy.display.detailsSecondaryMax),
        0,
        30,
      ),
      detailsSupportingMax: clamp(
        Math.trunc(policy.display.detailsSupportingMax),
        0,
        30,
      ),
    },
    venueThresholds: {
      polymarket: normalizeAttributionVenueThresholds(
        policy.venueThresholds.polymarket,
      ),
      kalshi: normalizeAttributionVenueThresholds(policy.venueThresholds.kalshi),
      limitless: normalizeAttributionVenueThresholds(
        policy.venueThresholds.limitless,
      ),
    },
    ruleWeights: {
      whale: Math.max(0, policy.ruleWeights.whale),
      specialist: Math.max(0, policy.ruleWeights.specialist),
      bot: Math.max(0, policy.ruleWeights.bot),
      insider: Math.max(0, policy.ruleWeights.insider),
      primaryTieBreakOrder: tieBreakOrder,
    },
    signalsDisplay: {
      maxDisplayReasons: clamp(
        Math.trunc(policy.signalsDisplay.maxDisplayReasons),
        1,
        10,
      ),
      hideRedundantReasonsWhenGateImplies: Boolean(
        policy.signalsDisplay.hideRedundantReasonsWhenGateImplies,
      ),
      severityThresholds: {
        default: normalizeAttributionSeverityThresholds(
          policy.signalsDisplay.severityThresholds.default,
        ),
        polymarket: normalizeAttributionSeverityThresholds(
          policy.signalsDisplay.severityThresholds.polymarket,
        ),
        kalshi: normalizeAttributionSeverityThresholds(
          policy.signalsDisplay.severityThresholds.kalshi,
        ),
        limitless: normalizeAttributionSeverityThresholds(
          policy.signalsDisplay.severityThresholds.limitless,
        ),
      },
    },
    sensitiveLabels: {
      insiderEnabled: Boolean(policy.sensitiveLabels.insiderEnabled),
      botEnabled: Boolean(policy.sensitiveLabels.botEnabled),
    },
    queryControls: {
      whalesBatchSize: clamp(Math.trunc(policy.queryControls.whalesBatchSize), 10, 1_000),
      whalesMaxScanCandidates: clamp(
        Math.trunc(policy.queryControls.whalesMaxScanCandidates),
        100,
        20_000,
      ),
    },
    venueCapabilities: {
      polymarket: {
        specialistEnabled: Boolean(policy.venueCapabilities.polymarket.specialistEnabled),
      },
      kalshi: {
        specialistEnabled: Boolean(policy.venueCapabilities.kalshi.specialistEnabled),
      },
      limitless: {
        specialistEnabled: Boolean(policy.venueCapabilities.limitless.specialistEnabled),
      },
    },
    multiVenueMerge: {
      strategy: "max_candidate_score",
      venueTieBreak: "volume30d_desc_then_fixed_order",
      fixedVenueOrder,
    },
  };
}

function normalizeAiWhaleProfilesPolicy(
  policy: AiWhaleProfilesPolicy,
): AiWhaleProfilesPolicy {
  const styleGuide = policy.styleGuide.trim();
  return {
    ...policy,
    autoRun: Boolean(policy.autoRun),
    limit: Math.max(1, Math.trunc(policy.limit)),
    marketLimit: Math.max(1, Math.trunc(policy.marketLimit)),
    windowDays: Math.max(1, Math.trunc(policy.windowDays)),
    selectionMode: policy.selectionMode,
    selectionRecentLimit: Math.max(0, Math.trunc(policy.selectionRecentLimit)),
    selectionPnlLimit: Math.max(0, Math.trunc(policy.selectionPnlLimit)),
    selectionSignalsLimit: Math.max(0, Math.trunc(policy.selectionSignalsLimit)),
    selectionSignalsWindowHours: clamp(
      Math.trunc(policy.selectionSignalsWindowHours),
      1,
      24 * 14,
    ),
    model: policy.model.trim(),
    styleGuide:
      styleGuide.length > 0
        ? styleGuide
        : "Neutral tone, short sentences, no hype, no speculation.",
    maxTokens: Math.max(1, Math.trunc(policy.maxTokens)),
    maxTokensFallback: Math.max(1, Math.trunc(policy.maxTokensFallback)),
    promptVersion: policy.promptVersion.trim() || "v1",
  };
}

function normalizeAiClustersPolicy(policy: AiClustersPolicy): AiClustersPolicy {
  return {
    ...policy,
    analysisEnabled: Boolean(policy.analysisEnabled),
    modelFast: policy.modelFast.trim(),
    modelFinal: policy.modelFinal.trim(),
    modelFallback: policy.modelFallback.trim(),
    maxStageB: Math.max(0, Math.trunc(policy.maxStageB)),
    reanalyzeHours: Math.max(0, Math.trunc(policy.reanalyzeHours)),
    useWebContext: Boolean(policy.useWebContext),
    webMaxResults: clamp(Math.trunc(policy.webMaxResults), 0, 25),
    minConfidence: clamp(policy.minConfidence, 0, 1),
    maxOutlierRatio: clamp(policy.maxOutlierRatio, 0, 1),
    analysisMinSpread: clamp(policy.analysisMinSpread, 0, 1),
    analysisMinQuality: clamp(policy.analysisMinQuality, 0, 1),
    analysisMinVenueCount: clamp(Math.trunc(policy.analysisMinVenueCount), 1, 20),
    analysisConcurrency: clamp(Math.trunc(policy.analysisConcurrency), 1, 20),
    debugLogs: Boolean(policy.debugLogs),
    maxClustersPerRun: Math.max(1, Math.trunc(policy.maxClustersPerRun)),
  };
}

function normalizeMarketMapPolicy(policy: MarketMapPolicy): MarketMapPolicy {
  const normalizedLabelLevels = Array.from(
    new Set(
      (policy.labelLevels ?? [])
        .map((value) => Math.trunc(value))
        .filter((value) => value === 1 || value === 2 || value === 3),
    ),
  ).sort((a, b) => a - b);

  const normalizedVenues = normalizeMarketMapVenues(policy.venuesEnabled ?? []);
  const venuesEnabled =
    normalizedVenues.length > 0
      ? normalizedVenues
      : (["polymarket", "kalshi", "limitless"] as const);
  const normalizedK3 = clamp(Math.trunc(policy.k3 ?? policy.k2), 2, 24);

  return {
    enabled: Boolean(policy.enabled),
    depth: clamp(Math.trunc(policy.depth), 2, 4),
    k1: clamp(Math.trunc(policy.k1), 2, 24),
    k2: clamp(Math.trunc(policy.k2), 2, 24),
    k3: normalizedK3,
    maxAiLabelsPerRun: clamp(
      Math.trunc(policy.maxAiLabelsPerRun ?? 400),
      1,
      2_000,
    ),
    maxEventsPerVenue: clamp(Math.trunc(policy.maxEventsPerVenue), 100, 20_000),
    ttlSec: clamp(Math.trunc(policy.ttlSec), 1_800, 604_800),
    minEventVolume24h: Math.max(0, policy.minEventVolume24h),
    minEventLiquidity: Math.max(0, policy.minEventLiquidity),
    mergeLimitDefault: clamp(Math.trunc(policy.mergeLimitDefault), 1, 200),
    mergePerVenueMinDefault: clamp(
      Math.trunc(policy.mergePerVenueMinDefault),
      0,
      50,
    ),
    sizeByDefault:
      policy.sizeByDefault === "count" ||
      policy.sizeByDefault === "liquidity" ||
      policy.sizeByDefault === "openInterest" ||
      policy.sizeByDefault === "volume24h"
        ? policy.sizeByDefault
        : "volume24h",
    labelAiEnabled: Boolean(policy.labelAiEnabled),
    labelLevels:
      normalizedLabelLevels.length > 0 ? normalizedLabelLevels : [1, 2, 3],
    labelModel: policy.labelModel.trim(),
    labelMaxTokens: clamp(Math.trunc(policy.labelMaxTokens), 1, 2_000),
    labelChildSamplesMax: clamp(
      Math.trunc(policy.labelChildSamplesMax ?? 16),
      1,
      20,
    ),
    labelSiblingSamplesMax: clamp(
      Math.trunc(policy.labelSiblingSamplesMax ?? 6),
      0,
      20,
    ),
    labelSampleMaxChars: clamp(
      Math.trunc(policy.labelSampleMaxChars ?? 80),
      24,
      200,
    ),
    debugLogs: Boolean(policy.debugLogs),
    venuesEnabled: [...venuesEnabled],
    projectionMethod: "umap",
    projectionPcaDims: clamp(Math.trunc(policy.projectionPcaDims), 8, 128),
    projectionUmapNeighbors: clamp(
      Math.trunc(policy.projectionUmapNeighbors),
      5,
      100,
    ),
    projectionUmapMinDist: clamp(policy.projectionUmapMinDist, 0.01, 0.99),
    projectionSeed: clamp(Math.trunc(policy.projectionSeed), 0, 2_147_483_647),
    projectionBudgetMs: clamp(
      Math.trunc(policy.projectionBudgetMs),
      1_000,
      600_000,
    ),
  };
}

function normalizeArbitrageDefaultsPolicy(
  policy: ArbitrageDefaultsPolicy,
): ArbitrageDefaultsPolicy {
  return {
    limit: clamp(Math.trunc(policy.limit), 1, 200),
    minVenueCount: clamp(Math.trunc(policy.minVenueCount), 1, 10),
    minSpread: clamp(policy.minSpread, 0, 1),
    minQualityScore: clamp(policy.minQualityScore, 0, 1),
  };
}

function normalizeMerged<K extends IntelPolicyKey>(
  key: K,
  merged: IntelPolicyMap[K],
): IntelPolicyMap[K] {
  switch (key) {
    case "wallet_intel_signals":
      return normalizeSignalsPolicy(merged as WalletIntelSignalsPolicy) as IntelPolicyMap[K];
    case "wallet_intel_refresh":
      return normalizeRefreshPolicy(merged as WalletIntelRefreshPolicy) as IntelPolicyMap[K];
    case "wallet_intel_attribution":
      return normalizeAttributionPolicy(
        merged as WalletIntelAttributionPolicy,
      ) as IntelPolicyMap[K];
    case "ai_whale_profiles":
      return normalizeAiWhaleProfilesPolicy(merged as AiWhaleProfilesPolicy) as IntelPolicyMap[K];
    case "ai_clusters":
      return normalizeAiClustersPolicy(merged as AiClustersPolicy) as IntelPolicyMap[K];
    case "market_map":
      return normalizeMarketMapPolicy(merged as MarketMapPolicy) as IntelPolicyMap[K];
    case "arbitrage_defaults":
      return normalizeArbitrageDefaultsPolicy(merged as ArbitrageDefaultsPolicy) as IntelPolicyMap[K];
    default:
      return merged;
  }
}

function sanitizeOverridePayload(
  key: IntelPolicyKey,
  payload: unknown,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const record = { ...(payload as Record<string, unknown>) };
  switch (key) {
    case "wallet_intel_signals": {
      delete record.requireOpenNow;
      delete record.notificationsEnabled;
      delete record.notifyMinScore;
      return record;
    }
    case "wallet_intel_refresh": {
      delete record.rpcSoftFailMode;
      delete record.maxHolderErrorsBeforeAbort;
      delete record.selectionVenueWeights;
      return record;
    }
    case "wallet_intel_attribution": {
      // Backward compatibility: older overrides may still include llmOverlay.
      delete record.llmOverlay;
      return record;
    }
    case "ai_clusters": {
      delete record.stageATimeoutMs;
      delete record.stageBTimeoutMs;
      delete record.forceFinalOnly;
      return record;
    }
    case "market_map": {
      delete record.projectionAlgo;
      delete record.layoutMode;
      return record;
    }
    case "ai_whale_profiles": {
      delete record.strictNoInsiderLanguage;
      return record;
    }
    case "arbitrage_defaults": {
      delete record.minAnalysisConfidence;
      delete record.maxOutlierRatio;
      return record;
    }
    default:
      return record;
  }
}

function validateOverride<K extends IntelPolicyKey>(
  key: K,
  payload: unknown,
): { valid: boolean; value: Partial<IntelPolicyMap[K]> | null } {
  const schema = policySchemas[key];
  const parsed = schema.safeParse(sanitizeOverridePayload(key, payload));
  if (!parsed.success) return { valid: false, value: null };
  return { valid: true, value: parsed.data as Partial<IntelPolicyMap[K]> };
}

export function getIntelPolicyDefaults<K extends IntelPolicyKey>(
  key: K,
): IntelPolicyMap[K] {
  return getDefaults()[key];
}

export function getIntelPolicySchema<K extends IntelPolicyKey>(
  key: K,
) {
  return policySchemas[key];
}

function resolveFromRow<K extends IntelPolicyKey>(
  key: K,
  row: RuntimePolicyRow | null,
): IntelPolicyResult<K> {
  const defaults = getIntelPolicyDefaults(key);
  if (!row) {
    return {
      key,
      source: "env",
      effectiveAt: null,
      createdAt: null,
      defaults,
      override: null,
      effective: normalizeMerged(key, defaults),
      invalidOverride: false,
    };
  }

  const parsed = validateOverride(key, row.payload);
  if (!parsed.valid || !parsed.value) {
    const warnKey = `${key}:${row.effective_at.toISOString()}`;
    if (!warnedInvalidOverrides.has(warnKey)) {
      warnedInvalidOverrides.add(warnKey);
      console.warn(
        "[runtime-policies] Invalid policy override payload; falling back to env defaults",
        { policyKey: key, effectiveAt: row.effective_at.toISOString() },
      );
    }
    return {
      key,
      source: "env",
      effectiveAt: row.effective_at,
      createdAt: row.created_at,
      defaults,
      override: null,
      effective: normalizeMerged(key, defaults),
      invalidOverride: true,
    };
  }

  const merged = deepMerge(defaults, parsed.value ?? {}) as IntelPolicyMap[K];
  const effective = normalizeMerged(key, merged);

  return {
    key,
    source: "db",
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
    defaults,
    override: parsed.value,
    effective,
    invalidOverride: false,
  };
}

export async function resolveIntelPolicy<K extends IntelPolicyKey>(
  pool: DbQuery,
  key: K,
): Promise<IntelPolicyResult<K>> {
  const row = await fetchActiveRuntimePolicy(pool, key);
  return resolveFromRow(key, row);
}

export async function resolveAllIntelPolicies(
  pool: DbQuery,
): Promise<{ [K in IntelPolicyKey]: IntelPolicyResult<K> }> {
  const rows = await listActiveRuntimePolicies(pool);
  const byKey = new Map(rows.map((row) => [row.policy_key, row]));
  return {
    wallet_intel_signals: resolveFromRow(
      "wallet_intel_signals",
      byKey.get("wallet_intel_signals") ?? null,
    ),
    wallet_intel_refresh: resolveFromRow(
      "wallet_intel_refresh",
      byKey.get("wallet_intel_refresh") ?? null,
    ),
    wallet_intel_attribution: resolveFromRow(
      "wallet_intel_attribution",
      byKey.get("wallet_intel_attribution") ?? null,
    ),
    ai_whale_profiles: resolveFromRow(
      "ai_whale_profiles",
      byKey.get("ai_whale_profiles") ?? null,
    ),
    ai_clusters: resolveFromRow(
      "ai_clusters",
      byKey.get("ai_clusters") ?? null,
    ),
    market_map: resolveFromRow(
      "market_map",
      byKey.get("market_map") ?? null,
    ),
    arbitrage_defaults: resolveFromRow(
      "arbitrage_defaults",
      byKey.get("arbitrage_defaults") ?? null,
    ),
  };
}

export async function resolveWalletIntelSignalsPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "wallet_intel_signals");
}

export async function resolveWalletIntelRefreshPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "wallet_intel_refresh");
}

export async function resolveWalletIntelAttributionPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "wallet_intel_attribution");
}

export async function resolveAiWhaleProfilesPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "ai_whale_profiles");
}

export async function resolveAiClustersPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "ai_clusters");
}

export async function resolveMarketMapPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "market_map");
}

export async function resolveArbitrageDefaultsPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "arbitrage_defaults");
}
