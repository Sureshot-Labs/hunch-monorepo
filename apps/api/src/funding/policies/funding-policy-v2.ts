import { z } from "zod";

import {
  RELAY_PINNED_ASSETS,
  RELAY_ROUTE_SPECS,
  relayRouteCapability,
  relayRuntimeRoute,
  relayWalletLocationPatternId,
  type RelayRouteSpec,
} from "../../funding-providers/relay/mappings.js";
import { sameAsset } from "../domain/asset-identity.js";
import type { AssetRef, FundingDestinationOption } from "../domain/types.js";
import { supportsCanonicalFundingReceiveEvents } from "../receive/canonical-receive-capabilities.js";
import { usdAmountSchema } from "../domain/schemas.js";
import {
  DEFAULT_FUNDING_RUNTIME_POLICY,
  deepFreeze,
  validateEffectiveFundingRuntime,
  type FundingPolicyValidationIssue,
  type FundingRuntimePolicy,
} from "./funding-policy.js";
import { POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID } from "../execution/delegated-funding-profile-ids.js";
import { RELAY_EVM_FUNDING_PROFILE_SPECS } from "../execution/relay-evm-profile-specs.js";

export const FUNDING_VENUE_IDS = deepFreeze([
  "polymarket",
  "limitless",
] as const);
export const FUNDING_RECEIVE_ASSET_IDS = deepFreeze([
  "polygon:pusd",
  "polygon:usdc",
  "polygon:usdce",
  "base:usdc",
  "solana:usdc",
  "solana:sol",
] as const);

export type FundingVenueId = (typeof FUNDING_VENUE_IDS)[number];
export type FundingReceiveAssetId = (typeof FUNDING_RECEIVE_ASSET_IDS)[number];

const venueIdSchema = z.enum(FUNDING_VENUE_IDS);
const receiveAssetIdSchema = z.enum(FUNDING_RECEIVE_ASSET_IDS);

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

function schemaValidationIssues(
  error: z.ZodError,
): FundingPolicyValidationIssue[] {
  return error.issues.map((issue) => ({
    code: "schema_invalid",
    path: issue.path.join("."),
    message: issue.message,
  }));
}

const rawFundingIntentPolicySchema = z
  .object({
    version: z.literal(2),
    venues: z.array(venueIdSchema).max(64),
    receive: z
      .object({
        assets: z.array(receiveAssetIdSchema).max(32),
        delegatedRelayEvmDailyCapUsd: usdAmountSchema.optional(),
        privy: z.boolean(),
      })
      .strict(),
    paused: z.boolean(),
  })
  .strict();

export const fundingIntentPolicySchema = rawFundingIntentPolicySchema.transform(
  (input) => {
    return {
      version: 2 as const,
      venues: unique(input.venues),
      receive: {
        assets: unique(input.receive.assets),
        ...(input.receive.delegatedRelayEvmDailyCapUsd
          ? {
              delegatedRelayEvmDailyCapUsd:
                input.receive.delegatedRelayEvmDailyCapUsd,
            }
          : {}),
        privy: input.receive.privy,
      },
      paused: input.paused,
    };
  },
);

export type FundingIntentPolicy = Readonly<
  z.output<typeof fundingIntentPolicySchema>
>;

export const fundingIntentPatchSchema = z
  .object({
    venues: z.array(venueIdSchema).max(64).optional(),
    receive: z
      .object({
        assets: z.array(receiveAssetIdSchema).max(32).optional(),
        delegatedRelayEvmDailyCapUsd: usdAmountSchema.nullable().optional(),
        privy: z.boolean().optional(),
      })
      .strict()
      .optional(),
    paused: z.boolean().optional(),
  })
  .strict();

export type FundingIntentPatch = Readonly<
  z.infer<typeof fundingIntentPatchSchema>
>;

export const DEFAULT_FUNDING_INTENT_POLICY: FundingIntentPolicy = deepFreeze({
  version: 2,
  venues: [],
  receive: { assets: [], privy: false },
  paused: false,
});

type CatalogAsset = Readonly<{
  asset: AssetRef;
  pricePolicyId: string | null;
  valuationEnabled: boolean;
  walletLocationPatternId: string;
  walletCapabilities: readonly ("observe" | "value" | "execution_source")[];
}>;

function walletLocationPatternId(asset: AssetRef): string {
  const locationPatternId = relayWalletLocationPatternId(asset);
  if (!locationPatternId) {
    throw new Error("funding asset lacks a code-owned wallet location");
  }
  return locationPatternId;
}

const stableAsset = (asset: AssetRef): CatalogAsset => ({
  asset,
  pricePolicyId: "exact-stable-policy-v1",
  valuationEnabled: true,
  walletLocationPatternId: walletLocationPatternId(asset),
  walletCapabilities: ["observe", "value", "execution_source"],
});

const FUNDING_ASSET_CATALOG: Readonly<
  Record<FundingReceiveAssetId, CatalogAsset>
> = deepFreeze({
  "polygon:pusd": stableAsset({
    networkId: "evm:137",
    assetId: RELAY_PINNED_ASSETS.polygonPusd,
    decimals: 6,
  }),
  "polygon:usdc": stableAsset({
    networkId: "evm:137",
    assetId: RELAY_PINNED_ASSETS.polygonUsdc,
    decimals: 6,
  }),
  "polygon:usdce": stableAsset({
    networkId: "evm:137",
    assetId: RELAY_PINNED_ASSETS.polygonUsdce,
    decimals: 6,
  }),
  "base:usdc": stableAsset({
    networkId: "evm:8453",
    assetId: RELAY_PINNED_ASSETS.baseUsdc,
    decimals: 6,
  }),
  "solana:usdc": stableAsset({
    networkId: "solana:mainnet",
    assetId: RELAY_PINNED_ASSETS.solanaUsdc,
    decimals: 6,
  }),
  "solana:sol": {
    asset: {
      networkId: "solana:mainnet",
      assetId: RELAY_PINNED_ASSETS.solanaNative,
      decimals: 9,
    },
    pricePolicyId: null,
    valuationEnabled: false,
    walletLocationPatternId: walletLocationPatternId({
      networkId: "solana:mainnet",
      assetId: RELAY_PINNED_ASSETS.solanaNative,
      decimals: 9,
    }),
    walletCapabilities: ["observe", "value", "execution_source"],
  },
});

type CatalogVenue = Readonly<{
  settlementAsset: FundingReceiveAssetId;
  settlementLocationPatternId: string;
  directReceiveAssets: readonly FundingReceiveAssetId[];
  privyMethodId: string;
}>;

const FUNDING_VENUE_CATALOG: Readonly<Record<FundingVenueId, CatalogVenue>> =
  deepFreeze({
    polymarket: {
      settlementAsset: "polygon:pusd",
      settlementLocationPatternId: "polymarket-venue-cash-v1",
      directReceiveAssets: ["polygon:pusd", "polygon:usdce"],
      privyMethodId: "privy-polymarket-pusd-v1",
    },
    limitless: {
      settlementAsset: "base:usdc",
      settlementLocationPatternId: "limitless-venue-cash-v1",
      directReceiveAssets: ["base:usdc"],
      privyMethodId: "privy-limitless-usdc-v1",
    },
  });

type CatalogRoute = Readonly<{
  spec: RelayRouteSpec;
  sourceAsset: FundingReceiveAssetId;
  destinationAsset: FundingReceiveAssetId;
  sourceLocationPatternId: string;
  destinationLocationPatternId: string;
  targetVenue: FundingVenueId;
}>;

const FUNDING_ROUTE_CATALOG: readonly CatalogRoute[] = deepFreeze([
  ...Object.values(RELAY_ROUTE_SPECS).flatMap((spec): CatalogRoute[] => {
    const sourceAsset = FUNDING_RECEIVE_ASSET_IDS.find((alias) =>
      sameAsset(FUNDING_ASSET_CATALOG[alias].asset, spec.source),
    );
    const targetVenue = FUNDING_VENUE_IDS.find((venueId) =>
      sameAsset(
        FUNDING_ASSET_CATALOG[FUNDING_VENUE_CATALOG[venueId].settlementAsset]
          .asset,
        spec.destination,
      ),
    );
    if (!sourceAsset || !targetVenue) return [];
    const destinationAsset = FUNDING_VENUE_CATALOG[targetVenue].settlementAsset;
    return [
      {
        spec,
        sourceAsset,
        destinationAsset,
        sourceLocationPatternId:
          FUNDING_ASSET_CATALOG[sourceAsset].walletLocationPatternId,
        destinationLocationPatternId:
          FUNDING_VENUE_CATALOG[targetVenue].settlementLocationPatternId,
        targetVenue,
      },
    ];
  }),
]);

function venueActive(
  policy: FundingIntentPolicy,
  venueId: FundingVenueId,
): boolean {
  return policy.venues.includes(venueId) && !policy.paused;
}

function routeCapability(
  route: CatalogRoute,
): FundingRuntimePolicy["routes"][number]["capability"] {
  return relayRouteCapability(route.spec);
}

function compileRoute(
  route: CatalogRoute,
): FundingRuntimePolicy["routes"][number] {
  return relayRuntimeRoute(route.spec, {
    sourceLocationPatternId: route.sourceLocationPatternId,
    destinationLocationPatternId: route.destinationLocationPatternId,
  });
}

function enabledRoutes(policy: FundingIntentPolicy): readonly CatalogRoute[] {
  const selectedAssets = new Set(policy.receive.assets);
  return FUNDING_ROUTE_CATALOG.filter(
    (route) =>
      venueActive(policy, route.targetVenue) &&
      selectedAssets.has(route.sourceAsset),
  );
}

function walletPreparation(
  venueId: FundingVenueId,
): FundingRuntimePolicy["walletPreparation"] {
  return (
    [
      ["internal", "internal_managed", "privy_authorization"],
      ["external", "external_ready", "web_client"],
    ] as const
  ).map(([kind, readinessClass, signerPath]) => ({
    capabilityId: `${venueId}-fund-${kind}-v1`,
    venueId,
    purpose: "fund" as const,
    readinessClass,
    signerPath,
    selectable: true,
    enabled: true,
  }));
}

export function compileFundingIntentPolicy(
  input: FundingIntentPolicy,
): FundingRuntimePolicy {
  const policy = fundingIntentPolicySchema.parse(input);
  const routes = enabledRoutes(policy);
  const includedAssets = new Set<FundingReceiveAssetId>(policy.receive.assets);
  for (const venueId of policy.venues) {
    includedAssets.add(FUNDING_VENUE_CATALOG[venueId].settlementAsset);
  }
  for (const route of routes) {
    includedAssets.add(route.sourceAsset);
    includedAssets.add(route.destinationAsset);
  }

  const locations = new Map<
    string,
    FundingRuntimePolicy["locations"][number]
  >();
  const addLocation = (location: FundingRuntimePolicy["locations"][number]) =>
    locations.set(location.locationPatternId, location);
  for (const alias of policy.receive.assets) {
    const catalog = FUNDING_ASSET_CATALOG[alias];
    addLocation({
      locationPatternId: catalog.walletLocationPatternId,
      locationKind: "wallet",
      asset: catalog.asset,
      ownership: "owned",
      observable: true,
      capabilities: [...catalog.walletCapabilities],
      enabled: true,
    });
  }
  for (const venueId of policy.venues) {
    const catalog = FUNDING_VENUE_CATALOG[venueId];
    addLocation({
      locationPatternId: catalog.settlementLocationPatternId,
      locationKind: "venue_account",
      asset: FUNDING_ASSET_CATALOG[catalog.settlementAsset].asset,
      ownership: "owned",
      observable: true,
      capabilities: ["observe", "value", "venue_settlement"],
      enabled: true,
    });
  }
  const anyFund = policy.venues.some((venueId) => venueActive(policy, venueId));
  const runtime: FundingRuntimePolicy = {
    ...DEFAULT_FUNDING_RUNTIME_POLICY,
    creationMode: anyFund ? "on" : "off",
    gates: {
      ...DEFAULT_FUNDING_RUNTIME_POLICY.gates,
      quoteCreation: anyFund,
      commit: anyFund,
      startUnsubmittedAction: anyFund,
    },
    automation: {
      ...DEFAULT_FUNDING_RUNTIME_POLICY.automation,
      stagedContinuation: anyFund,
    },
    assets: [...includedAssets].map((alias) => {
      const catalog = FUNDING_ASSET_CATALOG[alias];
      return {
        asset: catalog.asset,
        enabled: true,
        observationEnabled: true,
        valuationEnabled: catalog.valuationEnabled,
        pricePolicyId: catalog.pricePolicyId,
      };
    }),
    locations: [...locations.values()],
    venues: policy.venues.map((venueId) => {
      const delegatedWrap =
        venueId === "polymarket" &&
        !policy.paused &&
        policy.receive.assets.includes("polygon:usdce");
      const relayProfileIds = Object.values(
        RELAY_EVM_FUNDING_PROFILE_SPECS,
      ).flatMap((profile) =>
        profile.venueIds.includes(venueId) &&
        routes.some(
          (route) =>
            route.targetVenue === venueId &&
            profile.routeIds.includes(route.spec.routeId),
        )
          ? [profile.profileId]
          : [],
      );
      const delegatedRelayEvm =
        !policy.paused &&
        relayProfileIds.length > 0 &&
        policy.receive.delegatedRelayEvmDailyCapUsd !== undefined;
      return {
        venueId,
        lifecycleEnabled: true,
        destinationReadinessEnabled: venueActive(policy, venueId),
        balanceEnabled: true,
        fundingEnabled: venueActive(policy, venueId),
        tradingEnabled: false,
        withdrawalEnabled: false,
        delegatedExecutionEnabled: delegatedWrap || delegatedRelayEvm,
        delegatedPolicyIds: [
          ...(delegatedWrap ? [POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID] : []),
          ...(delegatedRelayEvm ? relayProfileIds : []),
        ],
        delegatedDailyCapUsd: delegatedRelayEvm
          ? (policy.receive.delegatedRelayEvmDailyCapUsd ?? null)
          : null,
        positionValue: {
          enabled: false,
          identityPolicyId: null,
          freshnessMs: null,
          valuationMethodId: null,
          deduplicationPolicyId: null,
        },
      };
    }),
    providers: routes.length
      ? [
          {
            providerId: "relay",
            enabledCapabilities: unique(routes.map(routeCapability)),
          },
        ]
      : [],
    routes: routes.map(compileRoute),
    privyFundingMethods:
      policy.receive.privy && anyFund
        ? policy.venues.flatMap((venueId) => {
            if (!venueActive(policy, venueId)) return [];
            const catalog = FUNDING_VENUE_CATALOG[venueId];
            return [
              {
                methodId: catalog.privyMethodId,
                enabled: true,
                locallyConfigured: true,
                destinationLocationPatternId:
                  catalog.settlementLocationPatternId,
                asset: FUNDING_ASSET_CATALOG[catalog.settlementAsset].asset,
              },
            ];
          })
        : [],
    walletPreparation: policy.venues.flatMap((venueId) =>
      venueActive(policy, venueId) ? walletPreparation(venueId) : [],
    ),
    positionActions: [],
    genericAddFundsRecommendationOrder: policy.venues.filter((venueId) =>
      venueActive(policy, venueId),
    ),
  };
  const validated = validateEffectiveFundingRuntime(runtime);
  if (!validated.ok) {
    throw new Error(
      `compact funding policy compiled to an invalid runtime policy: ${validated.issues
        .map((issue) => `${issue.path}:${issue.code}`)
        .join(", ")}`,
    );
  }
  return validated.policy;
}

export function validateFundingIntentPolicy(input: unknown):
  | Readonly<{
      ok: true;
      policy: FundingIntentPolicy;
      runtimePolicy: FundingRuntimePolicy;
      issues: readonly [];
    }>
  | Readonly<{
      ok: false;
      policy: null;
      runtimePolicy: null;
      issues: readonly FundingPolicyValidationIssue[];
    }> {
  const parsed = fundingIntentPolicySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      policy: null,
      runtimePolicy: null,
      issues: schemaValidationIssues(parsed.error),
    };
  }
  const policy = deepFreeze(parsed.data);
  return {
    ok: true,
    policy,
    runtimePolicy: compileFundingIntentPolicy(policy),
    issues: [],
  };
}

export function applyFundingIntentPatch(
  current: FundingIntentPolicy,
  input: unknown,
): ReturnType<typeof validateFundingIntentPolicy> {
  const parsed = fundingIntentPatchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      policy: null,
      runtimePolicy: null,
      issues: schemaValidationIssues(parsed.error),
    };
  }
  return validateFundingIntentPolicy({
    version: 2,
    venues: parsed.data.venues ?? current.venues,
    receive: {
      assets: parsed.data.receive?.assets ?? current.receive.assets,
      ...(parsed.data.receive?.delegatedRelayEvmDailyCapUsd === null
        ? {}
        : {
            delegatedRelayEvmDailyCapUsd:
              parsed.data.receive?.delegatedRelayEvmDailyCapUsd ??
              current.receive.delegatedRelayEvmDailyCapUsd,
          }),
      privy: parsed.data.receive?.privy ?? current.receive.privy,
    },
    paused: parsed.data.paused ?? current.paused,
  });
}

export function fundingIntentBehaviorSnapshot(policy: FundingIntentPolicy) {
  return {
    venues: {
      order: policy.venues,
      enabled: Object.fromEntries(
        FUNDING_VENUE_IDS.map((venueId) => [
          venueId,
          policy.venues.includes(venueId),
        ]),
      ),
    },
    receive: {
      assets: Object.fromEntries(
        FUNDING_RECEIVE_ASSET_IDS.map((asset) => [
          asset,
          policy.receive.assets.includes(asset),
        ]),
      ),
      privy: policy.receive.privy,
      delegatedRelayEvmDailyCapUsd:
        policy.receive.delegatedRelayEvmDailyCapUsd ?? null,
    },
    paused: policy.paused,
  };
}

function fundingVenueEnabled(
  policy: FundingRuntimePolicy,
  venueId: string,
): boolean {
  const venue = policy.venues.find(
    (candidate) => candidate.venueId === venueId,
  );
  return Boolean(
    venue?.lifecycleEnabled &&
    venue.destinationReadinessEnabled &&
    venue.fundingEnabled &&
    policy.creationMode === "on" &&
    policy.gates.quoteCreation &&
    policy.gates.commit &&
    policy.gates.startUnsubmittedAction &&
    !policy.gates.emergencyBroadcastPause,
  );
}

export function fundingReceiveAssetEnabled(
  policy: FundingRuntimePolicy,
  asset: AssetRef,
): boolean {
  return (
    supportsCanonicalFundingReceiveEvents(asset.networkId) &&
    policy.assets.some(
      (candidate) =>
        candidate.enabled &&
        candidate.observationEnabled &&
        sameAsset(candidate.asset, asset),
    ) &&
    policy.locations.some(
      (location) =>
        location.enabled &&
        location.locationKind === "wallet" &&
        location.ownership === "owned" &&
        location.observable &&
        location.capabilities.includes("observe") &&
        location.capabilities.includes("execution_source") &&
        sameAsset(location.asset, asset),
    )
  );
}

export function fundingDestinationEnabled(
  policy: FundingRuntimePolicy,
  option: Pick<FundingDestinationOption, "requiredAsset" | "venueId">,
  purpose: "fund" | "buy" | "sell" | "redeem" | "withdraw",
): boolean {
  if (purpose !== "fund") return true;
  if (!fundingVenueEnabled(policy, option.venueId)) return false;
  if (!fundingVenueReceiveEnabled(policy, option.venueId)) return false;
  const venue = FUNDING_VENUE_CATALOG[option.venueId as FundingVenueId];
  const settlementAsset = FUNDING_ASSET_CATALOG[venue.settlementAsset].asset;
  return sameAsset(option.requiredAsset, settlementAsset);
}

export function fundingVenueReceiveEnabled(
  policy: FundingRuntimePolicy,
  venueId: string,
): boolean {
  if (!fundingVenueEnabled(policy, venueId)) return false;
  if (!FUNDING_VENUE_IDS.includes(venueId as FundingVenueId)) return false;
  const venue = FUNDING_VENUE_CATALOG[venueId as FundingVenueId];
  const settlementAsset = FUNDING_ASSET_CATALOG[venue.settlementAsset].asset;
  const settlementReady =
    supportsCanonicalFundingReceiveEvents(settlementAsset.networkId) &&
    policy.assets.some(
      (candidate) =>
        candidate.enabled &&
        candidate.observationEnabled &&
        sameAsset(candidate.asset, settlementAsset),
    ) &&
    policy.locations.some(
      (location) =>
        location.enabled &&
        location.locationPatternId === venue.settlementLocationPatternId &&
        location.locationKind === "venue_account" &&
        location.ownership === "owned" &&
        location.observable &&
        location.capabilities.includes("observe") &&
        location.capabilities.includes("venue_settlement") &&
        sameAsset(location.asset, settlementAsset),
    );
  if (!settlementReady) return false;

  const directReceiveReady = venue.directReceiveAssets.some((alias) =>
    fundingReceiveAssetEnabled(policy, FUNDING_ASSET_CATALOG[alias].asset),
  );
  const routedReceiveReady = policy.routes.some(
    (route) =>
      route.enabled &&
      route.providerId === "relay" &&
      route.destinationLocationPatternId ===
        venue.settlementLocationPatternId &&
      sameAsset(route.destinationAsset, settlementAsset) &&
      fundingReceiveAssetEnabled(policy, route.sourceAsset),
  );
  const privyReady = policy.privyFundingMethods.some(
    (method) =>
      method.enabled &&
      method.locallyConfigured &&
      method.destinationLocationPatternId ===
        venue.settlementLocationPatternId &&
      sameAsset(method.asset, settlementAsset),
  );
  return directReceiveReady || routedReceiveReady || privyReady;
}
