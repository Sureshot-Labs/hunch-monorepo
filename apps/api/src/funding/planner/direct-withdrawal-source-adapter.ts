import { scaleUnsignedDecimalByRawRatio } from "../../account-value/decimal.js";
import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import {
  stableOpaqueId,
  stableWalletAssetLocationIdentity,
} from "../../account-value/canonical.js";
import type { PoolClient } from "@hunch/infra";
import { buildPolymarketPreRouteHandoffSteps } from "../../funding-providers/relay/operation-plan.js";
import { sameAccountAddress, sameAsset } from "../domain/asset-identity.js";
import {
  SOLANA_NATIVE_ASSET,
  SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS,
} from "../domain/network-fees.js";
import type { AssetRef, JsonValue, SourceOption } from "../domain/types.js";
import {
  buildExactErc20WithdrawalAction,
  buildExactSolWithdrawalAction,
  DIRECT_WITHDRAWAL_ADAPTER_ID,
  DIRECT_WITHDRAWAL_PROVIDER_ID,
  DIRECT_WITHDRAWAL_ROUTE_ID,
} from "../execution/direct-withdrawal-transfer.js";
import { resolveActionSponsorship } from "../execution/sponsorship-policy.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type {
  FundingCommitPlan,
  FundingCommitStep,
} from "../persistence/funding-operation-repository.js";
import { isPositiveRawAmount } from "../domain/raw-amount.js";
import type { PlannedSourceOption } from "./planning-types.js";
import {
  productionFundingProfileHasNativeGas,
  resolveProductionOwnedSourceExecution,
} from "./production-source-planner.js";
import type {
  FundingSourceAdapter,
  FundingSourcePlanningInput,
} from "./source-adapter.js";

function jsonRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  return value as Readonly<Record<string, JsonValue>>;
}

function withdrawableRawForAsset(
  asset: AssetRef,
  availableRaw: bigint,
): bigint {
  return sameAsset(asset, SOLANA_NATIVE_ASSET)
    ? availableRaw > SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS
      ? availableRaw - SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS
      : 0n
    : availableRaw;
}

function exactAvailableComponent(
  account: AccountValueReadModel,
  input: FundingSourcePlanningInput,
) {
  const availableByComponent = new Map(
    account.cashAvailability.components.map((component) => [
      component.componentId,
      component,
    ]),
  );
  return account.projection.components.flatMap((component) => {
    const available = availableByComponent.get(component.componentId);
    const execution = resolveProductionOwnedSourceExecution({
      account,
      component,
      allowDepositWalletUsdceHandoff: true,
    });
    const availableRaw =
      available && isPositiveRawAmount(available.availableRaw)
        ? BigInt(available.availableRaw)
        : 0n;
    const withdrawableRaw = withdrawableRawForAsset(
      component.amount.asset,
      availableRaw,
    ).toString();
    if (
      component.location.accountId !== input.accountId ||
      component.category === "in_transit" ||
      component.observationFreshness !== "fresh" ||
      component.observationError ||
      !sameAsset(component.amount.asset, input.requiredAmount.asset) ||
      !available ||
      available.freshness !== "fresh" ||
      !isPositiveRawAmount(available.availableRaw) ||
      BigInt(withdrawableRaw) < BigInt(input.requiredAmount.raw) ||
      !execution ||
      (!execution.profile.signingModes.includes("web_client") &&
        !execution.profile.signingModes.includes("privy_authorization"))
    ) {
      return [];
    }
    return [{ component, available, execution, withdrawableRaw }];
  });
}

/**
 * Same-asset withdrawals are not provider quotes. They are exact ERC-20 or
 * native-SOL transfers from an owned executable wallet. A Polymarket Deposit
 * Wallet adds the existing exact relayer handoff to its controller first.
 */
export class DirectWithdrawalSourceAdapter implements FundingSourceAdapter {
  readonly adapterId = DIRECT_WITHDRAWAL_ADAPTER_ID;

  constructor(private readonly account: AccountValueReadModel) {}

  async list(
    input: FundingSourcePlanningInput,
  ): Promise<readonly PlannedSourceOption[]> {
    if (
      input.request.purpose !== "withdrawal" ||
      input.destination.target.kind !== "external_recipient" ||
      !input.destination.externalRecipientId ||
      !input.destination.recipientAddress ||
      (!input.requiredAmount.asset.networkId.startsWith("evm:") &&
        !sameAsset(input.requiredAmount.asset, SOLANA_NATIVE_ASSET)) ||
      !isPositiveRawAmount(input.requiredAmount.raw)
    ) {
      return [];
    }
    const selectionExpiresAt = new Date(
      Math.min(
        input.now.getTime() + input.policy.ttl.quoteMs,
        Date.parse(input.destination.target.recipient.expiresAt),
      ),
    ).toISOString();
    // This adapter has no provider quote. The short quote TTL only fences
    // source selection and commit. Once committed, the immutable exact-amount
    // transfer must remain executable after an optional Deposit Wallet ->
    // controller handoff; persistence still caps every action at 15 minutes.
    const executionExpiresAt = new Date(
      Date.parse(input.destination.target.recipient.expiresAt),
    ).toISOString();
    return exactAvailableComponent(this.account, input).flatMap(
      ({ component, execution, withdrawableRaw }): PlannedSourceOption[] => {
        const hasDepositWalletHandoff = execution.preRouteHandoff != null;
        const existingControllerComponent = hasDepositWalletHandoff
          ? this.account.projection.components.find((candidate) => {
              const address = candidate.location.details.address;
              return (
                candidate.location.kind === "wallet" &&
                typeof address === "string" &&
                sameAsset(candidate.amount.asset, input.requiredAmount.asset) &&
                sameAccountAddress(
                  input.requiredAmount.asset.networkId,
                  address,
                  execution.profile.address,
                )
              );
            })
          : null;
        const controllerCreditIdentity = hasDepositWalletHandoff
          ? existingControllerComponent
            ? {
                componentId: existingControllerComponent.componentId,
                locationId: existingControllerComponent.location.locationId,
              }
            : stableWalletAssetLocationIdentity({
                accountId: input.accountId,
                address: execution.profile.address,
                asset: input.requiredAmount.asset,
                balanceClass: "polymarket",
              })
          : null;
        const actionInput = {
          amount: input.requiredAmount,
          profile: execution.profile,
          recipient: {
            address: input.destination.recipientAddress as string,
            addressFingerprint:
              input.destination.target.kind === "external_recipient"
                ? input.destination.target.recipient.addressFingerprint
                : "",
          },
        };
        const built = sameAsset(input.requiredAmount.asset, SOLANA_NATIVE_ASSET)
          ? buildExactSolWithdrawalAction(actionInput)
          : buildExactErc20WithdrawalAction(actionInput);
        const sponsorship = resolveActionSponsorship({
          action: built.action,
          profile: execution.profile,
        });
        if (
          sponsorship.payerRequirement === "user" &&
          !productionFundingProfileHasNativeGas(this.account, execution.profile)
        ) {
          return [];
        }
        const transferStep: FundingCommitStep = {
          ordinal: 0,
          segmentOrdinal: 0,
          stepKind: "transaction",
          state: "action_required",
          actionFingerprint: canonicalJsonHash(built.action),
          executorId:
            built.action.kind === "svm_transaction"
              ? "wallet_profile_svm_v1"
              : "wallet_profile_evm_v1",
          payerRequirement: sponsorship.payerRequirement,
          dependsOnOrdinal: null,
          normalizedAction: jsonRecord(built.action),
          actionValidationResult: jsonRecord({
            ...built.validation,
            sponsorshipPolicyId: sponsorship.policyId,
            signingMode: sponsorship.signingMode,
          }),
          actionExpiresAt: executionExpiresAt,
        };
        const steps = buildPolymarketPreRouteHandoffSteps({
          source: { preRouteHandoff: execution.preRouteHandoff },
          sourceAmount: input.requiredAmount,
          profile: execution.profile,
          steps: [transferStep],
        });
        const source = {
          kind: "owned_location" as const,
          location: execution.executionLocation,
        };
        const estimatedUsd =
          component.estimatedUsd && BigInt(component.amount.raw) > 0n
            ? scaleUnsignedDecimalByRawRatio({
                value: component.estimatedUsd.value,
                numeratorRaw: input.requiredAmount.raw,
                denominatorRaw: component.amount.raw,
              })
            : null;
        const option: SourceOption = {
          sourceOptionId: stableOpaqueId(
            "source_option",
            canonicalJsonHash({
              adapterId: DIRECT_WITHDRAWAL_ADAPTER_ID,
              componentId: component.componentId,
              recipientId: input.destination.externalRecipientId,
              amount: input.requiredAmount,
            }),
          ),
          kind:
            component.location.kind === "venue_account"
              ? "venue_cash"
              : "wallet_asset",
          safeLabel:
            execution.safeLabel ??
            (execution.profile.source === "external"
              ? "Connected wallet"
              : "Hunch wallet"),
          source,
          amountMode: "exact_output",
          quotedSourceAmount: input.requiredAmount,
          maximumSourceRaw: withdrawableRaw,
          expectedDestination: input.requiredAmount,
          minimumDestination: input.requiredAmount,
          estimatedUsd,
          fees: [],
          eta: null,
          experienceMode: "prepare_first",
          requiredActions: steps.map((step) => ({
            kind:
              step.stepKind === "external_handoff"
                ? ("external_handoff" as const)
                : built.action.kind,
            safeLabel:
              step.stepKind === "external_handoff"
                ? "Move Polymarket funds to your controller wallet"
                : "Send funds to the withdrawal address",
            actor: "user" as const,
            valueMoving: true,
            sponsorship:
              step.payerRequirement === "privy_sponsor"
                ? ("requested" as const)
                : ("none" as const),
          })),
          expiresAt: selectionExpiresAt,
          recommended: false,
          selectable: true,
          reasonCodes: [],
        };
        const plan: FundingCommitPlan = {
          operation: {
            purpose: "withdrawal",
            initialState: { status: "in_progress", stage: "committed" },
            experienceMode: "prepare_first",
            planKind: "wallet_route",
            sourceSnapshot: jsonRecord(option),
            destinationTargetSnapshot: jsonRecord(input.destination.target),
            externalRecipientId: input.destination.externalRecipientId,
            venueId: null,
            marketId: null,
            marketContextSnapshot: null,
            venueBindingSnapshot: null,
            walletExecutionSnapshot: jsonRecord(execution.profile),
            placementSnapshot: jsonRecord(input.placement),
            requestedSourceAmount: jsonRecord(input.requiredAmount),
            requestedDestinationAmount: jsonRecord(input.requiredAmount),
            supportMetadata: {
              adapterId: DIRECT_WITHDRAWAL_ADAPTER_ID,
              routeId: DIRECT_WITHDRAWAL_ROUTE_ID,
              withdrawalExecutionKind: "exact_same_asset_transfer",
              sourceComponentId: component.componentId,
              sourceLocationId: component.location.locationId,
              executionWalletId: execution.profile.walletId,
              ...(execution.preRouteHandoff
                ? { preRouteHandoff: jsonRecord(execution.preRouteHandoff) }
                : {}),
            },
          },
          segments: [
            {
              providerId: DIRECT_WITHDRAWAL_PROVIDER_ID,
              adapterId: DIRECT_WITHDRAWAL_ADAPTER_ID,
              adapterVersion: 1,
              // `same_network_swap` is the persisted v1 name for an exact
              // same-network asset movement; this adapter performs no swap.
              segmentKind: "same_network_swap",
              status: "planned",
              sourceSnapshot: jsonRecord(source),
              destinationTargetSnapshot: jsonRecord(input.destination.target),
              quotedInput: jsonRecord(input.requiredAmount),
              quotedExpectedOutput: jsonRecord(input.requiredAmount),
              quotedMinOutput: jsonRecord(input.requiredAmount),
              providerQuoteRefCiphertext: null,
              providerQuoteRefLookupHmac: null,
              depositAddressCiphertext: null,
              depositAddressLookupHmac: null,
              lookupKeyVersion: 1,
              refundLocationSnapshot: jsonRecord(execution.executionLocation),
              quoteExpiresAt: executionExpiresAt,
              supportMetadata: {
                executionKind:
                  built.action.kind === "svm_transaction"
                    ? "exact_sol_transfer"
                    : "exact_erc20_transfer",
              },
            },
          ],
          steps,
          reservations: [
            {
              segmentOrdinal: 0,
              componentId: component.componentId,
              locationId: component.location.locationId,
              networkId: input.requiredAmount.asset.networkId,
              assetId: input.requiredAmount.asset.assetId,
              assetDecimals: input.requiredAmount.asset.decimals,
              rawAmount: input.requiredAmount.raw,
              mode: "subtract_available",
              expiresAt: executionExpiresAt,
            },
            ...(controllerCreditIdentity
              ? [
                  {
                    segmentOrdinal: null,
                    componentId: controllerCreditIdentity.componentId,
                    locationId: controllerCreditIdentity.locationId,
                    networkId: input.requiredAmount.asset.networkId,
                    assetId: input.requiredAmount.asset.assetId,
                    assetDecimals: input.requiredAmount.asset.decimals,
                    rawAmount: input.requiredAmount.raw,
                    mode: "subtract_available" as const,
                    expiresAt: executionExpiresAt,
                    // The exact handoff creates this same-asset controller
                    // balance after commit. Fence it without counting it as a
                    // second economic source for the withdrawal.
                    economicRole: "future_credit_fence" as const,
                  },
                ]
              : []),
          ],
        };
        return [
          {
            option,
            commitPlan: plan,
            routeId: DIRECT_WITHDRAWAL_ROUTE_ID,
            providerId: DIRECT_WITHDRAWAL_PROVIDER_ID,
            compositeEligible: false,
          },
        ];
      },
    );
  }

  async verifyCommit(
    _client: PoolClient,
    input: Readonly<{
      userId: string;
      operation: FundingCommitPlan["operation"];
    }>,
  ): Promise<void> {
    if (
      input.operation.supportMetadata?.adapterId !==
      DIRECT_WITHDRAWAL_ADAPTER_ID
    ) {
      return;
    }
    const amount = input.operation.requestedSourceAmount as Readonly<{
      asset?: Readonly<{
        networkId?: unknown;
        assetId?: unknown;
        decimals?: unknown;
      }>;
      raw?: unknown;
    }> | null;
    const componentId = input.operation.supportMetadata.sourceComponentId;
    const sourceLocationId = input.operation.supportMetadata.sourceLocationId;
    const executionWalletId = input.operation.supportMetadata.executionWalletId;
    if (
      input.operation.purpose !== "withdrawal" ||
      typeof componentId !== "string" ||
      typeof sourceLocationId !== "string" ||
      typeof executionWalletId !== "string" ||
      typeof amount?.asset?.networkId !== "string" ||
      typeof amount.asset.assetId !== "string" ||
      typeof amount.asset.decimals !== "number" ||
      !isPositiveRawAmount(amount.raw)
    ) {
      throw new Error("direct withdrawal frozen source is invalid");
    }
    const frozenAsset = {
      networkId: amount.asset.networkId,
      assetId: amount.asset.assetId,
      decimals: amount.asset.decimals,
    };
    const frozenRaw = amount.raw;
    const component = this.account.projection.components.find(
      (candidate) =>
        candidate.componentId === componentId &&
        candidate.location.locationId === sourceLocationId &&
        candidate.location.accountId === input.userId &&
        sameAsset(candidate.amount.asset, frozenAsset),
    );
    const available = this.account.cashAvailability.components.find(
      (candidate) => candidate.componentId === componentId,
    );
    const execution = component
      ? resolveProductionOwnedSourceExecution({
          account: this.account,
          component,
          allowDepositWalletUsdceHandoff: true,
        })
      : null;
    if (
      !component ||
      component.observationFreshness !== "fresh" ||
      component.observationError ||
      !available ||
      available.freshness !== "fresh" ||
      !isPositiveRawAmount(available.availableRaw) ||
      withdrawableRawForAsset(frozenAsset, BigInt(available.availableRaw)) <
        BigInt(frozenRaw) ||
      execution?.profile.walletId !== executionWalletId
    ) {
      throw new Error("direct withdrawal source is no longer available");
    }
  }
}
