import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import { sameAsset } from "../domain/asset-identity.js";
import { withdrawalRawAvailabilityKnown } from "../domain/withdrawal-capacity.js";
import { senderNativeFeeRequirement } from "../domain/network-fees.js";
import {
  FundingPersistenceError,
  type FundingSharedSourceReservation,
} from "../persistence/funding-operation-repository.js";

/** The account must be collected under the commit's source locks, not at prepare time. */
export function assertSharedFundingSourceCapacity(
  account: Readonly<{
    projection: Pick<AccountValueReadModel["projection"], "components">;
    cashAvailability: Pick<
      AccountValueReadModel["cashAvailability"],
      "components"
    >;
  }>,
  userId: string,
  sources: readonly FundingSharedSourceReservation[],
  options: { directWithdrawal?: boolean } = {},
): void {
  for (const { reservation, heldRaw, projectedHeldRaw } of sources) {
    const component = account.projection.components.find(
      (entry) => entry.componentId === reservation.componentId,
    );
    const availability = account.cashAvailability.components.find(
      (entry) => entry.componentId === reservation.componentId,
    );
    const asset = {
      networkId: reservation.networkId,
      assetId: reservation.assetId,
      decimals: reservation.assetDecimals,
    };
    const nativeFee = senderNativeFeeRequirement(asset.networkId);
    const gasReserve =
      !options.directWithdrawal &&
      nativeFee &&
      sameAsset(nativeFee.asset, asset)
        ? BigInt(nativeFee.raw)
        : 0n;
    // Account availability includes every reservation mode by component ID.
    // Only same-component subtract holds without a finalized source debit
    // overlap the physically locked source holds; other modes cannot hide an
    // alias wallet's outstanding source reservation.
    const unprojectedPhysicalHold = availability
      ? BigInt(heldRaw) > BigInt(projectedHeldRaw)
        ? BigInt(heldRaw) - BigInt(projectedHeldRaw)
        : 0n
      : 0n;
    if (
      !component ||
      !availability ||
      component.location.accountId !== userId ||
      component.location.locationId !== reservation.locationId ||
      !sameAsset(component.amount.asset, asset) ||
      !sameAsset(availability.amount.asset, asset) ||
      component.category !== "cash" ||
      component.observationFreshness !== "fresh" ||
      component.observationError ||
      !(options.directWithdrawal
        ? withdrawalRawAvailabilityKnown(availability)
        : availability.freshness === "fresh") ||
      availability.reasonCodes.includes("cash_availability_unknown") ||
      BigInt(projectedHeldRaw) > BigInt(heldRaw) ||
      BigInt(projectedHeldRaw) > BigInt(availability.reservedRaw) ||
      BigInt(availability.availableRaw) <
        BigInt(reservation.rawAmount) + gasReserve + unprojectedPhysicalHold
    ) {
      throw new FundingPersistenceError(
        "quote_invalidated",
        "free source balance could not cover the new funding reservation",
      );
    }
  }
}
