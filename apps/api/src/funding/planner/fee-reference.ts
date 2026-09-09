import { scaleUnsignedDecimalByRawRatio } from "../../account-value/decimal.js";
import type { FundingDiscoveryRequest, Money } from "../domain/types.js";
import { rawAmount, sameAsset } from "./money.js";

/** A trade funds only its deficit, but its percentage cost budget belongs to
 * the whole trade. Absolute fee caps and exact source debits remain unchanged.
 * Other funding purposes (and capacity previews) retain route-based limits.
 */
export function tradeFundingFeeReferenceUsd(
  request: FundingDiscoveryRequest,
  output: Money,
  outputUsd: string | null,
): string | null {
  const trade = request.requestedDestinationAmount;
  if (
    request.purpose !== "trade_shortfall" ||
    request.serverQuoteAvailableSourceCapacity ||
    !trade ||
    outputUsd == null ||
    !sameAsset(trade.asset, output.asset) ||
    rawAmount(output.raw) === 0n ||
    rawAmount(trade.raw) < rawAmount(output.raw)
  )
    return null;
  return scaleUnsignedDecimalByRawRatio({
    value: outputUsd,
    numeratorRaw: trade.raw,
    denominatorRaw: output.raw,
  });
}
