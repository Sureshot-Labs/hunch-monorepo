import { z } from "zod";

import type { DbQuery } from "../db.js";
import { env } from "../env.js";
import {
  fetchActiveRuntimePolicy,
  listActiveRuntimePolicies,
  type RuntimePolicyRow,
} from "../repos/runtime-policies.js";

export const INTEL_POLICY_KEYS = [
  "wallet_intel_signals",
  "wallet_intel_refresh",
  "ai_whale_profiles",
  "ai_clusters",
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

type IntelPolicyMap = {
  wallet_intel_signals: WalletIntelSignalsPolicy;
  wallet_intel_refresh: WalletIntelRefreshPolicy;
  ai_whale_profiles: AiWhaleProfilesPolicy;
  ai_clusters: AiClustersPolicy;
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

const arbitrageDefaultsSchema = z
  .object({
    limit: positiveInt.max(200),
    minVenueCount: positiveInt.max(10),
    minSpread: ratio,
    minQualityScore: ratio,
  })
  .strict()
  .partial();

const policySchemas = {
  wallet_intel_signals: walletIntelSignalsSchema,
  wallet_intel_refresh: walletIntelRefreshSchema,
  ai_whale_profiles: aiWhaleProfilesSchema,
  ai_clusters: aiClustersSchema,
  arbitrage_defaults: arbitrageDefaultsSchema,
} as const;

const warnedInvalidOverrides = new Set<string>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
    case "ai_whale_profiles":
      return normalizeAiWhaleProfilesPolicy(merged as AiWhaleProfilesPolicy) as IntelPolicyMap[K];
    case "ai_clusters":
      return normalizeAiClustersPolicy(merged as AiClustersPolicy) as IntelPolicyMap[K];
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
    case "ai_clusters": {
      delete record.stageATimeoutMs;
      delete record.stageBTimeoutMs;
      delete record.forceFinalOnly;
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

  const effective = normalizeMerged(key, {
    ...defaults,
    ...parsed.value,
  } as IntelPolicyMap[K]);

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
    ai_whale_profiles: resolveFromRow(
      "ai_whale_profiles",
      byKey.get("ai_whale_profiles") ?? null,
    ),
    ai_clusters: resolveFromRow(
      "ai_clusters",
      byKey.get("ai_clusters") ?? null,
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

export async function resolveAiWhaleProfilesPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "ai_whale_profiles");
}

export async function resolveAiClustersPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "ai_clusters");
}

export async function resolveArbitrageDefaultsPolicy(pool: DbQuery) {
  return resolveIntelPolicy(pool, "arbitrage_defaults");
}
