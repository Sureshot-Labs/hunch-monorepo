export const POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID =
  "polymarket_deposit_usdce_wrap_v1";
/**
 * Controller-wallet pUSD can be funded into the canonical Polymarket Deposit
 * Wallet by the same immutable Funding Router.  It is deliberately a
 * different authority envelope from the USDC.e-only wrap: the server checks
 * that both fund amounts are the one exact confirmed shortfall.
 */
export const POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID =
  "polymarket_deposit_pusd_fund_v1";

export const POLYMARKET_DEPOSIT_ROUTER_PROFILE_IDS = Object.freeze([
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID,
]);

export function isPolymarketDepositRouterProfileId(profileId: string): boolean {
  return POLYMARKET_DEPOSIT_ROUTER_PROFILE_IDS.includes(profileId);
}
export const TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID =
  "telegram_relay_evm_funding_v1";
export const TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID =
  "telegram_relay_polygon_pusd_v1";
export const TELEGRAM_RELAY_POLYGON_USDC_PROFILE_ID =
  "telegram_relay_polygon_usdc_v1";
export const TELEGRAM_RELAY_POLYGON_USDCE_PROFILE_ID =
  "telegram_relay_polygon_usdce_v1";

export const TELEGRAM_RELAY_EVM_FUNDING_PROFILE_IDS = Object.freeze([
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_USDC_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_USDCE_PROFILE_ID,
]);

export type DelegatedFundingSecurityClass =
  | "closed_destination_transform"
  | "routed_value_movement"
  | "venue_execution";

export function delegatedFundingProfileRequiresAmountCap(
  profileId: string,
): boolean {
  return !isPolymarketDepositRouterProfileId(profileId);
}
