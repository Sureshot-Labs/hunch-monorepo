import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";

import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import { getRedis } from "../redis.js";
import {
  derivePolymarketFunders,
  inspectSafeWallet,
} from "../services/polymarket-funder.js";
import {
  fetchWalletActivitySignalPageLabels,
  fetchWalletActivitySignalRowsFast,
  fetchWalletActivitySummaryStats,
  fetchWalletActivityTopChanges,
  fetchWalletActivitySummaries,
  type WalletActivitySignalRow,
  type WalletActivitySummary,
  type WalletActivityTopChange,
} from "../services/wallet-activity-summary.js";
import {
  buildEmptyWalletActivitySparkline,
  fetchWalletActivitySparklines,
  fetchWalletPerformanceSeries,
  type WalletActivitySparkline,
} from "../services/wallet-intel-series.js";
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
import { normalizeOutcomeSideForApi } from "../services/wallet-intel-helpers.js";
import {
  buildWalletMmDiagnostics,
  MM_HEDGE_RATIO_MIN,
  MM_TWO_SIDED_MARKETS_MIN,
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
  walletActivityQuerySchema,
  walletActivitySignalsQuerySchema,
  walletActivitySummaryQuerySchema,
  walletFollowBodySchema,
  walletFollowDeleteQuerySchema,
  walletFollowParamsSchema,
  walletFollowingQuerySchema,
  walletPositionsQuerySchema,
  walletProfileParamsSchema,
  walletSeriesQuerySchema,
  walletWhalesQuerySchema,
} from "../schemas/wallet-intel.js";

type WalletRow = {
  id: string;
  address: string;
  chain: string;
  label: string | null;
  is_system_flagged: boolean;
  first_seen_at: Date;
  last_seen_at: Date;
};

type WalletTagRow = {
  slug: string;
  label: string;
  tag_type: string;
  is_system: boolean;
};

type WalletMetricsRow = {
  period: string;
  as_of: Date;
  trades_count: number | null;
  volume_usd: string | null;
  pnl_usd: string | null;
  roi: string | null;
  win_rate: string | null;
  avg_hold_hours: string | null;
  last_trade_at: Date | null;
};

type WhaleMarketRow = {
  wallet_id: string;
  market_id: string;
  market_title: string | null;
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
  userLabel: string | null;
  isSystemFlagged: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  isFollowed: boolean;
  tags: WalletTagRow[];
  metrics: WalletMetricsRow | null;
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
  ownerAddress: string | null;
  ownerLabel: string | null;
  ownerWalletId: string | null;
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
};

type WhaleProfileRow = {
  profile: unknown | null;
  profile_updated_at: Date | null;
};

type CandidateWalletRow = WalletRow &
  WhaleProfileRow & {
    user_label: string | null;
    tags: WalletTagRow[] | null;
    metrics: WalletMetricsRow | null;
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
  userLabel: string | null;
  isSystemFlagged: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  tags: WalletTagRow[];
  metrics: WalletMetricsRow | null;
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
};

type WalletActivitySignalItem = {
  walletId: string;
  address: string;
  chain: string;
  label: string | null;
  userLabel: string | null;
  isSystemFlagged: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  tags: WalletTagRow[];
  metrics: WalletMetricsRow | null;
  profile: unknown | null;
  profileUpdatedAt: Date | null;
  marketId: string;
  marketTitle: string | null;
  eventId: string | null;
  eventTitle: string | null;
  venue: string;
  marketStatus: string | null;
  closeTime: Date | null;
  expirationTime: Date | null;
  resolvedOutcome: string | null;
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
  attribution?: WalletAttribution;
};

function normalizeAddress(address: string): string {
  if (address.startsWith("0x")) return address.toLowerCase();
  return address.trim();
}

function normalizeStringArray(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function nullableNumber(
  value: string | number | null | undefined,
): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    primaryFilters.some((value) => SUMMARY_DEPENDENT_PRIMARY_FILTERS.has(value)) ||
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
    labelFilters.every((value) => EXACT_ATTRIBUTION_SQL_LABEL_FILTERS.has(value))
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
  routeKey: "wallets-whales" | "wallets-activity-summary" | "wallets-activity-signals",
  userId: string,
  query: unknown,
): string {
  const digest = createHash("sha1")
    .update(JSON.stringify(query))
    .digest("hex");
  return `wallet-intel:v1:${routeKey}:${userId}:${digest}`;
}

function mapWhaleRowToItem(
  row: WalletRow &
    WhaleProfileRow & {
      is_followed: boolean;
      tags: WalletTagRow[] | null;
      metrics: WalletMetricsRow | null;
      last_activity_at: Date | null;
      has_trade_activity: boolean | null;
      has_holder_activity: boolean | null;
      metrics_volume: string | null;
      metrics_pnl: string | null;
      metrics_trades: number | null;
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
      user_label: string | null;
    },
  refreshPolicy: Awaited<ReturnType<typeof resolveWalletIntelRefreshPolicy>>["effective"],
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
    userLabel: row.user_label ?? null,
    isSystemFlagged: row.is_system_flagged,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    isFollowed: row.is_followed,
    tags: row.tags ?? [],
    metrics: row.metrics ?? null,
    lastActivityAt: row.last_activity_at,
    activityKind: (() => {
      const hasTrade = row.has_trade_activity ?? false;
      const hasHolder = row.has_holder_activity ?? false;
      if (hasTrade && hasHolder) return "mixed";
      if (hasTrade) return "trade";
      if (hasHolder) return "holder";
      return null;
    })(),
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

async function withJitDisabled<T>(
  client: PoolClient,
  task: () => Promise<T>,
): Promise<T> {
  const show = await client.query<{ jit: string }>("show jit");
  const previous = show.rows[0]?.jit?.toLowerCase() === "off" ? "off" : "on";
  const changed = previous !== "off";
  if (changed) {
    await client.query("set jit = off");
  }
  try {
    return await task();
  } finally {
    if (changed) {
      try {
        await client.query(`set jit = ${previous}`);
      } catch {
        // ignore reset failures when connection is no longer usable
      }
    }
  }
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
    const reasonSet = new Set(item.displayReasons.map((value) => value.toLowerCase()));
    const mode = filters.signalReasonMode;
    const matched =
      mode === "all"
        ? reasonFilters.every((value) => reasonSet.has(value))
        : reasonFilters.some((value) => reasonSet.has(value));
    if (!matched) return false;
  }
  return true;
}

function signalRowToTopChange(
  row: WalletActivitySignalRow,
): WalletActivityTopChange {
  return {
    marketId: row.marketId,
    marketTitle: row.marketTitle,
    eventId: row.eventId,
    eventTitle: row.eventTitle,
    venue: row.venue,
    marketStatus: row.marketStatus,
    closeTime: row.closeTime,
    expirationTime: row.expirationTime,
    resolvedOutcome: row.resolvedOutcome,
    category: row.category,
    action: row.action,
    positionSide: row.positionSide,
    deltaShares: row.deltaShares,
    deltaUsd: row.deltaUsd,
    price: null,
    odds: row.odds,
    stakeUsd: row.stakeUsd,
    potentialPayoutUsd: row.potentialPayoutUsd,
    idleDays: row.idleDays,
    priorDistinctMarkets: row.priorDistinctMarkets,
    signalScore: row.signalScore,
    signalLabels: row.reasonCodes,
    signalType: row.signalType,
    lateBucket: row.lateBucket,
    labels: [],
    occurredAt: row.occurredAt,
  };
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
  userId: string,
): Promise<string[]> {
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
    filters.categories && filters.categories.length > 0 ? filters.categories : null;
  const tagsFilter = filters.tags && filters.tags.length > 0 ? filters.tags : null;
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

async function filterWalletIdsByMmExclusion(
  client: PoolClient,
  walletIds: string[],
  refreshPolicy: Awaited<ReturnType<typeof resolveWalletIntelRefreshPolicy>>["effective"],
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
      where not (
        coalesce(wpe.hedge_ratio, 0) >= $2::numeric
        and coalesce(wpe.two_sided_markets, 0) >= $3::int
        and coalesce(wpe.exposure_usd, 0) >= case
          when w.chain = 'solana' then $5::numeric
          else $4::numeric
        end
      )
    `,
    [
      walletIds,
      MM_HEDGE_RATIO_MIN,
      MM_TWO_SIDED_MARKETS_MIN,
      refreshPolicy.whaleUsd,
      refreshPolicy.whaleUsdSolana,
    ],
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
      attributionPolicy.venueThresholds.polymarket.marketMoverStakeToMarketVolRatio,
      attributionPolicy.venueThresholds.kalshi.marketMoverStakeToMarketVolRatio,
      attributionPolicy.venueThresholds.limitless.marketMoverStakeToMarketVolRatio,
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
    !canUseExactAttributionSqlLabelFilter(filters.primaryTyped, filters.labelsTyped)
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
    rows.map((row) => ({
      walletId: row.id,
      tags: row.tags ?? [],
      metrics: null,
      inferredWinRate: null,
      inferredResolvedCount: null,
      trackedExposureUsd: null,
      topChanges: [],
    })),
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
  userId: string,
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

async function loadWalletIdsForSignalScope(
  client: PoolClient,
  userId: string,
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
    scope === "all" ? loadFollowingWalletIds(client, userId) : Promise.resolve([]),
  ]);
  return mergeWalletIdsForScope(scope, followingIds, activeIds);
}

async function loadWalletRowsByIds(
  client: PoolClient,
  userId: string,
  walletIds: string[],
  categories: string[] | null,
): Promise<CandidateWalletRow[]> {
  if (walletIds.length === 0) return [];
  const categoryFilter = categories && categories.length > 0 ? categories : null;
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
      ),
      latest_metrics as (
        select distinct on (s.wallet_id)
          s.wallet_id,
          jsonb_build_object(
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
        join wallet_set ws on ws.wallet_id = s.wallet_id
        where s.period = '30d'
        order by s.wallet_id, s.as_of desc
      )
      select
        w.id,
        w.address,
        w.chain,
        w.label,
        wl.label as user_label,
        w.is_system_flagged,
        w.first_seen_at,
        w.last_seen_at,
        ta.tags,
        lm.metrics,
        wp.profile,
        wp.updated_at as profile_updated_at
      from wallet_set ws
      join wallets w on w.id = ws.wallet_id
      left join wallet_user_labels wl
        on wl.wallet_id = w.id
       and wl.user_id = $1
      left join tags_agg ta on ta.wallet_id = w.id
      left join latest_metrics lm on lm.wallet_id = w.id
      left join wallet_profiles wp on wp.wallet_id = w.id
      where ($3::text[] is null or wp.profile->'categories' ?| $3::text[])
      order by w.last_seen_at desc
    `,
    [userId, walletIds, categoryFilter],
  );
  return rows.rows;
}

async function loadWalletMmDiagnosticsMap(
  client: PoolClient,
  wallets: Array<{ walletId: string; chain: string }>,
  refreshPolicy: Awaited<ReturnType<typeof resolveWalletIntelRefreshPolicy>>["effective"],
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
            select distinct on (upper(coalesce(ws.outcome_side, '')))
              upper(coalesce(ws.outcome_side, '')) as outcome_side,
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
              upper(coalesce(ws.outcome_side, '')),
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

      if (chain !== "solana" && !ethers.isAddress(address)) {
        reply.code(400);
        return reply.send({ error: "Invalid EVM wallet address" });
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

        if (chain === "polygon" && ethers.isAddress(address)) {
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
              const safeLabel = baseLabel
                ? `${baseLabel} (Trading wallet)`
                : "Trading wallet (auto)";
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
                  safeLabel,
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
                    [user.id, safeWalletId, `${baseLabel} (Trading wallet)`],
                  );
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
                if (owner !== address) {
                  const ownerLabel = baseLabel
                    ? `${baseLabel} (Signer wallet)`
                    : "Signer wallet (auto)";
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
                      ownerLabel,
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
                        [user.id, ownerWalletId, `${baseLabel} (Signer wallet)`],
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
   * DELETE /wallets/follow/:address
   */
  z.delete(
    "/wallets/follow/:address",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: walletFollowParamsSchema,
        querystring: walletFollowDeleteQuerySchema,
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

        await client.query(
          `
            delete from wallet_user_labels
            where user_id = $1 and wallet_id = $2
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
            user_label: string | null;
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
              wl.label as user_label
            from wallet_follows wf
            join wallets w on w.id = wf.wallet_id
            left join wallet_profiles wp on wp.wallet_id = w.id
            left join wallet_user_labels wl
              on wl.wallet_id = w.id
             and wl.user_id = $1
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
              where s.wallet_id = w.id and s.period = '30d'
              order by s.as_of desc
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

        return reply.send({
          ok: true,
          wallets: rows.rows.map((row) => ({
            walletId: row.id,
            address: row.address,
            chain: row.chain,
            label: row.label,
            isSystemFlagged: row.is_system_flagged,
            firstSeenAt: row.first_seen_at,
            lastSeenAt: row.last_seen_at,
            followedAt: row.follow_created_at,
            tags: row.tags ?? [],
            metrics: row.metrics ?? null,
            inferredWinRate:
              row.inferred_total && row.inferred_total > 0 && row.inferred_wins != null
                ? Number(row.inferred_wins) / Number(row.inferred_total)
                : null,
            inferredResolvedCount:
              row.inferred_total != null ? Number(row.inferred_total) : null,
            profile: row.profile ?? null,
            profileUpdatedAt: row.profile_updated_at ?? null,
            userLabel: row.user_label ?? null,
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
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletWhalesQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

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
      const primaryFilterTyped = normalizeAttributionPrimaryFilters(primaryFilter);
      const labelsFilterTyped = normalizeAttributionLabelFilters(labelsFilter);
      const requiresSummaryForAttributionFilters = filtersRequireSummaryHydration(
        primaryFilterTyped,
        labelsFilterTyped,
      );
      const cacheTtlSec = Math.max(0, Math.trunc(env.walletIntelTtlSec));
      const cacheClient = cacheTtlSec > 0 ? await getRedis() : null;
      const cacheKey = walletIntelCacheKey("wallets-whales", user.id, query);
      if (cacheClient) {
        const cachedBody = await cacheClient.get(cacheKey);
        if (cachedBody) {
          reply.header("x-cache", "hit");
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(cachedBody);
        }
      }
      const client = await pool.connect();
      try {
        const result = await withJitDisabled(client, async () => {
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

          const orderBy = (() => {
            switch (query.sort) {
              case "volume_30d":
                return "whale_score desc nulls last, activity.last_activity_at desc nulls last, w.last_seen_at desc";
              case "trades_30d":
                return "metrics.metrics_trades desc nulls last, activity.last_activity_at desc nulls last, w.last_seen_at desc";
              case "exposure_usd":
                return "exposure.exposure_usd desc nulls last, activity.last_activity_at desc nulls last, w.last_seen_at desc";
              case "imbalance_usd":
                return "exposure.net_imbalance_usd desc nulls last, activity.last_activity_at desc nulls last, w.last_seen_at desc";
              case "winrate":
                return "case when inferred.total > 0 then inferred.wins::float / inferred.total end desc nulls last, inferred.total desc nulls last, activity.last_activity_at desc nulls last, w.last_seen_at desc";
              case "pnl_30d":
                return "metrics.metrics_pnl desc nulls last, whale_score desc nulls last, activity.last_activity_at desc nulls last, w.last_seen_at desc";
              case "last_activity":
              default:
                return "activity.last_activity_at desc nulls last, whale_score desc nulls last, w.last_seen_at desc";
            }
          })();

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

          const whaleRows = await client.query<
            WalletRow &
              WhaleProfileRow & {
                is_followed: boolean;
                tags: WalletTagRow[] | null;
                metrics: WalletMetricsRow | null;
                last_activity_at: Date | null;
                has_trade_activity: boolean | null;
                has_holder_activity: boolean | null;
                metrics_volume: string | null;
                metrics_pnl: string | null;
                metrics_trades: number | null;
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
                user_label: string | null;
              }
          >(
            `
              select
                w.id,
                w.address,
                w.chain,
                w.label,
                wl.label as user_label,
                w.is_system_flagged,
                (w.metadata->>'kind' = 'safe') as is_safe,
                w.first_seen_at,
                w.last_seen_at,
                (wf.wallet_id is not null) as is_followed,
                tags.tags,
                metrics.metrics,
                metrics.metrics_volume,
                metrics.metrics_pnl,
                metrics.metrics_trades,
                exposure.exposure_usd,
                exposure.hedged_notional_usd,
                exposure.net_imbalance_usd,
                exposure.hedge_ratio,
                exposure.two_sided_markets,
                case
                  when w.chain = 'solana'
                    then coalesce(nullif(metrics.metrics_volume, 0), exposure.exposure_usd, 0)
                  else coalesce(metrics.metrics_volume, 0)
                end as whale_score,
                owner.owner_address,
                owner.owner_label,
                owner.owner_wallet_id,
                wp.profile as profile,
                wp.updated_at as profile_updated_at,
                activity.last_activity_at,
                inferred.wins as inferred_wins,
                inferred.total as inferred_total
              from wallets w
              join wallet_tag_map tm on tm.wallet_id = w.id
               and tm.tag_id = $5::uuid
              left join wallet_follows wf on wf.wallet_id = w.id and wf.user_id = $1
              left join wallet_user_labels wl
                on wl.wallet_id = w.id
               and wl.user_id = $1
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
                  jsonb_build_object(
                    'period', s.period,
                    'as_of', s.as_of,
                    'trades_count', s.trades_count,
                    'volume_usd', s.volume_usd,
                    'pnl_usd', s.pnl_usd,
                    'roi', s.roi,
                    'win_rate', s.win_rate,
                    'avg_hold_hours', s.avg_hold_hours,
                    'last_trade_at', s.last_trade_at
                  ) as metrics,
                  s.volume_usd as metrics_volume,
                  s.pnl_usd as metrics_pnl,
                  s.trades_count as metrics_trades
                from wallet_metrics_snapshots s
                where s.wallet_id = w.id and s.period = '30d'
                order by s.as_of desc
                limit 1
              ) metrics on true
              left join lateral (
                select
                  max(wah.last_occurred_at) as last_activity_at,
                  bool_or(wah.activity_type in ('delta', 'trade')) as has_trade_activity,
                  bool_or(wah.activity_type = 'holder') as has_holder_activity
                from wallet_activity_hourly wah
                where wah.wallet_id = w.id
                  and wah.hour_bucket >= now() - ($3::text || ' days')::interval
              ) activity on true
              left join wallet_position_exposure exposure on exposure.wallet_id = w.id
              left join lateral (
                select
                  w2.address as owner_address,
                  w2.label as owner_label,
                  w2.id as owner_wallet_id
                from wallets w2
                where w.metadata->>'kind' = 'safe'
                  and w2.metadata->>'kind' = 'safe_owner'
                  and w2.metadata->>'derivedFrom' = w.address
                  and w2.chain = w.chain
                limit 1
              ) owner on true
              left join wallet_profiles wp on wp.wallet_id = w.id
              left join wallet_inferred_outcomes inferred on inferred.wallet_id = w.id
              where ($4::text[] is null or wp.profile->'categories' ?| $4::text[])
                and activity.last_activity_at is not null
              order by ${orderBy}
              limit $2
            `,
            [
              user.id,
              maxScanCandidates + 1,
              query.windowDays,
              categoryFilter.length > 0 ? categoryFilter : null,
              whaleTagId,
            ],
          );

          const hasMoreCandidates = whaleRows.rows.length > maxScanCandidates;
          const hitScanCap = hasMoreCandidates;
          const scannedRows = hasMoreCandidates
            ? whaleRows.rows.slice(0, maxScanCandidates)
            : whaleRows.rows;

          const filteredByActivity = scannedRows
            .map((row) => mapWhaleRowToItem(row, refreshPolicy.effective))
            .filter((row) => Boolean(row.lastActivityAt));

          const deduped = new Map<string, WhaleWalletItem>();
          for (const row of filteredByActivity) {
            const dedupeKey =
              row.isSafe && row.ownerAddress
                ? row.ownerAddress.toLowerCase()
                : row.address.toLowerCase();
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

          let summaryMapForFilters: Map<string, WalletActivitySummary> | null = null;
          const attributionMapForFilters = new Map<string, WalletAttribution>();
          let postFilterRows = tagsOnlyRows;

          if (needsAttributionForFilters && tagsOnlyRows.length > 0) {
            if (requiresSummaryForAttributionFilters) {
              summaryMapForFilters = new Map<string, WalletActivitySummary>();
              for (const chunk of chunkArray(tagsOnlyRows, hydrationBatchSize)) {
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

            for (const chunk of chunkArray(tagsOnlyRows, hydrationBatchSize)) {
              if (chunk.length === 0) continue;
              const chunkAttribution = await buildWalletAttributionMap(
                client,
                chunk.map((row) => ({
                  walletId: row.walletId,
                  tags: row.tags ?? [],
                  metrics: row.metrics ?? null,
                  inferredWinRate: row.inferredWinRate,
                  inferredResolvedCount: row.inferredResolvedCount,
                  trackedExposureUsd: row.trackedExposureUsd,
                  topChanges:
                    summaryMapForFilters?.get(row.walletId)?.topChanges ?? [],
                })),
                attributionPolicy.effective,
                {
                  mode: "filters",
                  filterPrimary: primaryFilterTyped,
                  filterLabels: labelsFilterTyped,
                },
              );
              for (const [walletId, attribution] of chunkAttribution.entries()) {
                attributionMapForFilters.set(walletId, attribution);
              }
            }

            postFilterRows = tagsOnlyRows.filter((row) =>
              walletMatchesFilters(row.tags, attributionMapForFilters.get(row.walletId), {
                tags: [],
                tagMode: query.tagMode,
                primary: primaryFilter,
                labels: labelsFilter,
                labelMode: query.labelMode,
              }),
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

          const pagedRows = postFilterRows.slice(
            query.offset,
            query.offset + query.limit,
          );
          const pagedIds = pagedRows.map((row) => row.walletId);

          const summaryMapForPage =
            summaryMapForFilters ?? new Map<string, WalletActivitySummary>();
          const needsSummaryForPage = query.includeSummary || includeAttributionInResponse;
          if (needsSummaryForPage) {
            const missingIds = pagedIds.filter((id) => !summaryMapForPage.has(id));
            if (missingIds.length > 0) {
              const pageSummary = await fetchWalletActivitySummaries(
                client,
                missingIds,
                {
                  windowHours,
                  topChanges: query.topChanges,
                  baselineDays: 30,
                  enteredLateHours: 24,
                },
              );
              for (const [walletId, summary] of pageSummary.entries()) {
                summaryMapForPage.set(walletId, summary);
              }
            }
          }

          const topMarketMap = await loadWhaleTopMarkets(
            client,
            pagedIds,
            query.marketLimit,
            query.windowDays,
          );
          const sparklineMap = query.includeSparkline
            ? await fetchWalletActivitySparklines(client, pagedIds, {
                windowHours,
              })
            : new Map<string, WalletActivitySparkline>();

          let pageAttributionMap = attributionMapForFilters;
          if (includeAttributionInResponse) {
            pageAttributionMap = await buildWalletAttributionMap(
              client,
              pagedRows.map((row) => ({
                walletId: row.walletId,
                tags: row.tags ?? [],
                metrics: row.metrics ?? null,
                inferredWinRate: row.inferredWinRate,
                inferredResolvedCount: row.inferredResolvedCount,
                trackedExposureUsd: row.trackedExposureUsd,
                topChanges: summaryMapForPage.get(row.walletId)?.topChanges ?? [],
              })),
              attributionPolicy.effective,
              { mode: "full" },
            );
          }

          const wallets = pagedRows.map((row) => {
            const summary = summaryMapForPage.get(row.walletId) ?? null;
            const hydrated = hydrateWhaleItemFromSummary(
              row,
              summary,
              query.includeSummary,
              topMarketMap.get(row.walletId) ?? [],
            );
            const withSparkline = query.includeSparkline
              ? {
                  ...hydrated,
                  sparkline:
                    sparklineMap.get(row.walletId) ??
                    buildEmptyWalletActivitySparkline({ windowHours }),
                }
              : hydrated;
            return includeAttributionInResponse
              ? {
                  ...withSparkline,
                  attribution: pageAttributionMap.get(row.walletId),
                }
              : withSparkline;
          });

          return {
            filterTooBroad: false as const,
            payload: {
              ok: true,
              wallets,
            },
          };
        });

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
        if (cacheClient) {
          await cacheClient.set(cacheKey, body, { EX: cacheTtlSec });
          reply.header("x-cache", "miss");
        }
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(body);
      } catch (error) {
        app.log.error(
          { error, userId: user.id, query },
          "Failed to load whale wallets",
        );
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
      preHandler: createAuthMiddleware(),
      schema: { params: walletProfileParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const walletId = request.params.walletId;
      const client = await pool.connect();
      try {
        const result = await client.query<
          WalletRow & {
            tags: WalletTagRow[] | null;
            metrics: WalletMetricsRow | null;
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
              tags.tags,
              metrics.metrics
            from wallets w
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
              where s.wallet_id = w.id and s.period = '30d'
              order by s.as_of desc
              limit 1
            ) metrics on true
            where w.id = $1
            limit 1
          `,
          [walletId],
        );

        const wallet = result.rows[0];
        if (!wallet) {
          reply.code(404);
          return reply.send({ error: "Wallet not found" });
        }

        return reply.send({
          ok: true,
          wallet: {
            walletId: wallet.id,
            address: wallet.address,
            chain: wallet.chain,
            label: wallet.label,
            isSystemFlagged: wallet.is_system_flagged,
            firstSeenAt: wallet.first_seen_at,
            lastSeenAt: wallet.last_seen_at,
            tags: wallet.tags ?? [],
            metrics: wallet.metrics ?? null,
          },
        });
      } catch (error) {
        app.log.error(
          { error, walletId, userId: user.id },
          "Failed to load wallet",
        );
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
      preHandler: createAuthMiddleware(),
      schema: {
        params: walletProfileParamsSchema,
        querystring: walletSeriesQuerySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

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

        const [activityMap, performance] = await Promise.all([
          fetchWalletActivitySparklines(client, [walletId], {
            windowHours: query.windowHours,
            bucketHours: query.bucketHours,
          }),
          fetchWalletPerformanceSeries(client, walletId, {
            period: query.period,
            limit: query.limit,
          }),
        ]);

        return reply.send({
          ok: true,
          walletId,
          activity:
            activityMap.get(walletId) ??
            buildEmptyWalletActivitySparkline({
              windowHours: query.windowHours,
              bucketHours: query.bucketHours,
            }),
          performance,
        });
      } catch (error) {
        app.log.error(
          { error, walletId, userId: user.id, query },
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
   * GET /wallets/activity/summary
   */
  z.get(
    "/wallets/activity/summary",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletActivitySummaryQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

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
      const primaryFilterTyped = normalizeAttributionPrimaryFilters(primaryFilter);
      const labelsFilterTyped = normalizeAttributionLabelFilters(labelsFilter);
      const requiresSummaryForAttributionFilters = filtersRequireSummaryHydration(
        primaryFilterTyped,
        labelsFilterTyped,
      );
      const cacheTtlSec = Math.max(0, Math.trunc(env.walletIntelTtlSec));
      const cacheClient = cacheTtlSec > 0 ? await getRedis() : null;
      const cacheKey = walletIntelCacheKey(
        "wallets-activity-summary",
        user.id,
        query,
      );
      if (cacheClient) {
        const cachedBody = await cacheClient.get(cacheKey);
        if (cachedBody) {
          reply.header("x-cache", "hit");
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(cachedBody);
        }
      }
      const client = await pool.connect();
      try {
        const payload = await withJitDisabled(client, async () => {
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
            user.id,
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
          let workingWalletIds = filteredWalletIds;
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
            return { ok: true, items: [] as WalletActivitySummaryItem[] };
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
              retentionDaysActivity: refreshPolicy.effective.retentionDaysActivity,
              weightStake: signalConfig.weightStake,
              weightOdds: signalConfig.weightOdds,
              weightIdle: signalConfig.weightIdle,
              weightNovelty: signalConfig.weightNovelty,
              minScore: signalConfig.minScore,
            },
          };
          if (!needsAttributionForFilters || !requiresSummaryForAttributionFilters) {
            const summaryStatsMap = await fetchWalletActivitySummaryStats(
              client,
              workingWalletIds,
              summaryOptions,
            );
            const sortMode = query.sort;
            const sortedStats = Array.from(summaryStatsMap.values())
              .filter((row) => Boolean(row.lastActivityAt))
              .sort((a, b) => {
                if (sortMode === "net_change_usd") {
                  return Math.abs(b.netChangeUsd) - Math.abs(a.netChangeUsd);
                }
                if (sortMode === "unusual_score") {
                  const aScore = a.unusualScore ?? 0;
                  const bScore = b.unusualScore ?? 0;
                  if (bScore !== aScore) return bScore - aScore;
                  return Math.abs(b.netChangeUsd) - Math.abs(a.netChangeUsd);
                }
                const aTime = a.lastActivityAt?.getTime() ?? 0;
                const bTime = b.lastActivityAt?.getTime() ?? 0;
                return bTime - aTime;
              });
            const pagedStats = sortedStats.slice(
              query.offset,
              query.offset + query.limit,
            );
            const pagedIds = pagedStats.map((row) => row.walletId);
            if (pagedIds.length === 0) {
              return { ok: true, items: [] as WalletActivitySummaryItem[] };
            }
            const [pageRows, pageTopChangesMap, sparklineMap] = await Promise.all([
              loadWalletRowsByIds(client, user.id, pagedIds, null),
              fetchWalletActivityTopChanges(client, pagedIds, summaryOptions),
              query.includeSparkline
                ? fetchWalletActivitySparklines(client, pagedIds, { windowHours })
                : Promise.resolve(new Map<string, WalletActivitySparkline>()),
            ]);
            const rowById = new Map(pageRows.map((row) => [row.id, row] as const));
            const attributionMap = includeAttributionInResponse
              ? await buildWalletAttributionMap(
                  client,
                  pagedIds
                    .map((walletId) => {
                      const row = rowById.get(walletId);
                      if (!row) return null;
                      return {
                        walletId,
                        tags: row.tags ?? [],
                        metrics: row.metrics ?? null,
                        inferredWinRate: null,
                        inferredResolvedCount: null,
                        trackedExposureUsd: null,
                        topChanges: pageTopChangesMap.get(walletId) ?? [],
                      };
                    })
                    .filter(
                      (
                        entry,
                      ): entry is {
                        walletId: string;
                        tags: WalletTagRow[];
                        metrics: WalletMetricsRow | null;
                        inferredWinRate: null;
                        inferredResolvedCount: null;
                        trackedExposureUsd: null;
                        topChanges: WalletActivityTopChange[];
                      } => Boolean(entry),
                    ),
                  attributionPolicy.effective,
                  { mode: "full" },
                )
              : new Map<string, WalletAttribution>();
            const items = pagedStats
              .map<WalletActivitySummaryItem | null>((summary) => {
                const row = rowById.get(summary.walletId);
                if (!row) return null;
                const baseItem: WalletActivitySummaryItem = {
                  walletId: row.id,
                  address: row.address,
                  chain: row.chain,
                  label: row.label,
                  userLabel: row.user_label ?? null,
                  isSystemFlagged: row.is_system_flagged,
                  firstSeenAt: row.first_seen_at,
                  lastSeenAt: row.last_seen_at,
                  tags: row.tags ?? [],
                  metrics: row.metrics ?? null,
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
                  topChanges: pageTopChangesMap.get(row.id) ?? [],
                };
                const withSparkline = query.includeSparkline
                  ? {
                      ...baseItem,
                      sparkline:
                        sparklineMap.get(row.id) ??
                        buildEmptyWalletActivitySparkline({ windowHours }),
                    }
                  : baseItem;
                return includeAttributionInResponse
                  ? {
                      ...withSparkline,
                      attribution: attributionMap.get(row.id),
                    }
                  : withSparkline;
              })
              .filter((row): row is WalletActivitySummaryItem => Boolean(row));
            return { ok: true, items };
          }

          const candidates = await loadWalletRowsByIds(
            client,
            user.id,
            filteredWalletIds,
            null,
          );
          const summaryStatsMap = await fetchWalletActivitySummaryStats(
            client,
            filteredWalletIds,
            summaryOptions,
          );

          const merged = candidates
            .map<WalletActivitySummaryItem | null>((row) => {
              const summary = summaryStatsMap.get(row.id);
              if (!summary || !summary.lastActivityAt) return null;
              return {
                walletId: row.id,
                address: row.address,
                chain: row.chain,
                label: row.label,
                userLabel: row.user_label ?? null,
                isSystemFlagged: row.is_system_flagged,
                firstSeenAt: row.first_seen_at,
                lastSeenAt: row.last_seen_at,
                tags: row.tags ?? [],
                metrics: row.metrics ?? null,
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
                topChanges: [],
              };
            })
            .filter((row): row is WalletActivitySummaryItem => Boolean(row));

          let topChangesForFilters = new Map<string, WalletActivityTopChange[]>();
          let attributionMap = new Map<string, WalletAttribution>();
          let filtered = merged;

          if (merged.length > 0) {
            topChangesForFilters = await fetchWalletActivityTopChanges(
              client,
              merged.map((row) => row.walletId),
              summaryOptions,
            );
            attributionMap = await buildWalletAttributionMap(
              client,
              merged.map((row) => ({
                walletId: row.walletId,
                tags: row.tags,
                metrics: row.metrics,
                inferredWinRate: null,
                inferredResolvedCount: null,
                trackedExposureUsd: null,
                topChanges: topChangesForFilters.get(row.walletId) ?? [],
              })),
              attributionPolicy.effective,
              {
                mode: "filters",
                filterPrimary: primaryFilterTyped,
                filterLabels: labelsFilterTyped,
              },
            );
            filtered = merged.filter((row) =>
              walletMatchesFilters(row.tags, attributionMap.get(row.walletId), {
                tags: [],
                tagMode: "any",
                primary: primaryFilter,
                labels: labelsFilter,
                labelMode: query.labelMode,
              }),
            );
          }

          const sortMode = query.sort;
          const sorted = filtered.sort((a, b) => {
            if (sortMode === "net_change_usd") {
              return Math.abs(b.netChangeUsd) - Math.abs(a.netChangeUsd);
            }
            if (sortMode === "unusual_score") {
              const aScore = a.unusualScore ?? 0;
              const bScore = b.unusualScore ?? 0;
              if (bScore !== aScore) return bScore - aScore;
              return Math.abs(b.netChangeUsd) - Math.abs(a.netChangeUsd);
            }
            const aTime = a.lastActivityAt?.getTime() ?? 0;
            const bTime = b.lastActivityAt?.getTime() ?? 0;
            return bTime - aTime;
          });

          const start = query.offset;
          const end = start + query.limit;
          const pagedRows = sorted.slice(start, end);
          const pagedIds = pagedRows.map((row) => row.walletId);
          const pageTopChangesMap = new Map<string, WalletActivityTopChange[]>();
          for (const walletId of pagedIds) {
            if (topChangesForFilters.has(walletId)) {
              pageTopChangesMap.set(walletId, topChangesForFilters.get(walletId) ?? []);
            }
          }
          const missingTopChangeIds = pagedIds.filter(
            (walletId) => !pageTopChangesMap.has(walletId),
          );
          if (missingTopChangeIds.length > 0) {
            const topChangesForPage = await fetchWalletActivityTopChanges(
              client,
              missingTopChangeIds,
              summaryOptions,
            );
            for (const [walletId, topChanges] of topChangesForPage.entries()) {
              pageTopChangesMap.set(walletId, topChanges);
            }
          }
          const sparklineMap = query.includeSparkline
            ? await fetchWalletActivitySparklines(client, pagedIds, { windowHours })
            : new Map<string, WalletActivitySparkline>();
          if (includeAttributionInResponse) {
            attributionMap = await buildWalletAttributionMap(
              client,
              pagedRows.map((row) => ({
                walletId: row.walletId,
                tags: row.tags,
                metrics: row.metrics,
                inferredWinRate: null,
                inferredResolvedCount: null,
                trackedExposureUsd: null,
                topChanges: pageTopChangesMap.get(row.walletId) ?? [],
              })),
              attributionPolicy.effective,
              { mode: "full" },
            );
          }

          const items = pagedRows.map((row) => {
            const withTopChanges = {
              ...row,
              topChanges: pageTopChangesMap.get(row.walletId) ?? [],
            };
            const withSparkline = query.includeSparkline
              ? {
                  ...withTopChanges,
                  sparkline:
                    sparklineMap.get(row.walletId) ??
                    buildEmptyWalletActivitySparkline({ windowHours }),
                }
              : withTopChanges;
            return includeAttributionInResponse
              ? {
                  ...withSparkline,
                  attribution: attributionMap.get(row.walletId),
                }
              : withSparkline;
          });

          return { ok: true, items };
        });

        const body = JSON.stringify(payload);
        if (cacheClient) {
          await cacheClient.set(cacheKey, body, { EX: cacheTtlSec });
          reply.header("x-cache", "miss");
        }
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(body);
      } catch (error) {
        app.log.error(
          { error, userId: user.id, query },
          "Failed to load wallet activity summaries",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load wallet activity summaries" });
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
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletActivitySignalsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

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
      const primaryFilterTyped = normalizeAttributionPrimaryFilters(primaryFilter);
      const labelsFilterTyped = normalizeAttributionLabelFilters(labelsFilter);
      const requiresSummaryForAttributionFilters = filtersRequireSummaryHydration(
        primaryFilterTyped,
        labelsFilterTyped,
      );
      const severityFilter = normalizeStringArray(
        (query.severity as string[] | undefined) ?? [],
      );
      const displayReasonFilter = normalizeStringArray(query.displayReasons);
      const cacheTtlSec = Math.max(0, Math.trunc(env.walletIntelTtlSec));
      const cacheClient = cacheTtlSec > 0 ? await getRedis() : null;
      const cacheKey = walletIntelCacheKey(
        "wallets-activity-signals",
        user.id,
        query,
      );
      if (cacheClient) {
        const cachedBody = await cacheClient.get(cacheKey);
        if (cachedBody) {
          reply.header("x-cache", "hit");
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(cachedBody);
        }
      }
      const client = await pool.connect();
      try {
        const payload = await withJitDisabled(client, async () => {
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
          const minPayoutUsd = query.minPayoutUsd ?? signalConfig.minPayoutUsd;

          const candidateWalletIds = await loadWalletIdsForSignalScope(
            client,
            user.id,
            query.scope,
            windowHours,
            {
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
              retentionDaysActivity: refreshPolicy.effective.retentionDaysActivity,
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
                  attributionPolicy.effective.signalsDisplay.severityThresholds,
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
              loadWalletRowsByIds(client, user.id, pageWalletIds, null),
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
                const pageLabels =
                  signalPageLabelsMap.get(
                    buildSignalRowLabelKey({
                      walletId: signalRow.walletId,
                      venue: signalRow.venue,
                      marketId: signalRow.marketId,
                      positionSide: signalRow.positionSide,
                    }),
                  ) ?? null;
                const labels = [
                  ...(pageLabels?.unusualSize ? ["unusual_size"] : []),
                  ...(pageLabels?.onPattern ? ["on_pattern"] : []),
                  ...(pageLabels &&
                  pageLabels.hasProfileCategories &&
                  !pageLabels.onPattern &&
                  pageLabels.category
                    ? ["out_of_pattern"]
                    : []),
                ];
                const signalPresentation = buildSignalPresentation({
                  signalLabels: signalRow.reasonCodes,
                  labels,
                  signalScore: signalRow.signalScore,
                  venue: signalRow.venue,
                  policy: attributionPolicy.effective,
                });
                return {
                  walletId: signalRow.walletId,
                  address: candidate.address,
                  chain: candidate.chain,
                  label: candidate.label,
                  userLabel: candidate.user_label ?? null,
                  isSystemFlagged: candidate.is_system_flagged,
                  firstSeenAt: candidate.first_seen_at,
                  lastSeenAt: candidate.last_seen_at,
                  tags: candidate.tags ?? [],
                  metrics: candidate.metrics ?? null,
                  profile: candidate.profile ?? null,
                  profileUpdatedAt: candidate.profile_updated_at ?? null,
                  marketId: signalRow.marketId,
                  marketTitle: signalRow.marketTitle,
                  eventId: signalRow.eventId,
                  eventTitle: signalRow.eventTitle,
                  venue: signalRow.venue,
                  marketStatus: signalRow.marketStatus,
                  closeTime: signalRow.closeTime,
                  expirationTime: signalRow.expirationTime,
                  resolvedOutcome: signalRow.resolvedOutcome,
                  category: signalRow.category,
                  action: signalRow.action,
                  positionSide: signalRow.positionSide,
                  deltaShares: signalRow.deltaShares,
                  deltaUsd: signalRow.deltaUsd,
                  stakeUsd: signalRow.stakeUsd,
                  odds: signalRow.odds,
                  potentialPayoutUsd: signalRow.potentialPayoutUsd,
                  idleDays: signalRow.idleDays,
                  priorDistinctMarkets: signalRow.priorDistinctMarkets,
                  signalScore: signalRow.signalScore,
                  signalType: signalRow.signalType,
                  lateBucket: signalRow.lateBucket,
                  labels,
                  signalLabels: signalRow.reasonCodes,
                  reasonCodes: signalPresentation.reasonCodes,
                  displayReasons: signalPresentation.displayReasons,
                  severity: signalPresentation.severity,
                  mmDiagnostics:
                    mmDiagnosticsByWallet.get(signalRow.walletId) ?? null,
                  occurredAt: signalRow.occurredAt,
                };
              })
              .filter((item): item is WalletActivitySignalItem => Boolean(item));

            if (!includeAttributionInResponse) {
              return {
                ok: true,
                items,
              };
            }

            const attributionInputsByWallet = items.reduce(
              (acc, item) => {
                const existing = acc.get(item.walletId);
                if (existing) {
                  existing.topChanges = [
                    ...existing.topChanges,
                    signalRowToTopChange({
                      walletId: item.walletId,
                      marketId: item.marketId,
                      marketTitle: item.marketTitle,
                      eventId: item.eventId,
                      eventTitle: item.eventTitle,
                      venue: item.venue,
                      marketStatus: item.marketStatus,
                      closeTime: item.closeTime,
                      expirationTime: item.expirationTime,
                      resolvedOutcome: item.resolvedOutcome,
                      category: item.category,
                      action: item.action,
                      positionSide: item.positionSide,
                      deltaShares: item.deltaShares,
                      deltaUsd: item.deltaUsd,
                      stakeUsd: item.stakeUsd,
                      odds: item.odds,
                      potentialPayoutUsd: item.potentialPayoutUsd,
                      idleDays: item.idleDays,
                      priorDistinctMarkets: item.priorDistinctMarkets,
                      signalScore: item.signalScore,
                      signalType: item.signalType,
                      lateBucket: item.lateBucket,
                      occurredAt: item.occurredAt,
                      reasonCodes: item.reasonCodes,
                    }),
                  ];
                  return acc;
                }
                acc.set(item.walletId, {
                  walletId: item.walletId,
                  tags: item.tags,
                  metrics: item.metrics,
                  inferredWinRate: null,
                  inferredResolvedCount: null,
                  trackedExposureUsd: null,
                  topChanges: [
                    signalRowToTopChange({
                      walletId: item.walletId,
                      marketId: item.marketId,
                      marketTitle: item.marketTitle,
                      eventId: item.eventId,
                      eventTitle: item.eventTitle,
                      venue: item.venue,
                      marketStatus: item.marketStatus,
                      closeTime: item.closeTime,
                      expirationTime: item.expirationTime,
                      resolvedOutcome: item.resolvedOutcome,
                      category: item.category,
                      action: item.action,
                      positionSide: item.positionSide,
                      deltaShares: item.deltaShares,
                      deltaUsd: item.deltaUsd,
                      stakeUsd: item.stakeUsd,
                      odds: item.odds,
                      potentialPayoutUsd: item.potentialPayoutUsd,
                      idleDays: item.idleDays,
                      priorDistinctMarkets: item.priorDistinctMarkets,
                      signalScore: item.signalScore,
                      signalType: item.signalType,
                      lateBucket: item.lateBucket,
                      occurredAt: item.occurredAt,
                      reasonCodes: item.reasonCodes,
                    }),
                  ],
                });
                return acc;
              },
              new Map<
                string,
                {
                  walletId: string;
                  tags: WalletTagRow[];
                  metrics: WalletMetricsRow | null;
                  inferredWinRate: null;
                  inferredResolvedCount: null;
                  trackedExposureUsd: null;
                  topChanges: WalletActivityTopChange[];
                }
              >(),
            );
            const attributionMap = await buildWalletAttributionMap(
              client,
              Array.from(attributionInputsByWallet.values()),
              attributionPolicy.effective,
              { mode: "full" },
            );
            return {
              ok: true,
              items: items.map((item) => ({
                ...item,
                attribution: attributionMap.get(item.walletId),
              })),
            };
          }

          const candidates = await loadWalletRowsByIds(
            client,
            user.id,
            workingWalletIds,
            null,
          );
          const walletIds = candidates.map((row) => row.id);
          const summaryMap = await fetchWalletActivitySummaries(client, walletIds, {
            ...signalSummaryOptions,
          });
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
              if (query.signalType && change.signalType !== query.signalType) continue;
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
              const signalPresentation = buildSignalPresentation({
                signalLabels: change.signalLabels ?? [],
                labels: change.labels ?? [],
                signalScore: change.signalScore ?? null,
                venue: change.venue,
                policy: attributionPolicy.effective,
              });
              items.push({
                walletId: row.id,
                address: row.address,
                chain: row.chain,
                label: row.label,
                userLabel: row.user_label ?? null,
                isSystemFlagged: row.is_system_flagged,
                firstSeenAt: row.first_seen_at,
                lastSeenAt: row.last_seen_at,
                tags: row.tags ?? [],
                metrics: row.metrics ?? null,
                profile: row.profile ?? null,
                profileUpdatedAt: row.profile_updated_at ?? null,
                marketId: change.marketId,
                marketTitle: change.marketTitle ?? null,
                eventId: change.eventId ?? null,
                eventTitle: change.eventTitle ?? null,
                venue: change.venue,
                marketStatus: change.marketStatus ?? null,
                closeTime: change.closeTime ?? null,
                expirationTime: change.expirationTime ?? null,
                resolvedOutcome: change.resolvedOutcome ?? null,
                category: change.category ?? null,
                action: change.action ?? null,
                positionSide: change.positionSide ?? null,
                deltaShares: change.deltaShares ?? null,
                deltaUsd: change.deltaUsd ?? null,
                stakeUsd: change.stakeUsd ?? null,
                odds: change.odds ?? null,
                potentialPayoutUsd: change.potentialPayoutUsd ?? null,
                idleDays: change.idleDays ?? null,
                priorDistinctMarkets: change.priorDistinctMarkets ?? null,
                signalScore: change.signalScore ?? null,
                signalType: change.signalType,
                lateBucket: change.lateBucket ?? null,
                labels: change.labels ?? [],
                signalLabels: change.signalLabels ?? [],
                reasonCodes: signalPresentation.reasonCodes,
                displayReasons: signalPresentation.displayReasons,
                severity: signalPresentation.severity,
                mmDiagnostics,
                occurredAt: change.occurredAt,
              });
            }
          }

          if (activeWithInvalidClose > 0) {
            app.log.warn(
              {
                userId: user.id,
                activeWithInvalidClose,
                samples: activeInvalidSamples,
              },
              "Detected ACTIVE markets with missing/past close time in wallet signals",
            );
          }

          const attributionInputsByWallet = items.reduce(
            (acc, item) => {
              const current = acc.get(item.walletId);
              if (!current) {
                acc.set(item.walletId, {
                  walletId: item.walletId,
                  tags: item.tags,
                  metrics: item.metrics,
                  inferredWinRate: null,
                  inferredResolvedCount: null,
                  trackedExposureUsd: null,
                  topChanges: [] as WalletActivityTopChange[],
                });
              }
              const holder = acc.get(item.walletId);
              if (holder) {
                holder.topChanges = [
                  ...(holder.topChanges ?? []),
                  {
                    marketId: item.marketId,
                    marketTitle: item.marketTitle ?? null,
                    eventId: item.eventId ?? null,
                    eventTitle: item.eventTitle ?? null,
                    venue: item.venue,
                    marketStatus: item.marketStatus ?? null,
                    closeTime: item.closeTime ?? null,
                    expirationTime: item.expirationTime ?? null,
                    resolvedOutcome: item.resolvedOutcome ?? null,
                    category: item.category ?? null,
                    action: item.action ?? null,
                    positionSide: item.positionSide ?? null,
                    deltaShares: item.deltaShares ?? null,
                    deltaUsd: item.deltaUsd ?? null,
                    price: null,
                    odds: item.odds ?? null,
                    stakeUsd: item.stakeUsd ?? null,
                    potentialPayoutUsd: item.potentialPayoutUsd ?? null,
                    idleDays: item.idleDays ?? null,
                    priorDistinctMarkets: item.priorDistinctMarkets ?? null,
                    signalScore: item.signalScore ?? null,
                    signalLabels: item.signalLabels ?? [],
                    signalType: item.signalType ?? null,
                    lateBucket: item.lateBucket ?? null,
                    labels: item.labels ?? [],
                    occurredAt: item.occurredAt,
                  } satisfies WalletActivityTopChange,
                ];
              }
              return acc;
            },
            new Map<
              string,
              {
                walletId: string;
                tags: WalletTagRow[];
                metrics: WalletMetricsRow | null;
                inferredWinRate: null;
                inferredResolvedCount: null;
                trackedExposureUsd: null;
                topChanges: WalletActivityTopChange[];
              }
            >(),
          );

          const attributionInputs = Array.from(attributionInputsByWallet.values());
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
                !walletMatchesFilters(item.tags, attributionMap.get(item.walletId), {
                  tags: [],
                  tagMode: "any",
                  primary: primaryFilter,
                  labels: labelsFilter,
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
          const pagedRows = sorted.slice(query.offset, query.offset + query.limit);
          if (includeAttributionInResponse) {
            const byWallet = new Map<string, (typeof attributionInputs)[number]>();
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
              ? { ...item, attribution: attributionMap.get(item.walletId) }
              : item,
          );
          return {
            ok: true,
            items: itemsForResponse,
          };
        });
        const body = JSON.stringify(payload);
        if (cacheClient) {
          await cacheClient.set(cacheKey, body, { EX: cacheTtlSec });
          reply.header("x-cache", "miss");
        }
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(body);
      } catch (error) {
        app.log.error(
          { error, userId: user.id, query },
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
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletActivityQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const params: Array<string | number | null> = [user.id];
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
      }

      if (query.since) {
        where += ` and wa.occurred_at >= $${idx++}`;
        params.push(query.since);
      }

      params.push(query.limit, query.offset);
      const limitParam = idx++;
      const offsetParam = idx++;

      const client = await pool.connect();
      try {
        const rows = await client.query<{
          wallet_id: string;
          address: string;
          chain: string;
          label: string | null;
          user_label: string | null;
          profile_label: string | null;
          venue: string;
          market_id: string;
          market_title: string | null;
          event_id: string | null;
          event_title: string | null;
          best_bid: string | null;
          best_ask: string | null;
          last_price: string | null;
          market_status: string | null;
          close_time: Date | null;
          expiration_time: Date | null;
          resolved_outcome: string | null;
          outcome_side: string | null;
          action: string | null;
          delta_shares: string | null;
          size_usd: string | null;
          price: string | null;
          activity_type: string;
          source: string | null;
          occurred_at: Date;
          metadata: unknown;
        }>(
          `
            select
              wa.wallet_id,
              w.address,
              w.chain,
              w.label,
              wl.label as user_label,
              wp.profile->>'label_short' as profile_label,
              wa.venue,
              wa.market_id,
              um.title as market_title,
              um.event_id as event_id,
              ue.title as event_title,
              um.best_bid,
              um.best_ask,
              um.last_price,
              um.status as market_status,
              um.close_time,
              um.expiration_time,
              um.resolved_outcome,
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
            left join wallet_profiles wp on wp.wallet_id = w.id
            left join unified_markets um on um.id = wa.market_id
            left join unified_events ue on ue.id = um.event_id
            where ${where}
              and wa.activity_type in ('delta', 'trade')
            order by wa.occurred_at desc
            limit $${limitParam}
            offset $${offsetParam}
          `,
          params,
        );

        const minUsd = env.walletIntelMinActivityUsd;
        const minShares = env.walletIntelMinActivityShares;

        const items = rows.rows.map((row) => ({
          walletId: row.wallet_id,
          address: row.address,
          chain: row.chain,
          label: row.label,
          userLabel: row.user_label ?? null,
          profileLabel: row.profile_label,
          venue: row.venue,
          marketId: row.market_id,
          marketTitle: row.market_title,
          eventId: row.event_id,
          eventTitle: row.event_title,
          bestBid: row.best_bid ? Number(row.best_bid) : null,
          bestAsk: row.best_ask ? Number(row.best_ask) : null,
          lastPrice: row.last_price ? Number(row.last_price) : null,
          marketStatus: row.market_status,
          closeTime: row.close_time ? row.close_time.toISOString() : null,
          expirationTime: row.expiration_time
            ? row.expiration_time.toISOString()
            : null,
          resolvedOutcome: row.resolved_outcome,
          outcomeSide: normalizeOutcomeSideForApi(row.outcome_side),
          action: row.action,
          deltaShares: row.delta_shares ? Number(row.delta_shares) : null,
          sizeUsd: row.size_usd ? Number(row.size_usd) : null,
          price: row.price ? Number(row.price) : null,
          activityType: row.activity_type,
          source: row.source,
          occurredAt: row.occurred_at,
          metadata: row.metadata ?? null,
        }));

        const filteredItems =
          minUsd <= 0 && minShares <= 0
            ? items
            : items.filter((item) => {
                if (item.sizeUsd != null) {
                  if (item.sizeUsd >= minUsd) return true;
                  if (item.deltaShares != null && item.deltaShares >= minShares) {
                    return true;
                  }
                  return false;
                }
                if (item.deltaShares != null) {
                  return item.deltaShares >= minShares;
                }
                return true;
              });

        return reply.send({
          ok: true,
          items: filteredItems,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, query },
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
   * GET /wallets/positions
   */
  z.get(
    "/wallets/positions",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: walletPositionsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const params: Array<string | number | null> = [user.id];
      let where = "";
      let idx = 2;
      const userParam = 1;

      if (query.walletId) {
        where += `ws.wallet_id = $${idx++}`;
        params.push(query.walletId);
      } else {
        where += `ws.wallet_id in (select wallet_id from wallet_follows where user_id = $${userParam})`;
      }

      if (query.venue) {
        where += ` and ws.venue = $${idx++}`;
        params.push(query.venue);
      }

      if (query.since) {
        where += ` and ws.snapshot_at >= $${idx++}`;
        params.push(query.since);
      }

      const positionFilterSql = query.includeSmall
        ? "true"
        : (() => {
            const minUsdParam = idx++;
            params.push(env.walletIntelMinPositionUsd);
            const minSharesParam = idx++;
            params.push(env.walletIntelMinPositionShares);
            return `
              (
                case
                  when ws.size_usd is not null then ws.size_usd >= $${minUsdParam}
                  when ws.shares is not null then ws.shares >= $${minSharesParam}
                  else true
                end
              )
            `;
          })();

      params.push(query.limit + 1, query.offset);
      const limitParam = idx++;
      const offsetParam = idx++;

      const client = await pool.connect();
      try {
        const latestOnly = query.latest ?? true;
        const sql = latestOnly
          ? `
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
                wl.label as user_label,
                wp.profile->>'label_short' as profile_label,
                ws.venue,
                ws.market_id,
                um.title as market_title,
                um.event_id as event_id,
                ue.title as event_title,
                um.status as market_status,
                um.close_time,
                um.expiration_time,
                um.resolved_outcome,
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
              left join wallet_profiles wp on wp.wallet_id = w.id
              left join unified_markets um on um.id = ws.market_id
              left join unified_events ue on ue.id = um.event_id
              where ${positionFilterSql}
              order by
                ws.snapshot_at desc,
                ws.size_usd desc nulls last,
                ws.shares desc nulls last,
                coalesce(um.title, ws.market_id) asc
              limit $${limitParam}
              offset $${offsetParam}
            `
          : `
              select
                ws.wallet_id,
                w.address,
                w.chain,
                w.label,
                wl.label as user_label,
                wp.profile->>'label_short' as profile_label,
                ws.venue,
                ws.market_id,
                um.title as market_title,
                um.event_id as event_id,
                ue.title as event_title,
                um.status as market_status,
                um.close_time,
                um.expiration_time,
                um.resolved_outcome,
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
              left join wallet_profiles wp on wp.wallet_id = w.id
              left join unified_markets um on um.id = ws.market_id
              left join unified_events ue on ue.id = um.event_id
              where ${where}
                and ${positionFilterSql}
              order by
                ws.snapshot_at desc,
                ws.size_usd desc nulls last,
                ws.shares desc nulls last,
                coalesce(um.title, ws.market_id) asc
              limit $${limitParam}
              offset $${offsetParam}
            `;

        const rows = await client.query<{
          wallet_id: string;
          address: string;
          chain: string;
          label: string | null;
          user_label: string | null;
          profile_label: string | null;
          venue: string;
          market_id: string;
          market_title: string | null;
          event_id: string | null;
          event_title: string | null;
          market_status: string | null;
          close_time: Date | null;
          expiration_time: Date | null;
          resolved_outcome: string | null;
          best_bid: string | null;
          best_ask: string | null;
          last_price: string | null;
          outcome_side: string | null;
          shares: string | null;
          size_usd: string | null;
          price: string | null;
          snapshot_at: Date;
          metadata: unknown;
        }>(sql, params);

        const hasMore = rows.rows.length > query.limit;
        const pageRows = hasMore ? rows.rows.slice(0, query.limit) : rows.rows;

        const items = pageRows.map((row) => ({
          walletId: row.wallet_id,
          address: row.address,
          chain: row.chain,
          label: row.label,
          userLabel: row.user_label ?? null,
          profileLabel: row.profile_label,
          venue: row.venue,
          marketId: row.market_id,
          marketTitle: row.market_title,
          eventId: row.event_id,
          eventTitle: row.event_title,
          bestBid: row.best_bid ? Number(row.best_bid) : null,
          bestAsk: row.best_ask ? Number(row.best_ask) : null,
          lastPrice: row.last_price ? Number(row.last_price) : null,
          marketStatus: row.market_status,
          closeTime: row.close_time ? row.close_time.toISOString() : null,
          expirationTime: row.expiration_time
            ? row.expiration_time.toISOString()
            : null,
          resolvedOutcome: row.resolved_outcome,
          outcomeSide: normalizeOutcomeSideForApi(row.outcome_side),
          shares: row.shares ? Number(row.shares) : null,
          sizeUsd: row.size_usd ? Number(row.size_usd) : null,
          price: row.price ? Number(row.price) : null,
          snapshotAt: row.snapshot_at,
          metadata: row.metadata ?? null,
        }));

        return reply.send({
          ok: true,
          items,
          hasMore,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, query },
          "Failed to load wallet positions",
        );
        reply.code(500);
        return reply.send({ error: "Failed to load wallet positions" });
      } finally {
        client.release();
      }
    },
  );
};
