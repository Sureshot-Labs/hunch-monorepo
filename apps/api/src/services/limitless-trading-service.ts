import { ethers } from "ethers";

import { fetchLimitlessAmmQuote } from "./limitless-onchain.js";

export async function quoteLimitlessAmmTrade(input: {
  rpcUrl: string;
  timeoutMs: number;
  marketAddress: string;
  outcomeIndex: number;
  side: "BUY" | "SELL";
  amountUsdRaw?: bigint | null;
  amountSharesRaw?: bigint | null;
}): Promise<{
  marketAddress: string;
  outcomeIndex: number;
  side: "BUY" | "SELL";
  sharesRaw: string | null;
  returnAmountRaw: string | null;
}> {
  const quote = await fetchLimitlessAmmQuote(input);
  return {
    marketAddress: ethers.getAddress(input.marketAddress),
    outcomeIndex: input.outcomeIndex,
    side: input.side,
    sharesRaw: quote.sharesRaw?.toString() ?? null,
    returnAmountRaw: quote.returnAmountRaw?.toString() ?? null,
  };
}
