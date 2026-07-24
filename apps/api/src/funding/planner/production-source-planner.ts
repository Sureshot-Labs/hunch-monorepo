import type { Pool } from "@hunch/infra";
import { ZeroAddress } from "ethers";

import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import {
  multiplyRawByUnitPrice,
  scaleUnsignedDecimalByRawRatio,
} from "../../account-value/decimal.js";
import { createRelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import {
  RelayClient,
  RelayClientError,
} from "../../funding-providers/relay/client.js";
import {
  RELAY_PINNED_ASSETS,
  RELAY_ROUTE_SPECS,
  type RelayRouteSpec,
} from "../../funding-providers/relay/mappings.js";
import { RelayWalletQuoteAdapter } from "../../funding-providers/relay/wallet-adapter.js";
import { RelayPinnedActionValidator } from "../../funding-providers/relay/action-validator.js";
import { getCredentialsEncryptionKey } from "../../lib/credentials-encryption.js";
import type {
  AssetLocation,
  AssetRef,
  FundingDiscoveryRequest,
  FundingExecutionPlan,
  JsonValue,
  Money,
  NormalizedAction,
  WalletExecutionProfile,
} from "../domain/types.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
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
      BigInt(available.availableRaw) > 0n
    );
  });
}

function isPinnedStableAsset(asset: AssetRef): boolean {
  const normalized = asset.assetId.toLowerCase();
  return (
    (asset.networkId === "evm:8453" &&
      normalized === RELAY_PINNED_ASSETS.baseUsdc) ||
    (asset.networkId === "evm:137" &&
      (normalized === RELAY_PINNED_ASSETS.polygonPusd ||
        normalized === RELAY_PINNED_ASSETS.polygonUsdc ||
        normalized === RELAY_PINNED_ASSETS.polygonUsdce)) ||
    (asset.networkId === "solana:mainnet" &&
      asset.assetId === RELAY_PINNED_ASSETS.solanaUsdc)
  );
}

function stableUsdValue(amount: Money): string | null {
  return isPinnedStableAsset(amount.asset)
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
  profile: WalletExecutionProfile;
  availableRaw: string;
  requiredAmount: Money;
  maximumSlippageBps: number;
  requiredCapability: "execution_source" | "withdrawal_source";
  suggestionPreferred: boolean;
}): RelayEligibleSourceFact[] {
  if (
    !isPinnedStableAsset(input.component.amount.asset) ||
    !isPinnedStableAsset(input.requiredAmount.asset)
  ) {
    return [];
  }
  const exactRoutes = input.policy.routes.filter(
    (route) =>
      route.enabled &&
      route.providerId === "relay" &&
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
      const raw =
        BigInt(input.availableRaw) < sourceRawWithSlippage
          ? input.availableRaw
          : sourceRawWithSlippage.toString();
      const grossDestinationRaw = rescaleStableRaw(
        raw,
        input.requiredAmount.asset.decimals,
        input.component.amount.asset.decimals,
      );
      const minimumDestinationRaw =
        (BigInt(grossDestinationRaw) *
          BigInt(10_000 - input.maximumSlippageBps)) /
        10_000n;
      const estimatedUsd =
        input.component.estimatedUsd && BigInt(input.component.amount.raw) > 0n
          ? scaleUnsignedDecimalByRawRatio({
              value: input.component.estimatedUsd.value,
              numeratorRaw: raw,
              denominatorRaw: input.component.amount.raw,
            })
          : null;
      return {
        componentId: input.component.componentId,
        sourceLocationPatternId: location.locationPatternId,
        safeLabel: `${input.component.amount.asset.networkId} wallet`,
        source: {
          kind: "owned_location" as const,
          location: input.component.location,
        },
        quoteInputAmount: {
          asset: input.component.amount.asset,
          raw,
        },
        quoteMinimumOutput: {
          asset: input.requiredAmount.asset,
          raw: minimumDestinationRaw.toString(),
        },
        maximumSourceRaw: input.availableRaw,
        estimatedUsd,
        transferable: true,
        riskEligible: true,
        walletExecutionReady:
          input.profile.signingModes.includes("web_client") ||
          input.profile.signingModes.includes("privy_authorization"),
        nativeGasReady: hasNativeGas(input.account, input.profile),
        suggestionPreferred: input.suggestionPreferred,
        freshness: "fresh" as const,
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
    const profile = profileForLocation(input.account, component.location);
    if (
      component.location.accountId !== input.accountId ||
      component.location.kind !== "wallet" ||
      component.category === "in_transit" ||
      component.observationFreshness !== "fresh" ||
      component.observationError ||
      component.valuationEligibility !== "included" ||
      !availability ||
      availability.freshness !== "fresh" ||
      BigInt(availability.availableRaw) <= 0n ||
      !profile
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
        profile,
        availableRaw: availability.availableRaw,
        requiredAmount: input.requiredAmount,
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
    return deriveProductionRelayEligibleSourceFacts({
      accountId: input.accountId,
      account: this.account,
      policy: this.currentPolicy(),
      requiredAmount: input.requiredAmount,
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
    let quote;
    try {
      quote = await adapter.quote({
        route: routeSpec(input.route),
        source: input.source.source,
        destination: input.destination.target,
        sourceAmount: input.sourceAmount,
        minimumOutput: input.minimumOutput,
        userAddress,
        recipientAddress: destinationAddress(input.destination),
        senderWalletId: profile.walletId,
        quoteCorrelationId: input.quoteCorrelationId,
        deadline: input.deadline,
      });
    } catch (error) {
      if (error instanceof RelayClientError) return null;
      throw error;
    }
    if (input.signal.aborted) return null;
    const steps = await validatedSteps({
      actions: quote.actions,
      minimumOutput: quote.candidate.minimumOutput,
      policyRevision: input.policyRevision,
      quoteCorrelationId: input.quoteCorrelationId,
      route: input.route,
      sourceAmount: input.sourceAmount,
      profile,
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
        requestedSourceAmount: jsonRecord(input.sourceAmount),
        requestedDestinationAmount: jsonRecord(input.minimumOutput),
        supportMetadata: {
          routeId: input.route.routeId,
          requestFingerprint: quote.requestFingerprint,
          routeShape: quote.routeShape,
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
          quotedInput: jsonRecord(input.sourceAmount),
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
          locationId: sourceLocation.locationId,
          networkId: input.sourceAmount.asset.networkId,
          assetId: input.sourceAmount.asset.assetId,
          assetDecimals: input.sourceAmount.asset.decimals,
          rawAmount: input.sourceAmount.raw,
          mode: "subtract_available" as const,
          expiresAt: quote.candidate.expiresAt,
        },
      ],
    };
    return {
      candidate: quote.candidate,
      feeUsd: quote.candidate.fees.map((fee) => stableUsdValue(fee.amount)),
      minimumDestinationEstimatedUsd: stableUsdValue(
        quote.candidate.minimumOutput,
      ),
      executionPlan: executionPlan({ quote, route: input.route }),
      commitPlan: plan,
    };
  }
}
