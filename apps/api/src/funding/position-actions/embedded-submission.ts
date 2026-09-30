import type { Pool } from "@hunch/infra";
import type { NormalizedAction } from "../domain/types.js";
import {
  validateEmbeddedFundingPayload,
  type EmbeddedFundingPayload,
} from "../execution/embedded-funding-submission-contract.js";
import { FundingPersistenceError } from "../persistence/funding-operation-repository.js";
import {
  fetchPositionActionForUser,
  claimPositionActionEmbeddedDispatch,
  recordPositionActionSubmission,
  recordPositionActionAuthorizationRejection,
  type StoredPositionAction,
} from "./position-action-repository.js";
import { positionActionPrivyReference } from "./privy-submission-reference.js";
import type { EmbeddedFundingReference } from "../execution/embedded-funding-submission.js";
import { EmbeddedEvmAuthorizationRejectedError } from "../../services/embedded-ethereum.js";

export type EmbeddedPositionSubmission = Readonly<{
  operationId: string;
  attemptNumber: number;
}>;
type Admission = EmbeddedPositionSubmission & {
  acceptedReference: EmbeddedFundingReference | null;
};

function acceptedReference(
  operation: StoredPositionAction,
): EmbeddedFundingReference | null {
  const stored = operation.submissionFingerprint;
  if (!stored) return null;
  if (/^0x[0-9a-f]{64}$/i.test(stored))
    return { kind: "transaction", value: stored };
  const provider = positionActionPrivyReference(
    stored,
    operation.executionMode,
  );
  return provider
    ? {
        kind:
          provider.kind === "transaction_id"
            ? "provider_transaction"
            : "user_operation",
        value: stored,
      }
    : null;
}

export function parseEmbeddedPositionExecutionKey(
  key: string | null | undefined,
): EmbeddedPositionSubmission | null {
  const match = key?.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9][0-9]*)$/i,
  );
  if (!match?.[1] || !Number.isSafeInteger(Number(match[2]))) return null;
  return {
    operationId: match[1].toLowerCase(),
    attemptNumber: Number(match[2]),
  };
}

export function validateEmbeddedPositionPayload(
  operation: StoredPositionAction,
  payload: EmbeddedFundingPayload,
): void {
  const action = operation.normalizedActions[0] as NormalizedAction | undefined;
  if (
    operation.action !== "redeem" ||
    operation.executionMode !== "privy_authorization" ||
    operation.normalizedActions.length !== 1 ||
    !action ||
    (action.kind !== "evm_transaction" &&
      action.kind !== "evm_transaction_batch") ||
    action.senderWalletId !== operation.executionWalletId
  )
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Position execution does not match its prepared action",
    );
  validateEmbeddedFundingPayload(
    action,
    {
      version: 1,
      phase: "admitted",
      expiresAt: operation.updatedAt.toISOString(),
      signer: operation.executionAddress,
      payer: "privy_sponsor",
    },
    payload,
  );
}

/** A key locates consent; it is never sufficient authorization by itself. */
export async function admitEmbeddedPositionSubmission(
  db: Pool,
  userId: string,
  key: string | undefined,
  payload: EmbeddedFundingPayload,
): Promise<Admission | null> {
  const scope = parseEmbeddedPositionExecutionKey(key);
  if (!scope) return null;
  const operation = await fetchPositionActionForUser(db, {
    userId,
    operationId: scope.operationId,
  });
  if (!operation)
    throw new FundingPersistenceError(
      "operation_not_found",
      "Position action was not found",
    );
  validateEmbeddedPositionPayload(operation, payload);
  const attempt = await db.query<{ outcome: string; attempt_number: number }>(
    `select outcome, attempt_number from position_action_attempts
      where action_operation_id = $1 order by attempt_number desc limit 1`,
    [operation.id],
  );
  const latest = attempt.rows[0];
  if (!latest || latest.attempt_number !== scope.attemptNumber)
    throw new FundingPersistenceError(
      "invalid_operation_state",
      "Position submission claim is no longer active",
    );
  const reference = acceptedReference(operation);
  if (reference) return { ...scope, acceptedReference: reference };
  // Ambiguity is recovery-only. Replaying an old provider idempotency key is
  // not permission to send again after the provider's retention window.
  if (latest.outcome !== "started" || operation.status !== "submitting")
    throw new FundingPersistenceError(
      "invalid_operation_state",
      "Position submission requires reconciliation, not another send",
    );
  return { ...scope, acceptedReference: null };
}

/** Persist provider acceptance before replying; a disconnected client is not the journal. */
export async function journalEmbeddedPositionAcceptance(
  db: Pool,
  userId: string,
  scope: EmbeddedPositionSubmission | null,
  references: readonly {
    kind: "transaction" | "provider_transaction" | "user_operation";
    value: string;
  }[],
): Promise<void> {
  if (!scope) return;
  const accepted = references[0];
  // The executor already returns wire-format references. Re-encoding an
  // accepted reference would fail after the actual provider POST.
  const reference = accepted?.value;
  const provider = reference
    ? positionActionPrivyReference(reference, "privy_authorization")
    : null;
  if (
    references.length !== 1 ||
    !accepted ||
    !reference ||
    (accepted.kind === "transaction"
      ? !/^0x[0-9a-f]{64}$/i.test(reference)
      : accepted.kind === "provider_transaction"
        ? provider?.kind !== "transaction_id"
        : provider?.kind !== "user_operation")
  )
    throw new FundingPersistenceError(
      "invalid_operation_state",
      "Position submission accepted without an exact reference; reconciliation is required",
    );
  await recordPositionActionSubmission(db, {
    userId,
    ...scope,
    outcome: "submitted",
    submissionFingerprint: reference,
    errorCode: null,
  });
}

/** The durable fence is inside single-flight, immediately before the POST. */
export async function beginEmbeddedPositionDispatch(
  db: Pool,
  userId: string,
  scope: EmbeddedPositionSubmission | null,
): Promise<void> {
  if (!scope) return;
  if (!(await claimPositionActionEmbeddedDispatch(db, { userId, ...scope })))
    throw new FundingPersistenceError(
      "invalid_operation_state",
      "Position submission requires reconciliation, not another send",
    );
}

/** Partial multi-POST execution and arbitrary errors remain uncertain. */
export async function journalEmbeddedPositionAuthorizationRejection(
  db: Pool,
  userId: string,
  scope: EmbeddedPositionSubmission | null,
  requestCount: number,
  error: unknown,
): Promise<void> {
  if (
    !scope ||
    requestCount !== 1 ||
    !(error instanceof EmbeddedEvmAuthorizationRejectedError)
  )
    return;
  await recordPositionActionAuthorizationRejection(db, {
    userId,
    ...scope,
    httpStatus: error.status,
  });
}
