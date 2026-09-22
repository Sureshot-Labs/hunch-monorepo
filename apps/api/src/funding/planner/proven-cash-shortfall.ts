import type { AccountValueReadModel } from "../../account-value/runtime-service.js";
import { resolveKnownAccountAsset } from "../../account-value/known-asset-catalog.js";
import type {
  FundingDiscoveryRequest,
  FundingReasonCode,
} from "../domain/types.js";

/** Only replace a route refusal when the complete cash inventory independently
 * proves a shortage. Include even disconnected cash as an upper bound; do not
 * infer spendability or a conversion rate from a missing/failed route.
 */
export function classifyProvenCashShortfall(
  account: AccountValueReadModel,
  request: FundingDiscoveryRequest,
  reasons: readonly FundingReasonCode[],
): readonly FundingReasonCode[] {
  const required = request.requestedDestinationAmount;
  if (
    request.purpose !== "trade_shortfall" ||
    request.consumerIntent?.side !== "BUY" ||
    !required ||
    !resolveKnownAccountAsset(required.asset)?.exactStable ||
    !reasons.includes("provider_quote_rejected") ||
    reasons.some(
      (reason) =>
        reason !== "provider_quote_rejected" &&
        reason !== "insufficient_liquidity",
    ) ||
    account.cashAvailability.completeness !== "complete" ||
    account.cashAvailability.freshness !== "fresh" ||
    account.cashAvailability.collectorErrors.length > 0 ||
    account.projection.collectorErrors.length > 0
  )
    return reasons;

  let totalRaw = 0n;
  for (const component of account.cashAvailability.components) {
    if (component.freshness !== "fresh" || component.reasonCodes.length > 0)
      return reasons;
    const available = BigInt(component.availableRaw);
    if (available === 0n) continue;
    // Never treat a SOL price estimate (or an unknown asset) as an exact cap.
    if (!resolveKnownAccountAsset(component.amount.asset)?.exactStable)
      return reasons;
    const numerator = available * 10n ** BigInt(required.asset.decimals);
    const denominator = 10n ** BigInt(component.amount.asset.decimals);
    totalRaw += (numerator + denominator - 1n) / denominator;
  }
  return totalRaw < BigInt(required.raw) ? ["insufficient_liquidity"] : reasons;
}
