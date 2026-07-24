import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import { stableOpaqueId } from "../../account-value/canonical.js";
import { multiplyRawByUnitPrice } from "../../account-value/decimal.js";
import { env } from "../../env.js";
import { buildPolymarketFundingPlan } from "../../services/polymarket-funding-router.js";
import type {
  AssetLocation,
  AssetRef,
  JsonValue,
  SourceOption,
  WalletExecutionProfile,
} from "../domain/types.js";
import { resolveActionSponsorship } from "../execution/sponsorship-policy.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { sameAsset } from "../planner/money.js";
import type {
  FundingSourceAdapter,
  FundingSourcePlanningInput,
} from "../planner/source-adapter.js";
import type { PlannedSourceOption } from "../planner/planning-types.js";
import { buildPolymarketFundingFollowupAction } from "./polymarket-funding-followup.js";
import {
  parsePolymarketFundingEvidence,
  POLYMARKET_FUNDING_SOURCE_ADAPTER_ID,
} from "./polymarket-funding-snapshot.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

function jsonRecord(value: unknown): JsonRecord {
  return value as JsonRecord;
}

function detail(location: AssetLocation, key: string): string | null {
  const value = location.details[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function profileForExactWallet(input: {
  account: AccountValueReadModel;
  walletId: string;
  networkId: string;
  address: string;
}): WalletExecutionProfile | null {
  return (
    input.account.ownership?.wallets.find(
      (profile) =>
        profile.walletId === input.walletId &&
        profile.networkId === input.networkId &&
        profile.address.toLowerCase() === input.address.toLowerCase(),
    ) ?? null
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
        env.polymarketFundingRouterAddress?.trim() || null,
      usdceAsset: {
        networkId: "evm:137",
        assetId: env.polymarketUsdceAddress,
        decimals: 6,
      },
    },
  ) {}

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
        address?.toLowerCase() !== input.address.toLowerCase() ||
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
    const facts = input.destinationFacts;
    const snapshot = parsePolymarketFundingEvidence(
      facts?.sourcePlanningEvidence ?? null,
    );
    if (
      input.request.purpose === "withdrawal" ||
      facts?.option.venueId !== "polymarket" ||
      facts.target.kind !== "owned_location" ||
      !snapshot ||
      snapshot.routerAddress.toLowerCase() !==
        this.config.canonicalRouterAddress?.toLowerCase() ||
      !sameAsset(input.requiredAmount.asset, facts.option.requiredAsset) ||
      BigInt(input.requiredAmount.raw) <= 0n
    ) {
      return null;
    }
    const profile = profileForExactWallet({
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
    const depositAvailableRaw =
      BigInt(snapshot.depositPusdRaw) > BigInt(snapshot.depositLockedRaw)
        ? BigInt(snapshot.depositPusdRaw) - BigInt(snapshot.depositLockedRaw)
        : 0n;
    const plan = buildPolymarketFundingPlan({
      signer: snapshot.signerAddress,
      depositWallet: snapshot.depositWallet,
      routerAddress: snapshot.routerAddress,
      routerNonce: BigInt(snapshot.routerNonceRaw),
      requiredRaw: depositAvailableRaw + BigInt(input.requiredAmount.raw),
      depositPusdRaw: BigInt(snapshot.depositPusdRaw),
      depositLockedRaw: BigInt(snapshot.depositLockedRaw),
      depositUsdceRaw: BigInt(snapshot.depositUsdceRaw),
      depositRouterUsdceAllowanceRaw: BigInt(
        snapshot.depositRouterUsdceAllowanceRaw,
      ),
      signerPusdRaw: BigInt(snapshot.signerPusdRaw),
      signerLockedRaw: 0n,
      signerUsdceRaw: BigInt(snapshot.signerUsdceRaw),
      routerPusdAllowanceRaw: BigInt(snapshot.routerPusdAllowanceRaw),
      routerUsdceAllowanceRaw: BigInt(snapshot.routerUsdceAllowanceRaw),
      fundingCapRaw: BigInt(snapshot.fundingCapRaw),
    });
    if (
      !plan ||
      plan.totalAmountRaw !== input.requiredAmount.raw ||
      plan.routerNonce !== snapshot.routerNonceRaw
    ) {
      return null;
    }
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
      expectedDestination: input.requiredAmount,
      minimumDestination: input.requiredAmount,
      estimatedUsd: multiplyRawByUnitPrice({
        raw: input.requiredAmount.raw,
        decimals: input.requiredAmount.asset.decimals,
        unitPriceUsd: "1",
      }),
      fees: [],
      eta: { minSeconds: 5, maxSeconds: 90 },
      experienceMode: "prepare_first",
      requiredActions: [
        {
          kind: "evm_transaction",
          safeLabel: "Fund Polymarket Deposit Wallet",
          actor: "user",
          valueMoving: true,
          sponsorship:
            sponsorship.payerRequirement === "privy_sponsor"
              ? "requested"
              : "none",
        },
      ],
      expiresAt: facts.spendability.expiresAt,
      recommended: true,
      selectable: true,
      reasonCodes: [],
    };
    return {
      option,
      routeId: null,
      providerId: null,
      commitPlan: {
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
          requestedSourceAmount: null,
          requestedDestinationAmount: jsonRecord(input.requiredAmount),
          supportMetadata: {
            preparationKind: "polymarket_funding_router",
            adapterId: this.adapterId,
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
          {
            ordinal: 0,
            segmentOrdinal: null,
            stepKind: "venue_preparation",
            state: "action_required",
            actionFingerprint: canonicalJsonHash(action),
            executorId: "wallet_profile_evm_v1",
            payerRequirement: sponsorship.payerRequirement,
            dependsOnOrdinal: null,
            normalizedAction: jsonRecord(action),
            actionValidationResult: {
              valid: true,
              signerAddress: profile.address,
              canonicalRouterAddress: snapshot.routerAddress,
              expectedNonceRaw: plan.routerNonce,
              expectedTotalAmountRaw: plan.totalAmountRaw,
              fundingPlanHash: canonicalJsonHash(plan),
              sponsorshipPolicyId: sponsorship.policyId,
              signingMode: sponsorship.signingMode,
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
      },
    };
  }
}
