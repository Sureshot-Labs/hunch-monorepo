import type { PoolClient } from "pg";

import { normalizeOutcomeSideForStorage } from "./wallet-intel-helpers.js";
import { buildSnapshotDeltaTrackableActivitySql } from "./wallet-intel-market-eligibility.js";
import {
  computeApproxLegPnlUsd,
  NET_SHARES_EPSILON,
} from "./wallet-intel-pnl.js";

type Queryable = Pick<PoolClient, "query">;

type RawLedgerRow = {
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
};

export type WalletPositionLedgerKeyInput = {
  walletId: string;
  marketId: string;
  outcomeSide: string | null;
};

export type WalletPositionLedgerRow = {
  walletId: string;
  marketId: string;
  outcomeSide: string | null;
  action: string | null;
  deltaShares: string | null;
  sizeUsd: string | null;
  price: string | null;
  occurredAt: Date;
  createdAt: Date | null;
  id: string;
};

export type WalletPositionLedgerState = {
  remainingShares: number;
  remainingBasisUsd: number;
  realizedPnlUsd: number;
  realizedBasisUsd: number;
  buyShares: number;
  buyCostUsd: number;
  sellShares: number;
  sellProceedsUsd: number;
  hasIncompleteEvents: boolean;
  oversold: boolean;
  eventCount: number;
};

export type WalletOpenEntryResolution = {
  approximate: boolean | null;
  entryPrice: number | null;
  source: "activity" | "snapshot" | null;
};

export type WalletLedgerApproxMetricInput = {
  outcomeSide: string | null;
  ledger: WalletPositionLedgerState | null | undefined;
  resolvedOutcome?: string | null;
  yesMarkPrice?: number | null;
};

export type WalletLedgerApproxMetricTotals = {
  approximate: boolean;
  pnlUsd: number | null;
  costBasisUsd: number | null;
  includedLegCount: number;
  unmarkedOpenLegCount: number;
};

const SHARE_RECONCILIATION_ABS_EPSILON = 1e-6;
const SHARE_RECONCILIATION_RATIO_EPSILON = 0.005;
const LEDGER_METRIC_ABS_EPSILON = 1e-9;

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function emptyLedgerState(): WalletPositionLedgerState {
  return {
    remainingShares: 0,
    remainingBasisUsd: 0,
    realizedPnlUsd: 0,
    realizedBasisUsd: 0,
    buyShares: 0,
    buyCostUsd: 0,
    sellShares: 0,
    sellProceedsUsd: 0,
    hasIncompleteEvents: false,
    oversold: false,
    eventCount: 0,
  };
}

function normalizeProbability(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return Math.min(1, value / 100);
  return value;
}

export function makeWalletPositionLedgerKey(
  walletId: string,
  marketId: string,
  outcomeSide: string | null | undefined,
): string {
  return [walletId, marketId, normalizeOutcomeSideForStorage(outcomeSide)].join(
    "::",
  );
}

export function sharesApproximatelyMatch(
  snapshotShares: number | null | undefined,
  ledgerShares: number,
): boolean {
  if (snapshotShares == null || !Number.isFinite(snapshotShares)) return true;
  const tolerance = Math.max(
    SHARE_RECONCILIATION_ABS_EPSILON,
    Math.abs(snapshotShares) * SHARE_RECONCILIATION_RATIO_EPSILON,
  );
  return Math.abs(snapshotShares - ledgerShares) <= tolerance;
}

export function replayWalletPositionLedgerRows(
  rows: WalletPositionLedgerRow[],
): WalletPositionLedgerState {
  const state = emptyLedgerState();

  for (const row of rows) {
    const price = parseNumber(row.price);
    let shares = parseNumber(row.deltaShares);
    let notionalUsd = parseNumber(row.sizeUsd);

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
      state.hasIncompleteEvents = true;
      continue;
    }

    const isSell = row.action?.trim().toUpperCase() === "SELL";
    if (!isSell) {
      state.buyShares += shares;
      state.buyCostUsd += notionalUsd;
      state.remainingShares += shares;
      state.remainingBasisUsd += notionalUsd;
      state.eventCount += 1;
      continue;
    }

    state.sellShares += shares;
    state.sellProceedsUsd += notionalUsd;

    if (state.remainingShares <= NET_SHARES_EPSILON) {
      state.oversold = true;
      state.eventCount += 1;
      continue;
    }

    const matchedShares = Math.min(state.remainingShares, shares);
    const shareRatio = matchedShares / shares;
    const matchedProceedsUsd = notionalUsd * shareRatio;
    const avgCostUsd =
      state.remainingShares > NET_SHARES_EPSILON
        ? state.remainingBasisUsd / state.remainingShares
        : 0;
    const matchedBasisUsd = avgCostUsd * matchedShares;

    state.realizedPnlUsd += matchedProceedsUsd - matchedBasisUsd;
    state.realizedBasisUsd += matchedBasisUsd;
    state.remainingShares = Math.max(0, state.remainingShares - matchedShares);
    state.remainingBasisUsd = Math.max(
      0,
      state.remainingBasisUsd - matchedBasisUsd,
    );
    if (shares - matchedShares > SHARE_RECONCILIATION_ABS_EPSILON) {
      state.oversold = true;
    }
    if (state.remainingShares <= NET_SHARES_EPSILON) {
      state.remainingShares = 0;
      state.remainingBasisUsd = 0;
    }
    state.eventCount += 1;
  }

  return state;
}

export function computeWalletLedgerApproxMetricTotals(
  inputs: WalletLedgerApproxMetricInput[],
): WalletLedgerApproxMetricTotals {
  let pnlUsd = 0;
  let costBasisUsd = 0;
  let includedLegCount = 0;
  let unmarkedOpenLegCount = 0;
  let approximate = false;

  for (const input of inputs) {
    const ledger = input.ledger ?? null;
    if (!ledger || ledger.eventCount <= 0) continue;

    if (ledger.hasIncompleteEvents || ledger.oversold) {
      approximate = true;
    }

    if (
      ledger.realizedBasisUsd > LEDGER_METRIC_ABS_EPSILON ||
      Math.abs(ledger.realizedPnlUsd) > LEDGER_METRIC_ABS_EPSILON
    ) {
      pnlUsd += ledger.realizedPnlUsd;
      costBasisUsd += ledger.realizedBasisUsd;
      includedLegCount += 1;
    }

    if (ledger.remainingShares <= NET_SHARES_EPSILON) continue;

    const outcomeSide = normalizeOutcomeSideForStorage(input.outcomeSide);
    if (outcomeSide !== "YES" && outcomeSide !== "NO") {
      approximate = true;
      unmarkedOpenLegCount += 1;
      continue;
    }

    const openLegPnlUsd = computeApproxLegPnlUsd({
      outcomeSide,
      netShares: ledger.remainingShares,
      netCost: ledger.remainingBasisUsd,
      resolvedOutcome: input.resolvedOutcome,
      markPrice: normalizeProbability(parseNumber(input.yesMarkPrice)),
    });
    if (openLegPnlUsd == null) {
      approximate = true;
      unmarkedOpenLegCount += 1;
      continue;
    }

    pnlUsd += openLegPnlUsd;
    costBasisUsd += ledger.remainingBasisUsd;
    includedLegCount += 1;
  }

  return {
    approximate,
    pnlUsd: includedLegCount > 0 ? pnlUsd : null,
    costBasisUsd:
      costBasisUsd > LEDGER_METRIC_ABS_EPSILON ? costBasisUsd : null,
    includedLegCount,
    unmarkedOpenLegCount,
  };
}

export function resolveApproxOpenEntryFromLedger(input: {
  ledger: WalletPositionLedgerState | null | undefined;
  observedPrice: number | null | undefined;
  snapshotShares: number | null | undefined;
}): WalletOpenEntryResolution {
  const observedPrice = normalizeProbability(parseNumber(input.observedPrice));
  const snapshotShares = parseNumber(input.snapshotShares);
  const ledger = input.ledger ?? null;

  if (
    ledger != null &&
    ledger.remainingShares > NET_SHARES_EPSILON &&
    ledger.remainingBasisUsd > 0 &&
    sharesApproximatelyMatch(snapshotShares, ledger.remainingShares)
  ) {
    return {
      approximate: ledger.hasIncompleteEvents || ledger.oversold,
      entryPrice: ledger.remainingBasisUsd / ledger.remainingShares,
      source: "activity",
    };
  }

  if (observedPrice != null) {
    return {
      approximate: true,
      entryPrice: observedPrice,
      source: "snapshot",
    };
  }

  return {
    approximate: null,
    entryPrice: null,
    source: null,
  };
}

export async function loadWalletPositionLedgerMap(
  client: Queryable,
  inputs: WalletPositionLedgerKeyInput[],
): Promise<Map<string, WalletPositionLedgerState>> {
  const byKey = new Map<string, WalletPositionLedgerState>();
  if (inputs.length === 0) return byKey;

  const normalizedInputs = Array.from(
    new Map(
      inputs
        .map((input) => {
          const outcomeSide = normalizeOutcomeSideForStorage(input.outcomeSide);
          if (outcomeSide !== "YES" && outcomeSide !== "NO") return null;
          return [
            makeWalletPositionLedgerKey(
              input.walletId,
              input.marketId,
              outcomeSide,
            ),
            {
              walletId: input.walletId,
              marketId: input.marketId,
              outcomeSide,
            },
          ] as const;
        })
        .filter(
          (
            entry,
          ): entry is readonly [
            string,
            {
              walletId: string;
              marketId: string;
              outcomeSide: "YES" | "NO";
            },
          ] => Boolean(entry),
        ),
    ).values(),
  );
  if (normalizedInputs.length === 0) return byKey;

  const { rows } = await client.query<RawLedgerRow>(
    `
      with input_keys as (
        select distinct
          x.wallet_id::uuid as wallet_id,
          x.market_id::text as market_id,
          x.outcome_side::text as outcome_side
        from jsonb_to_recordset($1::jsonb) as x(
          wallet_id text,
          market_id text,
          outcome_side text
        )
        where x.outcome_side in ('YES', 'NO')
      )
      select
        wa.wallet_id,
        wa.market_id,
        upper(coalesce(wa.outcome_side, '')) as outcome_side,
        wa.action,
        wa.delta_shares::text as delta_shares,
        wa.size_usd::text as size_usd,
        wa.price::text as price,
        wa.occurred_at,
        wa.created_at,
        wa.id
      from wallet_activity_events wa
      left join unified_markets m on m.id = wa.market_id
      left join unified_events e on e.id = m.event_id
      join input_keys k
        on k.wallet_id = wa.wallet_id
       and k.market_id = wa.market_id
       and k.outcome_side = upper(coalesce(wa.outcome_side, ''))
      where wa.activity_type in ('delta', 'trade')
        and ${buildSnapshotDeltaTrackableActivitySql({
          activityAlias: "wa",
          marketAlias: "m",
          eventAlias: "e",
        })}
      order by
        wa.wallet_id,
        wa.market_id,
        upper(coalesce(wa.outcome_side, '')),
        wa.occurred_at asc,
        wa.created_at asc nulls last,
        wa.id asc
    `,
    [
      JSON.stringify(
        normalizedInputs.map((input) => ({
          wallet_id: input.walletId,
          market_id: input.marketId,
          outcome_side: input.outcomeSide,
        })),
      ),
    ],
  );

  const rowsByKey = new Map<string, WalletPositionLedgerRow[]>();
  for (const row of rows) {
    const key = makeWalletPositionLedgerKey(
      row.wallet_id,
      row.market_id,
      row.outcome_side,
    );
    const existing = rowsByKey.get(key) ?? [];
    existing.push({
      walletId: row.wallet_id,
      marketId: row.market_id,
      outcomeSide: row.outcome_side,
      action: row.action,
      deltaShares: row.delta_shares,
      sizeUsd: row.size_usd,
      price: row.price,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      id: row.id,
    });
    rowsByKey.set(key, existing);
  }

  for (const input of normalizedInputs) {
    const key = makeWalletPositionLedgerKey(
      input.walletId,
      input.marketId,
      input.outcomeSide,
    );
    const ledgerRows = rowsByKey.get(key);
    if (!ledgerRows || ledgerRows.length === 0) continue;
    byKey.set(key, replayWalletPositionLedgerRows(ledgerRows));
  }

  return byKey;
}
