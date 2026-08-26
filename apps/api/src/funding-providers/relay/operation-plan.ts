import { Interface } from "ethers";
import { isPositiveRawAmount } from "../../funding/domain/raw-amount.js";

import { stableOpaqueId } from "../../account-value/canonical.js";
import { multiplyRawByUnitPrice } from "../../account-value/decimal.js";
import type {
  ExternalHandoffAction,
  FundingExecutionPlan,
  JsonValue,
  Money,
  NormalizedAction,
  WalletExecutionProfile,
} from "../../funding/domain/types.js";
import {
  canonicalAssetId,
  sameAccountAddress,
} from "../../funding/domain/asset-identity.js";
import { operationPurposeForExternalRecipient } from "../../funding/domain/withdrawal-binding.js";
import { groupWalletExecutableActions } from "../../funding/planner/evm-action-batching.js";
import type { ResolvedRouteDestination } from "../../funding/planner/destination-adapters.js";
import type {
  RelayEligibleSourceFact,
  RelayPlanningQuote,
} from "../../funding/planner/source-options.js";
import type { FundingRuntimePolicy } from "../../funding/policies/funding-policy.js";
import { canonicalJsonHash } from "../../funding/persistence/canonical.js";
import type { FundingCommitStep } from "../../funding/persistence/funding-operation-repository.js";
import { resolveActionSponsorship } from "../../funding/execution/sponsorship-policy.js";
import { withRelayClientSourceDebitPostcondition } from "../../funding/execution/relay-client-source-debit.js";
import { RelayPinnedActionValidator } from "./action-validator.js";
import { isRelayPinnedStableAsset } from "./mappings.js";
import {
  RELAY_DEPOSITORY_V2,
  canonicalizeRelayDepositoryV2SelfBoundAction,
} from "./rehearsal.js";
import type { createRelayReferenceCodec } from "./reference-codec.js";
import type { NormalizedRelayWalletQuote } from "./wallet-adapter.js";

const POLYMARKET_DEPOSIT_WALLET_HANDOFF_EXECUTOR_ID =
  "polymarket_deposit_wallet_relayer_v1";
const ERC20_TRANSFER_INTERFACE = new Interface([
  "function transfer(address recipient,uint256 amount)",
]);
const ERC20_APPROVE_INTERFACE = new Interface([
  "function approve(address spender,uint256 amount)",
]);

export function groupRelayExecutableActions(input: {
  actions: readonly NormalizedAction[];
  preserveActionBoundaries: boolean;
  profile: WalletExecutionProfile;
}) {
  return input.preserveActionBoundaries
    ? input.actions.map((action) => ({ action, sourceActions: [action] }))
    : groupWalletExecutableActions({
        actions: input.actions,
        profile: input.profile,
      });
}

function jsonRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  return value as Readonly<Record<string, JsonValue>>;
}

function relayStepKindForSourceActions(
  actions: readonly NormalizedAction[],
): "approve" | "deposit" | null {
  if (actions.some((action) => action.actionId.endsWith(":deposit"))) {
    return "deposit";
  }
  return actions.some((action) => action.actionId.endsWith(":approve"))
    ? "approve"
    : null;
}

function stableUsdValue(amount: Money): string | null {
  return isRelayPinnedStableAsset(amount.asset)
    ? multiplyRawByUnitPrice({
        raw: amount.raw,
        decimals: amount.asset.decimals,
        unitPriceUsd: "1",
      })
    : null;
}

async function validatedSteps(input: {
  actions: readonly NormalizedAction[];
  minimumOutput: Money;
  policyRevision: string;
  preserveActionBoundaries: boolean;
  quoteCorrelationId: string;
  route: FundingRuntimePolicy["routes"][number];
  sourceAmount: Money;
  profile: WalletExecutionProfile;
}) {
  const validatedByActionId = new Map<
    string,
    Awaited<ReturnType<RelayPinnedActionValidator["validate"]>>
  >();
  for (const action of input.actions) {
    const signerWalletId =
      action.kind === "evm_transaction"
        ? action.senderWalletId
        : action.kind === "svm_transaction"
          ? action.signerWalletId
          : "";
    const validation = await new RelayPinnedActionValidator(action).validate(
      action,
      {
        operationId: input.quoteCorrelationId,
        expectedState: { status: "in_progress", stage: "committed" },
        expectedNetworkId: action.networkId,
        expectedSignerWalletId: signerWalletId,
        sourceAmount: input.sourceAmount,
        minimumOutput: input.minimumOutput,
        policyRevision: input.policyRevision,
        routeId: input.route.routeId,
      },
    );
    resolveActionSponsorship({ action, profile: input.profile });
    validatedByActionId.set(action.actionId, validation);
  }

  const executableActions = groupRelayExecutableActions(input);
  return executableActions.map(({ action, sourceActions }, ordinal) => {
    const validations = sourceActions.map((sourceAction) => {
      const validation = validatedByActionId.get(sourceAction.actionId);
      if (!validation) {
        throw new Error("validated Relay action is missing from atomic group");
      }
      return validation;
    });
    const sponsorship = resolveActionSponsorship({
      action,
      profile: input.profile,
    });
    const relayStepKind = relayStepKindForSourceActions(sourceActions);
    const validation =
      validations.length === 1
        ? validations[0]
        : {
            validatorId: "relay_evm_atomic_batch_v1",
            validationRevision: canonicalJsonHash(
              validations.map((entry) => entry.validationRevision),
            ),
            validatedAt: validations.reduce(
              (latest, entry) =>
                entry.validatedAt > latest ? entry.validatedAt : latest,
              "",
            ),
            sourceActionValidations: validations.map((entry) => ({
              actionId: entry.action.actionId,
              validatorId: entry.validatorId,
              validationRevision: entry.validationRevision,
              validatedAt: entry.validatedAt,
            })),
          };
    const actionValidationResult = withRelayClientSourceDebitPostcondition({
      action,
      actionValidationResult: jsonRecord({
        ...validation,
        signerAddress: input.profile.address,
        sponsorshipPolicyId: sponsorship.policyId,
        signingMode: sponsorship.signingMode,
        ...(relayStepKind ? { relayStepKind } : {}),
      }),
      routeId: input.route.routeId,
      sourceAmount: input.sourceAmount,
    });
    return {
      ordinal,
      segmentOrdinal: 0,
      stepKind: "transaction" as const,
      state: "action_required" as const,
      actionFingerprint: canonicalJsonHash(action),
      executorId: input.route.networkExecutorId,
      payerRequirement: sponsorship.payerRequirement,
      dependsOnOrdinal: ordinal === 0 ? null : ordinal - 1,
      normalizedAction: jsonRecord(action),
      actionValidationResult,
    };
  });
}

export function buildPolymarketPreRouteHandoffSteps(input: {
  source: Pick<RelayEligibleSourceFact, "preRouteHandoff">;
  sourceAmount: Money;
  profile: WalletExecutionProfile;
  steps: readonly FundingCommitStep[];
}): readonly FundingCommitStep[] {
  const handoff = input.source.preRouteHandoff;
  if (!handoff) return input.steps;
  if (
    handoff.kind !== "polymarket_deposit_wallet_to_controller_v1" ||
    input.sourceAmount.asset.networkId !== "evm:137" ||
    canonicalAssetId(input.sourceAmount.asset) !==
      canonicalAssetId({
        ...input.sourceAmount.asset,
        assetId: handoff.tokenAddress,
      }) ||
    !sameAccountAddress(
      input.sourceAmount.asset.networkId,
      handoff.controllerAddress,
      input.profile.address,
    ) ||
    BigInt(input.sourceAmount.raw) <= 0n
  ) {
    throw new Error("Polymarket pre-route handoff differs from Relay source");
  }
  const transferData = ERC20_TRANSFER_INTERFACE.encodeFunctionData("transfer", [
    handoff.controllerAddress,
    BigInt(input.sourceAmount.raw),
  ]);
  const action: ExternalHandoffAction = {
    kind: "external_handoff",
    actionId: stableOpaqueId(
      "funding_action",
      canonicalJsonHash({
        kind: handoff.kind,
        funderAddress: handoff.funderAddress,
        controllerAddress: handoff.controllerAddress,
        tokenAddress: handoff.tokenAddress,
        amountRaw: input.sourceAmount.raw,
      }),
    ),
    networkId: input.sourceAmount.asset.networkId,
    actorWalletId: input.profile.walletId,
    handoffKind: "polymarket_deposit_wallet_transfer",
    payload: {
      topology: "deposit_wallet",
      funder: handoff.funderAddress,
      recipient: handoff.controllerAddress,
      token: handoff.tokenAddress,
      amountRaw: input.sourceAmount.raw,
      calls: [
        {
          target: handoff.tokenAddress,
          value: "0",
          data: transferData,
        },
      ],
    },
  };
  return [
    {
      ordinal: 0,
      // This is an exact user-authorized transfer from the Polymarket Deposit
      // Wallet, not a Relay quote action. In particular, do not bind the time
      // available to open Hunch and approve it to the short-lived downstream
      // Relay quote. The subsequent Relay steps retain their own quote fence.
      segmentOrdinal: null,
      stepKind: "external_handoff" as const,
      state: "action_required" as const,
      actionFingerprint: canonicalJsonHash(action),
      executorId: POLYMARKET_DEPOSIT_WALLET_HANDOFF_EXECUTOR_ID,
      payerRequirement: "provider" as const,
      dependsOnOrdinal: null,
      normalizedAction: jsonRecord(action),
      actionValidationResult: jsonRecord({
        signerAddress: input.profile.address,
        executionEnvelope: handoff.kind,
        funderAddress: handoff.funderAddress,
        recipientAddress: handoff.controllerAddress,
        tokenAddress: handoff.tokenAddress,
        amountRaw: input.sourceAmount.raw,
        transferData,
      }),
    },
    ...input.steps.map((step) => ({
      ...step,
      ordinal: step.ordinal + 1,
      dependsOnOrdinal:
        step.dependsOnOrdinal == null ? 0 : step.dependsOnOrdinal + 1,
    })),
  ];
}

export function relayDelegatedCommitSteps(
  input: Readonly<{
    steps: readonly FundingCommitStep[];
    sourceAmount: Money;
    profile: WalletExecutionProfile;
    serverExecutionProfileId: string;
    persistentApprovalCapRaw?: string;
  }>,
): readonly FundingCommitStep[] {
  const quotedDepositStep =
    input.steps.length === 1
      ? input.steps[0]
      : input.steps.length === 2
        ? input.steps[1]
        : undefined;
  const usesExistingAllowance = input.steps.length === 1;
  const persistentApprovalCapRaw = input.persistentApprovalCapRaw;
  const usesPersistentApproval =
    !usesExistingAllowance && persistentApprovalCapRaw != null;
  if (
    usesPersistentApproval &&
    (!isPositiveRawAmount(persistentApprovalCapRaw) ||
      BigInt(input.sourceAmount.raw) > BigInt(persistentApprovalCapRaw))
  ) {
    throw new Error("delegated Relay persistent approval cap is invalid");
  }
  if (
    !quotedDepositStep ||
    typeof quotedDepositStep.normalizedAction.actionId !== "string" ||
    !quotedDepositStep.normalizedAction.actionId.endsWith(":deposit") ||
    (usesExistingAllowance && quotedDepositStep.dependsOnOrdinal !== null) ||
    (!usesExistingAllowance &&
      (typeof input.steps[0]?.normalizedAction.actionId !== "string" ||
        !input.steps[0].normalizedAction.actionId.endsWith(":approve") ||
        input.steps[0].dependsOnOrdinal !== null ||
        quotedDepositStep.dependsOnOrdinal !== 0))
  ) {
    throw new Error(
      "delegated Relay EVM route requires exact deposit or approve/deposit steps",
    );
  }
  const quotedDepositAction = quotedDepositStep.normalizedAction;
  if (
    quotedDepositAction.kind !== "evm_transaction" ||
    typeof quotedDepositAction.to !== "string" ||
    typeof quotedDepositAction.data !== "string" ||
    quotedDepositAction.valueRaw !== "0" ||
    quotedDepositAction.senderWalletId !== input.profile.walletId
  ) {
    throw new Error("delegated Relay deposit quote is not an exact EVM action");
  }
  const canonicalDeposit = canonicalizeRelayDepositoryV2SelfBoundAction({
    action: {
      data: quotedDepositAction.data,
      to: quotedDepositAction.to,
      value: 0n,
    },
    amount: BigInt(input.sourceAmount.raw),
    token: input.sourceAmount.asset.assetId,
    user: input.profile.address,
  });
  const canonicalDepositAction = jsonRecord({
    ...quotedDepositAction,
    data: canonicalDeposit.data,
  });
  const committedDepositStep = {
    ...quotedDepositStep,
    actionFingerprint: canonicalJsonHash(canonicalDepositAction),
    normalizedAction: canonicalDepositAction,
    actionValidationResult: jsonRecord({
      ...quotedDepositStep.actionValidationResult,
      quotedActionFingerprint: quotedDepositStep.actionFingerprint,
      quotedDepositorAddress: input.profile.address,
      committedDepositorMode: "msg_sender_via_zero",
      relayOrderId: canonicalDeposit.orderId,
    }),
  };
  const quotedApprovalStep = input.steps[0] as FundingCommitStep | undefined;
  const canonicalApprovalAction =
    usesPersistentApproval && quotedApprovalStep
      ? jsonRecord({
          ...quotedApprovalStep.normalizedAction,
          to: input.sourceAmount.asset.assetId,
          data: ERC20_APPROVE_INTERFACE.encodeFunctionData("approve", [
            RELAY_DEPOSITORY_V2,
            BigInt(persistentApprovalCapRaw),
          ]),
        })
      : null;
  const committedApprovalStep =
    canonicalApprovalAction && quotedApprovalStep
      ? {
          ...quotedApprovalStep,
          actionFingerprint: canonicalJsonHash(canonicalApprovalAction),
          normalizedAction: canonicalApprovalAction,
        }
      : quotedApprovalStep;
  const committedSteps = usesExistingAllowance
    ? [committedDepositStep]
    : [committedApprovalStep as FundingCommitStep, committedDepositStep];
  return committedSteps.map((step, ordinal) => ({
    ...step,
    stepKind:
      !usesExistingAllowance && ordinal === 0 ? "approval" : step.stepKind,
    state: "planned",
    executorId: input.serverExecutionProfileId,
    actionValidationResult: jsonRecord({
      ...step.actionValidationResult,
      delegatedProfileId: input.serverExecutionProfileId,
      relayStepKind:
        !usesExistingAllowance && ordinal === 0 ? "approve" : "deposit",
      requiresSingleOperationBundle: true,
      ...(usesExistingAllowance ? { relayAllowanceMode: "preexisting" } : {}),
      ...(!usesExistingAllowance && ordinal === 0 && usesPersistentApproval
        ? {
            relayApprovalCapRaw: persistentApprovalCapRaw,
            relayAllowancePersistence: "bounded_cap",
          }
        : {}),
      ...(!usesExistingAllowance && ordinal === 1 && usesPersistentApproval
        ? { relayAllowanceMode: "preexisting" }
        : {}),
      ...(usesExistingAllowance || ordinal === 1
        ? {
            postconditionEvidenceKind: "exact_erc20_source_debit_v1",
            expectedSourceAssetId: input.sourceAmount.asset.assetId,
            expectedSourceAssetDecimals: input.sourceAmount.asset.decimals,
            expectedSourceAddress: input.profile.address,
            expectedSourceRecipient:
              typeof step.normalizedAction.to === "string"
                ? step.normalizedAction.to
                : "",
            expectedSourceRaw: input.sourceAmount.raw,
          }
        : {}),
    }),
  }));
}

function executionPlan(input: {
  quote: NormalizedRelayWalletQuote;
  route: FundingRuntimePolicy["routes"][number];
}): FundingExecutionPlan {
  return {
    kind: "wallet_route",
    segments: [
      {
        segmentId: `segment_${canonicalJsonHash({
          requestFingerprint: input.quote.requestFingerprint,
          routeId: input.route.routeId,
        }).slice(0, 32)}`,
        providerId: "relay",
        adapterId: input.route.adapterId,
        adapterVersion: input.route.adapterVersion,
        source: input.quote.candidate.source,
        destination: input.quote.candidate.destination,
        amountMode: input.quote.candidate.amountMode,
      },
    ],
  };
}

export async function buildRelayPlanningQuote(
  input: Readonly<{
    codec: ReturnType<typeof createRelayReferenceCodec>;
    destination: ResolvedRouteDestination;
    policyRevision: string;
    profile: WalletExecutionProfile;
    quote: NormalizedRelayWalletQuote;
    quoteCorrelationId: string;
    route: FundingRuntimePolicy["routes"][number];
    serverExecutionProfileId?: string;
    persistentApprovalCapRaw?: string;
    source: RelayEligibleSourceFact;
    supportMetadata?: Readonly<Record<string, JsonValue>>;
  }>,
): Promise<RelayPlanningQuote> {
  if (input.source.source.kind !== "owned_location") {
    throw new Error("Relay operation requires an owned source location");
  }
  const sourceLocation = input.source.source.location;
  // A Deposit Wallet handoff is an explicit user-authorized transfer. Keep the
  // following Relay calls in the same client execution plan; server authority
  // starts only after the funds are in the controller wallet on a later plan.
  const useServerExecution = Boolean(
    input.serverExecutionProfileId && !input.source.preRouteHandoff,
  );
  const relaySteps = await validatedSteps({
    actions: input.quote.actions,
    minimumOutput: input.quote.candidate.minimumOutput,
    policyRevision: input.policyRevision,
    preserveActionBoundaries: useServerExecution,
    quoteCorrelationId: input.quoteCorrelationId,
    route: input.route,
    sourceAmount: input.quote.sourceAmount,
    profile: input.profile,
  });
  const clientSteps = buildPolymarketPreRouteHandoffSteps({
    source: input.source,
    sourceAmount: input.quote.sourceAmount,
    profile: input.profile,
    steps: relaySteps,
  });
  const steps =
    useServerExecution && input.serverExecutionProfileId
      ? relayDelegatedCommitSteps({
          steps: clientSteps,
          sourceAmount: input.quote.sourceAmount,
          profile: input.profile,
          serverExecutionProfileId: input.serverExecutionProfileId,
          ...(input.persistentApprovalCapRaw
            ? { persistentApprovalCapRaw: input.persistentApprovalCapRaw }
            : {}),
        })
      : clientSteps;
  const plan = {
    operation: {
      purpose: operationPurposeForExternalRecipient(
        input.destination.externalRecipientId,
      ),
      initialState: {
        status: "in_progress" as const,
        stage: "committed" as const,
      },
      experienceMode: input.route.experienceMode,
      planKind: "wallet_route" as const,
      sourceSnapshot: jsonRecord(input.source.source),
      destinationTargetSnapshot: jsonRecord(input.destination.target),
      externalRecipientId: input.destination.externalRecipientId,
      venueId: input.destination.venueId,
      marketId: null,
      marketContextSnapshot: null,
      venueBindingSnapshot: input.destination.venueBindingOption
        ? jsonRecord(input.destination.venueBindingOption)
        : null,
      walletExecutionSnapshot: jsonRecord(input.profile),
      placementSnapshot: {},
      requestedSourceAmount: jsonRecord(input.quote.sourceAmount),
      requestedDestinationAmount: jsonRecord(
        input.quote.candidate.minimumOutput,
      ),
      supportMetadata: {
        ...input.supportMetadata,
        routeId: input.route.routeId,
        requestFingerprint: input.quote.requestFingerprint,
        routeShape: input.quote.routeShape,
        ...(input.destination.target.kind === "owned_location" &&
        input.destination.spendability
          ? {
              destinationObservation: {
                observerId: input.route.destinationObserverId,
                locationId: input.destination.target.location.locationId,
                asset: jsonRecord(input.destination.target.location.asset),
                baselineRaw: input.destination.spendability.observedAmount.raw,
                baselineRevision: input.destination.spendability.revision,
                baselineAsOf: input.destination.spendability.asOf,
              },
            }
          : {}),
        ...(input.source.preRouteHandoff
          ? { preRouteHandoff: jsonRecord(input.source.preRouteHandoff) }
          : {}),
      },
    },
    segments: [
      {
        providerId: "relay",
        adapterId: input.route.adapterId,
        adapterVersion: input.route.adapterVersion,
        segmentKind: input.quote.candidate.capability,
        status: "planned" as const,
        sourceSnapshot: jsonRecord(input.source.source),
        destinationTargetSnapshot: jsonRecord(input.destination.target),
        quotedInput: jsonRecord(input.quote.sourceAmount),
        quotedExpectedOutput: jsonRecord(input.quote.candidate.expectedOutput),
        quotedMinOutput: jsonRecord(input.quote.candidate.minimumOutput),
        providerQuoteRefCiphertext: input.codec.encrypt(input.quote.requestId),
        providerQuoteRefLookupHmac: input.codec.fingerprint(
          input.quote.requestId,
        ),
        depositAddressCiphertext: null,
        depositAddressLookupHmac: null,
        lookupKeyVersion: input.codec.keyVersion,
        refundLocationSnapshot: jsonRecord(sourceLocation),
        quoteExpiresAt: input.quote.candidate.expiresAt,
        supportMetadata: {
          requestFingerprint: input.quote.requestFingerprint,
          routeShape: input.quote.routeShape,
        },
      },
    ],
    steps,
    reservations: [
      {
        segmentOrdinal: 0,
        componentId: input.source.componentId,
        locationId:
          input.source.reservationLocationId ?? sourceLocation.locationId,
        networkId: input.quote.sourceAmount.asset.networkId,
        assetId: input.quote.sourceAmount.asset.assetId,
        assetDecimals: input.quote.sourceAmount.asset.decimals,
        rawAmount: input.quote.sourceAmount.raw,
        mode: "subtract_available" as const,
        expiresAt: input.quote.candidate.expiresAt,
      },
    ],
  };
  return {
    candidate: input.quote.candidate,
    sourceAmount: input.quote.sourceAmount,
    sourceEstimatedUsd: input.quote.sourceEstimatedUsd,
    feeUsd: input.quote.feeUsd.map((estimated, index) => {
      const fee = input.quote.candidate.fees[index];
      return estimated ?? (fee ? stableUsdValue(fee.amount) : null);
    }),
    minimumDestinationEstimatedUsd: stableUsdValue(
      input.quote.candidate.minimumOutput,
    ),
    executionPlan: executionPlan({ quote: input.quote, route: input.route }),
    commitPlan: plan,
  };
}
