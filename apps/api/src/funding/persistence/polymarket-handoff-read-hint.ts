import type { PoolClient } from "@hunch/infra";
import type { JsonValue } from "../domain/types.js";
import {
  loadFrozenPolymarketHandoffBinding,
  type StoredPolymarketHandoffBinding,
} from "./polymarket-handoff-binding-repository.js";

/** Operation-scoped immutable plans contain a bounded set of route inputs,
 * not an account's attempt history. This is a read binding, not settlement. */
export async function loadPolymarketHandoffReservationBindings(
  db: Pick<PoolClient, "query">,
  input: { userId: string; operationId: string; segmentId?: string },
): Promise<{ stored: StoredPolymarketHandoffBinding; segmentId: string }[]> {
  const candidates = await db.query<{
    segment_id: string;
    source_reservation_id: string;
  }>(
    `select source_row.segment_id,source_row.id as source_reservation_id
     from balance_reservations source_row
     join funding_operation_segments segment_row on segment_row.id=source_row.segment_id and segment_row.operation_id=source_row.operation_id
     where source_row.operation_id=$1::uuid and source_row.user_id=$2::uuid
       ${input.segmentId ? "and source_row.segment_id=$3::uuid" : ""}
       and source_row.mode='subtract_available' and source_row.economic_role='source_input' and segment_row.provider_id='relay'`,
    [
      input.operationId,
      input.userId,
      ...(input.segmentId ? [input.segmentId] : []),
    ],
  );
  const matches = [];
  for (const candidate of candidates.rows) {
    const stored = await loadFrozenPolymarketHandoffBinding(db, {
      userId: input.userId,
      operationId: input.operationId,
      segmentId: candidate.segment_id,
      sourceReservationId: candidate.source_reservation_id,
    });
    if (stored) matches.push({ stored, segmentId: candidate.segment_id });
  }
  return matches;
}

/** Index/discovery hint only, never financial evidence. Every monetary reader
 * must revalidate the frozen binding, current attempt/receipt and owned E.
 * It lives on the existing receipt, not in a second debit/credit ledger. */
export async function loadPolymarketHandoffReadHint(
  db: Pick<PoolClient, "query">,
  input: {
    userId: string;
    operationId: string;
    stepId: string;
    stepOrdinal: number;
  },
): Promise<{
  hint: Readonly<Record<string, JsonValue>>;
  stored: StoredPolymarketHandoffBinding;
} | null> {
  const matches = (
    await loadPolymarketHandoffReservationBindings(db, input)
  ).filter(({ stored }) => stored.binding.handoffOrdinal === input.stepOrdinal);
  if (matches.length !== 1) return null;
  const { stored, segmentId } = matches[0];
  const { binding } = stored;
  return {
    stored,
    hint: {
      version: 1,
      segmentId,
      sourceReservationId: stored.sourceReservationId,
      controllerFenceId: stored.controllerFenceId,
      stepId: input.stepId,
      networkId: binding.economicSource.asset.networkId,
      assetId: binding.economicSource.asset.assetId.toLowerCase(),
      sourceAddress: String(
        binding.economicSource.details.address,
      ).toLowerCase(),
      controllerAddress: String(
        binding.executionSource.details.address,
      ).toLowerCase(),
    },
  };
}
