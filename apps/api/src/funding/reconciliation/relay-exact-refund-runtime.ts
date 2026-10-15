import { tx, type Pool } from "@hunch/infra";
import type { RelayClient } from "../../funding-providers/relay/client.js";
import type { RelayStatusResponse } from "../../funding-providers/relay/schemas.js";
import { observeRelayExactRefundEvidence } from "../../funding-providers/relay/exact-refund-observer.js";
import {
  loadRelayExactRefundContext,
  recordRelayExactRefundReceiptsInTransaction,
  RelayExactRefundSnapshotChanged,
  type RelayExactRefundLookup,
} from "./relay-exact-refund-receipts.js";

/** Existing Relay driver callback. Provider/RPC reads finish before the common
 * writer starts its transaction. Marker-less legacy operations are untouched.
 * This is not the terminal canonical watcher: that runs independently of Relay. */
export async function reconcileRelayExactRefundReceipts(
  pool: Pool,
  relay: Pick<RelayClient, "requestEvidence">,
  input: RelayExactRefundLookup & { status: RelayStatusResponse; now: Date },
  observe: typeof observeRelayExactRefundEvidence = observeRelayExactRefundEvidence,
) {
  const context = await loadRelayExactRefundContext(pool, input);
  if (context.kind !== "ready") return context;
  const observed = await observe(pool, relay, {
    expected: context.expected,
    status: input.status,
    now: input.now,
    ...(context.ledgerAfterSecond === undefined
      ? {}
      : { ledgerAfterSecond: context.ledgerAfterSecond }),
  });
  const result =
    observed.kind === "pending"
      ? observed
      : await tx(pool, (db) =>
          recordRelayExactRefundReceiptsInTransaction(db, {
            ...input,
            request: observed.request,
            nativeLedger: observed.nativeLedger,
            evmEvents: observed.evmEvents,
          }),
        ).catch((error: unknown) => {
          // tx has rolled back ALL prelocks/effects before this catch. Retry
          // from current stored facts on the ordinary reconciliation cycle;
          // do not loop under old locks or turn financial conflicts into retries.
          if (!(error instanceof RelayExactRefundSnapshotChanged)) throw error;
          return { kind: "pending" as const, reason: error.reason };
        });
  // An atomic merge keeps another evidence reader's diagnostics intact. The
  // cursor rotates exact seconds after a budget denial; it never scans history.
  await pool.query(
    `update funding_operation_segments
    set support_metadata=jsonb_set(support_metadata, '{exactRefundReceipts}',
      (case when jsonb_typeof(support_metadata->'exactRefundReceipts')='object'
        then support_metadata->'exactRefundReceipts' else '{}'::jsonb end) || $3::jsonb, true)
    where operation_id=$1::uuid and id=$2::uuid and provider_id='relay'`,
    [
      input.operationId,
      input.segmentId,
      {
        requestFingerprint: context.identity.requestFingerprint,
        lookupKeyVersion: context.identity.lookupKeyVersion,
        checkedAt: input.now.toISOString(),
        result: result.kind,
        observationReason: observed.reason,
        reason:
          result.kind === "complete"
            ? null
            : "reason" in result
              ? result.reason
              : observed.reason,
        ...(observed.kind === "observed" &&
        "ledgerAfterSecond" in observed &&
        observed.ledgerAfterSecond !== undefined
          ? { ledgerAfterSecond: observed.ledgerAfterSecond }
          : {}),
      },
    ],
  );
  return result;
}
