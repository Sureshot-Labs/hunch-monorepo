import { tx, type Pool } from "@hunch/infra";

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
  startFundingStepAttemptForUserInTransaction,
} from "../persistence/funding-evidence-repository.js";
import {
  fetchFundingOperationForUser,
  FundingPersistenceError,
  type FundingOperationRow,
} from "../persistence/funding-operation-repository.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import {
  lockFundingPolicyForTransaction,
  resolveFundingPolicy,
} from "../policies/funding-policy-service.js";
import { withdrawalBindingMatches } from "../domain/withdrawal-binding.js";
import { parsePositiveInteger } from "../runtime/positive-integer.js";
import {
  resolveActionSponsorship,
  type ResolvedActionSponsorship,
} from "./sponsorship-policy.js";
import {
  normalizePolymarketDepositWalletTransactionReference,
  polymarketDepositWalletHandoffExpectation,
} from "./polymarket-deposit-wallet-handoff.js";
import { createFundingTransactionReferenceCodec } from "./transaction-reference-codec.js";
import { WithdrawalDestinationRuntime } from "./withdrawal-destination-runtime.js";
import { lockFundingControllerWallet } from "./funding-controller-wallet-lock.js";
import {
  isExternalHandoffFailureCode,
  isFundingActionFailureReportConsistent,
  isUnreferencedFundingActionAmbiguity,
  type FundingActionFailureCode,
} from "./action-report.js";

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
  controllerProfile: WalletExecutionProfile;
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
      controllerProfile: profile,
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
  const controllerProfile = profiles.find(
    (candidate) =>
      candidate.controllerWalletRef === profile.controllerWalletRef &&
      candidate.networkId === action.networkId &&
      candidate.source !== "smart",
  );
  if (!controllerProfile) {
    throw new FundingPersistenceError(
      "quote_invalidated",
      "committed signer controller is no longer an exact owned wallet",
    );
  }
  const sponsorship: ResolvedActionSponsorship = resolveActionSponsorship({
    action,
    profile,
  });
  return {
    controllerWalletRef: profile.controllerWalletRef,
    controllerProfile,
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

export function fundingActionPolicyIsCurrent(
  operation: Pick<FundingOperationRow, "policyRevision" | "policyVersion">,
  resolved: Readonly<{
    revision: string;
    runtime: Readonly<{ contractVersion: number }>;
  }>,
): boolean {
  return (
    resolved.revision === operation.policyRevision &&
    resolved.runtime.contractVersion === operation.policyVersion
  );
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
    return tx(this.db, async (client) => {
      if (externalRecipientId) {
        // The share lock makes revocation/crypto-shredding serialize with the
        // durable attempt start; validation outside this transaction can race.
        await this.withdrawalRuntime.resolve(userId, externalRecipientId, {
          db: client,
          lockForShare: true,
        });
        await this.dependencies.revalidateWithdrawalRecipient?.(
          userId,
          externalRecipientId,
        );
      }
      let expectedPolicy:
        | Readonly<{ revision: string; version: number }>
        | undefined;
      if (!externalRecipientId) {
        await lockFundingPolicyForTransaction(client);
        const resolvedPolicy = await resolveFundingPolicy(client);
        if (
          resolvedPolicy.runtime.creationMode !== "on" ||
          !resolvedPolicy.runtime.gates.startUnsubmittedAction ||
          resolvedPolicy.runtime.gates.emergencyBroadcastPause ||
          !fundingActionPolicyIsCurrent(operation, resolvedPolicy)
        ) {
          throw new FundingPersistenceError(
            "quote_invalidated",
            "funding action start is disabled or its policy changed",
          );
        }
        expectedPolicy = {
          revision: resolvedPolicy.revision,
          version: resolvedPolicy.runtime.contractVersion,
        };
      }
      const start = () =>
        startFundingStepAttemptForUserInTransaction(client, {
          userId,
          operationId: input.operationId,
          stepId: input.stepId,
          canonicalActionFingerprint: fingerprint,
          executorId: step.executorId,
          ...(expectedPolicy ? { expectedPolicy } : {}),
        });
      // Policy-controlled actions lock operation/step before the wallet. The
      // delegated worker uses the same order; a failed wallet check rolls the
      // inserted attempt back with this transaction.
      const started = externalRecipientId ? null : await start();
      await lockFundingControllerWallet(
        client,
        userId,
        execution.controllerProfile,
      );
      const durableStart = started ?? (await start());
      return {
        attemptId: durableStart.attempt.id,
        action,
        actionFingerprint: fingerprint,
        controllerWalletRef: execution.controllerWalletRef,
        executorId: step.executorId,
        executionMode: execution.executionMode,
        payerRequirement: execution.payerRequirement,
        sponsorshipPolicyId: execution.sponsorshipPolicyId,
      };
    });
  }

  async report(
    userId: string,
    input: Readonly<{
      operationId: string;
      stepId: string;
      attemptId: string;
      outcome: FundingActionReportOutcome;
      transactionReference: string | null;
      failureCode: FundingActionFailureCode | null;
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
    if (!isFundingActionFailureReportConsistent(input)) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "funding action diagnostic contradicts its broadcast boundary",
      );
    }
    if (
      isExternalHandoffFailureCode(input.failureCode) &&
      !polymarketDepositWalletHandoffExpectation(
        action,
        step.actionValidationResult,
      )
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "external handoff diagnostic requires the exact committed handoff action",
      );
    }
    const unreferencedAmbiguity = isUnreferencedFundingActionAmbiguity(input);
    if (
      (mayHaveBroadcast &&
        !input.transactionReference &&
        !unreferencedAmbiguity) ||
      (!mayHaveBroadcast && input.transactionReference)
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "possible broadcast requires a transaction reference unless provider submission is explicitly unknown",
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
    const normalizedReference = input.transactionReference
      ? normalizePolymarketDepositWalletTransactionReference(
          action,
          step.actionValidationResult,
          input.transactionReference,
        )
      : null;
    const reference = normalizedReference?.reference ?? null;
    const actualCosts = {
      ...input.actualCosts,
      ...(input.failureCode ? { reasonCode: input.failureCode } : {}),
    };
    const finished = await finishFundingStepAttemptForUser(this.db, {
      userId,
      operationId: input.operationId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      outcome: input.outcome,
      broadcastMayHaveOccurred: mayHaveBroadcast,
      referenceKind: normalizedReference
        ? action.kind === "svm_transaction"
          ? "signature"
          : normalizedReference.kind
        : null,
      receiptRefCiphertext: reference ? codec.encrypt(reference) : null,
      receiptRefLookupHmac: reference ? codec.fingerprint(reference) : null,
      lookupKeyVersion: reference ? codec.keyVersion : null,
      actualCosts,
    });
    return {
      accepted: true,
      stepState: finished.stepState,
    };
  }
}
