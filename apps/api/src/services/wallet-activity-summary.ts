import type { PoolClient } from "pg";

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

function parseNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNonNullNumber(value: string | number | null | undefined): number {
  const parsed = parseNumber(value);
  return parsed ?? 0;
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
  },
): Promise<Map<string, WalletActivitySummary>> {
  if (walletIds.length === 0) return new Map();

  const windowHours = Math.max(1, Math.trunc(options.windowHours));
  const topChanges = Math.max(1, Math.trunc(options.topChanges));
  const baselineDays = Math.max(7, Math.trunc(options.baselineDays ?? 30));
  const enteredLateHours = Math.max(1, Math.trunc(options.enteredLateHours ?? 24));

  const result = await client.query<WalletActivitySummaryDbRow>(
    `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
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
      events_window as (
        select
          wa.wallet_id,
          wa.venue,
          wa.market_id,
          wa.outcome_side,
          wa.action,
          wa.delta_shares,
          wa.size_usd,
          wa.price,
          wa.occurred_at,
          wa.metadata,
          coalesce(nullif(wa.metadata->>'prevShares', '')::numeric, 0) as prev_shares,
          coalesce(nullif(wa.metadata->>'currShares', '')::numeric, 0) as curr_shares
        from wallet_activity_events wa
        join wallet_set ws on ws.wallet_id = wa.wallet_id
        where wa.activity_type in ('delta', 'trade')
          and wa.occurred_at >= now() - ($2::text || ' hours')::interval
      ),
      baseline as (
        select
          wa.wallet_id,
          percentile_cont(0.5) within group (order by wa.size_usd) as p50_usd,
          percentile_cont(0.9) within group (order by wa.size_usd) as p90_usd
        from wallet_activity_events wa
        join wallet_set ws on ws.wallet_id = wa.wallet_id
        where wa.activity_type in ('delta', 'trade')
          and wa.size_usd is not null
          and wa.occurred_at >= now() - ($3::text || ' days')::interval
        group by wa.wallet_id
      ),
      classified as (
        select
          ew.*,
          case when upper(coalesce(ew.action, 'BUY')) = 'SELL' then -1 else 1 end as action_sign,
          coalesce(
            ew.size_usd,
            abs(coalesce(ew.delta_shares, 0)) * nullif(ew.price, 0)
          ) as delta_usd,
          case
            when ew.prev_shares <= 0 and ew.curr_shares > 0 then 'OPENED'
            when ew.prev_shares > 0 and ew.curr_shares <= 0 then 'CLOSED'
            when ew.curr_shares > ew.prev_shares and ew.prev_shares > 0 then 'INCREASED'
            when ew.curr_shares < ew.prev_shares and ew.curr_shares > 0 then 'REDUCED'
            else null
          end as change_action
        from events_window ew
      ),
      enriched as (
        select
          c.*,
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
          um.last_price
        from classified c
        left join unified_markets um on um.id = c.market_id
        left join unified_events ue on ue.id = um.event_id
      ),
      labeled as (
        select
          e.*,
          b.p50_usd,
          b.p90_usd,
          p.categories as profile_categories,
          coalesce(e.close_time, e.expiration_time) as close_at,
          (e.action_sign * coalesce(e.delta_shares, 0)) as signed_delta_shares,
          (e.action_sign * coalesce(e.delta_usd, 0)) as signed_delta_usd
        from enriched e
        left join baseline b on b.wallet_id = e.wallet_id
        left join profiles p on p.wallet_id = e.wallet_id
      ),
      change_rows as (
        select
          l.*,
          abs(l.signed_delta_usd) as abs_delta_usd,
          case
            when l.close_at is not null
             and l.close_at >= l.occurred_at
             and l.close_at - l.occurred_at <= ($5::text || ' hours')::interval
              then true
            else false
          end as entered_late,
          case
            when l.p90_usd is not null and l.p90_usd > 0 and coalesce(l.delta_usd, 0) >= l.p90_usd
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
      latest_change as (
        select
          cr.*,
          coalesce(cr.last_price, cr.price) as odds
        from change_rows cr
      ),
      latest_per_market as (
        select distinct on (lc.wallet_id, lc.venue, lc.market_id, lc.outcome_side)
          lc.wallet_id,
          lc.venue,
          lc.market_id,
          lc.outcome_side,
          lc.change_action,
          lc.price,
          lc.odds,
          lc.occurred_at
        from latest_change lc
        order by lc.wallet_id, lc.venue, lc.market_id, lc.outcome_side, lc.occurred_at desc
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
          sum(cr.abs_delta_usd) as gross_abs_delta_usd,
          bool_or(cr.entered_late) as entered_late,
          bool_or(cr.unusual_size) as unusual_size,
          bool_or(coalesce(cr.on_pattern, false)) as on_pattern
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
          lpm.price,
          lpm.odds,
          lpm.occurred_at,
          p.categories as profile_categories,
          row_number() over (
            partition by mc.wallet_id
            order by mc.gross_abs_delta_usd desc nulls last, lpm.occurred_at desc nulls last
          ) as rn
        from market_changes mc
        left join latest_per_market lpm
          on lpm.wallet_id = mc.wallet_id
         and lpm.venue = mc.venue
         and lpm.market_id = mc.market_id
         and lpm.outcome_side is not distinct from mc.outcome_side
        left join profiles p on p.wallet_id = mc.wallet_id
      ),
      top_changes as (
        select
          mr.wallet_id,
          jsonb_agg(
            jsonb_build_object(
              'marketId', mr.market_id,
              'marketTitle', mr.market_title,
              'eventId', mr.event_id,
              'eventTitle', mr.event_title,
              'venue', mr.venue,
              'marketStatus', mr.market_status,
              'closeTime', mr.close_time,
              'expirationTime', mr.expiration_time,
              'resolvedOutcome', mr.resolved_outcome,
              'category', mr.category,
              'action', mr.change_action,
              'positionSide', mr.outcome_side,
              'deltaShares', mr.signed_delta_shares,
              'deltaUsd', mr.signed_delta_usd,
              'price', mr.price,
              'odds', mr.odds,
              'labels', array_remove(array[
                case when mr.entered_late then 'entered_late' end,
                case when mr.unusual_size then 'unusual_size' end,
                case when mr.on_pattern then 'on_pattern' end,
                case
                  when mr.profile_categories is not null
                   and coalesce(mr.on_pattern, false) = false
                   and mr.category is not null
                    then 'out_of_pattern'
                end
              ], null),
              'occurredAt', mr.occurred_at
            )
            order by mr.gross_abs_delta_usd desc nulls last, mr.occurred_at desc nulls last
          ) filter (where mr.rn <= $4) as top_changes
        from market_ranked mr
        group by mr.wallet_id
      ),
      summary as (
        select
          cr.wallet_id,
          max(cr.occurred_at) as last_activity_at,
          sum(cr.signed_delta_usd) as net_change_usd,
          sum(case when upper(cr.outcome_side) = 'YES' then cr.signed_delta_usd else 0 end) as net_change_yes_usd,
          sum(case when upper(cr.outcome_side) = 'NO' then cr.signed_delta_usd else 0 end) as net_change_no_usd,
          count(*) filter (where cr.change_action = 'OPENED')::int as counts_new,
          count(*) filter (where cr.change_action = 'CLOSED')::int as counts_exit,
          count(*) filter (where cr.change_action = 'INCREASED')::int as counts_increase,
          count(*) filter (where cr.change_action = 'REDUCED')::int as counts_reduce,
          0::int as counts_flip,
          max(
            case
              when cr.p50_usd is not null and cr.p50_usd > 0
                then coalesce(cr.delta_usd, 0) / cr.p50_usd
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
    [walletIds, windowHours, baselineDays, topChanges, enteredLateHours],
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
