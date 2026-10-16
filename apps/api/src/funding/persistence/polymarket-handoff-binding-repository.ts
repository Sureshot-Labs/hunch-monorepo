import type { PoolClient } from "@hunch/infra";
import { isRecord } from "../../lib/type-guards.js";
import {
  readFrozenPolymarketHandoffBinding,
  type FrozenPolymarketHandoffBinding,
} from "../domain/polymarket-handoff-binding.js";
import { canonicalJsonEqual, canonicalJsonHash } from "./canonical.js";
import type {
  FundingCommitPlan,
  FundingCommitReservation,
} from "./funding-operation-repository.js";

/** Read the existing immutable quote by PK instead of rediscovering a plan
 * from an operation's potentially dense attempt/step history. Actual current
 * ownership, source-input and controller-fence rows remain mandatory. */
/** Scope expressions are internal SQL only, never request input. */
export function polymarketHandoffBindingSql(
  scope = {
    userId: "$1::uuid",
    operationId: "$2::uuid",
    segmentId: "$3::uuid",
    sourceReservationId: "$4::uuid",
  },
): string {
  return `
select operation_row.source_snapshot, operation_row.wallet_execution_snapshot,
  operation_row.plan_hash, quote_row.plan_snapshot,
  segment_row.ordinal as segment_ordinal, segment_row.source_snapshot as segment_source,
  segment_row.quoted_input, to_jsonb(source_row) as source_reservation,
  coalesce((select jsonb_agg(to_jsonb(fence_row)) from balance_reservations fence_row
    where fence_row.user_id=operation_row.user_id and fence_row.operation_id=operation_row.id
      and fence_row.location_id=segment_row.source_snapshot#>>'{location,locationId}'
      and fence_row.network_id=segment_row.quoted_input#>>'{asset,networkId}'
      and fence_row.asset_id=lower(segment_row.quoted_input#>>'{asset,assetId}')
      and fence_row.mode='subtract_available' and fence_row.economic_role='future_credit_fence'), '[]'::jsonb) as controller_fences
from (select * from balance_reservations where id=${scope.sourceReservationId} offset 0) source_row
cross join lateral(select * from funding_operations where id=${scope.operationId} offset 0) operation_row
cross join lateral(select * from funding_operation_segments where id=${scope.segmentId} offset 0) segment_row
cross join lateral(select * from funding_quotes where id=operation_row.quote_id offset 0) quote_row
where source_row.user_id=${scope.userId} and source_row.operation_id=operation_row.id
  and source_row.segment_id=segment_row.id and source_row.economic_role='source_input'
  and source_row.mode='subtract_available' and operation_row.user_id=${scope.userId}
  and segment_row.operation_id=operation_row.id and segment_row.provider_id='relay'
  and quote_row.user_id=operation_row.user_id and quote_row.consumed_at is not null
  and quote_row.plan_hash=operation_row.plan_hash`;
}

export const POLYMARKET_HANDOFF_BINDING_SQL = polymarketHandoffBindingSql();

export type PolymarketHandoffBindingRow = {
  source_snapshot: unknown;
  wallet_execution_snapshot: unknown;
  plan_hash: string;
  plan_snapshot: unknown;
  segment_ordinal: number;
  segment_source: unknown;
  quoted_input: unknown;
  source_reservation: unknown;
  controller_fences: unknown;
};

function actualReservationMatches(
  raw: unknown,
  expected: FundingCommitReservation,
  input: { userId: string; operationId: string; segmentId: string | null },
): raw is Record<string, unknown> {
  return (
    isRecord(raw) &&
    raw.user_id === input.userId &&
    raw.operation_id === input.operationId &&
    raw.segment_id === input.segmentId &&
    raw.mode === expected.mode &&
    raw.economic_role === (expected.economicRole ?? "source_input") &&
    raw.component_id === expected.componentId &&
    raw.location_id === expected.locationId &&
    raw.network_id === expected.networkId &&
    typeof raw.asset_id === "string" &&
    raw.asset_id.toLowerCase() === expected.assetId.toLowerCase() &&
    raw.asset_decimals === expected.assetDecimals &&
    String(raw.raw_amount) === expected.rawAmount
  );
}

export type StoredPolymarketHandoffBinding = Readonly<{
  binding: FrozenPolymarketHandoffBinding;
  sourceReservationId: string;
  controllerFenceId: string;
  sourceReservationActive: boolean;
  controllerFenceActive: boolean;
}>;

/** No expiration/status filter: historical physical evidence is still relevant
 * after cancellation/settlement. This is not permission to continue the plan. */
export async function loadFrozenPolymarketHandoffBinding(
  db: Pick<PoolClient, "query">,
  input: {
    userId: string;
    operationId: string;
    segmentId: string;
    sourceReservationId: string;
  },
): Promise<StoredPolymarketHandoffBinding | null> {
  const row = (
    await db.query<PolymarketHandoffBindingRow>(
      POLYMARKET_HANDOFF_BINDING_SQL,
      [
        input.userId,
        input.operationId,
        input.segmentId,
        input.sourceReservationId,
      ],
    )
  ).rows[0];
  return readStoredPolymarketHandoffBinding(row, input);
}

/** Shared decoder for the exact-key lookup and physical-tail read. In the
 * latter, quote/reservation/receipt/event facts must come from ONE statement. */
export function readStoredPolymarketHandoffBinding(
  row: PolymarketHandoffBindingRow | undefined,
  input: {
    userId: string;
    operationId: string;
    segmentId: string;
    sourceReservationId: string;
  },
): StoredPolymarketHandoffBinding | null {
  if (
    !row ||
    !isRecord(row.plan_snapshot) ||
    !isRecord(row.plan_snapshot.operation) ||
    ![
      row.plan_snapshot.segments,
      row.plan_snapshot.steps,
      row.plan_snapshot.reservations,
    ].every((value) => Array.isArray(value) && value.every(isRecord)) ||
    !Array.isArray(row.controller_fences) ||
    canonicalJsonHash(row.plan_snapshot) !== row.plan_hash
  )
    return null;
  const plan = row.plan_snapshot as unknown as FundingCommitPlan;
  const segment = plan.segments[row.segment_ordinal];
  if (
    !segment ||
    !canonicalJsonEqual(plan.operation.sourceSnapshot, row.source_snapshot) ||
    !canonicalJsonEqual(
      plan.operation.walletExecutionSnapshot,
      row.wallet_execution_snapshot,
    ) ||
    !canonicalJsonEqual(segment.sourceSnapshot, row.segment_source) ||
    !canonicalJsonEqual(segment.quotedInput, row.quoted_input)
  )
    return null;
  const binding = readFrozenPolymarketHandoffBinding({
    currentUserId: input.userId,
    plan,
    segmentOrdinal: row.segment_ordinal,
  });
  if (
    !binding ||
    !actualReservationMatches(
      row.source_reservation,
      binding.sourceReservation,
      input,
    ) ||
    row.source_reservation.id !== input.sourceReservationId ||
    row.controller_fences.length !== 1
  )
    return null;
  const fence = row.controller_fences[0];
  if (
    !actualReservationMatches(fence, binding.controllerFence, {
      ...input,
      segmentId: null,
    }) ||
    typeof fence.id !== "string"
  )
    return null;
  return {
    binding,
    sourceReservationId: input.sourceReservationId,
    controllerFenceId: fence.id,
    sourceReservationActive: row.source_reservation.state === "active",
    controllerFenceActive: fence.state === "active",
  };
}
