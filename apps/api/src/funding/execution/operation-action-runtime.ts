import { tx, type Pool } from "@hunch/infra";
import { PublicKey } from "@solana/web3.js";
import { createSolanaRpcConnection } from "../../services/rpc-client-factory.js";
import {
  parseSolanaSigningContext,
  parseVerifiedSolanaSubmission,
  verifySignedSolanaFundingSubmission,
  type SolanaSigningContext,
} from "./signed-solana-submission.js";
import { validatePolymarketFunderSelection } from "../../services/polymarket-funder.js";

import { buildAccountValueReadModel } from "../../account-value/runtime-service.js";
import { getCredentialsEncryptionKey } from "../../lib/credentials-encryption.js";
import { isReceiptBearingFundingActionKind } from "../domain/action-kinds.js";
import { normalizedActionSchema } from "../domain/schemas.js";
import { DirectWithdrawalSourceAdapter } from "../planner/direct-withdrawal-source-adapter.js";
import { DIRECT_SOLANA_WITHDRAWAL_FEE_ONLY_POLICY } from "./direct-solana-sponsorship-policy.js";
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
import { fundingReservationHoldSql } from "../persistence/source-reservation-hold.js";
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
import { expireUnbroadcastActionWait } from "../reconciliation/funding-reducer.js";
import {
  isExternalHandoffFailureCode,
  isFundingActionFailureReportConsistent,
  isUnreferencedFundingActionAmbiguity,
  normalizeFundingActionReport,
  type FundingActionFailureCode,
} from "./action-report.js";
import {
  assertDirectWithdrawalActionMatchesRecipient,
  isDirectWithdrawalExecutionKind,
} from "./direct-withdrawal-transfer.js";

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
    const isSafe = action.handoffKind === "polymarket_safe_transfer";
    if (
      action.networkId !== "evm:137" ||
      (!isSafe &&
        action.handoffKind !== "polymarket_deposit_wallet_transfer") ||
      executorId !==
        (isSafe
          ? "polymarket_safe_relayer_v1"
          : EXECUTOR_BY_ACTION_KIND.external_handoff)
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "committed external handoff is not an allowlisted client executor",
      );
    }
    const profile = exactWalletProfile(profiles, action);
    if (
      !profile ||
      (profile.source === "external" && !isSafe) ||
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
      solanaSigningContext?: SolanaSigningContext;
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
    let execution = assertClientExecutable(
      action,
      step.executorId,
      account.ownership?.wallets ?? [],
    );
    // Bind a server-observed lifetime BEFORE signing. A delayed registration
    // can then be reconciled even if the wallet dialog outlives this blockhash.
    let solanaSigningContext: SolanaSigningContext | undefined;
    if (
      action.kind === "svm_transaction" &&
      execution.executionMode === "web_client"
    ) {
      const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
      if (!rpcUrl)
        throw new FundingPersistenceError(
          "quote_invalidated",
          "Solana signing is unavailable",
        );
      const connection = createSolanaRpcConnection(rpcUrl, {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
        fetch: (url, init) =>
          fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
      });
      solanaSigningContext = await connection.getLatestBlockhash("confirmed");
    }
    if (
      action.kind === "external_handoff" &&
      action.handoffKind === "polymarket_safe_transfer"
    ) {
      const expectation = polymarketDepositWalletHandoffExpectation(
        action,
        step.actionValidationResult,
      );
      if (
        !expectation ||
        expectation.recipientAddress.toLowerCase() !==
          execution.controllerProfile.address.toLowerCase()
      ) {
        throw new FundingPersistenceError(
          "quote_mismatch",
          "Safe recovery must return the exact asset to its controller",
        );
      }
      const checked = await validatePolymarketFunderSelection({
        signer: execution.controllerProfile.address,
        funderAddress: expectation.funderAddress,
        includeMagicProxy: false,
      });
      if (
        checked.candidate?.signatureType !== 2 ||
        !checked.candidate.deployed ||
        checked.candidate.safeThreshold !== 1 ||
        checked.candidate.safeOwners?.length !== 1
      ) {
        throw new FundingPersistenceError(
          "quote_invalidated",
          "Safe recovery requires the existing canonical deployed Safe",
        );
      }
    }
    return tx(this.db, async (client) => {
      if (externalRecipientId) {
        // The share lock makes revocation/crypto-shredding serialize with the
        // durable attempt start; validation outside this transaction can race.
        const recipient = await this.withdrawalRuntime.resolve(
          userId,
          externalRecipientId,
          {
            db: client,
            lockForShare: true,
          },
        );
        const directWithdrawal = isDirectWithdrawalExecutionKind(
          operation.supportMetadata.withdrawalExecutionKind,
        );
        if (
          directWithdrawal &&
          action.kind !== "evm_transaction" &&
          action.kind !== "svm_transaction" &&
          action.kind !== "external_handoff"
        ) {
          throw new FundingPersistenceError(
            "quote_mismatch",
            "direct withdrawal contains an unsupported action",
          );
        }
        if (
          action.kind === "evm_transaction" ||
          action.kind === "svm_transaction"
        ) {
          assertDirectWithdrawalActionMatchesRecipient({
            action,
            actionValidationResult: step.actionValidationResult,
            recipient,
            required: directWithdrawal,
          });
          if (directWithdrawal && action.kind === "svm_transaction") {
            const componentId = operation.supportMetadata.sourceComponentId;
            const raw = step.actionValidationResult.expectedSourceRaw;
            if (
              typeof componentId !== "string" ||
              typeof raw !== "string" ||
              !/^[1-9][0-9]*$/.test(raw)
            )
              throw new FundingPersistenceError(
                "quote_invalidated",
                "Withdrawal source binding missing",
              );
            const feeRaw = step.actionValidationResult.withdrawalUserSolCostRaw;
            const fee =
              typeof feeRaw === "string" && /^(0|[1-9][0-9]*)$/.test(feeRaw)
                ? BigInt(feeRaw)
                : 0n;
            const native =
              recipient.asset.assetId === "11111111111111111111111111111111";
            const held = await client.query<{
              component_id: string;
              raw_amount: string;
            }>(
              `
              select reservation.component_id, reservation.raw_amount
              from balance_reservations reservation
              where reservation.user_id = $1 and reservation.operation_id = $2
                and reservation.state = 'active' and reservation.mode = 'subtract_available'
                and ${fundingReservationHoldSql("reservation")}
              for update
            `,
              [userId, operation.id],
            );
            const sourceHeld = held.rows
              .filter((row) => row.component_id === componentId)
              .reduce((sum, row) => sum + BigInt(row.raw_amount), 0n);
            const solIds = new Set(
              account.projection.components
                .filter(
                  (row) =>
                    row.amount.asset.networkId === "solana:mainnet" &&
                    row.amount.asset.assetId ===
                      "11111111111111111111111111111111" &&
                    row.location.details.address ===
                      execution.controllerProfile.address,
                )
                .map((row) => row.componentId),
            );
            const gasHeld = native
              ? 0n
              : held.rows
                  .filter((row) => solIds.has(row.component_id))
                  .reduce((sum, row) => sum + BigInt(row.raw_amount), 0n);
            if (
              sourceHeld !== BigInt(raw) + (native ? fee : 0n) ||
              gasHeld !== (native ? 0n : fee)
            )
              throw new FundingPersistenceError(
                "quote_invalidated",
                "Withdrawal reservation no longer matches the reviewed cost",
              );
            const checked = await new DirectWithdrawalSourceAdapter(
              account,
            ).capacity(componentId, recipient, {
              requestedRaw: BigInt(raw),
              ownReservedRaw: sourceHeld,
              ownReservedSolRaw: gasHeld,
              frozenPayer: step.payerRequirement,
            });
            if (
              !checked.built ||
              checked.userSolCostRaw > fee ||
              canonicalJsonHash(checked.built.action) !== fingerprint ||
              checked.payer !== step.payerRequirement
            )
              throw new FundingPersistenceError(
                "quote_invalidated",
                "Withdrawal cost or payer changed; review again",
              );
            if (checked.payer === "privy_sponsor")
              execution = {
                ...execution,
                payerRequirement: checked.payer,
                sponsorshipPolicyId: DIRECT_SOLANA_WITHDRAWAL_FEE_ONLY_POLICY,
              };
          }
        }
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
          solanaSigningContext,
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
        ...(solanaSigningContext ? { solanaSigningContext } : {}),
      };
    }).catch(async (error: unknown) => {
      if (
        operation.purpose === "trade_shortfall" &&
        error instanceof FundingPersistenceError &&
        error.code === "quote_expired"
      ) {
        // The failed attempt transaction has rolled back. Use the same
        // evidence-checked expiry path as the worker now, rather than leave
        // the client waiting for the next reconciliation tick. It refuses
        // cancellation if any submission outcome remains uncertain.
        await expireUnbroadcastActionWait(this.db, {
          operationId: input.operationId,
          now: new Date(),
        });
      }
      throw error;
    });
  }

  async report(
    userId: string,
    input: Readonly<{
      operationId: string;
      stepId: string;
      attemptId: string;
      outcome: FundingActionReportOutcome;
      signedTransaction?: string;
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
    const report = normalizeFundingActionReport(input);
    const mayHaveBroadcast =
      report.outcome === "submitted" || report.outcome === "ambiguous";
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
    const unreferencedAmbiguity = isUnreferencedFundingActionAmbiguity(report);
    if (
      input.failureCode === "embedded_evm_submission_unknown" &&
      (step.executorId !== "wallet_profile_evm_v1" ||
        (action.kind !== "evm_transaction" &&
          action.kind !== "evm_transaction_batch"))
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "embedded EVM diagnostic requires a committed EVM wallet action",
      );
    }
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
    let signedSubmission = null;
    if (input.signedTransaction !== undefined) {
      const signer = step.actionValidationResult.signerAddress;
      const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
      if (
        action.kind !== "svm_transaction" ||
        step.executorId !== "wallet_profile_svm_v1" ||
        typeof signer !== "string" ||
        !rpcUrl ||
        report.outcome !== "ambiguous" ||
        !reference
      ) {
        throw new FundingPersistenceError(
          "quote_mismatch",
          "signed submission requires an exact Solana wallet action and ambiguous reference report",
        );
      }
      const connection = createSolanaRpcConnection(rpcUrl, {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
        fetch: (url, init) =>
          fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
      });
      const lookupTables = await Promise.all(
        action.addressLookupTables.map(async (address) => {
          const result = await connection.getAddressLookupTable(
            new PublicKey(address),
          );
          if (!result.value)
            throw new FundingPersistenceError(
              "quote_invalidated",
              "Solana lookup table unavailable",
            );
          return result.value;
        }),
      );
      let identity;
      try {
        identity = verifySignedSolanaFundingSubmission({
          action,
          signer,
          signedTransaction: input.signedTransaction,
          lookupTables,
        });
      } catch {
        throw new FundingPersistenceError(
          "quote_mismatch",
          "signed Solana submission does not match the committed action",
        );
      }
      if (identity.signature !== reference)
        throw new FundingPersistenceError(
          "quote_mismatch",
          "signed submission reference mismatch",
        );
      const existing = await this.db.query<{
        actual_costs: Record<string, unknown>;
      }>(
        `select attempt_row.actual_costs from funding_operation_step_attempts attempt_row
         join funding_operation_steps step_row on step_row.id = attempt_row.step_id
         join funding_operations operation_row on operation_row.id = step_row.operation_id
         where attempt_row.id=$1 and step_row.id=$2 and operation_row.id=$3 and operation_row.user_id=$4`,
        [input.attemptId, input.stepId, input.operationId, userId],
      );
      if (!existing.rows[0])
        throw new FundingPersistenceError(
          "operation_not_found",
          "funding attempt not found",
        );
      const prior = parseVerifiedSolanaSubmission(
        existing.rows[0].actual_costs?.verifiedSolanaSubmission,
      );
      if (prior) {
        if (
          prior.signature !== identity.signature ||
          prior.blockhash !== identity.blockhash
        )
          throw new FundingPersistenceError(
            "quote_mismatch",
            "funding attempt already has another signed transaction",
          );
        signedSubmission = prior;
      } else {
        const context = parseSolanaSigningContext(
          existing.rows[0].actual_costs?.solanaSigningContext,
        );
        if (!context || context.blockhash !== identity.blockhash)
          throw new FundingPersistenceError(
            "quote_mismatch",
            "signed Solana submission requires its server-issued blockhash",
          );
        signedSubmission = {
          version: 1 as const,
          ...identity,
          lastValidBlockHeight: context.lastValidBlockHeight,
        };
      }
    }
    const actualCosts = {
      ...input.actualCosts,
      ...(input.failureCode ? { reasonCode: input.failureCode } : {}),
      ...(signedSubmission
        ? { verifiedSolanaSubmission: signedSubmission }
        : {}),
      ...(normalizedReference?.kind === "provider_receipt"
        ? { providerReferenceKind: "privy_transaction" }
        : {}),
    };
    const finished = await finishFundingStepAttemptForUser(this.db, {
      userId,
      operationId: input.operationId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      outcome: report.outcome,
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
