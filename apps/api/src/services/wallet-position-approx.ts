import type { PoolClient } from "pg";

import { isRecord } from "../lib/type-guards.js";
import { normalizeOutcomeSideForStorage } from "./wallet-intel-helpers.js";
import { buildWalletIntelTrackableMarketSql } from "./wallet-intel-market-eligibility.js";
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
  currentPrice: number | null;
  observedPrice: number | null;
  openPnlUsd: number | null;
  realizedPnlUsd: number | null;
  totalPnlUsd: number | null;
  approxPnlUsd: number | null;
  approxReliable: boolean;
  approxPnlSource: "activity" | "snapshot" | null;
};

export type WalletPositionNowKeyInput = {
  walletId: string;
  venue: string;
  marketId: string;
  outcomeSide: string | null;
};

export type WalletPositionNow = WalletPositionApproxMetrics & {
  positionShares: number | null;
  positionSizeUsd: number | null;
  snapshotAt: Date | null;
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

function resolveCurrentPrice(input: WalletPositionApproxInput): number | null {
  const side = normalizeOutcomeSideForStorage(input.outcomeSide);
  const yesMarkPrice = resolveMarkPrice(input);
  if (yesMarkPrice == null) return null;
  if (side === "YES") return yesMarkPrice;
  if (side === "NO") return 1 - yesMarkPrice;
  return null;
}

function combineTotalPnlUsd(input: {
  openPnlUsd: number | null;
  realizedPnlUsd: number | null;
}): number | null {
  const openPnlUsd =
    input.openPnlUsd != null && Number.isFinite(input.openPnlUsd)
      ? input.openPnlUsd
      : null;
  const realizedPnlUsd =
    input.realizedPnlUsd != null && Number.isFinite(input.realizedPnlUsd)
      ? input.realizedPnlUsd
      : null;
  if (openPnlUsd != null && realizedPnlUsd != null) {
    return openPnlUsd + realizedPnlUsd;
  }
  if (openPnlUsd != null) return openPnlUsd;
  if (realizedPnlUsd != null) return realizedPnlUsd;
  return null;
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
      currentPrice: resolveCurrentPrice(input),
      observedPrice: startPrice,
      openPnlUsd: null,
      realizedPnlUsd: null,
      totalPnlUsd: null,
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
      currentPrice: resolveCurrentPrice(input),
      observedPrice: startPrice,
      openPnlUsd: null,
      realizedPnlUsd: null,
      totalPnlUsd: null,
      approxPnlUsd: null,
      approxReliable: false,
      approxPnlSource: null,
    };
  }

  const openPnlUsd = (effectiveMark - startPrice) * shares;

  return {
    approxEntryPrice: null,
    currentPrice: effectiveMark,
    observedPrice: startPrice,
    openPnlUsd,
    realizedPnlUsd: null,
    totalPnlUsd: openPnlUsd,
    approxPnlUsd: openPnlUsd,
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

  const openPnlUsd =
    ledger.remainingShares > NET_SHARES_EPSILON
      ? computeApproxLegPnlUsd({
          outcomeSide: side,
          netShares: ledger.remainingShares,
          netCost: ledger.remainingBasisUsd,
          resolvedOutcome: input.resolvedOutcome,
          markPrice,
        })
      : 0;
  const totalPnlUsd =
    openPnlUsd == null
      ? ledger.remainingShares > NET_SHARES_EPSILON
        ? buildSnapshotFallback(input, markPrice).totalPnlUsd
        : ledger.realizedPnlUsd
      : combineTotalPnlUsd({
          openPnlUsd,
          realizedPnlUsd: ledger.realizedPnlUsd,
        });

  if (totalPnlUsd == null && openEntry.entryPrice == null) {
    return buildSnapshotFallback(input, markPrice);
  }

  const approxReliable =
    !ledger.hasIncompleteEvents && !ledger.oversold && !sharesMismatch;

  return {
    approxEntryPrice,
    currentPrice: resolveCurrentPrice(input),
    observedPrice: parseNumber(input.price),
    openPnlUsd,
    realizedPnlUsd: ledger.realizedPnlUsd,
    totalPnlUsd,
    approxPnlUsd: totalPnlUsd,
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

type LatestWalletPositionSnapshotRow = {
  wallet_id: string;
  venue: string;
  market_id: string;
  outcome_side: string | null;
  shares: string | null;
  size_usd: string | null;
  price: string | null;
  snapshot_at: Date | null;
  metadata: unknown;
  best_bid: string | null;
  best_ask: string | null;
  last_price: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | null;
};

export async function loadLatestWalletPositionNowMap(
  client: Queryable,
  inputs: WalletPositionNowKeyInput[],
): Promise<Map<string, WalletPositionNow>> {
  const byKey = new Map<string, WalletPositionNow>();
  if (inputs.length === 0) return byKey;

  const dedupedInputs = Array.from(
    new Map(
      inputs.map((input) => {
        const outcomeSide = normalizeOutcomeSideForStorage(input.outcomeSide);
        return [
          `${input.walletId}::${input.venue}::${input.marketId}::${outcomeSide}`,
          {
            walletId: input.walletId,
            venue: input.venue,
            marketId: input.marketId,
            outcomeSide,
          },
        ] as const;
      }),
    ).values(),
  );
  if (dedupedInputs.length === 0) return byKey;

  const payload = dedupedInputs.map((input) => ({
    wallet_id: input.walletId,
    venue: input.venue,
    market_id: input.marketId,
    outcome_side: input.outcomeSide,
  }));

  const { rows } = await client.query<LatestWalletPositionSnapshotRow>(
    `
      with input_keys as (
        select distinct
          wallet_id::uuid as wallet_id,
          venue::text as venue,
          market_id::text as market_id,
          case
            when upper(coalesce(outcome_side, '')) in ('YES', 'NO')
              then upper(coalesce(outcome_side, ''))
            else null
          end as outcome_side
        from jsonb_to_recordset($1::jsonb) as x(
          wallet_id text,
          venue text,
          market_id text,
          outcome_side text
        )
      ),
      latest as (
        select distinct on (ws.wallet_id, ws.venue)
          ws.wallet_id,
          ws.venue,
          ws.snapshot_at
        from wallet_position_snapshots ws
        join unified_markets um on um.id = ws.market_id
        left join unified_events ue on ue.id = um.event_id
        join (
          select distinct wallet_id, venue
          from input_keys
        ) input_wallets
          on input_wallets.wallet_id = ws.wallet_id
         and input_wallets.venue = ws.venue
        where ${buildWalletIntelTrackableMarketSql({
          marketAlias: "um",
          eventAlias: "ue",
        })}
        order by ws.wallet_id, ws.venue, ws.snapshot_at desc
      )
      select
        ik.wallet_id,
        ik.venue,
        ik.market_id,
        ik.outcome_side,
        ws.shares::text as shares,
        ws.size_usd::text as size_usd,
        ws.price::text as price,
        ws.snapshot_at,
        ws.metadata,
        um.best_bid::text as best_bid,
        um.best_ask::text as best_ask,
        um.last_price::text as last_price,
        um.resolved_outcome,
        um.resolved_outcome_pct::text as resolved_outcome_pct
      from input_keys ik
      join latest l
        on l.wallet_id = ik.wallet_id
       and l.venue = ik.venue
      left join wallet_position_snapshots ws
        on ws.wallet_id = ik.wallet_id
       and ws.venue = ik.venue
       and ws.snapshot_at = l.snapshot_at
       and ws.market_id = ik.market_id
       and (
         case
           when upper(coalesce(ws.outcome_side, '')) in ('YES', 'NO')
             then upper(coalesce(ws.outcome_side, ''))
           else null
         end
       ) is not distinct from ik.outcome_side
      left join unified_markets um on um.id = ik.market_id
    `,
    [JSON.stringify(payload)],
  );

  const approxInputs = rows
    .filter((row) => row.snapshot_at != null)
    .map<WalletPositionApproxInput>((row) => ({
      walletId: row.wallet_id,
      marketId: row.market_id,
      outcomeSide: row.outcome_side,
      shares: parseNumber(row.shares),
      price: parseNumber(row.price),
      bestBid: parseNumber(row.best_bid),
      bestAsk: parseNumber(row.best_ask),
      lastPrice: parseNumber(row.last_price),
      resolvedOutcome: row.resolved_outcome,
      resolvedOutcomePct: parseNumber(row.resolved_outcome_pct),
      metadata: row.metadata,
    }));
  const approxMetricsByKey = await loadWalletPositionApproxMetrics(
    client,
    approxInputs,
  );

  for (const row of rows) {
    if (row.snapshot_at == null) continue;

    const key = makeWalletPositionLedgerKey(
      row.wallet_id,
      row.market_id,
      row.outcome_side,
    );
    const metrics = approxMetricsByKey.get(key);

    byKey.set(key, {
      approxEntryPrice: metrics?.approxEntryPrice ?? null,
      currentPrice: metrics?.currentPrice ?? null,
      observedPrice: metrics?.observedPrice ?? parseNumber(row.price),
      openPnlUsd: metrics?.openPnlUsd ?? null,
      realizedPnlUsd: metrics?.realizedPnlUsd ?? null,
      totalPnlUsd: metrics?.totalPnlUsd ?? null,
      approxPnlUsd: metrics?.approxPnlUsd ?? null,
      approxReliable: metrics?.approxReliable ?? false,
      approxPnlSource: metrics?.approxPnlSource ?? null,
      positionShares: parseNumber(row.shares),
      positionSizeUsd: parseNumber(row.size_usd),
      snapshotAt: row.snapshot_at,
    });
  }

  return byKey;
}
