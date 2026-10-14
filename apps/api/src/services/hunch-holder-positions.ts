import type { PoolClient } from "pg";
import { normalizeOutcomeSideForApi } from "./wallet-intel-helpers.js";
import { resolveApproxYesMarkPrice } from "./wallet-intel-pnl.js";
import {
  calculateWalletPositionApproxMetrics,
  type WalletPositionNow,
  type WalletPositionNowKeyInput,
} from "./wallet-position-approx.js";
import {
  computeWalletLedgerApproxMetricTotals,
  loadWalletPositionLedgerMap,
  makeWalletPositionLedgerKey,
  type WalletPositionLedgerState,
} from "./wallet-position-ledger.js";

export type HunchPositionResult = {
  pnlUsd: number;
  approximate: true;
  source: "activity" | "snapshot_delta";
  valuation: "resolution" | "quote" | "position_snapshot" | "realized";
  activityAsOf: string | null;
  snapshotAsOf: string | null;
  priceAsOf: string | null;
};

export type HunchHolderPosition = WalletPositionNow & {
  positionResult: HunchPositionResult | null;
};

export type HunchPositionRow = {
  wallet_id: string;
  market_id: string;
  outcome_side: "YES" | "NO";
  shares: string | null;
  size_usd: string | null;
  price: string | null;
  snapshot_at: Date | null;
  wallet_snapshot_at: Date | null;
  market_status: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | null;
  resolution_observed_at: Date | null;
  quote_price: string | null;
  quote_at: Date | null;
};

// Exact-key reads only. Unlike the live portfolio loader, a historical position
// does not have to appear in the wallet's latest batch to have a result.
export const HUNCH_HOLDER_POSITIONS_SQL = `
  with input_keys as (
    select distinct x.wallet_id::uuid as wallet_id, x.venue, x.market_id, x.outcome_side
    from jsonb_to_recordset($1::jsonb)
      as x(wallet_id text, venue text, market_id text, outcome_side text)
  )
  select k.wallet_id, k.market_id, k.outcome_side,
    position_row.shares::text, position_row.size_usd::text, position_row.price::text,
    position_row.snapshot_at, wallet_batch.snapshot_at as wallet_snapshot_at,
    m.status as market_status, m.resolved_outcome, m.resolved_outcome_pct::text,
    m.resolution_observed_at,
    quote_row.price::text as quote_price, quote_row.ts as quote_at
  from input_keys k
  left join unified_markets m on m.id = k.market_id and m.venue = k.venue
  left join lateral (
    select ws.shares, ws.size_usd, ws.price, ws.snapshot_at
    from wallet_position_snapshots ws
    where ws.wallet_id = k.wallet_id and ws.venue = k.venue
      and ws.market_id = k.market_id and ws.outcome_side = k.outcome_side
    order by ws.snapshot_at desc limit 1
  ) position_row on true
  left join lateral (
    select ws.snapshot_at from wallet_position_snapshots ws
    where ws.wallet_id = k.wallet_id and ws.venue = k.venue
    order by ws.snapshot_at desc limit 1
  ) wallet_batch on true
  left join lateral (
    select coalesce(q.mid, (q.best_bid + q.best_ask) / 2, q.best_bid, q.best_ask) as price, q.ts
    from unified_tokens t
    join unified_token_top_latest q on q.token_id = t.token_id
    where t.market_id = k.market_id and t.side = k.outcome_side
    order by q.ts desc limit 1
  ) quote_row on true
`;

function numeric(value: string | number | null): number | null {
  if (value == null || (typeof value === "string" && !value.trim()))
    return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function probability(value: string | null): number | null {
  const result = numeric(value);
  return result != null && result >= 0 && result <= 1 ? result : null;
}

export function buildHunchHolderPosition(
  row: HunchPositionRow,
  ledger?: WalletPositionLedgerState,
): HunchHolderPosition {
  const resolvedSide = normalizeOutcomeSideForApi(row.resolved_outcome);
  const payout = numeric(row.resolved_outcome_pct);
  const resolvedPct =
    payout != null && payout >= 0 && payout <= 10000 ? payout : null;
  const settled = resolvedSide != null || resolvedPct != null;
  const cancelled = /^(CANCELLED|CANCELED|VOID)$/i.test(
    row.market_status ?? "",
  );
  const quote = probability(row.quote_price);
  const snapshotPrice = probability(row.price);
  const useQuote =
    quote != null &&
    row.quote_at != null &&
    (row.snapshot_at == null ||
      row.quote_at >= row.snapshot_at ||
      snapshotPrice == null);
  const sideMark =
    cancelled && !settled ? null : useQuote ? quote : snapshotPrice;
  const yesMark = resolveApproxYesMarkPrice({
    resolvedOutcome: resolvedSide,
    resolvedOutcomePct: resolvedPct,
    markPrice:
      sideMark == null
        ? null
        : row.outcome_side === "YES"
          ? sideMark
          : 1 - sideMark,
  });
  const totals = computeWalletLedgerApproxMetricTotals([
    {
      outcomeSide: row.outcome_side,
      ledger,
      resolvedOutcome: resolvedSide,
      yesMarkPrice: yesMark,
    },
  ]);
  // A realized subtotal is not the whole position result when the remainder
  // cannot be valued. Never replace that missing result with the note's old PnL.
  const pnl = totals.unmarkedOpenLegCount === 0 ? totals.pnlUsd : null;
  const realizedOnly =
    ledger != null && ledger.eventCount > 0 && ledger.remainingShares <= 1e-9;
  const positionResult: HunchPositionResult | null =
    pnl != null && Number.isFinite(pnl)
      ? {
          pnlUsd: pnl,
          // Even the activity ledger can be incomplete; these are tracked estimates,
          // not an assertion of the wallet's on-chain realized profit.
          approximate: true,
          source: ledger?.hasSnapshotEvents ? "snapshot_delta" : "activity",
          valuation: realizedOnly
            ? "realized"
            : settled
              ? "resolution"
              : useQuote
                ? "quote"
                : "position_snapshot",
          activityAsOf: ledger?.lastActivityAt?.toISOString() ?? null,
          snapshotAsOf: row.snapshot_at?.toISOString() ?? null,
          priceAsOf: realizedOnly
            ? null
            : settled
              ? (row.resolution_observed_at?.toISOString() ?? null)
              : ((useQuote ? row.quote_at : row.snapshot_at)?.toISOString() ??
                null),
        }
      : null;
  const metrics = calculateWalletPositionApproxMetrics(
    {
      walletId: row.wallet_id,
      marketId: row.market_id,
      outcomeSide: row.outcome_side,
      shares: numeric(row.shares),
      price: numeric(row.price),
      bestBid: yesMark,
      bestAsk: yesMark,
      lastPrice: null,
      resolvedOutcome: resolvedSide,
      resolvedOutcomePct: resolvedPct,
    },
    ledger,
  );
  const inCurrentBatch =
    row.snapshot_at != null &&
    row.wallet_snapshot_at != null &&
    row.snapshot_at.getTime() === row.wallet_snapshot_at.getTime();
  return {
    ...metrics,
    // Keep the existing latestPosition contract about the live portfolio, not
    // a stale holding resurrected from a closed market.
    positionShares: inCurrentBatch ? numeric(row.shares) : null,
    positionSizeUsd: inCurrentBatch ? numeric(row.size_usd) : null,
    snapshotAt: inCurrentBatch ? row.snapshot_at : null,
    positionResult,
  };
}

export async function loadHunchHolderPositions(
  client: Pick<PoolClient, "query">,
  inputs: WalletPositionNowKeyInput[],
): Promise<Map<string, HunchHolderPosition>> {
  const keys = [
    ...new Map(
      inputs.flatMap((input) => {
        const side = normalizeOutcomeSideForApi(input.outcomeSide);
        return side
          ? [
              [
                makeWalletPositionLedgerKey(
                  input.walletId,
                  input.marketId,
                  side,
                ),
                {
                  ...input,
                  outcomeSide: side,
                },
              ] as const,
            ]
          : [];
      }),
    ).values(),
  ];
  if (keys.length === 0) return new Map();
  const { rows } = await client.query<HunchPositionRow>(
    HUNCH_HOLDER_POSITIONS_SQL,
    [
      JSON.stringify(
        keys.map((k) => ({
          wallet_id: k.walletId,
          venue: k.venue,
          market_id: k.marketId,
          outcome_side: k.outcomeSide,
        })),
      ),
    ],
  );
  const ledgers = await loadWalletPositionLedgerMap(client, keys);
  return new Map(
    rows.map((row) => {
      const key = makeWalletPositionLedgerKey(
        row.wallet_id,
        row.market_id,
        row.outcome_side,
      );
      return [key, buildHunchHolderPosition(row, ledgers.get(key))];
    }),
  );
}
