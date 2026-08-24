import type { FundingDiscoveryRequest, Money } from "../domain/types.js";

/**
 * The trade amount is the later consumer ceiling; a funding quote must cover
 * only the server-observed shortfall when that narrower amount is present.
 * Keeping this choice in one pure helper prevents server and Mini App commits
 * from accidentally quoting the full Buy amount again.
 */
export function fundingDestinationAmountForRequest(
  request: Pick<
    FundingDiscoveryRequest,
    | "purpose"
    | "requestedDestinationAmount"
    | "serverAdditionalDestinationAmount"
  >,
): Money | null {
  if (request.purpose !== "trade_shortfall") {
    return request.requestedDestinationAmount;
  }
  return (
    request.serverAdditionalDestinationAmount ??
    request.requestedDestinationAmount
  );
}
