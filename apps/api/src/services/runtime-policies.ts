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
  "auth_access",
  "wallet_intel_signals",
  "wallet_intel_refresh",
  "wallet_intel_attribution",
  "api_cache_warm",
  "ai_whale_profiles",
  "ai_clusters",
  "market_map",
  "map_search",
  "map_signals",
  "arbitrage_defaults",
] as const;

export type IntelPolicyKey = (typeof INTEL_POLICY_KEYS)[number];

type PolicySource = "env" | "db";

export type AuthAccessState = "off" | "prompt" | "required";
export type EmbeddedSolanaSponsorshipMode = "observe" | "enforce";
export type EmbeddedSolanaSponsorshipFlowsPolicy = {
  dflow: boolean;
  across: boolean;
  directTransfer: boolean;
  debridge: boolean;
};

export type AuthAccessPolicy = {
  state: AuthAccessState;
  embeddedSolanaSponsorship: boolean;
  embeddedSolanaSponsorshipMode: EmbeddedSolanaSponsorshipMode;
  embeddedSolanaSponsorshipFlows: EmbeddedSolanaSponsorshipFlowsPolicy;
};

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
  safeLinkLimit: number;
  safeLinkStaleHours: number;
  safeLinkErrorStaleHours: number;
};

export type AiWhaleProfilesPolicy = {
  autoRun: boolean;
  limit: number;
  marketLimit: number;
  windowDays: number;
  selectionMode: "recent" | "pnl" | "hybrid" | "tracker_like";
  selectionRecentLimit: number;
  selectionPnlLimit: number;
  selectionTrackerRecentLimit: number;
  selectionTrackerPnlLimit: number;
  selectionTrackerWinRateLimit: number;
  selectionSignalsLimit: number;
  selectionTrackerWindowHours: number;
  selectionTrackerSurfaceLimit: number;
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

export type ApiCacheWarmPolicy = {
  enabled: boolean;
  pollIntervalSec: number;
  requestTimeoutMs: number;
  warmFeed: boolean;
  warmMarketMap: boolean;
  warmWalletIntel: boolean;
};

export type MarketMapPolicy = {
  enabled: boolean;
  triggerMode: "interval" | "cron";
  pollIntervalSec: number;
  scheduleCron: string | null;
  runWindowMinutes: number;
  maxRunsPerWindow: number;
  maxRunsPerDay: number;
  budgetWindowMinutes: number;
  budgetWindowUsd: number;
  dayBudgetUsd: number;
  estimatedRunCostUsd: number;
  lockTtlSec: number;
  lockHeartbeatSec: number;
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

export type MapSearchPolicy = {
  enabled: boolean;
  triggerMode: "interval" | "cron";
  pollIntervalSec: number;
  scheduleCron: string | null;
  runWindowMinutes: number;
  maxRunsPerWindow: number;
  maxRunsPerDay: number;
  budgetWindowMinutes: number;
  budgetWindowUsd: number;
  dayBudgetUsd: number;
  estimatedRunCostUsd: number;
  lockTtlSec: number;
  lockHeartbeatSec: number;
  artifactTtlSec: number;
  stateTtlSec: number;
  statusTtlSec: number;
  reuseMode:
    | "auto"
    | "cold_start"
    | "same_run_diversify"
    | "same_run_seed"
    | "resume_same_run"
    | "warm_start_prior_run";
  persistenceMode: "artifact_only" | "normalized_keys";
  model: string;
  embedModel: string;
  toolMode: "both" | "web" | "x" | "none";
  strictSchema: boolean;
  requireDistinctDomains: boolean;
  concurrency: number;
  maxCalls: number;
  budgetUsd: number;
  timeoutSec: number;
  maxRetries: number;
  retryBaseMs: number;
  maxTotalInputTokens: number;
  maxTotalOutputTokens: number;
  maxTotalToolAttempts: number;
  maxToolAttemptsPerCall: number;
  maxEvidencePerCall: number;
  maxEvidenceTotal: number;
  windowHoursL1: number;
  windowHoursL2: number;
  windowHoursL3: number;
  recentHoursHint: number;
  topRootCount: number;
  branchPerCall: number;
  eventSampleLimit: number;
  childSampleLimit: number;
  siblingSampleLimit: number;
  routeThresholdL1: number;
  routeThresholdL2: number;
  routeThresholdL3: number;
  routeMinSimilarity: number;
  routeMinMarginL1: number;
  routeMinMarginL2: number;
  routeMinMarginL3: number;
  sourceAllowDomains: string[];
  sourceDenyDomains: string[];
  maxXEvidencePerCall: number;
  maxUnconfirmedEvidencePerCall: number;
  lowYieldToolAttemptThreshold: number;
  lowYieldConsecutiveThreshold: number;
  enforceFreshness: boolean;
  reportTopLeaves: number;
  reportTopEvidence: number;
  warmStartEvidenceLimit: number;
  warmStartMinSimilarity: number;
  warmStartQueueBoost: number;
  sameRunNoveltyAlpha: number;
  sameRunNoveltyFloor: number;
  sameRunNoveltyBoost: number;
  dryRun: boolean;
  verbose: boolean;
  leanOutput: boolean;
  verboseOutput: boolean;
};

export type MapSignalsPolicy = {
  enabled: boolean;
  triggerMode: "interval" | "cron";
  pollIntervalSec: number;
  scheduleCron: string | null;
  runWindowMinutes: number;
  maxRunsPerWindow: number;
  maxRunsPerDay: number;
  budgetWindowMinutes: number;
  budgetWindowUsd: number;
  dayBudgetUsd: number;
  estimatedRunCostUsd: number;
  lockTtlSec: number;
  lockHeartbeatSec: number;
  artifactTtlSec: number;
  statusTtlSec: number;
  inputDigestEnabled: boolean;
  model: string;
  embedModel: string;
  maxNodes: number;
  maxSignals: number;
  maxEvidencePerNode: number;
  topMarketsPerEvent: number;
  maxMarketsPerNode: number;
  minEvidence: number;
  minConfirmed: number;
  minDistinctDomains: number;
  minEvidenceIdsForPublish: number;
  minAffinityForPublish: number;
  concurrency: number;
  maxOutputTokens: number;
  timeoutSec: number;
  maxRetries: number;
  retryBaseMs: number;
  dryRun: boolean;
  verbose: boolean;
  persistNotes: boolean;
  maxPublishPerRun: number;
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
  botMinActiveUtcHourSlots30d: number;
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
  auth_access: AuthAccessPolicy;
  wallet_intel_signals: WalletIntelSignalsPolicy;
  wallet_intel_refresh: WalletIntelRefreshPolicy;
  wallet_intel_attribution: WalletIntelAttributionPolicy;
  api_cache_warm: ApiCacheWarmPolicy;
  ai_whale_profiles: AiWhaleProfilesPolicy;
  ai_clusters: AiClustersPolicy;
  market_map: MarketMapPolicy;
  map_search: MapSearchPolicy;
  map_signals: MapSignalsPolicy;
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
    safeLinkLimit: nonNegativeInt,
    safeLinkStaleHours: positiveInt,
    safeLinkErrorStaleHours: positiveInt,
  })
  .strict()
  .partial();

const aiWhaleProfilesSchema = z
  .object({
    autoRun: strictBoolean,
    limit: positiveInt,
    marketLimit: positiveInt,
    windowDays: positiveInt,
    selectionMode: z.enum(["recent", "pnl", "hybrid", "tracker_like"]),
    selectionRecentLimit: nonNegativeInt,
    selectionPnlLimit: nonNegativeInt,
    selectionTrackerRecentLimit: nonNegativeInt,
    selectionTrackerPnlLimit: nonNegativeInt,
    selectionTrackerWinRateLimit: nonNegativeInt,
    selectionSignalsLimit: nonNegativeInt,
    selectionTrackerWindowHours: positiveInt,
    selectionTrackerSurfaceLimit: positiveInt,
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
    triggerMode: z.enum(["interval", "cron"]),
    pollIntervalSec: positiveInt.max(60 * 60 * 24),
    scheduleCron: z.string().trim().min(1).max(200).nullable(),
    runWindowMinutes: positiveInt.max(60 * 24 * 30),
    maxRunsPerWindow: positiveInt.max(1_000),
    maxRunsPerDay: positiveInt.max(1_000),
    budgetWindowMinutes: positiveInt.max(60 * 24 * 30),
    budgetWindowUsd: nonNegativeNumber.max(1_000_000),
    dayBudgetUsd: nonNegativeNumber.max(1_000_000),
    estimatedRunCostUsd: nonNegativeNumber.max(100_000),
    lockTtlSec: positiveInt.max(60 * 60 * 24),
    lockHeartbeatSec: positiveInt.max(60 * 60 * 24),
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

const mapSearchToolModeSchema = z.enum(["both", "web", "x", "none"]);
const mapSearchReuseModeSchema = z.enum([
  "auto",
  "cold_start",
  "same_run_diversify",
  "same_run_seed",
  "resume_same_run",
  "warm_start_prior_run",
]);
const mapSearchPersistenceModeSchema = z.enum([
  "artifact_only",
  "normalized_keys",
]);

const mapSearchSchema = z
  .object({
    enabled: strictBoolean,
    triggerMode: z.enum(["interval", "cron"]),
    pollIntervalSec: positiveInt.max(60 * 60 * 24),
    scheduleCron: z.string().trim().min(1).max(200).nullable(),
    runWindowMinutes: positiveInt.max(60 * 24 * 30),
    maxRunsPerWindow: positiveInt.max(1_000),
    maxRunsPerDay: positiveInt.max(1_000),
    budgetWindowMinutes: positiveInt.max(60 * 24 * 30),
    budgetWindowUsd: nonNegativeNumber.max(1_000_000),
    dayBudgetUsd: nonNegativeNumber.max(1_000_000),
    estimatedRunCostUsd: nonNegativeNumber.max(100_000),
    lockTtlSec: positiveInt.max(60 * 60 * 24),
    lockHeartbeatSec: positiveInt.max(60 * 60 * 24),
    artifactTtlSec: positiveInt.max(60 * 60 * 24 * 30),
    stateTtlSec: positiveInt.max(60 * 60 * 24 * 30),
    statusTtlSec: positiveInt.max(60 * 60 * 24 * 30),
    reuseMode: mapSearchReuseModeSchema,
    persistenceMode: mapSearchPersistenceModeSchema,
    model: z.string().trim().min(1).max(200),
    embedModel: z.string().trim().min(1).max(200),
    toolMode: mapSearchToolModeSchema,
    strictSchema: strictBoolean,
    requireDistinctDomains: strictBoolean,
    concurrency: positiveInt.max(8),
    maxCalls: positiveInt.max(1_000),
    budgetUsd: nonNegativeNumber.max(1_000_000),
    timeoutSec: positiveInt.max(60 * 10),
    maxRetries: nonNegativeInt.max(10),
    retryBaseMs: positiveInt.max(60_000),
    maxTotalInputTokens: positiveInt.max(10_000_000),
    maxTotalOutputTokens: positiveInt.max(10_000_000),
    maxTotalToolAttempts: positiveInt.max(100_000),
    maxToolAttemptsPerCall: positiveInt.max(1_000),
    maxEvidencePerCall: positiveInt.max(100),
    maxEvidenceTotal: positiveInt.max(10_000),
    windowHoursL1: positiveInt.max(24 * 30),
    windowHoursL2: positiveInt.max(24 * 30),
    windowHoursL3: positiveInt.max(24 * 30),
    recentHoursHint: positiveInt.max(24 * 30),
    topRootCount: positiveInt.max(200),
    branchPerCall: positiveInt.max(50),
    eventSampleLimit: positiveInt.max(200),
    childSampleLimit: positiveInt.max(200),
    siblingSampleLimit: positiveInt.max(200),
    routeThresholdL1: ratio,
    routeThresholdL2: ratio,
    routeThresholdL3: ratio,
    routeMinSimilarity: ratio,
    routeMinMarginL1: ratio,
    routeMinMarginL2: ratio,
    routeMinMarginL3: ratio,
    sourceAllowDomains: z.array(z.string().trim().min(1).max(128)).max(256),
    sourceDenyDomains: z.array(z.string().trim().min(1).max(128)).max(256),
    maxXEvidencePerCall: nonNegativeInt.max(100),
    maxUnconfirmedEvidencePerCall: nonNegativeInt.max(100),
    lowYieldToolAttemptThreshold: positiveInt.max(1_000),
    lowYieldConsecutiveThreshold: positiveInt.max(1_000),
    enforceFreshness: strictBoolean,
    reportTopLeaves: positiveInt.max(200),
    reportTopEvidence: positiveInt.max(200),
    warmStartEvidenceLimit: positiveInt.max(5_000),
    warmStartMinSimilarity: ratio,
    warmStartQueueBoost: nonNegativeNumber.max(10),
    sameRunNoveltyAlpha: nonNegativeNumber.max(20),
    sameRunNoveltyFloor: ratio,
    sameRunNoveltyBoost: nonNegativeNumber.max(10),
    dryRun: strictBoolean,
    verbose: strictBoolean,
    leanOutput: strictBoolean,
    verboseOutput: strictBoolean,
  })
  .strict()
  .partial();

const mapSignalsSchema = z
  .object({
    enabled: strictBoolean,
    triggerMode: z.enum(["interval", "cron"]),
    pollIntervalSec: positiveInt.max(60 * 60 * 24),
    scheduleCron: z.string().trim().min(1).max(200).nullable(),
    runWindowMinutes: positiveInt.max(60 * 24 * 30),
    maxRunsPerWindow: positiveInt.max(1_000),
    maxRunsPerDay: positiveInt.max(1_000),
    budgetWindowMinutes: positiveInt.max(60 * 24 * 30),
    budgetWindowUsd: nonNegativeNumber.max(1_000_000),
    dayBudgetUsd: nonNegativeNumber.max(1_000_000),
    estimatedRunCostUsd: nonNegativeNumber.max(100_000),
    lockTtlSec: positiveInt.max(60 * 60 * 24),
    lockHeartbeatSec: positiveInt.max(60 * 60 * 24),
    artifactTtlSec: positiveInt.max(60 * 60 * 24 * 30),
    statusTtlSec: positiveInt.max(60 * 60 * 24 * 30),
    inputDigestEnabled: strictBoolean,
    model: z.string().trim().min(1).max(200),
    embedModel: z.string().trim().min(1).max(200),
    maxNodes: positiveInt.max(500),
    maxSignals: positiveInt.max(500),
    maxEvidencePerNode: positiveInt.max(200),
    topMarketsPerEvent: positiveInt.max(20),
    maxMarketsPerNode: positiveInt.max(200),
    minEvidence: positiveInt.max(50),
    minConfirmed: nonNegativeInt.max(50),
    minDistinctDomains: positiveInt.max(50),
    minEvidenceIdsForPublish: positiveInt.max(50),
    minAffinityForPublish: ratio,
    concurrency: positiveInt.max(16),
    maxOutputTokens: positiveInt.max(8_000),
    timeoutSec: positiveInt.max(60 * 10),
    maxRetries: nonNegativeInt.max(10),
    retryBaseMs: positiveInt.max(60_000),
    dryRun: strictBoolean,
    verbose: strictBoolean,
    persistNotes: strictBoolean,
    maxPublishPerRun: positiveInt.max(5_000),
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

const apiCacheWarmSchema = z
  .object({
    enabled: strictBoolean,
    pollIntervalSec: positiveInt.max(60 * 60 * 24),
    requestTimeoutMs: positiveInt.max(60_000),
    warmFeed: strictBoolean,
    warmMarketMap: strictBoolean,
    warmWalletIntel: strictBoolean,
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
    botMinActiveUtcHourSlots30d: nonNegativeInt.max(24),
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
    kalshi: z.object({ specialistEnabled: strictBoolean }).strict().partial(),
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

const authAccessStateSchema = z.enum(["off", "prompt", "required"]);
const embeddedSolanaSponsorshipModeSchema = z.enum(["observe", "enforce"]);
const embeddedSolanaSponsorshipFlowsSchema = z
  .object({
    dflow: strictBoolean,
    across: strictBoolean,
    directTransfer: strictBoolean,
    debridge: strictBoolean,
  })
  .strict()
  .partial();
const authAccessSchema = z
  .object({
    state: authAccessStateSchema,
    embeddedSolanaSponsorship: strictBoolean,
    embeddedSolanaSponsorshipMode: embeddedSolanaSponsorshipModeSchema,
    embeddedSolanaSponsorshipFlows: embeddedSolanaSponsorshipFlowsSchema,
  })
  .strict()
  .partial();

const policySchemas = {
  auth_access: authAccessSchema,
  wallet_intel_signals: walletIntelSignalsSchema,
  wallet_intel_refresh: walletIntelRefreshSchema,
  wallet_intel_attribution: walletIntelAttributionSchema,
  api_cache_warm: apiCacheWarmSchema,
  ai_whale_profiles: aiWhaleProfilesSchema,
  ai_clusters: aiClustersSchema,
  market_map: marketMapSchema,
  map_search: mapSearchSchema,
  map_signals: mapSignalsSchema,
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
  botMinActiveUtcHourSlots30d: 16,
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
  policy: Pick<
    WalletIntelSignalsPolicy,
    "windowHoursDefault" | "windowHoursMax"
  >,
): number {
  const windowMax = Math.max(1, Math.trunc(policy.windowHoursMax));
  const windowDefault = clamp(
    Math.trunc(policy.windowHoursDefault),
    1,
    windowMax,
  );
  if (queryWindowHours == null) return windowDefault;
  const requested = Math.trunc(queryWindowHours);
  if (!Number.isFinite(requested)) return windowDefault;
  return clamp(requested, 1, windowMax);
}

function getDefaults(): IntelPolicyMap {
  return {
    auth_access: {
      state: env.authAccessState,
      embeddedSolanaSponsorship: env.embeddedSolanaSponsorshipEnabled,
      embeddedSolanaSponsorshipMode: "enforce",
      embeddedSolanaSponsorshipFlows: {
        dflow: false,
        across: false,
        directTransfer: false,
        debridge: false,
      },
    },
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
      safeLinkLimit: env.walletIntelSafeLinkLimit,
      safeLinkStaleHours: env.walletIntelSafeLinkStaleHours,
      safeLinkErrorStaleHours: env.walletIntelSafeLinkErrorStaleHours,
    },
    wallet_intel_attribution: getWalletIntelAttributionDefaults(),
    api_cache_warm: {
      enabled: false,
      pollIntervalSec: 30,
      requestTimeoutMs: 10_000,
      warmFeed: true,
      warmMarketMap: true,
      warmWalletIntel: true,
    },
    ai_whale_profiles: {
      autoRun: env.aiWhaleProfileAutoRun,
      limit: env.aiWhaleProfileLimit,
      marketLimit: env.aiWhaleProfileMarketLimit,
      windowDays: env.aiWhaleProfileWindowDays,
      selectionMode: env.aiWhaleProfileSelectionMode,
      selectionRecentLimit: env.aiWhaleProfileSelectionRecentLimit,
      selectionPnlLimit: env.aiWhaleProfileSelectionPnlLimit,
      selectionTrackerRecentLimit:
        env.aiWhaleProfileSelectionTrackerRecentLimit,
      selectionTrackerPnlLimit: env.aiWhaleProfileSelectionTrackerPnlLimit,
      selectionTrackerWinRateLimit:
        env.aiWhaleProfileSelectionTrackerWinRateLimit,
      selectionSignalsLimit: env.aiWhaleProfileSelectionSignalsLimit,
      selectionTrackerWindowHours:
        env.aiWhaleProfileSelectionTrackerWindowHours,
      selectionTrackerSurfaceLimit:
        env.aiWhaleProfileSelectionTrackerSurfaceLimit,
      selectionSignalsWindowHours:
        env.aiWhaleProfileSelectionSignalsWindowHours,
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
      triggerMode: env.aiMarketMapTriggerMode,
      pollIntervalSec: env.aiMarketMapPollIntervalSec,
      scheduleCron: env.aiMarketMapScheduleCron,
      runWindowMinutes: env.aiMarketMapRunWindowMinutes,
      maxRunsPerWindow: env.aiMarketMapMaxRunsPerWindow,
      maxRunsPerDay: env.aiMarketMapMaxRunsPerDay,
      budgetWindowMinutes: env.aiMarketMapBudgetWindowMinutes,
      budgetWindowUsd: env.aiMarketMapBudgetWindowUsd,
      dayBudgetUsd: env.aiMarketMapDayBudgetUsd,
      estimatedRunCostUsd: env.aiMarketMapEstimatedRunCostUsd,
      lockTtlSec: env.aiMarketMapLockTtlSec,
      lockHeartbeatSec: env.aiMarketMapLockHeartbeatSec,
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
    map_search: {
      enabled: env.aiMapSearchEnabled,
      triggerMode: "interval",
      pollIntervalSec: 60 * 60,
      scheduleCron: null,
      runWindowMinutes: 60,
      maxRunsPerWindow: 1,
      maxRunsPerDay: 24,
      budgetWindowMinutes: 60 * 24,
      budgetWindowUsd: 10,
      dayBudgetUsd: 25,
      estimatedRunCostUsd: 1,
      lockTtlSec: 60 * 30,
      lockHeartbeatSec: 30,
      artifactTtlSec: 60 * 60 * 24 * 3,
      stateTtlSec: 60 * 60 * 24 * 3,
      statusTtlSec: 60 * 60 * 24 * 7,
      reuseMode: "auto",
      persistenceMode: "normalized_keys",
      model: process.env.XAI_SEARCH_MODEL?.trim() || "grok-4-1-fast-reasoning",
      embedModel:
        process.env.OPENROUTER_EMBED_MODEL ||
        process.env.AI_EMBED_MODEL ||
        "intfloat/e5-large-v2",
      toolMode: "both",
      strictSchema: true,
      requireDistinctDomains: true,
      concurrency: 4,
      maxCalls: 16,
      budgetUsd: 1,
      timeoutSec: 80,
      maxRetries: 1,
      retryBaseMs: 1200,
      maxTotalInputTokens: 500_000,
      maxTotalOutputTokens: 150_000,
      maxTotalToolAttempts: 600,
      maxToolAttemptsPerCall: 20,
      maxEvidencePerCall: 8,
      maxEvidenceTotal: 240,
      windowHoursL1: 96,
      windowHoursL2: 72,
      windowHoursL3: 24,
      recentHoursHint: 6,
      topRootCount: 6,
      branchPerCall: 3,
      eventSampleLimit: 10,
      childSampleLimit: 8,
      siblingSampleLimit: 6,
      routeThresholdL1: 0.2,
      routeThresholdL2: 0.24,
      routeThresholdL3: 0.28,
      routeMinSimilarity: 0,
      routeMinMarginL1: 0.015,
      routeMinMarginL2: 0.02,
      routeMinMarginL3: 0.025,
      sourceAllowDomains: [],
      sourceDenyDomains: [
        "polymarket.com",
        "kalshi.com",
        "limitless.exchange",
        "hunch.trade",
        "app.hunch.trade",
        "instagram.com",
        "facebook.com",
        "tiktok.com",
        "mexc.com",
        "mexc.co",
        "kucoin.com",
      ],
      maxXEvidencePerCall: 2,
      maxUnconfirmedEvidencePerCall: 2,
      lowYieldToolAttemptThreshold: 10,
      lowYieldConsecutiveThreshold: 3,
      enforceFreshness: true,
      reportTopLeaves: 10,
      reportTopEvidence: 20,
      warmStartEvidenceLimit: 120,
      warmStartMinSimilarity: 0.18,
      warmStartQueueBoost: 0.8,
      sameRunNoveltyAlpha: 1.2,
      sameRunNoveltyFloor: 0.35,
      sameRunNoveltyBoost: 0.25,
      dryRun: false,
      verbose: false,
      leanOutput: false,
      verboseOutput: false,
    },
    map_signals: {
      enabled: env.aiMapSignalsEnabled,
      triggerMode: "interval",
      pollIntervalSec: 60 * 60,
      scheduleCron: null,
      runWindowMinutes: 60,
      maxRunsPerWindow: 1,
      maxRunsPerDay: 24,
      budgetWindowMinutes: 60 * 24,
      budgetWindowUsd: 10,
      dayBudgetUsd: 25,
      estimatedRunCostUsd: 0.25,
      lockTtlSec: 60 * 30,
      lockHeartbeatSec: 30,
      artifactTtlSec: 60 * 60 * 24 * 3,
      statusTtlSec: 60 * 60 * 24 * 7,
      inputDigestEnabled: true,
      model: "openai/gpt-5.4",
      embedModel:
        process.env.OPENROUTER_EMBED_MODEL ||
        process.env.AI_EMBED_MODEL ||
        "intfloat/e5-large-v2",
      maxNodes: 20,
      maxSignals: 20,
      maxEvidencePerNode: 12,
      topMarketsPerEvent: 5,
      maxMarketsPerNode: 12,
      minEvidence: 1,
      minConfirmed: 1,
      minDistinctDomains: 1,
      minEvidenceIdsForPublish: 1,
      minAffinityForPublish: 0.15,
      concurrency: 4,
      maxOutputTokens: 900,
      timeoutSec: 90,
      maxRetries: 1,
      retryBaseMs: 1200,
      dryRun: false,
      verbose: false,
      persistNotes: false,
      maxPublishPerRun: 200,
    },
    arbitrage_defaults: {
      limit: 24,
      minVenueCount: 2,
      minSpread: 0.03,
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
  const marketLimitPerVenue = Math.max(
    0,
    Math.trunc(policy.marketLimitPerVenue),
  );
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
    retentionDaysSnapshots: Math.max(
      0,
      Math.trunc(policy.retentionDaysSnapshots),
    ),
    retentionDaysActivity: Math.max(
      0,
      Math.trunc(policy.retentionDaysActivity),
    ),
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
    safeLinkLimit: Math.max(0, Math.trunc(policy.safeLinkLimit)),
    safeLinkStaleHours: Math.max(1, Math.trunc(policy.safeLinkStaleHours)),
    safeLinkErrorStaleHours: Math.max(
      1,
      Math.trunc(policy.safeLinkErrorStaleHours),
    ),
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
    highFrequencyTrades30d: Math.max(
      0,
      Math.trunc(value.highFrequencyTrades30d),
    ),
    botMinActiveDays30d: clamp(Math.trunc(value.botMinActiveDays30d), 0, 31),
    botMinActiveUtcHourSlots30d: clamp(
      Math.trunc(value.botMinActiveUtcHourSlots30d),
      0,
      24,
    ),
    botMaxMedianStakeUsd: Math.max(0, value.botMaxMedianStakeUsd),
    volumeTraderVolume30dUsd: Math.max(0, value.volumeTraderVolume30dUsd),
    specialistCategoryShareMin: clamp(value.specialistCategoryShareMin, 0, 1),
    insiderCriticalSignals30dMin: Math.max(
      0,
      Math.trunc(value.insiderCriticalSignals30dMin),
    ),
    insiderAvgSignalScoreMin: clamp(value.insiderAvgSignalScoreMin, 0, 1),
    insiderMinResolvedBets: Math.max(
      0,
      Math.trunc(value.insiderMinResolvedBets),
    ),
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
      listPrimaryCount: clamp(
        Math.trunc(policy.display.listPrimaryCount),
        1,
        5,
      ),
      listSecondaryCount: clamp(
        Math.trunc(policy.display.listSecondaryCount),
        0,
        10,
      ),
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
      kalshi: normalizeAttributionVenueThresholds(
        policy.venueThresholds.kalshi,
      ),
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
      whalesBatchSize: clamp(
        Math.trunc(policy.queryControls.whalesBatchSize),
        10,
        1_000,
      ),
      whalesMaxScanCandidates: clamp(
        Math.trunc(policy.queryControls.whalesMaxScanCandidates),
        100,
        20_000,
      ),
    },
    venueCapabilities: {
      polymarket: {
        specialistEnabled: Boolean(
          policy.venueCapabilities.polymarket.specialistEnabled,
        ),
      },
      kalshi: {
        specialistEnabled: Boolean(
          policy.venueCapabilities.kalshi.specialistEnabled,
        ),
      },
      limitless: {
        specialistEnabled: Boolean(
          policy.venueCapabilities.limitless.specialistEnabled,
        ),
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
    selectionTrackerRecentLimit: Math.max(
      0,
      Math.trunc(policy.selectionTrackerRecentLimit),
    ),
    selectionTrackerPnlLimit: Math.max(
      0,
      Math.trunc(policy.selectionTrackerPnlLimit),
    ),
    selectionTrackerWinRateLimit: Math.max(
      0,
      Math.trunc(policy.selectionTrackerWinRateLimit),
    ),
    selectionSignalsLimit: Math.max(
      0,
      Math.trunc(policy.selectionSignalsLimit),
    ),
    selectionTrackerWindowHours: clamp(
      Math.trunc(policy.selectionTrackerWindowHours),
      1,
      24 * 14,
    ),
    selectionTrackerSurfaceLimit: clamp(
      Math.trunc(policy.selectionTrackerSurfaceLimit),
      1,
      1_000,
    ),
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

function normalizeApiCacheWarmPolicy(
  policy: ApiCacheWarmPolicy,
): ApiCacheWarmPolicy {
  return {
    enabled: Boolean(policy.enabled),
    pollIntervalSec: clamp(
      Math.trunc(policy.pollIntervalSec),
      15,
      60 * 60 * 24,
    ),
    requestTimeoutMs: clamp(Math.trunc(policy.requestTimeoutMs), 250, 60_000),
    warmFeed: Boolean(policy.warmFeed),
    warmMarketMap: Boolean(policy.warmMarketMap),
    warmWalletIntel: Boolean(policy.warmWalletIntel),
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
    analysisMinVenueCount: clamp(
      Math.trunc(policy.analysisMinVenueCount),
      1,
      20,
    ),
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
    triggerMode:
      policy.triggerMode === "cron" || policy.triggerMode === "interval"
        ? policy.triggerMode
        : "interval",
    pollIntervalSec: clamp(
      Math.trunc(policy.pollIntervalSec),
      60,
      60 * 60 * 24,
    ),
    scheduleCron:
      typeof policy.scheduleCron === "string" &&
      policy.scheduleCron.trim().length > 0
        ? policy.scheduleCron.trim()
        : null,
    runWindowMinutes: clamp(
      Math.trunc(policy.runWindowMinutes ?? 60),
      1,
      60 * 24 * 30,
    ),
    maxRunsPerWindow: clamp(Math.trunc(policy.maxRunsPerWindow ?? 1), 1, 1_000),
    maxRunsPerDay: clamp(Math.trunc(policy.maxRunsPerDay ?? 24), 1, 1_000),
    budgetWindowMinutes: clamp(
      Math.trunc(policy.budgetWindowMinutes ?? 1_440),
      1,
      60 * 24 * 30,
    ),
    budgetWindowUsd: clamp(policy.budgetWindowUsd ?? 10, 0, 1_000_000),
    dayBudgetUsd: clamp(policy.dayBudgetUsd ?? 25, 0, 1_000_000),
    estimatedRunCostUsd: clamp(
      policy.estimatedRunCostUsd ?? env.aiMarketMapEstimatedRunCostUsd,
      0,
      100_000,
    ),
    lockTtlSec: clamp(Math.trunc(policy.lockTtlSec ?? 7_200), 60, 60 * 60 * 24),
    lockHeartbeatSec: clamp(
      Math.trunc(policy.lockHeartbeatSec ?? 30),
      10,
      60 * 60 * 24,
    ),
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

function normalizeMapSearchPolicy(policy: MapSearchPolicy): MapSearchPolicy {
  const normalizeDomains = (domains: string[]): string[] =>
    Array.from(
      new Set(
        (domains ?? [])
          .map((value) =>
            value
              .trim()
              .toLowerCase()
              .replace(/^https?:\/\//, "")
              .replace(/^www\./, ""),
          )
          .filter((value) => value.length > 0),
      ),
    ).slice(0, 256);

  return {
    ...policy,
    enabled: Boolean(policy.enabled),
    triggerMode:
      policy.triggerMode === "cron" || policy.triggerMode === "interval"
        ? policy.triggerMode
        : "interval",
    pollIntervalSec: clamp(
      Math.trunc(policy.pollIntervalSec),
      60,
      60 * 60 * 24,
    ),
    scheduleCron:
      typeof policy.scheduleCron === "string" &&
      policy.scheduleCron.trim().length > 0
        ? policy.scheduleCron.trim()
        : null,
    runWindowMinutes: clamp(
      Math.trunc(policy.runWindowMinutes),
      1,
      60 * 24 * 30,
    ),
    maxRunsPerWindow: clamp(Math.trunc(policy.maxRunsPerWindow), 1, 1_000),
    maxRunsPerDay: clamp(Math.trunc(policy.maxRunsPerDay), 1, 1_000),
    budgetWindowMinutes: clamp(
      Math.trunc(policy.budgetWindowMinutes),
      1,
      60 * 24 * 30,
    ),
    budgetWindowUsd: clamp(policy.budgetWindowUsd, 0, 1_000_000),
    dayBudgetUsd: clamp(policy.dayBudgetUsd, 0, 1_000_000),
    estimatedRunCostUsd: clamp(policy.estimatedRunCostUsd, 0, 100_000),
    lockTtlSec: clamp(Math.trunc(policy.lockTtlSec), 30, 60 * 60 * 24),
    lockHeartbeatSec: clamp(
      Math.trunc(policy.lockHeartbeatSec),
      10,
      60 * 60 * 24,
    ),
    artifactTtlSec: clamp(
      Math.trunc(policy.artifactTtlSec),
      60,
      60 * 60 * 24 * 30,
    ),
    stateTtlSec: clamp(Math.trunc(policy.stateTtlSec), 60, 60 * 60 * 24 * 30),
    statusTtlSec: clamp(Math.trunc(policy.statusTtlSec), 60, 60 * 60 * 24 * 30),
    reuseMode:
      policy.reuseMode === "auto" ||
      policy.reuseMode === "cold_start" ||
      policy.reuseMode === "same_run_diversify" ||
      policy.reuseMode === "same_run_seed" ||
      policy.reuseMode === "resume_same_run" ||
      policy.reuseMode === "warm_start_prior_run"
        ? policy.reuseMode
        : "auto",
    persistenceMode:
      policy.persistenceMode === "artifact_only" ||
      policy.persistenceMode === "normalized_keys"
        ? policy.persistenceMode
        : "normalized_keys",
    model: policy.model.trim(),
    embedModel: policy.embedModel.trim(),
    toolMode:
      policy.toolMode === "none" ||
      policy.toolMode === "web" ||
      policy.toolMode === "x" ||
      policy.toolMode === "both"
        ? policy.toolMode
        : "both",
    strictSchema: Boolean(policy.strictSchema),
    requireDistinctDomains: Boolean(policy.requireDistinctDomains),
    concurrency: clamp(Math.trunc(policy.concurrency), 1, 8),
    maxCalls: clamp(Math.trunc(policy.maxCalls), 1, 1_000),
    budgetUsd: clamp(policy.budgetUsd, 0, 1_000_000),
    timeoutSec: clamp(Math.trunc(policy.timeoutSec), 5, 60 * 10),
    maxRetries: clamp(Math.trunc(policy.maxRetries), 0, 10),
    retryBaseMs: clamp(Math.trunc(policy.retryBaseMs), 100, 60_000),
    maxTotalInputTokens: clamp(
      Math.trunc(policy.maxTotalInputTokens),
      1_000,
      10_000_000,
    ),
    maxTotalOutputTokens: clamp(
      Math.trunc(policy.maxTotalOutputTokens),
      1_000,
      10_000_000,
    ),
    maxTotalToolAttempts: clamp(
      Math.trunc(policy.maxTotalToolAttempts),
      1,
      100_000,
    ),
    maxToolAttemptsPerCall: clamp(
      Math.trunc(policy.maxToolAttemptsPerCall),
      1,
      1_000,
    ),
    maxEvidencePerCall: clamp(Math.trunc(policy.maxEvidencePerCall), 1, 100),
    maxEvidenceTotal: clamp(Math.trunc(policy.maxEvidenceTotal), 1, 10_000),
    windowHoursL1: clamp(Math.trunc(policy.windowHoursL1), 1, 24 * 30),
    windowHoursL2: clamp(Math.trunc(policy.windowHoursL2), 1, 24 * 30),
    windowHoursL3: clamp(Math.trunc(policy.windowHoursL3), 1, 24 * 30),
    recentHoursHint: clamp(Math.trunc(policy.recentHoursHint), 1, 24 * 30),
    topRootCount: clamp(Math.trunc(policy.topRootCount), 1, 200),
    branchPerCall: clamp(Math.trunc(policy.branchPerCall), 1, 50),
    eventSampleLimit: clamp(Math.trunc(policy.eventSampleLimit), 1, 200),
    childSampleLimit: clamp(Math.trunc(policy.childSampleLimit), 1, 200),
    siblingSampleLimit: clamp(Math.trunc(policy.siblingSampleLimit), 0, 200),
    routeThresholdL1: clamp(policy.routeThresholdL1, 0, 1),
    routeThresholdL2: clamp(policy.routeThresholdL2, 0, 1),
    routeThresholdL3: clamp(policy.routeThresholdL3, 0, 1),
    routeMinSimilarity: clamp(policy.routeMinSimilarity, 0, 1),
    routeMinMarginL1: clamp(policy.routeMinMarginL1, 0, 1),
    routeMinMarginL2: clamp(policy.routeMinMarginL2, 0, 1),
    routeMinMarginL3: clamp(policy.routeMinMarginL3, 0, 1),
    sourceAllowDomains: normalizeDomains(policy.sourceAllowDomains ?? []),
    sourceDenyDomains: normalizeDomains(policy.sourceDenyDomains ?? []),
    maxXEvidencePerCall: clamp(Math.trunc(policy.maxXEvidencePerCall), 0, 100),
    maxUnconfirmedEvidencePerCall: clamp(
      Math.trunc(policy.maxUnconfirmedEvidencePerCall),
      0,
      100,
    ),
    lowYieldToolAttemptThreshold: clamp(
      Math.trunc(policy.lowYieldToolAttemptThreshold),
      1,
      1_000,
    ),
    lowYieldConsecutiveThreshold: clamp(
      Math.trunc(policy.lowYieldConsecutiveThreshold),
      1,
      1_000,
    ),
    enforceFreshness: Boolean(policy.enforceFreshness),
    reportTopLeaves: clamp(Math.trunc(policy.reportTopLeaves), 1, 200),
    reportTopEvidence: clamp(Math.trunc(policy.reportTopEvidence), 1, 200),
    warmStartEvidenceLimit: clamp(
      Math.trunc(policy.warmStartEvidenceLimit),
      1,
      5_000,
    ),
    warmStartMinSimilarity: clamp(policy.warmStartMinSimilarity, 0, 1),
    warmStartQueueBoost: clamp(policy.warmStartQueueBoost, 0, 10),
    sameRunNoveltyAlpha: clamp(policy.sameRunNoveltyAlpha, 0, 20),
    sameRunNoveltyFloor: clamp(policy.sameRunNoveltyFloor, 0, 1),
    sameRunNoveltyBoost: clamp(policy.sameRunNoveltyBoost, 0, 10),
    dryRun: Boolean(policy.dryRun),
    verbose: Boolean(policy.verbose),
    leanOutput: Boolean(policy.leanOutput),
    verboseOutput: Boolean(policy.verboseOutput),
  };
}

function normalizeMapSignalsPolicy(policy: MapSignalsPolicy): MapSignalsPolicy {
  return {
    ...policy,
    enabled: Boolean(policy.enabled),
    triggerMode:
      policy.triggerMode === "cron" || policy.triggerMode === "interval"
        ? policy.triggerMode
        : "interval",
    pollIntervalSec: clamp(
      Math.trunc(policy.pollIntervalSec),
      60,
      60 * 60 * 24,
    ),
    scheduleCron:
      typeof policy.scheduleCron === "string" &&
      policy.scheduleCron.trim().length > 0
        ? policy.scheduleCron.trim()
        : null,
    runWindowMinutes: clamp(
      Math.trunc(policy.runWindowMinutes),
      1,
      60 * 24 * 30,
    ),
    maxRunsPerWindow: clamp(Math.trunc(policy.maxRunsPerWindow), 1, 1_000),
    maxRunsPerDay: clamp(Math.trunc(policy.maxRunsPerDay), 1, 1_000),
    budgetWindowMinutes: clamp(
      Math.trunc(policy.budgetWindowMinutes),
      1,
      60 * 24 * 30,
    ),
    budgetWindowUsd: clamp(policy.budgetWindowUsd, 0, 1_000_000),
    dayBudgetUsd: clamp(policy.dayBudgetUsd, 0, 1_000_000),
    estimatedRunCostUsd: clamp(policy.estimatedRunCostUsd, 0, 100_000),
    lockTtlSec: clamp(Math.trunc(policy.lockTtlSec), 30, 60 * 60 * 24),
    lockHeartbeatSec: clamp(
      Math.trunc(policy.lockHeartbeatSec),
      10,
      60 * 60 * 24,
    ),
    artifactTtlSec: clamp(
      Math.trunc(policy.artifactTtlSec),
      60,
      60 * 60 * 24 * 30,
    ),
    statusTtlSec: clamp(Math.trunc(policy.statusTtlSec), 60, 60 * 60 * 24 * 30),
    inputDigestEnabled: Boolean(policy.inputDigestEnabled),
    model: policy.model.trim(),
    embedModel: policy.embedModel.trim(),
    maxNodes: clamp(Math.trunc(policy.maxNodes), 1, 500),
    maxSignals: clamp(Math.trunc(policy.maxSignals), 1, 500),
    maxEvidencePerNode: clamp(Math.trunc(policy.maxEvidencePerNode), 1, 200),
    topMarketsPerEvent: clamp(Math.trunc(policy.topMarketsPerEvent), 1, 20),
    maxMarketsPerNode: clamp(Math.trunc(policy.maxMarketsPerNode), 1, 200),
    minEvidence: clamp(Math.trunc(policy.minEvidence), 1, 50),
    minConfirmed: clamp(Math.trunc(policy.minConfirmed), 0, 50),
    minDistinctDomains: clamp(Math.trunc(policy.minDistinctDomains), 1, 50),
    minEvidenceIdsForPublish: clamp(
      Math.trunc(policy.minEvidenceIdsForPublish),
      1,
      50,
    ),
    minAffinityForPublish: clamp(policy.minAffinityForPublish, 0, 1),
    concurrency: clamp(Math.trunc(policy.concurrency), 1, 16),
    maxOutputTokens: clamp(Math.trunc(policy.maxOutputTokens), 100, 8_000),
    timeoutSec: clamp(Math.trunc(policy.timeoutSec), 15, 60 * 10),
    maxRetries: clamp(Math.trunc(policy.maxRetries), 0, 10),
    retryBaseMs: clamp(Math.trunc(policy.retryBaseMs), 100, 60_000),
    dryRun: Boolean(policy.dryRun),
    verbose: Boolean(policy.verbose),
    persistNotes: Boolean(policy.persistNotes),
    maxPublishPerRun: clamp(Math.trunc(policy.maxPublishPerRun), 1, 5_000),
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

function normalizeAuthAccessPolicy(policy: AuthAccessPolicy): AuthAccessPolicy {
  return {
    state: authAccessStateSchema.safeParse(policy.state).success
      ? policy.state
      : "off",
    embeddedSolanaSponsorship: Boolean(policy.embeddedSolanaSponsorship),
    embeddedSolanaSponsorshipMode:
      embeddedSolanaSponsorshipModeSchema.safeParse(
        policy.embeddedSolanaSponsorshipMode,
      ).success
        ? policy.embeddedSolanaSponsorshipMode
        : "enforce",
    embeddedSolanaSponsorshipFlows: {
      dflow: Boolean(policy.embeddedSolanaSponsorshipFlows?.dflow),
      across: Boolean(policy.embeddedSolanaSponsorshipFlows?.across),
      directTransfer: Boolean(
        policy.embeddedSolanaSponsorshipFlows?.directTransfer,
      ),
      debridge: Boolean(policy.embeddedSolanaSponsorshipFlows?.debridge),
    },
  };
}

function normalizeMerged<K extends IntelPolicyKey>(
  key: K,
  merged: IntelPolicyMap[K],
): IntelPolicyMap[K] {
  switch (key) {
    case "auth_access":
      return normalizeAuthAccessPolicy(
        merged as AuthAccessPolicy,
      ) as IntelPolicyMap[K];
    case "wallet_intel_signals":
      return normalizeSignalsPolicy(
        merged as WalletIntelSignalsPolicy,
      ) as IntelPolicyMap[K];
    case "wallet_intel_refresh":
      return normalizeRefreshPolicy(
        merged as WalletIntelRefreshPolicy,
      ) as IntelPolicyMap[K];
    case "wallet_intel_attribution":
      return normalizeAttributionPolicy(
        merged as WalletIntelAttributionPolicy,
      ) as IntelPolicyMap[K];
    case "api_cache_warm":
      return normalizeApiCacheWarmPolicy(
        merged as ApiCacheWarmPolicy,
      ) as IntelPolicyMap[K];
    case "ai_whale_profiles":
      return normalizeAiWhaleProfilesPolicy(
        merged as AiWhaleProfilesPolicy,
      ) as IntelPolicyMap[K];
    case "ai_clusters":
      return normalizeAiClustersPolicy(
        merged as AiClustersPolicy,
      ) as IntelPolicyMap[K];
    case "market_map":
      return normalizeMarketMapPolicy(
        merged as MarketMapPolicy,
      ) as IntelPolicyMap[K];
    case "map_search":
      return normalizeMapSearchPolicy(
        merged as MapSearchPolicy,
      ) as IntelPolicyMap[K];
    case "map_signals":
      return normalizeMapSignalsPolicy(
        merged as MapSignalsPolicy,
      ) as IntelPolicyMap[K];
    case "arbitrage_defaults":
      return normalizeArbitrageDefaultsPolicy(
        merged as ArbitrageDefaultsPolicy,
      ) as IntelPolicyMap[K];
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
    case "api_cache_warm": {
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
    case "map_search": {
      return record;
    }
    case "map_signals": {
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

export function getIntelPolicySchema<K extends IntelPolicyKey>(key: K) {
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
    auth_access: resolveFromRow(
      "auth_access",
      byKey.get("auth_access") ?? null,
    ),
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
    api_cache_warm: resolveFromRow(
      "api_cache_warm",
      byKey.get("api_cache_warm") ?? null,
    ),
    ai_whale_profiles: resolveFromRow(
      "ai_whale_profiles",
      byKey.get("ai_whale_profiles") ?? null,
    ),
    ai_clusters: resolveFromRow(
      "ai_clusters",
      byKey.get("ai_clusters") ?? null,
    ),
    market_map: resolveFromRow("market_map", byKey.get("market_map") ?? null),
    map_search: resolveFromRow("map_search", byKey.get("map_search") ?? null),
    map_signals: resolveFromRow(
      "map_signals",
      byKey.get("map_signals") ?? null,
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

export async function resolveApiCacheWarmPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "api_cache_warm");
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

export async function resolveMapSearchPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "map_search");
}

export async function resolveMapSignalsPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "map_signals");
}

export async function resolveArbitrageDefaultsPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "arbitrage_defaults");
}

export async function resolveAuthAccessPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "auth_access");
}
