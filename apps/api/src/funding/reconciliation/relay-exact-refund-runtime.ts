import type { Pool } from "@hunch/infra";
import { isRecord } from "../../lib/type-guards.js";
import type { RelayClient } from "../../funding-providers/relay/client.js";
import type { RelayStatusResponse } from "../../funding-providers/relay/schemas.js";
import { observeRelayExactRefundEvidence } from "../../funding-providers/relay/exact-refund-observer.js";
import {
  loadRelayExactRefundContext,
  type RelayExactRefundLookup,
} from "./relay-exact-refund-receipts.js";
import { publishRelayExactRefundReceipts } from "./relay-exact-refund-publication.js";
import type { FundingEvidenceWorkContext } from "./funding-reducer.js";
import type { inspectEvmFundingReceiveAnchor } from "../receive/evm-receive-anchor-proof.js";
import {
  fundingEvidenceReadDeadline,
  fundingEvidenceBudgetClient,
  FundingEvidenceBudgetExpiredError,
  withFundingEvidenceReadBudget,
} from "./funding-evidence-budget.js";

/** Existing Relay driver callback. Provider/RPC reads finish before the common
 * writer starts its transaction. Marker-less legacy operations are untouched.
 * This is not the terminal canonical watcher: that runs independently of Relay. */
export async function reconcileRelayExactRefundReceipts(
  pool: Pool,
  relay: Pick<RelayClient, "requestEvidence">,
  input: RelayExactRefundLookup & {
    status: RelayStatusResponse;
    now: Date;
    work?: FundingEvidenceWorkContext & { limit: number };
    inspectCanonicalAnchor?: typeof inspectEvmFundingReceiveAnchor;
  },
  observe: typeof observeRelayExactRefundEvidence = observeRelayExactRefundEvidence,
) {
  if (
    input.work &&
    (!Number.isFinite(input.work.deadlineMs) ||
      Date.now() >= input.work.deadlineMs)
  )
    return { kind: "pending" as const, reason: "role_work_budget_exhausted" };
  const context = input.work
    ? await withFundingEvidenceReadBudget(pool, input.work.deadlineMs, (db) =>
        loadRelayExactRefundContext(db, input),
      )
    : await loadRelayExactRefundContext(pool, input);
  if (context.kind !== "ready") return context;
  const observed = await observe(pool, relay, {
    expected: context.expected,
    status: input.status,
    now: input.now,
    ...(input.work
      ? { deadlineMs: fundingEvidenceReadDeadline(input.work.deadlineMs) }
      : {}),
    ...(context.ledgerAfterSecond === undefined
      ? {}
      : { ledgerAfterSecond: context.ledgerAfterSecond }),
  });
  const result =
    observed.kind === "pending"
      ? observed
      : await publishRelayExactRefundReceipts(pool, {
          ...input,
          request: observed.request,
          nativeLedger: observed.nativeLedger,
          evmEvents: observed.evmEvents,
        });
  // An atomic merge keeps another evidence reader's diagnostics intact. The
  // cursor rotates exact seconds after a budget denial; it never scans history.
  const diagnostic = async (db: Pick<Pool, "query">) =>
    db.query(
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
  if (!input.work) await diagnostic(pool);
  else {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await diagnostic(
        fundingEvidenceBudgetClient(client, input.work.deadlineMs),
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      // Diagnostics are not money authority and cannot turn a committed
      // publication into a failed financial operation after its budget ends.
      if (
        !(error instanceof FundingEvidenceBudgetExpiredError) &&
        !(
          Date.now() >= input.work.deadlineMs &&
          isRecord(error) &&
          ["57014", "55P03"].includes(String(error.code))
        )
      )
        throw error;
    } finally {
      client.release();
    }
  }
  return result;
}
