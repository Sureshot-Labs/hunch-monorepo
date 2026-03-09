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

function nullableNumber(
  value: string | number | null | undefined,
): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

export async function fetchWalletPerformanceSeries(
  client: PoolClient,
  walletId: string,
  input?: {
    period?: WalletPerformanceSeriesPeriod;
    limit?: number;
  },
): Promise<WalletPerformanceSeries> {
  const period = input?.period ?? "30d";
  const limit = Math.max(1, Math.min(240, Math.trunc(input?.limit ?? 120)));

  const rows = await client.query<WalletPerformanceSeriesDbRow>(
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
