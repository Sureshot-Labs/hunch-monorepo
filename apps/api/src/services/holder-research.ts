import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import type {
  HolderResearchAgentOutputV1,
  HolderResearchBucket,
  HolderResearchStatus,
} from "../schemas/holder-research.js";
import type { HolderResearchPolicy } from "./runtime-policies.js";
import {
  buildMarketTypeText,
  classifyMarketType,
  classifyMarketTypeFromText,
  computeMarketHoursToClose,
  type MarketType,
} from "./market-type-classifier.js";
import {
  buildWalletIntelAcceptingOrdersSql,
  buildWalletIntelTrackableMarketSql,
} from "./wallet-intel-market-eligibility.js";
import {
  loadWalletMarketTypeMetricsMap,
  makeWalletMarketTypeMetricKey,
  type WalletMarketTypeMetric,
} from "./wallet-market-type-metrics.js";
import { buildWalletMmSuspectedSql } from "./wallet-intel-mm.js";
import { loadLatestWalletPositionNowMap } from "./wallet-position-approx.js";
import { makeWalletPositionLedgerKey } from "./wallet-position-ledger.js";

type Queryable = Pick<PoolClient, "query">;

export type HolderResearchSideKey = "YES" | "NO";

export type HolderResearchMmThresholds = {
  whaleUsd: number;
  whaleUsdSolana: number;
};

export type HolderResearchEvidence = {
  id: string;
  kind: "market" | "event" | "side" | "holder" | "activity" | "note";
  title: string;
  summary: string;
  relevance: number;
};

export type HolderResearchRelatedPosition = {
  marketId: string;
  marketTitle: string;
  eventTitle: string | null;
  side: HolderResearchSideKey;
  positionUsd: number;
  yesProbability: number | null;
  snapshotAt: string | null;
};

export type HolderResearchMarketMovementContext = {
  yesProbabilityNow: number | null;
  yesChange24h: number | null;
  volume24h: number | null;
  volumeChange24h: number | null;
  volumeChangePct24h: number | null;
  liquidity: number | null;
  liquidityChange24h: number | null;
  liquidityChangePct24h: number | null;
  openInterestChange24h: number | null;
  openInterestChangePct24h: number | null;
  updatedAt: string | null;
  previousDecisionYesProbability: number | null;
  yesChangeSincePreviousDecision: number | null;
  previousDecisionCheckedAt: string | null;
};

export type HolderResearchHolder = {
  walletId: string;
  address: string;
  chain: string;
  label: string | null;
  side: HolderResearchSideKey;
  positionUsd: number;
  positionShares: number | null;
  openPnlUsd: number | null;
  realizedPnlUsd: number | null;
  totalPnlUsd: number | null;
  avgEntryPrice: number | null;
  currentPrice: number | null;
  entryToCurrentDelta: number | null;
  approxReliable: boolean | null;
  approxPnlSource: "activity" | "snapshot" | null;
  positionSnapshotAt: string | null;
  pnl30dUsd: number | null;
  resolvedWinRateEdge30d: number | null;
  resolvedEdgeZScore30d: number | null;
  resolvedEdgeSampleCount30d: number | null;
  resolvedStakeUsd30d: number | null;
  trades30d: number | null;
  winRate30d: number | null;
  volume30dUsd: number | null;
  walletKind: string | null;
  ownerAddress: string | null;
  walletUsdLikeBalance: number | null;
  ownerUsdLikeBalance: number | null;
  mmSuspected: boolean;
  marketTypeMetrics30d?: WalletMarketTypeMetric | null;
  relatedOpenPositions: HolderResearchRelatedPosition[];
};

export type HolderResearchSide = {
  side: HolderResearchSideKey;
  usd: number;
  wallets: number;
  openPnlUsd: number | null;
  sharpHolders: number;
  sharpUsd: number;
  bestEdge: number | null;
  bestZScore: number | null;
  bestSampleCount: number | null;
  bestResolvedStakeUsd: number | null;
  bestTrades30d: number | null;
};

export type HolderResearchMarketInput = {
  marketId: string;
  eventId: string | null;
  venue: string;
  marketTitle: string;
  marketSlug: string | null;
  marketDescription: string | null;
  eventTitle: string | null;
  eventSlug: string | null;
  eventDescription: string | null;
  seriesKey: string | null;
  seriesTitle: string | null;
  resolutionSource: string | null;
  category: string | null;
  closeTime: string | null;
  expirationTime: string | null;
  yesProbability: number | null;
  volume24h: number | null;
  liquidity: number | null;
  marketMovementContext: HolderResearchMarketMovementContext;
  sides: Record<HolderResearchSideKey, HolderResearchSide>;
  holders: HolderResearchHolder[];
  recentActivityUsd: number;
  recentActivityAt: string | null;
  crossMarketWalletCount: number;
  previousNote: HolderResearchPreviousNote | null;
};

export type HolderResearchPreviousNote = {
  noteId: string;
  createdAt: string;
  title: string;
  inputDigest: string | null;
  cooldownUntil: string | null;
  walletTargets: Array<{
    side: HolderResearchSideKey | null;
    walletId: string;
  }>;
};

export type HolderResearchCandidate = {
  key: string;
  inputDigest: string;
  bucket: HolderResearchBucket;
  score: number;
  side: HolderResearchSideKey | null;
  direction: "up" | "down" | "mixed";
  signalType: "catalyst" | "risk" | "update";
  reasons: string[];
  market: HolderResearchMarketInput;
  evidence: HolderResearchEvidence[];
  cooldownUntil: string | null;
};

export type HolderResearchActorMode =
  | "none"
  | "sharp_cluster"
  | "single_holder";

export type HolderResearchActorSummary = {
  mode: HolderResearchActorMode;
  side: HolderResearchSideKey | null;
  credentialBullets: string[];
  primaryHolder: {
    walletId: string;
    label: string | null;
    side: HolderResearchSideKey;
    positionUsd: number;
    openPnlUsd: number | null;
    pnl30dUsd: number | null;
  } | null;
  cluster: {
    sharpHolders: number;
    sharpUsd: number;
    pnl30dUsd: number | null;
    availableSharpHolders: number;
  } | null;
};

export type HolderResearchMarketType = MarketType;

export type HolderResearchActorStrength =
  | "cluster"
  | "exceptional_single"
  | "solid_single"
  | "weak_single";

export type HolderResearchCredentialStrength =
  | "strong"
  | "medium"
  | "weak"
  | "contradicted";

export type HolderResearchPriceContext =
  | "with_signal"
  | "against_signal"
  | "already_priced"
  | "flat"
  | "unknown";

export type HolderResearchPublicContextRisk =
  | "confirms_holder"
  | "fully_explains_move"
  | "conflicts_holder"
  | "unknown";

export type HolderResearchQualityAssessment = {
  marketType: HolderResearchMarketType;
  hoursToClose: number | null;
  actorStrength: HolderResearchActorStrength;
  credentialStrength: HolderResearchCredentialStrength;
  priceContext: HolderResearchPriceContext;
  publicContextRisk: HolderResearchPublicContextRisk;
  reasons: string[];
};

export type HolderResearchSelectionResult = {
  selected: HolderResearchCandidate[];
  skipped: Array<{
    candidate: HolderResearchCandidate;
    reason: "below_score" | "cooldown" | "quota" | "duplicate_market";
  }>;
};

export type HolderResearchPersistDecision = {
  candidate: HolderResearchCandidate;
  output: HolderResearchAgentOutputV1;
  modelMeta: Record<string, unknown>;
};

export type HolderResearchPersistStats = {
  considered: number;
  persisted: number;
  skippedExisting: number;
  superseded: number;
  errors: number;
};

export type HolderResearchResolvedEvaluationStats = {
  considered: number;
  evaluated: number;
  correct: number;
  wrong: number;
  unknown: number;
  errors: number;
};

const PUBLISHABLE_HOLDER_RESEARCH_BUCKETS = new Set<HolderResearchBucket>([
  "followup_existing",
  "sharp_minority",
  "sharp_side",
]);

export type HolderResearchDecisionSnapshot = {
  version: 1;
  key: string;
  bucket: HolderResearchBucket;
  side: HolderResearchSideKey | null;
  marketId: string;
  eventId: string | null;
  yesProbability: number | null;
  sides: Record<
    HolderResearchSideKey,
    {
      usd: number;
      wallets: number;
      sharpHolders: number;
      sharpUsd: number;
      openPnlUsd: number | null;
    }
  >;
  evidenceHolders: Array<{
    walletId: string;
    side: HolderResearchSideKey;
    positionUsd: number;
    openPnlUsd: number | null;
    relatedOpenPositions: Array<{
      marketId: string;
      side: HolderResearchSideKey;
      positionUsd: number;
    }>;
  }>;
  recentActivityUsd: number;
  recentActivityAt: string | null;
  crossMarketWalletCount: number;
};

export type HolderResearchCachedDecision = {
  version: 1;
  candidateKey: string;
  status: HolderResearchStatus;
  model: string;
  checkedAt: string;
  nextEligibleAt: string | null;
  forceEligibleAt: string | null;
  snapshot: HolderResearchDecisionSnapshot;
  digest: string;
  rationale: string | null;
};

export type HolderResearchDecisionCacheEvaluation = {
  action: "analyze" | "skip";
  reason:
    | "no_cache"
    | "cache_parse_error"
    | "cache_key_mismatch"
    | "publish_status"
    | "decision_cache"
    | "meaningful_delta"
    | "force_recheck"
    | "cooldown_expired";
  snapshot: HolderResearchDecisionSnapshot;
  digest: string;
  cachedDecision: HolderResearchCachedDecision | null;
  cachedStatus: HolderResearchStatus | null;
  lastCheckedAt: string | null;
  nextEligibleAt: string | null;
  meaningfulDeltaReasons: string[];
};

type HolderResearchPromptPolicy = HolderResearchPolicy;

type HolderResearchMarketRow = {
  market_id: string;
  event_id: string | null;
  venue: string;
  market_title: string | null;
  market_slug: string | null;
  market_description: string | null;
  event_title: string | null;
  event_slug: string | null;
  event_description: string | null;
  series_key: string | null;
  series_title: string | null;
  resolution_source: string | null;
  category: string | null;
  close_time: Date | string | null;
  expiration_time: Date | string | null;
  best_bid: string | number | null;
  best_ask: string | number | null;
  last_price: string | number | null;
  volume_24h: string | number | null;
  liquidity: string | number | null;
  market_change_24h: string | number | null;
  volume_last_24h_change: string | number | null;
  volume_last_24h_change_pct: string | number | null;
  liquidity_change_24h: string | number | null;
  liquidity_change_pct_24h: string | number | null;
  open_interest_change_24h: string | number | null;
  open_interest_change_pct_24h: string | number | null;
  market_activity_metrics_updated_at: Date | string | null;
  yes_usd: string | number | null;
  no_usd: string | number | null;
  yes_wallets: string | number | null;
  no_wallets: string | number | null;
  yes_sharp_holders: string | number | null;
  no_sharp_holders: string | number | null;
  yes_sharp_usd: string | number | null;
  no_sharp_usd: string | number | null;
  yes_best_edge: string | number | null;
  no_best_edge: string | number | null;
  yes_best_z_score: string | number | null;
  no_best_z_score: string | number | null;
  yes_best_sample_count: string | number | null;
  no_best_sample_count: string | number | null;
  yes_best_resolved_stake_usd: string | number | null;
  no_best_resolved_stake_usd: string | number | null;
  yes_best_trades_30d: string | number | null;
  no_best_trades_30d: string | number | null;
  largest_holder_usd: string | number | null;
  recent_activity_usd: string | number | null;
  recent_activity_at: Date | string | null;
  cross_market_wallet_count: string | number | null;
  top_holders: unknown;
};

type HolderResearchRelatedPositionRow = {
  wallet_id: string;
  market_id: string;
  market_title: string | null;
  event_title: string | null;
  side: string | null;
  position_usd: string | number | null;
  snapshot_at: Date | string | null;
  best_bid: string | number | null;
  best_ask: string | number | null;
  last_price: string | number | null;
};

type HolderResearchResolvedNoteRow = {
  note_id: string;
  direction: string | null;
  confidence: string | number | null;
  created_at: Date | string;
  metrics: unknown;
  model_meta: unknown;
  market_id: string;
  market_title: string | null;
  event_title: string | null;
  category: string | null;
  close_time: Date | string | null;
  expiration_time: Date | string | null;
  best_bid: string | number | null;
  best_ask: string | number | null;
  last_price: string | number | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | number | null;
  accepting_orders: boolean | null;
};

const SIDE_KEYS: HolderResearchSideKey[] = ["YES", "NO"];
const DECISION_DELTA_EPSILON = 1e-9;

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toInt(value: unknown): number {
  const parsed = toNumber(value);
  if (parsed == null) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compactText(value: unknown, maxChars: number): string | null {
  const text = safeText(value);
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ");
  if (normalized.length <= maxChars) return normalized;
  const clipped = normalized.slice(0, maxChars);
  const sentenceEnd = Math.max(
    clipped.lastIndexOf(". "),
    clipped.lastIndexOf("? "),
    clipped.lastIndexOf("! "),
  );
  if (sentenceEnd >= Math.floor(maxChars * 0.55)) {
    return clipped.slice(0, sentenceEnd + 1);
  }
  const space = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, space > 0 ? space : maxChars - 3).trimEnd()}...`;
}

function normalizeSide(value: unknown): HolderResearchSideKey | null {
  const side = safeText(value)?.toUpperCase();
  return side === "YES" || side === "NO" ? side : null;
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function sideDirection(
  side: HolderResearchSideKey | null,
): "up" | "down" | "mixed" {
  if (side === "YES") return "up";
  if (side === "NO") return "down";
  return "mixed";
}

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function scoreLog(value: number, anchor: number): number {
  if (value <= 0 || anchor <= 0) return 0;
  return clamp01(Math.log10(1 + value / anchor) / 2);
}

function calculateYesProbability(row: {
  best_bid: string | number | null;
  best_ask: string | number | null;
  last_price: string | number | null;
}): number | null {
  const bid = toNumber(row.best_bid);
  const ask = toNumber(row.best_ask);
  if (bid != null && ask != null && bid >= 0 && ask >= 0) {
    return clamp01((bid + ask) / 2);
  }
  const last = toNumber(row.last_price);
  return last != null ? clamp01(last) : null;
}

function terminalYesProbabilityFromPrice(row: {
  best_bid: string | number | null;
  best_ask: string | number | null;
  last_price: string | number | null;
}): number | null {
  const yesProbability = calculateYesProbability(row);
  if (yesProbability == null) return null;
  if (yesProbability <= 0.01) return 0;
  if (yesProbability >= 0.99) return 1;
  return null;
}

function isExtremeOdds(
  yesProbability: number | null,
  policy: Pick<HolderResearchPolicy, "maxExtremeOdds">,
): boolean {
  if (yesProbability == null) return false;
  const max = Math.max(0.5, Math.min(1, policy.maxExtremeOdds));
  return yesProbability >= max || yesProbability <= 1 - max;
}

export function isSharpHolder(
  holder: Pick<
    HolderResearchHolder,
    | "positionUsd"
    | "resolvedWinRateEdge30d"
    | "resolvedEdgeZScore30d"
    | "resolvedEdgeSampleCount30d"
    | "resolvedStakeUsd30d"
    | "trades30d"
    | "mmSuspected"
  >,
  policy: Pick<
    HolderResearchPolicy,
    | "minHolderPositionUsd"
    | "minResolvedWinRateEdge30d"
    | "minResolvedEdgeZScore30d"
    | "minResolvedEdgeSampleCount30d"
    | "minResolvedStakeUsd30d"
    | "minTrades30d"
  >,
): boolean {
  return (
    !holder.mmSuspected &&
    holder.positionUsd >= policy.minHolderPositionUsd &&
    (holder.resolvedWinRateEdge30d ?? -Infinity) >=
      policy.minResolvedWinRateEdge30d &&
    (holder.resolvedEdgeZScore30d ?? -Infinity) >=
      policy.minResolvedEdgeZScore30d &&
    (holder.resolvedEdgeSampleCount30d ?? -Infinity) >=
      policy.minResolvedEdgeSampleCount30d &&
    (holder.resolvedStakeUsd30d ?? 0) >= policy.minResolvedStakeUsd30d &&
    (holder.trades30d ?? -Infinity) >= policy.minTrades30d
  );
}

function sideHasStrongSharpEvidence(
  side: HolderResearchSide,
  policy: HolderResearchPolicy,
): boolean {
  return (
    side.sharpHolders > 0 &&
    side.usd >= policy.minSidePositionUsd &&
    (side.bestEdge ?? -Infinity) >= policy.strongResolvedWinRateEdge30d &&
    (side.bestZScore ?? -Infinity) >= policy.strongResolvedEdgeZScore30d &&
    (side.bestSampleCount ?? -Infinity) >=
      policy.strongResolvedEdgeSampleCount30d &&
    (side.bestResolvedStakeUsd ?? 0) >= policy.strongResolvedStakeUsd30d
  );
}

function buildBaseEvidence(
  market: HolderResearchMarketInput,
): HolderResearchEvidence[] {
  const yes = market.sides.YES;
  const no = market.sides.NO;
  const total = yes.usd + no.usd;
  return [
    {
      id: `market:${market.marketId}`,
      kind: "market",
      title: market.marketTitle,
      summary: `${formatUsd(total)} tracked across YES ${formatUsd(yes.usd)} / NO ${formatUsd(no.usd)}.`,
      relevance: 1,
    },
    {
      id: `side:${market.marketId}:YES`,
      kind: "side",
      title: "YES side",
      summary: `${formatUsd(yes.usd)}, ${yes.wallets} wallets, ${yes.sharpHolders} sharp holders.`,
      relevance: 0.8,
    },
    {
      id: `side:${market.marketId}:NO`,
      kind: "side",
      title: "NO side",
      summary: `${formatUsd(no.usd)}, ${no.wallets} wallets, ${no.sharpHolders} sharp holders.`,
      relevance: 0.8,
    },
  ];
}

function holderEvidence(holder: HolderResearchHolder): HolderResearchEvidence {
  const label = holder.label ?? holder.address;
  const edge =
    holder.resolvedWinRateEdge30d == null
      ? "edge unknown"
      : `${(holder.resolvedWinRateEdge30d * 100).toFixed(1)}pp edge`;
  return {
    id: buildHolderEvidenceId(holder),
    kind: "holder",
    title: `${label} ${holder.side}`,
    summary: `${formatUsd(holder.positionUsd)} open, ${edge}, z=${holder.resolvedEdgeZScore30d?.toFixed(1) ?? "n/a"}, n=${holder.resolvedEdgeSampleCount30d ?? "n/a"}.`,
    relevance: 0.9,
  };
}

function buildHolderEvidenceId(
  holder: Pick<HolderResearchHolder, "walletId" | "side">,
): string {
  return `holder:${holder.walletId}:${holder.side}`;
}

function bestHolderForSide(
  market: HolderResearchMarketInput,
  side: HolderResearchSideKey,
): HolderResearchHolder | null {
  const sideHolders = market.holders.filter((holder) => holder.side === side);
  const nonMmHolders = sideHolders.filter((holder) => !holder.mmSuspected);
  const ranked = nonMmHolders.length > 0 ? nonMmHolders : sideHolders;
  return (
    ranked.sort((a, b) => {
      const edgeDelta =
        (b.resolvedWinRateEdge30d ?? -Infinity) -
        (a.resolvedWinRateEdge30d ?? -Infinity);
      if (edgeDelta !== 0) return edgeDelta;
      return b.positionUsd - a.positionUsd;
    })[0] ?? null
  );
}

export function buildHolderResearchInputDigest(
  candidate: Omit<HolderResearchCandidate, "inputDigest">,
): string {
  const movement = candidate.market.marketMovementContext;
  const digestInput = {
    bucket: candidate.bucket,
    side: candidate.side,
    marketId: candidate.market.marketId,
    eventId: candidate.market.eventId,
    yesProbability: candidate.market.yesProbability,
    marketMovementContext: {
      yesProbabilityNow: movement.yesProbabilityNow,
      yesChange24h: movement.yesChange24h,
      volume24h: movement.volume24h,
      volumeChange24h: movement.volumeChange24h,
      volumeChangePct24h: movement.volumeChangePct24h,
      liquidity: movement.liquidity,
      liquidityChange24h: movement.liquidityChange24h,
      liquidityChangePct24h: movement.liquidityChangePct24h,
      openInterestChange24h: movement.openInterestChange24h,
      openInterestChangePct24h: movement.openInterestChangePct24h,
      updatedAt: movement.updatedAt,
    },
    sides: candidate.market.sides,
    recentActivityUsd: candidate.market.recentActivityUsd,
    crossMarketWalletCount: candidate.market.crossMarketWalletCount,
    holders: candidate.market.holders.map((holder) => ({
      walletId: holder.walletId,
      side: holder.side,
      positionUsd: holder.positionUsd,
      positionShares: holder.positionShares,
      openPnlUsd: holder.openPnlUsd,
      realizedPnlUsd: holder.realizedPnlUsd,
      totalPnlUsd: holder.totalPnlUsd,
      avgEntryPrice: holder.avgEntryPrice,
      currentPrice: holder.currentPrice,
      entryToCurrentDelta: holder.entryToCurrentDelta,
      approxReliable: holder.approxReliable,
      approxPnlSource: holder.approxPnlSource,
      positionSnapshotAt: holder.positionSnapshotAt,
      pnl30dUsd: holder.pnl30dUsd,
      edge: holder.resolvedWinRateEdge30d,
      z: holder.resolvedEdgeZScore30d,
      samples: holder.resolvedEdgeSampleCount30d,
      stake: holder.resolvedStakeUsd30d,
      trades: holder.trades30d,
      walletKind: holder.walletKind,
      ownerAddress: holder.ownerAddress,
      walletUsdLikeBalance: holder.walletUsdLikeBalance,
      ownerUsdLikeBalance: holder.ownerUsdLikeBalance,
      mmSuspected: holder.mmSuspected,
    })),
  };
  return createHash("sha256").update(JSON.stringify(digestInput)).digest("hex");
}

function roundDecisionNumber(
  value: number | null,
  digits: number,
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundDecisionUsd(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function parseHolderEvidenceId(
  id: string,
): { walletId: string; side: HolderResearchSideKey } | null {
  const match = /^holder:(.+):(YES|NO)$/.exec(id);
  if (!match?.[1] || !match[2]) return null;
  return {
    walletId: match[1],
    side: match[2] as HolderResearchSideKey,
  };
}

function parsePreviousNoteWalletTargets(
  value: unknown,
): HolderResearchPreviousNote["walletTargets"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const walletId =
        typeof record.walletId === "string" ? record.walletId.trim() : "";
      if (!walletId) return null;
      const side = normalizeSide(record.side);
      return { side, walletId };
    })
    .filter(
      (
        entry,
      ): entry is {
        side: HolderResearchSideKey | null;
        walletId: string;
      } => entry != null,
    );
}

function selectedEvidenceHolders(
  candidate: HolderResearchCandidate,
): HolderResearchHolder[] {
  const evidenceKeys = new Set(
    candidate.evidence
      .map((evidence) => parseHolderEvidenceId(evidence.id))
      .filter(
        (entry): entry is { walletId: string; side: HolderResearchSideKey } =>
          entry != null,
      )
      .map((entry) => `${entry.walletId}:${entry.side}`),
  );
  const holders = candidate.market.holders.filter((holder) =>
    evidenceKeys.has(`${holder.walletId}:${holder.side}`),
  );
  if (holders.length > 0) return holders;
  if (candidate.side) {
    const holder = bestHolderForSide(candidate.market, candidate.side);
    return holder ? [holder] : [];
  }
  return [...candidate.market.holders]
    .sort((a, b) => b.positionUsd - a.positionUsd)
    .slice(0, 2);
}

function buildHolderEntryContext(candidate: HolderResearchCandidate) {
  return selectedEvidenceHolders(candidate)
    .slice(0, 3)
    .map((holder) => ({
      walletId: holder.walletId,
      label: holder.label,
      side: holder.side,
      positionUsd: holder.positionUsd,
      positionShares: holder.positionShares,
      avgEntryPrice: holder.avgEntryPrice,
      currentPrice: holder.currentPrice,
      entryToCurrentDelta: holder.entryToCurrentDelta,
      openPnlUsd: holder.openPnlUsd,
      realizedPnlUsd: holder.realizedPnlUsd,
      totalPnlUsd: holder.totalPnlUsd,
      approxReliable: holder.approxReliable,
      approxPnlSource: holder.approxPnlSource,
      snapshotAt: holder.positionSnapshotAt,
      mmSuspected: holder.mmSuspected,
      marketTypeMetrics30d: holder.marketTypeMetrics30d,
    }));
}

function previousNoteTargetHolders(
  candidate: HolderResearchCandidate,
): HolderResearchHolder[] {
  const targets = candidate.market.previousNote?.walletTargets ?? [];
  if (targets.length === 0) return [];
  const holders: HolderResearchHolder[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const holder = candidate.market.holders.find(
      (entry) =>
        entry.walletId === target.walletId &&
        (target.side == null || entry.side === target.side),
    );
    if (!holder) continue;
    const key = `${holder.walletId}:${holder.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    holders.push(holder);
  }
  return holders;
}

function selectHolderResearchTargetHolders(
  candidate: HolderResearchCandidate,
  evidenceIds: string[],
): HolderResearchHolder[] {
  const referencedHolderIds = new Set(
    evidenceIds.filter((evidenceId) => evidenceId.startsWith("holder:")),
  );
  const referencedHolders = candidate.market.holders.filter((holder) =>
    referencedHolderIds.has(buildHolderEvidenceId(holder)),
  );
  if (referencedHolders.length > 0) return referencedHolders;
  if (candidate.bucket === "followup_existing") {
    return previousNoteTargetHolders(candidate).slice(0, 1);
  }
  return candidate.side ? selectedEvidenceHolders(candidate).slice(0, 1) : [];
}

function formatWholePercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatPointDelta(value: number): string {
  const points = Math.round(Math.abs(value) * 100);
  return `${points} point${points === 1 ? "" : "s"}`;
}

function plural(
  value: number,
  singular: string,
  pluralLabel = `${singular}s`,
): string {
  return `${value} ${value === 1 ? singular : pluralLabel}`;
}

function buildHolderCredentialBullets(holder: HolderResearchHolder): string[] {
  const bullets: string[] = [];
  if (holder.pnl30dUsd != null && holder.pnl30dUsd >= 1_000) {
    bullets.push(`Up ${formatUsd(holder.pnl30dUsd)} over the last 30 days`);
  }
  if (
    holder.winRate30d != null &&
    holder.winRate30d >= 0.55 &&
    (holder.trades30d ?? 0) >= 5
  ) {
    bullets.push(
      `Won ${formatWholePercent(holder.winRate30d)} of recent trades`,
    );
  }
  if (
    holder.resolvedWinRateEdge30d != null &&
    holder.resolvedWinRateEdge30d >= 0.05 &&
    (holder.resolvedEdgeSampleCount30d ?? 0) >= 5
  ) {
    bullets.push(
      `Beat market prices by ${formatPointDelta(holder.resolvedWinRateEdge30d)} on recent resolved bets`,
    );
  }
  if (
    bullets.length > 0 &&
    holder.volume30dUsd != null &&
    holder.volume30dUsd >= 25_000
  ) {
    bullets.push(
      `Traded ${formatUsd(holder.volume30dUsd)} over the last 30 days`,
    );
  }
  return bullets.slice(0, 3);
}

function buildClusterCredentialBullets(input: {
  candidate: HolderResearchCandidate;
  policy: Pick<
    HolderResearchPolicy,
    | "minHolderPositionUsd"
    | "minResolvedEdgeSampleCount30d"
    | "minResolvedEdgeZScore30d"
    | "minResolvedStakeUsd30d"
    | "minResolvedWinRateEdge30d"
    | "minTrades30d"
    | "minSidePositionUsd"
  >;
  side: HolderResearchSideKey;
}): {
  availableSharpHolders: number;
  bullets: string[];
  pnl30dUsd: number | null;
} {
  const sideData = input.candidate.market.sides[input.side];
  const availableSharpHolders = input.candidate.market.holders.filter(
    (holder) =>
      holder.side === input.side && isSharpHolder(holder, input.policy),
  );
  const hasCompletePnl =
    availableSharpHolders.length >= sideData.sharpHolders &&
    availableSharpHolders.length > 0 &&
    availableSharpHolders.every((holder) => holder.pnl30dUsd != null);
  const pnl30dUsd = hasCompletePnl
    ? availableSharpHolders.reduce(
        (sum, holder) => sum + (holder.pnl30dUsd ?? 0),
        0,
      )
    : null;
  const bullets: string[] = [];
  if (pnl30dUsd != null && pnl30dUsd >= 1_000) {
    bullets.push(`Up ${formatUsd(pnl30dUsd)} combined over the last 30 days`);
  }
  bullets.push(
    `${plural(sideData.sharpHolders, "strong wallet")} on the same side`,
  );
  bullets.push(`${formatUsd(sideData.sharpUsd)} tracked by sharp wallets`);
  return {
    availableSharpHolders: availableSharpHolders.length,
    bullets: bullets.slice(0, 3),
    pnl30dUsd,
  };
}

export function buildHolderResearchActorSummary(input: {
  candidate: HolderResearchCandidate;
  evidenceIds: string[];
  policy: Pick<
    HolderResearchPolicy,
    | "minHolderPositionUsd"
    | "minResolvedEdgeSampleCount30d"
    | "minResolvedEdgeZScore30d"
    | "minResolvedStakeUsd30d"
    | "minResolvedWinRateEdge30d"
    | "minTrades30d"
    | "minSidePositionUsd"
  >;
}): HolderResearchActorSummary {
  const targetHolders = selectHolderResearchTargetHolders(
    input.candidate,
    input.evidenceIds,
  );
  const primaryHolder = targetHolders[0] ?? null;
  const side = input.candidate.side ?? primaryHolder?.side ?? null;
  if (!side) {
    return {
      mode: "none",
      side: null,
      credentialBullets: [],
      primaryHolder: null,
      cluster: null,
    };
  }

  const sideData = input.candidate.market.sides[side];
  if (
    sideData.sharpHolders >= 2 &&
    sideData.sharpUsd >= input.policy.minSidePositionUsd
  ) {
    const cluster = buildClusterCredentialBullets({
      candidate: input.candidate,
      policy: input.policy,
      side,
    });
    return {
      mode: "sharp_cluster",
      side,
      credentialBullets: cluster.bullets,
      primaryHolder: primaryHolder
        ? {
            walletId: primaryHolder.walletId,
            label: primaryHolder.label,
            side: primaryHolder.side,
            positionUsd: primaryHolder.positionUsd,
            openPnlUsd: primaryHolder.openPnlUsd,
            pnl30dUsd: primaryHolder.pnl30dUsd,
          }
        : null,
      cluster: {
        sharpHolders: sideData.sharpHolders,
        sharpUsd: sideData.sharpUsd,
        pnl30dUsd: cluster.pnl30dUsd,
        availableSharpHolders: cluster.availableSharpHolders,
      },
    };
  }

  if (!primaryHolder) {
    return {
      mode: "none",
      side,
      credentialBullets: [],
      primaryHolder: null,
      cluster: null,
    };
  }

  const credentialBullets = buildHolderCredentialBullets(primaryHolder);
  return {
    mode: credentialBullets.length > 0 ? "single_holder" : "none",
    side,
    credentialBullets,
    primaryHolder: {
      walletId: primaryHolder.walletId,
      label: primaryHolder.label,
      side: primaryHolder.side,
      positionUsd: primaryHolder.positionUsd,
      openPnlUsd: primaryHolder.openPnlUsd,
      pnl30dUsd: primaryHolder.pnl30dUsd,
    },
    cluster: null,
  };
}

function computeHoursToClose(market: HolderResearchMarketInput): number | null {
  return computeMarketHoursToClose({
    closeTime: market.closeTime,
    expirationTime: market.expirationTime,
  });
}

function classifyHolderResearchMarketType(
  market: HolderResearchMarketInput,
): HolderResearchMarketType {
  return classifyMarketType({
    category: market.category,
    seriesKey: market.seriesKey,
    seriesTitle: market.seriesTitle,
    eventTitle: market.eventTitle,
    marketTitle: market.marketTitle,
    closeTime: market.closeTime,
    expirationTime: market.expirationTime,
  });
}

function selectedSignalPriceChange(
  candidate: HolderResearchCandidate,
): number | null {
  const movement = candidate.market.marketMovementContext;
  const rawChange =
    movement.yesChangeSincePreviousDecision ?? movement.yesChange24h;
  if (rawChange == null || candidate.side == null) return null;
  return candidate.side === "YES" ? rawChange : -rawChange;
}

function classifyPriceContext(
  candidate: HolderResearchCandidate,
  policy: Pick<HolderResearchPolicy, "priceAgainstSignalBlockPp">,
): HolderResearchPriceContext {
  const signalChange = selectedSignalPriceChange(candidate);
  if (signalChange == null) return "unknown";
  const threshold = Math.max(0.01, policy.priceAgainstSignalBlockPp);
  if (signalChange <= -threshold) return "against_signal";
  if (signalChange >= threshold * 2) return "already_priced";
  if (signalChange >= threshold) return "with_signal";
  return "flat";
}

function holderHasStrongCredential(input: {
  holder: HolderResearchHolder;
  policy: Pick<
    HolderResearchPolicy,
    | "singleGameSportsMinEdge"
    | "singleGameSportsMinHolderUsd"
    | "singleGameSportsMinSamples"
    | "singleGameSportsMinWinRate"
    | "singleGameSportsRequirePositivePnl"
    | "minTrades30d"
  >;
}): boolean {
  const pnlOk =
    !input.policy.singleGameSportsRequirePositivePnl ||
    (input.holder.pnl30dUsd ?? 0) > 0;
  if (!pnlOk) return false;
  if (input.holder.positionUsd < input.policy.singleGameSportsMinHolderUsd) {
    return false;
  }
  const winStrong =
    (input.holder.winRate30d ?? -Infinity) >=
      input.policy.singleGameSportsMinWinRate &&
    (input.holder.trades30d ?? 0) >= input.policy.minTrades30d;
  const edgeStrong =
    (input.holder.resolvedWinRateEdge30d ?? -Infinity) >=
      input.policy.singleGameSportsMinEdge &&
    (input.holder.resolvedEdgeSampleCount30d ?? 0) >=
      input.policy.singleGameSportsMinSamples;
  return winStrong || edgeStrong;
}

export function buildHolderResearchQualityAssessment(
  candidate: HolderResearchCandidate,
  policy: HolderResearchPolicy,
  publicContextRisk: HolderResearchPublicContextRisk = "unknown",
): HolderResearchQualityAssessment {
  const actor = buildHolderResearchActorSummary({
    candidate,
    evidenceIds: candidate.evidence.map((evidence) => evidence.id),
    policy,
  });
  const marketType = classifyHolderResearchMarketType(candidate.market);
  const hoursToClose = computeHoursToClose(candidate.market);
  const reasons: string[] = [];
  let credentialStrength: HolderResearchCredentialStrength = "weak";
  let actorStrength: HolderResearchActorStrength = "weak_single";

  if (actor.mode === "sharp_cluster" && actor.cluster) {
    actorStrength = "cluster";
    credentialStrength =
      actor.cluster.sharpHolders >= 2 &&
      actor.cluster.sharpUsd >= policy.minSidePositionUsd
        ? "strong"
        : "medium";
    reasons.push("sharp_cluster");
  } else if (actor.mode === "single_holder" && actor.primaryHolder) {
    const holder = candidate.market.holders.find(
      (entry) =>
        entry.walletId === actor.primaryHolder?.walletId &&
        entry.side === actor.primaryHolder.side,
    );
    if (holder?.pnl30dUsd != null && holder.pnl30dUsd < 0) {
      credentialStrength = "contradicted";
      reasons.push("negative_30d_pnl");
    } else if (
      holder &&
      holderHasStrongCredential({
        holder,
        policy,
      })
    ) {
      credentialStrength = "strong";
      actorStrength = "exceptional_single";
      reasons.push("exceptional_single_holder");
    } else if (actor.credentialBullets.length > 0) {
      credentialStrength = "medium";
      actorStrength = "solid_single";
      reasons.push("single_holder_credentials");
    }
  }

  const priceContext = classifyPriceContext(candidate, policy);
  if (marketType === "single_game_sports") reasons.push("single_game_sports");
  if (priceContext === "against_signal") reasons.push("price_against_signal");
  if (priceContext === "already_priced") reasons.push("already_priced");
  if (publicContextRisk === "fully_explains_move") {
    reasons.push("public_news_fully_explains_move");
  }

  return {
    marketType,
    hoursToClose,
    actorStrength,
    credentialStrength,
    priceContext,
    publicContextRisk,
    reasons: [...new Set(reasons)],
  };
}

export function buildHolderResearchDecisionSnapshot(
  candidate: HolderResearchCandidate,
): HolderResearchDecisionSnapshot {
  const sideSnapshot = (side: HolderResearchSide) => ({
    usd: roundDecisionUsd(side.usd) ?? 0,
    wallets: side.wallets,
    sharpHolders: side.sharpHolders,
    sharpUsd: roundDecisionUsd(side.sharpUsd) ?? 0,
    openPnlUsd: roundDecisionUsd(side.openPnlUsd),
  });
  return {
    version: 1,
    key: candidate.key,
    bucket: candidate.bucket,
    side: candidate.side,
    marketId: candidate.market.marketId,
    eventId: candidate.market.eventId,
    yesProbability: roundDecisionNumber(candidate.market.yesProbability, 4),
    sides: {
      YES: sideSnapshot(candidate.market.sides.YES),
      NO: sideSnapshot(candidate.market.sides.NO),
    },
    evidenceHolders: selectedEvidenceHolders(candidate)
      .map((holder) => ({
        walletId: holder.walletId,
        side: holder.side,
        positionUsd: roundDecisionUsd(holder.positionUsd) ?? 0,
        openPnlUsd: roundDecisionUsd(holder.openPnlUsd),
        relatedOpenPositions: holder.relatedOpenPositions
          .map((position) => ({
            marketId: position.marketId,
            side: position.side,
            positionUsd: roundDecisionUsd(position.positionUsd) ?? 0,
          }))
          .sort((a, b) =>
            `${a.marketId}:${a.side}`.localeCompare(`${b.marketId}:${b.side}`),
          ),
      }))
      .sort((a, b) =>
        `${a.walletId}:${a.side}`.localeCompare(`${b.walletId}:${b.side}`),
      ),
    recentActivityUsd:
      roundDecisionUsd(candidate.market.recentActivityUsd) ?? 0,
    recentActivityAt: toIso(candidate.market.recentActivityAt),
    crossMarketWalletCount: candidate.market.crossMarketWalletCount,
  };
}

export function buildHolderResearchDecisionDigest(
  snapshot: HolderResearchDecisionSnapshot,
): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function buildHolderResearchDecisionCacheKey(
  candidateKey: string,
): string {
  return `ai:holder_research:v1:decision:${shortHash(candidateKey)}`;
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function addHoursIso(date: Date, hours: number): string {
  return new Date(date.getTime() + hours * 3_600_000).toISOString();
}

function diffThreshold(
  previous: number,
  policy: Pick<
    HolderResearchPolicy,
    "minMeaningfulSideUsdDelta" | "minMeaningfulSidePctDelta"
  >,
): number {
  return Math.max(
    policy.minMeaningfulSideUsdDelta,
    Math.abs(previous) * policy.minMeaningfulSidePctDelta,
  );
}

function holderDiffThreshold(
  previous: number,
  policy: Pick<
    HolderResearchPolicy,
    "minMeaningfulHolderUsdDelta" | "minMeaningfulHolderPctDelta"
  >,
): number {
  return Math.max(
    policy.minMeaningfulHolderUsdDelta,
    Math.abs(previous) * policy.minMeaningfulHolderPctDelta,
  );
}

function materialRelatedPositions(
  snapshot: HolderResearchDecisionSnapshot,
  policy: Pick<HolderResearchPolicy, "minHolderPositionUsd">,
): Map<string, number> {
  const positions = new Map<string, number>();
  for (const holder of snapshot.evidenceHolders) {
    for (const position of holder.relatedOpenPositions) {
      if (position.positionUsd < policy.minHolderPositionUsd) continue;
      positions.set(
        `${holder.walletId}:${position.marketId}:${position.side}`,
        position.positionUsd,
      );
    }
  }
  return positions;
}

export function diffHolderResearchDecisionSnapshots(
  previous: HolderResearchDecisionSnapshot,
  current: HolderResearchDecisionSnapshot,
  policy: Pick<
    HolderResearchPolicy,
    | "minHolderPositionUsd"
    | "minMeaningfulHolderPctDelta"
    | "minMeaningfulHolderUsdDelta"
    | "minMeaningfulOddsDelta"
    | "minMeaningfulSidePctDelta"
    | "minMeaningfulSideUsdDelta"
    | "minRecentActivityUsd"
  >,
  previousCheckedAt: string | null = null,
): string[] {
  const reasons: string[] = [];
  if (
    previous.yesProbability != null &&
    current.yesProbability != null &&
    Math.abs(current.yesProbability - previous.yesProbability) >=
      policy.minMeaningfulOddsDelta - DECISION_DELTA_EPSILON
  ) {
    reasons.push("odds_move");
  }

  for (const side of SIDE_KEYS) {
    const previousSide = previous.sides[side];
    const currentSide = current.sides[side];
    if (
      Math.abs(currentSide.usd - previousSide.usd) >=
      diffThreshold(previousSide.usd, policy) - DECISION_DELTA_EPSILON
    ) {
      reasons.push(`side_exposure_move:${side}`);
    }
    if (currentSide.sharpHolders !== previousSide.sharpHolders) {
      reasons.push(`sharp_holder_count_changed:${side}`);
    }
  }

  const previousHolders = new Map(
    previous.evidenceHolders.map((holder) => [
      `${holder.walletId}:${holder.side}`,
      holder,
    ]),
  );
  const currentHolders = new Map(
    current.evidenceHolders.map((holder) => [
      `${holder.walletId}:${holder.side}`,
      holder,
    ]),
  );
  const previousHolderKeys = [...previousHolders.keys()].sort();
  const currentHolderKeys = [...currentHolders.keys()].sort();
  if (previousHolderKeys.join("|") !== currentHolderKeys.join("|")) {
    reasons.push("holder_set_changed");
  }
  for (const [key, currentHolder] of currentHolders) {
    const previousHolder = previousHolders.get(key);
    if (!previousHolder) continue;
    if (
      Math.abs(currentHolder.positionUsd - previousHolder.positionUsd) >=
      holderDiffThreshold(previousHolder.positionUsd, policy) -
        DECISION_DELTA_EPSILON
    ) {
      reasons.push(`holder_position_move:${currentHolder.side}`);
    }
  }

  const previousCheckedMs = parseDateMs(previousCheckedAt);
  const currentActivityMs = parseDateMs(current.recentActivityAt);
  if (
    previousCheckedMs != null &&
    currentActivityMs != null &&
    currentActivityMs > previousCheckedMs &&
    current.recentActivityUsd >= policy.minRecentActivityUsd
  ) {
    reasons.push("fresh_flow");
  }

  const previousRelated = materialRelatedPositions(previous, policy);
  const currentRelated = materialRelatedPositions(current, policy);
  const relatedKeys = new Set([
    ...previousRelated.keys(),
    ...currentRelated.keys(),
  ]);
  for (const key of relatedKeys) {
    const previousUsd = previousRelated.get(key) ?? 0;
    const currentUsd = currentRelated.get(key) ?? 0;
    if (
      Math.abs(currentUsd - previousUsd) >=
      holderDiffThreshold(previousUsd, policy) - DECISION_DELTA_EPSILON
    ) {
      reasons.push("related_position_changed");
      break;
    }
  }

  return [...new Set(reasons)];
}

function isHolderResearchStatus(value: unknown): value is HolderResearchStatus {
  return value === "PUBLISH" || value === "CONTEXT" || value === "SKIP";
}

function parseDecisionSnapshot(
  value: unknown,
): HolderResearchDecisionSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as HolderResearchDecisionSnapshot;
  if (
    snapshot.version !== 1 ||
    typeof snapshot.key !== "string" ||
    typeof snapshot.marketId !== "string" ||
    !snapshot.sides?.YES ||
    !snapshot.sides.NO ||
    !Array.isArray(snapshot.evidenceHolders)
  ) {
    return null;
  }
  return snapshot;
}

export function parseHolderResearchCachedDecision(
  raw: string | null,
): HolderResearchCachedDecision | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const snapshot = parseDecisionSnapshot(record.snapshot);
    if (
      record.version !== 1 ||
      typeof record.candidateKey !== "string" ||
      !isHolderResearchStatus(record.status) ||
      typeof record.model !== "string" ||
      typeof record.checkedAt !== "string" ||
      typeof record.digest !== "string" ||
      !snapshot
    ) {
      return null;
    }
    return {
      version: 1,
      candidateKey: record.candidateKey,
      status: record.status,
      model: record.model,
      checkedAt: record.checkedAt,
      nextEligibleAt:
        typeof record.nextEligibleAt === "string"
          ? record.nextEligibleAt
          : null,
      forceEligibleAt:
        typeof record.forceEligibleAt === "string"
          ? record.forceEligibleAt
          : null,
      snapshot,
      digest: record.digest,
      rationale: typeof record.rationale === "string" ? record.rationale : null,
    };
  } catch {
    return null;
  }
}

export function evaluateHolderResearchDecisionCache(input: {
  candidate: HolderResearchCandidate;
  cachedDecision: HolderResearchCachedDecision | null;
  policy: HolderResearchPolicy;
  now?: Date;
}): HolderResearchDecisionCacheEvaluation {
  const now = input.now ?? new Date();
  const snapshot = buildHolderResearchDecisionSnapshot(input.candidate);
  const digest = buildHolderResearchDecisionDigest(snapshot);
  const cached = input.cachedDecision;
  if (!cached) {
    return {
      action: "analyze",
      reason: "no_cache",
      snapshot,
      digest,
      cachedDecision: null,
      cachedStatus: null,
      lastCheckedAt: null,
      nextEligibleAt: null,
      meaningfulDeltaReasons: [],
    };
  }
  if (cached.candidateKey !== input.candidate.key) {
    return {
      action: "analyze",
      reason: "cache_key_mismatch",
      snapshot,
      digest,
      cachedDecision: cached,
      cachedStatus: cached.status,
      lastCheckedAt: cached.checkedAt,
      nextEligibleAt: cached.nextEligibleAt,
      meaningfulDeltaReasons: [],
    };
  }
  if (cached.status === "PUBLISH") {
    return {
      action: "analyze",
      reason: "publish_status",
      snapshot,
      digest,
      cachedDecision: cached,
      cachedStatus: cached.status,
      lastCheckedAt: cached.checkedAt,
      nextEligibleAt: cached.nextEligibleAt,
      meaningfulDeltaReasons: [],
    };
  }

  const meaningfulDeltaReasons = diffHolderResearchDecisionSnapshots(
    cached.snapshot,
    snapshot,
    input.policy,
    cached.checkedAt,
  );
  if (meaningfulDeltaReasons.length > 0) {
    return {
      action: "analyze",
      reason: "meaningful_delta",
      snapshot,
      digest,
      cachedDecision: cached,
      cachedStatus: cached.status,
      lastCheckedAt: cached.checkedAt,
      nextEligibleAt: cached.nextEligibleAt,
      meaningfulDeltaReasons,
    };
  }

  const checkedAtMs = parseDateMs(cached.checkedAt);
  const forceAtMs =
    parseDateMs(cached.forceEligibleAt) ??
    (checkedAtMs == null
      ? null
      : checkedAtMs + input.policy.forceRecheckAfterHours * 3_600_000);
  if (forceAtMs != null && now.getTime() >= forceAtMs) {
    return {
      action: "analyze",
      reason: "force_recheck",
      snapshot,
      digest,
      cachedDecision: cached,
      cachedStatus: cached.status,
      lastCheckedAt: cached.checkedAt,
      nextEligibleAt: cached.nextEligibleAt,
      meaningfulDeltaReasons: ["force_recheck"],
    };
  }

  const nextEligibleAtMs = parseDateMs(cached.nextEligibleAt);
  if (nextEligibleAtMs != null && now.getTime() >= nextEligibleAtMs) {
    return {
      action: "analyze",
      reason: "cooldown_expired",
      snapshot,
      digest,
      cachedDecision: cached,
      cachedStatus: cached.status,
      lastCheckedAt: cached.checkedAt,
      nextEligibleAt: cached.nextEligibleAt,
      meaningfulDeltaReasons: [],
    };
  }

  return {
    action: "skip",
    reason: "decision_cache",
    snapshot,
    digest,
    cachedDecision: cached,
    cachedStatus: cached.status,
    lastCheckedAt: cached.checkedAt,
    nextEligibleAt: cached.nextEligibleAt,
    meaningfulDeltaReasons: [],
  };
}

export function applyHolderResearchPreviousDecisionContext(
  candidate: HolderResearchCandidate,
  evaluation: HolderResearchDecisionCacheEvaluation | null,
): HolderResearchCandidate {
  const cached = evaluation?.cachedDecision;
  if (!cached) return candidate;
  const previousYes = cached.snapshot.yesProbability;
  const currentYes = candidate.market.yesProbability;
  const yesChangeSincePreviousDecision =
    previousYes != null && currentYes != null ? currentYes - previousYes : null;
  return {
    ...candidate,
    market: {
      ...candidate.market,
      marketMovementContext: {
        ...candidate.market.marketMovementContext,
        previousDecisionYesProbability: previousYes,
        yesChangeSincePreviousDecision,
        previousDecisionCheckedAt: cached.checkedAt,
      },
    },
  };
}

export function buildHolderResearchDecisionCacheRecord(input: {
  candidate: HolderResearchCandidate;
  output: Pick<HolderResearchAgentOutputV1, "rationale" | "status">;
  model: string;
  policy: HolderResearchPolicy;
  now?: Date;
}): HolderResearchCachedDecision {
  const now = input.now ?? new Date();
  const snapshot = buildHolderResearchDecisionSnapshot(input.candidate);
  const cooldownHours =
    input.output.status === "SKIP"
      ? input.policy.skipCooldownHours
      : input.output.status === "CONTEXT"
        ? input.policy.contextCooldownHours
        : 0;
  return {
    version: 1,
    candidateKey: input.candidate.key,
    status: input.output.status,
    model: input.model,
    checkedAt: now.toISOString(),
    nextEligibleAt: cooldownHours > 0 ? addHoursIso(now, cooldownHours) : null,
    forceEligibleAt: addHoursIso(now, input.policy.forceRecheckAfterHours),
    snapshot,
    digest: buildHolderResearchDecisionDigest(snapshot),
    rationale: input.output.rationale,
  };
}

function buildCandidate(
  input: Omit<HolderResearchCandidate, "inputDigest" | "key">,
): HolderResearchCandidate {
  const keyParts = [
    "holder_research",
    "v1",
    input.bucket,
    input.market.marketId,
    input.side ?? "mixed",
  ];
  const withoutDigest = {
    ...input,
    key: keyParts.join(":"),
  } as Omit<HolderResearchCandidate, "inputDigest">;
  const inputDigest = buildHolderResearchInputDigest(withoutDigest);
  return {
    ...withoutDigest,
    inputDigest,
  };
}

function sharpScore(
  side: HolderResearchSide,
  policy: HolderResearchPolicy,
  minorityShareBoost: number,
): number {
  const edge = Math.max(
    0,
    (side.bestEdge ?? 0) - policy.minResolvedWinRateEdge30d,
  );
  const edgeSpan = Math.max(
    0.01,
    policy.strongResolvedWinRateEdge30d - policy.minResolvedWinRateEdge30d,
  );
  const z = Math.max(
    0,
    (side.bestZScore ?? 0) - policy.minResolvedEdgeZScore30d,
  );
  const zSpan = Math.max(
    0.1,
    policy.strongResolvedEdgeZScore30d - policy.minResolvedEdgeZScore30d,
  );
  const samples = Math.max(
    0,
    (side.bestSampleCount ?? 0) - policy.minResolvedEdgeSampleCount30d,
  );
  const sampleSpan = Math.max(
    1,
    policy.strongResolvedEdgeSampleCount30d -
      policy.minResolvedEdgeSampleCount30d,
  );

  return clamp01(
    0.5 +
      clamp01(edge / edgeSpan) * 0.16 +
      clamp01(z / zSpan) * 0.12 +
      clamp01(samples / sampleSpan) * 0.1 +
      scoreLog(side.usd, policy.minSidePositionUsd) * 0.08 +
      Math.min(0.08, side.sharpHolders * 0.03) +
      minorityShareBoost,
  );
}

export function buildHolderResearchCandidatesFromMarket(
  market: HolderResearchMarketInput,
  policy: HolderResearchPolicy,
): HolderResearchCandidate[] {
  if (isExtremeOdds(market.yesProbability, policy)) return [];

  const yes = market.sides.YES;
  const no = market.sides.NO;
  const totalUsd = yes.usd + no.usd;
  if (totalUsd <= 0) return [];

  const largestHolderUsd = Math.max(
    0,
    ...market.holders.map((holder) => holder.positionUsd),
  );
  const largestHolderPct = totalUsd > 0 ? largestHolderUsd / totalUsd : 0;
  const sidesByUsd = [...SIDE_KEYS].sort(
    (a, b) => market.sides[a].usd - market.sides[b].usd,
  );
  const minoritySideKey = sidesByUsd[0];
  const minority = market.sides[minoritySideKey];
  const majority = market.sides[sidesByUsd[1]];
  const minorityShare = totalUsd > 0 ? minority.usd / totalUsd : 0;
  const baseEvidence = buildBaseEvidence(market);
  const candidates: HolderResearchCandidate[] = [];

  const sharpSides = SIDE_KEYS.filter((side) => {
    const sideData = market.sides[side];
    return (
      sideData.sharpHolders > 0 &&
      sideData.usd >= policy.minSidePositionUsd &&
      (sideData.bestTrades30d ?? -Infinity) >= policy.minTrades30d
    );
  });

  if (
    sharpSides.length === 2 &&
    SIDE_KEYS.every((side) =>
      sideHasStrongSharpEvidence(market.sides[side], policy),
    )
  ) {
    const yesHolder = bestHolderForSide(market, "YES");
    const noHolder = bestHolderForSide(market, "NO");
    candidates.push(
      buildCandidate({
        bucket: "sharp_split",
        score: clamp01(
          0.66 +
            Math.min(0.14, (yes.sharpHolders + no.sharpHolders) * 0.03) +
            scoreLog(totalUsd, policy.minSidePositionUsd * 2) * 0.12,
        ),
        side: null,
        direction: "mixed",
        signalType: "update",
        reasons: ["sharp_yes", "sharp_no", "two_sided_sharp_evidence"],
        market,
        evidence: [
          ...baseEvidence,
          ...(yesHolder ? [holderEvidence(yesHolder)] : []),
          ...(noHolder ? [holderEvidence(noHolder)] : []),
        ],
        cooldownUntil: null,
      }),
    );
  }

  if (
    minority.usd >= policy.minMinorityUsd &&
    minorityShare >= policy.minMinorityShare &&
    minority.sharpHolders > 0 &&
    minority.usd >= policy.minSidePositionUsd &&
    minority.wallets >= 1 &&
    majority.wallets >= policy.minSideWallets
  ) {
    const holder = bestHolderForSide(market, minoritySideKey);
    candidates.push(
      buildCandidate({
        bucket: "sharp_minority",
        score: sharpScore(minority, policy, 0.08 + minorityShare * 0.1),
        side: minoritySideKey,
        direction: sideDirection(minoritySideKey),
        signalType: "update",
        reasons: ["sharp_minority", "material_minority_exposure"],
        market,
        evidence: [
          ...baseEvidence,
          ...(holder ? [holderEvidence(holder)] : []),
        ],
        cooldownUntil: null,
      }),
    );
  }

  for (const side of sharpSides) {
    const sideData = market.sides[side];
    const holder = bestHolderForSide(market, side);
    candidates.push(
      buildCandidate({
        bucket: "sharp_side",
        score: sharpScore(sideData, policy, 0),
        side,
        direction: sideDirection(side),
        signalType: "update",
        reasons: [`sharp_${side.toLowerCase()}`, "holder_edge_quality"],
        market,
        evidence: [
          ...baseEvidence,
          ...(holder ? [holderEvidence(holder)] : []),
        ],
        cooldownUntil: null,
      }),
    );
  }

  if (
    minority.usd >= policy.minMinorityUsd &&
    minorityShare >= policy.minMinorityShare &&
    yes.wallets >= policy.minSideWallets &&
    no.wallets >= policy.minSideWallets &&
    largestHolderPct < policy.twoSidedLargestHolderMaxPct
  ) {
    candidates.push(
      buildCandidate({
        bucket: "clean_disagreement",
        score: clamp01(
          0.5 +
            minorityShare * 0.35 +
            scoreLog(minority.usd, policy.minMinorityUsd) * 0.1 +
            Math.min(0.06, (yes.wallets + no.wallets) * 0.01),
        ),
        side: minoritySideKey,
        direction: "mixed",
        signalType: "update",
        reasons: ["two_sided_material_exposure", "not_whale_dominated"],
        market,
        evidence: baseEvidence,
        cooldownUntil: null,
      }),
    );
  }

  if (market.recentActivityUsd >= policy.minRecentActivityUsd) {
    candidates.push(
      buildCandidate({
        bucket: "recent_flow",
        score: clamp01(
          0.48 +
            scoreLog(market.recentActivityUsd, policy.minRecentActivityUsd) *
              0.22 +
            scoreLog(totalUsd, policy.minSidePositionUsd) * 0.08,
        ),
        side: null,
        direction: "mixed",
        signalType: "update",
        reasons: ["recent_meaningful_wallet_activity"],
        market,
        evidence: [
          ...baseEvidence,
          {
            id: `activity:${market.marketId}:recent`,
            kind: "activity",
            title: "Recent tracked flow",
            summary: `${formatUsd(market.recentActivityUsd)} recent wallet activity while exposure remains open.`,
            relevance: 0.75,
          },
        ],
        cooldownUntil: null,
      }),
    );
  }

  if (market.crossMarketWalletCount >= policy.eventBridgeMinWallets) {
    candidates.push(
      buildCandidate({
        bucket: "event_bridge",
        score: clamp01(
          0.5 +
            Math.min(0.2, market.crossMarketWalletCount * 0.025) +
            scoreLog(totalUsd, policy.minSidePositionUsd) * 0.08,
        ),
        side: null,
        direction: "mixed",
        signalType: "update",
        reasons: ["cross_market_wallet_overlap"],
        market,
        evidence: [
          ...baseEvidence,
          {
            id: `event:${market.eventId ?? market.marketId}:bridge`,
            kind: "event",
            title: "Cross-market holders",
            summary: `${market.crossMarketWalletCount} wallets hold more than one market in this event.`,
            relevance: 0.7,
          },
        ],
        cooldownUntil: null,
      }),
    );
  }

  if (
    totalUsd >= policy.concentrationMinTotalUsd &&
    largestHolderPct >= policy.concentrationLargestHolderPct
  ) {
    candidates.push(
      buildCandidate({
        bucket: "concentration_risk",
        score: clamp01(0.45 + largestHolderPct * 0.35),
        side: null,
        direction: "mixed",
        signalType: "risk",
        reasons: ["holder_concentration"],
        market,
        evidence: baseEvidence,
        cooldownUntil: null,
      }),
    );
  }

  if (market.previousNote && !market.previousNote.cooldownUntil) {
    candidates.push(
      buildCandidate({
        bucket: "followup_existing",
        score: clamp01(
          0.5 +
            scoreLog(market.recentActivityUsd, policy.minRecentActivityUsd) *
              0.2 +
            Math.max(...candidates.map((candidate) => candidate.score), 0) *
              0.2,
        ),
        side: null,
        direction: "mixed",
        signalType: "update",
        reasons: ["existing_holder_research_note", "market_still_active"],
        market,
        evidence: [
          ...baseEvidence,
          {
            id: `note:${market.previousNote.noteId}`,
            kind: "note",
            title: market.previousNote.title,
            summary: `Previous holder research note was created at ${market.previousNote.createdAt}.`,
            relevance: 0.7,
          },
        ],
        cooldownUntil: null,
      }),
    );
  }

  return candidates.filter((candidate) => candidate.score >= policy.minScore);
}

function quotaForBucket(
  bucket: HolderResearchBucket,
  policy: HolderResearchPolicy,
): number {
  switch (bucket) {
    case "followup_existing":
      return policy.quotaFollowupExisting;
    case "sharp_minority":
      return policy.quotaSharpMinority;
    case "sharp_side":
      return policy.quotaSharpSide;
    case "sharp_split":
      return policy.quotaSharpSplit;
    case "clean_disagreement":
      return policy.quotaCleanDisagreement;
    case "recent_flow":
      return policy.quotaRecentFlow;
    case "event_bridge":
      return policy.quotaEventBridge;
    case "concentration_risk":
      return policy.quotaConcentrationRisk;
  }
}

function bucketPriority(bucket: HolderResearchBucket): number {
  switch (bucket) {
    case "followup_existing":
      return 0;
    case "sharp_minority":
      return 1;
    case "sharp_split":
      return 2;
    case "sharp_side":
      return 3;
    case "clean_disagreement":
      return 4;
    case "recent_flow":
      return 5;
    case "event_bridge":
      return 6;
    case "concentration_risk":
      return 7;
  }
}

export function selectHolderResearchCandidates(
  candidates: HolderResearchCandidate[],
  policy: HolderResearchPolicy,
  now: Date = new Date(),
): HolderResearchSelectionResult {
  const maxSelected = Math.min(
    policy.maxAgentCallsPerRun,
    policy.maxCandidatesPerRun,
  );
  const selected: HolderResearchCandidate[] = [];
  const skipped: HolderResearchSelectionResult["skipped"] = [];
  const usedMarkets = new Set<string>();
  const usedKeys = new Set<string>();
  const quotaUsed = new Map<HolderResearchBucket, number>();
  const sorted = [...candidates].sort((a, b) => {
    const priorityDelta = bucketPriority(a.bucket) - bucketPriority(b.bucket);
    if (priorityDelta !== 0) return priorityDelta;
    return b.score - a.score;
  });

  const isEligible = (candidate: HolderResearchCandidate): boolean => {
    if (candidate.score < policy.minScore) {
      skipped.push({ candidate, reason: "below_score" });
      return false;
    }
    if (
      candidate.cooldownUntil &&
      new Date(candidate.cooldownUntil).getTime() > now.getTime()
    ) {
      skipped.push({ candidate, reason: "cooldown" });
      return false;
    }
    if (usedMarkets.has(candidate.market.marketId)) {
      skipped.push({ candidate, reason: "duplicate_market" });
      return false;
    }
    return true;
  };

  for (const candidate of sorted) {
    if (selected.length >= maxSelected) break;
    if (!isEligible(candidate)) continue;
    const quota = quotaForBucket(candidate.bucket, policy);
    const used = quotaUsed.get(candidate.bucket) ?? 0;
    if (used >= quota) continue;
    selected.push(candidate);
    usedKeys.add(candidate.key);
    usedMarkets.add(candidate.market.marketId);
    quotaUsed.set(candidate.bucket, used + 1);
  }

  const refill = [...candidates].sort((a, b) => b.score - a.score);
  for (const candidate of refill) {
    if (selected.length >= maxSelected) break;
    if (usedKeys.has(candidate.key)) continue;
    if (
      quotaForBucket(candidate.bucket, policy) <= 0 &&
      candidate.score < policy.publishMinScore
    ) {
      skipped.push({ candidate, reason: "quota" });
      continue;
    }
    if (!isEligible(candidate)) continue;
    selected.push(candidate);
    usedKeys.add(candidate.key);
    usedMarkets.add(candidate.market.marketId);
  }

  for (const candidate of candidates) {
    if (usedKeys.has(candidate.key)) continue;
    if (candidate.score >= policy.minScore) {
      skipped.push({ candidate, reason: "quota" });
    }
  }

  return { selected, skipped };
}

function buildSideFromRow(
  side: HolderResearchSideKey,
  row: HolderResearchMarketRow,
): HolderResearchSide {
  const prefix = side.toLowerCase() as "yes" | "no";
  return {
    side,
    usd: toNumber(row[`${prefix}_usd`]) ?? 0,
    wallets: toInt(row[`${prefix}_wallets`]),
    openPnlUsd: null,
    sharpHolders: toInt(row[`${prefix}_sharp_holders`]),
    sharpUsd: toNumber(row[`${prefix}_sharp_usd`]) ?? 0,
    bestEdge: toNumber(row[`${prefix}_best_edge`]),
    bestZScore: toNumber(row[`${prefix}_best_z_score`]),
    bestSampleCount: toNumber(row[`${prefix}_best_sample_count`]),
    bestResolvedStakeUsd: toNumber(row[`${prefix}_best_resolved_stake_usd`]),
    bestTrades30d: toNumber(row[`${prefix}_best_trades_30d`]),
  };
}

function parseHolderRows(row: HolderResearchMarketRow): HolderResearchHolder[] {
  return parseJsonArray(row.top_holders)
    .map<HolderResearchHolder | null>((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const side = normalizeSide(record.side);
      const walletId = safeText(record.walletId);
      const address = safeText(record.address);
      const chain = safeText(record.chain);
      const positionUsd = toNumber(record.positionUsd);
      if (!side || !walletId || !address || !chain || positionUsd == null) {
        return null;
      }
      return {
        walletId,
        address,
        chain,
        label: safeText(record.label),
        side,
        positionUsd,
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
        pnl30dUsd: toNumber(record.pnl30dUsd),
        resolvedWinRateEdge30d: toNumber(record.resolvedWinRateEdge30d),
        resolvedEdgeZScore30d: toNumber(record.resolvedEdgeZScore30d),
        resolvedEdgeSampleCount30d: toNumber(record.resolvedEdgeSampleCount30d),
        resolvedStakeUsd30d: toNumber(record.resolvedStakeUsd30d),
        trades30d: toNumber(record.trades30d),
        winRate30d: toNumber(record.winRate30d),
        volume30dUsd: toNumber(record.volume30dUsd),
        walletKind: safeText(record.walletKind),
        ownerAddress: safeText(record.ownerAddress),
        walletUsdLikeBalance: toNumber(record.walletUsdLikeBalance),
        ownerUsdLikeBalance: toNumber(record.ownerUsdLikeBalance),
        mmSuspected: record.mmSuspected === true,
        marketTypeMetrics30d: null,
        relatedOpenPositions: [],
      };
    })
    .filter((holder): holder is HolderResearchHolder => holder != null);
}

function buildMarketMovementContext(
  row: HolderResearchMarketRow,
  yesProbability: number | null,
): HolderResearchMarketMovementContext {
  return {
    yesProbabilityNow: yesProbability,
    yesChange24h: toNumber(row.market_change_24h),
    volume24h: toNumber(row.volume_24h),
    volumeChange24h: toNumber(row.volume_last_24h_change),
    volumeChangePct24h: toNumber(row.volume_last_24h_change_pct),
    liquidity: toNumber(row.liquidity),
    liquidityChange24h: toNumber(row.liquidity_change_24h),
    liquidityChangePct24h: toNumber(row.liquidity_change_pct_24h),
    openInterestChange24h: toNumber(row.open_interest_change_24h),
    openInterestChangePct24h: toNumber(row.open_interest_change_pct_24h),
    updatedAt: toIso(row.market_activity_metrics_updated_at),
    previousDecisionYesProbability: null,
    yesChangeSincePreviousDecision: null,
    previousDecisionCheckedAt: null,
  };
}

function rowToMarket(row: HolderResearchMarketRow): HolderResearchMarketInput {
  const yesProbability = calculateYesProbability(row);
  return {
    marketId: row.market_id,
    eventId: row.event_id,
    venue: row.venue,
    marketTitle: row.market_title ?? row.market_id,
    marketSlug: safeText(row.market_slug),
    marketDescription: compactText(row.market_description, 1_200),
    eventTitle: row.event_title,
    eventSlug: safeText(row.event_slug),
    eventDescription: compactText(row.event_description, 1_200),
    seriesKey: safeText(row.series_key),
    seriesTitle: safeText(row.series_title),
    resolutionSource: compactText(row.resolution_source, 600),
    category: row.category,
    closeTime: toIso(row.close_time),
    expirationTime: toIso(row.expiration_time),
    yesProbability,
    volume24h: toNumber(row.volume_24h),
    liquidity: toNumber(row.liquidity),
    marketMovementContext: buildMarketMovementContext(row, yesProbability),
    sides: {
      YES: buildSideFromRow("YES", row),
      NO: buildSideFromRow("NO", row),
    },
    holders: parseHolderRows(row),
    recentActivityUsd: toNumber(row.recent_activity_usd) ?? 0,
    recentActivityAt: toIso(row.recent_activity_at),
    crossMarketWalletCount: toInt(row.cross_market_wallet_count),
    previousNote: null,
  };
}

export async function loadHolderResearchCandidateMarkets(
  client: Queryable,
  policy: HolderResearchPolicy,
  mmThresholds?: HolderResearchMmThresholds,
): Promise<HolderResearchMarketInput[]> {
  const trackableSql = buildWalletIntelTrackableMarketSql({
    marketAlias: "um",
    eventAlias: "ue",
  });
  const candidateWalletLimit = Math.min(
    5_000,
    Math.max(1_000, policy.maxCandidatePool * 25),
  );
  const mmWhaleUsd = Math.max(
    0,
    mmThresholds?.whaleUsd ?? policy.minSidePositionUsd,
  );
  const mmWhaleUsdSolana = Math.max(
    0,
    mmThresholds?.whaleUsdSolana ?? mmWhaleUsd,
  );

  const { rows } = await client.query<HolderResearchMarketRow>(
    `
      with candidate_wallets as materialized (
        select
          w.id as wallet_id,
          w.address,
          w.chain,
          w.label,
          sel.metrics_volume_30d,
          sel.metrics_pnl_30d,
          sel.metrics_trades_30d,
          sel.metrics_win_rate_30d,
          sel.metrics_resolved_win_rate_edge_30d,
          sel.metrics_resolved_edge_z_score_30d,
          sel.metrics_resolved_edge_sample_count_30d,
          sel.metrics_resolved_stake_usd_30d,
          sel.exposure_usd,
          sel.hedged_notional_usd,
          sel.hedge_ratio,
          sel.two_sided_markets,
          ${buildWalletMmSuspectedSql({
            exposureUsdSql: "sel.exposure_usd",
            hedgedNotionalUsdSql: "sel.hedged_notional_usd",
            hedgeRatioSql: "sel.hedge_ratio",
            twoSidedMarketsSql: "sel.two_sided_markets",
            exposureThresholdSql: `case
              when w.chain = 'solana' then $13::numeric
              else $12::numeric
            end`,
          })} as mm_suspected,
          ons.wallet_kind,
          ons.owner_address,
          ons.wallet_usd_like_balance,
          ons.owner_usd_like_balance
        from wallet_intel_selector_snapshot sel
        join wallets w on w.id = sel.wallet_id
        left join wallet_onchain_state ons
          on ons.wallet_id = sel.wallet_id
        where
          coalesce(sel.exposure_usd, 0) >= $2::numeric
          or coalesce(sel.metrics_volume_30d, 0) >= $2::numeric
          or coalesce(sel.metrics_pnl_30d, 0) > 0
          or coalesce(sel.metrics_trades_30d, 0) >= $7::integer
          or sel.last_activity_at >= now() - ($1::numeric * interval '1 hour')
          or (
            coalesce(sel.metrics_resolved_win_rate_edge_30d, -1000) >= $3::numeric
            and coalesce(sel.metrics_resolved_edge_z_score_30d, -1000) >= $4::numeric
            and coalesce(sel.metrics_resolved_edge_sample_count_30d, -1) >= $5::integer
            and coalesce(sel.metrics_resolved_stake_usd_30d, 0) >= $6::numeric
            and coalesce(sel.metrics_trades_30d, -1) >= $7::integer
          )
        order by
          (
            coalesce(sel.metrics_resolved_win_rate_edge_30d, -1000) >= $3::numeric
            and coalesce(sel.metrics_resolved_edge_z_score_30d, -1000) >= $4::numeric
            and coalesce(sel.metrics_resolved_edge_sample_count_30d, -1) >= $5::integer
            and coalesce(sel.metrics_resolved_stake_usd_30d, 0) >= $6::numeric
            and coalesce(sel.metrics_trades_30d, -1) >= $7::integer
          ) desc,
          coalesce(sel.exposure_usd, 0) desc,
          coalesce(sel.metrics_pnl_30d, 0) desc,
          coalesce(sel.metrics_volume_30d, 0) desc,
          sel.last_activity_at desc nulls last,
          sel.wallet_id asc
        limit $11::integer
      ),
      latest_wallet_snapshots as materialized (
        select
          cw.*,
          latest.venue,
          latest.snapshot_at
        from candidate_wallets cw
        join lateral (
          select distinct on (ws.venue)
            ws.venue,
            ws.snapshot_at
          from wallet_position_snapshots ws
          where ws.wallet_id = cw.wallet_id
            and ws.snapshot_at >= now() - ($1::numeric * interval '1 hour')
          order by ws.venue, ws.snapshot_at desc
        ) latest on true
      ),
      open_positions as materialized (
        select
          latest.wallet_id,
          latest.venue,
          ws.market_id,
          upper(coalesce(ws.outcome_side, '')) as side,
          abs(coalesce(ws.size_usd, 0))::numeric as position_usd,
          ws.snapshot_at,
          latest.address,
          latest.chain,
          latest.label,
          latest.metrics_volume_30d,
          latest.metrics_pnl_30d,
          latest.metrics_trades_30d,
          latest.metrics_win_rate_30d,
          latest.metrics_resolved_win_rate_edge_30d,
          latest.metrics_resolved_edge_z_score_30d,
          latest.metrics_resolved_edge_sample_count_30d,
          latest.metrics_resolved_stake_usd_30d,
          latest.exposure_usd,
          latest.hedged_notional_usd,
          latest.hedge_ratio,
          latest.two_sided_markets,
          latest.mm_suspected,
          latest.wallet_kind,
          latest.owner_address,
          latest.wallet_usd_like_balance,
          latest.owner_usd_like_balance
        from latest_wallet_snapshots latest
        join wallet_position_snapshots ws
          on ws.wallet_id = latest.wallet_id
         and ws.venue = latest.venue
         and ws.snapshot_at = latest.snapshot_at
        join unified_markets um on um.id = ws.market_id
        left join unified_events ue on ue.id = um.event_id
        where ${trackableSql}
          and upper(coalesce(ws.outcome_side, '')) in ('YES', 'NO')
          and abs(coalesce(ws.size_usd, 0)) >= $2::numeric
      ),
      candidate_markets as materialized (
        select distinct market_id, venue
        from open_positions
      ),
      side_agg as (
        select
          market_id,
          side,
          sum(position_usd) as usd,
          count(distinct wallet_id) as wallets,
          count(*) filter (
            where position_usd >= $2::numeric
              and not coalesce(mm_suspected, false)
              and coalesce(metrics_resolved_win_rate_edge_30d, -1000) >= $3::numeric
              and coalesce(metrics_resolved_edge_z_score_30d, -1000) >= $4::numeric
              and coalesce(metrics_resolved_edge_sample_count_30d, -1) >= $5::integer
              and coalesce(metrics_resolved_stake_usd_30d, 0) >= $6::numeric
              and coalesce(metrics_trades_30d, -1) >= $7::integer
          ) as sharp_holders,
          sum(position_usd) filter (
            where position_usd >= $2::numeric
              and not coalesce(mm_suspected, false)
              and coalesce(metrics_resolved_win_rate_edge_30d, -1000) >= $3::numeric
              and coalesce(metrics_resolved_edge_z_score_30d, -1000) >= $4::numeric
              and coalesce(metrics_resolved_edge_sample_count_30d, -1) >= $5::integer
              and coalesce(metrics_resolved_stake_usd_30d, 0) >= $6::numeric
              and coalesce(metrics_trades_30d, -1) >= $7::integer
          ) as sharp_usd,
          max(metrics_resolved_win_rate_edge_30d) filter (
            where not coalesce(mm_suspected, false)
          ) as best_edge,
          max(metrics_resolved_edge_z_score_30d) filter (
            where not coalesce(mm_suspected, false)
          ) as best_z_score,
          max(metrics_resolved_edge_sample_count_30d) filter (
            where not coalesce(mm_suspected, false)
          ) as best_sample_count,
          max(metrics_resolved_stake_usd_30d) filter (
            where not coalesce(mm_suspected, false)
          ) as best_resolved_stake_usd,
          max(metrics_trades_30d) filter (
            where not coalesce(mm_suspected, false)
          ) as best_trades_30d
        from open_positions
        group by market_id, side
      ),
      recent_activity as (
        select
          wa.market_id,
          sum(abs(coalesce(wa.size_usd, 0))) as recent_activity_usd,
          max(wa.occurred_at) as recent_activity_at
        from candidate_markets cm
        join wallet_activity_events wa
          on wa.market_id = cm.market_id
         and wa.venue = cm.venue
        join unified_markets um on um.id = wa.market_id
        left join unified_events ue on ue.id = um.event_id
        where wa.occurred_at >= now() - ($8::numeric * interval '1 hour')
          and wa.activity_type in ('delta', 'trade')
          and ${trackableSql}
        group by wa.market_id
      ),
      event_wallet_market_counts as (
        select
          um.event_id,
          op.wallet_id,
          count(distinct op.market_id) as market_count
        from open_positions op
        join unified_markets um on um.id = op.market_id
        group by um.event_id, op.wallet_id
      ),
      event_bridge as (
        select
          event_id,
          count(*) filter (where market_count >= 2) as cross_market_wallet_count
        from event_wallet_market_counts
        group by event_id
      ),
      ranked_holders as (
        select
          op.*,
          row_number() over (
            partition by op.market_id
            order by
              (
                op.position_usd >= $2::numeric
                and not coalesce(op.mm_suspected, false)
                and coalesce(op.metrics_resolved_win_rate_edge_30d, -1000) >= $3::numeric
                and coalesce(op.metrics_resolved_edge_z_score_30d, -1000) >= $4::numeric
                and coalesce(op.metrics_resolved_edge_sample_count_30d, -1) >= $5::integer
                and coalesce(op.metrics_resolved_stake_usd_30d, 0) >= $6::numeric
                and coalesce(op.metrics_trades_30d, -1) >= $7::integer
              ) desc,
              op.position_usd desc
          ) as holder_rank
        from open_positions op
      ),
      top_holders as (
        select
          market_id,
          jsonb_agg(
            jsonb_build_object(
              'walletId', wallet_id,
              'address', address,
              'chain', chain,
              'label', label,
              'side', side,
              'positionUsd', position_usd,
              'volume30dUsd', metrics_volume_30d,
              'pnl30dUsd', metrics_pnl_30d,
              'trades30d', metrics_trades_30d,
              'winRate30d', metrics_win_rate_30d,
              'resolvedWinRateEdge30d', metrics_resolved_win_rate_edge_30d,
              'resolvedEdgeZScore30d', metrics_resolved_edge_z_score_30d,
              'resolvedEdgeSampleCount30d', metrics_resolved_edge_sample_count_30d,
              'resolvedStakeUsd30d', metrics_resolved_stake_usd_30d,
              'walletKind', wallet_kind,
              'ownerAddress', owner_address,
              'walletUsdLikeBalance', wallet_usd_like_balance,
              'ownerUsdLikeBalance', owner_usd_like_balance,
              'mmSuspected', mm_suspected
            )
            order by holder_rank asc
          ) filter (where holder_rank <= 8) as top_holders,
          max(position_usd) as largest_holder_usd
        from ranked_holders
        group by market_id
      )
      select
        um.id as market_id,
        um.event_id,
        um.venue,
        um.title as market_title,
        um.slug as market_slug,
        um.description as market_description,
        ue.title as event_title,
        ue.slug as event_slug,
        ue.description as event_description,
        ue.series_key,
        ue.series_title,
        nullif(
          coalesce(
            nullif(um.metadata->>'resolutionSource', ''),
            nullif(ue.metadata->>'resolutionSource', '')
          ),
          ''
        ) as resolution_source,
        coalesce(um.category, ue.category) as category,
        um.close_time,
        um.expiration_time,
        um.best_bid,
        um.best_ask,
        um.last_price,
        um.volume_24h,
        um.liquidity,
        mc.change_24h as market_change_24h,
        mam.volume_last_24h_change,
        mam.volume_last_24h_change_pct,
        mam.liquidity_change_24h,
        mam.liquidity_change_pct_24h,
        mam.open_interest_change_24h,
        mam.open_interest_change_pct_24h,
        mam.updated_at as market_activity_metrics_updated_at,
        coalesce(yes.usd, 0) as yes_usd,
        coalesce(no.usd, 0) as no_usd,
        coalesce(yes.wallets, 0) as yes_wallets,
        coalesce(no.wallets, 0) as no_wallets,
        coalesce(yes.sharp_holders, 0) as yes_sharp_holders,
        coalesce(no.sharp_holders, 0) as no_sharp_holders,
        coalesce(yes.sharp_usd, 0) as yes_sharp_usd,
        coalesce(no.sharp_usd, 0) as no_sharp_usd,
        yes.best_edge as yes_best_edge,
        no.best_edge as no_best_edge,
        yes.best_z_score as yes_best_z_score,
        no.best_z_score as no_best_z_score,
        yes.best_sample_count as yes_best_sample_count,
        no.best_sample_count as no_best_sample_count,
        yes.best_resolved_stake_usd as yes_best_resolved_stake_usd,
        no.best_resolved_stake_usd as no_best_resolved_stake_usd,
        yes.best_trades_30d as yes_best_trades_30d,
        no.best_trades_30d as no_best_trades_30d,
        th.largest_holder_usd,
        coalesce(ra.recent_activity_usd, 0) as recent_activity_usd,
        ra.recent_activity_at,
        coalesce(eb.cross_market_wallet_count, 0) as cross_market_wallet_count,
        coalesce(th.top_holders, '[]'::jsonb) as top_holders
      from unified_markets um
      left join unified_events ue on ue.id = um.event_id
      join top_holders th on th.market_id = um.id
      left join side_agg yes on yes.market_id = um.id and yes.side = 'YES'
      left join side_agg no on no.market_id = um.id and no.side = 'NO'
      left join recent_activity ra on ra.market_id = um.id
      left join event_bridge eb on eb.event_id = um.event_id
      left join unified_market_change_24h mc on mc.market_id = um.id
      left join unified_market_activity_metrics_24h mam on mam.market_id = um.id
      where ${trackableSql}
        and (coalesce(yes.usd, 0) + coalesce(no.usd, 0)) >= $9::numeric
      order by
        (coalesce(yes.sharp_holders, 0) + coalesce(no.sharp_holders, 0)) desc,
        (coalesce(yes.usd, 0) + coalesce(no.usd, 0)) desc
      limit $10::integer
    `,
    [
      policy.candidateLookbackHours,
      policy.minHolderPositionUsd,
      policy.minResolvedWinRateEdge30d,
      policy.minResolvedEdgeZScore30d,
      policy.minResolvedEdgeSampleCount30d,
      policy.minResolvedStakeUsd30d,
      policy.minTrades30d,
      policy.activityLookbackHours,
      Math.min(policy.minSidePositionUsd, policy.minMinorityUsd),
      policy.maxCandidatePool,
      candidateWalletLimit,
      mmWhaleUsd,
      mmWhaleUsdSolana,
    ],
  );

  return rows.map(rowToMarket);
}

export async function attachHolderResearchHistory(
  client: Queryable,
  markets: HolderResearchMarketInput[],
  policy: HolderResearchPolicy,
  now: Date = new Date(),
): Promise<HolderResearchMarketInput[]> {
  const marketIds = Array.from(
    new Set(markets.map((market) => market.marketId)),
  );
  if (marketIds.length === 0) return markets;

  const { rows } = await client.query<{
    market_id: string;
    note_id: string;
    title: string;
    created_at: Date | string;
    input_digest: string | null;
    wallet_targets: unknown;
  }>(
    `
      select distinct on (t.target_id)
        t.target_id as market_id,
        n.id as note_id,
        n.title,
        n.created_at,
        n.lineage->>'input_digest' as input_digest,
        coalesce(wallet_targets.targets, '[]'::jsonb) as wallet_targets
      from ai_note_targets t
      join ai_notes n on n.id = t.note_id
      left join lateral (
        select jsonb_agg(
          jsonb_build_object(
            'walletId', wt.target_id,
            'side', wt.target_meta->>'side'
          )
          order by wt.target_rank asc, wt.target_id asc
        ) as targets
        from ai_note_targets wt
        where wt.note_id = n.id
          and wt.target_kind = 'wallet'
      ) wallet_targets on true
      where t.target_kind = 'market'
        and t.target_id = any($1::text[])
        and n.note_type = 'signal'
        and n.producer_type = 'holder_research'
        and n.status = 'active'
      order by t.target_id, n.created_at desc
    `,
    [marketIds],
  );

  const byMarketId = new Map(
    rows.map((row) => [
      row.market_id,
      {
        noteId: row.note_id,
        title: row.title,
        createdAt: toIso(row.created_at) ?? now.toISOString(),
        inputDigest: row.input_digest,
        cooldownUntil: null,
        walletTargets: parsePreviousNoteWalletTargets(row.wallet_targets),
      } satisfies HolderResearchPreviousNote,
    ]),
  );

  return markets.map((market) => {
    const previousNote = byMarketId.get(market.marketId) ?? null;
    if (!previousNote) return market;
    const previousAt = new Date(previousNote.createdAt).getTime();
    const cooldownUntil =
      Number.isFinite(previousAt) &&
      now.getTime() - previousAt < policy.noteCooldownHours * 60 * 60 * 1_000
        ? new Date(
            previousAt + policy.noteCooldownHours * 60 * 60 * 1_000,
          ).toISOString()
        : null;
    return {
      ...market,
      previousNote: {
        ...previousNote,
        cooldownUntil,
      },
    };
  });
}

export function applyHolderResearchCooldowns(
  candidates: HolderResearchCandidate[],
  _policy: HolderResearchPolicy,
): HolderResearchCandidate[] {
  return candidates.map((candidate) => {
    const previous = candidate.market.previousNote;
    if (!previous) return candidate;
    if (candidate.bucket === "followup_existing") {
      return { ...candidate, cooldownUntil: null };
    }
    return { ...candidate, cooldownUntil: previous.cooldownUntil };
  });
}

export async function loadHolderResearchCandidates(
  client: Queryable,
  policy: HolderResearchPolicy,
  mmThresholds?: HolderResearchMmThresholds,
): Promise<HolderResearchCandidate[]> {
  const markets = await attachHolderResearchHistory(
    client,
    await loadHolderResearchCandidateMarkets(client, policy, mmThresholds),
    policy,
  );
  const candidates = markets.flatMap((market) =>
    buildHolderResearchCandidatesFromMarket(market, policy),
  );
  return applyHolderResearchCooldowns(candidates, policy);
}

export async function enrichHolderResearchLivePositions(
  client: Queryable,
  candidates: HolderResearchCandidate[],
  policy: HolderResearchPolicy,
): Promise<HolderResearchCandidate[]> {
  if (policy.maxLiveChecksPerRun <= 0 || candidates.length === 0) {
    return candidates;
  }

  const holderInputs = candidates
    .flatMap((candidate) =>
      candidate.market.holders.map((holder) => ({
        walletId: holder.walletId,
        venue: candidate.market.venue,
        marketId: candidate.market.marketId,
        outcomeSide: holder.side,
      })),
    )
    .slice(0, policy.maxLiveChecksPerRun);

  const liveByKey = await loadLatestWalletPositionNowMap(client, holderInputs);

  return candidates.map((candidate) => {
    const holders = candidate.market.holders.map((holder) => {
      const key = makeWalletPositionLedgerKey(
        holder.walletId,
        candidate.market.marketId,
        holder.side,
      );
      const live = liveByKey.get(key);
      return {
        ...holder,
        openPnlUsd: live?.openPnlUsd ?? holder.openPnlUsd,
        realizedPnlUsd: live?.realizedPnlUsd ?? holder.realizedPnlUsd,
        totalPnlUsd: live?.totalPnlUsd ?? holder.totalPnlUsd,
        positionUsd: live?.positionSizeUsd ?? holder.positionUsd,
        positionShares: live?.positionShares ?? holder.positionShares,
        avgEntryPrice: live?.approxEntryPrice ?? holder.avgEntryPrice,
        currentPrice: live?.currentPrice ?? holder.currentPrice,
        entryToCurrentDelta:
          live?.approxEntryPrice != null && live.currentPrice != null
            ? live.currentPrice - live.approxEntryPrice
            : holder.entryToCurrentDelta,
        approxReliable: live ? live.approxReliable : holder.approxReliable,
        approxPnlSource: live?.approxPnlSource ?? holder.approxPnlSource,
        positionSnapshotAt:
          toIso(live?.snapshotAt) ?? holder.positionSnapshotAt,
      };
    });

    const sides: HolderResearchMarketInput["sides"] = {
      YES: { ...candidate.market.sides.YES, openPnlUsd: null },
      NO: { ...candidate.market.sides.NO, openPnlUsd: null },
    };
    for (const side of SIDE_KEYS) {
      const pnlValues = holders
        .filter((holder) => holder.side === side)
        .map((holder) => holder.openPnlUsd)
        .filter((value): value is number => value != null);
      sides[side].openPnlUsd =
        pnlValues.length > 0
          ? pnlValues.reduce((sum, value) => sum + value, 0)
          : null;
    }

    const market = {
      ...candidate.market,
      holders,
      sides,
    };
    const withoutDigest = {
      ...candidate,
      market,
    };
    return {
      ...withoutDigest,
      inputDigest: buildHolderResearchInputDigest(withoutDigest),
    };
  });
}

function relatedPositionFromRow(
  row: HolderResearchRelatedPositionRow,
): HolderResearchRelatedPosition | null {
  const side = normalizeSide(row.side);
  const positionUsd = toNumber(row.position_usd);
  if (!side || positionUsd == null) return null;
  return {
    marketId: row.market_id,
    marketTitle: row.market_title ?? row.market_id,
    eventTitle: row.event_title,
    side,
    positionUsd,
    yesProbability: calculateYesProbability(row),
    snapshotAt: toIso(row.snapshot_at),
  };
}

export async function enrichHolderResearchHolderContext(
  client: Queryable,
  candidates: HolderResearchCandidate[],
  policy: HolderResearchPolicy,
): Promise<HolderResearchCandidate[]> {
  if (
    candidates.length === 0 ||
    policy.maxHolderContextHoldersPerCandidate <= 0 ||
    policy.maxHolderContextPositionsPerHolder <= 0
  ) {
    return candidates;
  }

  const holderIds = Array.from(
    new Set(
      candidates.flatMap((candidate) =>
        candidate.market.holders
          .slice(0, policy.maxHolderContextHoldersPerCandidate)
          .map((holder) => holder.walletId),
      ),
    ),
  );
  if (holderIds.length === 0) return candidates;

  const selectedMarketIds = Array.from(
    new Set(candidates.map((candidate) => candidate.market.marketId)),
  );
  const { rows } = await client.query<HolderResearchRelatedPositionRow>(
    `
      with input_wallets as (
        select unnest($1::uuid[]) as wallet_id
      ),
      latest_wallet_snapshots as materialized (
        select
          ws.wallet_id,
          ws.venue,
          max(ws.snapshot_at) as snapshot_at
        from wallet_position_snapshots ws
        join input_wallets input on input.wallet_id = ws.wallet_id
        where ws.snapshot_at >= now() - ($2::numeric * interval '1 hour')
        group by ws.wallet_id, ws.venue
      ),
      ranked_positions as (
        select
          ws.wallet_id::text as wallet_id,
          ws.market_id,
          um.title as market_title,
          ue.title as event_title,
          upper(coalesce(ws.outcome_side, '')) as side,
          abs(coalesce(ws.size_usd, 0))::numeric as position_usd,
          ws.snapshot_at,
          um.best_bid,
          um.best_ask,
          um.last_price,
          row_number() over (
            partition by ws.wallet_id
            order by abs(coalesce(ws.size_usd, 0)) desc, ws.market_id
          ) as position_rank
        from latest_wallet_snapshots latest
        join wallet_position_snapshots ws
          on ws.wallet_id = latest.wallet_id
         and ws.venue = latest.venue
         and ws.snapshot_at = latest.snapshot_at
        join unified_markets um on um.id = ws.market_id
        left join unified_events ue on ue.id = um.event_id
        where upper(coalesce(ws.outcome_side, '')) in ('YES', 'NO')
          and abs(coalesce(ws.size_usd, 0)) >= $3::numeric
          and not (ws.market_id = any($4::text[]))
      )
      select
        wallet_id,
        market_id,
        market_title,
        event_title,
        side,
        position_usd,
        snapshot_at,
        best_bid,
        best_ask,
        last_price
      from ranked_positions
      where position_rank <= $5::integer
      order by wallet_id, position_rank
    `,
    [
      holderIds,
      policy.candidateLookbackHours,
      policy.minHolderPositionUsd,
      selectedMarketIds,
      policy.maxHolderContextPositionsPerHolder,
    ],
  );

  const byWalletId = new Map<string, HolderResearchRelatedPosition[]>();
  for (const row of rows) {
    const related = relatedPositionFromRow(row);
    if (!related) continue;
    const list = byWalletId.get(row.wallet_id) ?? [];
    list.push(related);
    byWalletId.set(row.wallet_id, list);
  }

  return candidates.map((candidate) => {
    const holders = candidate.market.holders.map((holder) => ({
      ...holder,
      relatedOpenPositions: byWalletId.get(holder.walletId) ?? [],
    }));
    const market = { ...candidate.market, holders };
    const withoutDigest = { ...candidate, market };
    return {
      ...withoutDigest,
      inputDigest: buildHolderResearchInputDigest(withoutDigest),
    };
  });
}

export async function enrichHolderResearchMarketTypeMetrics(
  client: Queryable,
  candidates: HolderResearchCandidate[],
): Promise<HolderResearchCandidate[]> {
  if (candidates.length === 0) return candidates;

  const walletIds = Array.from(
    new Set(
      candidates.flatMap((candidate) =>
        candidate.market.holders.map((holder) => holder.walletId),
      ),
    ),
  );
  if (walletIds.length === 0) return candidates;

  let metricsByKey: Awaited<ReturnType<typeof loadWalletMarketTypeMetricsMap>>;
  try {
    metricsByKey = await loadWalletMarketTypeMetricsMap(client, {
      walletIds,
    });
  } catch (error) {
    console.warn("[holder-research] market-type metrics skipped", {
      walletCount: walletIds.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return candidates;
  }
  if (metricsByKey.size === 0) return candidates;

  return candidates.map((candidate) => {
    const marketType = classifyHolderResearchMarketType(candidate.market);
    const holders = candidate.market.holders.map((holder) => ({
      ...holder,
      marketTypeMetrics30d:
        metricsByKey.get(
          makeWalletMarketTypeMetricKey(holder.walletId, marketType),
        ) ?? null,
    }));
    const market = { ...candidate.market, holders };
    const withoutDigest = { ...candidate, market };
    return {
      ...withoutDigest,
      inputDigest: buildHolderResearchInputDigest(withoutDigest),
    };
  });
}

export function buildHolderResearchCandidatePromptJson(
  candidate: HolderResearchCandidate,
  policy?: HolderResearchPromptPolicy,
): Record<string, unknown> {
  const totalUsd =
    candidate.market.sides.YES.usd + candidate.market.sides.NO.usd;
  const actor = policy
    ? buildHolderResearchActorSummary({
        candidate,
        evidenceIds: candidate.evidence.map((evidence) => evidence.id),
        policy,
      })
    : null;
  const quality = policy
    ? buildHolderResearchQualityAssessment(candidate, policy)
    : null;
  return {
    key: candidate.key,
    inputDigest: candidate.inputDigest,
    bucket: candidate.bucket,
    score: candidate.score,
    side: candidate.side,
    reasons: candidate.reasons,
    market: {
      marketId: candidate.market.marketId,
      eventId: candidate.market.eventId,
      venue: candidate.market.venue,
      marketTitle: candidate.market.marketTitle,
      marketSlug: candidate.market.marketSlug,
      marketDescription: candidate.market.marketDescription,
      eventTitle: candidate.market.eventTitle,
      eventSlug: candidate.market.eventSlug,
      eventDescription: candidate.market.eventDescription,
      seriesKey: candidate.market.seriesKey,
      seriesTitle: candidate.market.seriesTitle,
      resolutionSource: candidate.market.resolutionSource,
      category: candidate.market.category,
      closeTime: candidate.market.closeTime,
      expirationTime: candidate.market.expirationTime,
      yesProbability: candidate.market.yesProbability,
      trackedUsd: totalUsd,
      recentActivityUsd: candidate.market.recentActivityUsd,
      recentActivityAt: candidate.market.recentActivityAt,
      crossMarketWalletCount: candidate.market.crossMarketWalletCount,
      previousNote: candidate.market.previousNote,
    },
    marketMovementContext:
      policy?.movementContextEnabled === false
        ? null
        : candidate.market.marketMovementContext,
    holderEntryContext:
      policy?.holderEntryContextEnabled === false
        ? []
        : buildHolderEntryContext(candidate),
    actor,
    quality,
    sides: candidate.market.sides,
    holders: candidate.market.holders.slice(0, 8),
    evidence: candidate.evidence,
  };
}

function thinSide(side: HolderResearchSide) {
  return {
    usd: side.usd,
    wallets: side.wallets,
    openPnlUsd: side.openPnlUsd,
    sharpHolders: side.sharpHolders,
    sharpUsd: side.sharpUsd,
    bestEdge: side.bestEdge,
    bestSampleCount: side.bestSampleCount,
  };
}

export function buildHolderResearchTriageCandidatePromptJson(
  candidate: HolderResearchCandidate,
  policy: HolderResearchPromptPolicy,
): Record<string, unknown> {
  const totalUsd =
    candidate.market.sides.YES.usd + candidate.market.sides.NO.usd;
  const actor = buildHolderResearchActorSummary({
    candidate,
    evidenceIds: candidate.evidence.map((evidence) => evidence.id),
    policy,
  });
  const quality = buildHolderResearchQualityAssessment(candidate, policy);
  return {
    key: candidate.key,
    bucket: candidate.bucket,
    score: candidate.score,
    side: candidate.side,
    direction: candidate.direction,
    signalType: candidate.signalType,
    reasons: candidate.reasons,
    market: {
      marketId: candidate.market.marketId,
      eventId: candidate.market.eventId,
      title: candidate.market.marketTitle,
      eventTitle: candidate.market.eventTitle,
      closeTime: candidate.market.closeTime,
      yesProbability: candidate.market.yesProbability,
      trackedUsd: totalUsd,
      recentActivityUsd: candidate.market.recentActivityUsd,
      recentActivityAt: candidate.market.recentActivityAt,
      previousNote: candidate.market.previousNote
        ? {
            createdAt: candidate.market.previousNote.createdAt,
            title: candidate.market.previousNote.title,
            cooldownUntil: candidate.market.previousNote.cooldownUntil,
          }
        : null,
    },
    marketMovementContext: policy.movementContextEnabled
      ? candidate.market.marketMovementContext
      : null,
    holderEntryContext: policy.holderEntryContextEnabled
      ? buildHolderEntryContext(candidate)
      : [],
    actor,
    quality,
    sides: {
      YES: thinSide(candidate.market.sides.YES),
      NO: thinSide(candidate.market.sides.NO),
    },
  };
}

export function buildHolderResearchExternalSearchInput(
  candidate: HolderResearchCandidate,
): Record<string, unknown> {
  const targetSide = candidate.side;
  const otherSide =
    targetSide === "YES" ? "NO" : targetSide === "NO" ? "YES" : null;
  const target = targetSide ? candidate.market.sides[targetSide] : null;
  const other = otherSide ? candidate.market.sides[otherSide] : null;
  const topTargetHolder = targetSide
    ? candidate.market.holders
        .filter((holder) => holder.side === targetSide)
        .sort((a, b) => b.positionUsd - a.positionUsd)[0]
    : null;

  return {
    market: {
      id: candidate.market.marketId,
      title: candidate.market.marketTitle,
      eventTitle: candidate.market.eventTitle,
      venue: candidate.market.venue,
      category: candidate.market.category,
      seriesTitle: candidate.market.seriesTitle,
      closeTime: candidate.market.closeTime,
      yesProbability: candidate.market.yesProbability,
      description:
        candidate.market.marketDescription ??
        candidate.market.eventDescription ??
        null,
      resolutionSource: candidate.market.resolutionSource,
    },
    holderSignal: {
      bucket: candidate.bucket,
      side: targetSide,
      score: candidate.score,
      reasons: candidate.reasons,
      sideUsd: target?.usd ?? null,
      sideWallets: target?.wallets ?? null,
      opposingSideUsd: other?.usd ?? null,
      opposingSideWallets: other?.wallets ?? null,
      sideOpenPnlUsd: target?.openPnlUsd ?? null,
      opposingSideOpenPnlUsd: other?.openPnlUsd ?? null,
      sideSharpHolders: target?.sharpHolders ?? null,
      sideSharpUsd: target?.sharpUsd ?? null,
      topHolderPositionUsd: topTargetHolder?.positionUsd ?? null,
      topHolderOpenPnlUsd: topTargetHolder?.openPnlUsd ?? null,
      recentActivityUsd: candidate.market.recentActivityUsd,
      recentActivityAt: candidate.market.recentActivityAt,
    },
    instruction:
      "Find public context that could explain this holder positioning. Compare dated public context with holder activity/snapshot timing. Keep the answer under 70 words. If public context came after the holder activity, say later public news may validate early positioning. If public context is missing, say public news does not explain it yet; do not accuse anyone of insider trading.",
  };
}

export function buildDeterministicHolderResearchDecision(
  candidate: HolderResearchCandidate,
  policy: HolderResearchPolicy,
): HolderResearchAgentOutputV1 {
  const status =
    candidate.score >= policy.publishMinScore &&
    candidate.bucket !== "concentration_risk" &&
    candidate.bucket !== "event_bridge"
      ? "PUBLISH"
      : candidate.score >= policy.minScore
        ? "CONTEXT"
        : "SKIP";
  const sideLabel = candidate.side ? `${candidate.side} ` : "";
  const titlePrefix =
    candidate.bucket === "sharp_minority"
      ? `Sharp minority ${sideLabel.trim()}`
      : candidate.bucket === "sharp_split"
        ? "Sharp holders on both sides"
        : candidate.bucket === "sharp_side"
          ? `Sharp ${sideLabel.trim()} holders`
          : candidate.bucket === "clean_disagreement"
            ? "Clean two-sided disagreement"
            : candidate.bucket === "recent_flow"
              ? "Recent holder flow"
              : candidate.bucket === "followup_existing"
                ? "Holder research follow-up"
                : candidate.bucket === "event_bridge"
                  ? "Cross-market holder bridge"
                  : "Holder concentration risk";
  const topEvidence = candidate.evidence.slice(0, 5);
  const totalUsd =
    candidate.market.sides.YES.usd + candidate.market.sides.NO.usd;
  const summary = `${candidate.market.marketTitle}: ${formatUsd(totalUsd)} tracked, YES ${formatUsd(candidate.market.sides.YES.usd)} / NO ${formatUsd(candidate.market.sides.NO.usd)}. ${candidate.reasons.join(", ")}.`;

  return {
    version: "holder_research_v1",
    status,
    bucket: candidate.bucket,
    confidence: clamp01(candidate.score),
    signal_type: candidate.signalType,
    direction: candidate.direction,
    headline: `${titlePrefix}: ${candidate.market.marketTitle}`.slice(0, 140),
    summary,
    rationale:
      status === "PUBLISH"
        ? "Internal holder data passes the configured exposure and quality gates."
        : "Candidate is useful context but does not clear the publish gate.",
    evidence_ids: topEvidence.map((evidence) => evidence.id),
    caveats: [
      "Holder data is snapshot-based and may lag live venue state.",
      "Resolved edge is historical holder quality, not a guarantee for this market.",
    ],
  };
}

export function buildHolderResearchNoteKey(
  candidate: HolderResearchCandidate,
): string {
  return `${candidate.key}:${shortHash(candidate.inputDigest)}`;
}

export function buildHolderResearchWalletTargets(
  candidate: HolderResearchCandidate,
  evidenceIds: string[],
  policy?: Parameters<typeof buildHolderResearchActorSummary>[0]["policy"],
): Array<{
  walletId: string;
  rank: number;
  affinityScore: number;
  meta: Record<string, unknown>;
}> {
  const holders = selectHolderResearchTargetHolders(candidate, evidenceIds);
  const actor = policy
    ? buildHolderResearchActorSummary({ candidate, evidenceIds, policy })
    : null;
  return holders.map((holder, index) => ({
    walletId: holder.walletId,
    rank: 10 + index,
    affinityScore: candidate.score,
    meta: {
      evidenceId: buildHolderEvidenceId(holder),
      actorMode: actor?.mode ?? null,
      credentialBullets:
        actor?.primaryHolder?.walletId === holder.walletId
          ? actor.credentialBullets
          : [],
      holderDescriptor: holder.label ?? "tracked wallet",
      clusterSharpHolders: actor?.cluster?.sharpHolders ?? null,
      clusterSharpUsd: actor?.cluster?.sharpUsd ?? null,
      clusterPnl30dUsd: actor?.cluster?.pnl30dUsd ?? null,
      side: holder.side,
      positionUsd: holder.positionUsd,
      openPnlUsd: holder.openPnlUsd,
      pnl30dUsd: holder.pnl30dUsd,
      resolvedWinRateEdge30d: holder.resolvedWinRateEdge30d,
      resolvedEdgeZScore30d: holder.resolvedEdgeZScore30d,
      resolvedEdgeSampleCount30d: holder.resolvedEdgeSampleCount30d,
      resolvedStakeUsd30d: holder.resolvedStakeUsd30d,
      trades30d: holder.trades30d,
      winRate30d: holder.winRate30d,
      walletKind: holder.walletKind,
      ownerAddress: holder.ownerAddress,
      mmSuspected: holder.mmSuspected,
      marketTypeMetrics30d: holder.marketTypeMetrics30d,
    },
  }));
}

function asContextHolderResearchOutput(
  output: HolderResearchAgentOutputV1,
  rationale: string,
): HolderResearchAgentOutputV1 {
  return {
    ...output,
    rationale,
    status: "CONTEXT",
  };
}

function normalizePublicContextRisk(
  value: unknown,
): HolderResearchPublicContextRisk {
  return value === "confirms_holder" ||
    value === "fully_explains_move" ||
    value === "conflicts_holder"
    ? value
    : "unknown";
}

function hasSameEventConflict(input: {
  candidate: HolderResearchCandidate;
  output: HolderResearchAgentOutputV1;
  policy: HolderResearchPolicy;
  publishedRunDecisions?: Array<{
    candidate: HolderResearchCandidate;
    output: HolderResearchAgentOutputV1;
  }>;
}): boolean {
  const eventId = input.candidate.market.eventId;
  if (!eventId) return false;
  const actionSide = candidateOutputActionSide(
    input.candidate,
    input.output,
    input.policy,
  );
  if (!actionSide) return false;
  return (input.publishedRunDecisions ?? []).some(({ candidate, output }) => {
    if (output.status !== "PUBLISH") return false;
    if (candidate.key === input.candidate.key) return false;
    if (candidate.market.eventId !== eventId) return false;
    if (candidate.market.marketId === input.candidate.market.marketId) {
      return false;
    }
    if (
      buildHolderResearchQualityAssessment(candidate, input.policy).marketType !==
      "single_game_sports"
    ) {
      return false;
    }
    return candidateOutputActionSide(candidate, output, input.policy) === actionSide;
  });
}

function candidateOutputActionSide(
  candidate: HolderResearchCandidate,
  output: HolderResearchAgentOutputV1 | null,
  policy: HolderResearchPolicy,
): HolderResearchSideKey | null {
  const walletTargets = output
    ? buildHolderResearchWalletTargets(candidate, output.evidence_ids, policy)
    : [];
  const holderSide = normalizeSide(walletTargets[0]?.meta.side);
  return candidate.side ?? holderSide;
}

export function applyHolderResearchPublishQualityGate(input: {
  candidate: HolderResearchCandidate;
  output: HolderResearchAgentOutputV1;
  policy: HolderResearchPolicy;
  publishedRunDecisions?: Array<{
    candidate: HolderResearchCandidate;
    output: HolderResearchAgentOutputV1;
  }>;
}): HolderResearchAgentOutputV1 {
  const { candidate, output } = input;
  if (output.status !== "PUBLISH") return output;

  if (output.direction === "mixed") {
    return asContextHolderResearchOutput(
      output,
      "Mixed holder reads are context-only until they name a clear side.",
    );
  }

  if (!PUBLISHABLE_HOLDER_RESEARCH_BUCKETS.has(candidate.bucket)) {
    return asContextHolderResearchOutput(
      output,
      "This holder read is useful context but not a directional publish signal.",
    );
  }

  const walletTargets = buildHolderResearchWalletTargets(
    candidate,
    output.evidence_ids,
    input.policy,
  );
  const holderSide = normalizeSide(walletTargets[0]?.meta.side);
  const actionSide = candidate.side ?? holderSide;
  if (!actionSide) {
    return asContextHolderResearchOutput(
      output,
      "No clear holder-backed side was available for publication.",
    );
  }

  if (sideDirection(actionSide) !== output.direction) {
    return asContextHolderResearchOutput(
      output,
      "The model direction did not match the holder-backed side.",
    );
  }

  if (walletTargets.length === 0) {
    return asContextHolderResearchOutput(
      output,
      "No related holder target was available for publication.",
    );
  }

  const actor = buildHolderResearchActorSummary({
    candidate,
    evidenceIds: output.evidence_ids,
    policy: input.policy,
  });
  if (actor.mode === "none" || actor.credentialBullets.length === 0) {
    return asContextHolderResearchOutput(
      output,
      "No strong holder credential was available for publication.",
    );
  }

  if (!input.policy.qualityGateEnabled) return output;

  const quality = buildHolderResearchQualityAssessment(
    candidate,
    input.policy,
    normalizePublicContextRisk(output.public_context_risk),
  );
  if (quality.publicContextRisk === "fully_explains_move") {
    return asContextHolderResearchOutput(
      output,
      "Public context fully explained the move, so the holder read is context-only.",
    );
  }
  if (quality.priceContext === "against_signal") {
    return asContextHolderResearchOutput(
      output,
      "Price moved materially against the holder side before publication.",
    );
  }
  if (
    quality.marketType === "single_game_sports" &&
    input.policy.singleGameSportsStrictMode
  ) {
    if (hasSameEventConflict(input)) {
      return asContextHolderResearchOutput(
        output,
        "Same-event sports signals were conflicting, so this is context-only.",
      );
    }
    if (
      actor.mode === "sharp_cluster" &&
      quality.actorStrength === "cluster" &&
      quality.credentialStrength === "strong"
    ) {
      return output;
    }
    if (
      actor.mode === "single_holder" &&
      quality.actorStrength === "exceptional_single" &&
      quality.credentialStrength === "strong"
    ) {
      return output;
    }
    return asContextHolderResearchOutput(
      output,
      "Single-game sports requires a sharp cluster or exceptional single holder.",
    );
  }

  return output;
}

function normalizeText(value: string | null | undefined, max: number): string {
  return (value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

export async function persistHolderResearchNotes(
  client: PoolClient,
  params: {
    runnerRunId: string;
    decisions: HolderResearchPersistDecision[];
    policy: HolderResearchPolicy;
  },
): Promise<HolderResearchPersistStats> {
  const stats: HolderResearchPersistStats = {
    considered: params.decisions.length,
    persisted: 0,
    skippedExisting: 0,
    superseded: 0,
    errors: 0,
  };

  for (const decision of params.decisions) {
    if (decision.output.status !== "PUBLISH") continue;
    const candidate = decision.candidate;
    const noteKey = buildHolderResearchNoteKey(candidate);
    const actorSummary = buildHolderResearchActorSummary({
      candidate,
      evidenceIds: decision.output.evidence_ids,
      policy: params.policy,
    });

    try {
      await client.query("begin");
      const inserted = await client.query<{ id: string }>(
        `
          insert into ai_notes (
            note_key,
            note_type,
            status,
            title,
            description,
            rationale,
            source_kind,
            source_id,
            producer_type,
            producer_run_id,
            lineage,
            signal_type,
            direction,
            confidence,
            reason_codes,
            metrics,
            model_meta
          ) values (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb
          )
          on conflict (note_key) do nothing
          returning id
        `,
        [
          noteKey,
          "signal",
          "active",
          normalizeText(decision.output.headline, 320) || "Holder signal",
          normalizeText(decision.output.summary, 1_000) || "No summary.",
          normalizeText(decision.output.rationale, 1_000) || null,
          "market",
          candidate.market.marketId,
          "holder_research",
          params.runnerRunId,
          JSON.stringify({
            candidate_key: candidate.key,
            input_digest: candidate.inputDigest,
            bucket: candidate.bucket,
            side: candidate.side,
            event_id: candidate.market.eventId,
          }),
          decision.output.signal_type,
          decision.output.direction,
          decision.output.confidence,
          JSON.stringify(candidate.reasons),
          JSON.stringify({
            score: candidate.score,
            bucket: candidate.bucket,
            side: candidate.side,
            quality: buildHolderResearchQualityAssessment(candidate, params.policy),
            market: {
              id: candidate.market.marketId,
              venue: candidate.market.venue,
              yesProbability: candidate.market.yesProbability,
              recentActivityUsd: candidate.market.recentActivityUsd,
              crossMarketWalletCount: candidate.market.crossMarketWalletCount,
            },
            sides: candidate.market.sides,
          }),
          JSON.stringify({
            ...decision.modelMeta,
            caveats: decision.output.caveats,
            primary_holder_credentials: actorSummary,
            evidence_refs: candidate.evidence.map((evidence) => ({
              evidence_id: evidence.id,
              headline: evidence.title,
              source_url: null,
              source_domain: "hunch.internal",
              published_at: null,
              confirmation: "confirmed",
              relevance: evidence.relevance,
            })),
          }),
        ],
      );

      const noteId = inserted.rows[0]?.id ?? null;
      if (!noteId) {
        stats.skippedExisting += 1;
        await client.query("rollback");
        continue;
      }

      await client.query(
        `
          insert into ai_note_targets (
            note_id,
            target_kind,
            target_id,
            is_primary,
            target_rank,
            affinity_score,
            target_meta
          ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)
          on conflict (note_id, target_kind, target_id) do nothing
        `,
        [
          noteId,
          "market",
          candidate.market.marketId,
          true,
          0,
          candidate.score,
          JSON.stringify({
            marketTitle: candidate.market.marketTitle,
            venue: candidate.market.venue,
            bucket: candidate.bucket,
            side: candidate.side,
          }),
        ],
      );

      if (candidate.market.eventId) {
        await client.query(
          `
            insert into ai_note_targets (
              note_id,
              target_kind,
              target_id,
              is_primary,
              target_rank,
              affinity_score,
              target_meta
            ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)
            on conflict (note_id, target_kind, target_id) do nothing
          `,
          [
            noteId,
            "event",
            candidate.market.eventId,
            false,
            5,
            null,
            JSON.stringify({ eventTitle: candidate.market.eventTitle }),
          ],
        );
      }

      for (const target of buildHolderResearchWalletTargets(
        candidate,
        decision.output.evidence_ids,
        params.policy,
      )) {
        await client.query(
          `
            insert into ai_note_targets (
              note_id,
              target_kind,
              target_id,
              is_primary,
              target_rank,
              affinity_score,
              target_meta
            ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)
            on conflict (note_id, target_kind, target_id) do nothing
          `,
          [
            noteId,
            "wallet",
            target.walletId,
            false,
            target.rank,
            target.affinityScore,
            JSON.stringify(target.meta),
          ],
        );
      }

      for (const evidence of candidate.evidence) {
        if (!decision.output.evidence_ids.includes(evidence.id)) continue;
        await client.query(
          `
            insert into ai_note_evidence (note_id, evidence_id, relevance)
            values ($1, $2, $3)
            on conflict (note_id, evidence_id) do nothing
          `,
          [noteId, evidence.id, evidence.relevance],
        );
      }

      const previous = await client.query<{ id: string }>(
        `
          select n.id
          from ai_notes n
          join ai_note_targets t
            on t.note_id = n.id
           and t.is_primary = true
          where n.note_type = 'signal'
            and n.producer_type = 'holder_research'
            and n.status = 'active'
            and t.target_kind = 'market'
            and t.target_id = $1
            and n.id <> $2
          order by n.created_at desc
          limit 1
        `,
        [candidate.market.marketId, noteId],
      );

      const previousId = previous.rows[0]?.id ?? null;
      if (previousId) {
        await client.query(
          `update ai_notes set status = 'superseded', updated_at = now() where id = $1`,
          [previousId],
        );
        await client.query(
          `update ai_notes set supersedes_note_id = $1, updated_at = now() where id = $2 and supersedes_note_id is null`,
          [previousId, noteId],
        );
        stats.superseded += 1;
      }

      await client.query("commit");
      stats.persisted += 1;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      stats.errors += 1;
      console.warn("[holder-research] failed to persist note", {
        error: error instanceof Error ? error.message : String(error),
        candidateKey: decision.candidate.key,
      });
    }
  }

  return stats;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finalYesProbabilityFromResolvedRow(
  row: Pick<
    HolderResearchResolvedNoteRow,
    "resolved_outcome" | "resolved_outcome_pct" | "best_bid" | "best_ask" | "last_price"
  >,
): number | null {
  const resolved = normalizeSide(row.resolved_outcome);
  if (resolved === "YES") return 1;
  if (resolved === "NO") return 0;
  const pct = toNumber(row.resolved_outcome_pct);
  if (pct != null) return clamp01(pct / 10_000);
  return terminalYesProbabilityFromPrice(row);
}

function noteYesProbability(metrics: unknown): number | null {
  const root = objectRecord(metrics);
  const market = objectRecord(root.market);
  return toNumber(market.yesProbability);
}

function evaluationSide(direction: string | null): HolderResearchSideKey | null {
  if (direction === "up") return "YES";
  if (direction === "down") return "NO";
  return null;
}

function evaluateResolvedSignalRow(
  row: HolderResearchResolvedNoteRow,
): Record<string, unknown> {
  const modelMeta = objectRecord(row.model_meta);
  const actor = objectRecord(modelMeta.primary_holder_credentials);
  const side = evaluationSide(row.direction);
  const noteYes = noteYesProbability(row.metrics);
  const finalYes = finalYesProbabilityFromResolvedRow(row);
  const priceDelta = noteYes != null && finalYes != null ? finalYes - noteYes : null;
  const sideAdjustedDelta =
    priceDelta != null && side != null
      ? side === "YES"
        ? priceDelta
        : -priceDelta
      : null;
  const outcome =
    side == null || finalYes == null
      ? "unknown"
      : side === "YES"
        ? finalYes >= 0.5
          ? "correct"
          : "wrong"
        : finalYes <= 0.5
          ? "correct"
          : "wrong";
  const closeMs = toIso(row.close_time)
    ? new Date(toIso(row.close_time) as string).getTime()
    : null;
  const createdMs = new Date(toIso(row.created_at) ?? Date.now()).getTime();
  const hoursToCloseAtNote =
    closeMs != null && Number.isFinite(createdMs)
      ? (closeMs - createdMs) / 3_600_000
      : null;
  const text = buildMarketTypeText({
    category: row.category,
    eventTitle: row.event_title,
    marketTitle: row.market_title,
  });

  return {
    version: 1,
    evaluatedAt: new Date().toISOString(),
    outcome,
    signalSide: side,
    direction: row.direction,
    confidence: toNumber(row.confidence),
    marketId: row.market_id,
    marketType: classifyMarketTypeFromText(text, hoursToCloseAtNote),
    hoursToCloseAtNote,
    noteYesProbability: noteYes,
    finalYesProbability: finalYes,
    priceDelta,
    sideAdjustedPriceDelta: sideAdjustedDelta,
    resolvedOutcome: normalizeSide(row.resolved_outcome),
    resolvedOutcomePct: toNumber(row.resolved_outcome_pct),
    acceptingOrders: row.accepting_orders,
    actorMode: typeof actor.mode === "string" ? actor.mode : null,
    primaryHolderPositionUsd: toNumber(
      objectRecord(actor.primaryHolder).positionUsd,
    ),
    primaryHolderPnl30dUsd: toNumber(objectRecord(actor.primaryHolder).pnl30dUsd),
    primaryHolderOpenPnlUsd: toNumber(
      objectRecord(actor.primaryHolder).openPnlUsd,
    ),
  };
}

function stableEvaluationString(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .filter(([key]) => key !== "evaluatedAt")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function hasSameResolvedEvaluation(
  metrics: unknown,
  evaluation: Record<string, unknown>,
): boolean {
  const previous = objectRecord(objectRecord(metrics).resolvedEvaluation);
  if (Object.keys(previous).length === 0) return false;
  return stableEvaluationString(previous) === stableEvaluationString(evaluation);
}

export async function evaluateResolvedHolderResearchNotes(
  client: Queryable,
  policy: HolderResearchPolicy,
): Promise<HolderResearchResolvedEvaluationStats> {
  const stats: HolderResearchResolvedEvaluationStats = {
    considered: 0,
    evaluated: 0,
    correct: 0,
    wrong: 0,
    unknown: 0,
    errors: 0,
  };
  if (!policy.resolvedEvaluationEnabled) return stats;

  const acceptingSql = buildWalletIntelAcceptingOrdersSql({
    marketAlias: "m",
    eventAlias: "e",
  });
  const { rows } = await client.query<HolderResearchResolvedNoteRow>(
    `
      select
        n.id as note_id,
        n.direction,
        n.confidence,
        n.created_at,
        n.metrics,
        n.model_meta,
        m.id as market_id,
        m.title as market_title,
        e.title as event_title,
        coalesce(m.category, e.category) as category,
        m.close_time,
        m.expiration_time,
        m.best_bid,
        m.best_ask,
        m.last_price,
        m.resolved_outcome,
        m.resolved_outcome_pct::text as resolved_outcome_pct,
        ${acceptingSql} as accepting_orders
      from ai_notes n
      join ai_note_targets t
        on t.note_id = n.id
       and t.target_kind = 'market'
       and t.is_primary = true
      join unified_markets m on m.id = t.target_id
      left join unified_events e on e.id = m.event_id
      where n.note_type = 'signal'
        and n.producer_type = 'holder_research'
        and n.created_at >= now() - ($1::numeric * interval '1 hour')
        and (
          not (coalesce(n.metrics, '{}'::jsonb) ? 'resolvedEvaluation')
          or (
            n.metrics #>> '{resolvedEvaluation,outcome}' = 'unknown'
            and n.updated_at <= now() - interval '24 hours'
          )
        )
        and (
          m.resolved_outcome is not null
          or m.resolved_outcome_pct is not null
          or not (${acceptingSql})
        )
      order by n.created_at desc, n.id desc
      limit 500
    `,
    [policy.resolvedEvaluationLookbackHours],
  );
  stats.considered = rows.length;

  for (const row of rows) {
    const evaluation = evaluateResolvedSignalRow(row);
    const outcome = evaluation.outcome;
    if (outcome === "correct") stats.correct += 1;
    else if (outcome === "wrong") stats.wrong += 1;
    else stats.unknown += 1;
    if (hasSameResolvedEvaluation(row.metrics, evaluation)) continue;
    try {
      const result = await client.query(
        `
          update ai_notes
          set
            metrics = jsonb_set(
              coalesce(metrics, '{}'::jsonb),
              '{resolvedEvaluation}',
              $2::jsonb,
              true
            ),
            updated_at = now()
          where id = $1::uuid
        `,
        [row.note_id, JSON.stringify(evaluation)],
      );
      const rowCount =
        typeof result.rowCount === "number" ? result.rowCount : 1;
      if (rowCount > 0) stats.evaluated += 1;
    } catch {
      stats.errors += 1;
    }
  }

  return stats;
}

export async function loadHolderResearchCalibrationMemo(
  client: Queryable,
  policy: HolderResearchPolicy,
): Promise<string[]> {
  if (!policy.calibrationMemoEnabled) return [];
  const { rows } = await client.query<{
    outcome: string | null;
    market_type: string | null;
    actor_mode: string | null;
    primary_holder_pnl_30d_usd: string | number | null;
    primary_holder_position_usd: string | number | null;
  }>(
    `
      select
        n.metrics #>> '{resolvedEvaluation,outcome}' as outcome,
        n.metrics #>> '{resolvedEvaluation,marketType}' as market_type,
        n.metrics #>> '{resolvedEvaluation,actorMode}' as actor_mode,
        n.metrics #>> '{resolvedEvaluation,primaryHolderPnl30dUsd}' as primary_holder_pnl_30d_usd,
        n.metrics #>> '{resolvedEvaluation,primaryHolderPositionUsd}' as primary_holder_position_usd
      from ai_notes n
      where n.note_type = 'signal'
        and n.producer_type = 'holder_research'
        and n.metrics ? 'resolvedEvaluation'
        and n.created_at >= now() - ($1::numeric * interval '1 hour')
      order by n.updated_at desc, n.created_at desc
      limit 50
    `,
    [policy.resolvedEvaluationLookbackHours],
  );

  const failedSportsSingles = rows.filter(
    (row) =>
      row.outcome === "wrong" &&
      row.market_type === "single_game_sports" &&
      row.actor_mode === "single_holder",
  );
  const successfulSportsStrong = rows.filter(
    (row) =>
      row.outcome === "correct" &&
      row.market_type === "single_game_sports" &&
      (row.actor_mode === "sharp_cluster" ||
        (row.actor_mode === "single_holder" &&
          (toNumber(row.primary_holder_pnl_30d_usd) ?? 0) > 0 &&
          (toNumber(row.primary_holder_position_usd) ?? 0) >=
            policy.singleGameSportsMinHolderUsd)),
  );
  const memo: string[] = [];
  if (failedSportsSingles.length > 0) {
    memo.push(
      `Recent failed pattern: ${failedSportsSingles.length} wrong single-game sports signals were single-holder reads; downgrade weak or public-favorite sports singles.`,
    );
  }
  if (successfulSportsStrong.length > 0) {
    memo.push(
      `Recent successful pattern: ${successfulSportsStrong.length} single-game sports signals worked when they had a sharp cluster or an exceptional profitable holder.`,
    );
  }
  const nonSportsCorrect = rows.filter(
    (row) =>
      row.outcome === "correct" &&
      row.market_type !== "single_game_sports",
  );
  if (nonSportsCorrect.length > 0) {
    memo.push(
      `Recent non-sports wins: ${nonSportsCorrect.length} resolved notes were correct; do not apply sports-only caution to politics, crypto, or long-dated outrights.`,
    );
  }
  return memo.slice(0, 4);
}
