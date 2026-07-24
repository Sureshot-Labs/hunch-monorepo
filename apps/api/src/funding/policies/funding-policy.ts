import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assetRefSchema,
  canonicalIdSchema,
  opaqueIdSchema,
  usdAmountSchema,
} from "../domain/schemas.js";
import {
  LOCATION_CAPABILITIES,
  type JsonValue,
  type LocationCapability,
} from "../domain/types.js";

export const FUNDING_POLICY_KEY = "funding_control_plane";

export type FundingRegistryRuntimeKind = "production" | "fixture" | "simulator";

export type RegisteredFundingComponent = Readonly<{
  id: string;
  runtimeKind: FundingRegistryRuntimeKind;
}>;

export type RegisteredProviderAdapter = RegisteredFundingComponent &
  Readonly<{
    providerId: string;
    capabilities: readonly FundingRouteCapability[];
  }>;

export type FundingStaticRegistry = Readonly<{
  locationKinds: readonly string[];
  providerAdapters: readonly RegisteredProviderAdapter[];
  actionValidators: readonly RegisteredFundingComponent[];
  networkExecutors: readonly RegisteredFundingComponent[];
  reconcilers: readonly RegisteredFundingComponent[];
  refundSemantics: readonly RegisteredFundingComponent[];
  destinationObservers: readonly RegisteredFundingComponent[];
  fixtureIds: readonly string[];
}>;

export const PRODUCTION_FUNDING_REGISTRY: FundingStaticRegistry = deepFreeze({
  locationKinds: ["wallet", "venue_account", "in_transit_claim"],
  providerAdapters: [
    {
      id: "relay_quote_v2",
      providerId: "relay",
      runtimeKind: "production",
      capabilities: [
        "same_network_swap",
        "cross_network_transfer",
        "cross_network_swap",
      ],
    },
    {
      id: "relay_strict_deposit_address_v1",
      providerId: "relay",
      runtimeKind: "production",
      capabilities: ["deposit_address"],
    },
  ],
  actionValidators: [
    { id: "relay_evm_action_v1", runtimeKind: "production" },
    { id: "relay_svm_action_v1", runtimeKind: "production" },
  ],
  networkExecutors: [
    { id: "wallet_profile_evm_v1", runtimeKind: "production" },
    { id: "wallet_profile_svm_v1", runtimeKind: "production" },
  ],
  reconcilers: [
    { id: "relay_status_v3", runtimeKind: "production" },
    { id: "across_legacy", runtimeKind: "production" },
    { id: "bungee_legacy", runtimeKind: "production" },
    { id: "debridge_dln_legacy", runtimeKind: "production" },
    { id: "debridge_same_chain_legacy", runtimeKind: "production" },
  ],
  refundSemantics: [
    {
      id: "relay_owned_refund_observation_v1",
      runtimeKind: "production",
    },
  ],
  destinationObservers: [
    {
      id: "relay_owned_destination_observation_v1",
      runtimeKind: "production",
    },
  ],
  fixtureIds: [
    "relay_quote_v2_wallet_docs",
    "relay_wallet_evm_roundtrip_live",
    "relay_wallet_solana_roundtrip_live",
    "relay_status_lifecycle_v3",
    "relay_webhook_status_updated",
    "relay_deposit_address_strict_docs",
    "relay_deposit_address_mismatch_policy",
  ],
});

const locationCapabilitySchema = z.enum(LOCATION_CAPABILITIES);

export const fundingCreationModeSchema = z.enum(["off", "on"]);

export type FundingCreationMode = z.infer<typeof fundingCreationModeSchema>;

const fundingOperationalGatesSchema = z
  .object({
    quoteCreation: z.boolean(),
    commit: z.boolean(),
    startUnsubmittedAction: z.boolean(),
    emergencyBroadcastPause: z.boolean(),
    reconciliation: z.boolean(),
    webhookIngestion: z.boolean(),
    polling: z.boolean(),
    refunds: z.boolean(),
    recovery: z.boolean(),
    workerDrain: z.boolean(),
    withdrawalRegistration: z.boolean().default(false),
    withdrawalExecution: z.boolean().default(false),
  })
  .strict();

const fundingAssetPolicySchema = z
  .object({
    asset: assetRefSchema,
    enabled: z.boolean(),
    observationEnabled: z.boolean(),
    valuationEnabled: z.boolean(),
    pricePolicyId: canonicalIdSchema.nullable(),
  })
  .strict();

const fundingLocationPolicySchema = z
  .object({
    locationPatternId: canonicalIdSchema,
    locationKind: canonicalIdSchema,
    asset: assetRefSchema,
    ownership: z.enum(["owned", "external_recipient"]),
    observable: z.boolean(),
    capabilities: z.array(locationCapabilitySchema).max(16),
    enabled: z.boolean(),
  })
  .strict();

const venuePositionValuePolicySchema = z
  .object({
    enabled: z.boolean(),
    identityPolicyId: canonicalIdSchema.nullable(),
    freshnessMs: z.number().int().positive().nullable(),
    valuationMethodId: canonicalIdSchema.nullable(),
    deduplicationPolicyId: canonicalIdSchema.nullable(),
  })
  .strict();

const fundingVenuePolicySchema = z
  .object({
    venueId: canonicalIdSchema,
    lifecycleEnabled: z.boolean(),
    destinationReadinessEnabled: z.boolean(),
    balanceEnabled: z.boolean(),
    fundingEnabled: z.boolean(),
    tradingEnabled: z.boolean(),
    withdrawalEnabled: z.boolean(),
    delegatedExecutionEnabled: z.boolean(),
    delegatedPolicyIds: z.array(canonicalIdSchema).max(32),
    delegatedDailyCapUsd: usdAmountSchema.nullable(),
    positionValue: venuePositionValuePolicySchema,
  })
  .strict();

export const FUNDING_ROUTE_CAPABILITIES = [
  "same_network_swap",
  "cross_network_transfer",
  "cross_network_swap",
  "deposit_address",
] as const;

export type FundingRouteCapability =
  (typeof FUNDING_ROUTE_CAPABILITIES)[number];

const fundingProviderPolicySchema = z
  .object({
    providerId: canonicalIdSchema,
    enabledCapabilities: z.array(z.enum(FUNDING_ROUTE_CAPABILITIES)).max(8),
  })
  .strict();

const depositAddressPolicySchema = z
  .object({
    mode: z.enum(["strict", "open"]),
    senderKinds: z.array(
      z.enum(["controlled_wallet", "exchange", "privy", "manual"]),
    ),
    refundOwnership: z.enum(["user_owned", "app_controlled"]),
    refundLocationPatternId: canonicalIdSchema.nullable(),
    transferObserverId: canonicalIdSchema.nullable(),
    requestTracking: z.enum(["request_only", "request_and_children"]),
    wrongAssetRecoveryPolicyId: canonicalIdSchema.nullable(),
    privyIngressAllowed: z.boolean(),
  })
  .strict();

const fundingRoutePolicySchema = z
  .object({
    routeId: canonicalIdSchema,
    enabled: z.boolean(),
    providerId: canonicalIdSchema,
    capability: z.enum(FUNDING_ROUTE_CAPABILITIES),
    adapterId: canonicalIdSchema,
    adapterVersion: z.number().int().positive(),
    sourceLocationPatternId: canonicalIdSchema,
    destinationLocationPatternId: canonicalIdSchema,
    sourceAsset: assetRefSchema,
    destinationAsset: assetRefSchema,
    fixtureIds: z.array(canonicalIdSchema).max(64),
    actionValidatorId: canonicalIdSchema,
    networkExecutorId: canonicalIdSchema,
    reconcilerId: canonicalIdSchema,
    refundSemanticsId: canonicalIdSchema,
    destinationObserverId: canonicalIdSchema,
    experienceMode: z.enum(["prepare_first", "inline"]),
    measuredObservationCount: z.number().int().min(0),
    minimumInlineObservationCount: z.number().int().positive(),
    fallbackKind: z
      .enum([
        "across_swap_api",
        "debridge_same_chain",
        "across_suggested_fees",
        "debridge_dln_cross_chain",
      ])
      .nullable(),
    depositAddress: depositAddressPolicySchema.nullable(),
  })
  .strict();

const privyFundingMethodPolicySchema = z
  .object({
    methodId: canonicalIdSchema,
    enabled: z.boolean(),
    locallyConfigured: z.boolean(),
    destinationLocationPatternId: canonicalIdSchema,
    asset: assetRefSchema,
  })
  .strict();

const walletPreparationCapabilitySchema = z
  .object({
    capabilityId: canonicalIdSchema,
    venueId: canonicalIdSchema,
    purpose: z.enum(["fund", "buy", "sell", "redeem", "withdraw"]),
    readinessClass: z.enum([
      "internal_managed",
      "external_ready",
      "external_setup_available",
      "external_source_only",
      "external_view_only",
    ]),
    signerPath: z
      .enum(["web_client", "privy_authorization", "privy_delegated"])
      .nullable(),
    selectable: z.boolean(),
    enabled: z.boolean(),
  })
  .strict();

const positionActionCapabilitySchema = z
  .object({
    capabilityId: canonicalIdSchema,
    venueId: canonicalIdSchema,
    action: z.enum(["sell", "redeem"]),
    enabled: z.boolean(),
    ownerBindingRequired: z.boolean(),
  })
  .strict();

export const fundingRuntimePolicySchema = z
  .object({
    version: z.literal(1),
    creationMode: fundingCreationModeSchema,
    gates: fundingOperationalGatesSchema,
    headline: z
      .object({
        mode: z.enum(["liquid_only", "liquid_plus_positions"]),
        userOverrideEnabled: z.boolean(),
        referencedByExecutableLiquidity: z.boolean(),
      })
      .strict(),
    tradingWallet: z
      .object({
        selectionScope: z.literal("current_intent"),
        rememberedSelectionEnabled: z.boolean(),
      })
      .strict(),
    automation: z
      .object({
        automaticRebalance: z.boolean(),
        stagedContinuation: z.boolean(),
      })
      .strict(),
    placement: z
      .object({
        requireExplicitNoTradeDestinationSelection: z.boolean(),
        maximumBufferBps: z.number().int().min(0).max(10_000),
        maximumBufferUsd: usdAmountSchema.default("0"),
        maximumSlippageBps: z.number().int().min(0).max(500),
        maximumFeeUsd: usdAmountSchema,
        maximumFeeBps: z.number().int().min(0).max(10_000).default(2_000),
        warningFeeUsd: usdAmountSchema.default("5"),
        warningFeeBps: z.number().int().min(0).max(10_000).default(1_000),
        minimumDestinationUsd: usdAmountSchema.default("1"),
      })
      .strict(),
    routeExperience: z
      .object({
        maximumInlineP95Ms: z.number().int().positive(),
        minimumInlineSuccessBps: z.number().int().min(0).max(10_000),
        minimumInlineObservationCount: z.number().int().positive(),
      })
      .strict()
      .default({
        maximumInlineP95Ms: 45_000,
        minimumInlineSuccessBps: 9_500,
        minimumInlineObservationCount: 20,
      }),
    ttl: z
      .object({
        collectorMs: z.number().int().positive(),
        priceMs: z.number().int().positive(),
        quoteMs: z.number().int().positive(),
        pollingMs: z.number().int().positive(),
        reservationMs: z.number().int().positive(),
      })
      .strict(),
    assets: z.array(fundingAssetPolicySchema).max(256),
    locations: z.array(fundingLocationPolicySchema).max(256),
    venues: z.array(fundingVenuePolicySchema).max(64),
    providers: z.array(fundingProviderPolicySchema).max(32),
    routes: z.array(fundingRoutePolicySchema).max(256),
    privyFundingMethods: z.array(privyFundingMethodPolicySchema).max(64),
    walletPreparation: z.array(walletPreparationCapabilitySchema).max(256),
    positionActions: z.array(positionActionCapabilitySchema).max(128),
    genericAddFundsRecommendationOrder: z.array(canonicalIdSchema).max(64),
  })
  .strict();

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type FundingRuntimePolicy = DeepReadonly<
  z.infer<typeof fundingRuntimePolicySchema>
>;

export const DEFAULT_FUNDING_RUNTIME_POLICY: FundingRuntimePolicy = deepFreeze({
  version: 1,
  creationMode: "off",
  gates: {
    quoteCreation: false,
    commit: false,
    startUnsubmittedAction: false,
    emergencyBroadcastPause: false,
    reconciliation: true,
    webhookIngestion: true,
    polling: true,
    refunds: true,
    recovery: true,
    workerDrain: true,
    withdrawalRegistration: false,
    withdrawalExecution: false,
  },
  headline: {
    mode: "liquid_only",
    userOverrideEnabled: false,
    referencedByExecutableLiquidity: false,
  },
  tradingWallet: {
    selectionScope: "current_intent",
    rememberedSelectionEnabled: false,
  },
  automation: {
    automaticRebalance: false,
    stagedContinuation: false,
  },
  placement: {
    requireExplicitNoTradeDestinationSelection: true,
    maximumBufferBps: 0,
    maximumBufferUsd: "0",
    maximumSlippageBps: 100,
    maximumFeeUsd: "10",
    maximumFeeBps: 2_000,
    warningFeeUsd: "5",
    warningFeeBps: 1_000,
    minimumDestinationUsd: "1",
  },
  routeExperience: {
    maximumInlineP95Ms: 45_000,
    minimumInlineSuccessBps: 9_500,
    minimumInlineObservationCount: 20,
  },
  ttl: {
    collectorMs: 60_000,
    priceMs: 60_000,
    quoteMs: 30_000,
    pollingMs: 15_000,
    reservationMs: 300_000,
  },
  assets: [],
  locations: [],
  venues: [],
  providers: [],
  routes: [],
  privyFundingMethods: [],
  walletPreparation: [],
  positionActions: [],
  genericAddFundsRecommendationOrder: [],
});

export type FundingPolicyValidationIssueCode =
  | "schema_invalid"
  | "duplicate_id"
  | "asset_price_policy_required"
  | "location_kind_unregistered"
  | "location_asset_unregistered"
  | "capability_requires_owned_observable_location"
  | "venue_position_policy_incomplete"
  | "forbidden_venue_active"
  | "venue_funding_dependency_missing"
  | "delegated_policy_incomplete"
  | "provider_capability_disabled"
  | "provider_adapter_unregistered"
  | "fixture_adapter_forbidden"
  | "route_dependency_missing"
  | "route_fixture_missing"
  | "route_location_missing"
  | "route_asset_mismatch"
  | "inline_evidence_missing"
  | "deposit_address_policy_invalid"
  | "deprecated_fallback_forbidden"
  | "privy_funding_method_unconfigured"
  | "preparation_signer_missing"
  | "position_owner_binding_required"
  | "automatic_rebalance_forbidden"
  | "staged_continuation_forbidden"
  | "headline_execution_coupling_forbidden"
  | "headline_override_forbidden"
  | "remembered_wallet_forbidden"
  | "explicit_destination_selection_required"
  | "creation_gate_mismatch"
  | "evidence_gate_must_remain_open";

export type FundingPolicyValidationIssue = Readonly<{
  code: FundingPolicyValidationIssueCode;
  path: string;
  message: string;
}>;

export type FundingPolicyValidationResult =
  | Readonly<{
      ok: true;
      policy: FundingRuntimePolicy;
      issues: readonly [];
    }>
  | Readonly<{
      ok: false;
      policy: null;
      issues: readonly FundingPolicyValidationIssue[];
    }>;

function assetKey(asset: {
  networkId: string;
  assetId: string;
  decimals: number;
}): string {
  return `${asset.networkId}:${asset.assetId}:${asset.decimals}`;
}

function componentById(
  components: readonly RegisteredFundingComponent[],
  id: string,
): RegisteredFundingComponent | undefined {
  return components.find((component) => component.id === id);
}

function duplicateIssues(
  values: readonly string[],
  path: string,
): FundingPolicyValidationIssue[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].map((value) => ({
    code: "duplicate_id",
    path,
    message: `duplicate identifier: ${value}`,
  }));
}

function addIssue(
  issues: FundingPolicyValidationIssue[],
  code: FundingPolicyValidationIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function validateParsedFundingPolicy(
  policy: FundingRuntimePolicy,
  registry: FundingStaticRegistry,
): FundingPolicyValidationIssue[] {
  const issues: FundingPolicyValidationIssue[] = [];
  issues.push(
    ...duplicateIssues(
      policy.assets.map(({ asset }) => assetKey(asset)),
      "assets",
    ),
    ...duplicateIssues(
      policy.locations.map(({ locationPatternId }) => locationPatternId),
      "locations",
    ),
    ...duplicateIssues(
      policy.venues.map(({ venueId }) => venueId),
      "venues",
    ),
    ...duplicateIssues(
      policy.providers.map(({ providerId }) => providerId),
      "providers",
    ),
    ...duplicateIssues(
      policy.routes.map(({ routeId }) => routeId),
      "routes",
    ),
    ...duplicateIssues(
      policy.routes
        .filter(
          (route) =>
            route.enabled &&
            route.providerId === "relay" &&
            route.capability !== "deposit_address",
        )
        .map((route) =>
          [
            route.sourceLocationPatternId,
            route.destinationLocationPatternId,
            assetKey(route.sourceAsset),
            assetKey(route.destinationAsset),
          ].join("|"),
        ),
      "routes.exactWalletMapping",
    ),
    ...duplicateIssues(
      policy.privyFundingMethods.map(({ methodId }) => methodId),
      "privyFundingMethods",
    ),
    ...duplicateIssues(
      policy.walletPreparation.map(({ capabilityId }) => capabilityId),
      "walletPreparation",
    ),
    ...duplicateIssues(
      policy.positionActions.map(({ capabilityId }) => capabilityId),
      "positionActions",
    ),
  );

  const assets = new Map(
    policy.assets.map((asset) => [assetKey(asset.asset), asset]),
  );
  const locations = new Map(
    policy.locations.map((location) => [location.locationPatternId, location]),
  );
  const venues = new Map(policy.venues.map((venue) => [venue.venueId, venue]));
  const providers = new Map(
    policy.providers.map((provider) => [provider.providerId, provider]),
  );

  for (const [index, asset] of policy.assets.entries()) {
    if (asset.enabled && asset.valuationEnabled && !asset.pricePolicyId) {
      addIssue(
        issues,
        "asset_price_policy_required",
        `assets.${index}.pricePolicyId`,
        "valued asset requires an exact price policy",
      );
    }
  }

  for (const [index, location] of policy.locations.entries()) {
    if (!registry.locationKinds.includes(location.locationKind)) {
      addIssue(
        issues,
        "location_kind_unregistered",
        `locations.${index}.locationKind`,
        "location kind is not present in the static registry",
      );
    }
    if (!assets.has(assetKey(location.asset))) {
      addIssue(
        issues,
        "location_asset_unregistered",
        `locations.${index}.asset`,
        "location asset is not registered",
      );
    }
    const sensitiveCapabilities: readonly LocationCapability[] = [
      "venue_settlement",
      "intermediate",
      "withdrawal_source",
    ];
    if (
      location.enabled &&
      location.capabilities.some((capability) =>
        sensitiveCapabilities.includes(capability),
      ) &&
      (location.ownership !== "owned" || !location.observable)
    ) {
      addIssue(
        issues,
        "capability_requires_owned_observable_location",
        `locations.${index}.capabilities`,
        "settlement/intermediate locations must be owned and observable",
      );
    }
  }

  for (const [index, venue] of policy.venues.entries()) {
    const position = venue.positionValue;
    if (
      position.enabled &&
      (!position.identityPolicyId ||
        !position.freshnessMs ||
        !position.valuationMethodId ||
        !position.deduplicationPolicyId)
    ) {
      addIssue(
        issues,
        "venue_position_policy_incomplete",
        `venues.${index}.positionValue`,
        "position valuation requires identity, freshness, method, and deduplication",
      );
    }
    if (
      ["kalshi", "dflow", "hyperliquid"].includes(venue.venueId) &&
      (venue.lifecycleEnabled ||
        venue.fundingEnabled ||
        venue.tradingEnabled ||
        venue.withdrawalEnabled ||
        venue.delegatedExecutionEnabled)
    ) {
      addIssue(
        issues,
        "forbidden_venue_active",
        `venues.${index}`,
        "exit-only/future venue cannot enter the active funding registry",
      );
    }
    if (
      venue.fundingEnabled &&
      (!venue.lifecycleEnabled || !venue.destinationReadinessEnabled)
    ) {
      addIssue(
        issues,
        "venue_funding_dependency_missing",
        `venues.${index}.fundingEnabled`,
        "venue funding requires lifecycle and destination readiness",
      );
    }
    if (
      venue.delegatedExecutionEnabled &&
      (venue.delegatedPolicyIds.length === 0 || !venue.delegatedDailyCapUsd)
    ) {
      addIssue(
        issues,
        "delegated_policy_incomplete",
        `venues.${index}.delegatedExecutionEnabled`,
        "delegated execution requires exact policy IDs and a cap",
      );
    }
  }

  for (const [index, route] of policy.routes.entries()) {
    if (!route.enabled) continue;
    const providerPolicy = providers.get(route.providerId);
    if (!providerPolicy?.enabledCapabilities.includes(route.capability)) {
      addIssue(
        issues,
        "provider_capability_disabled",
        `routes.${index}.capability`,
        "route capability must be independently enabled for its provider",
      );
    }

    const adapter = registry.providerAdapters.find(
      (candidate) =>
        candidate.id === route.adapterId &&
        candidate.providerId === route.providerId &&
        candidate.capabilities.includes(route.capability),
    );
    if (!adapter) {
      addIssue(
        issues,
        "provider_adapter_unregistered",
        `routes.${index}.adapterId`,
        "route adapter/capability is not registered",
      );
    } else if (adapter.runtimeKind !== "production") {
      addIssue(
        issues,
        "fixture_adapter_forbidden",
        `routes.${index}.adapterId`,
        "fixture and simulator adapters cannot be published",
      );
    }

    const dependencies: Array<
      readonly [string, readonly RegisteredFundingComponent[], string]
    > = [
      [route.actionValidatorId, registry.actionValidators, "actionValidatorId"],
      [route.networkExecutorId, registry.networkExecutors, "networkExecutorId"],
      [route.reconcilerId, registry.reconcilers, "reconcilerId"],
      [route.refundSemanticsId, registry.refundSemantics, "refundSemanticsId"],
      [
        route.destinationObserverId,
        registry.destinationObservers,
        "destinationObserverId",
      ],
    ];
    for (const [id, components, field] of dependencies) {
      const component = componentById(components, id);
      if (!component || component.runtimeKind !== "production") {
        addIssue(
          issues,
          component ? "fixture_adapter_forbidden" : "route_dependency_missing",
          `routes.${index}.${field}`,
          "enabled route dependency must be registered for production",
        );
      }
    }

    if (
      route.fixtureIds.length === 0 ||
      route.fixtureIds.some(
        (fixtureId) => !registry.fixtureIds.includes(fixtureId),
      )
    ) {
      addIssue(
        issues,
        "route_fixture_missing",
        `routes.${index}.fixtureIds`,
        "enabled route requires pinned registered fixtures",
      );
    }

    const sourceLocation = locations.get(route.sourceLocationPatternId);
    const destinationLocation = locations.get(
      route.destinationLocationPatternId,
    );
    if (!sourceLocation || !destinationLocation) {
      addIssue(
        issues,
        "route_location_missing",
        `routes.${index}`,
        "route source and destination patterns must be registered",
      );
    } else {
      if (
        !sourceLocation.enabled ||
        !sourceLocation.capabilities.includes("execution_source") ||
        !destinationLocation.enabled ||
        !destinationLocation.observable ||
        !destinationLocation.capabilities.includes("observe")
      ) {
        addIssue(
          issues,
          "route_dependency_missing",
          `routes.${index}`,
          "enabled route requires an enabled executable source and observable destination",
        );
      }
      if (assetKey(sourceLocation.asset) !== assetKey(route.sourceAsset)) {
        addIssue(
          issues,
          "route_asset_mismatch",
          `routes.${index}.sourceAsset`,
          "route source asset must match its location pattern",
        );
      }
      if (
        assetKey(destinationLocation.asset) !== assetKey(route.destinationAsset)
      ) {
        addIssue(
          issues,
          "route_asset_mismatch",
          `routes.${index}.destinationAsset`,
          "route destination asset must match its location pattern",
        );
      }
    }

    if (
      route.experienceMode === "inline" &&
      route.measuredObservationCount <
        Math.max(
          route.minimumInlineObservationCount,
          policy.routeExperience.minimumInlineObservationCount,
        )
    ) {
      addIssue(
        issues,
        "inline_evidence_missing",
        `routes.${index}.experienceMode`,
        "inline route lacks measured observations",
      );
    }

    if (
      route.fallbackKind === "across_suggested_fees" ||
      route.fallbackKind === "debridge_dln_cross_chain"
    ) {
      addIssue(
        issues,
        "deprecated_fallback_forbidden",
        `routes.${index}.fallbackKind`,
        "deprecated fallback cannot create a new funding operation",
      );
    }

    if (route.capability === "deposit_address") {
      const deposit = route.depositAddress;
      const refundLocation = deposit?.refundLocationPatternId
        ? locations.get(deposit.refundLocationPatternId)
        : undefined;
      const transferObserver = deposit?.transferObserverId
        ? componentById(
            registry.destinationObservers,
            deposit.transferObserverId,
          )
        : undefined;
      const valid =
        deposit?.mode === "strict" &&
        deposit.senderKinds.length > 0 &&
        deposit.senderKinds.every((kind) => kind === "controlled_wallet") &&
        deposit.refundOwnership === "user_owned" &&
        refundLocation?.ownership === "owned" &&
        refundLocation.observable &&
        refundLocation.capabilities.includes("observe") &&
        transferObserver?.runtimeKind === "production" &&
        deposit.requestTracking === "request_and_children" &&
        Boolean(deposit.wrongAssetRecoveryPolicyId) &&
        !deposit.privyIngressAllowed;
      if (!valid) {
        addIssue(
          issues,
          "deposit_address_policy_invalid",
          `routes.${index}.depositAddress`,
          "initial deposit-address route must be strict, controlled, observable, child-tracked, and user-refunded",
        );
      }
    } else if (route.depositAddress) {
      addIssue(
        issues,
        "deposit_address_policy_invalid",
        `routes.${index}.depositAddress`,
        "deposit-address policy is valid only for deposit-address capability",
      );
    }
  }

  for (const [index, method] of policy.privyFundingMethods.entries()) {
    const destination = locations.get(method.destinationLocationPatternId);
    if (
      method.enabled &&
      (!method.locallyConfigured ||
        !destination ||
        !destination.enabled ||
        destination.ownership !== "owned" ||
        !destination.observable ||
        !destination.capabilities.includes("observe") ||
        assetKey(destination.asset) !== assetKey(method.asset))
    ) {
      addIssue(
        issues,
        "privy_funding_method_unconfigured",
        `privyFundingMethods.${index}`,
        "enabled Privy method requires local configuration and exact destination",
      );
    }
  }

  for (const [index, preparation] of policy.walletPreparation.entries()) {
    if (
      preparation.enabled &&
      preparation.selectable &&
      preparation.readinessClass.startsWith("external_") &&
      preparation.readinessClass !== "external_source_only" &&
      preparation.readinessClass !== "external_view_only" &&
      !preparation.signerPath
    ) {
      addIssue(
        issues,
        "preparation_signer_missing",
        `walletPreparation.${index}.signerPath`,
        "selectable external binding requires an exact signer path",
      );
    }
    if (
      preparation.selectable &&
      (preparation.readinessClass === "external_source_only" ||
        preparation.readinessClass === "external_view_only")
    ) {
      addIssue(
        issues,
        "preparation_signer_missing",
        `walletPreparation.${index}.selectable`,
        "source-only and view-only bindings cannot be Trading Wallet options",
      );
    }
    if (!venues.has(preparation.venueId)) {
      addIssue(
        issues,
        "venue_funding_dependency_missing",
        `walletPreparation.${index}.venueId`,
        "wallet preparation venue is not registered",
      );
    }
  }

  for (const [index, action] of policy.positionActions.entries()) {
    if (action.enabled && !action.ownerBindingRequired) {
      addIssue(
        issues,
        "position_owner_binding_required",
        `positionActions.${index}.ownerBindingRequired`,
        "sell/redeem must use the proved position owner binding",
      );
    }
  }

  if (policy.automation.automaticRebalance) {
    addIssue(
      issues,
      "automatic_rebalance_forbidden",
      "automation.automaticRebalance",
      "automatic rebalance is not part of the initial product",
    );
  }
  if (policy.automation.stagedContinuation) {
    addIssue(
      issues,
      "staged_continuation_forbidden",
      "automation.stagedContinuation",
      "two-segment staged continuation is disabled initially",
    );
  }
  if (policy.headline.referencedByExecutableLiquidity) {
    addIssue(
      issues,
      "headline_execution_coupling_forbidden",
      "headline.referencedByExecutableLiquidity",
      "display headline cannot authorize executable liquidity",
    );
  }
  if (policy.headline.userOverrideEnabled) {
    addIssue(
      issues,
      "headline_override_forbidden",
      "headline.userOverrideEnabled",
      "initial policy does not expose a headline mode override",
    );
  }
  if (policy.tradingWallet.rememberedSelectionEnabled) {
    addIssue(
      issues,
      "remembered_wallet_forbidden",
      "tradingWallet.rememberedSelectionEnabled",
      "initial Trading Wallet scope is current intent only",
    );
  }
  if (!policy.placement.requireExplicitNoTradeDestinationSelection) {
    addIssue(
      issues,
      "explicit_destination_selection_required",
      "placement.requireExplicitNoTradeDestinationSelection",
      "multi-destination Add Funds requires an opaque explicit selection",
    );
  }

  const creationEnabled = policy.creationMode !== "off";
  if (
    !creationEnabled &&
    (policy.gates.quoteCreation ||
      policy.gates.commit ||
      policy.gates.startUnsubmittedAction)
  ) {
    addIssue(
      issues,
      "creation_gate_mismatch",
      "gates",
      "creation mode off must block quote, commit, and unsubmitted actions",
    );
  }
  if (
    !policy.gates.reconciliation ||
    !policy.gates.webhookIngestion ||
    !policy.gates.polling ||
    !policy.gates.refunds ||
    !policy.gates.recovery ||
    !policy.gates.workerDrain
  ) {
    addIssue(
      issues,
      "evidence_gate_must_remain_open",
      "gates",
      "financial evidence, reconciliation, refund, recovery, and drain gates cannot be disabled",
    );
  }

  return issues;
}

export function validateFundingRuntimePolicy(
  input: unknown,
  registry: FundingStaticRegistry = PRODUCTION_FUNDING_REGISTRY,
): FundingPolicyValidationResult {
  const parsed = fundingRuntimePolicySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      policy: null,
      issues: parsed.error.issues.map((issue) => ({
        code: "schema_invalid",
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }
  const policy = deepFreeze(parsed.data);
  const issues = validateParsedFundingPolicy(policy, registry);
  if (issues.length > 0) return { ok: false, policy: null, issues };
  return { ok: true, policy, issues: [] };
}

export type FundingPolicyGate =
  | "quote_creation"
  | "commit"
  | "start_unsubmitted_action"
  | "reconciliation"
  | "webhook_ingestion"
  | "polling"
  | "refund"
  | "recovery"
  | "worker_drain";

export function isFundingPolicyGateOpen(
  policy: FundingRuntimePolicy,
  gate: FundingPolicyGate,
): boolean {
  switch (gate) {
    case "quote_creation":
      return policy.creationMode !== "off" && policy.gates.quoteCreation;
    case "commit":
      return policy.creationMode !== "off" && policy.gates.commit;
    case "start_unsubmitted_action":
      return (
        policy.creationMode !== "off" &&
        policy.gates.startUnsubmittedAction &&
        !policy.gates.emergencyBroadcastPause
      );
    case "reconciliation":
      return policy.gates.reconciliation;
    case "webhook_ingestion":
      return policy.gates.webhookIngestion;
    case "polling":
      return policy.gates.polling;
    case "refund":
      return policy.gates.refunds;
    case "recovery":
      return policy.gates.recovery;
    case "worker_drain":
      return policy.gates.workerDrain;
  }
}

function canonicalize(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  throw new Error("policy contains a non-JSON value");
}

export function fundingPolicyRevision(policy: FundingRuntimePolicy): string {
  const canonical = JSON.stringify(canonicalize(policy));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export type FundingPolicyDiffEntry = Readonly<{
  path: string;
  before: JsonValue | undefined;
  after: JsonValue | undefined;
}>;

function diffJson(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path: string,
  output: FundingPolicyDiffEntry[],
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const beforeObject =
    before !== null && typeof before === "object" && !Array.isArray(before);
  const afterObject =
    after !== null && typeof after === "object" && !Array.isArray(after);
  if (beforeObject && afterObject) {
    const beforeRecord = before as Readonly<Record<string, JsonValue>>;
    const afterRecord = after as Readonly<Record<string, JsonValue>>;
    const keys = new Set([
      ...Object.keys(beforeRecord),
      ...Object.keys(afterRecord),
    ]);
    for (const key of [...keys].sort()) {
      diffJson(
        beforeRecord[key],
        afterRecord[key],
        path ? `${path}.${key}` : key,
        output,
      );
    }
    return;
  }
  output.push({ path, before, after });
}

export function diffFundingPolicies(
  before: FundingRuntimePolicy,
  after: FundingRuntimePolicy,
): readonly FundingPolicyDiffEntry[] {
  const output: FundingPolicyDiffEntry[] = [];
  diffJson(canonicalize(before), canonicalize(after), "", output);
  return output;
}

export function fundingPolicyPublishConfirmation(input: {
  currentRevision: string;
  candidateRevision: string;
}): string {
  return `PUBLISH FUNDING POLICY ${input.currentRevision} -> ${input.candidateRevision}`;
}

export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

export function createFundingStaticRegistry(input: {
  locationKinds?: readonly string[];
  providerAdapters?: readonly RegisteredProviderAdapter[];
  actionValidators?: readonly RegisteredFundingComponent[];
  networkExecutors?: readonly RegisteredFundingComponent[];
  reconcilers?: readonly RegisteredFundingComponent[];
  refundSemantics?: readonly RegisteredFundingComponent[];
  destinationObservers?: readonly RegisteredFundingComponent[];
  fixtureIds?: readonly string[];
}): FundingStaticRegistry {
  return deepFreeze({
    locationKinds: input.locationKinds ?? [],
    providerAdapters: input.providerAdapters ?? [],
    actionValidators: input.actionValidators ?? [],
    networkExecutors: input.networkExecutors ?? [],
    reconcilers: input.reconcilers ?? [],
    refundSemantics: input.refundSemantics ?? [],
    destinationObservers: input.destinationObservers ?? [],
    fixtureIds: input.fixtureIds ?? [],
  });
}

export const fundingPolicyDraftSchema = z.object({
  candidate: z.unknown(),
});

export const fundingPolicyPublishSchema = z
  .object({
    candidate: z.unknown(),
    expectedCurrentRevision: z.string().min(8).max(96),
    candidateRevision: z.string().min(8).max(96),
    confirmation: z.string().min(16).max(320),
    requestId: opaqueIdSchema,
  })
  .strict();
