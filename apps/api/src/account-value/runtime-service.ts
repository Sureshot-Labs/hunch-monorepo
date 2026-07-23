import type { Pool } from "@hunch/infra";

import { AuthService } from "../auth.js";
import { env } from "../env.js";
import type {
  AccountValueProjection,
  AssetRef,
  ObservedAsset,
  ValuedAssetComponent,
  ValuedPositionComponent,
} from "../funding/domain/types.js";
import type { FundingCreationMode } from "../funding/policies/funding-policy.js";
import { resolveFundingPolicy } from "../funding/policies/funding-policy-service.js";
import { fetchOpenOrderCollateralLocks } from "../services/open-order-collateral.js";
import { POLYGON_NATIVE_USDC_ADDRESS } from "../services/polymarket-onchain.js";
import {
  loadBalanceWalletLookup,
  resolveWalletBalancesForWalletWithInflight,
  type BalanceWalletResolution,
  type WalletBalanceItem,
} from "../routes/wallets.js";
import {
  projectAccountValue,
  resolveEffectiveHeadline,
  type CollectorError,
} from "./account-value-projector.js";
import {
  canonicalAssetKey,
  canonicalLocationKey,
  deduplicateObservedAssets,
  stableOpaqueId,
} from "./canonical.js";
import {
  projectCashAvailability,
  type CashAvailabilityAdjustment,
  type CashAvailabilityProjection,
} from "./cash-availability-projector.js";
import { addUnsignedDecimals } from "./decimal.js";
import {
  ExistingFactsOwnershipResolver,
  type ExistingVenueBindingFact,
  type ExistingWalletOwnershipFact,
} from "./ownership-resolver.js";
import {
  collectUnpricedKalshiPositions,
  collectVenuePositionValues,
} from "./position-value-collectors.js";
import {
  EXACT_STABLE_PRICE_POLICY_ID,
  ExactStablePriceAdapter,
  resolveStableImpairmentState,
  STABLE_IMPAIRED_PRICE_POLICY_ID,
  ValuationService,
  type AssetValuationPolicy,
  type StableImpairmentState,
} from "./valuation-service.js";
import {
  fetchAssetFundingPreferences,
  type StoredAssetFundingPreference,
} from "./asset-preferences.js";
import {
  applyFundingSourceDebitSuppression,
  buildFundingInTransitObservations,
  loadFundingAccountValueFacts,
  type FundingAccountValueFacts,
} from "./funding-movement-feed.js";

const SOLANA_CHAIN_ID = "7565164";
const UNPRICED_POLICY_ID = "unpriced";

type AccountAssetCatalogEntry = Readonly<{
  asset: AssetRef;
  category: "cash" | "token";
  symbol: string;
  venueId: "polymarket" | "limitless" | "kalshi" | null;
  pricePolicyId: string;
  verified: boolean;
}>;

export type AccountValueVenueSummary = Readonly<{
  cashEstimatedUsd: string;
  cashAvailableEstimatedUsd: string;
  positionsEstimatedUsd: string;
  totalPortfolioEstimatedUsd: string;
}>;

export type AccountValueReadModel = Readonly<{
  projection: AccountValueProjection;
  headline: ReturnType<typeof resolveEffectiveHeadline>;
  cashAvailability: CashAvailabilityProjection;
  venues: Readonly<Record<string, AccountValueVenueSummary>>;
  policy: Readonly<{
    creationMode: FundingCreationMode;
    revision: string;
    source: "default" | "db";
    invalidStoredPolicy: boolean;
  }>;
  ownershipEvidenceRevision: string;
  duplicateAssetObservationCount: number;
  assetPreferences: Readonly<Record<string, StoredAssetFundingPreference>>;
}>;

function exactStableCatalog(): AccountAssetCatalogEntry[] {
  return [
    {
      asset: {
        networkId: "evm:137",
        assetId: env.polymarketUsdcAddress,
        decimals: 6,
      },
      category: "cash",
      symbol: "pUSD",
      venueId: "polymarket",
      pricePolicyId: EXACT_STABLE_PRICE_POLICY_ID,
      verified: true,
    },
    {
      asset: {
        networkId: "evm:137",
        assetId: env.polymarketUsdceAddress,
        decimals: 6,
      },
      category: "cash",
      symbol: "USDC.e",
      venueId: "polymarket",
      pricePolicyId: EXACT_STABLE_PRICE_POLICY_ID,
      verified: true,
    },
    {
      asset: {
        networkId: "evm:137",
        assetId: POLYGON_NATIVE_USDC_ADDRESS,
        decimals: 6,
      },
      category: "cash",
      symbol: "USDC",
      venueId: "polymarket",
      pricePolicyId: EXACT_STABLE_PRICE_POLICY_ID,
      verified: true,
    },
    {
      asset: {
        networkId: "evm:8453",
        assetId: env.limitlessUsdcAddress,
        decimals: 6,
      },
      category: "cash",
      symbol: "USDC",
      venueId: "limitless",
      pricePolicyId: EXACT_STABLE_PRICE_POLICY_ID,
      verified: true,
    },
    {
      asset: {
        networkId: "solana:mainnet",
        assetId: env.solanaUsdcMint,
        decimals: 6,
      },
      category: "cash",
      symbol: "USDC",
      venueId: "kalshi",
      pricePolicyId: EXACT_STABLE_PRICE_POLICY_ID,
      verified: true,
    },
  ];
}

function mergeCatalogWithPolicy(
  policyAssets: readonly Readonly<{
    asset: AssetRef;
    enabled: boolean;
    observationEnabled: boolean;
    valuationEnabled: boolean;
    pricePolicyId: string | null;
  }>[],
): AccountAssetCatalogEntry[] {
  const catalog = new Map(
    exactStableCatalog().map((entry) => [
      canonicalAssetKey(entry.asset),
      entry,
    ]),
  );
  for (const item of policyAssets) {
    const key = canonicalAssetKey(item.asset);
    const existing = catalog.get(key);
    if (!item.enabled || !item.observationEnabled) {
      if (existing) catalog.delete(key);
      continue;
    }
    const pricePolicyId =
      item.valuationEnabled && item.pricePolicyId
        ? item.pricePolicyId
        : UNPRICED_POLICY_ID;
    if (existing) {
      catalog.set(key, { ...existing, pricePolicyId });
      continue;
    }
    catalog.set(key, {
      asset: item.asset,
      category: "token",
      symbol: "Token",
      venueId: null,
      pricePolicyId,
      verified: false,
    });
  }
  return [...catalog.values()];
}

function networkToBalanceChainId(networkId: string): string | null {
  if (networkId === "solana:mainnet") return SOLANA_CHAIN_ID;
  if (networkId.startsWith("evm:")) return networkId.slice("evm:".length);
  return null;
}

function normalizeAddress(value: string): string {
  return value.startsWith("0x") ? value.toLowerCase() : value;
}

function isPositiveRaw(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value) && BigInt(value) > 0n;
}

function resolutionSupportsEntry(
  resolution: BalanceWalletResolution,
  entry: AccountAssetCatalogEntry,
): boolean {
  if (resolution.walletType === "solana") {
    return entry.asset.networkId === "solana:mainnet";
  }
  if (resolution.source === "derived_funder") {
    return entry.asset.networkId === "evm:137";
  }
  return entry.asset.networkId.startsWith("evm:");
}

function buildObservation(inputs: {
  accountId: string;
  resolution: BalanceWalletResolution;
  balance: WalletBalanceItem;
  entry: AccountAssetCatalogEntry;
  observedAt: string;
}): ObservedAsset {
  const address = normalizeAddress(inputs.resolution.walletAddress);
  const locationKind =
    inputs.resolution.source === "derived_funder" ? "venue_account" : "wallet";
  const location = {
    kind: locationKind,
    locationId: stableOpaqueId(
      "location",
      `${inputs.accountId}:${locationKind}:${address}:${canonicalAssetKey(inputs.entry.asset)}`,
    ),
    accountId: inputs.accountId,
    asset: inputs.entry.asset,
    details: {
      address,
      linkedAddress: inputs.resolution.linkedWalletAddress,
      balanceClass: inputs.entry.venueId ?? "wallet",
      ...(inputs.entry.venueId ? { venueId: inputs.entry.venueId } : {}),
    },
  } as const;
  return {
    componentId: stableOpaqueId("asset", canonicalLocationKey(location)),
    location,
    amount: {
      asset: inputs.entry.asset,
      raw: inputs.balance.balanceRaw,
    },
    ownershipEvidenceId: stableOpaqueId(
      "evidence",
      `${inputs.resolution.source}:${inputs.resolution.linkedWalletAddress}:${address}`,
    ),
    observedAt: inputs.observedAt,
    observationFreshness: "fresh",
    observationError: null,
    metadataRisk: inputs.entry.verified ? "verified" : "unverified",
  };
}

async function collectInventory(inputs: {
  accountId: string;
  resolutions: readonly BalanceWalletResolution[];
  catalog: readonly AccountAssetCatalogEntry[];
  observedAt: string;
}): Promise<
  Readonly<{
    observations: readonly ObservedAsset[];
    errors: readonly CollectorError[];
  }>
> {
  const observations: ObservedAsset[] = [];
  const errors: CollectorError[] = [];
  await Promise.all(
    inputs.resolutions.map(async (resolution) => {
      const entries = inputs.catalog.filter((entry) =>
        resolutionSupportsEntry(resolution, entry),
      );
      const tokens = entries.flatMap((entry) => {
        const chainId = networkToBalanceChainId(entry.asset.networkId);
        return chainId ? [`${chainId}:${entry.asset.assetId}`] : [];
      });
      if (tokens.length === 0) return;
      try {
        const result = await resolveWalletBalancesForWalletWithInflight({
          walletAddress: resolution.walletAddress,
          walletType: resolution.walletType,
          tokens,
          chains: [],
        });
        if (result.warnings.length > 0) {
          errors.push({
            collectorId: "wallet-inventory",
            code: "wallet_balance_collection_warning",
            retryable: true,
          });
        }
        const entryByToken = new Map(
          entries.flatMap((entry) => {
            const chainId = networkToBalanceChainId(entry.asset.networkId);
            return chainId
              ? [
                  [
                    `${chainId}:${normalizeAddress(entry.asset.assetId)}`,
                    entry,
                  ] as const,
                ]
              : [];
          }),
        );
        for (const balance of result.balances) {
          const entry = entryByToken.get(
            `${balance.chainId}:${normalizeAddress(balance.address)}`,
          );
          if (!entry) continue;
          if (
            balance.decimals != null &&
            balance.decimals !== entry.asset.decimals
          ) {
            errors.push({
              collectorId: "wallet-inventory",
              code: "asset_decimals_mismatch",
              retryable: false,
            });
            continue;
          }
          if (!isPositiveRaw(balance.balanceRaw)) continue;
          observations.push(
            buildObservation({
              accountId: inputs.accountId,
              resolution,
              balance,
              entry,
              observedAt: inputs.observedAt,
            }),
          );
        }
      } catch {
        errors.push({
          collectorId: "wallet-inventory",
          code: "wallet_balance_collection_failed",
          retryable: true,
        });
      }
    }),
  );
  return { observations, errors };
}

function sourceForWallet(
  _wallet: Awaited<ReturnType<typeof AuthService.getUserWallets>>[number],
): "embedded" | "smart" | "external" {
  return "external";
}

function summarizeVenues(inputs: {
  assets: readonly ValuedAssetComponent[];
  positions: readonly ValuedPositionComponent[];
  cashAvailability: CashAvailabilityProjection;
  catalog: readonly AccountAssetCatalogEntry[];
}): Readonly<Record<string, AccountValueVenueSummary>> {
  const catalogVenueByAsset = new Map(
    inputs.catalog.map((entry) => [
      canonicalAssetKey(entry.asset),
      entry.venueId,
    ]),
  );
  const venues = ["polymarket", "limitless", "kalshi"];
  return Object.fromEntries(
    venues.map((venueId) => {
      const cashEstimatedUsd = addUnsignedDecimals(
        inputs.assets
          .filter(
            (component) =>
              component.category === "cash" &&
              component.valuationEligibility === "included" &&
              catalogVenueByAsset.get(
                canonicalAssetKey(component.amount.asset),
              ) === venueId,
          )
          .flatMap((component) =>
            component.estimatedUsd ? [component.estimatedUsd.value] : [],
          ),
      );
      const positionsEstimatedUsd = addUnsignedDecimals(
        inputs.positions
          .filter(
            (component) =>
              component.venueId === venueId &&
              component.valuationEligibility === "included",
          )
          .flatMap((component) =>
            component.estimatedUsd ? [component.estimatedUsd.value] : [],
          ),
      );
      const cashAvailableEstimatedUsd =
        inputs.cashAvailability.byVenueEstimatedUsd[venueId] ?? "0";
      return [
        venueId,
        {
          cashEstimatedUsd,
          cashAvailableEstimatedUsd,
          positionsEstimatedUsd,
          totalPortfolioEstimatedUsd: addUnsignedDecimals([
            cashEstimatedUsd,
            positionsEstimatedUsd,
          ]),
        },
      ];
    }),
  );
}

export async function buildAccountValueReadModel(inputs: {
  pool: Pool;
  userId: string;
  now?: Date;
}): Promise<AccountValueReadModel> {
  const now = inputs.now ?? new Date();
  const asOf = now.toISOString();
  const [resolvedPolicy, linkedWallets, balanceLookup] = await Promise.all([
    resolveFundingPolicy(inputs.pool),
    AuthService.getUserWallets(inputs.userId),
    loadBalanceWalletLookup(inputs.userId),
  ]);
  const catalog = mergeCatalogWithPolicy(resolvedPolicy.policy.assets);
  const resolutions = [...balanceLookup.values()];
  const credentialFacts = await Promise.all(
    linkedWallets
      .filter((wallet) => wallet.walletType === "ethereum")
      .map(async (wallet) => {
        const [polymarket, limitless] = await Promise.all([
          AuthService.getVenueCredentialsInfo(
            inputs.userId,
            "polymarket",
            wallet.walletAddress,
          ),
          AuthService.getVenueCredentialsInfo(
            inputs.userId,
            "limitless",
            wallet.walletAddress,
          ),
        ]);
        return { wallet, polymarket, limitless };
      }),
  );
  const exactCatalog = exactStableCatalog();
  const polymarketAsset = exactCatalog.find(
    (entry) =>
      entry.venueId === "polymarket" &&
      normalizeAddress(entry.asset.assetId) ===
        normalizeAddress(env.polymarketUsdcAddress),
  )?.asset;
  const limitlessAsset = exactCatalog.find(
    (entry) => entry.venueId === "limitless",
  )?.asset;
  const kalshiAsset = exactCatalog.find(
    (entry) => entry.venueId === "kalshi",
  )?.asset;
  if (!polymarketAsset || !limitlessAsset || !kalshiAsset) {
    throw new Error("account value stable catalog is incomplete");
  }
  const ownershipWallets: ExistingWalletOwnershipFact[] = resolutions.map(
    (resolution) => {
      const linked = linkedWallets.find(
        (wallet) =>
          normalizeAddress(wallet.walletAddress) ===
          normalizeAddress(resolution.linkedWalletAddress),
      );
      return {
        address: resolution.walletAddress,
        walletType: resolution.walletType === "solana" ? "solana" : "ethereum",
        source: linked ? sourceForWallet(linked) : "smart",
        linkedAddress: resolution.linkedWalletAddress,
        serverWalletRef: null,
      };
    },
  );
  const bindingFacts: ExistingVenueBindingFact[] = credentialFacts.flatMap(
    ({ wallet, polymarket, limitless }) => {
      const facts: ExistingVenueBindingFact[] = [];
      if (polymarket) {
        facts.push({
          venueId: "polymarket",
          controllerAddress: polymarket.funderAddress ?? wallet.walletAddress,
          executionAddress: wallet.walletAddress,
          accountRef: polymarket.funderAddress ?? wallet.walletAddress,
          settlementAsset: polymarketAsset,
          signingMode: "web_client",
        });
      }
      if (limitless) {
        facts.push({
          venueId: "limitless",
          controllerAddress: wallet.walletAddress,
          executionAddress: wallet.walletAddress,
          accountRef: wallet.walletAddress,
          settlementAsset: limitlessAsset,
          signingMode: "web_client",
        });
      }
      return facts;
    },
  );
  for (const wallet of linkedWallets.filter(
    (entry) => entry.walletType === "solana",
  )) {
    bindingFacts.push({
      venueId: "kalshi",
      controllerAddress: wallet.walletAddress,
      executionAddress: wallet.walletAddress,
      accountRef: wallet.walletAddress,
      settlementAsset: kalshiAsset,
      signingMode: "web_client",
    });
  }
  const ownership = await new ExistingFactsOwnershipResolver({
    wallets: ownershipWallets,
    venueBindings: bindingFacts,
    now: () => now,
  }).resolve(inputs.userId);

  const inventory = await collectInventory({
    accountId: inputs.userId,
    resolutions,
    catalog,
    observedAt: asOf,
  });
  const deduplicated = deduplicateObservedAssets(inventory.observations);
  const configuredCatalogByAsset = new Map(
    catalog.map((entry) => [canonicalAssetKey(entry.asset), entry]),
  );
  const stableStates = new Map<string, StableImpairmentState>(
    exactCatalog.map((entry) => {
      const configured = configuredCatalogByAsset.get(
        canonicalAssetKey(entry.asset),
      );
      return [
        canonicalAssetKey(entry.asset),
        resolveStableImpairmentState(
          configured?.pricePolicyId ?? entry.pricePolicyId,
          asOf,
        ),
      ];
    }),
  );
  const valuationPolicies: AssetValuationPolicy[] = catalog.map((entry) => ({
    asset: entry.asset,
    category: entry.category,
    pricePolicyId:
      entry.pricePolicyId === STABLE_IMPAIRED_PRICE_POLICY_ID
        ? EXACT_STABLE_PRICE_POLICY_ID
        : entry.pricePolicyId,
    maximumObservationAgeMs: resolvedPolicy.policy.ttl.collectorMs,
    executionEligibility: "unknown",
  }));
  const valuationService = new ValuationService({
    policies: valuationPolicies,
    adapters: [new ExactStablePriceAdapter(stableStates)],
    stableStates,
  });
  const valuedAssets = await valuationService.value(
    deduplicated.observations,
    now,
  );
  let fundingFacts: FundingAccountValueFacts = {
    schemaReady: false,
    availability: [],
    inTransit: [],
  };
  const fundingFactErrors: CollectorError[] = [];
  try {
    fundingFacts = await loadFundingAccountValueFacts(
      inputs.pool,
      inputs.userId,
    );
  } catch {
    fundingFactErrors.push({
      collectorId: "funding-account-value-facts",
      code: "funding_movement_collection_failed",
      retryable: true,
    });
  }
  const movementPolicies: AssetValuationPolicy[] = valuationPolicies.map(
    (policy) => ({
      ...policy,
      category: "in_transit",
      executionEligibility: "ineligible",
      maximumObservationAgeMs: Number.MAX_SAFE_INTEGER,
    }),
  );
  const movementValuationService = new ValuationService({
    policies: movementPolicies,
    adapters: [new ExactStablePriceAdapter(stableStates)],
    stableStates,
  });
  const inTransitAssets = await movementValuationService.value(
    buildFundingInTransitObservations(inputs.userId, fundingFacts.inTransit),
    now,
  );
  const projectedAssets = [
    ...applyFundingSourceDebitSuppression(valuedAssets, fundingFacts.inTransit),
    ...inTransitAssets,
  ];

  const linkedWalletAddresses = linkedWallets.map(
    (wallet) => wallet.walletAddress,
  );
  const positionFreshness = Math.max(
    resolvedPolicy.policy.ttl.collectorMs,
    300_000,
  );
  const positionErrors: CollectorError[] = [];
  const positionGroups = await Promise.all(
    [
      ["polymarket", "polymarket-position-value"] as const,
      ["limitless", "limitless-position-value"] as const,
    ].map(async ([venue, collectorId]) => {
      try {
        return await collectVenuePositionValues({
          pool: inputs.pool,
          userId: inputs.userId,
          walletAddresses: linkedWalletAddresses,
          venue,
          now,
          freshnessMs: positionFreshness,
        });
      } catch {
        positionErrors.push({
          collectorId,
          code: "position_value_collection_failed",
          retryable: true,
        });
        return [];
      }
    }),
  );
  try {
    positionGroups.push(
      await collectUnpricedKalshiPositions({
        pool: inputs.pool,
        userId: inputs.userId,
        walletAddresses: linkedWalletAddresses,
        now,
        freshnessMs: positionFreshness,
      }),
    );
  } catch {
    positionErrors.push({
      collectorId: "kalshi-position-inventory",
      code: "position_inventory_collection_failed",
      retryable: true,
    });
  }
  const positionComponents = positionGroups.flat();

  let locks = {
    polymarket: new Map<string, bigint>(),
    limitless: new Map<string, bigint>(),
  };
  const availabilityErrors: CollectorError[] = [...fundingFactErrors];
  try {
    locks = await fetchOpenOrderCollateralLocks(inputs.pool, {
      userId: inputs.userId,
      polymarketWallets: resolutions
        .filter((resolution) => resolution.walletType !== "solana")
        .map((resolution) => resolution.walletAddress),
      limitlessWallets: linkedWallets
        .filter((wallet) => wallet.walletType === "ethereum")
        .map((wallet) => wallet.walletAddress),
    });
  } catch {
    availabilityErrors.push({
      collectorId: "cash-availability-locks",
      code: "cash_lock_collection_failed",
      retryable: true,
    });
  }
  const catalogByAsset = new Map(
    catalog.map((entry) => [canonicalAssetKey(entry.asset), entry]),
  );
  const fundingAvailabilityByComponent = new Map(
    fundingFacts.availability.map((fact) => [fact.componentId, fact]),
  );
  const adjustments: CashAvailabilityAdjustment[] = valuedAssets
    .filter((component) => component.category === "cash")
    .map((component) => {
      const entry = catalogByAsset.get(
        canonicalAssetKey(component.amount.asset),
      );
      const address =
        typeof component.location.details.address === "string"
          ? normalizeAddress(component.location.details.address)
          : "";
      const venueId = entry?.venueId ?? null;
      const isPolymarketCollateral =
        venueId === "polymarket" &&
        normalizeAddress(component.amount.asset.assetId) ===
          normalizeAddress(env.polymarketUsdcAddress);
      const lockedRaw =
        isPolymarketCollateral && address
          ? (locks.polymarket.get(address) ?? 0n).toString()
          : venueId === "limitless" && address
            ? (locks.limitless.get(address) ?? 0n).toString()
            : "0";
      const fundingAvailability = fundingAvailabilityByComponent.get(
        component.componentId,
      );
      const submittedDebitRaw =
        fundingAvailability?.submittedDebitObservedAt != null &&
        Date.parse(component.observedAt) <
          Date.parse(fundingAvailability.submittedDebitObservedAt)
          ? fundingAvailability.submittedDebitRaw
          : "0";
      return {
        componentId: component.componentId,
        venueId,
        venueBindingId:
          venueId && address
            ? stableOpaqueId(
                "binding",
                `${inputs.userId}:${venueId}:${address}`,
              )
            : null,
        lockedRaw,
        reservedRaw: fundingAvailability?.reservedRaw ?? "0",
        submittedDebitRaw,
        availabilityKnown:
          fundingFactErrors.length === 0 &&
          (availabilityErrors.length === 0 ||
            (venueId !== "polymarket" && venueId !== "limitless")),
      };
    });
  const cashAvailability = projectCashAvailability({
    components: valuedAssets,
    adjustments,
    collectorErrors: availabilityErrors,
    asOf,
  });
  const collectorErrors = [
    ...inventory.errors,
    ...positionErrors,
    ...fundingFactErrors,
  ];
  const projection = projectAccountValue({
    accountId: inputs.userId,
    headlineMode: resolvedPolicy.policy.headline.mode,
    components: projectedAssets,
    positionComponents,
    collectorErrors,
    asOf,
  });
  const assetPreferences = await fetchAssetFundingPreferences(inputs.pool, {
    userId: inputs.userId,
    componentIds: valuedAssets.map((component) => component.componentId),
  });
  return {
    projection,
    headline: resolveEffectiveHeadline(projection),
    cashAvailability,
    venues: summarizeVenues({
      assets: projectedAssets,
      positions: positionComponents,
      cashAvailability,
      catalog,
    }),
    policy: {
      creationMode: resolvedPolicy.policy.creationMode,
      revision: resolvedPolicy.revision,
      source: resolvedPolicy.source,
      invalidStoredPolicy: resolvedPolicy.invalidStoredPolicy,
    },
    ownershipEvidenceRevision: ownership.evidenceRevision,
    duplicateAssetObservationCount: deduplicated.duplicateCount,
    assetPreferences,
  };
}
