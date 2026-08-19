/**
 * A Relay root prepares controller pUSD. For a Polymarket shortfall it is
 * only an intermediate result: the exact Router child must exist before the
 * Buy may consume or re-quote those funds.
 */
export function isTelegramPolymarketRouterContinuationPending(input: Readonly<{
  continuationId: string | null | undefined;
  operationStatus: string | null | undefined;
  progressStage: string | null | undefined;
  rootRequiresRouterContinuation: boolean;
  venue: string;
}>): boolean {
  return (
    input.venue === "polymarket" &&
    input.rootRequiresRouterContinuation &&
    input.continuationId == null &&
    input.operationStatus === "ready" &&
    input.progressStage === "ready_for_consumer"
  );
}
