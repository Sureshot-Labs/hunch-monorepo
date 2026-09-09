import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import { sameAsset } from "../domain/asset-identity.js";
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
): void {
  for (const { reservation, heldRaw } of sources) {
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
      nativeFee && sameAsset(nativeFee.asset, asset)
        ? BigInt(nativeFee.raw)
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
      availability.freshness !== "fresh" ||
      availability.reasonCodes.includes("cash_availability_unknown") ||
      // A snapshot must include every locked hold. A concurrent debit/reduction
      // may require a fresh retry; it must never silently enlarge capacity.
      BigInt(availability.reservedRaw) < BigInt(heldRaw) ||
      BigInt(availability.availableRaw) <
        BigInt(reservation.rawAmount) + gasReserve
    ) {
      throw new FundingPersistenceError(
        "quote_invalidated",
        "free source balance could not cover the new funding reservation",
      );
    }
  }
}
