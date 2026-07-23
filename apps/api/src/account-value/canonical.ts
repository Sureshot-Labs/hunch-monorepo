import { createHash } from "node:crypto";

import type {
  AssetLocation,
  AssetRef,
  ObservedAsset,
  ValuedPositionComponent,
} from "../funding/domain/types.js";

export function normalizeAssetId(asset: AssetRef): string {
  return asset.assetId.startsWith("0x")
    ? asset.assetId.toLowerCase()
    : asset.assetId;
}

export function canonicalAssetKey(asset: AssetRef): string {
  return `${asset.networkId}:${normalizeAssetId(asset)}:${asset.decimals}`;
}

function normalizeAddress(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : trimmed;
}

export function canonicalLocationKey(location: AssetLocation): string {
  const address =
    normalizeAddress(location.details.address) ||
    normalizeAddress(location.details.accountRef) ||
    normalizeAddress(location.details.operationId) ||
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

export function stableOpaqueId(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${prefix}_${digest.slice(0, 32)}`;
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
      component.positionRef.toLowerCase(),
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
