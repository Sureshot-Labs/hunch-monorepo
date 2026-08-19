/**
 * A Relay root prepares controller pUSD. For a Polymarket shortfall it is
 * only an intermediate result: the exact Router child must exist before the
 * Buy may consume or re-quote those funds.
 */
const TELEGRAM_ROUTER_CONTINUATION_HARD_REASON_CODES = new Set([
  "router_authorization_missing",
  "router_authorization_mismatch",
  "router_policy_or_wallet_setup_invalid",
  "router_root_amount_unavailable",
  "router_source_balance_insufficient",
  "router_deposit_wallet_unavailable",
]);

export function isTelegramRouterContinuationHardReason(
  reasonCode: unknown,
): boolean {
  return (
    typeof reasonCode === "string" &&
    TELEGRAM_ROUTER_CONTINUATION_HARD_REASON_CODES.has(reasonCode)
  );
}

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
