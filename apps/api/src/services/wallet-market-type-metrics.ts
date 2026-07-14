import type { PoolClient } from "pg";

import {
  classifyMarketSegment,
  classifyMarketType,
  type MarketSegment,
  type MarketType,
} from "./market-type-classifier.js";
import { buildSnapshotDeltaTrackableActivitySql } from "./wallet-intel-market-eligibility.js";
import { isWalletFinalOutcomeSampleAction } from "./wallet-final-outcome-samples.js";
import {
  NET_SHARES_EPSILON,
  resolveApproxYesMarkPrice,
} from "./wallet-intel-pnl.js";
import { buildWalletThirtyDayMetricsUpsertRows } from "./wallet-metrics-30d.js";
import {
  makeWalletPositionLedgerKey,
  replayWalletPositionLedgerRows,
  type WalletPositionLedgerRow,
} from "./wallet-position-ledger.js";

type Queryable = Pick<PoolClient, "query">;

export type WalletMarketTypeMetric = {
  walletId: string;
  marketType: MarketType;
  period: "30d";
  asOf: string;
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
  lastTradeAt: string | null;
  approximate: boolean;
  unmarkedOpenLegCount: number;
};

export type WalletMarketSegmentMetric = WalletMarketTypeMetric & {
  marketSegment: MarketSegment;
};

export type WalletTaxonomyRequirement = {
  walletId: string;
  marketType: MarketType;
  marketSegment: MarketSegment;
};

export type WalletTaxonomyLoadDiagnostics = {
  requestedWallets: number;
  hourlyCandidatePairs: number;
  selectedExactPairs: number;
  rawRowsReturned: number;
  sqlDurationMs: number;
  totalEnrichmentDurationMs: number;
};

type WalletMarketTypeActivityRow = {
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
  market_category: string | null;
  event_category: string | null;
  series_key: string | null;
  series_title: string | null;
  event_title: string | null;
  market_title: string | null;
  close_time: Date | null;
  expiration_time: Date | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | null;
  best_ask: string | null;
  best_bid: string | null;
  last_price: string | null;
};

type WalletTaxonomyCandidatePair = Pick<
  WalletMarketTypeActivityRow,
  | "wallet_id"
  | "market_id"
  | "market_category"
  | "event_category"
  | "series_key"
  | "series_title"
  | "event_title"
  | "market_title"
  | "close_time"
  | "expiration_time"
>;

type MetricAggregate = {
  walletId: string;
  tradesCount: number;
  volumeUsd: number;
  lastTradeAt: Date | null;
  resolvedCount: number;
  winningCount: number;
};

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function periodStart(asOf: Date, days: number): Date {
  return new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000);
}

function keyFor(walletId: string, marketClass: string): string {
  return `${walletId}:${marketClass}`;
}

export function makeWalletMarketTypeMetricKey(
  walletId: string,
  marketType: MarketType,
): string {
  return keyFor(walletId, marketType);
}

export function makeWalletMarketSegmentMetricKey(
  walletId: string,
  marketSegment: MarketSegment,
): string {
  return keyFor(walletId, marketSegment);
}

function rowMarketType(row: WalletMarketTypeActivityRow, asOf: Date) {
  return classifyMarketType(
    {
      category: row.market_category ?? row.event_category,
      seriesKey: row.series_key,
      seriesTitle: row.series_title,
      eventTitle: row.event_title,
      marketTitle: row.market_title,
      closeTime: row.close_time,
      expirationTime: row.expiration_time,
    },
    asOf,
  );
}

function rowMarketSegment(row: WalletMarketTypeActivityRow, asOf: Date) {
  return classifyMarketSegment(
    {
      category: row.market_category ?? row.event_category,
      seriesKey: row.series_key,
      seriesTitle: row.series_title,
      eventTitle: row.event_title,
      marketTitle: row.market_title,
      closeTime: row.close_time,
      expirationTime: row.expiration_time,
    },
    asOf,
  );
}

function notionalUsd(row: WalletMarketTypeActivityRow): number {
  const size = nullableNumber(row.size_usd);
  if (size != null) return Math.abs(size);
  const deltaShares = nullableNumber(row.delta_shares);
  const price = nullableNumber(row.price);
  if (deltaShares == null || price == null) return 0;
  return Math.abs(deltaShares) * Math.abs(price);
}

function metricMarkFromRow(row: WalletMarketTypeActivityRow) {
  const resolvedOutcome =
    row.resolved_outcome?.toUpperCase() === "YES" ||
    row.resolved_outcome?.toUpperCase() === "NO"
      ? row.resolved_outcome.toUpperCase()
      : null;
  const resolvedOutcomePct = nullableNumber(row.resolved_outcome_pct);
  const yesMarkPrice = resolveApproxYesMarkPrice({
    resolvedOutcome: row.resolved_outcome,
    resolvedOutcomePct,
    markPrice:
      nullableNumber(row.best_ask) ??
      nullableNumber(row.best_bid) ??
      nullableNumber(row.last_price),
  });
  return {
    resolvedOutcome,
    yesMarkPrice,
    resolvedYesPayout:
      resolvedOutcome != null || resolvedOutcomePct != null
        ? yesMarkPrice
        : null,
  };
}

export async function loadWalletMarketTypeMetricsMap(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf?: Date;
    periodDays?: number;
  },
): Promise<Map<string, WalletMarketTypeMetric>> {
  return loadWalletClassifiedMetricsMap(client, inputs, "marketType");
}

export async function loadWalletMarketSegmentMetricsMap(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf?: Date;
    periodDays?: number;
  },
): Promise<Map<string, WalletMarketSegmentMetric>> {
  return loadWalletClassifiedMetricsMap(
    client,
    inputs,
    "marketSegment",
  ) as Promise<Map<string, WalletMarketSegmentMetric>>;
}

export async function loadWalletMarketTaxonomyMetricsMaps(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf?: Date;
    periodDays?: number;
    requirements?: WalletTaxonomyRequirement[];
  },
): Promise<{
  marketSegmentMetricsByKey: Map<string, WalletMarketSegmentMetric>;
  marketTypeMetricsByKey: Map<string, WalletMarketTypeMetric>;
  diagnostics: WalletTaxonomyLoadDiagnostics;
}> {
  const startedAt = performance.now();
  const walletIds = Array.from(new Set(inputs.walletIds));
  const emptyDiagnostics = (): WalletTaxonomyLoadDiagnostics => ({
    requestedWallets: walletIds.length,
    hourlyCandidatePairs: 0,
    selectedExactPairs: 0,
    rawRowsReturned: 0,
    sqlDurationMs: 0,
    totalEnrichmentDurationMs: performance.now() - startedAt,
  });
  if (walletIds.length === 0) {
    return {
      marketSegmentMetricsByKey: new Map(),
      marketTypeMetricsByKey: new Map(),
      diagnostics: emptyDiagnostics(),
    };
  }

  const asOf = inputs.asOf ?? new Date();
  const since = periodStart(asOf, Math.max(1, inputs.periodDays ?? 30));
  let hourlyCandidatePairs = 0;
  let selectedExactPairs = 0;
  let sqlDurationMs = 0;
  let rows: WalletMarketTypeActivityRow[];
  if (inputs.requirements) {
    if (inputs.requirements.length === 0) {
      return {
        marketSegmentMetricsByKey: new Map(),
        marketTypeMetricsByKey: new Map(),
        diagnostics: emptyDiagnostics(),
      };
    }
    const hourlyStartedAt = performance.now();
    const candidatePairs = await loadWalletTaxonomyCandidatePairs(
      client,
      walletIds,
      asOf,
      since,
    );
    sqlDurationMs += performance.now() - hourlyStartedAt;
    hourlyCandidatePairs = candidatePairs.length;
    const exactPairs = selectWalletTaxonomyExactPairs({
      candidatePairs,
      requirements: inputs.requirements,
      asOf,
    });
    selectedExactPairs = exactPairs.length;
    if (exactPairs.length === 0) {
      return {
        marketSegmentMetricsByKey: new Map(),
        marketTypeMetricsByKey: new Map(),
        diagnostics: {
          ...emptyDiagnostics(),
          hourlyCandidatePairs,
          sqlDurationMs,
        },
      };
    }
    const rawStartedAt = performance.now();
    rows = await loadWalletMarketTypeActivityRowsForPairs(
      client,
      exactPairs,
      asOf,
      since,
    );
    sqlDurationMs += performance.now() - rawStartedAt;
  } else {
    const rawStartedAt = performance.now();
    rows = await loadWalletMarketTypeActivityRows(
      client,
      walletIds,
      asOf,
      since,
    );
    sqlDurationMs += performance.now() - rawStartedAt;
  }
  return {
    marketSegmentMetricsByKey: buildWalletClassifiedMetricsMapFromRows(
      rows,
      asOf,
      "marketSegment",
    ) as Map<string, WalletMarketSegmentMetric>,
    marketTypeMetricsByKey: buildWalletClassifiedMetricsMapFromRows(
      rows,
      asOf,
      "marketType",
    ),
    diagnostics: {
      requestedWallets: walletIds.length,
      hourlyCandidatePairs,
      selectedExactPairs,
      rawRowsReturned: rows.length,
      sqlDurationMs,
      totalEnrichmentDurationMs: performance.now() - startedAt,
    },
  };
}

export function selectWalletTaxonomyExactPairs(inputs: {
  candidatePairs: WalletTaxonomyCandidatePair[];
  requirements: WalletTaxonomyRequirement[];
  asOf: Date;
}): Array<{ walletId: string; marketId: string }> {
  const requirementsByWallet = new Map<
    string,
    Array<Pick<WalletTaxonomyRequirement, "marketType" | "marketSegment">>
  >();
  for (const requirement of inputs.requirements) {
    const existing = requirementsByWallet.get(requirement.walletId) ?? [];
    existing.push(requirement);
    requirementsByWallet.set(requirement.walletId, existing);
  }

  const selected = new Map<string, { walletId: string; marketId: string }>();
  for (const pair of inputs.candidatePairs) {
    const requirements = requirementsByWallet.get(pair.wallet_id) ?? [];
    if (requirements.length === 0) continue;
    const marketType = rowMarketType(
      pair as WalletMarketTypeActivityRow,
      inputs.asOf,
    );
    const marketSegment = rowMarketSegment(
      pair as WalletMarketTypeActivityRow,
      inputs.asOf,
    );
    if (
      !requirements.some(
        (requirement) =>
          requirement.marketType === marketType ||
          requirement.marketSegment === marketSegment,
      )
    ) {
      continue;
    }
    selected.set(`${pair.wallet_id}:${pair.market_id}`, {
      walletId: pair.wallet_id,
      marketId: pair.market_id,
    });
  }
  return Array.from(selected.values());
}

async function loadWalletTaxonomyCandidatePairs(
  client: Queryable,
  walletIds: string[],
  asOf: Date,
  since: Date,
): Promise<WalletTaxonomyCandidatePair[]> {
  const { rows } = await client.query<WalletTaxonomyCandidatePair>(
    `
      with hourly_pairs as materialized (
        select distinct wah.wallet_id, wah.market_id
        from wallet_activity_hourly wah
        where wah.wallet_id = any($1::uuid[])
          and wah.activity_type in ('delta', 'trade')
          and wah.hour_bucket >= date_trunc('hour', $3::timestamptz)
          and wah.hour_bucket <= $2::timestamptz
      )
      select
        hp.wallet_id,
        hp.market_id,
        um.category as market_category,
        ue.category as event_category,
        ue.series_key,
        ue.series_title,
        ue.title as event_title,
        um.title as market_title,
        um.close_time,
        um.expiration_time
      from hourly_pairs hp
      left join unified_markets um on um.id = hp.market_id
      left join unified_events ue on ue.id = um.event_id
    `,
    [walletIds, asOf, since],
  );
  return rows;
}

async function loadWalletMarketTypeActivityRowsForPairs(
  client: Queryable,
  pairs: Array<{ walletId: string; marketId: string }>,
  asOf: Date,
  since: Date,
): Promise<WalletMarketTypeActivityRow[]> {
  const { rows } = await client.query<WalletMarketTypeActivityRow>(
    `
      with requested_pairs as materialized (
        select wallet_id, market_id
        from unnest($1::uuid[], $2::text[]) as requested(wallet_id, market_id)
      )
      select
        wa.wallet_id,
        wa.market_id,
        wa.outcome_side,
        wa.action,
        wa.delta_shares::text as delta_shares,
        wa.size_usd::text as size_usd,
        wa.price::text as price,
        wa.occurred_at,
        wa.created_at,
        wa.id,
        um.category as market_category,
        ue.category as event_category,
        ue.series_key,
        ue.series_title,
        ue.title as event_title,
        um.title as market_title,
        um.close_time,
        um.expiration_time,
        upper(coalesce(um.resolved_outcome::text, '')) as resolved_outcome,
        um.resolved_outcome_pct::text as resolved_outcome_pct,
        um.best_ask::text as best_ask,
        um.best_bid::text as best_bid,
        um.last_price::text as last_price
      from requested_pairs requested
      join wallet_activity_events wa
        on wa.wallet_id = requested.wallet_id
       and wa.market_id = requested.market_id
      left join unified_markets um on um.id = wa.market_id
      left join unified_events ue on ue.id = um.event_id
      where wa.activity_type in ('delta', 'trade')
        and wa.occurred_at <= $3::timestamptz
        and wa.occurred_at >= $4::timestamptz
        and ${buildSnapshotDeltaTrackableActivitySql({
          activityAlias: "wa",
          marketAlias: "um",
          eventAlias: "ue",
        })}
      order by
        wa.wallet_id,
        wa.market_id,
        wa.outcome_side,
        wa.occurred_at asc,
        wa.created_at asc nulls last,
        wa.id asc
    `,
    [
      pairs.map((pair) => pair.walletId),
      pairs.map((pair) => pair.marketId),
      asOf,
      since,
    ],
  );
  return rows;
}

async function loadWalletClassifiedMetricsMap(
  client: Queryable,
  inputs: {
    walletIds: string[];
    asOf?: Date;
    periodDays?: number;
  },
  classification: "marketSegment" | "marketType",
): Promise<Map<string, WalletMarketTypeMetric>> {
  const walletIds = Array.from(new Set(inputs.walletIds));
  if (walletIds.length === 0) return new Map();

  const asOf = inputs.asOf ?? new Date();
  const since = periodStart(asOf, Math.max(1, inputs.periodDays ?? 30));
  const rows = await loadWalletMarketTypeActivityRows(
    client,
    walletIds,
    asOf,
    since,
  );
  return buildWalletClassifiedMetricsMapFromRows(rows, asOf, classification);
}

async function loadWalletMarketTypeActivityRows(
  client: Queryable,
  walletIds: string[],
  asOf: Date,
  since: Date,
): Promise<WalletMarketTypeActivityRow[]> {
  const { rows } = await client.query<WalletMarketTypeActivityRow>(
    `
      select
        wa.wallet_id,
        wa.market_id,
        wa.outcome_side,
        wa.action,
        wa.delta_shares::text as delta_shares,
        wa.size_usd::text as size_usd,
        wa.price::text as price,
        wa.occurred_at,
        wa.created_at,
        wa.id,
        um.category as market_category,
        ue.category as event_category,
        ue.series_key,
        ue.series_title,
        ue.title as event_title,
        um.title as market_title,
        um.close_time,
        um.expiration_time,
        upper(coalesce(um.resolved_outcome::text, '')) as resolved_outcome,
        um.resolved_outcome_pct::text as resolved_outcome_pct,
        um.best_ask::text as best_ask,
        um.best_bid::text as best_bid,
        um.last_price::text as last_price
      from wallet_activity_events wa
      left join unified_markets um on um.id = wa.market_id
      left join unified_events ue on ue.id = um.event_id
      where wa.wallet_id = any($1::uuid[])
        and wa.activity_type in ('delta', 'trade')
        and wa.occurred_at <= $2::timestamptz
        and wa.occurred_at >= $3::timestamptz
        and ${buildSnapshotDeltaTrackableActivitySql({
          activityAlias: "wa",
          marketAlias: "um",
          eventAlias: "ue",
        })}
      order by
        wa.wallet_id,
        wa.market_id,
        wa.outcome_side,
        wa.occurred_at asc,
        wa.created_at asc nulls last,
        wa.id asc
    `,
    [walletIds, asOf, since],
  );
  return rows;
}

function buildWalletClassifiedMetricsMapFromRows(
  rows: WalletMarketTypeActivityRow[],
  asOf: Date,
  classification: "marketSegment" | "marketType",
): Map<string, WalletMarketTypeMetric> {
  const aggregateByKey = new Map<string, MetricAggregate>();
  const ledgerRowsByTypeKey = new Map<string, WalletPositionLedgerRow[]>();
  const marketTypeByClass = new Map<string, MarketType>();
  const marketMarksById = new Map<
    string,
    ReturnType<typeof metricMarkFromRow>
  >();

  for (const row of rows) {
    const marketType = rowMarketType(row, asOf);
    const marketSegment = rowMarketSegment(row, asOf);
    const marketClass =
      classification === "marketSegment" ? marketSegment : marketType;
    if (!marketTypeByClass.has(marketClass)) {
      marketTypeByClass.set(marketClass, marketType);
    }
    const aggregateKey = keyFor(row.wallet_id, marketClass);
    const aggregate = aggregateByKey.get(aggregateKey) ?? {
      walletId: row.wallet_id,
      tradesCount: 0,
      volumeUsd: 0,
      lastTradeAt: null,
      resolvedCount: 0,
      winningCount: 0,
    };

    aggregate.tradesCount += 1;
    aggregate.volumeUsd += notionalUsd(row);
    if (!aggregate.lastTradeAt || row.occurred_at > aggregate.lastTradeAt) {
      aggregate.lastTradeAt = row.occurred_at;
    }

    const outcomeSide = row.outcome_side?.toUpperCase() ?? "";
    const resolvedOutcome = row.resolved_outcome?.toUpperCase() ?? "";
    if (
      isWalletFinalOutcomeSampleAction(row.action) &&
      (outcomeSide === "YES" || outcomeSide === "NO") &&
      (resolvedOutcome === "YES" || resolvedOutcome === "NO")
    ) {
      aggregate.resolvedCount += 1;
      if (outcomeSide === resolvedOutcome) aggregate.winningCount += 1;
    }
    aggregateByKey.set(aggregateKey, aggregate);

    if (!marketMarksById.has(row.market_id)) {
      marketMarksById.set(row.market_id, metricMarkFromRow(row));
    }
    if (outcomeSide !== "YES" && outcomeSide !== "NO") continue;

    const ledgerKey = `${marketClass}:${makeWalletPositionLedgerKey(
      row.wallet_id,
      row.market_id,
      outcomeSide,
    )}`;
    const existing = ledgerRowsByTypeKey.get(ledgerKey) ?? [];
    existing.push({
      walletId: row.wallet_id,
      marketId: row.market_id,
      outcomeSide,
      action: row.action,
      deltaShares: row.delta_shares,
      sizeUsd: row.size_usd,
      price: row.price,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      id: row.id,
    });
    ledgerRowsByTypeKey.set(ledgerKey, existing);
  }

  const ledgersByMetricKey = new Map<
    string,
    Array<{
      marketId: string;
      outcomeSide: string | null;
      ledger: ReturnType<typeof replayWalletPositionLedgerRows>;
    }>
  >();

  for (const [ledgerKey, ledgerRows] of ledgerRowsByTypeKey.entries()) {
    const marketClass = ledgerKey.slice(0, ledgerKey.indexOf(":"));
    const ledger = replayWalletPositionLedgerRows(ledgerRows);
    if (ledger.eventCount <= 0) continue;
    const first = ledgerRows[0];
    const metricKey = keyFor(first.walletId, marketClass);
    const existing = ledgersByMetricKey.get(metricKey) ?? [];
    existing.push({
      marketId: first.marketId,
      outcomeSide: first.outcomeSide,
      ledger,
    });
    ledgersByMetricKey.set(metricKey, existing);
  }

  const metrics = new Map<string, WalletMarketTypeMetric>();
  const marketClasses = Array.from(
    new Set(
      [...aggregateByKey.keys(), ...ledgersByMetricKey.keys()].map(
        (entry) => entry.split(":").at(-1) as string,
      ),
    ),
  );

  for (const marketClass of marketClasses) {
    const aggregates = Array.from(aggregateByKey.entries())
      .filter(([entryKey]) => entryKey.endsWith(`:${marketClass}`))
      .map(([, aggregate]) => ({
        walletId: aggregate.walletId,
        tradesCount: aggregate.tradesCount,
        volumeUsd: aggregate.volumeUsd,
        lastTradeAt: aggregate.lastTradeAt,
        resolvedCount: aggregate.resolvedCount,
        winningCount: aggregate.winningCount,
      }));
    const typeWalletIds = Array.from(
      new Set([
        ...aggregates.map((aggregate) => aggregate.walletId),
        ...Array.from(ledgersByMetricKey.keys())
          .filter((entryKey) => entryKey.endsWith(`:${marketClass}`))
          .map((entryKey) => entryKey.slice(0, entryKey.lastIndexOf(":"))),
      ]),
    );
    if (typeWalletIds.length === 0) continue;

    const ledgersByWallet = new Map<
      string,
      Array<{
        marketId: string;
        outcomeSide: string | null;
        ledger: ReturnType<typeof replayWalletPositionLedgerRows>;
      }>
    >();
    for (const walletId of typeWalletIds) {
      const entries =
        ledgersByMetricKey.get(keyFor(walletId, marketClass)) ?? [];
      if (entries.length > 0) ledgersByWallet.set(walletId, entries);
    }

    const built = buildWalletThirtyDayMetricsUpsertRows({
      walletIds: typeWalletIds,
      aggregates,
      ledgersByWallet,
      marketMarksById,
    });

    for (const row of built.rows) {
      if (
        row.tradesCount <= 0 &&
        (row.volumeUsd ?? 0) <= NET_SHARES_EPSILON &&
        row.resolvedEdgeSampleCount <= 0
      ) {
        continue;
      }
      const metricMarketType =
        marketTypeByClass.get(marketClass) ??
        (classification === "marketType"
          ? (marketClass as MarketType)
          : "other");
      metrics.set(keyFor(row.walletId, marketClass), {
        walletId: row.walletId,
        marketType: metricMarketType,
        ...(classification === "marketSegment"
          ? { marketSegment: marketClass as MarketSegment }
          : {}),
        period: "30d",
        asOf: asOf.toISOString(),
        tradesCount: row.tradesCount,
        volumeUsd: row.volumeUsd,
        pnlUsd: row.pnlUsd,
        roi: row.roi,
        winRate: row.winRate,
        resolvedEdgeSampleCount: row.resolvedEdgeSampleCount,
        resolvedActualWinRate: row.resolvedActualWinRate,
        resolvedExpectedWinRate: row.resolvedExpectedWinRate,
        resolvedWinRateEdge: row.resolvedWinRateEdge,
        resolvedEdgeZScore: row.resolvedEdgeZScore,
        resolvedBrierScore: row.resolvedBrierScore,
        resolvedStakeWeightedEdge: row.resolvedStakeWeightedEdge,
        resolvedStakeUsd: row.resolvedStakeUsd,
        lastTradeAt: row.lastTradeAt?.toISOString() ?? null,
        approximate: row.approximate,
        unmarkedOpenLegCount: row.unmarkedOpenLegCount,
      });
    }
  }

  return metrics;
}
