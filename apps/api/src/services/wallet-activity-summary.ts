import type { PoolClient } from "pg";

import { env } from "../env.js";
import { parseMarketOutcomes } from "./wallet-intel-helpers.js";

type WalletActivitySummaryDbRow = {
  wallet_id: string;
  last_activity_at: Date | null;
  net_change_usd: string | null;
  net_change_yes_usd: string | null;
  net_change_no_usd: string | null;
  counts_new: number | null;
  counts_exit: number | null;
  counts_increase: number | null;
  counts_reduce: number | null;
  counts_flip: number | null;
  max_abs_delta_usd_window: string | null;
  baseline_p90_usd: string | null;
  baseline_sample_count: number | null;
  top_changes: unknown;
};

type WalletActivitySummaryStatsDbRow = Omit<
  WalletActivitySummaryDbRow,
  "top_changes"
>;

type WalletActivityTopChangesDbRow = {
  wallet_id: string;
  top_changes: unknown;
};

type WalletActivitySignalSummaryDbRow = {
  wallet_id: string;
  critical_signals_30d: number | null;
  avg_signal_score_30d: string | null;
  has_reactivated_after_idle: boolean | null;
  has_late_entry: boolean | null;
  has_very_late_entry: boolean | null;
  has_unusual_behavior: boolean | null;
};

type WalletActivitySignalRowDbRow = {
  wallet_id: string;
  market_id: string;
  market_title: string | null;
  market_image: string | null;
  market_icon: string | null;
  event_id: string | null;
  event_title: string | null;
  event_image: string | null;
  event_icon: string | null;
  venue: string;
  market_status: string | null;
  close_time: Date | null;
  expiration_time: Date | null;
  resolved_outcome: string | null;
  outcomes: string | null;
  category: string | null;
  change_action: WalletActivityTopChange["action"];
  outcome_side: string | null;
  signed_delta_shares: string | null;
  signed_delta_usd: string | null;
  stake_usd: string | null;
  odds: string | null;
  potential_payout_usd: string | null;
  idle_days: string | null;
  prior_distinct_markets: number | null;
  signal_score: string | null;
  signal_type: WalletActivitySignalType | null;
  late_bucket: WalletActivityLateBucket | null;
  occurred_at: Date;
  reason_codes: string[] | null;
};

type WalletActivitySignalPageLabelDbRow = {
  wallet_id: string;
  venue: string;
  market_id: string;
  outcome_side: string | null;
  unusual_size: boolean;
  on_pattern: boolean;
  has_profile_categories: boolean;
  category: string | null;
};

export type WalletActivitySignalType = "longshot_large" | "longshot_large_late";
export type WalletActivityLateBucket = "late" | "very_late" | "unknown";
export type WalletActivityUnusualTier = "unusual" | "very_unusual" | "extreme";

export type WalletActivityTopChange = {
  marketId: string;
  marketTitle: string | null;
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
  outcomes: string[] | null;
  category: string | null;
  action: "OPENED" | "CLOSED" | "INCREASED" | "REDUCED" | null;
  positionSide: string | null;
  deltaShares: number | null;
  deltaUsd: number | null;
  price: number | null;
  odds: number | null;
  stakeUsd: number | null;
  potentialPayoutUsd: number | null;
  idleDays: number | null;
  priorDistinctMarkets: number | null;
  signalScore: number | null;
  signalLabels: string[];
  signalType: WalletActivitySignalType | null;
  lateBucket: WalletActivityLateBucket | null;
  labels: string[];
  occurredAt: Date;
};

export type WalletActivitySummary = {
  walletId: string;
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
  unusualTier: WalletActivityUnusualTier | null;
  topChanges: WalletActivityTopChange[];
};

export type WalletActivitySummaryStats = Omit<
  WalletActivitySummary,
  "topChanges"
>;

export type WalletActivitySignalSummary = {
  criticalSignals30d: number;
  avgSignalScore30d: number | null;
  hasReactivatedAfterIdle: boolean;
  hasLateEntry: boolean;
  hasVeryLateEntry: boolean;
  hasUnusualBehavior: boolean;
};

export type WalletActivitySignalRow = {
  walletId: string;
  marketId: string;
  marketTitle: string | null;
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
  outcomes: string[] | null;
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
  signalType: WalletActivitySignalType | null;
  lateBucket: WalletActivityLateBucket | null;
  occurredAt: Date;
  reasonCodes: string[];
};

export type WalletActivitySignalPageLabelFlags = {
  unusualSize: boolean;
  onPattern: boolean;
  hasProfileCategories: boolean;
  category: string | null;
};

export type WalletActivitySummarySortMode =
  | "last_activity"
  | "net_change_usd"
  | "unusual_score";

export function compareWalletActivitySummaryStats(
  left: WalletActivitySummaryStats,
  right: WalletActivitySummaryStats,
  sortMode: WalletActivitySummarySortMode,
): number {
  if (sortMode === "net_change_usd") {
    const netDelta = Math.abs(right.netChangeUsd) - Math.abs(left.netChangeUsd);
    if (netDelta !== 0) return netDelta;
    const rightTime = right.lastActivityAt?.getTime() ?? 0;
    const leftTime = left.lastActivityAt?.getTime() ?? 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return left.walletId.localeCompare(right.walletId);
  }

  if (sortMode === "unusual_score") {
    const leftScore = left.unusualScore ?? 0;
    const rightScore = right.unusualScore ?? 0;
    if (rightScore !== leftScore) return rightScore - leftScore;
    const netDelta = Math.abs(right.netChangeUsd) - Math.abs(left.netChangeUsd);
    if (netDelta !== 0) return netDelta;
    const rightTime = right.lastActivityAt?.getTime() ?? 0;
    const leftTime = left.lastActivityAt?.getTime() ?? 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return left.walletId.localeCompare(right.walletId);
  }

  const rightTime = right.lastActivityAt?.getTime() ?? 0;
  const leftTime = left.lastActivityAt?.getTime() ?? 0;
  if (rightTime !== leftTime) return rightTime - leftTime;
  const netDelta = Math.abs(right.netChangeUsd) - Math.abs(left.netChangeUsd);
  if (netDelta !== 0) return netDelta;
  return left.walletId.localeCompare(right.walletId);
}

function mapWalletActivitySignalRow(
  row: WalletActivitySignalRowDbRow,
): WalletActivitySignalRow {
  return {
    walletId: row.wallet_id,
    marketId: row.market_id,
    marketTitle: row.market_title,
    marketImage: row.market_image,
    marketIcon: row.market_icon,
    eventId: row.event_id,
    eventTitle: row.event_title,
    eventImage: row.event_image,
    eventIcon: row.event_icon,
    venue: row.venue,
    marketStatus: row.market_status,
    closeTime: row.close_time,
    expirationTime: row.expiration_time,
    resolvedOutcome: row.resolved_outcome,
    outcomes: parseMarketOutcomes(row.outcomes),
    category: row.category,
    action: row.change_action,
    positionSide: row.outcome_side,
    deltaShares: parseNumber(row.signed_delta_shares),
    deltaUsd: parseNumber(row.signed_delta_usd),
    stakeUsd: parseNumber(row.stake_usd),
    odds: parseNumber(row.odds),
    potentialPayoutUsd: parseNumber(row.potential_payout_usd),
    idleDays: parseNumber(row.idle_days),
    priorDistinctMarkets: row.prior_distinct_markets,
    signalScore: parseNumber(row.signal_score),
    signalType: row.signal_type,
    lateBucket: row.late_bucket,
    occurredAt: row.occurred_at,
    reasonCodes: normalizeStringArray(row.reason_codes),
  };
}

type WalletActivitySignalSeverityThresholds = {
  default: { medium: number; high: number; critical: number };
  polymarket: { medium: number; high: number; critical: number };
  kalshi: { medium: number; high: number; critical: number };
  limitless: { medium: number; high: number; critical: number };
};

type WalletActivityQueryOptions = {
  windowHours: number;
  topChanges: number;
  baselineDays?: number;
  minBaselineSampleCount?: number;
  enteredLateHours?: number;
  signalConfig?: Partial<WalletActivitySignalConfig>;
};

const UNUSUAL_TIER_UNUSUAL_MIN = 2;
const UNUSUAL_TIER_VERY_UNUSUAL_MIN = 5;
const UNUSUAL_TIER_EXTREME_MIN = 10;
export const DEFAULT_MIN_UNUSUAL_BASELINE_SAMPLES = 20;

export function computeRobustUnusualScore(input: {
  maxAbsDeltaUsd: number | null | undefined;
  baselineP90Usd: number | null | undefined;
  baselineSampleCount: number | null | undefined;
  minBaselineSamples?: number;
}): number | null {
  const minBaselineSamples = Math.max(
    1,
    Math.trunc(
      input.minBaselineSamples ?? DEFAULT_MIN_UNUSUAL_BASELINE_SAMPLES,
    ),
  );
  // Null means a legacy baseline row from before sample_count existed; keep it
  // eligible until refresh writes the exact count.
  const sampleCount =
    input.baselineSampleCount == null
      ? minBaselineSamples
      : Math.max(0, Math.trunc(input.baselineSampleCount));
  if (sampleCount < minBaselineSamples) return null;
  const denominator = input.baselineP90Usd ?? 0;
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const numerator = Math.max(0, input.maxAbsDeltaUsd ?? 0);
  if (!Number.isFinite(numerator)) return null;
  const score = numerator / denominator;
  return Number.isFinite(score) ? score : null;
}

export function resolveUnusualTier(
  score: number | null | undefined,
): WalletActivityUnusualTier | null {
  if (
    score == null ||
    !Number.isFinite(score) ||
    score < UNUSUAL_TIER_UNUSUAL_MIN
  ) {
    return null;
  }
  if (score >= UNUSUAL_TIER_EXTREME_MIN) return "extreme";
  if (score >= UNUSUAL_TIER_VERY_UNUSUAL_MIN) return "very_unusual";
  return "unusual";
}

type WalletActivitySignalConfig = {
  maxOdds: number;
  minStakeUsd: number;
  minPayoutUsd: number;
  minIdleDays: number;
  maxPriorMarkets: number;
  lateHours: number;
  veryLateHours: number;
  retentionDaysActivity: number;
  weightStake: number;
  weightOdds: number;
  weightIdle: number;
  weightNovelty: number;
  weightSum: number;
  minScore: number;
};

function parseNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNonNullNumber(value: string | number | null | undefined): number {
  const parsed = parseNumber(value);
  return parsed ?? 0;
}

function resolveSignalConfig(
  overrides?: Partial<WalletActivitySignalConfig>,
): WalletActivitySignalConfig {
  const retentionDaysActivity = Math.max(
    0,
    Math.trunc(
      overrides?.retentionDaysActivity ?? env.walletIntelRetentionDaysActivity,
    ),
  );
  const configuredMinIdleDays = Math.max(
    0,
    Math.trunc(overrides?.minIdleDays ?? env.walletIntelSignalMinIdleDays),
  );
  const minIdleDays =
    retentionDaysActivity > 0
      ? Math.min(configuredMinIdleDays, retentionDaysActivity)
      : configuredMinIdleDays;
  const veryLateHours = Math.max(
    1,
    Math.trunc(overrides?.veryLateHours ?? env.walletIntelSignalVeryLateHours),
  );
  const lateHours = Math.max(
    veryLateHours,
    Math.trunc(overrides?.lateHours ?? env.walletIntelSignalLateHours),
  );
  const weightStake = Math.max(
    0,
    overrides?.weightStake ?? env.walletIntelSignalWeightStake,
  );
  const weightOdds = Math.max(
    0,
    overrides?.weightOdds ?? env.walletIntelSignalWeightOdds,
  );
  const weightIdle = Math.max(
    0,
    overrides?.weightIdle ?? env.walletIntelSignalWeightIdle,
  );
  const weightNovelty = Math.max(
    0,
    overrides?.weightNovelty ?? env.walletIntelSignalWeightNovelty,
  );
  return {
    maxOdds: Math.max(0, overrides?.maxOdds ?? env.walletIntelSignalMaxOdds),
    minStakeUsd: Math.max(
      0,
      overrides?.minStakeUsd ?? env.walletIntelSignalMinStakeUsd,
    ),
    minPayoutUsd: Math.max(
      0,
      overrides?.minPayoutUsd ?? env.walletIntelSignalMinPayoutUsd,
    ),
    minIdleDays,
    maxPriorMarkets: Math.max(
      0,
      Math.trunc(
        overrides?.maxPriorMarkets ?? env.walletIntelSignalMaxPriorMarkets,
      ),
    ),
    lateHours,
    veryLateHours,
    retentionDaysActivity,
    weightStake,
    weightOdds,
    weightIdle,
    weightNovelty,
    weightSum: weightStake + weightOdds + weightIdle + weightNovelty,
    minScore: Math.max(0, overrides?.minScore ?? env.walletIntelSignalMinScore),
  };
}

function parseTopChanges(raw: unknown): WalletActivityTopChange[] {
  if (!Array.isArray(raw)) return [];
  const items: WalletActivityTopChange[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const occurredAtRaw = record.occurredAt;
    const occurredAt =
      occurredAtRaw instanceof Date
        ? occurredAtRaw
        : new Date(String(occurredAtRaw));
    if (!Number.isFinite(occurredAt.getTime())) continue;
    items.push({
      marketId: String(record.marketId ?? ""),
      marketTitle:
        record.marketTitle == null ? null : String(record.marketTitle ?? ""),
      marketImage:
        record.marketImage == null ? null : String(record.marketImage),
      marketIcon: record.marketIcon == null ? null : String(record.marketIcon),
      eventId: record.eventId == null ? null : String(record.eventId),
      eventTitle: record.eventTitle == null ? null : String(record.eventTitle),
      eventImage: record.eventImage == null ? null : String(record.eventImage),
      eventIcon: record.eventIcon == null ? null : String(record.eventIcon),
      venue: String(record.venue ?? ""),
      marketStatus:
        record.marketStatus == null ? null : String(record.marketStatus),
      closeTime:
        record.closeTime == null ? null : new Date(String(record.closeTime)),
      expirationTime:
        record.expirationTime == null
          ? null
          : new Date(String(record.expirationTime)),
      resolvedOutcome:
        record.resolvedOutcome == null ? null : String(record.resolvedOutcome),
      outcomes: parseMarketOutcomes(record.outcomes),
      category: record.category == null ? null : String(record.category),
      action:
        record.action == null
          ? null
          : (String(record.action) as WalletActivityTopChange["action"]),
      positionSide:
        record.positionSide == null ? null : String(record.positionSide),
      deltaShares: parseNumber(record.deltaShares as string | number | null),
      deltaUsd: parseNumber(record.deltaUsd as string | number | null),
      price: parseNumber(record.price as string | number | null),
      odds: parseNumber(record.odds as string | number | null),
      stakeUsd: parseNumber(record.stakeUsd as string | number | null),
      potentialPayoutUsd: parseNumber(
        record.potentialPayoutUsd as string | number | null,
      ),
      idleDays: parseNumber(record.idleDays as string | number | null),
      priorDistinctMarkets: parseNumber(
        record.priorDistinctMarkets as string | number | null,
      ),
      signalScore: parseNumber(record.signalScore as string | number | null),
      signalLabels: Array.isArray(record.signalLabels)
        ? record.signalLabels.map((label) => String(label))
        : [],
      signalType:
        record.signalType == null
          ? null
          : (String(record.signalType) as WalletActivitySignalType),
      lateBucket:
        record.lateBucket == null
          ? null
          : (String(record.lateBucket) as WalletActivityLateBucket),
      labels: Array.isArray(record.labels)
        ? record.labels.map((label) => String(label))
        : [],
      occurredAt,
    });
  }
  return items.filter((item) => item.marketId);
}

function normalizeStringArray(raw: string[] | null | undefined): string[] {
  if (!raw || raw.length === 0) return [];
  return raw.map((value) => String(value)).filter(Boolean);
}

function parseSummaryStatsRow(
  row: WalletActivitySummaryStatsDbRow,
  windowHours: number,
  minBaselineSampleCount: number,
): WalletActivitySummaryStats {
  const unusualScore = computeRobustUnusualScore({
    maxAbsDeltaUsd: parseNumber(row.max_abs_delta_usd_window),
    baselineP90Usd: parseNumber(row.baseline_p90_usd),
    baselineSampleCount: row.baseline_sample_count,
    minBaselineSamples: minBaselineSampleCount,
  });
  return {
    walletId: row.wallet_id,
    windowHours,
    lastActivityAt: row.last_activity_at,
    netChangeUsd: toNonNullNumber(row.net_change_usd),
    netChangeYesUsd: toNonNullNumber(row.net_change_yes_usd),
    netChangeNoUsd: toNonNullNumber(row.net_change_no_usd),
    countsNew: row.counts_new ?? 0,
    countsExit: row.counts_exit ?? 0,
    countsIncrease: row.counts_increase ?? 0,
    countsReduce: row.counts_reduce ?? 0,
    countsFlip: row.counts_flip ?? 0,
    unusualScore,
    unusualTier: resolveUnusualTier(unusualScore),
  };
}

function resolveWalletActivityQuery(input: WalletActivityQueryOptions): {
  windowHours: number;
  topChanges: number;
  baselineDays: number;
  minBaselineSampleCount: number;
  signalConfig: WalletActivitySignalConfig;
} {
  return {
    windowHours: Math.max(1, Math.trunc(input.windowHours)),
    topChanges: Math.max(1, Math.trunc(input.topChanges)),
    baselineDays: Math.max(7, Math.trunc(input.baselineDays ?? 30)),
    minBaselineSampleCount: Math.max(
      1,
      Math.trunc(
        input.minBaselineSampleCount ?? DEFAULT_MIN_UNUSUAL_BASELINE_SAMPLES,
      ),
    ),
    signalConfig: resolveSignalConfig(input.signalConfig),
  };
}

function buildWalletActivityParams(
  walletIds: string[],
  options: ReturnType<typeof resolveWalletActivityQuery>,
): unknown[] {
  return [
    walletIds,
    options.windowHours,
    options.baselineDays,
    options.topChanges,
    options.signalConfig.maxOdds,
    options.signalConfig.minStakeUsd,
    options.signalConfig.minPayoutUsd,
    options.signalConfig.maxPriorMarkets,
    options.signalConfig.lateHours,
    options.signalConfig.veryLateHours,
    options.signalConfig.retentionDaysActivity,
    options.signalConfig.minIdleDays,
    options.signalConfig.weightStake,
    options.signalConfig.weightOdds,
    options.signalConfig.weightIdle,
    options.signalConfig.weightNovelty,
    options.signalConfig.weightSum,
    options.signalConfig.minScore,
    options.minBaselineSampleCount,
  ];
}

function buildWalletActivitySummaryStatsParams(
  walletIds: string[],
  options: ReturnType<typeof resolveWalletActivityQuery>,
): unknown[] {
  return [walletIds, options.windowHours, options.baselineDays];
}

const FETCH_WALLET_ACTIVITY_BASE_SQL = `
  with wallet_set as (
    select unnest($1::uuid[]) as wallet_id
  ),
  window_start as (
    select now() - ($2::text || ' hours')::interval as ts
  ),
  history as (
    with history_events as (
      select
        wah.wallet_id,
        wah.market_id,
        max(wah.last_occurred_at) as last_prior_activity_at
      from wallet_activity_hourly wah
      join wallet_set ws on ws.wallet_id = wah.wallet_id
      where wah.activity_type in ('delta', 'trade')
        and wah.last_occurred_at < (select ts from window_start)
        and (
          $11::int = 0
          or wah.last_occurred_at >= now() - ($11::text || ' days')::interval
        )
      group by wah.wallet_id, wah.market_id
    )
    select
      ws.wallet_id,
      count(he.market_id)::int as prior_distinct_markets,
      max(he.last_prior_activity_at) as last_prior_activity_at
    from wallet_set ws
    left join history_events he on he.wallet_id = ws.wallet_id
    group by ws.wallet_id
  ),
  profiles as (
    select
      wp.wallet_id,
      array(
        select lower(value)
        from jsonb_array_elements_text(
          coalesce(wp.profile->'categories', '[]'::jsonb)
        ) value
      ) as categories
    from wallet_profiles wp
    join wallet_set ws on ws.wallet_id = wp.wallet_id
  ),
  baseline as (
    select
      wb.wallet_id,
      wb.p90_usd,
      nullif(to_jsonb(wb)->>'sample_count', '')::int as baseline_sample_count
    from wallet_activity_baseline wb
    join wallet_set ws on ws.wallet_id = wb.wallet_id
    where wb.window_days = $3::int
  ),
  events_window as (
    select
      wah.wallet_id,
      wah.venue,
      wah.market_id,
      nullif(wah.outcome_side, '') as outcome_side,
      sum(coalesce(wah.signed_delta_shares, 0)) as signed_delta_shares,
      sum(coalesce(wah.signed_delta_usd, 0)) as signed_delta_usd,
      sum(coalesce(wah.abs_delta_usd, 0)) as gross_abs_delta_usd,
      max(coalesce(wah.max_abs_delta_usd, 0)) as max_abs_delta_usd,
      max(wah.last_occurred_at) as last_occurred_at,
      (array_agg(wah.last_price order by wah.last_occurred_at desc))[1] as last_price,
      (array_agg(wah.last_change_action order by wah.last_occurred_at desc))[1] as change_action,
      bool_or(wah.entered_late) as entered_late,
      sum(coalesce(wah.counts_opened, 0)) as counts_opened,
      sum(coalesce(wah.counts_closed, 0)) as counts_closed,
      sum(coalesce(wah.counts_increased, 0)) as counts_increased,
      sum(coalesce(wah.counts_reduced, 0)) as counts_reduced
    from wallet_activity_hourly wah
    join wallet_set ws on ws.wallet_id = wah.wallet_id
    where wah.activity_type in ('delta', 'trade')
      and wah.hour_bucket >= now() - ($2::text || ' hours')::interval
    group by wah.wallet_id, wah.venue, wah.market_id, wah.outcome_side
  ),
  enriched as (
    select
      ew.*,
      um.title as market_title,
      um.image as market_image,
      um.icon as market_icon,
      um.event_id,
      ue.title as event_title,
      ue.image as event_image,
      ue.icon as event_icon,
      um.status as market_status,
      um.close_time,
      um.expiration_time,
      um.resolved_outcome,
      um.outcomes,
      lower(coalesce(um.category, ue.category)) as category,
      um.best_bid,
      um.best_ask,
      um.last_price as market_last_price
    from events_window ew
    left join unified_markets um on um.id = ew.market_id
    left join unified_events ue on ue.id = um.event_id
  ),
  change_rows as (
    select
      e.*,
      b.p90_usd,
      b.baseline_sample_count,
      h.prior_distinct_markets,
      h.last_prior_activity_at,
      p.categories as profile_categories,
      case
        when coalesce(b.baseline_sample_count, $19::int) >= $19::int
         and b.p90_usd is not null
         and b.p90_usd > 0
         and coalesce(e.max_abs_delta_usd, 0) >= b.p90_usd
          then true
        else false
      end as unusual_size,
      case
        when p.categories is not null
         and e.category is not null
         and e.category = any(p.categories)
          then true
        else false
      end as on_pattern,
      case
        when p.categories is not null then true
        else false
      end as has_profile_categories
    from enriched e
    left join baseline b on b.wallet_id = e.wallet_id
    left join history h on h.wallet_id = e.wallet_id
    left join profiles p on p.wallet_id = e.wallet_id
  )
`;

const FETCH_WALLET_ACTIVITY_RANKED_CLASSIFIED_SQL = `,
  ranked_changes as (
    select
      cr.wallet_id,
      cr.venue,
      cr.market_id,
      cr.outcome_side,
      cr.market_title,
      cr.market_image,
      cr.market_icon,
      cr.event_id,
      cr.event_title,
      cr.event_image,
      cr.event_icon,
      cr.market_status,
      cr.close_time,
      cr.expiration_time,
      cr.resolved_outcome,
      cr.outcomes,
      cr.category,
      cr.signed_delta_shares,
      cr.signed_delta_usd,
      cr.gross_abs_delta_usd,
      cr.entered_late,
      cr.unusual_size,
      cr.on_pattern,
      cr.change_action,
      cr.last_price as price,
      case
        when cr.last_price is not null then cr.last_price
        when upper(coalesce(cr.outcome_side, '')) = 'NO'
          and cr.market_last_price is not null
          then 1 - cr.market_last_price
        else cr.market_last_price
      end as odds,
      cr.last_occurred_at as occurred_at,
      cr.has_profile_categories,
      cr.prior_distinct_markets,
      cr.last_prior_activity_at,
      coalesce(cr.gross_abs_delta_usd, abs(cr.signed_delta_usd), 0) as stake_usd,
      case
        when cr.last_prior_activity_at is not null
          and cr.last_occurred_at is not null
          then greatest(
            extract(epoch from (cr.last_occurred_at - cr.last_prior_activity_at))
            / 86400.0,
            0
          )
        else null
      end as idle_days,
      row_number() over (
        partition by cr.wallet_id
        order by cr.gross_abs_delta_usd desc nulls last, cr.last_occurred_at desc nulls last
      ) as rn
    from change_rows cr
  ),
  scored_changes as (
    select
      rc.*,
      case
        when rc.odds is not null and rc.odds > 0
          then rc.stake_usd / rc.odds
        else null
      end as potential_payout_usd,
      case
        when coalesce(rc.close_time, rc.expiration_time) is null then 'unknown'
        when rc.occurred_at is null then 'unknown'
        when coalesce(rc.close_time, rc.expiration_time) <= rc.occurred_at
          then 'unknown'
        when extract(
          epoch from (coalesce(rc.close_time, rc.expiration_time) - rc.occurred_at)
        ) / 3600.0 <= $10::numeric then 'very_late'
        when extract(
          epoch from (coalesce(rc.close_time, rc.expiration_time) - rc.occurred_at)
        ) / 3600.0 <= $9::numeric then 'late'
        else null
      end as late_bucket,
      (
        (
          $13::numeric * (
            case
              when $6::numeric <= 0 then 0
              else least(coalesce(rc.stake_usd, 0) / $6::numeric, 1)
            end
          )
        )
        + (
          $14::numeric * (
            case
              when rc.odds is null or $5::numeric <= 0 then 0
              else greatest(0, least(1, ($5::numeric - rc.odds) / $5::numeric))
            end
          )
        )
        + (
          $15::numeric * (
            case
              when $12::numeric <= 0 then 0
              else least(coalesce(rc.idle_days, 0) / $12::numeric, 1)
            end
          )
        )
        + (
          $16::numeric * (
            case
              when coalesce(rc.prior_distinct_markets, 0) <= $8::int then 1
              else greatest(
                0,
                1 - (
                  (coalesce(rc.prior_distinct_markets, 0) - $8::int)::numeric
                  / greatest($8::numeric + 1, 1)
                )
              )
            end
          )
        )
      ) / greatest($17::numeric, 0.0001) as signal_score
    from ranked_changes rc
  ),
  classified_changes as (
    select
      sc.*,
      case
        when sc.odds is not null
         and sc.odds <= $5::numeric
         and coalesce(sc.stake_usd, 0) >= $6::numeric
         and ($7::numeric <= 0 or coalesce(sc.potential_payout_usd, 0) >= $7::numeric)
         and coalesce(sc.idle_days, 0) >= $12::numeric
         and coalesce(sc.prior_distinct_markets, 0) <= $8::int
         and sc.signal_score >= $18::numeric
          then true
        else false
      end as is_high_risk,
      case
        when sc.odds is not null
         and sc.odds <= $5::numeric
         and coalesce(sc.stake_usd, 0) >= $6::numeric
         and ($7::numeric <= 0 or coalesce(sc.potential_payout_usd, 0) >= $7::numeric)
         and sc.signal_score >= $18::numeric
          then case
            when sc.late_bucket in ('late', 'very_late')
              then 'longshot_large_late'
            else 'longshot_large'
          end
        else null
      end as signal_type
    from scored_changes sc
  )
`;

const FETCH_WALLET_ACTIVITY_TOP_CHANGES_CTE_SQL = `,
  top_changes as (
    select
      cc.wallet_id,
      jsonb_agg(
        jsonb_build_object(
          'marketId', cc.market_id,
          'marketTitle', cc.market_title,
          'marketImage', cc.market_image,
          'marketIcon', cc.market_icon,
          'eventId', cc.event_id,
          'eventTitle', cc.event_title,
          'eventImage', cc.event_image,
          'eventIcon', cc.event_icon,
          'venue', cc.venue,
          'marketStatus', cc.market_status,
          'closeTime', cc.close_time,
          'expirationTime', cc.expiration_time,
          'resolvedOutcome', cc.resolved_outcome,
          'outcomes', case when cc.outcomes is not null then cc.outcomes::jsonb else null end,
          'category', cc.category,
          'action', cc.change_action,
          'positionSide', cc.outcome_side,
          'deltaShares', cc.signed_delta_shares,
          'deltaUsd', cc.signed_delta_usd,
          'price', cc.price,
          'odds', cc.odds,
          'stakeUsd', cc.stake_usd,
          'potentialPayoutUsd', cc.potential_payout_usd,
          'idleDays', cc.idle_days,
          'priorDistinctMarkets', cc.prior_distinct_markets,
          'signalScore', cc.signal_score,
          'signalType', cc.signal_type,
          'lateBucket', cc.late_bucket,
          'signalLabels', array_remove(array[
            case
              when cc.odds is not null and cc.odds <= least($5::numeric, 0.10::numeric)
                then 'longshot_odds'
              when cc.odds is not null and cc.odds <= $5::numeric
                then 'low_odds'
            end,
            case when coalesce(cc.stake_usd, 0) >= $6::numeric then 'high_notional' end,
            case when coalesce(cc.idle_days, 0) >= $12::numeric then 'reactivated_after_idle' end,
            case when coalesce(cc.prior_distinct_markets, 0) <= $8::int then 'narrow_history' end,
            case when cc.is_high_risk then 'high_risk_longshot' end
          ], null),
          'labels', array_remove(array[
            case when cc.entered_late then 'entered_late' end,
            case when cc.unusual_size then 'unusual_size' end,
            case when cc.on_pattern then 'on_pattern' end,
            case
              when cc.has_profile_categories
               and coalesce(cc.on_pattern, false) = false
               and cc.category is not null
                then 'out_of_pattern'
            end,
            case
              when cc.odds is not null and cc.odds <= least($5::numeric, 0.10::numeric)
                then 'longshot_odds'
              when cc.odds is not null and cc.odds <= $5::numeric
                then 'low_odds'
            end,
            case when coalesce(cc.stake_usd, 0) >= $6::numeric then 'high_notional' end,
            case when coalesce(cc.idle_days, 0) >= $12::numeric then 'reactivated_after_idle' end,
            case when coalesce(cc.prior_distinct_markets, 0) <= $8::int then 'narrow_history' end,
            case when cc.is_high_risk then 'high_risk_longshot' end
          ], null),
          'occurredAt', cc.occurred_at
        )
        order by cc.gross_abs_delta_usd desc nulls last, cc.occurred_at desc nulls last
      ) filter (where cc.rn <= $4) as top_changes
    from classified_changes cc
    group by cc.wallet_id
  )
`;

const FETCH_WALLET_ACTIVITY_SUMMARY_CTE_SQL = `,
  summary as (
    select
      cr.wallet_id,
      max(cr.last_occurred_at) as last_activity_at,
      sum(cr.signed_delta_usd) as net_change_usd,
      sum(case when upper(coalesce(cr.outcome_side, '')) = 'YES' then cr.signed_delta_usd else 0 end) as net_change_yes_usd,
      sum(case when upper(coalesce(cr.outcome_side, '')) = 'NO' then cr.signed_delta_usd else 0 end) as net_change_no_usd,
      sum(cr.counts_opened)::int as counts_new,
      sum(cr.counts_closed)::int as counts_exit,
      sum(cr.counts_increased)::int as counts_increase,
      sum(cr.counts_reduced)::int as counts_reduce,
      0::int as counts_flip,
      max(coalesce(cr.max_abs_delta_usd, 0)) as max_abs_delta_usd_window,
      max(cr.p90_usd) as baseline_p90_usd,
      max(cr.baseline_sample_count)::int as baseline_sample_count
    from change_rows cr
    group by cr.wallet_id
  )
`;

const FETCH_WALLET_ACTIVITY_SUMMARIES_SQL = `
${FETCH_WALLET_ACTIVITY_BASE_SQL}
${FETCH_WALLET_ACTIVITY_RANKED_CLASSIFIED_SQL}
${FETCH_WALLET_ACTIVITY_TOP_CHANGES_CTE_SQL}
${FETCH_WALLET_ACTIVITY_SUMMARY_CTE_SQL}
  select
    s.wallet_id,
    s.last_activity_at,
    s.net_change_usd,
    s.net_change_yes_usd,
    s.net_change_no_usd,
    s.counts_new,
    s.counts_exit,
    s.counts_increase,
    s.counts_reduce,
    s.counts_flip,
    s.max_abs_delta_usd_window,
    s.baseline_p90_usd,
    s.baseline_sample_count,
    tc.top_changes
  from summary s
  left join top_changes tc on tc.wallet_id = s.wallet_id
`;

const FETCH_WALLET_ACTIVITY_SUMMARY_STATS_SQL = `
  with wallet_set as (
    select unnest($1::uuid[]) as wallet_id
  ),
  baseline as (
    select
      wb.wallet_id,
      wb.p90_usd,
      nullif(to_jsonb(wb)->>'sample_count', '')::int as baseline_sample_count
    from wallet_activity_baseline wb
    join wallet_set ws on ws.wallet_id = wb.wallet_id
    where wb.window_days = $3::int
  ),
  summary as (
    select
      wah.wallet_id,
      max(wah.last_occurred_at) as last_activity_at,
      sum(coalesce(wah.signed_delta_usd, 0)) as net_change_usd,
      sum(
        case
          when upper(coalesce(wah.outcome_side, '')) = 'YES'
            then coalesce(wah.signed_delta_usd, 0)
          else 0
        end
      ) as net_change_yes_usd,
      sum(
        case
          when upper(coalesce(wah.outcome_side, '')) = 'NO'
            then coalesce(wah.signed_delta_usd, 0)
          else 0
        end
      ) as net_change_no_usd,
      sum(coalesce(wah.counts_opened, 0))::int as counts_new,
      sum(coalesce(wah.counts_closed, 0))::int as counts_exit,
      sum(coalesce(wah.counts_increased, 0))::int as counts_increase,
      sum(coalesce(wah.counts_reduced, 0))::int as counts_reduce,
      0::int as counts_flip,
      max(coalesce(wah.max_abs_delta_usd, 0)) as max_abs_delta_usd_window
    from wallet_activity_hourly wah
    join wallet_set ws on ws.wallet_id = wah.wallet_id
    where wah.activity_type in ('delta', 'trade')
      and wah.hour_bucket >= now() - ($2::text || ' hours')::interval
    group by wah.wallet_id
  )
  select
    s.wallet_id,
    s.last_activity_at,
    s.net_change_usd,
    s.net_change_yes_usd,
    s.net_change_no_usd,
    s.counts_new,
    s.counts_exit,
    s.counts_increase,
    s.counts_reduce,
    s.counts_flip,
    s.max_abs_delta_usd_window,
    b.p90_usd as baseline_p90_usd,
    b.baseline_sample_count::int as baseline_sample_count
  from summary s
  left join baseline b on b.wallet_id = s.wallet_id
`;

const FETCH_WALLET_ACTIVITY_SUMMARY_TOP_CHANGES_SQL = `
${FETCH_WALLET_ACTIVITY_BASE_SQL}
${FETCH_WALLET_ACTIVITY_RANKED_CLASSIFIED_SQL}
${FETCH_WALLET_ACTIVITY_TOP_CHANGES_CTE_SQL}
  select
    tc.wallet_id,
    tc.top_changes
  from top_changes tc
`;

const FETCH_WALLET_ACTIVITY_SIGNAL_SUMMARY_SQL = `
${FETCH_WALLET_ACTIVITY_BASE_SQL}
${FETCH_WALLET_ACTIVITY_RANKED_CLASSIFIED_SQL}
  select
    cc.wallet_id,
    count(*) filter (
      where cc.rn <= $4 and cc.signal_score >= 0.9
    )::int as critical_signals_30d,
    avg(cc.signal_score) filter (
      where cc.rn <= $4
    )::text as avg_signal_score_30d,
    bool_or(
      coalesce(cc.idle_days, 0) >= $12::numeric
    ) filter (
      where cc.rn <= $4
    ) as has_reactivated_after_idle,
    bool_or(
      cc.entered_late or cc.late_bucket in ('late', 'very_late')
    ) filter (
      where cc.rn <= $4
    ) as has_late_entry,
    bool_or(
      cc.late_bucket = 'very_late'
    ) filter (
      where cc.rn <= $4
    ) as has_very_late_entry,
    bool_or(
      cc.unusual_size
      or (
        cc.has_profile_categories
        and coalesce(cc.on_pattern, false) = false
        and cc.category is not null
      )
      or cc.is_high_risk
    ) filter (
      where cc.rn <= $4
    ) as has_unusual_behavior
  from classified_changes cc
  group by cc.wallet_id
`;

const FETCH_WALLET_ACTIVITY_SIGNAL_ROWS_SQL = `
${FETCH_WALLET_ACTIVITY_BASE_SQL}
,
  signal_param_hints as (
    select $4::int as top_changes_hint
  )
${FETCH_WALLET_ACTIVITY_RANKED_CLASSIFIED_SQL}
,
  signal_rows as (
    select
      sc.wallet_id,
      sc.market_id,
      sc.market_title,
      sc.market_image,
      sc.market_icon,
      sc.event_id,
      sc.event_title,
      sc.event_image,
      sc.event_icon,
      sc.venue,
      sc.market_status,
      sc.close_time,
      sc.expiration_time,
      sc.resolved_outcome,
      sc.outcomes,
      sc.category,
      sc.change_action,
      sc.outcome_side,
      sc.signed_delta_shares,
      sc.signed_delta_usd,
      sc.stake_usd,
      sc.odds,
      sc.potential_payout_usd,
      sc.idle_days,
      sc.prior_distinct_markets,
      sc.signal_score,
      sc.signal_type,
      sc.late_bucket,
      sc.occurred_at,
      array_remove(array[
        case
          when sc.odds is not null and sc.odds <= least($5::numeric, 0.10::numeric)
            then 'longshot_odds'
          when sc.odds is not null and sc.odds <= $5::numeric
            then 'low_odds'
        end,
        case when coalesce(sc.stake_usd, 0) >= $6::numeric then 'high_notional' end,
        case when coalesce(sc.idle_days, 0) >= $12::numeric then 'reactivated_after_idle' end,
        case when coalesce(sc.prior_distinct_markets, 0) <= $8::int then 'narrow_history' end,
        case when sc.entered_late then 'late_entry' end,
        case when sc.unusual_size then 'unusual_size' end,
        case when sc.on_pattern then 'on_pattern' end,
        case
          when sc.has_profile_categories
           and coalesce(sc.on_pattern, false) = false
           and sc.category is not null
            then 'out_of_pattern'
        end,
        case
          when sc.odds is not null
           and sc.odds <= $5::numeric
           and coalesce(sc.stake_usd, 0) >= $6::numeric
           and ($7::numeric <= 0 or coalesce(sc.potential_payout_usd, 0) >= $7::numeric)
           and coalesce(sc.idle_days, 0) >= $12::numeric
           and coalesce(sc.prior_distinct_markets, 0) <= $8::int
           and sc.signal_score >= $18::numeric
            then 'high_risk_longshot'
        end
      ], null) as reason_codes
    from classified_changes sc
    where sc.signal_type is not null
      and sc.change_action in ('OPENED', 'INCREASED')
      and upper(coalesce(sc.market_status::text, '')) = 'ACTIVE'
      and nullif(btrim(coalesce(sc.resolved_outcome, '')), '') is null
      and coalesce(sc.close_time, sc.expiration_time) is not null
      and coalesce(sc.close_time, sc.expiration_time) > now()
      and ($20::text is null or sc.signal_type = $20::text)
      and ($21::text is null or sc.late_bucket = $21::text)
  )
  select
    sr.wallet_id,
    sr.market_id,
    sr.market_title,
    sr.market_image,
    sr.market_icon,
    sr.event_id,
    sr.event_title,
    sr.event_image,
    sr.event_icon,
    sr.venue,
    sr.market_status,
    sr.close_time,
    sr.expiration_time,
    sr.resolved_outcome,
    sr.outcomes,
    sr.category,
    sr.change_action,
    sr.outcome_side,
    sr.signed_delta_shares,
    sr.signed_delta_usd,
    sr.stake_usd,
    sr.odds,
    sr.potential_payout_usd,
    sr.idle_days,
    sr.prior_distinct_markets,
    sr.signal_score,
    sr.signal_type,
    sr.late_bucket,
    sr.occurred_at,
    sr.reason_codes
  from signal_rows sr
  where (
      $22::text[] is null
      or (
        lower($23::text) = 'all'
        and sr.reason_codes @> $22::text[]
      )
      or (
        lower($23::text) <> 'all'
        and sr.reason_codes && $22::text[]
      )
    )
  order by sr.signal_score desc nulls last, sr.close_time asc nulls last, sr.market_id, sr.wallet_id
  limit $24
  offset $25
`;

const FETCH_WALLET_ACTIVITY_SIGNAL_ROWS_FAST_SQL = `
  with wallet_set as (
    select unnest($1::uuid[]) as wallet_id
  ),
  window_start as (
    select now() - ($2::text || ' hours')::interval as ts
  ),
  signal_param_hints as (
    select
      $3::int as baseline_days_hint,
      $4::int as top_changes_hint,
      $19::int as min_baseline_sample_count_hint
  ),
  history as (
    with history_events as (
      select
        wah.wallet_id,
        wah.market_id,
        max(wah.last_occurred_at) as last_prior_activity_at
      from wallet_activity_hourly wah
      join wallet_set ws on ws.wallet_id = wah.wallet_id
      where wah.activity_type in ('delta', 'trade')
        and wah.last_occurred_at < (select ts from window_start)
        and (
          $11::int = 0
          or wah.last_occurred_at >= now() - ($11::text || ' days')::interval
        )
      group by wah.wallet_id, wah.market_id
    )
    select
      ws.wallet_id,
      count(he.market_id)::int as prior_distinct_markets,
      max(he.last_prior_activity_at) as last_prior_activity_at
    from wallet_set ws
    left join history_events he on he.wallet_id = ws.wallet_id
    group by ws.wallet_id
  ),
  events_window as (
    select
      wah.wallet_id,
      wah.venue,
      wah.market_id,
      nullif(wah.outcome_side, '') as outcome_side,
      sum(coalesce(wah.signed_delta_shares, 0)) as signed_delta_shares,
      sum(coalesce(wah.signed_delta_usd, 0)) as signed_delta_usd,
      sum(coalesce(wah.abs_delta_usd, 0)) as gross_abs_delta_usd,
      max(wah.last_occurred_at) as last_occurred_at,
      (array_agg(wah.last_price order by wah.last_occurred_at desc))[1] as last_price,
      (array_agg(wah.last_change_action order by wah.last_occurred_at desc))[1] as change_action,
      bool_or(wah.entered_late) as entered_late
    from wallet_activity_hourly wah
    join wallet_set ws on ws.wallet_id = wah.wallet_id
    where wah.activity_type in ('delta', 'trade')
      and wah.hour_bucket >= now() - ($2::text || ' hours')::interval
    group by wah.wallet_id, wah.venue, wah.market_id, wah.outcome_side
  ),
  enriched as (
    select
      ew.*,
      h.prior_distinct_markets,
      h.last_prior_activity_at,
      um.title as market_title,
      um.image as market_image,
      um.icon as market_icon,
      um.event_id,
      ue.title as event_title,
      ue.image as event_image,
      ue.icon as event_icon,
      um.status as market_status,
      um.close_time,
      um.expiration_time,
      um.resolved_outcome,
      um.outcomes,
      lower(coalesce(um.category, ue.category)) as category,
      um.last_price as market_last_price
    from events_window ew
    left join history h on h.wallet_id = ew.wallet_id
    left join unified_markets um on um.id = ew.market_id
    left join unified_events ue on ue.id = um.event_id
  ),
  scored_rows as (
    select
      e.wallet_id,
      e.market_id,
      e.market_title,
      e.market_image,
      e.market_icon,
      e.event_id,
      e.event_title,
      e.event_image,
      e.event_icon,
      e.venue,
      e.market_status,
      e.close_time,
      e.expiration_time,
      e.resolved_outcome,
      e.outcomes,
      e.category,
      e.change_action,
      e.outcome_side,
      e.signed_delta_shares,
      e.signed_delta_usd,
      coalesce(e.gross_abs_delta_usd, abs(e.signed_delta_usd), 0) as stake_usd,
      case
        when e.last_price is not null then e.last_price
        when upper(coalesce(e.outcome_side, '')) = 'NO'
          and e.market_last_price is not null
          then 1 - e.market_last_price
        else e.market_last_price
      end as odds,
      case
        when
          case
            when e.last_price is not null then e.last_price
            when upper(coalesce(e.outcome_side, '')) = 'NO'
              and e.market_last_price is not null
              then 1 - e.market_last_price
            else e.market_last_price
          end > 0
          then coalesce(e.gross_abs_delta_usd, abs(e.signed_delta_usd), 0)
            / (
              case
                when e.last_price is not null then e.last_price
                when upper(coalesce(e.outcome_side, '')) = 'NO'
                  and e.market_last_price is not null
                  then 1 - e.market_last_price
                else e.market_last_price
              end
            )
        else null
      end as potential_payout_usd,
      case
        when e.last_prior_activity_at is not null
          and e.last_occurred_at is not null
          then greatest(
            extract(epoch from (e.last_occurred_at - e.last_prior_activity_at))
            / 86400.0,
            0
          )
        else null
      end as idle_days,
      e.prior_distinct_markets,
      case
        when coalesce(e.close_time, e.expiration_time) is null then 'unknown'
        when e.last_occurred_at is null then 'unknown'
        when coalesce(e.close_time, e.expiration_time) <= e.last_occurred_at
          then 'unknown'
        when extract(
          epoch from (coalesce(e.close_time, e.expiration_time) - e.last_occurred_at)
        ) / 3600.0 <= $10::numeric then 'very_late'
        when extract(
          epoch from (coalesce(e.close_time, e.expiration_time) - e.last_occurred_at)
        ) / 3600.0 <= $9::numeric then 'late'
        else null
      end as late_bucket,
      e.last_occurred_at as occurred_at,
      e.entered_late,
      (
        (
          $13::numeric * (
            case
              when $6::numeric <= 0 then 0
              else least(
                coalesce(coalesce(e.gross_abs_delta_usd, abs(e.signed_delta_usd), 0), 0)
                / $6::numeric,
                1
              )
            end
          )
        )
        + (
          $14::numeric * (
            case
              when (
                case
                  when e.last_price is not null then e.last_price
                  when upper(coalesce(e.outcome_side, '')) = 'NO'
                    and e.market_last_price is not null
                    then 1 - e.market_last_price
                  else e.market_last_price
                end
              ) is null or $5::numeric <= 0 then 0
              else greatest(
                0,
                least(
                  1,
                  (
                    $5::numeric - (
                      case
                        when e.last_price is not null then e.last_price
                        when upper(coalesce(e.outcome_side, '')) = 'NO'
                          and e.market_last_price is not null
                          then 1 - e.market_last_price
                        else e.market_last_price
                      end
                    )
                  ) / $5::numeric
                )
              )
            end
          )
        )
        + (
          $15::numeric * (
            case
              when $12::numeric <= 0 then 0
              else least(
                coalesce(
                  case
                    when e.last_prior_activity_at is not null
                      and e.last_occurred_at is not null
                      then greatest(
                        extract(epoch from (e.last_occurred_at - e.last_prior_activity_at))
                        / 86400.0,
                        0
                      )
                    else null
                  end,
                  0
                ) / $12::numeric,
                1
              )
            end
          )
        )
        + (
          $16::numeric * (
            case
              when coalesce(e.prior_distinct_markets, 0) <= $8::int then 1
              else greatest(
                0,
                1 - (
                  (coalesce(e.prior_distinct_markets, 0) - $8::int)::numeric
                  / greatest($8::numeric + 1, 1)
                )
              )
            end
          )
        )
      ) / greatest($17::numeric, 0.0001) as signal_score
    from enriched e
  ),
  signal_rows as (
    select
      sr.wallet_id,
      sr.market_id,
      sr.market_title,
      sr.market_image,
      sr.market_icon,
      sr.event_id,
      sr.event_title,
      sr.event_image,
      sr.event_icon,
      sr.venue,
      sr.market_status,
      sr.close_time,
      sr.expiration_time,
      sr.resolved_outcome,
      sr.outcomes,
      sr.category,
      sr.change_action,
      sr.outcome_side,
      sr.signed_delta_shares,
      sr.signed_delta_usd,
      sr.stake_usd,
      sr.odds,
      sr.potential_payout_usd,
      sr.idle_days,
      sr.prior_distinct_markets,
      sr.signal_score,
      case
        when sr.odds is not null
         and sr.odds <= $5::numeric
         and coalesce(sr.stake_usd, 0) >= $6::numeric
         and ($7::numeric <= 0 or coalesce(sr.potential_payout_usd, 0) >= $7::numeric)
         and sr.signal_score >= $18::numeric
          then case
            when sr.late_bucket in ('late', 'very_late')
              then 'longshot_large_late'
            else 'longshot_large'
          end
        else null
      end as signal_type,
      sr.late_bucket,
      sr.occurred_at,
      array_remove(array[
        case
          when sr.odds is not null and sr.odds <= least($5::numeric, 0.10::numeric)
            then 'longshot_odds'
          when sr.odds is not null and sr.odds <= $5::numeric
            then 'low_odds'
        end,
        case when coalesce(sr.stake_usd, 0) >= $6::numeric then 'high_notional' end,
        case when coalesce(sr.idle_days, 0) >= $12::numeric then 'reactivated_after_idle' end,
        case when coalesce(sr.prior_distinct_markets, 0) <= $8::int then 'narrow_history' end,
        case when sr.entered_late then 'late_entry' end,
        case
          when sr.odds is not null
           and sr.odds <= $5::numeric
           and coalesce(sr.stake_usd, 0) >= $6::numeric
           and ($7::numeric <= 0 or coalesce(sr.potential_payout_usd, 0) >= $7::numeric)
           and coalesce(sr.idle_days, 0) >= $12::numeric
           and coalesce(sr.prior_distinct_markets, 0) <= $8::int
           and sr.signal_score >= $18::numeric
            then 'high_risk_longshot'
        end
      ], null) as reason_codes
    from scored_rows sr
  )
  select
    sr.wallet_id,
    sr.market_id,
    sr.market_title,
    sr.market_image,
    sr.market_icon,
    sr.event_id,
    sr.event_title,
    sr.event_image,
    sr.event_icon,
    sr.venue,
    sr.market_status,
    sr.close_time,
    sr.expiration_time,
    sr.resolved_outcome,
    sr.category,
    sr.change_action,
    sr.outcome_side,
    sr.signed_delta_shares,
    sr.signed_delta_usd,
    sr.stake_usd,
    sr.odds,
    sr.potential_payout_usd,
    sr.idle_days,
    sr.prior_distinct_markets,
    sr.signal_score,
    sr.signal_type,
    sr.late_bucket,
    sr.occurred_at,
    sr.reason_codes
  from signal_rows sr
  where sr.signal_type is not null
    and sr.change_action in ('OPENED', 'INCREASED')
    and upper(coalesce(sr.market_status::text, '')) = 'ACTIVE'
    and nullif(btrim(coalesce(sr.resolved_outcome, '')), '') is null
    and coalesce(sr.close_time, sr.expiration_time) is not null
    and coalesce(sr.close_time, sr.expiration_time) > now()
    and ($20::text is null or sr.signal_type = $20::text)
    and ($21::text is null or sr.late_bucket = $21::text)
    and (
      $22::text[] is null
      or (
        lower($23::text) = 'all'
        and sr.reason_codes @> $22::text[]
      )
      or (
        lower($23::text) <> 'all'
        and sr.reason_codes && $22::text[]
      )
    )
    and (
      $26::text[] is null
      or (
        case lower(coalesce(sr.venue, ''))
          when 'polymarket' then case
            when coalesce(sr.signal_score, 0) >= $32::numeric then 'critical'
            when coalesce(sr.signal_score, 0) >= $31::numeric then 'high'
            when coalesce(sr.signal_score, 0) >= $30::numeric then 'medium'
            else 'low'
          end
          when 'kalshi' then case
            when coalesce(sr.signal_score, 0) >= $35::numeric then 'critical'
            when coalesce(sr.signal_score, 0) >= $34::numeric then 'high'
            when coalesce(sr.signal_score, 0) >= $33::numeric then 'medium'
            else 'low'
          end
          when 'limitless' then case
            when coalesce(sr.signal_score, 0) >= $38::numeric then 'critical'
            when coalesce(sr.signal_score, 0) >= $37::numeric then 'high'
            when coalesce(sr.signal_score, 0) >= $36::numeric then 'medium'
            else 'low'
          end
          else case
            when coalesce(sr.signal_score, 0) >= $29::numeric then 'critical'
            when coalesce(sr.signal_score, 0) >= $28::numeric then 'high'
            when coalesce(sr.signal_score, 0) >= $27::numeric then 'medium'
            else 'low'
          end
        end
      ) = any($26::text[])
    )
  order by sr.signal_score desc nulls last, sr.close_time asc nulls last, sr.market_id, sr.wallet_id
  limit $24
  offset $25
`;

const FETCH_WALLET_ACTIVITY_SIGNAL_PAGE_LABELS_SQL = `
  with page_rows as (
    select
      pr.wallet_id,
      pr.venue,
      pr.market_id,
      nullif(pr.outcome_side, '') as outcome_side
    from unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) as pr(
      wallet_id,
      venue,
      market_id,
      outcome_side
    )
  ),
  wallet_set as (
    select distinct wallet_id from page_rows
  ),
  baseline as (
    select
      wb.wallet_id,
      wb.p90_usd,
      nullif(to_jsonb(wb)->>'sample_count', '')::int as baseline_sample_count
    from wallet_activity_baseline wb
    join wallet_set ws on ws.wallet_id = wb.wallet_id
    where wb.window_days = $6::int
  ),
  profiles as (
    select
      wp.wallet_id,
      array(
        select lower(value)
        from jsonb_array_elements_text(
          coalesce(wp.profile->'categories', '[]'::jsonb)
        ) value
      ) as categories
    from wallet_profiles wp
    join wallet_set ws on ws.wallet_id = wp.wallet_id
  ),
  window_rows as (
    select
      pr.wallet_id,
      pr.venue,
      pr.market_id,
      pr.outcome_side,
      max(coalesce(wah.max_abs_delta_usd, 0)) as max_abs_delta_usd,
      lower(coalesce(um.category, ue.category)) as category
    from page_rows pr
    join wallet_activity_hourly wah
      on wah.wallet_id = pr.wallet_id
     and wah.venue = pr.venue
     and wah.market_id = pr.market_id
     and coalesce(nullif(wah.outcome_side, ''), '') = coalesce(pr.outcome_side, '')
    left join unified_markets um on um.id = wah.market_id
    left join unified_events ue on ue.id = um.event_id
    where wah.activity_type in ('delta', 'trade')
      and wah.hour_bucket >= now() - ($5::text || ' hours')::interval
    group by
      pr.wallet_id,
      pr.venue,
      pr.market_id,
      pr.outcome_side,
      lower(coalesce(um.category, ue.category))
  )
  select
    pr.wallet_id,
    pr.venue,
    pr.market_id,
    pr.outcome_side,
    case
      when coalesce(b.baseline_sample_count, $7::int) >= $7::int
       and b.p90_usd is not null
       and b.p90_usd > 0
       and coalesce(wr.max_abs_delta_usd, 0) >= b.p90_usd
        then true
      else false
    end as unusual_size,
    case
      when p.categories is not null
       and wr.category is not null
       and wr.category = any(p.categories)
        then true
      else false
    end as on_pattern,
    case
      when p.categories is not null then true
      else false
    end as has_profile_categories,
    wr.category
  from page_rows pr
  left join window_rows wr
    on wr.wallet_id = pr.wallet_id
   and wr.venue = pr.venue
   and wr.market_id = pr.market_id
   and coalesce(wr.outcome_side, '') = coalesce(pr.outcome_side, '')
  left join baseline b on b.wallet_id = pr.wallet_id
  left join profiles p on p.wallet_id = pr.wallet_id
`;

/**
 * Compute wallet activity summaries and top changes for a set of wallet IDs.
 *
 * This is intentionally KISS:
 * - Activity is inferred from snapshot deltas / wallet_activity_events.
 * - "Unusual" is relative to the wallet's own recent p90 baseline and only
 *   evaluated when minimum baseline sample count is met.
 */
export async function fetchWalletActivitySummaries(
  client: PoolClient,
  walletIds: string[],
  options: WalletActivityQueryOptions,
): Promise<Map<string, WalletActivitySummary>> {
  if (walletIds.length === 0) return new Map();
  const resolved = resolveWalletActivityQuery(options);

  const result = await client.query<WalletActivitySummaryDbRow>(
    FETCH_WALLET_ACTIVITY_SUMMARIES_SQL,
    buildWalletActivityParams(walletIds, resolved),
  );

  const map = new Map<string, WalletActivitySummary>();
  for (const row of result.rows) {
    const stats = parseSummaryStatsRow(
      row,
      resolved.windowHours,
      resolved.minBaselineSampleCount,
    );
    map.set(row.wallet_id, {
      ...stats,
      topChanges: parseTopChanges(row.top_changes),
    });
  }

  return map;
}

export async function fetchWalletActivitySummaryStats(
  client: PoolClient,
  walletIds: string[],
  options: WalletActivityQueryOptions,
): Promise<Map<string, WalletActivitySummaryStats>> {
  if (walletIds.length === 0) return new Map();
  const resolved = resolveWalletActivityQuery(options);
  const result = await client.query<WalletActivitySummaryStatsDbRow>(
    FETCH_WALLET_ACTIVITY_SUMMARY_STATS_SQL,
    buildWalletActivitySummaryStatsParams(walletIds, resolved),
  );
  const map = new Map<string, WalletActivitySummaryStats>();
  for (const row of result.rows) {
    map.set(
      row.wallet_id,
      parseSummaryStatsRow(
        row,
        resolved.windowHours,
        resolved.minBaselineSampleCount,
      ),
    );
  }
  return map;
}

export async function fetchWalletActivityTopChanges(
  client: PoolClient,
  walletIds: string[],
  options: WalletActivityQueryOptions,
): Promise<Map<string, WalletActivityTopChange[]>> {
  if (walletIds.length === 0) return new Map();
  const resolved = resolveWalletActivityQuery(options);
  const result = await client.query<WalletActivityTopChangesDbRow>(
    FETCH_WALLET_ACTIVITY_SUMMARY_TOP_CHANGES_SQL,
    buildWalletActivityParams(walletIds, resolved),
  );
  const map = new Map<string, WalletActivityTopChange[]>();
  for (const row of result.rows) {
    map.set(row.wallet_id, parseTopChanges(row.top_changes));
  }
  return map;
}

export async function fetchWalletActivitySignalSummary(
  client: PoolClient,
  walletIds: string[],
  options: WalletActivityQueryOptions,
): Promise<Map<string, WalletActivitySignalSummary>> {
  if (walletIds.length === 0) return new Map();
  const resolved = resolveWalletActivityQuery(options);
  const result = await client.query<WalletActivitySignalSummaryDbRow>(
    FETCH_WALLET_ACTIVITY_SIGNAL_SUMMARY_SQL,
    buildWalletActivityParams(walletIds, resolved),
  );
  const map = new Map<string, WalletActivitySignalSummary>();
  for (const row of result.rows) {
    map.set(row.wallet_id, {
      criticalSignals30d: Math.max(
        0,
        Math.trunc(row.critical_signals_30d ?? 0),
      ),
      avgSignalScore30d: parseNumber(row.avg_signal_score_30d),
      hasReactivatedAfterIdle: row.has_reactivated_after_idle === true,
      hasLateEntry: row.has_late_entry === true,
      hasVeryLateEntry: row.has_very_late_entry === true,
      hasUnusualBehavior: row.has_unusual_behavior === true,
    });
  }
  return map;
}

export async function fetchWalletActivitySignalRows(
  client: PoolClient,
  walletIds: string[],
  options: WalletActivityQueryOptions & {
    signalType?: WalletActivitySignalType | null;
    lateBucket?: WalletActivityLateBucket | null;
    reasonCodes?: string[] | null;
    reasonMode?: "any" | "all";
    limit?: number;
    offset?: number;
  },
): Promise<WalletActivitySignalRow[]> {
  if (walletIds.length === 0) return [];
  const resolved = resolveWalletActivityQuery(options);
  const result = await client.query<WalletActivitySignalRowDbRow>(
    FETCH_WALLET_ACTIVITY_SIGNAL_ROWS_SQL,
    [
      ...buildWalletActivityParams(walletIds, resolved),
      options.signalType ?? null,
      options.lateBucket ?? null,
      options.reasonCodes?.length ? options.reasonCodes : null,
      options.reasonMode ?? "any",
      Math.max(1, Math.trunc(options.limit ?? 30)),
      Math.max(0, Math.trunc(options.offset ?? 0)),
    ],
  );
  return result.rows.map(mapWalletActivitySignalRow);
}

export async function fetchWalletActivitySignalRowsFast(
  client: PoolClient,
  walletIds: string[],
  options: WalletActivityQueryOptions & {
    signalType?: WalletActivitySignalType | null;
    lateBucket?: WalletActivityLateBucket | null;
    reasonCodes?: string[] | null;
    reasonMode?: "any" | "all";
    severityFilters?: string[] | null;
    severityThresholds?: WalletActivitySignalSeverityThresholds | null;
    limit?: number;
    offset?: number;
  },
): Promise<WalletActivitySignalRow[]> {
  if (walletIds.length === 0) return [];
  const resolved = resolveWalletActivityQuery(options);
  const severityThresholds = options.severityThresholds ?? {
    default: { medium: 0.35, high: 0.6, critical: 0.85 },
    polymarket: { medium: 0.35, high: 0.6, critical: 0.85 },
    kalshi: { medium: 0.35, high: 0.6, critical: 0.85 },
    limitless: { medium: 0.35, high: 0.6, critical: 0.85 },
  };
  const result = await client.query<WalletActivitySignalRowDbRow>(
    FETCH_WALLET_ACTIVITY_SIGNAL_ROWS_FAST_SQL,
    [
      ...buildWalletActivityParams(walletIds, resolved),
      options.signalType ?? null,
      options.lateBucket ?? null,
      options.reasonCodes?.length ? options.reasonCodes : null,
      options.reasonMode ?? "any",
      Math.max(1, Math.trunc(options.limit ?? 30)),
      Math.max(0, Math.trunc(options.offset ?? 0)),
      options.severityFilters?.length ? options.severityFilters : null,
      severityThresholds.default.medium,
      severityThresholds.default.high,
      severityThresholds.default.critical,
      severityThresholds.polymarket.medium,
      severityThresholds.polymarket.high,
      severityThresholds.polymarket.critical,
      severityThresholds.kalshi.medium,
      severityThresholds.kalshi.high,
      severityThresholds.kalshi.critical,
      severityThresholds.limitless.medium,
      severityThresholds.limitless.high,
      severityThresholds.limitless.critical,
    ],
  );
  return result.rows.map(mapWalletActivitySignalRow);
}

export async function fetchWalletActivitySignalPageLabels(
  client: PoolClient,
  rows: Array<{
    walletId: string;
    venue: string;
    marketId: string;
    positionSide: string | null;
  }>,
  options: WalletActivityQueryOptions,
): Promise<Map<string, WalletActivitySignalPageLabelFlags>> {
  if (rows.length === 0) return new Map();
  const resolved = resolveWalletActivityQuery(options);
  const result = await client.query<WalletActivitySignalPageLabelDbRow>(
    FETCH_WALLET_ACTIVITY_SIGNAL_PAGE_LABELS_SQL,
    [
      rows.map((row) => row.walletId),
      rows.map((row) => row.venue),
      rows.map((row) => row.marketId),
      rows.map((row) => row.positionSide ?? ""),
      resolved.windowHours,
      resolved.baselineDays,
      resolved.minBaselineSampleCount,
    ],
  );
  const map = new Map<string, WalletActivitySignalPageLabelFlags>();
  for (const row of result.rows) {
    const key = [
      row.wallet_id,
      row.venue,
      row.market_id,
      row.outcome_side ?? "",
    ].join(":");
    map.set(key, {
      unusualSize: row.unusual_size,
      onPattern: row.on_pattern,
      hasProfileCategories: row.has_profile_categories,
      category: row.category,
    });
  }
  return map;
}
