import { ethers } from "ethers";

import { isRecord } from "../lib/type-guards.js";
import { extractLimitlessMarketExchangeAddress } from "./limitless-market-contracts.js";

export type LimitlessClobFeePolicy =
  | { mode: "legacy"; signingFeeRateBps: number | null }
  | {
      mode: "collateral";
      signingFeeRateBps: 0;
      feeModule: string;
      collateralToken: string;
    };

export class LimitlessClobFeeError extends Error {
  constructor(
    readonly code:
      | "limitless_fee_policy_unavailable"
      | "limitless_fee_rate_mismatch"
      | "limitless_fee_wallet_mismatch"
      | "limitless_funding_order_type_mismatch"
      | "limitless_fee_module_approval_required"
      | "limitless_fee_module_allowance_unavailable",
    message: string,
    readonly responseStatus: 409 | 503,
    readonly feePolicy?: LimitlessClobFeePolicy,
  ) {
    super(message);
  }

  get responsePayload() {
    return {
      code: this.code,
      ...(this.feePolicy ? { feePolicy: this.feePolicy } : {}),
    };
  }

  get publicPayload() {
    return { error: this.message, ...this.responsePayload };
  }
}

export function assertLimitlessMarketPayloadSlug(
  payload: unknown,
  slug: string,
) {
  const market =
    isRecord(payload) && isRecord(payload.market) ? payload.market : payload;
  if (
    !isRecord(market) ||
    typeof market.slug !== "string" ||
    market.slug.toLowerCase() !== slug.toLowerCase()
  ) {
    throw unavailableLimitlessFeePolicy();
  }
}

export function unavailableLimitlessFeePolicy() {
  return new LimitlessClobFeeError(
    "limitless_fee_policy_unavailable",
    "Could not verify the Limitless market fee policy. Refresh and try again.",
    503,
  );
}

export function readLimitlessClobFeePolicy(
  payload: unknown,
  collateralToken: string,
  profileFeeRateBps?: number | null,
): LimitlessClobFeePolicy {
  const market =
    isRecord(payload) && isRecord(payload.market) ? payload.market : payload;
  const exchangeAddress = extractLimitlessMarketExchangeAddress(payload);
  if (
    !isRecord(market) ||
    !isRecord(market.venue) ||
    !exchangeAddress ||
    exchangeAddress === ethers.ZeroAddress
  ) {
    throw unavailableLimitlessFeePolicy();
  }
  const venue = market.venue;
  if (extractLimitlessMarketExchangeAddress({ venue }) !== exchangeAddress) {
    throw unavailableLimitlessFeePolicy();
  }
  if (venue.feeModuleType === "COLLATERAL") {
    const feeModule = venue.feeModule;
    const upstreamToken = isRecord(market.collateralToken)
      ? market.collateralToken.address
      : market.collateralToken;
    if (
      typeof feeModule !== "string" ||
      !ethers.isAddress(feeModule) ||
      feeModule.toLowerCase() === ethers.ZeroAddress ||
      feeModule.toLowerCase() === exchangeAddress.toLowerCase() ||
      !ethers.isAddress(collateralToken) ||
      collateralToken.toLowerCase() === ethers.ZeroAddress ||
      (upstreamToken != null &&
        (typeof upstreamToken !== "string" ||
          upstreamToken.toLowerCase() !== collateralToken.toLowerCase()))
    ) {
      throw unavailableLimitlessFeePolicy();
    }
    return {
      mode: "collateral",
      signingFeeRateBps: 0,
      feeModule: ethers.getAddress(feeModule),
      collateralToken: ethers.getAddress(collateralToken),
    };
  }
  if (venue.feeModuleType != null || venue.feeModule != null) {
    throw unavailableLimitlessFeePolicy();
  }
  return {
    mode: "legacy",
    signingFeeRateBps:
      profileFeeRateBps != null &&
      Number.isFinite(profileFeeRateBps) &&
      profileFeeRateBps >= 0
        ? Math.trunc(profileFeeRateBps)
        : null,
  };
}

export function assertLimitlessSigningFee(
  policy: LimitlessClobFeePolicy,
  signedFeeRateBps: number,
): void {
  if (
    policy.signingFeeRateBps != null &&
    signedFeeRateBps !== policy.signingFeeRateBps
  ) {
    throw new LimitlessClobFeeError(
      "limitless_fee_rate_mismatch",
      "Limitless fee rate changed. Refresh the market and sign a new order.",
      409,
      policy,
    );
  }
}

export async function assertLimitlessFeeModuleAllowance(input: {
  policy: LimitlessClobFeePolicy;
  owner: string;
  postOnly?: boolean;
  readAllowance: (input: {
    tokenAddress: string;
    owner: string;
    spender: string;
  }) => Promise<bigint>;
}): Promise<void> {
  const { policy } = input;
  if (policy.mode !== "collateral" || input.postOnly) return;
  let allowance: bigint;
  try {
    allowance = await input.readAllowance({
      tokenAddress: policy.collateralToken,
      owner: input.owner,
      spender: policy.feeModule,
    });
  } catch {
    throw new LimitlessClobFeeError(
      "limitless_fee_module_allowance_unavailable",
      "Could not verify Limitless fee allowance. Try again.",
      503,
      policy,
    );
  }
  // The market API does not quote the amount of the USDC fee. Catch a
  // definitively missing approval here; matching still enforces the amount.
  if (allowance <= 0n) {
    throw new LimitlessClobFeeError(
      "limitless_fee_module_approval_required",
      "Approve Base USDC for this Limitless market's fee module before continuing.",
      409,
      policy,
    );
  }
}
