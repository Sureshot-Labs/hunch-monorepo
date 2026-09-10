/** Exact cost accounting shared by withdrawal discovery and execution checks.
 * RPC/authorization evidence is supplied by the caller; unknown costs must not
 * be passed as zero. Amounts are raw units, never floating-point USD estimates.
 */
export function calculateWithdrawalCapacity(input: {
  nativeAsset: boolean;
  availableRaw: bigint;
  availableSolRaw: bigint;
  networkFeeRaw: bigint;
  accountRentRaw: bigint;
  payer: "user" | "privy_sponsor";
}) {
  for (const amount of [
    input.availableRaw,
    input.availableSolRaw,
    input.networkFeeRaw,
    input.accountRentRaw,
  ]) {
    if (amount < 0n)
      throw new Error("Withdrawal capacity requires nonnegative amounts");
  }
  if (input.payer === "privy_sponsor" && input.accountRentRaw !== 0n)
    throw new Error("Withdrawal sponsorship must not pay account rent");
  const userFeeRaw = input.payer === "user" ? input.networkFeeRaw : 0n;
  const userSolCostRaw = userFeeRaw + input.accountRentRaw;
  const maximumSourceRaw = input.nativeAsset
    ? input.availableRaw > userSolCostRaw
      ? input.availableRaw - userSolCostRaw
      : 0n
    : input.availableSolRaw >= userSolCostRaw
      ? input.availableRaw
      : 0n;
  return {
    maximumSourceRaw,
    userFeeRaw,
    userSolCostRaw,
    reasonCode:
      maximumSourceRaw > 0n
        ? null
        : input.availableRaw === 0n
          ? "insufficient_liquidity"
          : input.accountRentRaw > 0n && input.availableSolRaw < userSolCostRaw
            ? "insufficient_sol_for_rent"
            : "insufficient_sol_for_fee",
  };
}
