import type { Pool } from "@hunch/infra";

import {
  buildClusterExecution,
  compareClusterExecution,
  type ClusterExecutionMarket,
  type ClusterExecutionSummary,
} from "./cluster-execution.js";
import { loadClusterMarketNativeQuotes } from "./cluster-execution-quotes.js";
import { verifyClusterExecutions } from "./cluster-execution-verifier.js";

export const CLUSTER_EXECUTION_MAX_MARKETS = 100;

type EnrichableCluster = {
  id: string;
  markets: ClusterExecutionMarket[];
  priceSpread: number | null;
  seedMarketId: string | null;
  totalLiquidity?: number | null;
  volume24h?: number | null;
};

export type ExecutionEnrichedCluster<T extends EnrichableCluster> = Omit<
  T,
  "markets"
> & {
  execution: ClusterExecutionSummary;
  markets: ClusterExecutionMarket[];
};

export async function enrichClusterExecutions<T extends EnrichableCluster>(
  pool: Pool,
  clusters: T[],
  now = new Date(),
): Promise<Array<ExecutionEnrichedCluster<T>>> {
  const boundedMarketIds = new Set<string>();
  for (const cluster of clusters) {
    const clusterIds = [
      ...new Set(cluster.markets.map((market) => market.marketId)),
    ].filter((marketId) => !boundedMarketIds.has(marketId));
    if (
      boundedMarketIds.size + clusterIds.length >
      CLUSTER_EXECUTION_MAX_MARKETS
    ) {
      continue;
    }
    for (const marketId of clusterIds) boundedMarketIds.add(marketId);
  }
  const nativeQuotes = await loadClusterMarketNativeQuotes(pool, [
    ...boundedMarketIds,
  ]);
  const enriched = clusters.map((cluster) => {
    const built = buildClusterExecution({
      cluster,
      nativeQuotesByMarketId: nativeQuotes,
      now,
    });
    return {
      ...cluster,
      execution: built.execution,
      markets: built.markets,
    };
  });
  const verified = await verifyClusterExecutions(pool, enriched, now);
  return verified.slice().sort(compareClusterExecution);
}
