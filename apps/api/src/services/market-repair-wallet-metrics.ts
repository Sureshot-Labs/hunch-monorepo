import type { PoolClient } from "pg";

import { refreshWalletMetrics } from "./wallet-metrics-refresh.js";

export type RepairCountRow = {
  label: string;
  rows: string;
};

type DbPool = {
  connect(): Promise<PoolClient>;
  query: PoolClient["query"];
};

const WALLET_METRICS_BATCH_SIZE = 250;

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function loadWalletIdsForMarkets(
  db: Pick<DbPool, "query">,
  marketIds: string[],
): Promise<string[]> {
  if (marketIds.length === 0) return [];
  const { rows } = await db.query<{ wallet_id: string }>(
    `
      select distinct wallet_id::text as wallet_id
      from (
        select wallet_id
        from wallet_position_snapshots
        where market_id = any($1::text[])
        union
        select wallet_id
        from wallet_activity_events
        where market_id = any($1::text[])
      ) wallets
      order by wallet_id
    `,
    [marketIds],
  );
  return rows.map((row) => row.wallet_id);
}

export async function refreshWalletMetricsForMarkets(
  db: DbPool,
  inputs: {
    enabled: boolean;
    logPrefix: string;
    marketIds: string[];
    statementTimeoutSec: number;
  },
): Promise<RepairCountRow[]> {
  if (!inputs.enabled || inputs.marketIds.length === 0) return [];

  const walletIds = await loadWalletIdsForMarkets(db, inputs.marketIds);
  if (walletIds.length === 0) {
    return [{ label: "wallet_metrics_wallets", rows: "0" }];
  }

  const client = await db.connect();
  try {
    await client.query("select set_config('statement_timeout', $1, false)", [
      `${inputs.statementTimeoutSec}s`,
    ]);
    for (const batch of chunkArray(walletIds, WALLET_METRICS_BATCH_SIZE)) {
      await refreshWalletMetrics(client, {
        walletIds: batch,
        asOf: new Date(),
        logPrefix: inputs.logPrefix,
      });
    }
    await client.query("select refresh_wallet_intel_selector_snapshot()");
  } finally {
    client.release();
  }

  return [
    { label: "wallet_metrics_wallets", rows: String(walletIds.length) },
    { label: "wallet_intel_selector_snapshot", rows: "1" },
  ];
}
