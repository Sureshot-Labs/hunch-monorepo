import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";
import { PublicKey } from "@solana/web3.js";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";

import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import {
  collectMarketRefreshMarketIdsFromPayload,
  requestMarketRefreshForMarketRefs,
} from "../lib/market-refresh.js";
import { getRedisStatus } from "../redis.js";
import {
  derivePolymarketFunders,
  inspectSafeWallet,
} from "../services/polymarket-funder.js";
import {
  buildFeedCandidateEventSearchFilter,
  buildFeedSearchResultWindow,
  type FeedInputs,
} from "../repos/unified-read.js";
import type { PgParams } from "../server-types.js";
import {
  compareWalletActivitySummaryStats,
  fetchWalletActivitySignalPageLabels,
  fetchWalletActivitySignalSummary,
  fetchWalletActivitySignalRowsFast,
  type WalletActivitySignalPageLabelFlags,
  type WalletActivitySignalSummary,
  fetchWalletActivitySummaryStats,
  fetchWalletActivityTopChanges,
  fetchWalletActivitySummaries,
  type WalletActivitySignalRow,
  type WalletActivitySummary,
  type WalletActivitySummaryStats,
  type WalletActivitySummarySortMode,
  type WalletActivityTopChange,
} from "../services/wallet-activity-summary.js";
import {
  buildEmptyWalletActivitySparkline,
  fetchWalletActivitySparklines,
  fetchWalletPerformanceSparklines,
  fetchWalletPerformanceSeries,
  fetchWalletPortfolioPnlSeries,
  loadWalletPortfolioPerformanceMap,
  type WalletSparklineMetric,
  type WalletActivitySparkline,
  type WalletPortfolioPerformance,
} from "../services/wallet-intel-series.js";
import {
  loadWalletCategoryMix,
  loadWalletEntryBracketStats,
  type WalletEntryBracketKey,
} from "../services/wallet-profile-features.js";
import {
  resolveSignalWindowHours,
  resolveWalletIntelAttributionPolicy,
  resolveWalletIntelRefreshPolicy,
  resolveWalletIntelSignalsPolicy,
} from "../services/runtime-policies.js";
import {
  evaluateSignalMarketWindow,
  mergeWalletIdsForScope,
} from "../services/wallet-intel-filters.js";
import {
  normalizeOutcomeSideForApi,
  parseMarketOutcomes,
} from "../services/wallet-intel-helpers.js";
import {
  buildWalletIntelAcceptingOrdersSql,
  buildSnapshotDeltaTrackableActivitySql,
  buildWalletIntelTrackableMarketSql,
} from "../services/wallet-intel-market-eligibility.js";
import { classifyMarketType } from "../services/market-type-classifier.js";
import {
  loadWalletMarketTypeMetricsMap,
  makeWalletMarketTypeMetricKey,
} from "../services/wallet-market-type-metrics.js";
import {
  aggregateWalletMetricsFilterSql,
  aggregateWalletMetricsPreferenceSql,
} from "../services/wallet-metrics-constants.js";
import { loadWalletOpenPositionStatsPreferRollupMap } from "../services/wallet-open-position-stats.js";
import {
  extractWalletIdentityDisplayFields,
} from "../services/wallet-identity-names.js";
import {
  loadLatestWalletPositionNowMap,
  loadWalletPositionApproxMetrics,
  type WalletPositionNow,
} from "../services/wallet-position-approx.js";
import { makeWalletPositionLedgerKey } from "../services/wallet-position-ledger.js";
import {
  buildWalletMmDiagnostics,
  buildWalletMmSuspectedSql,
  type WalletMmDiagnostics,
} from "../services/wallet-intel-mm.js";
import {
  buildSignalPresentation,
  buildWalletAttributionMap,
  normalizeAttributionLabelFilters,
  normalizeAttributionPrimaryFilters,
  walletMatchesFilters,
  type WalletAttribution,
  type WalletAttributionLabelKey,
  type WalletAttributionPrimaryKey,
  type WalletSignalSeverity,
} from "../services/wallet-attribution.js";
import {
  eventWalletPositioningParamsSchema,
  marketWalletActivityParamsSchema,
  marketWalletActivityQuerySchema,
  marketWalletPositioningParamsSchema,
  walletActivityQuerySchema,
  walletActivitySignalsQuerySchema,
  walletActivitySummaryQuerySchema,
  walletActivitySummaryStatsQuerySchema,
  walletFollowBodySchema,
  walletFollowChainQuerySchema,
  walletFollowPatchBodySchema,
  walletFollowParamsSchema,
  walletFollowingQuerySchema,
  walletPrivateMetaPatchBodySchema,
  walletPrivateNoteBodySchema,
  walletPrivateNoteParamsSchema,
  walletPositionHistoryQuerySchema,
  walletPositioningQuerySchema,
  walletPositionsQuerySchema,
  walletProfileParamsSchema,
  walletProfileQuerySchema,
  walletResolverParamsSchema,
  walletResolverQuerySchema,
  walletSeriesQuerySchema,
  walletWhalesQuerySchema,
} from "../schemas/wallet-intel.js";

type WalletRow = {
  id: string;
  address: string;
  chain: string;
  label: string | null;
  metadata?: unknown | null;
  is_system_flagged: boolean;
  first_seen_at: Date;
  last_seen_at: Date;
};

type WalletResolveRow = WalletRow & {
  has_venue: boolean | null;
  exposure_usd: string | null;
  last_activity_at: Date | null;
  metrics_volume_30d: string | null;
  metrics_trades_30d: number | null;
};

type WalletOnchainStateRow = {
  wallet_id: string;
  wallet_kind: string | null;
  owner_address: string | null;
  owner_wallet_id: string | null;
  wallet_balances: unknown | null;
  owner_balances: unknown | null;
  wallet_usd_like_balance: string | null;
  owner_usd_like_balance: string | null;
  balance_as_of: Date | null;
  identity_resolved_at: Date | null;
};

type WalletOnchainIdentityFields = {
  walletKind: string | null;
  ownerAddress: string | null;
  ownerWalletId: string | null;
  identityGroupKey: string;
  walletBalances: unknown | null;
  ownerBalances: unknown | null;
  walletUsdLikeBalance: number | null;
  ownerUsdLikeBalance: number | null;
  balanceAsOf: string | null;
  identityResolvedAt: string | null;
};

type WalletTagRow = {
  slug: string;
  label: string;
  tag_type: string;
  is_system: boolean;
};

type WalletPrivateNoteRow = {
  id: string;
  note: string;
  created_at: Date;
  updated_at: Date;
};

type WalletLabelColor = "orange" | "cyan" | "green" | "gold" | "pink";

type WalletPrivateMetaRow = {
  followed: boolean;
  user_name: string | null;
  user_label: string | null;
  user_label_color: WalletLabelColor | null;
};

function buildHiddenOwnPositionSnapshotSuppressionSql(inputs: {
  snapshotAlias: string;
  walletAlias: string;
}): string {
  const { snapshotAlias, walletAlias } = inputs;
  return `
    not exists (
      select 1
      from positions hp
      where hp.position_scope = 'own'
        and coalesce(hp.is_hidden, false) = true
        and hp.venue = ${snapshotAlias}.venue
        and hp.token_id = ${snapshotAlias}.metadata->>'tokenId'
        and hp.wallet_address is not null
        and btrim(hp.wallet_address) <> ''
        and (
          (
            ${walletAlias}.chain = 'solana'
            and hp.wallet_address = ${walletAlias}.address
          )
          or (
            ${walletAlias}.chain <> 'solana'
            and lower(hp.wallet_address) = lower(${walletAlias}.address)
          )
        )
    )
  `;
}

type WalletMetricsRow = {
  period: string;
  as_of: Date;
  trades_count: number | null;
  volume_usd: string | null;
  pnl_usd: string | null;
  roi: string | null;
  win_rate: string | null;
  resolved_edge_sample_count?: number | null;
  resolved_actual_win_rate?: string | null;
  resolved_expected_win_rate?: string | null;
  resolved_win_rate_edge?: string | null;
  resolved_edge_z_score?: string | null;
  resolved_brier_score?: string | null;
  resolved_stake_weighted_edge?: string | null;
  resolved_stake_usd?: string | null;
  avg_hold_hours: string | null;
  last_trade_at: Date | null;
  winning_count?: number | null;
  losing_count?: number | null;
  resolved_count?: number | null;
};

type WalletMetricsResponse = {
  period: string;
  asOf: Date;
  tradesCount: number | null;
  volumeUsd: number | null;
  pnlUsd: number | null;
  roi: number | null;
  winRate: number | null;
  resolvedEdgeSampleCount: number | null;
  resolvedActualWinRate: number | null;
  resolvedExpectedWinRate: number | null;
  resolvedWinRateEdge: number | null;
  resolvedEdgeZScore: number | null;
  resolvedBrierScore: number | null;
  resolvedStakeWeightedEdge: number | null;
  resolvedStakeUsd: number | null;
  avgHoldHours: number | null;
  lastTradeAt: Date | null;
  winningCount: number | null;
  losingCount: number | null;
  resolvedCount: number | null;
};

type WalletResolvedTradeStats = {
  walletId: string;
  resolvedCount: number;
  winningCount: number;
  losingCount: number;
  winRate: number | null;
};

type SerializedWalletMetricsHolder<
  T extends { metrics: WalletMetricsRow | null },
> = Omit<T, "metrics"> & {
  metrics: WalletMetricsResponse | null;
};

export type WalletTopLabelVariant =
  | "hot-streak"
  | "trending-trader"
  | "rising-star"
  | "market-mover";

export type WalletHeadlineTag = {
  key: WalletAttributionLabelKey;
  label: string;
  source: "secondary" | "supporting";
};

export type WalletPrimaryLabelKey =
  | WalletAttributionLabelKey
  | "potential_insider"
  | "bot";

export type WalletPresentationLabel = {
  key: WalletPrimaryLabelKey | WalletAttributionLabelKey;
  label: string;
};

export type WalletPresentationBadgeKey =
  | "whale"
  | "unusual_activity"
  | "hot_streak";

export type WalletPresentationBadge = {
  key: WalletPresentationBadgeKey;
  label: string;
};

export type WalletActivitySummaryHeroStats = {
  totalWallets: number;
  trackedWallets: number | null;
  totalPnl30d: number | null;
  trackedPnl30d: number | null;
  asOf: Date;
};

type WalletActivityRouteRow = {
  wallet_id: string;
  address: string;
  chain: string;
  label: string | null;
  user_name: string | null;
  user_label: string | null;
  user_label_color: WalletLabelColor | null;
  wallet_metadata: unknown | null;
  profile_label: string | null;
  venue: string;
  market_id: string;
  market_title: string | null;
  outcomes: string | null;
  market_image: string | null;
  market_icon: string | null;
  event_id: string | null;
  event_title: string | null;
  event_image: string | null;
  event_icon: string | null;
  category: string | null;
  event_category: string | null;
  series_key: string | null;
  series_title: string | null;
  best_bid: string | null;
  best_ask: string | null;
  last_price: string | null;
  market_status: string | null;
  close_time: Date | null;
  expiration_time: Date | null;
  resolved_outcome: string | null;
  accepting_orders: boolean | null;
  outcome_side: string | null;
  action: string | null;
  delta_shares: string | null;
  size_usd: string | null;
  price: string | null;
  activity_type: string;
  source: string | null;
  occurred_at: Date;
  metadata: unknown;
};

type WalletPositionRouteRow = {
  wallet_id: string;
  address: string;
  chain: string;
  label: string | null;
  user_name: string | null;
  user_label: string | null;
  user_label_color: WalletLabelColor | null;
  wallet_metadata: unknown | null;
  profile_label: string | null;
  venue: string;
  market_id: string;
  market_title: string | null;
  outcomes: string | null;
  market_image: string | null;
  market_icon: string | null;
  event_id: string | null;
  event_title: string | null;
  event_image: string | null;
  event_icon: string | null;
  market_status: string | null;
  close_time: Date | null;
  expiration_time: Date | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | null;
  accepting_orders: boolean | null;
  best_bid: string | null;
  best_ask: string | null;
  last_price: string | null;
  outcome_side: string | null;
  shares: string | null;
  size_usd: string | null;
  price: string | null;
  snapshot_at: Date;
  metadata: unknown;
};

type WalletPositionBaseRouteItem = {
  walletId: string;
  address: string;
  chain: string;
  label: string | null;
  userName: string | null;
  userLabel: string | null;
  userLabelColor: WalletLabelColor | null;
  identityDisplayName: string | null;
  identityDisplayNameSource: string | null;
  identityProfileUrl: string | null;
  profileLabel: string | null;
  venue: string;
  marketId: string;
  marketTitle: string | null;
  outcomes: string[] | null;
  marketImage: string | null;
  marketIcon: string | null;
  eventId: string | null;
  eventTitle: string | null;
  eventImage: string | null;
  eventIcon: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  marketStatus: string | null;
  closeTime: string | null;
  expirationTime: string | null;
  resolvedOutcome: string | null;
  resolvedOutcomePct: number | null;
  acceptingOrders: boolean | null;
  outcomeSide: string | null;
  shares: number | null;
  sizeUsd: number | null;
  price: number | null;
  snapshotAt: Date;
  metadata: unknown;
};

type WhaleMarketRow = {
  wallet_id: string;
  market_id: string;
  market_title: string | null;
  outcomes: string | null;
  event_id: string | null;
  event_title: string | null;
  venue: string;
  market_status: string | null;
  close_time: Date | null;
  expiration_time: Date | null;
  resolved_outcome: string | null;
  activity_count: number;
  volume_usd: string | null;
  avg_price: string | null;
  best_bid: string | null;
  best_ask: string | null;
  last_price: string | null;
  position_side: string | null;
  has_yes_position: boolean;
  has_no_position: boolean;
  position_shares: string | null;
  position_value_usd: string | null;
  position_price: string | null;
  yes_position_shares: string | null;
  yes_position_value_usd: string | null;
  yes_position_price: string | null;
  no_position_shares: string | null;
  no_position_value_usd: string | null;
  no_position_price: string | null;
  last_activity_at: Date | null;
};

type WhaleMarketItem = {
  marketId: string;
  marketTitle: string | null;
  outcomes: string[] | null;
  eventId: string | null;
  eventTitle: string | null;
  venue: string;
  activityCount: number;
  volumeUsd: number | null;
  avgPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  lastYesPrice: number | null;
  marketStatus: string | null;
  closeTime: Date | null;
  expirationTime: Date | null;
  resolvedOutcome: string | null;
  positionSide: string | null;
  isTwoSided: boolean;
  positionShares: number | null;
  positionValueUsd: number | null;
  positionPrice: number | null;
  yesPositionShares: number | null;
  yesPositionValueUsd: number | null;
  yesPositionPrice: number | null;
  noPositionShares: number | null;
  noPositionValueUsd: number | null;
  noPositionPrice: number | null;
  lastActivityAt: Date | null;
};

type WhaleWalletItem = {
  walletId: string;
  address: string;
  chain: string;
  label: string | null;
  userName: string | null;
  userLabel: string | null;
  userLabelColor: WalletLabelColor | null;
  identityDisplayName: string | null;
  identityDisplayNameSource: string | null;
  identityProfileUrl: string | null;
  followersCount: number | null;
  isSystemFlagged: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  isFollowed: boolean;
  tags: WalletTagRow[];
  metrics: WalletMetricsRow | null;
  portfolioPerformance30d: WalletPortfolioPerformance | null;
  lastActivityAt: Date | null;
  activityKind: "mixed" | "trade" | "holder" | null;
  trackedExposureUsd: number | null;
  trackedHedgedNotionalUsd: number | null;
  trackedNetImbalanceUsd: number | null;
  trackedHedgeRatio: number | null;
  trackedTwoSidedMarkets: number | null;
  mmDiagnostics: WalletMmDiagnostics | null;
  approxPnlUsd: number | null;
  approxPnlPeriod: "30d";
  inferredWinRate: number | null;
  inferredResolvedCount: number | null;
  isSafe: boolean;
  walletKind: string | null;
  ownerAddress: string | null;
  ownerLabel: string | null;
  ownerWalletId: string | null;
  identityGroupKey: string;
  walletBalances: unknown | null;
  ownerBalances: unknown | null;
  walletUsdLikeBalance: number | null;
  ownerUsdLikeBalance: number | null;
  balanceAsOf: string | null;
  identityResolvedAt: string | null;
  profile: unknown | null;
  profileUpdatedAt: Date | null;
  windowHours: number | null;
  netChangeUsd: number | null;
  netChangeYesUsd: number | null;
  netChangeNoUsd: number | null;
  countsNew: number | null;
  countsExit: number | null;
  countsIncrease: number | null;
  countsReduce: number | null;
  countsFlip: number | null;
  unusualScore: number | null;
  unusualTier: WalletActivitySummary["unusualTier"];
  topChanges: WalletActivityTopChange[];
  topMarkets: WhaleMarketItem[];
  sparkline?: WalletActivitySparkline;
  attribution?: WalletAttribution;
  topLabelVariant: WalletTopLabelVariant | null;
  headlineTag: WalletHeadlineTag | null;
  primaryLabel: WalletPresentationLabel | null;
  secondaryLabels: WalletPresentationLabel[];
  badges: WalletPresentationBadge[];
  avgTradeSizeUsd: number | null;
};

type WhaleProfileRow = {
  profile: unknown | null;
  profile_updated_at: Date | null;
};

type WhaleSelectorRow = WalletRow &
  WhaleProfileRow & {
    is_followed: boolean;
    tags: WalletTagRow[] | null;
    metrics: WalletMetricsRow | null;
    last_activity_at: Date | null;
    has_trade_activity: boolean | null;
    has_holder_activity: boolean | null;
    metrics_volume: string | null;
    metrics_pnl: string | null;
    metrics_roi: string | null;
    metrics_trades: number | null;
    metrics_resolved_edge_sample_count: number | null;
    metrics_resolved_actual_win_rate: string | null;
    metrics_resolved_expected_win_rate: string | null;
    metrics_resolved_win_rate_edge: string | null;
    metrics_resolved_edge_z_score: string | null;
    metrics_resolved_brier_score: string | null;
    metrics_resolved_stake_weighted_edge: string | null;
    metrics_resolved_stake_usd: string | null;
    exposure_usd: string | null;
    hedged_notional_usd: string | null;
    net_imbalance_usd: string | null;
    hedge_ratio: string | null;
    two_sided_markets: number | null;
    whale_score: string | null;
    is_safe: boolean;
    owner_address: string | null;
    owner_label: string | null;
    owner_wallet_id: string | null;
    inferred_wins: number | null;
    inferred_total: number | null;
    user_name: string | null;
    user_label: string | null;
    user_label_color: WalletLabelColor | null;
  };

type WhaleSelectorSlimRow = WalletRow & {
  last_activity_at: Date | null;
  has_trade_activity: boolean | null;
  has_holder_activity: boolean | null;
  metrics_volume: string | null;
  metrics_pnl: string | null;
  metrics_roi: string | null;
  metrics_trades: number | null;
  metrics_win_rate: string | null;
  metrics_resolved_edge_sample_count: number | null;
  metrics_resolved_actual_win_rate: string | null;
  metrics_resolved_expected_win_rate: string | null;
  metrics_resolved_win_rate_edge: string | null;
  metrics_resolved_edge_z_score: string | null;
  metrics_resolved_brier_score: string | null;
  metrics_resolved_stake_weighted_edge: string | null;
  metrics_resolved_stake_usd: string | null;
  exposure_usd: string | null;
  hedged_notional_usd: string | null;
  net_imbalance_usd: string | null;
  hedge_ratio: string | null;
  two_sided_markets: number | null;
  whale_score: string | null;
  is_safe: boolean;
  owner_address: string | null;
  inferred_wins: number | null;
  inferred_total: number | null;
  user_name: string | null;
  user_label_color: WalletLabelColor | null;
};

type CandidateWalletRow = WalletRow &
  WhaleProfileRow & {
    user_name: string | null;
    user_label: string | null;
    user_label_color: WalletLabelColor | null;
    tags: WalletTagRow[] | null;
    metrics: WalletMetricsRow | null;
  };

type WhalePageMetadataRow = CandidateWalletRow & {
  is_followed: boolean;
  owner_address: string | null;
  owner_label: string | null;
  owner_wallet_id: string | null;
};

type WalletActivityStateRow = {
  wallet_id: string;
  last_activity_at: Date | null;
  has_trade_activity: boolean | null;
  has_holder_activity: boolean | null;
};

type WalletAttributionFilterRow = {
  id: string;
  tags: WalletTagRow[] | null;
};

type WalletActivitySummaryItem = {
  walletId: string;
  address: string;
  chain: string;
  label: string | null;
  userName: string | null;
  userLabel: string | null;
  userLabelColor: WalletLabelColor | null;
  identityDisplayName: string | null;
  identityDisplayNameSource: string | null;
  identityProfileUrl: string | null;
  followersCount: number | null;
  isSystemFlagged: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  tags: WalletTagRow[];
  metrics: WalletMetricsRow | null;
  portfolioPerformance30d: WalletPortfolioPerformance | null;
  inferredWinRate: number | null;
  inferredResolvedCount: number | null;
  profile: unknown | null;
  profileUpdatedAt: Date | null;
  windowHours: number;
  lastActivityAt: Date | null;
  netChangeUsd: number;
  netChangeYesUsd: number;
  netChangeNoUsd: number;
  countsNew: number;
  countsExit: number;
  countsIncrease: number;
  countsReduce: number;
  countsFlip: number;
  unusualScore: number | null;
  unusualTier: WalletActivitySummary["unusualTier"];
  topChanges: WalletActivityTopChange[];
  sparkline?: WalletActivitySparkline;
  attribution?: WalletAttribution;
  topLabelVariant: WalletTopLabelVariant | null;
  headlineTag: WalletHeadlineTag | null;
  primaryLabel: WalletPresentationLabel | null;
  secondaryLabels: WalletPresentationLabel[];
  badges: WalletPresentationBadge[];
  avgTradeSizeUsd: number | null;
  trackedExposureUsd: number | null;
  openPositionsCount: number | null;
  openMarketsCount: number | null;
  avgOpenPositionSizeUsd: number | null;
  avgOpenEntryPrice: number | null;
  avgOpenEntryApprox: boolean | null;
};

type WalletActivitySignalItem = {
  walletId: string;
  address: string;
  chain: string;
  label: string | null;
  userName: string | null;
  userLabel: string | null;
  userLabelColor: WalletLabelColor | null;
  identityDisplayName: string | null;
  identityDisplayNameSource: string | null;
  identityProfileUrl: string | null;
  isSystemFlagged: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  tags: WalletTagRow[];
  metrics: WalletMetricsRow | null;
  inferredWinRate: number | null;
  inferredResolvedCount: number | null;
  profile: unknown | null;
  profileUpdatedAt: Date | null;
  marketId: string;
  marketTitle: string | null;
  outcomes: string[] | null;
  marketImage: string | null;
  marketIcon: string | null;
  eventId: string | null;
  eventTitle: string | null;
  eventImage: string | null;
  eventIcon: string | null;
  venue: string;
  marketStatus: string | null;
  closeTime: Date | null;
  expirationTime: Date | null;
  resolvedOutcome: string | null;
  acceptingOrders: boolean | null;
  category: string | null;
  action: WalletActivityTopChange["action"];
  positionSide: string | null;
  deltaShares: number | null;
  deltaUsd: number | null;
  stakeUsd: number | null;
  odds: number | null;
  potentialPayoutUsd: number | null;
  idleDays: number | null;
  priorDistinctMarkets: number | null;
  signalScore: number | null;
  signalType: WalletActivityTopChange["signalType"];
  lateBucket: WalletActivityTopChange["lateBucket"];
  labels: string[];
  signalLabels: string[];
  reasonCodes: string[];
  displayReasons: string[];
  severity: WalletSignalSeverity;
  mmDiagnostics: WalletMmDiagnostics | null;
  occurredAt: Date;
  positionNow?: {
    approxEntryPrice: number | null;
    observedPrice: number | null;
    currentPrice: number | null;
    openPnlUsd: number | null;
    realizedPnlUsd: number | null;
    totalPnlUsd: number | null;
    approxPnlUsd: number | null;
    approxReliable: boolean;
    approxPnlSource: "activity" | "snapshot" | null;
    positionShares: number | null;
    positionSizeUsd: number | null;
    snapshotAt: Date | null;
  } | null;
  attribution?: WalletAttribution;
};

type WalletAttributionInputSeed = {
  walletId: string;
  tags: WalletTagRow[] | null | undefined;
  metrics: WalletMetricsRow | null | undefined;
  portfolioPnl30dUsd?: number | null | undefined;
  inferredWinRate: number | null | undefined;
  inferredResolvedCount: number | null | undefined;
  trackedExposureUsd: number | null | undefined;
  topChanges: WalletActivityTopChange[] | null | undefined;
  signalSummary?: WalletActivitySignalSummary | null | undefined;
  mmSuspected?: boolean | null | undefined;
};

const ATTRIBUTION_SIGNAL_SUMMARY_TOP_CHANGES = 5;

type WalletOpenPositionOverlay = {
  trackedExposureUsd: number | null;
  openPositionsCount: number | null;
  openMarketsCount: number | null;
  avgOpenPositionSizeUsd: number | null;
  avgOpenEntryPrice: number | null;
  avgOpenEntryApprox: boolean | null;
};

async function fetchWalletSparklineMap(
  client: PoolClient,
  walletIds: string[],
  input: {
    metric: WalletSparklineMetric;
    windowHours: number;
  },
): Promise<Map<string, WalletActivitySparkline>> {
  if (walletIds.length === 0) return new Map<string, WalletActivitySparkline>();
  if (input.metric === "trade_pnl") {
    return fetchWalletPerformanceSparklines(client, walletIds, {
      windowHours: input.windowHours,
    });
  }
  return fetchWalletActivitySparklines(client, walletIds, {
    windowHours: input.windowHours,
  });
}

function buildEmptyWalletSparkline(input: {
  metric: WalletSparklineMetric;
  windowHours: number;
}): WalletActivitySparkline {
  return buildEmptyWalletActivitySparkline({
    metric: input.metric,
    windowHours: input.windowHours,
  });
}

function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.startsWith("0x")) return trimmed.toLowerCase();
  return trimmed;
}

function walletAddressIdentityKey(address: string): string {
  const trimmed = address.trim();
  if (trimmed.startsWith("0x")) return trimmed.toLowerCase();
  return trimmed;
}

function requestWalletPositioningMarketRefresh(
  payload: unknown,
  logLabel: string,
): void {
  const marketIds = collectMarketRefreshMarketIdsFromPayload(payload, {
    fields: ["marketId"],
    maxMarkets: 100,
  });
  requestMarketRefreshForMarketRefs({ db: pool, marketIds, logLabel });
}

function requestWalletPositioningSingleMarketRefresh(
  marketId: string,
  logLabel: string,
): void {
  requestMarketRefreshForMarketRefs({
    db: pool,
    marketIds: [marketId],
    logLabel,
  });
}

function isZeroEvmWalletAddress(address: string): boolean {
  return address.toLowerCase() === ethers.ZeroAddress;
}

function isValidWalletAddressForChain(address: string, chain: string): boolean {
  if (chain === "solana") {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }
  return ethers.isAddress(address) && !isZeroEvmWalletAddress(address);
}

async function findWalletByAddressAndChain(
  client: PoolClient,
  address: string,
  chain: string,
): Promise<WalletRow | null> {
  const result = await client.query<WalletRow>(
    `
      select id, address, chain, label, metadata, is_system_flagged, first_seen_at, last_seen_at
      from wallets
      where address = $1 and chain = $2
      limit 1
    `,
    [address, chain],
  );

  return result.rows[0] ?? null;
}

async function findWalletsByAddress(
  client: PoolClient,
  address: string,
): Promise<WalletResolveRow[]> {
  const result = await client.query<WalletResolveRow>(
    `
      select
        w.id,
        w.address,
        w.chain,
        w.label,
        w.metadata,
        w.is_system_flagged,
        w.first_seen_at,
        w.last_seen_at,
        exists (
          select 1
          from wallet_venues wv
          where wv.wallet_id = w.id
        ) as has_venue,
        wis.exposure_usd::text as exposure_usd,
        wis.last_activity_at,
        wis.metrics_volume_30d::text as metrics_volume_30d,
        wis.metrics_trades_30d
      from wallets w
      left join wallet_intel_selector_snapshot wis on wis.wallet_id = w.id
      where w.address = $1
      order by w.last_seen_at desc, w.first_seen_at desc, w.chain asc
    `,
    [address],
  );

  return result.rows;
}

async function ensureWalletByAddressAndChain(
  client: PoolClient,
  address: string,
  chain: string,
): Promise<WalletRow> {
  const existing = await findWalletByAddressAndChain(client, address, chain);
  if (existing) return existing;

  const inserted = await client.query<WalletRow>(
    `
      insert into wallets (address, chain, label)
      values ($1, $2, null)
      on conflict (address, chain)
      do nothing
      returning id, address, chain, label, metadata, is_system_flagged, first_seen_at, last_seen_at
    `,
    [address, chain],
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const raced = await findWalletByAddressAndChain(client, address, chain);
  if (!raced) {
    throw new Error("Failed to resolve wallet after insert");
  }
  return raced;
}

async function loadWalletPrivateNotes(
  client: PoolClient,
  userId: string,
  walletId: string,
): Promise<WalletPrivateNoteRow[]> {
  const result = await client.query<WalletPrivateNoteRow>(
    `
      select id, note, created_at, updated_at
      from wallet_user_notes
      where user_id = $1 and wallet_id = $2
      order by created_at asc, id asc
    `,
    [userId, walletId],
  );

  return result.rows;
}

async function loadWalletPrivateMeta(
  client: PoolClient,
  userId: string,
  walletId: string,
): Promise<WalletPrivateMetaRow> {
  const result = await client.query<WalletPrivateMetaRow>(
    `
      select
        exists(
          select 1
          from wallet_follows wf
          where wf.user_id = $1 and wf.wallet_id = $2
        ) as followed,
        (
          select wn.name
          from wallet_user_names wn
          where wn.user_id = $1 and wn.wallet_id = $2
          limit 1
        ) as user_name,
        (
          select wl.label
          from wallet_user_labels wl
          where wl.user_id = $1 and wl.wallet_id = $2
          limit 1
        ) as user_label,
        (
          select wl.color
          from wallet_user_labels wl
          where wl.user_id = $1 and wl.wallet_id = $2
          limit 1
        ) as user_label_color
    `,
    [userId, walletId],
  );
  return (
    result.rows[0] ?? {
      followed: false,
      user_name: null,
      user_label: null,
      user_label_color: null,
    }
  );
}

async function loadWalletPrivateMetaByWalletIds(
  client: PoolClient,
  userId: string | null,
  walletIds: string[],
): Promise<Map<string, WalletPrivateMetaRow>> {
  const byWallet = new Map<string, WalletPrivateMetaRow>();
  if (walletIds.length === 0) return byWallet;

  const result = await client.query<
    WalletPrivateMetaRow & {
      wallet_id: string;
    }
  >(
    `
      with wallet_set as (
        select unnest($2::uuid[]) as wallet_id
      )
      select
        ws.wallet_id,
        exists(
          select 1
          from wallet_follows wf
          where wf.user_id = $1 and wf.wallet_id = ws.wallet_id
        ) as followed,
        (
          select wn.name
          from wallet_user_names wn
          where wn.user_id = $1 and wn.wallet_id = ws.wallet_id
          limit 1
        ) as user_name,
        (
          select wl.label
          from wallet_user_labels wl
          where wl.user_id = $1 and wl.wallet_id = ws.wallet_id
          limit 1
        ) as user_label,
        (
          select wl.color
          from wallet_user_labels wl
          where wl.user_id = $1 and wl.wallet_id = ws.wallet_id
          limit 1
        ) as user_label_color
      from wallet_set ws
    `,
    [userId, walletIds],
  );

  for (const row of result.rows) {
    byWallet.set(row.wallet_id, {
      followed: row.followed,
      user_name: row.user_name ?? null,
      user_label: row.user_label ?? null,
      user_label_color: row.user_label_color ?? null,
    });
  }

  return byWallet;
}

function normalizeStringArray(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return Array.from(
    new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)),
  );
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function scoreWalletAddressResolutionCandidate(input: {
  wallet: Pick<
    WalletResolveRow,
    | "has_venue"
    | "exposure_usd"
    | "last_activity_at"
    | "metrics_volume_30d"
    | "metrics_trades_30d"
    | "last_seen_at"
  >;
  privateMeta?: WalletPrivateMetaRow | null;
}): number[] {
  const meta = input.privateMeta ?? null;
  const exposureUsd = nullableNumber(input.wallet.exposure_usd) ?? 0;
  const volumeUsd = nullableNumber(input.wallet.metrics_volume_30d) ?? 0;
  const trades = input.wallet.metrics_trades_30d ?? 0;
  return [
    meta?.followed || meta?.user_label || meta?.user_name ? 1 : 0,
    exposureUsd > 0 ? 1 : 0,
    input.wallet.last_activity_at?.getTime() ?? 0,
    volumeUsd > 0 || trades > 0 ? 1 : 0,
    input.wallet.has_venue ? 1 : 0,
    input.wallet.last_seen_at.getTime(),
  ];
}

function compareNumericTuple(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function pickAddressResolvedWallet(
  wallets: WalletResolveRow[],
  privateMetaByWallet: Map<string, WalletPrivateMetaRow>,
): WalletResolveRow | null {
  let best: WalletResolveRow | null = null;
  let bestScore: number[] | null = null;
  for (const wallet of wallets) {
    const score = scoreWalletAddressResolutionCandidate({
      wallet,
      privateMeta: privateMetaByWallet.get(wallet.id) ?? null,
    });
    if (!best || !bestScore || compareNumericTuple(score, bestScore) > 0) {
      best = wallet;
      bestScore = score;
    }
  }
  return best;
}

function buildIdentityGroupKey(
  chain: string,
  ownerAddress: string | null | undefined,
  walletAddress: string,
): string {
  return `${chain}:${walletAddressIdentityKey(ownerAddress ?? walletAddress)}`;
}

function emptyWalletOnchainFields(input: {
  chain: string;
  address: string;
  ownerAddress?: string | null;
  ownerWalletId?: string | null;
}): WalletOnchainIdentityFields {
  const ownerAddress = input.ownerAddress ?? null;
  return {
    walletKind: null,
    ownerAddress,
    ownerWalletId: input.ownerWalletId ?? null,
    identityGroupKey: buildIdentityGroupKey(
      input.chain,
      ownerAddress,
      input.address,
    ),
    walletBalances: null,
    ownerBalances: null,
    walletUsdLikeBalance: null,
    ownerUsdLikeBalance: null,
    balanceAsOf: null,
    identityResolvedAt: null,
  };
}

function buildWalletOnchainFields(input: {
  chain: string;
  address: string;
  fallbackOwnerAddress?: string | null;
  fallbackOwnerWalletId?: string | null;
  state?: WalletOnchainStateRow | null;
}): WalletOnchainIdentityFields {
  const state = input.state ?? null;
  const ownerAddress =
    state?.owner_address ?? input.fallbackOwnerAddress ?? null;
  const ownerWalletId =
    state?.owner_wallet_id ?? input.fallbackOwnerWalletId ?? null;
  return {
    walletKind: state?.wallet_kind ?? null,
    ownerAddress,
    ownerWalletId,
    identityGroupKey: buildIdentityGroupKey(
      input.chain,
      ownerAddress,
      input.address,
    ),
    walletBalances: state?.wallet_balances ?? null,
    ownerBalances: state?.owner_balances ?? null,
    walletUsdLikeBalance: nullableNumber(state?.wallet_usd_like_balance),
    ownerUsdLikeBalance: nullableNumber(state?.owner_usd_like_balance),
    balanceAsOf: isoDate(state?.balance_as_of),
    identityResolvedAt: isoDate(state?.identity_resolved_at),
  };
}

async function loadWalletOnchainStateByIds(
  client: PoolClient,
  walletIds: string[],
): Promise<Map<string, WalletOnchainStateRow>> {
  const byWalletId = new Map<string, WalletOnchainStateRow>();
  if (walletIds.length === 0) return byWalletId;

  const rows = await client.query<WalletOnchainStateRow>(
    `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      )
      select
        wos.wallet_id,
        wos.wallet_kind,
        wos.owner_address,
        coalesce(wos.owner_wallet_id, owner_wallet.id) as owner_wallet_id,
        wos.wallet_balances,
        wos.owner_balances,
        wos.wallet_usd_like_balance::text as wallet_usd_like_balance,
        wos.owner_usd_like_balance::text as owner_usd_like_balance,
        wos.balance_as_of,
        wos.identity_resolved_at
      from wallet_set ws
      join wallet_onchain_state wos on wos.wallet_id = ws.wallet_id
      left join wallets owner_wallet
        on owner_wallet.chain = wos.chain
       and wos.owner_address is not null
       and (
         (wos.chain = 'solana' and owner_wallet.address = wos.owner_address)
         or (wos.chain <> 'solana' and lower(owner_wallet.address) = lower(wos.owner_address))
       )
    `,
    [walletIds],
  );

  for (const row of rows.rows) byWalletId.set(row.wallet_id, row);
  return byWalletId;
}

type WalletActivityChangeAction = "OPENED" | "INCREASED" | "REDUCED" | "CLOSED";

function resolveWalletActivityChangeAction(input: {
  action: string | null;
  source: string | null;
  metadata: unknown;
}): WalletActivityChangeAction | null {
  const normalizedSource = input.source?.trim().toLowerCase() ?? null;
  const normalizedAction = input.action?.trim().toUpperCase() ?? null;

  if (normalizedSource === "snapshot_delta") {
    const metadata = isRecord(input.metadata) ? input.metadata : null;
    const prevShares = nullableNumber(metadata?.prevShares);
    const currShares = nullableNumber(metadata?.currShares);
    const prev = prevShares != null && prevShares > 1e-9 ? prevShares : 0;
    const curr = currShares != null && currShares > 1e-9 ? currShares : 0;

    if (prev <= 0 && curr > 0) return "OPENED";
    if (prev > 0 && curr <= 0) return "CLOSED";
    if (curr > prev) return "INCREASED";
    if (curr < prev) return "REDUCED";

    if (normalizedAction === "BUY") return "INCREASED";
    if (normalizedAction === "SELL") return "REDUCED";
    return null;
  }

  return null;
}

function inferVenueFromMarketId(
  marketId: string | null | undefined,
): string | null {
  const prefix = marketId?.split(":", 1)[0]?.trim().toLowerCase();
  if (
    prefix === "polymarket" ||
    prefix === "kalshi" ||
    prefix === "limitless"
  ) {
    return prefix;
  }
  return null;
}

function normalizeMarketStatusFilter(status: string): string {
  return status === "OPEN" ? "ACTIVE" : status;
}

function buildJsonNumericSql(jsonTextExpr: string): string {
  return `case when (${jsonTextExpr}) ~ '^-?[0-9]+(\\.[0-9]+)?$' then (${jsonTextExpr})::numeric else null end`;
}

function buildWalletActivityChangeActionSql(activityAlias: string): string {
  const prevRaw = `${activityAlias}.metadata->>'prevShares'`;
  const currRaw = `${activityAlias}.metadata->>'currShares'`;
  const prevNumber = buildJsonNumericSql(prevRaw);
  const currNumber = buildJsonNumericSql(currRaw);
  const prev = `case when coalesce(${prevNumber}, 0) > 0.000000001 then coalesce(${prevNumber}, 0) else 0 end`;
  const curr = `case when coalesce(${currNumber}, 0) > 0.000000001 then coalesce(${currNumber}, 0) else 0 end`;

  return `
    case
      when lower(coalesce(${activityAlias}.source, '')) = 'snapshot_delta' then
        case
          when ${prev} <= 0 and ${curr} > 0 then 'OPENED'
          when ${prev} > 0 and ${curr} <= 0 then 'CLOSED'
          when ${curr} > ${prev} then 'INCREASED'
          when ${curr} < ${prev} then 'REDUCED'
          when upper(coalesce(${activityAlias}.action, '')) = 'BUY' then 'INCREASED'
          when upper(coalesce(${activityAlias}.action, '')) = 'SELL' then 'REDUCED'
          else null
        end
      else null
    end
  `;
}

function appendWalletActivityFilters(
  clauses: string[],
  params: Array<string | number | boolean | null>,
  startIndex: number,
  query: {
    outcomeSide?: string;
    action?: string;
    changeAction?: string;
    minSizeUsd?: number;
    minDeltaShares?: number;
  },
  activityAlias: string,
): number {
  let idx = startIndex;
  if (query.outcomeSide) {
    clauses.push(`${activityAlias}.outcome_side = $${idx++}::text`);
    params.push(query.outcomeSide);
  }
  if (query.action) {
    clauses.push(
      `upper(coalesce(${activityAlias}.action, '')) = $${idx++}::text`,
    );
    params.push(query.action);
  }
  if (query.changeAction) {
    clauses.push(
      `(${buildWalletActivityChangeActionSql(activityAlias)}) = $${idx++}::text`,
    );
    params.push(query.changeAction);
  }
  if (query.minSizeUsd != null) {
    clauses.push(
      `coalesce(${activityAlias}.size_usd, 0) >= $${idx++}::numeric`,
    );
    params.push(query.minSizeUsd);
  }
  if (query.minDeltaShares != null) {
    clauses.push(
      `abs(coalesce(${activityAlias}.delta_shares, 0)) >= $${idx++}::numeric`,
    );
    params.push(query.minDeltaShares);
  }
  return idx;
}

function appendMarketReferenceFilters(
  clauses: string[],
  params: PgParams,
  startIndex: number,
  query: {
    marketId?: string;
    eventId?: string;
    category?: string;
    marketStatus?: string;
    acceptingOrders?: boolean;
  },
  aliases: { marketAlias: string; eventAlias: string },
): number {
  let idx = startIndex;
  if (query.marketId) {
    clauses.push(`${aliases.marketAlias}.id = $${idx++}::text`);
    params.push(query.marketId);
  }
  if (query.eventId) {
    clauses.push(`${aliases.marketAlias}.event_id = $${idx++}::text`);
    params.push(query.eventId);
  }
  if (query.category) {
    clauses.push(
      `lower(coalesce(${aliases.marketAlias}.category, ${aliases.eventAlias}.category, '')) = lower($${idx++}::text)`,
    );
    params.push(query.category);
  }
  if (query.marketStatus) {
    const normalizedStatus = normalizeMarketStatusFilter(query.marketStatus);
    clauses.push(`
      (
        upper(coalesce(${aliases.marketAlias}.status::text, '')) = $${idx}::text
        or ($${idx}::text = 'RESOLVED' and ${aliases.marketAlias}.resolved_outcome is not null)
      )
    `);
    params.push(normalizedStatus);
    idx += 1;
  }
  if (query.acceptingOrders != null) {
    clauses.push(
      `(${buildWalletIntelAcceptingOrdersSql({
        marketAlias: aliases.marketAlias,
        eventAlias: aliases.eventAlias,
      })}) = $${idx++}::boolean`,
    );
    params.push(query.acceptingOrders);
  }
  return idx;
}

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function extractSearchTerms(value: string | null | undefined): string[] {
  const terms =
    value
      ?.toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((term) => term.length >= 2) ?? [];
  return Array.from(new Set(terms)).slice(0, 8);
}

function buildAllSearchTermsMatchSql(
  documentSql: string,
  termsParam: string,
): string {
  return `
    not exists (
      select 1
      from unnest(${termsParam}::text[]) search_term
      where lower(${documentSql}) not like '%' || search_term || '%'
    )
  `;
}

export function assertSqlParamPlaceholders(
  sql: string,
  params: PgParams,
  label: string,
): void {
  if (env.nodeEnv.toLowerCase() === "production") return;

  const placeholders = new Set<number>();
  for (const match of sql.matchAll(/\$(\d+)\b/g)) {
    placeholders.add(Number(match[1]));
  }
  const maxPlaceholder = placeholders.size ? Math.max(...placeholders) : 0;
  const missing: number[] = [];
  for (let i = 1; i <= params.length; i += 1) {
    if (!placeholders.has(i)) missing.push(i);
  }

  if (maxPlaceholder !== params.length || missing.length > 0) {
    throw new Error(
      `${label} SQL param mismatch: placeholders=${maxPlaceholder}, params=${params.length}, missing=${missing.join(",") || "none"}`,
    );
  }
}

function appendWalletMarketSearchFilter(
  clauses: string[],
  params: PgParams,
  startIndex: number,
  query: { q?: string },
  aliases: { marketAlias: string; eventAlias: string },
): number {
  const q = query.q?.trim();
  if (!q) return startIndex;
  const idx = startIndex;
  params.push(`%${escapeSqlLikePattern(q)}%`);
  clauses.push(`
    (
      coalesce(${aliases.marketAlias}.title, '') ilike $${idx} escape '\\'
      or coalesce(${aliases.eventAlias}.title, '') ilike $${idx} escape '\\'
      or coalesce(${aliases.marketAlias}.outcomes::text, '') ilike $${idx} escape '\\'
      or coalesce(${aliases.marketAlias}.id, '') ilike $${idx} escape '\\'
      or coalesce(${aliases.marketAlias}.event_id, '') ilike $${idx} escape '\\'
    )
  `);
  return idx + 1;
}

type WalletPositioningQuery = {
  scope: "whales";
  q?: string;
  venue?: string;
  category?: string;
  marketStatus: string;
  acceptingOrders?: boolean;
  outcomeSide?: string;
  walletActiveWithinHours: number;
  minWalletExposureUsd: number;
  minPositionUsd: number;
  minWallets?: number;
  minYesPositionUsd?: number;
  minNoPositionUsd?: number;
  minMinoritySideUsd?: number;
  minMinoritySideShare?: number;
  minYesWallets?: number;
  minNoWallets?: number;
  minAbsImbalancePct?: number;
  maxAbsImbalancePct?: number;
  maxLargestHolderPct?: number;
  minBalancedDisagreementScore?: number;
  contestedMinMinoritySideUsd: number;
  contestedMinMinoritySideShare: number;
  contestedMinSideWallets: number;
  contestedMaxLargestHolderPct: number;
  eventShape: "any" | "single_market" | "multi_market";
  minContestedMarketCount?: number;
  minEventDisagreementScore?: number;
  minCrossMarketWallets?: number;
  mmMode: "all" | "exclude" | "only";
  sort:
    | "tracked_position_usd"
    | "wallet_count"
    | "yes_position_usd"
    | "no_position_usd"
    | "imbalance_usd"
    | "balanced_disagreement"
    | "minority_side_usd"
    | "abs_imbalance_pct"
    | "event_disagreement_score"
    | "contested_market_count"
    | "cross_market_wallet_count"
    | "top_market_minority_side_usd"
    | "largest_market_pct"
    | "avg_win_rate"
    | "avg_win_rate_edge"
    | "avg_edge_z_score"
    | "avg_brier_score"
    | "avg_roi"
    | "newest_snapshot";
  includeHolders: boolean;
  holdersLimit: number;
  holderSort: "position_usd" | "edge_z_score";
  includePositionPnl: boolean;
  shape: "table" | "tree" | "graph" | "both";
  limit: number;
  offset: number;
};

type WalletPositioningRow = {
  wallet_id: string;
  address: string;
  chain: string;
  wallet_label: string | null;
  wallet_metadata: unknown | null;
  profile_label: string | null;
  wallet_kind: string | null;
  owner_address: string | null;
  owner_wallet_id: string | null;
  wallet_balances: unknown | null;
  owner_balances: unknown | null;
  wallet_usd_like_balance: string | null;
  owner_usd_like_balance: string | null;
  balance_as_of: Date | null;
  identity_resolved_at: Date | null;
  venue: string;
  market_id: string;
  market_title: string | null;
  market_image: string | null;
  market_icon: string | null;
  event_id: string | null;
  event_title: string | null;
  event_image: string | null;
  event_icon: string | null;
  category: string | null;
  market_status: string | null;
  event_status: string | null;
  outcomes: string | null;
  event_start_date: Date | null;
  event_end_date: Date | null;
  close_time: Date | null;
  expiration_time: Date | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | null;
  accepting_orders: boolean | null;
  best_bid: string | null;
  best_ask: string | null;
  last_price: string | null;
  liquidity: string | null;
  volume_24h: string | null;
  volume_total: string | null;
  open_interest: string | null;
  outcome_side: string | null;
  shares: string | null;
  size_usd: string | null;
  price: string | null;
  position_usd: string | null;
  snapshot_at: Date;
  metadata: unknown;
  metrics_pnl_30d: string | null;
  metrics_roi_30d: string | null;
  metrics_trades_30d: number | null;
  metrics_win_rate_30d: string | null;
  metrics_resolved_edge_sample_count_30d: number | null;
  metrics_resolved_actual_win_rate_30d: string | null;
  metrics_resolved_expected_win_rate_30d: string | null;
  metrics_resolved_win_rate_edge_30d: string | null;
  metrics_resolved_edge_z_score_30d: string | null;
  metrics_resolved_brier_score_30d: string | null;
  metrics_resolved_stake_weighted_edge_30d: string | null;
  metrics_resolved_stake_usd_30d: string | null;
  exposure_usd: string | null;
  hedged_notional_usd: string | null;
  net_imbalance_usd: string | null;
  hedge_ratio: string | null;
  two_sided_markets: number | null;
  last_activity_at: Date | null;
  inferred_wins: number | null;
  inferred_total: number | null;
  search_membership_tier: number | null;
  search_market_match_tier: number | null;
  search_event_match_tier: number | null;
};

type WalletPositioningQuoteRow = {
  market_id: string;
  side: string;
  token_id: string;
  best_bid: string | null;
  best_ask: string | null;
  mid: string | null;
  spread: string | null;
  updated_at: Date | null;
};

type PositioningSide = "YES" | "NO";

type PositioningOddsSide = {
  label: string;
  tokenId: string | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  updatedAt: string | null;
};

type PositioningOdds = {
  yes: PositioningOddsSide;
  no: PositioningOddsSide;
};

type PositioningPnl = {
  avgEntryPrice: number | null;
  currentPrice: number | null;
  openPnlUsd: number | null;
  realizedPnlUsd: number | null;
  totalPnlUsd: number | null;
  pnlPct: number | null;
  approxReliable: boolean;
  source: "activity" | "snapshot" | null;
};

type PositioningHolder = {
  walletId: string;
  address: string;
  chain: string;
  label: string | null;
  identityDisplayName: string | null;
  identityDisplayNameSource: string | null;
  identityProfileUrl: string | null;
  profileLabel: string | null;
  walletKind: string | null;
  ownerAddress: string | null;
  ownerWalletId: string | null;
  identityGroupKey: string;
  walletBalances: unknown | null;
  ownerBalances: unknown | null;
  walletUsdLikeBalance: number | null;
  ownerUsdLikeBalance: number | null;
  balanceAsOf: string | null;
  identityResolvedAt: string | null;
  side: PositioningSide;
  shares: number | null;
  positionUsd: number;
  price: number | null;
  snapshotAt: string | null;
  lastActivityAt: string | null;
  metrics: {
    pnl30d: number | null;
    roi30d: number | null;
    trades30d: number | null;
    winRate30d: number | null;
    resolvedEdgeSampleCount30d: number | null;
    resolvedActualWinRate30d: number | null;
    resolvedExpectedWinRate30d: number | null;
    resolvedWinRateEdge30d: number | null;
    resolvedEdgeZScore30d: number | null;
    resolvedBrierScore30d: number | null;
    resolvedStakeWeightedEdge30d: number | null;
    resolvedStakeUsd30d: number | null;
    inferredWinRate: number | null;
    resolvedWins: number | null;
    resolvedTotal: number | null;
  };
  mmDiagnostics: WalletMmDiagnostics;
  pnl?: PositioningPnl;
};

type PositioningSideAggregate = {
  side: PositioningSide;
  positionUsd: number;
  shares: number | null;
  walletCount: number;
  largestHolderUsd: number | null;
  largestHolderPct: number | null;
  weightedAvgWinRate30d: number | null;
  weightedAvgResolvedWinRateEdge30d: number | null;
  weightedAvgResolvedEdgeZScore30d: number | null;
  weightedAvgResolvedBrierScore30d: number | null;
  resolvedEdgeHolderCount: number;
  weightedAvgRoi30d: number | null;
  topWinRate30d: number | null;
  topPnl30d: number | null;
  avgEntryPrice: number | null;
  openPnlUsd: number | null;
  realizedPnlUsd: number | null;
  totalPnlUsd: number | null;
  pnlHolderCount: number;
  quote: {
    tokenId: string | null;
    bestBid: number | null;
    bestAsk: number | null;
    mid: number | null;
    spread: number | null;
    updatedAt: string | null;
  } | null;
  topHolders: PositioningHolder[];
};

type PositioningMarketAggregate = {
  marketId: string;
  eventId: string | null;
  venue: string;
  marketTitle: string | null;
  marketImage: string | null;
  marketIcon: string | null;
  eventTitle: string | null;
  eventImage: string | null;
  eventIcon: string | null;
  eventStartDate: string | null;
  eventEndDate: string | null;
  category: string | null;
  marketStatus: string | null;
  eventStatus: string | null;
  acceptingOrders: boolean | null;
  closeTime: string | null;
  expirationTime: string | null;
  resolvedOutcome: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  marketLiquidityUsd: number | null;
  volume24h: number | null;
  volumeTotal: number | null;
  openInterest: number | null;
  trackedPositionUsd: number;
  walletCount: number;
  largestHolderUsd: number | null;
  largestHolderPct: number | null;
  imbalanceUsd: number;
  imbalancePct: number | null;
  minoritySide: PositioningSide | null;
  minoritySideUsd: number;
  minoritySideShare: number | null;
  absImbalancePct: number | null;
  balancedDisagreementScore: number;
  weightedAvgWinRate30d: number | null;
  weightedAvgResolvedWinRateEdge30d: number | null;
  weightedAvgResolvedEdgeZScore30d: number | null;
  weightedAvgResolvedBrierScore30d: number | null;
  resolvedEdgeHolderCount: number;
  weightedAvgRoi30d: number | null;
  newestSnapshotAt: string | null;
  odds: PositioningOdds;
  sideBreakdown: Record<PositioningSide, PositioningSideAggregate>;
  topHolders: PositioningHolder[];
};

type PositioningEventAggregate = {
  eventId: string;
  venue: string | null;
  eventTitle: string | null;
  eventImage: string | null;
  eventIcon: string | null;
  eventStatus: string | null;
  startDate: string | null;
  endDate: string | null;
  category: string | null;
  trackedPositionUsd: number;
  walletCount: number;
  marketCount: number;
  eventShape: "single_market" | "multi_market";
  largestMarketUsd: number | null;
  largestMarketPct: number | null;
  contestedMarketCount: number;
  eventDisagreementScore: number;
  crossMarketWalletCount: number;
  topMarketMinoritySideUsd: number | null;
  topMarketMinoritySideShare: number | null;
  weightedAvgWinRate30d: number | null;
  weightedAvgResolvedWinRateEdge30d: number | null;
  weightedAvgResolvedEdgeZScore30d: number | null;
  weightedAvgResolvedBrierScore30d: number | null;
  resolvedEdgeHolderCount: number;
  weightedAvgRoi30d: number | null;
  newestSnapshotAt: string | null;
  topMarketsPreview: PositioningMarketAggregate[];
};

type PositioningAccumulator = {
  weightedWinRateTotal: number;
  weightedWinRateWeight: number;
  weightedResolvedWinRateEdgeTotal: number;
  weightedResolvedWinRateEdgeWeight: number;
  weightedResolvedEdgeZScoreTotal: number;
  weightedResolvedEdgeZScoreWeight: number;
  weightedResolvedBrierScoreTotal: number;
  weightedResolvedBrierScoreWeight: number;
  resolvedEdgeHolderIds: Set<string>;
  weightedRoiTotal: number;
  weightedRoiWeight: number;
  topWinRate: number | null;
  topPnl: number | null;
};

function initPositioningAccumulator(): PositioningAccumulator {
  return {
    weightedWinRateTotal: 0,
    weightedWinRateWeight: 0,
    weightedResolvedWinRateEdgeTotal: 0,
    weightedResolvedWinRateEdgeWeight: 0,
    weightedResolvedEdgeZScoreTotal: 0,
    weightedResolvedEdgeZScoreWeight: 0,
    weightedResolvedBrierScoreTotal: 0,
    weightedResolvedBrierScoreWeight: 0,
    resolvedEdgeHolderIds: new Set(),
    weightedRoiTotal: 0,
    weightedRoiWeight: 0,
    topWinRate: null,
    topPnl: null,
  };
}

function addPositioningStats(
  acc: PositioningAccumulator,
  holder: Pick<PositioningHolder, "walletId" | "positionUsd" | "metrics">,
) {
  const winRate =
    holder.metrics.winRate30d ?? holder.metrics.inferredWinRate ?? null;
  if (winRate != null) {
    acc.weightedWinRateTotal += winRate * holder.positionUsd;
    acc.weightedWinRateWeight += holder.positionUsd;
    acc.topWinRate = Math.max(acc.topWinRate ?? winRate, winRate);
  }
  if (
    holder.metrics.resolvedWinRateEdge30d != null &&
    holder.metrics.resolvedEdgeSampleCount30d != null &&
    holder.metrics.resolvedEdgeSampleCount30d > 0
  ) {
    acc.weightedResolvedWinRateEdgeTotal +=
      holder.metrics.resolvedWinRateEdge30d * holder.positionUsd;
    acc.weightedResolvedWinRateEdgeWeight += holder.positionUsd;
    acc.resolvedEdgeHolderIds.add(holder.walletId);
  }
  if (
    holder.metrics.resolvedEdgeZScore30d != null &&
    holder.metrics.resolvedEdgeSampleCount30d != null &&
    holder.metrics.resolvedEdgeSampleCount30d > 0
  ) {
    acc.weightedResolvedEdgeZScoreTotal +=
      holder.metrics.resolvedEdgeZScore30d * holder.positionUsd;
    acc.weightedResolvedEdgeZScoreWeight += holder.positionUsd;
    acc.resolvedEdgeHolderIds.add(holder.walletId);
  }
  if (
    holder.metrics.resolvedBrierScore30d != null &&
    holder.metrics.resolvedEdgeSampleCount30d != null &&
    holder.metrics.resolvedEdgeSampleCount30d > 0
  ) {
    acc.weightedResolvedBrierScoreTotal +=
      holder.metrics.resolvedBrierScore30d * holder.positionUsd;
    acc.weightedResolvedBrierScoreWeight += holder.positionUsd;
    acc.resolvedEdgeHolderIds.add(holder.walletId);
  }
  if (holder.metrics.roi30d != null) {
    acc.weightedRoiTotal += holder.metrics.roi30d * holder.positionUsd;
    acc.weightedRoiWeight += holder.positionUsd;
  }
  if (holder.metrics.pnl30d != null) {
    acc.topPnl = Math.max(
      acc.topPnl ?? holder.metrics.pnl30d,
      holder.metrics.pnl30d,
    );
  }
}

function finalizeWeightedAverage(total: number, weight: number): number | null {
  return weight > 0 ? total / weight : null;
}

function initSideAggregate(side: PositioningSide): PositioningSideAggregate {
  return {
    side,
    positionUsd: 0,
    shares: null,
    walletCount: 0,
    largestHolderUsd: null,
    largestHolderPct: null,
    weightedAvgWinRate30d: null,
    weightedAvgResolvedWinRateEdge30d: null,
    weightedAvgResolvedEdgeZScore30d: null,
    weightedAvgResolvedBrierScore30d: null,
    resolvedEdgeHolderCount: 0,
    weightedAvgRoi30d: null,
    topWinRate30d: null,
    topPnl30d: null,
    avgEntryPrice: null,
    openPnlUsd: null,
    realizedPnlUsd: null,
    totalPnlUsd: null,
    pnlHolderCount: 0,
    quote: null,
    topHolders: [],
  };
}

function isoDate(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function resolvePositioningSide(value: string | null): PositioningSide | null {
  return value === "YES" || value === "NO" ? value : null;
}

function parsePositioningOutcomeLabels(
  value: string | null,
): Record<PositioningSide, string> {
  const fallback = { YES: "YES", NO: "NO" };
  const parsed = parseMarketOutcomes(value);
  const yes = parsed?.[0]?.trim() ?? "";
  const no = parsed?.[1]?.trim() ?? "";
  return {
    YES: yes || fallback.YES,
    NO: no || fallback.NO,
  };
}

function buildPositioningOddsSide(
  label: string,
  quote: PositioningSideAggregate["quote"],
): PositioningOddsSide {
  return {
    label,
    tokenId: quote?.tokenId ?? null,
    bid: quote?.bestBid ?? null,
    ask: quote?.bestAsk ?? null,
    mid: quote?.mid ?? null,
    spread: quote?.spread ?? null,
    updatedAt: quote?.updatedAt ?? null,
  };
}

function buildPositioningOdds(
  labels: Record<PositioningSide, string>,
  sideBreakdown: Record<PositioningSide, PositioningSideAggregate>,
): PositioningOdds {
  return {
    yes: buildPositioningOddsSide(labels.YES, sideBreakdown.YES.quote),
    no: buildPositioningOddsSide(labels.NO, sideBreakdown.NO.quote),
  };
}

function refreshPositioningOdds(market: PositioningMarketAggregate) {
  market.odds = buildPositioningOdds(
    {
      YES: market.odds.yes.label,
      NO: market.odds.no.label,
    },
    market.sideBreakdown,
  );
}

function addNullable(
  total: number | null,
  value: number | null,
): number | null {
  if (value == null) return total;
  return (total ?? 0) + value;
}

function computePositioningMarketDisagreement(
  market: PositioningMarketAggregate,
) {
  const yesUsd = market.sideBreakdown.YES.positionUsd;
  const noUsd = market.sideBreakdown.NO.positionUsd;
  const minoritySideUsd = Math.min(yesUsd, noUsd);
  market.minoritySideUsd = minoritySideUsd;
  market.minoritySide =
    minoritySideUsd <= 0 || yesUsd === noUsd
      ? null
      : yesUsd < noUsd
        ? "YES"
        : "NO";
  market.minoritySideShare =
    market.trackedPositionUsd > 0
      ? minoritySideUsd / market.trackedPositionUsd
      : null;
  market.absImbalancePct =
    market.imbalancePct != null ? Math.abs(market.imbalancePct) : null;
  market.balancedDisagreementScore =
    Math.sqrt(Math.max(yesUsd, 0) * Math.max(noUsd, 0)) *
    (market.minoritySideShare ?? 0) *
    Math.max(0, 1 - (market.largestHolderPct ?? 1));
}

function pctPassesMin(value: number | null, threshold: number | undefined) {
  return threshold == null || (value != null && value >= threshold);
}

function pctPassesMax(value: number | null, threshold: number | undefined) {
  return threshold == null || (value != null && value <= threshold);
}

function marketPassesPositioningFilters(
  market: PositioningMarketAggregate,
  query: WalletPositioningQuery,
): boolean {
  if (
    query.minYesPositionUsd != null &&
    market.sideBreakdown.YES.positionUsd < query.minYesPositionUsd
  ) {
    return false;
  }
  if (
    query.minNoPositionUsd != null &&
    market.sideBreakdown.NO.positionUsd < query.minNoPositionUsd
  ) {
    return false;
  }
  if (
    query.minMinoritySideUsd != null &&
    market.minoritySideUsd < query.minMinoritySideUsd
  ) {
    return false;
  }
  if (!pctPassesMin(market.minoritySideShare, query.minMinoritySideShare)) {
    return false;
  }
  if (
    query.minYesWallets != null &&
    market.sideBreakdown.YES.walletCount < query.minYesWallets
  ) {
    return false;
  }
  if (
    query.minNoWallets != null &&
    market.sideBreakdown.NO.walletCount < query.minNoWallets
  ) {
    return false;
  }
  if (!pctPassesMin(market.absImbalancePct, query.minAbsImbalancePct)) {
    return false;
  }
  if (!pctPassesMax(market.absImbalancePct, query.maxAbsImbalancePct)) {
    return false;
  }
  if (!pctPassesMax(market.largestHolderPct, query.maxLargestHolderPct)) {
    return false;
  }
  if (
    query.minBalancedDisagreementScore != null &&
    market.balancedDisagreementScore < query.minBalancedDisagreementScore
  ) {
    return false;
  }
  return true;
}

function isContestedPositioningMarket(
  market: PositioningMarketAggregate,
  query: WalletPositioningQuery,
): boolean {
  return (
    market.minoritySideUsd >= query.contestedMinMinoritySideUsd &&
    (market.minoritySideShare ?? 0) >= query.contestedMinMinoritySideShare &&
    market.sideBreakdown.YES.walletCount >= query.contestedMinSideWallets &&
    market.sideBreakdown.NO.walletCount >= query.contestedMinSideWallets &&
    (market.largestHolderPct ?? 1) <= query.contestedMaxLargestHolderPct
  );
}

function eventPassesPositioningFilters(
  event: PositioningEventAggregate,
  query: WalletPositioningQuery,
): boolean {
  if (query.eventShape !== "any" && event.eventShape !== query.eventShape) {
    return false;
  }
  if (
    query.minContestedMarketCount != null &&
    event.contestedMarketCount < query.minContestedMarketCount
  ) {
    return false;
  }
  if (
    query.minEventDisagreementScore != null &&
    event.eventDisagreementScore < query.minEventDisagreementScore
  ) {
    return false;
  }
  if (
    query.minCrossMarketWallets != null &&
    event.crossMarketWalletCount < query.minCrossMarketWallets
  ) {
    return false;
  }
  return true;
}

function isEventPositioningSort(sort: WalletPositioningQuery["sort"]) {
  return [
    "event_disagreement_score",
    "contested_market_count",
    "cross_market_wallet_count",
    "top_market_minority_side_usd",
    "largest_market_pct",
  ].includes(sort);
}

function compareNullableNumberDesc(
  a: number | null | undefined,
  b: number | null | undefined,
): number {
  const aValid = typeof a === "number" && Number.isFinite(a);
  const bValid = typeof b === "number" && Number.isFinite(b);
  if (aValid && bValid) {
    if (a === b) return 0;
    return b - a;
  }
  if (aValid) return -1;
  if (bValid) return 1;
  return 0;
}

function compareStringAsc(a: string, b: string): number {
  return a.localeCompare(b);
}

function sortPositioningMarkets(
  markets: PositioningMarketAggregate[],
  sort: WalletPositioningQuery["sort"],
  searchTierByMarketId?: Map<string, number>,
): PositioningMarketAggregate[] {
  const value = (market: PositioningMarketAggregate): number | null => {
    switch (sort) {
      case "wallet_count":
        return market.walletCount;
      case "yes_position_usd":
        return market.sideBreakdown.YES.positionUsd;
      case "no_position_usd":
        return market.sideBreakdown.NO.positionUsd;
      case "imbalance_usd":
        return Math.abs(market.imbalanceUsd);
      case "balanced_disagreement":
        return market.balancedDisagreementScore;
      case "minority_side_usd":
        return market.minoritySideUsd;
      case "abs_imbalance_pct":
        return market.absImbalancePct;
      case "avg_win_rate":
        return market.weightedAvgWinRate30d;
      case "avg_win_rate_edge":
        return market.weightedAvgResolvedWinRateEdge30d;
      case "avg_edge_z_score":
        return market.weightedAvgResolvedEdgeZScore30d;
      case "avg_brier_score":
        return market.weightedAvgResolvedBrierScore30d != null
          ? -market.weightedAvgResolvedBrierScore30d
          : null;
      case "avg_roi":
        return market.weightedAvgRoi30d;
      case "newest_snapshot":
        return market.newestSnapshotAt
          ? new Date(market.newestSnapshotAt).getTime()
          : null;
      case "event_disagreement_score":
      case "contested_market_count":
      case "cross_market_wallet_count":
      case "top_market_minority_side_usd":
      case "largest_market_pct":
        return market.balancedDisagreementScore;
      case "tracked_position_usd":
      default:
        return market.trackedPositionUsd;
    }
  };
  return [...markets].sort((a, b) => {
    if (searchTierByMarketId) {
      const bySearchTier = compareNullableNumberDesc(
        searchTierByMarketId.get(a.marketId) ?? 0,
        searchTierByMarketId.get(b.marketId) ?? 0,
      );
      if (bySearchTier !== 0) return bySearchTier;
    }

    const byPrimary = compareNullableNumberDesc(value(a), value(b));
    if (byPrimary !== 0) return byPrimary;

    const byPosition = compareNullableNumberDesc(
      a.trackedPositionUsd,
      b.trackedPositionUsd,
    );
    if (byPosition !== 0) return byPosition;

    const byWallets = compareNullableNumberDesc(a.walletCount, b.walletCount);
    if (byWallets !== 0) return byWallets;

    return compareStringAsc(a.marketId, b.marketId);
  });
}

function holderEdgeZScoreSortValue(holder: PositioningHolder): number | null {
  const sampleCount = holder.metrics.resolvedEdgeSampleCount30d ?? 0;
  if (sampleCount <= 0) return null;
  return holder.metrics.resolvedEdgeZScore30d ?? null;
}

function sortPositioningHolders(
  holders: PositioningHolder[],
  sort: WalletPositioningQuery["holderSort"],
): PositioningHolder[] {
  if (sort === "edge_z_score") {
    return [...holders].sort((a, b) => {
      const byEdge = compareNullableNumberDesc(
        holderEdgeZScoreSortValue(a),
        holderEdgeZScoreSortValue(b),
      );
      if (byEdge !== 0) return byEdge;

      const bySamples = compareNullableNumberDesc(
        a.metrics.resolvedEdgeSampleCount30d ?? 0,
        b.metrics.resolvedEdgeSampleCount30d ?? 0,
      );
      if (bySamples !== 0) return bySamples;

      const byStake = compareNullableNumberDesc(
        a.metrics.resolvedStakeUsd30d ?? 0,
        b.metrics.resolvedStakeUsd30d ?? 0,
      );
      if (byStake !== 0) return byStake;

      return b.positionUsd - a.positionUsd;
    });
  }

  return [...holders].sort((a, b) => b.positionUsd - a.positionUsd);
}

function sortPositioningEvents(
  events: PositioningEventAggregate[],
  sort: WalletPositioningQuery["sort"],
  searchTierByEventId?: Map<string, number>,
): PositioningEventAggregate[] {
  const value = (event: PositioningEventAggregate): number | null => {
    switch (sort) {
      case "wallet_count":
        return event.walletCount;
      case "avg_win_rate":
        return event.weightedAvgWinRate30d;
      case "avg_win_rate_edge":
        return event.weightedAvgResolvedWinRateEdge30d;
      case "avg_edge_z_score":
        return event.weightedAvgResolvedEdgeZScore30d;
      case "avg_brier_score":
        return event.weightedAvgResolvedBrierScore30d != null
          ? -event.weightedAvgResolvedBrierScore30d
          : null;
      case "avg_roi":
        return event.weightedAvgRoi30d;
      case "newest_snapshot":
        return event.newestSnapshotAt
          ? new Date(event.newestSnapshotAt).getTime()
          : null;
      case "event_disagreement_score":
        return event.eventDisagreementScore;
      case "contested_market_count":
        return event.contestedMarketCount;
      case "cross_market_wallet_count":
        return event.crossMarketWalletCount;
      case "top_market_minority_side_usd":
        return event.topMarketMinoritySideUsd;
      case "largest_market_pct":
        return event.largestMarketPct;
      case "yes_position_usd":
      case "no_position_usd":
      case "imbalance_usd":
      case "balanced_disagreement":
      case "minority_side_usd":
      case "abs_imbalance_pct":
      case "tracked_position_usd":
      default:
        return event.trackedPositionUsd;
    }
  };
  return [...events].sort((a, b) => {
    if (searchTierByEventId) {
      const bySearchTier = compareNullableNumberDesc(
        searchTierByEventId.get(a.eventId) ?? 0,
        searchTierByEventId.get(b.eventId) ?? 0,
      );
      if (bySearchTier !== 0) return bySearchTier;
    }

    const byPrimary = compareNullableNumberDesc(value(a), value(b));
    if (byPrimary !== 0) return byPrimary;

    const byPosition = compareNullableNumberDesc(
      a.trackedPositionUsd,
      b.trackedPositionUsd,
    );
    if (byPosition !== 0) return byPosition;

    const byMarkets = compareNullableNumberDesc(a.marketCount, b.marketCount);
    if (byMarkets !== 0) return byMarkets;

    return compareStringAsc(a.eventId, b.eventId);
  });
}

async function loadPositioningQuotes(
  client: PoolClient,
  marketIds: string[],
): Promise<Map<string, PositioningSideAggregate["quote"]>> {
  const uniqueIds = Array.from(new Set(marketIds)).filter(Boolean);
  const byKey = new Map<string, PositioningSideAggregate["quote"]>();
  if (uniqueIds.length === 0) return byKey;
  const { rows } = await client.query<WalletPositioningQuoteRow>(
    `
      select
        ut.market_id,
        ut.side,
        ut.token_id,
        ttl.best_bid::text as best_bid,
        ttl.best_ask::text as best_ask,
        ttl.mid::text as mid,
        ttl.spread::text as spread,
        ttl.updated_at
      from unified_tokens ut
      left join unified_token_top_latest ttl on ttl.token_id = ut.token_id
      where ut.market_id = any($1::text[])
        and ut.side in ('YES', 'NO')
    `,
    [uniqueIds],
  );
  for (const row of rows) {
    byKey.set(`${row.market_id}::${row.side}`, {
      tokenId: row.token_id,
      bestBid: nullableNumber(row.best_bid),
      bestAsk: nullableNumber(row.best_ask),
      mid: nullableNumber(row.mid),
      spread: nullableNumber(row.spread),
      updatedAt: isoDate(row.updated_at),
    });
  }
  return byKey;
}

function buildPositioningGraph(input: {
  markets: PositioningMarketAggregate[];
  includeEvents: boolean;
}) {
  const nodes = new Map<string, Record<string, unknown>>();
  const edges: Array<Record<string, unknown>> = [];

  for (const market of input.markets) {
    const marketNodeId = `market:${market.marketId}`;
    if (input.includeEvents && market.eventId) {
      const eventNodeId = `event:${market.eventId}`;
      nodes.set(eventNodeId, {
        id: eventNodeId,
        type: "event",
        eventId: market.eventId,
        label: market.eventTitle,
        image: market.eventImage,
        icon: market.eventIcon,
        eventStatus: market.eventStatus,
        startDate: market.eventStartDate,
        endDate: market.eventEndDate,
        category: market.category,
      });
      edges.push({
        source: eventNodeId,
        target: marketNodeId,
        type: "event_market",
        weight: market.trackedPositionUsd,
      });
    }

    nodes.set(marketNodeId, {
      id: marketNodeId,
      type: "market",
      marketId: market.marketId,
      eventId: market.eventId,
      label: market.marketTitle,
      image: market.marketImage,
      icon: market.marketIcon,
      eventImage: market.eventImage,
      eventIcon: market.eventIcon,
      odds: market.odds,
      trackedPositionUsd: market.trackedPositionUsd,
      walletCount: market.walletCount,
      minoritySide: market.minoritySide,
      minoritySideUsd: market.minoritySideUsd,
      minoritySideShare: market.minoritySideShare,
      absImbalancePct: market.absImbalancePct,
      balancedDisagreementScore: market.balancedDisagreementScore,
      largestHolderPct: market.largestHolderPct,
    });

    for (const side of ["YES", "NO"] as const) {
      const sideAgg = market.sideBreakdown[side];
      const sideNodeId = `side:${market.marketId}:${side}`;
      nodes.set(sideNodeId, {
        id: sideNodeId,
        type: "side",
        marketId: market.marketId,
        side,
        positionUsd: sideAgg.positionUsd,
        walletCount: sideAgg.walletCount,
      });
      edges.push({
        source: marketNodeId,
        target: sideNodeId,
        type: "market_side",
        weight: sideAgg.positionUsd,
      });

      for (const holder of sideAgg.topHolders) {
        const traderNodeId = `trader:${holder.walletId}`;
        nodes.set(traderNodeId, {
          id: traderNodeId,
          type: "trader",
          walletId: holder.walletId,
          address: holder.address,
          chain: holder.chain,
          label: holder.profileLabel ?? holder.label,
          metrics: holder.metrics,
          mmSuspected: holder.mmDiagnostics.mmSuspected,
        });
        edges.push({
          source: sideNodeId,
          target: traderNodeId,
          type: "side_trader",
          weight: holder.positionUsd,
          shares: holder.shares,
        });
      }
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges,
  };
}

async function loadTrackedWalletPositioning(input: {
  client: PoolClient;
  query: WalletPositioningQuery;
  eventId?: string;
  marketId?: string;
  rollup: "events" | "markets" | "event-detail" | "market-detail";
}) {
  const { client, query } = input;
  const refreshPolicy = await resolveWalletIntelRefreshPolicy(client);
  const params: PgParams = [];
  const addParam = (value: PgParams[number]) => {
    params.push(value);
    return `$${params.length}`;
  };
  const walletActiveWithinHoursParam = addParam(query.walletActiveWithinHours);
  const minWalletExposureUsdParam = addParam(query.minWalletExposureUsd);

  const candidateClauses = [
    "tag.slug = 'whale'",
    `wis.last_activity_at >= now() - (${walletActiveWithinHoursParam}::integer * interval '1 hour')`,
    `coalesce(wis.exposure_usd, 0) >= ${minWalletExposureUsdParam}::numeric`,
  ];
  if (query.mmMode !== "all") {
    const whaleUsdParam = addParam(refreshPolicy.effective.whaleUsd);
    const whaleUsdSolanaParam = addParam(
      refreshPolicy.effective.whaleUsdSolana,
    );
    const candidateMmSql = buildWalletMmSuspectedSql({
      exposureUsdSql: "wis.exposure_usd",
      hedgedNotionalUsdSql: "wis.hedged_notional_usd",
      hedgeRatioSql: "wis.hedge_ratio",
      twoSidedMarketsSql: "wis.two_sided_markets",
      exposureThresholdSql: `case
        when w.chain = 'solana' then ${whaleUsdSolanaParam}::numeric
        else ${whaleUsdParam}::numeric
      end`,
    });
    if (query.mmMode === "exclude") {
      candidateClauses.push(`not ${candidateMmSql}`);
    } else {
      candidateClauses.push(candidateMmSql);
    }
  }

  const venueFilter = query.venue ?? inferVenueFromMarketId(input.marketId);
  let candidateVenuesSql =
    "values ('polymarket'::text), ('limitless'::text), ('kalshi'::text)";
  if (venueFilter) {
    candidateVenuesSql = `select ${addParam(venueFilter)}::text`;
  }

  const latestPositionClauses = [
    "ws.outcome_side in ('YES', 'NO')",
    "coalesce(ws.shares, 0) > 0",
  ];
  if (query.outcomeSide) {
    latestPositionClauses.push(
      `ws.outcome_side = ${addParam(query.outcomeSide)}::text`,
    );
  }
  latestPositionClauses.push(
    `greatest(coalesce(ws.size_usd, 0), abs(coalesce(ws.shares, 0) * coalesce(ws.price, 0))) >= ${addParam(query.minPositionUsd)}::numeric`,
  );

  const marketClauses: string[] = [];
  appendMarketReferenceFilters(
    marketClauses,
    params,
    params.length + 1,
    {
      marketId: input.marketId,
      eventId: input.eventId,
      category: query.category,
      marketStatus: query.marketStatus,
      acceptingOrders: query.acceptingOrders,
    },
    { marketAlias: "um", eventAlias: "ue" },
  );
  if (normalizeMarketStatusFilter(query.marketStatus) === "ACTIVE") {
    marketClauses.push("(ue.id is null or ue.status = 'ACTIVE')");
  }
  marketClauses.push("hp.token_id is null");
  const searchWindow = buildFeedSearchResultWindow({
    limit: query.limit,
    offset: query.offset,
  });
  const searchEarlyFilterInputs: Pick<FeedInputs, "venues" | "category"> = {};
  if (venueFilter) searchEarlyFilterInputs.venues = [venueFilter];
  if (query.category) searchEarlyFilterInputs.category = query.category;
  const searchFilter = buildFeedCandidateEventSearchFilter({
    add: addParam,
    q: query.q,
    nowParam: "now()",
    matchLimit: searchWindow.matchLimit,
    fallbackThreshold: searchWindow.fallbackThreshold,
    earlyFilterInputs: searchEarlyFilterInputs,
  });
  const searchTerms = searchFilter.hasSearch ? extractSearchTerms(query.q) : [];
  const searchTermsParam =
    searchFilter.hasSearch && searchTerms.length > 0
      ? addParam(searchTerms)
      : null;
  const marketSearchDocumentSql = `
    concat_ws(
      ' ',
      um.id,
      um.title,
      um.slug,
      um.description,
      um.category,
      um.outcomes::text
    )
  `;
  const eventSearchDocumentSql = `
    concat_ws(
      ' ',
      ue.id,
      ue.title,
      ue.slug,
      ue.description,
      ue.category
    )
  `;
  const siblingMarketSearchDocumentSql = `
    concat_ws(
      ' ',
      sm.id,
      sm.title,
      sm.slug,
      sm.description,
      sm.category,
      sm.outcomes::text
    )
  `;
  const marketSearchMatchSql =
    searchTermsParam && searchTerms.length > 0
      ? `case when ${buildAllSearchTermsMatchSql(marketSearchDocumentSql, searchTermsParam)} then 1 else 0 end`
      : "0";
  const eventSearchMatchSql =
    searchTermsParam && searchTerms.length > 0
      ? `case when ${buildAllSearchTermsMatchSql(eventSearchDocumentSql, searchTermsParam)} then 1 else 0 end`
      : "0";
  if (searchTermsParam && searchTerms.length > 0) {
    const siblingMarketSearchMatchSql = buildAllSearchTermsMatchSql(
      siblingMarketSearchDocumentSql,
      searchTermsParam,
    );
    marketClauses.push(`
      (
        (${marketSearchMatchSql}) > 0
        or (
          (${eventSearchMatchSql}) > 0
          and not exists (
            select 1
            from unified_markets sm
            where sm.event_id = um.event_id
              and sm.status = 'ACTIVE'
              and ${siblingMarketSearchMatchSql}
          )
        )
      )
    `);
  }
  const searchMembershipSql = searchFilter.hasSearch ? "1" : "0";

  const positioningSql = `
      with ${searchFilter.searchCte ? `${searchFilter.searchCte},` : ""}
      candidate_wallets as materialized (
        select
          w.id as wallet_id,
	          w.address,
	          w.chain,
	          w.label as wallet_label,
	          w.metadata as wallet_metadata,
	          wp.profile->>'label_short' as profile_label,
          wos.wallet_kind,
          coalesce(wos.owner_address, owner.owner_address) as owner_address,
          coalesce(wos.owner_wallet_id, owner.owner_wallet_id) as owner_wallet_id,
          wos.wallet_balances,
          wos.owner_balances,
          wos.wallet_usd_like_balance::text as wallet_usd_like_balance,
          wos.owner_usd_like_balance::text as owner_usd_like_balance,
          wos.balance_as_of,
          wos.identity_resolved_at,
          wis.metrics_pnl_30d,
          wis.metrics_roi_30d,
          wis.metrics_trades_30d,
          wis.metrics_win_rate_30d,
          wis.metrics_resolved_edge_sample_count_30d,
          wis.metrics_resolved_actual_win_rate_30d,
          wis.metrics_resolved_expected_win_rate_30d,
          wis.metrics_resolved_win_rate_edge_30d,
          wis.metrics_resolved_edge_z_score_30d,
          wis.metrics_resolved_brier_score_30d,
          wis.metrics_resolved_stake_weighted_edge_30d,
          wis.metrics_resolved_stake_usd_30d,
          wis.exposure_usd,
          wis.hedged_notional_usd,
          wis.net_imbalance_usd,
          wis.hedge_ratio,
          wis.two_sided_markets,
          wis.last_activity_at,
          inferred.wins as inferred_wins,
          inferred.total as inferred_total
        from wallet_tags tag
        join wallet_tag_map tm on tm.tag_id = tag.id
        join wallet_intel_selector_snapshot wis on wis.wallet_id = tm.wallet_id
        join wallets w on w.id = tm.wallet_id
        left join wallet_profiles wp on wp.wallet_id = w.id
        left join wallet_inferred_outcomes inferred on inferred.wallet_id = w.id
        left join wallet_onchain_state wos on wos.wallet_id = w.id
        ${buildWalletOwnerResolutionJoinSql(true)}
        where ${candidateClauses.join(" and ")}
      ),
      candidate_venues(venue) as (
        ${candidateVenuesSql}
      ),
      hidden_positions as materialized (
        select venue, token_id, wallet_address
        from positions
        where position_scope = 'own'
          and coalesce(is_hidden, false) = true
          and token_id is not null
          and wallet_address is not null
          and btrim(wallet_address) <> ''
      ),
      latest_snapshots as materialized (
        select
          cw.*,
          cv.venue,
          latest.snapshot_at
        from candidate_wallets cw
        cross join candidate_venues cv
        join lateral (
          select ws.snapshot_at
          from wallet_position_snapshots ws
          where ws.wallet_id = cw.wallet_id
            and ws.venue = cv.venue
          order by ws.snapshot_at desc
          limit 1
        ) latest on true
      ),
      latest_positions as materialized (
        select
          ls.*,
          ws.market_id,
          ws.outcome_side,
          ws.shares,
          ws.size_usd,
          ws.price,
          ws.metadata,
          greatest(
            coalesce(ws.size_usd, 0),
            abs(coalesce(ws.shares, 0) * coalesce(ws.price, 0))
          ) as position_usd
        from latest_snapshots ls
        join wallet_position_snapshots ws
          on ws.wallet_id = ls.wallet_id
         and ws.venue = ls.venue
         and ws.snapshot_at = ls.snapshot_at
        where ${latestPositionClauses.join(" and ")}
      )
      select
        lp.wallet_id,
	        lp.address,
	        lp.chain,
	        lp.wallet_label,
	        lp.wallet_metadata,
	        lp.profile_label,
        lp.wallet_kind,
        lp.owner_address,
        lp.owner_wallet_id,
        lp.wallet_balances,
        lp.owner_balances,
        lp.wallet_usd_like_balance,
        lp.owner_usd_like_balance,
        lp.balance_as_of,
        lp.identity_resolved_at,
        lp.venue,
        lp.market_id,
        um.title as market_title,
        um.image as market_image,
        um.icon as market_icon,
        um.event_id,
        ue.title as event_title,
        ue.image as event_image,
        ue.icon as event_icon,
        coalesce(um.category, ue.category) as category,
        um.status::text as market_status,
        ue.status::text as event_status,
        um.outcomes::text as outcomes,
        ue.start_date as event_start_date,
        ue.end_date as event_end_date,
        um.close_time,
        um.expiration_time,
        um.resolved_outcome,
        um.resolved_outcome_pct::text as resolved_outcome_pct,
        ${buildWalletIntelAcceptingOrdersSql({
          marketAlias: "um",
          eventAlias: "ue",
        })} as accepting_orders,
        um.best_bid::text as best_bid,
        um.best_ask::text as best_ask,
        um.last_price::text as last_price,
        um.liquidity::text as liquidity,
        um.volume_24h::text as volume_24h,
        um.volume_total::text as volume_total,
        um.open_interest::text as open_interest,
        lp.outcome_side as outcome_side,
        lp.shares::text as shares,
        lp.size_usd::text as size_usd,
        lp.price::text as price,
        lp.position_usd::text as position_usd,
        lp.snapshot_at,
        lp.metadata,
        lp.metrics_pnl_30d::text as metrics_pnl_30d,
        lp.metrics_roi_30d::text as metrics_roi_30d,
        lp.metrics_trades_30d,
        lp.metrics_win_rate_30d::text as metrics_win_rate_30d,
        lp.metrics_resolved_edge_sample_count_30d,
        lp.metrics_resolved_actual_win_rate_30d::text as metrics_resolved_actual_win_rate_30d,
        lp.metrics_resolved_expected_win_rate_30d::text as metrics_resolved_expected_win_rate_30d,
        lp.metrics_resolved_win_rate_edge_30d::text as metrics_resolved_win_rate_edge_30d,
        lp.metrics_resolved_edge_z_score_30d::text as metrics_resolved_edge_z_score_30d,
        lp.metrics_resolved_brier_score_30d::text as metrics_resolved_brier_score_30d,
        lp.metrics_resolved_stake_weighted_edge_30d::text as metrics_resolved_stake_weighted_edge_30d,
        lp.metrics_resolved_stake_usd_30d::text as metrics_resolved_stake_usd_30d,
        lp.exposure_usd::text as exposure_usd,
        lp.hedged_notional_usd::text as hedged_notional_usd,
        lp.net_imbalance_usd::text as net_imbalance_usd,
        lp.hedge_ratio::text as hedge_ratio,
        lp.two_sided_markets,
        lp.last_activity_at,
        lp.inferred_wins,
        lp.inferred_total,
        ${searchMembershipSql}::int as search_membership_tier,
        (${marketSearchMatchSql})::int as search_market_match_tier,
        (${eventSearchMatchSql})::int as search_event_match_tier
      from latest_positions lp
      join unified_markets um on um.id = lp.market_id
      left join unified_events ue on ue.id = um.event_id
      left join hidden_positions hp
        on hp.venue = lp.venue
       and hp.token_id = lp.metadata->>'tokenId'
       and (
         (lp.chain = 'solana' and hp.wallet_address = lp.address)
         or (lp.chain <> 'solana' and lower(hp.wallet_address) = lower(lp.address))
       )
      where ${marketClauses.join(" and ")}
    `;
  assertSqlParamPlaceholders(
    positioningSql,
    params,
    "loadTrackedWalletPositioning",
  );
  const { rows } = await client.query<WalletPositioningRow>(
    positioningSql,
    params,
  );

  const marketBuilders = new Map<
    string,
    {
      market: PositioningMarketAggregate;
      holders: PositioningHolder[];
      walletIds: Set<string>;
      stats: PositioningAccumulator;
      sideWalletIds: Record<PositioningSide, Set<string>>;
      sideStats: Record<PositioningSide, PositioningAccumulator>;
      pnlEntryWeighted: Record<PositioningSide, number>;
      pnlEntryShares: Record<PositioningSide, number>;
      directSearchMarketTier: number;
      searchMarketTier: number;
      searchEventTier: number;
    }
  >();

  const holdersByKey = new Map<string, PositioningHolder>();
  const rowsByHolderKey = new Map<string, WalletPositioningRow>();

  for (const row of rows) {
    const side = resolvePositioningSide(row.outcome_side);
    if (!side) continue;
    const positionUsd = nullableNumber(row.position_usd) ?? 0;
    if (positionUsd <= 0) continue;
    const shares = nullableNumber(row.shares);
    const holder: PositioningHolder = {
      walletId: row.wallet_id,
      address: row.address,
      chain: row.chain,
      label: row.wallet_label,
      ...extractWalletIdentityDisplayFields(row.wallet_metadata, row.wallet_label),
      profileLabel: row.profile_label,
      ...buildWalletOnchainFields({
        chain: row.chain,
        address: row.address,
        fallbackOwnerAddress: row.owner_address,
        fallbackOwnerWalletId: row.owner_wallet_id,
        state: {
          wallet_id: row.wallet_id,
          wallet_kind: row.wallet_kind,
          owner_address: row.owner_address,
          owner_wallet_id: row.owner_wallet_id,
          wallet_balances: row.wallet_balances,
          owner_balances: row.owner_balances,
          wallet_usd_like_balance: row.wallet_usd_like_balance,
          owner_usd_like_balance: row.owner_usd_like_balance,
          balance_as_of: row.balance_as_of,
          identity_resolved_at: row.identity_resolved_at,
        },
      }),
      side,
      shares,
      positionUsd,
      price: nullableNumber(row.price),
      snapshotAt: isoDate(row.snapshot_at),
      lastActivityAt: isoDate(row.last_activity_at),
      metrics: {
        pnl30d: nullableNumber(row.metrics_pnl_30d),
        roi30d: nullableNumber(row.metrics_roi_30d),
        trades30d: row.metrics_trades_30d,
        winRate30d: nullableNumber(row.metrics_win_rate_30d),
        resolvedEdgeSampleCount30d: row.metrics_resolved_edge_sample_count_30d,
        resolvedActualWinRate30d: nullableNumber(
          row.metrics_resolved_actual_win_rate_30d,
        ),
        resolvedExpectedWinRate30d: nullableNumber(
          row.metrics_resolved_expected_win_rate_30d,
        ),
        resolvedWinRateEdge30d: nullableNumber(
          row.metrics_resolved_win_rate_edge_30d,
        ),
        resolvedEdgeZScore30d: nullableNumber(
          row.metrics_resolved_edge_z_score_30d,
        ),
        resolvedBrierScore30d: nullableNumber(
          row.metrics_resolved_brier_score_30d,
        ),
        resolvedStakeWeightedEdge30d: nullableNumber(
          row.metrics_resolved_stake_weighted_edge_30d,
        ),
        resolvedStakeUsd30d: nullableNumber(row.metrics_resolved_stake_usd_30d),
        inferredWinRate:
          row.inferred_total &&
          row.inferred_total > 0 &&
          row.inferred_wins != null
            ? row.inferred_wins / row.inferred_total
            : null,
        resolvedWins: row.inferred_wins,
        resolvedTotal: row.inferred_total,
      },
      mmDiagnostics: buildWalletMmDiagnostics({
        exposureUsd: nullableNumber(row.exposure_usd),
        hedgedNotionalUsd: nullableNumber(row.hedged_notional_usd),
        netImbalanceUsd: nullableNumber(row.net_imbalance_usd),
        hedgeRatio: nullableNumber(row.hedge_ratio),
        twoSidedMarkets: row.two_sided_markets,
        chain: row.chain,
        refreshPolicy: refreshPolicy.effective,
      }),
    };
    const holderKey = makeWalletPositionLedgerKey(
      row.wallet_id,
      row.market_id,
      side,
    );
    holdersByKey.set(holderKey, holder);
    rowsByHolderKey.set(holderKey, row);

    let builder = marketBuilders.get(row.market_id);
    if (!builder) {
      const outcomeLabels = parsePositioningOutcomeLabels(row.outcomes);
      const sideBreakdown = {
        YES: initSideAggregate("YES"),
        NO: initSideAggregate("NO"),
      };
      builder = {
        market: {
          marketId: row.market_id,
          eventId: row.event_id,
          venue: row.venue,
          marketTitle: row.market_title,
          marketImage: row.market_image,
          marketIcon: row.market_icon,
          eventTitle: row.event_title,
          eventImage: row.event_image,
          eventIcon: row.event_icon,
          eventStartDate: isoDate(row.event_start_date),
          eventEndDate: isoDate(row.event_end_date),
          category: row.category,
          marketStatus: row.market_status,
          eventStatus: row.event_status,
          acceptingOrders: row.accepting_orders,
          closeTime: isoDate(row.close_time),
          expirationTime: isoDate(row.expiration_time),
          resolvedOutcome: row.resolved_outcome,
          bestBid: nullableNumber(row.best_bid),
          bestAsk: nullableNumber(row.best_ask),
          lastPrice: nullableNumber(row.last_price),
          marketLiquidityUsd: nullableNumber(row.liquidity),
          volume24h: nullableNumber(row.volume_24h),
          volumeTotal: nullableNumber(row.volume_total),
          openInterest: nullableNumber(row.open_interest),
          trackedPositionUsd: 0,
          walletCount: 0,
          largestHolderUsd: null,
          largestHolderPct: null,
          imbalanceUsd: 0,
          imbalancePct: null,
          minoritySide: null,
          minoritySideUsd: 0,
          minoritySideShare: null,
          absImbalancePct: null,
          balancedDisagreementScore: 0,
          weightedAvgWinRate30d: null,
          weightedAvgResolvedWinRateEdge30d: null,
          weightedAvgResolvedEdgeZScore30d: null,
          weightedAvgResolvedBrierScore30d: null,
          resolvedEdgeHolderCount: 0,
          weightedAvgRoi30d: null,
          newestSnapshotAt: null,
          odds: buildPositioningOdds(outcomeLabels, sideBreakdown),
          sideBreakdown,
          topHolders: [],
        },
        holders: [],
        walletIds: new Set(),
        stats: initPositioningAccumulator(),
        sideWalletIds: {
          YES: new Set(),
          NO: new Set(),
        },
        sideStats: {
          YES: initPositioningAccumulator(),
          NO: initPositioningAccumulator(),
        },
        pnlEntryWeighted: { YES: 0, NO: 0 },
        pnlEntryShares: { YES: 0, NO: 0 },
        directSearchMarketTier: 0,
        searchMarketTier: 0,
        searchEventTier: 0,
      };
      marketBuilders.set(row.market_id, builder);
    }

    const searchMembershipTier = row.search_membership_tier ?? 0;
    const hasDirectMarketMatch = (row.search_market_match_tier ?? 0) > 0;
    const hasDirectEventMatch = (row.search_event_match_tier ?? 0) > 0;
    builder.directSearchMarketTier = Math.max(
      builder.directSearchMarketTier,
      hasDirectMarketMatch ? 3 : 0,
    );
    builder.searchMarketTier = Math.max(
      builder.searchMarketTier,
      hasDirectMarketMatch ? 3 : hasDirectEventMatch ? 2 : searchMembershipTier,
    );
    builder.searchEventTier = Math.max(
      builder.searchEventTier,
      hasDirectEventMatch ? 3 : hasDirectMarketMatch ? 2 : searchMembershipTier,
    );

    const sideAgg = builder.market.sideBreakdown[side];
    builder.holders.push(holder);
    builder.walletIds.add(holder.walletId);
    builder.sideWalletIds[side].add(holder.walletId);
    builder.market.trackedPositionUsd += positionUsd;
    builder.market.largestHolderUsd = Math.max(
      builder.market.largestHolderUsd ?? positionUsd,
      positionUsd,
    );
    builder.market.newestSnapshotAt =
      !builder.market.newestSnapshotAt ||
      (holder.snapshotAt && holder.snapshotAt > builder.market.newestSnapshotAt)
        ? holder.snapshotAt
        : builder.market.newestSnapshotAt;
    sideAgg.positionUsd += positionUsd;
    sideAgg.shares = addNullable(sideAgg.shares, shares);
    sideAgg.largestHolderUsd = Math.max(
      sideAgg.largestHolderUsd ?? positionUsd,
      positionUsd,
    );
    addPositioningStats(builder.stats, holder);
    addPositioningStats(builder.sideStats[side], holder);
  }

  if (query.includePositionPnl && holdersByKey.size > 0) {
    const approxInputs = Array.from(holdersByKey.entries()).map(
      ([key, holder]) => {
        const row = rowsByHolderKey.get(key);
        return {
          walletId: holder.walletId,
          marketId: row?.market_id ?? "",
          outcomeSide: holder.side,
          shares: holder.shares,
          price: holder.price,
          bestBid: nullableNumber(row?.best_bid),
          bestAsk: nullableNumber(row?.best_ask),
          lastPrice: nullableNumber(row?.last_price),
          resolvedOutcome: row?.resolved_outcome ?? null,
          resolvedOutcomePct: nullableNumber(row?.resolved_outcome_pct),
          metadata: row?.metadata,
        };
      },
    );
    const approxMetrics = await loadWalletPositionApproxMetrics(
      client,
      approxInputs,
    );
    for (const [key, holder] of holdersByKey.entries()) {
      const row = rowsByHolderKey.get(key);
      if (!row) continue;
      const metrics = approxMetrics.get(key);
      const basis =
        metrics?.approxEntryPrice != null &&
        holder.shares != null &&
        holder.shares > 0
          ? metrics.approxEntryPrice * holder.shares
          : null;
      holder.pnl = {
        avgEntryPrice: metrics?.approxEntryPrice ?? null,
        currentPrice: metrics?.currentPrice ?? null,
        openPnlUsd: metrics?.openPnlUsd ?? null,
        realizedPnlUsd: metrics?.realizedPnlUsd ?? null,
        totalPnlUsd: metrics?.totalPnlUsd ?? null,
        pnlPct:
          basis != null && basis > 0 && metrics?.totalPnlUsd != null
            ? metrics.totalPnlUsd / basis
            : null,
        approxReliable: metrics?.approxReliable ?? false,
        source: metrics?.approxPnlSource ?? null,
      };
      const builder = marketBuilders.get(row.market_id);
      if (!builder) continue;
      const sideAgg = builder.market.sideBreakdown[holder.side];
      sideAgg.openPnlUsd = addNullable(
        sideAgg.openPnlUsd,
        holder.pnl.openPnlUsd,
      );
      sideAgg.realizedPnlUsd = addNullable(
        sideAgg.realizedPnlUsd,
        holder.pnl.realizedPnlUsd,
      );
      sideAgg.totalPnlUsd = addNullable(
        sideAgg.totalPnlUsd,
        holder.pnl.totalPnlUsd,
      );
      if (holder.pnl.avgEntryPrice != null && holder.shares != null) {
        builder.pnlEntryWeighted[holder.side] +=
          holder.pnl.avgEntryPrice * holder.shares;
        builder.pnlEntryShares[holder.side] += holder.shares;
      }
      if (holder.pnl.totalPnlUsd != null) {
        sideAgg.pnlHolderCount += 1;
      }
    }
  }

  const markets = Array.from(marketBuilders.values()).map((builder) => {
    const market = builder.market;
    market.walletCount = builder.walletIds.size;
    market.largestHolderPct =
      market.trackedPositionUsd > 0 && market.largestHolderUsd != null
        ? market.largestHolderUsd / market.trackedPositionUsd
        : null;
    market.weightedAvgWinRate30d = finalizeWeightedAverage(
      builder.stats.weightedWinRateTotal,
      builder.stats.weightedWinRateWeight,
    );
    market.weightedAvgResolvedWinRateEdge30d = finalizeWeightedAverage(
      builder.stats.weightedResolvedWinRateEdgeTotal,
      builder.stats.weightedResolvedWinRateEdgeWeight,
    );
    market.weightedAvgResolvedEdgeZScore30d = finalizeWeightedAverage(
      builder.stats.weightedResolvedEdgeZScoreTotal,
      builder.stats.weightedResolvedEdgeZScoreWeight,
    );
    market.weightedAvgResolvedBrierScore30d = finalizeWeightedAverage(
      builder.stats.weightedResolvedBrierScoreTotal,
      builder.stats.weightedResolvedBrierScoreWeight,
    );
    market.resolvedEdgeHolderCount = builder.stats.resolvedEdgeHolderIds.size;
    market.weightedAvgRoi30d = finalizeWeightedAverage(
      builder.stats.weightedRoiTotal,
      builder.stats.weightedRoiWeight,
    );
    market.imbalanceUsd =
      market.sideBreakdown.YES.positionUsd -
      market.sideBreakdown.NO.positionUsd;
    market.imbalancePct =
      market.trackedPositionUsd > 0
        ? market.imbalanceUsd / market.trackedPositionUsd
        : null;
    computePositioningMarketDisagreement(market);

    const sortedHolders = sortPositioningHolders(
      builder.holders,
      query.holderSort,
    );
    market.topHolders =
      query.includeHolders && query.holdersLimit > 0
        ? sortedHolders.slice(0, query.holdersLimit)
        : [];

    for (const side of ["YES", "NO"] as const) {
      const sideAgg = market.sideBreakdown[side];
      sideAgg.walletCount = builder.sideWalletIds[side].size;
      sideAgg.largestHolderPct =
        sideAgg.positionUsd > 0 && sideAgg.largestHolderUsd != null
          ? sideAgg.largestHolderUsd / sideAgg.positionUsd
          : null;
      sideAgg.weightedAvgWinRate30d = finalizeWeightedAverage(
        builder.sideStats[side].weightedWinRateTotal,
        builder.sideStats[side].weightedWinRateWeight,
      );
      sideAgg.weightedAvgResolvedWinRateEdge30d = finalizeWeightedAverage(
        builder.sideStats[side].weightedResolvedWinRateEdgeTotal,
        builder.sideStats[side].weightedResolvedWinRateEdgeWeight,
      );
      sideAgg.weightedAvgResolvedEdgeZScore30d = finalizeWeightedAverage(
        builder.sideStats[side].weightedResolvedEdgeZScoreTotal,
        builder.sideStats[side].weightedResolvedEdgeZScoreWeight,
      );
      sideAgg.weightedAvgResolvedBrierScore30d = finalizeWeightedAverage(
        builder.sideStats[side].weightedResolvedBrierScoreTotal,
        builder.sideStats[side].weightedResolvedBrierScoreWeight,
      );
      sideAgg.resolvedEdgeHolderCount =
        builder.sideStats[side].resolvedEdgeHolderIds.size;
      sideAgg.weightedAvgRoi30d = finalizeWeightedAverage(
        builder.sideStats[side].weightedRoiTotal,
        builder.sideStats[side].weightedRoiWeight,
      );
      sideAgg.topWinRate30d = builder.sideStats[side].topWinRate;
      sideAgg.topPnl30d = builder.sideStats[side].topPnl;
      sideAgg.avgEntryPrice =
        builder.pnlEntryShares[side] > 0
          ? builder.pnlEntryWeighted[side] / builder.pnlEntryShares[side]
          : null;
      sideAgg.topHolders =
        query.includeHolders && query.holdersLimit > 0
          ? sortedHolders
              .filter((holder) => holder.side === side)
              .slice(0, query.holdersLimit)
          : [];
    }

    return market as PositioningMarketAggregate;
  });
  const searchTierByMarketId =
    searchFilter.hasSearch && marketBuilders.size > 0
      ? new Map(
          Array.from(marketBuilders.entries()).map(([marketId, builder]) => [
            marketId,
            builder.searchMarketTier,
          ]),
        )
      : undefined;
  const directSearchTierByMarketId =
    searchFilter.hasSearch && marketBuilders.size > 0
      ? new Map(
          Array.from(marketBuilders.entries()).map(([marketId, builder]) => [
            marketId,
            builder.directSearchMarketTier,
          ]),
        )
      : undefined;
  const searchTierByEventMarketId =
    searchFilter.hasSearch && marketBuilders.size > 0
      ? new Map(
          Array.from(marketBuilders.entries()).map(([marketId, builder]) => [
            marketId,
            builder.searchEventTier,
          ]),
        )
      : undefined;

  const effectiveMinWallets =
    query.minWallets ?? (input.rollup === "market-detail" ? 1 : 2);
  const walletFilteredMarkets = markets.filter(
    (market) => market.walletCount >= effectiveMinWallets,
  );
  const marketFilteredMarkets = walletFilteredMarkets.filter((market) => {
    if (
      searchFilter.hasSearch &&
      (searchTierByMarketId?.get(market.marketId) ?? 0) > 0
    ) {
      return true;
    }
    return marketPassesPositioningFilters(market, query);
  });
  const sortedMarkets = sortPositioningMarkets(
    marketFilteredMarkets,
    query.sort,
    searchTierByMarketId,
  );

  const eventBuilders = new Map<
    string,
    {
      event: Omit<
        PositioningEventAggregate,
        | "walletCount"
        | "marketCount"
        | "eventShape"
        | "largestMarketPct"
        | "contestedMarketCount"
        | "eventDisagreementScore"
        | "crossMarketWalletCount"
        | "topMarketMinoritySideUsd"
        | "topMarketMinoritySideShare"
        | "weightedAvgWinRate30d"
        | "weightedAvgResolvedWinRateEdge30d"
        | "weightedAvgResolvedEdgeZScore30d"
        | "weightedAvgResolvedBrierScore30d"
        | "resolvedEdgeHolderCount"
        | "weightedAvgRoi30d"
        | "topMarketsPreview"
      >;
      walletIds: Set<string>;
      walletMarketIds: Map<string, Set<string>>;
      markets: PositioningMarketAggregate[];
      stats: PositioningAccumulator;
      searchTier: number;
    }
  >();
  for (const market of walletFilteredMarkets) {
    if (!market.eventId) continue;
    let builder = eventBuilders.get(market.eventId);
    if (!builder) {
      builder = {
        event: {
          eventId: market.eventId,
          venue: market.venue,
          eventTitle: market.eventTitle,
          eventImage: market.eventImage,
          eventIcon: market.eventIcon,
          eventStatus: market.eventStatus,
          startDate: market.eventStartDate,
          endDate: market.eventEndDate,
          category: market.category,
          trackedPositionUsd: 0,
          largestMarketUsd: null,
          newestSnapshotAt: null,
        },
        walletIds: new Set(),
        walletMarketIds: new Map(),
        markets: [],
        stats: initPositioningAccumulator(),
        searchTier: 0,
      };
      eventBuilders.set(market.eventId, builder);
    }
    builder.markets.push(market);
    builder.searchTier = Math.max(
      builder.searchTier,
      searchTierByMarketId?.get(market.marketId) ?? 0,
      searchTierByEventMarketId?.get(market.marketId) ?? 0,
    );
    builder.event.trackedPositionUsd += market.trackedPositionUsd;
    builder.event.largestMarketUsd = Math.max(
      builder.event.largestMarketUsd ?? market.trackedPositionUsd,
      market.trackedPositionUsd,
    );
    builder.event.newestSnapshotAt =
      !builder.event.newestSnapshotAt ||
      (market.newestSnapshotAt &&
        market.newestSnapshotAt > builder.event.newestSnapshotAt)
        ? market.newestSnapshotAt
        : builder.event.newestSnapshotAt;
    const sourceBuilder = marketBuilders.get(market.marketId);
    for (const holder of sourceBuilder?.holders ?? market.topHolders) {
      builder.walletIds.add(holder.walletId);
      let walletMarketIds = builder.walletMarketIds.get(holder.walletId);
      if (!walletMarketIds) {
        walletMarketIds = new Set();
        builder.walletMarketIds.set(holder.walletId, walletMarketIds);
      }
      walletMarketIds.add(market.marketId);
      addPositioningStats(builder.stats, holder);
    }
  }
  const searchTierByEventId =
    searchFilter.hasSearch && eventBuilders.size > 0
      ? new Map(
          Array.from(eventBuilders.entries()).map(([eventId, builder]) => [
            eventId,
            builder.searchTier,
          ]),
        )
      : undefined;
  const sortedEvents = sortPositioningEvents(
    Array.from(eventBuilders.values())
      .map((builder) => {
        const event = builder.event;
        const marketCount = builder.markets.length;
        const eventShape: PositioningEventAggregate["eventShape"] =
          marketCount <= 1 ? "single_market" : "multi_market";
        const contestedMarkets = builder.markets.filter((market) =>
          isContestedPositioningMarket(market, query),
        );
        const topMinorityMarket =
          contestedMarkets.reduce<PositioningMarketAggregate | null>(
            (top, market) =>
              !top || market.minoritySideUsd > top.minoritySideUsd
                ? market
                : top,
            null,
          );
        const directMatchedMarkets =
          searchFilter.hasSearch && directSearchTierByMarketId
            ? builder.markets.filter(
                (market) =>
                  (directSearchTierByMarketId.get(market.marketId) ?? 0) > 0,
              )
            : [];
        const previewSourceMarkets =
          directMatchedMarkets.length > 0
            ? directMatchedMarkets
            : builder.markets;
        const previewMarkets = isEventPositioningSort(query.sort)
          ? sortPositioningMarkets(
              previewSourceMarkets,
              "balanced_disagreement",
              directMatchedMarkets.length > 0
                ? directSearchTierByMarketId
                : searchTierByMarketId,
            )
          : sortPositioningMarkets(
              previewSourceMarkets,
              query.sort,
              directMatchedMarkets.length > 0
                ? directSearchTierByMarketId
                : searchTierByMarketId,
            );
        return {
          ...event,
          walletCount: builder.walletIds.size,
          marketCount,
          eventShape,
          largestMarketPct:
            event.trackedPositionUsd > 0 && event.largestMarketUsd != null
              ? event.largestMarketUsd / event.trackedPositionUsd
              : null,
          contestedMarketCount: contestedMarkets.length,
          eventDisagreementScore: contestedMarkets.reduce(
            (total, market) => total + market.balancedDisagreementScore,
            0,
          ),
          crossMarketWalletCount: Array.from(
            builder.walletMarketIds.values(),
          ).filter((marketIds) => marketIds.size >= 2).length,
          topMarketMinoritySideUsd: topMinorityMarket?.minoritySideUsd ?? null,
          topMarketMinoritySideShare:
            topMinorityMarket?.minoritySideShare ?? null,
          weightedAvgWinRate30d: finalizeWeightedAverage(
            builder.stats.weightedWinRateTotal,
            builder.stats.weightedWinRateWeight,
          ),
          weightedAvgResolvedWinRateEdge30d: finalizeWeightedAverage(
            builder.stats.weightedResolvedWinRateEdgeTotal,
            builder.stats.weightedResolvedWinRateEdgeWeight,
          ),
          weightedAvgResolvedEdgeZScore30d: finalizeWeightedAverage(
            builder.stats.weightedResolvedEdgeZScoreTotal,
            builder.stats.weightedResolvedEdgeZScoreWeight,
          ),
          weightedAvgResolvedBrierScore30d: finalizeWeightedAverage(
            builder.stats.weightedResolvedBrierScoreTotal,
            builder.stats.weightedResolvedBrierScoreWeight,
          ),
          resolvedEdgeHolderCount: builder.stats.resolvedEdgeHolderIds.size,
          weightedAvgRoi30d: finalizeWeightedAverage(
            builder.stats.weightedRoiTotal,
            builder.stats.weightedRoiWeight,
          ),
          topMarketsPreview: previewMarkets.slice(0, 3),
        };
      })
      .filter((event) => {
        if (
          searchFilter.hasSearch &&
          (searchTierByEventId?.get(event.eventId) ?? 0) > 0
        ) {
          return true;
        }
        return eventPassesPositioningFilters(event, query);
      }),
    query.sort,
    searchTierByEventId,
  );

  const page =
    input.rollup === "events"
      ? sortedEvents.slice(query.offset, query.offset + query.limit)
      : sortedMarkets.slice(query.offset, query.offset + query.limit);
  const selectedMarkets =
    input.rollup === "events"
      ? (page as PositioningEventAggregate[]).flatMap(
          (event) => event.topMarketsPreview,
        )
      : (page as PositioningMarketAggregate[]);
  const includeGraph = query.shape === "graph" || query.shape === "both";
  const includeTree = query.shape === "tree" || query.shape === "both";
  const quoteMap = await loadPositioningQuotes(
    client,
    selectedMarkets.map((market) => market.marketId),
  );
  for (const market of selectedMarkets) {
    for (const side of ["YES", "NO"] as const) {
      market.sideBreakdown[side].quote =
        quoteMap.get(`${market.marketId}::${side}`) ?? null;
    }
    refreshPositioningOdds(market);
  }

  return {
    ok: true,
    scope: query.scope,
    filters: {
      q: query.q ?? null,
      venue: venueFilter ?? null,
      eventId: input.eventId ?? null,
      marketId: input.marketId ?? null,
      category: query.category ?? null,
      marketStatus: query.marketStatus,
      acceptingOrders: query.acceptingOrders ?? null,
      outcomeSide: query.outcomeSide ?? null,
      walletActiveWithinHours: query.walletActiveWithinHours,
      minWalletExposureUsd: query.minWalletExposureUsd,
      minPositionUsd: query.minPositionUsd,
      minWallets: effectiveMinWallets,
      minYesPositionUsd: query.minYesPositionUsd ?? null,
      minNoPositionUsd: query.minNoPositionUsd ?? null,
      minMinoritySideUsd: query.minMinoritySideUsd ?? null,
      minMinoritySideShare: query.minMinoritySideShare ?? null,
      minYesWallets: query.minYesWallets ?? null,
      minNoWallets: query.minNoWallets ?? null,
      minAbsImbalancePct: query.minAbsImbalancePct ?? null,
      maxAbsImbalancePct: query.maxAbsImbalancePct ?? null,
      maxLargestHolderPct: query.maxLargestHolderPct ?? null,
      minBalancedDisagreementScore: query.minBalancedDisagreementScore ?? null,
      contestedMinMinoritySideUsd: query.contestedMinMinoritySideUsd,
      contestedMinMinoritySideShare: query.contestedMinMinoritySideShare,
      contestedMinSideWallets: query.contestedMinSideWallets,
      contestedMaxLargestHolderPct: query.contestedMaxLargestHolderPct,
      eventShape: query.eventShape,
      minContestedMarketCount: query.minContestedMarketCount ?? null,
      minEventDisagreementScore: query.minEventDisagreementScore ?? null,
      minCrossMarketWallets: query.minCrossMarketWallets ?? null,
      mmMode: query.mmMode,
      includeHolders: query.includeHolders,
      holdersLimit: query.holdersLimit,
      holderSort: query.holderSort,
      includePositionPnl: query.includePositionPnl,
    },
    totals: {
      markets:
        input.rollup === "events" || input.rollup === "event-detail"
          ? walletFilteredMarkets.length
          : marketFilteredMarkets.length,
      events: sortedEvents.length,
      positions: rows.length,
    },
    items: page,
    event:
      input.rollup === "event-detail" ? (sortedEvents[0] ?? null) : undefined,
    hasMore:
      input.rollup === "events"
        ? query.offset + query.limit < sortedEvents.length
        : query.offset + query.limit < sortedMarkets.length,
    tree: includeTree
      ? {
          events:
            input.rollup === "events"
              ? page
              : sortedEvents.filter((event) =>
                  selectedMarkets.some(
                    (market) => market.eventId === event.eventId,
                  ),
                ),
          markets: selectedMarkets,
        }
      : undefined,
    graph: includeGraph
      ? buildPositioningGraph({
          markets: selectedMarkets,
          includeEvents: input.rollup !== "market-detail",
        })
      : undefined,
  };
}

const ATTRIBUTION_LABEL_TEXT: Record<WalletAttributionLabelKey, string> = {
  sports_specialist: "Sports Specialist",
  politics_specialist: "Politics Specialist",
  crypto_specialist: "Crypto Specialist",
  macro_specialist: "Macro Specialist",
  tech_specialist: "Tech Specialist",
  weather_specialist: "Weather Specialist",
  health_specialist: "Health Specialist",
  culture_specialist: "Culture Specialist",
  mentions_specialist: "Mentions Specialist",
  high_win_rate: "High Win Rate",
  high_conviction: "High Conviction",
  consistent_performer: "Consistent Performer",
  "100k_pnl": "100K+ PnL",
  "1m_pnl": "1M+ PnL",
  "10m_pnl": "10M+ PnL",
  large_positions: "Large Positions",
  market_mover: "Market Mover",
  fresh_wallet: "Fresh Wallet",
  dormant_wake_up: "Dormant Wake Up",
  late_entry: "Late Entry",
  close_to_settlement: "Close to Settlement",
  unusual_behavior: "Unusual Behavior",
  high_frequency: "High Frequency",
  volume_trader: "Volume Trader",
};

const PRIMARY_LABEL_TEXT: Record<
  Exclude<WalletPrimaryLabelKey, WalletAttributionLabelKey>,
  string
> = {
  potential_insider: "Potential Insider",
  bot: "Bot",
};

const BADGE_TEXT: Record<WalletPresentationBadgeKey, string> = {
  whale: "Whale",
  unusual_activity: "Unusual",
  hot_streak: "Hot Streak",
};

const SPECIALIST_HEADLINE_TAG_ORDER: WalletAttributionLabelKey[] = [
  "mentions_specialist",
  "crypto_specialist",
  "sports_specialist",
  "politics_specialist",
  "macro_specialist",
  "tech_specialist",
  "weather_specialist",
  "health_specialist",
  "culture_specialist",
];

const HEADLINE_TAG_PRIORITY: WalletAttributionLabelKey[] = [
  "market_mover",
  ...SPECIALIST_HEADLINE_TAG_ORDER,
  "high_conviction",
  "high_win_rate",
  "volume_trader",
  "high_frequency",
  "fresh_wallet",
  "dormant_wake_up",
  "late_entry",
  "close_to_settlement",
  "unusual_behavior",
];

const SECONDARY_LABEL_PRIORITY: WalletAttributionLabelKey[] = [
  "market_mover",
  "high_conviction",
  "high_win_rate",
  "consistent_performer",
  "fresh_wallet",
  "volume_trader",
  "high_frequency",
  "late_entry",
  "close_to_settlement",
  "dormant_wake_up",
  "unusual_behavior",
];

function buildWalletLabelSet(
  attribution: WalletAttribution | null | undefined,
): Set<WalletAttributionLabelKey> {
  return new Set([
    ...(attribution?.secondary ?? []),
    ...(attribution?.supporting ?? []),
  ]);
}

export function resolveWalletHeadlineTag(
  attribution: WalletAttribution | null | undefined,
): WalletHeadlineTag | null {
  if (!attribution) return null;

  const secondarySet = new Set(attribution.secondary ?? []);
  const supportingSet = new Set(attribution.supporting ?? []);

  const resolveFrom = (
    key: WalletAttributionLabelKey,
  ): WalletHeadlineTag | null => {
    if (secondarySet.has(key)) {
      return {
        key,
        label: ATTRIBUTION_LABEL_TEXT[key],
        source: "secondary",
      };
    }
    if (supportingSet.has(key)) {
      return {
        key,
        label: ATTRIBUTION_LABEL_TEXT[key],
        source: "supporting",
      };
    }
    return null;
  };

  if (attribution.primary === "specialist") {
    for (const key of SPECIALIST_HEADLINE_TAG_ORDER) {
      const specialistTag = resolveFrom(key);
      if (specialistTag) return specialistTag;
    }
  }

  for (const key of HEADLINE_TAG_PRIORITY) {
    const headlineTag = resolveFrom(key);
    if (headlineTag) return headlineTag;
  }

  return null;
}

export function resolveWalletTopLabelVariant(input: {
  attribution: WalletAttribution | null | undefined;
  metrics?: {
    roi?: string | number | null;
    pnl_usd?: string | number | null;
  } | null;
  lastActivityAt?: Date | null;
}): WalletTopLabelVariant | null {
  const labels = buildWalletLabelSet(input.attribution);
  const roi = nullableNumber(input.metrics?.roi);
  const pnlUsd = nullableNumber(input.metrics?.pnl_usd);

  if (labels.has("market_mover")) return "market-mover";
  if (
    labels.has("fresh_wallet") &&
    (labels.has("high_win_rate") ||
      labels.has("high_conviction") ||
      (roi != null && roi > 0) ||
      (pnlUsd != null && pnlUsd > 0))
  ) {
    return "rising-star";
  }
  if (
    (labels.has("high_win_rate") || labels.has("consistent_performer")) &&
    pnlUsd != null &&
    pnlUsd > 0 &&
    input.lastActivityAt != null
  ) {
    return "hot-streak";
  }
  if (labels.has("high_frequency") || labels.has("volume_trader")) {
    return "trending-trader";
  }
  return null;
}

function toPresentationLabel(
  key: WalletAttributionLabelKey | WalletPrimaryLabelKey,
): WalletPresentationLabel {
  return {
    key,
    label:
      key in ATTRIBUTION_LABEL_TEXT
        ? ATTRIBUTION_LABEL_TEXT[key as WalletAttributionLabelKey]
        : PRIMARY_LABEL_TEXT[
            key as Exclude<WalletPrimaryLabelKey, WalletAttributionLabelKey>
          ],
  };
}

function resolveSpecialistPrimaryLabel(
  attribution: WalletAttribution,
): WalletPresentationLabel | null {
  for (const key of SPECIALIST_HEADLINE_TAG_ORDER) {
    if (
      (attribution.secondary ?? []).includes(key) ||
      (attribution.supporting ?? []).includes(key)
    ) {
      return toPresentationLabel(key);
    }
  }
  return null;
}

export function resolveWalletPrimaryLabel(
  attribution: WalletAttribution | null | undefined,
): WalletPresentationLabel | null {
  if (!attribution) return null;

  if (attribution.primary === "insider") {
    return toPresentationLabel("potential_insider");
  }

  if (attribution.primary === "bot") {
    return toPresentationLabel("bot");
  }

  return resolveSpecialistPrimaryLabel(attribution);
}

export function resolveWalletSecondaryLabels(
  attribution: WalletAttribution | null | undefined,
  limit = 2,
): WalletPresentationLabel[] {
  if (!attribution) return [];
  const labelSet = buildWalletLabelSet(attribution);
  return SECONDARY_LABEL_PRIORITY.filter((key) => labelSet.has(key))
    .slice(0, Math.max(0, limit))
    .map((key) => toPresentationLabel(key));
}

export function resolveWalletAvgTradeSizeUsd(
  metrics: WalletMetricsRow | null | undefined,
): number | null {
  const volumeUsd = nullableNumber(metrics?.volume_usd);
  const tradesCount =
    metrics?.trades_count != null ? Number(metrics.trades_count) : null;
  if (volumeUsd == null || tradesCount == null || tradesCount <= 0) return null;
  return volumeUsd / tradesCount;
}

export function resolveWalletBadges(input: {
  attribution: WalletAttribution | null | undefined;
  tags: WalletTagRow[] | null | undefined;
  unusualTier: WalletActivitySummary["unusualTier"] | null | undefined;
  metrics?: {
    roi?: string | number | null;
    pnl_usd?: string | number | null;
  } | null;
  lastActivityAt?: Date | null;
}): WalletPresentationBadge[] {
  const badges: WalletPresentationBadge[] = [];
  const tagSet = new Set((input.tags ?? []).map((tag) => tag.slug));

  if (
    tagSet.has("whale") ||
    input.attribution?.primary === "whale" ||
    (input.attribution?.primaryCandidates ?? []).some(
      (candidate) => candidate.key === "whale",
    )
  ) {
    badges.push({ key: "whale", label: BADGE_TEXT.whale });
  }

  if (input.unusualTier) {
    badges.push({
      key: "unusual_activity",
      label: BADGE_TEXT.unusual_activity,
    });
  }

  if (
    resolveWalletTopLabelVariant({
      attribution: input.attribution,
      metrics: input.metrics,
      lastActivityAt: input.lastActivityAt,
    }) === "hot-streak"
  ) {
    badges.push({
      key: "hot_streak",
      label: BADGE_TEXT.hot_streak,
    });
  }

  return badges;
}

export function resolveEntryBracketKey(
  rawPrice: number | null | undefined,
): WalletEntryBracketKey | null {
  if (rawPrice == null || !Number.isFinite(rawPrice)) return null;
  const normalized =
    rawPrice > 1 && rawPrice <= 100 ? rawPrice / 100 : rawPrice;
  if (normalized < 0 || normalized > 1) return null;
  if (normalized < 0.2) return "0-20";
  if (normalized < 0.4) return "20-40";
  if (normalized < 0.6) return "40-60";
  if (normalized < 0.8) return "60-80";
  return "80-100";
}

const SUMMARY_DEPENDENT_PRIMARY_FILTERS = new Set<WalletAttributionPrimaryKey>([
  "insider",
]);
const SUMMARY_DEPENDENT_LABEL_FILTERS = new Set<WalletAttributionLabelKey>([
  "close_to_settlement",
  "dormant_wake_up",
  "late_entry",
  "unusual_behavior",
]);
const FAST_SIGNAL_REASON_FILTERS = new Set([
  "high_notional",
  "high_risk_longshot",
  "late_entry",
  "low_odds",
  "longshot_odds",
  "narrow_history",
  "reactivated_after_idle",
]);
const EXACT_ATTRIBUTION_SQL_LABEL_FILTERS = new Set<WalletAttributionLabelKey>([
  "high_conviction",
  "market_mover",
]);

function filtersRequireSummaryHydration(
  primaryFilters: WalletAttributionPrimaryKey[],
  labelFilters: WalletAttributionLabelKey[],
): boolean {
  return (
    primaryFilters.some((value) =>
      SUMMARY_DEPENDENT_PRIMARY_FILTERS.has(value),
    ) ||
    labelFilters.some((value) => SUMMARY_DEPENDENT_LABEL_FILTERS.has(value))
  );
}

function displayReasonFiltersSupportedByFastSignals(
  filters: string[],
): boolean {
  return filters.every((value) => FAST_SIGNAL_REASON_FILTERS.has(value));
}

function canUseExactAttributionSqlLabelFilter(
  primaryFilters: WalletAttributionPrimaryKey[],
  labelFilters: WalletAttributionLabelKey[],
): boolean {
  return (
    primaryFilters.length === 0 &&
    labelFilters.length > 0 &&
    labelFilters.every((value) =>
      EXACT_ATTRIBUTION_SQL_LABEL_FILTERS.has(value),
    )
  );
}

async function resolveWhaleTagId(client: PoolClient): Promise<string> {
  const result = await client.query<{ id: string }>(
    `select id from wallet_tags where slug = 'whale' limit 1`,
  );
  const whaleTagId = result.rows[0]?.id ?? null;
  if (!whaleTagId) {
    throw new Error("Missing wallet_tags.slug='whale' record");
  }
  return whaleTagId;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const size = Math.max(1, Math.trunc(chunkSize));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function walletIntelCacheKey(
  routeKey:
    | "wallets-profile"
    | "wallets-whales"
    | "wallets-activity-summary"
    | "wallets-activity-summary-stats"
    | "wallets-activity-signals"
    | "wallets-positions"
    | "wallets-positions-history",
  userId: string,
  query: unknown,
): string {
  const digest = createHash("sha1").update(JSON.stringify(query)).digest("hex");
  return `wallet-intel:v1:${routeKey}:${userId}:${digest}`;
}

type WalletIntelCacheClient = NonNullable<
  Awaited<ReturnType<typeof getRedisStatus>>["redis"]
>;
type WalletIntelCacheLayer = "local" | "redis";
type WalletIntelLocalCacheEntry = {
  body: string;
  expiresAt: number;
};

const walletIntelLocalCache = new Map<string, WalletIntelLocalCacheEntry>();
let walletIntelLocalCachePruneAt = 0;

function pruneWalletIntelLocalCache(now = Date.now()) {
  if (walletIntelLocalCachePruneAt > now) return;
  walletIntelLocalCachePruneAt = now + 30_000;
  for (const [key, entry] of walletIntelLocalCache.entries()) {
    if (entry.expiresAt <= now) walletIntelLocalCache.delete(key);
  }
}

function readWalletIntelLocalCache(cacheKey: string): string | null {
  const now = Date.now();
  pruneWalletIntelLocalCache(now);
  const entry = walletIntelLocalCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    walletIntelLocalCache.delete(cacheKey);
    return null;
  }
  return entry.body;
}

function writeWalletIntelLocalCache(
  cacheKey: string,
  body: string,
  ttlSec: number,
) {
  if (ttlSec <= 0) {
    walletIntelLocalCache.delete(cacheKey);
    return;
  }
  walletIntelLocalCache.set(cacheKey, {
    body,
    expiresAt: Date.now() + ttlSec * 1000,
  });
  pruneWalletIntelLocalCache();
}

async function readWalletIntelCachedBody(
  cacheClient: WalletIntelCacheClient | null,
  cacheKey: string,
  ttlSec: number,
): Promise<{ body: string; layer: WalletIntelCacheLayer } | null> {
  const localBody = readWalletIntelLocalCache(cacheKey);
  if (localBody) return { body: localBody, layer: "local" };
  if (!cacheClient) return null;
  try {
    const redisBody = await cacheClient.get(cacheKey);
    if (!redisBody) return null;
    writeWalletIntelLocalCache(cacheKey, redisBody, ttlSec);
    return { body: redisBody, layer: "redis" };
  } catch (error) {
    console.warn("[wallet-intel-cache] Redis read failed", String(error));
    return null;
  }
}

async function writeWalletIntelCachedBody(
  cacheClient: WalletIntelCacheClient | null,
  cacheKey: string,
  body: string,
  ttlSec: number,
) {
  if (ttlSec <= 0) return;
  writeWalletIntelLocalCache(cacheKey, body, ttlSec);
  if (!cacheClient) return;
  try {
    await cacheClient.set(cacheKey, body, { EX: ttlSec });
  } catch (error) {
    console.warn("[wallet-intel-cache] Redis write failed", String(error));
  }
}

function buildWalletIntelSelectorMetricsJsonSql(alias: string): string {
  return `
    case
      when ${alias}.metrics_as_of is not null
        or ${alias}.metrics_volume_30d is not null
        or ${alias}.metrics_pnl_30d is not null
        or ${alias}.metrics_trades_30d is not null
        or ${alias}.metrics_resolved_edge_sample_count_30d is not null
      then jsonb_build_object(
        'period', '30d',
        'as_of', ${alias}.metrics_as_of,
        'trades_count', ${alias}.metrics_trades_30d,
        'volume_usd', ${alias}.metrics_volume_30d,
        'pnl_usd', ${alias}.metrics_pnl_30d,
        'roi', ${alias}.metrics_roi_30d,
        'win_rate', ${alias}.metrics_win_rate_30d,
        'resolved_edge_sample_count', ${alias}.metrics_resolved_edge_sample_count_30d,
        'resolved_actual_win_rate', ${alias}.metrics_resolved_actual_win_rate_30d,
        'resolved_expected_win_rate', ${alias}.metrics_resolved_expected_win_rate_30d,
        'resolved_win_rate_edge', ${alias}.metrics_resolved_win_rate_edge_30d,
        'resolved_edge_z_score', ${alias}.metrics_resolved_edge_z_score_30d,
        'resolved_brier_score', ${alias}.metrics_resolved_brier_score_30d,
        'resolved_stake_weighted_edge', ${alias}.metrics_resolved_stake_weighted_edge_30d,
        'resolved_stake_usd', ${alias}.metrics_resolved_stake_usd_30d,
        'avg_hold_hours', ${alias}.metrics_avg_hold_hours_30d,
        'last_trade_at', ${alias}.metrics_last_trade_at_30d
      )
      else null
    end
  `;
}

function buildWalletIntelWhaleScoreSql(alias: string): string {
  return `
    case
      when w.chain = 'solana'
        then coalesce(nullif(${alias}.metrics_volume_30d, 0), ${alias}.exposure_usd, 0)
      else coalesce(${alias}.metrics_volume_30d, 0)
    end
  `;
}

function buildWalletOwnerResolutionJoinSql(includeDetails = false): string {
  const linkedOwnerAddressSql = `
    coalesce(
      w.metadata->>'ownerAddress',
      w.metadata->>'linkedOwnerAddress'
    )
  `;
  const ownerColumns = includeDetails
    ? `
          w2.address as owner_address,
          w2.label as owner_label,
          w2.id as owner_wallet_id`
    : `
          w2.address as owner_address`;
  const resolvedColumns = includeDetails
    ? `
          coalesce(
            linked_owner_evm.owner_address,
            linked_owner_exact.owner_address,
            safe_owner.owner_address
          ) as owner_address,
          coalesce(
            linked_owner_evm.owner_label,
            linked_owner_exact.owner_label,
            safe_owner.owner_label
          ) as owner_label,
          coalesce(
            linked_owner_evm.owner_wallet_id,
            linked_owner_exact.owner_wallet_id,
            safe_owner.owner_wallet_id
          ) as owner_wallet_id`
    : `
          coalesce(
            linked_owner_evm.owner_address,
            linked_owner_exact.owner_address,
            safe_owner.owner_address
          ) as owner_address`;

  return `
              left join lateral (
                select${ownerColumns}
                from wallets w2
                where w.chain <> 'solana'
                  and ${linkedOwnerAddressSql} ~* '^0x[0-9a-f]{40}$'
                  and w2.chain <> 'solana'
                  and w2.chain = w.chain
                  and lower(w2.address) = lower(${linkedOwnerAddressSql})
                limit 1
              ) linked_owner_evm on true
              left join lateral (
                select${ownerColumns}
                from wallets w2
                where ${linkedOwnerAddressSql} is not null
                  and (
                    w.chain = 'solana'
                    or ${linkedOwnerAddressSql} !~* '^0x[0-9a-f]{40}$'
                  )
                  and w2.chain = w.chain
                  and w2.address = ${linkedOwnerAddressSql}
                limit 1
              ) linked_owner_exact on true
              left join lateral (
                select${ownerColumns}
                from wallets w2
                where linked_owner_evm.owner_address is null
                  and linked_owner_exact.owner_address is null
                  and w.metadata->>'kind' = 'safe'
                  and w2.chain = w.chain
                  and w2.metadata->>'kind' = 'safe_owner'
                  and w2.metadata->>'derivedFrom' = w.address
                limit 1
              ) safe_owner on true
              left join lateral (
                select${resolvedColumns}
              ) owner on true`;
}

function buildSlimWhaleSelectorSql(
  orderBy: string,
  includeInferred: boolean,
  qualityFilter: WhaleQualityFilterSql = EMPTY_WHALE_QUALITY_FILTER,
): string {
  const inferredSelect = includeInferred
    ? `,
                inferred.wins as inferred_wins,
                inferred.total as inferred_total`
    : `,
                null::int as inferred_wins,
                null::int as inferred_total`;
  const inferredJoin = includeInferred
    ? `
              left join wallet_inferred_outcomes inferred on inferred.wallet_id = w.id`
    : "";
  if (qualityFilter.hasFilters) {
    return `
              with quality as materialized (
                select wis.*
                from wallet_intel_selector_snapshot wis
                where wis.last_activity_at >= now() - ($2::text || ' days')::interval
                  ${qualityFilter.selectorSql}
              )
              select
                w.id,
                w.address,
                w.chain,
                w.label,
                w.metadata,
                null::text as user_name,
                null::text as user_label_color,
                w.is_system_flagged,
                (w.metadata->>'kind' = 'safe') as is_safe,
                w.first_seen_at,
                w.last_seen_at,
                wis.metrics_volume_30d as metrics_volume,
                wis.metrics_pnl_30d as metrics_pnl,
                wis.metrics_roi_30d as metrics_roi,
                wis.metrics_trades_30d as metrics_trades,
                wis.metrics_win_rate_30d as metrics_win_rate,
                wis.metrics_resolved_edge_sample_count_30d as metrics_resolved_edge_sample_count,
                wis.metrics_resolved_actual_win_rate_30d as metrics_resolved_actual_win_rate,
                wis.metrics_resolved_expected_win_rate_30d as metrics_resolved_expected_win_rate,
                wis.metrics_resolved_win_rate_edge_30d as metrics_resolved_win_rate_edge,
                wis.metrics_resolved_edge_z_score_30d as metrics_resolved_edge_z_score,
                wis.metrics_resolved_brier_score_30d as metrics_resolved_brier_score,
                wis.metrics_resolved_stake_weighted_edge_30d as metrics_resolved_stake_weighted_edge,
                wis.metrics_resolved_stake_usd_30d as metrics_resolved_stake_usd,
                wis.exposure_usd,
                wis.hedged_notional_usd,
                wis.net_imbalance_usd,
                wis.hedge_ratio,
                wis.two_sided_markets,
                ${buildWalletIntelWhaleScoreSql("wis")} as whale_score,
                owner.owner_address,
                wis.last_activity_at,
                null::boolean as has_trade_activity,
                null::boolean as has_holder_activity${inferredSelect}
              from quality wis
              join wallet_tag_map tm on tm.wallet_id = wis.wallet_id
               and tm.tag_id = $3::uuid
              join wallets w on w.id = wis.wallet_id
              ${buildWalletOwnerResolutionJoinSql()}${inferredJoin}
              where true
                ${qualityFilter.inferredSql}
              order by ${orderBy}
              limit $1
            `;
  }
  return `
              select
                w.id,
                w.address,
                w.chain,
                w.label,
                w.metadata,
                null::text as user_name,
                null::text as user_label_color,
                w.is_system_flagged,
                (w.metadata->>'kind' = 'safe') as is_safe,
                w.first_seen_at,
                w.last_seen_at,
                wis.metrics_volume_30d as metrics_volume,
                wis.metrics_pnl_30d as metrics_pnl,
                wis.metrics_roi_30d as metrics_roi,
                wis.metrics_trades_30d as metrics_trades,
                wis.metrics_win_rate_30d as metrics_win_rate,
                wis.metrics_resolved_edge_sample_count_30d as metrics_resolved_edge_sample_count,
                wis.metrics_resolved_actual_win_rate_30d as metrics_resolved_actual_win_rate,
                wis.metrics_resolved_expected_win_rate_30d as metrics_resolved_expected_win_rate,
                wis.metrics_resolved_win_rate_edge_30d as metrics_resolved_win_rate_edge,
                wis.metrics_resolved_edge_z_score_30d as metrics_resolved_edge_z_score,
                wis.metrics_resolved_brier_score_30d as metrics_resolved_brier_score,
                wis.metrics_resolved_stake_weighted_edge_30d as metrics_resolved_stake_weighted_edge,
                wis.metrics_resolved_stake_usd_30d as metrics_resolved_stake_usd,
                wis.exposure_usd,
                wis.hedged_notional_usd,
                wis.net_imbalance_usd,
                wis.hedge_ratio,
                wis.two_sided_markets,
                ${buildWalletIntelWhaleScoreSql("wis")} as whale_score,
                owner.owner_address,
                wis.last_activity_at,
                null::boolean as has_trade_activity,
                null::boolean as has_holder_activity${inferredSelect}
              from wallets w
              join wallet_tag_map tm on tm.wallet_id = w.id
               and tm.tag_id = $3::uuid
              join wallet_intel_selector_snapshot wis on wis.wallet_id = w.id
              ${buildWalletOwnerResolutionJoinSql()}${inferredJoin}
              where wis.last_activity_at >= now() - ($2::text || ' days')::interval
              order by ${orderBy}
              limit $1
            `;
}

function buildSlimWhaleSelectorWithSnapshotShortlistSql(
  orderBy: string,
  includeInferred: boolean,
  qualityFilter: WhaleQualityFilterSql = EMPTY_WHALE_QUALITY_FILTER,
): string {
  const inferredSelect = includeInferred
    ? `,
                inferred.wins as inferred_wins,
                inferred.total as inferred_total`
    : `,
                null::int as inferred_wins,
                null::int as inferred_total`;
  const inferredJoin = includeInferred
    ? `
              left join wallet_inferred_outcomes inferred on inferred.wallet_id = w.id`
    : "";
  return `
              with shortlist as materialized (
                select
                  w.id,
                  wis.last_activity_at,
                  ${buildWalletIntelWhaleScoreSql("wis")} as whale_score
                from wallets w
                join wallet_tag_map tm on tm.wallet_id = w.id
                 and tm.tag_id = $3::uuid
                join wallet_intel_selector_snapshot wis on wis.wallet_id = w.id
                where wis.last_activity_at >= now() - ($4::text || ' days')::interval
                  ${qualityFilter.sql}
                order by
                  wis.last_activity_at desc nulls last,
                  whale_score desc nulls last,
                  w.last_seen_at desc
                limit $1
              )
              select
                w.id,
                w.address,
                w.chain,
                w.label,
                w.metadata,
                null::text as user_name,
                null::text as user_label_color,
                w.is_system_flagged,
                (w.metadata->>'kind' = 'safe') as is_safe,
                w.first_seen_at,
                w.last_seen_at,
                wis.metrics_volume_30d as metrics_volume,
                wis.metrics_pnl_30d as metrics_pnl,
                wis.metrics_roi_30d as metrics_roi,
                wis.metrics_trades_30d as metrics_trades,
                wis.metrics_win_rate_30d as metrics_win_rate,
                wis.metrics_resolved_edge_sample_count_30d as metrics_resolved_edge_sample_count,
                wis.metrics_resolved_actual_win_rate_30d as metrics_resolved_actual_win_rate,
                wis.metrics_resolved_expected_win_rate_30d as metrics_resolved_expected_win_rate,
                wis.metrics_resolved_win_rate_edge_30d as metrics_resolved_win_rate_edge,
                wis.metrics_resolved_edge_z_score_30d as metrics_resolved_edge_z_score,
                wis.metrics_resolved_brier_score_30d as metrics_resolved_brier_score,
                wis.metrics_resolved_stake_weighted_edge_30d as metrics_resolved_stake_weighted_edge,
                wis.metrics_resolved_stake_usd_30d as metrics_resolved_stake_usd,
                wis.exposure_usd,
                wis.hedged_notional_usd,
                wis.net_imbalance_usd,
                wis.hedge_ratio,
                wis.two_sided_markets,
                ${buildWalletIntelWhaleScoreSql("wis")} as whale_score,
                owner.owner_address,
                wis.last_activity_at,
                null::boolean as has_trade_activity,
                null::boolean as has_holder_activity${inferredSelect}
              from shortlist s
              join wallets w on w.id = s.id
              left join wallet_intel_selector_snapshot wis on wis.wallet_id = w.id
              ${buildWalletOwnerResolutionJoinSql()}${inferredJoin}
              where wis.last_activity_at >= now() - ($4::text || ' days')::interval
              order by ${orderBy}
              limit $2
            `;
}

type WhaleQualityFilterSql = {
  sql: string;
  selectorSql: string;
  inferredSql: string;
  params: Array<number>;
  hasFilters: boolean;
};

const EMPTY_WHALE_QUALITY_FILTER: WhaleQualityFilterSql = {
  sql: "",
  selectorSql: "",
  inferredSql: "",
  params: [],
  hasFilters: false,
};

function buildWhaleQualityFilterSql(
  query: {
    minTrades30d?: number;
    minResolvedCount?: number;
    minPnl30d?: number;
    minRoi30d?: number;
    minWinRate30d?: number;
    minResolvedEdgeSampleCount?: number;
    minResolvedStakeUsd?: number;
    minResolvedWinRateEdge30d?: number;
    minResolvedEdgeZScore30d?: number;
    maxResolvedBrierScore30d?: number;
    maxExposureUsd?: number;
    maxNetImbalanceUsd?: number;
  },
  startIndex: number,
): WhaleQualityFilterSql {
  const selectorClauses: string[] = [];
  const inferredClauses: string[] = [];
  const params: Array<number> = [];
  let idx = startIndex;

  if (query.minTrades30d != null) {
    selectorClauses.push(`coalesce(wis.metrics_trades_30d, 0) >= $${idx++}`);
    params.push(query.minTrades30d);
  }
  if (query.minResolvedCount != null) {
    inferredClauses.push(`coalesce(inferred.total, 0) >= $${idx++}`);
    params.push(query.minResolvedCount);
  }
  if (query.minPnl30d != null) {
    selectorClauses.push(`coalesce(wis.metrics_pnl_30d, 0) >= $${idx++}`);
    params.push(query.minPnl30d);
  }
  if (query.minRoi30d != null) {
    selectorClauses.push(`coalesce(wis.metrics_roi_30d, 0) >= $${idx++}`);
    params.push(query.minRoi30d);
  }
  if (query.minWinRate30d != null) {
    inferredClauses.push(
      `case when inferred.total > 0 then inferred.wins::float / inferred.total else null end >= $${idx++}`,
    );
    params.push(query.minWinRate30d);
  }
  if (query.minResolvedEdgeSampleCount != null) {
    selectorClauses.push(
      `coalesce(wis.metrics_resolved_edge_sample_count_30d, 0) >= $${idx++}`,
    );
    params.push(query.minResolvedEdgeSampleCount);
  }
  if (query.minResolvedStakeUsd != null) {
    selectorClauses.push(
      `coalesce(wis.metrics_resolved_stake_usd_30d, 0) >= $${idx++}`,
    );
    params.push(query.minResolvedStakeUsd);
  }
  if (query.minResolvedWinRateEdge30d != null) {
    selectorClauses.push(
      `coalesce(wis.metrics_resolved_win_rate_edge_30d, -1) >= $${idx++}`,
    );
    params.push(query.minResolvedWinRateEdge30d);
  }
  if (query.minResolvedEdgeZScore30d != null) {
    selectorClauses.push(
      `coalesce(wis.metrics_resolved_edge_z_score_30d, -1000000000) >= $${idx++}`,
    );
    params.push(query.minResolvedEdgeZScore30d);
  }
  if (query.maxResolvedBrierScore30d != null) {
    selectorClauses.push(
      `wis.metrics_resolved_brier_score_30d is not null and wis.metrics_resolved_brier_score_30d <= $${idx++}`,
    );
    params.push(query.maxResolvedBrierScore30d);
  }
  if (query.maxExposureUsd != null) {
    selectorClauses.push(`coalesce(wis.exposure_usd, 0) <= $${idx++}`);
    params.push(query.maxExposureUsd);
  }
  if (query.maxNetImbalanceUsd != null) {
    selectorClauses.push(
      `abs(coalesce(wis.net_imbalance_usd, 0)) <= $${idx++}`,
    );
    params.push(query.maxNetImbalanceUsd);
  }
  const clauses = [...selectorClauses, ...inferredClauses];

  return {
    sql: clauses.length ? `and ${clauses.join("\n                and ")}` : "",
    selectorSql: selectorClauses.length
      ? `and ${selectorClauses.join("\n                  and ")}`
      : "",
    inferredSql: inferredClauses.length
      ? `and ${inferredClauses.join("\n                and ")}`
      : "",
    params,
    hasFilters: clauses.length > 0,
  };
}

function resolveWalletActivityKind(
  hasTrade: boolean | null | undefined,
  hasHolder: boolean | null | undefined,
): WhaleWalletItem["activityKind"] {
  if (hasTrade && hasHolder) return "mixed";
  if (hasTrade) return "trade";
  if (hasHolder) return "holder";
  return null;
}

function mapWhaleRowToItem(
  row: WhaleSelectorRow,
  refreshPolicy: Awaited<
    ReturnType<typeof resolveWalletIntelRefreshPolicy>
  >["effective"],
): WhaleWalletItem {
  const mmDiagnostics =
    row.exposure_usd != null ||
    row.hedged_notional_usd != null ||
    row.net_imbalance_usd != null ||
    row.hedge_ratio != null ||
    row.two_sided_markets != null
      ? buildWalletMmDiagnostics({
          exposureUsd: nullableNumber(row.exposure_usd) ?? 0,
          hedgedNotionalUsd: nullableNumber(row.hedged_notional_usd) ?? 0,
          netImbalanceUsd: nullableNumber(row.net_imbalance_usd) ?? 0,
          hedgeRatio: nullableNumber(row.hedge_ratio) ?? 0,
          twoSidedMarkets: row.two_sided_markets ?? 0,
          chain: row.chain,
          refreshPolicy,
        })
      : null;
  return {
    walletId: row.id,
    address: row.address,
    chain: row.chain,
    label: row.label,
    userName: row.user_name ?? null,
    userLabel: row.user_label ?? null,
    userLabelColor: row.user_label_color ?? null,
    ...extractWalletIdentityDisplayFields(row.metadata, row.label),
    followersCount: null,
    isSystemFlagged: row.is_system_flagged,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    isFollowed: row.is_followed,
    tags: row.tags ?? [],
    metrics: row.metrics ?? null,
    portfolioPerformance30d: null,
    lastActivityAt: row.last_activity_at,
    activityKind: resolveWalletActivityKind(
      row.has_trade_activity,
      row.has_holder_activity,
    ),
    trackedExposureUsd: nullableNumber(row.exposure_usd),
    trackedHedgedNotionalUsd: nullableNumber(row.hedged_notional_usd),
    trackedNetImbalanceUsd: nullableNumber(row.net_imbalance_usd),
    trackedHedgeRatio: nullableNumber(row.hedge_ratio),
    trackedTwoSidedMarkets:
      row.two_sided_markets != null ? Number(row.two_sided_markets) : null,
    mmDiagnostics,
    approxPnlUsd: nullableNumber(row.metrics_pnl),
    approxPnlPeriod: "30d",
    inferredWinRate:
      row.inferred_total && row.inferred_total > 0 && row.inferred_wins != null
        ? Number(row.inferred_wins) / Number(row.inferred_total)
        : null,
    inferredResolvedCount:
      row.inferred_total != null ? Number(row.inferred_total) : null,
    isSafe: row.is_safe,
    ...emptyWalletOnchainFields({
      chain: row.chain,
      address: row.address,
      ownerAddress: row.owner_address,
      ownerWalletId: row.owner_wallet_id,
    }),
    ownerAddress: row.owner_address,
    ownerLabel: row.owner_label,
    ownerWalletId: row.owner_wallet_id,
    profile: row.profile ?? null,
    profileUpdatedAt: row.profile_updated_at ?? null,
    windowHours: null,
    netChangeUsd: null,
    netChangeYesUsd: null,
    netChangeNoUsd: null,
    countsNew: null,
    countsExit: null,
    countsIncrease: null,
    countsReduce: null,
    countsFlip: null,
    unusualScore: null,
    unusualTier: null,
    topChanges: [],
    topMarkets: [],
    topLabelVariant: null,
    headlineTag: null,
    primaryLabel: null,
    secondaryLabels: [],
    badges: [],
    avgTradeSizeUsd: null,
  };
}

function mapWhaleSlimRowToItem(
  row: WhaleSelectorSlimRow,
  refreshPolicy: Awaited<
    ReturnType<typeof resolveWalletIntelRefreshPolicy>
  >["effective"],
): WhaleWalletItem {
  return mapWhaleRowToItem(
    {
      ...row,
      is_followed: false,
      tags: [],
      metrics:
        row.metrics_volume != null ||
        row.metrics_pnl != null ||
        row.metrics_trades != null ||
        row.metrics_resolved_edge_sample_count != null
          ? {
              period: "30d",
              as_of: row.last_seen_at,
              trades_count: row.metrics_trades,
              volume_usd: row.metrics_volume,
              pnl_usd: row.metrics_pnl,
              roi: row.metrics_roi,
              win_rate: row.metrics_win_rate,
              resolved_edge_sample_count:
                row.metrics_resolved_edge_sample_count,
              resolved_actual_win_rate: row.metrics_resolved_actual_win_rate,
              resolved_expected_win_rate:
                row.metrics_resolved_expected_win_rate,
              resolved_win_rate_edge: row.metrics_resolved_win_rate_edge,
              resolved_edge_z_score: row.metrics_resolved_edge_z_score,
              resolved_brier_score: row.metrics_resolved_brier_score,
              resolved_stake_weighted_edge:
                row.metrics_resolved_stake_weighted_edge,
              resolved_stake_usd: row.metrics_resolved_stake_usd,
              avg_hold_hours: null,
              last_trade_at: null,
            }
          : null,
      profile: null,
      profile_updated_at: null,
      owner_label: null,
      owner_wallet_id: null,
      user_name: row.user_name ?? null,
      user_label: null,
      user_label_color: row.user_label_color ?? null,
    },
    refreshPolicy,
  );
}

function hydrateWhaleItemMetadata(
  item: WhaleWalletItem,
  row: WhalePageMetadataRow | null,
): WhaleWalletItem {
  if (!row) return item;
  return {
    ...item,
    label: row.label,
    userName: row.user_name ?? null,
    userLabel: row.user_label ?? null,
    userLabelColor: row.user_label_color ?? null,
    ...extractWalletIdentityDisplayFields(row.metadata, row.label),
    isSystemFlagged: row.is_system_flagged,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    isFollowed: row.is_followed,
    tags: row.tags ?? [],
    metrics: row.metrics ?? null,
    ownerAddress: row.owner_address ?? item.ownerAddress,
    ownerLabel: row.owner_label ?? null,
    ownerWalletId: row.owner_wallet_id ?? null,
    profile: row.profile ?? null,
    profileUpdatedAt: row.profile_updated_at ?? null,
  };
}

function hydrateWhaleItemFromSummary(
  item: WhaleWalletItem,
  summary: WalletActivitySummary | null,
  includeSummary: boolean,
  topMarkets: WhaleMarketItem[],
): WhaleWalletItem {
  if (!summary) {
    return {
      ...item,
      topMarkets,
    };
  }
  const summaryForResponse = includeSummary ? summary : null;
  return {
    ...item,
    lastActivityAt: summaryForResponse?.lastActivityAt ?? item.lastActivityAt,
    windowHours: summaryForResponse?.windowHours ?? null,
    netChangeUsd: summaryForResponse?.netChangeUsd ?? null,
    netChangeYesUsd: summaryForResponse?.netChangeYesUsd ?? null,
    netChangeNoUsd: summaryForResponse?.netChangeNoUsd ?? null,
    countsNew: summaryForResponse?.countsNew ?? null,
    countsExit: summaryForResponse?.countsExit ?? null,
    countsIncrease: summaryForResponse?.countsIncrease ?? null,
    countsReduce: summaryForResponse?.countsReduce ?? null,
    countsFlip: summaryForResponse?.countsFlip ?? null,
    unusualScore: summaryForResponse?.unusualScore ?? null,
    unusualTier: summaryForResponse?.unusualTier ?? null,
    topChanges: summaryForResponse?.topChanges ?? [],
    topMarkets,
  };
}

export function buildWalletAttributionInput(
  input: WalletAttributionInputSeed,
): {
  walletId: string;
  tags: WalletTagRow[];
  metrics: WalletMetricsRow | null;
  portfolioPnl30dUsd: number | null;
  inferredWinRate: number | null;
  inferredResolvedCount: number | null;
  trackedExposureUsd: number | null;
  topChanges: WalletActivityTopChange[];
  signalSummary: WalletActivitySignalSummary | null;
  mmSuspected: boolean | null;
} {
  return {
    walletId: input.walletId,
    tags: input.tags ?? [],
    metrics: input.metrics ?? null,
    portfolioPnl30dUsd: input.portfolioPnl30dUsd ?? null,
    inferredWinRate: input.inferredWinRate ?? null,
    inferredResolvedCount: input.inferredResolvedCount ?? null,
    trackedExposureUsd: input.trackedExposureUsd ?? null,
    topChanges: input.topChanges ?? [],
    signalSummary: input.signalSummary ?? null,
    mmSuspected: input.mmSuspected ?? null,
  };
}

type WalletSummaryMetricOverlay = Partial<
  Pick<
    WalletActivitySummaryStats,
    | "metricsPnl30d"
    | "metricsRoi30d"
    | "metricsTrades30d"
    | "metricsVolume30d"
    | "metricsWinRate30d"
    | "metricsResolvedEdgeSampleCount30d"
    | "metricsResolvedWinRateEdge30d"
    | "metricsResolvedEdgeZScore30d"
    | "metricsResolvedStakeUsd30d"
  >
>;

function metricNumberToString(value: number | null | undefined): string | null {
  return value != null && Number.isFinite(value) ? String(value) : null;
}

function mergeWalletSummaryMetrics(
  metrics: WalletMetricsRow | null,
  summary: WalletActivitySummary | WalletActivitySummaryStats,
  asOfFallback: Date,
): WalletMetricsRow | null {
  const overlay = summary as WalletSummaryMetricOverlay;
  const hasOverlayMetrics =
    overlay.metricsPnl30d != null ||
    overlay.metricsRoi30d != null ||
    overlay.metricsTrades30d != null ||
    overlay.metricsVolume30d != null ||
    overlay.metricsWinRate30d != null ||
    overlay.metricsResolvedEdgeSampleCount30d != null ||
    overlay.metricsResolvedWinRateEdge30d != null ||
    overlay.metricsResolvedEdgeZScore30d != null ||
    overlay.metricsResolvedStakeUsd30d != null;

  if (!hasOverlayMetrics) return metrics ?? null;

  return {
    period: metrics?.period ?? "30d",
    as_of: metrics?.as_of ?? asOfFallback,
    trades_count: metrics?.trades_count ?? overlay.metricsTrades30d ?? null,
    volume_usd:
      metrics?.volume_usd ?? metricNumberToString(overlay.metricsVolume30d),
    pnl_usd: metrics?.pnl_usd ?? metricNumberToString(overlay.metricsPnl30d),
    roi: metrics?.roi ?? metricNumberToString(overlay.metricsRoi30d),
    win_rate:
      metrics?.win_rate ?? metricNumberToString(overlay.metricsWinRate30d),
    resolved_edge_sample_count:
      metrics?.resolved_edge_sample_count ??
      overlay.metricsResolvedEdgeSampleCount30d ??
      null,
    resolved_actual_win_rate: metrics?.resolved_actual_win_rate ?? null,
    resolved_expected_win_rate: metrics?.resolved_expected_win_rate ?? null,
    resolved_win_rate_edge:
      metrics?.resolved_win_rate_edge ??
      metricNumberToString(overlay.metricsResolvedWinRateEdge30d),
    resolved_edge_z_score:
      metrics?.resolved_edge_z_score ??
      metricNumberToString(overlay.metricsResolvedEdgeZScore30d),
    resolved_brier_score: metrics?.resolved_brier_score ?? null,
    resolved_stake_weighted_edge:
      metrics?.resolved_stake_weighted_edge ?? null,
    resolved_stake_usd:
      metrics?.resolved_stake_usd ??
      metricNumberToString(overlay.metricsResolvedStakeUsd30d),
    avg_hold_hours: metrics?.avg_hold_hours ?? null,
    last_trade_at: metrics?.last_trade_at ?? null,
    winning_count: metrics?.winning_count ?? null,
    losing_count: metrics?.losing_count ?? null,
    resolved_count: metrics?.resolved_count ?? null,
  };
}

export function buildWalletSummaryItem(
  row: CandidateWalletRow,
  summary: WalletActivitySummary | WalletActivitySummaryStats,
  options?: {
    followersCount?: number | null;
    topChanges?: WalletActivityTopChange[] | null;
    openPositionStats?: WalletOpenPositionOverlay | null;
    portfolioPerformance30d?: WalletPortfolioPerformance | null;
  },
): WalletActivitySummaryItem {
  const openPositionStats = options?.openPositionStats ?? null;
  return {
    walletId: row.id,
    address: row.address,
    chain: row.chain,
    label: row.label,
    userName: row.user_name ?? null,
    userLabel: row.user_label ?? null,
    userLabelColor: row.user_label_color ?? null,
    ...extractWalletIdentityDisplayFields(row.metadata, row.label),
    followersCount: options?.followersCount ?? null,
    isSystemFlagged: row.is_system_flagged,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    tags: row.tags ?? [],
    metrics: mergeWalletSummaryMetrics(
      row.metrics ?? null,
      summary,
      row.last_seen_at,
    ),
    portfolioPerformance30d: options?.portfolioPerformance30d ?? null,
    inferredWinRate: null,
    inferredResolvedCount: null,
    profile: row.profile ?? null,
    profileUpdatedAt: row.profile_updated_at ?? null,
    windowHours: summary.windowHours,
    lastActivityAt: summary.lastActivityAt,
    netChangeUsd: summary.netChangeUsd,
    netChangeYesUsd: summary.netChangeYesUsd,
    netChangeNoUsd: summary.netChangeNoUsd,
    countsNew: summary.countsNew,
    countsExit: summary.countsExit,
    countsIncrease: summary.countsIncrease,
    countsReduce: summary.countsReduce,
    countsFlip: summary.countsFlip,
    unusualScore: summary.unusualScore,
    unusualTier: summary.unusualTier,
    topChanges: options?.topChanges ?? [],
    topLabelVariant: null,
    headlineTag: null,
    primaryLabel: null,
    secondaryLabels: [],
    badges: [],
    avgTradeSizeUsd: null,
    trackedExposureUsd: openPositionStats?.trackedExposureUsd ?? null,
    openPositionsCount: openPositionStats?.openPositionsCount ?? null,
    openMarketsCount: openPositionStats?.openMarketsCount ?? null,
    avgOpenPositionSizeUsd: openPositionStats?.avgOpenPositionSizeUsd ?? null,
    avgOpenEntryPrice: openPositionStats?.avgOpenEntryPrice ?? null,
    avgOpenEntryApprox: openPositionStats?.avgOpenEntryApprox ?? null,
  };
}

function isSafeLocalWorkMem(value: string): boolean {
  return /^[1-9][0-9]*(kB|MB|GB)$/i.test(value);
}

async function withWalletIntelQuerySettings<T>(
  client: PoolClient,
  options: {
    workMem?: string | null;
    disableJit?: boolean;
  },
  task: () => Promise<T>,
): Promise<T> {
  const workMem = options.workMem ?? null;
  const disableJit = options.disableJit ?? true;
  if (!workMem && !disableJit) {
    return task();
  }

  await client.query("BEGIN");
  try {
    if (disableJit) {
      await client.query("SET LOCAL jit = off");
    }
    if (workMem) {
      if (!isSafeLocalWorkMem(workMem)) {
        throw new Error(`Unsafe local work_mem value: ${workMem}`);
      }
      await client.query(`SET LOCAL work_mem = '${workMem}'`);
    }
    const result = await task();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failures on broken connections
    }
    throw error;
  }
}

export const walletPositionRouteQuerySettings = {
  workMem: "48MB",
  disableJit: true,
} as const;

type WalletIntelCacheStatusResult = Awaited<ReturnType<typeof getRedisStatus>>;

async function resolveWalletIntelCacheContext(
  ttlSec: number,
): Promise<WalletIntelCacheStatusResult> {
  if (ttlSec <= 0) {
    return { redis: null, status: "disabled" };
  }
  return getRedisStatus();
}

function applyWalletIntelCacheHeaders(input: {
  reply: FastifyReply;
  hit: boolean;
  layer?: WalletIntelCacheLayer | "none";
  cacheStatus: WalletIntelCacheStatusResult["status"];
}) {
  input.reply.header("x-cache", input.hit ? "hit" : "miss");
  input.reply.header("x-cache-layer", input.layer ?? "none");
  input.reply.header("x-cache-status", input.cacheStatus);
}

function signalMatchesFilters(
  item: WalletActivitySignalItem,
  filters: {
    severity?: string[];
    displayReasons?: string[];
    signalReasonMode: "any" | "all";
  },
): boolean {
  const severity = normalizeStringArray(filters.severity);
  if (severity.length > 0 && !severity.includes(item.severity)) return false;
  const reasonFilters = normalizeStringArray(filters.displayReasons);
  if (reasonFilters.length > 0) {
    const reasonSet = new Set(
      item.displayReasons.map((value) => value.toLowerCase()),
    );
    const mode = filters.signalReasonMode;
    const matched =
      mode === "all"
        ? reasonFilters.every((value) => reasonSet.has(value))
        : reasonFilters.some((value) => reasonSet.has(value));
    if (!matched) return false;
  }
  return true;
}

function buildSignalItemLabels(
  pageLabels: WalletActivitySignalPageLabelFlags | null,
): string[] {
  if (!pageLabels) return [];
  return [
    ...(pageLabels.unusualSize ? ["unusual_size"] : []),
    ...(pageLabels.onPattern ? ["on_pattern"] : []),
    ...(pageLabels.hasProfileCategories &&
    !pageLabels.onPattern &&
    pageLabels.category
      ? ["out_of_pattern"]
      : []),
  ];
}

function buildAugmentedSignalItemLabels(
  baseLabels: string[],
  walletTags: WalletTagRow[] | null | undefined,
): string[] {
  const labels = new Set(baseLabels);
  if ((walletTags ?? []).some((tag) => tag.slug === "fresh")) {
    labels.add("fresh_wallet");
  }
  return Array.from(labels);
}

export function buildWalletSignalItemFromSignalRow(input: {
  candidate: CandidateWalletRow;
  signalRow: WalletActivitySignalRow;
  mmDiagnostics: WalletMmDiagnostics | null;
  pageLabels: WalletActivitySignalPageLabelFlags | null;
  attributionPolicy: Awaited<
    ReturnType<typeof resolveWalletIntelAttributionPolicy>
  >["effective"];
}): WalletActivitySignalItem {
  const labels = buildAugmentedSignalItemLabels(
    buildSignalItemLabels(input.pageLabels),
    input.candidate.tags,
  );
  const signalPresentation = buildSignalPresentation({
    signalLabels: input.signalRow.reasonCodes,
    labels,
    signalScore: input.signalRow.signalScore,
    venue: input.signalRow.venue,
    policy: input.attributionPolicy,
  });
  return {
    walletId: input.signalRow.walletId,
    address: input.candidate.address,
    chain: input.candidate.chain,
    label: input.candidate.label,
    userName: input.candidate.user_name ?? null,
    userLabel: input.candidate.user_label ?? null,
    userLabelColor: input.candidate.user_label_color ?? null,
    ...extractWalletIdentityDisplayFields(
      input.candidate.metadata,
      input.candidate.label,
    ),
    isSystemFlagged: input.candidate.is_system_flagged,
    firstSeenAt: input.candidate.first_seen_at,
    lastSeenAt: input.candidate.last_seen_at,
    tags: input.candidate.tags ?? [],
    metrics: input.candidate.metrics ?? null,
    inferredWinRate: null,
    inferredResolvedCount: null,
    profile: input.candidate.profile ?? null,
    profileUpdatedAt: input.candidate.profile_updated_at ?? null,
    marketId: input.signalRow.marketId,
    marketTitle: input.signalRow.marketTitle,
    outcomes: input.signalRow.outcomes,
    marketImage: input.signalRow.marketImage,
    marketIcon: input.signalRow.marketIcon,
    eventId: input.signalRow.eventId,
    eventTitle: input.signalRow.eventTitle,
    eventImage: input.signalRow.eventImage,
    eventIcon: input.signalRow.eventIcon,
    venue: input.signalRow.venue,
    marketStatus: input.signalRow.marketStatus,
    closeTime: input.signalRow.closeTime,
    expirationTime: input.signalRow.expirationTime,
    resolvedOutcome: input.signalRow.resolvedOutcome,
    acceptingOrders: input.signalRow.acceptingOrders,
    category: input.signalRow.category,
    action: input.signalRow.action,
    positionSide: input.signalRow.positionSide,
    deltaShares: input.signalRow.deltaShares,
    deltaUsd: input.signalRow.deltaUsd,
    stakeUsd: input.signalRow.stakeUsd,
    odds: input.signalRow.odds,
    potentialPayoutUsd: input.signalRow.potentialPayoutUsd,
    idleDays: input.signalRow.idleDays,
    priorDistinctMarkets: input.signalRow.priorDistinctMarkets,
    signalScore: input.signalRow.signalScore,
    signalType: input.signalRow.signalType,
    lateBucket: input.signalRow.lateBucket,
    labels,
    signalLabels: input.signalRow.reasonCodes,
    reasonCodes: signalPresentation.reasonCodes,
    displayReasons: signalPresentation.displayReasons,
    severity: signalPresentation.severity,
    mmDiagnostics: input.mmDiagnostics,
    occurredAt: input.signalRow.occurredAt,
  };
}

export function buildWalletSignalItemFromTopChange(input: {
  candidate: CandidateWalletRow;
  change: WalletActivityTopChange;
  mmDiagnostics: WalletMmDiagnostics | null;
  attributionPolicy: Awaited<
    ReturnType<typeof resolveWalletIntelAttributionPolicy>
  >["effective"];
}): WalletActivitySignalItem {
  const labels = buildAugmentedSignalItemLabels(
    input.change.labels ?? [],
    input.candidate.tags,
  );
  const signalLabels = input.change.signalLabels ?? [];
  const signalPresentation = buildSignalPresentation({
    signalLabels,
    labels,
    signalScore: input.change.signalScore ?? null,
    venue: input.change.venue,
    policy: input.attributionPolicy,
  });
  return {
    walletId: input.candidate.id,
    address: input.candidate.address,
    chain: input.candidate.chain,
    label: input.candidate.label,
    userName: input.candidate.user_name ?? null,
    userLabel: input.candidate.user_label ?? null,
    userLabelColor: input.candidate.user_label_color ?? null,
    ...extractWalletIdentityDisplayFields(
      input.candidate.metadata,
      input.candidate.label,
    ),
    isSystemFlagged: input.candidate.is_system_flagged,
    firstSeenAt: input.candidate.first_seen_at,
    lastSeenAt: input.candidate.last_seen_at,
    tags: input.candidate.tags ?? [],
    metrics: input.candidate.metrics ?? null,
    inferredWinRate: null,
    inferredResolvedCount: null,
    profile: input.candidate.profile ?? null,
    profileUpdatedAt: input.candidate.profile_updated_at ?? null,
    marketId: input.change.marketId,
    marketTitle: input.change.marketTitle ?? null,
    outcomes: input.change.outcomes ?? null,
    marketImage: input.change.marketImage ?? null,
    marketIcon: input.change.marketIcon ?? null,
    eventId: input.change.eventId ?? null,
    eventTitle: input.change.eventTitle ?? null,
    eventImage: input.change.eventImage ?? null,
    eventIcon: input.change.eventIcon ?? null,
    venue: input.change.venue,
    marketStatus: input.change.marketStatus ?? null,
    closeTime: input.change.closeTime ?? null,
    expirationTime: input.change.expirationTime ?? null,
    resolvedOutcome: input.change.resolvedOutcome ?? null,
    acceptingOrders: input.change.acceptingOrders ?? null,
    category: input.change.category ?? null,
    action: input.change.action ?? null,
    positionSide: input.change.positionSide ?? null,
    deltaShares: input.change.deltaShares ?? null,
    deltaUsd: input.change.deltaUsd ?? null,
    stakeUsd: input.change.stakeUsd ?? null,
    odds: input.change.odds ?? null,
    potentialPayoutUsd: input.change.potentialPayoutUsd ?? null,
    idleDays: input.change.idleDays ?? null,
    priorDistinctMarkets: input.change.priorDistinctMarkets ?? null,
    signalScore: input.change.signalScore ?? null,
    signalType: input.change.signalType,
    lateBucket: input.change.lateBucket ?? null,
    labels,
    signalLabels,
    reasonCodes: signalPresentation.reasonCodes,
    displayReasons: signalPresentation.displayReasons,
    severity: signalPresentation.severity,
    mmDiagnostics: input.mmDiagnostics,
    occurredAt: input.change.occurredAt,
  };
}

async function enrichWalletSignalItemsWithPositionNow(
  client: PoolClient,
  items: WalletActivitySignalItem[],
): Promise<WalletActivitySignalItem[]> {
  if (items.length === 0) return items;

  const positionNowByKey = await loadLatestWalletPositionNowMap(
    client,
    items.map((item) => ({
      walletId: item.walletId,
      venue: item.venue,
      marketId: item.marketId,
      outcomeSide: item.positionSide,
    })),
  );

  return items.map((item) => ({
    ...item,
    positionNow:
      positionNowByKey.get(
        makeWalletPositionLedgerKey(
          item.walletId,
          item.marketId,
          item.positionSide,
        ),
      ) ?? null,
  }));
}

export function signalItemToTopChange(
  item: WalletActivitySignalItem,
): WalletActivityTopChange {
  return {
    marketId: item.marketId,
    marketTitle: item.marketTitle,
    marketImage: item.marketImage,
    marketIcon: item.marketIcon,
    eventId: item.eventId,
    eventTitle: item.eventTitle,
    eventImage: item.eventImage,
    eventIcon: item.eventIcon,
    venue: item.venue,
    marketStatus: item.marketStatus,
    closeTime: item.closeTime,
    expirationTime: item.expirationTime,
    resolvedOutcome: item.resolvedOutcome,
    acceptingOrders: item.acceptingOrders,
    outcomes: item.outcomes,
    category: item.category,
    action: item.action,
    positionSide: item.positionSide,
    deltaShares: item.deltaShares,
    deltaUsd: item.deltaUsd,
    price: null,
    odds: item.odds,
    stakeUsd: item.stakeUsd,
    potentialPayoutUsd: item.potentialPayoutUsd,
    idleDays: item.idleDays,
    priorDistinctMarkets: item.priorDistinctMarkets,
    signalScore: item.signalScore,
    signalLabels: item.signalLabels,
    signalType: item.signalType,
    lateBucket: item.lateBucket,
    labels: item.labels,
    occurredAt: item.occurredAt,
  };
}

function createEmptySignalSummary(): WalletActivitySignalSummary {
  return {
    criticalSignals30d: 0,
    avgSignalScore30d: null,
    hasReactivatedAfterIdle: false,
    hasLateEntry: false,
    hasVeryLateEntry: false,
    hasUnusualBehavior: false,
  };
}

function buildSignalSummaryFromItems(
  items: WalletActivitySignalItem[],
): WalletActivitySignalSummary {
  const signalScores = items
    .map((item) => item.signalScore)
    .filter(
      (value): value is number => value != null && Number.isFinite(value),
    );
  const summary = createEmptySignalSummary();
  summary.criticalSignals30d = signalScores.filter(
    (score) => score >= 0.9,
  ).length;
  summary.avgSignalScore30d =
    signalScores.length > 0
      ? signalScores.reduce((sum, value) => sum + value, 0) /
        signalScores.length
      : null;

  for (const item of items) {
    const reasonCodes = new Set([
      ...item.signalLabels,
      ...item.labels,
      ...item.reasonCodes,
    ]);
    summary.hasReactivatedAfterIdle =
      summary.hasReactivatedAfterIdle ||
      reasonCodes.has("reactivated_after_idle");
    summary.hasLateEntry =
      summary.hasLateEntry ||
      reasonCodes.has("entered_late") ||
      item.lateBucket === "late" ||
      item.lateBucket === "very_late";
    summary.hasVeryLateEntry =
      summary.hasVeryLateEntry || item.lateBucket === "very_late";
    summary.hasUnusualBehavior =
      summary.hasUnusualBehavior ||
      reasonCodes.has("unusual_size") ||
      reasonCodes.has("out_of_pattern") ||
      reasonCodes.has("high_risk_longshot");
  }

  return summary;
}

export function buildWalletAttributionInputMapFromSignalItems(
  items: WalletActivitySignalItem[],
): Map<string, ReturnType<typeof buildWalletAttributionInput>> {
  const groupedItems = new Map<string, WalletActivitySignalItem[]>();
  for (const item of items) {
    const current = groupedItems.get(item.walletId) ?? [];
    current.push(item);
    groupedItems.set(item.walletId, current);
  }

  const byWallet = new Map<
    string,
    ReturnType<typeof buildWalletAttributionInput>
  >();
  for (const [walletId, walletItems] of groupedItems) {
    const first = walletItems[0];
    if (!first) continue;
    byWallet.set(
      walletId,
      buildWalletAttributionInput({
        walletId,
        tags: first.tags,
        metrics: first.metrics,
        inferredWinRate: null,
        inferredResolvedCount: null,
        trackedExposureUsd: null,
        topChanges: [],
        signalSummary: buildSignalSummaryFromItems(walletItems),
        mmSuspected: walletItems.some(
          (item) => item.mmDiagnostics?.mmSuspected === true,
        ),
      }),
    );
  }
  return byWallet;
}

function applyWalletResponsePresentation<
  T extends {
    walletId: string;
    metrics: WalletMetricsRow | null;
    lastActivityAt: Date | null;
    tags: WalletTagRow[];
    unusualTier: WalletActivitySummary["unusualTier"] | null;
  },
>(
  item: T,
  options: {
    includeAttributionInResponse: boolean;
    attributionMap: Map<string, WalletAttribution>;
  },
): Omit<T, "metrics"> & {
  attribution?: WalletAttribution;
  metrics: WalletMetricsResponse | null;
  topLabelVariant: WalletTopLabelVariant | null;
  headlineTag: WalletHeadlineTag | null;
  primaryLabel: WalletPresentationLabel | null;
  secondaryLabels: WalletPresentationLabel[];
  badges: WalletPresentationBadge[];
  avgTradeSizeUsd: number | null;
} {
  const attribution = options.attributionMap.get(item.walletId);
  const withAttribution = options.includeAttributionInResponse
    ? { ...item, attribution }
    : item;
  return serializeWalletResponseItem(
    applyWalletPresentationFields(withAttribution, attribution),
  );
}

function buildSignalRowLabelKey(input: {
  walletId: string;
  venue: string;
  marketId: string;
  positionSide: string | null;
}): string {
  return [
    input.walletId,
    input.venue,
    input.marketId,
    input.positionSide ?? "",
  ].join(":");
}

export function shouldReturnFilterTooBroad(input: {
  filteredCount: number;
  requestedOffset: number;
  requestedLimit: number;
  hitScanCap: boolean;
  hasMoreCandidates: boolean;
}): boolean {
  const needed = input.requestedOffset + input.requestedLimit;
  if (!input.hitScanCap || !input.hasMoreCandidates) return false;
  return input.filteredCount < needed;
}

async function loadFollowingWalletIds(
  client: PoolClient,
  userId: string | null,
): Promise<string[]> {
  if (!userId) return [];
  const rows = await client.query<{ wallet_id: string }>(
    `select wallet_id from wallet_follows where user_id = $1`,
    [userId],
  );
  return rows.rows.map((row) => row.wallet_id);
}

async function loadActiveWalletIds(
  client: PoolClient,
  windowHours: number,
  activityThresholds?: {
    minActivityUsd: number;
    minActivityShares: number;
  },
): Promise<string[]> {
  const minActivityUsd =
    activityThresholds?.minActivityUsd ?? env.walletIntelMinActivityUsd;
  const minActivityShares =
    activityThresholds?.minActivityShares ?? env.walletIntelMinActivityShares;
  const rows = await client.query<{ wallet_id: string }>(
    `
      select wah.wallet_id
      from wallet_activity_hourly wah
      where wah.activity_type in ('delta', 'trade')
        and wah.hour_bucket >= now() - ($1::text || ' hours')::interval
      group by wah.wallet_id
      having (
        $2::numeric <= 0
        and $3::numeric <= 0
      )
      or coalesce(sum(abs(wah.signed_delta_usd)), 0) >= $2::numeric
      or coalesce(sum(abs(wah.signed_delta_shares)), 0) >= $3::numeric
    `,
    [windowHours, minActivityUsd, minActivityShares],
  );
  return rows.rows.map((row) => row.wallet_id);
}

async function loadWhaleWalletIds(client: PoolClient): Promise<string[]> {
  const whaleTagId = await resolveWhaleTagId(client);
  const rows = await client.query<{ wallet_id: string }>(
    `
      select tm.wallet_id
      from wallet_tag_map tm
      where tm.tag_id = $1::uuid
    `,
    [whaleTagId],
  );
  return rows.rows.map((row) => row.wallet_id);
}

async function filterWalletIdsByMetadata(
  client: PoolClient,
  walletIds: string[],
  filters: {
    categories?: string[] | null;
    tags?: string[] | null;
    tagMode?: "any" | "all";
  },
): Promise<string[]> {
  if (walletIds.length === 0) return [];
  const categoryFilter =
    filters.categories && filters.categories.length > 0
      ? filters.categories
      : null;
  const tagsFilter =
    filters.tags && filters.tags.length > 0 ? filters.tags : null;
  if (!categoryFilter && !tagsFilter) return walletIds;
  const rows = await client.query<{ wallet_id: string }>(
    `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      ),
      tag_matches as (
        select
          ws.wallet_id,
          count(
            distinct case
              when $3::text[] is not null and t.slug = any($3::text[])
                then t.slug
              else null
            end
          )::int as matched_tag_count
        from wallet_set ws
        left join wallet_tag_map tm on tm.wallet_id = ws.wallet_id
        left join wallet_tags t on t.id = tm.tag_id
        group by ws.wallet_id
      )
      select ws.wallet_id
      from wallet_set ws
      left join wallet_profiles wp on wp.wallet_id = ws.wallet_id
      left join tag_matches tm on tm.wallet_id = ws.wallet_id
      where (
        $2::text[] is null
        or coalesce(wp.profile->'categories', '[]'::jsonb) ?| $2::text[]
      )
        and (
          $3::text[] is null
          or (
            lower($4::text) = 'all'
            and coalesce(tm.matched_tag_count, 0) >= cardinality($3::text[])
          )
          or (
            lower($4::text) <> 'all'
            and coalesce(tm.matched_tag_count, 0) > 0
          )
        )
    `,
    [walletIds, categoryFilter, tagsFilter, filters.tagMode ?? "any"],
  );
  return rows.rows.map((row) => row.wallet_id);
}

async function filterWalletIdsByActivitySummarySearch(
  client: PoolClient,
  userId: string | null,
  walletIds: string[],
  filters: {
    q?: string | null;
    marketId?: string | null;
    eventId?: string | null;
    windowHours: number;
  },
): Promise<string[]> {
  if (walletIds.length === 0) return [];
  const rawQuery = filters.q?.trim() ?? "";
  const terms = extractSearchTerms(rawQuery);
  const hasRawQuery = rawQuery.length > 0;
  const hasQuery = terms.length > 0;
  const marketId = filters.marketId?.trim() || null;
  const eventId = filters.eventId?.trim() || null;
  const hasReferenceFilter = marketId != null || eventId != null;
  if (hasRawQuery && !hasQuery) return [];
  if (!hasQuery && !hasReferenceFilter) return walletIds;

  const walletDocumentSql = `
    concat_ws(
      ' ',
      w.address,
      w.label,
      wl.label,
      wn.name,
      w.metadata #>> '{identityNames,primary,name}',
      w.metadata #>> '{identityNames,polymarket,username}',
      w.metadata #>> '{identityNames,polymarket,pseudonym}',
      w.metadata #>> '{identityNames,ens,name}',
      wp.profile->>'label',
      wp.profile->>'label_short'
    )
  `;
  const marketDocumentSql = `
    concat_ws(
      ' ',
      um.id,
      um.title,
      um.slug,
      um.description,
      um.category,
      um.outcomes::text,
      ue.id,
      ue.title,
      ue.slug,
      ue.description,
      ue.category
    )
  `;
  const walletQueryMatchSql = hasQuery
    ? buildAllSearchTermsMatchSql(walletDocumentSql, "$6")
    : "false";
  const marketQueryMatchSql = hasQuery
    ? buildAllSearchTermsMatchSql(marketDocumentSql, "$6")
    : "true";

  const rows = await client.query<{ wallet_id: string }>(
    `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      )
      select ws.wallet_id
      from wallet_set ws
      join wallets w on w.id = ws.wallet_id
      left join wallet_user_labels wl
        on wl.wallet_id = w.id
       and wl.user_id = $2::uuid
      left join wallet_user_names wn
        on wn.wallet_id = w.id
       and wn.user_id = $2::uuid
      left join wallet_profiles wp on wp.wallet_id = w.id
      where (
        (
          $4::text is null
          and $5::text is null
        )
        or exists (
          select 1
          from wallet_activity_hourly wah
          join unified_markets um on um.id = wah.market_id
          left join unified_events ue on ue.id = um.event_id
          where wah.wallet_id = ws.wallet_id
            and wah.activity_type in ('delta', 'trade')
            and wah.hour_bucket >= now() - ($3::text || ' hours')::interval
            and ($4::text is null or wah.market_id = $4::text)
            and ($5::text is null or um.event_id = $5::text)
        )
      )
      and (
        cardinality($6::text[]) = 0
        or ${walletQueryMatchSql}
        or exists (
          select 1
          from wallet_activity_hourly wah
          join unified_markets um on um.id = wah.market_id
          left join unified_events ue on ue.id = um.event_id
          where wah.wallet_id = ws.wallet_id
            and wah.activity_type in ('delta', 'trade')
            and wah.hour_bucket >= now() - ($3::text || ' hours')::interval
            and ($4::text is null or wah.market_id = $4::text)
            and ($5::text is null or um.event_id = $5::text)
            and ${marketQueryMatchSql}
        )
      )
    `,
    [walletIds, userId, filters.windowHours, marketId, eventId, terms],
  );
  return rows.rows.map((row) => row.wallet_id);
}

async function filterWalletIdsByMmExclusion(
  client: PoolClient,
  walletIds: string[],
  refreshPolicy: Awaited<
    ReturnType<typeof resolveWalletIntelRefreshPolicy>
  >["effective"],
): Promise<string[]> {
  if (walletIds.length === 0) return [];
  const rows = await client.query<{ wallet_id: string }>(
    `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      )
      select ws.wallet_id
      from wallet_set ws
      join wallets w on w.id = ws.wallet_id
      left join wallet_position_exposure wpe on wpe.wallet_id = ws.wallet_id
      where not ${buildWalletMmSuspectedSql({
        exposureUsdSql: "wpe.exposure_usd",
        hedgedNotionalUsdSql: "wpe.hedged_notional_usd",
        hedgeRatioSql: "wpe.hedge_ratio",
        twoSidedMarketsSql: "wpe.two_sided_markets",
        exposureThresholdSql: `case
          when w.chain = 'solana' then $3::numeric
          else $2::numeric
        end`,
      })}
    `,
    [walletIds, refreshPolicy.whaleUsd, refreshPolicy.whaleUsdSolana],
  );
  return rows.rows.map((row) => row.wallet_id);
}

async function loadWalletIdsForHighConvictionLabel(
  client: PoolClient,
  walletIds: string[],
  attributionPolicy: Awaited<
    ReturnType<typeof resolveWalletIntelAttributionPolicy>
  >["effective"],
): Promise<string[]> {
  if (walletIds.length === 0) return [];
  const rows = await client.query<{ wallet_id: string }>(
    `
      with venue_thresholds(venue, min_stake_usd) as (
        values
          ('polymarket', $2::numeric),
          ('kalshi', $3::numeric),
          ('limitless', $4::numeric)
      )
      select distinct scoped.wallet_id
      from (
        select
          wah.wallet_id,
          wah.venue,
          max(
            coalesce(wah.max_abs_delta_usd, wah.abs_delta_usd, abs(wah.signed_delta_usd), 0)
          ) as max_stake_usd
        from wallet_activity_hourly wah
        where wah.wallet_id = any($1::uuid[])
          and wah.activity_type in ('delta', 'trade')
          and wah.hour_bucket >= now() - interval '30 days'
        group by wah.wallet_id, wah.venue
      ) scoped
      join venue_thresholds vt on vt.venue = scoped.venue
      where vt.min_stake_usd > 0
        and scoped.max_stake_usd >= vt.min_stake_usd
    `,
    [
      walletIds,
      attributionPolicy.venueThresholds.polymarket.highConvictionStakeUsd,
      attributionPolicy.venueThresholds.kalshi.highConvictionStakeUsd,
      attributionPolicy.venueThresholds.limitless.highConvictionStakeUsd,
    ],
  );
  return rows.rows.map((row) => row.wallet_id);
}

async function loadWalletIdsForMarketMoverLabel(
  client: PoolClient,
  walletIds: string[],
  attributionPolicy: Awaited<
    ReturnType<typeof resolveWalletIntelAttributionPolicy>
  >["effective"],
): Promise<string[]> {
  if (walletIds.length === 0) return [];
  const rows = await client.query<{ wallet_id: string }>(
    `
      with venue_thresholds(venue, min_stake_usd, min_ratio) as (
        values
          ('polymarket', $2::numeric, $5::numeric),
          ('kalshi', $3::numeric, $6::numeric),
          ('limitless', $4::numeric, $7::numeric)
      ),
      stake_by_wallet_venue as (
        select
          wah.wallet_id,
          wah.venue,
          max(
            coalesce(wah.max_abs_delta_usd, wah.abs_delta_usd, abs(wah.signed_delta_usd), 0)
          ) as max_stake_usd
        from wallet_activity_hourly wah
        where wah.wallet_id = any($1::uuid[])
          and wah.activity_type in ('delta', 'trade')
          and wah.hour_bucket >= now() - interval '30 days'
        group by wah.wallet_id, wah.venue
      ),
      wallet_market as (
        select
          wah.wallet_id,
          wah.venue,
          wah.market_id,
          sum(coalesce(wah.abs_delta_usd, abs(wah.signed_delta_usd), 0)) as wallet_notional_24h
        from wallet_activity_hourly wah
        where wah.wallet_id = any($1::uuid[])
          and wah.activity_type in ('delta', 'trade')
          and wah.hour_bucket >= now() - interval '24 hours'
        group by wah.wallet_id, wah.venue, wah.market_id
      ),
      market_scope as (
        select distinct venue, market_id
        from wallet_market
      ),
      market_total as (
        select
          wah.venue,
          wah.market_id,
          sum(coalesce(wah.abs_delta_usd, abs(wah.signed_delta_usd), 0)) as market_notional_24h
        from wallet_activity_hourly wah
        join market_scope ms
          on ms.venue = wah.venue
         and ms.market_id = wah.market_id
        where wah.activity_type in ('delta', 'trade')
          and wah.hour_bucket >= now() - interval '24 hours'
        group by wah.venue, wah.market_id
      ),
      ratio_by_wallet_venue as (
        select
          wm.wallet_id,
          wm.venue,
          max(
            case
              when mt.market_notional_24h > 0
                then wm.wallet_notional_24h / mt.market_notional_24h
              else null
            end
          ) as max_stake_to_market_vol_ratio
        from wallet_market wm
        left join market_total mt
          on mt.venue = wm.venue
         and mt.market_id = wm.market_id
        group by wm.wallet_id, wm.venue
      )
      select distinct scoped.wallet_id
      from stake_by_wallet_venue scoped
      join venue_thresholds vt on vt.venue = scoped.venue
      left join ratio_by_wallet_venue rv
        on rv.wallet_id = scoped.wallet_id
       and rv.venue = scoped.venue
      where vt.min_stake_usd > 0
        and scoped.max_stake_usd >= vt.min_stake_usd
        and (
          vt.min_ratio <= 0
          or coalesce(rv.max_stake_to_market_vol_ratio, 0) >= vt.min_ratio
        )
    `,
    [
      walletIds,
      attributionPolicy.venueThresholds.polymarket.marketMoverStakeUsd,
      attributionPolicy.venueThresholds.kalshi.marketMoverStakeUsd,
      attributionPolicy.venueThresholds.limitless.marketMoverStakeUsd,
      attributionPolicy.venueThresholds.polymarket
        .marketMoverStakeToMarketVolRatio,
      attributionPolicy.venueThresholds.kalshi.marketMoverStakeToMarketVolRatio,
      attributionPolicy.venueThresholds.limitless
        .marketMoverStakeToMarketVolRatio,
    ],
  );
  return rows.rows.map((row) => row.wallet_id);
}

async function filterWalletIdsByExactAttributionLabels(
  client: PoolClient,
  walletIds: string[],
  attributionPolicy: Awaited<
    ReturnType<typeof resolveWalletIntelAttributionPolicy>
  >["effective"],
  filters: {
    primaryTyped: WalletAttributionPrimaryKey[];
    labelsTyped: WalletAttributionLabelKey[];
    labelMode?: "any" | "all";
  },
): Promise<string[] | null> {
  if (
    !canUseExactAttributionSqlLabelFilter(
      filters.primaryTyped,
      filters.labelsTyped,
    )
  ) {
    return null;
  }

  const uniqueLabels = Array.from(new Set(filters.labelsTyped));
  const resultSets = await Promise.all(
    uniqueLabels.map(async (label) => {
      switch (label) {
        case "high_conviction":
          return new Set(
            await loadWalletIdsForHighConvictionLabel(
              client,
              walletIds,
              attributionPolicy,
            ),
          );
        case "market_mover":
          return new Set(
            await loadWalletIdsForMarketMoverLabel(
              client,
              walletIds,
              attributionPolicy,
            ),
          );
        default:
          return new Set<string>();
      }
    }),
  );

  if (resultSets.length === 0) return walletIds;

  if ((filters.labelMode ?? "any") === "all") {
    const intersection = new Set(resultSets[0] ?? []);
    for (const resultSet of resultSets.slice(1)) {
      for (const walletId of Array.from(intersection)) {
        if (!resultSet.has(walletId)) intersection.delete(walletId);
      }
    }
    return walletIds.filter((walletId) => intersection.has(walletId));
  }

  const union = new Set<string>();
  for (const resultSet of resultSets) {
    for (const walletId of resultSet) union.add(walletId);
  }
  return walletIds.filter((walletId) => union.has(walletId));
}

async function loadWalletAttributionFilterRowsByIds(
  client: PoolClient,
  walletIds: string[],
): Promise<WalletAttributionFilterRow[]> {
  if (walletIds.length === 0) return [];
  const rows = await client.query<WalletAttributionFilterRow>(
    `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      ),
      tags_agg as (
        select
          tm.wallet_id,
          jsonb_agg(jsonb_build_object(
            'slug', t.slug,
            'label', t.label,
            'tag_type', t.tag_type,
            'is_system', t.is_system
          ) order by t.tag_type, t.slug) as tags
        from wallet_tag_map tm
        join wallet_set ws on ws.wallet_id = tm.wallet_id
        join wallet_tags t on t.id = tm.tag_id
        group by tm.wallet_id
      )
      select
        ws.wallet_id as id,
        ta.tags
      from wallet_set ws
      left join tags_agg ta on ta.wallet_id = ws.wallet_id
    `,
    [walletIds],
  );
  return rows.rows;
}

async function filterWalletIdsByAttribution(
  client: PoolClient,
  walletIds: string[],
  attributionPolicy: Awaited<
    ReturnType<typeof resolveWalletIntelAttributionPolicy>
  >["effective"],
  filters: {
    primary: string[];
    labels: string[];
    labelMode?: "any" | "all";
    primaryTyped: WalletAttributionPrimaryKey[];
    labelsTyped: WalletAttributionLabelKey[];
  },
): Promise<string[]> {
  if (walletIds.length === 0) return [];
  const exactSqlLabelFiltered = await filterWalletIdsByExactAttributionLabels(
    client,
    walletIds,
    attributionPolicy,
    {
      primaryTyped: filters.primaryTyped,
      labelsTyped: filters.labelsTyped,
      labelMode: filters.labelMode,
    },
  );
  if (exactSqlLabelFiltered) {
    return exactSqlLabelFiltered;
  }
  const rows = await loadWalletAttributionFilterRowsByIds(client, walletIds);
  const attributionMap = await buildWalletAttributionMap(
    client,
    rows.map((row) =>
      buildWalletAttributionInput({
        walletId: row.id,
        tags: row.tags,
        metrics: null,
        inferredWinRate: null,
        inferredResolvedCount: null,
        trackedExposureUsd: null,
        topChanges: [],
      }),
    ),
    attributionPolicy,
    {
      mode: "filters",
      filterPrimary: filters.primaryTyped,
      filterLabels: filters.labelsTyped,
    },
  );
  return rows
    .filter((row) =>
      walletMatchesFilters(row.tags, attributionMap.get(row.id), {
        tags: [],
        tagMode: "any",
        primary: filters.primary,
        labels: filters.labels,
        labelMode: filters.labelMode,
      }),
    )
    .map((row) => row.id);
}

async function loadWalletIdsForSummaryScope(
  client: PoolClient,
  userId: string | null,
  scope: "following" | "whales" | "all",
  options?: {
    windowHours?: number;
    minActivityUsd?: number;
    minActivityShares?: number;
  },
): Promise<string[]> {
  if (scope === "following") {
    return loadFollowingWalletIds(client, userId);
  }
  if (scope === "whales") {
    return loadWhaleWalletIds(client);
  }
  const windowHours = Math.max(1, Math.trunc(options?.windowHours ?? 24));
  const [followingIds, activeIds] = await Promise.all([
    loadFollowingWalletIds(client, userId),
    loadActiveWalletIds(client, windowHours, {
      minActivityUsd: options?.minActivityUsd ?? env.walletIntelMinActivityUsd,
      minActivityShares:
        options?.minActivityShares ?? env.walletIntelMinActivityShares,
    }),
  ]);
  return mergeWalletIdsForScope("all", followingIds, activeIds);
}

export function buildWalletActivitySummaryHeroStats(input: {
  walletIds: string[];
  followedWalletIds: string[];
  portfolioPerformanceMap: Map<string, WalletPortfolioPerformance>;
  asOfFallback?: Date;
  includeTrackedStats?: boolean;
}): WalletActivitySummaryHeroStats {
  const uniqueWalletIds = Array.from(new Set(input.walletIds));
  const uniqueFollowedWalletIds = Array.from(new Set(input.followedWalletIds));
  const asOfFallback = input.asOfFallback ?? new Date();
  const includeTrackedStats = input.includeTrackedStats ?? true;
  let totalPnl30d: number | null = null;
  let trackedPnl30d: number | null = null;
  let latestAsOfMs = 0;

  for (const walletId of uniqueWalletIds) {
    const performance = input.portfolioPerformanceMap.get(walletId);
    if (performance?.endAsOf) {
      latestAsOfMs = Math.max(latestAsOfMs, performance.endAsOf.getTime());
    }
    if (performance?.pnlUsd == null) continue;
    totalPnl30d = (totalPnl30d ?? 0) + performance.pnlUsd;
  }

  if (includeTrackedStats) {
    for (const walletId of uniqueFollowedWalletIds) {
      const performance = input.portfolioPerformanceMap.get(walletId);
      if (performance?.endAsOf) {
        latestAsOfMs = Math.max(latestAsOfMs, performance.endAsOf.getTime());
      }
      if (performance?.pnlUsd == null) continue;
      trackedPnl30d = (trackedPnl30d ?? 0) + performance.pnlUsd;
    }
  }

  return {
    totalWallets: uniqueWalletIds.length,
    trackedWallets: includeTrackedStats ? uniqueFollowedWalletIds.length : null,
    totalPnl30d,
    trackedPnl30d: includeTrackedStats ? trackedPnl30d : null,
    asOf: latestAsOfMs > 0 ? new Date(latestAsOfMs) : asOfFallback,
  };
}

async function loadWalletActivitySummaryHeroStats(
  client: PoolClient,
  userId: string | null,
  input: {
    windowHours: number;
    refreshPolicy: Awaited<
      ReturnType<typeof resolveWalletIntelRefreshPolicy>
    >["effective"];
  },
): Promise<WalletActivitySummaryHeroStats> {
  const asOf = new Date();
  const [followedWalletIds, activeWalletIds] = await Promise.all([
    loadFollowingWalletIds(client, userId),
    loadActiveWalletIds(client, input.windowHours, {
      minActivityUsd: input.refreshPolicy.minActivityUsd,
      minActivityShares: input.refreshPolicy.minActivityShares,
    }),
  ]);
  const walletIds = mergeWalletIdsForScope(
    "all",
    followedWalletIds,
    activeWalletIds,
  );
  const stats = await client.query<{
    total_wallets: number | string;
    tracked_wallets: number | string | null;
    total_pnl_30d: string | null;
    tracked_pnl_30d: string | null;
    as_of: Date | null;
  }>(
    `
      with wallet_set as (
        select distinct unnest($1::uuid[]) as wallet_id
      ),
      followed_set as (
        select distinct unnest($2::uuid[]) as wallet_id
      )
      select
        count(ws.wallet_id)::int as total_wallets,
        count(fs.wallet_id)::int as tracked_wallets,
        sum(wis.metrics_pnl_30d)::text as total_pnl_30d,
        sum(wis.metrics_pnl_30d) filter (
          where fs.wallet_id is not null
        )::text as tracked_pnl_30d,
        max(coalesce(wis.metrics_as_of, wis.updated_at)) as as_of
      from wallet_set ws
      left join followed_set fs on fs.wallet_id = ws.wallet_id
      left join wallet_intel_selector_snapshot wis on wis.wallet_id = ws.wallet_id
    `,
    [walletIds, followedWalletIds],
  );
  const row = stats.rows[0];
  const includeTrackedStats = userId != null;
  return {
    totalWallets: Number(row?.total_wallets ?? walletIds.length),
    trackedWallets: includeTrackedStats
      ? Number(row?.tracked_wallets ?? followedWalletIds.length)
      : null,
    totalPnl30d: nullableNumber(row?.total_pnl_30d),
    trackedPnl30d: includeTrackedStats
      ? nullableNumber(row?.tracked_pnl_30d)
      : null,
    asOf: row?.as_of ?? asOf,
  };
}

async function loadWalletIdsForSignalScope(
  client: PoolClient,
  userId: string | null,
  scope: "following" | "active" | "all",
  windowHours: number,
  activityThresholds?: {
    minActivityUsd: number;
    minActivityShares: number;
  },
): Promise<string[]> {
  if (scope === "following") {
    return loadFollowingWalletIds(client, userId);
  }
  const [activeIds, followingIds] = await Promise.all([
    loadActiveWalletIds(client, windowHours, activityThresholds),
    scope === "all"
      ? loadFollowingWalletIds(client, userId)
      : Promise.resolve([]),
  ]);
  return mergeWalletIdsForScope(scope, followingIds, activeIds);
}

async function loadWalletRowsByIds(
  client: PoolClient,
  userId: string | null,
  walletIds: string[],
  categories: string[] | null,
): Promise<CandidateWalletRow[]> {
  if (walletIds.length === 0) return [];
  const categoryFilter =
    categories && categories.length > 0 ? categories : null;
  const rows = await client.query<CandidateWalletRow>(
    `
      with wallet_set as (
        select unnest($2::uuid[]) as wallet_id
      ),
      tags_agg as (
        select
          tm.wallet_id,
          jsonb_agg(jsonb_build_object(
            'slug', t.slug,
            'label', t.label,
            'tag_type', t.tag_type,
            'is_system', t.is_system
          ) order by t.tag_type, t.slug) as tags
        from wallet_tag_map tm
        join wallet_set ws on ws.wallet_id = tm.wallet_id
        join wallet_tags t on t.id = tm.tag_id
        group by tm.wallet_id
      )
      select
        w.id,
	        w.address,
	        w.chain,
	        w.label,
	        w.metadata,
	        wn.name as user_name,
        wl.label as user_label,
        wl.color as user_label_color,
        w.is_system_flagged,
        w.first_seen_at,
        w.last_seen_at,
        ta.tags,
        ${buildWalletIntelSelectorMetricsJsonSql("wis")} as metrics,
        wp.profile,
        wp.updated_at as profile_updated_at
      from wallet_set ws
      join wallets w on w.id = ws.wallet_id
      left join wallet_intel_selector_snapshot wis on wis.wallet_id = w.id
      left join wallet_user_labels wl
        on wl.wallet_id = w.id
       and wl.user_id = $1
      left join wallet_user_names wn
       on wn.wallet_id = w.id
       and wn.user_id = $1
      left join tags_agg ta on ta.wallet_id = w.id
      left join wallet_profiles wp on wp.wallet_id = w.id
      where ($3::text[] is null or wp.profile->'categories' ?| $3::text[])
      order by w.last_seen_at desc
    `,
    [userId, walletIds, categoryFilter],
  );
  return rows.rows;
}

async function loadWalletActivityStateByIds(
  client: PoolClient,
  walletIds: string[],
  windowDays: number,
): Promise<Map<string, WalletActivityStateRow>> {
  const byWalletId = new Map<string, WalletActivityStateRow>();
  if (walletIds.length === 0) return byWalletId;

  const rows = await client.query<WalletActivityStateRow>(
    `
      select
        wah.wallet_id,
        max(wah.last_occurred_at) as last_activity_at,
        bool_or(wah.activity_type in ('delta', 'trade')) as has_trade_activity,
        bool_or(wah.activity_type = 'holder') as has_holder_activity
      from wallet_activity_hourly wah
      where wah.wallet_id = any($1::uuid[])
        and wah.hour_bucket >= now() - ($2::text || ' days')::interval
      group by wah.wallet_id
    `,
    [walletIds, Math.max(1, Math.trunc(windowDays))],
  );

  for (const row of rows.rows) {
    byWalletId.set(row.wallet_id, row);
  }

  return byWalletId;
}

async function loadWalletPageStateByIds(
  client: PoolClient,
  userId: string | null,
  walletIds: string[],
): Promise<
  Map<
    string,
    {
      is_followed: boolean;
      owner_address: string | null;
      owner_label: string | null;
      owner_wallet_id: string | null;
    }
  >
> {
  const byId = new Map<
    string,
    {
      is_followed: boolean;
      owner_address: string | null;
      owner_label: string | null;
      owner_wallet_id: string | null;
    }
  >();
  if (walletIds.length === 0) return byId;

  const rows = await client.query<{
    wallet_id: string;
    is_followed: boolean;
    owner_address: string | null;
    owner_label: string | null;
    owner_wallet_id: string | null;
  }>(
    `
      with wallet_set as (
        select unnest($2::uuid[]) as wallet_id
      )
      select
        w.id as wallet_id,
        (wf.wallet_id is not null) as is_followed,
        owner.owner_address,
        owner.owner_label,
        owner.owner_wallet_id
      from wallet_set ws
      join wallets w on w.id = ws.wallet_id
      left join wallet_follows wf on wf.wallet_id = w.id and wf.user_id = $1
      ${buildWalletOwnerResolutionJoinSql(true)}
    `,
    [userId, walletIds],
  );

  for (const row of rows.rows) {
    byId.set(row.wallet_id, row);
  }

  return byId;
}

async function loadWhalePageMetadataByIds(
  client: PoolClient,
  userId: string | null,
  walletIds: string[],
): Promise<Map<string, WhalePageMetadataRow>> {
  const byId = new Map<string, WhalePageMetadataRow>();
  if (walletIds.length === 0) return byId;
  const [walletRows, walletPageStateById] = await Promise.all([
    loadWalletRowsByIds(client, userId, walletIds, null),
    loadWalletPageStateByIds(client, userId, walletIds),
  ]);

  for (const row of walletRows) {
    const pageState = walletPageStateById.get(row.id);
    if (!pageState) continue;
    byId.set(row.id, {
      ...row,
      ...pageState,
    });
  }
  return byId;
}

async function loadWalletFollowerCountsMap(
  client: PoolClient,
  walletIds: string[],
): Promise<Map<string, number>> {
  const byWalletId = new Map<string, number>();
  if (walletIds.length === 0) return byWalletId;

  const rows = await client.query<{
    wallet_id: string;
    followers_count: number | string;
  }>(
    `
      select
        wallet_id,
        count(*)::int as followers_count
      from wallet_follows
      where wallet_id = any($1::uuid[])
      group by wallet_id
    `,
    [walletIds],
  );

  for (const row of rows.rows) {
    byWalletId.set(row.wallet_id, Number(row.followers_count));
  }

  return byWalletId;
}

async function loadWalletResolvedTradeStatsMap(
  client: PoolClient,
  walletIds: string[],
): Promise<Map<string, WalletResolvedTradeStats>> {
  const byWalletId = new Map<string, WalletResolvedTradeStats>();
  if (walletIds.length === 0) return byWalletId;

  const rows = await client.query<{
    wallet_id: string;
    total: number | null;
    winning_count: number | null;
  }>(
    `
      select
        wallet_id,
        total,
        wins as winning_count
      from wallet_inferred_outcomes
      where wallet_id = any($1::uuid[])
        and total > 0
    `,
    [walletIds],
  );

  for (const row of rows.rows) {
    const resolvedCount = Math.max(0, Number(row.total ?? 0));
    const winningCount = Math.max(0, Number(row.winning_count ?? 0));
    const losingCount = Math.max(resolvedCount - winningCount, 0);
    byWalletId.set(row.wallet_id, {
      walletId: row.wallet_id,
      resolvedCount,
      winningCount,
      losingCount,
      winRate: resolvedCount > 0 ? winningCount / resolvedCount : null,
    });
  }

  return byWalletId;
}

export function applyResolvedTradeStatsToMetrics(
  metrics: WalletMetricsRow | null,
  stats: WalletResolvedTradeStats | null | undefined,
  asOfFallback: Date | null = null,
): WalletMetricsRow | null {
  if (!stats) return metrics;
  const nextWinRate =
    metrics?.win_rate ?? (stats.winRate != null ? String(stats.winRate) : null);
  const nextWinningCount = metrics?.winning_count ?? stats.winningCount;
  const nextLosingCount = metrics?.losing_count ?? stats.losingCount;
  const nextResolvedCount = metrics?.resolved_count ?? stats.resolvedCount;

  if (!metrics) {
    if (nextWinRate == null && nextResolvedCount <= 0) return null;
    return {
      period: "30d",
      as_of: asOfFallback ?? new Date(),
      trades_count: null,
      volume_usd: null,
      pnl_usd: null,
      roi: null,
      win_rate: nextWinRate,
      avg_hold_hours: null,
      last_trade_at: null,
      resolved_edge_sample_count: null,
      resolved_actual_win_rate: null,
      resolved_expected_win_rate: null,
      resolved_win_rate_edge: null,
      resolved_edge_z_score: null,
      resolved_brier_score: null,
      resolved_stake_weighted_edge: null,
      resolved_stake_usd: null,
      winning_count: nextWinningCount,
      losing_count: nextLosingCount,
      resolved_count: nextResolvedCount,
    };
  }

  return {
    ...metrics,
    win_rate: nextWinRate,
    winning_count: nextWinningCount,
    losing_count: nextLosingCount,
    resolved_count: nextResolvedCount,
  };
}

function serializeWalletMetrics(
  metrics: WalletMetricsRow | null | undefined,
): WalletMetricsResponse | null {
  if (!metrics) return null;
  return {
    period: metrics.period,
    asOf: metrics.as_of,
    tradesCount:
      metrics.trades_count != null ? Number(metrics.trades_count) : null,
    volumeUsd: nullableNumber(metrics.volume_usd),
    pnlUsd: nullableNumber(metrics.pnl_usd),
    roi: nullableNumber(metrics.roi),
    winRate: nullableNumber(metrics.win_rate),
    resolvedEdgeSampleCount:
      metrics.resolved_edge_sample_count != null
        ? Number(metrics.resolved_edge_sample_count)
        : null,
    resolvedActualWinRate: nullableNumber(metrics.resolved_actual_win_rate),
    resolvedExpectedWinRate: nullableNumber(metrics.resolved_expected_win_rate),
    resolvedWinRateEdge: nullableNumber(metrics.resolved_win_rate_edge),
    resolvedEdgeZScore: nullableNumber(metrics.resolved_edge_z_score),
    resolvedBrierScore: nullableNumber(metrics.resolved_brier_score),
    resolvedStakeWeightedEdge: nullableNumber(
      metrics.resolved_stake_weighted_edge,
    ),
    resolvedStakeUsd: nullableNumber(metrics.resolved_stake_usd),
    avgHoldHours: nullableNumber(metrics.avg_hold_hours),
    lastTradeAt: metrics.last_trade_at ?? null,
    winningCount:
      metrics.winning_count != null ? Number(metrics.winning_count) : null,
    losingCount:
      metrics.losing_count != null ? Number(metrics.losing_count) : null,
    resolvedCount:
      metrics.resolved_count != null ? Number(metrics.resolved_count) : null,
  };
}

function serializeWalletResponseItem<
  T extends { metrics: WalletMetricsRow | null },
>(item: T): Omit<T, "metrics"> & { metrics: WalletMetricsResponse | null } {
  return {
    ...item,
    metrics: serializeWalletMetrics(item.metrics),
  };
}

function mapWalletActivityRouteItems(rows: WalletActivityRouteRow[]) {
  return rows.map((row) => ({
    walletId: row.wallet_id,
    address: row.address,
    chain: row.chain,
    label: row.label,
    userName: row.user_name ?? null,
    userLabel: row.user_label ?? null,
    userLabelColor: row.user_label_color ?? null,
    ...extractWalletIdentityDisplayFields(row.wallet_metadata, row.label),
    profileLabel: row.profile_label,
    venue: row.venue,
    marketId: row.market_id,
    marketTitle: row.market_title,
    outcomes: parseMarketOutcomes(row.outcomes),
    marketImage: row.market_image,
    marketIcon: row.market_icon,
    eventId: row.event_id,
    eventTitle: row.event_title,
    eventImage: row.event_image,
    eventIcon: row.event_icon,
    category: row.category ?? row.event_category,
    marketType: classifyMarketType({
      category: row.category ?? row.event_category,
      seriesKey: row.series_key,
      seriesTitle: row.series_title,
      eventTitle: row.event_title,
      marketTitle: row.market_title,
      closeTime: row.close_time,
      expirationTime: row.expiration_time,
    }),
    bestBid: row.best_bid ? Number(row.best_bid) : null,
    bestAsk: row.best_ask ? Number(row.best_ask) : null,
    lastPrice: row.last_price ? Number(row.last_price) : null,
    marketStatus: row.market_status,
    closeTime: row.close_time ? row.close_time.toISOString() : null,
    expirationTime: row.expiration_time
      ? row.expiration_time.toISOString()
      : null,
    resolvedOutcome: row.resolved_outcome,
    acceptingOrders: row.accepting_orders,
    outcomeSide: normalizeOutcomeSideForApi(row.outcome_side),
    action: row.action,
    deltaShares: row.delta_shares ? Number(row.delta_shares) : null,
    sizeUsd: row.size_usd ? Number(row.size_usd) : null,
    price: row.price ? Number(row.price) : null,
    activityType: row.activity_type,
    source: row.source,
    changeAction: resolveWalletActivityChangeAction({
      action: row.action,
      source: row.source,
      metadata: row.metadata,
    }),
    quoteTiming: "current" as const,
    occurredAt: row.occurred_at,
    metadata: row.metadata ?? null,
  }));
}

type WalletActivityRouteItem = ReturnType<
  typeof mapWalletActivityRouteItems
>[number];

async function enrichWalletActivityRouteItemsWithPositionNow(
  client: PoolClient,
  items: WalletActivityRouteItem[],
): Promise<
  Array<WalletActivityRouteItem & { positionNow: WalletPositionNow | null }>
> {
  if (items.length === 0) return [];

  const positionNowByKey = await loadLatestWalletPositionNowMap(
    client,
    items.map((item) => ({
      walletId: item.walletId,
      venue: item.venue,
      marketId: item.marketId,
      outcomeSide: item.outcomeSide,
    })),
  );

  return items.map((item) => ({
    ...item,
    positionNow:
      positionNowByKey.get(
        makeWalletPositionLedgerKey(
          item.walletId,
          item.marketId,
          item.outcomeSide,
        ),
      ) ?? null,
  }));
}

async function enrichWalletActivityRouteItemsWithMarketTypeMetrics<
  T extends WalletActivityRouteItem,
>(
  client: PoolClient,
  items: T[],
): Promise<Array<T & { marketTypeMetrics30d: unknown | null }>> {
  if (items.length === 0) return [];
  const walletIds = Array.from(new Set(items.map((item) => item.walletId)));
  const metricsByKey = await loadWalletMarketTypeMetricsMap(client, {
    walletIds,
  });

  return items.map((item) => ({
    ...item,
    marketTypeMetrics30d:
      metricsByKey.get(
        makeWalletMarketTypeMetricKey(item.walletId, item.marketType),
      ) ?? null,
  }));
}

function mapWalletPositionBaseItems(
  rows: WalletPositionRouteRow[],
): WalletPositionBaseRouteItem[] {
  return rows.map((row) => ({
    walletId: row.wallet_id,
    address: row.address,
    chain: row.chain,
    label: row.label,
    userName: row.user_name ?? null,
    userLabel: row.user_label ?? null,
    userLabelColor: row.user_label_color ?? null,
    ...extractWalletIdentityDisplayFields(row.wallet_metadata, row.label),
    profileLabel: row.profile_label,
    venue: row.venue,
    marketId: row.market_id,
    marketTitle: row.market_title,
    outcomes: parseMarketOutcomes(row.outcomes),
    marketImage: row.market_image,
    marketIcon: row.market_icon,
    eventId: row.event_id,
    eventTitle: row.event_title,
    eventImage: row.event_image,
    eventIcon: row.event_icon,
    bestBid: row.best_bid ? Number(row.best_bid) : null,
    bestAsk: row.best_ask ? Number(row.best_ask) : null,
    lastPrice: row.last_price ? Number(row.last_price) : null,
    marketStatus: row.market_status,
    closeTime: row.close_time ? row.close_time.toISOString() : null,
    expirationTime: row.expiration_time
      ? row.expiration_time.toISOString()
      : null,
    resolvedOutcome: row.resolved_outcome,
    resolvedOutcomePct: row.resolved_outcome_pct
      ? Number(row.resolved_outcome_pct)
      : null,
    acceptingOrders: row.accepting_orders,
    outcomeSide: normalizeOutcomeSideForApi(row.outcome_side),
    shares: row.shares ? Number(row.shares) : null,
    sizeUsd: row.size_usd ? Number(row.size_usd) : null,
    price: row.price ? Number(row.price) : null,
    snapshotAt: row.snapshot_at,
    metadata: row.metadata ?? null,
  }));
}

async function buildWalletPositionRouteItems(
  client: PoolClient,
  rows: WalletPositionRouteRow[],
) {
  const baseItems = mapWalletPositionBaseItems(rows);
  const approxMetrics = await loadWalletPositionApproxMetrics(
    client,
    baseItems,
  );

  return baseItems.map((item) => {
    const metrics = approxMetrics.get(
      `${item.walletId}::${item.marketId}::${item.outcomeSide ?? ""}`,
    );
    const { resolvedOutcomePct: _resolvedOutcomePct, ...rest } = item;
    return {
      ...rest,
      openPnlUsd: metrics?.openPnlUsd ?? null,
      realizedPnlUsd: metrics?.realizedPnlUsd ?? null,
      totalPnlUsd: metrics?.totalPnlUsd ?? null,
      approxEntryPrice: metrics?.approxEntryPrice ?? null,
      approxPnlUsd: metrics?.approxPnlUsd ?? null,
      approxReliable: metrics?.approxReliable ?? false,
      approxPnlSource: metrics?.approxPnlSource ?? null,
    };
  });
}

function applyWalletPresentationFields<
  T extends {
    metrics: WalletMetricsRow | null;
    lastActivityAt: Date | null;
    tags: WalletTagRow[];
    unusualTier: WalletActivitySummary["unusualTier"] | null;
  },
>(
  item: T,
  attribution: WalletAttribution | null | undefined,
): T & {
  topLabelVariant: WalletTopLabelVariant | null;
  headlineTag: WalletHeadlineTag | null;
  primaryLabel: WalletPresentationLabel | null;
  secondaryLabels: WalletPresentationLabel[];
  badges: WalletPresentationBadge[];
  avgTradeSizeUsd: number | null;
} {
  return {
    ...item,
    topLabelVariant: resolveWalletTopLabelVariant({
      attribution,
      metrics: item.metrics,
      lastActivityAt: item.lastActivityAt,
    }),
    headlineTag: resolveWalletHeadlineTag(attribution),
    primaryLabel: resolveWalletPrimaryLabel(attribution),
    secondaryLabels: resolveWalletSecondaryLabels(attribution),
    badges: resolveWalletBadges({
      attribution,
      tags: item.tags,
      unusualTier: item.unusualTier,
      metrics: item.metrics,
      lastActivityAt: item.lastActivityAt,
    }),
    avgTradeSizeUsd: resolveWalletAvgTradeSizeUsd(item.metrics),
  };
}

async function loadWalletMmDiagnosticsMap(
  client: PoolClient,
  wallets: Array<{ walletId: string; chain: string }>,
  refreshPolicy: Awaited<
    ReturnType<typeof resolveWalletIntelRefreshPolicy>
  >["effective"],
): Promise<Map<string, WalletMmDiagnostics>> {
  const byWallet = new Map<string, WalletMmDiagnostics>();
  if (wallets.length === 0) return byWallet;
  const walletIds = wallets.map((wallet) => wallet.walletId);
  const chainByWallet = new Map(
    wallets.map((wallet) => [wallet.walletId, wallet.chain] as const),
  );
  const rows = await client.query<{
    wallet_id: string;
    exposure_usd: string | null;
    hedged_notional_usd: string | null;
    net_imbalance_usd: string | null;
    hedge_ratio: string | null;
    two_sided_markets: number | null;
  }>(
    `
      select
        wallet_id,
        exposure_usd,
        hedged_notional_usd,
        net_imbalance_usd,
        hedge_ratio,
        two_sided_markets
      from wallet_position_exposure
      where wallet_id = any($1::uuid[])
    `,
    [walletIds],
  );

  for (const row of rows.rows) {
    byWallet.set(
      row.wallet_id,
      buildWalletMmDiagnostics({
        exposureUsd: nullableNumber(row.exposure_usd) ?? 0,
        hedgedNotionalUsd: nullableNumber(row.hedged_notional_usd) ?? 0,
        netImbalanceUsd: nullableNumber(row.net_imbalance_usd) ?? 0,
        hedgeRatio: nullableNumber(row.hedge_ratio) ?? 0,
        twoSidedMarkets: row.two_sided_markets ?? 0,
        chain: chainByWallet.get(row.wallet_id) ?? null,
        refreshPolicy,
      }),
    );
  }

  for (const wallet of wallets) {
    if (byWallet.has(wallet.walletId)) continue;
    byWallet.set(
      wallet.walletId,
      buildWalletMmDiagnostics({
        exposureUsd: 0,
        hedgedNotionalUsd: 0,
        netImbalanceUsd: 0,
        hedgeRatio: 0,
        twoSidedMarkets: 0,
        chain: wallet.chain,
        refreshPolicy,
      }),
    );
  }

  return byWallet;
}

async function loadWhaleTopMarkets(
  client: PoolClient,
  walletIds: string[],
  marketLimit: number,
  windowDays: number,
): Promise<Map<string, WhaleMarketItem[]>> {
  const byWallet = new Map<string, WhaleMarketItem[]>();
  if (walletIds.length === 0) return byWallet;
  const marketRows = await client.query<WhaleMarketRow>(
    `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      ),
      recent_markets as (
        select
          wah.wallet_id,
          wah.market_id,
          um.title as market_title,
          um.outcomes,
          um.event_id,
          ue.title as event_title,
          wah.venue,
          sum(wah.event_count)::int as activity_count,
          sum(wah.volume_usd) as volume_usd,
          case
            when sum(wah.delta_shares_sum) is null
              or sum(wah.delta_shares_sum) = 0
              then null
            else sum(wah.price_weighted_sum)
              / nullif(sum(wah.delta_shares_sum), 0)
          end as avg_price,
          max(wah.last_occurred_at) as last_activity_at,
          um.best_bid,
          um.best_ask,
          um.last_price,
          um.status as market_status,
          um.close_time,
          um.expiration_time,
          um.resolved_outcome
        from wallet_activity_hourly wah
        join wallet_set ws on ws.wallet_id = wah.wallet_id
        left join unified_markets um on um.id = wah.market_id
        left join unified_events ue on ue.id = um.event_id
        where wah.activity_type in ('delta', 'trade', 'holder')
          and wah.hour_bucket >= now() - ($3::text || ' days')::interval
        group by
          wah.wallet_id,
          wah.market_id,
          um.title,
          um.outcomes,
          um.event_id,
          ue.title,
          wah.venue,
          um.best_bid,
          um.best_ask,
          um.last_price,
          um.status,
          um.close_time,
          um.expiration_time,
          um.resolved_outcome
      ),
      ranked as (
        select
          recent_markets.*,
          pos.outcome_side as position_side,
          pos.has_yes_position,
          pos.has_no_position,
          pos.shares as position_shares,
          pos.size_usd as position_value_usd,
          pos.price as position_price,
          pos.yes_shares as yes_position_shares,
          pos.yes_size_usd as yes_position_value_usd,
          pos.yes_price as yes_position_price,
          pos.no_shares as no_position_shares,
          pos.no_size_usd as no_position_value_usd,
          pos.no_price as no_position_price,
          row_number() over (
            partition by recent_markets.wallet_id
            order by recent_markets.volume_usd desc nulls last,
                     recent_markets.activity_count desc,
                     recent_markets.last_activity_at desc
          ) as rn
        from recent_markets
        left join lateral (
          with latest_snapshot as (
            select max(ws.snapshot_at) as snapshot_at
            from wallet_position_snapshots ws
            where ws.wallet_id = recent_markets.wallet_id
              and ws.venue = recent_markets.venue
          ),
          latest_positions as (
            select distinct on (ws.outcome_side)
              ws.outcome_side,
              ws.shares,
              ws.size_usd,
              ws.price
            from wallet_position_snapshots ws
            join latest_snapshot ls
              on ls.snapshot_at = ws.snapshot_at
            where ws.wallet_id = recent_markets.wallet_id
              and ws.venue = recent_markets.venue
              and ws.market_id = recent_markets.market_id
              and ws.shares > 0
            order by
              ws.outcome_side,
              ws.snapshot_at desc,
              ws.size_usd desc nulls last,
              ws.shares desc
          )
          select
            case
              when bool_or(lp.outcome_side = 'YES')
               and bool_or(lp.outcome_side = 'NO')
                then 'BOTH'
              when bool_or(lp.outcome_side = 'YES')
                then 'YES'
              when bool_or(lp.outcome_side = 'NO')
                then 'NO'
              else null
            end as outcome_side,
            bool_or(lp.outcome_side = 'YES') as has_yes_position,
            bool_or(lp.outcome_side = 'NO') as has_no_position,
            sum(lp.shares) as shares,
            sum(lp.size_usd) as size_usd,
            case
              when bool_or(lp.outcome_side = 'YES')
               and bool_or(lp.outcome_side = 'NO')
                then null
              else max(lp.price)
            end as price,
            sum(case when lp.outcome_side = 'YES' then lp.shares else 0 end) as yes_shares,
            sum(case when lp.outcome_side = 'YES' then lp.size_usd else 0 end) as yes_size_usd,
            max(case when lp.outcome_side = 'YES' then lp.price end) as yes_price,
            sum(case when lp.outcome_side = 'NO' then lp.shares else 0 end) as no_shares,
            sum(case when lp.outcome_side = 'NO' then lp.size_usd else 0 end) as no_size_usd,
            max(case when lp.outcome_side = 'NO' then lp.price end) as no_price
          from latest_positions lp
        ) pos on true
        where (coalesce(pos.has_yes_position, false) or coalesce(pos.has_no_position, false))
          and recent_markets.resolved_outcome is null
          and (
            recent_markets.market_status is null
            or recent_markets.market_status not in ('CLOSED', 'SETTLED', 'ARCHIVED')
          )
          and (
            coalesce(recent_markets.close_time, recent_markets.expiration_time) is null
            or coalesce(recent_markets.close_time, recent_markets.expiration_time) >= now()
          )
      )
      select
        ranked.wallet_id,
        ranked.market_id,
        ranked.market_title,
        ranked.outcomes,
        ranked.event_id,
        ranked.event_title,
        ranked.venue,
        ranked.market_status,
        ranked.close_time,
        ranked.expiration_time,
        ranked.resolved_outcome,
        ranked.activity_count,
        ranked.volume_usd,
        ranked.avg_price,
        ranked.best_bid,
        ranked.best_ask,
        ranked.last_price,
        ranked.position_side,
        ranked.has_yes_position,
        ranked.has_no_position,
        ranked.position_shares,
        ranked.position_value_usd,
        ranked.position_price,
        ranked.yes_position_shares,
        ranked.yes_position_value_usd,
        ranked.yes_position_price,
        ranked.no_position_shares,
        ranked.no_position_value_usd,
        ranked.no_position_price,
        ranked.last_activity_at
      from ranked
      where ranked.rn <= $2
      order by ranked.wallet_id, ranked.rn
    `,
    [walletIds, marketLimit, windowDays],
  );
  for (const market of marketRows.rows) {
    const list = byWallet.get(market.wallet_id) ?? [];
    list.push({
      marketId: market.market_id,
      marketTitle: market.market_title,
      outcomes: parseMarketOutcomes(market.outcomes),
      eventId: market.event_id,
      eventTitle: market.event_title,
      venue: market.venue,
      activityCount: market.activity_count,
      volumeUsd: market.volume_usd ? Number(market.volume_usd) : null,
      avgPrice: market.avg_price ? Number(market.avg_price) : null,
      bestBid: market.best_bid ? Number(market.best_bid) : null,
      bestAsk: market.best_ask ? Number(market.best_ask) : null,
      lastYesPrice: market.last_price ? Number(market.last_price) : null,
      marketStatus: market.market_status ?? null,
      closeTime: market.close_time ?? null,
      expirationTime: market.expiration_time ?? null,
      resolvedOutcome: market.resolved_outcome ?? null,
      positionSide:
        market.has_yes_position && market.has_no_position
          ? "BOTH"
          : normalizeOutcomeSideForApi(market.position_side),
      isTwoSided: Boolean(market.has_yes_position && market.has_no_position),
      positionShares: market.position_shares
        ? Number(market.position_shares)
        : null,
      positionValueUsd: market.position_value_usd
        ? Number(market.position_value_usd)
        : null,
      positionPrice: market.position_price
        ? Number(market.position_price)
        : null,
      yesPositionShares: market.yes_position_shares
        ? Number(market.yes_position_shares)
        : null,
      yesPositionValueUsd: market.yes_position_value_usd
        ? Number(market.yes_position_value_usd)
        : null,
      yesPositionPrice: market.yes_position_price
        ? Number(market.yes_position_price)
        : null,
      noPositionShares: market.no_position_shares
        ? Number(market.no_position_shares)
        : null,
      noPositionValueUsd: market.no_position_value_usd
        ? Number(market.no_position_value_usd)
        : null,
      noPositionPrice: market.no_position_price
        ? Number(market.no_position_price)
        : null,
      lastActivityAt: market.last_activity_at,
    });
    byWallet.set(market.wallet_id, list);
  }
  return byWallet;
}

export const walletIntelRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * POST /wallets/follow
   */
  z.post(
    "/wallets/follow",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: walletFollowBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      const chain = body.chain.toLowerCase();
      const address = normalizeAddress(body.address);
      const baseLabel = body.label?.trim() || null;

      if (!isValidWalletAddressForChain(address, chain)) {
        reply.code(400);
        return reply.send({
          error:
            chain === "solana"
              ? "Invalid Solana wallet address"
              : "Invalid EVM wallet address",
        });
      }

      const client = await pool.connect();
      try {
        const walletResult = await client.query<WalletRow>(
          `
            insert into wallets (address, chain, label)
            values ($1, $2, $3)
            on conflict (address, chain)
            do update set
              label = coalesce(excluded.label, wallets.label),
              last_seen_at = greatest(wallets.last_seen_at, now()),
              updated_at = now()
            returning id, address, chain, label, is_system_flagged, first_seen_at, last_seen_at
          `,
          [address, chain, body.label ?? null],
        );

        const wallet = walletResult.rows[0];

        const followResult = await client.query<{
          id: string;
          created_at: Date;
        }>(
          `
            insert into wallet_follows (user_id, wallet_id)
            values ($1, $2)
            returning id, created_at
          `,
          [user.id, wallet.id],
        );

        if (baseLabel) {
          await client.query(
            `
              insert into wallet_user_labels (user_id, wallet_id, label)
              values ($1, $2, $3)
              on conflict (user_id, wallet_id)
              do update set
                label = excluded.label,
                updated_at = now()
            `,
            [user.id, wallet.id, baseLabel],
          );
        }

        if (
          chain === "polygon" &&
          isValidWalletAddressForChain(address, chain)
        ) {
          try {
            const funderResult = await derivePolymarketFunders({
              signer: address,
            });
            const safeCandidate = funderResult.candidates.find(
              (candidate) =>
                candidate.source === "safe_proxy" &&
                candidate.deployed &&
                candidate.contractKind === "SAFE_LIKE",
            );

            if (safeCandidate) {
              const safeAddress = normalizeAddress(safeCandidate.funder);
              if (isValidWalletAddressForChain(safeAddress, "polygon")) {
                const safeUserLabel = baseLabel
                  ? `${baseLabel} (Trading wallet)`
                  : null;
                const safeWalletResult = await client.query<WalletRow>(
                  `
                    insert into wallets (address, chain, label, metadata)
                    values ($1, $2, $3, $4)
                    on conflict (address, chain)
                    do update set
                      label = coalesce(wallets.label, excluded.label),
                      metadata = coalesce(wallets.metadata, '{}'::jsonb) || excluded.metadata,
                      last_seen_at = greatest(wallets.last_seen_at, now()),
                      updated_at = now()
                    returning id
                  `,
                  [
                    safeAddress,
                    "polygon",
                    null,
                    {
                      kind: "safe",
                      derivedFrom: address,
                      owners: safeCandidate.safeOwners ?? null,
                      threshold: safeCandidate.safeThreshold ?? null,
                    },
                  ],
                );
                const safeWalletId = safeWalletResult.rows[0]?.id;
                if (safeWalletId) {
                  await client.query(
                    `
                      insert into wallet_follows (user_id, wallet_id)
                      values ($1, $2)
                      on conflict (user_id, wallet_id)
                      do nothing
                    `,
                    [user.id, safeWalletId],
                  );
                  if (safeUserLabel) {
                    await client.query(
                      `
                        insert into wallet_user_labels (user_id, wallet_id, label)
                        values ($1, $2, $3)
                        on conflict (user_id, wallet_id)
                        do update set
                          label = excluded.label,
                          updated_at = now()
                      `,
                      [user.id, safeWalletId, safeUserLabel],
                    );
                  }
                }
              }
            }
          } catch (error) {
            app.log.warn(
              { error, userId: user.id, address },
              "Failed to auto-follow Polymarket Safe wallet",
            );
          }

          try {
            const safeInfo = await inspectSafeWallet({ address });
            if (safeInfo.safe) {
              await client.query(
                `
                  update wallets
                  set metadata = coalesce(metadata, '{}'::jsonb) || $2,
                      updated_at = now()
                  where id = $1
                `,
                [
                  wallet.id,
                  {
                    kind: "safe",
                    owners: safeInfo.owners ?? null,
                    threshold: safeInfo.threshold ?? null,
                  },
                ],
              );

              if (safeInfo.owners && safeInfo.owners.length === 1) {
                const owner = normalizeAddress(safeInfo.owners[0]);
                if (
                  isValidWalletAddressForChain(owner, "polygon") &&
                  owner !== address
                ) {
                  const ownerUserLabel = baseLabel
                    ? `${baseLabel} (Signer wallet)`
                    : null;
                  const ownerWalletResult = await client.query<{
                    id: string;
                  }>(
                    `
                      insert into wallets (address, chain, label, metadata)
                      values ($1, $2, $3, $4)
                      on conflict (address, chain)
                      do update set
                        label = coalesce(wallets.label, excluded.label),
                        metadata = coalesce(wallets.metadata, '{}'::jsonb) || excluded.metadata,
                        last_seen_at = greatest(wallets.last_seen_at, now()),
                        updated_at = now()
                      returning id
                    `,
                    [
                      owner,
                      "polygon",
                      null,
                      {
                        kind: "safe_owner",
                        derivedFrom: address,
                      },
                    ],
                  );

                  const ownerWalletId = ownerWalletResult.rows[0]?.id;
                  if (ownerWalletId) {
                    await client.query(
                      `
                        insert into wallet_follows (user_id, wallet_id)
                        values ($1, $2)
                        on conflict (user_id, wallet_id)
                        do nothing
                      `,
                      [user.id, ownerWalletId],
                    );
                    if (ownerUserLabel) {
                      await client.query(
                        `
                          insert into wallet_user_labels (user_id, wallet_id, label)
                          values ($1, $2, $3)
                          on conflict (user_id, wallet_id)
                          do update set
                            label = excluded.label,
                            updated_at = now()
                        `,
                        [user.id, ownerWalletId, ownerUserLabel],
                      );
                    }
                  }
                }
              }
            }
          } catch (error) {
            app.log.warn(
              { error, userId: user.id, address },
              "Failed to auto-follow Safe owner",
            );
          }
        }

        reply.code(201);
        return reply.send({
          ok: true,
          wallet: {
            walletId: wallet.id,
            address: wallet.address,
            chain: wallet.chain,
            label: wallet.label,
            ...extractWalletIdentityDisplayFields(wallet.metadata, wallet.label),
            isSystemFlagged: wallet.is_system_flagged,
            firstSeenAt: wallet.first_seen_at,
            lastSeenAt: wallet.last_seen_at,
          },
          follow: {
            id: followResult.rows[0].id,
            createdAt: followResult.rows[0].created_at,
          },
        });
      } catch (error) {
        const code = isRecord(error) ? error["code"] : undefined;
        if (code === "23505") {
          reply.code(409);
          return reply.send({ error: "Wallet already followed" });
        }

        app.log.error(
          { error, userId: user.id, address, chain },
          "Failed to follow wallet",
        );
        reply.code(500);
        return reply.send({ error: "Failed to follow wallet" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * PATCH /wallets/follow/:address
   * Update or clear a private label for an existing followed wallet.
   */
  z.patch(
    "/wallets/follow/:address",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: walletFollowParamsSchema,
        querystring: walletFollowChainQuerySchema,
        body: walletFollowPatchBodySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const address = normalizeAddress(request.params.address);
      const chain = request.query.chain.toLowerCase();
      const label = request.body.label;

      if (!isValidWalletAddressForChain(address, chain)) {
        reply.code(400);
        return reply.send({
          error:
            chain === "solana"
              ? "Invalid Solana wallet address"
              : "Invalid EVM wallet address",
        });
      }

      const client = await pool.connect();
      try {
        const walletResult = await client.query<WalletRow>(
          `
            select id, address, chain, label, metadata, is_system_flagged, first_seen_at, last_seen_at
            from wallets
            where address = $1 and chain = $2
          `,
          [address, chain],
        );

        const wallet = walletResult.rows[0];
        if (!wallet) {
          reply.code(404);
          return reply.send({ error: "Wallet not found" });
        }

        const followResult = await client.query<{ id: string }>(
          `
            select id
            from wallet_follows
            where user_id = $1 and wallet_id = $2
            limit 1
          `,
          [user.id, wallet.id],
        );

        if (followResult.rowCount === 0) {
          reply.code(404);
          return reply.send({ error: "Wallet not followed" });
        }

        if (label) {
          await client.query(
            `
              insert into wallet_user_labels (user_id, wallet_id, label)
              values ($1, $2, $3)
              on conflict (user_id, wallet_id)
              do update set
                label = excluded.label,
                updated_at = now()
            `,
            [user.id, wallet.id, label],
          );
        } else {
          await client.query(
            `
              delete from wallet_user_labels
              where user_id = $1 and wallet_id = $2
            `,
            [user.id, wallet.id],
          );
        }

        return reply.send({
          ok: true,
          wallet: {
            walletId: wallet.id,
            address: wallet.address,
            chain: wallet.chain,
            label: wallet.label,
            ...extractWalletIdentityDisplayFields(wallet.metadata, wallet.label),
            userLabel: label,
          },
          followed: true,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, address, chain, label },
          "Failed to update followed wallet label",
        );
        reply.code(500);
        return reply.send({ error: "Failed to update wallet label" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * DELETE /wallets/follow/:address
   */
  z.delete(
    "/wallets/follow/:address",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: walletFollowParamsSchema,
        querystring: walletFollowChainQuerySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const address = normalizeAddress(request.params.address);
      const chain = request.query.chain.toLowerCase();

      if (!isValidWalletAddressForChain(address, chain)) {
        reply.code(400);
        return reply.send({
          error:
            chain === "solana"
              ? "Invalid Solana wallet address"
              : "Invalid EVM wallet address",
        });
      }

      const client = await pool.connect();
      try {
        const walletResult = await client.query<WalletRow>(
          "select id from wallets where address = $1 and chain = $2",
          [address, chain],
        );

        const walletRow = walletResult.rows[0];
        if (!walletRow) {
          reply.code(404);
          return reply.send({ error: "Wallet not found" });
        }

        const deleteResult = await client.query(
          `
            delete from wallet_follows
            where user_id = $1 and wallet_id = $2
            returning id
          `,
          [user.id, walletRow.id],
        );

        if (deleteResult.rowCount === 0) {
          reply.code(404);
          return reply.send({ error: "Wallet not followed" });
        }

        return reply.send({ ok: true });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, address, chain },
          "Failed to unfollow wallet",
        );
        reply.code(500);
        return reply.send({ error: "Failed to unfollow wallet" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/private/:address
   */
  z.get(
    "/wallets/private/:address",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: walletFollowParamsSchema,
        querystring: walletFollowChainQuerySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const address = normalizeAddress(request.params.address);
      const chain = request.query.chain.toLowerCase();

      if (!isValidWalletAddressForChain(address, chain)) {
        reply.code(400);
        return reply.send({
          error:
            chain === "solana"
              ? "Invalid Solana wallet address"
              : "Invalid EVM wallet address",
        });
      }

      const client = await pool.connect();
      try {
        const wallet = await findWalletByAddressAndChain(
          client,
          address,
          chain,
        );
        if (!wallet) {
          return reply.send({
            ok: true,
            wallet: {
              walletId: null,
              address,
              chain,
              label: null,
              identityDisplayName: null,
              identityDisplayNameSource: null,
              identityProfileUrl: null,
            },
            followed: false,
            userName: null,
            userLabel: null,
            userLabelColor: null,
            notes: [],
          });
        }

        const meta = await loadWalletPrivateMeta(client, user.id, wallet.id);
        const notes = await loadWalletPrivateNotes(client, user.id, wallet.id);

        return reply.send({
          ok: true,
          wallet: {
            walletId: wallet.id,
            address: wallet.address,
            chain: wallet.chain,
            label: wallet.label,
            ...extractWalletIdentityDisplayFields(wallet.metadata, wallet.label),
          },
          followed: meta.followed,
          userName: meta.user_name,
          userLabel: meta.user_label,
          userLabelColor: meta.user_label_color,
          notes: notes.map((note) => ({
            id: note.id,
            note: note.note,
            createdAt: note.created_at,
            updatedAt: note.updated_at,
          })),
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, address, chain },
          "Failed to load private wallet metadata",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load private wallet metadata" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * PATCH /wallets/private/:address
   * Update or clear a private wallet label without requiring a follow row.
   */
  z.patch(
    "/wallets/private/:address",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: walletFollowParamsSchema,
        querystring: walletFollowChainQuerySchema,
        body: walletPrivateMetaPatchBodySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const address = normalizeAddress(request.params.address);
      const chain = request.query.chain.toLowerCase();
      const nextName = request.body.name;
      const nextLabel = request.body.label;
      const nextLabelColor = request.body.labelColor;

      if (!isValidWalletAddressForChain(address, chain)) {
        reply.code(400);
        return reply.send({
          error:
            chain === "solana"
              ? "Invalid Solana wallet address"
              : "Invalid EVM wallet address",
        });
      }

      const client = await pool.connect();
      try {
        const existingWallet = await findWalletByAddressAndChain(
          client,
          address,
          chain,
        );
        const shouldCreateWallet =
          existingWallet == null && (nextName != null || nextLabel != null);
        const wallet = shouldCreateWallet
          ? await ensureWalletByAddressAndChain(client, address, chain)
          : existingWallet;

        if (!wallet) {
          if (nextLabelColor !== undefined) {
            reply.code(400);
            return reply.send({
              error: "Label color requires an existing label",
            });
          }
          return reply.send({
            ok: true,
            wallet: {
              walletId: null,
              address,
              chain,
              label: null,
              identityDisplayName: null,
              identityDisplayNameSource: null,
              identityProfileUrl: null,
            },
            followed: false,
            userName: null,
            userLabel: null,
            userLabelColor: null,
            notes: [],
          });
        }

        const existingMeta = await loadWalletPrivateMeta(
          client,
          user.id,
          wallet.id,
        );

        if (nextLabelColor !== undefined) {
          const effectiveLabel =
            nextLabel !== undefined ? nextLabel : existingMeta.user_label;
          if (effectiveLabel == null) {
            reply.code(400);
            return reply.send({
              error: "Label color requires an existing label",
            });
          }
        }

        if (nextName !== undefined) {
          if (nextName) {
            await client.query(
              `
                insert into wallet_user_names (user_id, wallet_id, name)
                values ($1, $2, $3)
                on conflict (user_id, wallet_id)
                do update set
                  name = excluded.name,
                  updated_at = now()
              `,
              [user.id, wallet.id, nextName],
            );
          } else {
            await client.query(
              `
                delete from wallet_user_names
                where user_id = $1 and wallet_id = $2
              `,
              [user.id, wallet.id],
            );
          }
        }

        if (nextLabel !== undefined) {
          if (nextLabel) {
            await client.query(
              `
                insert into wallet_user_labels (user_id, wallet_id, label, color)
                values ($1, $2, $3, $4)
                on conflict (user_id, wallet_id)
                do update set
                  label = excluded.label,
                  color = excluded.color,
                  updated_at = now()
              `,
              [
                user.id,
                wallet.id,
                nextLabel,
                nextLabelColor === undefined
                  ? existingMeta.user_label_color
                  : nextLabelColor,
              ],
            );
          } else {
            await client.query(
              `
                delete from wallet_user_labels
                where user_id = $1 and wallet_id = $2
              `,
              [user.id, wallet.id],
            );
          }
        } else if (nextLabelColor !== undefined) {
          await client.query(
            `
              update wallet_user_labels
              set color = $3,
                  updated_at = now()
              where user_id = $1 and wallet_id = $2
            `,
            [user.id, wallet.id, nextLabelColor],
          );
        }

        const meta = await loadWalletPrivateMeta(client, user.id, wallet.id);
        const notes = await loadWalletPrivateNotes(client, user.id, wallet.id);

        return reply.send({
          ok: true,
          wallet: {
            walletId: wallet.id,
            address: wallet.address,
            chain: wallet.chain,
            label: wallet.label,
            ...extractWalletIdentityDisplayFields(wallet.metadata, wallet.label),
          },
          followed: meta.followed,
          userName: meta.user_name,
          userLabel: meta.user_label,
          userLabelColor: meta.user_label_color,
          notes: notes.map((note) => ({
            id: note.id,
            note: note.note,
            createdAt: note.created_at,
            updatedAt: note.updated_at,
          })),
        });
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            address,
            chain,
            name: nextName,
            label: nextLabel,
            labelColor: nextLabelColor,
          },
          "Failed to update private wallet label",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to update private wallet metadata",
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * POST /wallets/private/:address/notes
   */
  z.post(
    "/wallets/private/:address/notes",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: walletFollowParamsSchema,
        querystring: walletFollowChainQuerySchema,
        body: walletPrivateNoteBodySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const address = normalizeAddress(request.params.address);
      const chain = request.query.chain.toLowerCase();
      const note = request.body.note;

      if (!isValidWalletAddressForChain(address, chain)) {
        reply.code(400);
        return reply.send({
          error:
            chain === "solana"
              ? "Invalid Solana wallet address"
              : "Invalid EVM wallet address",
        });
      }

      const client = await pool.connect();
      try {
        const wallet = await ensureWalletByAddressAndChain(
          client,
          address,
          chain,
        );
        const insertResult = await client.query<WalletPrivateNoteRow>(
          `
            insert into wallet_user_notes (user_id, wallet_id, note)
            values ($1, $2, $3)
            returning id, note, created_at, updated_at
          `,
          [user.id, wallet.id, note],
        );

        reply.code(201);
        return reply.send({
          ok: true,
          wallet: {
            walletId: wallet.id,
            address: wallet.address,
            chain: wallet.chain,
            ...extractWalletIdentityDisplayFields(wallet.metadata, wallet.label),
          },
          note: {
            id: insertResult.rows[0].id,
            note: insertResult.rows[0].note,
            createdAt: insertResult.rows[0].created_at,
            updatedAt: insertResult.rows[0].updated_at,
          },
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, address, chain },
          "Failed to create private wallet note",
        );
        reply.code(500);
        return reply.send({ error: "Failed to create private wallet note" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * PATCH /wallets/private/:address/notes/:noteId
   */
  z.patch(
    "/wallets/private/:address/notes/:noteId",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: walletPrivateNoteParamsSchema,
        querystring: walletFollowChainQuerySchema,
        body: walletPrivateNoteBodySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const address = normalizeAddress(request.params.address);
      const noteId = request.params.noteId;
      const chain = request.query.chain.toLowerCase();
      const note = request.body.note;

      if (!isValidWalletAddressForChain(address, chain)) {
        reply.code(400);
        return reply.send({
          error:
            chain === "solana"
              ? "Invalid Solana wallet address"
              : "Invalid EVM wallet address",
        });
      }

      const client = await pool.connect();
      try {
        const wallet = await findWalletByAddressAndChain(
          client,
          address,
          chain,
        );
        if (!wallet) {
          reply.code(404);
          return reply.send({ error: "Wallet not found" });
        }

        const updateResult = await client.query<WalletPrivateNoteRow>(
          `
            update wallet_user_notes
            set note = $4,
                updated_at = now()
            where id = $1 and user_id = $2 and wallet_id = $3
            returning id, note, created_at, updated_at
          `,
          [noteId, user.id, wallet.id, note],
        );

        if (updateResult.rowCount === 0) {
          reply.code(404);
          return reply.send({ error: "Wallet note not found" });
        }

        return reply.send({
          ok: true,
          wallet: {
            walletId: wallet.id,
            address: wallet.address,
            chain: wallet.chain,
            ...extractWalletIdentityDisplayFields(wallet.metadata, wallet.label),
          },
          note: {
            id: updateResult.rows[0].id,
            note: updateResult.rows[0].note,
            createdAt: updateResult.rows[0].created_at,
            updatedAt: updateResult.rows[0].updated_at,
          },
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, address, chain, noteId },
          "Failed to update private wallet note",
        );
        reply.code(500);
        return reply.send({ error: "Failed to update private wallet note" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * DELETE /wallets/private/:address/notes/:noteId
   */
  z.delete(
    "/wallets/private/:address/notes/:noteId",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: walletPrivateNoteParamsSchema,
        querystring: walletFollowChainQuerySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const address = normalizeAddress(request.params.address);
      const noteId = request.params.noteId;
      const chain = request.query.chain.toLowerCase();

      if (!isValidWalletAddressForChain(address, chain)) {
        reply.code(400);
        return reply.send({
          error:
            chain === "solana"
              ? "Invalid Solana wallet address"
              : "Invalid EVM wallet address",
        });
      }

      const client = await pool.connect();
      try {
        const wallet = await findWalletByAddressAndChain(
          client,
          address,
          chain,
        );
        if (!wallet) {
          reply.code(404);
          return reply.send({ error: "Wallet not found" });
        }

        const deleteResult = await client.query(
          `
            delete from wallet_user_notes
            where id = $1 and user_id = $2 and wallet_id = $3
            returning id
          `,
          [noteId, user.id, wallet.id],
        );

        if (deleteResult.rowCount === 0) {
          reply.code(404);
          return reply.send({ error: "Wallet note not found" });
        }

        return reply.send({ ok: true });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, address, chain, noteId },
          "Failed to delete private wallet note",
        );
        reply.code(500);
        return reply.send({ error: "Failed to delete private wallet note" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/resolve/:address
   */
  z.get(
    "/wallets/resolve/:address",
    {
      preHandler: createAuthMiddleware({ optional: true }),
      schema: {
        params: walletResolverParamsSchema,
        querystring: walletResolverQuerySchema,
      },
    },
    async (request, reply) => {
      const userId = request.user?.id ?? null;

      const rawAddress = request.params.address.trim();
      const address = normalizeAddress(rawAddress);
      const looksValid =
        isValidWalletAddressForChain(address, "solana") ||
        isValidWalletAddressForChain(address, "polygon");
      if (!looksValid) {
        reply.code(400);
        return reply.send({ error: "Invalid wallet address" });
      }

      const client = await pool.connect();
      try {
        const preferredChain = request.query.chain?.toLowerCase() ?? null;
        const wallets = await findWalletsByAddress(client, address);
        const privateMetaByWallet = await loadWalletPrivateMetaByWalletIds(
          client,
          userId,
          wallets.map((wallet) => wallet.id),
        );
        const matches = wallets.map((wallet) => {
          const meta = privateMetaByWallet.get(wallet.id);
          return {
            walletId: wallet.id,
            address: wallet.address,
            chain: wallet.chain,
            label: wallet.label,
            followed: meta?.followed ?? false,
            userName: meta?.user_name ?? null,
            userLabel: meta?.user_label ?? null,
            userLabelColor: meta?.user_label_color ?? null,
            ...extractWalletIdentityDisplayFields(wallet.metadata, wallet.label),
          };
        });
        const preferredWallet = preferredChain
          ? (wallets.find((wallet) => wallet.chain === preferredChain) ??
            wallets[0] ??
            null)
          : pickAddressResolvedWallet(wallets, privateMetaByWallet);
        const resolvedWallet = preferredWallet
          ? (matches.find((wallet) => wallet.walletId === preferredWallet.id) ??
            null)
          : null;

        return reply.send({
          ok: true,
          wallet: resolvedWallet,
          matches,
        });
      } catch (error) {
        app.log.error(
          { error, userId, address },
          "Failed to resolve wallet by address",
        );
        reply.code(500);
        return reply.send({ error: "Failed to resolve wallet" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/following-lite
   */
  z.get(
    "/wallets/following-lite",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletFollowingQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const client = await pool.connect();
      try {
        const rows = await client.query<
          WalletRow & {
            follow_created_at: Date;
            metrics: WalletMetricsRow | null;
            user_name: string | null;
            user_label: string | null;
            user_label_color: WalletLabelColor | null;
          }
        >(
          `
            select
              w.id,
              w.address,
              w.chain,
              w.label,
              w.is_system_flagged,
              w.first_seen_at,
              w.last_seen_at,
              wf.created_at as follow_created_at,
              wn.name as user_name,
              wl.label as user_label,
              wl.color as user_label_color,
              lm.metrics
            from wallet_follows wf
            join wallets w on w.id = wf.wallet_id
            left join wallet_user_labels wl
              on wl.wallet_id = w.id
             and wl.user_id = $1
            left join wallet_user_names wn
              on wn.wallet_id = w.id
             and wn.user_id = $1
            left join lateral (
              select jsonb_build_object(
                'period', s.period,
                'as_of', s.as_of,
                'trades_count', s.trades_count,
                'volume_usd', s.volume_usd,
                'pnl_usd', s.pnl_usd,
                'roi', s.roi,
                'win_rate', s.win_rate,
                'avg_hold_hours', s.avg_hold_hours,
                'last_trade_at', s.last_trade_at
              ) as metrics
              from wallet_metrics_snapshots s
              where s.wallet_id = w.id
                and s.period = '30d'
                and ${aggregateWalletMetricsFilterSql("s")}
              order by s.as_of desc, ${aggregateWalletMetricsPreferenceSql("s")}
              limit 1
            ) lm on true
            where wf.user_id = $1
            order by wf.created_at desc
            limit $2
            offset $3
          `,
          [user.id, query.limit, query.offset],
        );
        const portfolioPerformanceMap = await loadWalletPortfolioPerformanceMap(
          client,
          rows.rows.map((row) => row.id),
          { rangeHours: 720 },
        );

        return reply.send({
          ok: true,
          wallets: rows.rows.map((row) => ({
            walletId: row.id,
            address: row.address,
            chain: row.chain,
            label: row.label,
            userName: row.user_name ?? null,
            userLabel: row.user_label ?? null,
            userLabelColor: row.user_label_color ?? null,
            followedAt: row.follow_created_at,
            metrics: serializeWalletMetrics(row.metrics ?? null),
            portfolioPerformance30d:
              portfolioPerformanceMap.get(row.id) ?? null,
          })),
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id },
          "Failed to list lightweight followed wallets",
        );
        reply.code(500);
        return reply.send({ error: "Failed to list followed wallets" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/following
   */
  z.get(
    "/wallets/following",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletFollowingQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const client = await pool.connect();
      try {
        const rows = await client.query<
          WalletRow & {
            follow_created_at: Date;
            tags: WalletTagRow[] | null;
            metrics: WalletMetricsRow | null;
            inferred_wins: number | null;
            inferred_total: number | null;
            profile: unknown | null;
            profile_updated_at: Date | null;
            user_name: string | null;
            user_label: string | null;
            user_label_color: WalletLabelColor | null;
          }
        >(
          `
            select
              w.id,
              w.address,
              w.chain,
              w.label,
              w.is_system_flagged,
              w.first_seen_at,
              w.last_seen_at,
              wf.created_at as follow_created_at,
              tags.tags,
              metrics.metrics,
              inferred.wins as inferred_wins,
              inferred.total as inferred_total,
              wp.profile as profile,
              wp.updated_at as profile_updated_at,
              wn.name as user_name,
              wl.label as user_label,
              wl.color as user_label_color
            from wallet_follows wf
            join wallets w on w.id = wf.wallet_id
            left join wallet_profiles wp on wp.wallet_id = w.id
            left join wallet_user_labels wl
              on wl.wallet_id = w.id
             and wl.user_id = $1
            left join wallet_user_names wn
              on wn.wallet_id = w.id
             and wn.user_id = $1
            left join lateral (
              select jsonb_agg(jsonb_build_object(
                'slug', t.slug,
                'label', t.label,
                'tag_type', t.tag_type,
                'is_system', t.is_system
              ) order by t.tag_type, t.slug) as tags
              from wallet_tag_map tm
              join wallet_tags t on t.id = tm.tag_id
              where tm.wallet_id = w.id
            ) tags on true
            left join lateral (
              select jsonb_build_object(
                'period', s.period,
                'as_of', s.as_of,
                'trades_count', s.trades_count,
                'volume_usd', s.volume_usd,
                'pnl_usd', s.pnl_usd,
                'roi', s.roi,
                'win_rate', s.win_rate,
                'avg_hold_hours', s.avg_hold_hours,
                'last_trade_at', s.last_trade_at
              ) as metrics
              from wallet_metrics_snapshots s
              where s.wallet_id = w.id
                and s.period = '30d'
                and ${aggregateWalletMetricsFilterSql("s")}
              order by s.as_of desc, ${aggregateWalletMetricsPreferenceSql("s")}
              limit 1
            ) metrics on true
            left join lateral (
              with latest as (
                select distinct on (ws.market_id, ws.outcome_side)
                  ws.market_id,
                  ws.outcome_side,
                  ws.shares
                from wallet_position_snapshots ws
                where ws.wallet_id = w.id
                  and ws.shares > 0
                order by ws.market_id, ws.outcome_side, ws.snapshot_at desc
              ),
              agg as (
                select
                  market_id,
                  sum(case when outcome_side = 'YES' then shares else 0 end) as yes_shares,
                  sum(case when outcome_side = 'NO' then shares else 0 end) as no_shares
                from latest
                group by market_id
              ),
              resolved as (
                select
                  agg.market_id,
                  agg.yes_shares,
                  agg.no_shares,
                  upper(m.resolved_outcome) as resolved_outcome
                from agg
                join unified_markets m on m.id = agg.market_id
                where m.resolved_outcome is not null
                  and upper(m.resolved_outcome) in ('YES', 'NO')
              ),
              eligible as (
                select *
                from resolved
                where (yes_shares > 0 and coalesce(no_shares, 0) = 0)
                   or (no_shares > 0 and coalesce(yes_shares, 0) = 0)
              )
              select
                count(*) filter (
                  where (resolved_outcome = 'YES' and yes_shares > 0 and no_shares = 0)
                     or (resolved_outcome = 'NO' and no_shares > 0 and yes_shares = 0)
                ) as wins,
                count(*)::int as total
              from eligible
            ) inferred on true
            where wf.user_id = $1
            order by wf.created_at desc
            limit $2
            offset $3
          `,
          [user.id, query.limit, query.offset],
        );
        const walletIds = rows.rows.map((row) => row.id);
        const [
          portfolioPerformanceMap,
          resolvedTradeStatsMap,
          onchainStateMap,
        ] = await Promise.all([
          loadWalletPortfolioPerformanceMap(client, walletIds, {
            rangeHours: 720,
          }),
          loadWalletResolvedTradeStatsMap(client, walletIds),
          loadWalletOnchainStateByIds(client, walletIds),
        ]);

        return reply.send({
          ok: true,
          wallets: rows.rows.map((row) => ({
            walletId: row.id,
            address: row.address,
            chain: row.chain,
            label: row.label,
            userName: row.user_name ?? null,
            isSystemFlagged: row.is_system_flagged,
            firstSeenAt: row.first_seen_at,
            lastSeenAt: row.last_seen_at,
            followedAt: row.follow_created_at,
            tags: row.tags ?? [],
            metrics: serializeWalletMetrics(
              applyResolvedTradeStatsToMetrics(
                row.metrics ?? null,
                resolvedTradeStatsMap.get(row.id),
                row.last_seen_at,
              ),
            ),
            portfolioPerformance30d:
              portfolioPerformanceMap.get(row.id) ?? null,
            inferredWinRate:
              row.inferred_total &&
              row.inferred_total > 0 &&
              row.inferred_wins != null
                ? Number(row.inferred_wins) / Number(row.inferred_total)
                : (resolvedTradeStatsMap.get(row.id)?.winRate ?? null),
            inferredResolvedCount:
              row.inferred_total != null
                ? Number(row.inferred_total)
                : (resolvedTradeStatsMap.get(row.id)?.resolvedCount ?? null),
            profile: row.profile ?? null,
            profileUpdatedAt: row.profile_updated_at ?? null,
            userLabel: row.user_label ?? null,
            userLabelColor: row.user_label_color ?? null,
            ...buildWalletOnchainFields({
              chain: row.chain,
              address: row.address,
              state: onchainStateMap.get(row.id) ?? null,
            }),
          })),
        });
      } catch (error) {
        app.log.error({ error, userId: user.id }, "Failed to list wallets");
        reply.code(500);
        return reply.send({ error: "Failed to list wallets" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/whales
   */
  z.get(
    "/wallets/whales",
    {
      preHandler: createAuthMiddleware({ optional: true }),
      schema: { querystring: walletWhalesQuerySchema },
    },
    async (request, reply) => {
      const userId = request.user?.id ?? null;

      const query = request.query;
      const categoryFilterRaw = Array.isArray(query.categories)
        ? query.categories
        : query.categories
          ? [query.categories]
          : [];
      const categoryFilter = Array.from(
        new Set(
          categoryFilterRaw
            .map((category: string) => category.trim().toLowerCase())
            .filter(Boolean),
        ),
      );
      const tagsFilter = normalizeStringArray(query.tags);
      const primaryFilter = normalizeStringArray(query.primary);
      const labelsFilter = normalizeStringArray(query.labels);
      const primaryFilterTyped =
        normalizeAttributionPrimaryFilters(primaryFilter);
      const labelsFilterTyped = normalizeAttributionLabelFilters(labelsFilter);
      const requiresSummaryForAttributionFilters =
        filtersRequireSummaryHydration(primaryFilterTyped, labelsFilterTyped);
      const cacheTtlSec = Math.max(0, Math.trunc(env.walletIntelTtlSec));
      const cacheContext = await resolveWalletIntelCacheContext(cacheTtlSec);
      const cacheClient = cacheContext.redis;
      const cacheKey = walletIntelCacheKey(
        "wallets-whales",
        userId ?? "anon",
        query,
      );
      const cached = await readWalletIntelCachedBody(
        cacheClient,
        cacheKey,
        cacheTtlSec,
      );
      if (cached) {
        applyWalletIntelCacheHeaders({
          reply,
          hit: true,
          layer: cached.layer,
          cacheStatus: cacheContext.status,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(cached.body);
      }
      const client = await pool.connect();
      try {
        const result = await withWalletIntelQuerySettings(
          client,
          { workMem: "32MB" },
          async () => {
            const [signalsPolicy, attributionPolicy, refreshPolicy] =
              await Promise.all([
                resolveWalletIntelSignalsPolicy(client),
                resolveWalletIntelAttributionPolicy(client),
                resolveWalletIntelRefreshPolicy(client),
              ]);
            const attributionEnabled = attributionPolicy.effective.enabled;
            const needsAttributionForFilters =
              primaryFilter.length > 0 || labelsFilter.length > 0;
            const includeAttributionInResponse =
              query.includeAttribution && attributionEnabled;

            const windowHours = resolveSignalWindowHours(
              query.windowHours,
              signalsPolicy.effective,
            );
            const queryControls = attributionPolicy.effective.queryControls;
            const maxScanCandidates = Math.max(
              100,
              Math.trunc(queryControls.whalesMaxScanCandidates),
            );
            const hydrationBatchSize = Math.max(
              10,
              Math.trunc(queryControls.whalesBatchSize),
            );
            const whaleTagId = await resolveWhaleTagId(client);
            const useSlimWhaleSelector =
              categoryFilter.length === 0 &&
              tagsFilter.length === 0 &&
              primaryFilter.length === 0 &&
              labelsFilter.length === 0;
            const slimQualityFilter = buildWhaleQualityFilterSql(query, 4);
            const useSnapshotWhaleShortlist =
              useSlimWhaleSelector &&
              query.sort === "last_activity" &&
              !slimQualityFilter.hasFilters;
            const whaleActivityOrderExpr = useSlimWhaleSelector
              ? "wis.last_activity_at"
              : "activity.last_activity_at";
            const needsInferredStats =
              query.sort === "winrate" ||
              query.minResolvedCount != null ||
              query.minWinRate30d != null;
            const orderBy = (() => {
              switch (query.sort) {
                case "volume_30d":
                  return `whale_score desc nulls last, ${whaleActivityOrderExpr} desc nulls last, w.last_seen_at desc`;
                case "trades_30d":
                  return `wis.metrics_trades_30d desc nulls last, ${whaleActivityOrderExpr} desc nulls last, w.last_seen_at desc`;
                case "exposure_usd":
                  return `wis.exposure_usd desc nulls last, ${whaleActivityOrderExpr} desc nulls last, w.last_seen_at desc`;
                case "imbalance_usd":
                  return `wis.net_imbalance_usd desc nulls last, ${whaleActivityOrderExpr} desc nulls last, w.last_seen_at desc`;
                case "winrate":
                  return `case when inferred.total > 0 then inferred.wins::float / inferred.total end desc nulls last, inferred.total desc nulls last, ${whaleActivityOrderExpr} desc nulls last, w.last_seen_at desc`;
                case "edge_z_score":
                  return `wis.metrics_resolved_edge_z_score_30d desc nulls last, wis.metrics_resolved_edge_sample_count_30d desc nulls last, ${whaleActivityOrderExpr} desc nulls last, w.last_seen_at desc`;
                case "stake_weighted_edge":
                  return `wis.metrics_resolved_stake_weighted_edge_30d desc nulls last, wis.metrics_resolved_stake_usd_30d desc nulls last, ${whaleActivityOrderExpr} desc nulls last, w.last_seen_at desc`;
                case "brier_score":
                  return `wis.metrics_resolved_brier_score_30d asc nulls last, wis.metrics_resolved_edge_sample_count_30d desc nulls last, ${whaleActivityOrderExpr} desc nulls last, w.last_seen_at desc`;
                case "pnl_30d":
                  return `wis.metrics_pnl_30d desc nulls last, whale_score desc nulls last, ${whaleActivityOrderExpr} desc nulls last, w.last_seen_at desc`;
                case "roi_30d":
                  return `wis.metrics_roi_30d desc nulls last, wis.metrics_pnl_30d desc nulls last, ${whaleActivityOrderExpr} desc nulls last, w.last_seen_at desc`;
                case "last_activity":
                default:
                  return `${whaleActivityOrderExpr} desc nulls last, whale_score desc nulls last, w.last_seen_at desc`;
              }
            })();
            const snapshotWhaleShortlistLimit = useSnapshotWhaleShortlist
              ? Math.min(
                  Math.max((query.offset + query.limit) * 10, 250),
                  maxScanCandidates + 1,
                )
              : null;
            const fullQualityFilter = buildWhaleQualityFilterSql(query, 6);

            const whaleRows = useSlimWhaleSelector
              ? await client.query<WhaleSelectorSlimRow>(
                  useSnapshotWhaleShortlist
                    ? buildSlimWhaleSelectorWithSnapshotShortlistSql(
                        orderBy,
                        needsInferredStats,
                        slimQualityFilter,
                      )
                    : buildSlimWhaleSelectorSql(
                        orderBy,
                        needsInferredStats,
                        slimQualityFilter,
                      ),
                  useSnapshotWhaleShortlist
                    ? [
                        snapshotWhaleShortlistLimit,
                        maxScanCandidates + 1,
                        whaleTagId,
                        query.windowDays,
                        ...slimQualityFilter.params,
                      ]
                    : [
                        maxScanCandidates + 1,
                        query.windowDays,
                        whaleTagId,
                        ...slimQualityFilter.params,
                      ],
                )
              : await client.query<WhaleSelectorRow>(
                  `
                  select
                    w.id,
	              w.address,
	              w.chain,
	              w.label,
	              w.metadata,
	              wn.name as user_name,
                    wl.label as user_label,
                    wl.color as user_label_color,
                    w.is_system_flagged,
                    (w.metadata->>'kind' = 'safe') as is_safe,
                    w.first_seen_at,
                    w.last_seen_at,
                    (wf.wallet_id is not null) as is_followed,
                    tags.tags,
                    ${buildWalletIntelSelectorMetricsJsonSql("wis")} as metrics,
                    wis.metrics_volume_30d as metrics_volume,
                    wis.metrics_pnl_30d as metrics_pnl,
                    wis.metrics_roi_30d as metrics_roi,
                    wis.metrics_trades_30d as metrics_trades,
                    wis.metrics_resolved_edge_sample_count_30d as metrics_resolved_edge_sample_count,
                    wis.metrics_resolved_actual_win_rate_30d as metrics_resolved_actual_win_rate,
                    wis.metrics_resolved_expected_win_rate_30d as metrics_resolved_expected_win_rate,
                    wis.metrics_resolved_win_rate_edge_30d as metrics_resolved_win_rate_edge,
                    wis.metrics_resolved_edge_z_score_30d as metrics_resolved_edge_z_score,
                    wis.metrics_resolved_brier_score_30d as metrics_resolved_brier_score,
                    wis.metrics_resolved_stake_weighted_edge_30d as metrics_resolved_stake_weighted_edge,
                    wis.metrics_resolved_stake_usd_30d as metrics_resolved_stake_usd,
                    wis.exposure_usd,
                    wis.hedged_notional_usd,
                    wis.net_imbalance_usd,
                    wis.hedge_ratio,
                    wis.two_sided_markets,
                    ${buildWalletIntelWhaleScoreSql("wis")} as whale_score,
                    owner.owner_address,
                    owner.owner_label,
                    owner.owner_wallet_id,
                    wp.profile as profile,
                    wp.updated_at as profile_updated_at,
                    activity.last_activity_at,
                    activity.has_trade_activity,
                    activity.has_holder_activity,
                    inferred.wins as inferred_wins,
                    inferred.total as inferred_total
                  from wallets w
                  join wallet_tag_map tm on tm.wallet_id = w.id
                   and tm.tag_id = $5::uuid
                  left join wallet_intel_selector_snapshot wis on wis.wallet_id = w.id
                  left join wallet_follows wf on wf.wallet_id = w.id and wf.user_id = $1
                  left join wallet_user_labels wl
                    on wl.wallet_id = w.id
                   and wl.user_id = $1
                  left join wallet_user_names wn
                    on wn.wallet_id = w.id
                   and wn.user_id = $1
                  left join lateral (
                    select jsonb_agg(jsonb_build_object(
                      'slug', t.slug,
                      'label', t.label,
                      'tag_type', t.tag_type,
                      'is_system', t.is_system
                    ) order by t.tag_type, t.slug) as tags
                    from wallet_tag_map tm
                    join wallet_tags t on t.id = tm.tag_id
                    where tm.wallet_id = w.id
                  ) tags on true
                  left join lateral (
                    select
                      max(wah.last_occurred_at) as last_activity_at,
                      bool_or(wah.activity_type in ('delta', 'trade')) as has_trade_activity,
                      bool_or(wah.activity_type = 'holder') as has_holder_activity
                    from wallet_activity_hourly wah
                    where wah.wallet_id = w.id
                      and wah.hour_bucket >= now() - ($3::text || ' days')::interval
                  ) activity on true
                  ${buildWalletOwnerResolutionJoinSql(true)}
                  left join wallet_profiles wp on wp.wallet_id = w.id
                  left join wallet_inferred_outcomes inferred on inferred.wallet_id = w.id
                  where ($4::text[] is null or wp.profile->'categories' ?| $4::text[])
                    and activity.last_activity_at is not null
                    ${fullQualityFilter.sql}
                  order by ${orderBy}
                  limit $2
                `,
                  [
                    userId,
                    maxScanCandidates + 1,
                    query.windowDays,
                    categoryFilter.length > 0 ? categoryFilter : null,
                    whaleTagId,
                    ...fullQualityFilter.params,
                  ],
                );

            const hasMoreCandidates = whaleRows.rows.length > maxScanCandidates;
            const hitScanCap = hasMoreCandidates;
            const scannedRows = hasMoreCandidates
              ? whaleRows.rows.slice(0, maxScanCandidates)
              : whaleRows.rows;

            const filteredByActivity = scannedRows
              .map((row) =>
                useSlimWhaleSelector
                  ? mapWhaleSlimRowToItem(
                      row as WhaleSelectorSlimRow,
                      refreshPolicy.effective,
                    )
                  : mapWhaleRowToItem(
                      row as WhaleSelectorRow,
                      refreshPolicy.effective,
                    ),
              )
              .filter((row) => Boolean(row.lastActivityAt));

            const deduped = new Map<string, WhaleWalletItem>();
            for (const row of filteredByActivity) {
              const dedupeKey = row.ownerAddress
                ? walletAddressIdentityKey(row.ownerAddress)
                : walletAddressIdentityKey(row.address);
              const existing = deduped.get(dedupeKey);
              if (!existing) {
                deduped.set(dedupeKey, row);
                continue;
              }
              const existingScore = (() => {
                switch (query.sort) {
                  case "trades_30d":
                    return Number(existing.metrics?.trades_count ?? 0);
                  case "exposure_usd":
                    return existing.trackedExposureUsd ?? 0;
                  case "imbalance_usd":
                    return existing.trackedNetImbalanceUsd ?? 0;
                  case "winrate":
                    return existing.inferredWinRate ?? 0;
                  case "roi_30d":
                    return nullableNumber(existing.metrics?.roi) ?? 0;
                  case "pnl_30d":
                    return existing.approxPnlUsd ?? 0;
                  case "last_activity":
                    return existing.lastActivityAt?.getTime() ?? 0;
                  case "volume_30d":
                  default:
                    return nullableNumber(existing.metrics?.volume_usd) ?? 0;
                }
              })();
              const rowScore = (() => {
                switch (query.sort) {
                  case "trades_30d":
                    return Number(row.metrics?.trades_count ?? 0);
                  case "exposure_usd":
                    return row.trackedExposureUsd ?? 0;
                  case "imbalance_usd":
                    return row.trackedNetImbalanceUsd ?? 0;
                  case "winrate":
                    return row.inferredWinRate ?? 0;
                  case "roi_30d":
                    return nullableNumber(row.metrics?.roi) ?? 0;
                  case "pnl_30d":
                    return row.approxPnlUsd ?? 0;
                  case "last_activity":
                    return row.lastActivityAt?.getTime() ?? 0;
                  case "volume_30d":
                  default:
                    return nullableNumber(row.metrics?.volume_usd) ?? 0;
                }
              })();

              if (existing.isSafe && !row.isSafe) {
                deduped.set(dedupeKey, row);
                continue;
              }
              if (!existing.isSafe && row.isSafe) {
                continue;
              }
              if (rowScore > existingScore) {
                deduped.set(dedupeKey, row);
                continue;
              }
              if (
                rowScore === existingScore &&
                row.lastActivityAt &&
                existing.lastActivityAt &&
                row.lastActivityAt > existing.lastActivityAt
              ) {
                deduped.set(dedupeKey, row);
              }
            }

            const dedupedRows = Array.from(deduped.values());
            const mmFilteredRows = dedupedRows.filter((row) => {
              if (query.mmMode === "exclude") {
                return !row.mmDiagnostics?.mmSuspected;
              }
              if (query.mmMode === "only") {
                return Boolean(row.mmDiagnostics?.mmSuspected);
              }
              return true;
            });
            const tagsOnlyRows = mmFilteredRows.filter((row) =>
              walletMatchesFilters(row.tags, undefined, {
                tags: tagsFilter,
                tagMode: query.tagMode,
                primary: [],
                labels: [],
                labelMode: query.labelMode,
              }),
            );

            let summaryMapForFilters: Map<
              string,
              WalletActivitySummary
            > | null = null;
            const attributionMapForFilters = new Map<
              string,
              WalletAttribution
            >();
            let postFilterRows = tagsOnlyRows;

            if (needsAttributionForFilters && tagsOnlyRows.length > 0) {
              if (requiresSummaryForAttributionFilters) {
                summaryMapForFilters = new Map<string, WalletActivitySummary>();
                for (const chunk of chunkArray(
                  tagsOnlyRows,
                  hydrationBatchSize,
                )) {
                  const chunkIds = chunk.map((row) => row.walletId);
                  if (chunkIds.length === 0) continue;
                  const chunkSummary = await fetchWalletActivitySummaries(
                    client,
                    chunkIds,
                    {
                      windowHours,
                      topChanges: query.topChanges,
                      baselineDays: 30,
                      enteredLateHours: 24,
                    },
                  );
                  for (const [walletId, summary] of chunkSummary.entries()) {
                    summaryMapForFilters.set(walletId, summary);
                  }
                }
              }

              for (const chunk of chunkArray(
                tagsOnlyRows,
                hydrationBatchSize,
              )) {
                if (chunk.length === 0) continue;
                const chunkAttribution = await buildWalletAttributionMap(
                  client,
                  chunk.map((row) =>
                    buildWalletAttributionInput({
                      walletId: row.walletId,
                      tags: row.tags,
                      metrics: row.metrics,
                      inferredWinRate: row.inferredWinRate,
                      inferredResolvedCount: row.inferredResolvedCount,
                      trackedExposureUsd: row.trackedExposureUsd,
                      topChanges: summaryMapForFilters?.get(row.walletId)
                        ?.topChanges,
                    }),
                  ),
                  attributionPolicy.effective,
                  {
                    mode: "filters",
                    filterPrimary: primaryFilterTyped,
                    filterLabels: labelsFilterTyped,
                  },
                );
                for (const [
                  walletId,
                  attribution,
                ] of chunkAttribution.entries()) {
                  attributionMapForFilters.set(walletId, attribution);
                }
              }

              postFilterRows = tagsOnlyRows.filter((row) =>
                walletMatchesFilters(
                  row.tags,
                  attributionMapForFilters.get(row.walletId),
                  {
                    tags: [],
                    tagMode: query.tagMode,
                    primary: primaryFilter,
                    labels: labelsFilter,
                    labelMode: query.labelMode,
                  },
                ),
              );
            }

            if (
              shouldReturnFilterTooBroad({
                filteredCount: postFilterRows.length,
                requestedOffset: query.offset,
                requestedLimit: query.limit,
                hitScanCap,
                hasMoreCandidates,
              })
            ) {
              return {
                filterTooBroad: true as const,
                maxScanCandidates,
              };
            }

            let pagedRows = postFilterRows.slice(
              query.offset,
              query.offset + query.limit,
            );
            const pagedIds = pagedRows.map((row) => row.walletId);

            if (useSlimWhaleSelector && pagedIds.length > 0) {
              const activityStateMap = await loadWalletActivityStateByIds(
                client,
                pagedIds,
                query.windowDays,
              );
              pagedRows = pagedRows.map((row) => {
                const activityState = activityStateMap.get(row.walletId);
                if (!activityState) return row;
                return {
                  ...row,
                  lastActivityAt:
                    activityState.last_activity_at ?? row.lastActivityAt,
                  activityKind: resolveWalletActivityKind(
                    activityState.has_trade_activity,
                    activityState.has_holder_activity,
                  ),
                };
              });
            }

            if (useSlimWhaleSelector && pagedIds.length > 0) {
              const pageMetadataMap = await loadWhalePageMetadataByIds(
                client,
                userId,
                pagedIds,
              );
              pagedRows = pagedRows.map((row) =>
                hydrateWhaleItemMetadata(
                  row,
                  pageMetadataMap.get(row.walletId) ?? null,
                ),
              );
            }
            if (pagedIds.length > 0) {
              const resolvedTradeStatsMap =
                await loadWalletResolvedTradeStatsMap(client, pagedIds);
              pagedRows = pagedRows.map((row) => {
                const stats = resolvedTradeStatsMap.get(row.walletId);
                return {
                  ...row,
                  metrics: applyResolvedTradeStatsToMetrics(
                    row.metrics ?? null,
                    stats,
                    row.lastSeenAt,
                  ),
                  inferredWinRate:
                    row.inferredWinRate ?? stats?.winRate ?? null,
                  inferredResolvedCount:
                    row.inferredResolvedCount ?? stats?.resolvedCount ?? null,
                };
              });
            }
            if (pagedIds.length > 0) {
              const onchainStateMap = await loadWalletOnchainStateByIds(
                client,
                pagedIds,
              );
              pagedRows = pagedRows.map((row) => ({
                ...row,
                ...buildWalletOnchainFields({
                  chain: row.chain,
                  address: row.address,
                  fallbackOwnerAddress: row.ownerAddress,
                  fallbackOwnerWalletId: row.ownerWalletId,
                  state: onchainStateMap.get(row.walletId) ?? null,
                }),
              }));
            }

            const summaryMapForPage =
              summaryMapForFilters ?? new Map<string, WalletActivitySummary>();
            const needsSummaryForPage =
              query.includeSummary || includeAttributionInResponse;
            if (needsSummaryForPage) {
              const missingIds = pagedIds.filter(
                (id) => !summaryMapForPage.has(id),
              );
              if (missingIds.length > 0) {
                const summaryOptions = {
                  windowHours,
                  topChanges: query.topChanges,
                  baselineDays: 30,
                  enteredLateHours: 24,
                };
                const [pageSummaryStats, pageTopChanges] = await Promise.all([
                  fetchWalletActivitySummaryStats(
                    client,
                    missingIds,
                    summaryOptions,
                  ),
                  fetchWalletActivityTopChanges(
                    client,
                    missingIds,
                    summaryOptions,
                  ),
                ]);
                for (const walletId of missingIds) {
                  const summaryStats = pageSummaryStats.get(walletId);
                  if (!summaryStats) continue;
                  summaryMapForPage.set(walletId, {
                    ...summaryStats,
                    topChanges: pageTopChanges.get(walletId) ?? [],
                  });
                }
              }
            }

            const [
              topMarketMap,
              followerCountsMap,
              sparklineMap,
              portfolioPerformanceMap,
            ] = await Promise.all([
              loadWhaleTopMarkets(
                client,
                pagedIds,
                query.marketLimit,
                query.windowDays,
              ),
              loadWalletFollowerCountsMap(client, pagedIds),
              query.includeSparkline
                ? fetchWalletSparklineMap(client, pagedIds, {
                    metric: query.sparklineMetric,
                    windowHours,
                  })
                : Promise.resolve(new Map<string, WalletActivitySparkline>()),
              loadWalletPortfolioPerformanceMap(client, pagedIds, {
                rangeHours: 720,
              }),
            ]);

            const pageAttributionMap =
              pagedRows.length > 0
                ? await buildWalletAttributionMap(
                    client,
                    pagedRows.map((row) =>
                      buildWalletAttributionInput({
                        walletId: row.walletId,
                        tags: row.tags,
                        metrics: row.metrics,
                        portfolioPnl30dUsd:
                          portfolioPerformanceMap.get(row.walletId)?.pnlUsd ??
                          null,
                        inferredWinRate: row.inferredWinRate,
                        inferredResolvedCount: row.inferredResolvedCount,
                        trackedExposureUsd: row.trackedExposureUsd,
                        topChanges: summaryMapForPage.get(row.walletId)
                          ?.topChanges,
                      }),
                    ),
                    attributionPolicy.effective,
                    { mode: "full" },
                  )
                : new Map<string, WalletAttribution>();

            const wallets = pagedRows.map((row) => {
              const summary = summaryMapForPage.get(row.walletId) ?? null;
              const hydrated = hydrateWhaleItemFromSummary(
                {
                  ...row,
                  followersCount: followerCountsMap.get(row.walletId) ?? 0,
                  portfolioPerformance30d:
                    portfolioPerformanceMap.get(row.walletId) ?? null,
                },
                summary,
                query.includeSummary,
                topMarketMap.get(row.walletId) ?? [],
              );
              const withSparkline = query.includeSparkline
                ? {
                    ...hydrated,
                    sparkline:
                      sparklineMap.get(row.walletId) ??
                      buildEmptyWalletSparkline({
                        metric: query.sparklineMetric,
                        windowHours,
                      }),
                  }
                : hydrated;
              const withAttribution = includeAttributionInResponse
                ? {
                    ...withSparkline,
                    attribution: pageAttributionMap.get(row.walletId),
                  }
                : withSparkline;
              return applyWalletResponsePresentation(withAttribution, {
                includeAttributionInResponse,
                attributionMap: pageAttributionMap,
              });
            });

            return {
              filterTooBroad: false as const,
              payload: {
                ok: true,
                wallets,
              },
            };
          },
        );

        if (result.filterTooBroad) {
          reply.code(422);
          return reply.send({
            error: "filter_too_broad",
            message:
              "Filter is too broad for current scan limits. Narrow filters or reduce offset.",
            statusCode: 422,
            details: {
              route: "/wallets/whales",
              maxScanCandidates: result.maxScanCandidates,
            },
          });
        }

        const body = JSON.stringify(result.payload);
        if (cacheTtlSec > 0) {
          await writeWalletIntelCachedBody(
            cacheClient,
            cacheKey,
            body,
            cacheTtlSec,
          );
        }
        applyWalletIntelCacheHeaders({
          reply,
          hit: false,
          layer: "none",
          cacheStatus: cacheContext.status,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(body);
      } catch (error) {
        app.log.error({ error, userId, query }, "Failed to load whale wallets");
        reply.code(500);
        return reply.send({ error: "Failed to load whale wallets" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/:walletId
   */
  z.get(
    "/wallets/:walletId",
    {
      preHandler: createAuthMiddleware({ optional: true }),
      schema: {
        params: walletProfileParamsSchema,
        querystring: walletProfileQuerySchema,
      },
    },
    async (request, reply) => {
      const userId = request.user?.id ?? null;

      const walletId = request.params.walletId;
      const query = request.query;
      const cacheTtlSec = Math.max(0, Math.trunc(env.walletIntelTtlSec));
      const cacheContext = await resolveWalletIntelCacheContext(cacheTtlSec);
      const cacheClient = cacheContext.redis;
      const cacheKey = walletIntelCacheKey(
        "wallets-profile",
        userId ?? "anon",
        { walletId, query },
      );
      const cached = await readWalletIntelCachedBody(
        cacheClient,
        cacheKey,
        cacheTtlSec,
      );
      if (cached) {
        applyWalletIntelCacheHeaders({
          reply,
          hit: true,
          layer: cached.layer,
          cacheStatus: cacheContext.status,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(cached.body);
      }

      const client = await pool.connect();
      try {
        const wallet =
          (await loadWalletRowsByIds(client, userId, [walletId], null)).find(
            (candidate) => candidate.id === walletId,
          ) ?? null;
        if (!wallet) {
          reply.code(404);
          return reply.send({ error: "Wallet not found" });
        }
        const resolvedTradeStatsMap = await loadWalletResolvedTradeStatsMap(
          client,
          [walletId],
        );
        wallet.metrics = applyResolvedTradeStatsToMetrics(
          wallet.metrics ?? null,
          resolvedTradeStatsMap.get(walletId),
          wallet.last_seen_at,
        );

        const [
          followerCountsMap,
          openPositionStatsMap,
          portfolioPerformanceMap,
          refreshPolicy,
          attributionPolicy,
          signalsPolicy,
          entryBracketStats,
          categoryMix,
          onchainStateMap,
        ] = await Promise.all([
          loadWalletFollowerCountsMap(client, [walletId]),
          loadWalletOpenPositionStatsPreferRollupMap(client, [walletId]),
          loadWalletPortfolioPerformanceMap(client, [walletId], {
            rangeHours: 720,
          }),
          resolveWalletIntelRefreshPolicy(client),
          resolveWalletIntelAttributionPolicy(client),
          resolveWalletIntelSignalsPolicy(client),
          loadWalletEntryBracketStats(client, walletId),
          loadWalletCategoryMix(client, walletId),
          loadWalletOnchainStateByIds(client, [walletId]),
        ]);
        const marketTypeMetricsMap = query.includeMarketTypeMetrics
          ? await loadWalletMarketTypeMetricsMap(client, {
              walletIds: [walletId],
            })
          : new Map();
        const openPositionStats = openPositionStatsMap.get(walletId) ?? null;
        const signalSummaryOptions = {
          windowHours: 720,
          topChanges: ATTRIBUTION_SIGNAL_SUMMARY_TOP_CHANGES,
          baselineDays: 30,
          enteredLateHours: 24,
          signalConfig: {
            maxOdds: signalsPolicy.effective.maxOdds,
            minStakeUsd: signalsPolicy.effective.minStakeUsd,
            minIdleDays: signalsPolicy.effective.minIdleDays,
            maxPriorMarkets: signalsPolicy.effective.maxPriorMarkets,
            minPayoutUsd: signalsPolicy.effective.minPayoutUsd,
            lateHours: signalsPolicy.effective.lateHours,
            veryLateHours: signalsPolicy.effective.veryLateHours,
            retentionDaysActivity:
              refreshPolicy.effective.retentionDaysActivity,
            weightStake: signalsPolicy.effective.weightStake,
            weightOdds: signalsPolicy.effective.weightOdds,
            weightIdle: signalsPolicy.effective.weightIdle,
            weightNovelty: signalsPolicy.effective.weightNovelty,
            minScore: signalsPolicy.effective.minScore,
          },
        };

        const [summary, signalSummaryMap, mmDiagnosticsByWallet] =
          await Promise.all([
            fetchWalletActivitySummaryStats(
              client,
              [walletId],
              signalSummaryOptions,
            ),
            fetchWalletActivitySignalSummary(
              client,
              [walletId],
              signalSummaryOptions,
            ),
            loadWalletMmDiagnosticsMap(
              client,
              [{ walletId, chain: wallet.chain }],
              refreshPolicy.effective,
            ),
          ]);
        const walletSummary = summary.get(walletId) ?? null;

        const attribution =
          (
            await buildWalletAttributionMap(
              client,
              [
                buildWalletAttributionInput({
                  walletId: wallet.id,
                  tags: wallet.tags,
                  metrics: wallet.metrics,
                  portfolioPnl30dUsd:
                    portfolioPerformanceMap.get(walletId)?.pnlUsd ?? null,
                  inferredWinRate: null,
                  inferredResolvedCount: null,
                  trackedExposureUsd:
                    openPositionStats?.trackedExposureUsd ?? null,
                  topChanges: [],
                  signalSummary: signalSummaryMap.get(walletId) ?? null,
                  mmSuspected:
                    mmDiagnosticsByWallet.get(walletId)?.mmSuspected ?? null,
                }),
              ],
              attributionPolicy.effective,
              { mode: "full" },
            )
          ).get(walletId) ?? null;

        const presentation = applyWalletPresentationFields(
          {
            metrics: wallet.metrics ?? null,
            lastActivityAt:
              walletSummary?.lastActivityAt ?? wallet.last_seen_at,
            tags: wallet.tags ?? [],
            unusualTier: walletSummary?.unusualTier ?? null,
          },
          attribution,
        );

        const responseProfile = isRecord(wallet.profile)
          ? {
              ...wallet.profile,
              categories:
                categoryMix.length > 0
                  ? categoryMix.map((item) => item.category)
                  : Array.isArray(wallet.profile.categories)
                    ? wallet.profile.categories
                    : [],
            }
          : (wallet.profile ?? null);

        const payload = {
          ok: true,
          wallet: {
            walletId: wallet.id,
            address: wallet.address,
            chain: wallet.chain,
            label: wallet.label,
            userName: wallet.user_name ?? null,
            userLabel: wallet.user_label ?? null,
            userLabelColor: wallet.user_label_color ?? null,
            ...extractWalletIdentityDisplayFields(wallet.metadata, wallet.label),
            followersCount: followerCountsMap.get(wallet.id) ?? 0,
            topLabelVariant: presentation.topLabelVariant,
            headlineTag: presentation.headlineTag,
            primaryLabel: presentation.primaryLabel,
            secondaryLabels: presentation.secondaryLabels,
            badges: presentation.badges,
            avgTradeSizeUsd: presentation.avgTradeSizeUsd,
            trackedExposureUsd: openPositionStats?.trackedExposureUsd ?? null,
            openPositionsCount: openPositionStats?.openPositionsCount ?? 0,
            openMarketsCount: openPositionStats?.openMarketsCount ?? 0,
            avgOpenPositionSizeUsd:
              openPositionStats?.avgOpenPositionSizeUsd ?? null,
            avgOpenEntryPrice: openPositionStats?.avgOpenEntryPrice ?? null,
            avgOpenEntryApprox: openPositionStats?.avgOpenEntryApprox ?? null,
            isSystemFlagged: wallet.is_system_flagged,
            firstSeenAt: wallet.first_seen_at,
            lastSeenAt: wallet.last_seen_at,
            tags: wallet.tags ?? [],
            metrics: serializeWalletMetrics(wallet.metrics ?? null),
            portfolioPerformance30d:
              portfolioPerformanceMap.get(walletId) ?? null,
            profile: responseProfile,
            profileUpdatedAt: wallet.profile_updated_at ?? null,
            ...buildWalletOnchainFields({
              chain: wallet.chain,
              address: wallet.address,
              state: onchainStateMap.get(walletId) ?? null,
            }),
            attribution,
            categoryMix,
            entryBracketStats,
            marketTypeMetrics30d: query.includeMarketTypeMetrics
              ? Array.from(marketTypeMetricsMap.values()).sort((a, b) => {
                  const sampleDelta =
                    b.resolvedEdgeSampleCount - a.resolvedEdgeSampleCount;
                  if (sampleDelta !== 0) return sampleDelta;
                  return (b.volumeUsd ?? 0) - (a.volumeUsd ?? 0);
                })
              : undefined,
          },
        };
        const body = JSON.stringify(payload);
        if (cacheTtlSec > 0) {
          await writeWalletIntelCachedBody(
            cacheClient,
            cacheKey,
            body,
            cacheTtlSec,
          );
        }
        applyWalletIntelCacheHeaders({
          reply,
          hit: false,
          layer: "none",
          cacheStatus: cacheContext.status,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(body);
      } catch (error) {
        app.log.error({ error, walletId, userId }, "Failed to load wallet");
        reply.code(500);
        return reply.send({ error: "Failed to load wallet" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/:walletId/series
   */
  z.get(
    "/wallets/:walletId/series",
    {
      preHandler: createAuthMiddleware({ optional: true }),
      schema: {
        params: walletProfileParamsSchema,
        querystring: walletSeriesQuerySchema,
      },
    },
    async (request, reply) => {
      const userId = request.user?.id ?? null;

      const walletId = request.params.walletId;
      const query = request.query;
      const client = await pool.connect();
      try {
        const walletExists = await client.query<{ id: string }>(
          `select id from wallets where id = $1 limit 1`,
          [walletId],
        );
        if (!walletExists.rows[0]?.id) {
          reply.code(404);
          return reply.send({ error: "Wallet not found" });
        }

        const activityWindowHours = query.windowHours ?? 168;
        const [activityMap, performance, portfolioPnlSeries] =
          await Promise.all([
            fetchWalletActivitySparklines(client, [walletId], {
              windowHours: activityWindowHours,
              bucketHours: query.bucketHours,
            }),
            fetchWalletPerformanceSeries(client, walletId, {
              period: query.period,
              windowHours: query.windowHours,
              bucketHours:
                query.windowHours != null ? query.bucketHours : undefined,
              limit: query.limit,
            }),
            fetchWalletPortfolioPnlSeries(client, walletId, {
              rangeHours: activityWindowHours,
              bucketHours: query.bucketHours,
              limit: query.limit,
            }),
          ]);

        return reply.send({
          ok: true,
          walletId,
          activity:
            activityMap.get(walletId) ??
            buildEmptyWalletActivitySparkline({
              windowHours: activityWindowHours,
              bucketHours: query.bucketHours,
            }),
          performance,
          portfolioPerformance: portfolioPnlSeries.performance,
          portfolioPnlSeries,
        });
      } catch (error) {
        app.log.error(
          { error, walletId, userId, query },
          "Failed to load wallet series",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load wallet series" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/activity/summary/stats
   */
  z.get(
    "/wallets/activity/summary/stats",
    {
      preHandler: createAuthMiddleware({ optional: true }),
      schema: { querystring: walletActivitySummaryStatsQuerySchema },
    },
    async (request, reply) => {
      const userId = request.user?.id ?? null;

      const query = request.query;
      const cacheTtlSec = Math.max(0, Math.trunc(env.walletIntelTtlSec));
      const cacheContext = await resolveWalletIntelCacheContext(cacheTtlSec);
      const cacheClient = cacheContext.redis;
      const cacheKey = walletIntelCacheKey(
        "wallets-activity-summary-stats",
        userId ?? "anon",
        query,
      );
      const cached = await readWalletIntelCachedBody(
        cacheClient,
        cacheKey,
        cacheTtlSec,
      );
      if (cached) {
        applyWalletIntelCacheHeaders({
          reply,
          hit: true,
          layer: cached.layer,
          cacheStatus: cacheContext.status,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(cached.body);
      }

      const client = await pool.connect();
      try {
        const payload = await withWalletIntelQuerySettings(
          client,
          { workMem: "16MB" },
          async () => {
            const [refreshPolicy, signalsPolicy] = await Promise.all([
              resolveWalletIntelRefreshPolicy(client),
              resolveWalletIntelSignalsPolicy(client),
            ]);
            const windowHours = resolveSignalWindowHours(
              query.windowHours,
              signalsPolicy.effective,
            );
            const stats = await loadWalletActivitySummaryHeroStats(
              client,
              userId,
              {
                windowHours,
                refreshPolicy: refreshPolicy.effective,
              },
            );

            return {
              ok: true as const,
              stats,
            };
          },
        );

        if (cacheTtlSec > 0) {
          await writeWalletIntelCachedBody(
            cacheClient,
            cacheKey,
            JSON.stringify(payload),
            cacheTtlSec,
          );
        }
        applyWalletIntelCacheHeaders({
          reply,
          hit: false,
          layer: "none",
          cacheStatus: cacheContext.status,
        });

        return reply.send(payload);
      } catch (error) {
        app.log.error(
          { error, userId, query },
          "Failed to load wallet activity summary stats",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to load wallet activity summary stats",
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/activity/summary
   */
  z.get(
    "/wallets/activity/summary",
    {
      preHandler: createAuthMiddleware({ optional: true }),
      schema: { querystring: walletActivitySummaryQuerySchema },
    },
    async (request, reply) => {
      const userId = request.user?.id ?? null;

      const query = request.query;
      if (!userId && query.scope === "following") {
        reply.code(401);
        return reply.send({
          error: "Authentication required for following scope",
        });
      }
      const categoryFilterRaw = Array.isArray(query.categories)
        ? query.categories
        : query.categories
          ? [query.categories]
          : [];
      const categoryFilter = Array.from(
        new Set(
          categoryFilterRaw
            .map((category: string) => category.trim().toLowerCase())
            .filter(Boolean),
        ),
      );
      const tagsFilter = normalizeStringArray(query.tags);
      const primaryFilter = normalizeStringArray(query.primary);
      const labelsFilter = normalizeStringArray(query.labels);
      const primaryFilterTyped =
        normalizeAttributionPrimaryFilters(primaryFilter);
      const labelsFilterTyped = normalizeAttributionLabelFilters(labelsFilter);
      const requiresSummaryForAttributionFilters =
        filtersRequireSummaryHydration(primaryFilterTyped, labelsFilterTyped);
      const cacheTtlSec = Math.max(0, Math.trunc(env.walletIntelTtlSec));
      const cacheContext = await resolveWalletIntelCacheContext(cacheTtlSec);
      const cacheClient = cacheContext.redis;
      const cacheKey = walletIntelCacheKey(
        "wallets-activity-summary",
        userId ?? "anon",
        query,
      );
      const cached = await readWalletIntelCachedBody(
        cacheClient,
        cacheKey,
        cacheTtlSec,
      );
      if (cached) {
        applyWalletIntelCacheHeaders({
          reply,
          hit: true,
          layer: cached.layer,
          cacheStatus: cacheContext.status,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(cached.body);
      }
      const client = await pool.connect();
      try {
        const payload = await withWalletIntelQuerySettings(
          client,
          { workMem: "32MB" },
          async () => {
            const [refreshPolicy, signalsPolicy, attributionPolicy] =
              await Promise.all([
                resolveWalletIntelRefreshPolicy(client),
                resolveWalletIntelSignalsPolicy(client),
                resolveWalletIntelAttributionPolicy(client),
              ]);
            const attributionEnabled = attributionPolicy.effective.enabled;
            const needsAttributionForFilters =
              primaryFilter.length > 0 || labelsFilter.length > 0;
            const includeAttributionInResponse =
              query.includeAttribution && attributionEnabled;
            const signalConfig = signalsPolicy.effective;
            const windowHours = resolveSignalWindowHours(
              query.windowHours,
              signalConfig,
            );
            const candidateWalletIds = await loadWalletIdsForSummaryScope(
              client,
              userId,
              query.scope,
              {
                windowHours,
                minActivityUsd: refreshPolicy.effective.minActivityUsd,
                minActivityShares: refreshPolicy.effective.minActivityShares,
              },
            );
            const filteredWalletIds = await filterWalletIdsByMetadata(
              client,
              candidateWalletIds,
              {
                categories: categoryFilter,
                tags: tagsFilter,
                tagMode: query.tagMode,
              },
            );
            const searchedWalletIds =
              await filterWalletIdsByActivitySummarySearch(
                client,
                userId,
                filteredWalletIds,
                {
                  q: query.q,
                  marketId: query.marketId,
                  eventId: query.eventId,
                  windowHours,
                },
              );
            let workingWalletIds = searchedWalletIds;
            if (
              needsAttributionForFilters &&
              !requiresSummaryForAttributionFilters &&
              workingWalletIds.length > 0
            ) {
              workingWalletIds = await filterWalletIdsByAttribution(
                client,
                workingWalletIds,
                attributionPolicy.effective,
                {
                  primary: primaryFilter,
                  labels: labelsFilter,
                  labelMode: query.labelMode,
                  primaryTyped: primaryFilterTyped,
                  labelsTyped: labelsFilterTyped,
                },
              );
            }
            if (workingWalletIds.length === 0) {
              return { ok: true, items: [] };
            }

            const summaryOptions = {
              windowHours,
              topChanges: query.topChanges,
              baselineDays: 30,
              enteredLateHours: 24,
              signalConfig: {
                maxOdds: signalConfig.maxOdds,
                minStakeUsd: signalConfig.minStakeUsd,
                minIdleDays: signalConfig.minIdleDays,
                maxPriorMarkets: signalConfig.maxPriorMarkets,
                minPayoutUsd: signalConfig.minPayoutUsd,
                lateHours: signalConfig.lateHours,
                veryLateHours: signalConfig.veryLateHours,
                retentionDaysActivity:
                  refreshPolicy.effective.retentionDaysActivity,
                weightStake: signalConfig.weightStake,
                weightOdds: signalConfig.weightOdds,
                weightIdle: signalConfig.weightIdle,
                weightNovelty: signalConfig.weightNovelty,
                minScore: signalConfig.minScore,
              },
            };
            const attributionSummaryOptions = {
              ...summaryOptions,
              topChanges: Math.max(
                summaryOptions.topChanges,
                ATTRIBUTION_SIGNAL_SUMMARY_TOP_CHANGES,
              ),
            };
            if (
              !needsAttributionForFilters ||
              !requiresSummaryForAttributionFilters
            ) {
              const summaryStatsMap = await fetchWalletActivitySummaryStats(
                client,
                workingWalletIds,
                summaryOptions,
              );
              const sortMode = query.sort as WalletActivitySummarySortMode;
              const sortedStats = Array.from(summaryStatsMap.values())
                .filter((row) => Boolean(row.lastActivityAt))
                .sort((a, b) =>
                  compareWalletActivitySummaryStats(a, b, sortMode),
                );
              const pagedStats = sortedStats.slice(
                query.offset,
                query.offset + query.limit,
              );
              const pagedIds = pagedStats.map((row) => row.walletId);
              if (pagedIds.length === 0) {
                return { ok: true, items: [] };
              }
              const [
                pageRows,
                pageTopChangesMap,
                pageSignalSummaryMap,
                sparklineMap,
                followerCountsMap,
                openPositionStatsMap,
                portfolioPerformanceMap,
                resolvedTradeStatsMap,
              ] = await Promise.all([
                loadWalletRowsByIds(client, userId, pagedIds, null),
                fetchWalletActivityTopChanges(client, pagedIds, summaryOptions),
                fetchWalletActivitySignalSummary(
                  client,
                  pagedIds,
                  attributionSummaryOptions,
                ),
                query.includeSparkline
                  ? fetchWalletSparklineMap(client, pagedIds, {
                      metric: query.sparklineMetric,
                      windowHours,
                    })
                  : Promise.resolve(new Map<string, WalletActivitySparkline>()),
                loadWalletFollowerCountsMap(client, pagedIds),
                loadWalletOpenPositionStatsPreferRollupMap(client, pagedIds),
                loadWalletPortfolioPerformanceMap(client, pagedIds, {
                  rangeHours: 720,
                }),
                loadWalletResolvedTradeStatsMap(client, pagedIds),
              ]);
              const mmDiagnosticsByWallet = await loadWalletMmDiagnosticsMap(
                client,
                pageRows.map((row) => ({
                  walletId: row.id,
                  chain: row.chain,
                })),
                refreshPolicy.effective,
              );
              const rowById = new Map(
                pageRows.map((row) => {
                  const resolvedStats = resolvedTradeStatsMap.get(row.id);
                  return [
                    row.id,
                    {
                      ...row,
                      metrics: applyResolvedTradeStatsToMetrics(
                        row.metrics,
                        resolvedStats,
                        row.last_seen_at,
                      ),
                    },
                  ] as const;
                }),
              );
              const attributionMap =
                pagedIds.length > 0
                  ? await buildWalletAttributionMap(
                      client,
                      pagedIds
                        .map((walletId) => {
                          const row = rowById.get(walletId);
                          if (!row) return null;
                          return buildWalletAttributionInput({
                            walletId,
                            tags: row.tags,
                            metrics: row.metrics,
                            portfolioPnl30dUsd:
                              portfolioPerformanceMap.get(walletId)?.pnlUsd ??
                              null,
                            inferredWinRate: null,
                            inferredResolvedCount: null,
                            trackedExposureUsd:
                              openPositionStatsMap.get(walletId)
                                ?.trackedExposureUsd ?? null,
                            topChanges: [],
                            signalSummary:
                              pageSignalSummaryMap.get(walletId) ?? null,
                            mmSuspected:
                              mmDiagnosticsByWallet.get(walletId)
                                ?.mmSuspected ?? null,
                          });
                        })
                        .filter(
                          (
                            entry,
                          ): entry is ReturnType<
                            typeof buildWalletAttributionInput
                          > => Boolean(entry),
                        ),
                      attributionPolicy.effective,
                      { mode: "full" },
                    )
                  : new Map<string, WalletAttribution>();
              const items = pagedStats
                .map<SerializedWalletMetricsHolder<WalletActivitySummaryItem> | null>(
                  (summary) => {
                    const row = rowById.get(summary.walletId);
                    if (!row) return null;
                    const baseItem = buildWalletSummaryItem(row, summary, {
                      followersCount: followerCountsMap.get(row.id) ?? 0,
                      topChanges: pageTopChangesMap.get(row.id) ?? [],
                      openPositionStats: openPositionStatsMap.get(
                        summary.walletId,
                      ) ?? {
                        trackedExposureUsd: null,
                        openPositionsCount: 0,
                        openMarketsCount: 0,
                        avgOpenPositionSizeUsd: null,
                        avgOpenEntryPrice: null,
                        avgOpenEntryApprox: null,
                      },
                      portfolioPerformance30d:
                        portfolioPerformanceMap.get(row.id) ?? null,
                    });
                    const withSparkline = query.includeSparkline
                      ? {
                          ...baseItem,
                          sparkline:
                            sparklineMap.get(row.id) ??
                            buildEmptyWalletSparkline({
                              metric: query.sparklineMetric,
                              windowHours,
                            }),
                        }
                      : baseItem;
                    const withAttribution = includeAttributionInResponse
                      ? {
                          ...withSparkline,
                          attribution: attributionMap.get(row.id),
                        }
                      : withSparkline;
                    return applyWalletResponsePresentation(withAttribution, {
                      includeAttributionInResponse,
                      attributionMap,
                    });
                  },
                )
                .filter(
                  (
                    row,
                  ): row is SerializedWalletMetricsHolder<WalletActivitySummaryItem> =>
                    Boolean(row),
                );
              return { ok: true, items };
            }

            const candidates = await loadWalletRowsByIds(
              client,
              userId,
              searchedWalletIds,
              null,
            );
            const summaryStatsMap = await fetchWalletActivitySummaryStats(
              client,
              searchedWalletIds,
              summaryOptions,
            );

            const merged = candidates
              .map<WalletActivitySummaryItem | null>((row) => {
                const summary = summaryStatsMap.get(row.id);
                if (!summary || !summary.lastActivityAt) return null;
                return buildWalletSummaryItem(row, summary);
              })
              .filter((row): row is WalletActivitySummaryItem => Boolean(row));
            const mergedPortfolioPerformanceMap =
              merged.length > 0
                ? await loadWalletPortfolioPerformanceMap(
                    client,
                    merged.map((row) => row.walletId),
                    { rangeHours: 720 },
                  )
                : new Map<string, WalletPortfolioPerformance>();

            const resolvedTradeStatsMap =
              merged.length > 0
                ? await loadWalletResolvedTradeStatsMap(
                    client,
                    merged.map((row) => row.walletId),
                  )
                : new Map<string, WalletResolvedTradeStats>();
            const mergedWithResolved = merged.map((row) => {
              const stats = resolvedTradeStatsMap.get(row.walletId);
              return {
                ...row,
                metrics: applyResolvedTradeStatsToMetrics(
                  row.metrics ?? null,
                  stats,
                  row.lastSeenAt,
                ),
                portfolioPerformance30d:
                  mergedPortfolioPerformanceMap.get(row.walletId) ?? null,
                inferredWinRate: row.inferredWinRate ?? stats?.winRate ?? null,
                inferredResolvedCount:
                  row.inferredResolvedCount ?? stats?.resolvedCount ?? null,
              };
            });

            let signalSummaryForFilters = new Map<
              string,
              WalletActivitySignalSummary
            >();
            let mmDiagnosticsByWallet = new Map<string, WalletMmDiagnostics>();
            let attributionMap = new Map<string, WalletAttribution>();
            let filtered = mergedWithResolved;

            if (mergedWithResolved.length > 0) {
              [signalSummaryForFilters, mmDiagnosticsByWallet] =
                await Promise.all([
                  fetchWalletActivitySignalSummary(
                    client,
                    mergedWithResolved.map((row) => row.walletId),
                    attributionSummaryOptions,
                  ),
                  loadWalletMmDiagnosticsMap(
                    client,
                    mergedWithResolved.map((row) => ({
                      walletId: row.walletId,
                      chain: row.chain,
                    })),
                    refreshPolicy.effective,
                  ),
                ]);
              attributionMap = await buildWalletAttributionMap(
                client,
                mergedWithResolved.map((row) =>
                  buildWalletAttributionInput({
                    walletId: row.walletId,
                    tags: row.tags,
                    metrics: row.metrics,
                    portfolioPnl30dUsd:
                      row.portfolioPerformance30d?.pnlUsd ?? null,
                    inferredWinRate: row.inferredWinRate,
                    inferredResolvedCount: row.inferredResolvedCount,
                    trackedExposureUsd: null,
                    topChanges: [],
                    signalSummary:
                      signalSummaryForFilters.get(row.walletId) ?? null,
                    mmSuspected:
                      mmDiagnosticsByWallet.get(row.walletId)?.mmSuspected ??
                      null,
                  }),
                ),
                attributionPolicy.effective,
                {
                  mode: "filters",
                  filterPrimary: primaryFilterTyped,
                  filterLabels: labelsFilterTyped,
                },
              );
              filtered = mergedWithResolved.filter((row) =>
                walletMatchesFilters(
                  row.tags,
                  attributionMap.get(row.walletId),
                  {
                    tags: [],
                    tagMode: "any",
                    primary: primaryFilter,
                    labels: labelsFilter,
                    labelMode: query.labelMode,
                  },
                ),
              );
            }

            const sortMode = query.sort as WalletActivitySummarySortMode;
            const sorted = filtered.sort((a, b) =>
              compareWalletActivitySummaryStats(a, b, sortMode),
            );

            const start = query.offset;
            const end = start + query.limit;
            const pagedRows = sorted.slice(start, end);
            const pagedIds = pagedRows.map((row) => row.walletId);
            const pageTopChangesMap = new Map<
              string,
              WalletActivityTopChange[]
            >();
            if (pagedIds.length > 0) {
              const topChangesForPage = await fetchWalletActivityTopChanges(
                client,
                pagedIds,
                summaryOptions,
              );
              for (const [
                walletId,
                topChanges,
              ] of topChangesForPage.entries()) {
                pageTopChangesMap.set(walletId, topChanges);
              }
            }
            const [
              sparklineMap,
              followerCountsMap,
              openPositionStatsMap,
              portfolioPerformanceMap,
            ] = await Promise.all([
              query.includeSparkline
                ? fetchWalletSparklineMap(client, pagedIds, {
                    metric: query.sparklineMetric,
                    windowHours,
                  })
                : Promise.resolve(new Map<string, WalletActivitySparkline>()),
              loadWalletFollowerCountsMap(client, pagedIds),
              loadWalletOpenPositionStatsPreferRollupMap(client, pagedIds),
              loadWalletPortfolioPerformanceMap(client, pagedIds, {
                rangeHours: 720,
              }),
            ]);
            attributionMap =
              pagedRows.length > 0
                ? await buildWalletAttributionMap(
                    client,
                    pagedRows.map((row) =>
                      buildWalletAttributionInput({
                        walletId: row.walletId,
                        tags: row.tags,
                        metrics: row.metrics,
                        portfolioPnl30dUsd:
                          portfolioPerformanceMap.get(row.walletId)?.pnlUsd ??
                          row.portfolioPerformance30d?.pnlUsd ??
                          null,
                        inferredWinRate: null,
                        inferredResolvedCount: null,
                        trackedExposureUsd:
                          openPositionStatsMap.get(row.walletId)
                            ?.trackedExposureUsd ?? null,
                        topChanges: [],
                        signalSummary:
                          signalSummaryForFilters.get(row.walletId) ?? null,
                        mmSuspected:
                          mmDiagnosticsByWallet.get(row.walletId)
                            ?.mmSuspected ?? null,
                      }),
                    ),
                    attributionPolicy.effective,
                    { mode: "full" },
                  )
                : new Map<string, WalletAttribution>();

            const items = pagedRows.map((row) => {
              const openPositionStats =
                openPositionStatsMap.get(row.walletId) ?? null;
              const withTopChanges = {
                ...row,
                followersCount: followerCountsMap.get(row.walletId) ?? 0,
                topChanges: pageTopChangesMap.get(row.walletId) ?? [],
                portfolioPerformance30d:
                  portfolioPerformanceMap.get(row.walletId) ??
                  row.portfolioPerformance30d ??
                  null,
                trackedExposureUsd:
                  openPositionStats?.trackedExposureUsd ?? null,
                openPositionsCount: openPositionStats?.openPositionsCount ?? 0,
                openMarketsCount: openPositionStats?.openMarketsCount ?? 0,
                avgOpenPositionSizeUsd:
                  openPositionStats?.avgOpenPositionSizeUsd ?? null,
                avgOpenEntryPrice: openPositionStats?.avgOpenEntryPrice ?? null,
                avgOpenEntryApprox:
                  openPositionStats?.avgOpenEntryApprox ?? null,
              };
              const withSparkline = query.includeSparkline
                ? {
                    ...withTopChanges,
                    sparkline:
                      sparklineMap.get(row.walletId) ??
                      buildEmptyWalletSparkline({
                        metric: query.sparklineMetric,
                        windowHours,
                      }),
                  }
                : withTopChanges;
              const withAttribution = includeAttributionInResponse
                ? {
                    ...withSparkline,
                    attribution: attributionMap.get(row.walletId),
                  }
                : withSparkline;
              return applyWalletResponsePresentation(withAttribution, {
                includeAttributionInResponse,
                attributionMap,
              });
            });

            return { ok: true, items };
          },
        );

        const body = JSON.stringify(payload);
        if (cacheTtlSec > 0) {
          await writeWalletIntelCachedBody(
            cacheClient,
            cacheKey,
            body,
            cacheTtlSec,
          );
        }
        applyWalletIntelCacheHeaders({
          reply,
          hit: false,
          layer: "none",
          cacheStatus: cacheContext.status,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(body);
      } catch (error) {
        app.log.error(
          { error, userId, query },
          "Failed to load wallet activity summaries",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to load wallet activity summaries",
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/activity/signals
   */
  z.get(
    "/wallets/activity/signals",
    {
      preHandler: createAuthMiddleware({ optional: true }),
      schema: { querystring: walletActivitySignalsQuerySchema },
    },
    async (request, reply) => {
      const userId = request.user?.id ?? null;

      const query = request.query;
      const categoryFilterRaw = Array.isArray(query.categories)
        ? query.categories
        : query.categories
          ? [query.categories]
          : [];
      const categoryFilter = Array.from(
        new Set(
          categoryFilterRaw
            .map((category: string) => category.trim().toLowerCase())
            .filter(Boolean),
        ),
      );
      const tagsFilter = normalizeStringArray(query.tags);
      const primaryFilter = normalizeStringArray(query.primary);
      const labelsFilter = normalizeStringArray(query.labels);
      const primaryFilterTyped =
        normalizeAttributionPrimaryFilters(primaryFilter);
      const labelsFilterTyped = normalizeAttributionLabelFilters(labelsFilter);
      const requiresSummaryForAttributionFilters =
        filtersRequireSummaryHydration(primaryFilterTyped, labelsFilterTyped);
      const severityFilter = normalizeStringArray(
        (query.severity as string[] | undefined) ?? [],
      );
      const displayReasonFilter = normalizeStringArray(query.displayReasons);
      if (!userId && !query.walletId && query.scope === "following") {
        reply.code(401);
        return reply.send({
          error: "Authentication required for following scope",
        });
      }
      const cacheTtlSec = Math.max(0, Math.trunc(env.walletIntelTtlSec));
      const cacheContext = await resolveWalletIntelCacheContext(cacheTtlSec);
      const cacheClient = cacheContext.redis;
      const cacheKey = walletIntelCacheKey(
        "wallets-activity-signals",
        userId ?? "anon",
        query,
      );
      const cached = await readWalletIntelCachedBody(
        cacheClient,
        cacheKey,
        cacheTtlSec,
      );
      if (cached) {
        applyWalletIntelCacheHeaders({
          reply,
          hit: true,
          layer: cached.layer,
          cacheStatus: cacheContext.status,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(cached.body);
      }
      const client = await pool.connect();
      try {
        const payload = await withWalletIntelQuerySettings(
          client,
          { workMem: "48MB" },
          async () => {
            const [signalsPolicy, refreshPolicy, attributionPolicy] =
              await Promise.all([
                resolveWalletIntelSignalsPolicy(client),
                resolveWalletIntelRefreshPolicy(client),
                resolveWalletIntelAttributionPolicy(client),
              ]);
            const attributionEnabled = attributionPolicy.effective.enabled;
            const needsAttributionForFilters =
              primaryFilter.length > 0 || labelsFilter.length > 0;
            const includeAttributionInResponse =
              query.includeAttribution && attributionEnabled;
            const signalConfig = signalsPolicy.effective;
            const windowHours = resolveSignalWindowHours(
              query.windowHours,
              signalConfig,
            );
            const minScore = query.minScore ?? signalConfig.minScore;
            const maxOdds = query.maxOdds ?? signalConfig.maxOdds;
            const minStakeUsd = query.minStakeUsd ?? signalConfig.minStakeUsd;
            const minIdleDays = query.minIdleDays ?? signalConfig.minIdleDays;
            const maxPriorMarkets =
              query.maxPriorMarkets ?? signalConfig.maxPriorMarkets;
            const minPayoutUsd =
              query.minPayoutUsd ?? signalConfig.minPayoutUsd;

            const candidateWalletIds = query.walletId
              ? [query.walletId]
              : await loadWalletIdsForSignalScope(
                  client,
                  userId,
                  query.scope,
                  windowHours,
                  {
                    minActivityUsd: refreshPolicy.effective.minActivityUsd,
                    minActivityShares:
                      refreshPolicy.effective.minActivityShares,
                  },
                );
            const filteredWalletIds = await filterWalletIdsByMetadata(
              client,
              candidateWalletIds,
              {
                categories: categoryFilter,
                tags: tagsFilter,
                tagMode: query.tagMode,
              },
            );
            let workingWalletIds = filteredWalletIds;
            if (query.excludeMmLike && workingWalletIds.length > 0) {
              workingWalletIds = await filterWalletIdsByMmExclusion(
                client,
                workingWalletIds,
                refreshPolicy.effective,
              );
            }
            if (
              needsAttributionForFilters &&
              !requiresSummaryForAttributionFilters &&
              workingWalletIds.length > 0
            ) {
              workingWalletIds = await filterWalletIdsByAttribution(
                client,
                workingWalletIds,
                attributionPolicy.effective,
                {
                  primary: primaryFilter,
                  labels: labelsFilter,
                  labelMode: query.labelMode,
                  primaryTyped: primaryFilterTyped,
                  labelsTyped: labelsFilterTyped,
                },
              );
            }
            if (workingWalletIds.length === 0) {
              return { ok: true, items: [] as WalletActivitySignalItem[] };
            }

            const signalSummaryOptions = {
              windowHours,
              topChanges: 10,
              baselineDays: 30,
              enteredLateHours: 24,
              signalConfig: {
                maxOdds,
                minStakeUsd,
                minIdleDays,
                maxPriorMarkets,
                minPayoutUsd,
                lateHours: signalConfig.lateHours,
                veryLateHours: signalConfig.veryLateHours,
                retentionDaysActivity:
                  refreshPolicy.effective.retentionDaysActivity,
                weightStake: signalConfig.weightStake,
                weightOdds: signalConfig.weightOdds,
                weightIdle: signalConfig.weightIdle,
                weightNovelty: signalConfig.weightNovelty,
                minScore,
              },
            };
            const canUseSignalsSqlFastPath =
              !requiresSummaryForAttributionFilters &&
              displayReasonFiltersSupportedByFastSignals(displayReasonFilter);

            if (canUseSignalsSqlFastPath) {
              const signalRows = await fetchWalletActivitySignalRowsFast(
                client,
                workingWalletIds,
                {
                  ...signalSummaryOptions,
                  signalType: query.signalType ?? null,
                  lateBucket: query.lateBucket ?? null,
                  reasonCodes:
                    displayReasonFilter.length > 0 ? displayReasonFilter : null,
                  reasonMode: query.signalReasonMode,
                  severityFilters:
                    severityFilter.length > 0
                      ? (severityFilter as WalletSignalSeverity[])
                      : null,
                  severityThresholds:
                    attributionPolicy.effective.signalsDisplay
                      .severityThresholds,
                  limit: query.limit,
                  offset: query.offset,
                },
              );
              if (signalRows.length === 0) {
                return { ok: true, items: [] as WalletActivitySignalItem[] };
              }

              const pageWalletIds = Array.from(
                new Set(signalRows.map((row) => row.walletId)),
              );
              const [pageCandidates, signalPageLabelsMap] = await Promise.all([
                loadWalletRowsByIds(client, userId, pageWalletIds, null),
                fetchWalletActivitySignalPageLabels(
                  client,
                  signalRows.map((row) => ({
                    walletId: row.walletId,
                    venue: row.venue,
                    marketId: row.marketId,
                    positionSide: row.positionSide,
                  })),
                  signalSummaryOptions,
                ),
              ]);
              const candidateByWalletId = new Map(
                pageCandidates.map((row) => [row.id, row] as const),
              );
              const pageWallets = pageCandidates.map((row) => ({
                walletId: row.id,
                chain: row.chain,
              }));
              const mmDiagnosticsByWallet = await loadWalletMmDiagnosticsMap(
                client,
                pageWallets,
                refreshPolicy.effective,
              );

              const items = signalRows
                .map<WalletActivitySignalItem | null>((signalRow) => {
                  const candidate = candidateByWalletId.get(signalRow.walletId);
                  if (!candidate) return null;
                  return buildWalletSignalItemFromSignalRow({
                    candidate,
                    signalRow,
                    mmDiagnostics:
                      mmDiagnosticsByWallet.get(signalRow.walletId) ?? null,
                    pageLabels:
                      signalPageLabelsMap.get(
                        buildSignalRowLabelKey({
                          walletId: signalRow.walletId,
                          venue: signalRow.venue,
                          marketId: signalRow.marketId,
                          positionSide: signalRow.positionSide,
                        }),
                      ) ?? null,
                    attributionPolicy: attributionPolicy.effective,
                  });
                })
                .filter((item): item is WalletActivitySignalItem =>
                  Boolean(item),
                );
              const enrichedItems =
                await enrichWalletSignalItemsWithPositionNow(client, items);

              if (!includeAttributionInResponse) {
                return {
                  ok: true,
                  items: enrichedItems.map((item) =>
                    serializeWalletResponseItem(item),
                  ),
                };
              }

              const attributionInputsByWallet =
                buildWalletAttributionInputMapFromSignalItems(enrichedItems);
              const attributionMap = await buildWalletAttributionMap(
                client,
                Array.from(attributionInputsByWallet.values()),
                attributionPolicy.effective,
                { mode: "full" },
              );
              return {
                ok: true,
                items: enrichedItems.map((item) =>
                  serializeWalletResponseItem({
                    ...item,
                    attribution: attributionMap.get(item.walletId),
                  }),
                ),
              };
            }

            const candidates = await loadWalletRowsByIds(
              client,
              userId,
              workingWalletIds,
              null,
            );
            const walletIds = candidates.map((row) => row.id);
            const summaryMap = await fetchWalletActivitySummaries(
              client,
              walletIds,
              {
                ...signalSummaryOptions,
              },
            );
            const mmDiagnosticsByWallet = await loadWalletMmDiagnosticsMap(
              client,
              candidates.map((row) => ({
                walletId: row.id,
                chain: row.chain,
              })),
              refreshPolicy.effective,
            );

            const items: WalletActivitySignalItem[] = [];
            const nowMs = Date.now();
            let activeWithInvalidClose = 0;
            const activeInvalidSamples: Array<{
              marketId: string;
              marketStatus: string | null;
              closeTime: Date | null;
              expirationTime: Date | null;
            }> = [];
            for (const row of candidates) {
              const summary = summaryMap.get(row.id);
              const mmDiagnostics = mmDiagnosticsByWallet.get(row.id) ?? null;
              if (!summary) continue;
              if (query.excludeMmLike && mmDiagnostics?.mmSuspected) continue;
              for (const change of summary.topChanges) {
                if (!change.signalType) continue;
                if (query.signalType && change.signalType !== query.signalType)
                  continue;
                if (query.lateBucket && change.lateBucket !== query.lateBucket)
                  continue;
                if (change.action !== "OPENED" && change.action !== "INCREASED")
                  continue;

                const marketWindow = evaluateSignalMarketWindow(change, nowMs);
                if (marketWindow.isActiveWithInvalidClose) {
                  activeWithInvalidClose += 1;
                  if (
                    activeInvalidSamples.length <
                    signalConfig.activeInvalidCloseSampleCap
                  ) {
                    activeInvalidSamples.push({
                      marketId: change.marketId,
                      marketStatus: change.marketStatus ?? null,
                      closeTime: change.closeTime ?? null,
                      expirationTime: change.expirationTime ?? null,
                    });
                  }
                }

                if (!marketWindow.isOpenNow) continue;
                if ((change.signalScore ?? 0) < minScore) continue;
                if ((change.stakeUsd ?? 0) < minStakeUsd) continue;
                if (
                  signalConfig.minDeltaUsd > 0 &&
                  Math.abs(change.deltaUsd ?? 0) < signalConfig.minDeltaUsd
                ) {
                  continue;
                }
                if (change.odds == null || change.odds > maxOdds) continue;
                const passesIdleDays = (change.idleDays ?? 0) >= minIdleDays;
                const passesPriorMarkets =
                  (change.priorDistinctMarkets ?? 0) <= maxPriorMarkets;
                if (!passesIdleDays && !passesPriorMarkets) continue;
                if ((change.potentialPayoutUsd ?? 0) < minPayoutUsd) continue;
                items.push(
                  buildWalletSignalItemFromTopChange({
                    candidate: row,
                    change,
                    mmDiagnostics,
                    attributionPolicy: attributionPolicy.effective,
                  }),
                );
              }
            }

            if (activeWithInvalidClose > 0) {
              app.log.warn(
                {
                  userId,
                  activeWithInvalidClose,
                  samples: activeInvalidSamples,
                },
                "Detected ACTIVE markets with missing/past close time in wallet signals",
              );
            }

            const attributionInputsByWallet =
              buildWalletAttributionInputMapFromSignalItems(items);
            const attributionInputs = Array.from(
              attributionInputsByWallet.values(),
            );
            let attributionMap = new Map<string, WalletAttribution>();
            let filteredItems: WalletActivitySignalItem[];
            if (needsAttributionForFilters) {
              attributionMap = await buildWalletAttributionMap(
                client,
                attributionInputs,
                attributionPolicy.effective,
                {
                  mode: "filters",
                  filterPrimary: primaryFilterTyped,
                  filterLabels: labelsFilterTyped,
                },
              );
              filteredItems = items.filter((item) => {
                if (
                  !walletMatchesFilters(
                    item.tags,
                    attributionMap.get(item.walletId),
                    {
                      tags: [],
                      tagMode: "any",
                      primary: primaryFilter,
                      labels: labelsFilter,
                      labelMode: query.labelMode,
                    },
                  )
                ) {
                  return false;
                }
                return signalMatchesFilters(item, {
                  severity: severityFilter,
                  displayReasons: displayReasonFilter,
                  signalReasonMode: query.signalReasonMode,
                });
              });
            } else {
              filteredItems = items.filter((item) => {
                if (
                  !walletMatchesFilters(item.tags, undefined, {
                    tags: [],
                    tagMode: "any",
                    primary: [],
                    labels: [],
                    labelMode: query.labelMode,
                  })
                ) {
                  return false;
                }
                return signalMatchesFilters(item, {
                  severity: severityFilter,
                  displayReasons: displayReasonFilter,
                  signalReasonMode: query.signalReasonMode,
                });
              });
            }

            const sorted = filteredItems.sort((a, b) => {
              const scoreDelta = (b.signalScore ?? 0) - (a.signalScore ?? 0);
              if (scoreDelta !== 0) return scoreDelta;
              return b.occurredAt.getTime() - a.occurredAt.getTime();
            });
            const pagedRows = await enrichWalletSignalItemsWithPositionNow(
              client,
              sorted.slice(query.offset, query.offset + query.limit),
            );
            if (includeAttributionInResponse) {
              const byWallet = new Map<
                string,
                (typeof attributionInputs)[number]
              >();
              for (const item of pagedRows) {
                const input = attributionInputsByWallet.get(item.walletId);
                if (input) byWallet.set(item.walletId, input);
              }
              attributionMap = await buildWalletAttributionMap(
                client,
                Array.from(byWallet.values()),
                attributionPolicy.effective,
                { mode: "full" },
              );
            }
            const itemsForResponse = pagedRows.map((item) =>
              includeAttributionInResponse
                ? serializeWalletResponseItem({
                    ...item,
                    attribution: attributionMap.get(item.walletId),
                  })
                : serializeWalletResponseItem(item),
            );
            return {
              ok: true,
              items: itemsForResponse,
            };
          },
        );
        const body = JSON.stringify(payload);
        if (cacheTtlSec > 0) {
          await writeWalletIntelCachedBody(
            cacheClient,
            cacheKey,
            body,
            cacheTtlSec,
          );
        }
        applyWalletIntelCacheHeaders({
          reply,
          hit: false,
          layer: "none",
          cacheStatus: cacheContext.status,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(body);
      } catch (error) {
        app.log.error(
          { error, userId, query },
          "Failed to load wallet activity signals",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load wallet activity signals" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/activity
   */
  z.get(
    "/wallets/activity",
    {
      preHandler: createAuthMiddleware({ optional: true }),
      schema: { querystring: walletActivityQuerySchema },
    },
    async (request, reply) => {
      const userId = request.user?.id ?? null;

      const query = request.query;
      if (!userId && !query.walletId) {
        reply.code(401);
        return reply.send({
          error: "Authentication required when walletId is omitted",
        });
      }
      const params: Array<string | number | boolean | null> = [userId];
      let where = "";
      let idx = 2;
      const userParam = 1;

      if (query.walletId) {
        where += `wa.wallet_id = $${idx++}`;
        params.push(query.walletId);
      } else {
        where += `wa.wallet_id in (select wallet_id from wallet_follows where user_id = $${userParam})`;
      }

      if (query.venue) {
        where += ` and wa.venue = $${idx++}`;
        params.push(query.venue);
      } else {
        const derivedVenue = inferVenueFromMarketId(query.marketId);
        if (derivedVenue) {
          where += ` and wa.venue = $${idx++}`;
          params.push(derivedVenue);
        }
      }

      if (query.since) {
        where += ` and wa.occurred_at >= $${idx++}`;
        params.push(query.since);
      }

      const filterClauses = [where];
      idx = appendMarketReferenceFilters(filterClauses, params, idx, query, {
        marketAlias: "um",
        eventAlias: "ue",
      });
      idx = appendWalletMarketSearchFilter(filterClauses, params, idx, query, {
        marketAlias: "um",
        eventAlias: "ue",
      });
      idx = appendWalletActivityFilters(
        filterClauses,
        params,
        idx,
        query,
        "wa",
      );
      where = filterClauses.join(" and ");

      params.push(query.limit, query.offset);
      const limitParam = idx++;
      const offsetParam = idx++;

      const client = await pool.connect();
      try {
        const rows = await client.query<WalletActivityRouteRow>(
          `
            select
              wa.wallet_id,
	                w.address,
	                w.chain,
	                w.label,
	                w.metadata as wallet_metadata,
	                wn.name as user_name,
              wl.label as user_label,
              wl.color as user_label_color,
              wp.profile->>'label_short' as profile_label,
              wa.venue,
              wa.market_id,
              um.title as market_title,
              um.outcomes,
              um.image as market_image,
              um.icon as market_icon,
              um.event_id as event_id,
              ue.title as event_title,
              ue.image as event_image,
              ue.icon as event_icon,
              um.category,
              ue.category as event_category,
              ue.series_key,
              ue.series_title,
              um.best_bid,
              um.best_ask,
              um.last_price,
              um.status as market_status,
              um.close_time,
              um.expiration_time,
              um.resolved_outcome,
              ${buildWalletIntelAcceptingOrdersSql({
                marketAlias: "um",
                eventAlias: "ue",
              })} as accepting_orders,
              wa.outcome_side,
              wa.action,
              wa.delta_shares,
              wa.size_usd,
              wa.price,
              wa.activity_type,
              wa.source,
              wa.occurred_at,
              wa.metadata
            from wallet_activity_events wa
            join wallets w on w.id = wa.wallet_id
            left join wallet_user_labels wl
              on wl.wallet_id = w.id
             and wl.user_id = $${userParam}
            left join wallet_user_names wn
              on wn.wallet_id = w.id
             and wn.user_id = $${userParam}
            left join wallet_profiles wp on wp.wallet_id = w.id
            left join unified_markets um on um.id = wa.market_id
            left join unified_events ue on ue.id = um.event_id
            where ${where}
              and wa.activity_type in ('delta', 'trade')
              and ${buildSnapshotDeltaTrackableActivitySql({
                activityAlias: "wa",
                marketAlias: "um",
                eventAlias: "ue",
              })}
            order by wa.occurred_at desc
            limit $${limitParam}
            offset $${offsetParam}
          `,
          params,
        );

        const minUsd = env.walletIntelMinActivityUsd;
        const minShares = env.walletIntelMinActivityShares;

        const items = query.includePositionNow
          ? await enrichWalletActivityRouteItemsWithPositionNow(
              client,
              mapWalletActivityRouteItems(rows.rows),
            )
          : mapWalletActivityRouteItems(rows.rows);

        const filteredItems =
          minUsd <= 0 && minShares <= 0
            ? items
            : items.filter((item) => {
                if (item.sizeUsd != null) {
                  if (item.sizeUsd >= minUsd) return true;
                  if (
                    item.deltaShares != null &&
                    Math.abs(item.deltaShares) >= minShares
                  ) {
                    return true;
                  }
                  return false;
                }
                if (item.deltaShares != null) {
                  return Math.abs(item.deltaShares) >= minShares;
                }
                return true;
              });
        const responseItems =
          query.includeMarketTypeMetrics && query.walletId
            ? await enrichWalletActivityRouteItemsWithMarketTypeMetrics(
                client,
                filteredItems,
              )
            : filteredItems;

        return reply.send({
          ok: true,
          items: responseItems,
        });
      } catch (error) {
        app.log.error(
          { error, userId, query },
          "Failed to load wallet activity",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load wallet activity" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/positioning/events
   */
  z.get(
    "/wallets/positioning/events",
    {
      schema: { querystring: walletPositioningQuerySchema },
    },
    async (request, reply) => {
      const query = request.query;
      const client = await pool.connect();
      try {
        const result = await withWalletIntelQuerySettings(
          client,
          { workMem: "32MB" },
          () =>
            loadTrackedWalletPositioning({
              client,
              query,
              rollup: "events",
            }),
        );
        requestWalletPositioningMarketRefresh(
          result,
          "wallet-positioning:events",
        );
        return reply.send(result);
      } catch (error) {
        app.log.error({ error, query }, "Failed to load event positioning");
        reply.code(500);
        return reply.send({ error: "Failed to load event positioning" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/positioning/markets
   */
  z.get(
    "/wallets/positioning/markets",
    {
      schema: { querystring: walletPositioningQuerySchema },
    },
    async (request, reply) => {
      const query = request.query;
      const client = await pool.connect();
      try {
        const result = await withWalletIntelQuerySettings(
          client,
          { workMem: "32MB" },
          () =>
            loadTrackedWalletPositioning({
              client,
              query,
              rollup: "markets",
            }),
        );
        requestWalletPositioningMarketRefresh(
          result,
          "wallet-positioning:markets",
        );
        return reply.send(result);
      } catch (error) {
        app.log.error({ error, query }, "Failed to load market positioning");
        reply.code(500);
        return reply.send({ error: "Failed to load market positioning" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /events/:eventId/wallet-positioning
   */
  z.get(
    "/events/:eventId/wallet-positioning",
    {
      schema: {
        params: eventWalletPositioningParamsSchema,
        querystring: walletPositioningQuerySchema,
      },
    },
    async (request, reply) => {
      const query = {
        ...request.query,
        limit: request.query.limit ?? 100,
        minWallets: request.query.minWallets ?? 1,
      };
      const client = await pool.connect();
      try {
        const result = await withWalletIntelQuerySettings(
          client,
          { workMem: "32MB" },
          () =>
            loadTrackedWalletPositioning({
              client,
              query,
              eventId: request.params.eventId,
              rollup: "event-detail",
            }),
        );
        requestWalletPositioningMarketRefresh(
          result,
          "wallet-positioning:event-detail",
        );
        return reply.send({
          ...result,
          eventId: request.params.eventId,
        });
      } catch (error) {
        app.log.error(
          { error, eventId: request.params.eventId, query },
          "Failed to load event wallet positioning",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load event wallet positioning" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /markets/:marketId/wallet-positioning
   */
  z.get(
    "/markets/:marketId/wallet-positioning",
    {
      schema: {
        params: marketWalletPositioningParamsSchema,
        querystring: walletPositioningQuerySchema,
      },
    },
    async (request, reply) => {
      const query = {
        ...request.query,
        limit: request.query.limit ?? 1,
        minWallets: request.query.minWallets ?? 1,
      };
      const client = await pool.connect();
      try {
        const result = await withWalletIntelQuerySettings(
          client,
          { workMem: "32MB" },
          () =>
            loadTrackedWalletPositioning({
              client,
              query,
              marketId: request.params.marketId,
              rollup: "market-detail",
            }),
        );
        requestWalletPositioningSingleMarketRefresh(
          request.params.marketId,
          "wallet-positioning:market-detail",
        );
        return reply.send({
          ...result,
          marketId: request.params.marketId,
          market: result.items[0] ?? null,
        });
      } catch (error) {
        app.log.error(
          { error, marketId: request.params.marketId, query },
          "Failed to load market wallet positioning",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to load market wallet positioning",
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /markets/:marketId/wallet-activity
   */
  z.get(
    "/markets/:marketId/wallet-activity",
    {
      schema: {
        params: marketWalletActivityParamsSchema,
        querystring: marketWalletActivityQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query;
      const params: Array<string | number | boolean | null> = [
        request.params.marketId,
      ];
      let idx = 2;
      const clauses = ["wa.market_id = $1"];
      const derivedVenue = inferVenueFromMarketId(request.params.marketId);

      if (derivedVenue) {
        clauses.push(`wa.venue = $${idx++}`);
        params.push(derivedVenue);
      }

      if (query.since) {
        clauses.push(`wa.occurred_at >= $${idx++}`);
        params.push(query.since);
      }

      idx = appendWalletActivityFilters(clauses, params, idx, query, "wa");

      params.push(query.limit, query.offset);
      const limitParam = idx++;
      const offsetParam = idx++;

      const client = await pool.connect();
      try {
        const rows = await client.query<WalletActivityRouteRow>(
          `
            select
              wa.wallet_id,
              w.address,
              w.chain,
              w.label,
              w.metadata as wallet_metadata,
              null::text as user_name,
              null::text as user_label,
              null::text as user_label_color,
              wp.profile->>'label_short' as profile_label,
              wa.venue,
              wa.market_id,
              um.title as market_title,
              um.outcomes,
              um.image as market_image,
              um.icon as market_icon,
              um.event_id as event_id,
              ue.title as event_title,
              ue.image as event_image,
              ue.icon as event_icon,
              um.category,
              ue.category as event_category,
              ue.series_key,
              ue.series_title,
              um.best_bid,
              um.best_ask,
              um.last_price,
              um.status as market_status,
              um.close_time,
              um.expiration_time,
              um.resolved_outcome,
              ${buildWalletIntelAcceptingOrdersSql({
                marketAlias: "um",
                eventAlias: "ue",
              })} as accepting_orders,
              wa.outcome_side,
              wa.action,
              wa.delta_shares,
              wa.size_usd,
              wa.price,
              wa.activity_type,
              wa.source,
              wa.occurred_at,
              wa.metadata
            from wallet_activity_events wa
            join wallets w on w.id = wa.wallet_id
            left join wallet_profiles wp on wp.wallet_id = w.id
            left join unified_markets um on um.id = wa.market_id
            left join unified_events ue on ue.id = um.event_id
            where ${clauses.join(" and ")}
              and wa.activity_type in ('delta', 'trade')
              and ${buildSnapshotDeltaTrackableActivitySql({
                activityAlias: "wa",
                marketAlias: "um",
                eventAlias: "ue",
              })}
            order by wa.occurred_at desc
            limit $${limitParam}
            offset $${offsetParam}
          `,
          params,
        );

        const items = query.includePositionNow
          ? await enrichWalletActivityRouteItemsWithPositionNow(
              client,
              mapWalletActivityRouteItems(rows.rows),
            )
          : mapWalletActivityRouteItems(rows.rows);

        return reply.send({
          ok: true,
          marketId: request.params.marketId,
          items,
        });
      } catch (error) {
        app.log.error(
          { error, marketId: request.params.marketId, query },
          "Failed to load market wallet activity",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load market wallet activity" });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /wallets/positions
   */
  z.get(
    "/wallets/positions",
    {
      preHandler: createAuthMiddleware({ optional: true }),
      schema: { querystring: walletPositionsQuerySchema },
    },
    async (request, reply) => {
      const userId = request.user?.id ?? null;

      const query = request.query;
      if (!userId && !query.walletId) {
        reply.code(401);
        return reply.send({
          error: "Authentication required when walletId is omitted",
        });
      }
      const cacheTtlSec = Math.max(0, Math.trunc(env.walletIntelTtlSec));
      const cacheContext = await resolveWalletIntelCacheContext(cacheTtlSec);
      const cacheClient = cacheContext.redis;
      const cacheKey = walletIntelCacheKey(
        "wallets-positions",
        userId ?? "anon",
        query,
      );
      const cached = await readWalletIntelCachedBody(
        cacheClient,
        cacheKey,
        cacheTtlSec,
      );
      if (cached) {
        applyWalletIntelCacheHeaders({
          reply,
          hit: true,
          layer: cached.layer,
          cacheStatus: cacheContext.status,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(cached.body);
      }

      const params: Array<string | number | boolean | null> = [userId];
      let where = "";
      let idx = 2;
      const userParam = 1;
      let walletParam: number | null = null;
      let venueParam: number | null = null;
      let sinceParam: number | null = null;
      const derivedVenue = inferVenueFromMarketId(query.marketId);

      if (query.walletId) {
        walletParam = idx++;
        where += `ws.wallet_id = $${walletParam}`;
        params.push(query.walletId);
      } else {
        where += `ws.wallet_id in (select wallet_id from wallet_follows where user_id = $${userParam})`;
      }

      if (query.venue) {
        venueParam = idx++;
        where += ` and ws.venue = $${venueParam}`;
        params.push(query.venue);
      } else if (derivedVenue) {
        venueParam = idx++;
        where += ` and ws.venue = $${venueParam}`;
        params.push(derivedVenue);
      }

      if (query.since) {
        sinceParam = idx++;
        where += ` and ws.snapshot_at >= $${sinceParam}`;
        params.push(query.since);
      }

      const positionFilterSql = query.includeSmall
        ? "true"
        : (() => {
            const minUsdParam = idx++;
            params.push(query.minPositionUsd ?? env.walletIntelMinPositionUsd);
            const minSharesParam = idx++;
            params.push(
              query.minPositionShares ?? env.walletIntelMinPositionShares,
            );
            return `
              (
                case
                  when ws.size_usd is not null then ws.size_usd >= $${minUsdParam}::numeric
                  when ws.shares is not null then ws.shares >= $${minSharesParam}::numeric
                  else true
                end
              )
            `;
          })();
      const positionMarketClauses: string[] = [];
      idx = appendMarketReferenceFilters(
        positionMarketClauses,
        params,
        idx,
        {
          marketId: query.marketId,
          eventId: query.eventId,
          category: query.category,
          marketStatus: query.marketStatus,
          acceptingOrders: query.acceptingOrders,
        },
        { marketAlias: "um", eventAlias: "ue" },
      );
      idx = appendWalletMarketSearchFilter(
        positionMarketClauses,
        params,
        idx,
        query,
        { marketAlias: "um", eventAlias: "ue" },
      );
      if (query.outcomeSide) {
        positionMarketClauses.push(`ws.outcome_side = $${idx++}::text`);
        params.push(query.outcomeSide);
      }
      if (query.minSizeUsd != null) {
        positionMarketClauses.push(
          `coalesce(ws.size_usd, 0) >= $${idx++}::numeric`,
        );
        params.push(query.minSizeUsd);
      }
      const positionMarketFilterSql = positionMarketClauses.length
        ? `and ${positionMarketClauses.join(" and ")}`
        : "";
      const hiddenPositionSuppressionSql =
        buildHiddenOwnPositionSnapshotSuppressionSql({
          snapshotAlias: "ws",
          walletAlias: "w",
        });

      params.push(query.limit + 1, query.offset);
      const limitParam = idx++;
      const offsetParam = idx++;

      const client = await pool.connect();
      try {
        const payload = await withWalletIntelQuerySettings(
          client,
          walletPositionRouteQuerySettings,
          async () => {
            const latestOnly = query.latest ?? true;
            const sql = latestOnly
              ? walletParam != null
                ? `
              with candidate_venues(venue) as (
                ${
                  venueParam != null
                    ? `select $${venueParam}::text`
                    : "values ('polymarket'), ('limitless'), ('kalshi')"
                }
              ),
              latest_snapshots as (
                select
                  cv.venue,
                  latest.snapshot_at
                from candidate_venues cv
                join lateral (
                  select ws.snapshot_at
                  from wallet_position_snapshots ws
                  where ws.wallet_id = $${walletParam}::uuid
                    and ws.venue = cv.venue
                    ${
                      sinceParam != null
                        ? `and ws.snapshot_at >= $${sinceParam}::timestamptz`
                        : ""
                    }
                  order by ws.snapshot_at desc
                  limit 1
                ) latest on true
              )
              select
                ws.wallet_id,
                w.address,
                w.chain,
                w.label,
                w.metadata as wallet_metadata,
                wn.name as user_name,
                wl.label as user_label,
                wl.color as user_label_color,
                wp.profile->>'label_short' as profile_label,
                ws.venue,
                ws.market_id,
                um.title as market_title,
                um.outcomes,
                um.image as market_image,
                um.icon as market_icon,
                um.event_id as event_id,
                ue.title as event_title,
                ue.image as event_image,
                ue.icon as event_icon,
                um.status as market_status,
                um.close_time,
                um.expiration_time,
                um.resolved_outcome,
                um.resolved_outcome_pct::text as resolved_outcome_pct,
                ${buildWalletIntelAcceptingOrdersSql({
                  marketAlias: "um",
                  eventAlias: "ue",
                })} as accepting_orders,
                um.best_bid,
                um.best_ask,
                um.last_price,
                ws.outcome_side,
                ws.shares,
                ws.size_usd,
                ws.price,
                ws.snapshot_at,
                ws.metadata
              from latest_snapshots ls
              join wallet_position_snapshots ws
                on ws.wallet_id = $${walletParam}::uuid
               and ws.venue = ls.venue
               and ws.snapshot_at = ls.snapshot_at
              join wallets w on w.id = ws.wallet_id
              left join wallet_user_labels wl
                on wl.wallet_id = w.id
               and wl.user_id = $${userParam}
              left join wallet_user_names wn
                on wn.wallet_id = w.id
               and wn.user_id = $${userParam}
              left join wallet_profiles wp on wp.wallet_id = w.id
              left join unified_markets um on um.id = ws.market_id
              left join unified_events ue on ue.id = um.event_id
              where ${positionFilterSql}
                ${positionMarketFilterSql}
                and ${hiddenPositionSuppressionSql}
                and ${buildWalletIntelTrackableMarketSql({
                  marketAlias: "um",
                  eventAlias: "ue",
                })}
              order by
                ws.snapshot_at desc,
                ws.size_usd desc nulls last,
                ws.shares desc nulls last,
                coalesce(um.title, ws.market_id) asc
              limit $${limitParam}::integer
              offset $${offsetParam}::integer
            `
                : `
              with latest_snapshots as (
                select
                  ws.wallet_id,
                  ws.venue,
                  max(ws.snapshot_at) as snapshot_at
                from wallet_position_snapshots ws
                where ${where}
                group by ws.wallet_id, ws.venue
              )
              select
                ws.wallet_id,
                w.address,
                w.chain,
                w.label,
                w.metadata as wallet_metadata,
                wn.name as user_name,
                wl.label as user_label,
                wl.color as user_label_color,
                wp.profile->>'label_short' as profile_label,
                ws.venue,
                ws.market_id,
                um.title as market_title,
                um.outcomes,
                um.image as market_image,
                um.icon as market_icon,
                um.event_id as event_id,
                ue.title as event_title,
                ue.image as event_image,
                ue.icon as event_icon,
                um.status as market_status,
                um.close_time,
                um.expiration_time,
                um.resolved_outcome,
                um.resolved_outcome_pct::text as resolved_outcome_pct,
                ${buildWalletIntelAcceptingOrdersSql({
                  marketAlias: "um",
                  eventAlias: "ue",
                })} as accepting_orders,
                um.best_bid,
                um.best_ask,
                um.last_price,
                ws.outcome_side,
                ws.shares,
                ws.size_usd,
                ws.price,
                ws.snapshot_at,
                ws.metadata
              from wallet_position_snapshots ws
              join latest_snapshots ls
                on ls.wallet_id = ws.wallet_id
               and ls.venue = ws.venue
               and ls.snapshot_at = ws.snapshot_at
              join wallets w on w.id = ws.wallet_id
              left join wallet_user_labels wl
                on wl.wallet_id = w.id
               and wl.user_id = $${userParam}
              left join wallet_user_names wn
                on wn.wallet_id = w.id
               and wn.user_id = $${userParam}
              left join wallet_profiles wp on wp.wallet_id = w.id
              left join unified_markets um on um.id = ws.market_id
              left join unified_events ue on ue.id = um.event_id
              where ${positionFilterSql}
                ${positionMarketFilterSql}
                and ${hiddenPositionSuppressionSql}
                and ${buildWalletIntelTrackableMarketSql({
                  marketAlias: "um",
                  eventAlias: "ue",
                })}
              order by
                ws.snapshot_at desc,
                ws.size_usd desc nulls last,
                ws.shares desc nulls last,
                coalesce(um.title, ws.market_id) asc
              limit $${limitParam}::integer
              offset $${offsetParam}::integer
            `
              : `
              select
                ws.wallet_id,
                w.address,
                w.chain,
                w.label,
                w.metadata as wallet_metadata,
                wn.name as user_name,
                wl.label as user_label,
                wl.color as user_label_color,
                wp.profile->>'label_short' as profile_label,
                ws.venue,
                ws.market_id,
                um.title as market_title,
                um.outcomes,
                um.image as market_image,
                um.icon as market_icon,
                um.event_id as event_id,
                ue.title as event_title,
                ue.image as event_image,
                ue.icon as event_icon,
                um.status as market_status,
                um.close_time,
                um.expiration_time,
                um.resolved_outcome,
                um.resolved_outcome_pct::text as resolved_outcome_pct,
                ${buildWalletIntelAcceptingOrdersSql({
                  marketAlias: "um",
                  eventAlias: "ue",
                })} as accepting_orders,
                um.best_bid,
                um.best_ask,
                um.last_price,
                ws.outcome_side,
                ws.shares,
                ws.size_usd,
                ws.price,
                ws.snapshot_at,
                ws.metadata
              from wallet_position_snapshots ws
              join wallets w on w.id = ws.wallet_id
              left join wallet_user_labels wl
                on wl.wallet_id = w.id
               and wl.user_id = $${userParam}
              left join wallet_user_names wn
                on wn.wallet_id = w.id
               and wn.user_id = $${userParam}
              left join wallet_profiles wp on wp.wallet_id = w.id
              left join unified_markets um on um.id = ws.market_id
              left join unified_events ue on ue.id = um.event_id
              where ${where}
                and ${positionFilterSql}
                ${positionMarketFilterSql}
                and ${hiddenPositionSuppressionSql}
                and ${buildWalletIntelTrackableMarketSql({
                  marketAlias: "um",
                  eventAlias: "ue",
                })}
              order by
                ws.snapshot_at desc,
                ws.size_usd desc nulls last,
                ws.shares desc nulls last,
                coalesce(um.title, ws.market_id) asc
              limit $${limitParam}::integer
              offset $${offsetParam}::integer
            `;

            const rows = await client.query<WalletPositionRouteRow>(
              sql,
              params,
            );

            const hasMore = rows.rows.length > query.limit;
            const pageRows = hasMore
              ? rows.rows.slice(0, query.limit)
              : rows.rows;
            const items = await buildWalletPositionRouteItems(client, pageRows);

            return {
              ok: true,
              items,
              hasMore,
            };
          },
        );
        const body = JSON.stringify(payload);
        if (cacheTtlSec > 0) {
          await writeWalletIntelCachedBody(
            cacheClient,
            cacheKey,
            body,
            cacheTtlSec,
          );
        }
        applyWalletIntelCacheHeaders({
          reply,
          hit: false,
          layer: "none",
          cacheStatus: cacheContext.status,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(body);
      } catch (error) {
        app.log.error(
          { error, userId, query },
          "Failed to load wallet positions",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load wallet positions" });
      } finally {
        client.release();
      }
    },
  );

  z.get(
    "/wallets/positions/history",
    {
      preHandler: createAuthMiddleware({ optional: true }),
      schema: { querystring: walletPositionHistoryQuerySchema },
    },
    async (request, reply) => {
      const userId = request.user?.id ?? null;

      const query = request.query;
      const cacheTtlSec = Math.max(0, Math.trunc(env.walletIntelTtlSec));
      const cacheContext = await resolveWalletIntelCacheContext(cacheTtlSec);
      const cacheClient = cacheContext.redis;
      const cacheKey = walletIntelCacheKey(
        "wallets-positions-history",
        userId ?? "anon",
        query,
      );
      const cached = await readWalletIntelCachedBody(
        cacheClient,
        cacheKey,
        cacheTtlSec,
      );
      if (cached) {
        applyWalletIntelCacheHeaders({
          reply,
          hit: true,
          layer: cached.layer,
          cacheStatus: cacheContext.status,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(cached.body);
      }

      const params: Array<string | number | boolean | null> = [
        userId,
        query.walletId,
      ];
      let idx = 3;
      const userParam = 1;
      const walletParam = 2;
      const derivedVenue = inferVenueFromMarketId(query.marketId);

      let historyWhere = `ws.wallet_id = $${walletParam}`;
      if (query.venue) {
        const venueParam = idx++;
        historyWhere += ` and ws.venue = $${venueParam}`;
        params.push(query.venue);
      } else if (derivedVenue) {
        const venueParam = idx++;
        historyWhere += ` and ws.venue = $${venueParam}`;
        params.push(derivedVenue);
      }

      if (query.marketId) {
        historyWhere += ` and ws.market_id = $${idx++}::text`;
        params.push(query.marketId);
      }

      if (query.outcomeSide) {
        historyWhere += ` and ws.outcome_side = $${idx++}::text`;
        params.push(query.outcomeSide);
      }

      const historyPositionFilterSql = query.includeSmall
        ? "true"
        : (() => {
            const minUsdParam = idx++;
            params.push(query.minPositionUsd ?? env.walletIntelMinPositionUsd);
            const minSharesParam = idx++;
            params.push(
              query.minPositionShares ?? env.walletIntelMinPositionShares,
            );
            return `
              (
                case
                  when tr.size_usd is not null then tr.size_usd >= $${minUsdParam}::numeric
                  when tr.shares is not null then tr.shares >= $${minSharesParam}::numeric
                  else true
                end
              )
            `;
          })();
      const historyHiddenPositionSuppressionSql =
        buildHiddenOwnPositionSnapshotSuppressionSql({
          snapshotAlias: "tr",
          walletAlias: "w",
        });

      let outerWhere = `where ${historyPositionFilterSql}
        and ${historyHiddenPositionSuppressionSql}`;
      if (query.since) {
        outerWhere += ` and tr.snapshot_at >= $${idx++}`;
        params.push(query.since);
      }

      const historyMarketClauses: string[] = [];
      idx = appendMarketReferenceFilters(
        historyMarketClauses,
        params,
        idx,
        {
          marketId: query.marketId,
          eventId: query.eventId,
          category: query.category,
          marketStatus: query.marketStatus,
          acceptingOrders: query.acceptingOrders,
        },
        { marketAlias: "um", eventAlias: "ue" },
      );
      idx = appendWalletMarketSearchFilter(
        historyMarketClauses,
        params,
        idx,
        query,
        { marketAlias: "um", eventAlias: "ue" },
      );
      if (query.outcomeSide) {
        historyMarketClauses.push(`tr.outcome_side = $${idx++}::text`);
        params.push(query.outcomeSide);
      }
      if (query.minSizeUsd != null) {
        historyMarketClauses.push(
          `coalesce(tr.size_usd, 0) >= $${idx++}::numeric`,
        );
        params.push(query.minSizeUsd);
      }
      if (historyMarketClauses.length) {
        outerWhere += ` and ${historyMarketClauses.join(" and ")}`;
      }

      params.push(query.limit + 1, query.offset);
      const limitParam = idx++;
      const offsetParam = idx++;

      const client = await pool.connect();
      try {
        const payload = await withWalletIntelQuerySettings(
          client,
          walletPositionRouteQuerySettings,
          async () => {
            const rows = await client.query<WalletPositionRouteRow>(
              `
            with position_keys as (
              select distinct
                ws.venue,
                ws.market_id,
                ws.outcome_side
              from wallet_position_snapshots ws
              where ${historyWhere}
                and (
                  coalesce(ws.shares, 0) > 0
                  or greatest(
                    coalesce(ws.size_usd, 0),
                    abs(coalesce(ws.shares, 0) * coalesce(ws.price, 0))
                  ) > 0
                )
            ),
            market_keys as (
              select
                pk.venue,
                pk.market_id,
                pk.outcome_side,
                coalesce(um.close_time, um.expiration_time) as terminal_at
              from position_keys pk
              join unified_markets um on um.id = pk.market_id
              where (
                  um.resolved_outcome is not null
                  or upper(coalesce(um.status::text, '')) in ('CLOSED', 'SETTLED', 'ARCHIVED')
                  or (
                    coalesce(um.close_time, um.expiration_time) is not null
                    and coalesce(um.close_time, um.expiration_time) < now()
                  )
                )
            ),
            terminal_rows as (
              select
                ws.wallet_id,
                ws.venue,
                ws.market_id,
                case
                  when ws.outcome_side in ('YES', 'NO')
                    then ws.outcome_side
                  else null
                end as outcome_side,
                ws.shares,
                ws.size_usd,
                ws.price,
                ws.snapshot_at,
                ws.metadata
              from market_keys mk
              join lateral (
                select ws.*
                from wallet_position_snapshots ws
                where ws.wallet_id = $${walletParam}::uuid
                  and ws.venue = mk.venue
                  and ws.market_id = mk.market_id
                  and ws.outcome_side = mk.outcome_side
                  and (
                    coalesce(ws.shares, 0) > 0
                    or greatest(
                      coalesce(ws.size_usd, 0),
                      abs(coalesce(ws.shares, 0) * coalesce(ws.price, 0))
                    ) > 0
                  )
                  and (
                    mk.terminal_at is null
                    or ws.snapshot_at <= mk.terminal_at
                  )
                order by ws.snapshot_at desc
                limit 1
              ) ws on true
            )
            select
              tr.wallet_id,
              w.address,
              w.chain,
              w.label,
              w.metadata as wallet_metadata,
              wn.name as user_name,
              wl.label as user_label,
              wl.color as user_label_color,
              wp.profile->>'label_short' as profile_label,
              tr.venue,
              tr.market_id,
              um.title as market_title,
              um.outcomes,
              um.image as market_image,
              um.icon as market_icon,
              um.event_id as event_id,
              ue.title as event_title,
              ue.image as event_image,
              ue.icon as event_icon,
              um.status as market_status,
              um.close_time,
              um.expiration_time,
              um.resolved_outcome,
              um.resolved_outcome_pct::text as resolved_outcome_pct,
              ${buildWalletIntelAcceptingOrdersSql({
                marketAlias: "um",
                eventAlias: "ue",
              })} as accepting_orders,
              um.best_bid,
              um.best_ask,
              um.last_price,
              tr.outcome_side,
              tr.shares,
              tr.size_usd,
              tr.price,
              tr.snapshot_at,
              tr.metadata
            from terminal_rows tr
            join wallets w on w.id = tr.wallet_id
            left join wallet_user_labels wl
              on wl.wallet_id = w.id
             and wl.user_id = $${userParam}
            left join wallet_user_names wn
              on wn.wallet_id = w.id
             and wn.user_id = $${userParam}
            left join wallet_profiles wp on wp.wallet_id = w.id
            left join unified_markets um on um.id = tr.market_id
            left join unified_events ue on ue.id = um.event_id
            ${outerWhere}
            order by
              tr.snapshot_at desc,
              tr.size_usd desc nulls last,
              tr.shares desc nulls last,
              coalesce(um.title, tr.market_id) asc
            limit $${limitParam}::integer
            offset $${offsetParam}::integer
          `,
              params,
            );

            const hasMore = rows.rows.length > query.limit;
            const pageRows = hasMore
              ? rows.rows.slice(0, query.limit)
              : rows.rows;
            const items = await buildWalletPositionRouteItems(client, pageRows);

            return {
              ok: true,
              items,
              hasMore,
            };
          },
        );
        const body = JSON.stringify(payload);
        if (cacheTtlSec > 0) {
          await writeWalletIntelCachedBody(
            cacheClient,
            cacheKey,
            body,
            cacheTtlSec,
          );
        }
        applyWalletIntelCacheHeaders({
          reply,
          hit: false,
          layer: "none",
          cacheStatus: cacheContext.status,
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(body);
      } catch (error) {
        app.log.error(
          { error, userId, query },
          "Failed to load wallet position history",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load wallet position history" });
      } finally {
        client.release();
      }
    },
  );
};
