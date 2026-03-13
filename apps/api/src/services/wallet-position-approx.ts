import type { PoolClient } from "pg";

import { isRecord } from "../lib/type-guards.js";
import { normalizeOutcomeSideForStorage } from "./wallet-intel-helpers.js";
import {
  loadWalletPositionLedgerMap,
  makeWalletPositionLedgerKey,
  resolveApproxOpenEntryFromLedger,
  sharesApproximatelyMatch,
  type WalletPositionLedgerState,
} from "./wallet-position-ledger.js";
import {
  computeApproxLegPnlUsd,
  NET_SHARES_EPSILON,
  resolveApproxYesMarkPrice,
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

function resolveMarkPrice(input: WalletPositionApproxInput): number | null {
  const side = normalizeOutcomeSideForStorage(input.outcomeSide);
  if (side !== "YES" && side !== "NO") return null;

  return resolveApproxYesMarkPrice({
    resolvedOutcome: input.resolvedOutcome,
    resolvedOutcomePct: parseNumber(input.resolvedOutcomePct),
    markPrice: input.bestAsk ?? input.bestBid ?? input.lastPrice,
  });
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

function buildApproxFromLedger(
  input: WalletPositionApproxInput,
  ledger: WalletPositionLedgerState,
  markPrice: number | null,
): WalletPositionApproxMetrics {
  const side = normalizeOutcomeSideForStorage(input.outcomeSide);
  if (side !== "YES" && side !== "NO") {
    return buildSnapshotFallback(input, markPrice);
  }

  const snapshotShares = parseNumber(input.shares);
  const sharesMismatch =
    snapshotShares != null &&
    snapshotShares > NET_SHARES_EPSILON &&
    !sharesApproximatelyMatch(snapshotShares, ledger.remainingShares);

  if (sharesMismatch) {
    return buildSnapshotFallback(input, markPrice);
  }

  const openEntry = resolveApproxOpenEntryFromLedger({
    ledger,
    observedPrice: input.price,
    snapshotShares,
  });
  if (
    ledger.remainingShares > NET_SHARES_EPSILON &&
    openEntry.source !== "activity"
  ) {
    return buildSnapshotFallback(input, markPrice);
  }
  const approxEntryPrice = openEntry.source === "activity" ? openEntry.entryPrice : null;

  const openLegPnlUsd =
    ledger.remainingShares > NET_SHARES_EPSILON
      ? computeApproxLegPnlUsd({
          outcomeSide: side,
          netShares: ledger.remainingShares,
          netCost: ledger.remainingBasisUsd,
          resolvedOutcome: input.resolvedOutcome,
          markPrice,
        })
      : 0;
  const approxPnlUsd =
    openLegPnlUsd == null
      ? ledger.remainingShares > NET_SHARES_EPSILON
        ? buildSnapshotFallback(input, markPrice).approxPnlUsd
        : ledger.realizedPnlUsd
      : ledger.realizedPnlUsd + openLegPnlUsd;

  if (approxPnlUsd == null && openEntry.entryPrice == null) {
    return buildSnapshotFallback(input, markPrice);
  }

  const approxReliable =
    !ledger.hasIncompleteEvents && !ledger.oversold && !sharesMismatch;

  return {
    approxEntryPrice,
    approxPnlUsd,
    approxReliable,
    approxPnlSource: "activity",
  };
}

export async function loadWalletPositionApproxMetrics(
  client: Queryable,
  inputs: WalletPositionApproxInput[],
): Promise<Map<string, WalletPositionApproxMetrics>> {
  const metricsByKey = new Map<string, WalletPositionApproxMetrics>();
  if (inputs.length === 0) return metricsByKey;

  const ledgerByKey = await loadWalletPositionLedgerMap(
    client,
    inputs.map((input) => ({
      walletId: input.walletId,
      marketId: input.marketId,
      outcomeSide: input.outcomeSide,
    })),
  );

  for (const input of inputs) {
    const key = makeWalletPositionLedgerKey(
      input.walletId,
      input.marketId,
      input.outcomeSide,
    );
    const ledger = ledgerByKey.get(key);
    const markPrice = resolveMarkPrice(input);

    const metrics =
      ledger && ledger.eventCount > 0
        ? buildApproxFromLedger(input, ledger, markPrice)
        : buildSnapshotFallback(input, markPrice);

    metricsByKey.set(key, metrics);
  }

  return metricsByKey;
}
