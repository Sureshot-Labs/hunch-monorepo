import type { AssetRef, Money } from "../domain/types.js";
import { canonicalAssetId, sameAsset } from "../domain/asset-identity.js";

export function normalizeAssetId(asset: AssetRef): string {
  return canonicalAssetId(asset);
}

export { sameAsset };

export function assertSameAsset(
  left: AssetRef,
  right: AssetRef,
  label: string,
): void {
  if (!sameAsset(left, right)) {
    throw new FundingPlannerError(
      "asset_mismatch",
      `${label} assets do not match`,
    );
  }
}

export function rawAmount(value: string, label = "amount"): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new FundingPlannerError(
      "invalid_amount",
      `${label} must be an unsigned raw-unit integer`,
    );
  }
  return BigInt(value);
}

export function money(asset: AssetRef, raw: bigint): Money {
  if (raw < 0n) {
    throw new FundingPlannerError(
      "invalid_amount",
      "money cannot contain a negative raw amount",
    );
  }
  return { asset, raw: raw.toString() };
}

export function subtractFloor(left: string, right: string): string {
  const result =
    rawAmount(left, "left amount") - rawAmount(right, "right amount");
  return (result > 0n ? result : 0n).toString();
}

export function addRaw(left: string, right: string): string {
  return (
    rawAmount(left, "left amount") + rawAmount(right, "right amount")
  ).toString();
}

export function multiplyBpsCeil(value: string, basisPoints: number): string {
  if (
    !Number.isInteger(basisPoints) ||
    basisPoints < 0 ||
    basisPoints > 10_000
  ) {
    throw new FundingPlannerError(
      "invalid_policy",
      "basis-point value is outside policy",
    );
  }
  const amount = rawAmount(value);
  return ((amount * BigInt(basisPoints) + 9_999n) / 10_000n).toString();
}

export type FundingPlannerErrorCode =
  | "asset_mismatch"
  | "destination_selection_required"
  | "destination_unavailable"
  | "funding_policy_disabled"
  | "invalid_amount"
  | "invalid_market_context"
  | "invalid_policy"
  | "manual_rebalance_forbidden"
  | "market_class_required"
  | "provider_unavailable"
  | "receive_channel_conflict"
  | "source_not_selected"
  | "stale_projection";

export class FundingPlannerError extends Error {
  constructor(
    readonly code: FundingPlannerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FundingPlannerError";
  }
}
