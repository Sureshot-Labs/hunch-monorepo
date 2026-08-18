import type { PoolClient } from "@hunch/infra";
import { Interface } from "ethers";

import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import { stableOpaqueId } from "../../account-value/canonical.js";
import {
  multiplyRawByUnitPrice,
  rawForUsdCeil,
} from "../../account-value/decimal.js";
import {
  buildPolymarketFundingPlan,
  buildMaximumPolymarketFundingPlan,
  PolymarketFundingPlanError,
} from "../../services/polymarket-funding-router.js";
import type {
  AssetLocation,
  AssetRef,
  FundingPurpose,
  JsonValue,
  SourceOption,
} from "../domain/types.js";
import { resolveActionSponsorship } from "../execution/sponsorship-policy.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";
import { sameAccountAddress } from "../domain/asset-identity.js";
import { sameAsset } from "../planner/money.js";
import { minimumAutomaticTradeRefillUsd } from "../planner/placement-policy.js";
import { POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW } from "../../services/polymarket-automation-policy.js";
import {
  findExactFundingWalletProfile,
  type FundingSourceAdapter,
  type FundingSourcePlanningInput,
} from "../planner/source-adapter.js";
import {
  isPolymarketDepositRouterProfileId,
  POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
} from "../execution/delegated-funding-profile-ids.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";
import {
  commitPlanRunsWithoutUserWalletAction,
  type PlannedSourceOption,
} from "../planner/planning-types.js";
import {
  buildExactPolymarketDepositUsdceWrapPlan,
  buildPolymarketFundingActionValidation,
  buildPolymarketFundingFollowupAction,
} from "./polymarket-funding-followup.js";
import {
  parsePolymarketFundingEvidence,
  POLYMARKET_FUNDING_SOURCE_ADAPTER_ID,
} from "./polymarket-funding-snapshot.js";
import { lockPolymarketFundingOperationPredecessor } from "./polymarket-funding-commit-guard.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

const ERC20_APPROVAL = new Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
]);

function jsonRecord(value: unknown): JsonRecord {
  return value as JsonRecord;
}

function detail(location: AssetLocation, key: string): string | null {
  const value = location.details[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function supportsExactOutputVenuePreparation(purpose: FundingPurpose): boolean {
  switch (purpose) {
    case "add_funds":
    case "trade_shortfall":
    case "manual_rebalance":
      return true;
    case "convert_asset":
    case "withdrawal":
      return false;
  }
}

function minimumAutomaticRelayDestinationRaw(
  input: FundingSourcePlanningInput,
): bigint | null {
  const unitPriceUsd =
    input.destinationFacts?.collateralValuation?.unitPriceUsd;
  if (!unitPriceUsd) return null;
  return BigInt(
    rawForUsdCeil({
      usd: minimumAutomaticTradeRefillUsd(input.policy),
      decimals: input.requiredAmount.asset.decimals,
      unitPriceUsd,
    }),
  );
}

export class PolymarketFundingSourceAdapter implements FundingSourceAdapter {
  readonly adapterId = POLYMARKET_FUNDING_SOURCE_ADAPTER_ID;

  constructor(
    private readonly account: AccountValueReadModel,
    private readonly config: Readonly<{
      canonicalRouterAddress: string | null;
      usdceAsset: AssetRef;
    }> = {
      canonicalRouterAddress:
        fundingSidecarRuntimeConfig.polymarketFundingRouterAddress || null,
      usdceAsset: {
        networkId: "evm:137",
        assetId: fundingSidecarRuntimeConfig.polymarketUsdceAddress,
        decimals: 6,
      },
    },
  ) {}

  async verifyCommit(
    client: PoolClient,
    input: Readonly<{
      userId: string;
      operation: FundingCommitPlan["operation"];
    }>,
  ): Promise<void> {
    if (
      input.operation.supportMetadata?.preparationKind !==
      "polymarket_funding_router"
    ) {
      return;
    }
    const metadataBinding =
      input.operation.supportMetadata?.venueBindingOptionId;
    const snapshotBinding =
      input.operation.venueBindingSnapshot?.venueBindingOptionId;
    const venueBindingOptionId =
      typeof metadataBinding === "string" && metadataBinding.trim()
        ? metadataBinding
        : typeof snapshotBinding === "string" && snapshotBinding.trim()
          ? snapshotBinding
          : "";
    await lockPolymarketFundingOperationPredecessor(client, {
      userId: input.userId,
      venueBindingOptionId,
    });
  }

  async list(
    input: FundingSourcePlanningInput,
  ): Promise<readonly PlannedSourceOption[]> {
    const option = await this.build(input);
    return option ? [option] : [];
  }

  private exactInputComponent(input: {
    accountId: string;
    address: string;
    asset: AssetRef;
    rawAmount: string;
  }): Readonly<{
    component: AccountValueReadModel["projection"]["components"][number];
    availableRaw: string;
  }> | null {
    if (input.rawAmount === "0") return null;
    const availabilityByComponent = new Map(
      this.account.cashAvailability.components.map((component) => [
        component.componentId,
        component,
      ]),
    );
    const matches = this.account.projection.components.flatMap((component) => {
      const availability = availabilityByComponent.get(component.componentId);
      const address = detail(component.location, "address");
      if (
        component.location.accountId !== input.accountId ||
        component.category === "in_transit" ||
        component.observationFreshness !== "fresh" ||
        component.observationError ||
        component.valuationEligibility !== "included" ||
        !sameAsset(component.amount.asset, input.asset) ||
        !address ||
        !sameAccountAddress(input.asset.networkId, address, input.address) ||
        !availability ||
        availability.freshness !== "fresh" ||
        BigInt(availability.availableRaw) < BigInt(input.rawAmount)
      ) {
        return [];
      }
      return [{ component, availableRaw: availability.availableRaw }];
    });
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  private async build(
    input: FundingSourcePlanningInput,
  ): Promise<PlannedSourceOption | null> {
    // A server execution profile is a single, exact authority envelope.
    // In particular, do not contribute a partial local preparation while a
    // Relay profile is being evaluated: doing so would turn the otherwise
    // viable Relay source into a residual-only composite candidate.
    if (
      input.request.serverExecutionProfileId != null &&
      !isPolymarketDepositRouterProfileId(
        input.request.serverExecutionProfileId,
      )
    ) {
      return null;
    }
    const facts = input.destinationFacts;
    const snapshot = parsePolymarketFundingEvidence(
      facts?.sourcePlanningEvidence ?? null,
    );
    if (
      !supportsExactOutputVenuePreparation(input.request.purpose) ||
      facts?.option.venueId !== "polymarket" ||
      facts.target.kind !== "owned_location" ||
      !facts.collateralValuation ||
      !snapshot ||
      !this.config.canonicalRouterAddress ||
      !sameAccountAddress(
        "evm:137",
        snapshot.routerAddress,
        this.config.canonicalRouterAddress,
      ) ||
      !sameAsset(input.requiredAmount.asset, facts.option.requiredAsset) ||
      BigInt(input.requiredAmount.raw) <= 0n
    ) {
      return null;
    }
    const profile = findExactFundingWalletProfile({
      account: this.account,
      walletId: facts.venueBinding.executionWalletId,
      networkId: "evm:137",
      address: snapshot.signerAddress,
    });
    if (
      !profile ||
      (!profile.signingModes.includes("web_client") &&
        !profile.signingModes.includes("privy_authorization"))
    ) {
      return null;
    }
    const buildPlan = (
      maximumFundingRaw: bigint,
      routerPusdAllowanceRaw = BigInt(snapshot.routerPusdAllowanceRaw),
    ) =>
      buildMaximumPolymarketFundingPlan({
        signer: snapshot.signerAddress,
        depositWallet: snapshot.depositWallet,
        routerAddress: snapshot.routerAddress,
        routerNonce: BigInt(snapshot.routerNonceRaw),
        maximumFundingRaw,
        depositPusdRaw: BigInt(snapshot.depositPusdRaw),
        depositLockedRaw: BigInt(snapshot.depositLockedRaw),
        depositUsdceRaw: BigInt(snapshot.depositUsdceRaw),
        depositRouterUsdceAllowanceRaw: BigInt(
          snapshot.depositRouterUsdceAllowanceRaw,
        ),
        signerPusdRaw: BigInt(snapshot.signerPusdRaw),
        signerLockedRaw: 0n,
        signerUsdceRaw: BigInt(snapshot.signerUsdceRaw),
        routerPusdAllowanceRaw,
        routerUsdceAllowanceRaw: BigInt(snapshot.routerUsdceAllowanceRaw),
        fundingCapRaw: BigInt(snapshot.fundingCapRaw),
      });
    const requiredRaw = BigInt(input.requiredAmount.raw);
    const delegatedWrap =
      input.request.serverExecutionProfileId ===
      POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID;
    const delegatedPusdFund =
      input.request.serverExecutionProfileId ===
      POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID;
    let plan;
    try {
      plan = delegatedWrap
        ? buildExactPolymarketDepositUsdceWrapPlan({
            receiptRaw: input.requiredAmount.raw,
            snapshot,
          })
        : delegatedPusdFund
          ? buildPolymarketFundingPlan({
              signer: snapshot.signerAddress,
              depositWallet: snapshot.depositWallet,
              routerAddress: snapshot.routerAddress,
              routerNonce: BigInt(snapshot.routerNonceRaw),
              requiredRaw,
              // The pUSD profile has one exact authority envelope.  It must
              // never silently absorb USDC.e into a pUSD-only Router call.
              depositPusdRaw: 0n,
              depositLockedRaw: 0n,
              depositUsdceRaw: 0n,
              depositRouterUsdceAllowanceRaw: 0n,
              signerPusdRaw: BigInt(snapshot.signerPusdRaw),
              signerLockedRaw: 0n,
              signerUsdceRaw: 0n,
              routerPusdAllowanceRaw:
                POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW,
              routerUsdceAllowanceRaw: 0n,
              fundingCapRaw: BigInt(snapshot.fundingCapRaw),
            })
          : buildPlan(requiredRaw);
      if (!delegatedWrap && plan && BigInt(plan.totalAmountRaw) < requiredRaw) {
        const minimumRelayRaw = minimumAutomaticRelayDestinationRaw(input);
        if (minimumRelayRaw == null) return null;
        const maximumPreparationRaw =
          requiredRaw > minimumRelayRaw ? requiredRaw - minimumRelayRaw : 0n;
        plan =
          maximumPreparationRaw > 0n ? buildPlan(maximumPreparationRaw) : null;
      }
    } catch (error) {
      // A stale/missing balance, cap, or allowance makes this exact source
      // unavailable; it must not abort discovery of independent sources such
      // as direct external ingress.
      if (error instanceof PolymarketFundingPlanError) return null;
      throw error;
    }
    if (!plan || plan.routerNonce !== snapshot.routerNonceRaw) {
      return null;
    }
    const plannedDestinationAmount = {
      asset: input.requiredAmount.asset,
      raw: plan.totalAmountRaw,
    };
    const fullyFunded = plan.totalAmountRaw === input.requiredAmount.raw;
    if (
      delegatedPusdFund &&
      (plan.pUsdAmountRaw !== input.requiredAmount.raw ||
        plan.depositUsdceAmountRaw !== "0" ||
        plan.signerUsdceAmountRaw !== "0")
    ) {
      return null;
    }
    const requiresPusdApproval =
      delegatedPusdFund &&
      BigInt(snapshot.routerPusdAllowanceRaw) < BigInt(plan.pUsdAmountRaw);
    const usdceAsset = this.config.usdceAsset;
    const exactInputs = [
      {
        address: snapshot.depositWallet,
        asset: usdceAsset,
        rawAmount: plan.depositUsdceAmountRaw,
      },
      {
        address: snapshot.signerAddress,
        asset: facts.option.requiredAsset,
        rawAmount: plan.pUsdAmountRaw,
      },
      {
        address: snapshot.signerAddress,
        asset: usdceAsset,
        rawAmount: plan.signerUsdceAmountRaw,
      },
    ].filter((entry) => entry.rawAmount !== "0");
    const attemptedInputs = exactInputs.map((entry) => ({
      ...entry,
      resolved: this.exactInputComponent({
        accountId: input.accountId,
        ...entry,
      }),
    }));
    const resolvedInputs = attemptedInputs.flatMap((entry) =>
      entry.resolved ? [{ ...entry, resolved: entry.resolved }] : [],
    );
    if (
      resolvedInputs.length === 0 ||
      resolvedInputs.length !== attemptedInputs.length
    ) {
      return null;
    }
    const quoteCorrelationId = stableOpaqueId(
      "funding_quote",
      canonicalJsonHash({
        accountId: input.accountId,
        adapterId: this.adapterId,
        destinationOptionId: facts.option.destinationOptionId,
        fundingPlan: plan,
        policyRevision: input.policyRevision,
        requiredAmount: input.requiredAmount,
      }),
    );
    const action = buildPolymarketFundingFollowupAction({
      binding: facts.venueBinding,
      canonicalRouterAddress: snapshot.routerAddress,
      inspectionRevision: facts.bindingOption.inspectionRevision,
      operationId: quoteCorrelationId,
      plan,
    });
    if (action.kind !== "evm_transaction") return null;
    const approvalAction = requiresPusdApproval
      ? (() => {
          const approval = {
            kind: "evm_transaction" as const,
            networkId: "evm:137",
            senderWalletId: action.senderWalletId,
            to: facts.option.requiredAsset.assetId,
            data: ERC20_APPROVAL.encodeFunctionData("approve", [
              snapshot.routerAddress,
              POLYMARKET_FUNDING_ROUTER_MAX_APPROVAL_RAW,
            ]),
            valueRaw: "0",
            gasLimitRaw: null,
          };
          return {
            ...approval,
            actionId: `action_${canonicalJsonHash({
              approval,
              operationId: quoteCorrelationId,
            }).slice(0, 32)}`,
          };
        })()
      : null;
    const sponsorship = resolveActionSponsorship({ action, profile });
    const source = {
      kind: "venue_preparation" as const,
      venueId: "polymarket",
      venueBindingId: facts.venueBinding.bindingId,
      inputCount: resolvedInputs.length,
    };
    const option: SourceOption = {
      sourceOptionId: stableOpaqueId(
        "source",
        canonicalJsonHash({ quoteCorrelationId, actionId: action.actionId }),
      ),
      kind: "venue_preparation",
      safeLabel: "Prepare Polymarket Deposit Wallet funds",
      source,
      amountMode: "exact_output",
      maximumSourceRaw: plan.totalAmountRaw,
      expectedDestination: plannedDestinationAmount,
      minimumDestination: plannedDestinationAmount,
      estimatedUsd: multiplyRawByUnitPrice({
        raw: plannedDestinationAmount.raw,
        decimals: input.requiredAmount.asset.decimals,
        unitPriceUsd: facts.collateralValuation.unitPriceUsd,
      }),
      fees: [],
      eta: { minSeconds: 5, maxSeconds: 90 },
      experienceMode: "prepare_first",
      requiredActions: [
        ...(approvalAction
          ? [
              {
                kind: "evm_transaction" as const,
                safeLabel: "Approve Polymarket Funding Router",
                actor: "server" as const,
                valueMoving: false,
                sponsorship: "requested" as const,
              },
            ]
          : []),
        {
          kind: "evm_transaction",
          safeLabel: "Fund Polymarket Deposit Wallet",
          actor: delegatedWrap || delegatedPusdFund ? "server" : "user",
          valueMoving: true,
          sponsorship:
            sponsorship.payerRequirement === "privy_sponsor"
              ? "requested"
              : "none",
        },
      ],
      expiresAt: facts.spendability.expiresAt,
      recommended: fullyFunded,
      selectable: fullyFunded,
      reasonCodes: fullyFunded ? [] : ["minimum_output_not_met"],
    };
    const commitPlan: PlannedSourceOption["commitPlan"] = {
      operation: {
        purpose: input.request.purpose,
        initialState: {
          status: "in_progress",
          stage: "committed",
        },
        experienceMode: "prepare_first",
        planKind: "venue_preparation",
        sourceSnapshot: jsonRecord(option),
        destinationTargetSnapshot: jsonRecord(input.destination.target),
        externalRecipientId: null,
        venueId: "polymarket",
        marketId: input.marketContext?.marketId ?? null,
        marketContextSnapshot: input.marketContext
          ? jsonRecord(input.marketContext)
          : null,
        venueBindingSnapshot: jsonRecord(facts.venueBinding),
        walletExecutionSnapshot: jsonRecord(profile),
        placementSnapshot: jsonRecord(input.placement),
        requestedSourceAmount:
          delegatedWrap || delegatedPusdFund
            ? jsonRecord({
                asset: delegatedWrap ? usdceAsset : facts.option.requiredAsset,
                raw: plan.totalAmountRaw,
              })
            : null,
        requestedDestinationAmount: jsonRecord(plannedDestinationAmount),
        supportMetadata: {
          preparationKind: "polymarket_funding_router",
          adapterId: this.adapterId,
          venueBindingOptionId: facts.bindingOption.venueBindingOptionId,
          fundingPlan: jsonRecord(plan),
          before: {
            routerNonceRaw: snapshot.routerNonceRaw,
            depositPusdRaw: snapshot.depositPusdRaw,
            clobPusdRaw: snapshot.clobPusdRaw,
            observedAt: snapshot.observedAt,
          },
        },
      },
      segments: [],
      steps: [
        ...(approvalAction
          ? [
              {
                ordinal: 0,
                segmentOrdinal: null,
                // This is an ERC-20 approval, not the Router's destination
                // preparation. Its canonical receipt must therefore satisfy
                // the dependency and unlock the following `fund` step.
                stepKind: "transaction" as const,
                state: "planned" as const,
                actionFingerprint: canonicalJsonHash(approvalAction),
                executorId: POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
                payerRequirement: "privy_sponsor" as const,
                dependsOnOrdinal: null,
                normalizedAction: jsonRecord(approvalAction),
                actionExpiresAt: null,
                actionValidationResult: {
                  kind: "controller_pusd_router_approval",
                  routerAddress: snapshot.routerAddress,
                },
              },
            ]
          : []),
        {
          ordinal: approvalAction ? 1 : 0,
          segmentOrdinal: null,
          stepKind: "venue_preparation",
          state:
            delegatedWrap || delegatedPusdFund ? "planned" : "action_required",
          actionFingerprint: canonicalJsonHash(action),
          executorId:
            delegatedWrap || delegatedPusdFund
              ? input.request.serverExecutionProfileId
              : "wallet_profile_evm_v1",
          payerRequirement: sponsorship.payerRequirement,
          dependsOnOrdinal: approvalAction ? 0 : null,
          normalizedAction: jsonRecord(action),
          ...(delegatedWrap || delegatedPusdFund
            ? { actionExpiresAt: null }
            : {}),
          actionValidationResult: {
            ...buildPolymarketFundingActionValidation({
              destinationAssetId:
                facts.venueBinding.settlementLocation.asset.assetId,
              plan,
              profileAddress: profile.address,
              routerAddress: snapshot.routerAddress,
              sponsorship,
            }),
            ...(delegatedWrap ? { activation: "after_verified_ingress" } : {}),
          },
        },
      ],
      reservations: resolvedInputs.map((entry) => {
        return {
          segmentOrdinal: null,
          componentId: entry.resolved.component.componentId,
          locationId: entry.resolved.component.location.locationId,
          networkId: entry.asset.networkId,
          assetId: entry.asset.assetId,
          assetDecimals: entry.asset.decimals,
          rawAmount: entry.rawAmount,
          mode: "subtract_available" as const,
          expiresAt: facts.spendability.expiresAt,
        };
      }),
    };
    return {
      option,
      routeId: null,
      providerId: null,
      commitPlan,
      compositeEligible:
        !fullyFunded && commitPlanRunsWithoutUserWalletAction(commitPlan),
    };
  }
}
