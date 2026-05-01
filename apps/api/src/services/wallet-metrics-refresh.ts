import type { PoolClient } from "pg";

import {
  buildSnapshotDeltaTrackableActivitySql,
} from "./wallet-intel-market-eligibility.js";
import { AGGREGATE_WALLET_METRICS_VENUE } from "./wallet-metrics-constants.js";
import {
  makeWalletPositionLedgerKey,
  replayWalletPositionLedgerRows,
  type WalletPositionLedgerRow,
} from "./wallet-position-ledger.js";
import { buildWalletThirtyDayMetricsUpsertRows } from "./wallet-metrics-30d.js";
import {
  NET_SHARES_EPSILON,
  resolveApproxYesMarkPrice,
} from "./wallet-intel-pnl.js";

type Queryable = Pick<PoolClient, "query">;

type WalletMetricsAggregateRow = {
  wallet_id: string;
  trades_count: number;
  volume_usd: string | null;
  last_trade_at: Date | null;
  resolved_count: number;
  winning_count: number;
};

type WalletMetricMarketRow = {
  id: string;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | null;
  best_ask: string | null;
  best_bid: string | null;
  last_price: string | null;
};

type WalletMetricMarketMark = {
  resolvedOutcome: string | null;
  yesMarkPrice: number | null;
};

type WalletMetricPeriod = "1d" | "7d" | "30d" | "all";

function parseNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function periodStart(asOf: Date, days: number | null): Date | null {
  if (days == null) return null;
  return new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000);
}

async function loadWalletMetricsAggregateRows(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
    since: Date | null;
  },
): Promise<WalletMetricsAggregateRow[]> {
  if (inputs.walletIds.length === 0) return [];

  const { rows } = await client.query<WalletMetricsAggregateRow>(
    `
      with base_events as (
        select
          wa.wallet_id,
          wa.market_id,
          upper(coalesce(wa.outcome_side, '')) as outcome_side,
          upper(coalesce(wa.action, '')) as action,
          coalesce(
            wa.size_usd,
            abs(coalesce(wa.delta_shares, 0)) * nullif(wa.price, 0)
          ) as notional_usd,
          wa.occurred_at
        from wallet_activity_events wa
        left join unified_markets m on m.id = wa.market_id
        left join unified_events e on e.id = m.event_id
        where wa.wallet_id = any($1::uuid[])
          and wa.activity_type in ('delta', 'trade')
          and wa.occurred_at <= $2::timestamptz
          and ($3::timestamptz is null or wa.occurred_at >= $3::timestamptz)
          and ${buildSnapshotDeltaTrackableActivitySql({
            activityAlias: "wa",
            marketAlias: "m",
            eventAlias: "e",
          })}
      )
      select
        b.wallet_id,
        count(*)::int as trades_count,
        sum(b.notional_usd) as volume_usd,
        max(b.occurred_at) as last_trade_at,
        count(*) filter (
          where upper(coalesce(um.resolved_outcome::text, '')) in ('YES', 'NO')
            and b.outcome_side in ('YES', 'NO')
            and b.action in ('OPENED', 'INCREASED', 'BUY', 'SELL')
        )::int as resolved_count,
        count(*) filter (
          where upper(coalesce(um.resolved_outcome::text, '')) in ('YES', 'NO')
            and b.outcome_side = upper(coalesce(um.resolved_outcome::text, ''))
            and b.action in ('OPENED', 'INCREASED', 'BUY', 'SELL')
        )::int as winning_count
      from base_events b
      left join unified_markets um on um.id = b.market_id
      group by b.wallet_id
    `,
    [inputs.walletIds, inputs.asOf, inputs.since],
  );

  return rows;
}

async function loadWalletMetricLedgerRows(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
    since: Date | null;
  },
): Promise<WalletPositionLedgerRow[]> {
  if (inputs.walletIds.length === 0) return [];

  const { rows } = await client.query<{
    wallet_id: string;
    market_id: string;
    outcome_side: string | null;
    action: string | null;
    delta_shares: string | null;
    size_usd: string | null;
    price: string | null;
    occurred_at: Date;
    created_at: Date | null;
    id: string;
  }>(
    `
      select
        wa.wallet_id,
        wa.market_id,
        upper(coalesce(wa.outcome_side, '')) as outcome_side,
        wa.action,
        wa.delta_shares::text as delta_shares,
        wa.size_usd::text as size_usd,
        wa.price::text as price,
        wa.occurred_at,
        wa.created_at,
        wa.id
      from wallet_activity_events wa
      left join unified_markets m on m.id = wa.market_id
      left join unified_events e on e.id = m.event_id
      where wa.wallet_id = any($1::uuid[])
        and wa.activity_type in ('delta', 'trade')
        and upper(coalesce(wa.outcome_side, '')) in ('YES', 'NO')
        and wa.occurred_at <= $2::timestamptz
        and ($3::timestamptz is null or wa.occurred_at >= $3::timestamptz)
        and ${buildSnapshotDeltaTrackableActivitySql({
          activityAlias: "wa",
          marketAlias: "m",
          eventAlias: "e",
        })}
      order by
        wa.wallet_id,
        wa.market_id,
        upper(coalesce(wa.outcome_side, '')),
        wa.occurred_at asc,
        wa.created_at asc nulls last,
        wa.id asc
    `,
    [inputs.walletIds, inputs.asOf, inputs.since],
  );

  return rows.map((row) => ({
    walletId: row.wallet_id,
    marketId: row.market_id,
    outcomeSide: row.outcome_side,
    action: row.action,
    deltaShares: row.delta_shares,
    sizeUsd: row.size_usd,
    price: row.price,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    id: row.id,
  }));
}

async function loadWalletMetricMarketMarkMap(
  client: Queryable,
  marketIds: string[],
): Promise<Map<string, WalletMetricMarketMark>> {
  const byMarket = new Map<string, WalletMetricMarketMark>();
  if (marketIds.length === 0) return byMarket;

  const { rows } = await client.query<WalletMetricMarketRow>(
    `
      select
        um.id,
        upper(coalesce(um.resolved_outcome::text, '')) as resolved_outcome,
        um.resolved_outcome_pct::text as resolved_outcome_pct,
        um.best_ask::text as best_ask,
        um.best_bid::text as best_bid,
        um.last_price::text as last_price
      from unified_markets um
      where um.id = any($1::text[])
    `,
    [marketIds],
  );

  for (const row of rows) {
    byMarket.set(row.id, {
      resolvedOutcome:
        row.resolved_outcome === "YES" || row.resolved_outcome === "NO"
          ? row.resolved_outcome
          : null,
      yesMarkPrice: resolveApproxYesMarkPrice({
        resolvedOutcome: row.resolved_outcome,
        resolvedOutcomePct: parseNumeric(row.resolved_outcome_pct),
        markPrice:
          parseNumeric(row.best_ask) ??
          parseNumeric(row.best_bid) ??
          parseNumeric(row.last_price),
      }),
    });
  }

  return byMarket;
}

async function refreshLedgerWindowMetrics(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
    period: WalletMetricPeriod;
    since: Date | null;
    logPrefix: string;
  },
): Promise<void> {
  const aggregates = await loadWalletMetricsAggregateRows(client, {
    walletIds: inputs.walletIds,
    asOf: inputs.asOf,
    since: inputs.since,
  });

  const ledgerRows = await loadWalletMetricLedgerRows(client, {
    walletIds: inputs.walletIds,
    asOf: inputs.asOf,
    since: inputs.since,
  });

  const ledgerRowsByKey = new Map<string, WalletPositionLedgerRow[]>();
  for (const row of ledgerRows) {
    const key = makeWalletPositionLedgerKey(
      row.walletId,
      row.marketId,
      row.outcomeSide,
    );
    const existing = ledgerRowsByKey.get(key) ?? [];
    existing.push(row);
    ledgerRowsByKey.set(key, existing);
  }

  const ledgersByWallet = new Map<
    string,
    Array<{
      marketId: string;
      outcomeSide: string | null;
      ledger: ReturnType<typeof replayWalletPositionLedgerRows>;
    }>
  >();
  const openMarketIds = new Set<string>();

  for (const rows of ledgerRowsByKey.values()) {
    const ledger = replayWalletPositionLedgerRows(rows);
    if (ledger.eventCount <= 0) continue;
    const first = rows[0];
    const existing = ledgersByWallet.get(first.walletId) ?? [];
    existing.push({
      marketId: first.marketId,
      outcomeSide: first.outcomeSide,
      ledger,
    });
    ledgersByWallet.set(first.walletId, existing);
    if (ledger.remainingShares > NET_SHARES_EPSILON) {
      openMarketIds.add(first.marketId);
    }
  }

  const marketMarksById = await loadWalletMetricMarketMarkMap(
    client,
    Array.from(openMarketIds),
  );

  const {
    rows: upsertRows,
    approximateWalletCount,
    unmarkedOpenLegCount,
  } = buildWalletThirtyDayMetricsUpsertRows({
    walletIds: inputs.walletIds,
    aggregates: aggregates.map((aggregate) => ({
      walletId: aggregate.wallet_id,
      tradesCount: aggregate.trades_count,
      volumeUsd: parseNumeric(aggregate.volume_usd),
      lastTradeAt: aggregate.last_trade_at,
      resolvedCount: aggregate.resolved_count,
      winningCount: aggregate.winning_count,
    })),
    ledgersByWallet,
    marketMarksById,
  });

  await client.query(
    `
      with upsert_rows as (
        select
          x.wallet_id::uuid as wallet_id,
          $2::text as period,
          $3::timestamptz as as_of,
          x.trades_count::int as trades_count,
          x.volume_usd::numeric as volume_usd,
          x.pnl_usd::numeric as pnl_usd,
          x.roi::numeric as roi,
          x.win_rate::numeric as win_rate,
          x.last_trade_at::timestamptz as last_trade_at
        from jsonb_to_recordset($1::jsonb) as x(
          wallet_id text,
          trades_count int,
          volume_usd text,
          pnl_usd text,
          roi text,
          win_rate text,
          last_trade_at text
        )
      )
      insert into wallet_metrics_snapshots (
        wallet_id,
        venue,
        period,
        as_of,
        trades_count,
        volume_usd,
        pnl_usd,
        roi,
        win_rate,
        last_trade_at
      )
      select
        u.wallet_id,
        $4::text,
        u.period,
        u.as_of,
        u.trades_count,
        u.volume_usd,
        u.pnl_usd,
        u.roi,
        u.win_rate,
        u.last_trade_at
      from upsert_rows u
      where not exists (
        select 1
        from wallet_metrics_snapshots existing_null
        where existing_null.wallet_id = u.wallet_id
          and existing_null.period = u.period
          and existing_null.as_of = u.as_of
          and existing_null.venue is null
      )
      or exists (
        select 1
        from wallet_metrics_snapshots existing_aggregate
        where existing_aggregate.wallet_id = u.wallet_id
          and existing_aggregate.period = u.period
          and existing_aggregate.as_of = u.as_of
          and existing_aggregate.venue = $4::text
      )
      on conflict (wallet_id, venue, period, as_of)
      do update set
        trades_count = excluded.trades_count,
        volume_usd = excluded.volume_usd,
        pnl_usd = excluded.pnl_usd,
        roi = excluded.roi,
        win_rate = excluded.win_rate,
        last_trade_at = excluded.last_trade_at,
        updated_at = now()
    `,
    [
      JSON.stringify(
        upsertRows.map((row) => ({
          wallet_id: row.walletId,
          trades_count: row.tradesCount,
          volume_usd:
            row.volumeUsd != null ? String(row.volumeUsd) : null,
          pnl_usd: row.pnlUsd != null ? String(row.pnlUsd) : null,
          roi: row.roi != null ? String(row.roi) : null,
          win_rate: row.winRate != null ? String(row.winRate) : null,
          last_trade_at: row.lastTradeAt?.toISOString() ?? null,
        })),
      ),
      inputs.period,
      inputs.asOf,
      AGGREGATE_WALLET_METRICS_VENUE,
    ],
  );

  if (approximateWalletCount > 0 || unmarkedOpenLegCount > 0) {
    console.warn(
      `${inputs.logPrefix} ${inputs.period} pnl uses approximate ledger replay`,
      {
        walletCount: upsertRows.length,
        approximateWalletCount,
        unmarkedOpenLegCount,
      },
    );
  }
}

export async function refreshWalletMetrics(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf: Date;
    logPrefix?: string;
  },
) {
  if (inputs.walletIds.length === 0) return;
  const logPrefix = inputs.logPrefix ?? "[wallets:metrics]";
  const periods: WalletMetricPeriod[] = ["1d", "7d", "30d", "all"];

  for (const period of periods) {
    await refreshLedgerWindowMetrics(client, {
      walletIds: inputs.walletIds,
      asOf: inputs.asOf,
      period,
      since:
        period === "1d"
          ? periodStart(inputs.asOf, 1)
          : period === "7d"
            ? periodStart(inputs.asOf, 7)
            : period === "30d"
              ? periodStart(inputs.asOf, 30)
              : null,
      logPrefix,
    });
  }
}
