import { createHash } from "node:crypto";

import type {
  AssetLocation,
  AssetRef,
  ObservedAsset,
  ValuedPositionComponent,
} from "../funding/domain/types.js";
import {
  canonicalAccountAddress,
  canonicalAssetId,
  canonicalAssetKey,
} from "../funding/domain/asset-identity.js";
import { HYPERCORE_MAINNET_USDC } from "../funding/domain/hypercore-identity.js";

export function normalizeAssetId(asset: AssetRef): string {
  return canonicalAssetId(asset);
}

export function canonicalLocationKey(location: AssetLocation): string {
  const address =
    (typeof location.details.address === "string"
      ? canonicalAccountAddress(
          location.asset.networkId,
          location.details.address,
        )
      : "") ||
    (typeof location.details.accountRef === "string"
      ? canonicalAccountAddress(
          location.asset.networkId,
          location.details.accountRef,
        )
      : "") ||
    (typeof location.details.operationId === "string"
      ? location.details.operationId.trim()
      : "") ||
    location.locationId;
  const balanceClass =
    typeof location.details.balanceClass === "string"
      ? location.details.balanceClass
      : "";
  return [
    location.accountId,
    location.kind,
    address,
    canonicalAssetKey(location.asset),
    balanceClass,
  ].join("|");
}

export { canonicalAssetKey };

export function stableOpaqueId(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${prefix}_${digest.slice(0, 32)}`;
}

/** Keep the P2 physical spot identity when adding execution bindings. Account
 * mode and controller/session changes must not create a second reserve pool. */
export function hypercoreSpotAccountLocation(input: {
  accountId: string;
  address: string;
  controllerWalletId: string | null;
}): { location: AssetLocation; bindingId: string } {
  const asset = HYPERCORE_MAINNET_USDC;
  const address = canonicalAccountAddress(asset.networkId, input.address);
  return {
    bindingId: stableOpaqueId(
      "binding",
      `${input.accountId}:hyperliquid:mainnet:${address}`,
    ),
    location: {
      kind: "venue_account",
      locationId: stableOpaqueId(
        "location",
        `${input.accountId}:hyperliquid:mainnet:${address}:${asset.assetId}`,
      ),
      accountId: input.accountId,
      asset,
      details: {
        venueId: "hyperliquid",
        accountRef: address,
        address,
        controllerWalletId: input.controllerWalletId,
        environment: "mainnet",
        symbol: "USDC",
        nativeSourceDex: "spot",
      },
    },
  };
}

/** A possible native refund destination, not a cash component or spendable
 * balance. Spot outflow can refund to the same owner's separate perps account. */
export function hypercorePerpsRefundLocation(input: {
  accountId: string;
  address: string;
  controllerWalletId: string;
}): AssetLocation {
  const spot = hypercoreSpotAccountLocation(input).location;
  return {
    ...spot,
    locationId: stableOpaqueId("location", `${spot.locationId}:perps_refund`),
    details: {
      ...spot.details,
      nativeSourceDex: "",
      balanceClass: "perp",
    },
  };
}

export function stableWalletOpaqueId(
  input: Readonly<{
    walletType: string;
    networkId: string;
    address: string;
  }>,
): string {
  return stableOpaqueId(
    "wallet",
    `${input.walletType}:${input.networkId}:${canonicalAccountAddress(
      input.networkId,
      input.address,
    )}`,
  );
}

/**
 * Reproduce the durable identity used by Account Value for one wallet asset,
 * including an asset that currently has a zero balance and is therefore
 * absent from the projection. Funding plans use this to fence a known future
 * credit without inventing a second component namespace.
 */
export function stableWalletAssetLocationIdentity(input: {
  accountId: string;
  address: string;
  asset: AssetRef;
  balanceClass: string;
}): Readonly<{ componentId: string; locationId: string }> {
  const address = canonicalAccountAddress(input.asset.networkId, input.address);
  const locationId = stableOpaqueId(
    "location",
    `${input.accountId}:wallet:${address}:${canonicalAssetKey(input.asset)}`,
  );
  const location: AssetLocation = {
    kind: "wallet",
    locationId,
    accountId: input.accountId,
    asset: input.asset,
    details: {
      address,
      balanceClass: input.balanceClass,
    },
  };
  return {
    componentId: stableOpaqueId("asset", canonicalLocationKey(location)),
    locationId,
  };
}

export type DeduplicatedInventory = Readonly<{
  observations: readonly ObservedAsset[];
  duplicateCount: number;
  ambiguousComponentIds: readonly string[];
}>;

export function deduplicateObservedAssets(
  observations: readonly ObservedAsset[],
): DeduplicatedInventory {
  const byKey = new Map<string, ObservedAsset[]>();
  for (const observation of observations) {
    const key = canonicalLocationKey(observation.location);
    const entries = byKey.get(key) ?? [];
    entries.push(observation);
    byKey.set(key, entries);
  }

  const deduplicated: ObservedAsset[] = [];
  const ambiguousComponentIds: string[] = [];
  let duplicateCount = 0;

  for (const entries of byKey.values()) {
    entries.sort(
      (left, right) =>
        Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
        left.componentId.localeCompare(right.componentId),
    );
    const selected = entries[0];
    if (!selected) continue;
    duplicateCount += entries.length - 1;

    const sameTimestamp = entries.filter(
      (entry) => entry.observedAt === selected.observedAt,
    );
    const conflictingLatest = sameTimestamp.some(
      (entry) => entry.amount.raw !== selected.amount.raw,
    );
    if (conflictingLatest) {
      ambiguousComponentIds.push(selected.componentId);
      deduplicated.push({
        ...selected,
        observationFreshness: "unknown",
        observationError: {
          code: "ambiguous_duplicate_observation",
          retryable: true,
        },
      });
      continue;
    }
    deduplicated.push(selected);
  }

  return {
    observations: deduplicated.sort((left, right) =>
      left.componentId.localeCompare(right.componentId),
    ),
    duplicateCount,
    ambiguousComponentIds,
  };
}

export type DeduplicatedPositions = Readonly<{
  components: readonly ValuedPositionComponent[];
  duplicateCount: number;
}>;

export function deduplicatePositionComponents(
  components: readonly ValuedPositionComponent[],
): DeduplicatedPositions {
  const byKey = new Map<string, ValuedPositionComponent[]>();
  for (const component of components) {
    const key = [
      component.venueId,
      component.venueBindingId,
      component.positionRef,
    ].join("|");
    const entries = byKey.get(key) ?? [];
    entries.push(component);
    byKey.set(key, entries);
  }

  const output: ValuedPositionComponent[] = [];
  let duplicateCount = 0;
  for (const entries of byKey.values()) {
    entries.sort(
      (left, right) =>
        Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
        left.componentId.localeCompare(right.componentId),
    );
    const selected = entries[0];
    if (!selected) continue;
    duplicateCount += entries.length - 1;

    const latest = entries.filter(
      (entry) => entry.observedAt === selected.observedAt,
    );
    const values = new Set(
      latest.map((entry) => entry.estimatedUsd?.value ?? null),
    );
    if (values.size > 1) {
      output.push({
        ...selected,
        estimatedUsd: null,
        observationFreshness: "unknown",
        observationError: {
          code: "ambiguous_duplicate_position",
          retryable: true,
        },
        valuationEligibility: "excluded",
        reasonCodes: [...selected.reasonCodes, "ambiguous_duplicate_position"],
      });
      continue;
    }
    output.push(selected);
  }

  return {
    components: output.sort((left, right) =>
      left.componentId.localeCompare(right.componentId),
    ),
    duplicateCount,
  };
}
