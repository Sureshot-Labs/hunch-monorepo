import type { PoolClient } from "pg";

import {
  fetchWalletPerformanceSeries,
  fetchWalletPortfolioPnlSeries,
} from "./wallet-intel-series.js";

export type WalletCategoryMixItem = {
  category: string;
  volumeUsd: number;
  tradeCount: number;
  share: number;
};

export type WalletEntryBracketKey =
  | "0-20"
  | "20-40"
  | "40-60"
  | "60-80"
  | "80-100";

export type WalletEntryBracketStat = {
  bracket: WalletEntryBracketKey;
  avgStakeUsd: number | null;
  totalStakeUsd: number;
  tradeCount: number;
  resolvedCount: number;
  winRate: number | null;
};

export type WalletPerformanceSummaryPoint = {
  asOf: string;
  pnlUsd: number | null;
  roi: number | null;
};

export type WalletPerformance30dSummary = {
  period: "30d";
  pointCount: number;
  startAsOf: string | null;
  endAsOf: string | null;
  startPnlUsd: number | null;
  endPnlUsd: number | null;
  deltaPnlUsd: number | null;
  startRoi: number | null;
  endRoi: number | null;
  deltaRoi: number | null;
  minPnlUsd: number | null;
  maxPnlUsd: number | null;
  minRoi: number | null;
  maxRoi: number | null;
  points: WalletPerformanceSummaryPoint[];
};

export type WalletResolvedPositionSample = {
  marketId: string;
  eventId: string | null;
  marketTitle: string | null;
  eventTitle: string | null;
  venue: string;
  category: string | null;
  marketStatus: string | null;
  closeTime: string | null;
  expirationTime: string | null;
  resolvedOutcome: string | null;
  outcomeSide: string | null;
  shares: number | null;
  sizeUsd: number | null;
  entryPrice: number | null;
  snapshotAt: string | null;
};

const ENTRY_BRACKET_KEYS: WalletEntryBracketKey[] = [
  "0-20",
  "20-40",
  "40-60",
  "60-80",
  "80-100",
];

function nullableNumber(
  value: string | number | null | undefined,
): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRate(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.abs(value) > 1 ? value / 100 : value;
}

function downsamplePerformancePoints(
  points: WalletPerformanceSummaryPoint[],
  maxPoints: number,
): WalletPerformanceSummaryPoint[] {
  if (points.length <= maxPoints) return points;
  const result: WalletPerformanceSummaryPoint[] = [];
  const lastIndex = points.length - 1;
  for (let index = 0; index < maxPoints; index += 1) {
    const pointIndex = Math.round((index * lastIndex) / Math.max(maxPoints - 1, 1));
    const point = points[pointIndex];
    if (point) result.push(point);
  }
  return result.filter(
    (point, index, list) =>
      index === 0 ||
      point.asOf !== list[index - 1]?.asOf,
  );
}

function summarizeRange(values: Array<number | null>): {
  min: number | null;
  max: number | null;
} {
  const normalized = values.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  if (normalized.length === 0) {
    return { min: null, max: null };
  }
  return {
    min: Math.min(...normalized),
    max: Math.max(...normalized),
  };
}

export async function loadWalletCategoryMix(
  client: PoolClient,
  walletId: string,
  windowDays = 30,
): Promise<WalletCategoryMixItem[]> {
  const rows = await client.query<{
    category: string;
    volume_usd: string | null;
    trade_count: number | null;
    share: string | null;
  }>(
    `
      with category_mix as (
        select
          lower(coalesce(nullif(trim(um.category), ''), 'other')) as category,
          sum(wa.size_usd)::double precision as volume_usd,
          count(*)::int as trade_count
        from wallet_activity_events wa
        left join unified_markets um on um.id = wa.market_id
        where wa.wallet_id = $1::uuid
          and wa.occurred_at >= now() - ($2::text || ' days')::interval
          and wa.size_usd is not null
        group by 1
      ),
      totals as (
        select sum(volume_usd)::double precision as total_volume_usd
        from category_mix
      )
      select
        cm.category,
        cm.volume_usd::text as volume_usd,
        cm.trade_count,
        case
          when t.total_volume_usd is null or t.total_volume_usd <= 0 then null
          else (cm.volume_usd / t.total_volume_usd)::text
        end as share
      from category_mix cm
      cross join totals t
      where cm.volume_usd > 0
      order by cm.volume_usd desc, cm.trade_count desc, cm.category asc
      limit 6
    `,
    [walletId, Math.max(1, Math.trunc(windowDays))],
  );

  return rows.rows
    .map((row) => ({
      category: row.category,
      volumeUsd: nullableNumber(row.volume_usd) ?? 0,
      tradeCount: row.trade_count ?? 0,
      share: nullableNumber(row.share) ?? 0,
    }))
    .filter((row) => row.volumeUsd > 0);
}

export async function loadWalletEntryBracketStats(
  client: PoolClient,
  walletId: string,
  windowDays = 30,
): Promise<WalletEntryBracketStat[]> {
  const rows = await client.query<{
    bracket: WalletEntryBracketKey;
    avg_stake_usd: string | null;
    total_stake_usd: string | null;
    trade_count: number | null;
    resolved_count: number | null;
    win_rate: string | null;
  }>(
    `
      with entry_events as (
        select
          case
            when wa.price is null then null
            when wa.price > 1 and wa.price <= 100 then wa.price / 100.0
            else wa.price
          end as price_probability,
          wa.size_usd::double precision as stake_usd,
          upper(coalesce(wa.outcome_side, '')) as outcome_side,
          upper(coalesce(um.resolved_outcome, '')) as resolved_outcome
        from wallet_activity_events wa
        left join unified_markets um on um.id = wa.market_id
        where wa.wallet_id = $1::uuid
          and wa.activity_type in ('delta', 'trade')
          and upper(coalesce(wa.action, '')) in ('OPENED', 'INCREASED', 'BUY', 'SELL')
          and wa.occurred_at >= now() - ($2::text || ' days')::interval
          and wa.size_usd is not null
          and wa.price is not null
      ),
      bucketed as (
        select
          case
            when price_probability < 0 or price_probability > 1 then null
            when price_probability < 0.2 then '0-20'
            when price_probability < 0.4 then '20-40'
            when price_probability < 0.6 then '40-60'
            when price_probability < 0.8 then '60-80'
            else '80-100'
          end as bracket,
          stake_usd,
          case
            when resolved_outcome in ('YES', 'NO')
             and outcome_side in ('YES', 'NO')
              then 1
            else 0
          end as resolved_row,
          case
            when resolved_outcome in ('YES', 'NO')
             and outcome_side = resolved_outcome
              then 1
            else 0
          end as win_row
        from entry_events
      )
      select
        bracket,
        avg(stake_usd)::text as avg_stake_usd,
        coalesce(sum(stake_usd), 0)::text as total_stake_usd,
        count(*)::int as trade_count,
        sum(resolved_row)::int as resolved_count,
        case
          when sum(resolved_row) > 0
            then (sum(win_row)::double precision / sum(resolved_row))::text
          else null
        end as win_rate
      from bucketed
      where bracket is not null
      group by bracket
    `,
    [walletId, Math.max(1, Math.trunc(windowDays))],
  );

  const rowByBracket = new Map(
    rows.rows.map((row) => [row.bracket, row] as const),
  );

  return ENTRY_BRACKET_KEYS.map((bracket) => {
    const row = rowByBracket.get(bracket);
    return {
      bracket,
      avgStakeUsd: row ? nullableNumber(row.avg_stake_usd) : null,
      totalStakeUsd: row ? nullableNumber(row.total_stake_usd) ?? 0 : 0,
      tradeCount: row?.trade_count ?? 0,
      resolvedCount: row?.resolved_count ?? 0,
      winRate: row ? nullableNumber(row.win_rate) : null,
    };
  });
}

export async function loadWalletPerformance30dSummary(
  client: PoolClient,
  walletId: string,
): Promise<WalletPerformance30dSummary> {
  const [tradeSeries, portfolioPnlSeries] = await Promise.all([
    fetchWalletPerformanceSeries(client, walletId, {
      period: "30d",
      windowHours: 720,
      bucketHours: 24,
      limit: 60,
    }),
    fetchWalletPortfolioPnlSeries(client, walletId, {
      rangeHours: 720,
      bucketHours: 24,
      limit: 60,
    }),
  ]);
  const tradeRoiByAsOf = new Map(
    tradeSeries.points.map((point) => [
      point.asOf.toISOString(),
      normalizeRate(nullableNumber(point.roi)),
    ]),
  );
  const normalizedPoints = portfolioPnlSeries.points.map((point) => ({
    asOf: point.asOf.toISOString(),
    pnlUsd: nullableNumber(point.pnlUsd),
    roi: tradeRoiByAsOf.get(point.asOf.toISOString()) ?? null,
  }));
  const sampledPoints = downsamplePerformancePoints(normalizedPoints, 12);
  const start = tradeSeries.points[0] ?? null;
  const end = tradeSeries.points[tradeSeries.points.length - 1] ?? null;
  const portfolioPerformance = portfolioPnlSeries.performance;
  const startRoi = normalizeRate(nullableNumber(start?.roi ?? null));
  const endRoi = normalizeRate(nullableNumber(end?.roi ?? null));
  const pnlRange = summarizeRange(normalizedPoints.map((point) => point.pnlUsd));
  const roiRange = summarizeRange(normalizedPoints.map((point) => point.roi));

  return {
    period: "30d",
    pointCount: normalizedPoints.length,
    startAsOf: portfolioPerformance?.startAsOf?.toISOString() ?? null,
    endAsOf: portfolioPerformance?.endAsOf?.toISOString() ?? null,
    startPnlUsd: portfolioPerformance?.startPnlUsd ?? null,
    endPnlUsd: portfolioPerformance?.endPnlUsd ?? null,
    deltaPnlUsd: portfolioPerformance?.pnlUsd ?? null,
    startRoi,
    endRoi,
    deltaRoi:
      startRoi != null && endRoi != null ? endRoi - startRoi : null,
    minPnlUsd: pnlRange.min,
    maxPnlUsd: pnlRange.max,
    minRoi: roiRange.min,
    maxRoi: roiRange.max,
    points: sampledPoints,
  };
}

export async function loadWalletResolvedPositionSamples(
  client: PoolClient,
  walletId: string,
  limit = 5,
): Promise<WalletResolvedPositionSample[]> {
  const rows = await client.query<{
    market_id: string;
    event_id: string | null;
    market_title: string | null;
    event_title: string | null;
    venue: string;
    category: string | null;
    market_status: string | null;
    close_time: Date | null;
    expiration_time: Date | null;
    resolved_outcome: string | null;
    outcome_side: string | null;
    shares: string | null;
    size_usd: string | null;
    price: string | null;
    snapshot_at: Date | null;
  }>(
    `
      with latest_snapshots as (
        select
          venue,
          max(snapshot_at) as snapshot_at
        from wallet_position_snapshots
        where wallet_id = $1::uuid
        group by venue
      )
      select
        ws.market_id,
        um.event_id,
        um.title as market_title,
        ue.title as event_title,
        ws.venue,
        lower(coalesce(um.category, ue.category)) as category,
        um.status as market_status,
        um.close_time,
        um.expiration_time,
        um.resolved_outcome,
        upper(nullif(ws.outcome_side, '')) as outcome_side,
        ws.shares::text,
        ws.size_usd::text,
        ws.price::text,
        ws.snapshot_at
      from wallet_position_snapshots ws
      join latest_snapshots ls
        on ls.venue = ws.venue
       and ls.snapshot_at = ws.snapshot_at
      left join unified_markets um on um.id = ws.market_id
      left join unified_events ue on ue.id = um.event_id
      where ws.wallet_id = $1::uuid
        and (
          (ws.shares is not null and ws.shares <= 0)
          or um.resolved_outcome is not null
          or (
            coalesce(um.close_time, um.expiration_time) is not null
            and coalesce(um.close_time, um.expiration_time) <= now()
          )
          or (um.status is not null and um.status <> 'ACTIVE')
        )
      order by
        ws.snapshot_at desc,
        ws.size_usd desc nulls last,
        ws.shares desc nulls last,
        coalesce(ue.title, um.title, ws.market_id) asc
      limit $2::int
    `,
    [walletId, Math.max(1, Math.trunc(limit))],
  );

  return rows.rows.map((row) => ({
    marketId: row.market_id,
    eventId: row.event_id,
    marketTitle: row.market_title,
    eventTitle: row.event_title,
    venue: row.venue,
    category: row.category,
    marketStatus: row.market_status,
    closeTime: row.close_time?.toISOString() ?? null,
    expirationTime: row.expiration_time?.toISOString() ?? null,
    resolvedOutcome: row.resolved_outcome,
    outcomeSide: row.outcome_side,
    shares: nullableNumber(row.shares),
    sizeUsd: nullableNumber(row.size_usd),
    entryPrice: nullableNumber(row.price),
    snapshotAt: row.snapshot_at?.toISOString() ?? null,
  }));
}
