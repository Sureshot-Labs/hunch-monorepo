import { Interface, ethers } from "ethers";

export const POLYMARKET_FUNDING_ROUTER_ABI = [
  "function fund(uint256 expectedNonce,uint256 totalAmount,uint256 pUsdAmount)",
  "function fundingNonce(address owner) view returns (uint256)",
] as const;

const fundingRouterInterface = new Interface(POLYMARKET_FUNDING_ROUTER_ABI);

export type PolymarketFundingPlan = {
  depositWallet: string;
  routerAddress: string;
  routerNonce: string;
  requiredRaw: string;
  depositAvailableRaw: string;
  depositUsdceAmountRaw: string;
  totalAmountRaw: string;
  pUsdAmountRaw: string;
  signerUsdceAmountRaw: string;
  usdceAmountRaw: string;
  calldata: string;
};

export class PolymarketFundingPlanError extends Error {
  constructor(
    readonly code:
      | "allowance_missing"
      | "cap_exceeded"
      | "insufficient_balance"
      | "invalid_configuration"
      | "unsupported_funder",
    message: string,
  ) {
    super(message);
    this.name = "PolymarketFundingPlanError";
  }
}

function positive(value: bigint | null | undefined): bigint {
  return value != null && value > 0n ? value : 0n;
}

function available(balance: bigint, locked: bigint): bigint {
  return balance > locked ? balance - locked : 0n;
}

export function buildPolymarketFundingPlan(input: {
  depositWallet: string;
  depositPusdRaw: bigint;
  depositRouterUsdceAllowanceRaw: bigint;
  depositLockedRaw?: bigint | null;
  depositUsdceRaw: bigint;
  fundingCapRaw: bigint;
  requiredRaw: bigint;
  routerAddress: string;
  routerNonce: bigint;
  routerPusdAllowanceRaw: bigint;
  routerUsdceAllowanceRaw: bigint;
  signer: string;
  signerLockedRaw?: bigint | null;
  signerPusdRaw: bigint;
  signerUsdceRaw: bigint;
}): PolymarketFundingPlan | null {
  let signer: string;
  let depositWallet: string;
  let routerAddress: string;
  try {
    signer = ethers.getAddress(input.signer);
    depositWallet = ethers.getAddress(input.depositWallet);
    routerAddress = ethers.getAddress(input.routerAddress);
  } catch {
    throw new PolymarketFundingPlanError(
      "invalid_configuration",
      "Polymarket funding router configuration is invalid.",
    );
  }
  if (signer === depositWallet) {
    throw new PolymarketFundingPlanError(
      "unsupported_funder",
      "Funding router requires a distinct canonical deposit wallet.",
    );
  }

  const requiredRaw = positive(input.requiredRaw);
  const depositAvailableRaw = available(
    positive(input.depositPusdRaw),
    positive(input.depositLockedRaw),
  );
  if (requiredRaw <= depositAvailableRaw) return null;

  const totalAmountRaw = requiredRaw - depositAvailableRaw;
  if (input.fundingCapRaw <= 0n || totalAmountRaw > input.fundingCapRaw) {
    throw new PolymarketFundingPlanError(
      "cap_exceeded",
      "Required Polymarket funding exceeds the configured router cap.",
    );
  }

  const depositUsdceAmountRaw =
    positive(input.depositUsdceRaw) < totalAmountRaw
      ? positive(input.depositUsdceRaw)
      : totalAmountRaw;
  if (
    depositUsdceAmountRaw > 0n &&
    positive(input.depositRouterUsdceAllowanceRaw) < depositUsdceAmountRaw
  ) {
    throw new PolymarketFundingPlanError(
      "allowance_missing",
      "Deposit wallet USDC.e funding-router approval is missing.",
    );
  }

  const remainingAfterDepositUsdce = totalAmountRaw - depositUsdceAmountRaw;
  const signerPusdAvailableRaw = available(
    positive(input.signerPusdRaw),
    positive(input.signerLockedRaw),
  );
  const pUsdAmountRaw =
    signerPusdAvailableRaw < remainingAfterDepositUsdce
      ? signerPusdAvailableRaw
      : remainingAfterDepositUsdce;
  const signerUsdceAmountRaw = remainingAfterDepositUsdce - pUsdAmountRaw;
  const usdceAmountRaw = depositUsdceAmountRaw + signerUsdceAmountRaw;
  if (positive(input.signerUsdceRaw) < signerUsdceAmountRaw) {
    throw new PolymarketFundingPlanError(
      "insufficient_balance",
      "Trading Wallet has insufficient pUSD and USDC.e for this order.",
    );
  }
  if (
    positive(input.routerPusdAllowanceRaw) < pUsdAmountRaw ||
    positive(input.routerUsdceAllowanceRaw) < signerUsdceAmountRaw
  ) {
    throw new PolymarketFundingPlanError(
      "allowance_missing",
      "Funding router token approvals are missing.",
    );
  }

  return {
    depositWallet,
    routerAddress,
    routerNonce: input.routerNonce.toString(),
    requiredRaw: requiredRaw.toString(),
    depositAvailableRaw: depositAvailableRaw.toString(),
    depositUsdceAmountRaw: depositUsdceAmountRaw.toString(),
    totalAmountRaw: totalAmountRaw.toString(),
    pUsdAmountRaw: pUsdAmountRaw.toString(),
    signerUsdceAmountRaw: signerUsdceAmountRaw.toString(),
    usdceAmountRaw: usdceAmountRaw.toString(),
    calldata: fundingRouterInterface.encodeFunctionData("fund", [
      input.routerNonce,
      totalAmountRaw,
      pUsdAmountRaw,
    ]),
  };
}

export function decodePolymarketFundingCalldata(calldata: string): {
  expectedNonce: bigint;
  pUsdAmount: bigint;
  totalAmount: bigint;
} {
  const decoded = fundingRouterInterface.decodeFunctionData("fund", calldata);
  return {
    expectedNonce: decoded[0] as bigint,
    totalAmount: decoded[1] as bigint,
    pUsdAmount: decoded[2] as bigint,
  };
}
