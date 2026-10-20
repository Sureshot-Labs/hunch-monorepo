import type { PoolClient } from "pg";
import {
  hip4FillRepairSchema,
  hip4LedgerRepairSchema,
  hip4PositionAccountingSchema,
  type Hip4AccountObservation,
} from "../schemas/hip4-account.js";
import { projectHip4PositionBasis } from "./hip4-position-accounting.js";
import { hip4FillCoveredThrough } from "./hip4-tail-history.js";
import {
  HIP4_BASIS_CASH_RECEIPTS_SQL,
  hip4ProvenCashLedgerEntries,
  type Hip4BasisLedgerEntry,
} from "./hip4-cash-ledger-evidence.js";
import { isHypercoreMainnetUsdc } from "../funding/domain/hypercore-identity.js";

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
  const ends = [
    hip4FillCoveredThrough({
      environment: input.environment,
      address: input.address,
      snapshotTime: observedTime,
      repair: fillsCoverage,
      tail: input.history.fillsTailCoverage,
    }),
    ledgerCoverage?.coveredThrough,
  ].filter((value): value is number => value != null);
  const coveredFrom =
    starts.length === coverages.length ? Math.max(...starts) : null;
  const coveredThrough =
    ends.length === coverages.length ? Math.min(...ends) : null;
  let incomplete =
    input.observation.unresolvedBalances.length > 0 ||
    // A failed attempt to extend an already covered range does not revoke its
    // earlier evidence. Coverage must still include the exact balance snapshot;
    // neither the failed extension nor a fresh clock establishes new coverage.
    coverages.some((row) => !row || row.gapDetailsTruncated) ||
    coveredFrom == null ||
    coveredThrough == null ||
    coveredThrough < observedTime;
  let fills: unknown[] = [];
  let ledger: Hip4BasisLedgerEntry[] = [];
  let provenQuoteTransfers: ReadonlySet<string> = new Set();
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
    const asset = {
      networkId: `hyperliquid:${input.environment}`,
      assetId: input.observation.cash.assetId,
      decimals: input.observation.cash.decimals,
    };
    if (!incomplete && isHypercoreMainnetUsdc(asset)) {
      // The existing bounded ledger read limits this exact-hash point lookup.
      // Proof is scoped to this derivation, never a durable symbol alias that
      // could outlive a canonical receipt's revocation.
      const hashes = [
        ...new Set(
          ledger.flatMap((entry) =>
            entry.delta?.type === "send" &&
            entry.delta.token === "USDC" &&
            typeof entry.hash === "string" &&
            /^0x[0-9a-fA-F]{64}$/u.test(entry.hash)
              ? [entry.hash.toLowerCase()]
              : [],
          ),
        ),
      ];
      if (hashes.length) {
        const receipts = await db.query(HIP4_BASIS_CASH_RECEIPTS_SQL, [hashes]);
        provenQuoteTransfers = hip4ProvenCashLedgerEntries({
          environment: input.environment,
          address: input.address,
          assetId: asset.assetId,
          decimals: asset.decimals,
          ledger,
          observations: receipts.rows,
        });
      }
    }
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
      provenQuoteTransfers,
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
