import type { PolymarketRuntimeEvidence } from "./runtime-facts.js";

export function classifyPolymarketClobCollateralResponse(
  input: Readonly<{
    balanceRaw: string | null;
    responseOk: boolean;
    responseStatus: number | null;
    signatureType: number;
    walletDeployed: boolean;
    walletTopology: PolymarketRuntimeEvidence["topology"];
  }>,
): Readonly<{
  collateralVisible: boolean;
  safeBalanceRaw: string | null;
  staleCredentials: boolean;
  verifiedCredentials: boolean;
}> {
  // An authenticated CLOB 404 is the expected pre-deployment state for a
  // Deposit Wallet. Its spendable CLOB balance is exactly zero until the
  // wallet exists. Once deployed, the same response remains a hard failure.
  const undeployedDepositWalletAbsent =
    input.signatureType === 3 &&
    input.walletTopology === "deposit_wallet" &&
    !input.walletDeployed &&
    !input.responseOk &&
    input.responseStatus === 404;
  const safeBalanceRaw = input.responseOk
    ? input.balanceRaw
    : undeployedDepositWalletAbsent
      ? "0"
      : null;
  return {
    collateralVisible:
      (input.responseOk || undeployedDepositWalletAbsent) &&
      safeBalanceRaw != null,
    safeBalanceRaw,
    staleCredentials: !input.responseOk && input.responseStatus === 401,
    verifiedCredentials: input.responseOk || undeployedDepositWalletAbsent,
  };
}
