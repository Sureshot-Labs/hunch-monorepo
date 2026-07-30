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

export type PolymarketFundingPlanInput = Readonly<{
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
}>;

function positive(value: bigint | null | undefined): bigint {
  return value != null && value > 0n ? value : 0n;
}

function available(balance: bigint, locked: bigint): bigint {
  return balance > locked ? balance - locked : 0n;
}

export function buildPolymarketFundingPlan(
  input: PolymarketFundingPlanInput,
): PolymarketFundingPlan | null {
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

const PARTIAL_CAPACITY_ERRORS = new Set<PolymarketFundingPlanError["code"]>([
  "allowance_missing",
  "cap_exceeded",
  "insufficient_balance",
]);

/**
 * Returns the largest exact router plan that is executable under the same
 * balances, allowances, cap, and priority rules as buildPolymarketFundingPlan.
 *
 * Executability is monotonic for this router: once a requested funding amount
 * exceeds any frozen capacity constraint, larger requests cannot recover.
 * Searching the exact builder keeps one source of truth for allocation and
 * calldata instead of maintaining a second, drifting capacity formula.
 */
export function buildMaximumPolymarketFundingPlan(
  input: Omit<PolymarketFundingPlanInput, "requiredRaw"> &
    Readonly<{ maximumFundingRaw: bigint }>,
): PolymarketFundingPlan | null {
  const maximumFundingRaw = positive(input.maximumFundingRaw);
  if (maximumFundingRaw === 0n) return null;
  const depositAvailableRaw = available(
    positive(input.depositPusdRaw),
    positive(input.depositLockedRaw),
  );
  let lower = 1n;
  let upper = maximumFundingRaw;
  let best: PolymarketFundingPlan | null = null;
  while (lower <= upper) {
    const candidateFundingRaw = lower + (upper - lower) / 2n;
    try {
      const plan = buildPolymarketFundingPlan({
        ...input,
        requiredRaw: depositAvailableRaw + candidateFundingRaw,
      });
      if (!plan || BigInt(plan.totalAmountRaw) !== candidateFundingRaw) {
        throw new Error(
          "maximum Polymarket funding search produced inconsistent economics",
        );
      }
      best = plan;
      lower = candidateFundingRaw + 1n;
    } catch (error) {
      if (
        !(error instanceof PolymarketFundingPlanError) ||
        !PARTIAL_CAPACITY_ERRORS.has(error.code)
      ) {
        throw error;
      }
      upper = candidateFundingRaw - 1n;
    }
  }
  return best;
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
