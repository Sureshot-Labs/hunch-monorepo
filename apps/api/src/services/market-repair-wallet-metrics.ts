import type { PoolClient } from "pg";

import { refreshWalletMetrics } from "./wallet-metrics-refresh.js";

export type RepairCountRow = {
  label: string;
  rows: string;
};

export type RepairMarketRef = {
  marketId: string;
  venue?: string | null;
};

type DbPool = {
  connect(): Promise<PoolClient>;
};

const WALLET_METRICS_BATCH_SIZE = 250;

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function normalizeMarketRefs(inputs: {
  marketIds?: string[];
  marketRefs?: RepairMarketRef[];
}): RepairMarketRef[] {
  const marketRefs: RepairMarketRef[] = [
    ...(inputs.marketRefs ?? []),
    ...(inputs.marketIds ?? []).map((marketId) => ({ marketId })),
  ];
  const seen = new Set<string>();
  const normalized: RepairMarketRef[] = [];

  for (const ref of marketRefs) {
    const marketId = ref.marketId.trim();
    if (!marketId) continue;
    const venue = ref.venue?.trim().toLowerCase() || null;
    const key = `${venue ?? ""}:${marketId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ marketId, venue });
  }

  return normalized;
}

async function loadWalletIdsForMarketRefs(
  client: PoolClient,
  marketRefs: RepairMarketRef[],
): Promise<string[]> {
  if (marketRefs.length === 0) return [];

  const venueRefs = marketRefs.filter((ref) => ref.venue);
  const noVenueMarketIds = marketRefs
    .filter((ref) => !ref.venue)
    .map((ref) => ref.marketId);
  const { rows } = await client.query<{ wallet_id: string }>(
    `
      with venue_refs as (
        select distinct market_id, venue
        from jsonb_to_recordset($1::jsonb) as ref(market_id text, venue text)
        where market_id is not null
          and market_id <> ''
          and venue is not null
          and venue <> ''
      ),
      no_venue_refs as (
        select distinct market_id
        from unnest($2::text[]) as ref(market_id)
        where market_id is not null
          and market_id <> ''
      )
      select distinct wallet_id::text as wallet_id
      from (
        select snapshots.wallet_id
        from venue_refs refs
        join wallet_position_snapshots snapshots
          on snapshots.venue = refs.venue
         and snapshots.market_id = refs.market_id
        union
        select activity.wallet_id
        from venue_refs refs
        join wallet_activity_events activity
          on activity.venue = refs.venue
         and activity.market_id = refs.market_id
        union
        select snapshots.wallet_id
        from no_venue_refs refs
        join wallet_position_snapshots snapshots
          on snapshots.market_id = refs.market_id
        union
        select activity.wallet_id
        from no_venue_refs refs
        join wallet_activity_events activity
          on activity.market_id = refs.market_id
      ) wallets
      order by wallet_id
    `,
    [JSON.stringify(venueRefs), noVenueMarketIds],
  );
  return rows.map((row) => row.wallet_id);
}

export async function refreshWalletMetricsForMarkets(
  db: DbPool,
  inputs: {
    enabled: boolean;
    logPrefix: string;
    marketIds?: string[];
    marketRefs?: RepairMarketRef[];
    statementTimeoutSec: number;
  },
): Promise<RepairCountRow[]> {
  const marketRefs = normalizeMarketRefs(inputs);
  if (!inputs.enabled || marketRefs.length === 0) return [];

  const client = await db.connect();
  let walletCount = 0;
  try {
    await client.query("select set_config('statement_timeout', $1, false)", [
      `${inputs.statementTimeoutSec}s`,
    ]);
    const walletIds = await loadWalletIdsForMarketRefs(client, marketRefs);
    if (walletIds.length === 0) {
      return [{ label: "wallet_metrics_wallets", rows: "0" }];
    }
    walletCount = walletIds.length;

    for (const batch of chunkArray(walletIds, WALLET_METRICS_BATCH_SIZE)) {
      await refreshWalletMetrics(client, {
        walletIds: batch,
        asOf: new Date(),
        logPrefix: inputs.logPrefix,
      });
    }
    await client.query("select refresh_wallet_intel_selector_snapshot()");
  } finally {
    await client.query("reset statement_timeout").catch(() => {});
    client.release();
  }

  return [
    { label: "wallet_metrics_wallets", rows: String(walletCount) },
    { label: "wallet_intel_selector_snapshot", rows: "1" },
  ];
}
