import type { Pool } from "@hunch/infra";
import {
  beginEmbeddedPreparationDispatch,
  fetchFundingPreparationRun,
  reportFundingPreparationAction,
} from "../persistence/funding-preparation-run-repository.js";
import { FundingPersistenceError } from "../persistence/funding-operation-repository.js";
import {
  validateEmbeddedFundingPayload,
  type EmbeddedFundingPayload,
} from "../execution/embedded-funding-submission-contract.js";
import type { EmbeddedFundingReference } from "../execution/embedded-funding-submission.js";
import { parsePrivyFundingTransactionReference } from "../execution/privy-transaction-reference.js";
import { EmbeddedEvmAuthorizationRejectedError } from "../../services/embedded-ethereum.js";
import {
  parsePreparationExecutionKey,
  type PreparationAdmission,
} from "./admission-contract.js";
import type { NormalizedAction } from "../domain/types.js";

type Scope = NonNullable<ReturnType<typeof parsePreparationExecutionKey>>;

function validate(
  action: NormalizedAction,
  grant: PreparationAdmission,
  payload: EmbeddedFundingPayload,
) {
  if (payload.kind !== "ethereum")
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Preparation admission requires its exact EVM payload",
    );
  validateEmbeddedFundingPayload(
    action,
    {
      version: 1,
      phase: "admitted",
      expiresAt: grant.createdAt,
      signer: grant.signer,
      payer: payload.transactions.some((call) => call.sponsor !== false)
        ? "privy_sponsor"
        : "user",
    },
    payload,
  );
}

export async function inspectEmbeddedPreparationAdmission(
  db: Pool,
  userId: string,
  key: string | undefined,
  payload: EmbeddedFundingPayload,
) {
  const scope = parsePreparationExecutionKey(key);
  if (!scope) {
    if (key?.startsWith("trade-preparation:v1:"))
      throw new FundingPersistenceError(
        "quote_mismatch",
        "Invalid preparation execution scope",
      );
    // Old clients retain their old path, but may not dispatch a closed run.
    const legacy = key?.match(/^trade-preparation:([a-f0-9-]{36}):(.+)$/i);
    if (legacy?.[1]) {
      const run = await fetchFundingPreparationRun(db, {
        userId,
        runId: legacy[1],
      });
      const attempt = run?.actions.find(
        (action) => action.actionId === legacy[2],
      );
      if (
        !run ||
        !attempt ||
        attempt.state !== "action_required" ||
        attempt.broadcastMayHaveOccurred ||
        attempt.report ||
        run.request.executionJournal ||
        run.expiresAt <= new Date() ||
        ["expired", "failed", "cancelled", "succeeded"].includes(run.status)
      )
        throw new FundingPersistenceError(
          "invalid_state_transition",
          "Refresh wallet preparation; this action is closed or requires admission",
        );
    }
    return null;
  }
  const run = await fetchFundingPreparationRun(db, {
    userId,
    runId: scope.runId,
  });
  const grant = run?.request.executionJournal?.admissions[scope.actionId];
  const attempt = run?.actions.find(
    (action) => action.actionId === scope.actionId,
  );
  if (
    !run ||
    !grant ||
    !attempt ||
    grant.id !== scope.admissionId ||
    grant.delivery !== "embedded"
  )
    throw new FundingPersistenceError(
      "quote_mismatch",
      "Preparation admission does not match this owned action",
    );
  validate(attempt.action, grant, payload);
  let acceptedReference: EmbeddedFundingReference | null = null;
  const reference = attempt.transactionReference;
  const provider = reference
    ? parsePrivyFundingTransactionReference(reference)
    : null;
  if (reference && /^0x[a-f0-9]{64}$/i.test(reference))
    acceptedReference = { kind: "transaction", value: reference };
  else if (reference && provider)
    acceptedReference = {
      kind:
        provider.kind === "transaction_id"
          ? "provider_transaction"
          : "user_operation",
      value: reference,
    };
  if (
    !acceptedReference &&
    (grant.phase !== "reserved" ||
      run.expiresAt <= new Date() ||
      ["expired", "failed", "cancelled", "succeeded"].includes(run.status))
  )
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "Preparation needs status recovery, not another send",
    );
  return { scope, acceptedReference };
}

export async function beginPreparationProviderDispatch(
  db: Pool,
  userId: string,
  scope: Scope | null,
  payload: EmbeddedFundingPayload,
) {
  if (!scope) return;
  await beginEmbeddedPreparationDispatch(db, {
    userId,
    ...scope,
    validate: (action, grant) => validate(action, grant, payload),
  });
}

export async function journalPreparationProviderAcceptance(
  db: Pool,
  userId: string,
  scope: Scope | null,
  references: readonly EmbeddedFundingReference[],
) {
  if (!scope) return;
  const accepted = references[0];
  const provider = accepted
    ? parsePrivyFundingTransactionReference(accepted.value)
    : null;
  if (
    references.length !== 1 ||
    !accepted ||
    (accepted.kind === "transaction"
      ? !/^0x[a-f0-9]{64}$/i.test(accepted.value)
      : accepted.kind === "provider_transaction"
        ? provider?.kind !== "transaction_id"
        : provider?.kind !== "user_operation")
  )
    throw new FundingPersistenceError(
      "invalid_state_transition",
      "Preparation accepted without an exact reference; do not resend",
    );
  await reportFundingPreparationAction(db, {
    userId,
    ...scope,
    internalAdmissionId: scope.admissionId,
    report: {
      outcome: accepted.kind === "transaction" ? "submitted" : "ambiguous",
      transactionReference: accepted.value,
      networkFeeRaw: null,
    },
  });
}

export async function journalPreparationProviderRejection(
  db: Pool,
  userId: string,
  scope: Scope | null,
  requestCount: number,
  error: unknown,
) {
  if (
    !scope ||
    requestCount !== 1 ||
    !(error instanceof EmbeddedEvmAuthorizationRejectedError)
  )
    return;
  await reportFundingPreparationAction(db, {
    userId,
    ...scope,
    internalAdmissionId: scope.admissionId,
    report: {
      outcome: "failed",
      transactionReference: null,
      networkFeeRaw: null,
      notStartedReason: "wallet_rejected",
    },
  });
}
