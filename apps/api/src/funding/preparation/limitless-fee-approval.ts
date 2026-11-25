import { extractLimitlessMarketExchangeAddress } from "../../services/limitless-market-contracts.js";
import { assertLimitlessMarketPayloadSlug } from "../../services/limitless-clob-fees.js";
import {
  fetchLimitlessClobMarket,
  marketLimitlessFeePolicy,
  readBaseUsdcAllowance,
} from "../../services/limitless-clob-fee-runtime.js";

export type LimitlessFeeApproval = Readonly<{
  marketSlug: string;
  token: string;
  spender: string;
  amountRaw: string;
}>;

export type LimitlessFeeApprovalEvidence =
  | { state: "not_required" | "ready" | "unavailable" }
  | { state: "required"; approval: LimitlessFeeApproval };

export async function inspectLimitlessFeeApproval(
  input: Readonly<{
    marketSlug: string | null;
    exchangeAddress: string | null;
    owner: string;
    principalRaw: string;
  }>,
  dependencies = {
    loadMarket: fetchLimitlessClobMarket,
    loadAllowance: readBaseUsdcAllowance,
  },
): Promise<LimitlessFeeApprovalEvidence> {
  const { marketSlug, exchangeAddress, owner, principalRaw } = input;
  if (
    !marketSlug ||
    !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/i.test(marketSlug) ||
    !/^[1-9][0-9]{0,15}$/.test(principalRaw) ||
    !Number.isSafeInteger(Number(principalRaw))
  ) {
    return { state: "unavailable" };
  }
  try {
    const market = await dependencies.loadMarket(marketSlug, {
      timeoutMs: 2500,
    });
    assertLimitlessMarketPayloadSlug(market, marketSlug);
    const policy = marketLimitlessFeePolicy(market);
    if (policy.mode === "legacy") return { state: "not_required" };
    if (
      !exchangeAddress ||
      extractLimitlessMarketExchangeAddress(market)?.toLowerCase() !==
        exchangeAddress.toLowerCase()
    ) {
      return { state: "unavailable" };
    }
    const allowance = await dependencies.loadAllowance({
      tokenAddress: policy.collateralToken,
      owner,
      spender: policy.feeModule,
    });
    // The exact fee/individual fee cap is not available before matching.
    // Don't overwrite a positive allowance based on a fee estimate.
    if (allowance > 0n) return { state: "ready" };
    return {
      state: "required",
      approval: {
        marketSlug,
        token: policy.collateralToken,
        spender: policy.feeModule,
        amountRaw: principalRaw,
      },
    };
  } catch {
    return { state: "unavailable" };
  }
}
