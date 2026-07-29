import type { Pool } from "@hunch/infra";
import { Interface, ZeroAddress } from "ethers";

import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import {
  multiplyRawByUnitPrice,
  scaleUnsignedDecimalByRawRatio,
} from "../../account-value/decimal.js";
import { stableOpaqueId } from "../../account-value/canonical.js";
import { createRelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import {
  RelayClient,
  RelayClientError,
} from "../../funding-providers/relay/client.js";
import {
  isRelayPinnedStableAsset,
  RELAY_PINNED_ASSETS,
  RELAY_ROUTE_SPECS,
  type RelayRouteSpec,
} from "../../funding-providers/relay/mappings.js";
import {
  RelayQuoteEconomicsError,
  RelayWalletQuoteAdapter,
} from "../../funding-providers/relay/wallet-adapter.js";
import { RelayPinnedActionValidator } from "../../funding-providers/relay/action-validator.js";
import { getCredentialsEncryptionKey } from "../../lib/credentials-encryption.js";
import type {
  AssetLocation,
  AssetRef,
  ExternalHandoffAction,
  FundingDiscoveryRequest,
  FundingExecutionPlan,
  JsonValue,
  Money,
  NormalizedAction,
  FundingReasonCode,
  WalletExecutionProfile,
} from "../domain/types.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import type { FundingSourcePlanningRequest } from "./planner.js";
import {
  fetchFundingRouteExperience,
  fundingRouteExperienceFingerprint,
} from "../persistence/route-experience-repository.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import {
  PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID,
  resolveActionSponsorship,
} from "../execution/sponsorship-policy.js";
import { sameAsset } from "./money.js";
import {
  RelayFirstSourcePlanner,
  type RelayEligibleSourceFact,
  type RelayPlanningQuote,
} from "./source-options.js";
import type { ResolvedRouteDestination } from "./destination-adapters.js";
import type { PlannedSourceOption } from "./planning-types.js";
import type {
  FundingSourceAdapter,
  FundingSourcePlanningInput,
} from "./source-adapter.js";
import { listAdaptedFundingSources } from "./source-adapter.js";

const ROUTE_EXPERIENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const SOLANA_NATIVE_EXECUTION_RESERVE_LAMPORTS = 3_000_000n;
const POLYMARKET_DEPOSIT_WALLET_HANDOFF_EXECUTOR_ID =
  "polymarket_deposit_wallet_relayer_v1";
const ERC20_TRANSFER_INTERFACE = new Interface([
  "function transfer(address recipient,uint256 amount)",
]);

function jsonRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  return value as Readonly<Record<string, JsonValue>>;
}

function positiveInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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
        profile.address.toLowerCase() === address.toLowerCase(),
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
      profile.address.toLowerCase() === address.toLowerCase(),
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
    address.toLowerCase() !== profile.address.toLowerCase() ||
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

function nativeAssetId(asset: AssetRef): string {
  return asset.networkId === "solana:mainnet"
    ? RELAY_PINNED_ASSETS.solanaNative
    : ZeroAddress;
}

function hasNativeGas(
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
    return (
      component.location.kind === "wallet" &&
      component.amount.asset.networkId === profile.networkId &&
      component.amount.asset.assetId.toLowerCase() ===
        nativeAssetId(component.amount.asset).toLowerCase() &&
      address?.toLowerCase() === profile.address.toLowerCase() &&
      available?.freshness === "fresh" &&
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

function stableUsdValue(amount: Money): string | null {
  return isRelayPinnedStableAsset(amount.asset)
    ? multiplyRawByUnitPrice({
        raw: amount.raw,
        decimals: amount.asset.decimals,
        unitPriceUsd: "1",
      })
    : null;
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

function routeSpec(
  route: FundingRuntimePolicy["routes"][number],
): RelayRouteSpec {
  const exactById = RELAY_ROUTE_SPECS[route.routeId];
  if (
    exactById &&
    sameAsset(exactById.source, route.sourceAsset) &&
    sameAsset(exactById.destination, route.destinationAsset)
  ) {
    return exactById;
  }
  const matches = Object.values(RELAY_ROUTE_SPECS).filter(
    (spec) =>
      sameAsset(spec.source, route.sourceAsset) &&
      sameAsset(spec.destination, route.destinationAsset),
  );
  if (matches.length !== 1) {
    throw new Error(
      "enabled Relay route does not map to one pinned rehearsal route",
    );
  }
  const match = matches[0];
  if (!match) {
    throw new Error("enabled Relay route mapping disappeared");
  }
  return match;
}

function destinationAddress(destination: ResolvedRouteDestination): string {
  const address =
    destination.target.kind === "owned_location"
      ? detail(destination.target.location, "address")
      : destination.recipientAddress;
  if (!address) throw new Error("funding destination address is unavailable");
  return address;
}

function executionPlan(input: {
  quote: Awaited<ReturnType<RelayWalletQuoteAdapter["quote"]>>;
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
        if (input.purpose === "convert_asset") {
          // Convert is exact-input UX. Relay owns the executable minimum
          // derived from its live quote; this pre-quote value only identifies
          // the positive destination asset and must not turn the entered
          // source amount into an exact-output request.
          minimumDestinationRaw = "1";
        } else {
          const grossDestinationRaw = rescaleStableRaw(
            raw,
            input.requiredAmount.asset.decimals,
            input.component.amount.asset.decimals,
          );
          const boundedMinimum =
            (BigInt(grossDestinationRaw) *
              BigInt(10_000 - input.maximumSlippageBps)) /
            10_000n;
          minimumDestinationRaw = (
            boundedMinimum > 0n ? boundedMinimum : 1n
          ).toString();
        }
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
        ...(input.purpose === "convert_asset"
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
          : hasNativeGas(input.account, input.profile),
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
    const directProfile = profileForLocation(input.account, component.location);
    const funderAddress = detail(component.location, "address");
    const linkedAddress = detail(component.location, "linkedAddress");
    const isPolymarketDepositWalletSource =
      input.purpose !== "withdrawal" &&
      component.location.kind === "venue_account" &&
      detail(component.location, "venueId") === "polymarket" &&
      detail(component.location, "polymarketFunderKind") === "deposit_wallet" &&
      component.amount.asset.networkId === "evm:137" &&
      component.amount.asset.assetId.toLowerCase() ===
        RELAY_PINNED_ASSETS.polygonPusd.toLowerCase() &&
      Boolean(funderAddress) &&
      Boolean(linkedAddress) &&
      funderAddress?.toLowerCase() !== linkedAddress?.toLowerCase() &&
      directProfile?.source === "smart" &&
      directProfile.signingModes.length === 0;
    const handoffControllerProfile =
      isPolymarketDepositWalletSource && linkedAddress
        ? profileForExactAddress(
            input.account,
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
    const nativeSolSource = isSolanaNativeAsset(component.amount.asset);
    if (
      component.location.accountId !== input.accountId ||
      component.category === "in_transit" ||
      component.observationFreshness !== "fresh" ||
      component.observationError ||
      (component.valuationEligibility !== "included" && !nativeSolSource) ||
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
        ...(usesPolymarketHandoff && funderAddress && linkedAddress && profile
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

async function validatedSteps(input: {
  actions: readonly NormalizedAction[];
  minimumOutput: Money;
  policyRevision: string;
  quoteCorrelationId: string;
  route: FundingRuntimePolicy["routes"][number];
  sourceAmount: Money;
  profile: WalletExecutionProfile;
}) {
  const output = [];
  for (const [ordinal, action] of input.actions.entries()) {
    const validator = new RelayPinnedActionValidator(action);
    const signerWalletId =
      action.kind === "evm_transaction"
        ? action.senderWalletId
        : action.kind === "svm_transaction"
          ? action.signerWalletId
          : "";
    const validated = await validator.validate(action, {
      operationId: input.quoteCorrelationId,
      expectedState: { status: "in_progress", stage: "committed" },
      expectedNetworkId: action.networkId,
      expectedSignerWalletId: signerWalletId,
      sourceAmount: input.sourceAmount,
      minimumOutput: input.minimumOutput,
      policyRevision: input.policyRevision,
      routeId: input.route.routeId,
    });
    const sponsorship = resolveActionSponsorship({
      action,
      profile: input.profile,
    });
    output.push({
      ordinal,
      segmentOrdinal: 0,
      stepKind: "transaction" as const,
      state: "action_required" as const,
      actionFingerprint: canonicalJsonHash(action),
      executorId: input.route.networkExecutorId,
      payerRequirement: sponsorship.payerRequirement,
      dependsOnOrdinal: ordinal === 0 ? null : ordinal - 1,
      normalizedAction: jsonRecord(action),
      actionValidationResult: jsonRecord({
        ...validated,
        signerAddress: input.profile.address,
        sponsorshipPolicyId: sponsorship.policyId,
        signingMode: sponsorship.signingMode,
      }),
    });
  }
  return output;
}

export function buildPolymarketPreRouteHandoffSteps(input: {
  source: RelayEligibleSourceFact;
  sourceAmount: Money;
  profile: WalletExecutionProfile;
  steps: Awaited<ReturnType<typeof validatedSteps>>;
}) {
  const handoff = input.source.preRouteHandoff;
  if (!handoff) return input.steps;
  if (
    handoff.kind !== "polymarket_deposit_wallet_to_controller_v1" ||
    input.sourceAmount.asset.networkId !== "evm:137" ||
    input.sourceAmount.asset.assetId.toLowerCase() !==
      handoff.tokenAddress.toLowerCase() ||
    handoff.controllerAddress.toLowerCase() !==
      input.profile.address.toLowerCase() ||
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
      segmentOrdinal: 0,
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

export class ProductionFundingSourcePlanner {
  constructor(
    private readonly db: Pool,
    private readonly account: AccountValueReadModel,
    private readonly sourceAdapters: readonly FundingSourceAdapter[] = [],
  ) {}

  async list(
    input: FundingSourcePlanningInput,
  ): Promise<readonly PlannedSourceOption[]> {
    const [adapted, relay] = await Promise.all([
      listAdaptedFundingSources(this.sourceAdapters, input),
      this.relayPlanner().list(input),
    ]);
    return [...adapted, ...relay];
  }

  async listBlockingReasonCodes(
    input: FundingSourcePlanningRequest,
  ): Promise<readonly FundingReasonCode[]> {
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
    return otherwiseExecutableWithoutGas ||
      this.confirmedNativeSolanaAmountConsumesReserve(input)
      ? ["insufficient_gas"]
      : [];
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
      observeRoute: async ({ route, amountBand, now }) => {
        const lookupKey = process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY?.trim();
        const keyVersion =
          positiveInt(process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION) ?? 1;
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
    return deriveProductionRelayEligibleSourceFacts({
      accountId: input.accountId,
      account: this.account,
      policy: this.currentPolicy(),
      requiredAmount: input.requiredAmount,
      confirmedSourceAmount: input.request.confirmedSourceAmount,
      destinationLocationPatternId:
        input.destination.destinationLocationPatternId,
      purpose: input.request.purpose,
      maximumSlippageBps: Math.min(
        input.request.maxSlippageBps ??
          this.currentPolicy().placement.maximumSlippageBps,
        this.currentPolicy().placement.maximumSlippageBps,
      ),
    });
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
  ): Promise<RelayPlanningQuote | null> {
    const apiKey = process.env.RELAY_API_KEY?.trim();
    const lookupKey = process.env.FUNDING_REFERENCE_LOOKUP_HMAC_KEY?.trim();
    const keyVersion =
      positiveInt(process.env.FUNDING_REFERENCE_LOOKUP_KEY_VERSION) ?? 1;
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
    const mappedRelayRoute = routeSpec(input.route);
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
        maximumSlippageBps: input.source.maximumSlippageBps,
      });
    } catch (error) {
      if (
        error instanceof RelayClientError ||
        error instanceof RelayQuoteEconomicsError
      ) {
        return null;
      }
      throw error;
    }
    if (input.signal.aborted) return null;
    const relaySteps = await validatedSteps({
      actions: quote.actions,
      minimumOutput: quote.candidate.minimumOutput,
      policyRevision: input.policyRevision,
      quoteCorrelationId: input.quoteCorrelationId,
      route: input.route,
      sourceAmount: quote.sourceAmount,
      profile,
    });
    const steps = buildPolymarketPreRouteHandoffSteps({
      source: input.source,
      sourceAmount: quote.sourceAmount,
      profile,
      steps: relaySteps,
    });
    const plan = {
      operation: {
        purpose: "add_funds" as const,
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
        walletExecutionSnapshot: jsonRecord(profile),
        placementSnapshot: {},
        requestedSourceAmount: jsonRecord(quote.sourceAmount),
        requestedDestinationAmount: jsonRecord(input.minimumOutput),
        supportMetadata: {
          routeId: input.route.routeId,
          requestFingerprint: quote.requestFingerprint,
          routeShape: quote.routeShape,
          ...(input.destination.target.kind === "owned_location" &&
          input.destination.spendability
            ? {
                destinationObservation: {
                  observerId: input.route.destinationObserverId,
                  locationId: input.destination.target.location.locationId,
                  asset: jsonRecord(input.destination.target.location.asset),
                  baselineRaw:
                    input.destination.spendability.observedAmount.raw,
                  baselineRevision: input.destination.spendability.revision,
                  baselineAsOf: input.destination.spendability.asOf,
                },
              }
            : {}),
          ...(input.source.preRouteHandoff
            ? {
                preRouteHandoff: jsonRecord(input.source.preRouteHandoff),
              }
            : {}),
        },
      },
      segments: [
        {
          providerId: "relay",
          adapterId: input.route.adapterId,
          adapterVersion: input.route.adapterVersion,
          segmentKind: quote.candidate.capability,
          status: "planned" as const,
          sourceSnapshot: jsonRecord(input.source.source),
          destinationTargetSnapshot: jsonRecord(input.destination.target),
          quotedInput: jsonRecord(quote.sourceAmount),
          quotedExpectedOutput: jsonRecord(quote.candidate.expectedOutput),
          quotedMinOutput: jsonRecord(quote.candidate.minimumOutput),
          providerQuoteRefCiphertext: codec.encrypt(quote.requestId),
          providerQuoteRefLookupHmac: codec.fingerprint(quote.requestId),
          depositAddressCiphertext: null,
          depositAddressLookupHmac: null,
          lookupKeyVersion: codec.keyVersion,
          refundLocationSnapshot: jsonRecord(sourceLocation),
          quoteExpiresAt: quote.candidate.expiresAt,
          supportMetadata: {
            requestFingerprint: quote.requestFingerprint,
            routeShape: quote.routeShape,
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
          networkId: quote.sourceAmount.asset.networkId,
          assetId: quote.sourceAmount.asset.assetId,
          assetDecimals: quote.sourceAmount.asset.decimals,
          rawAmount: quote.sourceAmount.raw,
          mode: "subtract_available" as const,
          expiresAt: quote.candidate.expiresAt,
        },
      ],
    };
    return {
      candidate: quote.candidate,
      sourceAmount: quote.sourceAmount,
      sourceEstimatedUsd: quote.sourceEstimatedUsd,
      feeUsd: quote.feeUsd.map((estimated, index) => {
        const fee = quote.candidate.fees[index];
        return estimated ?? (fee ? stableUsdValue(fee.amount) : null);
      }),
      minimumDestinationEstimatedUsd: stableUsdValue(
        quote.candidate.minimumOutput,
      ),
      executionPlan: executionPlan({ quote, route: input.route }),
      commitPlan: plan,
    };
  }
}
