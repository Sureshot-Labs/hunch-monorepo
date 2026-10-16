import type { Pool } from "@hunch/infra";
import { isRecord } from "../lib/type-guards.js";
import { assetLocationSchema } from "../funding/domain/schemas.js";
import { readCommittedFundingIdentity } from "../funding/domain/committed-economic-identity.js";
import {
  sameAccountAddress,
  sameAsset,
} from "../funding/domain/asset-identity.js";
import { hypercoreLocationDex } from "../funding/domain/hypercore-identity.js";
import type { AssetLocation } from "../funding/domain/types.js";
import { committedFundingReadLocationAlias } from "./funding-read-location-identity.js";

/** Start with the indexed physical post-snapshot debit tail. Alias proofs are
 * operation-scoped; never discover aliases by scanning old users/merge audit.
 * Strict exports retain the old SQL-only contract. Candidate exports MUST pass
 * admitFundingSnapshotDebits before any money is summed. */
function snapshotDebitsSql(native: boolean, candidates: boolean): string {
  const componentMatch = native
    ? "(source_snapshot.component_id is null or reservation_row.component_id=source_snapshot.component_id)"
    : "reservation_row.component_id=source_snapshot.component_id";
  const reservationScope = `reservation_row.operation_id=debit.operation_id
    and reservation_row.user_id=$1
    and reservation_row.segment_id is not distinct from debit.segment_id
    and reservation_row.network_id=debit.network_id
    and ${native ? "reservation_row.asset_id=debit.asset_id" : "lower(reservation_row.asset_id)=lower(debit.asset_id)"}
    and reservation_row.asset_decimals=debit.asset_decimals
    and reservation_row.mode='subtract_available'`;
  return `select source_snapshot.component_id as source_component_id,
    source_snapshot.location_id as source_location_id,
    debit.operation_id, debit.segment_id, debit.network_id, debit.asset_id,
    debit.asset_decimals, debit.raw_amount,
    coalesce(debit.finalized_at,debit.observed_at) as observed_at
    ${
      candidates
        ? `,${native ? "source_snapshot.native_source_dex as source_native_dex," : ""}debit.id::text as debit_id, lower(debit.from_address) as source_address,
      reservation_proof.strict_match,
      case when not reservation_proof.strict_match then operation_row.source_snapshot end as operation_source_snapshot,
      case when not reservation_proof.strict_match then segment_row.source_snapshot end as segment_source_snapshot,
      case when not reservation_proof.strict_match then reservation_proof.proofs end as reservation_proofs`
        : ""
    }
    from jsonb_to_recordset($2::jsonb) as source_snapshot(
      component_id text, location_id text, address text, asset_decimals integer,
      snapshot_at timestamptz ${native ? ",native_source_dex text" : ",network_id text, asset_id text"})
    join funding_observations debit on
      ${native ? "debit.network_id='hyperliquid:mainnet' and debit.asset_id='0x6d1e7cde53ba9467b783cb7c530ce054'" : "debit.network_id in ('evm:8453','evm:137') and debit.network_id=source_snapshot.network_id and lower(debit.asset_id)=source_snapshot.asset_id and debit.asset_decimals=6"}
      and debit.asset_decimals=source_snapshot.asset_decimals
      and lower(debit.from_address)=source_snapshot.address
      and coalesce(debit.finalized_at,debit.observed_at)>source_snapshot.snapshot_at
      and debit.kind='source_debit' and debit.canonical and debit.finality_status='finalized'
    join funding_operations operation_row on operation_row.id=debit.operation_id and operation_row.user_id=$1
    ${
      candidates
        ? `cross join lateral (
      select coalesce(bool_or(${componentMatch} and reservation_row.location_id=source_snapshot.location_id),false) as strict_match,
        jsonb_agg(jsonb_build_object('componentId',reservation_row.component_id,'locationId',reservation_row.location_id)) as proofs
      from balance_reservations reservation_row where ${reservationScope}
    ) reservation_proof
    left join funding_operation_segments segment_row on not reservation_proof.strict_match
      and segment_row.id=debit.segment_id and segment_row.operation_id=debit.operation_id
    where reservation_proof.proofs is not null`
        : `where exists(select 1 from balance_reservations reservation_row where ${reservationScope}
      and ${componentMatch} and reservation_row.location_id=source_snapshot.location_id)`
    }`;
}

export const FUNDING_NATIVE_SNAPSHOT_DEBITS_SQL = snapshotDebitsSql(
  true,
  false,
);
export const FUNDING_EVM_SNAPSHOT_DEBITS_SQL = snapshotDebitsSql(false, false);
export const FUNDING_NATIVE_SNAPSHOT_DEBIT_CANDIDATES_SQL = snapshotDebitsSql(
  true,
  true,
);
export const FUNDING_EVM_SNAPSHOT_DEBIT_CANDIDATES_SQL = snapshotDebitsSql(
  false,
  true,
);

export type FundingSnapshotDebitRow = {
  source_component_id: string | null;
  source_location_id: string;
  operation_id: string;
  segment_id: string | null;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  raw_amount: string;
  observed_at: Date | string;
  debit_id: string;
  source_address: string;
  strict_match: boolean;
  source_native_dex?: "spot" | "" | null;
  operation_source_snapshot?: unknown;
  segment_source_snapshot?: unknown;
  reservation_proofs?: unknown;
};

/** Proof of an original/current physical namespace, not address-only matching.
 * Also identifies genuinely other-class debits, which must not fence cash in
 * the requested class. Invalid/ambiguous evidence remains a blocking unknown. */
function snapshotDebitAlias(userId: string, row: FundingSnapshotDebitRow) {
  const rawSource =
    row.segment_id === null
      ? row.operation_source_snapshot
      : row.segment_source_snapshot;
  const wrapped =
    isRecord(rawSource) && isRecord(rawSource.source)
      ? rawSource.source
      : rawSource;
  if (!isRecord(wrapped)) return null;
  const source = assetLocationSchema.safeParse(
    wrapped.kind === "owned_location" ? wrapped.location : wrapped,
  );
  if (!source.success) return null;
  const identity = readCommittedFundingIdentity({
    currentOwnerUserId: userId,
    operationSourceSnapshot: row.operation_source_snapshot,
    accountIds: [source.data.accountId],
  });
  if (!identity) return null;
  const alias = committedFundingReadLocationAlias(
    source.data as AssetLocation,
    identity,
  );
  if (
    !alias ||
    !sameAsset(alias.currentLocation.asset, {
      networkId: row.network_id,
      assetId: row.asset_id,
      decimals: row.asset_decimals,
    }) ||
    !sameAccountAddress(
      row.network_id,
      String(alias.currentLocation.details.address),
      row.source_address,
    ) ||
    !Array.isArray(row.reservation_proofs) ||
    !row.reservation_proofs.some(
      (proof: unknown) =>
        isRecord(proof) &&
        proof.locationId === alias.originalLocation.locationId &&
        (row.source_component_id === null ||
          proof.componentId === alias.originalComponentId),
    )
  )
    return null;
  return { alias, identity };
}

function isOtherNativeCashClass(
  userId: string,
  row: FundingSnapshotDebitRow,
): boolean {
  if (row.strict_match || row.network_id !== "hyperliquid:mainnet")
    return false;
  const proof = snapshotDebitAlias(userId, row);
  if (!proof) return false;
  const dex = hypercoreLocationDex(proof.alias.currentLocation);
  return dex !== null && dex !== (row.source_native_dex ?? "spot");
}

/** A single statement supplies strict matches and potential rebased matches
 * from the same MVCC snapshot (also when embedded in availability aggregates).
 * Never use address equality or balanceLocationId as economic authority. */
export function admitFundingSnapshotDebits(
  userId: string,
  rows: readonly FundingSnapshotDebitRow[],
): FundingSnapshotDebitRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify([
      row.debit_id,
      row.source_component_id,
      row.source_location_id,
    ]);
    if (seen.has(key)) return false;
    if (row.strict_match !== true) {
      const proof = snapshotDebitAlias(userId, row);
      if (!proof || proof.identity.originalEconomicAccountId === userId)
        return false;
      const { alias } = proof;
      if (
        alias.currentLocation.locationId !== row.source_location_id ||
        (alias.currentLocation.kind !== "wallet" &&
          (hypercoreLocationDex(alias.currentLocation) === null ||
            hypercoreLocationDex(alias.currentLocation) !==
              (row.source_native_dex ?? "spot"))) ||
        (row.source_component_id !== null &&
          row.source_component_id !== alias.currentComponentId) ||
        (row.source_component_id === null &&
          alias.currentLocation.kind === "wallet")
      )
        return false;
    }
    seen.add(key);
    return true;
  });
}

function snapshotDebitKey(row: FundingSnapshotDebitRow): string {
  return JSON.stringify([
    row.debit_id,
    row.source_component_id,
    row.source_location_id,
  ]);
}

/** Rejected proof is unknown accounting, not a confirmed absence of a debit.
 * Keep it separate from admitted money; a fresh physical snapshot naturally
 * removes the candidate through the same indexed time-tail predicate. */
export function partitionFundingSnapshotDebits(
  userId: string,
  rows: readonly FundingSnapshotDebitRow[],
): {
  accepted: FundingSnapshotDebitRow[];
  rejected: FundingSnapshotDebitRow[];
} {
  const accepted = admitFundingSnapshotDebits(userId, rows);
  const seen = new Set(accepted.map(snapshotDebitKey));
  const rejected = rows.filter((row) => {
    if (isOtherNativeCashClass(userId, row)) return false;
    const key = snapshotDebitKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { accepted, rejected };
}

export class FundingSnapshotDebitEvidenceError extends Error {
  constructor() {
    super(
      "Source debit evidence is incomplete; refresh the physical balance and retry",
    );
    this.name = "FundingSnapshotDebitEvidenceError";
  }
}

export function requireAdmittedFundingSnapshotDebits(
  userId: string,
  rows: readonly FundingSnapshotDebitRow[],
): FundingSnapshotDebitRow[] {
  const result = partitionFundingSnapshotDebits(userId, rows);
  if (result.rejected.length) throw new FundingSnapshotDebitEvidenceError();
  return result.accepted;
}

/** Physical native debit reader shared by order and funding send admission.
 * These callers already validate the exact current-owned physical class. */
export async function loadFundingPhysicalNativeSnapshotDebits(
  db: Pick<Pool, "query">,
  userId: string,
  location: AssetLocation,
  observedAt: string,
): Promise<FundingSnapshotDebitRow[]> {
  const { rows } = await db.query<FundingSnapshotDebitRow>(
    FUNDING_NATIVE_SNAPSHOT_DEBIT_CANDIDATES_SQL,
    [
      userId,
      JSON.stringify([
        {
          component_id: null,
          location_id: location.locationId,
          address: String(location.details.address).toLowerCase(),
          asset_decimals: location.asset.decimals,
          snapshot_at: observedAt,
          native_source_dex: hypercoreLocationDex(location),
        },
      ]),
    ],
  );
  return requireAdmittedFundingSnapshotDebits(userId, rows);
}
