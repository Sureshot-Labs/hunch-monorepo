import type { PoolClient } from "@hunch/infra";
import { sameAccountAddress, sameAsset } from "../domain/asset-identity.js";
import {
  fundingRefundReceiptMatchesContract,
  readFundingRefundContract,
  readFundingRefundReceiptIdentity,
} from "../domain/refund-settlement.js";
import { isRecord } from "../../lib/type-guards.js";
import type { OwnedRouteCanonicalDestinationEvent } from "./owned-route-destination-observer.js";

export const EXACT_REFUND_CORRELATION_PENDING =
  "exact_refund_correlation_pending";
export type RecordedExactRefundClassification =
  | Readonly<{ kind: "unmatched" }>
  | Readonly<{ kind: "internal"; operationId: string; segmentId: string }>
  | Readonly<{
      kind: "recovery_required";
      reason:
        | "exact_refund_receipt_conflict"
        | "exact_refund_receipt_not_final";
    }>;

/** Absence here is NOT proof of an external deposit: the refund observer may
 * not have written the receipt yet. The caller must also resolve the pending
 * source-action candidates before allocating a receive credit. */
export const RECORDED_EXACT_REFUND_EVENTS_SQL = `
  select event_key.identity, receipt_row.id as observation_id,
    receipt_row.operation_id, receipt_row.segment_id,
    receipt_row.network_id, receipt_row.asset_id, receipt_row.asset_decimals,
    receipt_row.raw_amount, receipt_row.from_address, receipt_row.to_address,
    receipt_row.ledger_height, receipt_row.block_hash,
    receipt_row.canonical, receipt_row.finality_status, receipt_row.metadata,
    operation_row.user_id,
    segment_row.refund_location_snapshot,
    segment_row.provider_quote_ref_lookup_hmac, segment_row.lookup_key_version
  from jsonb_to_recordset($1::jsonb) as event_key(
    identity text, network_id text, tx_hash text, event_index text)
  join lateral (
    select * from funding_observations candidate_row
    where candidate_row.network_id=event_key.network_id
      and candidate_row.tx_hash=event_key.tx_hash
      and candidate_row.event_index=event_key.event_index
      and candidate_row.kind='refund_credit'
    -- Two different claims already prove a collision; this is not a page of
    -- historical operations and needs neither a status nor a time cutoff.
    limit 2
  ) receipt_row on true
  join funding_operations operation_row on operation_row.id=receipt_row.operation_id
  left join funding_operation_segments segment_row
    on segment_row.operation_id=receipt_row.operation_id
      and segment_row.id=receipt_row.segment_id and segment_row.provider_id='relay'`;

export type RecordedRefundRow = Readonly<{
  identity: string;
  observation_id: string;
  operation_id: string;
  segment_id: string | null;
  user_id: string;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  raw_amount: string;
  from_address: string | null;
  to_address: string;
  ledger_height: string | null;
  block_hash: string | null;
  canonical: boolean;
  finality_status: string;
  metadata: unknown;
  refund_location_snapshot: unknown;
  provider_quote_ref_lookup_hmac: string | null;
  lookup_key_version: number | null;
}>;

export function refundCanonicalEventKey(
  event: OwnedRouteCanonicalDestinationEvent,
): string {
  return [
    event.networkId,
    event.transactionHash.toLowerCase(),
    event.eventIndex,
  ].join(":");
}

const conflict = (): RecordedExactRefundClassification => ({
  kind: "recovery_required",
  reason: "exact_refund_receipt_conflict",
});

/** Pure full-envelope check, shared with offline/PG tests. A changed block or
 * reorged record remains uncertain rather than becoming a new external credit. */
export function classifyRecordedExactRefund(
  userId: string,
  event: OwnedRouteCanonicalDestinationEvent,
  rows: readonly RecordedRefundRow[],
): RecordedExactRefundClassification {
  if (!rows.length) return { kind: "unmatched" };
  if (rows.length !== 1) return conflict();
  const row = rows[0];
  const snapshot = row.refund_location_snapshot;
  const contract = readFundingRefundContract(snapshot, {
    requestFingerprint: row.provider_quote_ref_lookup_hmac,
    lookupKeyVersion: row.lookup_key_version,
  });
  const metadata = row.metadata;
  // This observer owns only explicitly opted-in routes/receipts. Older venue
  // refunds keep their existing classification path, including records without
  // the new snapshot marker. A malformed marker or partial new receipt does not
  // become legacy merely because one piece of its identity is missing.
  if (
    !contract &&
    !(
      isRecord(metadata) &&
      (metadata.observerId === "relay_exact_refund_observation_v1" ||
        Object.hasOwn(metadata, "relayRefundReceipt"))
    )
  )
    return { kind: "unmatched" };
  const alternatives =
    isRecord(snapshot) && isRecord(snapshot.alternativeRefundLocations)
      ? snapshot.alternativeRefundLocations.locations
      : [];
  const ownersMatch =
    isRecord(snapshot) &&
    snapshot.accountId === userId &&
    Array.isArray(alternatives) &&
    alternatives.every(
      (location) => isRecord(location) && location.accountId === userId,
    );
  if (
    !row.segment_id ||
    row.user_id !== userId ||
    !ownersMatch ||
    !contract?.supported ||
    row.identity !== refundCanonicalEventKey(event) ||
    !isRecord(metadata) ||
    metadata.observerId !== "relay_exact_refund_observation_v1" ||
    (metadata.nativeDestinationDex !== undefined &&
      metadata.nativeDestinationDex !== null) ||
    event.networkId !== event.asset.networkId ||
    !sameAsset(
      {
        networkId: row.network_id,
        assetId: row.asset_id,
        decimals: row.asset_decimals,
      },
      event.asset,
    ) ||
    row.raw_amount !== event.rawAmount ||
    !/^[1-9]\d*$/.test(event.rawAmount) ||
    !sameAccountAddress(
      event.networkId,
      row.to_address,
      event.destinationAddress,
    ) ||
    !row.from_address ||
    !event.sourceAddress ||
    !sameAccountAddress(
      event.networkId,
      row.from_address,
      event.sourceAddress,
    ) ||
    row.ledger_height !== event.ledgerHeight ||
    !row.block_hash ||
    !event.blockHash ||
    row.block_hash.toLowerCase() !== event.blockHash.toLowerCase() ||
    !fundingRefundReceiptMatchesContract(contract, {
      observationId: row.observation_id,
      money: { asset: event.asset, raw: event.rawAmount },
      destinationAddress: event.destinationAddress,
      nativeDestinationDex: null,
      identity: readFundingRefundReceiptIdentity(metadata.relayRefundReceipt),
      completionProofs: [],
    })
  )
    return conflict();
  if (!row.canonical || row.finality_status !== "finalized")
    return {
      kind: "recovery_required",
      reason: "exact_refund_receipt_not_final",
    };
  return {
    kind: "internal",
    operationId: row.operation_id,
    segmentId: row.segment_id,
  };
}

/** Indexed exact-physical-key lookup, including terminal/reorged records.
 * Batching uses the receive scanner's bounded event batch. No provider IO. */
export async function classifyRecordedRelayExactRefundEvents(
  db: Pick<PoolClient, "query">,
  input: {
    userId: string;
    events: readonly OwnedRouteCanonicalDestinationEvent[];
  },
): Promise<ReadonlyMap<string, RecordedExactRefundClassification>> {
  const events = input.events.filter(
    (event) => event.networkId === "evm:8453" || event.networkId === "evm:137",
  );
  const byKey = new Map<string, OwnedRouteCanonicalDestinationEvent[]>();
  for (const event of events) {
    const key = refundCanonicalEventKey(event);
    byKey.set(key, [...(byKey.get(key) ?? []), event]);
  }
  if (!byKey.size) return new Map();
  const { rows } = await db.query<RecordedRefundRow>(
    RECORDED_EXACT_REFUND_EVENTS_SQL,
    [
      JSON.stringify(
        [...byKey].map(([identity, [event]]) => ({
          identity,
          network_id: event.networkId,
          tx_hash: event.transactionHash.toLowerCase(),
          event_index: event.eventIndex,
        })),
      ),
    ],
  );
  return new Map(
    [...byKey].map(([key, group]) => {
      const envelope = (event: OwnedRouteCanonicalDestinationEvent) =>
        JSON.stringify([
          event.networkId,
          event.asset.networkId,
          event.asset.assetId.toLowerCase(),
          event.asset.decimals,
          event.destinationAddress.toLowerCase(),
          event.sourceAddress?.toLowerCase(),
          event.rawAmount,
          event.ledgerHeight,
          event.blockHash?.toLowerCase(),
        ]);
      if (group.some((event) => envelope(event) !== envelope(group[0])))
        return [key, conflict()];
      const matching = rows.filter((row) => row.identity === key);
      const decisions = group.map((event) =>
        classifyRecordedExactRefund(input.userId, event, matching),
      );
      // Repeated keys with inconsistent envelopes cannot win by input order.
      return [
        key,
        decisions.find((decision) => decision.kind === "recovery_required") ??
          decisions[0],
      ];
    }),
  );
}
