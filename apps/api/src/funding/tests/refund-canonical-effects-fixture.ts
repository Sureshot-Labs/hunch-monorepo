import type { PoolClient } from "@hunch/infra";
import {
  protectRefundCanonicalProofs,
  restoreArbitratedRefundCanonicalProof,
} from "../reconciliation/relay-refund-watch-effects.js";
import {
  prelockOwnedRefundEvents,
  readProtectedRecordedRefundRoleProof,
  recordedRefundRoleEvent,
} from "../reconciliation/relay-owned-refund-ownership.js";
import { refundWatchFacts } from "../reconciliation/relay-refund-watch-context.js";

/** Offline legacy effect fixtures inject the intended role explicitly.
 * This is NOT the runtime coordinator and does not prove complete role scans,
 * cross-COMMIT visibility or final F. Committed publication tests cover those.
 * Physical economics/ownership, recorded proof and receipt CAS remain real.
 */
export async function persistRefundCanonicalProofsFixture(
  db: Pick<PoolClient, "query">,
  input: Parameters<typeof protectRefundCanonicalProofs>[1],
): Promise<{ changed: number; stale: boolean }> {
  const result = await protectRefundCanonicalProofs(db, input);
  let changed = result.changed;
  let stale = result.stale;
  for (const { row, canonical } of result.restorations) {
    const previous = recordedRefundRoleEvent(row.receipt_snapshot, input.now);
    if (!previous || !canonical.ledgerHeight || !canonical.blockHash) {
      stale = true;
      continue;
    }
    const physical = await prelockOwnedRefundEvents(db, previous, {
      ...previous,
      ledgerHeight: canonical.ledgerHeight,
      blockHash: canonical.blockHash,
    });
    const receipt = JSON.parse(row.receipt_snapshot);
    const proof = await readProtectedRecordedRefundRoleProof(db, {
      locked: physical,
      receiptSnapshot: row.receipt_snapshot,
      operationId: input.operationId,
      segmentId: receipt.segment_id,
      facts: refundWatchFacts(row, input.operationId),
    });
    if (!proof) {
      stale = true;
      continue;
    }
    const restored = await restoreArbitratedRefundCanonicalProof(db, {
      operationId: input.operationId,
      row,
      now: input.now,
      canonical,
      physical,
      proof,
      classification: {
        kind: "internal_refund",
        match: {
          kind: "internal",
          operationId: input.operationId,
          segmentId: receipt.segment_id,
        },
      },
    });
    if (restored) changed++;
    else stale = true;
  }
  return { changed, stale };
}
