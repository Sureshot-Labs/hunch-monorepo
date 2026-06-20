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
  resolvedYesPayout: number | null;
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
  resolvedEdgeSampleCount: number;
  resolvedActualWinRate: number | null;
  resolvedExpectedWinRate: number | null;
  resolvedWinRateEdge: number | null;
  resolvedEdgeZScore: number | null;
  resolvedBrierScore: number | null;
  resolvedStakeWeightedEdge: number | null;
  resolvedStakeUsd: number | null;
  lastTradeAt: Date | null;
  approximate: boolean;
  unmarkedOpenLegCount: number;
};

export type WalletThirtyDayMetricsBuildResult = {
  rows: WalletThirtyDayMetricsUpsertRow[];
  approximateWalletCount: number;
  unmarkedOpenLegCount: number;
};

const METRIC_EPSILON = 1e-9;

function normalizeProbability(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const normalized = value > 1 && value <= 100 ? value / 100 : value;
  if (!Number.isFinite(normalized)) return null;
  return Math.max(0, Math.min(1, normalized));
}

function resolveSidePayout(
  outcomeSide: string | null | undefined,
  resolvedYesPayout: number | null | undefined,
): number | null {
  const yesPayout = normalizeProbability(resolvedYesPayout);
  if (yesPayout == null) return null;
  const side = outcomeSide?.trim().toUpperCase();
  if (side === "YES") return yesPayout;
  if (side === "NO") return 1 - yesPayout;
  return null;
}

export type WalletResolvedEdgeMetrics = {
  sampleCount: number;
  actualWinRate: number | null;
  expectedWinRate: number | null;
  winRateEdge: number | null;
  edgeZScore: number | null;
  brierScore: number | null;
  stakeWeightedEdge: number | null;
  resolvedStakeUsd: number | null;
};

export function computeWalletResolvedEdgeMetrics(
  entries: WalletThirtyDayLedgerEntry[],
  marketMarksById: Map<string, WalletMetricMarkInput>,
): WalletResolvedEdgeMetrics {
  let sampleCount = 0;
  let actualTotal = 0;
  let expectedTotal = 0;
  let varianceTotal = 0;
  let brierTotal = 0;
  let stakeUsd = 0;
  let stakeWeightedEdgeTotal = 0;

  for (const entry of entries) {
    const ledger = entry.ledger;
    if (!ledger || ledger.buyShares <= NET_SHARES_EPSILON) continue;
    if (ledger.buyCostUsd <= METRIC_EPSILON) continue;

    const mark = marketMarksById.get(entry.marketId);
    const actual = resolveSidePayout(
      entry.outcomeSide,
      mark?.resolvedYesPayout ?? null,
    );
    if (actual == null) continue;

    const expected = normalizeProbability(ledger.buyCostUsd / ledger.buyShares);
    if (expected == null) continue;

    const stake = Math.max(0, ledger.buyCostUsd);
    const edge = actual - expected;

    sampleCount += 1;
    actualTotal += actual;
    expectedTotal += expected;
    varianceTotal += expected * (1 - expected);
    brierTotal += edge * edge;
    stakeUsd += stake;
    stakeWeightedEdgeTotal += edge * stake;
  }

  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      actualWinRate: null,
      expectedWinRate: null,
      winRateEdge: null,
      edgeZScore: null,
      brierScore: null,
      stakeWeightedEdge: null,
      resolvedStakeUsd: null,
    };
  }

  const actualWinRate = actualTotal / sampleCount;
  const expectedWinRate = expectedTotal / sampleCount;
  const winRateEdge = actualWinRate - expectedWinRate;

  return {
    sampleCount,
    actualWinRate,
    expectedWinRate,
    winRateEdge,
    edgeZScore:
      varianceTotal > METRIC_EPSILON
        ? (actualTotal - expectedTotal) / Math.sqrt(varianceTotal)
        : null,
    brierScore: brierTotal / sampleCount,
    stakeWeightedEdge:
      stakeUsd > METRIC_EPSILON ? stakeWeightedEdgeTotal / stakeUsd : null,
    resolvedStakeUsd: stakeUsd > METRIC_EPSILON ? stakeUsd : null,
  };
}

export function buildWalletThirtyDayMetricsUpsertRows(input: {
  walletIds: string[];
  aggregates: WalletMetricsAggregateInput[];
  ledgersByWallet: Map<string, WalletThirtyDayLedgerEntry[]>;
  marketMarksById: Map<string, WalletMetricMarkInput>;
}): WalletThirtyDayMetricsBuildResult {
  const aggregateByWalletId = new Map(
    input.aggregates.map(
      (aggregate) => [aggregate.walletId, aggregate] as const,
    ),
  );

  let approximateWalletCount = 0;
  let unmarkedOpenLegCount = 0;

  const rows = input.walletIds.map<WalletThirtyDayMetricsUpsertRow>(
    (walletId) => {
      const aggregate = aggregateByWalletId.get(walletId) ?? null;
      const walletLedgers = input.ledgersByWallet.get(walletId) ?? [];
      const totals = computeWalletLedgerApproxMetricTotals(
        walletLedgers.map((entry) => ({
          outcomeSide: entry.outcomeSide,
          ledger: entry.ledger,
          resolvedOutcome:
            input.marketMarksById.get(entry.marketId)?.resolvedOutcome ?? null,
          yesMarkPrice:
            input.marketMarksById.get(entry.marketId)?.yesMarkPrice ?? null,
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
      const resolvedEdgeMetrics = computeWalletResolvedEdgeMetrics(
        walletLedgers,
        input.marketMarksById,
      );

      return {
        walletId,
        tradesCount: aggregate?.tradesCount ?? 0,
        volumeUsd: aggregate == null ? 0 : aggregate.volumeUsd,
        pnlUsd,
        roi,
        winRate,
        resolvedEdgeSampleCount: resolvedEdgeMetrics.sampleCount,
        resolvedActualWinRate: resolvedEdgeMetrics.actualWinRate,
        resolvedExpectedWinRate: resolvedEdgeMetrics.expectedWinRate,
        resolvedWinRateEdge: resolvedEdgeMetrics.winRateEdge,
        resolvedEdgeZScore: resolvedEdgeMetrics.edgeZScore,
        resolvedBrierScore: resolvedEdgeMetrics.brierScore,
        resolvedStakeWeightedEdge: resolvedEdgeMetrics.stakeWeightedEdge,
        resolvedStakeUsd: resolvedEdgeMetrics.resolvedStakeUsd,
        lastTradeAt: aggregate?.lastTradeAt ?? null,
        approximate: totals.approximate,
        unmarkedOpenLegCount: totals.unmarkedOpenLegCount,
      };
    },
  );

  return {
    rows,
    approximateWalletCount,
    unmarkedOpenLegCount,
  };
}
