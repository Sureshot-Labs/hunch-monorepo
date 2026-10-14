import { tx, type Pool } from "@hunch/infra";
import {
  admitNativeFundingSendInTransaction,
  nativeFundingPreparationInTransaction,
  type NativeFundingSubmitInput,
} from "./hypercore-auth-attempt.js";
import {
  nativeSendCapacityCheck,
  readNativeSendCapacity,
  type NativeSpotCapacity,
} from "./hypercore-send-capacity.js";
import { parseNativeFundingSubmission } from "./hypercore-submission-contract.js";
import { nativeFundingSignedRequest } from "./hypercore-signed-request.js";
import type { FundingTransactionReferenceCodec } from "./transaction-reference-codec.js";
import {
  lockFundingPolicyForTransaction,
  resolveFundingControlPlaneSnapshot,
  type FundingControlPlaneSnapshot,
} from "../policies/funding-policy-sidecar.js";
import {
  wakeFundingReconciliationInTransaction,
  FundingPersistenceError,
} from "../persistence/funding-operation-repository.js";
import { readHip4Policy } from "../../services/hip4-repository.js";

type SendRequest = Extract<
  Awaited<ReturnType<typeof admitNativeFundingSendInTransaction>>,
  { admitted: true }
>["request"];

type NativeSendObservation = {
  capacity: NativeSpotCapacity;
  timeoutMs: number;
  responseMaxBytes: number;
};
type NativeSendDependencies = {
  /** Server-internal test seams, never accepted from an API request. */
  observe?: (pool: Pool, address: string) => Promise<NativeSendObservation>;
  admissionPolicy?: FundingControlPlaneSnapshot;
  fetcher?: typeof fetch;
};
async function observeNativeSend(
  pool: Pool,
  address: string,
): Promise<NativeSendObservation> {
  const read = await readHip4Policy(pool, "accountRead");
  const capacity = await readNativeSendCapacity(pool, address);
  return {
    capacity,
    timeoutMs: read.policy.requestTimeoutMs,
    responseMaxBytes: read.policy.responseMaxBytes,
  };
}

/** One fixed native endpoint, no redirects, no replay, no raw response logging.
 * ACK is a transport fact only, never a canonical source-debit receipt. */
export async function postNativeFundingSendOnce(
  request: SendRequest,
  options: {
    timeoutMs: number;
    responseMaxBytes: number;
    fetcher?: typeof fetch;
  },
): Promise<"acknowledged" | "unknown"> {
  try {
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      !Number.isSafeInteger(options.responseMaxBytes) ||
      options.responseMaxBytes <= 0
    )
      return "unknown";
    const response = await (options.fetcher ?? fetch)(
      "https://api.hyperliquid.xyz/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return "unknown";
    }
    const reader = response.body?.getReader();
    if (!reader) return "unknown";
    let text = "",
      bytes = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > options.responseMaxBytes) return "unknown";
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      const value: unknown = JSON.parse(text);
      return value &&
        typeof value === "object" &&
        "status" in value &&
        value.status === "ok"
        ? "acknowledged"
        : "unknown";
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch {
    return "unknown";
  }
}

/** Internal execution seam; not exposed as a new API or delegated worker.
 * The browser supplies only sign-only output for its existing funding attempt.
 * Recovery polls the same attempt; it never resends this signed action. */
export async function submitNativeFundingSend(
  pool: Pool,
  input: NativeFundingSubmitInput,
  codec: FundingTransactionReferenceCodec,
  dependencies: NativeSendDependencies = {},
) {
  const scoped = await pool.query<{ actual_costs: Record<string, unknown> }>(
    `select attempt_row.actual_costs
    from funding_operations operation_row join funding_operation_steps step_row on step_row.operation_id=operation_row.id
    join funding_operation_step_attempts attempt_row on attempt_row.step_id=step_row.id
    where operation_row.id=$1 and operation_row.user_id=$2 and step_row.id=$3 and attempt_row.id=$4`,
    [input.operationId, input.userId, input.stepId, input.attemptId],
  );
  if (!scoped.rows[0])
    throw new FundingPersistenceError(
      "operation_not_found",
      "Native send attempt not found",
    );
  const prepared =
    parseNativeFundingSubmission(scoped.rows[0].actual_costs.nativeSubmission)
      ?.phase === "prepared";
  const { pair } = await nativeFundingPreparationInTransaction(
    pool,
    input.operationId,
    input.stepId,
  );
  if (pair.send.id !== input.stepId)
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Native send action changed",
    );
  nativeFundingSignedRequest(pair.validated, "send_asset", input.signature);
  // Fresh provider IO and its committed budget use the pool before borrowing
  // a transaction client. Works with pool max=1 and cannot starve the pool.
  let observation: NativeSendObservation | null = null;
  if (prepared) {
    try {
      observation = await (dependencies.observe ?? observeNativeSend)(
        pool,
        pair.validated.binding.owner,
      );
    } catch {
      throw new FundingPersistenceError(
        "quote_invalidated",
        "Native source capacity is unavailable; refresh and retry before sending",
      );
    }
  }
  const admitted = await tx(pool, async (client) => {
    await lockFundingPolicyForTransaction(client);
    const policy =
      dependencies.admissionPolicy ??
      (await resolveFundingControlPlaneSnapshot(client));
    const result = await admitNativeFundingSendInTransaction(
      client,
      input,
      policy,
      nativeSendCapacityCheck(async () => {
        if (!observation) throw new Error("native_capacity_missing");
        return observation.capacity;
      }),
      codec,
    );
    if (result.admitted)
      await wakeFundingReconciliationInTransaction(client, {
        operationId: input.operationId,
        dueAt: new Date(),
      });
    return result;
  });
  if (admitted.admitted) {
    if (!observation) throw new Error("native_send_transport_unavailable");
    await postNativeFundingSendOnce(admitted.request, {
      timeoutMs: observation.timeoutMs,
      responseMaxBytes: observation.responseMaxBytes,
      fetcher: dependencies.fetcher,
    });
    // The durable attempt and job already survive a process/connection failure
    // here. Never claim success or release funds based on the HTTP response.
  }
  return {
    attemptId: input.attemptId,
    submissionStatus:
      !admitted.admitted && ["cancelled", "failed"].includes(admitted.outcome)
        ? ("closed" as const)
        : ("reconcile_required" as const),
  };
}
