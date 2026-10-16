import type { PoolClient } from "@hunch/infra";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";
import { sameAccountAddress, sameAsset } from "../domain/asset-identity.js";
import { hypercoreLocationDex } from "../domain/hypercore-identity.js";
import { assetLocationSchema, moneySchema } from "../domain/schemas.js";
import type { AssetRef, Money } from "../domain/types.js";
import { readCommittedFundingIdentity } from "../domain/committed-economic-identity.js";

export type RefundNativeDestination = Readonly<{
  asset: AssetRef;
  address: string;
  minimum: Money;
  dex: "spot" | "";
}>;

/** Frozen owned target and min output of this exact route, not current balance
 * or nominal input. Missing/legacy bindings cannot clear native source risk. */
export function readRefundNativeDestination(input: {
  userId: string;
  destination: unknown;
  minimum: unknown;
  operationSourceSnapshot?: unknown;
}): RefundNativeDestination | null {
  const target = input.destination;
  const location = assetLocationSchema.safeParse(
    target &&
      typeof target === "object" &&
      "kind" in target &&
      target.kind === "owned_location" &&
      "location" in target
      ? target.location
      : null,
  );
  const minimum = moneySchema.safeParse(input.minimum);
  if (!location.success || !minimum.success) return null;
  const dex = hypercoreLocationDex(location.data);
  return dex !== null &&
    readCommittedFundingIdentity({
      currentOwnerUserId: input.userId,
      operationSourceSnapshot: input.operationSourceSnapshot,
      accountIds: [location.data.accountId],
    }) !== null &&
    typeof location.data.details.address === "string" &&
    /^0x[0-9a-f]{40}$/iu.test(location.data.details.address) &&
    sameAsset(location.data.asset, minimum.data.asset) &&
    /^[1-9]\d{0,77}$/u.test(minimum.data.raw)
    ? {
        asset: location.data.asset,
        address: location.data.details.address,
        minimum: minimum.data,
        dex,
      }
    : null;
}

export type RefundDestinationObservation = Readonly<{
  id: string;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  tx_hash: string;
  event_index: string;
  from_address: string | null;
  to_address: string;
  raw_amount: string;
  ledger_height: string | null;
  block_hash: string | null;
  observer_id: string | null;
  native_destination_dex: string | null;
}>;

/** Consumes the existing canonical destination writer's physical receipt.
 * Synthetic owned-route balance-delta keys are deliberately not settlement.
 * Canonical/finality/operation/segment checks belong to the enclosing page. */
export function refundDestinationObservationMatches(
  target: RefundNativeDestination,
  row: RefundDestinationObservation,
): boolean {
  return (
    row.observer_id === "relay_owned_destination_observation_v1" &&
    row.event_index === "hypercore:send:destination_credit" &&
    /^0x[0-9a-f]{64}$/u.test(row.tx_hash) &&
    /^0x[0-9a-f]{40}$/iu.test(row.from_address ?? "") &&
    row.ledger_height === null &&
    row.block_hash === null &&
    row.native_destination_dex === target.dex &&
    /^[1-9]\d{0,77}$/u.test(row.raw_amount) &&
    sameAsset(
      {
        networkId: row.network_id,
        assetId: row.asset_id,
        decimals: row.asset_decimals,
      },
      target.asset,
    ) &&
    sameAccountAddress(row.network_id, row.to_address, target.address)
  );
}

// Exact PK + one caller-bounded page of identities. Read only membership bits,
// never the append-only reference array or full provider/audit JSON.
export const REFUND_DESTINATION_REFERENCES_SQL = `select receipt_key.id
  from funding_operation_segments segment_row
  cross join jsonb_to_recordset($3::jsonb) as receipt_key(id uuid,fingerprint text)
  where segment_row.operation_id=$1::uuid and segment_row.id=$2::uuid
    and coalesce(segment_row.support_metadata->'relaySuccessfulDestinationReferenceHashesV1','[]'::jsonb)
      @> jsonb_build_array(receipt_key.fingerprint)`;

export async function readRefundDestinationReferences(
  db: Pick<PoolClient, "query">,
  input: {
    operationId: string;
    segmentId: string;
    receipts: readonly Pick<RefundDestinationObservation, "id" | "tx_hash">[];
  },
): Promise<ReadonlySet<string>> {
  if (!input.receipts.length) return new Set();
  const { rows } = await db.query<{ id: string }>(
    REFUND_DESTINATION_REFERENCES_SQL,
    [
      input.operationId,
      input.segmentId,
      JSON.stringify(
        input.receipts.map((row) => ({
          id: row.id,
          fingerprint: relayDestinationReferenceIdentity(row.tx_hash),
        })),
      ),
    ],
  );
  return new Set(rows.map((row) => row.id));
}
