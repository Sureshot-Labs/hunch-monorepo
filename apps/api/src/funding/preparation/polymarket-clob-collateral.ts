import type { PolymarketRuntimeEvidence } from "./runtime-facts.js";

export type PolymarketClobBalanceObservation =
  | Readonly<{ kind: "present"; raw: string }>
  | Readonly<{ kind: "absent" | "invalid"; raw: null }>;

export function readPolymarketClobBalance(
  payload: unknown,
): PolymarketClobBalanceObservation {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "invalid", raw: null };
  }
  if (!("balance" in payload) || payload.balance == null) {
    return { kind: "absent", raw: null };
  }
  const value = payload.balance;
  const raw =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : null;
  return raw && /^(0|[1-9][0-9]*)$/u.test(raw)
    ? { kind: "present", raw }
    : { kind: "invalid", raw: null };
}

export function classifyPolymarketClobCollateralResponse(
  input: Readonly<{
    balance: PolymarketClobBalanceObservation;
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
  // An undeployed canonical Deposit Wallet cannot have CLOB collateral yet.
  // Depending on the CLOB deployment, that fact is represented either by an
  // authenticated response with no balance field or by a 404. Both mean a
  // known zero only before deployment; all credential failures and every
  // missing balance after deployment remain unavailable.
  const undeployedDepositWallet =
    input.signatureType === 3 &&
    input.walletTopology === "deposit_wallet" &&
    !input.walletDeployed;
  const undeployedDepositWalletAbsent =
    undeployedDepositWallet &&
    ((input.responseOk && input.balance.kind === "absent") ||
      (!input.responseOk && input.responseStatus === 404));
  const safeBalanceRaw =
    input.responseOk && input.balance.kind === "present"
      ? input.balance.raw
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

export function polymarketClobCollateralIsVisible(
  input: Readonly<{
    classified: Readonly<{
      collateralVisible: boolean;
      safeBalanceRaw: string | null;
    }>;
    observedWalletBalanceRaw: string | null;
    signatureType: number;
    walletDeployed: boolean;
    walletTopology: PolymarketRuntimeEvidence["topology"];
  }>,
): boolean {
  if (
    !input.classified.collateralVisible ||
    input.classified.safeBalanceRaw == null ||
    input.observedWalletBalanceRaw == null
  ) {
    return false;
  }
  let clobBalance: bigint;
  let observedWalletBalance: bigint;
  try {
    clobBalance = BigInt(input.classified.safeBalanceRaw);
    observedWalletBalance = BigInt(input.observedWalletBalanceRaw);
  } catch {
    return false;
  }
  if (clobBalance < 0n || observedWalletBalance < 0n) return false;
  // Before the canonical Deposit Wallet exists, an authenticated absent CLOB
  // account is the complete expected fact even when pUSD has already arrived
  // at its counterfactual on-chain address. Deployment is what makes that
  // balance visible to the venue. Any non-zero CLOB value is contradictory and
  // remains unavailable instead of being hidden by this exception.
  if (
    input.signatureType === 3 &&
    input.walletTopology === "deposit_wallet" &&
    !input.walletDeployed
  ) {
    return clobBalance === 0n;
  }
  return clobBalance >= observedWalletBalance;
}
