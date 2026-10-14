import { tx, type Pool } from "@hunch/infra";
import type { RelayClient } from "../../funding-providers/relay/client.js";
import {
  admitNativeFundingAuthInTransaction,
  finishNativeFundingAuthInTransaction,
} from "./hypercore-auth-attempt.js";
import { parseNativeFundingSubmission } from "./hypercore-submission-contract.js";
import {
  lockFundingPolicyForTransaction,
  resolveFundingControlPlaneSnapshot,
} from "../policies/funding-policy-sidecar.js";
import {
  wakeFundingReconciliationInTransaction,
  FundingPersistenceError,
} from "../persistence/funding-operation-repository.js";
import { reduceFundingOperationInTransaction } from "../reconciliation/funding-reducer.js";

/** Same funding attempts/locks/reducer; deliberately no separate jobs or nonce
 * retry coordinator. Caller supplies a server-constructed bounded RelayClient. */
export async function submitNativeFundingAuth(
  pool: Pool,
  input: Parameters<typeof admitNativeFundingAuthInTransaction>[1],
  relay: Pick<RelayClient, "authorizeHypercore">,
) {
  const admitted = await tx(pool, async (client) => {
    await lockFundingPolicyForTransaction(client);
    const policy = await resolveFundingControlPlaneSnapshot(client);
    const admission = await admitNativeFundingAuthInTransaction(
      client,
      input,
      policy,
    );
    if (admission.admitted)
      await wakeFundingReconciliationInTransaction(client, {
        operationId: input.operationId,
        dueAt: new Date(),
      });
    return admission;
  });
  if (admitted.admitted) {
    let authorized = false;
    try {
      await relay.authorizeHypercore(admitted.request, admitted.signature);
      authorized = true;
    } catch {
      // Never retain a URL/error containing a signature. Unknown registration
      // has no debit; only an explicit retry may resubmit the identical mapping.
    }
    await tx(pool, async (client) => {
      const finished = await finishNativeFundingAuthInTransaction(client, {
        ...input,
        requestFingerprint: admitted.requestFingerprint,
        authorized,
      });
      if (finished) {
        await reduceFundingOperationInTransaction(client, {
          operationId: input.operationId,
          now: new Date(),
        });
        await wakeFundingReconciliationInTransaction(client, {
          operationId: input.operationId,
          dueAt: new Date(),
        });
      }
    });
  }
  // Re-read after completion: cancellation may have won during the HTTP call.
  const rows = await pool.query<{
    outcome: string;
    actual_costs: Record<string, unknown>;
  }>(
    `select attempt_row.outcome,attempt_row.actual_costs from funding_operations operation_row
      join funding_operation_steps step_row on step_row.operation_id=operation_row.id
      join funding_operation_step_attempts attempt_row on attempt_row.step_id=step_row.id
     where operation_row.id=$1 and operation_row.user_id=$2 and step_row.id=$3 and attempt_row.id=$4`,
    [input.operationId, input.userId, input.stepId, input.attemptId],
  );
  const row = rows.rows[0];
  if (!row)
    throw new FundingPersistenceError(
      "operation_not_found",
      "Native authorization attempt not found",
    );
  const submission = parseNativeFundingSubmission(
    row.actual_costs.nativeSubmission,
  );
  const status =
    submission?.phase === "closed" &&
    submission.reason === "authorized" &&
    row.outcome === "succeeded"
      ? "authorized"
      : submission?.phase === "closed" &&
          submission.reason === "authorization_unknown" &&
          row.outcome === "failed"
        ? "retry_required"
        : submission?.phase === "admitted" && row.outcome === "started"
          ? "pending"
          : "closed";
  // Registration state only, NOT permission to send. The existing operation
  // lifecycle and a fresh SendAsset admission still decide whether to proceed.
  return { attemptId: input.attemptId, authorizationStatus: status };
}
