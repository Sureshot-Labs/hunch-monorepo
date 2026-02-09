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
  unusual_score: string | null;
  top_changes: unknown;
};

export type WalletActivitySignalType = "longshot_large" | "longshot_large_late";
export type WalletActivityLateBucket = "late" | "very_late" | "unknown";

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
  topChanges: WalletActivityTopChange[];
};

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
 * - "Unusual" is relative to the wallet's own recent baseline.
 */
export async function fetchWalletActivitySummaries(
  client: PoolClient,
  walletIds: string[],
  options: {
    windowHours: number;
    topChanges: number;
    baselineDays?: number;
    enteredLateHours?: number;
    signalConfig?: Partial<WalletActivitySignalConfig>;
  },
): Promise<Map<string, WalletActivitySummary>> {
  if (walletIds.length === 0) return new Map();

  const windowHours = Math.max(1, Math.trunc(options.windowHours));
  const topChanges = Math.max(1, Math.trunc(options.topChanges));
  const baselineDays = Math.max(7, Math.trunc(options.baselineDays ?? 30));
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
        select
          ws.wallet_id,
          count(distinct wae.market_id)::int as prior_distinct_markets,
          max(wae.occurred_at) as last_prior_activity_at
        from wallet_set ws
        left join wallet_activity_events wae
          on wae.wallet_id = ws.wallet_id
         and wae.activity_type in ('delta', 'trade')
         and wae.occurred_at < (select ts from window_start)
         and (
           $11::int = 0
           or wae.occurred_at >= now() - ($11::text || ' days')::interval
         )
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
          wb.p50_usd,
          wb.p90_usd
        from wallet_activity_baseline wb
        where wb.wallet_id = any($1::uuid[])
          and wb.window_days = $3::int
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
          b.p50_usd,
          b.p90_usd,
          p.categories as profile_categories,
          coalesce(e.close_time, e.expiration_time) as close_at
        from enriched e
        left join baseline b on b.wallet_id = e.wallet_id
        left join profiles p on p.wallet_id = e.wallet_id
      ),
      change_rows as (
        select
          l.*,
          case
            when l.p90_usd is not null
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
          end as on_pattern
        from labeled l
      ),
      latest_per_market as (
        select distinct on (cr.wallet_id, cr.venue, cr.market_id, cr.outcome_side)
          cr.wallet_id,
          cr.venue,
          cr.market_id,
          cr.outcome_side,
          cr.change_action,
          cr.last_price,
          cr.last_occurred_at
        from change_rows cr
        order by cr.wallet_id, cr.venue, cr.market_id, cr.outcome_side, cr.last_occurred_at desc
      ),
      market_changes as (
        select
          cr.wallet_id,
          cr.venue,
          cr.market_id,
          cr.outcome_side,
          max(cr.market_title) as market_title,
          max(cr.event_id) as event_id,
          max(cr.event_title) as event_title,
          max(cr.market_status) as market_status,
          max(cr.close_time) as close_time,
          max(cr.expiration_time) as expiration_time,
          max(cr.resolved_outcome) as resolved_outcome,
          max(cr.category) as category,
          sum(cr.signed_delta_shares) as signed_delta_shares,
          sum(cr.signed_delta_usd) as signed_delta_usd,
          sum(cr.gross_abs_delta_usd) as gross_abs_delta_usd,
          bool_or(cr.entered_late) as entered_late,
          bool_or(cr.unusual_size) as unusual_size,
          bool_or(coalesce(cr.on_pattern, false)) as on_pattern,
          max(cr.market_last_price) as market_last_price
        from change_rows cr
        group by cr.wallet_id, cr.venue, cr.market_id, cr.outcome_side
      ),
      market_ranked as (
        select
          mc.wallet_id,
          mc.venue,
          mc.market_id,
          mc.outcome_side,
          mc.market_title,
          mc.event_id,
          mc.event_title,
          mc.market_status,
          mc.close_time,
          mc.expiration_time,
          mc.resolved_outcome,
          mc.category,
          mc.signed_delta_shares,
          mc.signed_delta_usd,
          mc.gross_abs_delta_usd,
          mc.entered_late,
          mc.unusual_size,
          mc.on_pattern,
          lpm.change_action,
          lpm.last_price as price,
          case
            when lpm.last_price is not null then lpm.last_price
            when upper(coalesce(mc.outcome_side, '')) = 'NO'
              and mc.market_last_price is not null
              then 1 - mc.market_last_price
            else mc.market_last_price
          end as odds,
          lpm.last_occurred_at as occurred_at,
          p.categories as profile_categories,
          h.prior_distinct_markets,
          h.last_prior_activity_at,
          coalesce(mc.gross_abs_delta_usd, abs(mc.signed_delta_usd), 0) as stake_usd,
          case
            when h.last_prior_activity_at is not null
              and lpm.last_occurred_at is not null
              then greatest(
                extract(epoch from (lpm.last_occurred_at - h.last_prior_activity_at))
                / 86400.0,
                0
              )
            else null
          end as idle_days,
          row_number() over (
            partition by mc.wallet_id
            order by mc.gross_abs_delta_usd desc nulls last, lpm.last_occurred_at desc nulls last
          ) as rn
        from market_changes mc
        left join latest_per_market lpm
          on lpm.wallet_id = mc.wallet_id
         and lpm.venue = mc.venue
         and lpm.market_id = mc.market_id
         and lpm.outcome_side is not distinct from mc.outcome_side
        left join profiles p on p.wallet_id = mc.wallet_id
        left join history h on h.wallet_id = mc.wallet_id
      ),
      scored_changes as (
        select
          mr.*,
          case
            when mr.odds is not null and mr.odds > 0
              then mr.stake_usd / mr.odds
            else null
          end as potential_payout_usd,
          case
            when coalesce(mr.close_time, mr.expiration_time) is null then 'unknown'
            when mr.occurred_at is null then 'unknown'
            when coalesce(mr.close_time, mr.expiration_time) <= mr.occurred_at
              then 'unknown'
            when extract(
              epoch from (coalesce(mr.close_time, mr.expiration_time) - mr.occurred_at)
            ) / 3600.0 <= $10::numeric then 'very_late'
            when extract(
              epoch from (coalesce(mr.close_time, mr.expiration_time) - mr.occurred_at)
            ) / 3600.0 <= $9::numeric then 'late'
            else null
          end as late_bucket,
          (
            (
              $13::numeric * (
                case
                  when $6::numeric <= 0 then 0
                  else least(coalesce(mr.stake_usd, 0) / $6::numeric, 1)
                end
              )
            )
            + (
              $14::numeric * (
                case
                  when mr.odds is null or $5::numeric <= 0 then 0
                  else greatest(0, least(1, ($5::numeric - mr.odds) / $5::numeric))
                end
              )
            )
            + (
              $15::numeric * (
                case
                  when $12::numeric <= 0 then 0
                  else least(coalesce(mr.idle_days, 0) / $12::numeric, 1)
                end
              )
            )
            + (
              $16::numeric * (
                case
                  when coalesce(mr.prior_distinct_markets, 0) <= $8::int then 1
                  else greatest(
                    0,
                    1 - (
                      (coalesce(mr.prior_distinct_markets, 0) - $8::int)::numeric
                      / greatest($8::numeric + 1, 1)
                    )
                  )
                end
              )
            )
          ) / greatest($17::numeric, 0.0001) as signal_score
        from market_ranked mr
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
                  when cc.profile_categories is not null
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
          max(
            case
              when cr.p50_usd is not null and cr.p50_usd > 0
                then coalesce(cr.max_abs_delta_usd, 0) / cr.p50_usd
              else null
            end
          ) as unusual_score
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
        s.unusual_score,
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
    ],
  );

  const map = new Map<string, WalletActivitySummary>();
  for (const row of result.rows) {
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
      unusualScore: parseNumber(row.unusual_score),
      topChanges: parseTopChanges(row.top_changes),
    });
  }

  return map;
}
