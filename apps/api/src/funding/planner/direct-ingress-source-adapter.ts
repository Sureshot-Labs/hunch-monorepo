import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import { multiplyRawByUnitPrice } from "../../account-value/decimal.js";
import { stableOpaqueId } from "../../account-value/canonical.js";
import {
  buildPolymarketFundingPlan,
  PolymarketFundingPlanError,
} from "../../services/polymarket-funding-router.js";
import {
  isRelayPinnedStableAsset,
  RELAY_PINNED_ASSETS,
} from "../../funding-providers/relay/mappings.js";
import type {
  AssetLocation,
  AssetRef,
  ExternalIngressInstruction,
  JsonValue,
  SourceOption,
  WalletExecutionProfile,
} from "../domain/types.js";
import {
  canonicalAccountAddress,
  canonicalAssetKey,
  sameAccountAddress,
} from "../domain/asset-identity.js";
import { resolveActionSponsorship } from "../execution/sponsorship-policy.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import { fundingReceiveAssetEnabled } from "../policies/funding-policy-v2.js";
import type {
  FundingCommitPlan,
  FundingCommitReservation,
} from "../persistence/funding-operation-repository.js";
import { buildPolymarketFundingFollowupAction } from "../preparation/polymarket-funding-followup.js";
import { parsePolymarketFundingEvidence } from "../preparation/polymarket-funding-snapshot.js";
import type {
  FundingSourceAdapter,
  FundingSourcePlanningInput,
} from "./source-adapter.js";
import type { PlannedSourceOption } from "./planning-types.js";
import { buildFundingReceiveTargets } from "./receive-targets.js";
import { sameAsset } from "./money.js";
import { supportsCanonicalFundingReceiveEvents } from "../receive/canonical-receive-capabilities.js";
import { fundingSidecarRuntimeConfig } from "../runtime/sidecar-runtime-config.js";

function jsonRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  return value as Readonly<Record<string, JsonValue>>;
}

function detail(input: FundingSourcePlanningInput, key: string): string | null {
  if (input.destination.target.kind !== "owned_location") return null;
  return locationDetail(input.destination.target.location, key);
}

function locationDetail(location: AssetLocation, key: string): string | null {
  const value = location.details[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function exactDestinationPolicy(input: FundingSourcePlanningInput) {
  return input.policy.locations.find(
    (location) =>
      location.enabled &&
      location.observable &&
      location.ownership === "owned" &&
      location.capabilities.includes("venue_settlement") &&
      location.locationPatternId ===
        input.destination.destinationLocationPatternId &&
      sameAsset(location.asset, input.requiredAmount.asset),
  );
}

type DirectIngressVariant = Readonly<{
  variantId: string;
  networkId: string;
  asset: AssetRef;
  destinationAddress: string;
  destinationLocationId: string;
  baselineRaw: string;
  baselineRevision: string;
  observation: Readonly<{
    adapterId: string;
    payload: Readonly<Record<string, JsonValue>>;
  }>;
  completion:
    | Readonly<{ kind: "direct_destination_credit" }>
    | Readonly<{ kind: "child_funding_operation" }>
    | Readonly<{
        kind: "committed_venue_preparation";
        stepOrdinal: number;
      }>;
}>;

type DirectIngressCompletion = Readonly<{
  variants: readonly DirectIngressVariant[];
  step: FundingCommitPlan["steps"][number];
  walletExecutionSnapshot: Readonly<Record<string, JsonValue>>;
  supportMetadata: Readonly<Record<string, JsonValue>>;
}>;

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
        sameAccountAddress(input.networkId, profile.address, input.address),
    ) ?? null
  );
}

function exactIngressVariant(
  input: FundingSourcePlanningInput,
): DirectIngressVariant {
  if (input.destination.target.kind !== "owned_location") {
    throw new Error("direct ingress requires an owned destination");
  }
  const destinationAddress = detail(input, "address");
  if (!destinationAddress || !input.destinationFacts) {
    throw new Error("direct ingress requires an observable destination");
  }
  return {
    variantId: stableOpaqueId(
      "ingress_variant",
      canonicalJsonHash({
        destinationAddress: canonicalAccountAddress(
          input.requiredAmount.asset.networkId,
          destinationAddress,
        ),
        asset: input.requiredAmount.asset,
        completion: "direct_destination_credit",
      }),
    ),
    networkId: input.requiredAmount.asset.networkId,
    asset: input.requiredAmount.asset,
    destinationAddress,
    destinationLocationId: input.destination.target.location.locationId,
    baselineRaw: input.destinationFacts.spendability.observedAmount.raw,
    baselineRevision: input.destinationFacts.spendability.revision,
    observation: {
      adapterId: "owned_destination_spendability_v1",
      payload: {},
    },
    completion: { kind: "direct_destination_credit" },
  };
}

function buildPolymarketIngressCompletion(input: {
  account: AccountValueReadModel;
  planning: FundingSourcePlanningInput;
  canonicalRouterAddress: string | null;
  usdceAsset: AssetRef;
}): DirectIngressCompletion | null {
  const facts = input.planning.destinationFacts;
  const usdcePolicy = input.planning.policy.assets.find((candidate) =>
    sameAsset(candidate.asset, input.usdceAsset),
  );
  const snapshot = parsePolymarketFundingEvidence(
    facts?.sourcePlanningEvidence ?? null,
  );
  const destinationAddress = detail(input.planning, "address");
  if (
    facts?.option.venueId !== "polymarket" ||
    facts.target.kind !== "owned_location" ||
    !snapshot ||
    !destinationAddress ||
    !sameAccountAddress(
      "evm:137",
      destinationAddress,
      snapshot.depositWallet,
    ) ||
    !input.canonicalRouterAddress ||
    !sameAccountAddress(
      "evm:137",
      snapshot.routerAddress,
      input.canonicalRouterAddress,
    ) ||
    !sameAsset(
      input.planning.requiredAmount.asset,
      facts.option.requiredAsset,
    ) ||
    input.planning.requiredAmount.asset.networkId !== "evm:137" ||
    input.usdceAsset.networkId !== "evm:137" ||
    input.usdceAsset.decimals !==
      input.planning.requiredAmount.asset.decimals ||
    !input.planning.policy.automation.stagedContinuation ||
    !usdcePolicy?.enabled ||
    !usdcePolicy.observationEnabled ||
    BigInt(input.planning.requiredAmount.raw) <= 0n
  ) {
    return null;
  }
  const profile = profileForExactWallet({
    account: input.account,
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
  let plan;
  try {
    plan = buildPolymarketFundingPlan({
      signer: snapshot.signerAddress,
      depositWallet: snapshot.depositWallet,
      routerAddress: snapshot.routerAddress,
      routerNonce: BigInt(snapshot.routerNonceRaw),
      requiredRaw:
        depositAvailableRaw + BigInt(input.planning.requiredAmount.raw),
      depositPusdRaw: BigInt(snapshot.depositPusdRaw),
      depositLockedRaw: BigInt(snapshot.depositLockedRaw),
      // This branch is frozen against the amount this operation is waiting
      // to receive. Existing USDC.e is intentionally not swept.
      depositUsdceRaw: BigInt(input.planning.requiredAmount.raw),
      depositRouterUsdceAllowanceRaw: BigInt(
        snapshot.depositRouterUsdceAllowanceRaw,
      ),
      signerPusdRaw: 0n,
      signerLockedRaw: 0n,
      signerUsdceRaw: 0n,
      routerPusdAllowanceRaw: 0n,
      routerUsdceAllowanceRaw: 0n,
      // The external ingress operation is already frozen to the exact amount
      // the user confirmed. Bound this follow-up to that amount instead of a
      // delegated bot-buy policy cap; the router allowance is checked
      // independently above.
      fundingCapRaw: BigInt(input.planning.requiredAmount.raw),
    });
  } catch (error) {
    if (error instanceof PolymarketFundingPlanError) return null;
    throw error;
  }
  if (
    !plan ||
    plan.totalAmountRaw !== input.planning.requiredAmount.raw ||
    plan.depositUsdceAmountRaw !== input.planning.requiredAmount.raw ||
    plan.pUsdAmountRaw !== "0" ||
    plan.signerUsdceAmountRaw !== "0"
  ) {
    return null;
  }
  const quoteCorrelationId = stableOpaqueId(
    "funding_quote",
    canonicalJsonHash({
      accountId: input.planning.accountId,
      adapterId: "direct_owned_multi_asset_receive_v1",
      destinationOptionId: facts.option.destinationOptionId,
      fundingPlan: plan,
      policyRevision: input.planning.policyRevision,
      requiredAmount: input.planning.requiredAmount,
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
  const baselineRevision = canonicalJsonHash({
    schema: "polymarket_ingress_baseline_v1",
    snapshot,
  });
  const common = {
    networkId: "evm:137",
    destinationAddress: snapshot.depositWallet,
    destinationLocationId: facts.target.location.locationId,
    baselineRevision,
  } as const;
  const variants: readonly DirectIngressVariant[] = [
    {
      ...common,
      variantId: stableOpaqueId(
        "ingress_variant",
        canonicalJsonHash({
          destinationAddress: snapshot.depositWallet.toLowerCase(),
          asset: input.planning.requiredAmount.asset,
          completion: "direct_destination_credit",
        }),
      ),
      asset: input.planning.requiredAmount.asset,
      baselineRaw: snapshot.depositPusdRaw,
      observation: {
        adapterId: "polymarket_deposit_wallet_assets_v1",
        payload: { field: "depositPusdRaw" },
      },
      completion: { kind: "direct_destination_credit" },
    },
    {
      ...common,
      variantId: stableOpaqueId(
        "ingress_variant",
        canonicalJsonHash({
          destinationAddress: snapshot.depositWallet.toLowerCase(),
          asset: input.usdceAsset,
          completion: "committed_venue_preparation",
        }),
      ),
      asset: input.usdceAsset,
      baselineRaw: snapshot.depositUsdceRaw,
      observation: {
        adapterId: "polymarket_deposit_wallet_assets_v1",
        payload: { field: "depositUsdceRaw" },
      },
      completion: {
        kind: "committed_venue_preparation",
        stepOrdinal: 0,
      },
    },
  ];
  return {
    variants,
    step: {
      ordinal: 0,
      segmentOrdinal: null,
      stepKind: "venue_preparation",
      state: "planned",
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
        activation: "after_verified_ingress",
      },
    },
    walletExecutionSnapshot: jsonRecord(profile),
    supportMetadata: {
      preparationKind: "polymarket_funding_router",
      venueBinding: jsonRecord(facts.venueBinding),
      fundingPlan: jsonRecord(plan),
      before: {
        routerNonceRaw: snapshot.routerNonceRaw,
        depositPusdRaw: snapshot.depositPusdRaw,
        clobPusdRaw: snapshot.clobPusdRaw,
        observedAt: snapshot.observedAt,
      },
    },
  };
}

function isNativeSolAsset(asset: AssetRef): boolean {
  return (
    asset.networkId === "solana:mainnet" &&
    asset.assetId === RELAY_PINNED_ASSETS.solanaNative &&
    asset.decimals === 9
  );
}

function buildRoutedReceiveVariants(input: {
  account: AccountValueReadModel;
  planning: FundingSourcePlanningInput;
  existing: readonly DirectIngressVariant[];
}): readonly DirectIngressVariant[] {
  if (
    !input.planning.policy.automation.stagedContinuation ||
    !isRelayPinnedStableAsset(input.planning.requiredAmount.asset)
  ) {
    return [];
  }
  const existing = new Set(
    input.existing.map(
      (variant) =>
        `${canonicalAssetKey(variant.asset)}:${canonicalAccountAddress(variant.networkId, variant.destinationAddress)}`,
    ),
  );
  const componentVariants = (
    input.account.projection?.components ?? []
  ).flatMap((component) => {
    if (
      component.category === "in_transit" ||
      component.location.kind !== "wallet" ||
      component.location.accountId !== input.planning.accountId ||
      component.observationFreshness !== "fresh" ||
      component.observationError ||
      (!isRelayPinnedStableAsset(component.amount.asset) &&
        !isNativeSolAsset(component.amount.asset)) ||
      !supportsCanonicalFundingReceiveEvents(component.amount.asset.networkId)
    ) {
      return [];
    }
    const routes = input.planning.policy.routes.filter(
      (route) =>
        route.enabled &&
        route.providerId === "relay" &&
        route.destinationLocationPatternId ===
          input.planning.destination.destinationLocationPatternId &&
        sameAsset(route.sourceAsset, component.amount.asset) &&
        sameAsset(route.destinationAsset, input.planning.requiredAmount.asset),
    );
    if (routes.length !== 1) return [];
    const route = routes[0];
    if (!route) return [];
    const sourcePolicies = input.planning.policy.locations.filter(
      (location) =>
        location.enabled &&
        location.locationPatternId === route.sourceLocationPatternId &&
        location.locationKind === "wallet" &&
        location.ownership === "owned" &&
        location.observable &&
        location.capabilities.includes("execution_source") &&
        sameAsset(location.asset, component.amount.asset),
    );
    if (sourcePolicies.length !== 1) return [];
    const walletId = locationDetail(component.location, "walletId");
    const address = locationDetail(component.location, "address");
    if (!walletId || !address) return [];
    const profile = profileForExactWallet({
      account: input.account,
      walletId,
      networkId: component.amount.asset.networkId,
      address,
    });
    if (
      !profile ||
      profile.source === "external" ||
      profile.signingModes.length === 0
    ) {
      return [];
    }
    const destinationAddress = canonicalAccountAddress(
      component.amount.asset.networkId,
      address,
    );
    const key = `${canonicalAssetKey(component.amount.asset)}:${destinationAddress}`;
    if (existing.has(key)) return [];
    existing.add(key);
    return [
      {
        variantId: stableOpaqueId(
          "ingress_variant",
          canonicalJsonHash({
            destinationAddress,
            asset: component.amount.asset,
            completion: "child_funding_operation",
            routeId: route.routeId,
          }),
        ),
        networkId: component.amount.asset.networkId,
        asset: component.amount.asset,
        destinationAddress: address,
        destinationLocationId: component.location.locationId,
        baselineRaw: component.amount.raw,
        baselineRevision: canonicalJsonHash({
          schema: "owned_receive_component_baseline_v1",
          componentId: component.componentId,
          observedAt: component.observedAt,
          raw: component.amount.raw,
        }),
        observation: {
          // This variant belongs to an owned source wallet. Destination
          // spendability can only observe the venue destination and therefore
          // cannot verify a routed cross-network source location.
          adapterId: "owned_wallet_liquid_balances_v1",
          payload: {
            routeId: route.routeId,
            balanceKey: canonicalAssetKey(component.amount.asset),
          },
        },
        completion: { kind: "child_funding_operation" as const },
      },
    ];
  });
  const capabilityVariants = (input.planning.policy.routes ?? []).flatMap(
    (route) => {
      if (
        !route.enabled ||
        route.providerId !== "relay" ||
        route.destinationLocationPatternId !==
          input.planning.destination.destinationLocationPatternId ||
        !sameAsset(
          route.destinationAsset,
          input.planning.requiredAmount.asset,
        ) ||
        (!isRelayPinnedStableAsset(route.sourceAsset) &&
          !isNativeSolAsset(route.sourceAsset)) ||
        !supportsCanonicalFundingReceiveEvents(route.sourceAsset.networkId)
      ) {
        return [];
      }
      const sourcePolicies = input.planning.policy.locations.filter(
        (location) =>
          location.enabled &&
          location.locationPatternId === route.sourceLocationPatternId &&
          location.locationKind === "wallet" &&
          location.ownership === "owned" &&
          location.observable &&
          location.capabilities.includes("execution_source") &&
          sameAsset(location.asset, route.sourceAsset),
      );
      if (sourcePolicies.length !== 1) return [];
      const profiles = (input.account.ownership?.wallets ?? []).filter(
        (profile) =>
          profile.networkId === route.sourceAsset.networkId &&
          profile.source !== "external" &&
          profile.signingModes.length > 0,
      );
      if (profiles.length !== 1) return [];
      const profile = profiles[0];
      if (!profile) return [];
      const destinationAddress = canonicalAccountAddress(
        route.sourceAsset.networkId,
        profile.address,
      );
      const key = `${canonicalAssetKey(route.sourceAsset)}:${destinationAddress}`;
      if (existing.has(key)) return [];
      existing.add(key);
      return [
        {
          variantId: stableOpaqueId(
            "ingress_variant",
            canonicalJsonHash({
              destinationAddress,
              asset: route.sourceAsset,
              completion: "child_funding_operation",
              routeId: route.routeId,
            }),
          ),
          networkId: route.sourceAsset.networkId,
          asset: route.sourceAsset,
          destinationAddress: profile.address,
          destinationLocationId: stableOpaqueId(
            "location",
            [
              input.planning.accountId,
              "wallet",
              destinationAddress,
              canonicalAssetKey(route.sourceAsset),
            ].join(":"),
          ),
          baselineRaw: "0",
          baselineRevision: canonicalJsonHash({
            schema: "owned_receive_capability_baseline_v1",
            walletId: profile.walletId,
            routeId: route.routeId,
            asset: route.sourceAsset,
          }),
          observation: {
            adapterId: "owned_wallet_liquid_balances_v1",
            payload: {
              routeId: route.routeId,
              balanceKey: canonicalAssetKey(route.sourceAsset),
            },
          },
          completion: { kind: "child_funding_operation" as const },
        },
      ];
    },
  );
  return [...componentVariants, ...capabilityVariants];
}

function instruction(input: {
  destinationAddress: string;
  destinationOptionId: string;
  expiresAt: string;
  ingressKind: "manual" | "privy";
  planning: FundingSourcePlanningInput;
  variants: readonly DirectIngressVariant[];
}): ExternalIngressInstruction {
  const amount = input.planning.requiredAmount;
  const targets = buildFundingReceiveTargets(input.variants);
  const sourceNetworks = new Set(
    input.variants.map((variant) => variant.asset.networkId),
  );
  const sourceAssets = new Map(
    input.variants.map((variant) => [
      canonicalAssetKey(variant.asset),
      variant.asset,
    ]),
  );
  return {
    ingressKind: input.ingressKind,
    sourceNetworkId:
      sourceNetworks.size === 1
        ? (sourceNetworks.values().next().value ?? null)
        : null,
    sourceAsset:
      sourceAssets.size === 1
        ? (sourceAssets.values().next().value ?? null)
        : null,
    receiveTargets: targets,
    recommendedReceiveTargetId: targets[0]?.receiveTargetId ?? null,
    destinationOptionId: input.destinationOptionId,
    destinationAddress: input.destinationAddress,
    requestedAmount: amount,
    amountSemantics: "minimum",
    expiresAt: input.expiresAt,
    safeInstructions: [
      "Use only a displayed asset on its displayed network.",
      "Do not mix different assets in the same funding operation.",
      "You may make several smaller transfers of one asset until the requested amount is reached.",
      "Any excess remains available in your Hunch balance.",
      "Hunch observes the deposit and completes any required conversion before marking funds ready.",
    ],
  };
}

function sourceOption(input: {
  planning: FundingSourcePlanningInput;
  kind: "manual_receive" | "privy_funding_method";
  ingressKind: "manual" | "privy";
  safeLabel: string;
  expiresAt: string;
  destinationAddress: string;
  recommended: boolean;
  variants: readonly DirectIngressVariant[];
}): SourceOption {
  const ingress = instruction({
    planning: input.planning,
    ingressKind: input.ingressKind,
    destinationAddress: input.destinationAddress,
    destinationOptionId: input.planning.destination.destinationId,
    expiresAt: input.expiresAt,
    variants: input.variants,
  });
  const source = {
    kind: "external_ingress" as const,
    ingressKind: input.ingressKind,
    networkId: ingress.sourceNetworkId,
    asset: ingress.sourceAsset,
    controlledSender: false,
  };
  return {
    sourceOptionId: stableOpaqueId(
      "source",
      canonicalJsonHash({
        destinationOptionId: input.planning.destination.destinationId,
        ingressKind: input.ingressKind,
        requiredAmount: input.planning.requiredAmount,
        policyRevision: input.planning.policyRevision,
      }),
    ),
    kind: input.kind,
    safeLabel: input.safeLabel,
    source,
    ingress,
    amountMode: "exact_output",
    maximumSourceRaw: input.planning.requiredAmount.raw,
    expectedDestination: input.planning.requiredAmount,
    minimumDestination: input.planning.requiredAmount,
    estimatedUsd: multiplyRawByUnitPrice({
      raw: input.planning.requiredAmount.raw,
      decimals: input.planning.requiredAmount.asset.decimals,
      unitPriceUsd: "1",
    }),
    fees: [],
    eta: null,
    experienceMode: "prepare_first",
    requiredActions: [
      {
        kind: "external_handoff",
        safeLabel:
          input.ingressKind === "privy"
            ? "Explicitly confirm funding in Privy"
            : "Explicitly send from your external wallet",
        actor: "user",
        valueMoving: true,
        sponsorship: "none",
      },
    ],
    expiresAt: input.expiresAt,
    recommended: input.recommended,
    selectable: true,
    reasonCodes: [],
  };
}

function plannedSource(
  input: FundingSourcePlanningInput,
  option: SourceOption,
  variants: readonly DirectIngressVariant[],
  completion: DirectIngressCompletion | null,
  receiveSessionVariants: readonly DirectIngressVariant[] = variants,
): PlannedSourceOption {
  const destinationFacts = input.destinationFacts;
  if (input.destination.target.kind !== "owned_location") {
    throw new Error("direct ingress requires an owned destination");
  }
  if (!input.destination.venueBindingOption) {
    throw new Error("direct ingress requires a frozen venue binding option");
  }
  const destinationLocation = input.destination.target.location;
  const reservationExpiresAt = new Date(
    input.now.getTime() + input.policy.ttl.reservationMs,
  ).toISOString();
  return {
    option,
    routeId: null,
    providerId: null,
    compositeEligible: false,
    commitPlan: {
      operation: {
        purpose: input.request.purpose,
        initialState: {
          status: "awaiting_external_funds",
          stage: "source_action",
        },
        experienceMode: "prepare_first",
        planKind: "direct_external_handoff",
        sourceSnapshot: jsonRecord(option),
        destinationTargetSnapshot: jsonRecord(input.destination.target),
        externalRecipientId: null,
        venueId: input.destination.venueId,
        marketId: input.marketContext?.marketId ?? null,
        marketContextSnapshot: input.marketContext
          ? jsonRecord(input.marketContext)
          : null,
        venueBindingSnapshot: jsonRecord(input.destination.venueBindingOption),
        walletExecutionSnapshot: completion?.walletExecutionSnapshot ?? null,
        placementSnapshot: jsonRecord(input.placement),
        requestedSourceAmount: jsonRecord(input.requiredAmount),
        requestedDestinationAmount: jsonRecord(input.requiredAmount),
        supportMetadata: {
          adapterId: "direct_owned_receive_v1",
          destinationObserverId: "owned_multi_asset_balance_delta_v1",
          ingressVariants: variants.map((variant) => jsonRecord(variant)),
          receiveSessionVariants: receiveSessionVariants.map((variant) =>
            jsonRecord(variant),
          ),
          receiveSessionTargets: buildFundingReceiveTargets(
            receiveSessionVariants,
          ).map((target) => jsonRecord(target)),
          destinationBaselineRaw:
            destinationFacts?.spendability.observedAmount.raw ?? null,
          destinationBaselineRevision:
            destinationFacts?.spendability.revision ?? null,
          ...(completion?.supportMetadata ?? {}),
        },
      },
      segments: [],
      steps: completion ? [completion.step] : [],
      reservations: variants.map(
        (variant): FundingCommitReservation => ({
          segmentOrdinal: null,
          componentId: stableOpaqueId(
            "direct_ingress",
            `${destinationLocation.locationId}:${canonicalAssetKey(variant.asset)}`,
          ),
          locationId: destinationLocation.locationId,
          networkId: variant.asset.networkId,
          assetId: variant.asset.assetId,
          assetDecimals: variant.asset.decimals,
          rawAmount: input.requiredAmount.raw,
          mode: "advisory_destination",
          expiresAt: reservationExpiresAt,
        }),
      ),
    },
  };
}

export class DirectIngressFundingSourceAdapter implements FundingSourceAdapter {
  readonly adapterId = "direct_owned_receive_v1";

  constructor(
    private readonly account: AccountValueReadModel | null = null,
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

  async list(
    input: FundingSourcePlanningInput,
  ): Promise<readonly PlannedSourceOption[]> {
    if (
      input.request.purpose !== "add_funds" &&
      input.request.purpose !== "manual_rebalance"
    ) {
      return [];
    }
    const destinationPolicy = exactDestinationPolicy(input);
    const destinationAddress = detail(input, "address");
    if (
      !destinationPolicy ||
      !destinationAddress ||
      !input.destinationFacts ||
      !input.destination.venueBindingOption ||
      input.destination.target.kind !== "owned_location"
    ) {
      return [];
    }
    const expiresAt = new Date(
      input.now.getTime() + input.policy.ttl.quoteMs,
    ).toISOString();
    const completion = this.account
      ? buildPolymarketIngressCompletion({
          account: this.account,
          planning: input,
          canonicalRouterAddress: this.config.canonicalRouterAddress,
          usdceAsset: this.config.usdceAsset,
        })
      : null;
    const candidateVariants = completion?.variants ?? [
      exactIngressVariant(input),
    ];
    const directVariants = candidateVariants.filter((variant) =>
      fundingReceiveAssetEnabled(input.policy, variant.asset),
    );
    const completionForSelectedAsset = directVariants.some(
      (variant) => variant.completion.kind === "committed_venue_preparation",
    )
      ? completion
      : null;
    // Receive targets are limited to networks with an exact canonical event
    // observer. Polygon and Base share the EVM Transfer scanner. Solana SPL
    // and native SOL use exact finalized instruction identity. A Relay quote
    // or aggregate wallet balance is never sufficient receipt identity.
    const receiveSessionVariants = [
      ...directVariants,
      ...(this.account
        ? buildRoutedReceiveVariants({
            account: this.account,
            planning: input,
            existing: directVariants,
          })
        : []),
    ].filter((variant) =>
      supportsCanonicalFundingReceiveEvents(variant.networkId),
    );
    const sources: PlannedSourceOption[] = [];
    if (receiveSessionVariants.length > 0) {
      const manual = sourceOption({
        planning: input,
        kind: "manual_receive",
        ingressKind: "manual",
        safeLabel: "Deposit crypto",
        expiresAt,
        destinationAddress,
        recommended: true,
        variants: receiveSessionVariants,
      });
      sources.push(
        plannedSource(
          input,
          manual,
          directVariants,
          completionForSelectedAsset,
          receiveSessionVariants,
        ),
      );
    }
    const privyEnabled = input.policy.privyFundingMethods.some(
      (method) =>
        method.enabled &&
        method.locallyConfigured &&
        method.destinationLocationPatternId ===
          input.destination.destinationLocationPatternId &&
        sameAsset(method.asset, input.requiredAmount.asset),
    );
    const privyVariants = candidateVariants.filter((variant) =>
      sameAsset(variant.asset, input.requiredAmount.asset),
    );
    if (privyEnabled && privyVariants.length > 0) {
      const privy = sourceOption({
        planning: input,
        kind: "privy_funding_method",
        ingressKind: "privy",
        safeLabel: "Fund with Privy",
        expiresAt,
        destinationAddress,
        recommended: false,
        variants: privyVariants,
      });
      sources.push(plannedSource(input, privy, privyVariants, null));
    }
    return sources;
  }
}
