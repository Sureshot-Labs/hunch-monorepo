import type { PoolClient } from "pg";

import {
  loadWalletPositionLedgerMap,
  makeWalletPositionLedgerKey,
  resolveApproxOpenEntryFromLedger,
} from "./wallet-position-ledger.js";
import { buildWalletIntelTrackableMarketSql } from "./wallet-intel-market-eligibility.js";

type Queryable = Pick<PoolClient, "query">;

const OPEN_POSITION_EPSILON = 1e-9;

export type WalletOpenPositionStats = {
  trackedExposureUsd: number | null;
  openPositionsCount: number;
  openMarketsCount: number;
  avgOpenPositionSizeUsd: number | null;
  avgOpenEntryPrice: number | null;
  avgOpenEntryApprox: boolean | null;
};

type OpenPositionSnapshotRow = {
  wallet_id: string;
  market_id: string;
  outcome_side: string | null;
  shares: string | null;
  size_usd: string | null;
  observed_price: string | null;
};

type WalletOpenPositionAccumulator = {
  entrySharesTotal: number;
  entryWeightedPriceTotal: number;
  exposureUsdTotal: number;
  measurablePositionCount: number;
  openEntryApprox: boolean;
  openEntryCount: number;
  openMarketIds: Set<string>;
  openPositionsCount: number;
};

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function createAccumulator(): WalletOpenPositionAccumulator {
  return {
    entrySharesTotal: 0,
    entryWeightedPriceTotal: 0,
    exposureUsdTotal: 0,
    measurablePositionCount: 0,
    openEntryApprox: false,
    openEntryCount: 0,
    openMarketIds: new Set<string>(),
    openPositionsCount: 0,
  };
}

export async function loadWalletOpenPositionStatsMap(
  client: Queryable,
  walletIds: string[],
): Promise<Map<string, WalletOpenPositionStats>> {
  const byWallet = new Map<string, WalletOpenPositionStats>();
  if (walletIds.length === 0) return byWallet;

  const { rows } = await client.query<OpenPositionSnapshotRow>(
    `
      with wallet_set as (
        select unnest($1::uuid[]) as wallet_id
      ),
      latest as (
        select
          wallet_set.wallet_id,
          latest_venue_snapshot.venue,
          latest_venue_snapshot.snapshot_at
        from wallet_set
        join lateral (
          select distinct on (ws.venue)
            ws.venue,
            ws.snapshot_at
          from wallet_position_snapshots ws
          where ws.wallet_id = wallet_set.wallet_id
          order by ws.venue, ws.snapshot_at desc
        ) latest_venue_snapshot on true
      ),
      latest_rows as (
        select
          ws.wallet_id,
          ws.market_id,
          case
            when ws.outcome_side in ('YES', 'NO')
              then ws.outcome_side
            else null
          end as outcome_side,
          greatest(coalesce(ws.shares, 0), 0) as shares,
          greatest(
            coalesce(
              ws.size_usd,
              abs(coalesce(ws.shares, 0) * coalesce(ws.price, 0)),
              0
            ),
            0
          ) as size_usd,
          case
            when ws.price is null then null
            when ws.price < 0 then 0::numeric
            when ws.price > 1 then least(1::numeric, ws.price / 100::numeric)
            else least(1::numeric, ws.price)
          end as observed_price,
          upper(coalesce(um.resolved_outcome::text, '')) as resolved_outcome,
          upper(coalesce(um.status::text, '')) as market_status,
          coalesce(um.close_time, um.expiration_time) as market_end_time
        from wallet_position_snapshots ws
        join latest l
          on l.wallet_id = ws.wallet_id
         and l.venue = ws.venue
         and l.snapshot_at = ws.snapshot_at
        left join unified_markets um on um.id = ws.market_id
        left join unified_events ue on ue.id = um.event_id
        where ${buildWalletIntelTrackableMarketSql({
          marketAlias: "um",
          eventAlias: "ue",
        })}
      )
      select
        wallet_id,
        market_id,
        outcome_side,
        shares::text as shares,
        size_usd::text as size_usd,
        observed_price::text as observed_price
      from latest_rows
      where (
        coalesce(shares, 0) > ${OPEN_POSITION_EPSILON}
        or coalesce(size_usd, 0) > 0
      )
        and resolved_outcome not in ('YES', 'NO')
    `,
    [walletIds],
  );

  const ledgerByKey = await loadWalletPositionLedgerMap(
    client,
    rows.map((row) => ({
      walletId: row.wallet_id,
      marketId: row.market_id,
      outcomeSide: row.outcome_side,
    })),
  );

  const accumulators = new Map<string, WalletOpenPositionAccumulator>();
  for (const row of rows) {
    const accumulator = accumulators.get(row.wallet_id) ?? createAccumulator();
    const shares = parseNumber(row.shares);
    const sizeUsd = parseNumber(row.size_usd);
    const observedPrice = parseNumber(row.observed_price);

    accumulator.openPositionsCount += 1;
    accumulator.openMarketIds.add(row.market_id);

    if (sizeUsd != null && Number.isFinite(sizeUsd) && sizeUsd > 0) {
      accumulator.exposureUsdTotal += sizeUsd;
      accumulator.measurablePositionCount += 1;
    }

    if (shares != null && shares > OPEN_POSITION_EPSILON) {
      const key = makeWalletPositionLedgerKey(
        row.wallet_id,
        row.market_id,
        row.outcome_side,
      );
      const openEntry = resolveApproxOpenEntryFromLedger({
        ledger: ledgerByKey.get(key) ?? null,
        observedPrice,
        snapshotShares: shares,
      });
      if (openEntry.entryPrice != null) {
        accumulator.entrySharesTotal += shares;
        accumulator.entryWeightedPriceTotal += openEntry.entryPrice * shares;
        accumulator.openEntryApprox ||= openEntry.approximate === true;
        accumulator.openEntryCount += 1;
      }
    }

    accumulators.set(row.wallet_id, accumulator);
  }

  for (const walletId of walletIds) {
    const accumulator = accumulators.get(walletId);
    if (!accumulator) {
      byWallet.set(walletId, {
        trackedExposureUsd: null,
        openPositionsCount: 0,
        openMarketsCount: 0,
        avgOpenPositionSizeUsd: null,
        avgOpenEntryPrice: null,
        avgOpenEntryApprox: null,
      });
      continue;
    }

    byWallet.set(walletId, {
      trackedExposureUsd:
        accumulator.exposureUsdTotal > 0 ? accumulator.exposureUsdTotal : null,
      openPositionsCount: accumulator.openPositionsCount,
      openMarketsCount: accumulator.openMarketIds.size,
      avgOpenPositionSizeUsd:
        accumulator.measurablePositionCount > 0
          ? accumulator.exposureUsdTotal / accumulator.measurablePositionCount
          : null,
      avgOpenEntryPrice:
        accumulator.entrySharesTotal > 0
          ? accumulator.entryWeightedPriceTotal / accumulator.entrySharesTotal
          : null,
      avgOpenEntryApprox:
        accumulator.openEntryCount > 0 ? accumulator.openEntryApprox : null,
    });
  }

  return byWallet;
}
