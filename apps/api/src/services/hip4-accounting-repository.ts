import type { PoolClient } from "pg";
import {
  hip4FillRepairSchema,
  hip4LedgerRepairSchema,
  hip4PositionAccountingSchema,
  type Hip4AccountObservation,
} from "../schemas/hip4-account.js";
import { projectHip4PositionBasis } from "./hip4-position-accounting.js";

export const HIP4_BASIS_FILLS_SQL = `select provider_fill from hip4_account_executions
  where environment=$1 and account_address=$2 and time_ms>=$3 and time_ms<=$4
  order by time_ms,coin,tid,oid limit $5`;
export const HIP4_BASIS_LEDGER_SQL = `select ledger_entry from hip4_account_ledger
  where environment=$1 and account_address=$2 and time_ms>=$3 and time_ms<=$4
  order by time_ms,event_key limit $5`;

/** Called in the existing lease transaction AFTER inserting facts, so the
 * derivation and its exact balance snapshot are published atomically. Bound
 * local reads; never fetch a provider here or block valid balances on history.
 */
export async function readHip4PositionAccounting(
  db: Pick<PoolClient, "query">,
  input: {
    environment: "mainnet" | "testnet";
    address: string;
    observation: Hip4AccountObservation;
    history: Record<string, unknown>;
    maxRows: number;
    conflicts: Record<string, number>;
  },
) {
  const observedTime = Date.parse(input.observation.observedAt);
  const fillsCoverage = hip4FillRepairSchema.safeParse(
    input.history.fillRepair,
  ).data;
  const ledgerCoverage = hip4LedgerRepairSchema.safeParse(
    input.history.ledgerRepair,
  ).data;
  const coverages = [fillsCoverage, ledgerCoverage];
  const starts = coverages
    .map((row) => row?.coveredFrom)
    .filter((value): value is number => value != null);
  const ends = coverages
    .map((row) => row?.coveredThrough)
    .filter((value): value is number => value != null);
  const coveredFrom =
    starts.length === coverages.length ? Math.max(...starts) : null;
  const coveredThrough =
    ends.length === coverages.length ? Math.min(...ends) : null;
  let incomplete =
    input.observation.unresolvedBalances.length > 0 ||
    coverages.some(
      (row) => !row || row.gapDetailsTruncated || !!row.lastError,
    ) ||
    coveredFrom == null ||
    coveredThrough == null ||
    coveredThrough < observedTime;
  let fills: unknown[] = [];
  let ledger: { time: number; delta: Record<string, unknown> }[] = [];
  if (!incomplete && input.observation.positions.length) {
    const params = [
      input.environment,
      input.address,
      coveredFrom,
      observedTime,
      input.maxRows + 1,
    ];
    const fillRows = await db.query(HIP4_BASIS_FILLS_SQL, params);
    const ledgerRows = await db.query(HIP4_BASIS_LEDGER_SQL, params);
    incomplete =
      fillRows.rows.length > input.maxRows ||
      ledgerRows.rows.length > input.maxRows;
    fills = fillRows.rows.map((row) => row.provider_fill);
    ledger = ledgerRows.rows.map((row) => row.ledger_entry);
  }
  return hip4PositionAccountingSchema.parse({
    version: 1,
    observedAt: input.observation.observedAt,
    method: "observed_zero_anchor_weighted_average",
    feeTreatment: "buy_fees_in_basis_sell_fees_in_realized",
    allTimeComplete: false,
    positions: projectHip4PositionBasis({
      positions: input.observation.positions,
      fills,
      ledger,
      quoteLedgerToken: `USDC:${input.observation.cash.assetId}`,
      observedTime,
      coveredFrom,
      coveredThrough,
      incomplete,
      conflicts: input.conflicts,
      gaps: coverages.flatMap((row) => row?.gaps.map((gap) => gap.time) ?? []),
    }),
  });
}
