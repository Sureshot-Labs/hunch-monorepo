import type { Pool } from "@hunch/infra";

import { buildAccountValueReadModel } from "../../account-value/runtime-service.js";
import { getCredentialsEncryptionKey } from "../../lib/credentials-encryption.js";
import { isReceiptBearingFundingActionKind } from "../domain/action-kinds.js";
import { normalizedActionSchema } from "../domain/schemas.js";
import type {
  NormalizedAction,
  WalletExecutionProfile,
} from "../domain/types.js";
import {
  fetchFundingOperationStepForUser,
  finishFundingStepAttemptForUser,
  startFundingStepAttemptForUser,
} from "../persistence/funding-evidence-repository.js";
import {
  fetchFundingOperationForUser,
  FundingPersistenceError,
  type FundingOperationRow,
} from "../persistence/funding-operation-repository.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { resolveFundingPolicy } from "../policies/funding-policy-service.js";
import { withdrawalBindingMatches } from "../domain/withdrawal-binding.js";
import { parsePositiveInteger } from "../runtime/positive-integer.js";
import {
  resolveActionSponsorship,
  type ResolvedActionSponsorship,
} from "./sponsorship-policy.js";
import { normalizePolymarketDepositWalletTransactionReference } from "./polymarket-deposit-wallet-handoff.js";
import { createFundingTransactionReferenceCodec } from "./transaction-reference-codec.js";
import { WithdrawalDestinationRuntime } from "./withdrawal-destination-runtime.js";

const EXECUTOR_BY_ACTION_KIND = {
  evm_transaction: "wallet_profile_evm_v1",
  evm_transaction_batch: "wallet_profile_evm_v1",
  external_handoff: "polymarket_deposit_wallet_relayer_v1",
  svm_transaction: "wallet_profile_svm_v1",
} as const;

function signerWalletId(action: NormalizedAction): string | null {
  if (
    action.kind === "evm_transaction" ||
    action.kind === "evm_transaction_batch"
  ) {
    return action.senderWalletId;
  }
  if (action.kind === "svm_transaction" || action.kind === "signature") {
    return action.signerWalletId;
  }
  return action.actorWalletId;
}

function exactWalletProfile(
  profiles: readonly WalletExecutionProfile[],
  action: NormalizedAction,
): WalletExecutionProfile | null {
  const walletId = signerWalletId(action);
  if (!walletId) return null;
  return (
    profiles.find(
      (profile) =>
        profile.walletId === walletId && profile.networkId === action.networkId,
    ) ?? null
  );
}

function assertClientExecutable(
  action: NormalizedAction,
  executorId: string,
  profiles: readonly WalletExecutionProfile[],
): Readonly<{
  controllerWalletRef: string;
  executionMode: "web_client" | "privy_authorization" | "venue_relayer";
  payerRequirement: "user" | "privy_sponsor" | "provider";
  sponsorshipPolicyId: string | null;
}> {
  if (action.kind === "external_handoff") {
    if (
      action.networkId !== "evm:137" ||
      action.handoffKind !== "polymarket_deposit_wallet_transfer" ||
      executorId !== EXECUTOR_BY_ACTION_KIND.external_handoff
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "committed external handoff is not an allowlisted client executor",
      );
    }
    const profile = exactWalletProfile(profiles, action);
    if (
      !profile ||
      profile.source === "external" ||
      !profile.controllerWalletRef ||
      (!profile.signingModes.includes("web_client") &&
        !profile.signingModes.includes("privy_authorization"))
    ) {
      throw new FundingPersistenceError(
        "quote_invalidated",
        "committed Polymarket handoff actor is no longer owned and executable",
      );
    }
    return {
      controllerWalletRef: profile.controllerWalletRef,
      executionMode: "venue_relayer",
      payerRequirement: "provider",
      sponsorshipPolicyId: null,
    };
  }
  if (
    action.kind !== "evm_transaction" &&
    action.kind !== "evm_transaction_batch" &&
    action.kind !== "svm_transaction"
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "this endpoint exposes only committed Relay transaction actions",
    );
  }
  if (executorId !== EXECUTOR_BY_ACTION_KIND[action.kind]) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "committed action executor is not the exact client executor",
    );
  }
  const profile = exactWalletProfile(profiles, action);
  if (
    !profile ||
    (!profile.signingModes.includes("web_client") &&
      !profile.signingModes.includes("privy_authorization"))
  ) {
    throw new FundingPersistenceError(
      "quote_invalidated",
      "committed signer is no longer owned and client-executable",
    );
  }
  if (
    action.kind === "evm_transaction_batch" &&
    profile.evmAtomicBatchMode !== "privy_wallet_send_calls"
  ) {
    throw new FundingPersistenceError(
      "quote_invalidated",
      "committed signer no longer supports atomic EVM batches",
    );
  }
  if (!profile.controllerWalletRef) {
    throw new FundingPersistenceError(
      "quote_invalidated",
      "committed signer has no authenticated wallet reference",
    );
  }
  const sponsorship: ResolvedActionSponsorship = resolveActionSponsorship({
    action,
    profile,
  });
  return {
    controllerWalletRef: profile.controllerWalletRef,
    executionMode: sponsorship.signingMode,
    payerRequirement: sponsorship.payerRequirement,
    sponsorshipPolicyId: sponsorship.policyId,
  };
}

export type FundingActionReportOutcome =
  | "submitted"
  | "ambiguous"
  | "failed"
  | "cancelled";

export function isReportableFundingActionKind(
  kind: NormalizedAction["kind"],
): boolean {
  return isReceiptBearingFundingActionKind(kind);
}

export function assertWithdrawalActionPolicy(
  operation: Pick<FundingOperationRow, "externalRecipientId" | "purpose">,
): string | null {
  if (
    !withdrawalBindingMatches(operation.purpose, operation.externalRecipientId)
  ) {
    throw new FundingPersistenceError(
      "quote_mismatch",
      "withdrawal operation and external recipient binding differ",
    );
  }
  return operation.externalRecipientId;
}

export class FundingOperationActionRuntime {
  private readonly withdrawalRuntime: WithdrawalDestinationRuntime;

  constructor(
    private readonly db: Pool,
    private readonly dependencies: Readonly<{
      revalidateWithdrawalRecipient?: (
        userId: string,
        recipientId: string,
      ) => Promise<void>;
    }> = {},
  ) {
    this.withdrawalRuntime = new WithdrawalDestinationRuntime(db);
  }

  async prepare(
    userId: string,
    input: Readonly<{ operationId: string; stepId: string }>,
  ): Promise<
    Readonly<{
      attemptId: string;
      action: NormalizedAction;
      actionFingerprint: string;
      controllerWalletRef: string;
      executorId: string;
      executionMode: "web_client" | "privy_authorization" | "venue_relayer";
      payerRequirement: "user" | "privy_sponsor" | "provider";
      sponsorshipPolicyId: string | null;
    }>
  > {
    const [operation, step, account] = await Promise.all([
      fetchFundingOperationForUser(this.db, {
        userId,
        operationId: input.operationId,
      }),
      fetchFundingOperationStepForUser(this.db, {
        userId,
        operationId: input.operationId,
        stepId: input.stepId,
      }),
      buildAccountValueReadModel({ pool: this.db, userId }),
    ]);
    if (!operation || !step) {
      throw new FundingPersistenceError(
        "operation_not_found",
        "funding operation action was not found for authenticated user",
      );
    }
    const externalRecipientId = assertWithdrawalActionPolicy(operation);
    if (!externalRecipientId) {
      const resolvedPolicy = await resolveFundingPolicy(this.db);
      if (
        resolvedPolicy.runtime.creationMode !== "on" ||
        !resolvedPolicy.runtime.gates.startUnsubmittedAction ||
        resolvedPolicy.runtime.gates.emergencyBroadcastPause ||
        resolvedPolicy.revision !== operation.policyRevision
      ) {
        throw new FundingPersistenceError(
          "quote_invalidated",
          "funding action start is disabled or its policy changed",
        );
      }
    }
    if (externalRecipientId) {
      await (
        this.dependencies.revalidateWithdrawalRecipient ??
        ((ownerId, recipientId) =>
          this.withdrawalRuntime
            .resolve(ownerId, recipientId)
            .then(() => undefined))
      )(userId, externalRecipientId);
    }
    const action = normalizedActionSchema.parse(
      step.normalizedAction,
    ) as unknown as NormalizedAction;
    const fingerprint = canonicalJsonHash(action);
    if (fingerprint !== step.actionFingerprint) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "stored funding action differs from its immutable fingerprint",
      );
    }
    const execution = assertClientExecutable(
      action,
      step.executorId,
      account.ownership?.wallets ?? [],
    );
    const started = await startFundingStepAttemptForUser(this.db, {
      userId,
      operationId: input.operationId,
      stepId: input.stepId,
      canonicalActionFingerprint: fingerprint,
      executorId: step.executorId,
    });
    return {
      attemptId: started.attempt.id,
      action,
      actionFingerprint: fingerprint,
      controllerWalletRef: execution.controllerWalletRef,
      executorId: step.executorId,
      executionMode: execution.executionMode,
      payerRequirement: execution.payerRequirement,
      sponsorshipPolicyId: execution.sponsorshipPolicyId,
    };
  }

  async report(
    userId: string,
    input: Readonly<{
      operationId: string;
      stepId: string;
      attemptId: string;
      outcome: FundingActionReportOutcome;
      transactionReference: string | null;
      actualCosts: Readonly<{ networkFeeRaw: string | null }>;
    }>,
  ): Promise<
    Readonly<{
      accepted: true;
      stepState: "submitted" | "reconcile_required" | "failed" | "cancelled";
    }>
  > {
    const step = await fetchFundingOperationStepForUser(this.db, {
      userId,
      operationId: input.operationId,
      stepId: input.stepId,
    });
    if (!step) {
      throw new FundingPersistenceError(
        "operation_not_found",
        "funding operation action was not found for authenticated user",
      );
    }
    const action = normalizedActionSchema.parse(
      step.normalizedAction,
    ) as unknown as NormalizedAction;
    if (!isReportableFundingActionKind(action.kind)) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "this endpoint accepts only committed transaction or relayer reports",
      );
    }
    const mayHaveBroadcast =
      input.outcome === "submitted" || input.outcome === "ambiguous";
    if (mayHaveBroadcast !== Boolean(input.transactionReference)) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "possible broadcast requires exactly one transaction reference",
      );
    }
    const lookupKey = process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY?.trim();
    const keyVersion =
      parsePositiveInteger(process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION) ??
      1;
    if (!lookupKey) {
      throw new FundingPersistenceError(
        "quote_invalidated",
        "funding reference protection is not configured",
      );
    }
    const codec = createFundingTransactionReferenceCodec({
      encryptionKey: getCredentialsEncryptionKey(),
      lookupHmacKey: lookupKey,
      keyVersion,
    });
    const reference = input.transactionReference
      ? normalizePolymarketDepositWalletTransactionReference(
          action,
          step.actionValidationResult,
          input.transactionReference,
        )
      : null;
    const finished = await finishFundingStepAttemptForUser(this.db, {
      userId,
      operationId: input.operationId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      outcome: input.outcome,
      broadcastMayHaveOccurred: mayHaveBroadcast,
      referenceKind: reference
        ? action.kind === "svm_transaction"
          ? "signature"
          : "transaction"
        : null,
      receiptRefCiphertext: reference ? codec.encrypt(reference) : null,
      receiptRefLookupHmac: reference ? codec.fingerprint(reference) : null,
      lookupKeyVersion: reference ? codec.keyVersion : null,
      actualCosts: input.actualCosts,
    });
    return {
      accepted: true,
      stepState: finished.stepState,
    };
  }
}
