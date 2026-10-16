import type { Pool } from "@hunch/infra";
import { isRecord } from "../lib/type-guards.js";
import type { ValuedAssetComponent } from "../funding/domain/types.js";
import {
  sameAccountAddress,
  sameAsset,
} from "../funding/domain/asset-identity.js";
import { readFinalizedPolymarketHandoffReceipt } from "../funding/domain/polymarket-handoff-binding.js";
import { readCommittedFundingIdentity } from "../funding/domain/committed-economic-identity.js";
import {
  polymarketHandoffBindingSql,
  readStoredPolymarketHandoffBinding,
  type PolymarketHandoffBindingRow,
} from "../funding/persistence/polymarket-handoff-binding-repository.js";
import type { FundingStepReceiptObservation } from "../funding/persistence/funding-step-receipt-repository.js";
import type { CanonicalEventOwnershipRow } from "../funding/persistence/canonical-event-lock-sql.js";
import { committedFundingReadLocationAlias } from "./funding-read-location-identity.js";
import type { FundingInTransitFact } from "./funding-movement-feed.js";

const hintUuid = (key: string) =>
  `case when handoff.evidence#>>'{polymarketHandoffReadV1,${key}}' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then (handoff.evidence#>>'{polymarketHandoffReadV1,${key}}')::uuid end`;

/** Indexed physical/time tail, followed by exact PK hydration. All mutable
 * proof is read in this statement: never combine a cached pre-reorg receipt
 * with a later event/ownership read. Hints discover gaps, never money. */
export const FUNDING_HANDOFF_SNAPSHOT_TAIL_SQL = `
select snapshot.component_id as source_component_id, snapshot.location_id as source_location_id,
  snapshot.observed_at_text as source_snapshot_observed_at,
  snapshot.network_id as physical_network_id, snapshot.asset_id as physical_asset_id,
  snapshot.asset_decimals as physical_asset_decimals, snapshot.address as physical_address,
  handoff.physical_side, handoff.operation_id, handoff.step_id,
  handoff.attempt_id, handoff.network_id, handoff.status, handoff.action_match,
  handoff.canonical, handoff.failure_code, handoff.evidence,
  handoff.ledger_height::text, handoff.block_hash, handoff.first_seen_at,
  handoff.observed_at, handoff.finalized_at, handoff.reorged_at,
  coalesce(handoff.reorged_at,handoff.finalized_at,handoff.observed_at) as change_at,
  step_row.ordinal as step_ordinal, step_row.action_fingerprint as step_fingerprint,
  step_row.executor_id as step_executor_id,
  attempt_row.canonical_action_fingerprint as attempt_fingerprint,
  attempt_row.executor_id as attempt_executor_id, attempt_row.broadcast_may_have_occurred,
  ${hintUuid("segmentId")} as bound_segment_id,
  ${hintUuid("sourceReservationId")} as bound_source_reservation_id,
  binding_row.*,
  case when event_row.id is not null then jsonb_build_object(
    'network_id',event_row.network_id,'tx_hash',event_row.tx_hash,'event_index',event_row.event_index,
    'asset_id',event_row.asset_id,'asset_decimals',event_row.asset_decimals,
    'source_address',event_row.source_address,'destination_address',event_row.destination_address,
    'raw_amount',event_row.raw_amount::text,'ledger_height',event_row.ledger_height::text,
    'block_hash',event_row.block_hash,'allocation_status',event_row.allocation_status,
    'allocation_error_code',event_row.allocation_error_code,
    'allocated_receipt_id',event_row.allocated_receipt_id,
    'allocated_receive_session_id',event_row.allocated_receive_session_id) end as physical_event
from jsonb_to_recordset($2::jsonb) snapshot(component_id text,location_id text,address text,
  network_id text,asset_id text,asset_decimals integer,snapshot_at timestamptz,observed_at_text text)
cross join lateral (
  ${["source", "controller"]
    .map(
      (side) => `select receipt_row.*, '${side}'::text as physical_side
    from funding_step_receipt_observations receipt_row
    where receipt_row.network_id='evm:137' and receipt_row.network_id=snapshot.network_id
      and receipt_row.evidence#>>'{polymarketHandoffReadV1,version}'='1'
      and receipt_row.evidence#>>'{polymarketHandoffReadV1,assetId}' ~ '^0x[0-9a-fA-F]{40}$'
      and receipt_row.evidence#>>'{polymarketHandoffReadV1,${side}Address}' ~ '^0x[0-9a-fA-F]{40}$'
      and lower(receipt_row.evidence#>>'{polymarketHandoffReadV1,assetId}')=snapshot.asset_id
      and lower(receipt_row.evidence#>>'{polymarketHandoffReadV1,${side}Address}')=snapshot.address
      and coalesce(receipt_row.reorged_at,receipt_row.finalized_at,receipt_row.observed_at)>snapshot.snapshot_at`,
    )
    .join(" union all ")}
  offset 0
) handoff
cross join lateral (select id from funding_operations where id=handoff.operation_id and user_id=$1::uuid offset 0) owned_operation
cross join lateral (select * from funding_operation_steps where id=handoff.step_id and operation_id=handoff.operation_id offset 0) step_row
cross join lateral (select * from funding_operation_step_attempts where id=handoff.attempt_id and step_id=handoff.step_id offset 0) attempt_row
left join lateral (${polymarketHandoffBindingSql({ userId: "$1::uuid", operationId: "handoff.operation_id", segmentId: hintUuid("segmentId"), sourceReservationId: hintUuid("sourceReservationId") })}) binding_row on true
left join lateral (select * from funding_receive_canonical_events
  where network_id=handoff.network_id and tx_hash=lower(handoff.evidence->>'transactionHash')
    and event_index=handoff.evidence->>'handoffEventIndex' offset 0) event_row on true`;

export type FundingHandoffSnapshotRow = PolymarketHandoffBindingRow & {
  source_component_id: string;
  source_location_id: string;
  source_snapshot_observed_at: string | null;
  physical_network_id: string;
  physical_asset_id: string;
  physical_asset_decimals: number;
  physical_address: string;
  physical_side: "source" | "controller";
  operation_id: string;
  step_id: string;
  attempt_id: string;
  network_id: string;
  status: FundingStepReceiptObservation["status"];
  action_match: boolean | null;
  canonical: boolean;
  failure_code: string | null;
  evidence: FundingStepReceiptObservation["evidence"];
  ledger_height: string | null;
  block_hash: string | null;
  first_seen_at: Date;
  observed_at: Date;
  finalized_at: Date | null;
  reorged_at: Date | null;
  change_at: Date;
  step_ordinal: number;
  step_fingerprint: string;
  step_executor_id: string;
  attempt_fingerprint: string;
  attempt_executor_id: string;
  broadcast_may_have_occurred: boolean;
  bound_segment_id: string | null;
  bound_source_reservation_id: string | null;
  physical_event:
    | (CanonicalEventOwnershipRow & {
        network_id: string;
        tx_hash: string;
        event_index: string;
      })
    | null;
};

export function projectFundingHandoffSnapshotFacts(
  userId: string,
  rows: readonly FundingHandoffSnapshotRow[],
): FundingInTransitFact[] {
  const facts: FundingInTransitFact[] = [],
    seen = new Set<string>();
  for (const row of rows) {
    const stored =
      row.bound_segment_id && row.bound_source_reservation_id
        ? readStoredPolymarketHandoffBinding(row, {
            userId,
            operationId: row.operation_id,
            segmentId: row.bound_segment_id,
            sourceReservationId: row.bound_source_reservation_id,
          })
        : null;
    const binding = stored?.binding;
    const hint = row.evidence.polymarketHandoffReadV1;
    const proof =
      binding &&
      row.physical_event &&
      row.step_fingerprint === binding.handoffFingerprint &&
      row.step_executor_id === binding.handoffExecutorId &&
      isRecord(hint) &&
      hint.stepId === row.step_id &&
      hint.controllerFenceId === stored.controllerFenceId
        ? readFinalizedPolymarketHandoffReceipt({
            operationId: row.operation_id,
            binding,
            attempt: {
              operationId: row.operation_id,
              id: row.attempt_id,
              stepId: row.step_id,
              stepOrdinal: row.step_ordinal,
              actionFingerprint: row.attempt_fingerprint,
              executorId: row.attempt_executor_id,
              broadcastMayHaveOccurred: row.broadcast_may_have_occurred,
            },
            receipt: {
              operationId: row.operation_id,
              stepId: row.step_id,
              attemptId: row.attempt_id,
              networkId: row.network_id,
              status: row.status,
              actionMatch: row.action_match,
              canonical: row.canonical,
              failureCode: row.failure_code,
              ledgerHeight: row.ledger_height,
              blockHash: row.block_hash,
              evidence: row.evidence,
              firstSeenAt: row.first_seen_at,
              observedAt: row.observed_at,
              finalizedAt: row.finalized_at,
              reorgedAt: row.reorged_at,
            },
            event: row.physical_event,
          })
        : null;
    const location =
      binding &&
      (row.physical_side === "source"
        ? binding.economicSource
        : binding.executionSource);
    const reservation =
      binding &&
      (row.physical_side === "source"
        ? binding.sourceReservation
        : binding.controllerFence);
    const identity =
      location &&
      readCommittedFundingIdentity({
        currentOwnerUserId: userId,
        operationSourceSnapshot: row.source_snapshot,
        accountIds: [location.accountId],
      });
    const alias =
      location && identity && location.accountId !== userId
        ? committedFundingReadLocationAlias(location, identity)
        : null;
    const currentLocation = alias?.currentLocation ?? location;
    const currentComponentId =
      alias?.currentComponentId ?? reservation?.componentId;
    const matchesPhysical =
      currentLocation &&
      currentLocation.accountId === userId &&
      currentLocation.locationId === row.source_location_id &&
      currentComponentId === row.source_component_id &&
      sameAsset(currentLocation.asset, {
        networkId: row.physical_network_id,
        assetId: row.physical_asset_id,
        decimals: row.physical_asset_decimals,
      }) &&
      typeof currentLocation.details.address === "string" &&
      sameAccountAddress(
        row.physical_network_id,
        currentLocation.details.address,
        row.physical_address,
      );
    const valid = Boolean(proof && matchesPhysical);
    // Neither latest-RPC cash snapshot retains a ledger height. Its timestamp
    // is captured BEFORE IO, so it may already include H even before the first
    // finality poll. Never subtract H by that wallclock ordering (90 -> 80),
    // or assert controller10-H/D as known0. A normal post-finality balance read
    // removes this narrow unknown tail; no new delay or repair write is needed.
    const error = !valid
      ? "funding_source_evidence_invalid"
      : "funding_handoff_snapshot_pending";
    const key = JSON.stringify([
      row.source_component_id,
      valid
        ? [row.network_id, proof?.transactionHash, proof?.eventIndex]
        : [row.operation_id, row.attempt_id],
      row.physical_side,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      operationId: row.operation_id,
      segmentId: row.bound_segment_id,
      sourceComponentId: row.source_component_id,
      sourceLocationId: row.source_location_id,
      amount: {
        asset: {
          networkId: row.physical_network_id,
          assetId: row.physical_asset_id,
          decimals: row.physical_asset_decimals,
        },
        raw: "0",
      },
      observedAt: row.change_at.toISOString(),
      ...(row.source_snapshot_observed_at
        ? { sourceSnapshotObservedAt: row.source_snapshot_observed_at }
        : {}),
      ...(error ? { observationError: error } : {}),
    });
  }
  return facts;
}

/** Physical suppression/unknown facts only. NEVER pass these through the
 * economic in-transit observation constructor. Terminal status is irrelevant. */
export async function loadFundingHandoffSnapshotFacts(
  db: Pick<Pool, "query">,
  userId: string,
  components: readonly ValuedAssetComponent[],
): Promise<FundingInTransitFact[]> {
  const snapshots = components
    .filter(
      (row) =>
        row.location.accountId === userId &&
        row.observationFreshness === "fresh" &&
        !row.observationError &&
        sameAsset(row.location.asset, row.amount.asset) &&
        row.location.asset.networkId === "evm:137" &&
        row.location.asset.decimals === 6,
    )
    .map((row) => ({
      component_id: row.componentId,
      location_id: row.location.locationId,
      address: String(row.location.details.address).toLowerCase(),
      network_id: row.amount.asset.networkId,
      asset_id: row.amount.asset.assetId.toLowerCase(),
      asset_decimals: row.amount.asset.decimals,
      snapshot_at: row.observedAt,
      observed_at_text: row.observedAt,
    }));
  if (!snapshots.length) return [];
  const { rows } = await db.query<FundingHandoffSnapshotRow>(
    FUNDING_HANDOFF_SNAPSHOT_TAIL_SQL,
    [userId, JSON.stringify(snapshots)],
  );
  return projectFundingHandoffSnapshotFacts(userId, rows);
}
