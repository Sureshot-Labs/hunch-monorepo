import type { PoolClient } from "pg";

import { isRecord } from "../lib/type-guards.js";
import { normalizeOutcomeSideForStorage } from "./wallet-intel-helpers.js";
import {
  clampProbability,
  computeApproxLegPnlUsd,
  NET_SHARES_EPSILON,
} from "./wallet-intel-pnl.js";

type Queryable = Pick<PoolClient, "query">;

type WalletPositionApproxInput = {
  walletId: string;
  marketId: string;
  outcomeSide: string | null;
  shares: number | null;
  price: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  resolvedOutcome: string | null;
  resolvedOutcomePct?: number | null;
  metadata?: unknown;
};

type ActivityLegRow = {
  wallet_id: string;
  market_id: string;
  outcome_side: string | null;
  action: string | null;
  delta_shares: string | null;
  size_usd: string | null;
  price: string | null;
};

type ActivityAgg = {
  buyShares: number;
  buyCostUsd: number;
  sellShares: number;
  netShares: number;
  netCostUsd: number;
  hasIncompleteEvents: boolean;
  eventCount: number;
};

export type WalletPositionApproxMetrics = {
  approxEntryPrice: number | null;
  approxPnlUsd: number | null;
  approxReliable: boolean;
  approxPnlSource: "activity" | "snapshot" | null;
};

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function makeKey(
  walletId: string,
  marketId: string,
  outcomeSide: string | null | undefined,
): string {
  return [
    walletId,
    marketId,
    normalizeOutcomeSideForStorage(outcomeSide),
  ].join("::");
}

function resolveMarkPrice(input: WalletPositionApproxInput): number | null {
  const side = normalizeOutcomeSideForStorage(input.outcomeSide);
  if (side !== "YES" && side !== "NO") return null;

  const resolvedOutcome = input.resolvedOutcome?.trim().toUpperCase() ?? null;
  if (resolvedOutcome === "YES" || resolvedOutcome === "NO") {
    return resolvedOutcome === "YES" ? 1 : 0;
  }

  const resolvedOutcomePct = parseNumber(input.resolvedOutcomePct);
  if (resolvedOutcomePct != null) {
    const yesPrice = clampProbability(resolvedOutcomePct / 10000);
    return yesPrice;
  }

  const yesPrice = clampProbability(
    input.bestAsk ?? input.bestBid ?? input.lastPrice,
  );
  return yesPrice;
}

function extractFallbackShares(
  input: WalletPositionApproxInput,
): number | null {
  const shares = parseNumber(input.shares);
  if (shares != null && shares > NET_SHARES_EPSILON) return shares;
  if (!isRecord(input.metadata)) return null;

  const prevShares = parseNumber(input.metadata.prevShares);
  if (prevShares != null && prevShares > NET_SHARES_EPSILON) return prevShares;

  const metaShares = parseNumber(input.metadata.shares);
  if (metaShares != null && metaShares > NET_SHARES_EPSILON) return metaShares;

  return null;
}

function buildSnapshotFallback(
  input: WalletPositionApproxInput,
  markPrice: number | null,
): WalletPositionApproxMetrics {
  const startPrice = parseNumber(input.price);
  const shares = extractFallbackShares(input);
  if (
    startPrice == null ||
    shares == null ||
    shares <= NET_SHARES_EPSILON ||
    markPrice == null
  ) {
    return {
      approxEntryPrice: null,
      approxPnlUsd: null,
      approxReliable: false,
      approxPnlSource: null,
    };
  }

  const side = normalizeOutcomeSideForStorage(input.outcomeSide);
  const effectiveMark =
    side === "YES"
      ? markPrice
      : side === "NO"
        ? 1 - markPrice
        : null;
  if (effectiveMark == null) {
    return {
      approxEntryPrice: null,
      approxPnlUsd: null,
      approxReliable: false,
      approxPnlSource: null,
    };
  }

  return {
    approxEntryPrice: null,
    approxPnlUsd: (effectiveMark - startPrice) * shares,
    approxReliable: false,
    approxPnlSource: "snapshot",
  };
}

function buildApproxFromActivity(
  input: WalletPositionApproxInput,
  agg: ActivityAgg,
  markPrice: number | null,
): WalletPositionApproxMetrics {
  const side = normalizeOutcomeSideForStorage(input.outcomeSide);
  if (side !== "YES" && side !== "NO") {
    return buildSnapshotFallback(input, markPrice);
  }

  if (agg.netShares < -NET_SHARES_EPSILON) {
    return buildSnapshotFallback(input, markPrice);
  }

  const approxEntryPrice =
    agg.netShares >= NET_SHARES_EPSILON && agg.netCostUsd > 0
      ? agg.netCostUsd / agg.netShares
      : agg.buyShares >= NET_SHARES_EPSILON && agg.buyCostUsd > 0
        ? agg.buyCostUsd / agg.buyShares
        : null;

  const approxPnlUsd =
    Math.abs(agg.netShares) <= NET_SHARES_EPSILON
      ? -agg.netCostUsd
      : computeApproxLegPnlUsd({
          outcomeSide: side,
          netShares: Math.max(0, agg.netShares),
          netCost: agg.netCostUsd,
          resolvedOutcome: input.resolvedOutcome,
          markPrice,
        });

  if (approxPnlUsd == null && approxEntryPrice == null) {
    return buildSnapshotFallback(input, markPrice);
  }

  const approxReliable =
    !agg.hasIncompleteEvents &&
    agg.netShares >= -NET_SHARES_EPSILON &&
    agg.sellShares <= agg.buyShares + NET_SHARES_EPSILON;

  return {
    approxEntryPrice,
    approxPnlUsd,
    approxReliable,
    approxPnlSource: "activity",
  };
}

function aggregateActivityRows(rows: ActivityLegRow[]): Map<string, ActivityAgg> {
  const byKey = new Map<string, ActivityAgg>();

  for (const row of rows) {
    const key = makeKey(row.wallet_id, row.market_id, row.outcome_side);
    const agg = byKey.get(key) ?? {
      buyShares: 0,
      buyCostUsd: 0,
      sellShares: 0,
      netShares: 0,
      netCostUsd: 0,
      hasIncompleteEvents: false,
      eventCount: 0,
    };

    const price = parseNumber(row.price);
    let shares = parseNumber(row.delta_shares);
    let notionalUsd = parseNumber(row.size_usd);

    if (shares == null && price != null && notionalUsd != null && price > 0) {
      shares = Math.abs(notionalUsd / price);
    }

    if (notionalUsd == null && shares != null && price != null) {
      notionalUsd = Math.abs(shares * price);
    }

    if (
      shares == null ||
      !Number.isFinite(shares) ||
      shares <= 0 ||
      notionalUsd == null ||
      !Number.isFinite(notionalUsd) ||
      notionalUsd < 0
    ) {
      agg.hasIncompleteEvents = true;
      byKey.set(key, agg);
      continue;
    }

    const isSell = row.action?.trim().toUpperCase() === "SELL";
    if (isSell) {
      agg.sellShares += shares;
      agg.netShares -= shares;
      agg.netCostUsd -= notionalUsd;
    } else {
      agg.buyShares += shares;
      agg.buyCostUsd += notionalUsd;
      agg.netShares += shares;
      agg.netCostUsd += notionalUsd;
    }

    agg.eventCount += 1;
    byKey.set(key, agg);
  }

  return byKey;
}

export async function loadWalletPositionApproxMetrics(
  client: Queryable,
  inputs: WalletPositionApproxInput[],
): Promise<Map<string, WalletPositionApproxMetrics>> {
  const metricsByKey = new Map<string, WalletPositionApproxMetrics>();
  if (inputs.length === 0) return metricsByKey;

  const walletIds = Array.from(new Set(inputs.map((row) => row.walletId)));
  const marketIds = Array.from(new Set(inputs.map((row) => row.marketId)));

  const { rows } = await client.query<ActivityLegRow>(
    `
      select
        wallet_id,
        market_id,
        outcome_side,
        action,
        delta_shares::text as delta_shares,
        size_usd::text as size_usd,
        price::text as price
      from wallet_activity_events
      where wallet_id = any($1::uuid[])
        and market_id = any($2::text[])
        and activity_type in ('delta', 'trade')
    `,
    [walletIds, marketIds],
  );

  const activityByKey = aggregateActivityRows(rows);

  for (const input of inputs) {
    const key = makeKey(input.walletId, input.marketId, input.outcomeSide);
    const agg = activityByKey.get(key);
    const markPrice = resolveMarkPrice(input);

    const metrics =
      agg && agg.eventCount > 0
        ? buildApproxFromActivity(input, agg, markPrice)
        : buildSnapshotFallback(input, markPrice);

    metricsByKey.set(key, metrics);
  }

  return metricsByKey;
}
