/**
 * A Relay root needs a Router child only when it delivered pUSD to the
 * controller. A root whose exact destination is the Polymarket Deposit Wallet
 * is already consumer-ready for the Buy; trying to route it again would look
 * for pUSD in the wrong wallet.
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

export function telegramPolymarketRootRequiresRouterContinuationSql(
  operationAlias: string,
): string {
  return `exists (
    select 1
      from funding_operation_steps root_step
     where root_step.operation_id = ${operationAlias}.id
       and root_step.executor_id in (
         'telegram_relay_evm_funding_v1',
         'telegram_relay_polygon_usdc_v1'
       )
  )
  and not (
    coalesce(${operationAlias}.destination_target_snapshot #>> '{location,kind}', '') = 'venue_account'
    and coalesce(${operationAlias}.destination_target_snapshot #>> '{location,details,venueId}', '') = 'polymarket'
  )`;
}

export function isTelegramPolymarketRouterContinuationPending(
  input: Readonly<{
    continuationId: string | null | undefined;
    operationStatus: string | null | undefined;
    progressStage: string | null | undefined;
    rootRequiresRouterContinuation: boolean;
    venue: string;
  }>,
): boolean {
  return (
    input.venue === "polymarket" &&
    input.rootRequiresRouterContinuation &&
    input.continuationId == null &&
    input.operationStatus === "ready" &&
    input.progressStage === "ready_for_consumer"
  );
}
