import type { PoolClient } from "pg";

import { env } from "../env.js";

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

export type WalletActivitySignalType = "longshot_large" | "longshot_large_late";
export type WalletActivityLateBucket = "late" | "very_late" | "unknown";
export type WalletActivityUnusualTier =
  | "unusual"
  | "very_unusual"
  | "extreme";

export type WalletActivityTopChange = {
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
  const sampleCount = Math.max(0, Math.trunc(input.baselineSampleCount ?? 0));
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
  if (score == null || !Number.isFinite(score) || score < UNUSUAL_TIER_UNUSUAL_MIN) {
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
      occurredAtRaw instanceof Date ? occurredAtRaw : new Date(String(occurredAtRaw));
    if (!Number.isFinite(occurredAt.getTime())) continue;
    items.push({
      marketId: String(record.marketId ?? ""),
      marketTitle:
        record.marketTitle == null ? null : String(record.marketTitle ?? ""),
      eventId: record.eventId == null ? null : String(record.eventId),
      eventTitle: record.eventTitle == null ? null : String(record.eventTitle),
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
  options: {
    windowHours: number;
    topChanges: number;
    baselineDays?: number;
    minBaselineSampleCount?: number;
    enteredLateHours?: number;
    signalConfig?: Partial<WalletActivitySignalConfig>;
  },
): Promise<Map<string, WalletActivitySummary>> {
  if (walletIds.length === 0) return new Map();

  const windowHours = Math.max(1, Math.trunc(options.windowHours));
  const topChanges = Math.max(1, Math.trunc(options.topChanges));
  const baselineDays = Math.max(7, Math.trunc(options.baselineDays ?? 30));
  const minBaselineSampleCount = Math.max(
    1,
    Math.trunc(
      options.minBaselineSampleCount ?? DEFAULT_MIN_UNUSUAL_BASELINE_SAMPLES,
    ),
  );
  const signalConfig = resolveSignalConfig(options.signalConfig);

  const result = await client.query<WalletActivitySummaryDbRow>(
    `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      ),
      window_start as (
        select now() - ($2::text || ' hours')::interval as ts
      ),
      history as (
        with history_events as (
          select
            wae.wallet_id,
            wae.market_id,
            max(wae.occurred_at) as last_prior_activity_at
          from wallet_activity_events wae
          join wallet_set ws on ws.wallet_id = wae.wallet_id
          where wae.activity_type in ('delta', 'trade')
            and wae.occurred_at < (select ts from window_start)
            and (
              $11::int = 0
              or wae.occurred_at >= now() - ($11::text || ' days')::interval
            )
          group by wae.wallet_id, wae.market_id
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
          wb.p90_usd
        from wallet_activity_baseline wb
        join wallet_set ws on ws.wallet_id = wb.wallet_id
        where wb.window_days = $3::int
      ),
      baseline_samples as (
        with baseline_event_counts as (
          select
            wae.wallet_id,
            count(*)::int as baseline_sample_count
          from wallet_activity_events wae
          join wallet_set ws on ws.wallet_id = wae.wallet_id
          where wae.activity_type in ('delta', 'trade')
            and wae.size_usd is not null
            and wae.occurred_at >= now() - ($3::text || ' days')::interval
            and wae.occurred_at <= now()
          group by wae.wallet_id
        )
        select
          ws.wallet_id,
          coalesce(bec.baseline_sample_count, 0)::int as baseline_sample_count
        from wallet_set ws
        left join baseline_event_counts bec on bec.wallet_id = ws.wallet_id
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
          um.event_id,
          ue.title as event_title,
          um.status as market_status,
          um.close_time,
          um.expiration_time,
          um.resolved_outcome,
          lower(coalesce(um.category, ue.category)) as category,
          um.best_bid,
          um.best_ask,
          um.last_price as market_last_price
        from events_window ew
        left join unified_markets um on um.id = ew.market_id
        left join unified_events ue on ue.id = um.event_id
      ),
      labeled as (
        select
          e.*,
          b.p90_usd,
          coalesce(bs.baseline_sample_count, 0) as baseline_sample_count,
          h.prior_distinct_markets,
          h.last_prior_activity_at,
          p.categories as profile_categories,
          coalesce(e.close_time, e.expiration_time) as close_at
        from enriched e
        left join baseline b on b.wallet_id = e.wallet_id
        left join baseline_samples bs on bs.wallet_id = e.wallet_id
        left join history h on h.wallet_id = e.wallet_id
        left join profiles p on p.wallet_id = e.wallet_id
      ),
      change_rows as (
        select
          l.*,
          case
            when coalesce(l.baseline_sample_count, 0) >= $19::int
             and l.p90_usd is not null
             and l.p90_usd > 0
             and coalesce(l.max_abs_delta_usd, 0) >= l.p90_usd
              then true
            else false
          end as unusual_size,
          case
            when l.profile_categories is not null
             and l.category is not null
             and l.category = any(l.profile_categories)
              then true
            else false
          end as on_pattern,
          case
            when l.profile_categories is not null then true
            else false
          end as has_profile_categories
        from labeled l
      ),
      ranked_changes as (
        select
          cr.wallet_id,
          cr.venue,
          cr.market_id,
          cr.outcome_side,
          cr.market_title,
          cr.event_id,
          cr.event_title,
          cr.market_status,
          cr.close_time,
          cr.expiration_time,
          cr.resolved_outcome,
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
      ),
      top_changes as (
        select
          cc.wallet_id,
          jsonb_agg(
            jsonb_build_object(
              'marketId', cc.market_id,
              'marketTitle', cc.market_title,
              'eventId', cc.event_id,
              'eventTitle', cc.event_title,
              'venue', cc.venue,
              'marketStatus', cc.market_status,
              'closeTime', cc.close_time,
              'expirationTime', cc.expiration_time,
              'resolvedOutcome', cc.resolved_outcome,
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
                case when cc.odds is not null and cc.odds <= $5::numeric then 'longshot_odds' end,
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
                case when cc.odds is not null and cc.odds <= $5::numeric then 'longshot_odds' end,
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
      ),
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
          max(coalesce(cr.baseline_sample_count, 0))::int as baseline_sample_count
        from change_rows cr
        group by cr.wallet_id
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
        s.baseline_p90_usd,
        s.baseline_sample_count,
        tc.top_changes
      from summary s
      left join top_changes tc on tc.wallet_id = s.wallet_id
    `,
    [
      walletIds,
      windowHours,
      baselineDays,
      topChanges,
      signalConfig.maxOdds,
      signalConfig.minStakeUsd,
      signalConfig.minPayoutUsd,
      signalConfig.maxPriorMarkets,
      signalConfig.lateHours,
      signalConfig.veryLateHours,
      signalConfig.retentionDaysActivity,
      signalConfig.minIdleDays,
      signalConfig.weightStake,
      signalConfig.weightOdds,
      signalConfig.weightIdle,
      signalConfig.weightNovelty,
      signalConfig.weightSum,
      signalConfig.minScore,
      minBaselineSampleCount,
    ],
  );

  const map = new Map<string, WalletActivitySummary>();
  for (const row of result.rows) {
    const unusualScore = computeRobustUnusualScore({
      maxAbsDeltaUsd: parseNumber(row.max_abs_delta_usd_window),
      baselineP90Usd: parseNumber(row.baseline_p90_usd),
      baselineSampleCount: row.baseline_sample_count,
      minBaselineSamples: minBaselineSampleCount,
    });
    map.set(row.wallet_id, {
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
      topChanges: parseTopChanges(row.top_changes),
    });
  }

  return map;
}
