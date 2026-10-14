import type { AccountValueReadModel } from "./runtime-service.js";
import type { ValuedAssetComponent } from "../funding/domain/types.js";
import { sameAsset } from "../funding/domain/asset-identity.js";
import { isHypercoreFundingNetwork } from "../funding/domain/hypercore-identity.js";
import { withdrawalDestinationAssets } from "../funding/domain/withdrawal-contract.js";
import { resolveProductionOwnedSourceExecution } from "../funding/planner/production-source-planner.js";

/** Read-only UI hints from the same owned-source resolver and available cash
 * as the planner. No provider call, quote, reservation or execution authority.
 * Native accounts must not be offered as ordinary same-asset wallet sends. */
export function withdrawalOptionsForAsset(
  account: AccountValueReadModel,
  component: ValuedAssetComponent,
  now: number,
) {
  if (!isHypercoreFundingNetwork(component.amount.asset.networkId))
    return undefined;
  const availability = account.cashAvailability.components.find(
    (row) => row.componentId === component.componentId,
  );
  const validUntil = component.location.details.validUntil;
  const expiry = typeof validUntil === "string" ? Date.parse(validUntil) : NaN;
  const execution = resolveProductionOwnedSourceExecution({
    account,
    component,
  });
  if (
    !execution ||
    execution.profile.source !== "embedded" ||
    !availability ||
    availability.freshness !== "fresh" ||
    component.observationFreshness !== "fresh" ||
    availability.asOf !== component.observedAt ||
    !sameAsset(availability.amount.asset, component.amount.asset) ||
    !Number.isFinite(now) ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    Date.parse(component.observedAt) > now
  )
    return { destinations: [], maximumSourceRaw: null, validUntil: null };
  return {
    destinations: withdrawalDestinationAssets(component.amount.asset),
    maximumSourceRaw: availability.availableRaw,
    validUntil,
  };
}
