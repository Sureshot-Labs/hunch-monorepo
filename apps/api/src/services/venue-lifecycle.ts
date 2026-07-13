import {
  filterVenuesByLifecycleCapability,
  getVenuesWithLifecycleCapability,
  venueHasLifecycleCapability,
  type HunchVenue,
  type VenueLifecycleCapability,
} from "@hunch/shared";

import type { DbQuery } from "../db.js";
import { resolveVenueLifecyclePolicy } from "./runtime-policies.js";

export async function filterVenuesForLifecycleCapability(
  db: DbQuery,
  venues: readonly unknown[] | null | undefined,
  capability: VenueLifecycleCapability,
): Promise<{ revision: string; venues: HunchVenue[] }> {
  const resolved = await resolveVenueLifecyclePolicy(db);
  const requested =
    venues == null
      ? getVenuesWithLifecycleCapability(resolved.effective, capability)
      : filterVenuesByLifecycleCapability(
          resolved.effective,
          venues,
          capability,
        );
  return { revision: resolved.revision, venues: requested };
}

export async function venueLifecycleAllows(
  db: DbQuery,
  venue: unknown,
  capability: VenueLifecycleCapability,
): Promise<boolean> {
  const resolved = await resolveVenueLifecyclePolicy(db);
  return venueHasLifecycleCapability(resolved.effective, venue, capability);
}

export type VenueLifecycleTradingAction = "BUY" | "CANCEL" | "REDEEM" | "SELL";

export function resolveCollateralPairTradingAction(input: {
  collateralAsset: string;
  inputAsset: string | null | undefined;
  outputAsset: string | null | undefined;
}): "BUY" | "SELL" | null {
  const inputAsset = input.inputAsset?.trim();
  const outputAsset = input.outputAsset?.trim();
  if (!inputAsset || !outputAsset || inputAsset === outputAsset) return null;
  if (inputAsset === input.collateralAsset) return "BUY";
  if (outputAsset === input.collateralAsset) return "SELL";
  return null;
}

export function lifecycleCapabilityForTradingAction(
  action: VenueLifecycleTradingAction,
): VenueLifecycleCapability {
  switch (action) {
    case "BUY":
      return "increaseExposure";
    case "SELL":
      return "reduceExposure";
    case "REDEEM":
      return "redeem";
    case "CANCEL":
      return "cancel";
  }
}

export async function venueLifecycleAllowsTradingAction(
  db: DbQuery,
  venue: unknown,
  action: VenueLifecycleTradingAction,
  options: { automation?: boolean } = {},
): Promise<boolean> {
  const resolved = await resolveVenueLifecyclePolicy(db);
  return (
    venueHasLifecycleCapability(
      resolved.effective,
      venue,
      lifecycleCapabilityForTradingAction(action),
    ) &&
    (!options.automation ||
      venueHasLifecycleCapability(resolved.effective, venue, "automation"))
  );
}
