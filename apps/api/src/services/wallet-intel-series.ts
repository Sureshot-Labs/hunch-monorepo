import type { PoolClient } from "pg";

export type WalletActivitySparklinePoint = {
  bucketStart: Date;
  netChangeUsd: number;
  grossChangeUsd: number;
  eventCount: number;
};

export type WalletActivitySparkline = {
  windowHours: number;
  bucketHours: number;
  points: WalletActivitySparklinePoint[];
};

export type WalletPerformanceSeriesPoint = {
  asOf: Date;
  pnlUsd: number | null;
  roi: number | null;
  volumeUsd: number | null;
  tradesCount: number | null;
  winRate: number | null;
  avgHoldHours: number | null;
  lastTradeAt: Date | null;
};

export type WalletPerformanceSeriesPeriod = "1d" | "7d" | "30d" | "all";

export type WalletPerformanceSeries = {
  period: WalletPerformanceSeriesPeriod;
  points: WalletPerformanceSeriesPoint[];
};

export type WalletPortfolioPerformance = {
  rangeHours: number;
  startAsOf: Date | null;
  endAsOf: Date | null;
  startPnlUsd: number | null;
  endPnlUsd: number | null;
  pnlUsd: number | null;
  baselineApprox: boolean;
};

export type WalletPortfolioPnlSeriesPoint = {
  asOf: Date;
  pnlUsd: number;
};

export type WalletPortfolioPnlSeries = {
  rangeHours: number;
  mode: "delta_from_start";
  baselineApprox: boolean;
  performance: WalletPortfolioPerformance | null;
  points: WalletPortfolioPnlSeriesPoint[];
};

type WalletActivitySparklineDbRow = {
  wallet_id: string;
  bucket_start: Date;
  net_change_usd: string | null;
  gross_change_usd: string | null;
  event_count: number | null;
};

type WalletPerformanceSeriesDbRow = {
  as_of: Date;
  pnl_usd: string | null;
  roi: string | null;
  volume_usd: string | null;
  trades_count: number | null;
  win_rate: string | null;
  avg_hold_hours: string | null;
  last_trade_at: Date | null;
};

type WalletPortfolioPerformanceDbRow = {
  wallet_id: string;
  start_as_of: Date | null;
  start_pnl_usd: string | null;
  end_as_of: Date | null;
  end_pnl_usd: string | null;
  baseline_approx: boolean | null;
};

function nullableNumber(
  value: string | number | null | undefined,
): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolvePortfolioPerformance(
  row: WalletPortfolioPerformanceDbRow,
  rangeHours: number,
): WalletPortfolioPerformance {
  const startPnlUsd = nullableNumber(row.start_pnl_usd);
  const endPnlUsd = nullableNumber(row.end_pnl_usd);
  return {
    rangeHours,
    startAsOf: row.start_as_of ?? null,
    endAsOf: row.end_as_of ?? null,
    startPnlUsd,
    endPnlUsd,
    pnlUsd:
      startPnlUsd != null && endPnlUsd != null ? endPnlUsd - startPnlUsd : null,
    baselineApprox: row.baseline_approx === true,
  };
}

export function resolveSparklineBucketHours(
  windowHours: number,
  requestedBucketHours?: number | null,
): number {
  const normalizedWindow = Math.max(1, Math.trunc(windowHours));
  if (requestedBucketHours != null) {
    const normalizedBucket = Math.max(1, Math.trunc(requestedBucketHours));
    return Math.min(normalizedWindow, normalizedBucket);
  }
  if (normalizedWindow <= 24) return 1;
  if (normalizedWindow <= 48) return 2;
  if (normalizedWindow <= 96) return 4;
  if (normalizedWindow <= 168) return 6;
  if (normalizedWindow <= 336) return 12;
  return 24;
}

export function buildEmptyWalletActivitySparkline(input: {
  windowHours: number;
  bucketHours?: number | null;
}): WalletActivitySparkline {
  const bucketHours = resolveSparklineBucketHours(
    input.windowHours,
    input.bucketHours,
  );
  return {
    windowHours: Math.max(1, Math.trunc(input.windowHours)),
    bucketHours,
    points: [],
  };
}

export async function fetchWalletActivitySparklines(
  client: PoolClient,
  walletIds: string[],
  input: {
    windowHours: number;
    bucketHours?: number | null;
    asOf?: Date;
  },
): Promise<Map<string, WalletActivitySparkline>> {
  const byWallet = new Map<string, WalletActivitySparkline>();
  if (walletIds.length === 0) return byWallet;

  const windowHours = Math.max(1, Math.trunc(input.windowHours));
  const bucketHours = resolveSparklineBucketHours(
    windowHours,
    input.bucketHours,
  );
  const asOf = input.asOf ?? new Date();
  const start = new Date(asOf.getTime() - windowHours * 60 * 60 * 1000);

  const rows = await client.query<WalletActivitySparklineDbRow>(
    `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      ),
      bucketed as (
        select
          wah.wallet_id,
          floor(
            extract(epoch from wah.hour_bucket) / ($4::int * 3600)
          )::bigint as bucket_index,
          sum(coalesce(wah.signed_delta_usd, 0)) as net_change_usd,
          sum(
            coalesce(wah.abs_delta_usd, abs(wah.signed_delta_usd), 0)
          ) as gross_change_usd,
          sum(coalesce(wah.event_count, 0))::int as event_count
        from wallet_activity_hourly wah
        join wallet_set ws on ws.wallet_id = wah.wallet_id
        where wah.activity_type in ('delta', 'trade')
          and wah.hour_bucket >= $2::timestamptz
          and wah.hour_bucket <= $3::timestamptz
        group by wah.wallet_id, bucket_index
      )
      select
        bucketed.wallet_id,
        timestamptz 'epoch'
          + (bucketed.bucket_index * $4::int * 3600) * interval '1 second'
            as bucket_start,
        bucketed.net_change_usd::text,
        bucketed.gross_change_usd::text,
        bucketed.event_count
      from bucketed
      order by bucketed.wallet_id, bucket_start
    `,
    [walletIds, start, asOf, bucketHours],
  );

  const bucketMs = bucketHours * 60 * 60 * 1000;
  const startBucketMs = Math.floor(start.getTime() / bucketMs) * bucketMs;
  const endBucketMs = Math.floor(asOf.getTime() / bucketMs) * bucketMs;
  const rowsByWallet = new Map<string, Map<number, WalletActivitySparklinePoint>>();

  for (const row of rows.rows) {
    const bucketStart = new Date(row.bucket_start);
    const bucketStartMs = bucketStart.getTime();
    const walletMap =
      rowsByWallet.get(row.wallet_id) ??
      new Map<number, WalletActivitySparklinePoint>();
    walletMap.set(bucketStartMs, {
      bucketStart,
      netChangeUsd: nullableNumber(row.net_change_usd) ?? 0,
      grossChangeUsd: nullableNumber(row.gross_change_usd) ?? 0,
      eventCount: row.event_count ?? 0,
    });
    rowsByWallet.set(row.wallet_id, walletMap);
  }

  for (const walletId of walletIds) {
    const walletRows = rowsByWallet.get(walletId) ?? new Map();
    const points: WalletActivitySparklinePoint[] = [];
    for (
      let bucketStartMs = startBucketMs;
      bucketStartMs <= endBucketMs;
      bucketStartMs += bucketMs
    ) {
      points.push(
        walletRows.get(bucketStartMs) ?? {
          bucketStart: new Date(bucketStartMs),
          netChangeUsd: 0,
          grossChangeUsd: 0,
          eventCount: 0,
        },
      );
    }
    byWallet.set(walletId, {
      windowHours,
      bucketHours,
      points,
    });
  }

  return byWallet;
}

export async function loadWalletPortfolioPerformanceMap(
  client: PoolClient,
  walletIds: string[],
  input: {
    rangeHours: number;
    asOf?: Date;
  },
): Promise<Map<string, WalletPortfolioPerformance>> {
  const byWallet = new Map<string, WalletPortfolioPerformance>();
  if (walletIds.length === 0) return byWallet;

  const rangeHours = Math.max(1, Math.trunc(input.rangeHours));
  const asOf = input.asOf ?? new Date();
  const rangeStart = new Date(asOf.getTime() - rangeHours * 60 * 60 * 1000);

  const rows = await client.query<WalletPortfolioPerformanceDbRow>(
    `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      )
      select
        ws.wallet_id,
        coalesce(ss.as_of, fs.as_of) as start_as_of,
        coalesce(ss.pnl_usd::text, fs.pnl_usd::text) as start_pnl_usd,
        es.as_of as end_as_of,
        es.pnl_usd::text as end_pnl_usd,
        (ss.as_of is null and fs.as_of is not null) as baseline_approx
      from wallet_set ws
      left join lateral (
        select
          s.as_of,
          s.pnl_usd
        from wallet_metrics_snapshots s
        where s.wallet_id = ws.wallet_id
          and s.period = 'all'
          and s.pnl_usd is not null
          and s.as_of <= $2::timestamptz
        order by s.as_of desc
        limit 1
      ) ss on true
      left join lateral (
        select
          s.as_of,
          s.pnl_usd
        from wallet_metrics_snapshots s
        where ss.as_of is null
          and s.wallet_id = ws.wallet_id
          and s.period = 'all'
          and s.pnl_usd is not null
          and s.as_of > $2::timestamptz
          and s.as_of <= $3::timestamptz
        order by s.as_of asc
        limit 1
      ) fs on true
      left join lateral (
        select
          s.as_of,
          s.pnl_usd
        from wallet_metrics_snapshots s
        where s.wallet_id = ws.wallet_id
          and s.period = 'all'
          and s.pnl_usd is not null
          and s.as_of <= $3::timestamptz
        order by s.as_of desc
        limit 1
      ) es on true
    `,
    [walletIds, rangeStart, asOf],
  );

  for (const row of rows.rows) {
    byWallet.set(
      row.wallet_id,
      resolvePortfolioPerformance(row, rangeHours),
    );
  }

  return byWallet;
}

export async function fetchWalletPerformanceSeries(
  client: PoolClient,
  walletId: string,
  input?: {
    period?: WalletPerformanceSeriesPeriod;
    limit?: number;
    windowHours?: number | null;
    bucketHours?: number | null;
    asOf?: Date;
  },
): Promise<WalletPerformanceSeries> {
  const period = input?.period ?? "30d";
  const limit = Math.max(1, Math.min(240, Math.trunc(input?.limit ?? 120)));
  const windowHours =
    input?.windowHours != null
      ? Math.max(1, Math.trunc(input.windowHours))
      : null;
  const bucketHours =
    windowHours != null
      ? resolveSparklineBucketHours(windowHours, input?.bucketHours)
      : null;
  const asOf = input?.asOf ?? new Date();

  const rows =
    windowHours != null && bucketHours != null
      ? await client.query<WalletPerformanceSeriesDbRow>(
          `
            with filtered as (
              select
                s.as_of,
                s.pnl_usd,
                s.roi,
                s.volume_usd,
                s.trades_count,
                s.win_rate,
                s.avg_hold_hours,
                s.last_trade_at,
                floor(
                  extract(epoch from s.as_of) / ($4::int * 3600)
                )::bigint as bucket_index
              from wallet_metrics_snapshots s
              where s.wallet_id = $1::uuid
                and s.period = $2::text
                and s.as_of >= $3::timestamptz
                and s.as_of <= $5::timestamptz
            ),
            bucketed as (
              select distinct on (bucket_index)
                as_of,
                pnl_usd,
                roi,
                volume_usd,
                trades_count,
                win_rate,
                avg_hold_hours,
                last_trade_at
              from filtered
              order by bucket_index, as_of desc
            ),
            limited as (
              select
                as_of,
                pnl_usd,
                roi,
                volume_usd,
                trades_count,
                win_rate,
                avg_hold_hours,
                last_trade_at
              from bucketed
              order by as_of desc
              limit $6
            )
            select
              as_of,
              pnl_usd::text,
              roi::text,
              volume_usd::text,
              trades_count,
              win_rate::text,
              avg_hold_hours::text,
              last_trade_at
            from limited
            order by as_of asc
          `,
          [
            walletId,
            period,
            new Date(asOf.getTime() - windowHours * 60 * 60 * 1000),
            bucketHours,
            asOf,
            limit,
          ],
        )
      : await client.query<WalletPerformanceSeriesDbRow>(
          `
            select
              s.as_of,
              s.pnl_usd::text,
              s.roi::text,
              s.volume_usd::text,
              s.trades_count,
              s.win_rate::text,
              s.avg_hold_hours::text,
              s.last_trade_at
            from (
              select
                as_of,
                pnl_usd,
                roi,
                volume_usd,
                trades_count,
                win_rate,
                avg_hold_hours,
                last_trade_at
              from wallet_metrics_snapshots
              where wallet_id = $1::uuid
                and period = $2::text
              order by as_of desc
              limit $3
            ) s
            order by s.as_of asc
          `,
          [walletId, period, limit],
        );

  return {
    period,
    points: rows.rows.map((row) => ({
      asOf: row.as_of,
      pnlUsd: nullableNumber(row.pnl_usd),
      roi: nullableNumber(row.roi),
      volumeUsd: nullableNumber(row.volume_usd),
      tradesCount: row.trades_count ?? null,
      winRate: nullableNumber(row.win_rate),
      avgHoldHours: nullableNumber(row.avg_hold_hours),
      lastTradeAt: row.last_trade_at,
    })),
  };
}

export async function fetchWalletPortfolioPnlSeries(
  client: PoolClient,
  walletId: string,
  input: {
    rangeHours: number;
    limit?: number;
    bucketHours?: number | null;
    asOf?: Date;
  },
): Promise<WalletPortfolioPnlSeries> {
  const rangeHours = Math.max(1, Math.trunc(input.rangeHours));
  const asOf = input.asOf ?? new Date();
  const windowStart = new Date(asOf.getTime() - rangeHours * 60 * 60 * 1000);

  const [portfolioPerformanceMap, rawSeries] = await Promise.all([
    loadWalletPortfolioPerformanceMap(client, [walletId], {
      rangeHours,
      asOf,
    }),
    fetchWalletPerformanceSeries(client, walletId, {
      period: "all",
      windowHours: rangeHours,
      bucketHours: input.bucketHours,
      limit: input.limit,
      asOf,
    }),
  ]);

  const performance = portfolioPerformanceMap.get(walletId) ?? null;
  const baselinePnlUsd = performance?.startPnlUsd ?? null;

  if (baselinePnlUsd == null) {
    return {
      rangeHours,
      mode: "delta_from_start",
      baselineApprox: performance?.baselineApprox ?? false,
      performance,
      points: [],
    };
  }

  const points: WalletPortfolioPnlSeriesPoint[] = rawSeries.points
    .filter((point) => point.pnlUsd != null && Number.isFinite(point.pnlUsd))
    .map((point) => ({
      asOf: point.asOf,
      pnlUsd: (point.pnlUsd ?? 0) - baselinePnlUsd,
    }));

  const syntheticStart =
    performance?.baselineApprox === true
      ? performance.startAsOf
      : windowStart;

  if (syntheticStart) {
    const firstPoint = points[0] ?? null;
    if (!firstPoint || firstPoint.asOf.getTime() !== syntheticStart.getTime()) {
      points.unshift({
        asOf: syntheticStart,
        pnlUsd: 0,
      });
    }
  }

  return {
    rangeHours,
    mode: "delta_from_start",
    baselineApprox: performance?.baselineApprox ?? false,
    performance,
    points,
  };
}
