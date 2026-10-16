import type { Pool } from "@hunch/infra";
import {
  FUNDING_NATIVE_SNAPSHOT_DEBIT_CANDIDATES_SQL,
  requireAdmittedFundingSnapshotDebits,
  FundingSnapshotDebitEvidenceError,
  type FundingSnapshotDebitRow,
} from "../../account-value/funding-snapshot-debits.js";
import type { AssetLocation } from "../domain/types.js";
import {
  isHypercoreMainnetUsdc,
  hypercoreLocationDex,
} from "../domain/hypercore-identity.js";
import { fundingReservationHoldSql } from "../persistence/source-reservation-hold.js";
import { PreparationContractError } from "./core-adapter.js";
import {
  hip4OrderHoldsSql,
  hip4ReplacedConsumerHoldSql,
} from "../../repos/hip4-order-holds.js";

/** One MVCC snapshot: a reservation turning into a canonical debit must not
 * disappear between reads or be subtracted twice. Keep the common hold rules,
 * including started sends past their quote expiry and consumer reservations. */
export const HYPERCORE_PREPARATION_AVAILABILITY_SQL = `
  with native_debit_rows as materialized (${FUNDING_NATIVE_SNAPSHOT_DEBIT_CANDIDATES_SQL}),
  native_order_holds as (
    select held_order.raw_amount
    from jsonb_to_recordset($2::jsonb) recipient_snapshot(address text,snapshot_at timestamptz,native_source_dex text)
    cross join lateral (${hip4OrderHoldsSql({
      userId: "$1",
      address: "recipient_snapshot.address",
      assetId: "'0x6d1e7cde53ba9467b783cb7c530ce054'",
      snapshotMs: "(extract(epoch from recipient_snapshot.snapshot_at)*1000)",
    })}) held_order where coalesce(recipient_snapshot.native_source_dex,'spot')='spot'
  ),
  native_pending_holds as (
    select balance_reservations.raw_amount
    from jsonb_to_recordset($2::jsonb) as recipient_snapshot(
      location_id text, address text, asset_decimals integer)
    join balance_reservations
      on balance_reservations.user_id=$1
      and balance_reservations.location_id=recipient_snapshot.location_id
      and balance_reservations.network_id='hyperliquid:mainnet'
      and balance_reservations.asset_id='0x6d1e7cde53ba9467b783cb7c530ce054'
      and balance_reservations.asset_decimals=recipient_snapshot.asset_decimals
      and balance_reservations.state='active'
    where (${fundingReservationHoldSql("balance_reservations")}
      or (balance_reservations.mode='settled_for_consumer' and exists(
        select 1 from funding_trade_attempts attempt_row
        where attempt_row.reservation_id=balance_reservations.id
          and attempt_row.state in ('claimed','submission_started','ambiguous'))))
      and not ${hip4ReplacedConsumerHoldSql("balance_reservations")}
      and not exists (
        select 1 from funding_observations settled_debit
        where settled_debit.operation_id=balance_reservations.operation_id
          and settled_debit.segment_id is not distinct from balance_reservations.segment_id
          and settled_debit.network_id=balance_reservations.network_id
          and settled_debit.asset_id=balance_reservations.asset_id
          and settled_debit.asset_decimals=balance_reservations.asset_decimals
          and lower(settled_debit.from_address)=recipient_snapshot.address
          and settled_debit.kind='source_debit' and settled_debit.canonical
          and settled_debit.finality_status='finalized'
      )
  )
  select
    (coalesce((select sum(raw_amount::numeric) from native_pending_holds),0)
      +coalesce((select sum(raw_amount::numeric) from native_order_holds),0))::text as reserved_raw,
    coalesce((select sum(raw_amount::numeric) from native_debit_rows where strict_match),0)::text as submitted_debit_raw,
    coalesce((select jsonb_agg(to_jsonb(debit_candidate)) from native_debit_rows debit_candidate where not strict_match),'[]'::jsonb) as debit_alias_candidates
`;

export async function loadHypercorePreparationAvailability(
  db: Pick<Pool, "query">,
  input: { accountId: string; location: AssetLocation; observedAt: string },
): Promise<{ reservedRaw: string; submittedDebitRaw: string }> {
  const { location } = input;
  if (
    location.accountId !== input.accountId ||
    location.kind !== "venue_account" ||
    hypercoreLocationDex(location) === null ||
    !isHypercoreMainnetUsdc(location.asset) ||
    typeof location.details.address !== "string" ||
    !/^0x[\da-fA-F]{40}$/.test(location.details.address) ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    Date.parse(input.observedAt) > Date.now()
  )
    throw new PreparationContractError(
      "evidence_invalid",
      "Native recipient availability identity is invalid",
    );
  const { rows } = await db.query<{
    reserved_raw: string;
    submitted_debit_raw: string;
    debit_alias_candidates: FundingSnapshotDebitRow[];
  }>(HYPERCORE_PREPARATION_AVAILABILITY_SQL, [
    input.accountId,
    JSON.stringify([
      {
        // Physical aliases are not additional cash. A historical reservation's
        // component name does not change its exact owned account/location/asset.
        component_id: null,
        location_id: location.locationId,
        address: location.details.address.toLowerCase(),
        asset_decimals: location.asset.decimals,
        snapshot_at: input.observedAt,
        native_source_dex: hypercoreLocationDex(location),
      },
    ]),
  ]);
  const row = rows[0];
  if (
    !row ||
    !Array.isArray(row.debit_alias_candidates) ||
    !/^(0|[1-9][0-9]*)$/.test(row.reserved_raw) ||
    !/^(0|[1-9][0-9]*)$/.test(row.submitted_debit_raw)
  )
    throw new PreparationContractError(
      "evidence_invalid",
      "Native availability facts are invalid",
    );
  let aliases: FundingSnapshotDebitRow[];
  try {
    aliases = requireAdmittedFundingSnapshotDebits(
      input.accountId,
      row.debit_alias_candidates,
    );
  } catch (error) {
    if (!(error instanceof FundingSnapshotDebitEvidenceError)) throw error;
    throw new PreparationContractError("evidence_invalid", error.message);
  }
  return {
    reservedRaw: row.reserved_raw,
    submittedDebitRaw: (
      BigInt(row.submitted_debit_raw) +
      aliases.reduce((sum, debit) => sum + BigInt(debit.raw_amount), 0n)
    ).toString(),
  };
}
