import {
  computeWalletLedgerApproxMetricTotals,
  type WalletPositionLedgerState,
} from "./wallet-position-ledger.js";
import { NET_SHARES_EPSILON } from "./wallet-intel-pnl.js";

export type WalletMetricsAggregateInput = {
  walletId: string;
  tradesCount: number;
  volumeUsd: number | null;
  lastTradeAt: Date | null;
  resolvedCount: number;
  winningCount: number;
};

export type WalletMetricMarkInput = {
  resolvedOutcome: string | null;
  yesMarkPrice: number | null;
};

export type WalletThirtyDayLedgerEntry = {
  marketId: string;
  outcomeSide: string | null;
  ledger: WalletPositionLedgerState;
};

export type WalletThirtyDayMetricsUpsertRow = {
  walletId: string;
  tradesCount: number;
  volumeUsd: number | null;
  pnlUsd: number | null;
  roi: number | null;
  winRate: number | null;
  lastTradeAt: Date | null;
  approximate: boolean;
  unmarkedOpenLegCount: number;
};

export type WalletThirtyDayMetricsBuildResult = {
  rows: WalletThirtyDayMetricsUpsertRow[];
  approximateWalletCount: number;
  unmarkedOpenLegCount: number;
};

export function buildWalletThirtyDayMetricsUpsertRows(input: {
  walletIds: string[];
  aggregates: WalletMetricsAggregateInput[];
  ledgersByWallet: Map<string, WalletThirtyDayLedgerEntry[]>;
  marketMarksById: Map<string, WalletMetricMarkInput>;
}): WalletThirtyDayMetricsBuildResult {
  const aggregateByWalletId = new Map(
    input.aggregates.map((aggregate) => [aggregate.walletId, aggregate] as const),
  );

  let approximateWalletCount = 0;
  let unmarkedOpenLegCount = 0;

  const rows = input.walletIds.map<WalletThirtyDayMetricsUpsertRow>((walletId) => {
    const aggregate = aggregateByWalletId.get(walletId) ?? null;
    const walletLedgers = input.ledgersByWallet.get(walletId) ?? [];
    const totals = computeWalletLedgerApproxMetricTotals(
      walletLedgers.map((entry) => ({
        outcomeSide: entry.outcomeSide,
        ledger: entry.ledger,
        resolvedOutcome: input.marketMarksById.get(entry.marketId)?.resolvedOutcome ?? null,
        yesMarkPrice: input.marketMarksById.get(entry.marketId)?.yesMarkPrice ?? null,
      })),
    );

    if (totals.approximate) approximateWalletCount += 1;
    unmarkedOpenLegCount += totals.unmarkedOpenLegCount;

    const pnlUsd = totals.pnlUsd;
    const roi =
      pnlUsd != null &&
      totals.costBasisUsd != null &&
      totals.costBasisUsd > NET_SHARES_EPSILON
        ? pnlUsd / totals.costBasisUsd
        : null;
    const winRate =
      aggregate != null && aggregate.resolvedCount > 0
        ? aggregate.winningCount / aggregate.resolvedCount
        : null;

    return {
      walletId,
      tradesCount: aggregate?.tradesCount ?? 0,
      volumeUsd: aggregate == null ? 0 : aggregate.volumeUsd,
      pnlUsd,
      roi,
      winRate,
      lastTradeAt: aggregate?.lastTradeAt ?? null,
      approximate: totals.approximate,
      unmarkedOpenLegCount: totals.unmarkedOpenLegCount,
    };
  });

  return {
    rows,
    approximateWalletCount,
    unmarkedOpenLegCount,
  };
}
