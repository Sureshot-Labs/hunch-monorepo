export const POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID =
  "polymarket_deposit_usdce_wrap_v1";

export type DelegatedFundingSecurityClass =
  | "closed_destination_transform"
  | "routed_value_movement"
  | "venue_execution";

export function delegatedFundingProfileRequiresAmountCap(
  profileId: string,
): boolean {
  return profileId !== POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID;
}
