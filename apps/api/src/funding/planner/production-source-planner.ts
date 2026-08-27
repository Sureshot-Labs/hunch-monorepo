import type { Pool } from "@hunch/infra";
import { ZeroAddress } from "ethers";

import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import { scaleUnsignedDecimalByRawRatio } from "../../account-value/decimal.js";
import { stableOpaqueId } from "../../account-value/canonical.js";
import { createRelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import {
  isRelayQuoteRejectedError,
  RelayClient,
  RelayClientError,
} from "../../funding-providers/relay/client.js";
import {
  isRelayPinnedStableAsset,
  RELAY_PINNED_ASSETS,
  resolveRelayRouteSpec,
} from "../../funding-providers/relay/mappings.js";
import {
  RelayQuoteEconomicsError,
  RelayQuoteValidationError,
  RelayWalletQuoteAdapter,
} from "../../funding-providers/relay/wallet-adapter.js";
import { buildRelayPlanningQuote } from "../../funding-providers/relay/operation-plan.js";
export { buildPolymarketPreRouteHandoffSteps } from "../../funding-providers/relay/operation-plan.js";
import { getCredentialsEncryptionKey } from "../../lib/credentials-encryption.js";
import type {
  AssetLocation,
  AssetRef,
  FundingDiscoveryRequest,
  Money,
  FundingReasonCode,
  WalletExecutionProfile,
} from "../domain/types.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import type {
  FundingSourcePlanningRequest,
  FundingSourcePlanningResult,
} from "./planner.js";
import {
  fetchFundingRouteExperience,
  fundingRouteExperienceFingerprint,
} from "../persistence/route-experience-repository.js";
import { PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID } from "../execution/sponsorship-policy.js";
import {
  loadRelayEvmExecutionConfiguration,
  relayEvmSequentialQuoteTtlMs,
} from "../execution/delegated-funding-config.js";
import { relayEvmFundingProfileSpec } from "../execution/relay-evm-profile-specs.js";
import {
  FundingPlannerError,
  assertSameAsset,
  rawAmount,
  sameAsset,
} from "./money.js";
import { buildCompositeSourceOption } from "./composite-source-options.js";
import {
  RelayFirstSourcePlanner,
  effectiveFundingEconomicsLimits,
  type RelayEligibleSourceFact,
  type RelayPlanningQuoteResult,
} from "./source-options.js";
import type { ResolvedRouteDestination } from "./destination-adapters.js";
import {
  commitPlanRunsWithoutUserWalletAction,
  plannedSourceRunsWithClientWalletActions,
  type PlannedSourceOption,
} from "./planning-types.js";
import type {
  FundingSourceAdapter,
  FundingSourcePlanningInput,
} from "./source-adapter.js";
import { listAdaptedFundingSources } from "./source-adapter.js";
import {
  canonicalAssetId,
  sameAccountAddress,
} from "../domain/asset-identity.js";
import { SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS } from "../domain/network-fees.js";
import { withWithdrawalPlanningContract } from "../domain/withdrawal-contract.js";
import { parsePositiveInteger } from "../runtime/positive-integer.js";

const ROUTE_EXPERIENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export function fundingSourceInventoryBlockingReasonCodes(
  errors: readonly Readonly<{
    collectorId: string;
    retryable: boolean;
  }>[],
): readonly FundingReasonCode[] {
  return errors.some(
    (error) => error.collectorId === "wallet-inventory" && error.retryable,
  )
    ? ["rpc_unavailable"]
    : [];
}

function detail(location: AssetLocation, key: string): string | null {
  const value = location.details[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function profileForLocation(
  account: AccountValueReadModel,
  location: AssetLocation,
): WalletExecutionProfile | null {
  const walletId = detail(location, "walletId");
  const address = detail(location, "address");
  if (!walletId || !address || !account.ownership) return null;
  return (
    account.ownership.wallets.find(
      (profile) =>
        profile.walletId === walletId &&
        profile.networkId === location.asset.networkId &&
        sameAccountAddress(location.asset.networkId, profile.address, address),
    ) ?? null
  );
}

function profileForExactAddress(
  account: AccountValueReadModel,
  networkId: string,
  address: string,
): WalletExecutionProfile | null {
  if (!account.ownership) return null;
  const matches = account.ownership.wallets.filter(
    (profile) =>
      profile.networkId === networkId &&
      sameAccountAddress(networkId, profile.address, address),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function walletExecutionLocation(
  location: AssetLocation,
  profile: WalletExecutionProfile,
): AssetLocation | null {
  const walletId = detail(location, "walletId");
  const address = detail(location, "address");
  if (
    !walletId ||
    !address ||
    walletId !== profile.walletId ||
    !sameAccountAddress(profile.networkId, address, profile.address) ||
    location.asset.networkId !== profile.networkId
  ) {
    return null;
  }
  if (location.kind === "wallet") return location;
  if (location.kind !== "venue_account" || profile.source === "external") {
    return null;
  }
  // Keep accounting and execution identities separate. A managed venue cash
  // component is reserved by its original location, while Relay receives the
  // exact wallet/address capability that can actually sign the transfer.
  return {
    kind: "wallet",
    locationId: stableOpaqueId(
      "location",
      `${location.locationId}:wallet_execution`,
    ),
    accountId: location.accountId,
    asset: location.asset,
    details: {
      ...location.details,
      address,
      walletId,
      balanceLocationId: location.locationId,
    },
  };
}

function linkedControllerExecutionLocation(
  location: AssetLocation,
  profile: WalletExecutionProfile,
): AssetLocation {
  return {
    kind: "wallet",
    locationId: stableOpaqueId(
      "location",
      `${location.locationId}:${profile.walletId}:controller_execution`,
    ),
    accountId: location.accountId,
    asset: location.asset,
    details: {
      address: profile.address,
      walletId: profile.walletId,
      balanceLocationId: location.locationId,
      linkedAddress: profile.address,
      balanceClass: "polymarket_handoff",
    },
  };
}

export type ProductionOwnedSourceExecution = Readonly<{
  executionLocation: AssetLocation;
  preRouteHandoff?: RelayEligibleSourceFact["preRouteHandoff"];
  profile: WalletExecutionProfile;
  safeLabel?: string;
}>;

/**
 * Resolves accounting ownership separately from the wallet that can execute
 * an action. A Polymarket Deposit Wallet is observable cash, but only its
 * linked controller is a general-purpose signer; callers may prepend the
 * exact relayer handoff returned here before their ordinary wallet action.
 */
export function resolveProductionOwnedSourceExecution(input: {
  account: AccountValueReadModel;
  component: AccountValueReadModel["projection"]["components"][number];
}): ProductionOwnedSourceExecution | null {
  const { account, component } = input;
  const directProfile = profileForLocation(account, component.location);
  const funderAddress = detail(component.location, "address");
  const linkedAddress = detail(component.location, "linkedAddress");
  const isPolymarketDepositWalletSource =
    component.location.kind === "venue_account" &&
    detail(component.location, "venueId") === "polymarket" &&
    detail(component.location, "polymarketFunderKind") === "deposit_wallet" &&
    component.amount.asset.networkId === "evm:137" &&
    canonicalAssetId(component.amount.asset) ===
      RELAY_PINNED_ASSETS.polygonPusd.toLowerCase() &&
    Boolean(funderAddress) &&
    Boolean(linkedAddress) &&
    Boolean(
      funderAddress &&
      linkedAddress &&
      !sameAccountAddress("evm:137", funderAddress, linkedAddress),
    ) &&
    directProfile?.source === "smart" &&
    directProfile.signingModes.length === 0;
  const handoffControllerProfile =
    isPolymarketDepositWalletSource && linkedAddress
      ? profileForExactAddress(
          account,
          component.amount.asset.networkId,
          linkedAddress,
        )
      : null;
  const usesPolymarketHandoff =
    Boolean(handoffControllerProfile) &&
    handoffControllerProfile?.source !== "external" &&
    Boolean(handoffControllerProfile?.controllerWalletRef) &&
    (handoffControllerProfile?.signingModes.includes("web_client") ||
      handoffControllerProfile?.signingModes.includes("privy_authorization"));
  const profile = usesPolymarketHandoff
    ? handoffControllerProfile
    : directProfile;
  const executionLocation =
    usesPolymarketHandoff && profile
      ? linkedControllerExecutionLocation(component.location, profile)
      : profile
        ? walletExecutionLocation(component.location, profile)
        : null;
  if (!profile || !executionLocation) return null;
  return {
    profile,
    executionLocation,
    ...(usesPolymarketHandoff && funderAddress && linkedAddress
      ? {
          safeLabel: "Polymarket balance",
          preRouteHandoff: {
            kind: "polymarket_deposit_wallet_to_controller_v1" as const,
            sourceLocation: component.location,
            funderAddress,
            controllerAddress: profile.address,
            tokenAddress: component.amount.asset.assetId,
          },
        }
      : {}),
  };
}

function nativeAssetId(asset: AssetRef): string {
  return asset.networkId === "solana:mainnet"
    ? RELAY_PINNED_ASSETS.solanaNative
    : ZeroAddress;
}

export function productionFundingProfileHasNativeGas(
  account: AccountValueReadModel,
  profile: WalletExecutionProfile,
): boolean {
  if (
    profile.sponsorshipPolicyIds.includes(
      PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID,
    ) &&
    profile.signingModes.includes("privy_authorization") &&
    Boolean(profile.serverWalletRef)
  ) {
    return true;
  }
  const availableByComponent = new Map(
    account.cashAvailability.components.map((component) => [
      component.componentId,
      component,
    ]),
  );
  return account.projection.components.some((component) => {
    const address = detail(component.location, "address");
    const available = availableByComponent.get(component.componentId);
    // Gas eligibility is an execution fact, not a USD-valuation fact. The
    // cash projector marks an unpriced native token as stale even when its raw
    // on-chain balance is fresh and fully available. Requiring that aggregate
    // freshness made a temporary Pyth/SOL price gap disable otherwise valid
    // Solana funding routes.
    const rawAvailabilityIsFresh =
      component.observationFreshness === "fresh" &&
      !component.observationError &&
      available != null &&
      !available.reasonCodes.includes("cash_availability_unknown");
    return (
      component.location.kind === "wallet" &&
      component.amount.asset.networkId === profile.networkId &&
      canonicalAssetId(component.amount.asset) ===
        canonicalAssetId({
          ...component.amount.asset,
          assetId: nativeAssetId(component.amount.asset),
        }) &&
      Boolean(
        address &&
        sameAccountAddress(profile.networkId, address, profile.address),
      ) &&
      rawAvailabilityIsFresh &&
      BigInt(available.availableRaw) >=
        (profile.networkId === "solana:mainnet"
          ? SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS
          : 1n)
    );
  });
}

function isSolanaNativeAsset(asset: AssetRef): boolean {
  return (
    asset.networkId === "solana:mainnet" &&
    asset.assetId === RELAY_PINNED_ASSETS.solanaNative &&
    asset.decimals === 9
  );
}

function rescaleStableRaw(
  raw: string,
  sourceDecimals: number,
  destinationDecimals: number,
): string {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error("stable amount is not an unsigned raw integer");
  }
  if (sourceDecimals === destinationDecimals) return raw;
  const source = BigInt(raw);
  if (sourceDecimals > destinationDecimals) {
    return (
      source *
      10n ** BigInt(sourceDecimals - destinationDecimals)
    ).toString();
  }
  const divisor = 10n ** BigInt(destinationDecimals - sourceDecimals);
  return ((source + divisor - 1n) / divisor).toString();
}

function destinationAddress(destination: ResolvedRouteDestination): string {
  const address =
    destination.target.kind === "owned_location"
      ? detail(destination.target.location, "address")
      : destination.recipientAddress;
  if (!address) throw new Error("funding destination address is unavailable");
  return address;
}

function sourceFactsForComponent(input: {
  account: AccountValueReadModel;
  policy: FundingRuntimePolicy;
  component: AccountValueReadModel["projection"]["components"][number];
  executionLocation: AssetLocation;
  profile: WalletExecutionProfile;
  safeLabel?: string;
  preRouteHandoff?: RelayEligibleSourceFact["preRouteHandoff"];
  availableRaw: string;
  requiredAmount: Money;
  confirmedSourceAmount?: Money | null;
  purpose?: FundingDiscoveryRequest["purpose"];
  destinationLocationPatternId?: string;
  maximumSlippageBps: number;
  requiredCapability: "execution_source" | "withdrawal_source";
  suggestionPreferred: boolean;
}): RelayEligibleSourceFact[] {
  const nativeSolSource = isSolanaNativeAsset(input.component.amount.asset);
  if (
    (!isRelayPinnedStableAsset(input.component.amount.asset) &&
      !nativeSolSource) ||
    !isRelayPinnedStableAsset(input.requiredAmount.asset)
  ) {
    return [];
  }
  const exactRoutes = input.policy.routes.filter(
    (route) =>
      route.enabled &&
      route.providerId === "relay" &&
      (input.destinationLocationPatternId == null ||
        route.destinationLocationPatternId ===
          input.destinationLocationPatternId) &&
      sameAsset(route.sourceAsset, input.component.amount.asset) &&
      sameAsset(route.destinationAsset, input.requiredAmount.asset),
  );
  if (exactRoutes.length !== 1) return [];
  return input.policy.locations
    .filter(
      (location) =>
        location.enabled &&
        location.ownership === "owned" &&
        location.locationKind === "wallet" &&
        location.observable &&
        location.capabilities.includes(input.requiredCapability) &&
        sameAsset(location.asset, input.component.amount.asset),
    )
    .map((location): RelayEligibleSourceFact => {
      const availableRaw = BigInt(input.availableRaw);
      const spendableRaw = nativeSolSource
        ? availableRaw > SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS
          ? availableRaw - SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS
          : 0n
        : availableRaw;
      let raw: string;
      let minimumDestinationRaw: string;
      const confirmedSourceRaw =
        input.confirmedSourceAmount &&
        sameAsset(
          input.confirmedSourceAmount.asset,
          input.component.amount.asset,
        )
          ? BigInt(input.confirmedSourceAmount.raw)
          : null;
      if (confirmedSourceRaw != null) {
        raw =
          confirmedSourceRaw > 0n && confirmedSourceRaw <= spendableRaw
            ? confirmedSourceRaw.toString()
            : "0";
        // A confirmed source amount is exact-input regardless of which flow
        // supplied it. This includes user-entered Convert and an observed
        // receive receipt. Relay freezes the economically safe destination
        // output; the pre-quote floor only proves that the route cannot return
        // zero and must never turn received funds into an exact-output spend.
        minimumDestinationRaw = "1";
      } else if (nativeSolSource) {
        raw = spendableRaw.toString();
        minimumDestinationRaw = input.requiredAmount.raw;
      } else {
        const requiredSourceRaw = rescaleStableRaw(
          input.requiredAmount.raw,
          input.component.amount.asset.decimals,
          input.requiredAmount.asset.decimals,
        );
        const slippageDenominator = 10_000 - input.maximumSlippageBps;
        const sourceRawWithSlippage =
          (BigInt(requiredSourceRaw) * 10_000n +
            BigInt(slippageDenominator) -
            1n) /
          BigInt(slippageDenominator);
        raw =
          spendableRaw < sourceRawWithSlippage
            ? spendableRaw.toString()
            : sourceRawWithSlippage.toString();
        const grossDestinationRaw = rescaleStableRaw(
          raw,
          input.requiredAmount.asset.decimals,
          input.component.amount.asset.decimals,
        );
        minimumDestinationRaw = (
          (BigInt(grossDestinationRaw) *
            BigInt(10_000 - input.maximumSlippageBps)) /
          10_000n
        ).toString();
      }
      const estimatedUsd =
        !nativeSolSource &&
        input.component.estimatedUsd &&
        BigInt(input.component.amount.raw) > 0n
          ? scaleUnsignedDecimalByRawRatio({
              value: input.component.estimatedUsd.value,
              numeratorRaw: raw,
              denominatorRaw: input.component.amount.raw,
            })
          : null;
      return {
        componentId: input.component.componentId,
        reservationLocationId: input.component.location.locationId,
        sourceLocationPatternId: location.locationPatternId,
        safeLabel:
          input.safeLabel ??
          (input.profile.source === "external"
            ? "Connected wallet"
            : nativeSolSource
              ? "SOL on Solana"
              : input.component.location.kind === "venue_account"
                ? "Trading balance"
                : `${input.component.amount.asset.networkId} wallet`),
        source: {
          kind: "owned_location" as const,
          location: input.executionLocation,
        },
        quoteInputAmount: {
          asset: input.component.amount.asset,
          raw,
        },
        quoteMinimumOutput: {
          asset: input.requiredAmount.asset,
          raw: minimumDestinationRaw,
        },
        ...(confirmedSourceRaw != null
          ? { quoteModeOverride: "exact_input" as const }
          : {}),
        maximumSourceRaw: spendableRaw.toString(),
        maximumSlippageBps: input.maximumSlippageBps,
        estimatedUsd,
        transferable: true,
        riskEligible: true,
        walletExecutionReady:
          input.profile.signingModes.includes("web_client") ||
          input.profile.signingModes.includes("privy_authorization"),
        nativeGasReady: nativeSolSource
          ? spendableRaw > 0n
          : productionFundingProfileHasNativeGas(input.account, input.profile),
        suggestionPreferred: input.suggestionPreferred,
        freshness: "fresh" as const,
        ...(input.preRouteHandoff
          ? { preRouteHandoff: input.preRouteHandoff }
          : {}),
      };
    })
    .filter(
      (fact) =>
        BigInt(fact.quoteInputAmount.raw) > 0n &&
        BigInt(fact.quoteMinimumOutput?.raw ?? "0") > 0n,
    );
}

export function deriveProductionRelayEligibleSourceFacts(input: {
  accountId: string;
  account: AccountValueReadModel;
  policy: FundingRuntimePolicy;
  requiredAmount: Money;
  confirmedSourceAmount?: Money | null;
  destinationLocationPatternId?: string;
  purpose?: FundingDiscoveryRequest["purpose"];
  maximumSlippageBps?: number;
}): readonly RelayEligibleSourceFact[] {
  const availabilityByComponent = new Map(
    input.account.cashAvailability.components.map((component) => [
      component.componentId,
      component,
    ]),
  );
  const facts: RelayEligibleSourceFact[] = [];
  for (const component of input.account.projection.components) {
    const availability = availabilityByComponent.get(component.componentId);
    const execution = resolveProductionOwnedSourceExecution({
      account: input.account,
      component,
    });
    const profile = execution?.profile ?? null;
    const executionLocation = execution?.executionLocation ?? null;
    const nativeSolSource = isSolanaNativeAsset(component.amount.asset);
    if (
      component.location.accountId !== input.accountId ||
      component.category === "in_transit" ||
      component.observationFreshness !== "fresh" ||
      component.observationError ||
      (component.valuationEligibility !== "included" &&
        !nativeSolSource &&
        input.purpose !== "withdrawal") ||
      !availability ||
      (availability.freshness !== "fresh" &&
        (!nativeSolSource ||
          availability.reasonCodes.includes("cash_availability_unknown"))) ||
      BigInt(availability.availableRaw) <= 0n ||
      !profile ||
      !executionLocation
    ) {
      continue;
    }
    const preference =
      input.account.assetPreferences[component.componentId]?.preference ??
      "ask";
    if (preference === "never_suggest") continue;
    facts.push(
      ...sourceFactsForComponent({
        account: input.account,
        policy: input.policy,
        component,
        executionLocation,
        profile,
        ...(execution?.safeLabel ? { safeLabel: execution.safeLabel } : {}),
        ...(execution?.preRouteHandoff
          ? { preRouteHandoff: execution.preRouteHandoff }
          : {}),
        availableRaw: availability.availableRaw,
        requiredAmount: input.requiredAmount,
        confirmedSourceAmount: input.confirmedSourceAmount,
        purpose: input.purpose,
        destinationLocationPatternId: input.destinationLocationPatternId,
        maximumSlippageBps:
          input.maximumSlippageBps ?? input.policy.placement.maximumSlippageBps,
        requiredCapability:
          input.purpose === "withdrawal"
            ? "withdrawal_source"
            : "execution_source",
        suggestionPreferred: preference === "suggest",
      }),
    );
  }
  return facts;
}

/**
 * A server execution profile is not merely quote metadata. It is the exact
 * delegated authority envelope for one source asset and a finite route set.
 * Restrict the candidate inventory before Relay's quote batch limit is
 * applied; otherwise unrelated wallet assets can consume the batch and hide
 * the executable source for the selected envelope.
 */
export function filterRelayEligibleSourceFactsForExecutionProfile(
  facts: readonly RelayEligibleSourceFact[],
  serverExecutionProfileId: string | null | undefined,
): readonly RelayEligibleSourceFact[] {
  if (!serverExecutionProfileId) return facts;
  const profile = relayEvmFundingProfileSpec(serverExecutionProfileId);
  if (!profile) return [];
  return facts.filter((fact) =>
    sameAsset(fact.quoteInputAmount.asset, profile.sourceAsset),
  );
}

export function restrictRelayRoutesToExecutionProfile(
  policy: FundingRuntimePolicy,
  serverExecutionProfileId: string | null | undefined,
): FundingRuntimePolicy {
  if (!serverExecutionProfileId) return policy;
  const profile = relayEvmFundingProfileSpec(serverExecutionProfileId);
  return {
    ...policy,
    routes: policy.routes.filter(
      (route) =>
        route.providerId !== "relay" ||
        Boolean(
          profile &&
          profile.routeIds.includes(route.routeId) &&
          sameAsset(route.sourceAsset, profile.sourceAsset),
        ),
    ),
  };
}

type FundingExecutionBoundary = "automatic" | "client_handoff";

function venuePreparationSupportsBoundary(
  source: PlannedSourceOption,
  executionBoundary: FundingExecutionBoundary,
  requiresCompositeEligibility: boolean,
): boolean {
  return executionBoundary === "client_handoff"
    ? plannedSourceRunsWithClientWalletActions(source)
    : (!requiresCompositeEligibility || source.compositeEligible === true) &&
        commitPlanRunsWithoutUserWalletAction(source.commitPlan);
}

function maximumVenuePreparationContributionRaw(
  sources: readonly PlannedSourceOption[],
  requiredAmount: Money,
  executionBoundary: FundingExecutionBoundary,
): bigint {
  return sources.reduce((maximum, source) => {
    const minimum = source.option.minimumDestination;
    if (
      source.option.source.kind !== "venue_preparation" ||
      !venuePreparationSupportsBoundary(source, executionBoundary, true) ||
      !minimum
    ) {
      return maximum;
    }
    assertSameAsset(
      minimum.asset,
      requiredAmount.asset,
      "venue preparation contribution",
    );
    const contribution = rawAmount(minimum.raw);
    return contribution > 0n &&
      contribution < rawAmount(requiredAmount.raw) &&
      contribution > maximum
      ? contribution
      : maximum;
  }, 0n);
}

export function remainingFundingRequirementAfterVenuePreparation(
  sources: readonly PlannedSourceOption[],
  requiredAmount: Money,
  executionBoundary: FundingExecutionBoundary = "automatic",
): Money | null {
  const requiredRaw = rawAmount(requiredAmount.raw);
  const fullyCovered = sources.some((source) => {
    const minimum = source.option.minimumDestination;
    if (
      !source.option.selectable ||
      source.option.source.kind !== "venue_preparation" ||
      !minimum ||
      !venuePreparationSupportsBoundary(source, executionBoundary, false)
    ) {
      return false;
    }
    assertSameAsset(
      minimum.asset,
      requiredAmount.asset,
      "venue preparation coverage",
    );
    return rawAmount(minimum.raw) >= requiredRaw;
  });
  if (fullyCovered) return null;
  const contributedRaw = maximumVenuePreparationContributionRaw(
    sources,
    requiredAmount,
    executionBoundary,
  );
  return contributedRaw >= requiredRaw
    ? null
    : {
        asset: requiredAmount.asset,
        raw: (requiredRaw - contributedRaw).toString(),
      };
}

export function restrictResidualSourcesToCompositeContribution(
  sources: readonly PlannedSourceOption[],
  input: Readonly<{
    plannedRequirement: Money;
    fullRequirement: Money;
  }>,
): readonly PlannedSourceOption[] {
  assertSameAsset(
    input.plannedRequirement.asset,
    input.fullRequirement.asset,
    "residual funding requirement",
  );
  if (
    rawAmount(input.plannedRequirement.raw) >=
    rawAmount(input.fullRequirement.raw)
  ) {
    return sources;
  }
  return sources.map((source) => {
    if (!source.option.selectable) return source;
    return {
      ...source,
      option: {
        ...source.option,
        experienceMode: "unavailable" as const,
        recommended: false,
        selectable: false,
        reasonCodes: [
          ...new Set<FundingReasonCode>([
            ...source.option.reasonCodes,
            "minimum_output_not_met",
          ]),
        ],
      },
      compositeEligible:
        source.compositeEligible === true &&
        commitPlanRunsWithoutUserWalletAction(source.commitPlan),
    };
  });
}

type ProductionRelayDiscovery = Readonly<{
  sources: readonly PlannedSourceOption[];
  reasonCodes: readonly FundingReasonCode[];
}>;

/**
 * Automatic and Mini App composites have different execution boundaries.
 * Discover each Relay residual against only the venue preparation that the
 * same boundary can execute; otherwise a user-signed Polygon contribution can
 * leave a native-SOL quote incorrectly asking for the full shortfall.
 */
export async function planProductionFundingSourceBoundaries(
  input: Readonly<{
    adapted: readonly PlannedSourceOption[];
    requiredAmount: Money;
    destinationUnitPriceUsd: string | null;
    maximumFeeUsd: string;
    maximumFeeBps: number;
    discoverRelay: (requiredAmount: Money) => Promise<ProductionRelayDiscovery>;
  }>,
): Promise<FundingSourcePlanningResult> {
  const requirements = {
    automatic: remainingFundingRequirementAfterVenuePreparation(
      input.adapted,
      input.requiredAmount,
      "automatic",
    ),
    client_handoff: remainingFundingRequirementAfterVenuePreparation(
      input.adapted,
      input.requiredAmount,
      "client_handoff",
    ),
  } as const;
  const discoveries = new Map<string, Promise<ProductionRelayDiscovery>>();
  const discover = (
    requirement: Money | null,
  ): Promise<ProductionRelayDiscovery> => {
    if (!requirement) {
      return Promise.resolve({ sources: [], reasonCodes: [] });
    }
    const key = `${requirement.asset.networkId}:${requirement.asset.assetId}:${requirement.asset.decimals}:${requirement.raw}`;
    const existing = discoveries.get(key);
    if (existing) return existing;
    const pending = input.discoverRelay(requirement);
    discoveries.set(key, pending);
    return pending;
  };
  const [automaticDiscovery, clientDiscovery] = await Promise.all([
    discover(requirements.automatic),
    discover(requirements.client_handoff),
  ]);
  const residualSources = (
    discovery: ProductionRelayDiscovery,
    requirement: Money | null,
  ) =>
    requirement
      ? restrictResidualSourcesToCompositeContribution(discovery.sources, {
          plannedRequirement: requirement,
          fullRequirement: input.requiredAmount,
        })
      : [];
  const automaticRelay = residualSources(
    automaticDiscovery,
    requirements.automatic,
  );
  const clientRelay = residualSources(
    clientDiscovery,
    requirements.client_handoff,
  );
  const compositeInput = {
    requiredDestination: input.requiredAmount,
    destinationUnitPriceUsd: input.destinationUnitPriceUsd,
    maximumFeeUsd: input.maximumFeeUsd,
    maximumFeeBps: input.maximumFeeBps,
  } as const;
  const automaticComposite = buildCompositeSourceOption({
    ...compositeInput,
    candidates: [...input.adapted, ...automaticRelay],
  });
  const clientComposite = buildCompositeSourceOption({
    ...compositeInput,
    candidates: [...input.adapted, ...clientRelay],
    executionBoundary: "client_handoff",
  });
  const sources = [
    ...input.adapted,
    ...automaticRelay,
    ...clientRelay,
    automaticComposite,
    clientComposite,
  ].filter(
    (candidate, index, all): candidate is PlannedSourceOption =>
      candidate != null &&
      all.findIndex(
        (entry) =>
          entry?.option.sourceOptionId === candidate.option.sourceOptionId,
      ) === index,
  );
  return {
    sources,
    reasonCodes: [
      ...new Set<FundingReasonCode>([
        ...automaticDiscovery.reasonCodes,
        ...clientDiscovery.reasonCodes,
      ]),
    ],
  };
}

export class ProductionFundingSourcePlanner {
  constructor(
    private readonly db: Pool,
    private readonly account: AccountValueReadModel,
    private readonly sourceAdapters: readonly FundingSourceAdapter[] = [],
  ) {}

  async list(
    input: FundingSourcePlanningInput,
  ): Promise<readonly PlannedSourceOption[]> {
    return (await this.discover(input)).sources;
  }

  async discover(
    input: FundingSourcePlanningInput,
  ): Promise<FundingSourcePlanningResult> {
    const [adapted, inventoryReasonCodes] = await Promise.all([
      listAdaptedFundingSources(this.sourceAdapters, input),
      this.listBlockingReasonCodes(input),
    ]);
    const limits = effectiveFundingEconomicsLimits(input.policy, {
      maximumFeeUsd: input.request.maxFeeUsd,
      maximumSlippageBps: input.request.maxSlippageBps,
    });
    const relayPlanner = this.relayPlanner();
    const planned = await planProductionFundingSourceBoundaries({
      adapted,
      requiredAmount: input.requiredAmount,
      destinationUnitPriceUsd:
        input.destinationFacts?.collateralValuation?.unitPriceUsd ?? null,
      maximumFeeUsd: limits.maximumFeeUsd,
      maximumFeeBps: limits.maximumFeeBps,
      discoverRelay: (requiredAmount) =>
        relayPlanner.discover({
          ...input,
          policy: restrictRelayRoutesToExecutionProfile(
            input.policy,
            input.request.serverExecutionProfileId,
          ),
          requiredAmount,
        }),
    });
    return {
      sources: planned.sources,
      reasonCodes: [
        ...new Set<FundingReasonCode>([
          ...inventoryReasonCodes,
          ...planned.reasonCodes,
        ]),
      ],
    };
  }

  async listBlockingReasonCodes(
    input: FundingSourcePlanningRequest,
  ): Promise<readonly FundingReasonCode[]> {
    // A failed wallet observation is not proof that the wallet is empty.
    const blockers = [
      ...fundingSourceInventoryBlockingReasonCodes(
        this.account.projection.collectorErrors,
      ),
    ];
    const facts = this.relaySourceFacts({
      accountId: input.accountId,
      request: input.request,
      destination: input.destination,
      requiredAmount: input.requiredAmount,
      policyRevision: input.policyRevision,
      now: input.now,
    });
    const otherwiseExecutableWithoutGas = facts.some(
      (fact) =>
        !fact.nativeGasReady &&
        fact.transferable &&
        fact.riskEligible &&
        fact.walletExecutionReady &&
        fact.freshness === "fresh" &&
        BigInt(fact.quoteInputAmount.raw) > 0n &&
        BigInt(fact.maximumSourceRaw) >= BigInt(fact.quoteInputAmount.raw),
    );
    if (
      otherwiseExecutableWithoutGas ||
      this.confirmedNativeSolanaAmountConsumesReserve(input)
    ) {
      blockers.push("insufficient_gas");
    }
    return blockers;
  }

  private confirmedNativeSolanaAmountConsumesReserve(
    input: FundingSourcePlanningRequest,
  ): boolean {
    const confirmed = input.request.confirmedSourceAmount;
    if (!confirmed || !isSolanaNativeAsset(confirmed.asset)) return false;
    const exactRouteExists = input.policy.routes.some(
      (route) =>
        route.enabled &&
        route.providerId === "relay" &&
        route.destinationLocationPatternId ===
          input.destination.destinationLocationPatternId &&
        sameAsset(route.sourceAsset, confirmed.asset) &&
        sameAsset(route.destinationAsset, input.requiredAmount.asset),
    );
    if (!exactRouteExists) return false;
    const availabilityByComponent = new Map(
      this.account.cashAvailability.components.map((component) => [
        component.componentId,
        component,
      ]),
    );
    const requestedRaw = BigInt(confirmed.raw);
    return this.account.projection.components.some((component) => {
      if (!sameAsset(component.amount.asset, confirmed.asset)) return false;
      const availability = availabilityByComponent.get(component.componentId);
      const profile = profileForLocation(this.account, component.location);
      if (
        !availability ||
        availability.freshness !== "fresh" ||
        !profile ||
        (!profile.signingModes.includes("web_client") &&
          !profile.signingModes.includes("privy_authorization"))
      ) {
        return false;
      }
      const availableRaw = BigInt(availability.availableRaw);
      const spendableRaw =
        availableRaw > SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS
          ? availableRaw - SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS
          : 0n;
      return requestedRaw > spendableRaw && requestedRaw <= availableRaw;
    });
  }

  private relayPlanner(): RelayFirstSourcePlanner {
    return new RelayFirstSourcePlanner({
      listEligibleSources: (input) => this.listEligibleSources(input),
      quoteRelay: (input) => this.quoteRelay(input),
      serverExecutionQuoteWindow: (profileId) => {
        if (!relayEvmFundingProfileSpec(profileId)) return null;
        const configuration = loadRelayEvmExecutionConfiguration();
        return {
          maximumQuoteTtlMs: relayEvmSequentialQuoteTtlMs(configuration),
          minimumRemainingTtlMs: configuration.minimumSequentialTtlMs,
        };
      },
      observeRoute: async ({ route, amountBand, now }) => {
        const lookupKey = process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY?.trim();
        const keyVersion =
          parsePositiveInteger(
            process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION,
          ) ?? 1;
        if (!lookupKey) return null;
        return fetchFundingRouteExperience(this.db, {
          routeKeyHmac: fundingRouteExperienceFingerprint(
            `${route.routeId}:${amountBand}`,
            lookupKey,
          ),
          routeKeyVersion: keyVersion,
          maximumAgeMs: ROUTE_EXPERIENCE_MAX_AGE_MS,
          now,
        });
      },
    });
  }

  private async listEligibleSources(
    input: Readonly<{
      accountId: string;
      request: FundingDiscoveryRequest;
      destination: ResolvedRouteDestination;
      requiredAmount: Money;
      policyRevision: string;
      now: Date;
    }>,
  ): Promise<readonly RelayEligibleSourceFact[]> {
    return this.relaySourceFacts(input);
  }

  private relaySourceFacts(
    input: Readonly<{
      accountId: string;
      request: FundingDiscoveryRequest;
      destination: ResolvedRouteDestination;
      requiredAmount: Money;
      policyRevision: string;
      now: Date;
    }>,
  ): readonly RelayEligibleSourceFact[] {
    const basePolicy = this.currentPolicy();
    const policy =
      input.request.purpose === "withdrawal"
        ? withWithdrawalPlanningContract(basePolicy, input.requiredAmount.asset)
        : basePolicy;
    return filterRelayEligibleSourceFactsForExecutionProfile(
      deriveProductionRelayEligibleSourceFacts({
        accountId: input.accountId,
        account: this.account,
        policy,
        requiredAmount: input.requiredAmount,
        confirmedSourceAmount: input.request.confirmedSourceAmount,
        destinationLocationPatternId:
          input.destination.destinationLocationPatternId,
        purpose: input.request.purpose,
        maximumSlippageBps: Math.min(
          input.request.maxSlippageBps ?? policy.placement.maximumSlippageBps,
          policy.placement.maximumSlippageBps,
        ),
      }),
      input.request.serverExecutionProfileId,
    );
  }

  private currentPolicy(): FundingRuntimePolicy {
    if (!this.account.runtimePolicy) {
      throw new Error("account value runtime policy snapshot is unavailable");
    }
    return this.account.runtimePolicy;
  }

  private async quoteRelay(
    input: Parameters<
      ConstructorParameters<typeof RelayFirstSourcePlanner>[0]["quoteRelay"]
    >[0],
  ): Promise<RelayPlanningQuoteResult> {
    const apiKey = process.env.RELAY_API_KEY?.trim();
    const lookupKey = process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY?.trim();
    const keyVersion =
      parsePositiveInteger(process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION) ??
      1;
    if (!apiKey || !lookupKey) {
      throw new Error("Relay runtime secrets are unavailable");
    }
    const sourceLocation =
      input.source.source.kind === "owned_location"
        ? input.source.source.location
        : null;
    if (!sourceLocation) return null;
    const profile = profileForLocation(this.account, sourceLocation);
    const userAddress = detail(sourceLocation, "address");
    if (!profile || !userAddress) return null;
    const codec = createRelayReferenceCodec({
      encryptionKey: getCredentialsEncryptionKey(),
      lookupHmacKey: lookupKey,
      keyVersion,
    });
    const adapter = new RelayWalletQuoteAdapter(
      new RelayClient({
        apiKey,
        timeoutMs: Math.min(input.timeoutMs, 10_000),
      }),
    );
    const mappedRelayRoute = resolveRelayRouteSpec(input.route);
    const relayRoute =
      input.source.quoteModeOverride === "exact_input"
        ? { ...mappedRelayRoute, quoteMode: "exact_input" as const }
        : mappedRelayRoute;
    const quoteSourceAmount =
      relayRoute.quoteMode === "expected_output"
        ? {
            ...input.sourceAmount,
            raw: input.source.maximumSourceRaw,
          }
        : input.sourceAmount;
    let quote;
    try {
      quote = await adapter.quote({
        route: relayRoute,
        source: input.source.source,
        destination: input.destination.target,
        sourceAmount: quoteSourceAmount,
        minimumOutput: input.minimumOutput,
        userAddress,
        recipientAddress: destinationAddress(input.destination),
        senderWalletId: profile.walletId,
        quoteCorrelationId: input.quoteCorrelationId,
        deadline: input.deadline,
        ...(input.maximumQuoteTtlMs
          ? { maximumQuoteTtlMs: input.maximumQuoteTtlMs }
          : {}),
        maximumSlippageBps: input.source.maximumSlippageBps,
      });
    } catch (error) {
      if (error instanceof RelayClientError) {
        if (isRelayQuoteRejectedError(error)) {
          return {
            kind: "rejected",
            reasonCode: "provider_quote_rejected",
          };
        }
        throw new FundingPlannerError(
          "provider_unavailable",
          `Relay funding quote failed: ${error.code}`,
        );
      }
      if (error instanceof RelayQuoteValidationError) {
        console.warn("[funding-relay] quote validation rejected", {
          routeId: relayRoute.routeId,
          quoteMode: relayRoute.quoteMode,
          reason: error.message,
        });
        return {
          kind: "rejected",
          reasonCode: "provider_quote_invalid",
        };
      }
      if (error instanceof RelayQuoteEconomicsError) {
        return {
          kind: "rejected",
          reasonCode: "provider_quote_economics_rejected",
        };
      }
      throw error;
    }
    if (input.signal.aborted) return null;
    return buildRelayPlanningQuote({
      codec,
      destination: input.destination,
      policyRevision: input.policyRevision,
      profile,
      quote,
      quoteCorrelationId: input.quoteCorrelationId,
      route: input.route,
      ...(input.serverExecutionProfileId
        ? { serverExecutionProfileId: input.serverExecutionProfileId }
        : {}),
      ...(input.persistentApprovalCapRaw
        ? {
            persistentApprovalCapRaw: input.persistentApprovalCapRaw,
          }
        : {}),
      source: input.source,
    });
  }
}
